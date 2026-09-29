import * as vscode from 'vscode';
import type { ChatEvent } from '../chat/ChatService';

const mockResolve = jest.fn();
const mockFactoryCallbacks: {
    onStatus?: (transport: 'gateway' | 'acpx', connected: boolean, protocolVersion: number | null) => void;
    onInvalidated?: (reason: 'identity' | 'transport') => void;
} = {};

jest.mock('../webview/chatServiceFactory', () => ({
    ChatServiceFactory: jest.fn().mockImplementation((_context, onStatus, onInvalidated) => {
        mockFactoryCallbacks.onStatus = onStatus;
        mockFactoryCallbacks.onInvalidated = onInvalidated;
        return { resolve: (...args: unknown[]) => mockResolve(...args), dispose: jest.fn() };
    }),
}));

jest.mock('../core/gatewayChatService', () => jest.requireActual('./helpers/mockGatewayService').mockGatewayModule());

// Identity realpath keeps sends free of real disk I/O, so flush() is deterministic.
jest.mock('fs', () => {
    const actual = jest.requireActual('fs');
    return { ...actual, promises: { ...actual.promises, realpath: async (p: string) => p } };
});

import { ChatViewProvider } from '../webview/ChatViewProvider';
import type { GatewayChatService } from '../core/gatewayChatService';
import { COLD_SESSION_PLACEHOLDER } from '../core/agentPicker';
import { renderMarkdown } from '../webview/viewMessaging';
import { historySnapshot, sessionSummaries } from './helpers/mockGatewayService';

type Posted = Record<string, unknown>;
type ThreadState = {
    id: string;
    messages: Array<Record<string, unknown>>;
    pendingAttachments: unknown[];
    lastUsage: unknown;
    contextTokens: number;
    status: string;
    notice?: string;
};

type FakeWebview = {
    posted: Posted[];
    send(message: Posted): Promise<void>;
    webview: vscode.Webview;
};

type FakeView = {
    webview: vscode.Webview;
    visible: boolean;
    show: (preserveFocus?: boolean) => void;
    onDidDispose: vscode.Event<void>;
};

const { GatewayChatService: MockGatewayChatService } =
    jest.requireMock<{ GatewayChatService: new () => GatewayChatService }>('../core/gatewayChatService');

const WARM_ROWS = [
    { key: 'agent:main:main', label: 'Main' },
    { key: 'agent:coder:main', label: 'Coder' },
    { key: 'agent:cold:main', label: 'Cold', placement: { state: 'provisioning' } },
];

function makeWebview(): FakeWebview {
    let handler: (message: Posted) => Promise<void> = async () => undefined;
    const posted: Posted[] = [];
    const webview: vscode.Webview = {
        options: {},
        html: '',
        cspSource: 'vscode-webview:',
        postMessage: async (message: Posted) => { posted.push(message); return true; },
        onDidReceiveMessage: (cb: (message: Posted) => Promise<void>) => { handler = cb; return { dispose() {} }; },
        asWebviewUri: (uri: vscode.Uri) => uri,
    };
    return { posted, webview, send: (message) => handler(message) };
}

function makeGateway(): GatewayChatService {
    const gateway = new MockGatewayChatService();
    jest.mocked(gateway.listSessions).mockResolvedValue(sessionSummaries(WARM_ROWS));
    return gateway;
}

function makeMemento(): vscode.Memento {
    return { keys: () => [], get: jest.fn(), update: jest.fn(async () => undefined) };
}

function makeContext(): vscode.ExtensionContext {
    const context: Pick<vscode.ExtensionContext, 'globalState' | 'workspaceState'> = {
        globalState: { ...makeMemento(), setKeysForSync: jest.fn() },
        workspaceState: makeMemento(),
    };
    return context as vscode.ExtensionContext;
}

function makeProvider(): { provider: ChatViewProvider; sidebar: FakeWebview & { view: FakeView } } {
    const provider = new ChatViewProvider(vscode.Uri.file('/ext'), makeContext());
    const sidebar = makeWebview();
    const view: FakeView = { webview: sidebar.webview, visible: true, show: jest.fn(), onDidDispose: jest.fn() };
    provider.resolveWebviewView(view as vscode.WebviewView, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
    return { provider, sidebar: { ...sidebar, view } };
}

// Real setImmediate: the global one is faked.
const { setImmediate: realSetImmediate } = jest.requireActual<typeof import('timers')>('timers');

async function flush(): Promise<void> {
    for (let i = 0; i < 10; i++) {
        await new Promise(resolve => realSetImmediate(resolve));
    }
}

/** The panel the most recent popOut() created through the vscode mock. */
function lastPopOutPanel(): { webview: { postMessage: jest.Mock } } {
    const results = jest.mocked(vscode.window.createWebviewPanel).mock.results;
    return results[results.length - 1].value;
}

type StateMessage = { type: 'state'; threads: ThreadState[]; activeThreadId: string };

function isStateMessage(message: Posted): message is StateMessage {
    return message.type === 'state';
}

function lastState(webview: FakeWebview): StateMessage {
    const states = webview.posted.filter(isStateMessage);
    return states[states.length - 1];
}

function threadOf(webview: FakeWebview, threadId: string): ThreadState {
    const thread = lastState(webview).threads.find(t => t.id === threadId);
    expect(thread).toBeDefined();
    return thread!;
}

/** Transcript callback the provider registered for the last resumed session. */
function lastTranscriptSink(gateway: GatewayChatService): (event: ChatEvent) => void {
    const calls = jest.mocked(gateway.resumeSession).mock.calls;
    return calls[calls.length - 1][1];
}

describe('ChatViewProvider', () => {
    let gateway: GatewayChatService;

    beforeEach(() => {
        jest.useFakeTimers();
        (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = [{ uri: vscode.Uri.file('/work') }];
        gateway = makeGateway();
        mockResolve.mockReset();
        mockResolve.mockResolvedValue({ service: gateway, transport: 'gateway' });
        jest.mocked(vscode.window.showInformationMessage).mockClear();
    });

    afterEach(() => {
        jest.useRealTimers();
        (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = undefined;
        (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = undefined;
    });

    describe('openSession', () => {
        it('opens into the requesting thread, not the active one', async () => {
            const { sidebar } = makeProvider();
            await sidebar.send({ type: 'newSession' });
            expect(lastState(sidebar).activeThreadId).toBe('thread-2');

            jest.mocked(gateway.getHistory).mockResolvedValue(historySnapshot([{ role: 'user', text: 'q', id: 'u1' }]));
            await sidebar.send({ type: 'openSession', sessionKey: 'agent:coder:main', threadId: 'thread-1' });
            await flush();

            expect(threadOf(sidebar, 'thread-1').messages).toEqual([{ role: 'user', content: 'q' }]);
            expect(threadOf(sidebar, 'thread-2').messages).toEqual([]);
        });

        it('rejects a message without a known threadId', async () => {
            const { sidebar } = makeProvider();
            await sidebar.send({ type: 'openSession', sessionKey: 'agent:coder:main' });
            await sidebar.send({ type: 'openSession', sessionKey: 'agent:coder:main', threadId: 'thread-9' });
            await flush();
            expect(gateway.getHistory).not.toHaveBeenCalled();
        });

        it('renders restored assistant rows through the live reply renderer', async () => {
            const { sidebar } = makeProvider();
            const text = '**bold** <img src=x onerror=alert(1)>';
            jest.mocked(gateway.getHistory).mockResolvedValue(historySnapshot([{ role: 'assistant', text, id: 'a1' }]));
            await sidebar.send({ type: 'openSession', sessionKey: 'agent:coder:main', threadId: 'thread-1' });
            await flush();

            const [restored] = threadOf(sidebar, 'thread-1').messages;
            expect(restored).toEqual({ role: 'assistant', content: text, html: await renderMarkdown(text) });
            expect(restored.html).not.toContain('<img');
        });

        it('clears the previous session\'s usage when rebinding', async () => {
            const { sidebar } = makeProvider();
            await sidebar.send({ type: 'openSession', sessionKey: 'agent:main:main', threadId: 'thread-1' });
            await flush();
            lastTranscriptSink(gateway)({ type: 'usage', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 90_000 } });
            await flush();
            expect(threadOf(sidebar, 'thread-1').contextTokens).toBe(90_000);

            await sidebar.send({ type: 'openSession', sessionKey: 'agent:coder:main', threadId: 'thread-1' });
            await flush();
            expect(threadOf(sidebar, 'thread-1').contextTokens).toBe(0);
            expect(threadOf(sidebar, 'thread-1').lastUsage).toBeNull();
        });

        it('shows the cold placeholder as a transient notice, not a transcript message', async () => {
            const { sidebar } = makeProvider();
            await sidebar.send({ type: 'openSession', sessionKey: 'agent:cold:main', threadId: 'thread-1' });
            await flush();
            expect(threadOf(sidebar, 'thread-1').messages).toEqual([]);
            expect(threadOf(sidebar, 'thread-1').notice).toBe(COLD_SESSION_PLACEHOLDER);

            lastTranscriptSink(gateway)({ type: 'done' });
            await flush();
            expect(threadOf(sidebar, 'thread-1').notice).toBeUndefined();
        });
    });

    describe('reply replacement', () => {
        async function runSink(sidebar: FakeWebview): Promise<(event: ChatEvent) => void> {
            await sidebar.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            const calls = jest.mocked(gateway.sendMessage).mock.calls;
            return calls[calls.length - 1][0].onEvent;
        }

        function assistantRows(sidebar: FakeWebview): unknown[] {
            return threadOf(sidebar, 'thread-1').messages.filter(m => m.role === 'assistant').map(m => m.content);
        }

        it('replaces the streaming text in place, and the webview gets the replacement', async () => {
            const { sidebar } = makeProvider();
            const run = await runSink(sidebar);
            run({ type: 'text', text: 'draft' });
            run({ type: 'text', text: ' more' });
            run({ type: 'textReplace', text: 'final answer' });
            await flush();
            expect(sidebar.posted.filter(m => m.type === 'textUpdate').pop()).toMatchObject({ threadId: 'thread-1', text: 'final answer' });
            run({ type: 'done' });
            await flush();
            expect(assistantRows(sidebar)).toEqual(['final answer']);
        });

        it('replaces the reply already committed as the last row, and starts anew after a tool row', async () => {
            const { sidebar } = makeProvider();
            const run = await runSink(sidebar);
            run({ type: 'text', text: 'before the tool' });
            run({ type: 'toolCall', title: 'read', status: 'running', details: '' });
            run({ type: 'textReplace', text: 'after the tool' });
            await flush();
            run({ type: 'done' });
            await flush();
            expect(assistantRows(sidebar)).toEqual(['before the tool', 'after the tool']);
        });

        it('leaves no reply row when the text is replaced with nothing, streaming or already committed', async () => {
            const { sidebar } = makeProvider();
            const run = await runSink(sidebar);
            run({ type: 'text', text: 'never kept' });
            run({ type: 'textReplace', text: '' });
            run({ type: 'done' });
            await flush();
            expect(assistantRows(sidebar)).toEqual([]);
            const next = await runSink(sidebar);
            next({ type: 'text', text: 'shown' });
            next({ type: 'done' });
            await flush();
            next({ type: 'textReplace', text: '' });
            await flush();
            expect(assistantRows(sidebar)).toEqual([]);
        });
    });

    describe('tool calls', () => {
        async function openWithRunningTool(sidebar: FakeWebview): Promise<(event: ChatEvent) => void> {
            await sidebar.send({ type: 'openSession', sessionKey: 'agent:main:main', threadId: 'thread-1' });
            await flush();
            const sink = lastTranscriptSink(gateway);
            sink({ type: 'toolCall', title: 'read', status: 'running', details: '' });
            await flush();
            return sink;
        }

        function toolStatuses(sidebar: FakeWebview): string[] {
            const tool = threadOf(sidebar, 'thread-1').messages.find(m => m.role === 'tool') as { entries: Array<{ status: string }> };
            return tool.entries.map(entry => entry.status);
        }

        /** Run sink of a send issued through the gateway. */
        async function sendAndCaptureRunSink(sidebar: FakeWebview): Promise<(event: ChatEvent) => void> {
            await sidebar.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            const calls = jest.mocked(gateway.sendMessage).mock.calls;
            return calls[calls.length - 1][0].onEvent;
        }

        it('marks unfinished entries done when the thread\'s own run completes', async () => {
            const { sidebar } = makeProvider();
            const run = await sendAndCaptureRunSink(sidebar);
            run({ type: 'toolCall', title: 'read', status: 'running', details: '' });
            run({ type: 'done' });
            await flush();
            expect(toolStatuses(sidebar)).toEqual(['done']);
        });

        it('marks unfinished entries cancelled when the thread\'s own run fails', async () => {
            const { sidebar } = makeProvider();
            const run = await sendAndCaptureRunSink(sidebar);
            run({ type: 'toolCall', title: 'read', status: 'running', details: '' });
            run({ type: 'error', message: 'boom' });
            await flush();
            expect(toolStatuses(sidebar)).toEqual(['cancelled']);
        });

        it('leaves entries open on a transcript replay `done` of an external run', async () => {
            const { sidebar } = makeProvider();
            const sink = await openWithRunningTool(sidebar);
            sink({ type: 'done' });
            await flush();
            expect(toolStatuses(sidebar)).toEqual(['running']);
        });

        it('marks unfinished entries cancelled when the user cancels', async () => {
            const { sidebar } = makeProvider();
            await openWithRunningTool(sidebar);
            await sidebar.send({ type: 'cancel', threadId: 'thread-1' });
            expect(toolStatuses(sidebar)).toEqual(['cancelled']);
        });
    });

    describe('sessions list', () => {
        it('replies only to the requesting webview, echoing its threadId', async () => {
            const { provider, sidebar } = makeProvider();
            provider.popOut();
            const popout = lastPopOutPanel().webview;
            await sidebar.send({ type: 'requestSessions', threadId: 'thread-1' });

            const reply = sidebar.posted.find(m => m.type === 'sessionsList');
            expect(reply).toMatchObject({ threadId: 'thread-1', error: undefined });
            expect((reply!.sessions as Array<{ sessionKey: string }>).map(s => s.sessionKey)).toContain('agent:coder:main');
            expect(jest.mocked(popout.postMessage).mock.calls.some(([m]) => m.type === 'sessionsList')).toBe(false);
        });

        it('reports an unavailable gateway instead of staying silent', async () => {
            const { sidebar } = makeProvider();
            mockResolve.mockResolvedValue({ service: {}, transport: 'acpx' });
            await sidebar.send({ type: 'requestSessions', threadId: 'thread-1' });
            mockResolve.mockRejectedValue(new Error('invalid gateway URL'));
            await sidebar.send({ type: 'requestSessions', threadId: 'thread-1' });

            const replies = sidebar.posted.filter(m => m.type === 'sessionsList');
            expect(replies).toEqual([
                { type: 'sessionsList', sessions: [], error: 'Gateway not connected', threadId: 'thread-1' },
                { type: 'sessionsList', sessions: [], error: 'Gateway error: invalid gateway URL', threadId: 'thread-1' },
            ]);
        });

        it('reports a failed sessions.list', async () => {
            const { sidebar } = makeProvider();
            jest.mocked(gateway.listSessions).mockRejectedValue(new Error('rpc down'));
            await sidebar.send({ type: 'requestSessions', threadId: 'thread-1' });
            expect(sidebar.posted.find(m => m.type === 'sessionsList')).toMatchObject({ sessions: [], error: 'Could not load sessions' });
        });
    });

    describe('insertMention', () => {
        beforeEach(() => {
            (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = {
                document: { uri: vscode.Uri.file('/work/a.ts'), languageId: 'typescript', getText: () => 'x' },
                selection: { isEmpty: true },
            };
            jest.mocked(vscode.workspace.asRelativePath).mockReturnValue('a.ts');
        });

        it('reveals the hidden chat view and delivers once its page is ready', async () => {
            const { provider, sidebar } = makeProvider();
            sidebar.view.visible = false;
            await provider.insertSelectionMention();
            expect(sidebar.view.show).toHaveBeenCalledWith(true);
            expect(sidebar.posted.filter(m => m.type === 'insertMention')).toHaveLength(0);

            await sidebar.send({ type: 'requestState' });
            await sidebar.send({ type: 'requestState' });
            expect(sidebar.posted.filter(m => m.type === 'insertMention')).toEqual([{ type: 'insertMention', mention: '@a.ts' }]);
        });

        it('tells the user when no chat view exists', async () => {
            await new ChatViewProvider(vscode.Uri.file('/ext'), makeContext()).insertSelectionMention();
            expect(vscode.window.showInformationMessage).toHaveBeenCalled();
        });
    });

    describe('send failures', () => {
        it('reports a throwing send in the thread', async () => {
            const { sidebar } = makeProvider();
            jest.mocked(gateway.sendMessage).mockImplementation(() => { throw new Error('boom'); });
            await sidebar.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            const messages = threadOf(sidebar, 'thread-1').messages;
            expect(messages[messages.length - 1]).toEqual({ role: 'error', content: 'Send failed: boom' });
            expect(threadOf(sidebar, 'thread-1').status).toBe('error');
        });

        it('adds no failure row to a thread cleared meanwhile', async () => {
            const { sidebar } = makeProvider();
            jest.mocked(gateway.sendMessage).mockImplementation(() => {
                void sidebar.send({ type: 'clearThread', threadId: 'thread-1' });
                throw new Error('boom');
            });
            await sidebar.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await sidebar.send({ type: 'requestState' });
            expect(threadOf(sidebar, 'thread-1').messages).toEqual([]);
        });

        it('reports a throwing slash command instead of rejecting the message handler', async () => {
            const { sidebar } = makeProvider();
            jest.mocked(gateway.sendMessage).mockImplementation(() => { throw new Error('boom'); });
            await expect(sidebar.send({ type: 'slashCommand', threadId: 'thread-1', command: 'plan', text: 'x' })).resolves.toBeUndefined();
            await flush();
            const messages = threadOf(sidebar, 'thread-1').messages;
            expect(messages[messages.length - 1]).toEqual({ role: 'error', content: 'Send failed: boom' });
        });

        it('never revives a cancelled send when a later send\'s resolve invalidates the gateway', async () => {
            const { sidebar } = makeProvider();
            await sidebar.send({ type: 'openSession', sessionKey: 'agent:main:main', threadId: 'thread-1' });
            await flush();
            const resolves: Array<() => void> = [];
            mockResolve.mockImplementation(() => new Promise(resolve => {
                resolves.push(() => resolve({ service: gateway, transport: 'gateway' }));
            }));

            void sidebar.send({ type: 'send', threadId: 'thread-1', text: 'first' });
            await flush();
            await sidebar.send({ type: 'cancel', threadId: 'thread-1' });
            void sidebar.send({ type: 'send', threadId: 'thread-1', text: 'second' });
            await flush();
            expect(resolves).toHaveLength(2);
            mockFactoryCallbacks.onInvalidated!('transport');
            resolves.forEach(resolve => resolve());
            await flush();

            expect(jest.mocked(gateway.sendMessage).mock.calls.map(call => call[0].prompt)).toEqual(['second']);
        });
    });

    describe('sending with attachments', () => {
        it('sends the prompt once the attachments are read', async () => {
            const dir = jest.requireActual<typeof import('fs')>('fs').mkdtempSync('/tmp/claw-send-');
            const file = `${dir}/note.txt`;
            jest.requireActual<typeof import('fs')>('fs').writeFileSync(file, 'attached body');
            try {
                const { sidebar } = makeProvider();
                (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = [{ uri: vscode.Uri.file('/work') }, { uri: vscode.Uri.file('/tmp') }];
                await sidebar.send({ type: 'attachFiles', threadId: 'thread-1', filePaths: [file] });
                await flush();

                await sidebar.send({ type: 'send', threadId: 'thread-1', text: 'with attachment' });
                await flush();

                const sent = jest.mocked(gateway.sendMessage).mock.calls.map(call => call[0].prompt);
                expect(sent).toHaveLength(1);
                expect(sent[0]).toContain('with attachment');
                expect(sent[0]).toContain(file);
            } finally {
                jest.requireActual<typeof import('fs')>('fs').rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    describe('inbound message validation', () => {
        it('never routes a message with an unknown threadId to the active thread', async () => {
            const { sidebar } = makeProvider();
            await sidebar.send({ type: 'send', threadId: 'thread-9', text: 'hi' });
            await sidebar.send({ type: 'send', threadId: 'thread-1', text: 42 });
            await sidebar.send({ type: 'requestState' });
            await flush();
            expect(lastState(sidebar).threads[0].messages).toEqual([]);
        });

        it('removes an attachment only for an in-range integer index', async () => {
            const { sidebar } = makeProvider();
            (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = [{ uri: vscode.Uri.file('/work') }, { uri: vscode.Uri.file('/tmp') }];
            await sidebar.send({ type: 'attachFiles', threadId: 'thread-1', filePaths: ['/tmp/claw-a.txt'] });
            await flush();
            for (const index of [-1, 1, 0.5, '0']) {
                await sidebar.send({ type: 'removeAttachment', threadId: 'thread-1', index });
            }
            expect(threadOf(sidebar, 'thread-1').pendingAttachments).toHaveLength(1);

            await sidebar.send({ type: 'removeAttachment', threadId: 'thread-1', index: 0 });
            expect(threadOf(sidebar, 'thread-1').pendingAttachments).toHaveLength(0);
        });

        it('writes a dimension only when the host accepts it', async () => {
            const update = jest.fn(async () => undefined);
            const config: vscode.WorkspaceConfiguration = {
                get: ((_section: string, defaultValue?: unknown) => defaultValue) as vscode.WorkspaceConfiguration['get'],
                has: () => false,
                inspect: () => undefined,
                update,
            };
            const getConfiguration = jest.mocked(vscode.workspace.getConfiguration);
            const original = getConfiguration.getMockImplementation();
            getConfiguration.mockImplementation(() => config);
            try {
                const { sidebar } = makeProvider();
                await sidebar.send({ type: 'setDimension', dimension: '9x9' });
                expect(update).not.toHaveBeenCalled();

                await sidebar.send({ type: 'setDimension', dimension: '2x3' });
                expect(update.mock.calls).toEqual([
                    ['chat.dimension', '2x3', vscode.ConfigurationTarget.Global],
                ]);
            } finally {
                getConfiguration.mockImplementation(original);
            }
        });
    });

    describe('connectGatewayTransport', () => {
        it('surfaces a gateway resolution failure to its caller', async () => {
            const { provider } = makeProvider();
            mockResolve.mockRejectedValue(new Error('invalid gateway URL'));
            await expect(provider.connectGatewayTransport()).rejects.toThrow('invalid gateway URL');
        });
    });

    describe('bootstrap', () => {
        const slashCommandPushes = (webview: FakeWebview): Posted[] => webview.posted.filter(m => m.type === 'slashCommands');

        it('pushes the slash commands once the webview had time to load', () => {
            const { sidebar } = makeProvider();
            jest.advanceTimersByTime(100);
            expect(slashCommandPushes(sidebar)).toHaveLength(1);
        });

        it('pushes nothing after the provider is disposed', () => {
            const { provider, sidebar } = makeProvider();
            provider.dispose();
            jest.advanceTimersByTime(100);
            expect(slashCommandPushes(sidebar)).toEqual([]);
        });

        it('pushes nothing after the view is disposed', () => {
            const { sidebar } = makeProvider();
            const [onViewDisposed] = jest.mocked(sidebar.view.onDidDispose).mock.calls[0];
            onViewDisposed();
            jest.advanceTimersByTime(100);
            expect(slashCommandPushes(sidebar)).toEqual([]);
        });
    });

    describe('transport status', () => {
        it('replays the last status to a newly resolved webview', async () => {
            const { provider } = makeProvider();
            mockFactoryCallbacks.onStatus!('gateway', true, 4);
            provider.popOut();
            const popoutPanel = lastPopOutPanel();
            jest.advanceTimersByTime(100);
            expect(popoutPanel.webview.postMessage).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'transportStatus', protocolVersion: 4, label: 'gateway v4 · connected' })
            );
        });

        it('names only the transport when no gateway protocol was negotiated', async () => {
            const { sidebar } = makeProvider();
            mockFactoryCallbacks.onStatus!('gateway', false, null);
            mockFactoryCallbacks.onStatus!('acpx', true, null);
            const labels = sidebar.posted.filter(m => m.type === 'transportStatus').map(m => m.label);
            expect(labels).toEqual(['gateway · offline', 'acpx · connected']);
        });

        it('names the transport change when it interrupts a run', async () => {
            const { sidebar } = makeProvider();
            await sidebar.send({ type: 'openSession', sessionKey: 'agent:main:main', threadId: 'thread-1' });
            await flush();
            lastTranscriptSink(gateway)({ type: 'text', text: 'partial' });
            await flush();

            mockFactoryCallbacks.onInvalidated!('transport');
            const messages = threadOf(sidebar, 'thread-1').messages;
            expect(messages[messages.length - 1]).toEqual({
                role: 'error',
                content: 'The chat transport changed. The active run was interrupted; send the message again.',
            });
        });
    });
});
