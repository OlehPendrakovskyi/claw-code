import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DOMWindow, JSDOM, VirtualConsole } from 'jsdom';
import { getWebviewContent } from '../webview/content';
import { GRID_DIMENSIONS, TOOL_STATUS_JS } from '../webview/content-js';
import type { ThreadSnapshot } from '../webview/viewMessaging';

type Message = Record<string, unknown>;

type Webview = {
    window: DOMWindow;
    document: Document;
    posted: Message[];
    /** Style attributes the webview's CSP would have dropped from parsed markup. */
    blockedStyles: string[];
    crashes: string[];
    host(message: Message): void;
};

const loaded: Webview[] = [];

/** CSP `style-src 'nonce-…'` ignores style attributes parsed from markup; CSSOM writes still apply. */
function emulateStyleAttributeCsp(window: DOMWindow, blockedStyles: string[]): void {
    const innerHTML = Object.getOwnPropertyDescriptor(window.Element.prototype, 'innerHTML');
    if (!innerHTML?.set) {
        throw new Error('jsdom exposes no innerHTML setter');
    }
    const setInnerHTML = innerHTML.set;
    Object.defineProperty(window.Element.prototype, 'innerHTML', {
        ...innerHTML,
        set(this: Element, markup: string) {
            setInnerHTML.call(this, markup);
            const root = this instanceof window.HTMLTemplateElement ? this.content : this;
            root.querySelectorAll('[style]').forEach(el => {
                blockedStyles.push(el.getAttribute('style') ?? '');
                el.removeAttribute('style');
            });
        },
    });
}

function loadWebview(): Webview {
    const posted: Message[] = [];
    const blockedStyles: string[] = [];
    const crashes: string[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('error', (...args: unknown[]) => crashes.push(args.map(String).join(' ')));
    virtualConsole.on('jsdomError', (err: Error) => crashes.push(err.stack ?? err.message));
    const html = getWebviewContent({ cspSource: 'vscode-webview:' } as vscode.Webview, vscode.Uri.file('/ext'), true);
    const dom = new JSDOM(html, {
        runScripts: 'dangerously',
        virtualConsole,
        beforeParse(window) {
            Object.assign(window, { acquireVsCodeApi: () => ({ postMessage: (message: Message) => posted.push(message) }) });
            emulateStyleAttributeCsp(window, blockedStyles);
        },
    });
    const { window } = dom;
    const webview: Webview = {
        window,
        document: window.document,
        posted,
        blockedStyles,
        crashes,
        host: message => window.dispatchEvent(new window.MessageEvent('message', { data: message })),
    };
    loaded.push(webview);
    return webview;
}

function thread(id: string, overrides: Message = {}): Message {
    const base: ThreadSnapshot = {
        id,
        index: Number(id.replace(/\D/g, '')) || 1,
        title: `Thread ${id}`,
        messages: [],
        pendingAssistantText: '',
        pendingAttachments: [],
        currentChatType: 'chat',
        currentModel: 'codex',
        permissionState: 'approve-reads',
        isStreaming: false,
        status: 'idle',
        source: 'API',
        contextTokens: 0,
        contextMax: 128000,
        lastUsage: null,
    };
    return { ...base, ...overrides };
}

function hostState(webview: Webview, threads: Message[], extra: Message = {}): void {
    webview.host({
        type: 'state',
        activeThreadId: threads.length ? threads[0].id : '',
        threads,
        models: ['codex', 'claude'],
        dimension: '1x1',
        ...extra,
    });
}

function tick(webview: Webview, ms = 0): Promise<void> {
    return new Promise(resolve => webview.window.setTimeout(resolve, ms));
}

function byThread<T extends Element>(webview: Webview, selector: string, threadId: string): T {
    const match = Array.from(webview.document.querySelectorAll<T>(selector))
        .find(el => el.getAttribute('data-thread-id') === threadId);
    if (!match) {
        throw new Error(`no ${selector} for ${threadId}`);
    }
    return match;
}

function composer(webview: Webview, threadId: string): HTMLTextAreaElement {
    return byThread<HTMLTextAreaElement>(webview, '.composer-input', threadId);
}

function paneOf(webview: Webview, threadId: string): HTMLElement {
    return byThread<HTMLElement>(webview, '.pane', threadId);
}

function action(webview: Webview, name: string, threadId: string): HTMLElement {
    return byThread<HTMLElement>(webview, `[data-action="${name}"]`, threadId);
}

/** Focus first: focusing an inactive pane re-renders it, so the field is looked up again afterwards. */
function typeInto(webview: Webview, findField: () => HTMLTextAreaElement | HTMLInputElement, text: string, init: InputEventInit = {}): void {
    findField().focus();
    const field = findField();
    field.value = text;
    field.setSelectionRange(text.length, text.length);
    field.dispatchEvent(new webview.window.InputEvent('input', { bubbles: true, ...init }));
}

function press(webview: Webview, target: Element, key: string, init: KeyboardEventInit = {}): void {
    target.dispatchEvent(new webview.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
}

function click(webview: Webview, target: Element): void {
    target.dispatchEvent(new webview.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

function postedOfType(webview: Webview, type: string): Message[] {
    return webview.posted.filter(message => message.type === type);
}

function dropUriList(webview: Webview, target: Element, uriList: string): void {
    const drop = new webview.window.Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
        value: { types: ['text/uri-list'], getData: (type: string) => (type === 'text/uri-list' ? uriList : '') },
    });
    target.dispatchEvent(drop);
}

function loadToolStatus(): {
    getToolGroupStatus(entries: Array<{ status: string }>): string;
    shouldOpenToolGroup(status: string): boolean;
    getToolStatusSymbol(status: string): string;
    getToolStatusClass(status: string): string;
} {
    return new Function(
        `${TOOL_STATUS_JS}; return { getToolGroupStatus, shouldOpenToolGroup, getToolStatusSymbol, getToolStatusClass };`
    )();
}

const XSS = '<img src=x onerror="window.pwned=1">"\'';

const SESSIONS = [
    { sessionKey: 'agent:main:main', label: 'Main', hasActiveRun: true },
    { sessionKey: 'agent:coder:main', label: 'Coder', cold: true },
];

function sessionRows(webview: Webview): HTMLElement[] {
    const panel = webview.document.getElementById('claw-sessions-panel');
    return panel ? Array.from(panel.querySelectorAll<HTMLElement>('[role="menuitem"]')) : [];
}

describe('content-js', () => {
    afterEach(() => {
        const crashes = loaded.flatMap(webview => [
            ...webview.crashes,
            ...Array.from(webview.document.querySelectorAll('.openclaw-crash'), el => el.textContent ?? ''),
        ]);
        loaded.splice(0).forEach(webview => webview.window.close());
        expect(crashes).toEqual([]);
    });

    describe('tool status', () => {
        const status = loadToolStatus();

        it('reports running while any entry is non-terminal, even beside a failure', () => {
            expect(status.getToolGroupStatus([{ status: 'error' }, { status: 'running' }])).toBe('running');
        });

        it('reports error, cancelled, then done once every entry is terminal', () => {
            expect(status.getToolGroupStatus([{ status: 'done' }, { status: 'failed' }, { status: 'cancelled' }])).toBe('error');
            expect(status.getToolGroupStatus([{ status: 'done' }, { status: 'cancelled' }])).toBe('cancelled');
            expect(status.getToolGroupStatus([{ status: 'done' }])).toBe('done');
        });

        it('opens running and failed groups only', () => {
            expect(['running', 'error', 'cancelled', 'done'].map(status.shouldOpenToolGroup)).toEqual([true, true, false, false]);
        });

        it('gives each status its own glyph and class', () => {
            expect(['done', 'error', 'cancelled', 'running'].map(status.getToolStatusSymbol)).toEqual(['✓', '✗', '⊘', '⟳']);
            expect(['done', 'failed', 'cancelled', 'pending'].map(status.getToolStatusClass)).toEqual([' tool-ok', ' tool-fail', ' tool-cancel', ' tool-run']);
        });
    });

    describe('boot', () => {
        it('shows an empty grid and asks the host for state and recommendations', () => {
            const webview = loadWebview();
            expect(webview.document.getElementById('paneGrid')?.textContent).toContain('No threads available.');
            expect(webview.posted).toEqual([{ type: 'requestState' }, { type: 'requestRecommendations' }]);
        });
    });

    describe('rendering', () => {
        it.each([1, 3])('renders %i panes in order, each composer bound to its own thread', count => {
            const webview = loadWebview();
            const threads = Array.from({ length: count }, (_, i) => thread(`thread-${i + 1}`));
            hostState(webview, threads);
            const panes = Array.from(webview.document.querySelectorAll<HTMLElement>('.pane'));
            expect(panes.map(pane => pane.dataset.threadId)).toEqual(threads.map(t => t.id));
            panes.forEach(pane => {
                expect(pane.querySelector('.composer-input')?.getAttribute('data-thread-id')).toBe(pane.dataset.threadId);
            });
        });

        it('renders every untrusted string as text, never as markup', () => {
            const webview = loadWebview();
            const hostile = thread('t"1', {
                title: XSS,
                source: XSS,
                currentModel: XSS,
                currentChatType: XSS,
                status: `idle" onclick="x`,
                index: XSS,
                contextMax: XSS,
                contextTokens: XSS,
                lastUsage: { totalTokens: XSS },
                pendingAttachments: [{ name: XSS, path: XSS, type: 'file' }],
                messages: [
                    { role: 'user', content: XSS },
                    { role: 'assistant', content: XSS },
                    { role: 'error', content: XSS },
                    { role: 'tool', entries: [{ title: XSS, status: XSS, details: XSS }] },
                ],
            });
            hostState(webview, [hostile, thread('t2', { notice: XSS })], { models: [XSS] });
            click(webview, action(webview, 'toggle-model', 't"1'));
            expect(webview.document.querySelectorAll('img')).toHaveLength(0);
            expect(webview.document.querySelectorAll('[onerror], [onclick]')).toHaveLength(0);
            expect(paneOf(webview, 't"1').querySelector('.pane-title')?.textContent).toBe(XSS);
            expect(paneOf(webview, 't2').querySelector('.pane-empty')?.textContent).toBe(XSS);
            expect(composer(webview, 't"1')).toBeDefined();
        });

        it('round-trips entity-like and quoting values through every attribute sink exactly', async () => {
            const webview = loadWebview();
            const tricky = 'a&amp;b&quot;c<d>"e\'&lt;f&#39;';
            const id = `t${tricky}`;
            hostState(webview, [thread(id, {
                pendingAttachments: [{ name: tricky, path: `/w/${tricky}`, type: 'file' }],
            })], { activeThreadId: id, models: [tricky] });
            webview.host({ type: 'recommendations', items: [{ command: `/explain ${tricky}`, icon: '?', label: 'x' }] });

            expect(paneOf(webview, id).dataset.threadId).toBe(id);
            expect(action(webview, 'remove-attachment', id).getAttribute('aria-label')).toBe(`Remove ${tricky}`);
            expect(paneOf(webview, id).querySelector('.att-pill-name')?.getAttribute('title')).toBe(`/w/${tricky}`);

            click(webview, action(webview, 'toggle-model', id));
            click(webview, action(webview, 'select-model', id));
            expect(postedOfType(webview, 'setModel')).toEqual([{ type: 'setModel', threadId: id, model: tricky }]);

            click(webview, action(webview, 'toggle-recs', id));
            click(webview, action(webview, 'use-recommendation', id));
            expect(composer(webview, id).value).toBe(`/explain ${tricky} `);

            typeInto(webview, () => composer(webview, id), '@w');
            await tick(webview, 150);
            webview.host({ type: 'fileSearchResults', threadId: id, query: 'w', files: [{ name: tricky, path: `/w/${tricky}`, relativePath: tricky }] });
            click(webview, action(webview, 'pick-file', id));
            expect(postedOfType(webview, 'attachFile')).toEqual([{ type: 'attachFile', threadId: id, filePath: `/w/${tricky}` }]);

            click(webview, action(webview, 'sessions', id));
            webview.host({ type: 'sessionsList', threadId: id, sessions: [{ sessionKey: `agent:${tricky}`, label: tricky }] });
            click(webview, sessionRows(webview)[0]);
            expect(postedOfType(webview, 'openSession')).toEqual([{ type: 'openSession', sessionKey: `agent:${tricky}`, threadId: id }]);
        });

        it('strips non-web link targets from assistant HTML and keeps web links', () => {
            const webview = loadWebview();
            const html = '<a href="javascript:alert(1)">bad</a> <a href=" command:workbench.action.terminal.new">cmd</a> <a href="https://example.com">ok</a>';
            hostState(webview, [thread('t1', { messages: [{ role: 'assistant', content: 'links', html }] })]);
            const links = Array.from(webview.document.querySelectorAll('.message-assistant a'));
            expect(links.map(link => [link.textContent, link.getAttribute('href')])).toEqual([
                ['bad', null],
                ['cmd', null],
                ['ok', 'https://example.com'],
            ]);
        });

        it('draws the context gauge through CSSOM, not style attributes the CSP drops', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1', { contextTokens: 32000, contextMax: 128000 })]);
            click(webview, action(webview, 'toggle-model', 't1'));
            const fill = paneOf(webview, 't1').querySelector<HTMLElement>('.context-bar-fill');
            expect(fill?.style.width).toBe('25%');
            expect(webview.blockedStyles).toEqual([]);
        });

        it('hides done and cancelled tool groups when hideToolActivity is on, keeping running and failed ones', () => {
            const webview = loadWebview();
            const messages = [
                { role: 'tool', entries: [{ title: 'read', status: 'done', details: '' }] },
                { role: 'tool', entries: [{ title: 'stopped', status: 'cancelled', details: '' }] },
                { role: 'tool', entries: [{ title: 'broke', status: 'error', details: '' }] },
                { role: 'tool', entries: [{ title: 'write', status: 'running', details: '' }] },
            ];
            hostState(webview, [thread('t1', { messages })], { hideToolActivity: true });
            expect(Array.from(webview.document.querySelectorAll('.message-tool-entry-title'), el => el.textContent)).toEqual(['broke', 'write']);
            hostState(webview, [thread('t1', { messages })], { hideToolActivity: false });
            expect(webview.document.querySelectorAll('.message-tool')).toHaveLength(4);
        });

        it('keeps a tool group the user expanded open across re-renders', async () => {
            const webview = loadWebview();
            const messages = [{ role: 'tool', entries: [{ id: 'call-1', title: 'read', status: 'done', details: 'ok' }] }];
            hostState(webview, [thread('t1', { messages })]);
            const group = webview.document.querySelector<HTMLDetailsElement>('.message-tool');
            expect(group?.open).toBe(false);
            group!.open = true;
            await tick(webview);
            hostState(webview, [thread('t1', { messages: [...messages, { role: 'user', content: 'more' }] })]);
            expect(webview.document.querySelector<HTMLDetailsElement>('.message-tool')?.open).toBe(true);
        });

        it('shows a pane its own streamed text only, escaped, with the Stop control', () => {
            const webview = loadWebview();
            hostState(webview, [thread('a"1'), thread('b2')]);
            webview.host({ type: 'textUpdate', threadId: 'a"1', text: XSS });
            const pending = paneOf(webview, 'a"1').querySelector('.message-pending');
            expect(pending?.textContent).toBe(XSS);
            expect(webview.document.querySelectorAll('img')).toHaveLength(0);
            expect(paneOf(webview, 'b2').querySelector('.message-pending')).toBeNull();
            expect(paneOf(webview, 'a"1').querySelector('.btn-send')?.getAttribute('data-action')).toBe('cancel');
            expect(paneOf(webview, 'a"1').querySelector('.pane-status')?.textContent).toBe('Running');
        });

        it('shows run notices as escaped status rows after the messages, and drops them when the host does', () => {
            const webview = loadWebview();
            const messages = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }];
            hostState(webview, [thread('t1', { messages, runNotices: [XSS, 'Stopped: output limit reached.'] })]);
            const rows = [...paneOf(webview, 't1').querySelectorAll('.pane-body > .message')];
            expect(rows.map(row => row.className)).toEqual([
                'message message-user', 'message message-assistant', 'message message-notice', 'message message-notice',
            ]);
            expect(rows[2].textContent).toBe(XSS);
            expect(rows[2].getAttribute('role')).toBe('status');
            expect(webview.document.querySelectorAll('img')).toHaveLength(0);
            hostState(webview, [thread('t1', { messages, runNotices: [] })]);
            expect(paneOf(webview, 't1').querySelectorAll('.message-notice')).toHaveLength(0);
        });

        it('ignores streamed text for a thread it does not show', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            webview.host({ type: 'textUpdate', threadId: 'gone', text: 'hello' });
            expect(webview.document.querySelectorAll('.message-pending')).toHaveLength(0);
        });

        it('labels the transport badge as text', () => {
            const webview = loadWebview();
            webview.host({ type: 'transportStatus', label: XSS });
            webview.host({ type: 'transportStatus', label: 'gateway · connected' });
            const badges = webview.document.querySelectorAll('#claw-transport-status');
            expect(badges).toHaveLength(1);
            expect(badges[0].textContent).toBe('gateway · connected');
        });
    });

    describe('grid dimension', () => {
        it('offers exactly the layouts the host accepts and package.json declares', () => {
            const webview = loadWebview();
            const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
            const declared = manifest.contributes.configuration.properties['openclaw.chat.dimension'].enum;
            const options = Array.from(webview.document.querySelectorAll<HTMLOptionElement>('#dimensionSelect option'), o => o.value);
            expect(options).toEqual(declared);
            expect(options).toEqual(GRID_DIMENSIONS);
            expect(webview.document.getElementById('btn-flip')).toBeNull();
        });

        it.each(GRID_DIMENSIONS)('lays out %s and still renders every thread', dimension => {
            const webview = loadWebview();
            const [cols, rows] = dimension.split('x');
            const threads = Array.from({ length: Number(cols) * Number(rows) }, (_, i) => thread(`t${i + 1}`));
            hostState(webview, threads, { dimension });
            const grid = webview.document.getElementById('paneGrid')!;
            expect(grid.style.getPropertyValue('--grid-cols')).toBe(cols);
            expect(grid.style.getPropertyValue('--grid-rows')).toBe(rows);
            expect(webview.document.querySelectorAll('.pane')).toHaveLength(threads.length);
            expect(webview.document.querySelector<HTMLSelectElement>('#dimensionSelect')?.value).toBe(dimension);
        });

        it('posts the chosen layout and drops the 1x1-only collapse toggles at once', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1'), thread('t2')]);
            expect(webview.document.querySelectorAll('.pane-collapse-btn')).toHaveLength(2);
            const select = webview.document.querySelector<HTMLSelectElement>('#dimensionSelect')!;
            select.value = '2x2';
            select.dispatchEvent(new webview.window.Event('change', { bubbles: true }));
            expect(postedOfType(webview, 'setDimension')).toEqual([{ type: 'setDimension', dimension: '2x2' }]);
            expect(webview.document.querySelectorAll('.pane-collapse-btn')).toHaveLength(0);
        });

        it('ignores a dimension the host contract does not allow', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')], { dimension: '2x2' });
            hostState(webview, [thread('t1')], { dimension: '9x9' });
            expect(webview.document.querySelector<HTMLSelectElement>('#dimensionSelect')?.value).toBe('2x2');
        });
    });

    describe('composer', () => {
        it('keeps each pane draft, focus and caret through a host re-render', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1'), thread('t2')]);
            typeInto(webview, () => composer(webview, 't1'), 'draft one');
            composer(webview, 't1').setSelectionRange(3, 3);
            hostState(webview, [thread('t1'), thread('t2')]);
            const input = composer(webview, 't1');
            expect(input.value).toBe('draft one');
            expect(composer(webview, 't2').value).toBe('');
            expect(webview.document.activeElement).toBe(input);
            expect(input.selectionStart).toBe(3);
        });

        it('sends on Enter with the thread id and inserts a newline on Shift+Enter', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1'), thread('t2')], { activeThreadId: 't2' });
            typeInto(webview, () => composer(webview, 't1'), 'hello');
            press(webview, composer(webview, 't1'), 'Enter', { shiftKey: true });
            expect(postedOfType(webview, 'send')).toEqual([]);
            press(webview, composer(webview, 't1'), 'Enter');
            expect(postedOfType(webview, 'send')).toEqual([{ type: 'send', threadId: 't1', text: 'hello', clientId: 'send-1' }]);
            expect(composer(webview, 't1').value).toBe('');
        });

        it('does not send while an IME composition is confirming with Enter', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            typeInto(webview, () => composer(webview, 't1'), 'にほん');
            press(webview, composer(webview, 't1'), 'Enter', { isComposing: true });
            expect(postedOfType(webview, 'send')).toEqual([]);
        });

        it('leaves the textarea in place during a composition and catches up at its end', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            const input = composer(webview, 't1');
            typeInto(webview, () => input, '/ex', { isComposing: true });
            expect(composer(webview, 't1')).toBe(input);
            input.dispatchEvent(new webview.window.CompositionEvent('compositionend', { bubbles: true }));
            expect(webview.document.querySelector('.slash-dropdown.visible')).not.toBeNull();
        });

        it('sends a slash command with its multi-line text intact', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            typeInto(webview, () => composer(webview, 't1'), '/explain first line\nsecond line');
            press(webview, composer(webview, 't1'), 'Enter');
            expect(postedOfType(webview, 'slashCommand')).toEqual([
                { type: 'slashCommand', threadId: 't1', command: 'explain', text: 'first line\nsecond line', clientId: 'send-1' },
            ]);
        });

        it('navigates the slash menu with the arrows, picks with Enter and closes on Escape', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            typeInto(webview, () => composer(webview, 't1'), '/');
            const names = () => Array.from(webview.document.querySelectorAll('.slash-item'), el => el.getAttribute('data-command'));
            const active = () => webview.document.querySelector('.slash-item.active')?.getAttribute('data-command');
            expect(active()).toBe(names()[0]);
            press(webview, composer(webview, 't1'), 'ArrowDown');
            expect(active()).toBe(names()[1]);
            press(webview, composer(webview, 't1'), 'ArrowUp');
            press(webview, composer(webview, 't1'), 'ArrowUp');
            expect(active()).toBe(names()[0]);
            press(webview, composer(webview, 't1'), 'Enter');
            expect(composer(webview, 't1').value).toBe(`/${names()[0] ?? 'explain'} `);
            expect(postedOfType(webview, 'send')).toEqual([]);

            typeInto(webview, () => composer(webview, 't1'), '/re');
            expect(webview.document.querySelector('.slash-dropdown.visible')).not.toBeNull();
            press(webview, composer(webview, 't1'), 'Escape');
            expect(webview.document.querySelector('.slash-dropdown.visible')).toBeNull();
            expect(webview.document.activeElement).toBe(composer(webview, 't1'));
        });

        it('closes the model menu on Escape', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            click(webview, action(webview, 'toggle-model', 't1'));
            const search = byThread<HTMLInputElement>(webview, '.selector-search', 't1');
            search.focus();
            press(webview, search, 'Escape');
            expect(webview.document.querySelector('.selector-dropdown.visible')).toBeNull();
        });

        it('exposes the chat-type menu as a keyboard listbox', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            const trigger = action(webview, 'toggle-chat-type', 't1');
            expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
            expect(trigger.getAttribute('aria-expanded')).toBe('false');
            click(webview, trigger);
            expect(action(webview, 'toggle-chat-type', 't1').getAttribute('aria-expanded')).toBe('true');
            const options = Array.from(webview.document.querySelectorAll<HTMLElement>('[data-action="select-chat-type"]'));
            expect(options.map(o => [o.getAttribute('role'), o.getAttribute('aria-selected')])).toEqual([
                ['option', 'true'], ['option', 'false'], ['option', 'false'], ['option', 'false'],
            ]);
            expect(webview.document.activeElement).toBe(options[0]);
            press(webview, options[0], 'ArrowDown');
            press(webview, webview.document.activeElement!, 'ArrowDown');
            press(webview, webview.document.activeElement!, 'Enter');
            expect(postedOfType(webview, 'setChatType')).toEqual([{ type: 'setChatType', threadId: 't1', chatType: 'review' }]);
            expect(webview.document.querySelector('.selector-dropdown.visible')).toBeNull();
        });

        it('picks the first model match with Enter in the search box', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            click(webview, action(webview, 'toggle-model', 't1'));
            expect(webview.document.activeElement?.classList.contains('selector-search')).toBe(true);
            typeInto(webview, () => byThread<HTMLInputElement>(webview, '.selector-search', 't1'), 'cla');
            press(webview, byThread<HTMLInputElement>(webview, '.selector-search', 't1'), 'Enter');
            expect(postedOfType(webview, 'setModel')).toEqual([{ type: 'setModel', threadId: 't1', model: 'claude' }]);
        });

        it('names the attachment each remove button removes', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1', { pendingAttachments: [{ name: 'a.ts', path: '/w/a.ts', type: 'file' }] })]);
            const remove = action(webview, 'remove-attachment', 't1');
            expect([remove.getAttribute('aria-label'), remove.getAttribute('title')]).toEqual(['Remove a.ts', 'Remove a.ts']);
        });

        it('keeps typing in the model search box instead of jumping to the composer', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            click(webview, action(webview, 'toggle-model', 't1'));
            typeInto(webview, () => byThread<HTMLInputElement>(webview, '.selector-search', 't1'), 'cl');
            const search = byThread<HTMLInputElement>(webview, '.selector-search', 't1');
            expect(webview.document.activeElement).toBe(search);
            expect(search.value).toBe('cl');
            expect(Array.from(webview.document.querySelectorAll('[data-action="select-model"]'), el => el.getAttribute('data-value'))).toEqual(['claude']);
            click(webview, action(webview, 'select-model', 't1'));
            expect(postedOfType(webview, 'setModel')).toEqual([{ type: 'setModel', threadId: 't1', model: 'claude' }]);
        });

        it('queues a draft sent during a reply and delivers it without touching the next draft', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1', { isStreaming: true, status: 'running' })]);
            typeInto(webview, () => composer(webview, 't1'), 'follow up');
            press(webview, composer(webview, 't1'), 'Enter');
            expect(postedOfType(webview, 'cancel')).toEqual([]);
            expect(webview.document.querySelector('.queued-indicator')).not.toBeNull();
            typeInto(webview, () => composer(webview, 't1'), 'next draft');
            hostState(webview, [thread('t1', { status: 'complete' })]);
            expect(postedOfType(webview, 'send')).toEqual([{ type: 'send', threadId: 't1', text: 'follow up', clientId: 'send-1' }]);
            expect(composer(webview, 't1').value).toBe('next draft');
            expect(webview.document.querySelector('.queued-indicator')).toBeNull();
        });

        it('gives a rejected send back to the composer, ahead of anything typed since', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1'), thread('t2')]);
            typeInto(webview, () => composer(webview, 't1'), 'lost words');
            press(webview, composer(webview, 't1'), 'Enter');
            typeInto(webview, () => composer(webview, 't1'), 'newer');
            webview.host({ type: 'sendRejected', threadId: 't1', clientId: 'send-1' });
            expect(composer(webview, 't1').value).toBe('lost words\n\nnewer');
            expect(composer(webview, 't2').value).toBe('');
        });

        it('forgets a send once the host accepts it', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            typeInto(webview, () => composer(webview, 't1'), 'delivered');
            press(webview, composer(webview, 't1'), 'Enter');
            webview.host({ type: 'sendAccepted', threadId: 't1', clientId: 'send-1' });
            webview.host({ type: 'sendRejected', threadId: 't1', clientId: 'send-1' });
            expect(composer(webview, 't1').value).toBe('');
        });

        it('keeps a send the transcript already shows until the host settles it', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            typeInto(webview, () => composer(webview, 't1'), 'shown then retired');
            press(webview, composer(webview, 't1'), 'Enter');
            hostState(webview, [thread('t1', { messages: [{ role: 'user', content: 'shown then retired' }], isStreaming: true })]);
            webview.host({ type: 'sendRejected', threadId: 't1', clientId: 'send-1' });
            expect(composer(webview, 't1').value).toBe('shown then retired');
        });

        it('gives back only the rejected one of two pending sends', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            typeInto(webview, () => composer(webview, 't1'), 'first');
            press(webview, composer(webview, 't1'), 'Enter');
            typeInto(webview, () => composer(webview, 't1'), 'second');
            press(webview, composer(webview, 't1'), 'Enter');

            webview.host({ type: 'sendRejected', threadId: 't1', clientId: 'send-1' });

            expect(postedOfType(webview, 'send').map(m => m.text)).toEqual(['first', 'second']);
            expect(composer(webview, 't1').value).toBe('first');
        });

        it.each(['cancel', 'clear'])('returns a queued draft to the composer on %s instead of sending it', (actionName) => {
            const webview = loadWebview();
            hostState(webview, [thread('t1', { isStreaming: true, status: 'running' })]);
            typeInto(webview, () => composer(webview, 't1'), 'queued words');
            press(webview, composer(webview, 't1'), 'Enter');

            click(webview, action(webview, actionName, 't1'));
            hostState(webview, [thread('t1', { status: 'cancelled' })]);

            expect(postedOfType(webview, 'send')).toEqual([]);
            expect(composer(webview, 't1').value).toBe('queued words');
        });

        it('stops the reply on Escape, never on an empty Enter', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1', { isStreaming: true, status: 'running' })]);
            press(webview, composer(webview, 't1'), 'Enter');
            expect(postedOfType(webview, 'cancel')).toEqual([]);
            expect(paneOf(webview, 't1').querySelector('.composer-status')?.textContent).toContain('Esc stops');
            press(webview, composer(webview, 't1'), 'Escape');
            expect(postedOfType(webview, 'cancel')).toEqual([{ type: 'cancel', threadId: 't1' }]);
        });

        it('sends each queued draft as its own turn, slash commands included', () => {
            const webview = loadWebview();
            const running = () => hostState(webview, [thread('t1', { isStreaming: true, status: 'running' })]);
            const idle = () => hostState(webview, [thread('t1', { status: 'complete' })]);
            const acceptLast = () => {
                const last = webview.posted.filter(m => m.type === 'send' || m.type === 'slashCommand').pop();
                webview.host({ type: 'sendAccepted', threadId: 't1', clientId: last?.clientId });
            };
            running();
            ['hello', '/compact', '/explain now'].forEach(text => {
                typeInto(webview, () => composer(webview, 't1'), text);
                if (webview.document.querySelector('.slash-dropdown.visible')) {
                    press(webview, composer(webview, 't1'), 'Escape');
                }
                press(webview, composer(webview, 't1'), 'Enter');
            });
            webview.posted.splice(0);
            idle();
            idle();
            expect(webview.posted.map(m => [m.type, m.text ?? m.command])).toEqual([['send', 'hello']]);
            acceptLast();
            running();
            idle();
            acceptLast();
            running();
            idle();
            expect(webview.posted.map(m => [m.type, m.command ?? m.text, m.text])).toEqual([
                ['send', 'hello', 'hello'],
                ['slashCommand', 'compact', ''],
                ['slashCommand', 'explain', 'now'],
            ]);
        });

        it('keeps the textarea node, its leading newline and the transcript while typing', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1', { messages: [{ role: 'user', content: 'hi' }] })]);
            const input = composer(webview, 't1');
            const message = webview.document.querySelector('.message-user');
            typeInto(webview, () => input, '\nhello');
            expect(composer(webview, 't1')).toBe(input);
            expect(input.value).toBe('\nhello');
            expect(webview.document.querySelector('.message-user')).toBe(message);
        });

        it('leaves the textarea and an unchanged transcript alone on host pushes', () => {
            const webview = loadWebview();
            const messages = [{ role: 'user', content: 'hi' }];
            hostState(webview, [thread('t1', { messages })]);
            const input = composer(webview, 't1');
            const message = webview.document.querySelector('.message-user');
            webview.host({ type: 'recommendations', items: [] });
            hostState(webview, [thread('t1', { messages: messages.map(m => ({ ...m })), title: 'Renamed' })]);
            expect(composer(webview, 't1')).toBe(input);
            expect(webview.document.querySelector('.message-user')).toBe(message);
            expect(paneOf(webview, 't1').querySelector('.pane-title')?.textContent).toBe('Renamed');
            hostState(webview, [thread('t1', { messages: [...messages, { role: 'assistant', content: 'yo' }] })]);
            expect(webview.document.querySelectorAll('.message')).toHaveLength(2);
        });

        it('defers host renders while an IME composition is open and flushes at its end', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            const input = composer(webview, 't1');
            input.focus();
            input.dispatchEvent(new webview.window.CompositionEvent('compositionstart', { bubbles: true }));
            hostState(webview, [thread('t1', { title: 'Renamed' })]);
            expect(paneOf(webview, 't1').querySelector('.pane-title')?.textContent).toBe('Thread t1');
            input.dispatchEvent(new webview.window.CompositionEvent('compositionend', { bubbles: true }));
            expect(paneOf(webview, 't1').querySelector('.pane-title')?.textContent).toBe('Renamed');
            expect(composer(webview, 't1')).toBe(input);
        });
    });

    describe('file mentions', () => {
        async function openMention(webview: Webview, threadId: string, text: string): Promise<void> {
            typeInto(webview, () => composer(webview, threadId), text);
            await tick(webview, 150);
        }

        const FILES = [
            { name: 'a.ts', path: '/w/a.ts', relativePath: 'a.ts' },
            { name: 'b.ts', path: '/w/b.ts', relativePath: 'b.ts' },
        ];

        it('searches for the pane, then attaches the picked file and drops the @query', async () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            await openMention(webview, 't1', 'see @a');
            expect(postedOfType(webview, 'fileSearch')).toEqual([{ type: 'fileSearch', query: 'a', threadId: 't1' }]);
            webview.host({ type: 'fileSearchResults', threadId: 't1', query: 'a', files: FILES });
            press(webview, composer(webview, 't1'), 'ArrowDown');
            press(webview, composer(webview, 't1'), 'Enter');
            expect(postedOfType(webview, 'attachFile')).toEqual([{ type: 'attachFile', threadId: 't1', filePath: '/w/b.ts' }]);
            expect(composer(webview, 't1').value).toBe('see ');
        });

        it('ignores results that land after the mention closed', async () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            await openMention(webview, 't1', '@a');
            typeInto(webview, () => composer(webview, 't1'), '@a ');
            webview.host({ type: 'fileSearchResults', threadId: 't1', query: 'a', files: FILES });
            typeInto(webview, () => composer(webview, 't1'), '@a @');
            press(webview, composer(webview, 't1'), 'Enter');
            expect(postedOfType(webview, 'attachFile')).toEqual([]);
            expect(postedOfType(webview, 'send')).toEqual([{ type: 'send', threadId: 't1', text: '@a @', clientId: 'send-1' }]);
        });

        it('stops offering the previous query\'s results while the next one is searched', async () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            await openMention(webview, 't1', '@a');
            webview.host({ type: 'fileSearchResults', threadId: 't1', query: 'a', files: FILES });
            typeInto(webview, () => composer(webview, 't1'), '@ab');
            press(webview, composer(webview, 't1'), 'Enter');
            expect(postedOfType(webview, 'attachFile')).toEqual([]);
        });

        it('ignores results for an older query or another pane', async () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1'), thread('t2')]);
            await openMention(webview, 't1', '@a');
            webview.host({ type: 'fileSearchResults', threadId: 't1', query: '', files: FILES });
            webview.host({ type: 'fileSearchResults', threadId: 't2', query: 'a', files: FILES });
            press(webview, composer(webview, 't1'), 'Enter');
            expect(postedOfType(webview, 'attachFile')).toEqual([]);
        });

        it('sends from another pane instead of attaching the first pane\'s pick', async () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1'), thread('t2')]);
            await openMention(webview, 't1', '@a');
            webview.host({ type: 'fileSearchResults', threadId: 't1', query: 'a', files: FILES });
            const other = composer(webview, 't2');
            other.value = 'hi';
            press(webview, other, 'Enter');
            expect(postedOfType(webview, 'attachFile')).toEqual([]);
        });

        it('appends an inserted mention to the active thread draft', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1'), thread('t2')], { activeThreadId: 't2' });
            typeInto(webview, () => composer(webview, 't2'), 'look at ');
            webview.host({ type: 'insertMention', mention: '@src/a.ts#L1-2' });
            expect(composer(webview, 't2').value).toBe('look at @src/a.ts#L1-2');
            expect(composer(webview, 't1').value).toBe('');
        });
    });

    describe('pane actions', () => {
        it.each([
            ['export', 'exportThread'],
            ['clear', 'clearThread'],
            ['close', 'closeThread'],
            ['attach', 'attach'],
            ['sessions', 'requestSessions'],
        ])('%s posts %s for its own thread', (name, type) => {
            const webview = loadWebview();
            hostState(webview, [thread('t1'), thread('t2')]);
            click(webview, action(webview, name, 't2'));
            expect(postedOfType(webview, type)).toEqual([{ type, threadId: 't2' }]);
        });

        it('focuses the clicked pane on the host', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1'), thread('t2')]);
            click(webview, paneOf(webview, 't2').querySelector('.pane-title')!);
            expect(postedOfType(webview, 'focusThread')).toEqual([{ type: 'focusThread', threadId: 't2' }]);
            expect(paneOf(webview, 't2').classList.contains('active')).toBe(true);
        });

        it('expands an auto-collapsed pane from its toggle', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1'), thread('t2', { status: 'complete' })]);
            expect(paneOf(webview, 't2').classList.contains('collapsed')).toBe(true);
            click(webview, action(webview, 'toggleCollapse', 't2'));
            expect(paneOf(webview, 't2').classList.contains('collapsed')).toBe(false);
        });

        it('opens the suggestions of a pane that was not active', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1'), thread('t2')]);
            webview.host({ type: 'recommendations', items: [{ command: '/explain', icon: '?', label: XSS }] });
            click(webview, action(webview, 'toggle-recs', 't2'));
            expect(paneOf(webview, 't2').querySelector('.recommendations')?.classList.contains('open')).toBe(true);
            expect(paneOf(webview, 't2').querySelector('.rec-chip')?.textContent).toBe(`? ${XSS}`);
            click(webview, action(webview, 'use-recommendation', 't2'));
            expect(composer(webview, 't2').value).toBe('/explain ');
        });

        it('leaves the transcript DOM alone when a click has nothing to close', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1', { messages: [{ role: 'user', content: 'copy me' }] })]);
            const message = webview.document.querySelector('.message-user')!;
            click(webview, message);
            expect(webview.document.querySelector('.message-user')).toBe(message);
        });

        it('links the paths in plain-text rows, not the prose before them or URL tails', () => {
            const webview = loadWebview();
            const content = 'failed in src/a.ts:5:5 and see /home/x/y.ts, docs at https://host.dev/z.js';
            hostState(webview, [thread('t1', { messages: [{ role: 'error', content }] })]);
            const links = Array.from(webview.document.querySelectorAll('.message-error .file-link'));
            expect(links.map(link => [link.textContent, link.getAttribute('data-file-path'), link.getAttribute('data-line')])).toEqual([
                ['src/a.ts:5:5', 'src/a.ts', '5'],
                ['/home/x/y.ts', '/home/x/y.ts', null],
            ]);
            expect(webview.document.querySelector('.message-error')?.textContent).toBe(content);
            press(webview, links[0], 'Enter');
            click(webview, links[1]);
            expect(postedOfType(webview, 'openFile')).toEqual([
                { type: 'openFile', filePath: 'src/a.ts', line: '5' },
                { type: 'openFile', filePath: '/home/x/y.ts', line: '' },
            ]);
        });

        it('links a wrapped or punctuated path without its surrounding prose', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1', { messages: [{ role: 'error', content: 'see (src/a.ts:3). Also C:\\w\\b.py.' }] })]);
            const links = Array.from(webview.document.querySelectorAll('.file-link'));
            expect(links.map(link => [link.textContent, link.getAttribute('data-file-path'), link.getAttribute('data-line')])).toEqual([
                ['src/a.ts:3', 'src/a.ts', '3'],
                ['C:\\w\\b.py', 'C:\\w\\b.py', null],
            ]);
        });

        it.each([
            ['nested separators', 'a/'],
            ['dotted runs', 'a.'],
            ['line suffixes', '1:'],
            ['parentheses', '(a)/'],
        ])('linkifies adversarial %s in linear time', (_name, unit) => {
            const webview = loadWebview();
            const belowCap = unit.repeat(Math.floor(19000 / unit.length));
            const huge = unit.repeat(Math.floor(1_000_000 / unit.length));
            const startedAt = Date.now();
            hostState(webview, [thread('t1', { messages: [
                { role: 'error', content: belowCap },
                { role: 'error', content: huge },
                { role: 'tool', entries: [{ title: 'x', status: 'error', details: belowCap }] },
            ] })]);
            expect(Date.now() - startedAt).toBeLessThan(200);
            expect(webview.document.querySelectorAll('.message-error')).toHaveLength(2);
        });

        it('streams reply text as plain text and links its paths once it lands', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            webview.host({ type: 'textUpdate', threadId: 't1', text: 'open src/a.ts' });
            expect(paneOf(webview, 't1').querySelector('.message-pending')?.textContent).toBe('open src/a.ts');
            expect(paneOf(webview, 't1').querySelector('.message-pending .file-link')).toBeNull();
            hostState(webview, [thread('t1', { messages: [{ role: 'assistant', content: 'open src/a.ts' }] })]);
            expect(paneOf(webview, 't1').querySelector('.message-assistant .file-link')?.getAttribute('data-file-path')).toBe('src/a.ts');
        });

        it('asks for a new thread, a split and a pop-out from the header', () => {
            const webview = loadWebview();
            ['btn-new', 'btn-split', 'btn-popout'].forEach(id => click(webview, webview.document.getElementById(id)!));
            expect(webview.posted.slice(2)).toEqual([{ type: 'newSession' }, { type: 'splitThread' }, { type: 'popOut' }]);
        });
    });

    describe('drag and drop', () => {
        it('attaches dropped explorer files, skipping a malformed URI but not its neighbours', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            const shell = byThread(webview, '.composer-shell', 't1');
            dropUriList(webview, shell, [
                '# comment',
                'file:///home/me/a%20b.ts',
                'file:///C:/work/c.ts',
                'file:///bad%E0%A4%A.ts',
                'file://server/share/d.ts',
                'https://example.com/e.ts',
            ].join('\r\n'));
            expect(postedOfType(webview, 'attachFiles')).toEqual([{
                type: 'attachFiles',
                threadId: 't1',
                filePaths: ['/home/me/a b.ts', 'C:/work/c.ts', '//server/share/d.ts'],
            }]);
        });
    });

    describe('sessions panel', () => {
        function openPanel(webview: Webview, threadId: string, listing: Message = { sessions: SESSIONS }): void {
            click(webview, action(webview, 'sessions', threadId));
            webview.host({ type: 'sessionsList', threadId, ...listing });
        }

        it('renders a labelled menu of escaped rows and focuses the first', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            openPanel(webview, 't1', { sessions: [...SESSIONS, { sessionKey: 'k', label: XSS }] });
            const panel = webview.document.getElementById('claw-sessions-panel');
            expect(panel?.getAttribute('role')).toBe('menu');
            expect(sessionRows(webview).map(row => row.textContent)).toEqual(['● Main', '❄ Coder', XSS]);
            expect(webview.document.querySelectorAll('img')).toHaveLength(0);
            expect(webview.document.activeElement).toBe(sessionRows(webview)[0]);
        });

        it('opens a session into the pane that asked and closes the menu', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1'), thread('t2')]);
            click(webview, action(webview, 'sessions', 't2'));
            webview.host({ type: 'sessionsList', sessions: SESSIONS });
            click(webview, sessionRows(webview)[1]);
            expect(postedOfType(webview, 'openSession')).toEqual([{ type: 'openSession', sessionKey: 'agent:coder:main', threadId: 't2' }]);
            expect(webview.document.getElementById('claw-sessions-panel')).toBeNull();
        });

        it('drops a reply the user no longer waits for, after typing or clicking away', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            click(webview, action(webview, 'sessions', 't1'));
            typeInto(webview, () => composer(webview, 't1'), 'moving on');
            webview.host({ type: 'sessionsList', threadId: 't1', sessions: SESSIONS });
            expect(webview.document.getElementById('claw-sessions-panel')).toBeNull();
            click(webview, action(webview, 'sessions', 't1'));
            click(webview, webview.document.body);
            webview.host({ type: 'sessionsList', threadId: 't1', sessions: SESSIONS });
            expect(webview.document.getElementById('claw-sessions-panel')).toBeNull();
            webview.host({ type: 'sessionsList', threadId: 't1', sessions: SESSIONS });
            expect(webview.document.getElementById('claw-sessions-panel')).toBeNull();
        });

        it('leaves focus where the user put it when the list lands', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            click(webview, action(webview, 'sessions', 't1'));
            composer(webview, 't1').focus();
            webview.host({ type: 'sessionsList', threadId: 't1', sessions: SESSIONS });
            expect(webview.document.getElementById('claw-sessions-panel')).not.toBeNull();
            expect(webview.document.activeElement).toBe(composer(webview, 't1'));
        });

        it('moves focus with the arrow keys, wrapping around', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            openPanel(webview, 't1');
            const panel = webview.document.getElementById('claw-sessions-panel')!;
            press(webview, panel, 'ArrowDown');
            expect(webview.document.activeElement).toBe(sessionRows(webview)[1]);
            press(webview, panel, 'ArrowDown');
            expect(webview.document.activeElement).toBe(sessionRows(webview)[0]);
            press(webview, panel, 'ArrowUp');
            expect(webview.document.activeElement).toBe(sessionRows(webview)[1]);
        });

        it('closes on Escape and hands focus back to the Sessions button of its pane', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t"1')]);
            openPanel(webview, 't"1');
            press(webview, webview.document.getElementById('claw-sessions-panel')!, 'Escape');
            expect(webview.document.getElementById('claw-sessions-panel')).toBeNull();
            expect(webview.document.activeElement).toBe(action(webview, 'sessions', 't"1'));
        });

        it('shows an explicit disabled row when the list is empty or unavailable', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            openPanel(webview, 't1', { sessions: [] });
            expect(sessionRows(webview).map(row => row.textContent)).toEqual(['No sessions']);
            openPanel(webview, 't1', { sessions: [], error: XSS });
            expect(sessionRows(webview).map(row => row.textContent)).toEqual([XSS]);
            expect(sessionRows(webview)[0].getAttribute('aria-disabled')).toBe('true');
        });

        it('closes on an outside click, and on the host confirming a selection', async () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            openPanel(webview, 't1');
            await tick(webview);
            click(webview, webview.document.body);
            expect(webview.document.getElementById('claw-sessions-panel')).toBeNull();
            openPanel(webview, 't1');
            webview.host({ type: 'agentSelected', sessionKey: 'agent:main:main' });
            expect(webview.document.getElementById('claw-sessions-panel')).toBeNull();
        });

        it('reloads an open panel once per burst of session index changes, keeping the focused row', async () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            openPanel(webview, 't1');
            press(webview, webview.document.getElementById('claw-sessions-panel')!, 'ArrowDown');
            const requestsBefore = postedOfType(webview, 'requestSessions').length;
            webview.host({ type: 'sessionsChanged' });
            webview.host({ type: 'sessionsChanged' });
            await tick(webview, 350);
            expect(postedOfType(webview, 'requestSessions').slice(requestsBefore)).toEqual([{ type: 'requestSessions', threadId: 't1' }]);
            webview.host({ type: 'sessionsList', threadId: 't1', sessions: [{ sessionKey: 'agent:new:main', label: 'New' }, ...SESSIONS] });
            expect(sessionRows(webview).map(row => row.textContent)).toEqual(['New', '● Main', '❄ Coder']);
            expect(webview.document.activeElement).toBe(sessionRows(webview)[2]);
        });

        it('asks for nothing when the session index changes with the panel closed', async () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            webview.host({ type: 'sessionsChanged' });
            await tick(webview, 350);
            expect(postedOfType(webview, 'requestSessions')).toEqual([]);
        });
    });

    describe('operator prompts', () => {
        const approval = {
            kind: 'approval',
            id: 'a1',
            key: 'exec:a1',
            subject: 'exec',
            title: XSS,
            details: ['Working folder: /work', XSS],
            decisions: ['allow-once', 'deny'],
            sessionKey: 'agent:main:main',
            runId: 'r1',
            expiresInMs: 3_600_000,
            state: 'pending',
            status: '',
        };

        const question = {
            kind: 'question',
            id: 'q1',
            key: 'question:q1',
            questions: [
                { id: 'color', header: 'Color', text: 'Which color?', options: [{ label: 'Red', description: null }, { label: 'Blue', description: XSS }], multiSelect: false, allowsOther: true, secret: false },
                { id: 'token', header: '', text: 'Token?', options: [], multiSelect: false, allowsOther: true, secret: true },
            ],
            sessionKey: 'agent:main:main',
            runId: null,
            expiresInMs: 3_600_000,
            state: 'pending',
            status: '',
        };

        function card(webview: Webview, promptKey: string): HTMLElement {
            const match = Array.from(webview.document.querySelectorAll<HTMLElement>('.prompt-card')).find(el => el.getAttribute('data-prompt-key') === promptKey);
            if (!match) {
                throw new Error(`no prompt card ${promptKey}`);
            }
            return match;
        }

        function buttonLabeled(webview: Webview, promptKey: string, label: string): HTMLButtonElement {
            const button = Array.from(card(webview, promptKey).querySelectorAll('button')).find(el => el.textContent === label);
            if (!button) {
                throw new Error(`no ${label} button`);
            }
            return button;
        }

        function field(webview: Webview, promptKey: string, selector: string): HTMLInputElement {
            const match = card(webview, promptKey).querySelector<HTMLInputElement>(selector);
            if (!match) {
                throw new Error(`no ${selector}`);
            }
            return match;
        }

        it('renders an approval as text, never markup, with one button per offered decision', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1', { prompts: [approval] })]);
            expect(card(webview, 'exec:a1').getAttribute('role')).toBe('group');
            expect(card(webview, 'exec:a1').querySelector('.prompt-title')?.textContent).toBe(XSS);
            expect(Array.from(card(webview, 'exec:a1').querySelectorAll('.prompt-details li'), li => li.textContent)).toEqual(['Working folder: /work', XSS]);
            expect(webview.document.querySelectorAll('img')).toHaveLength(0);
            expect(Array.from(card(webview, 'exec:a1').querySelectorAll('button'), button => button.textContent)).toEqual(['Approve once', 'Deny']);
            click(webview, buttonLabeled(webview, 'exec:a1', 'Deny'));
            expect(postedOfType(webview, 'resolveApproval')).toEqual([{ type: 'resolveApproval', threadId: 't1', promptKey: 'exec:a1', decision: 'deny' }]);
        });

        it('keeps cards of different sources apart when their prompts share an id', () => {
            const webview = loadWebview();
            const plugin = { ...approval, subject: 'plugin', key: 'plugin:a1', title: 'Write' };
            hostState(webview, [thread('t1', { prompts: [approval, plugin] })]);
            expect(card(webview, 'plugin:a1').querySelector('.prompt-title')?.textContent).toBe('Write');
            click(webview, buttonLabeled(webview, 'plugin:a1', 'Deny'));
            expect(postedOfType(webview, 'resolveApproval')).toEqual([{ type: 'resolveApproval', threadId: 't1', promptKey: 'plugin:a1', decision: 'deny' }]);
        });

        it('fixes a deadline on this clock from the time left when the prompt first arrives', () => {
            const webview = loadWebview();
            const expiry = () => card(webview, 'exec:a1').querySelector('.prompt-expiry')?.textContent;
            hostState(webview, [thread('t1', { prompts: [approval] })]);
            const shown = expiry();
            expect(shown).toMatch(/^Expires at /);
            hostState(webview, [thread('t1', { prompts: [{ ...approval, expiresInMs: 1_800_000, status: 'Sending…' }] })]);
            expect(expiry()).toBe(shown);
        });

        it('shows a settled row with its status and no buttons, and a sending row with its buttons disabled', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1', { prompts: [{ ...approval, state: 'resolved', status: 'Allowed once elsewhere' }, { ...question, state: 'submitting', status: 'Sending…' }] })]);
            expect(card(webview, 'exec:a1').querySelectorAll('button')).toHaveLength(0);
            expect(card(webview, 'exec:a1').querySelector('.prompt-status')?.textContent).toBe('Allowed once elsewhere');
            expect(Array.from(card(webview, 'question:q1').querySelectorAll('button'), button => button.disabled)).toEqual([true, true]);
        });

        it('sends the chosen option, or a typed answer in its place, and keeps drafts across re-renders', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1', { prompts: [question] })]);
            expect(field(webview, 'question:q1', '.prompt-other[type="password"]').getAttribute('aria-label')).toBe('Your answer');
            const blue = card(webview, 'question:q1').querySelectorAll<HTMLInputElement>('.prompt-choice')[1];
            click(webview, blue);
            typeInto(webview, () => field(webview, 'question:q1', '.prompt-other[type="password"]'), 's3cret');
            hostState(webview, [thread('t1', { prompts: [question], messages: [{ role: 'user', content: 'moved on' }] })]);
            click(webview, buttonLabeled(webview, 'question:q1', 'Send answer'));
            expect(postedOfType(webview, 'answerQuestion').pop()).toEqual({ type: 'answerQuestion', threadId: 't1', promptKey: 'question:q1', answers: { color: ['Blue'], token: ['s3cret'] } });
            typeInto(webview, () => field(webview, 'question:q1', '.prompt-other[type="text"]'), 'Teal');
            expect(card(webview, 'question:q1').querySelectorAll<HTMLInputElement>('.prompt-choice')[1].checked).toBe(false);
            press(webview, field(webview, 'question:q1', '.prompt-other[type="text"]'), 'Enter');
            expect(postedOfType(webview, 'answerQuestion').pop()).toMatchObject({ answers: { color: ['Teal'], token: ['s3cret'] } });
            click(webview, buttonLabeled(webview, 'question:q1', 'Skip'));
            expect(postedOfType(webview, 'answerQuestion').pop()).toEqual({ type: 'answerQuestion', threadId: 't1', promptKey: 'question:q1', answers: null });
        });

        it('hands focus back to the control that had it when the rows change', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1', { prompts: [question] })]);
            typeInto(webview, () => field(webview, 'question:q1', '.prompt-other[type="text"]'), 'Te');
            hostState(webview, [thread('t1', { prompts: [{ ...question, status: 'Answer every question.' }] })]);
            expect(webview.document.activeElement).toBe(field(webview, 'question:q1', '.prompt-other[type="text"]'));
            expect(field(webview, 'question:q1', '.prompt-other[type="text"]').value).toBe('Te');
            hostState(webview, [thread('t1', { prompts: [] })]);
            expect(webview.document.querySelector('.pane-prompts')).toBeNull();
            expect(webview.document.activeElement).toBe(composer(webview, 't1'));
        });

        it('shows hidden and direction-changing characters and blank-line padding in a command, and warns', () => {
            const webview = loadWebview();
            const command = 'ls \u202Eexe.txt\u200B' + '\n'.repeat(40) + 'rm -rf ~';
            hostState(webview, [thread('t1', { prompts: [{ ...approval, title: command, details: [] }] })]);
            const shown = card(webview, 'exec:a1').querySelector('.prompt-command')?.textContent ?? '';
            expect(shown).toContain('‹U+202E›');
            expect(shown).toContain('‹U+200B›');
            expect(shown).toContain('‹39 blank lines›');
            expect(shown).toContain('rm -rf ~');
            expect(Array.from(card(webview, 'exec:a1').querySelectorAll('.prompt-warnings li'), li => li.textContent)).toEqual([
                'Contains hidden or direction-changing characters, shown as ‹U+…›.',
                'Contains runs of blank lines, shown collapsed.',
            ]);
        });

        it('keeps the answers of two panes showing one question apart', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1', { prompts: [question] }), thread('t2', { prompts: [question] })], { dimension: '2x2' });
            const [first, second] = Array.from(webview.document.querySelectorAll<HTMLElement>('.prompt-card'));
            click(webview, first.querySelectorAll<HTMLInputElement>('.prompt-choice')[1]);
            expect(second.querySelectorAll<HTMLInputElement>('.prompt-choice')[1].checked).toBe(false);
            click(webview, Array.from(second.querySelectorAll('button')).find(button => button.textContent === 'Send answer')!);
            expect(postedOfType(webview, 'answerQuestion').pop()).toMatchObject({ threadId: 't2', answers: { color: [], token: [] } });
        });

        it('never auto-collapses a pane with a waiting request, and badges it in the header', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1'), thread('t2', { prompts: [approval] })]);
            expect(paneOf(webview, 't2').classList.contains('collapsed')).toBe(false);
            expect(paneOf(webview, 't2').querySelector('.pane-prompt-badge')?.textContent).toBe('1 waiting for you');
        });

        it('announces a new request and a changed status once, in a live region that stays in place', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1')]);
            const announcer = () => paneOf(webview, 't1').querySelector('.pane-prompt-announcer');
            hostState(webview, [thread('t1', { prompts: [approval] })]);
            const region = announcer();
            expect(region?.getAttribute('aria-live')).toBe('polite');
            expect(region?.textContent).toBe(`Approval needed: ${XSS}`);
            hostState(webview, [thread('t1', { prompts: [{ ...approval, state: 'resolved', status: 'Denied' }] })]);
            expect(announcer()).toBe(region);
            expect(region?.textContent).toBe('Denied');
            expect(card(webview, 'exec:a1').querySelector('[role="status"]')).toBeNull();
        });
    });

    describe('streaming replacement', () => {
        it('replaces the streaming bubble with a shorter text, leaving the composer draft alone', () => {
            const webview = loadWebview();
            hostState(webview, [thread('t1', { isStreaming: true, status: 'running', pendingAssistantText: 'draft' })]);
            typeInto(webview, () => composer(webview, 't1'), 'my draft');
            webview.host({ type: 'textUpdate', threadId: 't1', text: 'a much longer draft reply' });
            webview.host({ type: 'textUpdate', threadId: 't1', text: 'final' });
            expect(byThread(webview, '.message-pending', 't1').textContent).toBe('final');
            expect(composer(webview, 't1').value).toBe('my draft');
            expect(webview.document.activeElement).toBe(composer(webview, 't1'));
        });
    });
});
