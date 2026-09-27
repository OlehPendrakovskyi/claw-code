/**
 * Unit tests for the agent picker, session history mapping, and gateway
 * session-selection / resume surface added in wave 2.
 */

import {
  AgentPicker,
  COLD_SESSION_PLACEHOLDER,
  buildAgentSessionItems,
  isColdSession,
  isDuplicateMessage,
  isMainAgentSession,
  isMainAgentSessionKey,
  mapHistoryMessages,
  parseSessionRows,
  toAgentSessionItems,
} from '../core/agentPicker';
import { GatewayChatService, WebSocketLike } from '../core/gatewayChatService';

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
    features: {
      methods: ['sessions.list', 'chat.send', 'sessions.messages.subscribe', 'chat.history', 'chat.abort'],
      events: ['session.message'],
    },
    auth: { role: 'operator', scopes: ['operator.read', 'operator.write'] },
    policy: { maxPayload: 26214400, maxBufferedBytes: 52428800, tickIntervalMs: 15000 },
  },
};

const SESSIONS_ROWS = [
  { key: 'agent:main:main', label: 'Main agent', agentId: 'main', hasActiveRun: true, updatedAt: '2026-09-26T10:00:00Z' },
  { key: 'agent:main:subagent:0214', agentId: 'main', hasActiveRun: false },
  { key: 'agent:coder:main', label: 'Coder', agentId: 'coder', updatedAt: '2026-09-26T11:00:00Z' },
  { key: 'agent:drained:main', agentId: 'drained', placement: { state: 'reclaimed' } },
  { key: 'agent:cold:main', agentId: 'cold', placement: { state: 'provisioning' } },
  { key: 'node:dev:xyz', label: 'Node session' },
  { key: 'main', label: 'Default session' },
  { agentId: 'no-key' },
];

describe('parseSessionRows', () => {
  it('parses {sessions: [...]} payloads and skips malformed rows', () => {
    const parsed = parseSessionRows({ sessions: SESSIONS_ROWS });
    expect(parsed.ok).toBe(true);
    expect(parsed.rows.map((r) => r.key)).toEqual([
      'agent:main:main',
      'agent:main:subagent:0214',
      'agent:coder:main',
      'agent:drained:main',
      'agent:cold:main',
      'node:dev:xyz',
      'main',
    ]);
  });

  it('tolerates bare arrays and junk payloads', () => {
    expect(parseSessionRows(SESSIONS_ROWS).ok).toBe(true);
    expect(parseSessionRows({ sessions: 'nope' }).ok).toBe(false);
    expect(parseSessionRows(null).ok).toBe(false);
    expect(parseSessionRows('junk').rows).toEqual([]);
  });
});

describe('isMainAgentSessionKey', () => {
  it('applies the same filter to webview-supplied keys', () => {
    expect(isMainAgentSessionKey('agent:coder:main')).toBe(true);
    expect(isMainAgentSessionKey('main')).toBe(true);
    expect(isMainAgentSessionKey('agent:main:subagent:0214')).toBe(false);
    expect(isMainAgentSessionKey('node:dev:xyz')).toBe(false);
    expect(isMainAgentSessionKey(undefined)).toBe(false);
    expect(isMainAgentSessionKey(42)).toBe(false);
  });
});

describe('isMainAgentSession', () => {
  it('accepts agent:<id>:main and the bare default session', () => {
    expect(isMainAgentSession({ key: 'agent:main:main' })).toBe(true);
    expect(isMainAgentSession({ key: 'agent:coder:main' })).toBe(true);
    expect(isMainAgentSession({ key: 'main' })).toBe(true);
  });

  it('rejects subagent, foreign, and malformed sessions', () => {
    expect(isMainAgentSession({ key: 'agent:main:subagent:0214' })).toBe(false);
    expect(isMainAgentSession({ key: 'node:dev:xyz' })).toBe(false);
    expect(isMainAgentSession({ key: 'agent:main:main:extra' })).toBe(false);
    expect(isMainAgentSession({ key: '' })).toBe(false);
  });
});

describe('isColdSession', () => {
  it('flags non-materialized placements and passes warm/absent ones', () => {
    expect(isColdSession({ key: 'k', placement: { state: 'provisioning' } })).toBe(true);
    expect(isColdSession({ key: 'k', placement: { state: 'reclaimed' } })).toBe(true);
    expect(isColdSession({ key: 'k', placement: { state: 'active' } })).toBe(false);
    expect(isColdSession({ key: 'k', placement: { state: 'local' } })).toBe(false);
    expect(isColdSession({ key: 'k' })).toBe(false);
  });
});

describe('toAgentSessionItems', () => {
  it('filters to main-agent sessions, sorts active runs first', () => {
    const items = toAgentSessionItems(parseSessionRows({ sessions: SESSIONS_ROWS }).rows);
    expect(items.map((i) => i.sessionKey)).toEqual(['agent:main:main', 'agent:coder:main', 'agent:drained:main', 'agent:cold:main', 'main']);
  });

  it('carries hasActiveRun, label fallback, and cold flags', () => {
    const items = buildAgentSessionItems({ sessions: SESSIONS_ROWS });
    const main = items.find((i) => i.sessionKey === 'agent:main:main');
    expect(main?.hasActiveRun).toBe(true);
    expect(main?.agentId).toBe('main');
    const cold = items.find((i) => i.sessionKey === 'agent:cold:main');
    expect(cold?.cold).toBe(true);
    expect(cold?.label).toBe('cold');
    const drained = items.find((i) => i.sessionKey === 'agent:drained:main');
    expect(drained?.label).toBe('drained');
  });

  it('treats activeRunIds as a run indicator', () => {
    const items = toAgentSessionItems([{ key: 'agent:x:main', activeRunIds: ['run-1'] }]);
    expect(items[0].hasActiveRun).toBe(true);
  });
});

describe('AgentPicker', () => {
  it('lists filtered sessions through the transport', async () => {
    const picker = new AgentPicker({
      listSessions: async () => ({ sessions: SESSIONS_ROWS }),
    });
    const items = await picker.listMainSessions();
    expect(items.length).toBe(5);
    expect(items[0].sessionKey).toBe('agent:main:main');
  });

  it('returns [] without transport or on RPC failure', async () => {
    expect(await new AgentPicker(null).listMainSessions()).toEqual([]);
    const failing = new AgentPicker({
      listSessions: async () => {
        throw new Error('rpc down');
      },
    });
    expect(await failing.listMainSessions()).toEqual([]);
  });

  it('pick returns the QuickPick selection and undefined on cancel/empty', async () => {
    const picker = new AgentPicker(
      { listSessions: async () => ({ sessions: SESSIONS_ROWS }) },
      { show: async (items) => items[1] }
    );
    const chosen = await picker.pick();
    expect(chosen?.sessionKey).toBe('agent:coder:main');

    const cancelled = new AgentPicker(
      { listSessions: async () => ({ sessions: SESSIONS_ROWS }) },
      { show: async () => undefined }
    );
    expect(await cancelled.pick()).toBeUndefined();

    const empty = new AgentPicker({ listSessions: async () => ({ sessions: [] }) }, { show: async () => undefined });
    expect(await empty.pick()).toBeUndefined();
  });
});

describe('mapHistoryMessages', () => {
  it('maps user/assistant rows and skips tool-only or empty rows', () => {
    const messages = mapHistoryMessages({
      messages: [
        { role: 'user', text: 'hello', messageId: 'm1' },
        { role: 'assistant', text: 'hi there', messageId: 'm2' },
        { role: 'assistant', text: '', messageId: 'm3' },
        { role: 'toolUseResult', text: 'tool text' },
        { role: 'assistant' },
        'junk',
      ],
    });
    expect(messages).toEqual([
      { role: 'user', content: 'hello', messageId: 'm1' },
      { role: 'assistant', content: 'hi there', messageId: 'm2' },
    ]);
  });

  it('tolerates missing or malformed payloads', () => {
    expect(mapHistoryMessages(null)).toEqual([]);
    expect(mapHistoryMessages({})).toEqual([]);
    expect(mapHistoryMessages({ messages: 'nope' })).toEqual([]);
  });
});

describe('isDuplicateMessage', () => {
  it('dedups by messageId and passes unknown ids', () => {
    const seen = new Set(['m1']);
    expect(isDuplicateMessage('m1', seen)).toBe(true);
    expect(isDuplicateMessage('m2', seen)).toBe(false);
    expect(isDuplicateMessage(null, seen)).toBe(false);
  });
});

describe('GatewayChatService session selection and resume', () => {
  function makeConnected(log: { lines: string[] }): { svc: GatewayChatService; ws: MockSocket; ready: Promise<void> } {
    const ws = createMockWs();
    const svc = new GatewayChatService({
      url: 'ws://gateway.test:18789',
      token: 'secret-token-value',
      logger: {
        info: (m) => log.lines.push(m),
        warn: (m) => log.lines.push(m),
        error: (m) => log.lines.push(m),
      },
      wsFactory: () => ws,
    });
    void svc.connect();
    ws.emit('open');
    ws.emit('message', JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n', ts: 0 } }));
    ws.emit('message', JSON.stringify(HELLO_OK));
    return { svc, ws, ready: svc.connect() };
  }

  function rpcPayload(ws: MockSocket, id: string, payload: unknown): void {
    ws.emit('message', JSON.stringify({ type: 'res', id, ok: true, payload }));
  }

  function lastRequest(ws: MockSocket): { id: string; method: string; params?: Record<string, unknown> } {
    const frame = JSON.parse(ws.sent[ws.sent.length - 1]) as { type: string; id: string; method: string; params?: Record<string, unknown> };
    expect(frame.type).toBe('req');
    return frame as { id: string; method: string; params?: Record<string, unknown> };
  }

  /** Newest request frame with the given method (frames are sent in order). */
  function lastRequestByMethod(ws: MockSocket, method: string): { id: string; method: string } | null {
    for (let i = ws.sent.length - 1; i >= 0; i--) {
      const frame = JSON.parse(ws.sent[i]) as { type: string; id: string; method: string };
      if (frame.type === 'req' && frame.method === method) {
        return frame;
      }
    }
    return null;
  }

  it('setActiveSession routes the next chat.send to the chosen session', async () => {
    const log = { lines: [] as string[] };
    const { svc, ws, ready } = makeConnected(log);
    await ready;
    svc.setActiveSession('agent:coder:main');
    expect(svc.getActiveSessionKey()).toBe('agent:coder:main');

    // Catch-up runs only on a cursor/resume path: seed a delta cursor first
    // (the initial send itself must not replay an unscoped history tail).
    svc.seedHistory('agent:coder:main', { deltaCursor: 'c0', messages: [] });

    let done: Array<unknown> = [];
    svc.sendMessage('hi', '/tmp', 'codex', 'chat', (e) => done.push(e));
    // The send is gated behind the pre-send subscription acknowledgement, so
    // resolve the subscribe RPC first; `chat.send` follows on success.
    let req = lastRequest(ws);
    expect(req.method).toBe('sessions.messages.subscribe');
    rpcPayload(ws, req.id, {});
    await new Promise((r) => setTimeout(r, 0));
    req = lastRequest(ws);
    expect(req.method).toBe('chat.send');
    expect(req.params?.sessionKey).toBe('agent:coder:main');
    // The cursor-gated catch-up (seeded 'c0') was issued alongside the send;
    // answer both the acknowledgement and the history replay.
    const history = lastRequestByMethod(ws, 'chat.history');
    expect(history).not.toBeNull();
    rpcPayload(ws, req.id, { sessionKey: 'agent:coder:main' });
    rpcPayload(ws, history!.id, { messages: [{ role: 'assistant', text: 'routed', messageId: 'm-r1' }], deltaCursor: 'c1' });
    await new Promise((r) => setTimeout(r, 0));
    svc.dispose();
    // The run sink is present at catch-up start, so it is excluded from
    // replayed history (and its finalizing done): replay must not reach a
    // live run whose own response is still in flight. Routing to the chosen
    // session is asserted above via chat.send params.
    expect(done).toEqual([]);
  });

  it('resumeSession subscribes and replays unseen history (dedup by messageId)', async () => {
    const log = { lines: [] as string[] };
    const { svc, ws, ready } = makeConnected(log);
    await ready;
    const events: Array<Record<string, unknown>> = [];
    svc.resumeSession('agent:main:main', (e) => events.push(e as unknown as Record<string, unknown>));
    expect(svc.getActiveSessionKey()).toBe('agent:main:main');

    let req = lastRequest(ws);
    expect(req.method).toBe('sessions.messages.subscribe');
    rpcPayload(ws, req.id, {});
    await new Promise((r) => setTimeout(r, 0));

    req = lastRequest(ws);
    expect(req.method).toBe('chat.history');
    rpcPayload(ws, req.id, {
      messages: [
        { role: 'assistant', text: 'restored', messageId: 'm-1' },
        { role: 'assistant', text: '', messageId: 'm-2' },
      ],
      deltaCursor: 'cursor-9',
    });
    await new Promise((r) => setTimeout(r, 0));

    const texts = events.filter((e) => e.type === 'text').map((e) => e.text);
    expect(texts).toEqual(['restored']);
    // The completed assistant row (full text, no delta) finalizes; the empty
    // text row does not.
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    svc.dispose();
  });

  it('abort retires only the run sink and keeps other threads\' transcript subscribers', async () => {
    const log = { lines: [] as string[] };
    const { svc, ws, ready } = makeConnected(log);
    await ready;
    svc.seedHistory('agent:main:main', { deltaCursor: 'c0', messages: [] });
    const runEvents: Array<Record<string, unknown>> = [];
    const transcriptEvents: Array<Record<string, unknown>> = [];
    svc.sendMessage('hi', '/tmp', 'codex', 'chat', (e) => runEvents.push(e as unknown as Record<string, unknown>));
    // The send is gated behind the pre-send subscription acknowledgement.
    let req = lastRequest(ws);
    expect(req.method).toBe('sessions.messages.subscribe');
    rpcPayload(ws, req.id, {});
    await new Promise((r) => setTimeout(r, 0));
    // The pre-send cursor seed for the requested (default) key: issueSend
    // awaits this snapshot before issuing chat.send.
    req = lastRequest(ws);
    expect(req.method).toBe('chat.history');
    // The snapshot must carry a recovery boundary (cursor + messages),
    // otherwise the pre-ack send aborts and chat.send is never issued.
    rpcPayload(ws, req.id, { deltaCursor: 'c0', messages: [] });
    await new Promise((r) => setTimeout(r, 0));
    req = lastRequest(ws);
    expect(req.method).toBe('chat.send');
    // Resolve the acknowledgement; the gateway resolves the requested key,
    // so the ack path reuses the established subscription.
    rpcPayload(ws, req.id, { sessionKey: 'agent:main:main' });
    await new Promise((r) => setTimeout(r, 0));
    // A second, transcript-only subscriber on the same session: the session
    // is already subscribed, so no duplicate subscribe RPC is issued.
    svc.resumeSession('agent:main:main', (e) => transcriptEvents.push(e as unknown as Record<string, unknown>));

    svc.abort('agent:main:main');
    req = lastRequest(ws);
    expect(req.method).toBe('chat.abort');
    rpcPayload(ws, req.id, {});
    await new Promise((r) => setTimeout(r, 0));

    // The run sink is retired with done; the transcript-only subscriber of
    // another thread on the same session keeps receiving later events.
    expect(runEvents.some((e) => e.type === 'done')).toBe(true);
    expect(transcriptEvents.some((e) => e.type === 'done')).toBe(false);
    ws.emit('message', JSON.stringify({
      type: 'event',
      event: 'session.message',
      payload: { sessionKey: 'agent:main:main', role: 'assistant', delta: 'live' },
    }));
    await new Promise((r) => setTimeout(r, 0));
    expect(transcriptEvents.some((e) => e.type === 'text' && e.text === 'live')).toBe(true);
    expect(runEvents.some((e) => e.type === 'text' && e.text === 'live')).toBe(false);
    svc.dispose();
  });

  it('getHistory returns the raw payload and null on RPC failure', async () => {
    const log = { lines: [] as string[] };
    const { svc, ws, ready } = makeConnected(log);
    await ready;
    const pending = svc.getHistory('agent:main:main');
    const req = lastRequest(ws);
    expect(req.method).toBe('chat.history');
    expect(req.params?.sessionKey).toBe('agent:main:main');
    rpcPayload(ws, req.id, { messages: [{ role: 'user', text: 'q' }] });
    await expect(pending).resolves.toEqual({ messages: [{ role: 'user', text: 'q' }] });

    const failing = svc.getHistory('agent:main:main');
    const req2 = lastRequest(ws);
    ws.emit('message', JSON.stringify({ type: 'res', id: req2.id, ok: false, error: { code: 'E', message: 'boom' } }));
    await expect(failing).resolves.toBeNull();
    svc.dispose();
  });
});

describe('cold placeholder constant', () => {
  it('mentions session reload so users know history will arrive', () => {
    expect(COLD_SESSION_PLACEHOLDER).toContain('Session is unloaded');
  });
});
