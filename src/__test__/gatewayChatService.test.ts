/**
 * Unit tests for GatewayChatService with a mock WebSocket transport.
 */

import { DEFAULT_SESSION_KEY, GatewayChatService, WebSocketLike } from '../core/gatewayChatService';
import { GatewayConnectError } from '../core/gatewayHandshake';
import type { ChatEvent } from '../chat/ChatService';

jest.mock('ws', () => jest.fn());

type MockSocket = WebSocketLike & {
  handlers: Map<string, Array<(...args: unknown[]) => void>>;
  sent: string[];
  emit(event: string, ...args: unknown[]): void;
};

function createMockWs(): MockSocket {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const ws: MockSocket = {
    handlers,
    sent: [],
    send(data: string) {
      ws.sent.push(data);
    },
    close() {
      handlers.get('close')?.forEach((cb) => cb(1000, Buffer.alloc(0)));
    },
    on(event: string, cb: (...args: never[]) => void) {
      const list = handlers.get(event) ?? [];
      list.push(cb as (...args: unknown[]) => void);
      handlers.set(event, list);
    },
    removeListener(event: string, cb: (...args: unknown[]) => void) {
      handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== cb));
    },
    emit(event: string, ...args: unknown[]) {
      for (const cb of [...(handlers.get(event) ?? [])]) {
        cb(...args);
      }
    },
  };
  return ws;
}

/** A shared-token mismatch exactly as the 2026.9 gateway sends it (connect-auth.ts rejectUnauthorized). */
const TOKEN_MISMATCH_ERROR = {
  code: 'INVALID_REQUEST',
  message: 'unauthorized: gateway token mismatch (set gateway.remote.token to match gateway.auth.token)',
  details: {
    code: 'AUTH_TOKEN_MISMATCH',
    authReason: 'token_mismatch',
    canRetryWithDeviceToken: false,
    recommendedNextStep: 'update_auth_credentials',
  },
};

const HELLO_OK = {
  type: 'res',
  id: 'cc-1',
  ok: true,
  payload: {
    type: 'hello-ok',
    protocol: 4,
    server: { version: '1.0.0', connId: 'conn-1' },
    features: { methods: ['sessions.list', 'chat.send', 'sessions.messages.subscribe', 'chat.history', 'chat.abort'], events: ['session.message'] },
    auth: { role: 'operator', scopes: ['operator.read', 'operator.write'] },
    policy: { maxPayload: 26214400, maxBufferedBytes: 52428800, tickIntervalMs: 15000 },
  },
};

describe('GatewayChatService', () => {
    describe('GatewayChatService', () => {
      const services: GatewayChatService[] = [];
      afterEach(() => {
        for (const svc of services.splice(0)) svc.dispose();
        jest.useRealTimers();
      });

      function makeService(
        ws: MockSocket,
        log: { lines: string[] },
        wsFactory: (url: string) => WebSocketLike = () => ws
      ): GatewayChatService {
        const svc = new GatewayChatService({
          url: 'ws://gateway.test:18789',
          token: 'secret-token-value',
          logger: {
            info: (m) => log.lines.push(m),
            warn: (m) => log.lines.push(m),
            error: (m) => log.lines.push(m),
          },
          wsFactory,
        });
        services.push(svc);
        return svc;
      }

      /** Drive a handshake without macrotask ticks (works on fake timers).
       *  The socket is read after connect() so factory-created sockets resolve. */
      async function handshake(
        svc: GatewayChatService,
        socket: () => MockSocket,
        reply: unknown = HELLO_OK
      ): Promise<void> {
        const connecting = svc.connect();
        const ws = socket();
        ws.emit('open');
        ws.emit('message', JSON.stringify({ type: 'event', event: 'connect.challenge', payload: {} }));
        const connectReq = ws.sent.map((raw) => JSON.parse(raw) as { id: string }).pop()!;
        ws.emit('message', JSON.stringify({ ...(reply as object), id: connectReq.id }));
        await connecting;
      }

      describe('connection lifecycle', () => {
        it('stops reconnecting after the gateway rejects the handshake until the settings change', async () => {
          jest.useFakeTimers();
          const sockets: MockSocket[] = [];
          const svc = makeService(createMockWs(), { lines: [] }, () => {
            sockets.push(createMockWs());
            return sockets[sockets.length - 1];
          });
          const rejection = { type: 'res', ok: false, error: TOKEN_MISMATCH_ERROR };
          await expect(handshake(svc, () => sockets[0], rejection)).rejects.toThrow('handshake rejected');
          jest.advanceTimersByTime(120_000);
          expect(sockets).toHaveLength(1);
          svc.updateConnection('ws://gateway.test:18789', 'rotated-token');
          jest.advanceTimersByTime(120_000);
          expect(sockets).toHaveLength(2);
        });

        it('keeps backing off after a transient handshake rejection or unexpected payload', async () => {
          jest.useFakeTimers();
          const sockets: MockSocket[] = [];
          const svc = makeService(createMockWs(), { lines: [] }, () => {
            sockets.push(createMockWs());
            return sockets[sockets.length - 1];
          });
          const starting = { type: 'res', ok: false, error: { code: 'UNAVAILABLE', message: 'starting' } };
          await expect(handshake(svc, () => sockets[0], starting)).rejects.toThrow('handshake rejected');
          jest.advanceTimersByTime(1100);
          expect(sockets).toHaveLength(2);
          const bogus = { type: 'res', ok: true, payload: { type: 'not-hello' } };
          const reconnect = svc.connect();
          const socket = sockets[1];
          socket.emit('open');
          socket.emit('message', JSON.stringify({ type: 'event', event: 'connect.challenge', payload: {} }));
          const connectReq = JSON.parse(socket.sent[socket.sent.length - 1]) as { id: string };
          socket.emit('message', JSON.stringify({ ...bogus, id: connectReq.id }));
          await expect(reconnect).rejects.toThrow('unexpected payload');
          jest.advanceTimersByTime(120_000);
          expect(sockets.length).toBeGreaterThan(2);
        });

        it('treats a retryable auth code as transient', async () => {
          jest.useFakeTimers();
          const sockets: MockSocket[] = [];
          const svc = makeService(createMockWs(), { lines: [] }, () => {
            sockets.push(createMockWs());
            return sockets[sockets.length - 1];
          });
          const limited = {
            type: 'res',
            ok: false,
            error: {
              code: 'INVALID_REQUEST',
              message: 'unauthorized: too many failed authentication attempts (retry later)',
              retryable: true,
              retryAfterMs: 1000,
              details: { code: 'AUTH_RATE_LIMITED', authReason: 'rate_limited' },
            },
          };
          await expect(handshake(svc, () => sockets[0], limited)).rejects.toThrow('handshake rejected');
          jest.advanceTimersByTime(1100);
          expect(sockets).toHaveLength(2);
        });

        it('rejects connect() with a redacted error when the socket factory throws', async () => {
          const log = { lines: [] as string[] };
          const svc = makeService(createMockWs(), log, () => {
            throw new Error('Invalid URL: ws://user:hunter2@gw.test/?token=abc&x=secret-token-value#frag');
          });
          let connecting: Promise<void> | undefined;
          expect(() => { connecting = svc.connect(); }).not.toThrow();
          const err = await connecting!.catch((e: Error) => e);
          expect((err as Error).message).toContain('gateway connect failed');
          expect((err as Error).message).not.toMatch(/hunter2|token=abc|secret-token-value/);
        });

        it('survives a socket factory throw inside the reconnect timer', async () => {
          jest.useFakeTimers();
          const log = { lines: [] as string[] };
          const ws = createMockWs();
          let factoryThrows = false;
          const svc = makeService(ws, log, () => {
            if (factoryThrows) throw new Error('Invalid URL: ws://user:hunter2@gw.test/#frag');
            return ws;
          });
          await handshake(svc, () => ws);
          factoryThrows = true;
          ws.close();
          expect(() => jest.advanceTimersByTime(1100)).not.toThrow();
          for (let i = 0; i < 5; i++) await Promise.resolve();
          expect(log.lines.some((l) => l.includes('reconnect failed'))).toBe(true);
          expect(log.lines.join('\n')).not.toContain('hunter2');
        });

        it('redacts URL credentials and the token from socket error logs', async () => {
          const log = { lines: [] as string[] };
          const ws = createMockWs();
          const svc = makeService(ws, log);
          const connecting = svc.connect();
          ws.emit('error', new Error('connect ECONNREFUSED ws://user:hunter2@gw.test/?token=secret-token-value'));
          await expect(connecting).rejects.toThrow('gateway error');
          expect(log.lines.join('\n')).not.toMatch(/hunter2|secret-token-value/);
        });

        it('rejects connect() after dispose without opening a socket', async () => {
          let opened = 0;
          const svc = makeService(createMockWs(), { lines: [] }, () => {
            opened += 1;
            return createMockWs();
          });
          svc.dispose();
          await expect(svc.connect()).rejects.toThrow('disposed');
          expect(opened).toBe(0);
        });
      });

      it('handshakes with role=operator and token auth, never logging the token', async () => {
        const ws = createMockWs();
        const log = { lines: [] as string[] };
        const svc = makeService(ws, log);
        const pending = svc.connect();
        // Emit open, then the pre-connect challenge -> connect frame sent (challenge-gated).
        ws.emit('open');
        await new Promise<void>((r) => setTimeout(r, 0));
        ws.emit('message', JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { ts: Date.now() } }));
        await new Promise<void>((r) => setTimeout(r, 0));
        expect(ws.sent).toHaveLength(1);
        const connectFrame = JSON.parse(ws.sent[0]) as { method: string; params: Record<string, unknown> };
        expect(connectFrame.method).toBe('connect');
        expect(connectFrame.params.role).toBe('operator');
        expect((connectFrame.params.auth as { token: string }).token).toBe('secret-token-value');
        // Reply hello-ok with the connect request id (responses are id-correlated).
        ws.emit('message', JSON.stringify(HELLO_OK));
        await pending;
        expect(svc.isRunning).toBe(true);
        expect(svc.hello?.protocol).toBe(4);
        // No log line may contain the token or the prompt.
        expect(log.lines.join('\n')).not.toContain('secret-token-value');
      });

      it('rejects connect on handshake error frame', async () => {
        const ws = createMockWs();
        const svc = makeService(ws, { lines: [] });
        const pending = svc.connect();
        ws.emit('open');
        ws.emit('message', JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { ts: Date.now() } }));
        await new Promise<void>((r) => setTimeout(r, 0));
        ws.emit('message', JSON.stringify({ type: 'res', id: 'cc-1', ok: false, error: TOKEN_MISMATCH_ERROR }));
        await expect(pending).rejects.toThrow('handshake rejected');
      });

      it('sends RPC requests and correlates responses', async () => {
        const ws = createMockWs();
        const svc = makeService(ws, { lines: [] });
        const connecting = svc.connect();
        ws.emit('open');
        ws.emit('message', JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { ts: Date.now() } }));
        await new Promise<void>((r) => setTimeout(r, 0));
        ws.emit('message', JSON.stringify(HELLO_OK));
        await connecting;

        const p = svc.listSessions({});
        await new Promise<void>((r) => setTimeout(r, 0));
        const rpc = JSON.parse(ws.sent[1]) as { type: string; method: string; id: string };
        expect(rpc.type).toBe('req');
        expect(rpc.method).toBe('sessions.list');
        ws.emit('message', JSON.stringify({ type: 'res', id: rpc.id, ok: true, payload: { sessions: [] } }));
        await expect(p).resolves.toEqual({ sessions: [] });
      });

      it('schedules reconnect with exponential backoff on close', async () => {
        jest.useFakeTimers();
        try {
          const ws = createMockWs();
          const log = { lines: [] as string[] };
          // The factory replaces the socket on every reconnect attempt.
          let second: MockSocket | null = null;
          const sockets = [ws];
          const svc = makeService(ws, log, () => sockets.shift() ?? (second = createMockWs()));
          const connecting = svc.connect();
          await Promise.resolve();
          ws.emit('open');
          ws.emit('message', JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { ts: Date.now() } }));
          ws.emit('message', JSON.stringify(HELLO_OK));
          await connecting;
          expect(svc.isRunning).toBe(true);
          ws.close(); // triggers close -> schedule reconnect
          expect(log.lines.some((l) => l.includes('reconnect scheduled'))).toBe(true);
          jest.advanceTimersByTime(1100);
          await Promise.resolve();
          expect(second).not.toBeNull();
          svc.dispose();
        } finally {
          jest.useRealTimers();
        }
      });

      it('rejects send when not connected', async () => {
        const ws = createMockWs();
        const svc = makeService(ws, { lines: [] });
        await expect(svc.send('sessions.list')).rejects.toThrow('not connected');
      });

      it('emits error+done when sendMessage is called while disconnected', () => {
        const svc = makeService(createMockWs(), { lines: [] });
        const events: unknown[] = [];
        svc.sendMessage('p', '/tmp', 'm', 'chat', (e) => events.push(e));
        svc.dispose();
        expect(events).toEqual([{ type: 'error', message: 'Gateway is not connected. Run "OpenClaw: Connect to Gateway" to configure a token, or check openclaw.gateway.url.' }, { type: 'done' }]);
      });
    });
    describe('GatewayChatService sendMessage/abort', () => {
      const services: GatewayChatService[] = [];
      afterEach(() => {
        for (const svc of services.splice(0)) svc.dispose();
      });

      async function connectService(
        ws: MockSocket,
        methods?: string[],
        wsFactory: (url: string) => WebSocketLike = () => ws
      ): Promise<GatewayChatService> {
        const svc = new GatewayChatService({
          url: 'ws://gateway.test:18789',
          token: 'secret-token-value',
          logger: { info() {}, warn() {}, error() {} },
          wsFactory,
        });
        services.push(svc);
        const pending = svc.connect();
        ws.emit('open');
        await new Promise<void>((r) => setTimeout(r, 0));
        ws.emit('message', JSON.stringify({ type: 'event', event: 'connect.challenge', payload: {} }));
        await new Promise<void>((r) => setTimeout(r, 0));
        const hello = JSON.parse(JSON.stringify(HELLO_OK)) as typeof HELLO_OK;
        if (methods) {
          (hello.payload as { features: { methods: string[] } }).features.methods = methods;
        }
        ws.emit('message', JSON.stringify(hello));
        await pending;
        return svc;
      }

      function sentRequests(ws: MockSocket): Array<{ method: string; id: string; params: Record<string, unknown> }> {
        return ws.sent
          .map((raw) => JSON.parse(raw) as { type: string; method: string; id: string; params: Record<string, unknown> })
          .filter((f) => f.type === 'req');
      }

      /** Resolve the pre-send subscription: chat.send is issued only after the
       *  subscribe acknowledgement, so tests must answer it first. */
      function answerSubscribe(ws: MockSocket): void {
        for (const req of sentRequests(ws)) {
          if (req.method === 'sessions.messages.subscribe') {
            ws.emit('message', JSON.stringify({ type: 'res', id: req.id, ok: true, payload: {} }));
          }
        }
      }

      /** Resolve the pre-send history snapshot: issueSend awaits it before
       *  chat.send, so tests must answer it to reach the send RPC. */
      function answerPreSendHistory(ws: MockSocket, payload: Record<string, unknown> = { messages: [] }): void {
        for (const req of sentRequests(ws)) {
          if (req.method === 'chat.history' && !('deltaCursor' in req.params)) {
            ws.emit('message', JSON.stringify({ type: 'res', id: req.id, ok: true, payload }));
          }
        }
      }

      it('sends chat.send with enqueue mode and subscribes to session messages', async () => {
        const ws = createMockWs();
        const svc = await connectService(ws);
        svc.sendMessage('hello', '/tmp', 'm', 'chat', () => {});
        await new Promise<void>((r) => setTimeout(r, 0));
        const subscribe = sentRequests(ws).find((r) => r.method === 'sessions.messages.subscribe');
        expect(subscribe?.params).toEqual({ sessionKeys: ['main'] });
        answerSubscribe(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        answerPreSendHistory(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        const send = sentRequests(ws).find((r) => r.method === 'chat.send');
        expect(send?.params).toMatchObject({ sessionKey: 'main', text: 'hello', queueMode: 'enqueue' });
        ws.emit('message', JSON.stringify({ type: 'res', id: send!.id, ok: true, payload: { sessionKey: 'main' } }));
        await new Promise<void>((r) => setTimeout(r, 0));
        svc.dispose();
      });

      it('aborts the send when the pre-send history snapshot resolves without a recovery boundary', async () => {
        const ws = createMockWs();
        const svc = await connectService(ws);
        const events: unknown[] = [];
        svc.sendMessage('hi', '/tmp', 'm', 'chat', (e) => events.push(e));
        await new Promise<void>((r) => setTimeout(r, 0));
        answerSubscribe(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        // A malformed snapshot (no messages array, no cursor) seeds no boundary:
        // a reconnect catch-up would return early and miss deltas permanently,
        // so the send must abort instead of issuing chat.send unrecoverably.
        answerPreSendHistory(ws, {} as Record<string, unknown>);
        await new Promise<void>((r) => setTimeout(r, 0));
        expect(sentRequests(ws).find((r) => r.method === 'chat.send')).toBeUndefined();
        expect(events).toContainEqual({ type: 'done' });
        expect(events.some((e) => (e as { type: string }).type === 'error')).toBe(true);
        svc.dispose();
      });

      it('seeds a delta cursor for a fresh run so reconnect catch-up has one', async () => {
        const ws = createMockWs();
        const svc = await connectService(ws);
        svc.sendMessage('hi', '/tmp', 'm', 'chat', () => {});
        await new Promise<void>((r) => setTimeout(r, 0));
        answerSubscribe(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        // The pre-send cursor seed: issueSend awaits this snapshot before issuing
        // chat.send, so a reconnect catch-up always covers the fresh run.
        const snapshot = sentRequests(ws).find((r) => r.method === 'chat.history' && !('deltaCursor' in r.params));
        expect(snapshot).toBeDefined();
        ws.emit('message', JSON.stringify({
          type: 'res',
          id: snapshot!.id,
          ok: true,
          payload: { deltaCursor: 'cursor-seed', messages: [{ messageId: 'm0', role: 'user', text: 'hi' }] },
        }));
        await new Promise<void>((r) => setTimeout(r, 0));
        const send = sentRequests(ws).find((r) => r.method === 'chat.send')!;
        ws.emit('message', JSON.stringify({ type: 'res', id: send.id, ok: true, payload: { sessionKey: 'main' } }));
        await new Promise<void>((r) => setTimeout(r, 0));
        // The pre-send subscription was already established, so no duplicate
        // subscribe is issued after the ack, and the seeded cursor means the
        // post-ack fallback seed is skipped.
        const subscribe = sentRequests(ws).find((r) => r.method === 'sessions.messages.subscribe');
        expect(subscribe).toBeDefined();
        expect(
          sentRequests(ws).filter((r) => r.method === 'sessions.messages.subscribe')
        ).toHaveLength(1);
        expect(
          sentRequests(ws)
            .filter((r) => r.method === 'chat.history')
            .find((r) => r.params.deltaCursor === 'cursor-seed')
        ).toBeUndefined();
        svc.dispose();
      });

      it('streams session.message deltas to the active sink and finishes on session_end', async () => {
        const ws = createMockWs();
        const svc = await connectService(ws);
        const events: unknown[] = [];
        svc.sendMessage('hi', '/tmp', 'm', 'chat', (e) => events.push(e));
        await new Promise<void>((r) => setTimeout(r, 0));
        answerSubscribe(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        answerPreSendHistory(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        const send = sentRequests(ws).find((r) => r.method === 'chat.send')!;
        ws.emit('message', JSON.stringify({ type: 'res', id: send.id, ok: true, payload: { sessionKey: 'main' } }));
        await new Promise<void>((r) => setTimeout(r, 0));
        ws.emit('message', JSON.stringify({
          type: 'event',
          event: 'session.message',
          payload: { sessionKey: 'main', role: 'assistant', delta: 'he' },
        }));
        ws.emit('message', JSON.stringify({
          type: 'event',
          event: 'session.message',
          payload: { sessionKey: 'main', role: 'assistant', text: 'llo' },
        }));
        ws.emit('message', JSON.stringify({ type: 'event', event: 'session_end', payload: { sessionKey: 'main' } }));
        await new Promise<void>((r) => setTimeout(r, 0));
        expect(events).toContainEqual({ type: 'text', text: 'he' });
        expect(events).toContainEqual({ type: 'text', text: 'llo' });
        expect(events).toContainEqual({ type: 'done' });
        svc.dispose();
      });

      it('does not re-emit the tail when a mixed delta+text frame precedes the full-text completion', async () => {
        const ws = createMockWs();
        const svc = await connectService(ws);
        const events: unknown[] = [];
        svc.sendMessage('hi', '/tmp', 'm', 'chat', (e) => events.push(e));
        await new Promise<void>((r) => setTimeout(r, 0));
        answerSubscribe(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        answerPreSendHistory(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        const send = sentRequests(ws).find((r) => r.method === 'chat.send')!;
        ws.emit('message', JSON.stringify({ type: 'res', id: send.id, ok: true, payload: { sessionKey: 'main' } }));
        await new Promise<void>((r) => setTimeout(r, 0));
        // Delta 'he', then a mixed frame carrying both a delta and the
        // cumulative text ('he' + 'llo' == 'hello'), then the normal
        // full-text completion frame: the stale delta prefix must not
        // duplicate the tail.
        ws.emit('message', JSON.stringify({
          type: 'event', event: 'session.message',
          payload: { sessionKey: 'main', role: 'assistant', messageId: 'm0', delta: 'he' },
        }));
        ws.emit('message', JSON.stringify({
          type: 'event', event: 'session.message',
          payload: { sessionKey: 'main', role: 'assistant', messageId: 'm0', delta: 'llo', text: 'hello' },
        }));
        ws.emit('message', JSON.stringify({
          type: 'event', event: 'session.message',
          payload: { sessionKey: 'main', role: 'assistant', messageId: 'm0', text: 'hello' },
        }));
        ws.emit('message', JSON.stringify({ type: 'event', event: 'session_end', payload: { sessionKey: 'main' } }));
        await new Promise<void>((r) => setTimeout(r, 0));
        const texts = events.filter((e) => (e as { type: string }).type === 'text').map((e) => (e as { text: string }).text);
        expect(texts).toEqual(['he', 'llo']);
        svc.dispose();
      });

      it('delivers the final text when a divergent mixed frame precedes the completion', async () => {
        const ws = createMockWs();
        const svc = await connectService(ws);
        const events: unknown[] = [];
        svc.sendMessage('hi', '/tmp', 'm', 'chat', (e) => events.push(e));
        await new Promise<void>((r) => setTimeout(r, 0));
        answerSubscribe(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        answerPreSendHistory(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        const send = sentRequests(ws).find((r) => r.method === 'chat.send')!;
        ws.emit('message', JSON.stringify({ type: 'res', id: send.id, ok: true, payload: { sessionKey: 'main' } }));
        await new Promise<void>((r) => setTimeout(r, 0));
        // Delta 'he', then a mixed frame whose full text does not extend the
        // streamed prefix plus delta: the mixed frame's full text stays intact,
        // the tracker keeps the accumulated delta prefix, and the later
        // full-text completion frame must still deliver its text.
        ws.emit('message', JSON.stringify({
          type: 'event', event: 'session.message',
          payload: { sessionKey: 'main', role: 'assistant', messageId: 'm0', delta: 'he' },
        }));
        ws.emit('message', JSON.stringify({
          type: 'event', event: 'session.message',
          payload: { sessionKey: 'main', role: 'assistant', messageId: 'm0', delta: 'x', text: 'hello' },
        }));
        ws.emit('message', JSON.stringify({
          type: 'event', event: 'session.message',
          payload: { sessionKey: 'main', role: 'assistant', messageId: 'm0', text: 'hello' },
        }));
        ws.emit('message', JSON.stringify({ type: 'event', event: 'session_end', payload: { sessionKey: 'main' } }));
        await new Promise<void>((r) => setTimeout(r, 0));
        const texts = events.filter((e) => (e as { type: string }).type === 'text').map((e) => (e as { text: string }).text);
        expect(texts).toEqual(['he', 'x', 'hello', 'hello']);
        svc.dispose();
      });

      it('keeps the response visible for a no-id frame carrying delta and full text', async () => {
        const ws = createMockWs();
        const svc = await connectService(ws);
        const events: unknown[] = [];
        svc.sendMessage('hi', '/tmp', 'm', 'chat', (e) => events.push(e));
        await new Promise<void>((r) => setTimeout(r, 0));
        answerSubscribe(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        answerPreSendHistory(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        const send = sentRequests(ws).find((r) => r.method === 'chat.send')!;
        ws.emit('message', JSON.stringify({ type: 'res', id: send.id, ok: true, payload: { sessionKey: 'main' } }));
        await new Promise<void>((r) => setTimeout(r, 0));
        // A normal frame without a messageId carries both the delta and the
        // cumulative text describing the same content: the mapper emits only the
        // full text, so the delta must NOT join the emitted prefix — otherwise
        // bookkeeping slices the response down to an empty string and the
        // assistant turn disappears.
        ws.emit('message', JSON.stringify({
          type: 'event', event: 'session.message',
          payload: { sessionKey: 'main', role: 'assistant', delta: 'hello', text: 'hello' },
        }));
        await new Promise<void>((r) => setTimeout(r, 0));
        const texts = events.filter((e) => (e as { type: string }).type === 'text').map((e) => (e as { text: string }).text);
        expect(texts).toEqual(['hello']);
        svc.dispose();
      });

      it('fails the send as a conflict when the resolved session is owned by another run', async () => {
        const ws = createMockWs();
        const svc = await connectService(ws);
        // Thread B owns a live run on session 'other'.
        const bEvents: unknown[] = [];
        svc.setActiveSession('other');
        svc.sendMessage('b', '/tmp', 'm', 'chat', (e) => bEvents.push(e));
        await new Promise<void>((r) => setTimeout(r, 0));
        answerSubscribe(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        answerPreSendHistory(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        const bSend = sentRequests(ws).find((r) => r.method === 'chat.send')!;
        ws.emit('message', JSON.stringify({ type: 'res', id: bSend.id, ok: true, payload: { sessionKey: 'other' } }));
        await new Promise<void>((r) => setTimeout(r, 0));
        // Thread A sends on 'main'; the gateway resolves the send to 'other',
        // whose run sink still belongs to thread B.
        const aEvents: unknown[] = [];
        svc.setActiveSession('main');
        svc.sendMessage('a', '/tmp', 'm', 'chat', (e) => aEvents.push(e));
        await new Promise<void>((r) => setTimeout(r, 0));
        answerSubscribe(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        answerPreSendHistory(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        const aSend = sentRequests(ws).filter((r) => r.method === 'chat.send').pop()!;
        expect(aSend.params).toMatchObject({ sessionKey: 'main', queueMode: 'enqueue' });
        ws.emit('message', JSON.stringify({ type: 'res', id: aSend.id, ok: true, payload: { sessionKey: 'other' } }));
        await new Promise<void>((r) => setTimeout(r, 0));
        // Thread B's stream must stay untouched; thread A gets a conflict error.
        expect(bEvents).toEqual([]);
        expect(aEvents).toContainEqual(expect.objectContaining({ type: 'error' }));
        expect(aEvents[aEvents.length - 1]).toEqual({ type: 'done' });
        svc.dispose();
      });

      it('abort sends chat.abort and emits done', async () => {
        const ws = createMockWs();
        const svc = await connectService(ws);
        const events: unknown[] = [];
        svc.sendMessage('hi', '/tmp', 'm', 'chat', (e) => events.push(e));
        await new Promise<void>((r) => setTimeout(r, 0));
        answerSubscribe(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        answerPreSendHistory(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        const send = sentRequests(ws).find((r) => r.method === 'chat.send')!;
        ws.emit('message', JSON.stringify({ type: 'res', id: send.id, ok: true, payload: { sessionKey: 'main' } }));
        await new Promise<void>((r) => setTimeout(r, 0));
        svc.abort();
        await new Promise<void>((r) => setTimeout(r, 0));
        const abort = sentRequests(ws).find((r) => r.method === 'chat.abort');
        expect(abort?.params).toEqual({ sessionKey: 'main' });
        ws.emit('message', JSON.stringify({ type: 'res', id: abort!.id, ok: true, payload: {} }));
        await new Promise<void>((r) => setTimeout(r, 0));
        expect(events).toContainEqual({ type: 'done' });
        svc.dispose();
      });

      it('abort while disconnected retires the sink and emits done without sending', async () => {
        const ws = createMockWs();
        const svc = await connectService(ws);
        const events: unknown[] = [];
        svc.sendMessage('hi', '/tmp', 'm', 'chat', (e) => events.push(e));
        await new Promise<void>((r) => setTimeout(r, 0));
        answerSubscribe(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        answerPreSendHistory(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        const send = sentRequests(ws).find((r) => r.method === 'chat.send')!;
        ws.emit('message', JSON.stringify({ type: 'res', id: send.id, ok: true, payload: { sessionKey: 'main' } }));
        await new Promise<void>((r) => setTimeout(r, 0));
        ws.emit('close');
        await new Promise<void>((r) => setTimeout(r, 0));
        svc.abort();
        await new Promise<void>((r) => setTimeout(r, 0));
        expect(events).toContainEqual({ type: 'done' });
        expect(sentRequests(ws).filter((r) => r.method === 'chat.abort')).toHaveLength(0);
        svc.dispose();
      });

      it('abort retires the transcript sink so late session.message events are not delivered', async () => {
        const ws = createMockWs();
        const svc = await connectService(ws);
        const events: unknown[] = [];
        svc.sendMessage('hi', '/tmp', 'm', 'chat', (e) => events.push(e));
        await new Promise<void>((r) => setTimeout(r, 0));
        answerSubscribe(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        answerPreSendHistory(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        const send = sentRequests(ws).find((r) => r.method === 'chat.send')!;
        ws.emit('message', JSON.stringify({ type: 'res', id: send.id, ok: true, payload: { sessionKey: 'main' } }));
        await new Promise<void>((r) => setTimeout(r, 0));
        svc.abort();
        const abort = sentRequests(ws).find((r) => r.method === 'chat.abort')!;
        ws.emit('message', JSON.stringify({ type: 'res', id: abort.id, ok: true, payload: {} }));
        await new Promise<void>((r) => setTimeout(r, 0));
        const doneCount = events.filter((e) => (e as { type: string }).type === 'done').length;
        ws.emit('message', JSON.stringify({
          type: 'event',
          event: 'session.message',
          payload: { sessionKey: 'main', role: 'assistant', delta: 'late tail' },
        }));
        ws.emit('message', JSON.stringify({ type: 'event', event: 'session_end', payload: { sessionKey: 'main' } }));
        await new Promise<void>((r) => setTimeout(r, 0));
        expect(events).not.toContainEqual({ type: 'text', text: 'late tail' });
        expect(events.filter((e) => (e as { type: string }).type === 'done')).toHaveLength(doneCount);
        svc.dispose();
      });

      it('warns instead of crashing when subscribe method is not advertised', async () => {
        const ws = createMockWs();
        const log = { lines: [] as string[] };
        const svc = new GatewayChatService({
          url: 'ws://gateway.test:18789',
          token: 't',
          logger: {
            info: (m) => log.lines.push(m),
            warn: (m) => log.lines.push(m),
            error: (m) => log.lines.push(m),
          },
          wsFactory: () => ws,
        });
        const pending = svc.connect();
        ws.emit('open');
        await new Promise<void>((r) => setTimeout(r, 0));
        ws.emit('message', JSON.stringify({ type: 'event', event: 'connect.challenge', payload: {} }));
        await new Promise<void>((r) => setTimeout(r, 0));
        const hello = JSON.parse(JSON.stringify(HELLO_OK)) as typeof HELLO_OK;
        (hello.payload as { features: { methods: string[] } }).features.methods = ['sessions.list'];
        ws.emit('message', JSON.stringify(hello));
        await pending;
        const events: ChatEvent[] = [];
        svc.sendMessage('hi', '/tmp', 'm', 'chat', (e) => events.push(e));
        await new Promise<void>((r) => setTimeout(r, 0));
        // Without transcript streaming the send is rejected explicitly: a
        // gateway that does not advertise the subscribe method would emit no
        // session events, so sending now would complete the turn silently
        // without output.
        expect(sentRequests(ws).find((r) => r.method === 'chat.send')).toBeUndefined();
        expect(events.some((e) => e.type === 'error')).toBe(true);
        expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
        svc.dispose();
      });

      it('catches up via chat.history with deltaCursor and dedupes by messageId', async () => {
        const ws = createMockWs();
        const svc = await connectService(ws);
        const events: unknown[] = [];
        // Catch-up runs only on a cursor/resume path: seed a delta cursor first.
        // The replay goes to a transcript-only resume sink: a run sink (including
        // one present at catch-up start) is excluded from replay delivery, since
        // replayed history and its finalizing done must not reach a live run.
        svc.seedHistory('main', { deltaCursor: 'cursor-42', messages: [] });
        svc.resumeSession('main', (e) => events.push(e), { historyRendered: true });
        await new Promise<void>((r) => setTimeout(r, 0));
        const subscribe = sentRequests(ws).find((r) => r.method === 'sessions.messages.subscribe')!;
        ws.emit('message', JSON.stringify({ type: 'res', id: subscribe.id, ok: true, payload: {} }));
        await new Promise<void>((r) => setTimeout(r, 0));
        const history = sentRequests(ws).find((r) => r.method === 'chat.history');
        expect(history?.params).toMatchObject({ sessionKey: 'main', deltaCursor: 'cursor-42' });
        ws.emit('message', JSON.stringify({
          type: 'res',
          id: history!.id,
          ok: true,
          payload: {
            deltaCursor: 'cursor-42',
            messages: [
              { messageId: 'm1', role: 'assistant', text: 'cached' },
              { messageId: 'm1', role: 'assistant', text: 'cached' },
              { messageId: 'm2', role: 'assistant', delta: 'tail' },
            ],
          },
        }));
        await new Promise<void>((r) => setTimeout(r, 0));
        const texts = events.filter((e): e is { type: string; text: string } =>
          (e as { type?: string }).type === 'text'
        );
        expect(texts).toEqual(expect.arrayContaining([{ type: 'text', text: 'cached' }, { type: 'text', text: 'tail' }]));
        expect(texts.filter((t) => t.text === 'cached')).toHaveLength(1);
        svc.dispose();
      });

      it('delivers replayed unseen catch-up rows and their done to the run sink present at catch-up start', async () => {
        // Reconnect/resume catch-up with a live run whose socket dropped: the
        // run sink is the thread's only delivery channel (the persistent sink
        // is suspended while the run streams), so replayed rows must reach it
        // or deltas appended while disconnected are permanently lost. A
        // completed row in the replayed history means the response finished
        // server-side, so the replayed done is the run's only terminal — the
        // sink is retired and the row is remembered so a late re-emission is
        // filtered. Pre-ack and raced sinks stay excluded (covered by the
        // pre-ack and post-ack-seed tests below).
        const ws = createMockWs();
        const svc = await connectService(ws);
        const events: unknown[] = [];
        svc.seedHistory('main', { deltaCursor: 'cursor-42', messages: [] });
        svc.sendMessage('hi', '/tmp', 'm', 'chat', (e) => events.push(e));
        await new Promise<void>((r) => setTimeout(r, 0));
        answerSubscribe(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        answerPreSendHistory(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        const send = sentRequests(ws).find((r) => r.method === 'chat.send')!;
        ws.emit('message', JSON.stringify({ type: 'res', id: send.id, ok: true, payload: { sessionKey: 'main' } }));
        await new Promise<void>((r) => setTimeout(r, 0));
        const history = sentRequests(ws).filter((r) => r.method === 'chat.history').pop()!;
        ws.emit('message', JSON.stringify({
          type: 'res',
          id: history.id,
          ok: true,
          payload: {
            deltaCursor: 'cursor-42',
            messages: [{ messageId: 'm1', role: 'assistant', text: 'replayed' }],
          },
        }));
        await new Promise<void>((r) => setTimeout(r, 0));
        expect(events.filter((e) => (e as { type?: string }).type === 'text')).toHaveLength(1);
        expect(events.filter((e) => (e as { type?: string }).type === 'done')).toHaveLength(1);
        svc.dispose();
      });

      it('withholds replayed delta-only rows from the run sink present at catch-up start', async () => {
        // Replayed delta chunks cannot be deduped against chunks the live
        // stream already delivered, so they stay withheld from the run sink;
        // the missed content is recovered when the row's finalized form
        // arrives and the complete frame is diffed against the streamed
        // prefix.
        const ws = createMockWs();
        const svc = await connectService(ws);
        const events: unknown[] = [];
        svc.seedHistory('main', { deltaCursor: 'cursor-42', messages: [] });
        svc.sendMessage('hi', '/tmp', 'm', 'chat', (e) => events.push(e));
        await new Promise<void>((r) => setTimeout(r, 0));
        answerSubscribe(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        answerPreSendHistory(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        const send = sentRequests(ws).find((r) => r.method === 'chat.send')!;
        ws.emit('message', JSON.stringify({ type: 'res', id: send.id, ok: true, payload: { sessionKey: 'main' } }));
        await new Promise<void>((r) => setTimeout(r, 0));
        // Simulate a live streamed delta prefix so the in-flight message has a
        // store entry, then reconnect-catch-up delta rows for the same message.
        ws.emit('message', JSON.stringify({
          type: 'event',
          event: 'session.message',
          payload: { sessionKey: 'main', messageId: 'm1', role: 'assistant', delta: 'live ' },
        }));
        await new Promise<void>((r) => setTimeout(r, 0));
        const history = sentRequests(ws).filter((r) => r.method === 'chat.history').pop()!;
        ws.emit('message', JSON.stringify({
          type: 'res',
          id: history.id,
          ok: true,
          payload: {
            deltaCursor: 'cursor-42',
            messages: [{ messageId: 'm1', role: 'assistant', delta: 'replayed' }],
          },
        }));
        await new Promise<void>((r) => setTimeout(r, 0));
        const texts = events.filter((e) => (e as { type?: string }).type === 'text') as Array<{ text: string }>;
        expect(texts.map((t) => t.text)).toEqual(['live ']);
        expect(events.filter((e) => (e as { type?: string }).type === 'done')).toHaveLength(0);
        svc.dispose();
      });


      it('does not pre-seed the in-flight response from the post-ack history snapshot', async () => {
        const ws = createMockWs();
        const svc = await connectService(ws);
        const events: unknown[] = [];
        svc.sendMessage('hi', '/tmp', 'm', 'chat', (e) => events.push(e));
        await new Promise<void>((r) => setTimeout(r, 0));
        answerSubscribe(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        answerPreSendHistory(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        const send = sentRequests(ws).find((r) => r.method === 'chat.send')!;
        ws.emit('message', JSON.stringify({ type: 'res', id: send.id, ok: true, payload: { sessionKey: 'main' } }));
        await new Promise<void>((r) => setTimeout(r, 0));
        const subscribe = sentRequests(ws).find((r) => r.method === 'sessions.messages.subscribe')!;
        ws.emit('message', JSON.stringify({ type: 'res', id: subscribe.id, ok: true, payload: {} }));
        await new Promise<void>((r) => setTimeout(r, 0));
        // The post-ack snapshot races the live stream: if it already contains
        // the in-flight response row, the seen-set must not pre-seed it.
        const history = sentRequests(ws).find((r) => r.method === 'chat.history');
        ws.emit('message', JSON.stringify({
          type: 'res',
          id: history!.id,
          ok: true,
          payload: { messages: [{ messageId: 'm-live', role: 'assistant', text: 'live reply' }] },
        }));
        await new Promise<void>((r) => setTimeout(r, 0));
        ws.emit('message', JSON.stringify({
          type: 'event',
          event: 'session.message',
          payload: { sessionKey: 'main', messageId: 'm-live', role: 'assistant', text: 'live reply' },
        }));
        await new Promise<void>((r) => setTimeout(r, 0));
        const texts = events.filter((e): e is { type: string; text: string } =>
          (e as { type?: string }).type === 'text');
        expect(texts).toContainEqual({ type: 'text', text: 'live reply' });
        svc.dispose();
      });

      it('drops keyless session.message frames that could belong to either of two sessions', async () => {
        const ws = createMockWs();
        const svc = await connectService(ws);
        const first: unknown[] = [];
        const second: unknown[] = [];
        svc.resumeSession('agent:a:main', (e) => first.push(e), { historyRendered: true });
        svc.resumeSession('agent:b:main', (e) => second.push(e), { historyRendered: true });
        answerSubscribe(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        ws.emit('message', JSON.stringify({ type: 'event', event: 'session.message', payload: { role: 'assistant', text: 'leak' } }));
        expect(first).toEqual([]);
        expect(second).toEqual([]);
      });

      it('replays post-history events on a cursor-less rendered resume without duplicating the seeded tail', async () => {
        const ws = createMockWs();
        const svc = await connectService(ws);
        const events: unknown[] = [];
        // History rendered without a delta cursor: the seeded rows form the
        // catch-up boundary. Events between this snapshot and the subscribe
        // ack must still replay, and keyless seeded rows must not duplicate.
        svc.seedHistory('main', {
          messages: [
            { role: 'user', text: 'hi' },
            { role: 'assistant', text: 'done' },
          ],
        });
        svc.resumeSession('main', (e) => events.push(e), { historyRendered: true });
        answerSubscribe(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        const history = sentRequests(ws).find((r) => r.method === 'chat.history');
        expect(history?.params).toMatchObject({ sessionKey: 'main' });
        expect(history?.params.deltaCursor).toBeUndefined();
        ws.emit('message', JSON.stringify({
          type: 'res',
          id: history!.id,
          ok: true,
          payload: {
            messages: [
              { role: 'user', text: 'hi' },
              { role: 'assistant', text: 'done' },
              { messageId: 'm9', role: 'assistant', text: 'fresh' },
            ],
          },
        }));
        await new Promise<void>((r) => setTimeout(r, 0));
        const texts = events.filter((e): e is { type: string; text: string } =>
          (e as { type?: string }).type === 'text'
        );
        expect(texts).toEqual([{ type: 'text', text: 'fresh' }]);
        svc.dispose();
      });

      it('seeds the fingerprint boundary even when the seen-set is skipped (rememberSeen: false)', async () => {
        const ws = createMockWs();
        const svc = await connectService(ws);
        const events: unknown[] = [];
        // Post-ack seeding skips the seen-set, but the cursor-less catch-up
        // boundary must still be seeded: otherwise the next reconnect replays
        // the whole snapshot (or, mid-run, skips catch-up and loses events).
        svc.seedHistory(
          'main',
          {
            messages: [
              { role: 'user', text: 'hi' },
              { role: 'assistant', text: 'done' },
            ],
          },
          { rememberSeen: false }
        );
        svc.resumeSession('main', (e) => events.push(e), { historyRendered: true });
        answerSubscribe(ws);
        await new Promise<void>((r) => setTimeout(r, 0));
        const history = sentRequests(ws).find((r) => r.method === 'chat.history');
        ws.emit('message', JSON.stringify({
          type: 'res',
          id: history!.id,
          ok: true,
          payload: {
            messages: [
              { role: 'user', text: 'hi' },
              { role: 'assistant', text: 'done' },
              { messageId: 'm9', role: 'assistant', text: 'fresh' },
            ],
          },
        }));
        await new Promise<void>((r) => setTimeout(r, 0));
        const texts = events.filter((e): e is { type: string; text: string } =>
          (e as { type?: string }).type === 'text');
        expect(texts).toEqual([{ type: 'text', text: 'fresh' }]);
        svc.dispose();
      });

      const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

      function emitEvent(ws: MockSocket, event: string, payload: Record<string, unknown>): void {
        ws.emit('message', JSON.stringify({ type: 'event', event, payload }));
      }

      function ackLastChatSend(ws: MockSocket, payload: Record<string, unknown> = { sessionKey: 'main' }): void {
        const send = sentRequests(ws).filter((r) => r.method === 'chat.send').pop()!;
        ws.emit('message', JSON.stringify({ type: 'res', id: send.id, ok: true, payload }));
      }

      /** Walk a send through subscribe and the pre-send history up to an issued, unacknowledged chat.send. */
      async function issueSend(svc: GatewayChatService, ws: MockSocket, sink: (e: unknown) => void): Promise<void> {
        svc.sendMessage('hi', '/tmp', 'm', 'chat', sink);
        await tick();
        answerSubscribe(ws);
        await tick();
        answerPreSendHistory(ws);
        await tick();
      }

      async function acceptedRun(svc: GatewayChatService, ws: MockSocket, sink: (e: unknown) => void): Promise<void> {
        await issueSend(svc, ws, sink);
        ackLastChatSend(ws);
        await tick();
      }

      function failPendingSubscribe(ws: MockSocket): void {
        const subscribe = sentRequests(ws).filter((r) => r.method === 'sessions.messages.subscribe').pop()!;
        ws.emit('message', JSON.stringify({ type: 'res', id: subscribe.id, ok: false, error: { code: 'X' } }));
      }

      describe('pre-ack send retirement', () => {
        it('releases the pre-ack registration when the transcript subscribe fails', async () => {
          const ws = createMockWs();
          const svc = await connectService(ws);
          svc.sendMessage('hi', '/tmp', 'm', 'chat', () => {});
          await tick();
          failPendingSubscribe(ws);
          await tick();
          expect(svc.hasOwnedRun('main')).toBe(false);
          const resumed: unknown[] = [];
          svc.resumeSession('main', (e) => resumed.push(e), { historyRendered: true });
          await tick();
          answerSubscribe(ws);
          await tick();
          emitEvent(ws, 'session.message', { sessionKey: 'main', delta: 'live' });
          expect(resumed).toEqual([{ type: 'text', text: 'live' }]);
        });

        it('releases the pre-ack registration when a credential switch interrupts the pre-send history', async () => {
          const ws = createMockWs();
          const svc = await connectService(ws);
          const events: unknown[] = [];
          svc.sendMessage('hi', '/tmp', 'm', 'chat', (e) => events.push(e));
          await tick();
          answerSubscribe(ws);
          await tick();
          svc.updateConnection('ws://other.test:18789', 'rotated');
          await tick();
          expect(svc.hasOwnedRun('main')).toBe(false);
          expect(events).toEqual([{ type: 'done' }]);
          expect(sentRequests(ws).find((r) => r.method === 'chat.send')).toBeUndefined();
        });

        it('keeps only the newest frames buffered for an unacknowledged send', async () => {
          const ws = createMockWs();
          const svc = await connectService(ws);
          const events: Array<{ type: string; text?: string }> = [];
          await issueSend(svc, ws, (e) => events.push(e as { type: string; text?: string }));
          for (let i = 0; i < 600; i++) {
            emitEvent(ws, 'session.message', { sessionKey: 'agent:resolved', messageId: `m${i}`, delta: `d${i}` });
          }
          ackLastChatSend(ws, { sessionKey: 'agent:resolved' });
          await tick();
          const texts = events.filter((e) => e.type === 'text');
          expect(texts).toHaveLength(500);
          expect(texts[0]).toEqual({ type: 'text', text: 'd100' });
        });
      });

      describe('pre-ack frame attribution', () => {
        it('does not let a foreign run ending before chat.send finalize the queued send', async () => {
          const ws = createMockWs();
          const svc = await connectService(ws);
          const observer: unknown[] = [];
          svc.resumeSession('main', (e) => observer.push(e), { historyRendered: true });
          await tick();
          answerSubscribe(ws);
          await tick();
          const events: unknown[] = [];
          svc.sendMessage('hi', '/tmp', 'm', 'chat', (e) => events.push(e));
          await tick();
          emitEvent(ws, 'session_end', { sessionKey: 'main' });
          expect(observer).toEqual([{ type: 'done' }]);
          answerPreSendHistory(ws);
          await tick();
          expect(sentRequests(ws).find((r) => r.method === 'chat.send')?.params.queueMode).toBe('enqueue');
          ackLastChatSend(ws);
          await tick();
          emitEvent(ws, 'session.message', { sessionKey: 'main', messageId: 'm2', text: 'answer' });
          emitEvent(ws, 'session_end', { sessionKey: 'main' });
          expect(events).toEqual([{ type: 'text', text: 'answer' }, { type: 'done' }]);
        });

        it('delivers a foreign run\'s frames before chat.send to observers only', async () => {
          const ws = createMockWs();
          const svc = await connectService(ws);
          const observer: unknown[] = [];
          svc.resumeSession('main', (e) => observer.push(e), { historyRendered: true });
          await tick();
          answerSubscribe(ws);
          await tick();
          const events: unknown[] = [];
          svc.sendMessage('hi', '/tmp', 'm', 'chat', (e) => events.push(e));
          await tick();
          emitEvent(ws, 'session.message', { sessionKey: 'main', messageId: 'f1', text: 'FOREIGN' });
          emitEvent(ws, 'session_end', { sessionKey: 'main' });
          answerPreSendHistory(ws);
          await tick();
          ackLastChatSend(ws);
          await tick();
          emitEvent(ws, 'session.message', { sessionKey: 'main', messageId: 'm2', text: 'answer' });
          emitEvent(ws, 'session_end', { sessionKey: 'main' });
          expect(observer.slice(0, 2)).toEqual([{ type: 'text', text: 'FOREIGN' }, { type: 'done' }]);
          expect(events).toEqual([{ type: 'text', text: 'answer' }, { type: 'done' }]);
        });

        it('does not let the steered run ending before chat.send finalize the steering send', async () => {
          const ws = createMockWs();
          const svc = await connectService(ws);
          const first: unknown[] = [];
          await acceptedRun(svc, ws, (e) => first.push(e));
          const steering: unknown[] = [];
          svc.sendMessage('more', '/tmp', 'm', 'chat', (e) => steering.push(e));
          emitEvent(ws, 'session_end', { sessionKey: 'main' });
          await tick();
          answerPreSendHistory(ws);
          await tick();
          expect(sentRequests(ws).filter((r) => r.method === 'chat.send').pop()?.params.queueMode).toBe('steer');
          ackLastChatSend(ws);
          await tick();
          emitEvent(ws, 'session.message', { sessionKey: 'main', messageId: 'm3', text: 'steered' });
          emitEvent(ws, 'session_end', { sessionKey: 'main' });
          expect(first).toEqual([{ type: 'done' }]);
          expect(steering).toEqual([{ type: 'text', text: 'steered' }, { type: 'done' }]);
        });

        it('still finalizes a fast run whose session_end arrives between chat.send and its ack', async () => {
          const ws = createMockWs();
          const svc = await connectService(ws);
          const events: unknown[] = [];
          await issueSend(svc, ws, (e) => events.push(e));
          emitEvent(ws, 'session.message', { sessionKey: 'main', messageId: 'm1', text: 'fast' });
          emitEvent(ws, 'session_end', { sessionKey: 'main' });
          expect(events).toEqual([]);
          ackLastChatSend(ws);
          await tick();
          expect(events).toEqual([{ type: 'text', text: 'fast' }, { type: 'done' }]);
        });

        it('dedupes a drained keyless delta against the live completion under the resolved key', async () => {
          const ws = createMockWs();
          const svc = await connectService(ws);
          svc.setActiveSession('agent:foo');
          const events: unknown[] = [];
          await issueSend(svc, ws, (e) => events.push(e));
          emitEvent(ws, 'session.message', { messageId: 'm1', delta: 'he' });
          ackLastChatSend(ws, { sessionKey: 'agent:foo' });
          await tick();
          emitEvent(ws, 'session.message', { messageId: 'm1', text: 'hello' });
          expect(events).toEqual([{ type: 'text', text: 'he' }, { type: 'text', text: 'llo' }]);
        });
      });

      describe('teardown terminals', () => {
        it('delivers a single done when a credential switch rejects a pending subscribe', async () => {
          const ws = createMockWs();
          const svc = await connectService(ws);
          const events: unknown[] = [];
          svc.sendMessage('hi', '/tmp', 'm', 'chat', (e) => events.push(e));
          await tick();
          svc.updateConnection('ws://other.test:18789', 'rotated');
          await tick();
          expect(events).toEqual([{ type: 'done' }]);
        });

        it('delivers a single done when suspend rejects a pending subscribe', async () => {
          const ws = createMockWs();
          const svc = await connectService(ws);
          const events: unknown[] = [];
          svc.sendMessage('hi', '/tmp', 'm', 'chat', (e) => events.push(e));
          await tick();
          svc.suspend();
          await tick();
          expect(events).toEqual([{ type: 'done' }]);
        });

        it('drops resume-only sinks on suspend so a later resubscribe cannot duplicate delivery', async () => {
          const first = createMockWs();
          const ws = createMockWs();
          const sockets = [first, ws];
          const svc = await connectService(first, undefined, () => sockets.shift()!);
          const orphan: unknown[] = [];
          svc.resumeSession('main', (e) => orphan.push(e), { historyRendered: true });
          await tick();
          answerSubscribe(first);
          await tick();
          svc.suspend();
          const reopened: unknown[] = [];
          const reconnecting = svc.connect();
          ws.emit('open');
          ws.emit('message', JSON.stringify({ type: 'event', event: 'connect.challenge', payload: {} }));
          const connectReq = sentRequests(ws).filter((r) => r.method === 'connect').pop()!;
          ws.emit('message', JSON.stringify({ ...HELLO_OK, id: connectReq.id }));
          await reconnecting;
          svc.resumeSession('main', (e) => reopened.push(e), { historyRendered: true });
          await tick();
          answerSubscribe(ws);
          await tick();
          emitEvent(ws, 'session.message', { sessionKey: 'main', delta: 'once' });
          expect(orphan).toEqual([]);
          expect(reopened).toEqual([{ type: 'text', text: 'once' }]);
        });

        it('delivers a single done to a pending send on dispose', async () => {
          const ws = createMockWs();
          const svc = await connectService(ws);
          const events: unknown[] = [];
          svc.sendMessage('hi', '/tmp', 'm', 'chat', (e) => events.push(e));
          await tick();
          svc.dispose();
          await tick();
          expect(events).toEqual([{ type: 'done' }]);
          expect(svc.hasOwnedRun('main')).toBe(false);
        });

        it('finishes an acknowledged run with done on dispose without aborting it remotely', async () => {
          const ws = createMockWs();
          const svc = await connectService(ws);
          const events: unknown[] = [];
          await acceptedRun(svc, ws, (e) => events.push(e));
          svc.dispose();
          expect(events).toEqual([{ type: 'done' }]);
          expect(sentRequests(ws).find((r) => r.method === 'chat.abort')).toBeUndefined();
        });
      });

      describe('bounded bookkeeping', () => {
        it('keeps an actively streaming message tracked past the delta-record cap', async () => {
          const ws = createMockWs();
          const svc = await connectService(ws);
          const texts: string[] = [];
          await acceptedRun(svc, ws, (e) => {
            if ((e as { type: string }).type === 'text') texts.push((e as { text: string }).text);
          });
          const delta = (messageId: string, text: string): void =>
            emitEvent(ws, 'session.message', { sessionKey: 'main', messageId, delta: text });
          delta('m0', 'a');
          for (let i = 1; i <= 100; i++) delta(`m${i}`, 'x');
          delta('m0', 'b');
          for (let i = 101; i <= 200; i++) delta(`m${i}`, 'x');
          emitEvent(ws, 'session.message', { sessionKey: 'main', messageId: 'm0', text: 'abc' });
          expect(texts[texts.length - 1]).toBe('c');
        });

        it('ignores a malformed catch-up cursor instead of storing it', async () => {
          const ws = createMockWs();
          const svc = await connectService(ws);
          svc.seedHistory('main', { deltaCursor: 'c1', messages: [] });
          svc.resumeSession('main', () => {}, { historyRendered: true });
          await tick();
          answerSubscribe(ws);
          await tick();
          const catchUp = sentRequests(ws).filter((r) => r.method === 'chat.history').pop()!;
          ws.emit('message', JSON.stringify({
            type: 'res', id: catchUp.id, ok: true, payload: { deltaCursor: { bogus: true }, messages: [] },
          }));
          await tick();
          expect(svc.captureSessionState('main')?.deltaCursor).toBe('c1');
        });

        it('stores a bounded digest boundary instead of the seeded row text', () => {
          const svc = new GatewayChatService({ url: 'ws://gateway.test:18789', token: 't', wsFactory: () => createMockWs() });
          services.push(svc);
          const longText = 'x'.repeat(10_000);
          const rows = Array.from({ length: 600 }, () => ({ role: 'assistant', text: longText }));
          svc.seedHistory('main', { messages: rows });
          const boundary = svc.captureSessionState('main')?.seededCatchUpFingerprints ?? [];
          expect(boundary).toHaveLength(500);
          expect(boundary.some((fingerprint) => fingerprint.includes(longText))).toBe(false);
        });
      });
    });

    describe('protocol invariants', () => {
      type Request = { id: string; method: string; params: Record<string, unknown> };
      const METHODS = ['sessions.list', 'chat.send', 'sessions.messages.subscribe', 'chat.history', 'chat.abort'];
      const services: GatewayChatService[] = [];
      afterEach(() => {
        for (const svc of services.splice(0)) svc.dispose();
        jest.useRealTimers();
      });

      const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

      function requests(ws: MockSocket, method: string): Request[] {
        return ws.sent
          .map((raw) => JSON.parse(raw) as Request & { type: string })
          .filter((frame) => frame.type === 'req' && frame.method === method);
      }

      function last(ws: MockSocket, method: string): Request {
        const request = requests(ws, method).pop();
        if (!request) throw new Error(`no ${method} request`);
        return request;
      }

      function reply(ws: MockSocket, request: Request, payload: unknown = {}): void {
        ws.emit('message', JSON.stringify({ type: 'res', id: request.id, ok: true, payload }));
      }

      function rejectRpc(ws: MockSocket, request: Request, error: unknown = { code: 'X' }): void {
        ws.emit('message', JSON.stringify({ type: 'res', id: request.id, ok: false, error }));
      }

      function emitEvent(ws: MockSocket, name: string, payload: unknown): void {
        ws.emit('message', JSON.stringify({ type: 'event', event: name, payload }));
      }

      function answerHandshake(ws: MockSocket, response: Record<string, unknown> = { ok: true, payload: helloPayload() }): void {
        ws.emit('open');
        emitEvent(ws, 'connect.challenge', {});
        ws.emit('message', JSON.stringify({ type: 'res', id: last(ws, 'connect').id, ...response }));
      }

      function helloPayload(methods: string[] = METHODS): Record<string, unknown> {
        return { type: 'hello-ok', protocol: 4, features: { methods } };
      }

      function service(sockets: MockSocket[], options: { token?: string; log?: string[] } = {}): GatewayChatService {
        const log = options.log ?? [];
        const queue = [...sockets];
        const svc = new GatewayChatService({
          url: 'ws://gw.test',
          token: options.token ?? 'secret-token-value',
          logger: { info: (m) => log.push(m), warn: (m) => log.push(m), error: (m) => log.push(m) },
          wsFactory: () => queue.shift() ?? createMockWs(),
        });
        services.push(svc);
        return svc;
      }

      async function connected(
        sockets: MockSocket[] = [createMockWs()],
        options: { methods?: string[]; log?: string[] } = {}
      ): Promise<{ svc: GatewayChatService; ws: MockSocket }> {
        const svc = service(sockets, options);
        const connecting = svc.connect();
        answerHandshake(sockets[0], { ok: true, payload: helloPayload(options.methods) });
        await connecting;
        return { svc, ws: sockets[0] };
      }

      async function reconnect(svc: GatewayChatService, from: MockSocket, to: MockSocket): Promise<void> {
        from.emit('close');
        const connecting = svc.connect();
        answerHandshake(to);
        await connecting;
      }

      function recorder(): { events: ChatEvent[]; sink: (event: ChatEvent) => void; types: () => string[] } {
        const events: ChatEvent[] = [];
        return { events, sink: (event) => events.push(event), types: () => events.map((event) => event.type) };
      }

      /** Walk a send through its subscription and pre-send history up to an issued, unacknowledged chat.send. */
      async function issueSend(
        svc: GatewayChatService,
        ws: MockSocket,
        sink: (event: ChatEvent) => void,
        history: unknown = { messages: [] }
      ): Promise<void> {
        svc.sendMessage('hi', '/tmp', 'm', 'chat', sink);
        await flush();
        const subscribe = requests(ws, 'sessions.messages.subscribe').pop();
        if (subscribe) reply(ws, subscribe);
        await flush();
        const snapshot = requests(ws, 'chat.history').pop();
        if (snapshot) reply(ws, snapshot, history);
        await flush();
      }

      async function acceptedRun(
        svc: GatewayChatService,
        ws: MockSocket,
        sink: (event: ChatEvent) => void,
        history?: unknown
      ): Promise<void> {
        await issueSend(svc, ws, sink, history);
        reply(ws, last(ws, 'chat.send'), { sessionKey: svc.getActiveSessionKey() ?? 'main' });
        await flush();
      }

      describe('transport defaults', () => {
        it('opens sockets through the ws package and logs through a silent default logger', async () => {
          const socket = createMockWs();
          const WebSocketMock = jest.requireMock<jest.Mock>('ws');
          WebSocketMock.mockImplementation(() => socket);
          const svc = new GatewayChatService({ url: 'ws://gw.test', token: 't' });
          services.push(svc);
          const connecting = svc.connect();
          expect(WebSocketMock).toHaveBeenCalledWith('ws://gw.test');
          answerHandshake(socket);
          await connecting;
          const history = svc.getHistory('main');
          rejectRpc(socket, last(socket, 'chat.history'));
          await expect(history).resolves.toBeNull();
          expect(() => socket.emit('error', new Error('boom'))).not.toThrow();
          expect(DEFAULT_SESSION_KEY).toBe('main');
        });

        it('reports a non-Error thrown by the socket factory', async () => {
          const svc = new GatewayChatService({
            url: 'ws://gw.test',
            token: 't',
            wsFactory: () => {
              throw 'bad url';
            },
          });
          services.push(svc);
          await expect(svc.connect()).rejects.toThrow('gateway connect failed bad url');
        });

        it('leaves transport errors intact when no token is configured', async () => {
          const svc = new GatewayChatService({
            url: 'ws://gw.test',
            token: '',
            wsFactory: () => {
              throw new Error('Invalid URL');
            },
          });
          services.push(svc);
          await expect(svc.connect()).rejects.toThrow('gateway connect failed Invalid URL');
        });

        it('keys the gateway identity on the url and token unambiguously', () => {
          const a = service([]);
          a.updateConnection('ws://a:1', 'b');
          const b = service([]);
          b.updateConnection('ws://a', '1:b');
          expect(a.getGatewayIdentity()).not.toBe(b.getGatewayIdentity());
          expect(a.getGatewayIdentity()).toContain('ws://a:1');
        });
      });

      describe('handshake details', () => {
        it('sends connect after the challenge fallback when the gateway sends no challenge', async () => {
          jest.useFakeTimers();
          const ws = createMockWs();
          const svc = service([ws]);
          const connecting = svc.connect();
          ws.emit('open');
          expect(requests(ws, 'connect')).toHaveLength(0);
          jest.advanceTimersByTime(500);
          const hello = last(ws, 'connect');
          ws.emit('message', JSON.stringify({ type: 'res', id: hello.id, ok: true, payload: helloPayload() }));
          await connecting;
          expect(svc.isRunning).toBe(true);
        });

        it('sends a single connect request and ignores unrelated frames during the handshake', async () => {
          const ws = createMockWs();
          const svc = service([ws]);
          const connecting = svc.connect();
          ws.emit('open');
          emitEvent(ws, 'connect.challenge', {});
          emitEvent(ws, 'connect.challenge', {});
          emitEvent(ws, 'session.message', { text: 'early' });
          ws.emit('message', 'not json');
          ws.emit('message', JSON.stringify({ type: 'res', id: 'other', ok: false, error: TOKEN_MISMATCH_ERROR }));
          expect(requests(ws, 'connect')).toHaveLength(1);
          reply(ws, last(ws, 'connect'), helloPayload());
          await connecting;
          expect(svc.isRunning).toBe(true);
        });

        it('times out a handshake that never answers and schedules a reconnect', async () => {
          jest.useFakeTimers();
          const log: string[] = [];
          const ws = createMockWs();
          const svc = service([ws], { log });
          const connecting = svc.connect();
          ws.emit('open');
          emitEvent(ws, 'connect.challenge', {});
          jest.advanceTimersByTime(10_000);
          await expect(connecting).rejects.toThrow('gateway handshake timed out');
          expect(log.some((line) => line.includes('reconnect scheduled'))).toBe(true);
        });

        it('rejects hello-ok delivered by a socket retired mid-handshake', async () => {
          const ws = createMockWs();
          ws.close = () => {};
          const svc = service([ws, createMockWs()]);
          const connecting = svc.connect();
          ws.emit('open');
          emitEvent(ws, 'connect.challenge', {});
          svc.updateConnection('ws://other.test', 'rotated');
          reply(ws, last(ws, 'connect'), helloPayload());
          await expect(connecting).rejects.toThrow('retired socket delivered hello-ok');
          expect(svc.isRunning).toBe(false);
        });

        it('adopts the newer attempt when credentials change between hello-ok and its settlement', async () => {
          const [first, second] = [createMockWs(), createMockWs()];
          const svc = service([first, second]);
          const stale = svc.connect();
          answerHandshake(first);
          svc.updateConnection('ws://other.test', 'rotated');
          const fresh = svc.connect();
          answerHandshake(second);
          await expect(stale).resolves.toBeUndefined();
          await fresh;
          expect(svc.isRunning).toBe(true);
          expect(svc.getGatewayIdentity()).toContain('rotated');
        });

        it('rejects a superseded attempt when no newer attempt is pending', async () => {
          const ws = createMockWs();
          const svc = service([ws]);
          const connecting = svc.connect();
          answerHandshake(ws);
          svc.suspend();
          await expect(connecting).rejects.toThrow('superseded by a newer attempt');
        });

        it('resolves connect() at once while connected and ignores frames of a retired socket', async () => {
          const [first, second] = [createMockWs(), createMockWs()];
          const { svc } = await connected([first, second]);
          await svc.connect();
          expect(first.sent.filter((raw) => raw.includes('"connect"'))).toHaveLength(1);
          const observer = recorder();
          svc.resumeSession('main', observer.sink, { historyRendered: true });
          reply(first, last(first, 'sessions.messages.subscribe'));
          await flush();
          svc.updateConnection('ws://other.test', 'rotated');
          observer.events.length = 0;
          emitEvent(first, 'session.message', { sessionKey: 'main', delta: 'late' });
          expect(observer.events).toEqual([]);
        });
      });

      describe('reconnect scheduling', () => {
        it('keeps one pending reconnect when credentials change while one is scheduled', async () => {
          jest.useFakeTimers();
          const sockets = [createMockWs(), createMockWs(), createMockWs()];
          const opened: MockSocket[] = [];
          const svc = new GatewayChatService({
            url: 'ws://gw.test',
            token: 't',
            wsFactory: () => {
              const socket = sockets.shift()!;
              opened.push(socket);
              return socket;
            },
          });
          services.push(svc);
          const connecting = svc.connect();
          answerHandshake(opened[0]);
          await connecting;
          opened[0].emit('close');
          svc.updateConnection('ws://other.test', 'rotated');
          jest.advanceTimersByTime(60_000);
          expect(opened).toHaveLength(2);
        });

        it('cancels a scheduled reconnect on an explicit connect()', async () => {
          jest.useFakeTimers();
          const [first, second] = [createMockWs(), createMockWs()];
          const opened: MockSocket[] = [];
          const queue = [first, second];
          const svc = new GatewayChatService({
            url: 'ws://gw.test',
            token: 't',
            wsFactory: () => {
              const socket = queue.shift() ?? createMockWs();
              opened.push(socket);
              return socket;
            },
          });
          services.push(svc);
          const connecting = svc.connect();
          answerHandshake(first);
          await connecting;
          first.emit('close');
          const again = svc.connect();
          answerHandshake(second);
          await again;
          jest.advanceTimersByTime(60_000);
          expect(opened).toEqual([first, second]);
        });

        it('does not schedule a reconnect when credentials change before any connect()', () => {
          jest.useFakeTimers();
          let opened = 0;
          const svc = new GatewayChatService({
            url: 'ws://gw.test',
            token: 't',
            wsFactory: () => {
              opened += 1;
              return createMockWs();
            },
          });
          services.push(svc);
          svc.updateConnection('ws://other.test', 'rotated');
          svc.updateConnection('ws://other.test', 'rotated');
          jest.advanceTimersByTime(60_000);
          expect(opened).toBe(0);
        });
      });

      describe('rpc', () => {
        it('times out an unanswered request and ignores its late response', async () => {
          const { svc, ws } = await connected();
          jest.useFakeTimers();
          const listing = svc.listSessions({});
          jest.advanceTimersByTime(30_000);
          await expect(listing).rejects.toThrow('gateway rpc timeout method=sessions.list');
          expect(() => reply(ws, last(ws, 'sessions.list'), { sessions: [] })).not.toThrow();
        });

        it('rejects with the error code of a failed response, or unknown without one', async () => {
          const { svc, ws } = await connected();
          const coded = svc.listSessions({});
          rejectRpc(ws, last(ws, 'sessions.list'), { code: 'NOPE' });
          await expect(coded).rejects.toThrow('gateway rpc error code=NOPE');
          const bare = svc.listSessions({});
          ws.emit('message', JSON.stringify({ type: 'res', id: last(ws, 'sessions.list').id, ok: 'yes' }));
          await expect(bare).rejects.toThrow('gateway rpc error code=unknown');
        });

        it('rejects a request whose socket write throws', async () => {
          const { svc, ws } = await connected();
          ws.send = () => {
            throw new Error('socket closing');
          };
          await expect(svc.listSessions({})).rejects.toThrow('gateway rpc send failed method=sessions.list socket closing');
        });

        it('ignores garbage and unknown runtime frames', async () => {
          const { svc, ws } = await connected();
          const observer = recorder();
          svc.resumeSession('main', observer.sink, { historyRendered: true });
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          ws.emit('message', '{');
          ws.emit('message', JSON.stringify({ type: 'res', id: 'nobody', ok: true }));
          emitEvent(ws, 'sessions.changed', { sessionKey: 'main' });
          emitEvent(ws, 'session.message', null);
          emitEvent(ws, 'session.message', 'text');
          expect(observer.events).toEqual([]);
        });
      });

      describe('session state snapshots', () => {
        it('returns null when a session has no catch-up state', () => {
          expect(service([]).captureSessionState('main')).toBeNull();
        });

        it('restores a captured snapshot after the sink was cleared', () => {
          const svc = service([]);
          svc.seedHistory('main', { deltaCursor: 'c1', messages: [{ messageId: 'm1', role: 'assistant', text: 'a' }] });
          const snapshot = svc.captureSessionState('main');
          svc.clearSessionSink('main');
          expect(svc.captureSessionState('main')).toBeNull();
          svc.restoreSessionState('main', snapshot);
          expect(svc.captureSessionState('main')).toEqual(snapshot);
        });

        it('restores partial snapshots and ignores a null one', () => {
          const svc = service([]);
          svc.restoreSessionState('main', null);
          svc.restoreSessionState('main', { deltaCursor: 'c9' });
          expect(svc.captureSessionState('main')).toEqual({ deltaCursor: 'c9' });
        });

        it('evicts the oldest seen id once the per-session cap is reached', () => {
          const svc = service([]);
          const rows = Array.from({ length: 501 }, (_, i) => ({ messageId: `m${i}`, role: 'assistant', text: 't' }));
          svc.seedHistory('main', { messages: [...rows, rows[500]] });
          const seen = svc.captureSessionState('main')?.seenMessageIds;
          expect(seen?.size).toBe(500);
          expect(seen?.has('m0')).toBe(false);
          expect(seen?.has('m500')).toBe(true);
        });

        it('ignores seed payloads that are not objects', () => {
          const svc = service([]);
          svc.seedHistory('main', null);
          svc.seedHistory('main', 'rows');
          svc.seedHistory('main', { cursor: 'c2' });
          expect(svc.captureSessionState('main')).toEqual({ deltaCursor: 'c2' });
        });
      });

      describe('transcript sinks', () => {
        it('rebinds a transcript sink without claiming the active session', async () => {
          const { svc, ws } = await connected();
          svc.setActiveSession('agent:a:main');
          const observer = recorder();
          svc.rebindTranscriptSink('main', observer.sink);
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          emitEvent(ws, 'session.message', { sessionKey: 'main', delta: 'x' });
          expect(observer.events).toEqual([{ type: 'text', text: 'x' }]);
          expect(svc.getActiveSessionKey()).toBe('agent:a:main');
        });

        it('unsubscribes when the last sink leaves and logs a failed unsubscribe', async () => {
          const log: string[] = [];
          const { svc, ws } = await connected([createMockWs()], {
            methods: [...METHODS, 'sessions.messages.unsubscribe'],
            log,
          });
          const observer = recorder();
          svc.resumeSession('main', observer.sink, { historyRendered: true });
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          svc.removeTranscriptSink('main', observer.sink);
          svc.removeTranscriptSink('main', observer.sink);
          const unsubscribe = last(ws, 'sessions.messages.unsubscribe');
          expect(unsubscribe.params).toEqual({ sessionKeys: ['main'] });
          rejectRpc(ws, unsubscribe);
          await flush();
          expect(log.some((line) => line.includes('sessions.messages.unsubscribe failed'))).toBe(true);
        });

        it('releases a subscription whose sinks all left while it was in flight', async () => {
          const { svc, ws } = await connected([createMockWs()], { methods: [...METHODS, 'sessions.messages.unsubscribe'] });
          const observer = recorder();
          svc.seedHistory('main', { deltaCursor: 'c1', messages: [] });
          svc.resumeSession('main', observer.sink, { historyRendered: true });
          svc.clearSessionSink('main');
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          expect(requests(ws, 'sessions.messages.unsubscribe')).toHaveLength(1);
          expect(requests(ws, 'chat.history')).toHaveLength(0);
        });

        it('retires resume sinks with done when the gateway lacks transcript subscriptions', async () => {
          const { svc } = await connected([createMockWs()], { methods: ['sessions.list'] });
          const observer = recorder();
          svc.resumeSession('main', observer.sink);
          expect(observer.events).toEqual([{ type: 'done' }]);
        });

        it('keeps resume sinks when their subscription fails, so a reconnect restores them', async () => {
          const [first, second] = [createMockWs(), createMockWs()];
          const { svc, ws } = await connected([first, second]);
          const observer = recorder();
          svc.resumeSession('main', observer.sink, { historyRendered: true });
          rejectRpc(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          expect(observer.events).toEqual([]);
          await reconnect(svc, first, second);
          reply(second, last(second, 'sessions.messages.subscribe'));
          await flush();
          emitEvent(second, 'session.message', { sessionKey: 'main', delta: 'back' });
          expect(observer.events).toEqual([{ type: 'text', text: 'back' }]);
        });

        it('fans a session out to its sinks only, never to another session', async () => {
          const { svc, ws } = await connected();
          const a = recorder();
          const a2 = recorder();
          const b = recorder();
          svc.resumeSession('agent:a:main', a.sink, { historyRendered: true });
          svc.resumeSession('agent:a:main', a2.sink, { historyRendered: true });
          svc.resumeSession('agent:b:main', b.sink, { historyRendered: true });
          for (const subscribe of requests(ws, 'sessions.messages.subscribe')) reply(ws, subscribe);
          await flush();
          emitEvent(ws, 'session.message', { sessionKey: 'agent:a:main', delta: 'for a' });
          emitEvent(ws, 'session.message', { sessionKey: 'agent:c:main', delta: 'unknown' });
          emitEvent(ws, 'session.message', { sessionKey: 'agent:a:main', role: 'user', text: 'prompt' });
          expect(a.events).toEqual([{ type: 'text', text: 'for a' }]);
          expect(a2.events).toEqual([{ type: 'text', text: 'for a' }]);
          expect(b.events).toEqual([]);
          expect(requests(ws, 'sessions.messages.subscribe')).toHaveLength(2);
        });
      });

      describe('resume catch-up scheduling', () => {
        it('catches up a second resume once the shared subscription succeeds', async () => {
          const { svc, ws } = await connected();
          svc.resumeSession('main', () => {}, { historyRendered: true });
          const second = recorder();
          svc.resumeSession('main', second.sink);
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          expect(requests(ws, 'chat.history')).toHaveLength(1);
          reply(ws, last(ws, 'chat.history'), { messages: [{ messageId: 'm1', role: 'assistant', text: 'missed' }] });
          await flush();
          expect(second.events).toEqual([{ type: 'text', text: 'missed' }, { type: 'done' }]);
        });

        it('skips the catch-up of a second resume when the shared subscription fails', async () => {
          const { svc, ws } = await connected();
          svc.resumeSession('main', () => {});
          svc.resumeSession('main', () => {});
          rejectRpc(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          expect(requests(ws, 'chat.history')).toHaveLength(0);
        });

        it('catches up directly when resuming an already subscribed session', async () => {
          const { svc, ws } = await connected();
          svc.resumeSession('main', () => {}, { historyRendered: true });
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          svc.resumeSession('main', () => {});
          expect(requests(ws, 'chat.history')).toHaveLength(1);
          expect(requests(ws, 'sessions.messages.subscribe')).toHaveLength(1);
        });

        it('skips catch-up and history fetches when the gateway lacks chat.history', async () => {
          const methods = ['chat.send', 'sessions.messages.subscribe'];
          const { svc, ws } = await connected([createMockWs()], { methods });
          svc.resumeSession('main', () => {});
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          await expect(svc.getHistory('main')).resolves.toBeNull();
          expect(requests(ws, 'chat.history')).toHaveLength(0);
        });

        it('ignores a catch-up payload without a messages array and logs a failed one', async () => {
          const log: string[] = [];
          const { svc, ws } = await connected([createMockWs()], { log });
          const observer = recorder();
          svc.resumeSession('main', observer.sink);
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          reply(ws, last(ws, 'chat.history'), null);
          await flush();
          svc.resumeSession('main', observer.sink);
          rejectRpc(ws, last(ws, 'chat.history'));
          await flush();
          expect(observer.events).toEqual([]);
          expect(log.some((line) => line.includes('chat.history catch-up failed'))).toBe(true);
        });
      });

      describe('send lifecycle', () => {
        it('refuses a send while the previous run on the session is still aborting', async () => {
          const { svc, ws } = await connected();
          await acceptedRun(svc, ws, () => {});
          svc.abort('main');
          const next = recorder();
          svc.sendMessage('again', '/tmp', 'm', 'chat', next.sink);
          expect(next.types()).toEqual(['error', 'done']);
          expect(next.events[0]).toMatchObject({ message: expect.stringContaining('still aborting') });
        });

        it('fails the send with error and done when chat.send is rejected', async () => {
          const { svc, ws } = await connected();
          const run = recorder();
          await issueSend(svc, ws, run.sink);
          rejectRpc(ws, last(ws, 'chat.send'), { code: 'BUSY' });
          await flush();
          expect(run.events).toEqual([{ type: 'error', message: 'gateway rpc error code=BUSY' }, { type: 'done' }]);
          expect(svc.hasOwnedRun('main')).toBe(false);
        });

        it('fails the send when the pre-send history snapshot is rejected', async () => {
          const { svc, ws } = await connected();
          const run = recorder();
          svc.sendMessage('hi', '/tmp', 'm', 'chat', run.sink);
          await flush();
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          rejectRpc(ws, last(ws, 'chat.history'));
          await flush();
          expect(run.types()).toEqual(['error', 'done']);
          expect(requests(ws, 'chat.send')).toHaveLength(0);
        });

        it('never issues a send aborted during its pre-send history snapshot', async () => {
          const { svc, ws } = await connected();
          const run = recorder();
          svc.sendMessage('hi', '/tmp', 'm', 'chat', run.sink);
          await flush();
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          svc.abort('main');
          reply(ws, last(ws, 'chat.history'), { messages: [] });
          await flush();
          expect(run.events).toEqual([{ type: 'done' }]);
          expect(requests(ws, 'chat.send')).toHaveLength(0);
        });

        it('ignores the late acknowledgement of an aborted send', async () => {
          const { svc, ws } = await connected();
          const run = recorder();
          await issueSend(svc, ws, run.sink);
          svc.abort('main');
          reply(ws, last(ws, 'chat.send'), { sessionKey: 'main' });
          reply(ws, last(ws, 'chat.abort'));
          await flush();
          emitEvent(ws, 'session.message', { sessionKey: 'main', delta: 'late' });
          expect(run.events).toEqual([{ type: 'done' }]);
          expect(svc.hasOwnedRun('main')).toBe(false);
        });

        it('keeps the requested key when the acknowledgement names no session', async () => {
          const { svc, ws } = await connected();
          const run = recorder();
          await issueSend(svc, ws, run.sink);
          reply(ws, last(ws, 'chat.send'), { sessionKey: 7 });
          await flush();
          emitEvent(ws, 'session.message', { sessionKey: 'main', delta: 'ok' });
          expect(run.events).toEqual([{ type: 'text', text: 'ok' }]);
        });

        it('moves the run to a resolved key, notifies the thread and warns about a boundary-less snapshot', async () => {
          const log: string[] = [];
          const { svc, ws } = await connected([createMockWs()], { log });
          const run = recorder();
          const resolved: Array<[string, string]> = [];
          svc.sendMessage('hi', '/tmp', 'm', 'chat', run.sink, (key, requested) => resolved.push([key, requested]));
          await flush();
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          reply(ws, last(ws, 'chat.history'), { messages: [] });
          await flush();
          reply(ws, last(ws, 'chat.send'), { sessionKey: 'agent:x:main' });
          await flush();
          expect(resolved).toEqual([['agent:x:main', 'main']]);
          expect(last(ws, 'sessions.messages.subscribe').params).toEqual({ sessionKeys: ['agent:x:main'] });
          reply(ws, last(ws, 'chat.history'), {});
          await flush();
          expect(log.some((line) => line.includes('carried no recovery boundary'))).toBe(true);
          emitEvent(ws, 'session.message', { sessionKey: 'main', delta: 'old key' });
          emitEvent(ws, 'session.message', { sessionKey: 'agent:x:main', delta: 'new key' });
          expect(run.events).toEqual([{ type: 'text', text: 'new key' }]);
          expect(svc.getActiveSessionKey()).toBe('agent:x:main');
        });

        it('reports a failed transcript subscription for an accepted run on a resolved key', async () => {
          const { svc, ws } = await connected();
          const run = recorder();
          await issueSend(svc, ws, run.sink);
          reply(ws, last(ws, 'chat.send'), { sessionKey: 'agent:x:main' });
          await flush();
          rejectRpc(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          expect(run.types()).toEqual(['error', 'done']);
          expect(run.events[0]).toMatchObject({ message: expect.stringContaining('failed: gateway rpc error code=X') });
        });

        it('keeps frames buffered for another issued send when one send is acknowledged', async () => {
          const { svc, ws } = await connected();
          const a = recorder();
          const b = recorder();
          svc.setActiveSession('agent:a:main');
          await issueSend(svc, ws, a.sink);
          const sendA = last(ws, 'chat.send');
          svc.setActiveSession('agent:b:main');
          await issueSend(svc, ws, b.sink);
          const sendB = last(ws, 'chat.send');
          emitEvent(ws, 'session.message', { sessionKey: 'agent:a:main', delta: 'for a' });
          emitEvent(ws, 'session.message', { sessionKey: 'agent:b:main', delta: 'for b' });
          reply(ws, sendB, { sessionKey: 'agent:b:main' });
          await flush();
          reply(ws, sendA, { sessionKey: 'agent:a:main' });
          await flush();
          expect(a.events).toEqual([{ type: 'text', text: 'for a' }]);
          expect(b.events).toEqual([{ type: 'text', text: 'for b' }]);
        });

        it('hands a sinkless frame to the issued send that resolves to its session', async () => {
          const { svc, ws } = await connected();
          const a = recorder();
          const b = recorder();
          svc.setActiveSession('agent:a:main');
          await issueSend(svc, ws, a.sink);
          const sendA = last(ws, 'chat.send');
          svc.setActiveSession('agent:b:main');
          await issueSend(svc, ws, b.sink);
          const sendB = last(ws, 'chat.send');
          emitEvent(ws, 'session.message', { sessionKey: 'agent:z:main', delta: 'resolved' });
          emitEvent(ws, 'session.message', { sessionKey: 'agent:y:main', delta: 'orphan' });
          reply(ws, sendA, { sessionKey: 'agent:a:main' });
          await flush();
          reply(ws, sendB, { sessionKey: 'agent:z:main' });
          await flush();
          expect(a.events).toEqual([]);
          expect(b.events).toEqual([{ type: 'text', text: 'resolved' }]);
        });

        it('delivers nothing buffered after a buffered end finished the run', async () => {
          const { svc, ws } = await connected();
          const run = recorder();
          await issueSend(svc, ws, run.sink);
          emitEvent(ws, 'session_end', { sessionKey: 'main' });
          emitEvent(ws, 'session.message', { sessionKey: 'main', delta: 'after end' });
          reply(ws, last(ws, 'chat.send'), { sessionKey: 'main' });
          await flush();
          expect(run.events).toEqual([{ type: 'done' }]);
        });

        it('buffers an end for a sinkless resolved key until the acknowledgement', async () => {
          const { svc, ws } = await connected();
          const run = recorder();
          await issueSend(svc, ws, run.sink);
          emitEvent(ws, 'session_end', { sessionKey: 'agent:x:main' });
          expect(run.events).toEqual([]);
          reply(ws, last(ws, 'chat.send'), { sessionKey: 'agent:x:main' });
          await flush();
          expect(run.events).toEqual([{ type: 'done' }]);
        });

        it('steers with the same sink without a spurious done', async () => {
          const { svc, ws } = await connected();
          const run = recorder();
          await acceptedRun(svc, ws, run.sink, { deltaCursor: 'c1', messages: [] });
          svc.sendMessage('more', '/tmp', 'm', 'chat', run.sink);
          await flush();
          expect(last(ws, 'chat.send').params.queueMode).toBe('steer');
          reply(ws, last(ws, 'chat.send'), { sessionKey: 'main' });
          await flush();
          emitEvent(ws, 'session_end', { sessionKey: 'main' });
          expect(run.events).toEqual([{ type: 'done' }]);
        });

        it('keeps another send\'s buffered frames when an issued send is aborted', async () => {
          const { svc, ws } = await connected();
          const b = recorder();
          svc.setActiveSession('agent:a:main');
          await issueSend(svc, ws, () => {});
          svc.setActiveSession('agent:b:main');
          await issueSend(svc, ws, b.sink);
          emitEvent(ws, 'session.message', { sessionKey: 'agent:b:main', delta: 'for b' });
          svc.abort('agent:a:main');
          reply(ws, last(ws, 'chat.send'), { sessionKey: 'agent:b:main' });
          await flush();
          expect(b.events).toEqual([{ type: 'text', text: 'for b' }]);
        });

        it('hands the frames of a replaced issued send to the steering send', async () => {
          const { svc, ws } = await connected();
          const thread = recorder();
          await issueSend(svc, ws, thread.sink);
          const firstSend = last(ws, 'chat.send');
          emitEvent(ws, 'session.message', { sessionKey: 'main', messageId: 'm1', delta: 'he' });
          svc.sendMessage('more', '/tmp', 'm', 'chat', thread.sink);
          await flush();
          emitEvent(ws, 'session.message', { sessionKey: 'main', messageId: 'm1', delta: 'llo' });
          reply(ws, last(ws, 'chat.history'), { messages: [] });
          await flush();
          const steerSend = last(ws, 'chat.send');
          expect(steerSend.params.queueMode).toBe('steer');
          reply(ws, firstSend, { sessionKey: 'main' });
          reply(ws, steerSend, { sessionKey: 'main' });
          await flush();
          emitEvent(ws, 'session.message', { sessionKey: 'main', messageId: 'm1', text: 'hello world' });
          emitEvent(ws, 'session_end', { sessionKey: 'main' });
          expect(thread.events).toEqual([
            { type: 'text', text: 'he' },
            { type: 'text', text: 'llo' },
            { type: 'text', text: ' world' },
            { type: 'done' },
          ]);
        });

        it('holds an end of the replaced issued run until the steering send is acknowledged', async () => {
          const { svc, ws } = await connected();
          const observer = recorder();
          svc.resumeSession('main', observer.sink, { historyRendered: true });
          const first = recorder();
          await issueSend(svc, ws, first.sink);
          const steering = recorder();
          svc.sendMessage('more', '/tmp', 'm', 'chat', steering.sink);
          await flush();
          emitEvent(ws, 'session_end', { sessionKey: 'main' });
          expect(observer.events).toEqual([]);
          reply(ws, last(ws, 'chat.history'), { messages: [] });
          await flush();
          reply(ws, last(ws, 'chat.send'), { sessionKey: 'main' });
          await flush();
          expect(first.events).toEqual([{ type: 'done' }]);
          expect(steering.events).toEqual([{ type: 'done' }]);
          expect(observer.events).toEqual([{ type: 'done' }]);
        });

        it('does not rebind the thread when a buffered end already finished the resolved run', async () => {
          const { svc, ws } = await connected();
          const resolved: string[] = [];
          const run = recorder();
          svc.sendMessage('hi', '/tmp', 'm', 'chat', run.sink, (key) => resolved.push(key));
          await flush();
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          reply(ws, last(ws, 'chat.history'), { messages: [] });
          await flush();
          emitEvent(ws, 'session_end', { sessionKey: 'agent:x:main' });
          reply(ws, last(ws, 'chat.send'), { sessionKey: 'agent:x:main' });
          await flush();
          expect(run.events).toEqual([{ type: 'done' }]);
          expect(resolved).toEqual([]);
        });

      });

      describe('abort edge cases', () => {
        it('does nothing without a session key or a run', async () => {
          const { svc, ws } = await connected();
          svc.abort();
          svc.abort('main');
          expect(requests(ws, 'chat.abort')).toHaveLength(0);
        });

        it('completes the run with done even when chat.abort fails', async () => {
          const log: string[] = [];
          const { svc, ws } = await connected([createMockWs()], { log });
          const run = recorder();
          await acceptedRun(svc, ws, run.sink);
          svc.abort('main');
          rejectRpc(ws, last(ws, 'chat.abort'));
          await flush();
          expect(run.events).toEqual([{ type: 'done' }]);
          expect(log.some((line) => line.includes('chat.abort failed'))).toBe(true);
        });

        it('drops late frames of an aborting session and remembers its completed message', async () => {
          const { svc, ws } = await connected();
          const observer = recorder();
          svc.resumeSession('main', observer.sink, { historyRendered: true });
          await acceptedRun(svc, ws, () => {});
          svc.abort('main');
          emitEvent(ws, 'session.message', { sessionKey: 'main', messageId: 'm1', text: 'late final' });
          emitEvent(ws, 'session.message', { sessionKey: 'main', delta: 'late delta' });
          emitEvent(ws, 'session_end', { sessionKey: 'main' });
          reply(ws, last(ws, 'chat.abort'));
          await flush();
          expect(observer.events).toEqual([]);
          expect(svc.captureSessionState('main')?.seenMessageIds?.has('m1')).toBe(true);
        });
      });

      describe('keyless session_end', () => {
        it('finishes the only active run', async () => {
          const { svc, ws } = await connected();
          svc.resumeSession('agent:idle:main', () => {}, { historyRendered: true });
          const run = recorder();
          await acceptedRun(svc, ws, run.sink);
          emitEvent(ws, 'session_end', {});
          expect(run.events).toEqual([{ type: 'done' }]);
        });

        it('treats an empty session key as keyless', async () => {
          const { svc, ws } = await connected();
          const run = recorder();
          await acceptedRun(svc, ws, run.sink);
          emitEvent(ws, 'session_end', { sessionKey: '' });
          expect(run.events).toEqual([{ type: 'done' }]);
        });

        it('finishes the only observed session and drops an ambiguous end', async () => {
          const { svc, ws } = await connected();
          const a = recorder();
          svc.resumeSession('agent:a:main', a.sink, { historyRendered: true });
          emitEvent(ws, 'session_end', null);
          expect(a.events).toEqual([{ type: 'done' }]);
          const b = recorder();
          svc.resumeSession('agent:b:main', b.sink, { historyRendered: true });
          emitEvent(ws, 'session_end', {});
          expect(a.events).toHaveLength(1);
          expect(b.events).toEqual([]);
        });
      });

      describe('live frame dedupe', () => {
        it('drops the text of a repeated complete frame but keeps its tool update', async () => {
          const { svc, ws } = await connected();
          const run = recorder();
          await acceptedRun(svc, ws, run.sink);
          emitEvent(ws, 'session.message', { sessionKey: 'main', messageId: 'm1', text: 'done' });
          emitEvent(ws, 'session.message', {
            sessionKey: 'main',
            messageId: 'm1',
            text: 'done',
            toolCall: { id: 't1', name: 'shell', status: 'done', details: '' },
          });
          expect(run.events).toEqual([
            { type: 'text', text: 'done' },
            { type: 'toolCall', title: 'shell', status: 'done', details: '', id: 't1' },
          ]);
        });

        it('passes textless tool and usage frames through untouched', async () => {
          const { svc, ws } = await connected();
          const run = recorder();
          await acceptedRun(svc, ws, run.sink);
          emitEvent(ws, 'session.message', { sessionKey: 'main', messageId: 'm1', toolCall: { name: 'shell' } });
          emitEvent(ws, 'session.message', { sessionKey: 'main', usage: { promptTokens: 1, completionTokens: 2 } });
          expect(run.events).toEqual([
            { type: 'toolCall', title: 'shell', status: 'running', details: '' },
            { type: 'usage', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } },
          ]);
        });

        it('keeps a diverging full text of a keyless stream intact', async () => {
          const { svc, ws } = await connected();
          const run = recorder();
          await acceptedRun(svc, ws, run.sink);
          emitEvent(ws, 'session.message', { sessionKey: 'main', delta: 'he' });
          emitEvent(ws, 'session.message', { sessionKey: 'main', delta: 'x', text: 'other' });
          expect(run.events).toEqual([{ type: 'text', text: 'he' }, { type: 'text', text: 'other' }]);
        });

        it('starts dedupe from zero for the next run once a run ends', async () => {
          const { svc, ws } = await connected();
          const observer = recorder();
          svc.resumeSession('agent:b:main', observer.sink, { historyRendered: true });
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          emitEvent(ws, 'session.message', { sessionKey: 'agent:b:main', messageId: 'b1', delta: 'b' });
          svc.setActiveSession('main');
          const first = recorder();
          await acceptedRun(svc, ws, first.sink, { deltaCursor: 'c1', messages: [] });
          emitEvent(ws, 'session.message', { sessionKey: 'main', messageId: 'm1', delta: 'he' });
          emitEvent(ws, 'session_end', { sessionKey: 'main' });
          const second = recorder();
          await acceptedRun(svc, ws, second.sink);
          emitEvent(ws, 'session.message', { sessionKey: 'main', messageId: 'm1', text: 'hello' });
          emitEvent(ws, 'session.message', { sessionKey: 'agent:b:main', messageId: 'b1', text: 'bye' });
          expect(second.events).toEqual([{ type: 'text', text: 'hello' }]);
          expect(observer.events).toEqual([{ type: 'text', text: 'b' }, { type: 'text', text: 'ye' }]);
        });
      });

      describe('catch-up boundary', () => {
        it('aligns the boundary around delta-only rows it never fingerprinted', async () => {
          const { svc, ws } = await connected();
          const observer = recorder();
          const [a, d, b, c] = [
            { role: 'assistant', text: 'A' },
            { role: 'assistant', delta: 'par' },
            { role: 'assistant', text: 'B' },
            { role: 'assistant', text: 'C' },
          ];
          svc.seedHistory('main', { messages: [a, d, b] });
          svc.resumeSession('main', observer.sink, { historyRendered: true });
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          reply(ws, last(ws, 'chat.history'), { messages: [a, d, b, c] });
          await flush();
          expect(observer.events).toEqual([{ type: 'text', text: 'C' }, { type: 'done' }]);
        });

        it('aligns a sliding history window on the seeded boundary', async () => {
          const { svc, ws } = await connected();
          const observer = recorder();
          const row = (text: string): Record<string, unknown> => ({ role: 'assistant', text });
          svc.seedHistory('main', { messages: [row('A'), row('B'), row('C')] });
          svc.resumeSession('main', observer.sink, { historyRendered: true });
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          reply(ws, last(ws, 'chat.history'), { messages: [row('B'), row('C'), row('D')] });
          await flush();
          expect(observer.events).toEqual([{ type: 'text', text: 'D' }, { type: 'done' }]);
        });

        it('fingerprints role, delta shape and text so similar rows are not confused', async () => {
          const { svc, ws } = await connected();
          const observer = recorder();
          svc.seedHistory('main', {
            messages: [{ toolCall: { name: 'x' } }, { role: 'assistant', delta: 'd', text: 'T' }],
          });
          svc.resumeSession('main', observer.sink, { historyRendered: true });
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          reply(ws, last(ws, 'chat.history'), {
            messages: [{ toolCall: { name: 'x' } }, { role: 'assistant', delta: 'd', text: 'T' }, { role: 'assistant', text: 'T' }],
          });
          await flush();
          expect(observer.events).toEqual([{ type: 'text', text: 'T' }, { type: 'done' }]);
        });

        it('recovers the text of an unseen boundary tail while a run is registered', async () => {
          const [first, second] = [createMockWs(), createMockWs()];
          const { svc, ws } = await connected([first, second]);
          const observer = recorder();
          svc.resumeSession('main', observer.sink, { historyRendered: true });
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          const run = recorder();
          await acceptedRun(svc, ws, run.sink);
          const snapshot = [{ role: 'user', text: 'hi' }, { messageId: 'r1', role: 'assistant', text: 'reply' }];
          reply(ws, last(ws, 'chat.history'), { messages: snapshot });
          await flush();
          await reconnect(svc, first, second);
          reply(second, last(second, 'sessions.messages.subscribe'));
          await flush();
          reply(second, last(second, 'chat.history'), { messages: snapshot });
          await flush();
          expect(run.events).toEqual([{ type: 'text', text: 'reply' }, { type: 'done' }]);
          expect(observer.events).toEqual([{ type: 'text', text: 'reply' }, { type: 'done' }]);
          expect(svc.hasOwnedRun('main')).toBe(false);
        });

        it('finalizes observers on every already-seen final row, not only the tail', async () => {
          const { svc, ws } = await connected();
          const observer = recorder();
          svc.seedHistory('main', { deltaCursor: 'c1', messages: [{ messageId: 'm1', role: 'assistant', text: 'seen' }] });
          svc.resumeSession('main', observer.sink, { historyRendered: true });
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          reply(ws, last(ws, 'chat.history'), {
            messages: [{ messageId: 'm1', role: 'assistant', text: 'seen' }, { messageId: 'm2', role: 'assistant', delta: 'next' }],
          });
          await flush();
          expect(observer.events).toEqual([{ type: 'done' }, { type: 'text', text: 'next' }]);
        });

        it('replays nothing for a boundary tail without a run', async () => {
          const { svc, ws } = await connected();
          const observer = recorder();
          const rows = [{ role: 'assistant', text: 'old' }];
          svc.seedHistory('main', { messages: rows });
          svc.resumeSession('main', observer.sink, { historyRendered: true });
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          reply(ws, last(ws, 'chat.history'), { messages: rows });
          await flush();
          expect(observer.events).toEqual([]);
        });

        it('finalizes observers of a seen tail but keeps a pre-ack run sink out of the replay', async () => {
          const { svc, ws } = await connected();
          const observer = recorder();
          svc.seedHistory('main', { deltaCursor: 'c1', messages: [{ messageId: 'm1', role: 'assistant', text: 'seen' }] });
          svc.resumeSession('main', observer.sink, { historyRendered: true });
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          const catchUp = last(ws, 'chat.history');
          const run = recorder();
          svc.sendMessage('hi', '/tmp', 'm', 'chat', run.sink);
          await flush();
          reply(ws, catchUp, { deltaCursor: 'c1', messages: [{ messageId: 'm1', role: 'assistant', text: 'seen' }] });
          await flush();
          expect(observer.events).toEqual([{ type: 'done' }]);
          expect(run.events).toEqual([]);
          expect(svc.hasOwnedRun('main')).toBe(true);
        });

        it('recovers boundary text for observers only while the registered run is still pre-ack', async () => {
          const { svc, ws } = await connected();
          const observer = recorder();
          const rows = [{ role: 'assistant', text: 'tail' }];
          svc.seedHistory('main', { messages: rows });
          svc.resumeSession('main', observer.sink, { historyRendered: true });
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          const catchUp = last(ws, 'chat.history');
          const run = recorder();
          svc.sendMessage('hi', '/tmp', 'm', 'chat', run.sink);
          await flush();
          reply(ws, catchUp, { messages: rows });
          await flush();
          expect(observer.events).toEqual([{ type: 'text', text: 'tail' }, { type: 'done' }]);
          expect(run.events).toEqual([]);
        });
      });

      describe('handshake', () => {
        it('rejects a handshake error payload of the wrong type without throwing', async () => {
          const ws = createMockWs();
          const svc = service([ws]);
          const connecting = svc.connect();
          expect(() => answerHandshake(ws, { ok: false, error: null })).not.toThrow();
          await expect(connecting).rejects.toThrow('handshake rejected code=unknown');
        });

        it('rejects connect() when the socket closes right after hello-ok', async () => {
          const ws = createMockWs();
          const svc = service([ws]);
          const connecting = svc.connect();
          answerHandshake(ws);
          ws.emit('close');
          await expect(connecting).rejects.toThrow('closed during the handshake');
          expect(svc.isRunning).toBe(false);
        });
      });

      describe('handshake rejections', () => {
        const pairingRequired = {
          code: 'NOT_PAIRED',
          message: 'pairing required: device is not approved yet',
          details: { code: 'PAIRING_REQUIRED', reason: 'not-paired', requestId: 'req-1' },
        };

        function trackedService(): { svc: GatewayChatService; opened: MockSocket[] } {
          const opened: MockSocket[] = [];
          const svc = new GatewayChatService({
            url: 'ws://gw.test',
            token: 'secret-token-value',
            wsFactory: () => {
              const socket = createMockWs();
              opened.push(socket);
              return socket;
            },
          });
          services.push(svc);
          return { svc, opened };
        }

        async function rejectFirstHandshake(error: unknown): Promise<{ opened: MockSocket[]; failure: unknown }> {
          const { svc, opened } = trackedService();
          const connecting = svc.connect();
          answerHandshake(opened[0], { ok: false, error });
          const failure = await connecting.catch((err: unknown) => err);
          return { opened, failure };
        }

        it('sends a connect frame the 2026.9 schema accepts', async () => {
          const ws = createMockWs();
          const svc = service([ws]);
          void svc.connect().catch(() => undefined);
          ws.emit('open');
          emitEvent(ws, 'connect.challenge', { nonce: 'n', ts: 1 });
          const params = last(ws, 'connect').params as {
            minProtocol: number;
            maxProtocol: number;
            client: Record<string, unknown>;
          };
          expect(params.minProtocol).toBeLessThanOrEqual(4);
          expect(params.maxProtocol).toBeGreaterThanOrEqual(4);
          expect(params.client).toMatchObject({ id: 'gateway-client', mode: 'backend', displayName: 'Claw Code' });
          expect(Object.keys(params).sort()).toEqual(['auth', 'client', 'maxProtocol', 'minProtocol', 'role', 'scopes', 'userAgent']);
          expect(Buffer.byteLength(ws.sent[ws.sent.length - 1])).toBeLessThan(64 * 1024);
        });

        it('rejects connect() with the classification, a redacted message and a hint', async () => {
          const { failure } = await rejectFirstHandshake({
            ...TOKEN_MISMATCH_ERROR,
            message: 'unauthorized: token secret-token-value does not match',
          });
          expect(failure).toBeInstanceOf(GatewayConnectError);
          const { rejection, message } = failure as GatewayConnectError;
          expect(rejection).toMatchObject({ kind: 'permanent', code: 'AUTH_TOKEN_MISMATCH', message: 'unauthorized: token *** does not match' });
          expect(rejection.hint).toContain('OpenClaw: Connect to Gateway');
          expect(message).toBe('gateway handshake rejected code=AUTH_TOKEN_MISMATCH: unauthorized: token *** does not match');
        });

        it('caps a long gateway message', async () => {
          const { failure } = await rejectFirstHandshake({ code: 'FORBIDDEN', message: 'x'.repeat(1000) });
          expect((failure as GatewayConnectError).rejection.message).toHaveLength(301);
        });

        it.each([
          ['a permanent rejection', TOKEN_MISMATCH_ERROR],
          ['a pairing request', pairingRequired],
        ])('stops reconnecting after %s even though a 1008 close follows it', async (_label, error) => {
          jest.useFakeTimers();
          const { opened } = await rejectFirstHandshake(error);
          opened[0].emit('close', 1008, Buffer.from('pairing required'));
          jest.advanceTimersByTime(10 * 60_000);
          expect(opened).toHaveLength(1);
        });

        it('waits the rate-limit delay before reconnecting', async () => {
          jest.useFakeTimers();
          const { opened } = await rejectFirstHandshake({
            code: 'INVALID_REQUEST',
            message: 'unauthorized: too many failed authentication attempts (retry later)',
            retryable: true,
            retryAfterMs: 60_000,
            details: { code: 'AUTH_RATE_LIMITED', authReason: 'rate_limited' },
          });
          jest.advanceTimersByTime(59_999);
          expect(opened).toHaveLength(1);
          jest.advanceTimersByTime(1);
          expect(opened).toHaveLength(2);
        });

        it.each([
          ['a rate limit without a delay', { code: 'INVALID_REQUEST', retryable: true, details: { code: 'AUTH_RATE_LIMITED' } }],
          [
            'a pairing request that asks to wait',
            { ...pairingRequired, details: { ...pairingRequired.details, recommendedNextStep: 'wait_then_retry', pauseReconnect: false } },
          ],
        ])('retries %s at the slowest backoff', async (_label, error) => {
          jest.useFakeTimers();
          const { opened } = await rejectFirstHandshake(error);
          jest.advanceTimersByTime(29_999);
          expect(opened).toHaveLength(1);
          jest.advanceTimersByTime(1);
          expect(opened).toHaveLength(2);
        });

        it('honours retryAfterMs of a startup rejection', async () => {
          jest.useFakeTimers();
          const { opened } = await rejectFirstHandshake({
            code: 'UNAVAILABLE',
            message: 'gateway starting; retry shortly',
            retryable: true,
            retryAfterMs: 5000,
            details: { reason: 'startup-sidecars' },
          });
          jest.advanceTimersByTime(4999);
          expect(opened).toHaveLength(1);
          jest.advanceTimersByTime(1);
          expect(opened).toHaveLength(2);
        });

        it('refuses to send a connect frame over the pre-auth limit', async () => {
          jest.useFakeTimers();
          const ws = createMockWs();
          const svc = new GatewayChatService({ url: 'ws://gw.test', token: 't'.repeat(70 * 1024), wsFactory: () => ws });
          services.push(svc);
          const connecting = svc.connect();
          ws.emit('open');
          emitEvent(ws, 'connect.challenge', {});
          const failure = await connecting.catch((err: unknown) => err);
          expect((failure as GatewayConnectError).rejection).toMatchObject({ kind: 'permanent', code: 'CONNECT_FRAME_TOO_LARGE' });
          expect(ws.sent).toHaveLength(0);
        });

        it('ends in-flight runs with the pairing hint when a reconnect needs approval', async () => {
          const [first, second] = [createMockWs(), createMockWs()];
          const { svc, ws } = await connected([first, second]);
          const run = recorder();
          await acceptedRun(svc, ws, run.sink);
          ws.emit('close');
          const reconnecting = svc.connect();
          answerHandshake(second, { ok: false, error: pairingRequired });
          await expect(reconnecting).rejects.toThrow('code=PAIRING_REQUIRED');
          expect(run.types()).toEqual(['error', 'done']);
          expect(run.events[0]).toMatchObject({ message: expect.stringContaining('Approve this device') });
        });
      });

      describe('observers of a pre-ack send', () => {
        async function observedIssuedSend(): Promise<{ svc: GatewayChatService; ws: MockSocket; observer: ReturnType<typeof recorder>; run: ReturnType<typeof recorder> }> {
          const { svc, ws } = await connected();
          const observer = recorder();
          svc.resumeSession('agent:s:main', observer.sink, { historyRendered: true });
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          const run = recorder();
          svc.setActiveSession('agent:s:main');
          await issueSend(svc, ws, run.sink, { deltaCursor: 'c1', messages: [] });
          return { svc, ws, observer, run };
        }

        it('still get the frames held for a send whose acknowledgement resolves another session', async () => {
          const { ws, observer, run } = await observedIssuedSend();
          emitEvent(ws, 'session.message', { sessionKey: 'agent:s:main', messageId: 'm', delta: 'other run' });
          expect(observer.events).toEqual([]);
          reply(ws, last(ws, 'chat.send'), { sessionKey: 'agent:t:main' });
          await flush();
          expect(observer.events).toEqual([{ type: 'text', text: 'other run' }]);
          expect(run.events).toEqual([]);
        });

        it('still get the frames and end held for a send that fails', async () => {
          const { ws, observer, run } = await observedIssuedSend();
          emitEvent(ws, 'session.message', { sessionKey: 'agent:s:main', messageId: 'm', text: 'observer visible' });
          emitEvent(ws, 'session_end', { sessionKey: 'agent:s:main' });
          rejectRpc(ws, last(ws, 'chat.send'));
          await flush();
          expect(observer.events).toEqual([{ type: 'text', text: 'observer visible' }, { type: 'done' }]);
          expect(run.types()).toEqual(['error', 'done']);
        });
      });

      describe('steering a running session', () => {
        it('hands the steered run\'s output during the pre-send window to the steering send', async () => {
          const { svc, ws } = await connected();
          const first = recorder();
          await acceptedRun(svc, ws, first.sink);
          reply(ws, last(ws, 'chat.history'), { messages: [] });
          await flush();
          emitEvent(ws, 'session.message', { sessionKey: 'main', messageId: 'm', delta: 'one ' });
          const steering = recorder();
          svc.sendMessage('steer', '/tmp', 'm', 'chat', steering.sink);
          await flush();
          emitEvent(ws, 'session.message', { sessionKey: 'main', messageId: 'm', delta: 'two ' });
          reply(ws, last(ws, 'chat.history'), { messages: [{ role: 'user', text: 'p' }] });
          await flush();
          reply(ws, last(ws, 'chat.send'), { sessionKey: 'main' });
          await flush();
          emitEvent(ws, 'session.message', { sessionKey: 'main', messageId: 'm', delta: 'three' });
          expect(first.events).toEqual([{ type: 'text', text: 'one ' }, { type: 'done' }]);
          expect(steering.events).toEqual([{ type: 'text', text: 'two ' }, { type: 'text', text: 'three' }]);
        });
      });

      describe('overlapping catch-ups', () => {
        it('replays a tail once for two resumes of the same session', async () => {
          const { svc, ws } = await connected();
          svc.seedHistory('main', { deltaCursor: 'c1', messages: [] });
          const a = recorder();
          const b = recorder();
          svc.resumeSession('main', a.sink, { historyRendered: true });
          svc.resumeSession('main', b.sink, { historyRendered: true });
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          expect(requests(ws, 'chat.history')).toHaveLength(1);
          reply(ws, last(ws, 'chat.history'), { deltaCursor: 'c2', messages: [{ role: 'assistant', text: 'new' }] });
          await flush();
          expect(a.events).toEqual([{ type: 'text', text: 'new' }, { type: 'done' }]);
          expect(b.events).toEqual([{ type: 'text', text: 'new' }, { type: 'done' }]);
        });

        it('runs one more pass when a later caller needs an unscoped catch-up', async () => {
          const { svc, ws } = await connected();
          svc.seedHistory('main', { messages: [{ role: 'assistant', text: 'old' }] });
          svc.resumeSession('main', () => {}, { historyRendered: true });
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          svc.resumeSession('main', () => {});
          svc.resumeSession('main', () => {});
          reply(ws, last(ws, 'chat.history'), { messages: [{ role: 'assistant', text: 'old' }] });
          await flush();
          expect(requests(ws, 'chat.history')).toHaveLength(2);
        });
      });

      describe('abort during a reconnect gap', () => {
        it('sends chat.abort once the gateway is reachable again', async () => {
          const [first, second] = [createMockWs(), createMockWs()];
          const { svc, ws } = await connected([first, second]);
          const run = recorder();
          await acceptedRun(svc, ws, run.sink);
          ws.emit('close');
          svc.abort('main');
          expect(run.events).toEqual([{ type: 'done' }]);
          const connecting = svc.connect();
          answerHandshake(second);
          await connecting;
          expect(last(second, 'chat.abort').params).toEqual({ sessionKey: 'main' });
          emitEvent(second, 'session.message', { sessionKey: 'main', delta: 'late' });
          expect(run.events).toEqual([{ type: 'done' }]);
        });

        it('forgets the pending abort when the credentials change', async () => {
          const [first, second] = [createMockWs(), createMockWs()];
          const { svc, ws } = await connected([first, second]);
          await acceptedRun(svc, ws, () => {});
          ws.emit('close');
          svc.abort('main');
          svc.updateConnection('ws://other.test', 'rotated');
          const connecting = svc.connect();
          answerHandshake(second);
          await connecting;
          expect(requests(second, 'chat.abort')).toHaveLength(0);
        });
      });

      describe('connection state listeners', () => {
        it('announces completed handshakes and socket losses once each', async () => {
          const [first, second, third] = [createMockWs(), createMockWs(), createMockWs()];
          const svc = service([first, second, third]);
          const states: boolean[] = [];
          const unsubscribe = svc.onConnectionStateChange((isConnected) => states.push(isConnected));
          const connecting = svc.connect();
          answerHandshake(first);
          await connecting;
          await reconnect(svc, first, second);
          svc.suspend();
          svc.suspend();
          unsubscribe();
          const again = svc.connect();
          answerHandshake(third);
          await again;
          expect(states).toEqual([true, false, true, false]);
        });

        it('announces nothing for a hello-ok followed by a close in the same tick', async () => {
          const ws = createMockWs();
          const svc = service([ws]);
          const states: boolean[] = [];
          svc.onConnectionStateChange((isConnected) => states.push(isConnected));
          const connecting = svc.connect();
          answerHandshake(ws);
          ws.emit('close');
          await connecting.catch(() => undefined);
          expect(states).toEqual([]);
        });
      });

      describe('transport limits', () => {
        it('reports the gateway defaults before the first handshake and refreshes them on every reconnect', async () => {
          const [first, second] = [createMockWs(), createMockWs()];
          const svc = service([first, second]);
          expect(svc.getTransportLimits()).toEqual({
            maxPayloadBytes: 26214400,
            maxBufferedBytes: 52428800,
            attachmentMaxBytes: 20971520,
            attachmentMaxImageBytes: 6291456,
          });
          const connecting = svc.connect();
          answerHandshake(first, {
            ok: true,
            payload: { ...helloPayload(), policy: { maxPayload: 1000, maxBufferedBytes: 2000, tickIntervalMs: 30000, attachments: { maxBytes: 500, maxImageBytes: 400 } } },
          });
          await connecting;
          expect(svc.getTransportLimits()).toEqual({ maxPayloadBytes: 1000, maxBufferedBytes: 2000, attachmentMaxBytes: 500, attachmentMaxImageBytes: 400 });
          await reconnect(svc, first, second);
          expect(svc.getTransportLimits().maxPayloadBytes).toBe(26214400);
        });
      });

      describe('credential rejection on reconnect', () => {
        it('ends an in-flight run with error and done instead of leaving it streaming', async () => {
          const [first, second] = [createMockWs(), createMockWs()];
          const { svc, ws } = await connected([first, second]);
          const run = recorder();
          await acceptedRun(svc, ws, run.sink);
          ws.emit('close');
          const reconnecting = svc.connect();
          answerHandshake(second, { ok: false, error: TOKEN_MISMATCH_ERROR });
          await expect(reconnecting).rejects.toThrow('handshake rejected');
          expect(run.types()).toEqual(['error', 'done']);
          expect(svc.hasOwnedRun('main')).toBe(false);
        });
      });

      describe('complete-frame dedupe', () => {
        it('renders an identified first frame carrying the same delta and text once', async () => {
          const { svc, ws } = await connected();
          const run = recorder();
          await acceptedRun(svc, ws, run.sink);
          emitEvent(ws, 'session.message', { sessionKey: 'main', messageId: 'm1', delta: 'hello', text: 'hello' });
          expect(run.events).toEqual([{ type: 'text', text: 'hello' }]);
        });
      });

      describe('subscription failure terminals', () => {
        it('gives a steered-out send one done and the steering send its error and done', async () => {
          const { svc, ws } = await connected();
          const first = recorder();
          const steering = recorder();
          svc.sendMessage('a', '/tmp', 'm', 'chat', first.sink);
          svc.sendMessage('b', '/tmp', 'm', 'chat', steering.sink);
          await flush();
          rejectRpc(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          expect(first.events).toEqual([{ type: 'done' }]);
          expect(steering.types()).toEqual(['error', 'done']);
          expect(requests(ws, 'chat.send')).toHaveLength(0);
        });

        it('reports an error to a send that joined a resume subscription which then failed', async () => {
          const { svc, ws } = await connected();
          const observer = recorder();
          svc.resumeSession('main', observer.sink, { historyRendered: true });
          const run = recorder();
          svc.sendMessage('b', '/tmp', 'm', 'chat', run.sink);
          await flush();
          rejectRpc(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          expect(run.types()).toEqual(['error', 'done']);
          expect(observer.events).toEqual([]);
        });
      });

      describe('abort', () => {
        it('completes a send still awaiting its subscription with done and no remote abort', async () => {
          const { svc, ws } = await connected();
          const run = recorder();
          svc.sendMessage('a', '/tmp', 'm', 'chat', run.sink);
          svc.abort('main');
          await flush();
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          expect(run.events).toEqual([{ type: 'done' }]);
          expect(requests(ws, 'chat.abort')).toHaveLength(0);
          expect(requests(ws, 'chat.send')).toHaveLength(0);
        });

        it('aborts the steered remote run when a steering send is cancelled before chat.send', async () => {
          const { svc, ws } = await connected();
          await acceptedRun(svc, ws, () => {}, { deltaCursor: 'c1', messages: [] });
          const steering = recorder();
          svc.sendMessage('more', '/tmp', 'm', 'chat', steering.sink);
          svc.abort('main');
          expect(last(ws, 'chat.abort').params).toEqual({ sessionKey: 'main' });
          reply(ws, last(ws, 'chat.abort'));
          await flush();
          expect(steering.events).toEqual([{ type: 'done' }]);
        });
      });

      describe('acknowledgement under a resolved key', () => {
        it('leaves no registration at the requested key once a drained end finished the run', async () => {
          const { svc, ws } = await connected();
          const run = recorder();
          await issueSend(svc, ws, run.sink);
          emitEvent(ws, 'session.message', { sessionKey: 'agent:x:main', messageId: 'm1', text: 'fast' });
          emitEvent(ws, 'session_end', { sessionKey: 'agent:x:main' });
          reply(ws, last(ws, 'chat.send'), { sessionKey: 'agent:x:main' });
          await flush();
          expect(run.events).toEqual([{ type: 'text', text: 'fast' }, { type: 'done' }]);
          expect(svc.hasOwnedRun('main')).toBe(false);
          expect(svc.hasOwnedRun('agent:x:main')).toBe(false);
        });

        it('drops the frames of a conflicted send instead of leaking them into a later send', async () => {
          const { svc, ws } = await connected();
          svc.setActiveSession('agent:x:main');
          await acceptedRun(svc, ws, () => {});
          const conflicted = recorder();
          svc.setActiveSession('main');
          await issueSend(svc, ws, conflicted.sink);
          emitEvent(ws, 'session.message', { sessionKey: 'agent:z:main', messageId: 'z1', text: 'stale' });
          reply(ws, last(ws, 'chat.send'), { sessionKey: 'agent:x:main' });
          await flush();
          expect(conflicted.types()).toEqual(['error', 'done']);
          const later = recorder();
          svc.setActiveSession('main');
          await issueSend(svc, ws, later.sink);
          reply(ws, last(ws, 'chat.send'), { sessionKey: 'agent:z:main' });
          await flush();
          expect(later.events).toEqual([]);
        });
      });

      describe('session_end routing', () => {
        it('finalizes nothing for a session key of the wrong type', async () => {
          const { svc, ws } = await connected();
          const run = recorder();
          await acceptedRun(svc, ws, run.sink);
          emitEvent(ws, 'session_end', { sessionKey: 42 });
          expect(run.events).toEqual([]);
          expect(svc.hasOwnedRun('main')).toBe(true);
        });
      });

      describe('credential switch', () => {
        it('retires a run sink whose transcript registration was already cleared', async () => {
          const { svc, ws } = await connected();
          const run = recorder();
          await acceptedRun(svc, ws, run.sink);
          svc.clearSessionSink('main');
          svc.updateConnection('ws://other.test', 'rotated');
          expect(run.events).toEqual([{ type: 'done' }]);
          expect(svc.hasOwnedRun('main')).toBe(false);
        });
      });

      describe('history seeding', () => {
        it('never marks user rows as seen', () => {
          const svc = service([]);
          svc.seedHistory('main', { messages: [{ messageId: 'u1', role: 'user', text: 'q' }] });
          expect(svc.captureSessionState('main')?.seenMessageIds).toBeUndefined();
        });
      });

      describe('catch-up replay', () => {
        it('replays the rows after a junk row instead of aborting the catch-up', async () => {
          const { svc, ws } = await connected();
          const observer = recorder();
          svc.seedHistory('main', { deltaCursor: 'c1', messages: [] });
          svc.resumeSession('main', observer.sink, { historyRendered: true });
          reply(ws, last(ws, 'sessions.messages.subscribe'));
          await flush();
          reply(ws, last(ws, 'chat.history'), {
            messages: [null, 7, ['x'], { messageId: 'm1', role: 'assistant', text: 'after junk' }],
          });
          await flush();
          expect(observer.events).toEqual([{ type: 'text', text: 'after junk' }, { type: 'done' }]);
        });

        it('does not replay earlier turns into a run after a cursor-less reconnect', async () => {
          const [first, second] = [createMockWs(), createMockWs()];
          const { svc, ws } = await connected([first, second]);
          const turns = [
            { role: 'user', text: 'q1' },
            { role: 'assistant', text: 'a1' },
            { role: 'user', text: 'q2' },
            { role: 'assistant', text: 'a2' },
          ];
          const run = recorder();
          await acceptedRun(svc, ws, run.sink, { messages: turns });
          reply(ws, last(ws, 'chat.history'), { messages: [...turns, { role: 'user', text: 'hi' }] });
          await flush();
          await reconnect(svc, first, second);
          reply(second, last(second, 'sessions.messages.subscribe'));
          await flush();
          reply(second, last(second, 'chat.history'), {
            messages: [...turns, { role: 'user', text: 'hi' }, { role: 'assistant', text: 'answer' }],
          });
          await flush();
          expect(run.events).toEqual([{ type: 'text', text: 'answer' }, { type: 'done' }]);
          expect(svc.hasOwnedRun('main')).toBe(false);
        });

        it('finalizes a run once when the replayed tail holds several already-seen rows', async () => {
          const [first, second] = [createMockWs(), createMockWs()];
          const { svc, ws } = await connected([first, second]);
          const rows = [
            { messageId: 'a1', role: 'assistant', text: 'one' },
            { messageId: 'a2', role: 'assistant', text: 'two' },
          ];
          const run = recorder();
          await acceptedRun(svc, ws, run.sink, { deltaCursor: 'c1', messages: rows });
          await reconnect(svc, first, second);
          reply(second, last(second, 'sessions.messages.subscribe'));
          await flush();
          reply(second, last(second, 'chat.history'), { deltaCursor: 'c2', messages: rows });
          await flush();
          expect(run.events).toEqual([{ type: 'done' }]);
        });
      });
    });
});
