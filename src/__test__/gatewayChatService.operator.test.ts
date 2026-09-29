/**
 * GatewayChatService approvals, agent questions and cut transcript rows,
 * against a mock socket that validates every frame the client sends with the
 * schemas exported from the real gateway; inbound frames come from validated
 * builders.
 */

import { GatewayChatService, type GatewaySend } from '../core/gatewayChatService';
import { generateDeviceIdentity } from '../core/gatewayProtocol/deviceIdentity';
import type { DeviceCredentialStore, DeviceIdentity, StoredDeviceToken } from '../core/gatewayProtocol/deviceIdentity';
import type { OperatorPrompt } from '../core/gatewayProtocol/model';
import type { PromptChange } from '../core/operatorPrompts';
import type { ChatEvent } from '../chat/ChatService';
import {
    CANONICAL_MAIN,
    createMockSocket,
    eventFrame,
    payloads,
    protocolViolations,
    type MockSocket,
} from './helpers/gatewayV4';

jest.mock('ws', () => jest.fn());

const APPROVAL_SCOPES = ['operator.read', 'operator.write', 'operator.approvals', 'operator.questions'];
const CUT = '\n...(truncated)...';
const LONG_REPLY = `${'word '.repeat(2400)}END`;

type Harness = { svc: GatewayChatService; sockets: MockSocket[]; socket: () => MockSocket; changes: PromptChange[] };

/** Approvals a run raises name the device that started it as reviewer, so the client proves one. */
class MemoryDeviceStore implements DeviceCredentialStore {
    private readonly identity: DeviceIdentity = generateDeviceIdentity();
    private readonly tokens = new Map<string, StoredDeviceToken>();

    async loadIdentity(): Promise<DeviceIdentity> {
        return this.identity;
    }

    async loadToken(gateway: string, deviceId: string): Promise<StoredDeviceToken | null> {
        const token = this.tokens.get(gateway);
        return token?.deviceId === deviceId ? token : null;
    }

    async storeToken(gateway: string, token: StoredDeviceToken): Promise<void> {
        this.tokens.set(gateway, token);
    }

    async clearToken(gateway: string): Promise<void> {
        this.tokens.delete(gateway);
    }
}

type ConnectOptions = { scopes?: string[]; device?: boolean; lists?: BackfillLists };

type BackfillLists = { exec?: unknown[]; plugin?: unknown[]; questions?: unknown[] };

async function settle(): Promise<void> {
    for (let i = 0; i < 25; i++) await Promise.resolve();
}

function texts(events: ChatEvent[]): string {
    return events.flatMap((event) => (event.type === 'text' ? [event.text] : [])).join('');
}

function requested(changes: PromptChange[]): OperatorPrompt[] {
    return changes.flatMap((change) => (change.type === 'requested' ? [change.prompt] : []));
}

function outcomes(changes: PromptChange[]): Array<[string, string]> {
    return changes.flatMap((change): Array<[string, string]> => (change.type === 'resolved' ? [[change.id, change.outcome]] : []));
}

function methods(socket: MockSocket): string[] {
    return socket.requests().map((request) => request.method);
}

describe('GatewayChatService operator prompts and cut rows', () => {
    const services: GatewayChatService[] = [];

    afterEach(() => {
        for (const svc of services.splice(0)) svc.dispose();
        jest.useRealTimers();
        expect(protocolViolations.splice(0)).toEqual([]);
    });

    function harness(device: boolean): Harness {
        const sockets: MockSocket[] = [];
        const svc = new GatewayChatService({
            deviceCredentials: device ? new MemoryDeviceStore() : undefined,
            url: 'ws://gateway.test:18789',
            token: 'secret-token-value',
            wsFactory: () => {
                sockets.push(createMockSocket());
                return sockets[sockets.length - 1];
            },
            reconnectBaseDelayMs: 100,
            reconnectMaxDelayMs: 1000,
        });
        services.push(svc);
        const changes: PromptChange[] = [];
        svc.onApprovalRequest((change) => changes.push(change));
        return { svc, sockets, socket: () => sockets[sockets.length - 1], changes };
    }

    /** The challenge arrives, the device loads, then the gateway accepts. */
    async function handshake(h: Harness, scopes = APPROVAL_SCOPES): Promise<void> {
        h.socket().receive(eventFrame('connect.challenge', payloads.challenge()));
        await settle();
        h.socket().reply('connect', payloads.helloOk({ scopes }));
        await settle();
    }

    /** Connected with a device and the approval and question scopes; the backfill lists answer with `lists`. */
    async function connected({ scopes = APPROVAL_SCOPES, device = true, lists = {} }: ConnectOptions = {}): Promise<Harness> {
        const h = harness(device);
        const connecting = h.svc.connect();
        await handshake(h, scopes);
        await connecting;
        answerBackfill(h, lists);
        await settle();
        return h;
    }

    function answerBackfill(h: Harness, lists: BackfillLists): void {
        const pending = methods(h.socket());
        if (pending.includes('exec.approval.list')) h.socket().reply('exec.approval.list', lists.exec ?? []);
        if (pending.includes('plugin.approval.list')) h.socket().reply('plugin.approval.list', lists.plugin ?? []);
        if (pending.includes('question.list')) h.socket().reply('question.list', { questions: lists.questions ?? [] });
    }

    function receive(h: Harness, event: string, payload: unknown): void {
        h.socket().receive(eventFrame(event, payload));
    }

    function observe(h: Harness): ChatEvent[] {
        const seen: ChatEvent[] = [];
        h.svc.resumeSession('main', (event) => seen.push(event), { historyRendered: true });
        h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
        return seen;
    }

    function send(h: Harness): { events: ChatEvent[]; send: GatewaySend } {
        const events: ChatEvent[] = [];
        const request: GatewaySend = { sessionKey: 'main', prompt: 'hello', onEvent: (event) => events.push(event) };
        h.svc.sendMessage(request);
        return { events, send: request };
    }

    async function accepted(h: Harness): Promise<string> {
        h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
        await settle();
        const runId = String(h.socket().lastRequest('chat.send').params.idempotencyKey);
        h.socket().reply('chat.send', payloads.sendAck(runId));
        await settle();
        return runId;
    }

    describe('approvals', () => {
        it('announces an exec approval with what helps decide, and resolves it with the chosen decision', async () => {
            const h = await connected();
            receive(h, 'exec.approval.requested', payloads.execApproval({ id: 'a1', runId: 'r1' }, 'rm -rf build', { warningText: 'Deletes files' }));
            expect(requested(h.changes)).toEqual([{
                kind: 'approval',
                id: 'a1',
                subject: 'exec',
                title: 'rm -rf build',
                details: ['Working folder: /work', 'Deletes files'],
                decisions: ['allow-once', 'allow-always', 'deny'],
                sessionKey: CANONICAL_MAIN,
                runId: 'r1',
                expiresAtMs: expect.any(Number),
            }]);
            const resolving = h.svc.resolveApproval('a1', 'allow-once');
            expect(h.socket().lastRequest('exec.approval.resolve').params).toEqual({ id: 'a1', decision: 'allow-once' });
            h.socket().reply('exec.approval.resolve', { ok: true });
            await resolving;
            expect(outcomes(h.changes)).toEqual([['a1', 'allow-once']]);
        });

        it('resolves a plugin approval through its own method and offers only the decisions it allows, deny always', async () => {
            const h = await connected();
            receive(h, 'plugin.approval.requested', payloads.pluginApproval({ id: 'plugin:1' }, 'Write a file', { allowedDecisions: ['allow-once'] }));
            const [prompt] = requested(h.changes);
            expect(prompt).toMatchObject({ subject: 'plugin', title: 'Write a file', decisions: ['allow-once', 'deny'], details: ['Writes outside the workspace', 'Tool: write', 'Plugin: guard'] });
            await expect(h.svc.resolveApproval('plugin:1', 'allow-always')).rejects.toThrow(/no longer pending/);
            expect(methods(h.socket())).not.toContain('plugin.approval.resolve');
            const resolving = h.svc.resolveApproval('plugin:1', 'deny');
            h.socket().reply('plugin.approval.resolve', { ok: true });
            await resolving;
            expect(outcomes(h.changes)).toEqual([['plugin:1', 'deny']]);
        });

        it('settles an approval resolved elsewhere, and withdraws one a late resolve finds gone', async () => {
            const h = await connected();
            receive(h, 'exec.approval.requested', payloads.execApproval({ id: 'a1' }, 'ls'));
            receive(h, 'exec.approval.requested', payloads.execApproval({ id: 'a2' }, 'pwd'));
            receive(h, 'exec.approval.resolved', payloads.approvalResolved('a1', 'deny'));
            const resolving = h.svc.resolveApproval('a2', 'allow-once');
            h.socket().replyError('exec.approval.resolve', { code: 'INVALID_REQUEST', message: 'unknown or expired approval id', details: { reason: 'APPROVAL_NOT_FOUND' } });
            await resolving;
            expect(outcomes(h.changes)).toEqual([['a1', 'deny'], ['a2', 'withdrawn']]);
        });

        it('keeps an approval pending when its resolve fails for another reason', async () => {
            const h = await connected();
            receive(h, 'exec.approval.requested', payloads.execApproval({ id: 'a1' }, 'ls'));
            const resolving = h.svc.resolveApproval('a1', 'allow-once');
            h.socket().replyError('exec.approval.resolve', { code: 'UNAVAILABLE', message: 'approval resolve unavailable' });
            await expect(resolving).rejects.toThrow(/UNAVAILABLE/);
            expect(outcomes(h.changes)).toEqual([]);
        });

        it('expires an approval at the deadline the gateway set, which broadcasts nothing', async () => {
            jest.useFakeTimers();
            const h = await connected();
            receive(h, 'exec.approval.requested', payloads.execApproval({ id: 'a1', expiresAtMs: Date.now() + 5000 }, 'ls'));
            jest.advanceTimersByTime(4999);
            expect(outcomes(h.changes)).toEqual([]);
            jest.advanceTimersByTime(1);
            expect(outcomes(h.changes)).toEqual([['a1', 'expired']]);
        });

        it('names the session following the run when a request carries no session key', async () => {
            const h = await connected();
            send(h);
            const runId = await accepted(h);
            receive(h, 'plugin.approval.requested', payloads.pluginApproval({ id: 'plugin:2', sessionKey: null, runId }, 'Write'));
            expect(requested(h.changes)[0]).toMatchObject({ sessionKey: CANONICAL_MAIN, runId });
        });

        it('replays pending approvals to a late listener', async () => {
            const h = await connected();
            receive(h, 'exec.approval.requested', payloads.execApproval({ id: 'a1' }, 'ls'));
            const late: PromptChange[] = [];
            h.svc.onApprovalRequest((change) => late.push(change));
            expect(requested(late).map((prompt) => prompt.id)).toEqual(['a1']);
        });

        it('withdraws every prompt when the endpoint changes', async () => {
            const h = await connected();
            receive(h, 'exec.approval.requested', payloads.execApproval({ id: 'a1' }, 'ls'));
            h.svc.updateConnection('ws://other.test:18789', 'other-token');
            expect(outcomes(h.changes)).toEqual([['a1', 'withdrawn']]);
        });
    });

    describe('backfill', () => {
        it('lists what predates the connection, then drops what a reconnect no longer lists but keeps what raced it', async () => {
            jest.useFakeTimers();
            const h = await connected({ lists: { exec: [{ approvalKind: 'exec', ...payloads.execApproval({ id: 'old' }, 'make') }] } });
            expect(requested(h.changes).map((prompt) => prompt.id)).toEqual(['old']);
            h.socket().emit('close', 1006, Buffer.alloc(0));
            jest.advanceTimersByTime(1000);
            await handshake(h);
            receive(h, 'exec.approval.requested', payloads.execApproval({ id: 'raced' }, 'make test'));
            answerBackfill(h, {});
            await settle();
            expect(outcomes(h.changes)).toEqual([['old', 'withdrawn']]);
            expect(requested(h.changes).map((prompt) => prompt.id)).toEqual(['old', 'raced']);
        });

        it('keeps prompts of a kind whose list failed', async () => {
            jest.useFakeTimers();
            const h = await connected({ lists: { questions: [payloads.question({ id: 'q1' }, [{ questionId: 'pick', question: 'Which?' }])] } });
            h.socket().emit('close', 1006, Buffer.alloc(0));
            jest.advanceTimersByTime(1000);
            await handshake(h);
            h.socket().reply('exec.approval.list', []);
            h.socket().reply('plugin.approval.list', []);
            h.socket().replyError('question.list', { code: 'UNAVAILABLE', message: 'busy' });
            await settle();
            expect(outcomes(h.changes)).toEqual([]);
        });

        it('lists nothing without the scopes, and says where a waiting approval is when a tool reports one', async () => {
            const h = await connected({ scopes: ['operator.read', 'operator.write'] });
            expect(methods(h.socket()).filter((method) => method.includes('approval') || method.startsWith('question'))).toEqual([]);
            expect(h.svc.getPromptAccess()).toEqual({ approvals: false, questions: false });
            const run = send(h);
            const runId = await accepted(h);
            const pending = { status: 'approval-pending', approvalId: 'a1', expiresAtMs: 1 };
            receive(h, 'agent', payloads.tool({ runId, seq: 2 }, { phase: 'result', name: 'exec', toolCallId: 't1', isError: false, result: { details: pending } }));
            expect(run.events).toContainEqual({ type: 'notice', text: expect.stringContaining('waiting for approval in OpenClaw') });
        });

        it('sees no approvals without a device identity, and says why a command that needed one did not run', async () => {
            const h = await connected({ device: false });
            expect(h.svc.getPromptAccess()).toEqual({ approvals: false, questions: true });
            expect(methods(h.socket()).filter((method) => method.includes('approval'))).toEqual([]);
            const run = send(h);
            const runId = await accepted(h);
            const denied = { status: 'error', tool: 'exec', error: 'exec denied: Headless runs cannot wait for interactive exec approval.' };
            receive(h, 'agent', payloads.tool({ runId, seq: 2 }, { phase: 'result', name: 'exec', toolCallId: 't1', isError: true, result: { details: denied } }));
            expect(run.events).toContainEqual({ type: 'notice', text: expect.stringContaining('no approval client could see the request') });
        });

        it('shows no notice for a waiting approval this connection can answer', async () => {
            const h = await connected();
            const run = send(h);
            const runId = await accepted(h);
            receive(h, 'agent', payloads.tool({ runId, seq: 2 }, { phase: 'result', name: 'exec', toolCallId: 't1', isError: false, result: { details: { status: 'approval-pending' } } }));
            expect(run.events.filter((event) => event.type === 'notice')).toEqual([]);
        });
    });

    describe('questions', () => {
        const questions = [
            { questionId: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue', description: 'calm' }], isOther: true },
            { questionId: 'token', question: 'API token?', isSecret: true },
        ];

        it('announces a question with its options, and answers every question at once', async () => {
            const h = await connected();
            receive(h, 'question.requested', payloads.question({ id: 'q1', runId: 'r1' }, questions));
            expect(requested(h.changes)[0]).toEqual({
                kind: 'question',
                id: 'q1',
                sessionKey: CANONICAL_MAIN,
                runId: 'r1',
                expiresAtMs: expect.any(Number),
                questions: [
                    { id: 'color', header: 'Color', text: 'Which color?', options: [{ label: 'Red', description: null }, { label: 'Blue', description: 'calm' }], multiSelect: false, allowsOther: true, secret: false },
                    { id: 'token', header: '', text: 'API token?', options: [], multiSelect: false, allowsOther: true, secret: true },
                ],
            });
            const answering = h.svc.answerQuestion('q1', { color: ['Teal'], token: ['s3cret'] });
            expect(h.socket().lastRequest('question.resolve').params).toEqual({ id: 'q1', answers: { answers: { color: ['Teal'], token: ['s3cret'] } } });
            h.socket().reply('question.resolve', { status: 'answered', answers: { answers: { color: ['Teal'], token: ['s3cret'] } } });
            await answering;
            expect(outcomes(h.changes)).toEqual([['q1', 'answered']]);
        });

        it('declines a question by cancelling it, and follows one that expires or is answered elsewhere', async () => {
            const h = await connected();
            receive(h, 'question.requested', payloads.question({ id: 'q1' }, questions));
            receive(h, 'question.requested', payloads.question({ id: 'q2' }, questions));
            receive(h, 'question.requested', payloads.question({ id: 'q3' }, questions));
            const declining = h.svc.answerQuestion('q1', null);
            expect(h.socket().lastRequest('question.resolve').params).toEqual({ id: 'q1', cancel: true });
            h.socket().reply('question.resolve', { status: 'cancelled' });
            await declining;
            receive(h, 'question.resolved', payloads.questionResolved('q2', 'expired'));
            receive(h, 'question.resolved', payloads.questionResolved('q3', 'answered'));
            expect(outcomes(h.changes)).toEqual([['q1', 'cancelled'], ['q2', 'expired'], ['q3', 'answered']]);
        });

        it('ignores a question record that is not pending or has a malformed question', async () => {
            const h = await connected();
            receive(h, 'question.requested', { ...payloads.question({ id: 'q1' }, questions), status: 'answered' });
            h.socket().receive(JSON.stringify({ type: 'event', event: 'question.requested', payload: { ...payloads.question({ id: 'q2' }, questions), questions: [{ header: 'x' }] } }));
            expect(requested(h.changes)).toEqual([]);
        });
    });

    describe('cut transcript rows', () => {
        function cutRow(id: string, runId: string, seq: number, text = LONG_REPLY): Record<string, unknown> {
            return payloads.sessionMessage({ role: 'assistant', text: `${text.slice(0, 8000)}${CUT}`, id, seq, runId });
        }

        function fullRead(text = LONG_REPLY, id = 'e1', runId = 'r1', seq = 3): Record<string, unknown> {
            return payloads.historyTail([{ role: 'assistant', text, id, seq, runId }]);
        }

        it('reads a cut live row on its own, uncut, before rendering it', async () => {
            const h = await connected();
            const seen = observe(h);
            await settle();
            receive(h, 'session.message', cutRow('e1', 'r1', 3));
            await settle();
            expect(h.socket().lastRequest('chat.history').params).toEqual({ sessionKey: CANONICAL_MAIN, messageId: 'e1', limit: 1, maxChars: 500_000 });
            expect(seen).toEqual([]);
            h.socket().reply('chat.history', fullRead());
            await settle();
            expect(texts(seen)).toBe(LONG_REPLY);
        });

        it('keeps later rows behind a cut one and reads one entry of a session at a time', async () => {
            const h = await connected();
            const seen = observe(h);
            await settle();
            receive(h, 'session.message', cutRow('e1', 'r1', 3, `A${LONG_REPLY}`));
            receive(h, 'session.message', cutRow('e2', 'r2', 5, `B${LONG_REPLY}`));
            receive(h, 'session.message', payloads.sessionMessage({ role: 'assistant', text: 'C short', id: 'e3', seq: 7, runId: 'r3' }));
            await settle();
            expect(seen).toEqual([]);
            expect(h.socket().requests().filter((request) => request.method === 'chat.history')).toHaveLength(1);
            h.socket().reply('chat.history', fullRead(`A${LONG_REPLY}`));
            await settle();
            expect(h.socket().lastRequest('chat.history').params).toMatchObject({ messageId: 'e2' });
            h.socket().reply('chat.history', fullRead(`B${LONG_REPLY}`, 'e2', 'r2', 5));
            await settle();
            expect(texts(seen)).toBe(`A${LONG_REPLY}B${LONG_REPLY}C short`);
        });

        it('renders a cut row as it came when the full read fails', async () => {
            const h = await connected();
            const seen = observe(h);
            await settle();
            receive(h, 'session.message', cutRow('e1', 'r1', 3));
            await settle();
            h.socket().replyError('chat.history', { code: 'UNAVAILABLE', message: 'busy' });
            await settle();
            expect(texts(seen)).toBe(LONG_REPLY.slice(0, 8000));
        });

        it('completes a cut row that catch-up replays', async () => {
            const h = await connected();
            h.svc.restoreSessionState('main', { cursor: 'c2', lastSeq: 2 });
            const seen = observe(h);
            await settle();
            h.socket().reply('chat.history', payloads.historyDelta([{ role: 'assistant', text: `${LONG_REPLY.slice(0, 8000)}${CUT}`, id: 'e1', seq: 3, runId: 'r1' }], 'c3'));
            await settle();
            expect(h.socket().lastRequest('chat.history').params).toMatchObject({ messageId: 'e1' });
            h.socket().reply('chat.history', fullRead());
            await settle();
            expect(seen).toEqual([{ type: 'text', text: LONG_REPLY }, { type: 'done' }]);
        });

        it('finishes a run that ended while the socket was away with its whole final text', async () => {
            jest.useFakeTimers();
            const h = await connected();
            const run = send(h);
            const runId = await accepted(h);
            receive(h, 'chat', payloads.delta({ runId, seq: 1 }, 'word ', 'word '));
            h.socket().emit('close', 1006, Buffer.alloc(0));
            jest.advanceTimersByTime(1000);
            await handshake(h);
            answerBackfill(h, {});
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            h.socket().reply('chat.history', payloads.historyTail([{ role: 'assistant', text: `${LONG_REPLY.slice(0, 8000)}${CUT}`, id: 'e9', seq: 6, runId }], { activeRunIds: [] }));
            await settle();
            h.socket().reply('chat.history', fullRead(LONG_REPLY, 'e9', runId, 6));
            await settle();
            expect(texts(run.events)).toBe(LONG_REPLY);
            expect(run.events.filter((event) => event.type === 'done')).toHaveLength(1);
        });
    });
});
