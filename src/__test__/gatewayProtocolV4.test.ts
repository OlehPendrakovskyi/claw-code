/**
 * The protocol v4 adapter, its fixtures and the version registry.
 */

import { v4Adapter } from '../core/gatewayProtocol/v4/adapter';
import { classifyHandshakeRejection } from '../core/gatewayProtocol/v4/errors';
import { describeJson } from '../core/gatewayProtocol/v4/readers';
import { handshakeAdapter, isAdapter, isProtocolSetting, negotiatedAdapter, resolveProtocolSetting } from '../core/gatewayProtocol/registry';
import type { InboundFrame } from '../core/gatewayProtocol/model';
import {
    CANONICAL_MAIN,
    FIXTURE_VERSION,
    assertValidError,
    assertValidEvent,
    assertValidRequest,
    assertValidResult,
    captured,
    capturedPayload,
    eventFrame,
    payloads,
} from './helpers/gatewayV4';

const hello = { token: 'secret', minProtocol: 4, maxProtocol: 4, clientVersion: '0.2.1', platform: 'linux' };

function decodedEvent(frame: string): Extract<InboundFrame, { type: 'event' }>['event'] {
    const decoded = v4Adapter.decodeFrame(frame);
    if (decoded?.type !== 'event') throw new Error('not an event frame');
    return decoded.event;
}

describe('gateway protocol v4', () => {
    describe('fixtures', () => {
        it('were exported from openclaw 2026.9.6 at protocol 4', () => {
            expect(FIXTURE_VERSION).toBe('openclaw 2026.9.6\nprotocol 4');
        });

        it('validate every captured gateway frame against its schema', () => {
            const results: Record<string, string> = {
                helloOk: 'connect',
                subscribeResult: 'sessions.messages.subscribe',
                sessionsListResult: 'sessions.list',
                historyTailResult: 'chat.history',
                historyDeltaResult: 'chat.history',
                chatSendResult: 'chat.send',
            };
            for (const [name, frame] of Object.entries(captured)) {
                if (name === '//') continue;
                if (frame.type === 'event') {
                    expect(() => assertValidEvent(frame.event ?? '', frame.payload)).not.toThrow();
                } else if (frame.ok) {
                    expect(() => assertValidResult(results[name], frame.payload)).not.toThrow();
                } else {
                    expect(() => assertValidError(frame.error)).not.toThrow();
                }
            }
        });

        it('reject the request shapes the gateway refuses', () => {
            const request = (method: string, params: object) => JSON.stringify({ type: 'req', id: 'r1', method, params });
            expect(() => assertValidRequest(request('sessions.messages.subscribe', { sessionKeys: ['main'] }))).toThrow(/must have required property 'key'/);
            expect(() => assertValidRequest(request('chat.send', { sessionKey: 'main', text: 'hi', queueMode: 'enqueue' }))).toThrow(/idempotencyKey/);
            expect(() => assertValidRequest(request('chat.history', { sessionKey: 'main', deltaCursor: 'c' }))).toThrow(/additional properties/);
        });
    });

    describe('requests', () => {
        it('frame a connect the gateway accepts: closed client enums, tool events, approvals and the operator scopes', () => {
            const frame = assertValidRequest(v4Adapter.encodeRequest('cc-1', v4Adapter.connectRequest(hello)));
            expect(frame.params).toEqual({
                minProtocol: 4,
                maxProtocol: 4,
                client: { id: 'gateway-client', displayName: 'Claw Code', version: '0.2.1', platform: 'linux', mode: 'backend' },
                caps: ['tool-events', 'session-scoped-events', 'approvals'],
                role: 'operator',
                scopes: ['operator.read', 'operator.write', 'operator.approvals', 'operator.questions'],
                auth: { token: 'secret' },
                userAgent: 'claw-code/0.2.1',
            });
        });

        it('frame a connect with a device proof the connect schema accepts, and sign what it sends', () => {
            const device = { deviceId: 'a'.repeat(64), publicKey: 'cHVibGlj', signature: 'c2ln', signedAtMs: 1790605209429, nonce: 'n-1' };
            const frame = assertValidRequest(v4Adapter.encodeRequest('cc-1', v4Adapter.connectRequest({ ...hello, deviceToken: 'dt' }, device)));
            expect(frame.params).toMatchObject({
                auth: { token: 'secret', deviceToken: 'dt' },
                device: { id: 'a'.repeat(64), publicKey: 'cHVibGlj', signature: 'c2ln', signedAt: 1790605209429, nonce: 'n-1' },
            });
            const payload = v4Adapter.deviceAuthPayload({ ...hello, platform: ' Linux' }, { deviceId: 'd1', nonce: 'n-1', signedAtMs: 5 });
            const scopes = (frame.params.scopes as string[]).join(',');
            expect(payload).toBe(`v3|d1|gateway-client|backend|operator|${scopes}|5|secret|n-1|linux|`);
        });

        it('send the message under an idempotency key that becomes the run id, without a queue mode', () => {
            const frame = assertValidRequest(v4Adapter.encodeRequest('cc-2', v4Adapter.sendRequest({ sessionKey: CANONICAL_MAIN, text: 'hi', runId: 'run-1' })));
            expect(frame).toMatchObject({ method: 'chat.send', params: { sessionKey: CANONICAL_MAIN, message: 'hi', idempotencyKey: 'run-1' } });
            expect(frame.params).not.toHaveProperty('queueMode');
        });

        it('attach files base64-encoded, sized exactly as the budget predicts', () => {
            const base = { sessionKey: CANONICAL_MAIN, text: 'look', runId: 'run-1' };
            const files = [
                { name: 'shot "1".png', mimeType: 'image/png', data: Buffer.alloc(1000, 7) },
                { name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('ünïcode') },
            ];
            const bare = v4Adapter.encodeRequest('cc-3', v4Adapter.sendRequest(base));
            const full = v4Adapter.encodeRequest('cc-3', v4Adapter.sendRequest({ ...base, attachments: files }));
            const frame = assertValidRequest(full);
            expect(frame.params.attachments).toEqual([
                expect.objectContaining({ type: 'image', mimeType: 'image/png', fileName: 'shot "1".png', sizeBytes: 1000, content: Buffer.alloc(1000, 7).toString('base64') }),
                expect.objectContaining({ type: 'file', fileName: 'notes.txt', sizeBytes: Buffer.byteLength('ünïcode'), origin: 'file' }),
            ]);
            const predicted = files.reduce((sum, { name, mimeType, data }) => sum + v4Adapter.attachmentWireBytes({ name, mimeType, byteLength: data.byteLength }), 0);
            // The attachments list itself: `,"attachments":[` + `]`, minus the separator the first item does not need.
            const listOverhead = Buffer.byteLength(',"attachments":[]') - 1;
            expect(Buffer.byteLength(full) - Buffer.byteLength(bare)).toBe(predicted + listOverhead);
        });

        it('leave attachments out of a send without files', () => {
            expect(v4Adapter.sendRequest({ sessionKey: 'k', text: 't', runId: 'r', attachments: [] }).params).not.toHaveProperty('attachments');
        });

        it('name the session by `key` for subscriptions and pass the history cursor as `cursor`', () => {
            const requests = [
                v4Adapter.subscribeRequest({ sessionKey: 'main' }),
                v4Adapter.unsubscribeRequest({ sessionKey: CANONICAL_MAIN }),
                v4Adapter.historyRequest({ sessionKey: CANONICAL_MAIN, cursor: 'c1' }),
                v4Adapter.historyRequest({ sessionKey: 'main' }),
                v4Adapter.historyRequest({ sessionKey: 'main', olderPageOffset: 200 }),
                v4Adapter.abortRequest({ sessionKey: CANONICAL_MAIN, runId: 'run-1' }),
                v4Adapter.listRequest({}),
                v4Adapter.listRequest({ offset: 100 }),
                v4Adapter.sessionEventsRequest(),
            ].map((wire, index) => assertValidRequest(v4Adapter.encodeRequest(`cc-${index}`, wire)));
            expect(requests.map((request) => request.params)).toEqual([
                { key: 'main' },
                { key: CANONICAL_MAIN },
                { sessionKey: CANONICAL_MAIN, cursor: 'c1', maxChars: 500_000 },
                { sessionKey: 'main', maxChars: 500_000 },
                { sessionKey: 'main', offset: 200, maxChars: 500_000 },
                { sessionKey: CANONICAL_MAIN, runId: 'run-1' },
                { limit: 100 },
                { limit: 100, offset: 100 },
                {},
            ]);
        });
    });

    describe('hello', () => {
        it('reads the device token the gateway issued', () => {
            const payload = { ...capturedPayload('helloOk'), auth: { role: 'operator', scopes: ['operator.read'], deviceToken: 'dtok', issuedAtMs: 1 } };
            assertValidResult('connect', payload);
            expect(v4Adapter.parseHello(payload)?.deviceToken).toBe('dtok');
        });

        it('reads protocol, server, limits, features and grants from a real hello-ok', () => {
            const accepted = v4Adapter.parseHello(capturedPayload('helloOk'));
            expect(accepted).toMatchObject({
                deviceToken: null,
                protocolVersion: 4,
                serverVersion: '2026.9.6',
                role: 'operator',
                scopes: ['operator.read', 'operator.write'],
                limits: {
                    maxPayloadBytes: 26214400,
                    maxBufferedBytes: 52428800,
                    attachmentMaxBytes: 19464192,
                    attachmentMaxImageBytes: 6291456,
                    tickIntervalMs: 30000,
                },
            });
            expect(accepted && v4Adapter.missingOperations(accepted.features)).toEqual([]);
            expect(accepted?.features.capabilities.has('profile-binding-v1')).toBe(true);
        });

        it('reads the main-session alias from the snapshot', () => {
            expect(v4Adapter.parseHello(capturedPayload('helloOk'))?.sessionAliases).toEqual(new Map([['main', CANONICAL_MAIN]]));
            expect(v4Adapter.parseHello({ type: 'hello-ok', protocol: 4, snapshot: {} })?.sessionAliases.size).toBe(0);
        });

        it('keeps a default for each malformed limit and caps the image limit at the attachment limit', () => {
            const accepted = v4Adapter.parseHello(payloads.helloOk({ policy: { maxPayload: 1000, maxBufferedBytes: 2000, tickIntervalMs: 5000, attachments: { maxBytes: 100, maxImageBytes: 500 } } }));
            expect(accepted?.limits).toEqual({ maxPayloadBytes: 1000, maxBufferedBytes: 2000, attachmentMaxBytes: 100, attachmentMaxImageBytes: 100, tickIntervalMs: 5000 });
            expect(v4Adapter.parseHello({ type: 'hello-ok', protocol: 4, policy: { maxPayload: -1 } })?.limits.maxPayloadBytes).toBe(25 * 1024 * 1024);
        });

        it('is not a hello without the hello-ok type and a protocol', () => {
            expect(v4Adapter.parseHello({ type: 'hello', protocol: 4 })).toBeNull();
            expect(v4Adapter.parseHello({ type: 'hello-ok' })).toBeNull();
        });

        it('lists the operations a gateway without them cannot serve', () => {
            const accepted = v4Adapter.parseHello(payloads.helloOk({ methods: ['chat.send', 'sessions.list'] }));
            expect(accepted && v4Adapter.missingOperations(accepted.features)).toEqual(['subscribe', 'history']);
        });
    });

    describe('events', () => {
        it('reads deltas with their cumulative snapshot and replace flag', () => {
            expect(decodedEvent(JSON.stringify(captured.chatDelta2))).toEqual({
                kind: 'runDelta',
                runId: 'probe-run-2',
                sessionKey: CANONICAL_MAIN,
                seq: 7,
                deltaText: '  Activ',
                replace: false,
                snapshotText: 'Echo:  Activ',
            });
            expect(decodedEvent(eventFrame('chat', payloads.delta({ runId: 'r', seq: 1 }, 'new', 'new', true)))).toMatchObject({ replace: true });
        });

        it('reads final, aborted, error and status events', () => {
            expect(decodedEvent(JSON.stringify(captured.chatFinal))).toEqual({
                kind: 'runFinal',
                runId: 'probe-run-2',
                sessionKey: CANONICAL_MAIN,
                seq: 13,
                text: 'Echo:  Active Subagents\\nnone"',
                usage: null,
            });
            expect(decodedEvent(JSON.stringify(captured.chatErrorFirst))).toMatchObject({ kind: 'runError', errorMessage: 'No route-compatible authentication source is configured for openai.' });
            expect(decodedEvent(eventFrame('chat', payloads.aborted({ runId: 'r', seq: 2 })))).toMatchObject({ kind: 'runAborted', text: null });
            expect(decodedEvent(JSON.stringify(captured.chatStatus))).toMatchObject({ kind: 'runStatus', runId: 'probe-run-2' });
        });

        it('reads transcript messages with sequence, run and usage', () => {
            expect(decodedEvent(JSON.stringify(captured.sessionMessageAssistant))).toEqual({
                kind: 'transcriptMessage',
                sessionKey: CANONICAL_MAIN,
                message: {
                    role: 'assistant',
                    text: 'Echo:  Active Subagents\\nnone"',
                    entryId: '0cbea3ed-7bfe-4581-b732-eec38f16e472',
                    seq: 10,
                    runId: 'probe-run-2',
                    usage: { promptTokens: 11, completionTokens: 5, totalTokens: 16 },
                    truncated: false,
                },
            });
            expect(decodedEvent(JSON.stringify(captured.sessionMessageUser))).toMatchObject({ message: { role: 'user', runId: 'probe-run-2', seq: 9 } });
        });

        it('takes the run of an assistant row from its bare idempotency key', () => {
            const payload = payloads.sessionMessage({ role: 'assistant', text: 'x', seq: 1 });
            const message = { ...(payload.message as object), __openclaw: { seq: 1, idempotencyKey: 'run-7' } };
            expect(decodedEvent(eventFrame('session.message', { ...payload, message }))).toMatchObject({ message: { runId: 'run-7' } });
        });

        it('strips the truncation marker and flags the row', () => {
            const frame = eventFrame('session.message', payloads.sessionMessage({ role: 'assistant', text: 'start\n...(truncated)...', seq: 1 }));
            expect(decodedEvent(frame)).toMatchObject({ message: { text: 'start', truncated: true } });
        });

        it('reads the tool stream of agent events and ignores the other streams', () => {
            const start = payloads.tool({ runId: 'r', seq: 3 }, { phase: 'start', name: 'exec', toolCallId: 't1', args: { command: 'ls' } });
            const result = payloads.tool({ runId: 'r', seq: 4 }, { phase: 'result', name: 'exec', toolCallId: 't1', isError: true, result: 'denied' });
            expect(decodedEvent(eventFrame('agent', start))).toEqual({
                kind: 'toolUpdate',
                runId: 'r',
                sessionKey: CANONICAL_MAIN,
                seq: 3,
                toolCallId: 't1',
                name: 'exec',
                status: 'running',
                details: '{\n  "command": "ls"\n}',
                awaitingApproval: null,
            });
            expect(decodedEvent(eventFrame('agent', result))).toMatchObject({ status: 'error', details: 'denied' });
            expect(decodedEvent(eventFrame('agent', { ...start, stream: 'lifecycle' }))).toBeNull();
        });

        it('keeps the tick interval a valid timer delay for a two-tick watchdog', () => {
            const tick = (tickIntervalMs: number) => v4Adapter.parseHello(payloads.helloOk({ tickIntervalMs }))?.limits.tickIntervalMs;
            expect(tick(1)).toBe(1000);
            expect(tick(2 ** 40)).toBe(Math.floor((2 ** 31 - 1) / 2));
        });

        it('caps the restart wait a shutdown announces', () => {
            expect(decodedEvent(eventFrame('shutdown', { reason: 'restart', restartExpectedMs: 2 ** 40 }))).toEqual({ kind: 'shutdown', reason: 'restart', restartExpectedMs: 300_000 });
        });

        it('reads keepalive, shutdown and challenge, and ignores events it does not consume', () => {
            expect(decodedEvent(JSON.stringify(captured.tick))).toEqual({ kind: 'keepalive' });
            expect(decodedEvent(eventFrame('shutdown', { reason: 'restart', restartExpectedMs: 5000 }))).toEqual({ kind: 'shutdown', reason: 'restart', restartExpectedMs: 5000 });
            expect(decodedEvent(JSON.stringify(captured.connectChallenge))).toEqual({ kind: 'challenge', nonce: '3895d967-2424-485f-b3ca-94c44c444afd', issuedAtMs: 1790606195482 });
            expect(decodedEvent(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 7, ts: -1 } }))).toEqual({ kind: 'challenge', nonce: null, issuedAtMs: null });
            expect(decodedEvent(JSON.stringify({ type: 'event', event: 'presence', payload: {} }))).toBeNull();
        });

        it('never throws on malformed frames', () => {
            const junk = ['', 'not json', 'null', '[]', '{"type":"res"}', '{"type":"event"}', '{"type":"event","event":"chat","payload":{"state":"delta"}}',
                '{"type":"event","event":"session.message","payload":{"sessionKey":"k","message":5}}', '{"type":"event","event":"agent","payload":{"stream":"tool","data":null}}'];
            for (const raw of junk) {
                expect(() => v4Adapter.decodeFrame(raw)).not.toThrow();
            }
            expect(v4Adapter.decodeFrame('{"type":"event","event":"chat","payload":{"state":"delta"}}')).toEqual({ type: 'event', connectionSeq: null, event: null });
        });
    });

    describe('results', () => {
        it('reads the canonical key of a real subscription and the run id of a real ack', () => {
            expect(v4Adapter.parseSubscription(capturedPayload('subscribeResult'))).toEqual({ canonicalKey: CANONICAL_MAIN });
            expect(v4Adapter.parseSendAccepted(capturedPayload('chatSendResult'))).toEqual({ runId: 'probe-run-2' });
            expect(v4Adapter.parseSubscription({ subscribed: false, key: 'k' })).toBeNull();
        });

        it('reads a real tail, a real delta and a reset', () => {
            const tail = v4Adapter.parseHistory(capturedPayload('historyTailResult'));
            expect(tail).toMatchObject({ cursor: expect.any(String), inFlightRunId: null, activeRunIds: [] });
            expect(tail && 'messages' in tail && tail.messages.map((m) => [m.role, m.seq, m.runId])).toEqual([
                ['user', 1, 'probe-run-1'],
                ['other', 2, 'probe-run-1'],
                ['user', 3, expect.any(String)],
                ['assistant', 4, expect.any(String)],
                ['user', 5, expect.any(String)],
                ['assistant', 6, expect.any(String)],
                ['user', 7, expect.any(String)],
                ['assistant', 8, expect.any(String)],
            ]);
            const delta = v4Adapter.parseHistory(capturedPayload('historyDeltaResult'));
            expect(delta && 'messages' in delta && delta.messages.map((m) => [m.role, m.seq])).toEqual([['user', 9], ['assistant', 10]]);
            expect(v4Adapter.parseHistory({ kind: 'reset' })).toEqual({ reset: true });
            expect(v4Adapter.parseHistory({ kind: 'delta', messages: [] })).toBeNull();
        });

        it('reads a real session row, activity in epoch milliseconds', () => {
            expect(v4Adapter.parseSessionList(capturedPayload('sessionsListResult'))?.sessions).toEqual([
                { key: CANONICAL_MAIN, label: 'Hello from probe', agentId: 'dev', hasActiveRun: false, lastActivityMs: expect.any(Number), cold: false },
            ]);
            expect(v4Adapter.parseSessionList({ sessions: [{ key: 'agent:a:main', placement: { state: 'reclaimed' }, updatedAt: 5, lastActivityAt: 9 }, { label: 'no key' }] })?.sessions).toEqual([
                { key: 'agent:a:main', label: null, agentId: null, hasActiveRun: false, lastActivityMs: 9, cold: true },
            ]);
            expect(v4Adapter.parseSessionList({ rows: [] })).toBeNull();
        });
    });

    describe('handshake rejections', () => {
        it('stops on the real token mismatch and protocol mismatch', () => {
            expect(classifyHandshakeRejection(captured.tokenMismatchRejection.error)).toMatchObject({ kind: 'permanent', code: 'AUTH_TOKEN_MISMATCH' });
            expect(classifyHandshakeRejection(captured.protocolMismatchRejection.error)).toMatchObject({
                kind: 'permanent',
                code: 'PROTOCOL_MISMATCH',
                hint: expect.stringContaining('openclaw.gateway.protocolVersion'),
            });
        });

        it('pauses for a pairing approval, but backs off when the gateway says to wait and retry', () => {
            expect(classifyHandshakeRejection({ code: 'NOT_PAIRED', message: 'pairing required', details: { code: 'PAIRING_REQUIRED' } })).toMatchObject({ kind: 'pause', throttled: true });
            expect(classifyHandshakeRejection({ code: 'NOT_PAIRED', message: 'pairing required', details: { code: 'PAIRING_REQUIRED', recommendedNextStep: 'wait_then_retry' } })).toMatchObject({ kind: 'backoff', throttled: true });
        });

        it('names the pairing request and the command that approves it', () => {
            const error = {
                code: 'NOT_PAIRED',
                message: 'pairing required: device is asking for more scopes than currently approved',
                details: { code: 'PAIRING_REQUIRED', reason: 'scope-upgrade', requestId: 'req-7', remediationHint: 'Review the requested scopes, then approve the pending upgrade.', deviceId: 'd1', requestedRole: 'operator' },
            };
            assertValidError(error);
            const rejection = classifyHandshakeRejection(error);
            expect(rejection).toMatchObject({ kind: 'pause', pairing: { requestId: 'req-7', reason: 'scope-upgrade' } });
            expect(rejection.hint).toContain("approve this device's scope upgrade: run `openclaw devices approve req-7`");
        });

        it('points at the pending list when the pairing request id is missing or unsafe to echo', () => {
            for (const requestId of [undefined, 'bad id; rm -rf', '']) {
                const rejection = classifyHandshakeRejection({ code: 'NOT_PAIRED', message: 'pairing required', details: { code: 'PAIRING_REQUIRED', requestId, reason: 'bogus' } });
                expect(rejection.pairing).toEqual({ requestId: null, reason: null });
                expect(rejection.hint).toContain('`openclaw devices list`, then `openclaw devices approve <requestId>`');
            }
        });

        it('reads an inherited object key as no pairing reason', () => {
            const rejection = classifyHandshakeRejection({ code: 'NOT_PAIRED', message: 'pairing required', details: { code: 'PAIRING_REQUIRED', requestId: 'req-7', reason: 'constructor' } });
            expect(rejection.pairing).toEqual({ requestId: 'req-7', reason: null });
            expect(rejection.hint).not.toContain('native code');
        });

        it('offers the device token retry the gateway suggests, and flags a refused device token', () => {
            const tokenMismatch = { code: 'INVALID_REQUEST', message: 'unauthorized', details: { code: 'AUTH_TOKEN_MISMATCH', canRetryWithDeviceToken: true, recommendedNextStep: 'retry_with_device_token' } };
            expect(classifyHandshakeRejection(tokenMismatch)).toMatchObject({ kind: 'permanent', deviceTokenRetry: true });
            expect(classifyHandshakeRejection(captured.tokenMismatchRejection.error).deviceTokenRetry).toBe(true);
            const deviceMismatch = classifyHandshakeRejection({ code: 'INVALID_REQUEST', message: 'unauthorized', details: { code: 'AUTH_DEVICE_TOKEN_MISMATCH' } });
            expect(deviceMismatch).toMatchObject({ kind: 'permanent', staleDeviceToken: true });
            expect(deviceMismatch.deviceTokenRetry).toBeUndefined();
        });

        it('tells a missing device identity from a rejected device signature', () => {
            const missing = classifyHandshakeRejection({ code: 'NOT_PAIRED', message: 'device identity required', details: { code: 'DEVICE_IDENTITY_REQUIRED' } });
            expect(missing).toMatchObject({ kind: 'permanent', hint: expect.stringContaining('SecretStorage') });
            for (const code of ['DEVICE_AUTH_SIGNATURE_INVALID', 'DEVICE_AUTH_SIGNATURE_EXPIRED', 'DEVICE_AUTH_NONCE_MISMATCH', 'DEVICE_AUTH_DEVICE_ID_MISMATCH']) {
                const rejected = classifyHandshakeRejection({ code: 'INVALID_REQUEST', message: 'device signature invalid', details: { code, reason: 'device-signature' } });
                expect(rejected).toMatchObject({ kind: 'permanent', hint: expect.stringContaining('Reset Gateway Device Identity') });
            }
        });

        it('backs off on a top-level INVALID_REQUEST with an unknown detail code, and on startup', () => {
            expect(classifyHandshakeRejection({ code: 'INVALID_REQUEST', message: 'x', details: { code: 'SOMETHING_NEW' } })).toMatchObject({ kind: 'backoff', code: 'SOMETHING_NEW' });
            expect(classifyHandshakeRejection({ code: 'UNAVAILABLE', message: 'starting', retryAfterMs: 1500, details: { reason: 'startup-sidecars' } })).toMatchObject({ kind: 'backoff', retryAfterMs: 1500 });
        });

        it('stops on a bare INVALID_REQUEST, FORBIDDEN, scope and configuration failures', () => {
            expect(classifyHandshakeRejection({ code: 'INVALID_REQUEST', message: 'bad connect' }).kind).toBe('permanent');
            expect(classifyHandshakeRejection({ code: 'FORBIDDEN', message: 'no' }).kind).toBe('permanent');
            expect(classifyHandshakeRejection({ code: 'INVALID_REQUEST', message: 'x', details: { code: 'AUTH_SCOPE_MISMATCH' } }).kind).toBe('permanent');
            expect(classifyHandshakeRejection({ code: 'INVALID_REQUEST', message: 'x', details: { code: 'CONTROL_UI_ORIGIN_NOT_ALLOWED' } }).kind).toBe('permanent');
            expect(classifyHandshakeRejection({ code: 'INVALID_REQUEST', message: 'x', details: { code: 'X', recommendedNextStep: 'update_auth_credentials' } }).kind).toBe('permanent');
        });

        it('throttles rate limits and caps absurd retry delays', () => {
            expect(classifyHandshakeRejection({ code: 'UNAVAILABLE', message: 'locked', details: { code: 'AUTH_RATE_LIMITED' } })).toMatchObject({ kind: 'backoff', throttled: true });
            expect(classifyHandshakeRejection({ code: 'UNAVAILABLE', message: 'x', retryAfterMs: 1e20 }).retryAfterMs).toBe(5 * 60_000);
            expect(classifyHandshakeRejection({ code: 'UNAVAILABLE', message: 'x', details: { retryAfterMs: 86_400_000 } }).retryAfterMs).toBe(5 * 60_000);
            expect(v4Adapter.parseRpcFailure({ code: 'UNAVAILABLE', message: 'busy', retryable: true, retryAfterMs: 86_400_000 }).retryAfterMs).toBe(60_000);
        });

        it('tolerates junk', () => {
            for (const junk of [undefined, null, 'x', 5, [], { code: 7, details: 'y' }]) {
                expect(classifyHandshakeRejection(junk)).toMatchObject({ kind: 'backoff', code: 'unknown' });
            }
        });
    });

    describe('hostile input', () => {
        it('ignores chat states it does not know and history without rows', () => {
            expect(decodedEvent(JSON.stringify({ type: 'event', event: 'chat', payload: { runId: 'r', sessionKey: 'k', seq: 1, state: 'thinking' } }))).toBeNull();
            expect(v4Adapter.parseHistory({ sessionKey: 'main' })).toBeNull();
            expect(v4Adapter.parseHistory(null)).toBeNull();
        });

        it('reads no usage from fields it does not know', () => {
            const frame = eventFrame('session.message', payloads.sessionMessage({ role: 'assistant', text: 'x', seq: 1, usage: { cacheRead: 5 } }));
            expect(decodedEvent(frame)).toMatchObject({ message: { usage: null } });
        });

        it('shows unserializable and oversized tool payloads safely', () => {
            const bigint = decodedEvent(JSON.stringify({ type: 'event', event: 'agent', payload: { runId: 'r', seq: 1, stream: 'tool', ts: 1, data: { phase: 'result', toolCallId: 't', result: 'y'.repeat(5000) } } }));
            expect(bigint).toMatchObject({ name: 'tool', details: `${'y'.repeat(4000)}…` });
            const cyclic: Record<string, unknown> = {};
            cyclic.self = cyclic;
            expect(describeJson(cyclic, 100)).toBe('[unserializable]');
            expect(describeJson(() => 1, 100)).toBe('');
        });

        it('classifies a bare NOT_PAIRED, a configuration review and junk RPC errors', () => {
            expect(classifyHandshakeRejection({ code: 'NOT_PAIRED', message: 'pair' })).toMatchObject({ kind: 'pause' });
            expect(classifyHandshakeRejection({ code: 'UNAVAILABLE', message: 'x', details: { code: 'X', recommendedNextStep: 'review_auth_configuration' } })).toMatchObject({ kind: 'permanent' });
            expect(classifyHandshakeRejection({ code: 'UNAVAILABLE', message: 'x', details: { code: 'X' } })).toMatchObject({ kind: 'backoff' });
            expect(v4Adapter.parseRpcFailure({ code: 'UNAVAILABLE', message: 'busy', retryable: true, retryAfterMs: 250 })).toEqual({ code: 'UNAVAILABLE', message: 'busy', retryable: true, retryAfterMs: 250 });
            expect(v4Adapter.parseRpcFailure({ code: 'INVALID_REQUEST', message: 'x'.repeat(400) }).message).toBe(`${'x'.repeat(300)}…`);
            expect(v4Adapter.parseRpcFailure('junk')).toEqual({ code: 'unknown', message: '', retryable: false });
        });

        it('reads what it can from sparse frames', () => {
            const event = (name: string, payload: object) => decodedEvent(JSON.stringify({ type: 'event', event: name, payload }));
            expect(event('chat', { runId: 'r', sessionKey: 'k', seq: 1, state: 'delta' })).toBeNull();
            expect(event('agent', { runId: 'r', seq: 1, stream: 'tool', data: { phase: 'update', toolCallId: 't' } })).toMatchObject({ details: '', sessionKey: null });
            expect(event('shutdown', {})).toEqual({ kind: 'shutdown', reason: 'shutdown', restartExpectedMs: null });
            expect(event('session.message', { sessionKey: 'k', message: { role: 'assistant', content: [{ type: 'text', text: 5 }, { type: 'image' }] } })).toMatchObject({ message: { text: '', seq: null, runId: null } });
            expect(v4Adapter.parseSendAccepted({ status: 'started' })).toBeNull();
            expect(v4Adapter.abortRequest({ sessionKey: 'k' }).params).toEqual({ sessionKey: 'k' });
            expect(v4Adapter.parseSessionList({ sessions: [{ key: 'agent:a:main' }] })).toEqual({ sessions: [{ key: 'agent:a:main', label: null, agentId: null, hasActiveRun: false, lastActivityMs: null, cold: false }], nextOffset: null });
            expect(v4Adapter.parseHistory({ kind: 'delta', messages: [7, { sessionKey: 'k' }], deltaCursor: 'c', sessionInfo: {}, inFlightRun: { runId: 'r' } })).toEqual({ messages: [], cursor: 'c', inFlightRunId: 'r', activeRunIds: null, olderPageOffset: null });
            expect(classifyHandshakeRejection({ code: 'UNAVAILABLE', message: 'x', details: { code: 'AUTHENTICATED_PROFILE_UNAVAILABLE' } })).toMatchObject({ kind: 'backoff' });
        });

        it('falls back to the default limits', () => {
            expect(v4Adapter.defaultLimits()).toEqual({
                maxPayloadBytes: 25 * 1024 * 1024,
                maxBufferedBytes: 50 * 1024 * 1024,
                attachmentMaxBytes: 20 * 1024 * 1024,
                attachmentMaxImageBytes: 6 * 1024 * 1024,
                tickIntervalMs: 30_000,
            });
        });
    });

    describe('registry', () => {
        it('offers every supported version for auto and exactly one for a number', () => {
            expect(resolveProtocolSetting('auto')).toEqual({ min: 4, max: 4 });
            expect(resolveProtocolSetting('4')).toEqual({ min: 4, max: 4 });
            expect(handshakeAdapter({ min: 4, max: 4 })).toBe(v4Adapter);
            expect(() => handshakeAdapter({ min: 5, max: 5 })).toThrow('gateway protocol 5 is not supported');
        });

        it('recognizes the settings package.json declares', () => {
            const declared = (require('../../package.json') as { contributes: { configuration: { properties: Record<string, { enum: string[] }> } } })
                .contributes.configuration.properties['openclaw.gateway.protocolVersion'].enum;
            expect(declared.every(isProtocolSetting)).toBe(true);
            expect(isProtocolSetting('5')).toBe(false);
            expect(isProtocolSetting(4)).toBe(false);
        });

        it('picks the adapter of the negotiated version and rejects one outside the offer', () => {
            expect(negotiatedAdapter({ min: 4, max: 4 }, 4)).toBe(v4Adapter);
            const mismatch = negotiatedAdapter({ min: 4, max: 4 }, 5);
            expect(isAdapter(mismatch)).toBe(false);
            expect(mismatch).toMatchObject({ kind: 'permanent', code: 'PROTOCOL_MISMATCH', hint: expect.stringContaining('update the extension or the gateway') });
        });
    });
});
