/**
 * Unit tests for GatewayChatService with a mock WebSocket transport.
 */

import { GatewayChatService, parseFrame, mapSessionEventToChatEvent, WebSocketLike } from '../core/gatewayChatService';
import type { SessionEvent } from '../core/contract';

type MockSocket = WebSocketLike & {
  handlers: Map<string, Array<(...args: never[]) => void>>;
  sent: string[];
  emit(event: string, ...args: unknown[]): void;
};

function createMockWs(): MockSocket {
  const handlers = new Map<string, Array<(...args: never[]) => void>>();
  const ws: MockSocket = {
    handlers,
    sent: [],
    send(data: string) {
      ws.sent.push(data);
    },
    close() {
      handlers.get('close')?.forEach((cb) => (cb as (code: number, reason: Buffer) => void)(1000, Buffer.alloc(0)));
    },
    on(event: string, cb: (...args: never[]) => void) {
      const list = handlers.get(event) ?? [];
      list.push(cb as (...args: never[]) => void);
      handlers.set(event, list);
    },
    removeListener(event: string, cb: (...args: unknown[]) => void) {
      handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== (cb as never)));
    },
    emit(event: string, ...args: unknown[]) {
      for (const cb of handlers.get(event) ?? []) {
        (cb as unknown as (...a: unknown[]) => void)(...args);
      }
    },
  };
  return ws;
}

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
    describe('parseFrame', () => {
      it('parses res and event frames from strings and buffers', () => {
        expect(parseFrame('{"type":"res","id":"1","ok":true}')).toEqual({ type: 'res', id: '1', ok: true });
        expect(parseFrame(Buffer.from('{"type":"event","event":"x","payload":{}}'))).toEqual({
          type: 'event',
          event: 'x',
          payload: {},
        });
        expect(parseFrame('not json')).toBeNull();
        expect(parseFrame('{"type":"bogus"}')).toBeNull();
        expect(parseFrame(42)).toBeNull();
      });
    });

    describe('mapSessionEventToChatEvent', () => {
      it('maps assistant session.message text to a text ChatEvent', () => {
        const evt: SessionEvent = { event: 'session.message', payload: { role: 'assistant', text: 'hi' } };
        expect(mapSessionEventToChatEvent(evt)).toEqual([{ type: 'text', text: 'hi' }]);
      });
      it('skips user-role messages and non-message events', () => {
        const user: SessionEvent = { event: 'session.message', payload: { role: 'user', text: 'yo' } };
        expect(mapSessionEventToChatEvent(user)).toEqual([]);
        const other: SessionEvent = { event: 'sessions.changed', payload: {} };
        expect(mapSessionEventToChatEvent(other)).toEqual([]);
      });
      it('maps usage payloads', () => {
        const evt: SessionEvent = {
          event: 'session.message',
          payload: { usage: { promptTokens: 5, completionTokens: 7 } },
        };
        expect(mapSessionEventToChatEvent(evt)).toEqual([
          { type: 'usage', usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 } },
        ]);
      });
      it('maps a mixed delta+text frame without a messageId to the full text only', () => {
        // Both fields describe the same content; without an id the per-message
        // dedupe cannot run, so the full text is canonical (delta would append
        // the same string twice).
        const evt: SessionEvent = {
          event: 'session.message',
          payload: { role: 'assistant', delta: 'hello', text: 'hello' },
        };
        expect(mapSessionEventToChatEvent(evt)).toEqual([{ type: 'text', text: 'hello' }]);
      });
      it('emits both delta and text for a messageId-carrying mixed frame', () => {
        const evt: SessionEvent = {
          event: 'session.message',
          payload: { role: 'assistant', messageId: 'm1', delta: 'hello', text: 'hello' },
        };
        expect(mapSessionEventToChatEvent(evt)).toEqual([
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'hello' },
        ]);
      });
      it('emits toolCall together with delta and usage in the same frame', () => {
        const evt: SessionEvent = {
          event: 'session.message',
          payload: {
            toolCall: { name: 'shell', status: 'running' },
            delta: 'partial',
            usage: { promptTokens: 2, completionTokens: 3 },
          },
        };
        expect(mapSessionEventToChatEvent(evt)).toEqual([
          { type: 'toolCall', title: 'shell', status: 'running', details: '' },
          { type: 'text', text: 'partial' },
          { type: 'usage', usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } },
        ]);
      });
    });

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
          const rejection = { type: 'res', ok: false, error: { code: 'UNAUTHORIZED' } };
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
          const limited = { type: 'res', ok: false, error: { code: 'UNAUTHORIZED', message: 'later', retryable: true } };
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
        ws.emit('message', JSON.stringify({ type: 'res', id: 'cc-1', ok: false, error: { code: 'UNAUTHORIZED', message: 'no' } }));
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
          const svc = makeService(ws, log);
          const connecting = svc.connect();
          await Promise.resolve();
          ws.emit('open');
          ws.emit('message', JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { ts: Date.now() } }));
          ws.emit('message', JSON.stringify(HELLO_OK));
          await Promise.resolve();
          await Promise.resolve();
          expect(svc.isRunning).toBe(true);
          // Reconnect factory replaces ws each attempt.
          let second: MockSocket | null = null;
          (svc as unknown as { wsFactory: (url: string) => WebSocketLike }).wsFactory = () => {
            second = createMockWs();
            return second;
          };
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

      it('emits error+done via onEvent when sendMessage is called while disconnected', () => {
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
        const events: Array<Record<string, unknown>> = [];
        svc.sendMessage('hi', '/tmp', 'm', 'chat', (e) => events.push(e as unknown as Record<string, unknown>));
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
        svc.onEvent = (e) => events.push(e);
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
        svc.onEvent = (e) => events.push(e);
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
        svc.onEvent = (e) => events.push(e);
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
        svc.onEvent = (e) => events.push(e);
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

      it('drops unroutable keyless session.message frames instead of leaking via onEvent', async () => {
        const ws = createMockWs();
        const svc = await connectService(ws);
        const globalEvents: unknown[] = [];
        svc.onEvent = (e) => globalEvents.push(e);
        ws.emit('message', JSON.stringify({ type: 'event', event: 'session.message', payload: { role: 'assistant', text: 'leak' } }));
        await new Promise<void>((r) => setTimeout(r, 0));
        expect(globalEvents).toEqual([]);
        svc.dispose();
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
});
