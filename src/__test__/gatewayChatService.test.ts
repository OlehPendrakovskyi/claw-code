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
    expect(mapSessionEventToChatEvent(evt)).toEqual({ type: 'text', text: 'hi' });
  });
  it('skips user-role messages and non-message events', () => {
    const user: SessionEvent = { event: 'session.message', payload: { role: 'user', text: 'yo' } };
    expect(mapSessionEventToChatEvent(user)).toBeNull();
    const other: SessionEvent = { event: 'sessions.changed', payload: {} };
    expect(mapSessionEventToChatEvent(other)).toBeNull();
  });
  it('maps usage payloads', () => {
    const evt: SessionEvent = {
      event: 'session.message',
      payload: { usage: { promptTokens: 5, completionTokens: 7 } },
    };
    expect(mapSessionEventToChatEvent(evt)).toEqual({
      type: 'usage',
      usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
    });
  });
});

describe('GatewayChatService', () => {
  function makeService(ws: MockSocket, log: { lines: string[] }): GatewayChatService {
    return new GatewayChatService({
      url: 'ws://gateway.test:18789',
      token: 'secret-token-value',
      logger: {
        info: (m) => log.lines.push(m),
        warn: (m) => log.lines.push(m),
        error: (m) => log.lines.push(m),
      },
      wsFactory: () => ws,
    });
  }

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
    expect(events).toEqual([{ type: 'error', message: 'gateway not connected' }, { type: 'done' }]);
  });
});
describe('GatewayChatService sendMessage/abort', () => {
  async function connectService(ws: MockSocket, methods?: string[]): Promise<GatewayChatService> {
    const svc = new GatewayChatService({
      url: 'ws://gateway.test:18789',
      token: 'secret-token-value',
      logger: { info() {}, warn() {}, error() {} },
      wsFactory: () => ws,
    });
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

  it('sends chat.send with enqueue mode and subscribes to session messages', async () => {
    const ws = createMockWs();
    const svc = await connectService(ws);
    svc.sendMessage('hello', '/tmp', 'm', 'chat', () => {});
    await new Promise<void>((r) => setTimeout(r, 0));
    const send = sentRequests(ws).find((r) => r.method === 'chat.send');
    expect(send?.params).toMatchObject({ sessionKey: 'main', text: 'hello', queueMode: 'enqueue' });
    ws.emit('message', JSON.stringify({ type: 'res', id: send!.id, ok: true, payload: { sessionKey: 'main' } }));
    await new Promise<void>((r) => setTimeout(r, 0));
    const subscribe = sentRequests(ws).find((r) => r.method === 'sessions.messages.subscribe');
    expect(subscribe?.params).toEqual({ sessionKeys: ['main'] });
    svc.dispose();
  });

  it('streams session.message deltas to the active sink and finishes on session_end', async () => {
    const ws = createMockWs();
    const svc = await connectService(ws);
    const events: unknown[] = [];
    svc.sendMessage('hi', '/tmp', 'm', 'chat', (e) => events.push(e));
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

  it('abort sends chat.abort and emits done', async () => {
    const ws = createMockWs();
    const svc = await connectService(ws);
    const events: unknown[] = [];
    svc.sendMessage('hi', '/tmp', 'm', 'chat', (e) => events.push(e));
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
    svc.sendMessage('hi', '/tmp', 'm', 'chat', () => {});
    await new Promise<void>((r) => setTimeout(r, 0));
    const send = sentRequests(ws).find((r) => r.method === 'chat.send')!;
    ws.emit('message', JSON.stringify({ type: 'res', id: send.id, ok: true, payload: { sessionKey: 'main' } }));
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(log.lines.join('\n')).toContain('does not advertise');
    svc.dispose();
  });

  it('catches up via chat.history with deltaCursor and dedupes by messageId', async () => {
    const ws = createMockWs();
    const svc = await connectService(ws);
    const events: unknown[] = [];
    svc.onEvent = (e) => events.push(e);
    svc.sendMessage('hi', '/tmp', 'm', 'chat', (e) => events.push(e));
    await new Promise<void>((r) => setTimeout(r, 0));
    const send = sentRequests(ws).find((r) => r.method === 'chat.send')!;
    ws.emit('message', JSON.stringify({ type: 'res', id: send.id, ok: true, payload: { sessionKey: 'main' } }));
    await new Promise<void>((r) => setTimeout(r, 0));
    const subscribe = sentRequests(ws).find((r) => r.method === 'sessions.messages.subscribe')!;
    ws.emit('message', JSON.stringify({ type: 'res', id: subscribe.id, ok: true, payload: {} }));
    await new Promise<void>((r) => setTimeout(r, 0));
    const history = sentRequests(ws).find((r) => r.method === 'chat.history');
    expect(history?.params).toMatchObject({ sessionKey: 'main' });
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
});
