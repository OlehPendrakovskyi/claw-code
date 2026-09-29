/**
 * GatewayChatService against a mock socket that speaks OpenClaw Gateway
 * protocol v4: every frame the client sends is validated against the schemas
 * exported from the real gateway, and inbound frames come from captures of a
 * real gateway or validated builders.
 */

import { createPublicKey, verify } from 'crypto';
import { GatewayChatService, type GatewaySend, type PairingState } from '../core/gatewayChatService';
import { generateDeviceIdentity } from '../core/gatewayProtocol/deviceIdentity';
import type { DeviceCredentialStore, DeviceIdentity, StoredDeviceToken } from '../core/gatewayProtocol/deviceIdentity';
import { GatewayConnectError } from '../core/gatewayProtocol/model';
import { v4Adapter } from '../core/gatewayProtocol/v4/adapter';
import type { ProtocolSetting } from '../core/gatewayProtocol/registry';
import type { ChatEvent } from '../chat/ChatService';
import {
    CANONICAL_MAIN,
    captured,
    completeHandshake,
    createMockSocket,
    errorFrame,
    eventFrame,
    resultFrame,
    payloads,
    protocolViolations,
    type MockSocket,
} from './helpers/gatewayV4';

jest.mock('ws', () => jest.fn());

const TOKEN = 'secret-token-value';
const GATEWAY_ORIGIN = 'ws://gateway.test:18789';

/** SecretStorage stand-in: one identity, tokens keyed by gateway origin. */
class MemoryDeviceStore implements DeviceCredentialStore {
    identity: DeviceIdentity = generateDeviceIdentity();
    readonly tokens = new Map<string, StoredDeviceToken>();
    failIdentity = false;
    readonly stored: StoredDeviceToken[] = [];

    async loadIdentity(): Promise<DeviceIdentity> {
        if (this.failIdentity) throw new Error('keyring locked');
        return this.identity;
    }

    async loadToken(gateway: string, deviceId: string): Promise<StoredDeviceToken | null> {
        const token = this.tokens.get(gateway);
        return token?.deviceId === deviceId ? token : null;
    }

    async storeToken(gateway: string, token: StoredDeviceToken): Promise<void> {
        this.stored.push(token);
        this.tokens.set(gateway, token);
    }

    async clearToken(gateway: string, deviceId: string): Promise<void> {
        if (this.tokens.get(gateway)?.deviceId === deviceId) this.tokens.delete(gateway);
    }
}

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

    type HarnessOptions = { token?: string; protocol?: ProtocolSetting; throwOnOpen?: unknown; device?: DeviceCredentialStore; trustsDeviceTokenRetry?: boolean };

    function harness(opts: HarnessOptions = {}): Harness {
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
            deviceCredentials: opts.device,
            trustsDeviceTokenRetry: () => opts.trustsDeviceTokenRetry === true,
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

        it('pauses on a pending pairing when it proved no device', async () => {
            jest.useFakeTimers();
            const h = harness();
            const connecting = h.svc.connect();
            h.socket().receive(eventFrame('connect.challenge', payloads.challenge()));
            h.socket().replyError('connect', { code: 'NOT_PAIRED', message: 'pairing required', details: { code: 'PAIRING_REQUIRED' } });
            const error = (await connecting.catch((err: unknown) => err)) as GatewayConnectError;
            expect(error.rejection.hint).toMatch(/openclaw devices approve/);
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

        it('drops stale deltas and replaces the shown text with a diverging replacement, mid-stream', async () => {
            const h = await connected();
            const run = send(h);
            const runId = await accepted(h);
            receive(h, 'chat', payloads.delta({ runId, seq: 2 }, 'Hello', 'Hello'));
            receive(h, 'chat', payloads.delta({ runId, seq: 1 }, 'He', 'He'));
            receive(h, 'chat', payloads.delta({ runId, seq: 3 }, 'Goodbye', 'Goodbye', true));
            receive(h, 'chat', payloads.final({ runId, seq: 4 }, 'Goodbye all'));
            expect(run.events.filter((event) => event.type === 'text' || event.type === 'textReplace')).toEqual([
                { type: 'text', text: 'Hello' },
                { type: 'textReplace', text: 'Goodbye' },
                { type: 'text', text: ' all' },
            ]);
        });

        it('replaces the streamed text once with a final text that diverges from it', async () => {
            const h = await connected();
            const run = send(h);
            const runId = await accepted(h);
            receive(h, 'chat', payloads.delta({ runId, seq: 1 }, 'draft', 'draft'));
            receive(h, 'chat', payloads.final({ runId, seq: 2 }, 'final answer'));
            expect(run.events).toEqual([{ type: 'text', text: 'draft' }, { type: 'textReplace', text: 'final answer' }, { type: 'done' }]);
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

        it('reports a rejected send, and holds a send whose answer the dropped connection lost', async () => {
            const h = await connected();
            const rejected = send(h);
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            h.socket().replyError('chat.send', { code: 'INVALID_REQUEST', message: 'invalid chat.send params' });
            await settle();
            expect(rejected.events).toEqual([{ type: 'error', message: 'The gateway rejected the send: gateway rpc error code=INVALID_REQUEST: invalid chat.send params' }, { type: 'done' }]);
            const lost = send(h);
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            h.socket().emit('close', 1006, Buffer.alloc(0));
            await settle();
            // The answer was lost, not refused: the send waits to be re-sent after the reconnect.
            expect(lost.events).toEqual([]);
            expect(h.svc.hasOwnedRun('main')).toBe(true);
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
            expect(h.socket().requests().map((request) => request.method)).toEqual(['connect', 'sessions.subscribe']);
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

        it('says a run started before a reconnect cannot be stopped, and keeps it visible to observers', async () => {
            jest.useFakeTimers();
            const h = await connected();
            const seen: ChatEvent[] = [];
            h.svc.resumeSession(CANONICAL_MAIN, (event) => seen.push(event), { historyRendered: true });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            const run = send(h, CANONICAL_MAIN);
            const runId = await accepted(h);
            h.socket().emit('close', 1006, Buffer.alloc(0));
            h.svc.abort(CANONICAL_MAIN);
            expect(run.events).toEqual([{ type: 'notice', text: expect.stringContaining('It continues on the gateway') }, { type: 'done' }]);
            jest.advanceTimersByTime(1000);
            completeHandshake(h.socket());
            await settle();
            expect(h.socket().requests().map((request) => request.method)).not.toContain('chat.abort');
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            receive(h, 'chat', payloads.final({ runId, seq: 4 }, 'finished anyway'));
            expect(texts(seen)).toBe('finished anyway');
        });

        it('keeps following a run the gateway refused to stop', async () => {
            const h = await connected();
            const seen: ChatEvent[] = [];
            h.svc.resumeSession(CANONICAL_MAIN, (event) => seen.push(event), { historyRendered: true });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            const run = send(h, CANONICAL_MAIN);
            const runId = await accepted(h);
            h.svc.abort(CANONICAL_MAIN);
            h.socket().replyError('chat.abort', { code: 'INVALID_REQUEST', message: 'unauthorized' });
            await settle();
            expect(run.events).toEqual([{ type: 'notice', text: expect.stringContaining('It continues on the gateway') }, { type: 'done' }]);
            receive(h, 'chat', payloads.final({ runId, seq: 2 }, 'still here'));
            expect(texts(seen)).toBe('still here');
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
            expect(h.socket().lastRequest('chat.history').params).toEqual({ sessionKey: CANONICAL_MAIN, cursor: 'cursor-2', maxChars: 500_000 });
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
            expect(h.socket().lastRequest('chat.history').params).toEqual({ sessionKey: CANONICAL_MAIN, maxChars: 500_000 });
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
                expect(harnessed.socket().lastRequest('chat.history').params).toEqual({ sessionKey: CANONICAL_MAIN, maxChars: 500_000 });
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
            expect(h.socket().lastRequest('chat.history').params).toEqual({ sessionKey: CANONICAL_MAIN, maxChars: 500_000 });
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
            expect(count(run.events, 'done')).toBe(1);
            expect(h.svc.hasOwnedRun('main')).toBe(false);
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
            expect(h.socket().lastRequest('chat.history').params).toEqual({ sessionKey: CANONICAL_MAIN, cursor: 'c2', maxChars: 500_000 });
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
            expect(h.socket().requests().map((r) => r.method)).toEqual(['connect', 'sessions.subscribe']);
        });
    });

    describe('history edges', () => {
        it('seeds from a snapshot without cursor or active runs, and with an in-flight run', async () => {
            const h = await connected();
            const seen: ChatEvent[] = [];
            h.svc.seedHistory('main', { messages: [{ role: 'user', text: 'q', entryId: null, seq: null, runId: null, usage: null, truncated: false }], cursor: null, inFlightRunId: 'live', activeRunIds: null, olderPageOffset: null });
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
            const snapshot = (activeRunIds: string[] | null) => ({ messages: [], cursor: null, inFlightRunId: null, activeRunIds, olderPageOffset: null });
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

    describe('review regressions', () => {
        it('re-sends a send the RPC timeout cut off under the same run id, then reports it unconfirmed', async () => {
            jest.useFakeTimers();
            const h = await connected();
            const run = send(h);
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            for (let attempt = 0; attempt < 3; attempt++) {
                jest.advanceTimersByTime(30_000);
                await settle();
            }
            const sends = h.socket().requests().filter((request) => request.method === 'chat.send');
            expect(sends).toHaveLength(3);
            expect(new Set(sends.map((request) => request.params.idempotencyKey)).size).toBe(1);
            expect(run.events).toEqual([{ type: 'error', message: expect.stringContaining('did not confirm the send') }, { type: 'done' }]);
        });

        it('re-sends after a reconnect when the answer to chat.send was lost, and follows the run', async () => {
            jest.useFakeTimers();
            const h = await connected();
            const run = send(h);
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            const runId = String(h.socket().lastRequest('chat.send').params.idempotencyKey);
            h.socket().emit('close', 1006, Buffer.alloc(0));
            await settle();
            expect(run.events).toEqual([]);
            jest.advanceTimersByTime(1000);
            completeHandshake(h.socket());
            await settle();
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            expect(h.socket().lastRequest('chat.send').params.idempotencyKey).toBe(runId);
            h.socket().reply('chat.send', { runId, status: 'in_flight' });
            await settle();
            receive(h, 'chat', payloads.final({ runId, seq: 3 }, 'answer'));
            expect(run.events).toEqual([{ type: 'text', text: 'answer' }, { type: 'done' }]);
        });

        it('retries a retryable refusal after the delay the gateway asked for', async () => {
            jest.useFakeTimers();
            const h = await connected();
            const run = send(h);
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            h.socket().replyError('chat.send', { code: 'UNAVAILABLE', message: 'queue full', retryable: true, retryAfterMs: 2000 });
            await settle();
            jest.advanceTimersByTime(1999);
            expect(h.socket().requests().filter((request) => request.method === 'chat.send')).toHaveLength(1);
            jest.advanceTimersByTime(1);
            expect(h.socket().requests().filter((request) => request.method === 'chat.send')).toHaveLength(2);
            h.socket().replyError('chat.send', { code: 'INVALID_REQUEST', message: 'bad' });
            await settle();
            expect(run.events).toEqual([{ type: 'error', message: 'The gateway rejected the send: gateway rpc error code=INVALID_REQUEST: bad' }, { type: 'done' }]);
        });

        it('does not let a run seen before a drop hold the next send open', async () => {
            jest.useFakeTimers();
            const h = await connected();
            h.svc.resumeSession(CANONICAL_MAIN, () => undefined, { historyRendered: true });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            receive(h, 'chat', payloads.status({ runId: 'foreign', seq: 0 }));
            h.socket().emit('close', 1006, Buffer.alloc(0));
            jest.advanceTimersByTime(1000);
            completeHandshake(h.socket());
            await settle();
            const run = send(h, CANONICAL_MAIN);
            const runId = await accepted(h);
            receive(h, 'chat', payloads.final({ runId, seq: 1 }, 'Done'));
            expect(run.events).toEqual([{ type: 'text', text: 'Done' }, { type: 'done' }]);
        });

        it('forgets the runs of a session nobody observes any more', async () => {
            const h = await connected();
            const sink = (): void => undefined;
            h.svc.resumeSession(CANONICAL_MAIN, sink, { historyRendered: true });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            receive(h, 'chat', payloads.delta({ runId: 'foreign', seq: 1 }, 'x', 'x'));
            h.svc.removeTranscriptSink(CANONICAL_MAIN, sink);
            const run = send(h, CANONICAL_MAIN);
            const runId = await accepted(h);
            receive(h, 'chat', payloads.final({ runId, seq: 1 }, 'Mine'));
            expect(count(run.events, 'done')).toBe(1);
        });

        it('does not finish a run that started while a catch-up read was in flight', async () => {
            const h = await connected();
            h.svc.seedHistory('main', { messages: [], cursor: 'c1', inFlightRunId: null, activeRunIds: [], olderPageOffset: null });
            h.svc.resumeSession('main', () => undefined, { historyRendered: true });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            const historyRequest = h.socket().lastRequest('chat.history');
            const run = send(h, CANONICAL_MAIN);
            const runId = await accepted(h);
            receive(h, 'chat', payloads.delta({ runId, seq: 1 }, 'Hel', 'Hel'));
            h.socket().receive(resultFrame(historyRequest.id, 'chat.history', payloads.historyDelta([{ role: 'user', text: 'hi', seq: 2, runId }], 'c2')));
            await settle();
            receive(h, 'chat', payloads.final({ runId, seq: 2 }, 'Hello world'));
            expect(texts(run.events)).toBe('Hello world');
            expect(count(run.events, 'done')).toBe(1);
        });

        it('does not finish a tracked run that moved on during the read', async () => {
            jest.useFakeTimers();
            const h = await connected();
            const run = send(h);
            const runId = await accepted(h);
            receive(h, 'chat', payloads.delta({ runId, seq: 1 }, 'A', 'A'));
            h.socket().emit('close', 1006, Buffer.alloc(0));
            jest.advanceTimersByTime(1000);
            completeHandshake(h.socket());
            await settle();
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            receive(h, 'chat', payloads.delta({ runId, seq: 2 }, 'AB', 'B'));
            h.socket().reply('chat.history', payloads.historyTail([{ role: 'user', text: 'hello', seq: 1, runId }], { activeRunIds: [] }));
            await settle();
            expect(count(run.events, 'done')).toBe(0);
            receive(h, 'chat', payloads.final({ runId, seq: 3 }, 'ABC'));
            expect(texts(run.events)).toBe('ABC');
        });

        it('replays rows missed during an outage even when a live row overtakes the read', async () => {
            jest.useFakeTimers();
            const h = await connected();
            const seen: ChatEvent[] = [];
            h.svc.seedHistory('main', { messages: [{ role: 'assistant', text: 'old', entryId: null, seq: 9, runId: 'r0', usage: null, truncated: false }], cursor: 'c9', inFlightRunId: null, activeRunIds: [], olderPageOffset: null });
            h.svc.resumeSession('main', (event) => seen.push(event), { historyRendered: true });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            h.socket().reply('chat.history', payloads.historyDelta([], 'c9'));
            await settle();
            h.socket().emit('close', 1006, Buffer.alloc(0));
            jest.advanceTimersByTime(1000);
            completeHandshake(h.socket());
            await settle();
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            receive(h, 'session.message', payloads.sessionMessage({ role: 'user', text: 'next q', seq: 12 }));
            h.socket().reply('chat.history', payloads.historyDelta([
                { role: 'user', text: 'q', seq: 10 },
                { role: 'assistant', text: 'MISSED-REPLY', seq: 11, runId: 'foreign' },
                { role: 'user', text: 'next q', seq: 12 },
            ], 'c12'));
            await settle();
            expect(seen).toEqual([{ type: 'text', text: 'MISSED-REPLY' }, { type: 'done' }]);
        });

        it('waits for an announced restart once, then backs off normally', async () => {
            jest.useFakeTimers();
            const h = await connected();
            receive(h, 'shutdown', { reason: 'restart', restartExpectedMs: 5000 });
            h.socket().emit('close', 1012, Buffer.alloc(0));
            jest.advanceTimersByTime(5000);
            expect(h.sockets).toHaveLength(2);
            h.socket().emit('close', 1006, Buffer.alloc(0));
            await settle();
            jest.advanceTimersByTime(199);
            expect(h.sockets).toHaveLength(2);
            jest.advanceTimersByTime(1);
            expect(h.sockets).toHaveLength(3);
        });
    });

    describe('conformance', () => {
        const truncated = (text: string) => `${text}\n...(truncated)...`;

        it('never lets a truncated transcript row stand in for the streamed reply', async () => {
            const h = await connected();
            const run = send(h);
            const runId = await accepted(h);
            receive(h, 'chat', payloads.delta({ runId, seq: 1 }, 'Long reply, part one', 'Long reply, part one'));
            receive(h, 'session.message', payloads.sessionMessage({ role: 'assistant', text: truncated('Long reply'), seq: 5, runId }));
            receive(h, 'chat', payloads.final({ runId, seq: 2 }, 'Long reply, part one and two'));
            expect(texts(run.events)).toBe('Long reply, part one and two');
        });

        it('finishes a run from a truncated row only with what extends the streamed text', async () => {
            jest.useFakeTimers();
            const h = await connected();
            const run = send(h);
            const runId = await accepted(h);
            receive(h, 'chat', payloads.delta({ runId, seq: 1 }, 'Streamed ', 'Streamed '));
            h.socket().emit('close', 1006, Buffer.alloc(0));
            jest.advanceTimersByTime(1000);
            completeHandshake(h.socket());
            await settle();
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            h.socket().reply('chat.history', payloads.historyTail([{ role: 'assistant', text: truncated('Streamed text that was cut'), seq: 2, runId }], { activeRunIds: [] }));
            await settle();
            expect(texts(run.events)).toBe('Streamed text that was cut');
            expect(count(run.events, 'done')).toBe(1);
        });

        it('marks a replayed row the gateway cut', async () => {
            const h = await connected();
            const seen: ChatEvent[] = [];
            h.svc.resumeSession('main', (event) => seen.push(event));
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            h.socket().reply('chat.history', payloads.historyTail([{ role: 'assistant', text: truncated('cut'), seq: 1, runId: 'r' }]));
            await settle();
            expect(seen[0]).toEqual({ type: 'text', text: 'cut…' });
        });

        it('shows a /btw side answer and a side error as run output', async () => {
            const h = await connected();
            const run = send(h);
            const runId = await accepted(h);
            receive(h, 'chat.side_result', { kind: 'btw', runId, sessionKey: CANONICAL_MAIN, agentId: 'dev', question: 'q', text: 'side answer', isError: false, ts: 1, seq: 1 });
            receive(h, 'chat.side_result', { kind: 'btw', runId, sessionKey: CANONICAL_MAIN, text: 'side failed', isError: true, seq: 2 });
            receive(h, 'chat', payloads.final({ runId, seq: 3 }));
            expect(run.events).toEqual([{ type: 'text', text: 'side answer' }, { type: 'error', message: 'side failed' }, { type: 'done' }]);
        });

        it('shows session.tool updates to observers once, even when the agent stream repeats them', async () => {
            const h = await connected();
            const seen: ChatEvent[] = [];
            h.svc.resumeSession(CANONICAL_MAIN, (event) => seen.push(event), { historyRendered: true });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            const tool = payloads.tool({ runId: 'foreign', seq: 3 }, { phase: 'start', name: 'exec', toolCallId: 't1', args: 'ls' });
            receive(h, 'session.tool', tool);
            receive(h, 'agent', tool);
            expect(seen).toEqual([{ type: 'toolCall', id: 't1', title: 'exec', status: 'running', details: 'ls' }]);
            expect(h.sockets[0].lastRequest('sessions.subscribe').params).toEqual({});
        });

        it('tells listeners when the session index changes', async () => {
            const h = await connected();
            const changed: Array<string | null> = [];
            const stop = h.svc.onSessionsChanged((key) => changed.push(key));
            receive(h, 'sessions.changed', { sessionKey: CANONICAL_MAIN, reason: 'patch', ts: 1 });
            receive(h, 'sessions.changed', { reason: 'refresh' });
            stop();
            receive(h, 'sessions.changed', { reason: 'refresh' });
            expect(changed).toEqual([CANONICAL_MAIN, null]);
        });

        it('refuses a connection that was granted none of the operator scopes', async () => {
            jest.useFakeTimers();
            const h = harness();
            const connecting = h.svc.connect();
            const hello = payloads.helloOk();
            completeHandshake(h.socket(), { ...hello, auth: { role: 'operator', scopes: [] } });
            const error = (await connecting.catch((err: unknown) => err)) as GatewayConnectError;
            expect(error.rejection).toMatchObject({ kind: 'permanent', code: 'MISSING_SCOPE', hint: expect.stringContaining('approve this device') });
            jest.advanceTimersByTime(60_000);
            expect(h.sockets).toHaveLength(1);
        });

        it('ignores traffic of sessions nobody observes, so a later send does not wait for its runs', async () => {
            const h = await connected();
            send(h, CANONICAL_MAIN);
            const first = await accepted(h);
            receive(h, 'chat', payloads.final({ runId: first, seq: 1 }, 'one'));
            receive(h, 'chat', payloads.delta({ runId: 'elsewhere', seq: 1 }, 'x', 'x'));
            receive(h, 'session.message', payloads.sessionMessage({ role: 'assistant', text: 'row', seq: 9, runId: 'elsewhere' }));
            expect(h.svc.captureSessionState(CANONICAL_MAIN)).toBeNull();
            const run = send(h, CANONICAL_MAIN);
            const runId = await accepted(h);
            receive(h, 'chat', payloads.final({ runId, seq: 1 }, 'two'));
            expect(run.events).toEqual([{ type: 'text', text: 'two' }, { type: 'done' }]);
        });

        it('does not make a send wait for a run it only saw as a transcript row', async () => {
            const h = await connected();
            h.svc.resumeSession(CANONICAL_MAIN, () => undefined, { historyRendered: true });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            receive(h, 'session.message', payloads.sessionMessage({ role: 'assistant', text: 'finished elsewhere', seq: 3, runId: 'quiet' }));
            const run = send(h, CANONICAL_MAIN);
            const runId = await accepted(h);
            receive(h, 'chat', payloads.final({ runId, seq: 1 }, 'mine'));
            expect(count(run.events, 'done')).toBe(1);
        });

        it('retries a retryable refusal without a delay after a second, and only while connected', async () => {
            jest.useFakeTimers();
            const h = await connected();
            const run = send(h);
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            h.socket().replyError('chat.send', { code: 'UNAVAILABLE', message: 'busy', retryable: true });
            await settle();
            h.socket().emit('close', 1006, Buffer.alloc(0));
            jest.advanceTimersByTime(999);
            expect(h.sockets[0].requests().filter((request) => request.method === 'chat.send')).toHaveLength(1);
            jest.advanceTimersByTime(1);
            completeHandshake(h.socket());
            await settle();
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            expect(h.socket().requests().filter((request) => request.method === 'chat.send')).toHaveLength(1);
            expect(run.events).toEqual([]);
        });

        it('reports a send the socket could not write, and a refusal without a message', async () => {
            const h = await connected();
            const unwritten = send(h);
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            expect(unwritten.events).toEqual([]);
            h.socket().receive(JSON.stringify({ type: 'res', id: h.socket().lastRequest('chat.send').id, ok: false, error: { code: 'FORBIDDEN' } }));
            await settle();
            expect(unwritten.events[0]).toEqual({ type: 'error', message: 'The gateway rejected the send: gateway rpc error code=FORBIDDEN' });
            const broken = send(h);
            h.socket().send = () => {
                throw new Error('EPIPE');
            };
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            expect(broken.events[0]).toEqual({ type: 'error', message: expect.stringContaining('The message was not sent: gateway rpc send failed method=chat.send EPIPE') });
        });

        it('keeps a bounded memory of the runs it started', async () => {
            const h = await connected();
            for (let i = 0; i < 201; i++) {
                send(h, CANONICAL_MAIN);
                const runId = await accepted(h);
                receive(h, 'chat', payloads.final({ runId, seq: 1 }));
            }
            expect(h.svc.hasOwnedRun(CANONICAL_MAIN)).toBe(false);
        });

        it('ignores a side result without text', async () => {
            const h = await connected();
            const run = send(h);
            const runId = await accepted(h);
            receive(h, 'chat.side_result', { runId, sessionKey: CANONICAL_MAIN, seq: 1 });
            expect(run.events).toEqual([]);
        });

        it('stops paging history at a reset page and at an offset that does not move back', async () => {
            const h = await connected();
            const reset = h.svc.getHistory('main');
            h.socket().reply('chat.history', { ...payloads.historyTail([{ role: 'user', text: 'q', seq: 5 }]), hasMore: true, nextOffset: 3 });
            await settle();
            h.socket().reply('chat.history', payloads.historyReset());
            expect((await reset)?.messages.map((message) => message.text)).toEqual(['q']);
            const stuck = h.svc.getHistory('main');
            h.socket().reply('chat.history', { ...payloads.historyTail([{ role: 'user', text: 'unsequenced' }]), hasMore: true, nextOffset: 3 });
            await settle();
            h.socket().reply('chat.history', { ...payloads.historyTail([{ role: 'user', text: 'older' }]), hasMore: true, nextOffset: 6 });
            await settle();
            h.socket().reply('chat.history', { ...payloads.historyTail([{ role: 'user', text: 'oldest' }]), hasMore: true, nextOffset: 6 });
            expect((await stuck)?.messages.map((message) => message.text)).toEqual(['oldest', 'older', 'unsequenced']);
        });

        it('re-subscribes only sessions that still have sinks after a reconnect', async () => {
            jest.useFakeTimers();
            const h = await connected();
            h.svc.restoreSessionState('agent:idle:main', { cursor: 'c', lastSeq: 1 });
            h.svc.resumeSession(CANONICAL_MAIN, () => undefined, { historyRendered: true });
            h.socket().reply('sessions.messages.subscribe', payloads.subscribed());
            await settle();
            h.socket().emit('close', 1006, Buffer.alloc(0));
            jest.advanceTimersByTime(1000);
            completeHandshake(h.socket());
            await settle();
            expect(h.socket().requests().filter((request) => request.method === 'sessions.messages.subscribe').map((request) => request.params)).toEqual([{ key: CANONICAL_MAIN }]);
        });

        it('pages through the session list', async () => {
            const h = await connected();
            const listing = h.svc.listSessions();
            h.socket().reply('sessions.list', { ...payloads.sessionsList([{ key: 'agent:a:main' }, { key: 'agent:b:main' }]), hasMore: true, nextOffset: 2 });
            await settle();
            expect(h.socket().lastRequest('sessions.list').params).toEqual({ limit: 100, offset: 2 });
            h.socket().reply('sessions.list', { ...payloads.sessionsList([{ key: 'agent:b:main' }, { key: 'agent:c:main' }]), hasMore: false, nextOffset: null });
            expect((await listing).map((session) => session.key)).toEqual(['agent:a:main', 'agent:b:main', 'agent:c:main']);
        });

        it('restores older history pages before the latest one', async () => {
            const h = await connected();
            const reading = h.svc.getHistory('main');
            h.socket().reply('chat.history', { ...payloads.historyTail([{ role: 'user', text: 'q3', seq: 3 }, { role: 'assistant', text: 'a3', seq: 4 }], { cursor: 'c4' }), hasMore: true, nextOffset: 2 });
            await settle();
            expect(h.socket().lastRequest('chat.history').params).toEqual({ sessionKey: 'main', offset: 2, maxChars: 500_000 });
            h.socket().reply('chat.history', { ...payloads.historyTail([{ role: 'user', text: 'q1', seq: 1 }, { role: 'assistant', text: 'a1', seq: 2 }, { role: 'user', text: 'q3', seq: 3 }]), hasMore: false });
            const snapshot = await reading;
            expect(snapshot?.messages.map((message) => message.text)).toEqual(['q1', 'a1', 'q3', 'a3']);
            expect(snapshot?.cursor).toBe('c4');
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
    describe('device identity', () => {
        /** The challenge arrives; the device loads from its store before the connect goes out. */
        async function answerChallenge(h: Harness): Promise<void> {
            h.socket().receive(eventFrame('connect.challenge', payloads.challenge()));
            await settle();
        }

        async function deviceConnected(store: MemoryDeviceStore, hello: Record<string, unknown> = payloads.helloOk()): Promise<Harness> {
            const h = harness({ device: store });
            const connecting = h.svc.connect();
            await answerChallenge(h);
            h.socket().reply('connect', hello);
            await connecting;
            return h;
        }

        function helloIssuing(deviceToken: string): Record<string, unknown> {
            const hello = payloads.helloOk();
            return { ...hello, auth: { ...(hello.auth as Record<string, unknown>), deviceToken } };
        }

        function pairingStates(h: Harness): PairingState[] {
            const states: PairingState[] = [];
            h.svc.onPairingChange((state) => states.push(state));
            return states;
        }

        function pairingRequired(requestId: string): Record<string, unknown> {
            return { code: 'NOT_PAIRED', message: 'pairing required: device is not approved yet', details: { code: 'PAIRING_REQUIRED', reason: 'not-paired', requestId } };
        }

        const tokenMismatch = {
            code: 'INVALID_REQUEST',
            message: 'unauthorized: gateway token mismatch',
            details: { code: 'AUTH_TOKEN_MISMATCH', canRetryWithDeviceToken: true, recommendedNextStep: 'retry_with_device_token' },
        };

        it('signs the challenge with the stored identity, verifiable with its public key', async () => {
            const store = new MemoryDeviceStore();
            const h = await deviceConnected(store);
            const challenge = payloads.challenge();
            const device = h.socket().lastRequest('connect').params.device as Record<string, unknown>;
            expect(device).toMatchObject({ id: store.identity.deviceId, publicKey: store.identity.publicKey, nonce: challenge.nonce, signedAt: challenge.ts });
            const hello = { token: TOKEN, minProtocol: 4, maxProtocol: 4, clientVersion: '0.2.1', platform: process.platform };
            const payload = v4Adapter.deviceAuthPayload(hello, { deviceId: store.identity.deviceId, nonce: String(challenge.nonce), signedAtMs: Number(challenge.ts) });
            const signature = Buffer.from(String(device.signature), 'base64url');
            expect(verify(null, Buffer.from(payload), createPublicKey(store.identity.privateKey), signature)).toBe(true);
        });

        it('keeps the token the gateway issued under its origin, and leaves an unchanged one alone', async () => {
            jest.useFakeTimers();
            const store = new MemoryDeviceStore();
            const h = await deviceConnected(store, helloIssuing('dtok-1'));
            await settle();
            expect(store.tokens.get(GATEWAY_ORIGIN)).toEqual({ deviceId: store.identity.deviceId, role: 'operator', token: 'dtok-1', scopes: expect.any(Array) });
            h.socket().emit('close', 1006, Buffer.alloc(0));
            jest.advanceTimersByTime(1000);
            await answerChallenge(h);
            h.socket().reply('connect', helloIssuing('dtok-1'));
            await settle();
            expect(store.stored).toHaveLength(1);
            expect(h.socket().lastRequest('connect').params.auth).toEqual({ token: TOKEN });
        });

        it('connects as no device when SecretStorage fails, or without a store', async () => {
            const store = new MemoryDeviceStore();
            store.failIdentity = true;
            const h = await deviceConnected(store);
            expect(h.socket().lastRequest('connect').params).not.toHaveProperty('device');
            expect(h.logs).toContainEqual(expect.stringContaining('device identity unavailable'));
            const plain = await connected();
            expect(plain.socket().lastRequest('connect').params).not.toHaveProperty('device');
        });

        it('will not prove a device against a challenge without a timestamp', async () => {
            const h = harness({ device: new MemoryDeviceStore() });
            const connecting = h.svc.connect();
            h.socket().receive(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n-1' } }));
            await expect(connecting).rejects.toThrow(/no usable nonce or timestamp/);
            expect(methods(h.sockets[0])).not.toContain('connect');
        });

        it('waits for a pending approval, asking again at a slow pace, and resumes once approved', async () => {
            jest.useFakeTimers();
            const store = new MemoryDeviceStore();
            const h = harness({ device: store });
            const states = pairingStates(h);
            const connecting = h.svc.connect();
            await answerChallenge(h);
            h.socket().replyError('connect', pairingRequired('req-1'));
            const error = (await connecting.catch((err: unknown) => err)) as GatewayConnectError;
            expect(error.rejection).toMatchObject({ kind: 'pause', pairing: { requestId: 'req-1' } });
            expect(states).toEqual([{ status: 'pending', request: { requestId: 'req-1', reason: 'not-paired' }, hint: expect.stringContaining('openclaw devices approve req-1') }]);
            jest.advanceTimersByTime(4999);
            expect(h.sockets).toHaveLength(1);
            jest.advanceTimersByTime(1);
            expect(h.sockets).toHaveLength(2);
            await answerChallenge(h);
            h.socket().reply('connect', helloIssuing('dtok-approved'));
            await settle();
            expect(h.svc.isRunning).toBe(true);
            expect(states[states.length - 1]).toEqual({ status: 'approved' });
            expect(store.tokens.get(GATEWAY_ORIGIN)?.token).toBe('dtok-approved');
        });

        it('stops asking once the approval wait limit passes, until the next explicit connect', async () => {
            jest.useFakeTimers();
            const h = harness({ device: new MemoryDeviceStore() });
            const states = pairingStates(h);
            h.svc.connect().catch(() => undefined);
            for (let attempt = 0; attempt < 400 && states.every((state) => state.status === 'pending'); attempt++) {
                await answerChallenge(h);
                h.socket().replyError('connect', pairingRequired('req-1'));
                await settle();
                jest.advanceTimersByTime(5000);
            }
            expect(states[states.length - 1]).toMatchObject({ status: 'expired', request: { requestId: 'req-1' } });
            expect(h.sockets.length).toBeGreaterThan(170);
            const attempts = h.sockets.length;
            jest.advanceTimersByTime(60_000);
            expect(h.sockets).toHaveLength(attempts);
            h.svc.connect().catch(() => undefined);
            await answerChallenge(h);
            h.socket().replyError('connect', pairingRequired('req-1'));
            await settle();
            expect(states[states.length - 1]).toMatchObject({ status: 'pending' });
        });

        it('stops a wait_then_retry pairing wait at the limit instead of restarting it on every reconnect', async () => {
            jest.useFakeTimers();
            const h = harness({ device: new MemoryDeviceStore() });
            const states = pairingStates(h);
            const waiting = { code: 'NOT_PAIRED', message: 'pairing required', details: { code: 'PAIRING_REQUIRED', reason: 'not-paired', requestId: 'req-1', recommendedNextStep: 'wait_then_retry', pauseReconnect: false } };
            h.svc.connect().catch(() => undefined);
            for (let attempt = 0; attempt < 1200 && states.every((state) => state.status === 'pending'); attempt++) {
                await answerChallenge(h);
                h.socket().replyError('connect', waiting);
                await settle();
                jest.advanceTimersByTime(1000);
            }
            expect(states[states.length - 1]).toMatchObject({ status: 'expired' });
            const attempts = h.sockets.length;
            jest.advanceTimersByTime(60_000);
            expect(h.sockets).toHaveLength(attempts);
            expect(states.filter((state) => state.status === 'expired')).toHaveLength(1);
        });

        it('ignores the late rejection of a handshake retired by new settings', async () => {
            jest.useFakeTimers();
            const store = new MemoryDeviceStore();
            store.tokens.set('ws://127.0.0.1:18789', { deviceId: store.identity.deviceId, role: 'operator', token: 'dtok-local', scopes: [] });
            store.tokens.set(GATEWAY_ORIGIN, { deviceId: store.identity.deviceId, role: 'operator', token: 'dtok-remote', scopes: [] });
            const h = harness({ device: store, trustsDeviceTokenRetry: true });
            h.svc.connect().catch(() => undefined);
            await answerChallenge(h);
            const retired = h.socket();
            // A real socket reports its close later; the old gateway's answer is still in flight.
            retired.close = (code?: number) => {
                retired.closed.push(code);
            };
            h.svc.updateConnection('ws://127.0.0.1:18789', TOKEN);
            retired.replyError('connect', tokenMismatch);
            await settle();
            jest.advanceTimersByTime(2000);
            await answerChallenge(h);
            expect(h.sockets).toHaveLength(2);
            expect(h.socket().lastRequest('connect').params.auth).toEqual({ token: TOKEN });
        });

        it('retries a refused shared token once with the stored device token, and forgets a refused one', async () => {
            jest.useFakeTimers();
            const store = new MemoryDeviceStore();
            store.tokens.set(GATEWAY_ORIGIN, { deviceId: store.identity.deviceId, role: 'operator', token: 'dtok-old', scopes: ['operator.read'] });
            const h = harness({ device: store, trustsDeviceTokenRetry: true });
            const connecting = h.svc.connect();
            await answerChallenge(h);
            expect(h.socket().lastRequest('connect').params.auth).toEqual({ token: TOKEN });
            h.socket().replyError('connect', tokenMismatch);
            await expect(connecting).rejects.toMatchObject({ rejection: { kind: 'backoff', code: 'AUTH_TOKEN_MISMATCH' } });
            jest.advanceTimersByTime(1000);
            await answerChallenge(h);
            expect(h.socket().lastRequest('connect').params.auth).toEqual({ token: TOKEN, deviceToken: 'dtok-old' });
            h.socket().replyError('connect', { code: 'INVALID_REQUEST', message: 'unauthorized: device token mismatch', details: { code: 'AUTH_DEVICE_TOKEN_MISMATCH' } });
            await settle();
            expect(store.tokens.has(GATEWAY_ORIGIN)).toBe(false);
            jest.advanceTimersByTime(60_000);
            expect(h.sockets).toHaveLength(2);
        });

        it('offers no stored device token to an untrusted endpoint', async () => {
            jest.useFakeTimers();
            const store = new MemoryDeviceStore();
            store.tokens.set(GATEWAY_ORIGIN, { deviceId: store.identity.deviceId, role: 'operator', token: 'dtok-old', scopes: [] });
            const h = harness({ device: store });
            const connecting = h.svc.connect();
            await answerChallenge(h);
            h.socket().replyError('connect', tokenMismatch);
            await expect(connecting).rejects.toMatchObject({ rejection: { kind: 'permanent' } });
            jest.advanceTimersByTime(60_000);
            expect(h.sockets).toHaveLength(1);
        });

        it('stops a run it started before a reconnect, as the same device', async () => {
            jest.useFakeTimers();
            const h = await deviceConnected(new MemoryDeviceStore());
            const run = send(h, CANONICAL_MAIN);
            const runId = await accepted(h);
            h.socket().emit('close', 1006, Buffer.alloc(0));
            jest.advanceTimersByTime(1000);
            await answerChallenge(h);
            h.socket().reply('connect', payloads.helloOk());
            await settle();
            h.svc.abort(CANONICAL_MAIN);
            expect(h.socket().lastRequest('chat.abort').params).toEqual({ sessionKey: CANONICAL_MAIN, runId });
            h.socket().reply('chat.abort', { ok: true, aborted: true, runIds: [runId] });
            await settle();
            expect(run.events).toEqual([{ type: 'done' }]);
        });

        /** A device-proved run, its socket dropped: the cancel happens while disconnected. */
        async function cancelledWhileDown(store: MemoryDeviceStore): Promise<{ h: Harness; run: Send; runId: string }> {
            const h = await deviceConnected(store);
            const run = send(h, CANONICAL_MAIN);
            const runId = await accepted(h);
            h.socket().emit('close', 1006, Buffer.alloc(0));
            h.svc.abort(CANONICAL_MAIN);
            return { h, run, runId };
        }

        async function reconnectAsDevice(h: Harness): Promise<void> {
            jest.advanceTimersByTime(1000);
            await answerChallenge(h);
            h.socket().reply('connect', payloads.helloOk());
            await settle();
        }

        it('holds a cancel made while disconnected and sends it right after the same device reconnects', async () => {
            jest.useFakeTimers();
            const { h, run, runId } = await cancelledWhileDown(new MemoryDeviceStore());
            expect(run.events).toEqual([]);
            await reconnectAsDevice(h);
            expect(h.socket().lastRequest('chat.abort').params).toEqual({ sessionKey: CANONICAL_MAIN, runId });
            expect(send(h, CANONICAL_MAIN).events[0]).toEqual({ type: 'error', message: expect.stringContaining('still aborting') });
            h.socket().reply('chat.abort', { ok: true, aborted: true, runIds: [runId] });
            await settle();
            expect(run.events).toEqual([{ type: 'done' }]);
        });

        it('sends an abort lost with its socket again after the same device reconnects', async () => {
            jest.useFakeTimers();
            const h = await deviceConnected(new MemoryDeviceStore());
            const run = send(h, CANONICAL_MAIN);
            const runId = await accepted(h);
            h.svc.abort(CANONICAL_MAIN);
            expect(methods(h.socket())).toContain('chat.abort');
            h.socket().emit('close', 1006, Buffer.alloc(0));
            await settle();
            expect(run.events).toEqual([]);
            await reconnectAsDevice(h);
            expect(h.socket().lastRequest('chat.abort').params).toEqual({ sessionKey: CANONICAL_MAIN, runId });
            h.socket().reply('chat.abort', { ok: true, aborted: true, runIds: [runId] });
            await settle();
            expect(run.events).toEqual([{ type: 'done' }]);
        });

        it('says the run continues when the gateway refuses the held cancel', async () => {
            jest.useFakeTimers();
            const { h, run } = await cancelledWhileDown(new MemoryDeviceStore());
            await reconnectAsDevice(h);
            h.socket().replyError('chat.abort', { code: 'INVALID_REQUEST', message: 'unauthorized' });
            await settle();
            expect(run.events).toEqual([{ type: 'notice', text: expect.stringContaining('It continues on the gateway') }, { type: 'done' }]);
        });

        it('drops a held cancel when the device identity changes, and says the run continues', async () => {
            jest.useFakeTimers();
            const store = new MemoryDeviceStore();
            const { h, run } = await cancelledWhileDown(store);
            store.identity = generateDeviceIdentity();
            h.svc.resetDeviceIdentity();
            expect(run.events).toEqual([{ type: 'notice', text: expect.stringContaining('It continues on the gateway') }, { type: 'done' }]);
            await reconnectAsDevice(h);
            expect(methods(h.socket())).not.toContain('chat.abort');
        });

        it('gives a held cancel up when no handshake completes in time', async () => {
            jest.useFakeTimers();
            const { h, run } = await cancelledWhileDown(new MemoryDeviceStore());
            jest.advanceTimersByTime(119_000);
            expect(run.events).toEqual([]);
            jest.advanceTimersByTime(1000);
            expect(run.events).toEqual([{ type: 'notice', text: expect.stringContaining('It continues on the gateway') }, { type: 'done' }]);
            expect(h.sockets.every((socket) => !methods(socket).includes('chat.abort'))).toBe(true);
        });

        it('cannot stop a run an earlier identity started, and says so', async () => {
            jest.useFakeTimers();
            const store = new MemoryDeviceStore();
            const h = await deviceConnected(store);
            const run = send(h, CANONICAL_MAIN);
            await accepted(h);
            store.identity = generateDeviceIdentity();
            h.svc.resetDeviceIdentity();
            jest.advanceTimersByTime(1000);
            await answerChallenge(h);
            expect(h.socket().lastRequest('connect').params.device).toMatchObject({ id: store.identity.deviceId });
            h.socket().reply('connect', payloads.helloOk());
            await settle();
            h.svc.abort(CANONICAL_MAIN);
            expect(methods(h.socket())).not.toContain('chat.abort');
            expect(run.events).toEqual([{ type: 'notice', text: expect.stringContaining('It continues on the gateway') }, { type: 'done' }]);
        });
    });
});
