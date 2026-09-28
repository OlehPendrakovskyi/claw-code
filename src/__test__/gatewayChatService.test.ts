/**
 * GatewayChatService against a mock socket that speaks OpenClaw Gateway
 * protocol v4: every frame the client sends is validated against the schemas
 * exported from the real gateway, and inbound frames come from captures of a
 * real gateway or validated builders.
 */

import { GatewayChatService, type GatewaySend } from '../core/gatewayChatService';
import { GatewayConnectError } from '../core/gatewayProtocol/model';
import type { ProtocolSetting } from '../core/gatewayProtocol/registry';
import type { ChatEvent } from '../chat/ChatService';
import {
    CANONICAL_MAIN,
    captured,
    completeHandshake,
    createMockSocket,
    errorFrame,
    eventFrame,
    payloads,
    protocolViolations,
    type MockSocket,
} from './helpers/gatewayV4';

jest.mock('ws', () => jest.fn());

const TOKEN = 'secret-token-value';

type Harness = {
    svc: GatewayChatService;
    sockets: MockSocket[];
    socket: () => MockSocket;
    logs: string[];
};

type Send = { events: ChatEvent[]; resolved: Array<[string, string]>; send: GatewaySend };

async function settle(): Promise<void> {
    for (let i = 0; i < 25; i++) await Promise.resolve();
}

/** A captured real frame re-addressed to another run. */
function capturedEvent(name: string, runId: string): string {
    const frame = captured[name];
    return eventFrame(frame.event ?? '', { ...(frame.payload as object), runId });
}

function texts(events: ChatEvent[]): string {
    return events.flatMap((event) => (event.type === 'text' ? [event.text] : [])).join('');
}

function count(events: ChatEvent[], type: ChatEvent['type']): number {
    return events.filter((event) => event.type === type).length;
}

describe('GatewayChatService', () => {
    const services: GatewayChatService[] = [];

    afterEach(() => {
        for (const svc of services.splice(0)) svc.dispose();
        jest.useRealTimers();
        const violations = protocolViolations.splice(0);
        expect(violations).toEqual([]);
    });

    function harness(opts: { token?: string; protocol?: ProtocolSetting; throwOnOpen?: unknown } = {}): Harness {
        const sockets: MockSocket[] = [];
        const logs: string[] = [];
        const svc = new GatewayChatService({
            url: 'ws://gateway.test:18789',
            token: opts.token ?? TOKEN,
            protocol: opts.protocol,
            logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
            wsFactory: () => {
                if (opts.throwOnOpen !== undefined) throw opts.throwOnOpen;
                sockets.push(createMockSocket());
                return sockets[sockets.length - 1];
            },
            reconnectBaseDelayMs: 100,
            reconnectMaxDelayMs: 1000,
        });
        services.push(svc);
        return { svc, sockets, socket: () => sockets[sockets.length - 1], logs };
    }

    async function connected(opts: Parameters<typeof harness>[0] & { hello?: Record<string, unknown> } = {}): Promise<Harness> {
        const h = harness(opts);
        const connecting = h.svc.connect();
        completeHandshake(h.socket(), opts.hello);
        await connecting;
        return h;
    }

    function send(h: Harness, sessionKey = 'main'): Send {
        const events: ChatEvent[] = [];
        const resolved: Array<[string, string]> = [];
        const request: GatewaySend = {
            sessionKey,
            prompt: 'hello',
            onEvent: (event) => events.push(event),
            onSessionResolved: (resolvedKey, requestedKey) => resolved.push([resolvedKey, requestedKey]),
        };
        h.svc.sendMessage(request);
        return { events, resolved, send: request };
    }

    /** Subscribe and acknowledge a send; returns the run id the client chose. */
    async function accepted(h: Harness, canonicalKey = CANONICAL_MAIN): Promise<string> {
        h.socket().reply('sessions.messages.subscribe', payloads.subscribed(canonicalKey));
        await settle();
        const runId = String(h.socket().lastRequest('chat.send').params.idempotencyKey);
        h.socket().reply('chat.send', payloads.sendAck(runId));
        await settle();
        return runId;
    }

    function receive(h: Harness, event: string, payload: unknown, seq?: number): void {
        h.socket().receive(eventFrame(event, payload, seq));
    }

    function methods(socket: MockSocket): string[] {
        return socket.requests().map((request) => request.method);
    }

    describe('handshake', () => {
        it('sends connect on the challenge and reports the negotiated version and limits', async () => {
            const h = harness();
            const connecting = h.svc.connect();
            expect(h.socket().sent).toEqual([]);
            completeHandshake(h.socket());
            await connecting;
            expect(h.socket().lastRequest('connect').params).toMatchObject({ minProtocol: 4, maxProtocol: 4, auth: { token: TOKEN } });
            expect(h.svc.isRunning).toBe(true);
            expect(h.svc.getProtocolVersion()).toBe(4);
            expect(h.svc.getTransportLimits()).toMatchObject({ attachmentMaxBytes: 19464192, tickIntervalMs: 30000 });
            expect(h.logs).toContain('gateway connected protocol=v4 server=2026.9.6 role=operator');
        });

        it('offers exactly the configured protocol version', async () => {
            const h = await connected({ protocol: '4' });
            expect(h.socket().lastRequest('connect').params).toMatchObject({ minProtocol: 4, maxProtocol: 4 });
        });

        it('refuses a hello naming a version it did not offer, for good', async () => {
            jest.useFakeTimers();
            const h = harness();
            const connecting = h.svc.connect();
            completeHandshake(h.socket(), payloads.helloOk({ protocol: 5 }));
            const error = await connecting.catch((err: unknown) => err);
            expect(error).toBeInstanceOf(GatewayConnectError);
            expect((error as GatewayConnectError).rejection).toMatchObject({ kind: 'permanent', code: 'PROTOCOL_MISMATCH' });
            jest.advanceTimersByTime(60_000);
            expect(h.sockets).toHaveLength(1);
        });

        it('stops after the real token-mismatch rejection until the connection settings change', async () => {
            jest.useFakeTimers();
            const h = harness();
            const connecting = h.svc.connect();
            h.socket().receive(eventFrame('connect.challenge', payloads.challenge()));
            h.socket().replyError('connect', captured.tokenMismatchRejection.error);
            await expect(connecting).rejects.toThrow('gateway handshake rejected code=AUTH_TOKEN_MISMATCH');
            jest.advanceTimersByTime(60_000);
            expect(h.sockets).toHaveLength(1);
            h.svc.updateConnection('ws://gateway.test:18789', 'rotated');
            jest.advanceTimersByTime(60_000);
            expect(h.sockets).toHaveLength(2);
        });

        it('backs off after a transient rejection, no sooner than the gateway asked', async () => {
            jest.useFakeTimers();
            const h = harness();
            const connecting = h.svc.connect();
            h.socket().receive(eventFrame('connect.challenge', payloads.challenge()));
            h.socket().replyError('connect', { code: 'UNAVAILABLE', message: 'starting', retryAfterMs: 5000, details: { reason: 'startup-sidecars' } });
            await expect(connecting).rejects.toThrow('handshake rejected');
            jest.advanceTimersByTime(4900);
            expect(h.sockets).toHaveLength(1);
            jest.advanceTimersByTime(200);
            expect(h.sockets).toHaveLength(2);
        });

        it('pauses while a device pairing is pending', async () => {
            jest.useFakeTimers();
            const h = harness();
            const connecting = h.svc.connect();
            h.socket().receive(eventFrame('connect.challenge', payloads.challenge()));
            h.socket().replyError('connect', { code: 'NOT_PAIRED', message: 'pairing required', details: { code: 'PAIRING_REQUIRED' } });
            const error = (await connecting.catch((err: unknown) => err)) as GatewayConnectError;
            expect(error.rejection.hint).toMatch(/not implemented/);
            jest.advanceTimersByTime(60_000);
            expect(h.sockets).toHaveLength(1);
        });

        it('never sends a connect frame beyond the pre-auth limit', async () => {
            const h = harness({ token: 'x'.repeat(70 * 1024) });
            const connecting = h.svc.connect();
            h.socket().receive(eventFrame('connect.challenge', payloads.challenge()));
            await expect(connecting).rejects.toThrow('CONNECT_FRAME_TOO_LARGE');
            expect(h.socket().sent).toEqual([]);
        });

        it('gives up when no challenge arrives', async () => {
            jest.useFakeTimers();
            const h = harness();
            const connecting = h.svc.connect();
            jest.advanceTimersByTime(15_000);
            await expect(connecting).rejects.toThrow('handshake timed out');
        });

        it('keeps the token out of errors and logs', async () => {
            const h = harness({ throwOnOpen: new Error(`Invalid URL: ws://user:${TOKEN}@host/?token=${TOKEN}`) });
            const error = (await h.svc.connect().catch((err: unknown) => err)) as Error;
            expect(error.message).not.toContain(TOKEN);
            const live = await connected();
            live.socket().emit('error', new Error(`boom ${TOKEN}`));
            expect([...h.logs, ...live.logs].join('\n')).not.toContain(TOKEN);
        });

        it('reconnects with a new hello when the protocol setting changes', async () => {
            jest.useFakeTimers();
            const h = await connected();
            h.svc.updateConnection('ws://gateway.test:18789', TOKEN, '4');
            expect(h.svc.isRunning).toBe(false);
            jest.advanceTimersByTime(1000);
            completeHandshake(h.socket());
            await settle();
            expect(h.sockets).toHaveLength(2);
            expect(h.svc.isRunning).toBe(true);
        });
    });

    describe('keepalive', () => {
        it('reconnects once ticks stop for two tick intervals', async () => {
            jest.useFakeTimers();
            const h = await connected({ hello: payloads.helloOk({ tickIntervalMs: 1000 }) });
            jest.advanceTimersByTime(1500);
            h.socket().receive(JSON.stringify(captured.tick));
            jest.advanceTimersByTime(1500);
            expect(h.socket().closed).toEqual([]);
            jest.advanceTimersByTime(1500);
            expect(h.sockets[0].closed).toEqual([4000]);
            expect(h.svc.isRunning).toBe(false);
            jest.advanceTimersByTime(1000);
            expect(h.sockets).toHaveLength(2);
        });

        it('waits for the restart a shutdown event announced', async () => {
            jest.useFakeTimers();
            const h = await connected();
            receive(h, 'shutdown', { reason: 'gateway restarting', restartExpectedMs: 5000 });
            h.socket().emit('close', 1012, Buffer.alloc(0));
            jest.advanceTimersByTime(4900);
            expect(h.sockets).toHaveLength(1);
            jest.advanceTimersByTime(200);
            expect(h.sockets).toHaveLength(2);
        });
    });

    describe('sending', () => {
        it('resolves the session, sends to its canonical key and streams the run to one done', async () => {
            const h = await connected();
            const run = send(h);
            expect(h.socket().lastRequest('sessions.messages.subscribe').params).toEqual({ key: CANONICAL_MAIN });
            expect(methods(h.socket())).not.toContain('chat.send');
            const runId = await accepted(h);
            expect(run.resolved).toEqual([[CANONICAL_MAIN, 'main']]);
            expect(h.socket().lastRequest('chat.send').params).toEqual({ sessionKey: CANONICAL_MAIN, message: 'hello', idempotencyKey: runId });
            h.socket().receive(capturedEvent('chatStatus', runId));
            for (const name of ['chatDelta1', 'chatDelta2', 'chatDelta3']) h.socket().receive(capturedEvent(name, runId));
            h.socket().receive(capturedEvent('sessionMessageAssistant', runId));
            h.socket().receive(capturedEvent('chatFinal', runId));
            expect(texts(run.events)).toBe('Echo:  Active Subagents\\nnone"');
            expect(run.events.filter((event) => event.type !== 'text')).toEqual([
                { type: 'usage', usage: { promptTokens: 11, completionTokens: 5, totalTokens: 16 } },
                { type: 'done' },
            ]);
            expect(h.svc.hasOwnedRun('main')).toBe(false);
        });

        it('delivers run events that race the acknowledgement', async () => {
            const h = await connected();
            const run = send(h);
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            const runId = String(h.socket().lastRequest('chat.send').params.idempotencyKey);
            receive(h, 'chat', payloads.delta({ runId, seq: 1 }, 'early', 'early'));
            h.socket().reply('chat.send', payloads.sendAck(runId));
            receive(h, 'chat', payloads.final({ runId, seq: 2 }, 'early bird'));
            expect(texts(run.events)).toBe('early bird');
            expect(count(run.events, 'done')).toBe(1);
        });

        it('holds events of an unknown run until the ack, then gives them to the observers only', async () => {
            const h = await connected();
            const seen: ChatEvent[] = [];
            h.svc.resumeSession(CANONICAL_MAIN, (event) => seen.push(event), { historyRendered: true });
            const run = send(h, CANONICAL_MAIN);
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            receive(h, 'chat', payloads.delta({ runId: 'queued-elsewhere', seq: 1 }, 'other', 'other'));
            expect(seen).toEqual([]);
            const runId = String(h.socket().lastRequest('chat.send').params.idempotencyKey);
            h.socket().reply('chat.send', payloads.sendAck(runId));
            await settle();
            expect(seen).toEqual([{ type: 'text', text: 'other' }]);
            expect(run.events).toEqual([]);
        });

        it('ends a run on its first terminal, ignoring the duplicate the gateway sends', async () => {
            const h = await connected();
            const run = send(h);
            const runId = await accepted(h);
            h.socket().receive(capturedEvent('chatErrorFirst', runId));
            h.socket().receive(capturedEvent('chatErrorSecond', runId));
            expect(run.events).toEqual([{ type: 'error', message: 'No route-compatible authentication source is configured for openai.' }, { type: 'done' }]);
        });

        it('drops stale deltas and holds a diverging replacement for the final text', async () => {
            const h = await connected();
            const run = send(h);
            const runId = await accepted(h);
            receive(h, 'chat', payloads.delta({ runId, seq: 2 }, 'Hello', 'Hello'));
            receive(h, 'chat', payloads.delta({ runId, seq: 1 }, 'He', 'He'));
            receive(h, 'chat', payloads.delta({ runId, seq: 3 }, 'Goodbye', 'Goodbye', true));
            expect(texts(run.events)).toBe('Hello');
            receive(h, 'chat', payloads.final({ runId, seq: 4 }, 'Goodbye all'));
            expect(texts(run.events)).toBe('Hello\n\nGoodbye all');
        });

        it('never delivers another session\'s run', async () => {
            const h = await connected();
            const run = send(h);
            const runId = await accepted(h);
            receive(h, 'chat', payloads.delta({ runId: 'other-run', sessionKey: 'agent:coder:main', seq: 1 }, 'leak', 'leak'));
            receive(h, 'chat', payloads.final({ runId: 'other-run', sessionKey: 'agent:coder:main', seq: 2 }, 'leak'));
            receive(h, 'chat', payloads.final({ runId, sessionKey: 'agent:coder:main', seq: 1 }, 'wrong session'));
            expect(run.events).toEqual([]);
        });

        it('shows tool activity of the run', async () => {
            const h = await connected();
            const run = send(h);
            const runId = await accepted(h);
            receive(h, 'agent', payloads.tool({ runId, seq: 3 }, { phase: 'start', name: 'exec', toolCallId: 't1', args: { command: 'ls' } }));
            receive(h, 'agent', payloads.tool({ runId, seq: 5 }, { phase: 'result', name: 'exec', toolCallId: 't1', isError: false, result: 'a.txt' }));
            expect(run.events).toEqual([
                { type: 'toolCall', id: 't1', title: 'exec', status: 'running', details: '{\n  "command": "ls"\n}' },
                { type: 'toolCall', id: 't1', title: 'exec', status: 'done', details: 'a.txt' },
            ]);
        });

        it('refuses to send when disconnected or when the gateway cannot stream', async () => {
            const offline = harness();
            const refused = send(offline);
            expect(refused.events).toEqual([{ type: 'error', message: expect.stringContaining('not connected') }, { type: 'done' }]);
            const limited = await connected({ hello: payloads.helloOk({ methods: ['chat.send', 'sessions.list'] }) });
            const unsupported = send(limited);
            expect(unsupported.events[0]).toEqual({ type: 'error', message: expect.stringContaining('does not offer subscribe, history') });
            expect(methods(limited.socket())).toEqual(['connect']);
        });

        it('does not send when the subscription is refused', async () => {
            const h = await connected();
            const run = send(h);
            h.socket().receive(errorFrame(h.socket().lastRequest('sessions.messages.subscribe').id, captured.invalidParamsError.error));
            await settle();
            expect(run.events).toEqual([{ type: 'error', message: expect.stringContaining('the send was not issued') }, { type: 'done' }]);
            expect(methods(h.socket())).not.toContain('chat.send');
        });

        it('reports a rejected send and a send the dropped connection left unconfirmed', async () => {
            const h = await connected();
            const rejected = send(h);
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            h.socket().replyError('chat.send', { code: 'INVALID_REQUEST', message: 'invalid chat.send params' });
            await settle();
            expect(rejected.events).toEqual([{ type: 'error', message: 'The gateway rejected the send: gateway rpc error code=INVALID_REQUEST' }, { type: 'done' }]);
            const lost = send(h);
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            h.socket().emit('close', 1006, Buffer.alloc(0));
            await settle();
            expect(lost.events).toEqual([{ type: 'error', message: expect.stringContaining('dropped before the gateway confirmed') }, { type: 'done' }]);
        });

        it('issues chat.send once, even across a reconnect', async () => {
            jest.useFakeTimers();
            const h = await connected();
            send(h);
            await accepted(h);
            h.socket().emit('close', 1006, Buffer.alloc(0));
            jest.advanceTimersByTime(1000);
            completeHandshake(h.socket());
            await settle();
            const sends = h.sockets.flatMap((socket) => socket.requests()).filter((request) => request.method === 'chat.send');
            expect(sends).toHaveLength(1);
        });

        it('follows the run it steered into and ends once both runs ended', async () => {
            const h = await connected();
            const first = send(h);
            const firstRun = await accepted(h);
            receive(h, 'chat', payloads.delta({ runId: firstRun, seq: 1 }, 'Part one', 'Part one'));
            const second = send(h, CANONICAL_MAIN);
            expect(first.events[first.events.length - 1]).toEqual({ type: 'done' });
            const secondRun = await accepted(h);
            receive(h, 'chat', payloads.final({ runId: secondRun, seq: 1 }));
            receive(h, 'chat', payloads.delta({ runId: firstRun, seq: 2 }, 'Part one, steered', ', steered', false));
            expect(count(second.events, 'done')).toBe(0);
            receive(h, 'chat', payloads.final({ runId: firstRun, seq: 3 }, 'Part one, steered.'));
            expect(texts(second.events)).toBe(', steered.');
            expect(count(second.events, 'done')).toBe(1);
            expect(count(first.events, 'done')).toBe(1);
        });

        it('knows the main alias from the hello, before any subscription', async () => {
            const h = await connected();
            expect(h.svc.canonicalSessionKey('main')).toBe(CANONICAL_MAIN);
            const first = send(h, CANONICAL_MAIN);
            await accepted(h);
            send(h, 'main');
            expect(first.events).toEqual([{ type: 'done' }]);
            expect(h.svc.hasOwnedRun('main')).toBe(true);
        });

        it('moves state kept under the alias to the canonical key on connect', async () => {
            const h = harness();
            const seen: ChatEvent[] = [];
            h.svc.restoreSessionState('main', { cursor: 'c3', lastSeq: 3 });
            h.svc.resumeSession('main', (event) => seen.push(event), { historyRendered: true });
            const connecting = h.svc.connect();
            completeHandshake(h.socket());
            await connecting;
            expect(h.svc.captureSessionState(CANONICAL_MAIN)).toEqual({ cursor: 'c3', lastSeq: 3 });
            expect(h.socket().lastRequest('sessions.messages.subscribe').params).toEqual({ key: CANONICAL_MAIN });
        });

        it('learns the canonical key from the subscription when the hello names no alias', async () => {
            const hello = payloads.helloOk();
            const h = await connected({ hello: { ...hello, snapshot: { ...(hello.snapshot as object), sessionDefaults: undefined } } });
            expect(h.svc.canonicalSessionKey('main')).toBe('main');
            const run = send(h);
            expect(h.socket().lastRequest('sessions.messages.subscribe').params).toEqual({ key: 'main' });
            await accepted(h);
            expect(run.resolved).toEqual([[CANONICAL_MAIN, 'main']]);
            expect(h.svc.canonicalSessionKey('main')).toBe(CANONICAL_MAIN);
        });

        it('refuses a send through a new alias of a session another local run streams', async () => {
            const hello = payloads.helloOk();
            const h = await connected({ hello: { ...hello, snapshot: { ...(hello.snapshot as object), sessionDefaults: undefined } } });
            const first = send(h, CANONICAL_MAIN);
            await accepted(h);
            const aliasSend = send(h, 'main');
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            expect(aliasSend.events).toEqual([{ type: 'error', message: expect.stringContaining('already streaming in another chat thread') }, { type: 'done' }]);
            expect(first.events).toEqual([]);
        });
    });

    describe('attachments', () => {
        const image = { name: 'shot.png', mimeType: 'image/png', data: Buffer.from('89504e470d0a1a0a', 'hex') };
        const notes = { name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('plain notes') };

        it('travel base64-encoded in chat.send, as the gateway parses them', async () => {
            const h = await connected();
            h.svc.sendMessage({ sessionKey: CANONICAL_MAIN, prompt: 'look', attachments: [image, notes], onEvent: () => undefined });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            expect(h.socket().lastRequest('chat.send').params.attachments).toEqual([
                { type: 'image', mimeType: 'image/png', fileName: 'shot.png', content: 'iVBORw0KGgo=', sizeBytes: 8, origin: 'file' },
                { type: 'file', mimeType: 'text/plain', fileName: 'notes.txt', content: Buffer.from('plain notes').toString('base64'), sizeBytes: 11, origin: 'file' },
            ]);
        });

        it('are refused above the advertised per-image and per-file ceilings', async () => {
            const h = await connected({ hello: payloads.helloOk({ policy: { maxPayload: 1_000_000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000, attachments: { maxBytes: 20, maxImageBytes: 4 } } }) });
            const events: ChatEvent[] = [];
            h.svc.sendMessage({ sessionKey: CANONICAL_MAIN, prompt: 'look', attachments: [image], onEvent: (event) => events.push(event) });
            expect(events).toEqual([{ type: 'error', message: 'Attachment "shot.png" is 8 bytes; the gateway accepts at most 4 bytes per image.' }, { type: 'done' }]);
            const fileEvents: ChatEvent[] = [];
            h.svc.sendMessage({ sessionKey: CANONICAL_MAIN, prompt: 'read', attachments: [{ ...notes, data: Buffer.alloc(21) }], onEvent: (event) => fileEvents.push(event) });
            expect(fileEvents[0]).toEqual({ type: 'error', message: expect.stringContaining('at most 20 bytes per file') });
            expect(h.socket().requests().map((request) => request.method)).toEqual(['connect']);
        });

        it('never put a frame over the payload limit on the wire', async () => {
            const h = await connected({ hello: payloads.helloOk({ policy: { maxPayload: 2000, maxBufferedBytes: 1_000_000, tickIntervalMs: 30_000 } }) });
            const events: ChatEvent[] = [];
            h.svc.sendMessage({ sessionKey: CANONICAL_MAIN, prompt: 'big', attachments: [{ ...notes, data: Buffer.alloc(3000) }], onEvent: (event) => events.push(event) });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            expect(events).toEqual([{ type: 'error', message: expect.stringMatching(/^The message was not sent: chat\.send is \d+ bytes, over the gateway's 2000-byte frame limit/) }, { type: 'done' }]);
            expect(h.socket().requests().map((request) => request.method)).not.toContain('chat.send');
        });
    });

    describe('aborting', () => {
        it('aborts the local run by id, drops its late events and completes after the gateway answered', async () => {
            const h = await connected();
            const run = send(h);
            const runId = await accepted(h);
            h.svc.abort('main');
            expect(h.socket().lastRequest('chat.abort').params).toEqual({ sessionKey: CANONICAL_MAIN, runId });
            receive(h, 'chat', payloads.delta({ runId, seq: 1 }, 'late', 'late'));
            expect(send(h).events[0]).toEqual({ type: 'error', message: expect.stringContaining('still aborting') });
            expect(run.events).toEqual([]);
            h.socket().reply('chat.abort', { ok: true, aborted: true, runIds: [runId] });
            await settle();
            expect(run.events).toEqual([{ type: 'done' }]);
        });

        it('stops a send still preparing without any gateway call', async () => {
            const h = await connected();
            const run = send(h);
            h.svc.abort('main');
            expect(run.events).toEqual([{ type: 'done' }]);
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            expect(methods(h.socket())).not.toContain('chat.send');
            expect(methods(h.socket())).not.toContain('chat.abort');
        });

        it('aborts after the next handshake when cancelled while disconnected', async () => {
            jest.useFakeTimers();
            const h = await connected();
            const run = send(h);
            const runId = await accepted(h);
            h.socket().emit('close', 1006, Buffer.alloc(0));
            h.svc.abort(CANONICAL_MAIN);
            expect(run.events).toEqual([{ type: 'done' }]);
            jest.advanceTimersByTime(1000);
            completeHandshake(h.socket());
            await settle();
            expect(h.socket().lastRequest('chat.abort').params).toEqual({ sessionKey: CANONICAL_MAIN, runId });
        });

        it('never aborts a run another client started', async () => {
            const h = await connected();
            h.svc.resumeSession(CANONICAL_MAIN, () => undefined, { historyRendered: true });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            receive(h, 'chat', payloads.delta({ runId: 'foreign', seq: 1 }, 'theirs', 'theirs'));
            send(h, CANONICAL_MAIN);
            const runId = await accepted(h);
            h.svc.abort(CANONICAL_MAIN);
            const aborted = h.socket().requests().filter((request) => request.method === 'chat.abort').map((request) => request.params.runId);
            expect(aborted).toEqual([runId]);
        });
    });

    describe('transcript sinks', () => {
        it('observe another client\'s run on a resumed session under its canonical key', async () => {
            const h = await connected();
            const seen: ChatEvent[] = [];
            h.svc.resumeSession('main', (event) => seen.push(event), { historyRendered: true });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            receive(h, 'chat', payloads.delta({ runId: 'foreign', seq: 1 }, 'Hi', 'Hi'));
            receive(h, 'chat', payloads.final({ runId: 'foreign', seq: 2 }, 'Hi there'));
            expect(seen).toEqual([{ type: 'text', text: 'Hi' }, { type: 'text', text: ' there' }, { type: 'done' }]);
        });

        it('catch up from the seeded cursor, showing only rows after it', async () => {
            const h = await connected();
            const seen: ChatEvent[] = [];
            const snapshot = await (async () => {
                const reading = h.svc.getHistory('main');
                h.socket().reply('chat.history', payloads.historyTail([{ role: 'user', text: 'q', seq: 1 }, { role: 'assistant', text: 'a', seq: 2, runId: 'r0' }], { cursor: 'cursor-2' }));
                return reading;
            })();
            h.svc.seedHistory('main', snapshot);
            h.svc.resumeSession('main', (event) => seen.push(event), { historyRendered: true });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            expect(h.socket().lastRequest('chat.history').params).toEqual({ sessionKey: CANONICAL_MAIN, cursor: 'cursor-2' });
            h.socket().reply('chat.history', payloads.historyDelta([{ role: 'assistant', text: 'a', seq: 2, runId: 'r0' }, { role: 'user', text: 'q2', seq: 3 }, { role: 'assistant', text: 'a2', seq: 4, runId: 'r1' }], 'cursor-4'));
            await settle();
            expect(seen).toEqual([{ type: 'text', text: 'a2' }, { type: 'done' }]);
            expect(h.svc.captureSessionState('main')).toEqual({ cursor: 'cursor-4', lastSeq: 4 });
        });

        it('replay the tail when no history was rendered', async () => {
            const h = await connected();
            const seen: ChatEvent[] = [];
            h.svc.resumeSession('main', (event) => seen.push(event));
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            expect(h.socket().lastRequest('chat.history').params).toEqual({ sessionKey: CANONICAL_MAIN });
            h.socket().reply('chat.history', payloads.historyTail([{ role: 'user', text: 'q', seq: 1 }, { role: 'assistant', text: 'a', seq: 2, runId: 'r0' }]));
            await settle();
            expect(seen).toEqual([{ type: 'text', text: 'a' }, { type: 'done' }]);
        });

        it('release the subscription with the last sink and forget the position on clear', async () => {
            const h = await connected();
            const sink = (): void => undefined;
            h.svc.resumeSession('main', sink, { historyRendered: true });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            h.svc.restoreSessionState('main', { cursor: 'c9', lastSeq: 9 });
            h.svc.removeTranscriptSink('main', sink);
            expect(h.socket().lastRequest('sessions.messages.unsubscribe').params).toEqual({ key: CANONICAL_MAIN });
            expect(h.svc.captureSessionState(CANONICAL_MAIN)).toEqual({ cursor: 'c9', lastSeq: 9 });
            h.svc.clearSessionSink('main');
            expect(h.svc.captureSessionState('main')).toBeNull();
        });
    });

    describe('reconnect catch-up', () => {
        async function runAcrossDrop(historyReply: (h: Harness, runId: string) => void): Promise<{ h: Harness; run: Send }> {
            jest.useFakeTimers();
            const h = await connected();
            const run = send(h);
            const runId = await accepted(h);
            receive(h, 'session.message', payloads.sessionMessage({ role: 'user', text: 'hello', seq: 5, runId }));
            receive(h, 'chat', payloads.delta({ runId, seq: 1 }, 'Partial', 'Partial'));
            h.socket().emit('close', 1006, Buffer.alloc(0));
            jest.advanceTimersByTime(1000);
            completeHandshake(h.socket());
            await settle();
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            historyReply(h, runId);
            await settle();
            return { h, run };
        }

        it('finishes a run that ended while the socket was away with the text it left', async () => {
            const { h, run } = await runAcrossDrop((harnessed, runId) => {
                expect(harnessed.socket().lastRequest('chat.history').params).toEqual({ sessionKey: CANONICAL_MAIN });
                harnessed.socket().reply('chat.history', payloads.historyTail([
                    { role: 'user', text: 'hello', seq: 5, runId },
                    { role: 'assistant', text: 'Partial answer.', seq: 6, runId },
                ], { cursor: 'c6', activeRunIds: [] }));
            });
            expect(texts(run.events)).toBe('Partial answer.');
            expect(count(run.events, 'done')).toBe(1);
            expect(h.svc.hasOwnedRun('main')).toBe(false);
        });

        it('keeps following a run the gateway still reports active', async () => {
            const { h, run } = await runAcrossDrop((harnessed, runId) => {
                harnessed.socket().reply('chat.history', payloads.historyTail([{ role: 'user', text: 'hello', seq: 5, runId }], { activeRunIds: [runId] }));
            });
            expect(count(run.events, 'done')).toBe(0);
            const runId = String(h.sockets[0].lastRequest('chat.send').params.idempotencyKey);
            receive(h, 'chat', payloads.final({ runId, seq: 9 }, 'Partial, finished'));
            expect(texts(run.events)).toBe('Partial, finished');
            expect(count(run.events, 'done')).toBe(1);
        });

        it('falls back to a tail read when the cursor was reset', async () => {
            jest.useFakeTimers();
            const h = await connected();
            const seen: ChatEvent[] = [];
            h.svc.restoreSessionState('main', { cursor: 'stale', lastSeq: 2 });
            h.svc.resumeSession('main', (event) => seen.push(event), { historyRendered: true });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            h.socket().reply('chat.history', payloads.historyReset());
            await settle();
            expect(h.socket().lastRequest('chat.history').params).toEqual({ sessionKey: CANONICAL_MAIN });
            h.socket().reply('chat.history', payloads.historyTail([{ role: 'assistant', text: 'old', seq: 2, runId: 'r0' }, { role: 'assistant', text: 'new', seq: 3, runId: 'r1' }], { cursor: 'c3' }));
            await settle();
            expect(seen).toEqual([{ type: 'text', text: 'new' }, { type: 'done' }]);
        });

        it('ends runs with the hint when the reconnect is rejected for good', async () => {
            jest.useFakeTimers();
            const h = await connected();
            const run = send(h);
            await accepted(h);
            h.socket().emit('close', 1006, Buffer.alloc(0));
            jest.advanceTimersByTime(1000);
            h.socket().receive(eventFrame('connect.challenge', payloads.challenge()));
            h.socket().replyError('connect', captured.tokenMismatchRejection.error);
            await settle();
            expect(run.events).toEqual([{ type: 'error', message: expect.stringContaining('OpenClaw: Connect to Gateway') }, { type: 'done' }]);
        });

        it('catches up from history when the connection sequence skips', async () => {
            const h = await connected();
            h.svc.restoreSessionState('main', { cursor: 'c1', lastSeq: 1 });
            h.svc.resumeSession('main', () => undefined, { historyRendered: true });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            h.socket().reply('chat.history', payloads.historyDelta([], 'c1'));
            await settle();
            const before = h.socket().requests().filter((request) => request.method === 'chat.history').length;
            h.socket().receive(eventFrame('tick', { ts: 1 }, 10));
            h.socket().receive(eventFrame('tick', { ts: 2 }, 14));
            await settle();
            expect(h.socket().requests().filter((request) => request.method === 'chat.history')).toHaveLength(before + 1);
        });
    });

    describe('reads', () => {
        it('lists the gateway\'s sessions from a real sessions.list result', async () => {
            const h = await connected();
            const listing = h.svc.listSessions();
            h.socket().reply('sessions.list', captured.sessionsListResult.payload);
            expect(await listing).toEqual([{ key: CANONICAL_MAIN, label: 'Hello from probe', agentId: 'dev', hasActiveRun: false, lastActivityMs: expect.any(Number), cold: false }]);
        });

        it('reads a history tail for restore, and null when the gateway cannot', async () => {
            const h = await connected();
            const reading = h.svc.getHistory('main');
            h.socket().reply('chat.history', captured.historyTailResult.payload);
            expect((await reading)?.messages).toHaveLength(8);
            const failing = h.svc.getHistory('main');
            h.socket().replyError('chat.history', { code: 'UNAVAILABLE', message: 'busy' });
            expect(await failing).toBeNull();
            expect(await harness().svc.getHistory('main')).toBeNull();
        });
    });

    describe('connection bookkeeping', () => {
        it('tells listeners about connects and drops until they unsubscribe', async () => {
            jest.useFakeTimers();
            const h = harness();
            const states: boolean[] = [];
            const stop = h.svc.onConnectionStateChange((isConnected) => states.push(isConnected));
            const connecting = h.svc.connect();
            completeHandshake(h.socket());
            await connecting;
            h.socket().emit('close', 1006, Buffer.alloc(0));
            stop();
            jest.advanceTimersByTime(1000);
            completeHandshake(h.socket());
            await settle();
            expect(h.svc.isRunning).toBe(true);
            expect(states).toEqual([true, false]);
        });

        it('opens its socket with the ws package by default', async () => {
            const socket = createMockSocket();
            const ws = jest.requireMock<jest.Mock>('ws');
            ws.mockImplementation(() => socket);
            const svc = new GatewayChatService({ url: 'ws://gateway.test:18789', token: TOKEN });
            services.push(svc);
            const connecting = svc.connect();
            completeHandshake(socket);
            await connecting;
            expect(ws).toHaveBeenCalledWith('ws://gateway.test:18789');
        });

        it('does not connect when it was suspended or its socket closed right after the hello', async () => {
            const suspended = harness();
            const suspending = suspended.svc.connect();
            completeHandshake(suspended.socket());
            suspended.svc.suspend();
            await expect(suspending).rejects.toThrow('superseded by a newer attempt');
            const dropped = harness();
            const dropping = dropped.svc.connect();
            completeHandshake(dropped.socket());
            dropped.socket().emit('close', 1006, Buffer.alloc(0));
            await expect(dropping).rejects.toThrow('closed during the handshake');
            expect(dropped.svc.isRunning).toBe(false);
        });

        it('lets a handshake overtaken by a suspend and a new attempt adopt that attempt', async () => {
            const h = harness();
            const first = h.svc.connect();
            completeHandshake(h.socket());
            h.svc.suspend();
            const second = h.svc.connect();
            completeHandshake(h.socket());
            await first;
            await second;
            expect(h.sockets).toHaveLength(2);
            expect(h.svc.isRunning).toBe(true);
        });

        it('ignores a hello that a retired socket delivers late', async () => {
            const h = harness();
            const first = h.svc.connect().then(() => 'connected', (err: Error) => err.message);
            const retired = h.socket();
            retired.close = () => undefined;
            h.svc.updateConnection('ws://gateway.test:18789', 'rotated');
            completeHandshake(retired);
            expect(await first).toMatch('retired socket delivered its hello');
            expect(h.svc.isRunning).toBe(false);
        });

        it('shares one attempt between concurrent connects and resolves at once when connected', async () => {
            const h = harness();
            const first = h.svc.connect();
            expect(h.svc.connect()).toBe(first);
            completeHandshake(h.socket());
            await first;
            await h.svc.connect();
            expect(h.sockets).toHaveLength(1);
        });

        it('keeps a superseded handshake from connecting and lets it adopt the newer attempt', async () => {
            const h = harness();
            const first = h.svc.connect().then(() => 'connected', (err: Error) => err.message);
            h.svc.updateConnection('ws://gateway.test:18789', 'rotated');
            const second = h.svc.connect();
            completeHandshake(h.socket());
            expect(await first).toMatch('superseded');
            await second;
            expect(h.socket().lastRequest('connect').params).toMatchObject({ auth: { token: 'rotated' } });
        });

        it('fails a handshake whose result is not a hello', async () => {
            const h = harness();
            const connecting = h.svc.connect();
            h.socket().receive(eventFrame('connect.challenge', payloads.challenge()));
            h.socket().receive(JSON.stringify({ type: 'res', id: h.socket().lastRequest('connect').id, ok: true, payload: { type: 'hello' } }));
            await expect(connecting).rejects.toThrow('returned no hello');
        });

        it('ignores an unchanged endpoint and does not reconnect a client that never connected', () => {
            jest.useFakeTimers();
            const h = harness();
            h.svc.updateConnection('ws://gateway.test:18789', TOKEN);
            h.svc.updateConnection('ws://gateway.test:18789', 'other');
            jest.advanceTimersByTime(60_000);
            expect(h.sockets).toHaveLength(0);
            expect(h.svc.getGatewayIdentity()).toBe(JSON.stringify(['ws://gateway.test:18789', 'other']));
        });

        it('suspends: aborts the local run, finishes its sink and stops reconnecting', async () => {
            jest.useFakeTimers();
            const h = await connected();
            const run = send(h);
            const runId = await accepted(h);
            h.svc.suspend();
            expect(h.sockets[0].lastRequest('chat.abort').params).toEqual({ sessionKey: CANONICAL_MAIN, runId });
            expect(run.events).toEqual([{ type: 'done' }]);
            jest.advanceTimersByTime(60_000);
            expect(h.sockets).toHaveLength(1);
        });

        it('times out an unanswered RPC and reports a socket that cannot send', async () => {
            jest.useFakeTimers();
            const h = await connected();
            const listing = h.svc.listSessions();
            jest.advanceTimersByTime(30_000);
            await expect(listing).rejects.toThrow('gateway rpc timeout method=sessions.list');
            h.socket().send = () => {
                throw new Error(`broken pipe ${TOKEN}`);
            };
            const failing = h.svc.listSessions();
            await expect(failing).rejects.toThrow('gateway rpc send failed method=sessions.list broken pipe ***');
        });

        it('rejects a malformed session list', async () => {
            const h = await connected();
            const listing = h.svc.listSessions();
            h.socket().receive(JSON.stringify({ type: 'res', id: h.socket().lastRequest('sessions.list').id, ok: true, payload: { rows: [] } }));
            await expect(listing).rejects.toThrow('malformed session list');
        });

        it('budgets attachments with the protocol it will offer before any handshake', () => {
            expect(harness().svc.attachmentWireBytes({ name: 'a.png', mimeType: 'image/png', byteLength: 3 })).toBeGreaterThan(4);
        });
    });

    describe('session bookkeeping', () => {
        it('forgets the oldest idle sessions beyond its bound', () => {
            const h = harness();
            h.svc.restoreSessionState('agent:first:main', { cursor: 'c', lastSeq: 1 });
            for (let i = 0; i < 101; i++) h.svc.restoreSessionState(`agent:a${i}:main`, { cursor: 'c', lastSeq: 1 });
            expect(h.svc.captureSessionState('agent:first:main')).toBeNull();
            expect(h.svc.captureSessionState('agent:a100:main')).toEqual({ cursor: 'c', lastSeq: 1 });
        });

        it('forgets the oldest aliases beyond its bound', async () => {
            const hello = payloads.helloOk();
            const h = await connected({ hello: { ...hello, snapshot: { ...(hello.snapshot as object), sessionDefaults: undefined } } });
            for (let i = 0; i < 257; i++) {
                h.svc.resumeSession(`alias-${i}`, () => undefined, { historyRendered: true });
                h.socket().reply('sessions.messages.subscribe', payloads.subscribed(`agent:a${i}:main`));
                await settle();
            }
            expect(h.svc.canonicalSessionKey('alias-0')).toBe('alias-0');
            expect(h.svc.canonicalSessionKey('alias-256')).toBe('agent:a256:main');
        });

        it('releases a subscription without an unsubscribe call when the gateway has none', async () => {
            const advertised = (payloads.helloOk().features as { methods: string[] }).methods.filter((m) => m !== 'sessions.messages.unsubscribe');
            const h = await connected({ hello: payloads.helloOk({ methods: advertised }) });
            const sink = (): void => undefined;
            h.svc.resumeSession(CANONICAL_MAIN, sink, { historyRendered: true });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            h.svc.removeTranscriptSink(CANONICAL_MAIN, sink);
            expect(h.socket().requests().map((r) => r.method)).not.toContain('sessions.messages.unsubscribe');
        });

        it('tolerates teardown calls for sessions and sinks it does not know', () => {
            const h = harness();
            expect(() => {
                h.svc.clearSessionSink('agent:none:main');
                h.svc.removeTranscriptSink('agent:none:main', () => undefined);
                h.svc.restoreSessionState('agent:none:main', null);
                h.svc.seedHistory('agent:none:main', null);
                h.svc.abort('agent:none:main');
            }).not.toThrow();
            expect(h.svc.captureSessionState('agent:none:main')).toBeNull();
        });

        it('re-registers a transcript sink and subscribes it', async () => {
            const h = await connected();
            const seen: ChatEvent[] = [];
            h.svc.rebindTranscriptSink(CANONICAL_MAIN, (event) => seen.push(event));
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            receive(h, 'chat', payloads.final({ runId: 'foreign', seq: 1 }, 'hi'));
            expect(seen).toEqual([{ type: 'text', text: 'hi' }, { type: 'done' }]);
        });

        it('ignores a subscription answer that does not confirm one', async () => {
            const h = await connected();
            const run = send(h);
            h.socket().reply('sessions.messages.subscribe', payloads.unsubscribed());
            await settle();
            expect(run.events).toEqual([{ type: 'error', message: expect.stringContaining('the send was not issued') }, { type: 'done' }]);
        });

        it('keeps sinks of a session whose subscription failed after a reconnect, but ends its run', async () => {
            jest.useFakeTimers();
            const h = await connected();
            const run = send(h);
            await accepted(h);
            h.socket().emit('close', 1006, Buffer.alloc(0));
            jest.advanceTimersByTime(1000);
            completeHandshake(h.socket());
            await settle();
            h.socket().replyError('sessions.messages.subscribe', { code: 'UNAVAILABLE', message: 'busy' });
            await settle();
            expect(run.events).toEqual([{ type: 'error', message: expect.stringContaining('The response may not appear in this thread') }, { type: 'done' }]);
        });
    });

    describe('run routing', () => {
        it('follows the run the ack names when it differs from the chosen id', async () => {
            const h = await connected();
            const run = send(h);
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            receive(h, 'chat', payloads.delta({ runId: 'server-run', seq: 1 }, 'early', 'early'));
            h.socket().reply('chat.send', payloads.sendAck('server-run'));
            await settle();
            receive(h, 'chat', payloads.final({ runId: 'server-run', seq: 2 }, 'early done'));
            expect(texts(run.events)).toBe('early done');
            expect(count(run.events, 'done')).toBe(0);
            expect(h.logs).toContain('gateway acknowledged the send under another run id; following it');
        });

        it('routes tool events without a session key by their run', async () => {
            const h = await connected();
            const run = send(h);
            const runId = await accepted(h);
            receive(h, 'agent', { ...payloads.tool({ runId, seq: 1 }, { phase: 'update', name: 'exec', toolCallId: 't', partialResult: 'half' }), sessionKey: undefined });
            expect(run.events).toEqual([{ type: 'toolCall', id: 't', title: 'exec', status: 'running', details: 'half' }]);
        });

        it('keeps text that an aborted run extended, and drops what diverged', async () => {
            const h = await connected();
            const seen: ChatEvent[] = [];
            h.svc.resumeSession(CANONICAL_MAIN, (event) => seen.push(event), { historyRendered: true });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            receive(h, 'chat', payloads.delta({ runId: 'r1', seq: 1 }, 'Hel', 'Hel'));
            receive(h, 'chat', { ...payloads.aborted({ runId: 'r1', seq: 2 }), message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } });
            receive(h, 'chat', payloads.delta({ runId: 'r2', seq: 1 }, 'Bye', 'Bye'));
            receive(h, 'chat', { ...payloads.aborted({ runId: 'r2', seq: 2 }), message: { role: 'assistant', content: [{ type: 'text', text: 'Other' }] } });
            receive(h, 'chat', payloads.status({ runId: 'r3', seq: 1 }));
            expect(texts(seen)).toBe('HelloBye');
            expect(count(seen, 'done')).toBe(2);
        });

        it('starts the text of a run first seen through its transcript row', async () => {
            const h = await connected();
            const seen: ChatEvent[] = [];
            h.svc.resumeSession(CANONICAL_MAIN, (event) => seen.push(event), { historyRendered: true });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            receive(h, 'session.message', payloads.sessionMessage({ role: 'assistant', text: 'From the row', seq: 4, runId: 'quiet' }));
            receive(h, 'chat', payloads.final({ runId: 'quiet', seq: 5 }, 'From the row, then more'));
            receive(h, 'session.message', payloads.sessionMessage({ role: 'user', text: 'unrelated', seq: 6 }, 'agent:other:main'));
            expect(texts(seen)).toBe('From the row, then more');
        });

        it('bounds the live runs it tracks per session', async () => {
            const h = await connected();
            const seen: ChatEvent[] = [];
            h.svc.resumeSession(CANONICAL_MAIN, (event) => seen.push(event), { historyRendered: true });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            for (let i = 0; i < 51; i++) receive(h, 'chat', payloads.delta({ runId: `run-${i}`, seq: 1 }, 'x', 'x'));
            receive(h, 'chat', payloads.delta({ runId: 'run-0', seq: 2 }, 'xy', 'y'));
            expect(texts(seen)).toBe(`${'x'.repeat(51)}xy`);
        });
    });

    describe('catch-up scheduling', () => {
        it('runs a second catch-up after one requested mid-way', async () => {
            const h = await connected();
            h.svc.restoreSessionState('main', { cursor: 'c1', lastSeq: 1 });
            h.svc.resumeSession('main', () => undefined, { historyRendered: true });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            h.svc.rebindTranscriptSink('main', () => undefined);
            await settle();
            h.socket().reply('chat.history', payloads.historyDelta([], 'c2'));
            await settle();
            expect(h.socket().lastRequest('chat.history').params).toEqual({ sessionKey: CANONICAL_MAIN, cursor: 'c2' });
        });

        it('gives up when the tail read after a reset fails too', async () => {
            const h = await connected();
            const seen: ChatEvent[] = [];
            h.svc.restoreSessionState('main', { cursor: 'stale', lastSeq: 5 });
            h.svc.resumeSession('main', (event) => seen.push(event), { historyRendered: true });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            h.socket().reply('chat.history', payloads.historyReset());
            await settle();
            h.socket().reply('chat.history', payloads.historyReset());
            await settle();
            expect(seen).toEqual([]);
            expect(h.svc.captureSessionState('main')).toEqual({ cursor: null, lastSeq: 5 });
        });

        it('restarts the sequence when the reset tail is behind the old position', async () => {
            const h = await connected();
            const seen: ChatEvent[] = [];
            h.svc.restoreSessionState('main', { cursor: 'stale', lastSeq: 40 });
            h.svc.resumeSession('main', (event) => seen.push(event), { historyRendered: true });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            h.socket().reply('chat.history', payloads.historyReset());
            await settle();
            h.socket().reply('chat.history', payloads.historyTail([{ role: 'assistant', text: 'after /clear', seq: 2, runId: 'r' }], { cursor: 'c2' }));
            await settle();
            expect(seen).toEqual([{ type: 'text', text: 'after /clear' }, { type: 'done' }]);
        });

        it('leaves runs alone when the history does not say which are active', async () => {
            jest.useFakeTimers();
            const h = await connected();
            const run = send(h);
            const runId = await accepted(h);
            h.socket().emit('close', 1006, Buffer.alloc(0));
            jest.advanceTimersByTime(1000);
            completeHandshake(h.socket());
            await settle();
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            const tail = payloads.historyTail([{ role: 'assistant', text: 'done?', seq: 3, runId }]);
            h.socket().reply('chat.history', { ...tail, sessionInfo: { key: CANONICAL_MAIN } });
            await settle();
            expect(count(run.events, 'done')).toBe(0);
        });
    });

    describe('handshake edges', () => {
        it('answers only the first challenge and ignores other traffic before the hello', async () => {
            const h = harness();
            const connecting = h.svc.connect();
            h.socket().emit('message', 42);
            h.socket().receive(eventFrame('connect.challenge', payloads.challenge()));
            h.socket().receive(eventFrame('connect.challenge', payloads.challenge()));
            h.socket().receive(JSON.stringify(captured.tick));
            h.socket().receive(JSON.stringify({ type: 'res', id: 'someone-else', ok: true, payload: {} }));
            expect(h.socket().requests().map((r) => r.method)).toEqual(['connect']);
            h.socket().reply('connect', payloads.helloOk());
            await connecting;
            expect(h.svc.isRunning).toBe(true);
        });

        it('reports a rejection without a message, and caps a long one', async () => {
            const bare = harness();
            const bareConnect = bare.svc.connect();
            bare.socket().receive(eventFrame('connect.challenge', payloads.challenge()));
            bare.socket().receive(JSON.stringify({ type: 'res', id: bare.socket().lastRequest('connect').id, ok: false, error: { code: 'FORBIDDEN' } }));
            await expect(bareConnect).rejects.toThrow(/^gateway handshake rejected code=FORBIDDEN$/);
            const long = harness();
            const longConnect = long.svc.connect();
            long.socket().receive(eventFrame('connect.challenge', payloads.challenge()));
            long.socket().replyError('connect', { code: 'FORBIDDEN', message: 'x'.repeat(400) });
            const error = (await longConnect.catch((err: unknown) => err)) as GatewayConnectError;
            expect(error.rejection.message).toBe(`${'x'.repeat(300)}…`);
        });

        it('retries a throttled rejection at the slowest pace and a plain one at once', async () => {
            jest.useFakeTimers();
            const throttled = harness();
            const first = throttled.svc.connect();
            throttled.socket().receive(eventFrame('connect.challenge', payloads.challenge()));
            throttled.socket().replyError('connect', { code: 'UNAVAILABLE', message: 'locked', details: { code: 'AUTH_RATE_LIMITED' } });
            await first.catch(() => undefined);
            jest.advanceTimersByTime(999);
            expect(throttled.sockets).toHaveLength(1);
            jest.advanceTimersByTime(1);
            expect(throttled.sockets).toHaveLength(2);
            const plain = harness();
            const second = plain.svc.connect();
            plain.socket().receive(eventFrame('connect.challenge', payloads.challenge()));
            plain.socket().replyError('connect', { code: 'UNAVAILABLE', message: 'busy' });
            await second.catch(() => undefined);
            jest.advanceTimersByTime(100);
            expect(plain.sockets).toHaveLength(2);
        });

        it('reports a factory that throws a non-error, and redacts nothing without a token', async () => {
            const h = harness({ token: '', throwOnOpen: 'no socket for ws://u:p@host' });
            await expect(h.svc.connect()).rejects.toThrow('gateway connect failed no socket for');
            expect(h.svc.getTransportLimits().maxPayloadBytes).toBe(25 * 1024 * 1024);
        });

        it('reconnects promptly after a shutdown that names no restart time', async () => {
            jest.useFakeTimers();
            const h = await connected();
            receive(h, 'shutdown', { reason: 'stopping' });
            h.socket().emit('close', 1012, Buffer.alloc(0));
            jest.advanceTimersByTime(100);
            expect(h.sockets).toHaveLength(2);
        });
    });

    describe('run edges', () => {
        it('reports a run error without a message, with its usage', async () => {
            const h = await connected();
            const run = send(h);
            const runId = await accepted(h);
            receive(h, 'chat', { runId, sessionKey: CANONICAL_MAIN, seq: 1, state: 'error', usage: { input: 3, output: 1 } });
            expect(run.events).toEqual([
                { type: 'usage', usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 } },
                { type: 'error', message: 'The gateway reported that the run failed.' },
                { type: 'done' },
            ]);
        });

        it('keeps only the latest events of unknown runs while a send is unacknowledged', async () => {
            const h = await connected();
            const seen: ChatEvent[] = [];
            h.svc.resumeSession(CANONICAL_MAIN, (event) => seen.push(event), { historyRendered: true });
            send(h, CANONICAL_MAIN);
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            for (let i = 1; i <= 201; i++) receive(h, 'chat', payloads.delta({ runId: 'other', seq: i }, 'x'.repeat(i), 'x'));
            const runId = String(h.socket().lastRequest('chat.send').params.idempotencyKey);
            h.socket().reply('chat.send', payloads.sendAck(runId));
            await settle();
            expect(texts(seen)).toBe('x'.repeat(201));
            expect(seen.filter((event) => event.type === 'text')[0]).toEqual({ type: 'text', text: 'xx' });
        });

        it('follows every run a chain of steering sends inherited', async () => {
            const h = await connected();
            send(h, CANONICAL_MAIN);
            const firstRun = await accepted(h);
            receive(h, 'chat', payloads.delta({ runId: firstRun, seq: 1 }, 'a', 'a'));
            send(h, CANONICAL_MAIN);
            await accepted(h);
            const third = send(h, CANONICAL_MAIN);
            const thirdRun = await accepted(h);
            receive(h, 'chat', payloads.final({ runId: thirdRun, seq: 1 }));
            expect(count(third.events, 'done')).toBe(0);
            receive(h, 'chat', payloads.final({ runId: firstRun, seq: 2 }, 'ab'));
            expect(texts(third.events)).toBe('b');
        });

        it('drops a send whose session was taken over while it was being resolved', async () => {
            const h = await connected();
            const events: ChatEvent[] = [];
            h.svc.sendMessage({
                sessionKey: 'main',
                prompt: 'p',
                onEvent: (event) => events.push(event),
                onSessionResolved: () => h.svc.abort(CANONICAL_MAIN),
            });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            expect(events).toEqual([{ type: 'done' }]);
            expect(h.socket().requests().map((r) => r.method)).not.toContain('chat.send');
        });

        it('catches up only subscribed sessions with sinks after a sequence gap', async () => {
            const h = await connected();
            h.svc.restoreSessionState('agent:idle:main', { cursor: 'c', lastSeq: 1 });
            h.socket().receive(eventFrame('tick', { ts: 1 }, 1));
            h.socket().receive(eventFrame('tick', { ts: 2 }, 5));
            await settle();
            expect(h.socket().requests().map((r) => r.method)).toEqual(['connect']);
        });
    });

    describe('history edges', () => {
        it('seeds from a snapshot without cursor or active runs, and with an in-flight run', async () => {
            const h = await connected();
            const seen: ChatEvent[] = [];
            h.svc.seedHistory('main', { messages: [{ role: 'user', text: 'q', entryId: null, seq: null, runId: null, usage: null }], cursor: null, inFlightRunId: 'live', activeRunIds: null });
            expect(h.svc.captureSessionState('main')).toBeNull();
            h.svc.resumeSession('main', (event) => seen.push(event), { historyRendered: true });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            h.socket().reply('chat.history', { ...payloads.historyTail([{ role: 'assistant', text: 'live answer', seq: 2, runId: 'live' }]), sessionInfo: { key: CANONICAL_MAIN }, inFlightRun: { runId: 'other', text: '' } });
            await settle();
            expect(seen).toEqual([{ type: 'text', text: 'live answer' }, { type: 'done' }]);
        });

        it('merges runs tracked under the alias into the canonical session on connect', async () => {
            const h = harness();
            const seen: ChatEvent[] = [];
            const snapshot = (activeRunIds: string[] | null) => ({ messages: [], cursor: null, inFlightRunId: null, activeRunIds });
            h.svc.seedHistory(CANONICAL_MAIN, snapshot(['r1']));
            h.svc.seedHistory('main', snapshot(['r1', 'r2']));
            h.svc.seedHistory('main', snapshot(null));
            h.svc.resumeSession('main', (event) => seen.push(event), { historyRendered: true });
            const connecting = h.svc.connect();
            completeHandshake(h.socket());
            await connecting;
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            h.socket().emit('message', 7);
            receive(h, 'chat', payloads.final({ runId: 'r2', seq: 1 }, 'r2 done'));
            receive(h, 'chat', payloads.final({ runId: 'r1', seq: 1 }, 'r1 done'));
            expect(texts(seen)).toBe('r2 doner1 done');
        });

        it('replays unsequenced tail rows only when nothing bounds the replay', async () => {
            const h = await connected();
            const seen: ChatEvent[] = [];
            h.svc.resumeSession('main', (event) => seen.push(event));
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            h.socket().reply('chat.history', payloads.historyTail([{ role: 'assistant', text: 'unsequenced' }]));
            await settle();
            expect(seen).toEqual([{ type: 'text', text: 'unsequenced' }, { type: 'done' }]);
        });

        it('treats a reset answer to a tail read as no history', async () => {
            const h = await connected();
            const seen: ChatEvent[] = [];
            h.svc.resumeSession('main', (event) => seen.push(event));
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            h.socket().reply('chat.history', payloads.historyReset());
            await settle();
            expect(seen).toEqual([]);
            const reading = h.svc.getHistory('main');
            h.socket().reply('chat.history', payloads.historyReset());
            expect(await reading).toBeNull();
        });

        it('finishes a tracked run the transcript mentions without a final text', async () => {
            jest.useFakeTimers();
            const h = await connected();
            const run = send(h);
            const runId = await accepted(h);
            h.socket().emit('close', 1006, Buffer.alloc(0));
            jest.advanceTimersByTime(1000);
            completeHandshake(h.socket());
            await settle();
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            h.socket().reply('chat.history', payloads.historyTail([{ role: 'user', text: 'hello', seq: 1, runId }], { activeRunIds: [] }));
            await settle();
            expect(run.events).toEqual([{ type: 'done' }]);
        });
    });

    describe('lifecycle', () => {
        it('settles pending requests, finishes sinks and stays silent after dispose', async () => {
            jest.useFakeTimers();
            const h = await connected();
            const run = send(h);
            const runId = await accepted(h);
            const listing = h.svc.listSessions();
            h.svc.dispose();
            await expect(listing).rejects.toThrow('gateway client disposed');
            expect(run.events).toEqual([{ type: 'done' }]);
            h.sockets[0].receive(eventFrame('chat', payloads.final({ runId, seq: 1 }, 'late')));
            jest.advanceTimersByTime(120_000);
            expect(run.events).toEqual([{ type: 'done' }]);
            expect(h.sockets).toHaveLength(1);
            await expect(h.svc.connect()).rejects.toThrow('disposed');
        });

        it('retires every sink when the endpoint changes', async () => {
            const h = await connected();
            const run = send(h);
            await accepted(h);
            const seen: ChatEvent[] = [];
            h.svc.resumeSession('agent:coder:main', (event) => seen.push(event), { historyRendered: true });
            h.svc.updateConnection('ws://other:18789', TOKEN);
            expect(count(run.events, 'done')).toBe(1);
            expect(seen).toEqual([{ type: 'done' }]);
            expect(h.svc.canonicalSessionKey('main')).toBe('main');
        });

        it('never throws on untrusted frames', async () => {
            const h = await connected();
            send(h);
            await accepted(h);
            const junk = ['', 'nope', '{}', '[]', 'null', '{"type":"res","id":5}', '{"type":"event","event":"chat","payload":null}',
                '{"type":"event","event":"chat","payload":{"runId":"x","sessionKey":"agent:dev:main","seq":"1","state":"final"}}',
                '{"type":"event","event":"session.message","payload":{"sessionKey":"agent:dev:main","message":{"role":"assistant","content":7}}}',
                '{"type":"event","event":"agent","payload":{"runId":"x","stream":"tool","seq":1,"data":{"phase":"start"}}}'];
            for (const raw of junk) {
                expect(() => h.socket().receive(raw)).not.toThrow();
            }
            expect(() => h.socket().emit('message', Buffer.from('{"type":"event","event":"tick","payload":{"ts":1}}'))).not.toThrow();
        });
    });
});
