import * as vscode from 'vscode';
import { markdownToHTML } from '@create-markdown/preview';
import { ChatService } from '../chat/ChatService';
import {
    appendToolMessage,
    ChatThreadState,
    enrichAttachmentsForWebview,
    gatherEditorContext,
    getThreadSnapshots,
    handleFileSearch,
    postToAll,
    renderMarkdown,
} from '../webview/viewMessaging';

// The renderer pulls its parser in through a dynamic import. These tests mock
// that module and feed renderMarkdown the HTML shape the renderer emits.
vi.mock('@create-markdown/preview', () => ({ markdownToHTML: vi.fn() }));

const markdownToHTMLMock = vi.mocked(markdownToHTML);
const findFilesMock = vi.mocked(vscode.workspace.findFiles);

const webviewUri = (uri: vscode.Uri) => ({ toString: () => `webview:${uri.fsPath}` }) as vscode.Uri;

function fakeWebview() {
    return {
        postMessage: vi.fn(),
        asWebviewUri: vi.fn(webviewUri),
    };
}

type Webview = ReturnType<typeof fakeWebview>;
const asWebview = (webview: Webview) => webview as Pick<vscode.Webview, 'postMessage' | 'asWebviewUri'> as vscode.Webview;

function postedFiles(webview: Webview): string[] {
    const [message] = webview.postMessage.mock.calls[0];
    expect(message.type).toBe('fileSearchResults');
    return message.files.map((file: { relativePath: string }) => file.relativePath);
}

const uris = (...paths: string[]) => paths.map(p => vscode.Uri.file(p));

function makeThread(overrides: Partial<ChatThreadState> = {}): ChatThreadState {
    return {
        id: 't1', index: 1, title: 'Thread 1', messages: [], pendingAssistantText: '', pendingAttachments: [],
        currentChatType: 'chat', currentModel: 'codex', permissionState: 'approve-reads', isStreaming: false,
        status: 'idle', source: 'API', contextTokens: 0, contextMax: 0, lastUsage: null, service: new ChatService(),
        eventEpoch: 0, bindingEpoch: 0, openGeneration: 0, openInFlightGen: null,
        ...overrides,
    };
}

type FakeEditor = { text: string; selectionText?: string; uri?: vscode.Uri; languageId?: string };

function setActiveEditor(editor: FakeEditor | undefined): void {
    const window = vscode.window as { activeTextEditor: unknown };
    window.activeTextEditor = editor && {
        document: {
            uri: editor.uri ?? vscode.Uri.file('/ws/src/app.ts'),
            languageId: editor.languageId ?? 'typescript',
            getText: (range?: unknown) => (range ? editor.selectionText : editor.text),
        },
        selection: { isEmpty: !editor.selectionText },
    };
}

describe('viewMessaging', () => {
    describe('renderMarkdown', () => {
        const renderedLink = (href: string) => `<p class="cm-paragraph"><a href="${href}" target="_blank" rel="noopener noreferrer">x</a></p>`;
        const renderLink = (href: string) => {
            markdownToHTMLMock.mockResolvedValueOnce(renderedLink(href));
            return renderMarkdown('[x](...)');
        };

        it('asks the renderer to sanitize', async () => {
            markdownToHTMLMock.mockResolvedValueOnce('<p><strong>bold</strong></p>');
            expect(await renderMarkdown('**bold**')).toBe('<p><strong>bold</strong></p>');
            expect(markdownToHTMLMock).toHaveBeenLastCalledWith('**bold**', { sanitize: true });
        });

        it.each([
            'javascript:alert(1)',
            'JaVaScRiPt:alert(1)',
            ' \u0001javascript:alert(1)',
            'java\tscript:alert(1)',
            'java\nscript:alert(1)',
            '&#106;avascript:alert(1)',
            '&#x6A;avascript:alert(1)',
            '&#106avascript:alert(1)',
            'vbscript:msgbox',
            'data:text/html;base64,PHNjcmlwdD4=',
            'command:workbench.action.terminal.new',
            'vscode://file/etc/passwd',
            'file:///etc/passwd',
        ])('neutralizes the unsafe link target %p', async (href) => {
            expect(await renderLink(href)).toBe(renderedLink('#'));
        });

        it.each([
            'https://example.com/a?b=1&amp;c=2',
            'HTTP://example.com',
            'mailto:someone@example.com',
            'docs/readme.md',
            './rel',
            '/abs',
            '#section',
            'java&amp;#115;cript:alert(1)',
            '&lt;javascript:alert(1)&gt;',
            '&#99999999;x',
        ])('keeps the link target %p, which is safe or relative', async (href) => {
            expect(await renderLink(href)).toBe(renderedLink(href));
        });

        it('neutralizes every unsafe link and leaves escaped text alone', async () => {
            markdownToHTMLMock.mockResolvedValueOnce(
                '<a href="javascript:a()">1</a> &lt;a href=&quot;javascript:b()&quot;&gt; <a class="c" href="https://ok">2</a> <a href="data:x">3</a>'
            );
            expect(await renderMarkdown('...')).toBe(
                '<a href="#">1</a> &lt;a href=&quot;javascript:b()&quot;&gt; <a class="c" href="https://ok">2</a> <a href="#">3</a>'
            );
        });

        it('falls back to escaped text when the renderer throws', async () => {
            markdownToHTMLMock.mockRejectedValueOnce(new Error('boom'));
            expect(await renderMarkdown('<b a="1">\'&')).toBe('&lt;b a=&quot;1&quot;&gt;&#39;&amp;');
        });
    });

    describe('handleFileSearch', () => {
        const setTabs = (...tabs: unknown[]) => Object.assign(vscode.window.tabGroups, { all: tabs.length ? [{ tabs }] : [] });

        beforeEach(() => {
            findFilesMock.mockReset();
            findFilesMock.mockResolvedValue([]);
            setTabs();
        });

        it('offers open text editors for an empty query', async () => {
            setTabs(
                { input: new vscode.TabInputText(vscode.Uri.file('/ws/src/open.ts')) },
                { input: { kind: 'notebook' } },
            );
            const webview = fakeWebview();
            await handleFileSearch('', asWebview(webview), '/ws');
            expect(postedFiles(webview)).toEqual(['src/open.ts']);
            expect(findFilesMock).not.toHaveBeenCalled();
        });

        it('lists workspace files by path length when no editor is open', async () => {
            findFilesMock.mockResolvedValue(uris('/ws/src/deep/b.ts', '/ws/a.ts'));
            const webview = fakeWebview();
            await handleFileSearch('', asWebview(webview), '/ws');
            expect(findFilesMock).toHaveBeenCalledTimes(1);
            expect(findFilesMock.mock.calls[0][0]).toBe('**/*');
            expect(postedFiles(webview)).toEqual(['a.ts', 'src/deep/b.ts']);
        });

        it('treats a whitespace query as empty without scanning twice', async () => {
            const webview = fakeWebview();
            await handleFileSearch('   ', asWebview(webview), '/ws');
            expect(findFilesMock).toHaveBeenCalledTimes(1);
        });

        it('globs the trimmed query and ranks name prefixes first', async () => {
            findFilesMock.mockResolvedValueOnce(uris('/ws/lib/myutil.ts', '/ws/util.ts', '/ws/util/index.ts'));
            const webview = fakeWebview();
            await handleFileSearch(' util ', asWebview(webview), '/ws');
            expect(findFilesMock.mock.calls[0][0]).toBe('**/*util*');
            expect(postedFiles(webview)).toEqual(['util.ts', 'lib/myutil.ts', 'util/index.ts']);
        });

        it('finds case-insensitive and directory matches through the bounded scan', async () => {
            findFilesMock.mockResolvedValueOnce([]).mockResolvedValueOnce(
                uris('/ws/lib/readers/y.ts', '/ws/README.md', '/ws/readers/x.ts', '/ws/other.ts')
            );
            const webview = fakeWebview();
            await handleFileSearch('read', asWebview(webview), '/ws');
            expect(findFilesMock.mock.calls[1]).toEqual(['**/*', expect.any(String), 5000]);
            expect(postedFiles(webview)).toEqual(['README.md', 'readers/x.ts', 'lib/readers/y.ts']);
        });

        it('skips the scan once the glob found enough matches', async () => {
            findFilesMock.mockResolvedValueOnce(uris(...Array.from({ length: 20 }, (_, i) => `/ws/item${i}.ts`)));
            const webview = fakeWebview();
            await handleFileSearch('item', asWebview(webview), '/ws');
            expect(findFilesMock).toHaveBeenCalledTimes(1);
            expect(postedFiles(webview)).toHaveLength(15);
        });

        it('lists a file found by both passes once', async () => {
            findFilesMock.mockResolvedValue(uris('/ws/app.ts'));
            const webview = fakeWebview();
            await handleFileSearch('app', asWebview(webview), '/ws');
            expect(postedFiles(webview)).toEqual(['app.ts']);
        });

        it.each(['{a,b}', '*', 'x[0]', 'a\\b', '!neg', 'f(1)', 'a,b', 'x'.repeat(256)])(
            'searches the query %p literally, never as a glob', async (query) => {
                const webview = fakeWebview();
                await handleFileSearch(query, asWebview(webview), '/ws');
                expect(findFilesMock.mock.calls.map(([pattern]) => pattern)).toEqual(['**/*']);
            });

        it('keeps a leading dash inside the glob instead of a leading argument', async () => {
            const webview = fakeWebview();
            await handleFileSearch('--files', asWebview(webview), '/ws');
            expect(findFilesMock.mock.calls[0][0]).toBe('**/*--files*');
        });

        it('still answers when the file search fails', async () => {
            findFilesMock.mockRejectedValue(new Error('invalid glob'));
            const webview = fakeWebview();
            await handleFileSearch('app', asWebview(webview), '/ws');
            expect(postedFiles(webview)).toEqual([]);
        });

        it('reports absolute paths when there is no workspace folder', async () => {
            findFilesMock.mockResolvedValue(uris('/abs/app.ts'));
            const webview = fakeWebview();
            await handleFileSearch('app', asWebview(webview), '');
            expect(postedFiles(webview)).toEqual(['/abs/app.ts']);
        });
    });

    describe('gatherEditorContext', () => {
        const git = vi.fn(async (args: string): Promise<string> => (args === 'diff' ? 'DIFF' : 'STAGED'));
        const getDiagnosticsMock = vi.mocked(vscode.languages.getDiagnostics as (uri: vscode.Uri) => vscode.Diagnostic[]);

        afterEach(() => {
            setActiveEditor(undefined);
            getDiagnosticsMock.mockReset();
            getDiagnosticsMock.mockReturnValue([]);
            git.mockClear();
        });

        it('returns no context without an editor', async () => {
            setActiveEditor(undefined);
            for (const type of ['selection', 'file', 'diagnostics', 'none'] as const) {
                expect(await gatherEditorContext(type, git)).toEqual({});
            }
        });

        it('describes the active file and prefers the selection', async () => {
            vi.mocked(vscode.workspace.asRelativePath).mockReturnValueOnce('src/app.ts');
            setActiveEditor({ text: 'whole file', selectionText: 'picked' });
            expect(await gatherEditorContext('selection', git)).toEqual({
                filePath: 'src/app.ts', fileName: 'app.ts', languageId: 'typescript', selection: 'picked',
            });
        });

        it('falls back to the whole file when nothing is selected', async () => {
            setActiveEditor({ text: 'whole file' });
            expect((await gatherEditorContext('selection', git)).fileContent).toBe('whole file');
        });

        it('always includes the whole file for the file context', async () => {
            setActiveEditor({ text: 'whole file', selectionText: 'picked' });
            expect((await gatherEditorContext('file', git)).fileContent).toBe('whole file');
        });

        it('lists diagnostics with their severity and one-based line', async () => {
            setActiveEditor({ text: 'body' });
            getDiagnosticsMock.mockReturnValue([
                { severity: vscode.DiagnosticSeverity.Error, range: { start: { line: 4 } }, message: 'bad' },
                { severity: vscode.DiagnosticSeverity.Warning, range: { start: { line: 0 } }, message: 'meh' },
            ] as vscode.Diagnostic[]);
            const context = await gatherEditorContext('diagnostics', git);
            expect(context.fileContent).toBe('body');
            expect(context.diagnostics).toBe('[Error] Line 5: bad\n[Warning] Line 1: meh');
        });

        it('omits diagnostics when there are none and keeps the selection', async () => {
            setActiveEditor({ text: 'body', selectionText: 'sel' });
            const context = await gatherEditorContext('diagnostics', git);
            expect(context).not.toHaveProperty('diagnostics');
            expect(context).not.toHaveProperty('fileContent');
        });

        it('reads the working-tree diff, falling back to the file when it is empty', async () => {
            setActiveEditor({ text: 'body' });
            expect((await gatherEditorContext('gitDiff', git)).gitDiff).toBe('DIFF');
            git.mockResolvedValueOnce('');
            expect((await gatherEditorContext('gitDiff', git)).fileContent).toBe('body');
        });

        it('reads the staged diff', async () => {
            setActiveEditor(undefined);
            expect(await gatherEditorContext('gitStaged', git)).toEqual({ gitStaged: 'STAGED' });
            expect(git).toHaveBeenCalledWith('diff --staged');
        });
    });

    describe('appendToolMessage', () => {
        const entry = (id: string | undefined, status: string) => ({ title: 'read', status, details: '', ...(id ? { id } : {}) });

        it('starts a tool message after a non-tool message', () => {
            const thread = makeThread({ messages: [{ role: 'user', content: 'hi' }] });
            appendToolMessage(thread, entry('a', 'running'));
            expect(thread.messages[1]).toEqual({ role: 'tool', entries: [entry('a', 'running')] });
        });

        it('updates the entry with the same id in place', () => {
            const thread = makeThread();
            appendToolMessage(thread, entry('a', 'running'));
            appendToolMessage(thread, entry('b', 'running'));
            appendToolMessage(thread, entry('a', 'done'));
            expect(thread.messages).toEqual([{ role: 'tool', entries: [entry('a', 'done'), entry('b', 'running')] }]);
        });

        it('always appends entries without an id', () => {
            const thread = makeThread();
            appendToolMessage(thread, entry(undefined, 'running'));
            appendToolMessage(thread, entry(undefined, 'running'));
            expect(thread.messages).toEqual([{ role: 'tool', entries: [entry(undefined, 'running'), entry(undefined, 'running')] }]);
        });
    });

    describe('thread snapshots', () => {
        it('snapshots visible threads in order, skipping unknown ids, as copies', () => {
            const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
            const one = makeThread({ id: 'one', messages: [{ role: 'user', content: 'hi' }], lastUsage: usage });
            const two = makeThread({ id: 'two' });
            const snapshots = getThreadSnapshots(new Map([['one', one], ['two', two]]), ['two', 'missing', 'one']);
            expect(snapshots.map(s => s.id)).toEqual(['two', 'one']);
            expect(snapshots[1].lastUsage).toEqual(usage);
            expect(snapshots[1].lastUsage).not.toBe(usage);
            expect(snapshots[1].messages[0]).not.toBe(one.messages[0]);
            expect(snapshots[0].lastUsage).toBeNull();
            expect(snapshots[0]).not.toHaveProperty('service');
        });

        it('adds preview URIs to image attachments only, tolerating a failing conversion', () => {
            const thread = makeThread({ pendingAttachments: [
                { name: 'a.png', path: '/ws/a.png', type: 'image' },
                { name: 'b.ts', path: '/ws/b.ts', type: 'file' },
                { name: 'c.png', path: '/ws/c.png', type: 'image' },
            ] });
            const webview = fakeWebview();
            webview.asWebviewUri.mockImplementationOnce(webviewUri)
                .mockImplementationOnce(() => {
                    throw new Error('outside local roots');
                });
            const [snapshot] = enrichAttachmentsForWebview(getThreadSnapshots(new Map([['t1', thread]]), ['t1']), asWebview(webview));
            expect(snapshot.pendingAttachments.map(a => a.previewUri)).toEqual(['webview:/ws/a.png', undefined, undefined]);
        });

        it('posts to every live webview', () => {
            const first = fakeWebview();
            const second = fakeWebview();
            postToAll([asWebview(first), undefined, asWebview(second)], { type: 'ping' });
            expect(first.postMessage).toHaveBeenCalledWith({ type: 'ping' });
            expect(second.postMessage).toHaveBeenCalledWith({ type: 'ping' });
        });
    });
});
