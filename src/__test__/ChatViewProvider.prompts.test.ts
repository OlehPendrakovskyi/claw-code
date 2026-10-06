import * as vscode from 'vscode';

const mockResolve = vi.fn();

vi.mock('../webview/chatServiceFactory', () => ({
    ChatServiceFactory: vi.fn().mockImplementation(function () {
        return {
            resolve: (...args: unknown[]) => mockResolve(...args),
            dispose: vi.fn(),
        };
    }),
}));

vi.mock('../core/gatewayChatService', async () => (await vi.importActual<typeof import('./helpers/mockGatewayService')>('./helpers/mockGatewayService')).mockGatewayModule());

vi.mock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    return { ...actual, promises: { ...actual.promises, realpath: async (p: string) => p } };
});

import { ChatViewProvider } from '../webview/ChatViewProvider';
import { PromptAnswerUnconfirmedError, type GatewayChatService } from '../core/gatewayChatService';
import type { OperatorPrompt, QuestionPrompt } from '../core/gatewayProtocol/model';
import { keyOf, type PromptChange } from '../core/operatorPrompts';
import { MAX_TYPED_ANSWER_CHARS } from '../webview/operatorPromptView';
import { historySnapshot, sessionSummaries } from './helpers/mockGatewayService';

type Posted = Record<string, unknown>;
type ThreadState = { id: string; prompts: Array<Record<string, unknown>> };
type StateMessage = { type: 'state'; threads: ThreadState[] };
type FakeWebview = { posted: Posted[]; send(message: unknown): Promise<void>; webview: vscode.Webview };
type FakeView = { webview: vscode.Webview; visible: boolean; show: (preserveFocus?: boolean) => void; onDidDispose: vscode.Event<void> };
type TestGateway = GatewayChatService & { emitPrompt(change: PromptChange): void; emitSessionsChanged(sessionKey?: string | null): void };

const { GatewayChatService: MockGatewayChatService } =
    await vi.importMock<{ GatewayChatService: new () => TestGateway }>('../core/gatewayChatService');

const MAIN = 'agent:main:main';
const CODER = 'agent:coder:main';

const APPROVAL: OperatorPrompt = {
    kind: 'approval',
    id: 'a1',
    subject: 'exec',
    title: 'rm -rf build',
    details: ['Working folder: /work'],
    decisions: ['allow-once', 'deny'],
    sessionKey: MAIN,
    runId: 'r1',
    lifetimeMs: 600_000,
};

const QUESTION: QuestionPrompt = {
    kind: 'question',
    id: 'q1',
    questions: [
        { id: 'color', header: 'Color', text: 'Which?', options: [{ label: 'Red', description: null }, { label: 'Blue', description: null }], multiSelect: false, allowsOther: false, secret: false },
    ],
    sessionKey: MAIN,
    runId: null,
    lifetimeMs: 600_000,
};

const EXPIRES_AT_MS = 4_102_444_800_000;

function requestedChange(prompt: OperatorPrompt): PromptChange {
    return { type: 'requested', key: keyOf(prompt), prompt, expiresAtMs: EXPIRES_AT_MS };
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

function makeProvider(): FakeWebview {
    const workspaceState = { keys: () => [], get: vi.fn(), update: vi.fn(async () => undefined) };
    const context: Pick<vscode.ExtensionContext, 'globalState' | 'workspaceState'> = {
        globalState: { keys: () => [], get: vi.fn(), update: vi.fn(async () => undefined), setKeysForSync: vi.fn() },
        workspaceState,
    };
    const provider = new ChatViewProvider(vscode.Uri.file('/ext'), context as vscode.ExtensionContext);
    const sidebar = makeWebview();
    const view: FakeView = { webview: sidebar.webview, visible: true, show: vi.fn(), onDidDispose: vi.fn() };
    provider.resolveWebviewView(view as vscode.WebviewView, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
    return sidebar;
}

const { setImmediate: realSetImmediate } = await vi.importActual<typeof import('timers')>('timers');

async function flush(): Promise<void> {
    for (let i = 0; i < 10; i++) {
        await new Promise(resolve => realSetImmediate(resolve));
    }
}

function promptsOf(webview: FakeWebview, threadId = 'thread-1'): Array<Record<string, unknown>> {
    const states = webview.posted.filter((message): message is StateMessage => message.type === 'state');
    return states[states.length - 1].threads.find(thread => thread.id === threadId)?.prompts ?? [];
}

function summaries(prompts: Array<Record<string, unknown>>): Array<[unknown, unknown, unknown]> {
    return prompts.map(prompt => [prompt.id, prompt.state, prompt.status]);
}

describe('ChatViewProvider prompts', () => {
    let gateway: TestGateway;

    beforeEach(() => {
        vi.useFakeTimers();
        gateway = new MockGatewayChatService();
        vi.mocked(gateway.listSessions).mockResolvedValue(sessionSummaries([{ key: MAIN, label: 'Main' }, { key: CODER, label: 'Coder' }]));
        vi.mocked(gateway.getHistory).mockResolvedValue(historySnapshot([]));
        mockResolve.mockReset();
        mockResolve.mockResolvedValue({ service: gateway, transport: 'gateway' });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    async function boundTo(sessionKey: string): Promise<FakeWebview> {
        const sidebar = makeProvider();
        await sidebar.send({ type: 'openSession', sessionKey, threadId: 'thread-1' });
        await flush();
        return sidebar;
    }

    describe('rows', () => {
        it('shows a prompt only in the thread bound to its session', async () => {
            const sidebar = await boundTo(MAIN);
            gateway.emitPrompt(requestedChange(APPROVAL));
            gateway.emitPrompt(requestedChange({ ...QUESTION, sessionKey: CODER }));
            expect(summaries(promptsOf(sidebar))).toEqual([['a1', 'pending', '']]);
            expect(promptsOf(sidebar)[0]).toMatchObject({ kind: 'approval', title: 'rm -rf build', decisions: ['allow-once', 'deny'] });
        });

        it('reads an approval resolved elsewhere, and one that expired, as settled rows', async () => {
            const sidebar = await boundTo(MAIN);
            gateway.emitPrompt(requestedChange(APPROVAL));
            gateway.emitPrompt(requestedChange(QUESTION));
            gateway.emitPrompt({ type: 'resolved', key: 'exec:a1', outcome: 'deny' });
            gateway.emitPrompt({ type: 'resolved', key: 'question:q1', outcome: 'expired' });
            expect(summaries(promptsOf(sidebar))).toEqual([['a1', 'resolved', 'Denied elsewhere'], ['q1', 'resolved', 'Expired without an answer']]);
        });

        it('keeps prompts of different sources apart when they share an id', async () => {
            const sidebar = await boundTo(MAIN);
            gateway.emitPrompt(requestedChange({ ...APPROVAL, id: 'x1' }));
            gateway.emitPrompt(requestedChange({ ...QUESTION, id: 'x1' }));
            gateway.emitPrompt({ type: 'resolved', key: 'question:x1', outcome: 'expired' });
            expect(promptsOf(sidebar).map(prompt => [prompt.key, prompt.state])).toEqual([['exec:x1', 'pending'], ['question:x1', 'resolved']]);
            await sidebar.send({ type: 'resolveApproval', threadId: 'thread-1', promptKey: 'exec:x1', decision: 'deny' });
            expect(gateway.resolveApproval).toHaveBeenCalledWith('exec:x1', 'deny');
        });

        it('sends the time left rather than the host clock deadline', async () => {
            vi.useFakeTimers({ now: EXPIRES_AT_MS - 90_000 });
            const sidebar = await boundTo(MAIN);
            gateway.emitPrompt(requestedChange(APPROVAL));
            expect(promptsOf(sidebar)[0]).toMatchObject({ expiresInMs: 90_000 });
            expect(promptsOf(sidebar)[0]).not.toHaveProperty('expiresAtMs');
        });

        it('drops settled rows at the next turn and keeps the waiting ones', async () => {
            const sidebar = await boundTo(MAIN);
            gateway.emitPrompt(requestedChange(APPROVAL));
            gateway.emitPrompt(requestedChange(QUESTION));
            gateway.emitPrompt({ type: 'resolved', key: 'exec:a1', outcome: 'allow-once' });
            await sidebar.send({ type: 'send', threadId: 'thread-1', text: 'next' });
            await flush();
            expect(summaries(promptsOf(sidebar))).toEqual([['q1', 'pending', '']]);
        });
    });

    describe('answers', () => {
        it('resolves an approval with an offered decision and marks it answered here', async () => {
            const sidebar = await boundTo(MAIN);
            gateway.emitPrompt(requestedChange(APPROVAL));
            vi.mocked(gateway.resolveApproval).mockImplementation(async (key, decision) => gateway.emitPrompt({ type: 'resolved', key, outcome: decision }));
            await sidebar.send({ type: 'resolveApproval', threadId: 'thread-1', promptKey: 'exec:a1', decision: 'allow-once' });
            expect(gateway.resolveApproval).toHaveBeenCalledWith('exec:a1', 'allow-once');
            expect(summaries(promptsOf(sidebar))).toEqual([['a1', 'resolved', 'Allowed once']]);
        });

        it('ignores a decision the approval does not offer and a prompt it does not know', async () => {
            const sidebar = await boundTo(MAIN);
            gateway.emitPrompt(requestedChange(APPROVAL));
            await sidebar.send({ type: 'resolveApproval', threadId: 'thread-1', promptKey: 'exec:a1', decision: 'allow-always' });
            await sidebar.send({ type: 'resolveApproval', threadId: 'thread-1', promptKey: 'nope', decision: 'deny' });
            await sidebar.send({ type: 'resolveApproval', threadId: 'thread-1', promptKey: { id: 'a1' }, decision: 'deny' });
            expect(gateway.resolveApproval).not.toHaveBeenCalled();
        });

        it('keeps a row pending with the reason when the answer fails', async () => {
            const sidebar = await boundTo(MAIN);
            gateway.emitPrompt(requestedChange(APPROVAL));
            vi.mocked(gateway.resolveApproval).mockRejectedValue(new Error('gateway rpc error code=UNAVAILABLE'));
            await sidebar.send({ type: 'resolveApproval', threadId: 'thread-1', promptKey: 'exec:a1', decision: 'deny' });
            expect(summaries(promptsOf(sidebar))).toEqual([['a1', 'pending', 'gateway rpc error code=UNAVAILABLE']]);
        });

        it('sends question answers only when every question has an allowed answer, and declines with null', async () => {
            const sidebar = await boundTo(MAIN);
            gateway.emitPrompt(requestedChange(QUESTION));
            gateway.emitPrompt(requestedChange({ ...QUESTION, id: 'q2' }));
            await sidebar.send({ type: 'answerQuestion', threadId: 'thread-1', promptKey: 'question:q1', answers: { color: ['Green'] } });
            expect(gateway.answerQuestion).not.toHaveBeenCalled();
            expect(promptsOf(sidebar)[0]).toMatchObject({ state: 'pending', status: expect.stringContaining('Answer every question') });
            await sidebar.send({ type: 'answerQuestion', threadId: 'thread-1', promptKey: 'question:q1', answers: { color: [' Blue '] } });
            expect(gateway.answerQuestion).toHaveBeenLastCalledWith('question:q1', { color: ['Blue'] });
            await sidebar.send({ type: 'answerQuestion', threadId: 'thread-1', promptKey: 'question:q2', answers: null });
            expect(gateway.answerQuestion).toHaveBeenLastCalledWith('question:q2', null);
        });

        it('sends each picked option once', async () => {
            const sidebar = await boundTo(MAIN);
            const multi: QuestionPrompt = { ...QUESTION, questions: [{ ...QUESTION.questions[0], multiSelect: true }] };
            gateway.emitPrompt(requestedChange(multi));
            await sidebar.send({ type: 'answerQuestion', threadId: 'thread-1', promptKey: 'question:q1', answers: { color: ['Red', 'Red', 'Blue'] } });
            expect(gateway.answerQuestion).toHaveBeenLastCalledWith('question:q1', { color: ['Red', 'Blue'] });
        });

        it('refuses a typed answer too long to send, and says so', async () => {
            const sidebar = await boundTo(MAIN);
            const open: QuestionPrompt = { ...QUESTION, questions: [{ ...QUESTION.questions[0], allowsOther: true }] };
            gateway.emitPrompt(requestedChange(open));
            await sidebar.send({ type: 'answerQuestion', threadId: 'thread-1', promptKey: 'question:q1', answers: { color: ['x'.repeat(MAX_TYPED_ANSWER_CHARS + 1)] } });
            expect(gateway.answerQuestion).not.toHaveBeenCalled();
            expect(promptsOf(sidebar)[0]).toMatchObject({ state: 'pending', status: expect.stringContaining('Shorten the typed answer') });
        });

        it('sends an offered option however long, as only typed text is capped', async () => {
            const sidebar = await boundTo(MAIN);
            const label = 'x'.repeat(MAX_TYPED_ANSWER_CHARS + 1);
            const long: QuestionPrompt = { ...QUESTION, questions: [{ ...QUESTION.questions[0], options: [{ label, description: null }] }] };
            gateway.emitPrompt(requestedChange(long));
            await sidebar.send({ type: 'answerQuestion', threadId: 'thread-1', promptKey: 'question:q1', answers: { color: [label] } });
            expect(gateway.answerQuestion).toHaveBeenLastCalledWith('question:q1', { color: [label] });
        });

        it('keeps a picked option exactly as offered, trimming only typed text', async () => {
            const sidebar = await boundTo(MAIN);
            const padded: QuestionPrompt = { ...QUESTION, questions: [{ ...QUESTION.questions[0], options: [{ label: 'Yes ', description: null }] }] };
            gateway.emitPrompt(requestedChange(padded));
            await sidebar.send({ type: 'answerQuestion', threadId: 'thread-1', promptKey: 'question:q1', answers: { color: ['Yes '] } });
            expect(gateway.answerQuestion).toHaveBeenLastCalledWith('question:q1', { color: ['Yes '] });
        });

        it('accepts an answer only from a thread that shows the prompt', async () => {
            const sidebar = await boundTo(MAIN);
            gateway.emitPrompt(requestedChange({ ...APPROVAL, sessionKey: CODER }));
            await sidebar.send({ type: 'resolveApproval', threadId: 'thread-1', promptKey: 'exec:a1', decision: 'allow-once' });
            await sidebar.send({ type: 'resolveApproval', promptKey: 'exec:a1', decision: 'allow-once' });
            expect(gateway.resolveApproval).not.toHaveBeenCalled();
        });

        it('reads an answer whose reply was lost as given here once the gateway settles it', async () => {
            const sidebar = await boundTo(MAIN);
            gateway.emitPrompt(requestedChange(APPROVAL));
            vi.mocked(gateway.resolveApproval).mockRejectedValue(new PromptAnswerUnconfirmedError('gateway connection closed'));
            await sidebar.send({ type: 'resolveApproval', threadId: 'thread-1', promptKey: 'exec:a1', decision: 'allow-once' });
            gateway.emitPrompt({ type: 'resolved', key: 'exec:a1', outcome: 'allow-once' });
            expect(summaries(promptsOf(sidebar))).toEqual([['a1', 'resolved', 'Allowed once']]);
        });

        it('reads the same decision settled after an answer that was never sent as given elsewhere', async () => {
            const sidebar = await boundTo(MAIN);
            gateway.emitPrompt(requestedChange(APPROVAL));
            vi.mocked(gateway.resolveApproval).mockRejectedValue(new Error('not connected to the gateway'));
            await sidebar.send({ type: 'resolveApproval', threadId: 'thread-1', promptKey: 'exec:a1', decision: 'allow-once' });
            gateway.emitPrompt({ type: 'resolved', key: 'exec:a1', outcome: 'allow-once' });
            expect(summaries(promptsOf(sidebar))).toEqual([['a1', 'resolved', 'Allowed once elsewhere']]);
        });
    });

    describe('prompts no session claims', () => {
        it('shows one in the active gateway thread, and answers it from there', async () => {
            const sidebar = await boundTo(MAIN);
            gateway.emitPrompt(requestedChange({ ...APPROVAL, sessionKey: null }));
            expect(summaries(promptsOf(sidebar))).toEqual([['a1', 'pending', '']]);
            await sidebar.send({ type: 'resolveApproval', threadId: 'thread-1', promptKey: 'exec:a1', decision: 'deny' });
            expect(gateway.resolveApproval).toHaveBeenCalledWith('exec:a1', 'deny');
        });

        it('warns when no thread is bound to the gateway', async () => {
            const sidebar = makeProvider();
            await sidebar.send({ type: 'requestSessions', threadId: 'thread-1' });
            await flush();
            vi.mocked(vscode.window.showWarningMessage).mockClear();
            gateway.emitPrompt(requestedChange({ ...QUESTION, sessionKey: null }));
            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('no chat thread here shows'));
        });
    });

    describe('session index changes', () => {
        it('tells the webviews and refetches the session list on the next key check', async () => {
            const sidebar = await boundTo(MAIN);
            const listed = vi.mocked(gateway.listSessions).mock.calls.length;
            gateway.emitSessionsChanged('agent:new:main');
            expect(sidebar.posted.filter(message => message.type === 'sessionsChanged')).toHaveLength(1);
            await sidebar.send({ type: 'openSession', sessionKey: 'agent:new:main', threadId: 'thread-1' });
            await flush();
            expect(vi.mocked(gateway.listSessions).mock.calls.length).toBeGreaterThan(listed);
        });
    });
});
