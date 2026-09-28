import * as vscode from 'vscode';
import type { ChatEvent } from '../chat/ChatService';

const mockResolve = jest.fn();
const mockFactoryCallbacks: { onInvalidated?: (reason: 'identity' | 'transport') => void } = {};

jest.mock('../webview/chatServiceFactory', () => ({
    ChatServiceFactory: jest.fn().mockImplementation((_context, _onStatus, onInvalidated) => {
        mockFactoryCallbacks.onInvalidated = onInvalidated;
        return { resolve: (...args: unknown[]) => mockResolve(...args), dispose: jest.fn() };
    }),
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
        getTransportLimits = jest.fn(() => ({ maxPayloadBytes: 26214400, maxBufferedBytes: 52428800, attachmentMaxBytes: 20971520, attachmentMaxImageBytes: 6291456 }));
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

// Identity realpath keeps mention resolution off the disk; the attachment
// reader's /proc fd check still needs the real one.
jest.mock('fs', () => {
    const actual = jest.requireActual('fs');
    const realpath = async (p: string): Promise<string> => p.startsWith('/proc/') ? actual.promises.realpath(p) : p;
    return { ...actual, promises: { ...actual.promises, realpath } };
});

import { ChatService } from '../chat/ChatService';
import { ChatViewProvider } from '../webview/ChatViewProvider';
import type { GatewayChatService } from '../core/gatewayChatService';
import * as viewMessaging from '../webview/viewMessaging';

type Posted = Record<string, unknown>;
type ThreadState = {
    id: string;
    messages: Array<Record<string, unknown>>;
    pendingAssistantText: string;
    pendingAttachments: unknown[];
    contextTokens: number;
    isStreaming: boolean;
    status: string;
    currentModel: string;
};
type StateMessage = { type: 'state'; threads: ThreadState[]; visibleThreadIds: string[] };
type BackendChoice = { service: ChatService | GatewayChatService; transport: 'gateway' | 'acpx' };
type AcpxSendArgs = Parameters<ChatService['sendMessage']>;

type FakeWebview = {
    posted: Posted[];
    send(message: Posted): Promise<void>;
};

type FakeView = {
    webview: vscode.Webview;
    visible: boolean;
    show: (preserveFocus?: boolean) => void;
    onDidDispose: vscode.Event<void>;
};

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void };

const { GatewayChatService: MockGatewayChatService } =
    jest.requireMock<{ GatewayChatService: new () => GatewayChatService }>('../core/gatewayChatService');

const SESSION_ROWS = [
    { key: 'agent:main:main', label: 'Main' },
    { key: 'agent:coder:main', label: 'Coder' },
];

const actualFs = jest.requireActual<typeof import('fs')>('fs');

// Real setImmediate: the global one is faked.
const { setImmediate: realSetImmediate } = jest.requireActual<typeof import('timers')>('timers');

async function flush(): Promise<void> {
    for (let i = 0; i < 10; i++) {
        await new Promise(resolve => realSetImmediate(resolve));
    }
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function makeMemento(): vscode.Memento {
    return { keys: () => [], get: jest.fn(), update: jest.fn(async () => undefined) };
}

function makeContext(workspaceState = makeMemento()): vscode.ExtensionContext {
    const context: Pick<vscode.ExtensionContext, 'globalState' | 'workspaceState'> = {
        globalState: { ...makeMemento(), setKeysForSync: jest.fn() },
        workspaceState,
    };
    return context as vscode.ExtensionContext;
}

function makeProvider(workspaceState?: vscode.Memento): FakeWebview {
    const provider = new ChatViewProvider(vscode.Uri.file('/ext'), makeContext(workspaceState));
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
    const view: FakeView = { webview, visible: true, show: jest.fn(), onDidDispose: jest.fn() };
    provider.resolveWebviewView(view as vscode.WebviewView, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
    return { posted, send: (message) => handler(message) };
}

function isStateMessage(message: Posted): message is StateMessage {
    return message.type === 'state';
}

function threadOf(webview: FakeWebview, threadId: string): ThreadState {
    const states = webview.posted.filter(isStateMessage);
    const thread = states[states.length - 1].threads.find(t => t.id === threadId);
    expect(thread).toBeDefined();
    return thread!;
}

function lastMessage(webview: FakeWebview, threadId: string): Record<string, unknown> {
    const messages = threadOf(webview, threadId).messages;
    return messages[messages.length - 1];
}

function withTempFile(name: string, body: string): { dir: string; file: string } {
    const dir = actualFs.mkdtempSync('/tmp/claw-send-');
    const file = `${dir}/${name}`;
    actualFs.writeFileSync(file, body);
    return { dir, file };
}

describe('ChatViewProvider send lifecycle', () => {
    let gateway: GatewayChatService;
    let acpxSend: jest.SpyInstance<void, AcpxSendArgs>;
    let acpxAbort: jest.SpyInstance<void, []>;

    const gatewayChoice = (): BackendChoice => ({ service: gateway, transport: 'gateway' });
    const acpxChoice = (service = new ChatService()): BackendChoice => ({ service, transport: 'acpx' });
    const gatewayPrompts = (): string[] => jest.mocked(gateway.sendMessage).mock.calls.map(call => call[0]);
    const acpxPrompts = (): string[] => acpxSend.mock.calls.map(call => call[0]);

    function lastGatewayRun(): Parameters<GatewayChatService['sendMessage']> {
        const calls = jest.mocked(gateway.sendMessage).mock.calls;
        return calls[calls.length - 1];
    }

    function lastAcpxRun(): AcpxSendArgs {
        return acpxSend.mock.calls[acpxSend.mock.calls.length - 1];
    }

    /** Resolve the next backend lookups only when the test says so. */
    function deferResolves(count: number): Array<Deferred<BackendChoice>> {
        const pending = Array.from({ length: count }, () => deferred<BackendChoice>());
        pending.forEach(next => mockResolve.mockImplementationOnce(() => next.promise));
        return pending;
    }

    /** Opens a session into thread-1 and returns its persistent transcript sink. */
    async function openSession(webview: FakeWebview, sessionKey = 'agent:main:main'): Promise<(event: ChatEvent) => void> {
        await webview.send({ type: 'openSession', sessionKey, threadId: 'thread-1' });
        await flush();
        const calls = jest.mocked(gateway.resumeSession).mock.calls;
        return calls[calls.length - 1][1];
    }

    beforeEach(() => {
        jest.useFakeTimers();
        (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = [{ uri: vscode.Uri.file('/work') }];
        gateway = new MockGatewayChatService();
        jest.mocked(gateway.listSessions).mockResolvedValue({ sessions: SESSION_ROWS });
        mockResolve.mockReset();
        mockResolve.mockResolvedValue(gatewayChoice());
        acpxSend = jest.spyOn(ChatService.prototype, 'sendMessage').mockImplementation(() => undefined);
        acpxAbort = jest.spyOn(ChatService.prototype, 'abort').mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
        jest.mocked(vscode.workspace.fs.stat).mockReset();
        (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = undefined;
    });

    describe('transcript events during a send', () => {
        it('a transcript `done` while the backend resolves does not retire the send', async () => {
            const webview = makeProvider();
            const transcript = await openSession(webview);
            const [resolve] = deferResolves(1);

            void webview.send({ type: 'send', threadId: 'thread-1', text: 'mine' });
            await flush();
            transcript({ type: 'text', text: 'external reply' });
            transcript({ type: 'done' });
            await flush();
            resolve.resolve(gatewayChoice());
            await flush();

            expect(gatewayPrompts()).toEqual(['mine']);
            expect(threadOf(webview, 'thread-1').status).toBe('running');
            expect(threadOf(webview, 'thread-1').messages.map(m => m.content)).toEqual(['mine', 'external reply']);
        });

        it('a transcript `error` while the backend resolves does not retire the send', async () => {
            const webview = makeProvider();
            const transcript = await openSession(webview);
            const [resolve] = deferResolves(1);

            void webview.send({ type: 'send', threadId: 'thread-1', text: 'mine' });
            await flush();
            transcript({ type: 'error', message: 'external failure' });
            await flush();
            resolve.resolve(gatewayChoice());
            await flush();

            expect(gatewayPrompts()).toEqual(['mine']);
            expect(threadOf(webview, 'thread-1').isStreaming).toBe(true);
        });

        it('a transcript `done` or `error` during an acpx run leaves the run to its own sink', async () => {
            const webview = makeProvider();
            await openSession(webview);
            mockResolve.mockResolvedValue(acpxChoice());
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            const rebinds = jest.mocked(gateway.rebindTranscriptSink).mock.calls;
            const transcript = rebinds[rebinds.length - 1][1];
            const run = lastAcpxRun()[4];

            transcript({ type: 'error', message: 'external failure' });
            transcript({ type: 'done' });
            await flush();
            expect(threadOf(webview, 'thread-1')).toMatchObject({ status: 'running', isStreaming: true });

            run({ type: 'text', text: 'acpx reply' });
            run({ type: 'done' });
            await flush();
            expect(threadOf(webview, 'thread-1')).toMatchObject({ status: 'complete', isStreaming: false });

            transcript({ type: 'text', text: 'later' });
            transcript({ type: 'done' });
            await flush();
            expect(threadOf(webview, 'thread-1').isStreaming).toBe(false);
        });

        it('tells the webview a thread started streaming on its first transcript chunk', async () => {
            const webview = makeProvider();
            const transcript = await openSession(webview);

            transcript({ type: 'text', text: 'external' });
            await flush();

            expect(threadOf(webview, 'thread-1')).toMatchObject({ isStreaming: true, pendingAssistantText: 'external' });
        });
    });

    describe('send failures', () => {
        it('restores the suspended transcript sink when the send throws', async () => {
            const webview = makeProvider();
            await openSession(webview);
            jest.mocked(gateway.sendMessage).mockImplementation(() => { throw new Error('boom'); });

            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            const rebinds = jest.mocked(gateway.rebindTranscriptSink).mock.calls;
            expect(rebinds.map(call => call[0])).toEqual(['agent:main:main']);
            rebinds[0][1]({ type: 'text', text: 'heard again' });
            await flush();

            expect(threadOf(webview, 'thread-1').pendingAssistantText).toBe('heard again');
        });

        it('a cancelled send that throws later does not fail the send that replaced it', async () => {
            const webview = makeProvider();
            const [first, second] = deferResolves(2);

            void webview.send({ type: 'send', threadId: 'thread-1', text: 'first' });
            await flush();
            await webview.send({ type: 'cancel', threadId: 'thread-1' });
            void webview.send({ type: 'send', threadId: 'thread-1', text: 'second' });
            await flush();
            first.reject(new Error('stale failure'));
            await flush();
            second.resolve(gatewayChoice());
            await flush();

            expect(gatewayPrompts()).toEqual(['second']);
            expect(threadOf(webview, 'thread-1').messages).not.toContainEqual({ role: 'error', content: 'Send failed: stale failure' });
            expect(threadOf(webview, 'thread-1').status).toBe('running');
        });

        it('reports a failing backend resolve in the thread', async () => {
            const webview = makeProvider();
            mockResolve.mockRejectedValue(new Error('invalid gateway URL'));

            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();

            expect(lastMessage(webview, 'thread-1')).toEqual({ role: 'error', content: 'Send failed: invalid gateway URL' });
            expect(threadOf(webview, 'thread-1')).toMatchObject({ status: 'error', isStreaming: false });
        });

        it('reports a failing attachment read in the thread', async () => {
            const webview = makeProvider();
            jest.spyOn(viewMessaging, 'readAttachments').mockRejectedValue(new Error('disk gone'));
            await webview.send({ type: 'attachFiles', threadId: 'thread-1', filePaths: ['/tmp/claw-note.txt'] });

            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();

            expect(gatewayPrompts()).toEqual([]);
            expect(lastMessage(webview, 'thread-1')).toEqual({ role: 'error', content: 'Send failed: disk gone' });
        });

        it('reports a send without a workspace folder', async () => {
            const webview = makeProvider();
            (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = undefined;

            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();

            expect(mockResolve).not.toHaveBeenCalled();
            expect(lastMessage(webview, 'thread-1')).toEqual({ role: 'error', content: 'No workspace folder open. Open a folder to use chat.' });
            expect(threadOf(webview, 'thread-1').status).toBe('error');
        });
    });

    describe('cancel', () => {
        it('during mention resolution sends nothing and keeps the mention out of the thread', async () => {
            const webview = makeProvider();
            const stat = deferred<vscode.FileStat>();
            jest.mocked(vscode.workspace.fs.stat).mockImplementationOnce(() => stat.promise);

            void webview.send({ type: 'send', threadId: 'thread-1', text: 'look at @a.ts' });
            await flush();
            await webview.send({ type: 'cancel', threadId: 'thread-1' });
            stat.resolve({ type: 1, ctime: 0, mtime: 0, size: 1 });
            await flush();

            expect(mockResolve).not.toHaveBeenCalled();
            expect(threadOf(webview, 'thread-1')).toMatchObject({ status: 'cancelled', messages: [], pendingAttachments: [] });
        });

        it('during the backend resolve disposes the acpx service it produced', async () => {
            const webview = makeProvider();
            const [resolve] = deferResolves(1);
            const fresh = new ChatService();
            const dispose = jest.spyOn(fresh, 'dispose');

            void webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            await webview.send({ type: 'cancel', threadId: 'thread-1' });
            resolve.resolve(acpxChoice(fresh));
            await flush();

            expect(acpxSend).not.toHaveBeenCalled();
            expect(dispose).toHaveBeenCalled();
            expect(threadOf(webview, 'thread-1').status).toBe('cancelled');
        });

        it('during the attachment read removes the snapshots and sends nothing', async () => {
            const webview = makeProvider();
            const read = deferred<{ prompt: string; dispose: () => Promise<void> }>();
            const disposeSnapshots = jest.fn(async () => undefined);
            jest.spyOn(viewMessaging, 'readAttachments').mockReturnValue(read.promise);
            mockResolve.mockResolvedValue(acpxChoice());
            await webview.send({ type: 'attachFiles', threadId: 'thread-1', filePaths: ['/tmp/claw-note.txt'] });

            void webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            await webview.send({ type: 'cancel', threadId: 'thread-1' });
            read.resolve({ prompt: 'attached', dispose: disposeSnapshots });
            await flush();

            expect(acpxSend).not.toHaveBeenCalled();
            expect(disposeSnapshots).toHaveBeenCalled();
        });

        it('after dispatch aborts the acpx run and drops its late events', async () => {
            const webview = makeProvider();
            mockResolve.mockResolvedValue(acpxChoice());
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            const onEvent = lastAcpxRun()[4];

            await webview.send({ type: 'cancel', threadId: 'thread-1' });
            onEvent({ type: 'text', text: 'late' });
            onEvent({ type: 'done' });
            await flush();

            expect(acpxAbort).toHaveBeenCalled();
            expect(threadOf(webview, 'thread-1')).toMatchObject({ status: 'cancelled', isStreaming: false, pendingAssistantText: '' });
            expect(threadOf(webview, 'thread-1').messages.map(m => m.role)).toEqual(['user']);
        });

        it('drops usage reported by the cancelled run', async () => {
            const webview = makeProvider();
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            const onEvent = lastGatewayRun()[4];
            onEvent({ type: 'usage', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 500 } });
            await flush();
            expect(threadOf(webview, 'thread-1').contextTokens).toBe(500);

            await webview.send({ type: 'cancel', threadId: 'thread-1' });
            onEvent({ type: 'usage', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 900 } });
            await flush();

            expect(threadOf(webview, 'thread-1').contextTokens).toBe(500);
        });
    });

    describe('clear and close mid-send', () => {
        it('clearing during the backend resolve sends nothing into the cleared thread', async () => {
            const webview = makeProvider();
            const [resolve] = deferResolves(1);

            void webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            await webview.send({ type: 'clearThread', threadId: 'thread-1' });
            resolve.resolve(gatewayChoice());
            await flush();

            expect(gatewayPrompts()).toEqual([]);
            expect(threadOf(webview, 'thread-1')).toMatchObject({ status: 'idle', messages: [], isStreaming: false });
        });

        it('closing during the backend resolve sends nothing and disposes the acpx service', async () => {
            const webview = makeProvider();
            await webview.send({ type: 'newSession' });
            const [resolve] = deferResolves(1);
            const fresh = new ChatService();
            const dispose = jest.spyOn(fresh, 'dispose');

            void webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            await webview.send({ type: 'closeThread', threadId: 'thread-1' });
            resolve.resolve(acpxChoice(fresh));
            await flush();

            expect(acpxSend).not.toHaveBeenCalled();
            expect(dispose).toHaveBeenCalled();
        });
    });

    describe('backend switching', () => {
        it('sends each prompt once through the backend resolved for it', async () => {
            const webview = makeProvider();
            const acpx = new ChatService();
            const disposeAcpx = jest.spyOn(acpx, 'dispose');
            mockResolve
                .mockResolvedValueOnce(gatewayChoice())
                .mockResolvedValueOnce(acpxChoice(acpx))
                .mockResolvedValueOnce(gatewayChoice());

            await webview.send({ type: 'send', threadId: 'thread-1', text: 'one' });
            await flush();
            const gatewayRun = lastGatewayRun()[4];
            gatewayRun({ type: 'done' });
            await flush();
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'two' });
            await flush();
            const acpxRun = lastAcpxRun()[4];
            acpxRun({ type: 'done' });
            await flush();
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'three' });
            await flush();
            gatewayRun({ type: 'text', text: 'late gateway' });
            acpxRun({ type: 'text', text: 'late acpx' });
            await flush();

            expect(gatewayPrompts()).toEqual(['one', 'three']);
            expect(acpxPrompts()).toEqual(['two']);
            expect(disposeAcpx).toHaveBeenCalled();
            expect(threadOf(webview, 'thread-1')).toMatchObject({ status: 'running', pendingAssistantText: '' });
        });

        it('keeps the session transcript sink across a fallback to acpx, silent during the acpx run', async () => {
            const webview = makeProvider();
            await openSession(webview);
            mockResolve.mockResolvedValue(acpxChoice());

            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            const rebinds = jest.mocked(gateway.rebindTranscriptSink).mock.calls;
            const transcript = rebinds[rebinds.length - 1][1];
            const run = lastAcpxRun()[4];
            run({ type: 'text', text: 'part one ' });
            transcript({ type: 'text', text: 'session output ' });
            transcript({ type: 'done' });
            run({ type: 'text', text: 'part two' });
            run({ type: 'done' });
            await flush();
            expect(threadOf(webview, 'thread-1').messages.map(m => m.content)).toEqual(['go', 'part one part two']);

            transcript({ type: 'text', text: 'session output' });
            await flush();
            expect(threadOf(webview, 'thread-1').pendingAssistantText).toBe('session output');
        });
    });

    describe('attachments', () => {
        it('sends an acpx prompt with the attachment once it is read', async () => {
            const { dir, file } = withTempFile('note.txt', 'attached body');
            try {
                const webview = makeProvider();
                mockResolve.mockResolvedValue(acpxChoice());
                await webview.send({ type: 'attachFiles', threadId: 'thread-1', filePaths: [file] });

                await webview.send({ type: 'send', threadId: 'thread-1', text: 'with attachment' });
                await flush();

                expect(acpxPrompts()).toHaveLength(1);
                expect(acpxPrompts()[0]).toContain('attached body');
                expect(acpxPrompts()[0]).toContain('with attachment');
                expect(threadOf(webview, 'thread-1').pendingAttachments).toEqual([]);
            } finally {
                actualFs.rmSync(dir, { recursive: true, force: true });
            }
        });

        it('attaches a mentioned workspace file to a slash command', async () => {
            const { dir } = withTempFile('note.txt', 'attached body');
            (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = [{ uri: vscode.Uri.file(dir) }];
            try {
                const webview = makeProvider();

                await webview.send({ type: 'slashCommand', threadId: 'thread-1', command: 'explain', text: '@note.txt' });
                await flush();

                expect(gatewayPrompts()).toHaveLength(1);
                expect(gatewayPrompts()[0]).toContain('attached body');
                expect(threadOf(webview, 'thread-1').messages[0]).toEqual({ role: 'user', content: '/explain @note.txt' });
            } finally {
                actualFs.rmSync(dir, { recursive: true, force: true });
            }
        });
    });

    describe('slash commands', () => {
        it('sends an unknown command as the text the user typed', async () => {
            const webview = makeProvider();

            await webview.send({ type: 'slashCommand', threadId: 'thread-1', command: 'nope', text: 'hi' });
            await flush();

            expect(gatewayPrompts()).toEqual(['/nope hi']);
        });

        it('marks the thread busy before gathering editor context', async () => {
            const webview = makeProvider();
            const [resolve] = deferResolves(1);

            void webview.send({ type: 'slashCommand', threadId: 'thread-1', command: 'plan', text: 'x' });
            expect(threadOf(webview, 'thread-1')).toMatchObject({ isStreaming: true, messages: [] });
            await webview.send({ type: 'slashCommand', threadId: 'thread-1', command: 'plan', text: 'y' });
            await flush();
            resolve.resolve(gatewayChoice());
            await flush();

            expect(gatewayPrompts()).toHaveLength(1);
            expect(threadOf(webview, 'thread-1').messages.map(m => m.content)).toEqual(['/plan x']);
        });
    });

    describe('sends while a session opens', () => {
        const OPENING = { role: 'error', content: 'A session is being opened in this thread. Send the message again once it has loaded.' };
        const HISTORY = { messages: [{ role: 'user', text: 'earlier', messageId: 'u1' }] };

        it('shows each rejected send with the reason, and keeps both past the history restore', async () => {
            const webview = makeProvider();
            const [openResolve] = deferResolves(1);
            jest.mocked(gateway.getHistory).mockResolvedValue(HISTORY);
            void webview.send({ type: 'openSession', sessionKey: 'agent:coder:main', threadId: 'thread-1' });
            await flush();

            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await webview.send({ type: 'slashCommand', threadId: 'thread-1', command: 'plan', text: 'x' });
            expect(threadOf(webview, 'thread-1').messages).toEqual([
                { role: 'user', content: 'go' }, OPENING, { role: 'user', content: '/plan x' }, OPENING,
            ]);
            openResolve.resolve(gatewayChoice());
            await flush();

            expect(gatewayPrompts()).toEqual([]);
            expect(threadOf(webview, 'thread-1').messages).toEqual([
                { role: 'user', content: 'earlier' },
                { role: 'user', content: 'go' }, OPENING, { role: 'user', content: '/plan x' }, OPENING,
            ]);
        });

        it('retires a send whose backend resolved after an open started, keeping it past the restore', async () => {
            const webview = makeProvider();
            const [sendResolve, openResolve] = deferResolves(2);
            jest.mocked(gateway.getHistory).mockResolvedValue(HISTORY);

            void webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            void webview.send({ type: 'openSession', sessionKey: 'agent:coder:main', threadId: 'thread-1' });
            await flush();
            sendResolve.resolve(gatewayChoice());
            await flush();
            expect(threadOf(webview, 'thread-1')).toMatchObject({ status: 'error', isStreaming: false });
            expect(threadOf(webview, 'thread-1').messages).toEqual([{ role: 'user', content: 'go' }, OPENING]);
            openResolve.resolve(gatewayChoice());
            await flush();

            expect(gatewayPrompts()).toEqual([]);
            expect(threadOf(webview, 'thread-1').messages).toEqual([{ role: 'user', content: 'earlier' }, { role: 'user', content: 'go' }, OPENING]);
        });

        it('forgets rejected sends once the open settles', async () => {
            const webview = makeProvider();
            const [firstOpen] = deferResolves(1);
            jest.mocked(gateway.getHistory).mockResolvedValue(HISTORY);
            void webview.send({ type: 'openSession', sessionKey: 'agent:coder:main', threadId: 'thread-1' });
            await flush();
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            firstOpen.resolve(gatewayChoice());
            await flush();

            await openSession(webview, 'agent:main:main');

            expect(threadOf(webview, 'thread-1').messages).toEqual([{ role: 'user', content: 'earlier' }]);
        });
    });

    describe('concurrent sends', () => {
        it.each([
            ['in send order', [0, 1]],
            ['in reverse order', [1, 0]],
        ])('dispatches the first of two threads sending on the same session when resolves land %s', async (_order, landing) => {
            const webview = makeProvider();
            await webview.send({ type: 'newSession' });
            const resolves = deferResolves(2);

            void webview.send({ type: 'send', threadId: 'thread-1', text: 'from one' });
            void webview.send({ type: 'send', threadId: 'thread-2', text: 'from two' });
            await flush();
            for (const index of landing) {
                resolves[index].resolve(gatewayChoice());
                await flush();
            }

            expect(gatewayPrompts()).toEqual(['from one']);
            expect(threadOf(webview, 'thread-1').status).toBe('running');
            expect(lastMessage(webview, 'thread-2')).toEqual({
                role: 'error',
                content: 'Session "main" is already streaming in another chat thread. Wait for it to finish or open a different session.',
            });
        });

        it('lets a later send claim a session whose earlier claimant was cancelled', async () => {
            const webview = makeProvider();
            await webview.send({ type: 'newSession' });
            const [first, second] = deferResolves(2);

            void webview.send({ type: 'send', threadId: 'thread-1', text: 'from one' });
            await flush();
            await webview.send({ type: 'cancel', threadId: 'thread-1' });
            void webview.send({ type: 'send', threadId: 'thread-2', text: 'from two' });
            await flush();
            second.resolve(gatewayChoice());
            first.resolve(gatewayChoice());
            await flush();

            expect(gatewayPrompts()).toEqual(['from two']);
        });

        it('ignores a second send on a thread that is still streaming', async () => {
            const webview = makeProvider();
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'first' });
            await flush();

            await webview.send({ type: 'send', threadId: 'thread-1', text: 'second' });
            await flush();

            expect(gatewayPrompts()).toEqual(['first']);
            expect(threadOf(webview, 'thread-1').messages.map(m => m.content)).toEqual(['first']);
        });
    });

    describe('run events', () => {
        async function sendAndCaptureRun(webview: FakeWebview): Promise<(event: ChatEvent) => void> {
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            return lastGatewayRun()[4];
        }

        it('keeps the error status when `done` follows an error', async () => {
            const webview = makeProvider();
            const run = await sendAndCaptureRun(webview);

            run({ type: 'error', message: 'boom' });
            run({ type: 'done' });
            await flush();

            expect(threadOf(webview, 'thread-1')).toMatchObject({ status: 'error', isStreaming: false });
            expect(threadOf(webview, 'thread-1').messages).toEqual([
                { role: 'user', content: 'go' },
                { role: 'error', content: 'boom' },
            ]);
        });

        it('commits the reply once when `done` arrives twice', async () => {
            const webview = makeProvider();
            const run = await sendAndCaptureRun(webview);

            run({ type: 'text', text: 'reply' });
            run({ type: 'done' });
            run({ type: 'done' });
            await flush();

            expect(threadOf(webview, 'thread-1').status).toBe('complete');
            expect(threadOf(webview, 'thread-1').messages.map(m => m.role)).toEqual(['user', 'assistant']);
        });

        it('rebinds the thread to the session key the gateway resolved', async () => {
            const webview = makeProvider();
            await sendAndCaptureRun(webview);
            const onSessionResolved = lastGatewayRun()[5]!;

            onSessionResolved('agent:main:main', 'main');
            jest.mocked(gateway.hasOwnedRun).mockReturnValue(true);
            await webview.send({ type: 'cancel', threadId: 'thread-1' });

            expect(gateway.abort).toHaveBeenCalledWith('agent:main:main');
        });

        it('retires a run whose thread moved to another session before the gateway resolved it', async () => {
            const webview = makeProvider();
            await sendAndCaptureRun(webview);
            const onSessionResolved = lastGatewayRun()[5]!;
            await openSession(webview, 'agent:coder:main');

            onSessionResolved('main', 'main');
            await flush();

            expect(gateway.clearSessionSink).toHaveBeenCalledWith('main');
            expect(threadOf(webview, 'thread-1')).toMatchObject({ isStreaming: false });
            expect(threadOf(webview, 'thread-1').status).not.toBe('running');
        });

        it('restores the transcript sink on the session key the gateway resolved', async () => {
            const webview = makeProvider();
            await openSession(webview);
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            const [, , , , run, onSessionResolved] = lastGatewayRun();

            onSessionResolved!('agent:main:resolved', 'agent:main:main');
            run({ type: 'done' });
            await flush();

            expect(jest.mocked(gateway.rebindTranscriptSink).mock.calls.map(call => call[0])).toEqual(['agent:main:resolved']);
        });

        it('drops a reply whose thread was cleared while it rendered', async () => {
            const webview = makeProvider();
            const render = deferred<string>();
            jest.spyOn(viewMessaging, 'renderMarkdown').mockReturnValue(render.promise);
            const run = await sendAndCaptureRun(webview);

            run({ type: 'text', text: 'reply' });
            run({ type: 'done' });
            await flush();
            await webview.send({ type: 'clearThread', threadId: 'thread-1' });
            render.resolve('<p>reply</p>');
            await flush();

            expect(threadOf(webview, 'thread-1')).toMatchObject({ messages: [], status: 'idle' });
        });
    });

    describe('gateway session allowlist', () => {
        it('resets a thread bound to a session the current gateway no longer lists', async () => {
            const webview = makeProvider();
            await openSession(webview, 'agent:coder:main');
            jest.mocked(gateway.getGatewayIdentity).mockReturnValue('gateway-2');
            jest.mocked(gateway.listSessions).mockResolvedValue({ sessions: [{ key: 'agent:main:main', label: 'Main' }] });

            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();

            expect(gatewayPrompts()).toEqual([]);
            expect(gateway.removeTranscriptSink).toHaveBeenCalledWith('agent:coder:main', expect.any(Function));
            expect(gateway.clearSessionSink).toHaveBeenCalledWith('agent:coder:main');
            expect(threadOf(webview, 'thread-1')).toMatchObject({ status: 'error', isStreaming: false });
            expect(lastMessage(webview, 'thread-1').content).toContain('is not known to the current gateway');
        });
    });

    describe('gateway invalidation', () => {
        it('interrupts only gateway threads that are running', async () => {
            const webview = makeProvider();
            await webview.send({ type: 'newSession' });
            await webview.send({ type: 'send', threadId: 'thread-2', text: 'gateway run' });
            await flush();
            lastGatewayRun()[4]({ type: 'done' });
            mockResolve.mockResolvedValue(acpxChoice());
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'acpx run' });
            await flush();

            mockFactoryCallbacks.onInvalidated!('transport');

            expect(threadOf(webview, 'thread-1').status).toBe('running');
            expect(threadOf(webview, 'thread-2').status).toBe('complete');
            expect(threadOf(webview, 'thread-2').messages.map(m => m.role)).toEqual(['user']);
        });
    });

    describe('clear and close on a gateway thread', () => {
        it('clearing aborts the thread\'s own run and keeps hearing the session', async () => {
            const webview = makeProvider();
            const staleTranscript = await openSession(webview);
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            jest.mocked(gateway.hasOwnedRun).mockReturnValue(true);

            await webview.send({ type: 'clearThread', threadId: 'thread-1' });
            const rebinds = jest.mocked(gateway.rebindTranscriptSink).mock.calls;
            staleTranscript({ type: 'text', text: 'stale' });
            rebinds[rebinds.length - 1][1]({ type: 'text', text: 'fresh' });
            await flush();

            expect(gateway.abort).toHaveBeenCalledWith('agent:main:main');
            expect(threadOf(webview, 'thread-1').pendingAssistantText).toBe('fresh');
        });

        it('closing a running thread aborts its run and releases its session', async () => {
            const webview = makeProvider();
            await webview.send({ type: 'newSession' });
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            jest.mocked(gateway.hasOwnedRun).mockReturnValue(true);

            await webview.send({ type: 'closeThread', threadId: 'thread-1' });

            expect(gateway.abort).toHaveBeenCalledWith('main');
            expect(gateway.clearSessionSink).toHaveBeenCalledWith('main');
        });

        it('closing keeps the session sink another thread is bound to', async () => {
            const webview = makeProvider();
            await webview.send({ type: 'newSession' });
            await webview.send({ type: 'send', threadId: 'thread-2', text: 'two' });
            await flush();
            lastGatewayRun()[4]({ type: 'done' });
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'one' });
            await flush();

            await webview.send({ type: 'closeThread', threadId: 'thread-1' });

            expect(gateway.clearSessionSink).not.toHaveBeenCalled();
        });
    });

    describe('attachment resolution', () => {
        type ReadCall = Parameters<typeof viewMessaging.readAttachments>;

        function spyOnReads(): jest.SpyInstance<ReturnType<typeof viewMessaging.readAttachments>, ReadCall> {
            return jest.spyOn(viewMessaging, 'readAttachments').mockResolvedValue({ prompt: 'attached', dispose: async () => undefined });
        }

        it('sends a mentioned line range with the prompt', async () => {
            const webview = makeProvider();
            const reads = spyOnReads();

            await webview.send({ type: 'send', threadId: 'thread-1', text: 'see @a.ts#L2-3' });
            await flush();

            expect(reads.mock.calls[0][0]).toEqual([{ name: 'a.ts', path: '/work/a.ts', type: 'file', lineStart: 2, lineEnd: 3 }]);
            expect(gatewayPrompts()).toEqual(['attached\n\nsee @a.ts#L2-3']);
        });

        it('sends a file both attached and mentioned only once', async () => {
            const webview = makeProvider();
            const reads = spyOnReads();
            await webview.send({ type: 'attachFile', threadId: 'thread-1', filePath: '/work/a.ts' });

            await webview.send({ type: 'send', threadId: 'thread-1', text: 'see @a.ts' });
            await flush();

            expect(reads.mock.calls[0][0].map(a => a.path)).toEqual(['/work/a.ts']);
        });

        it('ignores a mention outside the workspace', async () => {
            const webview = makeProvider();
            const reads = spyOnReads();

            await webview.send({ type: 'send', threadId: 'thread-1', text: 'see @../etc/passwd' });
            await flush();

            expect(reads).not.toHaveBeenCalled();
            expect(gatewayPrompts()).toEqual(['see @../etc/passwd']);
        });

        it('auto-attaches the open editor file once when it is also mentioned', async () => {
            const getConfiguration = jest.mocked(vscode.workspace.getConfiguration);
            const original = getConfiguration.getMockImplementation();
            const config: vscode.WorkspaceConfiguration = {
                get: ((key: string, defaultValue?: unknown) => key === 'chat.attachOpenFile' ? true : defaultValue) as vscode.WorkspaceConfiguration['get'],
                has: () => false,
                inspect: () => undefined,
                update: async () => undefined,
            };
            getConfiguration.mockImplementation(() => config);
            (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = { document: { uri: vscode.Uri.file('/work/a.ts') } };
            try {
                const webview = makeProvider();
                const reads = spyOnReads();

                await webview.send({ type: 'send', threadId: 'thread-1', text: 'see @a.ts' });
                await flush();

                expect(reads.mock.calls[0][0].map(a => a.path)).toEqual(['/work/a.ts']);
            } finally {
                getConfiguration.mockImplementation(original);
                (vscode.window as { activeTextEditor?: unknown }).activeTextEditor = undefined;
            }
        });

        it('attaches nothing picked in a dialog that outlived a cancel', async () => {
            const webview = makeProvider();
            const picked = deferred<vscode.Uri[] | undefined>();
            jest.mocked(vscode.window.showOpenDialog).mockReturnValueOnce(picked.promise);

            void webview.send({ type: 'attach', threadId: 'thread-1' });
            await webview.send({ type: 'cancel', threadId: 'thread-1' });
            picked.resolve([vscode.Uri.file('/work/a.ts')]);
            await flush();

            expect(threadOf(webview, 'thread-1').pendingAttachments).toEqual([]);
        });
    });

    describe('rejected sends', () => {
        const rejections = (webview: FakeWebview): Posted[] => webview.posted.filter(m => m.type === 'sendRejected');

        it('tells the webview about a send dropped by a guard', async () => {
            const webview = makeProvider();
            await webview.send({ type: 'send', threadId: 'thread-9', text: 'unknown pane' });
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'first' });
            await flush();
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'while streaming' });
            await webview.send({ type: 'slashCommand', threadId: 'thread-1', command: 'plan', text: 'while streaming' });

            expect(gatewayPrompts()).toEqual(['first']);
            expect(rejections(webview)).toEqual([
                { type: 'sendRejected', threadId: 'thread-9' },
                { type: 'sendRejected', threadId: 'thread-1' },
                { type: 'sendRejected', threadId: 'thread-1' },
            ]);
        });

        it('tells the webview about a send retired before dispatch', async () => {
            const webview = makeProvider();
            const [resolve] = deferResolves(1);

            const sending = webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            await webview.send({ type: 'cancel', threadId: 'thread-1' });
            resolve.resolve(gatewayChoice());
            await sending;

            expect(rejections(webview)).toEqual([{ type: 'sendRejected', threadId: 'thread-1' }]);
        });

        it('tells the webview about a send without a workspace or on a busy session', async () => {
            const webview = makeProvider();
            await webview.send({ type: 'newSession' });
            await webview.send({ type: 'send', threadId: 'thread-2', text: 'runs' });
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'session busy' });
            (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders = undefined;
            await webview.send({ type: 'newSession' });
            await webview.send({ type: 'send', threadId: 'thread-3', text: 'no folder' });

            expect(gatewayPrompts()).toEqual(['runs']);
            expect(rejections(webview)).toEqual([
                { type: 'sendRejected', threadId: 'thread-1' },
                { type: 'sendRejected', threadId: 'thread-3' },
            ]);
        });

        it('stays silent for a dispatched send', async () => {
            const webview = makeProvider();
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            lastGatewayRun()[4]({ type: 'done' });
            await flush();
            await webview.send({ type: 'slashCommand', threadId: 'thread-1', command: 'plan', text: 'x' });

            expect(rejections(webview)).toEqual([]);
            expect(gatewayPrompts()).toHaveLength(2);
        });
    });

    describe('transcript callback teardown', () => {
        it('closing unregisters the session callback kept across an acpx fallback', async () => {
            const webview = makeProvider();
            await webview.send({ type: 'newSession' });
            await openSession(webview);
            mockResolve.mockResolvedValue(acpxChoice());
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            const rebinds = jest.mocked(gateway.rebindTranscriptSink).mock.calls;
            const [sessionKey, callback] = rebinds[rebinds.length - 1];

            await webview.send({ type: 'closeThread', threadId: 'thread-1' });

            expect(gateway.removeTranscriptSink).toHaveBeenLastCalledWith(sessionKey, callback);
        });

        it('drops the old-key callback when the gateway resolves the run to another session', async () => {
            const webview = makeProvider();
            const transcript = await openSession(webview);
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            jest.mocked(gateway.removeTranscriptSink).mockClear();

            lastGatewayRun()[5]!('agent:main:resolved', 'agent:main:main');

            expect(gateway.removeTranscriptSink).toHaveBeenCalledWith('agent:main:main', transcript);
        });
    });

    describe('new and split threads', () => {
        it('opens a new thread with defaults at the end, and a split inheriting the active thread next to it', async () => {
            const webview = makeProvider();
            await webview.send({ type: 'newSession' });
            await webview.send({ type: 'focusThread', threadId: 'thread-1' });
            await webview.send({ type: 'setModel', threadId: 'thread-1', model: 'claude' });

            await webview.send({ type: 'newSession' });
            await webview.send({ type: 'focusThread', threadId: 'thread-1' });
            await webview.send({ type: 'splitThread' });

            const state = webview.posted.filter(isStateMessage).pop()!;
            expect(state.visibleThreadIds).toEqual(['thread-1', 'thread-4', 'thread-2', 'thread-3']);
            expect(threadOf(webview, 'thread-3').currentModel).toBe('codex');
            expect(threadOf(webview, 'thread-4').currentModel).toBe('claude');
        });
    });

    describe('final review', () => {
        const OPENING = { role: 'error', content: 'A session is being opened in this thread. Send the message again once it has loaded.' };

        it('shows a send that an open of another session cut off, past the history restore', async () => {
            const webview = makeProvider();
            await openSession(webview, 'agent:main:main');
            const [sendResolve, openResolve] = deferResolves(2);
            jest.mocked(gateway.getHistory).mockResolvedValue({ messages: [{ role: 'user', text: 'earlier', messageId: 'u1' }] });

            const sending = webview.send({ type: 'send', threadId: 'thread-1', text: 'go', clientId: 'c1' });
            await flush();
            void webview.send({ type: 'openSession', sessionKey: 'agent:coder:main', threadId: 'thread-1' });
            await flush();
            openResolve.resolve(gatewayChoice());
            await flush();
            sendResolve.resolve(gatewayChoice());
            await sending;
            await flush();

            expect(gatewayPrompts()).toEqual([]);
            expect(threadOf(webview, 'thread-1').messages).toEqual([{ role: 'user', content: 'earlier' }, { role: 'user', content: 'go' }, OPENING]);
            expect(webview.posted).toContainEqual({ type: 'sendRejected', threadId: 'thread-1', clientId: 'c1' });
        });

        it('echoes the webview\'s clientId when it accepts a send', async () => {
            const webview = makeProvider();
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go', clientId: 'c7' });
            expect(webview.posted).toContainEqual({ type: 'sendAccepted', threadId: 'thread-1', clientId: 'c7' });
        });

        it('does not let a send that resolves to acpx keep the session from a gateway send', async () => {
            const webview = makeProvider();
            await webview.send({ type: 'newSession' });
            const [first, second] = deferResolves(2);

            void webview.send({ type: 'send', threadId: 'thread-1', text: 'acpx one' });
            void webview.send({ type: 'send', threadId: 'thread-2', text: 'gateway two' });
            await flush();
            second.resolve(gatewayChoice());
            await flush();
            first.resolve(acpxChoice());
            await flush();

            expect(acpxPrompts()).toEqual(['acpx one']);
            expect(gatewayPrompts()).toEqual(['gateway two']);
        });

        it('retires an acpx thread\'s session callback when the gateway identity changes', async () => {
            const webview = makeProvider();
            await openSession(webview, 'agent:coder:main');
            mockResolve.mockResolvedValue(acpxChoice());
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            lastAcpxRun()[4]({ type: 'done' });
            await flush();
            mockFactoryCallbacks.onInvalidated!('identity');
            jest.mocked(gateway.rebindTranscriptSink).mockClear();

            await webview.send({ type: 'clearThread', threadId: 'thread-1' });

            expect(gateway.rebindTranscriptSink).not.toHaveBeenCalled();
        });

        it('binds a deferred resume to a thread still unbound after its acpx run', async () => {
            const workspaceState = makeMemento();
            jest.mocked(workspaceState.get).mockReturnValue('agent:coder:main');
            const [resumeResolve] = deferResolves(1);
            const webview = makeProvider(workspaceState);
            mockResolve.mockResolvedValue(acpxChoice());
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            await flush();
            resumeResolve.resolve(gatewayChoice());
            await flush();
            jest.mocked(gateway.resumeSession).mockClear();
            mockResolve.mockResolvedValue(gatewayChoice());

            lastAcpxRun()[4]({ type: 'done' });
            await flush();

            expect(jest.mocked(gateway.resumeSession).mock.calls.map(call => call[0])).toEqual(['agent:coder:main']);
        });

        it('erases a stale persisted session when the only newer choice never got written', async () => {
            const workspaceState = makeMemento();
            jest.mocked(workspaceState.get).mockReturnValue('agent:gone:main');
            const firstWrite = deferred<void>();
            jest.mocked(workspaceState.update).mockImplementationOnce(() => firstWrite.promise);
            const [resumeResolve] = deferResolves(1);
            const webview = makeProvider(workspaceState);

            void webview.send({ type: 'openSession', sessionKey: 'agent:coder:main', threadId: 'thread-1' });
            await flush();
            void webview.send({ type: 'openSession', sessionKey: 'agent:main:main', threadId: 'thread-1' });
            await flush();
            await webview.send({ type: 'clearThread', threadId: 'thread-1' });
            firstWrite.reject(new Error('disk full'));
            await flush();
            resumeResolve.resolve(gatewayChoice());
            await flush();

            expect(workspaceState.update).toHaveBeenLastCalledWith('openclaw.lastSessionKey', undefined);
        });
    });

    describe('review round 5', () => {
        const persisted = (sessionKey: string): vscode.Memento => {
            const workspaceState = makeMemento();
            jest.mocked(workspaceState.get).mockImplementation((key: string) => key === 'openclaw.lastSessionKey' ? sessionKey : undefined);
            return workspaceState;
        };

        it('sends from a fresh thread through the default alias and binds the canonical key from the ack', async () => {
            jest.mocked(gateway.listSessions).mockResolvedValue({ sessions: [{ key: 'agent:main:main', label: 'Main' }] });
            const webview = makeProvider();

            await webview.send({ type: 'send', threadId: 'thread-1', text: 'hi' });
            lastGatewayRun()[5]!('agent:main:main', 'main');
            lastGatewayRun()[4]({ type: 'done' });
            await flush();
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'hi again' });

            expect(gatewayPrompts()).toEqual(['hi', 'hi again']);
            expect(jest.mocked(gateway.setActiveSession).mock.calls.map(call => call[0])).toEqual(['main', 'agent:main:main']);
        });

        it('keeps the binding and gives the draft back when the session cannot be checked', async () => {
            const webview = makeProvider();
            await openSession(webview, 'agent:coder:main');
            jest.mocked(gateway.getGatewayIdentity).mockReturnValue('gateway-2');
            jest.mocked(gateway.listSessions).mockRejectedValue(new Error('timeout'));

            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go', clientId: 'c1' });
            await flush();
            expect(gatewayPrompts()).toEqual([]);
            expect(lastMessage(webview, 'thread-1')).toEqual({ role: 'error', content: 'Could not check this session with the gateway. Send the message again in a moment.' });
            expect(webview.posted).toContainEqual({ type: 'sendRejected', threadId: 'thread-1', clientId: 'c1' });
            expect(gateway.clearSessionSink).not.toHaveBeenCalled();

            jest.mocked(gateway.listSessions).mockResolvedValue({ sessions: SESSION_ROWS });
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            expect(gatewayPrompts()).toEqual(['go']);
            expect(gateway.setActiveSession).toHaveBeenLastCalledWith('agent:coder:main');
        });

        it('refetches the allowlist before calling a bound session unknown', async () => {
            const webview = makeProvider();
            await openSession(webview, 'agent:coder:main');
            jest.mocked(gateway.listSessions).mockResolvedValueOnce({ sessions: [{ key: 'agent:main:main', label: 'Main' }] });
            await webview.send({ type: 'requestSessions', threadId: 'thread-1' });
            jest.advanceTimersByTime(5000);

            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });

            expect(gatewayPrompts()).toEqual(['go']);
            expect(gateway.setActiveSession).toHaveBeenLastCalledWith('agent:coder:main');
            expect(gateway.clearSessionSink).not.toHaveBeenCalled();
        });

        it('drops a deferred resume when the gateway identity changes', async () => {
            const [resumeResolve] = deferResolves(1);
            const webview = makeProvider(persisted('agent:main:main'));
            mockResolve.mockResolvedValue(acpxChoice());
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'acpx' });
            resumeResolve.resolve(gatewayChoice());
            await flush();

            mockFactoryCallbacks.onInvalidated!('identity');
            mockResolve.mockResolvedValue(gatewayChoice());
            lastAcpxRun()[4]({ type: 'done' });
            await flush();

            expect(gateway.resumeSession).not.toHaveBeenCalled();
        });

        it('drops a deferred resume when the thread is cleared', async () => {
            const [resumeResolve] = deferResolves(1);
            const webview = makeProvider(persisted('agent:main:main'));
            mockResolve.mockResolvedValue(acpxChoice());
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'acpx one' });
            resumeResolve.resolve(gatewayChoice());
            await flush();

            await webview.send({ type: 'clearThread', threadId: 'thread-1' });
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'acpx two' });
            mockResolve.mockResolvedValue(gatewayChoice());
            lastAcpxRun()[4]({ type: 'done' });
            await flush();

            expect(gateway.resumeSession).not.toHaveBeenCalled();
        });

        it('resumes a session dropped by an identity change once the new gateway lists it', async () => {
            const webview = makeProvider();
            await openSession(webview, 'agent:main:main');
            jest.mocked(gateway.getGatewayIdentity).mockReturnValue('gateway-2');
            mockFactoryCallbacks.onInvalidated!('identity');
            jest.mocked(gateway.resumeSession).mockClear();

            await webview.send({ type: 'send', threadId: 'thread-1', text: 'go' });
            lastGatewayRun()[4]({ type: 'done' });
            await flush();

            expect(jest.mocked(gateway.resumeSession).mock.calls.map(call => call[0])).toEqual(['agent:main:main']);
        });

        it('does not resume a dropped session the new gateway no longer lists', async () => {
            const webview = makeProvider();
            await webview.send({ type: 'newSession' });
            await openSession(webview, 'agent:coder:main');
            jest.mocked(gateway.getGatewayIdentity).mockReturnValue('gateway-2');
            jest.mocked(gateway.listSessions).mockResolvedValue({ sessions: [{ key: 'agent:main:main', label: 'Main' }] });
            mockFactoryCallbacks.onInvalidated!('identity');
            jest.mocked(gateway.resumeSession).mockClear();

            await webview.send({ type: 'send', threadId: 'thread-2', text: 'go' });
            lastGatewayRun()[4]({ type: 'done' });
            await flush();
            await webview.send({ type: 'requestSessions', threadId: 'thread-1' });
            await flush();

            expect(gateway.resumeSession).not.toHaveBeenCalled();
        });

        it('keeps a file attached while a send prepares for the next send', async () => {
            const webview = makeProvider();
            const stat = deferred<vscode.FileStat>();
            jest.mocked(vscode.workspace.fs.stat).mockImplementationOnce(() => stat.promise);

            void webview.send({ type: 'send', threadId: 'thread-1', text: 'see @slow.ts' });
            await flush();
            await webview.send({ type: 'attachFile', threadId: 'thread-1', filePath: '/work/dropped.ts' });
            stat.resolve({ type: 1, ctime: 0, mtime: 0, size: 1 });
            await flush();

            expect(threadOf(webview, 'thread-1').pendingAttachments).toEqual([{ name: 'dropped.ts', path: '/work/dropped.ts', type: 'file' }]);
        });

        it('keeps another client\'s reply that was streaming in when the send started', async () => {
            const webview = makeProvider();
            const transcript = await openSession(webview, 'agent:main:main');
            const stat = deferred<vscode.FileStat>();
            jest.mocked(vscode.workspace.fs.stat).mockImplementationOnce(() => stat.promise);

            void webview.send({ type: 'send', threadId: 'thread-1', text: 'see @slow.ts' });
            await flush();
            transcript({ type: 'text', text: 'external reply' });
            await flush();
            stat.resolve({ type: 1, ctime: 0, mtime: 0, size: 1 });
            await flush();

            expect(threadOf(webview, 'thread-1').messages.map(m => [m.role, m.content])).toEqual([['assistant', 'external reply'], ['user', 'see @slow.ts']]);
        });

        it('settles the tool entries of an acpx run an open aborts', async () => {
            const webview = makeProvider();
            await openSession(webview, 'agent:main:main');
            mockResolve.mockResolvedValue(acpxChoice());
            await webview.send({ type: 'send', threadId: 'thread-1', text: 'acpx' });
            lastAcpxRun()[4]({ type: 'toolCall', title: 'Read', status: 'running', details: '' });
            await flush();
            jest.mocked(gateway.getHistory).mockResolvedValue(null);
            mockResolve.mockResolvedValue(gatewayChoice());

            await openSession(webview, 'agent:main:main');

            const tool = threadOf(webview, 'thread-1').messages.find(m => m.role === 'tool') as { entries: Array<{ status: string }> };
            expect(tool.entries.map(entry => entry.status)).toEqual(['cancelled']);
        });

        it('posts the state once per settings change, and not for settings it does not show', async () => {
            const webview = makeProvider();
            const listeners = jest.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls;
            const listener = listeners[listeners.length - 1][0];
            const stateCount = (): number => webview.posted.filter(isStateMessage).length;
            const changed = (key: string): vscode.ConfigurationChangeEvent => ({ affectsConfiguration: (section: string) => section === `openclaw.${key}` });
            const before = stateCount();

            await webview.send({ type: 'setDimension', dimension: '2x2' });
            listener(changed('chat.dimension'));
            await webview.send({ type: 'setModel', threadId: 'thread-1', model: 'claude' });
            listener(changed('chat.agent'));

            expect(stateCount() - before).toBe(2);
        });

        it('attaches from the file-search dropdown only a workspace file or an open editor document', async () => {
            const webview = makeProvider();
            (vscode.window as { tabGroups: unknown }).tabGroups = { all: [{ tabs: [{ input: new vscode.TabInputText(vscode.Uri.file('/elsewhere/open.ts')) }] }] };
            try {
                await webview.send({ type: 'attachFile', threadId: 'thread-1', filePath: '/etc/passwd' });
                await webview.send({ type: 'attachFile', threadId: 'thread-1', filePath: '/work/a.ts' });
                await webview.send({ type: 'attachFile', threadId: 'thread-1', filePath: '/elsewhere/open.ts' });

                expect(threadOf(webview, 'thread-1').pendingAttachments.map(a => (a as { path: string }).path)).toEqual(['/work/a.ts', '/elsewhere/open.ts']);
            } finally {
                (vscode.window as { tabGroups: unknown }).tabGroups = { all: [] };
            }
        });
    });
});
