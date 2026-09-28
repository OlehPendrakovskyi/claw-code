import * as vscode from 'vscode';
import type { ChatEvent } from '../chat/ChatService';

const mockResolve = jest.fn();

jest.mock('../webview/chatServiceFactory', () => ({
    ChatServiceFactory: jest.fn().mockImplementation(() => ({
        resolve: (...args: unknown[]) => mockResolve(...args),
        dispose: jest.fn(),
    })),
}));

jest.mock('../core/gatewayChatService', () => {
    class GatewayChatService {
        setActiveSession = jest.fn();
        hasOwnedRun = jest.fn(() => false);
        abort = jest.fn();
        removeTranscriptSink = jest.fn();
        rebindTranscriptSink = jest.fn();
        clearSessionSink = jest.fn();
        getGatewayIdentity = jest.fn(() => 'gateway-1');
        listSessions = jest.fn(async () => ({ sessions: [] as unknown[] }));
        getHistory = jest.fn(async (): Promise<unknown> => ({ messages: [] }));
        seedHistory = jest.fn();
        resumeSession = jest.fn();
        captureSessionState = jest.fn(() => null);
        restoreSessionState = jest.fn();
        sendMessage = jest.fn();
        dispose = jest.fn();
    }
    return { GatewayChatService, DEFAULT_SESSION_KEY: 'main' };
});

// Identity realpath keeps sends free of real disk I/O, so flush() is deterministic.
jest.mock('fs', () => {
    const actual = jest.requireActual('fs');
    return { ...actual, promises: { ...actual.promises, realpath: async (p: string) => p } };
});

import { ChatViewProvider } from '../webview/ChatViewProvider';
import type { GatewayChatService } from '../core/gatewayChatService';

type Posted = Record<string, unknown>;
type ThreadState = {
    id: string;
    title: string;
    messages: Array<Record<string, unknown>>;
    status: string;
    pendingAssistantText: string;
    currentChatType: string;
    currentModel: string;
};
type StateMessage = { type: 'state'; threads: ThreadState[]; activeThreadId: string };

type FakeWebview = {
    posted: Posted[];
    send(message: unknown): Promise<void>;
    webview: vscode.Webview;
};

type FakeView = {
    webview: vscode.Webview;
    visible: boolean;
    show: (preserveFocus?: boolean) => void;
    onDidDispose: vscode.Event<void>;
};

type Harness = {
    provider: ChatViewProvider;
    sidebar: FakeWebview;
    view: FakeView;
    workspaceState: { get: jest.Mock; update: jest.Mock };
};

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };

const { GatewayChatService: MockGatewayChatService } =
    jest.requireMock<{ GatewayChatService: new () => GatewayChatService }>('../core/gatewayChatService');

const LAST_SESSION_KEY = 'openclaw.lastSessionKey';

const WARM_ROWS = [
    { key: 'main', label: 'Default' },
    { key: 'agent:main:main', label: 'Main' },
    { key: 'agent:coder:main', label: 'Coder' },
];

function historyOf(text: string): unknown {
    return { messages: [{ role: 'user', text, messageId: `id-${text}` }] };
}

function deferred<T>(): Deferred<T> {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}

function makeWebview(): FakeWebview {
    let handler: (message: unknown) => Promise<void> = async () => undefined;
    const posted: Posted[] = [];
    const webview: vscode.Webview = {
        options: {},
        html: '',
        cspSource: 'vscode-webview:',
        postMessage: async (message: Posted) => { posted.push(message); return true; },
        onDidReceiveMessage: (cb: (message: unknown) => Promise<void>) => { handler = cb; return { dispose() {} }; },
        asWebviewUri: (uri: vscode.Uri) => uri,
    };
    return { posted, webview, send: (message) => handler(message) };
}

function makeContext(persistedKey?: string): { context: vscode.ExtensionContext; workspaceState: Harness['workspaceState'] } {
    const workspaceState = {
        keys: () => [],
        get: jest.fn((key: string) => (key === LAST_SESSION_KEY ? persistedKey : undefined)),
        update: jest.fn(async () => undefined),
    };
    const context: Pick<vscode.ExtensionContext, 'globalState' | 'workspaceState'> = {
        globalState: { keys: () => [], get: jest.fn(), update: jest.fn(async () => undefined), setKeysForSync: jest.fn() },
        workspaceState,
    };
    return { context: context as vscode.ExtensionContext, workspaceState };
}

function makeProvider(options: { persistedKey?: string } = {}): Harness {
    const { context, workspaceState } = makeContext(options.persistedKey);
    const provider = new ChatViewProvider(vscode.Uri.file('/ext'), context);
    const sidebar = makeWebview();
    const view: FakeView = { webview: sidebar.webview, visible: true, show: jest.fn(), onDidDispose: jest.fn() };
    provider.resolveWebviewView(view as vscode.WebviewView, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
    return { provider, sidebar, view, workspaceState };
}

// Real setImmediate: the global one is faked.
const { setImmediate: realSetImmediate } = jest.requireActual<typeof import('timers')>('timers');

async function flush(): Promise<void> {
    for (let i = 0; i < 10; i++) {
        await new Promise(resolve => realSetImmediate(resolve));
    }
}

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

function lastMessageOf(webview: FakeWebview, threadId: string): Record<string, unknown> {
    const messages = threadOf(webview, threadId).messages;
    return messages[messages.length - 1];
}

type MockPanel = {
    active?: boolean;
    visible?: boolean;
    reveal: jest.Mock;
    onDidDispose: jest.Mock;
    webview: { postMessage: jest.Mock; onDidReceiveMessage: jest.Mock };
};

function lastPanel(): MockPanel {
    const results = jest.mocked(vscode.window.createWebviewPanel).mock.results;
    return results[results.length - 1].value;
}

/** The pop-out panel the most recent popOut() created, with its message handler. */
function lastPopOut(): { postMessage: jest.Mock; send(message: unknown): Promise<void>; dispose(): void } {
    const panel = lastPanel();
    const [handler] = panel.webview.onDidReceiveMessage.mock.calls[0];
    const [onDispose] = panel.onDidDispose.mock.calls[0];
    return { postMessage: panel.webview.postMessage, send: handler, dispose: onDispose };
}

function resumedKeys(gateway: GatewayChatService): string[] {
    return jest.mocked(gateway.resumeSession).mock.calls.map(call => call[0]);
}

function transcriptSinkFor(gateway: GatewayChatService, sessionKey: string): (event: ChatEvent) => void {
    const calls = jest.mocked(gateway.resumeSession).mock.calls.filter(call => call[0] === sessionKey);
    return calls[calls.length - 1][1];
}

function lastRunSink(gateway: GatewayChatService): (event: ChatEvent) => void {
    const calls = jest.mocked(gateway.sendMessage).mock.calls;
    return calls[calls.length - 1][4];
}

/** Session key the most recent send targeted. */
function lastSentSessionKey(gateway: GatewayChatService): string {
    const calls = jest.mocked(gateway.setActiveSession).mock.calls;
    return calls[calls.length - 1][0];
}

function pickSession(sessionKey: string): void {
    (jest.mocked(vscode.window.showQuickPick) as jest.Mock).mockImplementation(
        async (items: Array<{ detail?: string }>) => items.find(item => item.detail === sessionKey)
    );
}

describe('ChatViewProvider sessions', () => {
    let gateway: GatewayChatService;

    beforeEach(() => {
        jest.useFakeTimers();
        (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = [{ uri: vscode.Uri.file('/work') }];
        gateway = new MockGatewayChatService();
        jest.mocked(gateway.listSessions).mockResolvedValue({ sessions: WARM_ROWS });
        mockResolve.mockReset();
        mockResolve.mockResolvedValue({ service: gateway, transport: 'gateway' });
        jest.mocked(vscode.window.showWarningMessage).mockClear();
        jest.mocked(vscode.window.showQuickPick).mockReset();
        jest.mocked(vscode.window.createWebviewPanel).mockClear();
    });

    afterEach(() => {
        jest.useRealTimers();
        (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = undefined;
    });

    describe('openSession', () => {
        it('tells the thread when the gateway is unavailable and accepts sends afterwards', async () => {
            const { sidebar } = makeProvider();
            mockResolve.mockRejectedValueOnce(new Error('down'));
            await sidebar.send({ type: 'openSession', sessionKey: 'agent:coder:main', threadId: 'thread-1' });
            expect(lastMessageOf(sidebar, 'thread-1')).toEqual({
                role: 'error',
                content: 'Could not open session "agent:coder:main": Gateway not connected.',
            });

            await sidebar.send({ type: 'send', threadId: 'thread-1', text: 'hi' });
            await flush();
            expect(gateway.sendMessage).toHaveBeenCalledTimes(1);
        });

        it('tells the thread when the gateway does not list the key', async () => {
            const { sidebar } = makeProvider();
            await sidebar.send({ type: 'openSession', sessionKey: 'agent:ghost:main', threadId: 'thread-1' });
            expect(gateway.getHistory).not.toHaveBeenCalled();
            expect(lastMessageOf(sidebar, 'thread-1')).toEqual({
                role: 'error',
                content: 'Session "agent:ghost:main" is not known to the current gateway. Refresh the sessions list and reopen it.',
            });
        });

        it('lets the newer of two opens win even when the older resolves last', async () => {
            const { sidebar, workspaceState } = makeProvider();
            const resolves: Array<() => void> = [];
            mockResolve.mockImplementation(() => new Promise(resolve => {
                resolves.push(() => resolve({ service: gateway, transport: 'gateway' }));
            }));
            jest.mocked(gateway.getHistory).mockImplementation(async (key: string) => historyOf(key));

            void sidebar.send({ type: 'openSession', sessionKey: 'agent:coder:main', threadId: 'thread-1' });
            void sidebar.send({ type: 'openSession', sessionKey: 'agent:main:main', threadId: 'thread-1' });
            await flush();
            resolves[1]();
            await flush();
            resolves[0]();
            await flush();

            expect(threadOf(sidebar, 'thread-1').messages).toEqual([{ role: 'user', content: 'agent:main:main' }]);
            expect(jest.mocked(gateway.getHistory).mock.calls).toEqual([['agent:main:main']]);
            expect(workspaceState.update.mock.calls).toEqual([[LAST_SESSION_KEY, 'agent:main:main']]);
        });

        it('aborts the thread\'s own run when it opens another session mid-run', async () => {
            const { sidebar } = makeProvider();
            await sidebar.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            jest.mocked(gateway.hasOwnedRun).mockReturnValue(true);
            jest.mocked(gateway.getHistory).mockResolvedValue(historyOf('coder history'));

            await sidebar.send({ type: 'openSession', sessionKey: 'agent:coder:main', threadId: 'thread-1' });
            await flush();

            expect(gateway.abort).toHaveBeenCalledWith('main');
            expect(threadOf(sidebar, 'thread-1')).toMatchObject({
                status: 'idle',
                messages: [{ role: 'user', content: 'coder history' }],
            });
        });

        it('keeps the live transcript when the bound session is reopened mid-run', async () => {
            const { sidebar } = makeProvider();
            await sidebar.send({ type: 'openSession', sessionKey: 'agent:main:main', threadId: 'thread-1' });
            await flush();
            await sidebar.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();

            await sidebar.send({ type: 'openSession', sessionKey: 'agent:main:main', threadId: 'thread-1' });
            await flush();

            expect(gateway.getHistory).toHaveBeenCalledTimes(1);
            expect(threadOf(sidebar, 'thread-1')).toMatchObject({ status: 'running', messages: [{ role: 'user', content: 'go' }] });
            expect(sidebar.posted[sidebar.posted.length - 1]).toEqual({ type: 'agentSelected', sessionKey: 'agent:main:main' });
        });

        it('replaces the previous transcript with a retry notice when a rebind cannot load history', async () => {
            const { sidebar } = makeProvider();
            jest.mocked(gateway.getHistory).mockResolvedValueOnce(historyOf('main history')).mockResolvedValueOnce(null);
            await sidebar.send({ type: 'openSession', sessionKey: 'agent:main:main', threadId: 'thread-1' });
            await sidebar.send({ type: 'openSession', sessionKey: 'agent:coder:main', threadId: 'thread-1' });
            await flush();

            expect(threadOf(sidebar, 'thread-1')).toMatchObject({
                status: 'error',
                messages: [{ role: 'assistant', content: 'Failed to load session history. Reopen the session to retry.' }],
            });
        });

        it('keeps the transcript when reopening the same session cannot load history', async () => {
            const { sidebar } = makeProvider();
            jest.mocked(gateway.getHistory).mockResolvedValueOnce(historyOf('main history')).mockResolvedValueOnce(null);
            await sidebar.send({ type: 'openSession', sessionKey: 'agent:main:main', threadId: 'thread-1' });
            await sidebar.send({ type: 'openSession', sessionKey: 'agent:main:main', threadId: 'thread-1' });
            await flush();

            expect(threadOf(sidebar, 'thread-1').messages).toEqual([{ role: 'user', content: 'main history' }]);
        });

        it('titles the thread with the key when sessions.list fails during the open', async () => {
            const { sidebar } = makeProvider();
            await sidebar.send({ type: 'requestSessions', threadId: 'thread-1' });
            jest.mocked(gateway.listSessions).mockRejectedValue(new Error('rpc down'));
            jest.mocked(gateway.getHistory).mockResolvedValue(historyOf('coder history'));

            await sidebar.send({ type: 'openSession', sessionKey: 'agent:coder:main', threadId: 'thread-1' });
            await flush();

            expect(threadOf(sidebar, 'thread-1')).toMatchObject({
                title: 'agent:coder:main',
                messages: [{ role: 'user', content: 'coder history' }],
            });
        });

        it('never resubscribes the previous session when the thread is cleared while a rebind loads history', async () => {
            const { sidebar } = makeProvider();
            await sidebar.send({ type: 'openSession', sessionKey: 'agent:main:main', threadId: 'thread-1' });
            await flush();
            const history = deferred<unknown>();
            jest.mocked(gateway.getHistory).mockReturnValueOnce(history.promise);

            void sidebar.send({ type: 'openSession', sessionKey: 'agent:coder:main', threadId: 'thread-1' });
            await flush();
            await sidebar.send({ type: 'clearThread', threadId: 'thread-1' });
            history.resolve(historyOf('coder history'));
            await flush();

            expect(jest.mocked(gateway.rebindTranscriptSink).mock.calls.map(call => call[0])).not.toContain('agent:main:main');
            expect(threadOf(sidebar, 'thread-1').messages).toEqual([]);
        });

        it('removes the previous session\'s callback of a thread closed while a rebind loads history', async () => {
            const { sidebar } = makeProvider();
            await sidebar.send({ type: 'openSession', sessionKey: 'agent:main:main', threadId: 'thread-1' });
            await sidebar.send({ type: 'newSession' });
            await sidebar.send({ type: 'openSession', sessionKey: 'agent:main:main', threadId: 'thread-2' });
            await flush();
            const secondThreadSink = transcriptSinkFor(gateway, 'agent:main:main');
            jest.mocked(gateway.getHistory).mockReturnValueOnce(deferred<unknown>().promise);

            void sidebar.send({ type: 'openSession', sessionKey: 'agent:coder:main', threadId: 'thread-2' });
            await flush();
            await sidebar.send({ type: 'closeThread', threadId: 'thread-2' });

            expect(gateway.removeTranscriptSink).toHaveBeenCalledWith('agent:main:main', secondThreadSink);
        });

        it('restores the previous session\'s transcript sink when persisting the new key fails', async () => {
            const { sidebar, workspaceState } = makeProvider();
            await sidebar.send({ type: 'openSession', sessionKey: 'agent:main:main', threadId: 'thread-1' });
            await flush();
            workspaceState.update.mockRejectedValueOnce(new Error('disk full'));

            await sidebar.send({ type: 'openSession', sessionKey: 'agent:coder:main', threadId: 'thread-1' });
            await flush();

            expect(lastMessageOf(sidebar, 'thread-1')).toEqual({
                role: 'error',
                content: 'Failed to persist the last session. Reopen the session to retry.',
            });
            const [restoredKey, restoredSink] = jest.mocked(gateway.rebindTranscriptSink).mock.calls[0];
            expect(restoredKey).toBe('agent:main:main');
            restoredSink({ type: 'text', text: 'still listening' });
            await flush();
            expect(threadOf(sidebar, 'thread-1').pendingAssistantText).toBe('still listening');
        });

        it('reports nothing for a superseded open that fails', async () => {
            const { sidebar } = makeProvider();
            const resolves: Array<() => void> = [];
            mockResolve.mockImplementation(() => new Promise(resolve => {
                resolves.push(() => resolve({ service: gateway, transport: 'gateway' }));
            }));

            void sidebar.send({ type: 'openSession', sessionKey: 'agent:ghost:main', threadId: 'thread-1' });
            void sidebar.send({ type: 'openSession', sessionKey: 'agent:main:main', threadId: 'thread-1' });
            await flush();
            resolves[1]();
            await flush();
            resolves[0]();
            await flush();

            expect(threadOf(sidebar, 'thread-1').messages).toEqual([]);
            expect(resumedKeys(gateway)).toEqual(['agent:main:main']);
        });

        it('yields to a newer open while its own key is being persisted', async () => {
            const { sidebar, workspaceState } = makeProvider();
            const firstWrite = deferred<undefined>();
            workspaceState.update.mockReturnValueOnce(firstWrite.promise);
            jest.mocked(gateway.getHistory).mockImplementation(async (key: string) => historyOf(key));

            void sidebar.send({ type: 'openSession', sessionKey: 'agent:main:main', threadId: 'thread-1' });
            await flush();
            void sidebar.send({ type: 'openSession', sessionKey: 'agent:coder:main', threadId: 'thread-1' });
            await flush();
            firstWrite.resolve(undefined);
            await flush();

            expect(threadOf(sidebar, 'thread-1').messages).toEqual([{ role: 'user', content: 'agent:coder:main' }]);
            expect(resumedKeys(gateway)).toEqual(['agent:coder:main']);
            expect(workspaceState.update.mock.calls).toEqual([
                [LAST_SESSION_KEY, 'agent:main:main'],
                [LAST_SESSION_KEY, 'agent:coder:main'],
            ]);
        });

        it('stops a running CLI send when the thread opens a gateway session', async () => {
            const { sidebar } = makeProvider();
            const cli = { sendMessage: jest.fn(), abort: jest.fn(), dispose: jest.fn() };
            mockResolve.mockResolvedValueOnce({ service: cli, transport: 'acpx' });
            await sidebar.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            expect(cli.sendMessage).toHaveBeenCalledTimes(1);
            jest.mocked(gateway.getHistory).mockResolvedValue(historyOf('coder history'));

            await sidebar.send({ type: 'openSession', sessionKey: 'agent:coder:main', threadId: 'thread-1' });
            await flush();

            expect(cli.abort).toHaveBeenCalled();
            expect(threadOf(sidebar, 'thread-1')).toMatchObject({
                status: 'idle',
                messages: [{ role: 'user', content: 'coder history' }],
            });
        });

        it('rejects the open when the gateway identity changed while the key was persisted', async () => {
            const { sidebar, workspaceState } = makeProvider();
            workspaceState.update.mockImplementationOnce(async () => {
                jest.mocked(gateway.getGatewayIdentity).mockReturnValue('gateway-2');
                jest.mocked(gateway.listSessions).mockResolvedValue({ sessions: [{ key: 'agent:main:main' }] });
            });

            await sidebar.send({ type: 'openSession', sessionKey: 'agent:coder:main', threadId: 'thread-1' });
            await flush();

            expect(gateway.getHistory).not.toHaveBeenCalled();
            expect(lastMessageOf(sidebar, 'thread-1')).toMatchObject({ role: 'error' });
        });
    });

    describe('sessions list', () => {
        it('replies to the pop-out that asked and stops posting to it once closed', async () => {
            const { provider, sidebar } = makeProvider();
            provider.popOut();
            const popOut = lastPopOut();
            await popOut.send({ type: 'requestSessions', threadId: 'thread-1' });

            expect(popOut.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'sessionsList', threadId: 'thread-1' }));
            expect(sidebar.posted.some(m => m.type === 'sessionsList')).toBe(false);

            popOut.dispose();
            popOut.postMessage.mockClear();
            await sidebar.send({ type: 'requestState' });
            expect(popOut.postMessage).not.toHaveBeenCalled();
        });

        it('shares one sessions.list between concurrent requests', async () => {
            const { sidebar } = makeProvider();
            await Promise.all([
                sidebar.send({ type: 'requestSessions', threadId: 'thread-1' }),
                sidebar.send({ type: 'requestSessions', threadId: 'thread-1' }),
            ]);
            expect(gateway.listSessions).toHaveBeenCalledTimes(1);
            expect(sidebar.posted.filter(m => m.type === 'sessionsList')).toHaveLength(2);
        });

        it('retries once when the gateway identity changes mid-refresh', async () => {
            const { sidebar } = makeProvider();
            jest.mocked(gateway.listSessions).mockImplementationOnce(async () => {
                jest.mocked(gateway.getGatewayIdentity).mockReturnValue('gateway-2');
                return { sessions: [{ key: 'agent:stale:main' }] };
            });

            await sidebar.send({ type: 'requestSessions', threadId: 'thread-1' });

            const reply = sidebar.posted.find(m => m.type === 'sessionsList');
            expect((reply!.sessions as Array<{ sessionKey: string }>).map(s => s.sessionKey)).not.toContain('agent:stale:main');
            expect(reply).toMatchObject({ error: undefined });
        });

        it('reports a failure when the identity keeps changing', async () => {
            const { sidebar } = makeProvider();
            let identity = 0;
            jest.mocked(gateway.listSessions).mockImplementation(async () => {
                identity += 1;
                jest.mocked(gateway.getGatewayIdentity).mockReturnValue(`gateway-${identity + 1}`);
                return { sessions: WARM_ROWS };
            });

            await sidebar.send({ type: 'requestSessions', threadId: 'thread-1' });

            expect(sidebar.posted.find(m => m.type === 'sessionsList')).toMatchObject({ sessions: [], error: 'Could not load sessions' });
        });

        it('rejects every open as unknown when the gateway lists no sessions', async () => {
            const { sidebar } = makeProvider();
            jest.mocked(gateway.listSessions).mockResolvedValue({ sessions: [] });
            await sidebar.send({ type: 'requestSessions', threadId: 'thread-1' });
            expect(sidebar.posted.find(m => m.type === 'sessionsList')).toMatchObject({ sessions: [], error: undefined });

            await sidebar.send({ type: 'openSession', sessionKey: 'agent:main:main', threadId: 'thread-1' });
            expect(gateway.getHistory).not.toHaveBeenCalled();
            expect(lastMessageOf(sidebar, 'thread-1')).toMatchObject({ role: 'error' });
        });
    });

    describe('command palette picker', () => {
        it('opens the picked session into the active thread without a chat view', async () => {
            const { context, workspaceState } = makeContext();
            const provider = new ChatViewProvider(vscode.Uri.file('/ext'), context);
            pickSession('agent:coder:main');

            await provider.showAgentPicker();

            expect(resumedKeys(gateway)).toEqual(['agent:coder:main']);
            expect(workspaceState.update).toHaveBeenCalledWith(LAST_SESSION_KEY, 'agent:coder:main');
        });

        it('opens a session created after the allowlist was built', async () => {
            const { provider, sidebar } = makeProvider();
            await sidebar.send({ type: 'requestSessions', threadId: 'thread-1' });
            jest.mocked(gateway.listSessions).mockResolvedValue({ sessions: [...WARM_ROWS, { key: 'agent:new:main' }] });
            pickSession('agent:new:main');

            await provider.showAgentPicker();

            expect(gateway.getHistory).toHaveBeenCalledWith('agent:new:main');
        });

        it('ignores a pick whose thread closed while the picker was open', async () => {
            const { provider, sidebar } = makeProvider();
            await sidebar.send({ type: 'newSession' });
            (jest.mocked(vscode.window.showQuickPick) as jest.Mock).mockImplementation(
                async (items: Array<{ detail?: string }>) => {
                    await sidebar.send({ type: 'closeThread', threadId: 'thread-2' });
                    return items.find(item => item.detail === 'agent:coder:main');
                }
            );

            await provider.showAgentPicker();

            expect(gateway.getHistory).not.toHaveBeenCalled();
        });

        it('warns instead of showing an empty picker when the gateway is unavailable', async () => {
            const { provider } = makeProvider();
            mockResolve.mockResolvedValue({ service: {}, transport: 'acpx' });

            await provider.showAgentPicker();

            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Gateway not connected');
            expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
        });
    });

    describe('resume on activation', () => {
        it('keeps the persisted key when the gateway is down', async () => {
            mockResolve.mockRejectedValue(new Error('down'));
            const { workspaceState } = makeProvider({ persistedKey: 'agent:coder:main' });
            await flush();
            expect(workspaceState.update).not.toHaveBeenCalled();
            expect(gateway.resumeSession).not.toHaveBeenCalled();
        });

        it('keeps the persisted key when sessions.list fails', async () => {
            jest.mocked(gateway.listSessions).mockRejectedValue(new Error('rpc down'));
            const { workspaceState } = makeProvider({ persistedKey: 'agent:coder:main' });
            await flush();
            expect(workspaceState.update).not.toHaveBeenCalled();
            expect(gateway.resumeSession).not.toHaveBeenCalled();
        });

        it('erases a key the gateway no longer lists', async () => {
            const { workspaceState } = makeProvider({ persistedKey: 'agent:gone:main' });
            await flush();
            expect(workspaceState.update.mock.calls).toEqual([[LAST_SESSION_KEY, undefined]]);
            expect(gateway.resumeSession).not.toHaveBeenCalled();
        });

        it('erases a malformed key without contacting the gateway', async () => {
            const { workspaceState } = makeProvider({ persistedKey: 'agent:coder:subagent:1' });
            await flush();
            expect(workspaceState.update.mock.calls).toEqual([[LAST_SESSION_KEY, undefined]]);
            expect(mockResolve).not.toHaveBeenCalled();
        });

        it('restores a known session into the active thread', async () => {
            jest.mocked(gateway.getHistory).mockResolvedValue(historyOf('earlier'));
            const { sidebar } = makeProvider({ persistedKey: 'agent:coder:main' });
            await flush();

            expect(threadOf(sidebar, 'thread-1').messages).toEqual([{ role: 'user', content: 'earlier' }]);
            expect(jest.mocked(gateway.resumeSession).mock.calls).toEqual([
                ['agent:coder:main', expect.any(Function), { historyRendered: true }],
            ]);
        });

        it('keeps restoring into its thread when focus moves during the history fetch', async () => {
            const history = deferred<unknown>();
            jest.mocked(gateway.getHistory).mockReturnValueOnce(history.promise);
            const { sidebar } = makeProvider({ persistedKey: 'agent:coder:main' });
            await flush();

            await sidebar.send({ type: 'newSession' });
            history.resolve(historyOf('earlier'));
            await flush();

            expect(lastState(sidebar).activeThreadId).toBe('thread-2');
            expect(threadOf(sidebar, 'thread-1').messages).toEqual([{ role: 'user', content: 'earlier' }]);
            expect(resumedKeys(gateway)).toEqual(['agent:coder:main']);
        });

        it('defers the resume while a send runs and flushes it when the run is done', async () => {
            const history = deferred<unknown>();
            jest.mocked(gateway.getHistory).mockReturnValueOnce(history.promise);
            const { sidebar } = makeProvider({ persistedKey: 'agent:coder:main' });
            await flush();

            await sidebar.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            expect(lastSentSessionKey(gateway)).toBe('agent:coder:main');
            history.resolve(historyOf('earlier'));
            await flush();
            expect(gateway.resumeSession).not.toHaveBeenCalled();

            lastRunSink(gateway)({ type: 'done' });
            await flush();
            expect(jest.mocked(gateway.resumeSession).mock.calls).toEqual([
                ['agent:coder:main', expect.any(Function), { historyRendered: false }],
            ]);
        });

        it('leaves a session opened while the gateway resolved bound to the thread', async () => {
            const resumeResolve = deferred<unknown>();
            mockResolve.mockReturnValueOnce(resumeResolve.promise);
            const { sidebar } = makeProvider({ persistedKey: 'agent:coder:main' });
            await sidebar.send({ type: 'openSession', sessionKey: 'agent:main:main', threadId: 'thread-1' });
            await flush();

            resumeResolve.resolve({ service: gateway, transport: 'gateway' });
            await flush();
            await sidebar.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();

            expect(gateway.getHistory).not.toHaveBeenCalledWith('agent:coder:main');
            expect(lastSentSessionKey(gateway)).toBe('agent:main:main');
        });

        it('drops a deferred resume once the running send bound the thread to another session', async () => {
            const resumeResolve = deferred<unknown>();
            const sendResolve = deferred<unknown>();
            mockResolve.mockReturnValueOnce(resumeResolve.promise).mockReturnValueOnce(sendResolve.promise);
            const { sidebar } = makeProvider({ persistedKey: 'agent:coder:main' });
            void sidebar.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();

            resumeResolve.resolve({ service: gateway, transport: 'gateway' });
            await flush();
            sendResolve.resolve({ service: gateway, transport: 'gateway' });
            await flush();
            lastRunSink(gateway)({ type: 'done' });
            await flush();

            expect(lastSentSessionKey(gateway)).toBe('main');
            expect(gateway.resumeSession).not.toHaveBeenCalled();
        });

        it('retries a deferred resume on the next run when the gateway is down at done', async () => {
            const history = deferred<unknown>();
            jest.mocked(gateway.getHistory).mockReturnValueOnce(history.promise);
            const { sidebar } = makeProvider({ persistedKey: 'agent:coder:main' });
            await flush();
            await sidebar.send({ type: 'send', threadId: 'thread-1', text: 'first' });
            history.resolve(historyOf('earlier'));
            await flush();

            mockResolve.mockRejectedValueOnce(new Error('down'));
            lastRunSink(gateway)({ type: 'done' });
            await flush();
            expect(gateway.resumeSession).not.toHaveBeenCalled();

            await sidebar.send({ type: 'send', threadId: 'thread-1', text: 'second' });
            await flush();
            lastRunSink(gateway)({ type: 'done' });
            await flush();
            expect(resumedKeys(gateway)).toEqual(['agent:coder:main']);
        });

        it('drops the resume of a thread closed during the history fetch', async () => {
            const history = deferred<unknown>();
            jest.mocked(gateway.getHistory).mockReturnValueOnce(history.promise);
            const { sidebar } = makeProvider({ persistedKey: 'agent:coder:main' });
            await flush();

            await sidebar.send({ type: 'newSession' });
            await sidebar.send({ type: 'closeThread', threadId: 'thread-1' });
            history.resolve(historyOf('earlier'));
            await flush();

            expect(gateway.resumeSession).not.toHaveBeenCalled();
            expect(gateway.seedHistory).not.toHaveBeenCalled();
        });

        it('never erases a session persisted while the gateway resolved', async () => {
            const resumeResolve = deferred<unknown>();
            mockResolve.mockReturnValueOnce(resumeResolve.promise);
            const { sidebar, workspaceState } = makeProvider({ persistedKey: 'agent:gone:main' });
            await sidebar.send({ type: 'openSession', sessionKey: 'agent:main:main', threadId: 'thread-1' });
            await flush();

            resumeResolve.resolve({ service: gateway, transport: 'gateway' });
            await flush();

            expect(workspaceState.update.mock.calls).toEqual([[LAST_SESSION_KEY, 'agent:main:main']]);
        });
    });

    describe('webview bootstrap', () => {
        it('resumes the persisted session only once across webviews', async () => {
            const { provider, workspaceState } = makeProvider({ persistedKey: 'agent:coder:main' });
            provider.popOut();
            provider.attachDebugPanel(jest.mocked(vscode.window.createWebviewPanel)('openclaw.debug', 'Debug', vscode.ViewColumn.Beside));
            await flush();
            expect(workspaceState.get).toHaveBeenCalledTimes(1);
        });

        it('stops posting to the sidebar and debug panel once they are disposed', async () => {
            const { provider, sidebar, view } = makeProvider();
            const debug = jest.mocked(vscode.window.createWebviewPanel)('openclaw.debug', 'Debug', vscode.ViewColumn.Beside);
            provider.attachDebugPanel(debug);
            const debugPanel = lastPanel();
            jest.mocked(view.onDidDispose).mock.calls[0][0]();
            debugPanel.onDidDispose.mock.calls[0][0]();
            sidebar.posted.length = 0;
            debugPanel.webview.postMessage.mockClear();

            provider.newSession();

            expect(sidebar.posted).toEqual([]);
            expect(debugPanel.webview.postMessage).not.toHaveBeenCalled();
        });

        it('answers requestState from the pop-out with state for every view', async () => {
            const { provider, sidebar } = makeProvider();
            provider.popOut();
            const popOut = lastPopOut();
            sidebar.posted.length = 0;

            await popOut.send({ type: 'requestState' });

            expect(sidebar.posted.some(isStateMessage)).toBe(true);
            expect(popOut.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'state' }));
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

        afterEach(() => {
            (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = undefined;
        });

        it('prefers the focused pop-out over the visible sidebar', async () => {
            const { provider, sidebar } = makeProvider();
            provider.popOut();
            const panel = lastPanel();
            panel.active = true;

            await provider.insertSelectionMention();

            expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: 'insertMention', mention: '@a.ts' });
            expect(sidebar.posted.some(m => m.type === 'insertMention')).toBe(false);
        });

        it('reveals a hidden pop-out when there is no sidebar', async () => {
            const provider = new ChatViewProvider(vscode.Uri.file('/ext'), makeContext().context);
            provider.popOut();
            const panel = lastPanel();

            await provider.insertSelectionMention();

            expect(panel.reveal).toHaveBeenCalledWith(undefined, true);
            expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: 'insertMention', mention: '@a.ts' });
        });
    });

    describe('inbound message validation', () => {
        const MALFORMED: unknown[] = [
            null,
            'send',
            {},
            { type: 'bogus', threadId: 'thread-1' },
            { type: 'send', threadId: 'thread-1', text: '' },
            { type: 'send', threadId: 7, text: 'hi' },
            { type: 'setChatType', threadId: 'thread-1', chatType: 'root' },
            { type: 'setChatType', threadId: 'thread-1', chatType: 5 },
            { type: 'setModel', threadId: 'thread-1', model: '--dangerously-bypass' },
            { type: 'setModel', threadId: 'thread-1', model: ['claude'] },
            { type: 'slashCommand', threadId: 'thread-1', command: 5, text: 'x' },
            { type: 'slashCommand', threadId: 'thread-1', command: 'plan', text: 5 },
            { type: 'cancel', threadId: 'thread-9' },
            { type: 'clearThread', threadId: null },
            { type: 'focusThread', threadId: 'thread-9' },
            { type: 'closeThread', threadId: {} },
            { type: 'requestAgents', threadId: 'thread-1' },
            { type: 'selectAgent', sessionKey: 'agent:coder:main' },
            { type: 'openSession', sessionKey: 'agent:coder:subagent:1', threadId: 'thread-1' },
            { type: 'openSession', sessionKey: 42, threadId: 'thread-1' },
            { type: 'openSession', sessionKey: 'agent:coder:main', threadId: 42 },
            { type: 'setDimension', dimension: '9x9' },
            { type: 'setSetting', key: 'chat.agent', value: 'x' },
            { type: 'attach', threadId: 7 },
            { type: 'removeAttachment', threadId: 'thread-1', index: 0 },
            { type: 'exportThread', threadId: 7 },
            { type: 'fileSearch', query: 5 },
            { type: 'attachFile', threadId: 'thread-1', filePath: '' },
            { type: 'attachFiles', threadId: 'thread-1', filePaths: 'x' },
            { type: 'openFile', filePath: 5 },
            { type: 'openFile', filePath: 'a.ts', line: 5 },
        ];

        it('ignores malformed messages of every type', async () => {
            const update = jest.fn(async () => undefined);
            const getConfiguration = jest.mocked(vscode.workspace.getConfiguration);
            const original = getConfiguration.getMockImplementation();
            getConfiguration.mockImplementation(() => ({
                get: ((_section: string, defaultValue?: unknown) => defaultValue) as vscode.WorkspaceConfiguration['get'],
                has: () => false,
                inspect: () => undefined,
                update,
            }));
            try {
                const { sidebar } = makeProvider();
                await sidebar.send({ type: 'requestState' });
                const before = threadOf(sidebar, 'thread-1');

                for (const message of MALFORMED) {
                    await expect(sidebar.send(message)).resolves.toBeUndefined();
                }
                await sidebar.send({ type: 'requestState' });

                expect(threadOf(sidebar, 'thread-1')).toEqual(before);
                expect(lastState(sidebar).threads).toHaveLength(1);
                expect(mockResolve).not.toHaveBeenCalled();
                expect(update).not.toHaveBeenCalled();
                expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
                expect(sidebar.posted.some(m => m.type === 'agentsList' || m.type === 'sessionsList')).toBe(false);
            } finally {
                getConfiguration.mockImplementation(original);
            }
        });

        it('switches the chat type and model only to offered values', async () => {
            const { sidebar } = makeProvider();
            await sidebar.send({ type: 'setChatType', threadId: 'thread-1', chatType: 'review' });
            await sidebar.send({ type: 'setModel', threadId: 'thread-1', model: 'claude' });
            expect(threadOf(sidebar, 'thread-1')).toMatchObject({ currentChatType: 'review', currentModel: 'claude' });
        });
    });
});
