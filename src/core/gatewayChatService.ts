/**
 * Claw Code — GatewayChatService.
 *
 * Skeleton transport client for the OpenClaw Gateway WebSocket protocol
 * (docs/gateway/protocol/transport.md + handshake.md). Implements the same
 * public method surface as `ChatService` from src/chat/ChatService.ts so the
 * chat panel can switch backends via dependency injection later.
 *
 * - WebSocket is injected as a factory so unit tests can mock the transport.
 * - Never logs tokens or prompts; only connect/error/reconnect status lines.
 * - Not wired into active code paths yet: exported + unit-tested only.
 */

import type {
  ClientHello,
  HelloOk,
  RpcInboundFrame,
  RpcRequestFrame,
  RpcResponseFrame,
  SessionEvent,
} from './contract';
import { GatewayEvents, GatewayRpcMethods } from './contract';
import type { ChatEvent } from '../chat/ChatService';

/** Minimal logger seam; default is a silent no-op. */
export type Logger = {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
};

/** Subset of the `ws` WebSocket surface this service relies on. */
export type WebSocketLike = {
  send(data: string): void;
  close(): void;
  on(event: string, cb: (...args: never[]) => void): void;
  removeListener(event: string, cb: (...args: unknown[]) => void): void;
};

export type WebSocketFactory = (url: string) => WebSocketLike;

export type GatewayChatServiceOptions = {
  /** Gateway URL, e.g. `ws://nas.local:18789`. */
  url: string;
  /** Gateway auth token (never logged). */
  token: string;
  logger?: Logger;
  /** WebSocket constructor/factory override for tests. */
  wsFactory?: WebSocketFactory;
  /** Reconnect base delay in ms (exponential backoff seed). */
  reconnectBaseDelayMs?: number;
  /** Reconnect max delay in ms. */
  reconnectMaxDelayMs?: number;
};

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

type PendingRequest = {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
};

const CLIENT_VERSION = '0.2.1';
const PROTOCOL_VERSION = 4;
/** Session key used when the gateway does not echo one back. */
export const DEFAULT_SESSION_KEY = 'main';

/** Extract a `sessionKey` from an RPC payload, when present. */
function extractSessionKey(payload: unknown): string | null {
  if (payload && typeof payload === 'object') {
    const key = (payload as { sessionKey?: unknown; session?: { key?: unknown } }).sessionKey ??
      (payload as { session?: { key?: unknown } }).session?.key;
    if (typeof key === 'string' && key) {
      return key;
    }
  }
  return null;
}
const REQUEST_TIMEOUT_MS = 30_000;
/** Max wait for connect.challenge before sending connect anyway (protocol/auth.md allows legacy fallback). */
const CHALLENGE_FALLBACK_MS = 500;

/** Finite timeout for the full connect handshake (no-response protection). */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** Lazily require `ws` (activation-path friendly); handles CJS and ESM interop shapes. */
function defaultWsFactory(url: string): WebSocketLike {
  const wsModule = require('ws') as unknown;
  const WSCtor =
    typeof wsModule === 'function'
      ? (wsModule as new (url: string) => WebSocketLike)
      : ((wsModule as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket ??
        (wsModule as { default?: { WebSocket?: new (url: string) => WebSocketLike } }).default
          ?.WebSocket);
  if (typeof WSCtor !== 'function') {
    throw new Error('unable to resolve WebSocket constructor from the ws package');
  }
  return new WSCtor(url);
}

/** Extract frames from mixed WS message data (string/Buffer). */
export function parseFrame(data: unknown): RpcInboundFrame | null {
  const text = typeof data === 'string' ? data : data instanceof Buffer ? data.toString('utf8') : null;
  if (!text) return null;
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    if (obj.type === 'res' || obj.type === 'event') {
      return obj as unknown as RpcInboundFrame;
    }
    return null;
  } catch {
    return null;
  }
}

const TOOL_CALL_STATUSES = new Set(['running', 'done', 'error', 'failed']);

/**
 * Map a gateway `session.message` event to a UI ChatEvent.
 * Handles toolCall payloads, streaming text deltas, final text, and usage.
 * Returns null when the event carries none of those.
 */
export function mapSessionEventToChatEvent(evt: SessionEvent): ChatEvent | null {
  if (evt.event !== GatewayEvents.sessionMessage) return null;
  const payload = (evt.payload ?? {}) as {
    role?: string;
    text?: unknown;
    delta?: unknown;
    toolCall?: { name?: unknown; title?: unknown; status?: unknown } | null;
    usage?:
      | {
          promptTokens?: number;
          completionTokens?: number;
          prompt_tokens?: number;
          completion_tokens?: number;
          input_tokens?: number;
          output_tokens?: number;
        }
      | null;
  };
  if (payload.role && payload.role !== 'assistant') return null;
  const tc = payload.toolCall;
  if (tc && typeof tc === 'object') {
    const rawStatus = typeof tc.status === 'string' ? tc.status : '';
    const status = TOOL_CALL_STATUSES.has(rawStatus) ? rawStatus : rawStatus ? 'running' : 'done';
    return {
      type: 'toolCall',
      title: typeof tc.title === 'string' && tc.title ? tc.title : typeof tc.name === 'string' && tc.name ? tc.name : 'tool',
      status,
      details: '',
    };
  }
  if (typeof payload.delta === 'string' && payload.delta.length > 0) {
    return { type: 'text', text: payload.delta };
  }
  if (typeof payload.text === 'string' && payload.text.length > 0) {
    return { type: 'text', text: payload.text };
  }
  const u = payload.usage;
  const promptTokens = Number(u?.promptTokens ?? u?.prompt_tokens ?? u?.input_tokens ?? 0);
  const completionTokens = Number(
    u?.completionTokens ?? u?.completion_tokens ?? u?.output_tokens ?? 0
  );
  if (u && (promptTokens || completionTokens)) {
    return {
      type: 'usage',
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    };
  }
  return null;
}

/**
 * Gateway transport + chat facade.
 *
 * Lifecycle: `connect()` opens the WS and completes the `connect` handshake
 * (role=operator, token auth, hello-ok). On socket close it reconnects with
 * exponential backoff. RPCs (`send`, `listSessions`) ride the same socket
 * with per-request ids and timeouts.
 */
export class GatewayChatService {
  private readonly url: string;
  private readonly token: string;
  private readonly logger: Logger;
  private readonly wsFactory: WebSocketFactory;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  private ws: WebSocketLike | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private connected = false;
  /** In-flight connect() (serialized: concurrent calls share the attempt). */
  private connectPromise: Promise<void> | null = null;
  /** Session key the last sendMessage targeted (falls back to default). */
  private activeSessionKey: string | null = null;
  /** Run sinks keyed by session so concurrent thread sends do not overwrite each other.
   *  An entry also marks that session as having an active run (queue-mode selection). */
  private runSinksBySession = new Map<string, ((event: ChatEvent) => void)>();
  /** Transcript subscribers keyed by session (run or resume); re-subscribed after reconnect. */
  private transcriptSinksBySession = new Map<string, ((event: ChatEvent) => void)>();

  /** Latest delta cursor per session key (for catch-up after reconnect). */
  private deltaCursorBySession = new Map<string, unknown>();
  /** Message ids already surfaced for the active session (dedup on resume). */
  /** Seen message IDs per session key, capped so long-lived sessions cannot
   *  grow memory unbounded. Keyed per session: messageIds are only unique
   *  within one session's transcript. */
  private seenMessageIdsBySession = new Map<string, Set<string>>();
  private static readonly SEEN_MESSAGE_LIMIT = 500;

  /** Record a messageId as seen for one session (oldest entry evicted at the cap). */
  private rememberSeen(sessionKey: string, messageId: string): void {
    let seen = this.seenMessageIdsBySession.get(sessionKey);
    if (!seen) {
      seen = new Set<string>();
      this.seenMessageIdsBySession.set(sessionKey, seen);
    }
    if (seen.size >= GatewayChatService.SEEN_MESSAGE_LIMIT) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) {
        seen.delete(oldest);
      }
    }
    seen.add(messageId);
  }

  /** Whether a messageId was already delivered for one session. */
  private hasSeen(sessionKey: string, messageId: string): boolean {
    return this.seenMessageIdsBySession.get(sessionKey)?.has(messageId) ?? false;
  }

  /** Latest hello-ok payload from the active connection, if any. */
  hello: HelloOk | null = null;

  /** Gateway events forwarded to chat subscribers (mapped to ChatEvent). */
  onEvent: (event: ChatEvent) => void = () => {};
  /** Raw session events for lower-level subscribers. */
  onSessionEvent: (event: SessionEvent) => void = () => {};

  constructor(deps: GatewayChatServiceOptions) {
    this.url = deps.url;
    this.token = deps.token;
    this.logger = deps.logger ?? silentLogger;
    this.wsFactory = deps.wsFactory ?? defaultWsFactory;
    this.baseDelayMs = deps.reconnectBaseDelayMs ?? 1000;
    this.maxDelayMs = deps.reconnectMaxDelayMs ?? 30_000;
  }

  /** Whether the socket is currently open and handshook. */
  get isRunning(): boolean {
    return this.connected;
  }

  /**
   * Open the WebSocket and complete the operator handshake. Serialized
   * (concurrent calls join the in-flight attempt), idempotent while
   * connected; an explicit attempt cancels any pending scheduled reconnect.
   */
  connect(): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }
    if (this.connected && this.ws) {
      return Promise.resolve();
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const attempt = this.openAndHandshake()
      .then((hello) => {
        this.hello = hello;
        this.reconnectAttempt = 0;
        this.attachRuntimeHandlers();
        this.resubscribeActiveSession();
        this.logger.info(`gateway connected protocol=${hello.protocol}`);
      })
      .finally(() => {
        this.connectPromise = null;
      });
    this.connectPromise = attempt;
    return attempt;
  }

  /**
   * Full connect handshake: gate `connect` on the pre-connect
   * `connect.challenge` event (token-only clients need no signed reply;
   * a short fallback timer keeps gateways without challenge working).
   */
  private openAndHandshake(): Promise<HelloOk> {
    this.ws = this.wsFactory(this.url);
    const ws = this.ws;
    return new Promise<HelloOk>((resolve, reject) => {
      let settled = false;
      let helloSent = false;
      let connectRequestId: string | null = null;
      let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
      let challengeTimer: ReturnType<typeof setTimeout> | null = null;
      handshakeTimer = setTimeout(() => {
        settleError('gateway handshake timed out');
        try {
          ws.close();
        } catch {
          // socket already closed
        }
      }, HANDSHAKE_TIMEOUT_MS);
      const settleError = (msg: string) => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // socket already closed
        }
        if (challengeTimer) {
          clearTimeout(challengeTimer);
          challengeTimer = null;
        }
        if (handshakeTimer) {
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
        }
        reject(new Error(msg));
      };
      const sendHello = () => {
        if (helloSent || settled) return;
        helloSent = true;
        if (challengeTimer) {
          clearTimeout(challengeTimer);
          challengeTimer = null;
        }
        const frame: RpcRequestFrame = {
          type: 'req',
          id: this.allocId(),
          method: GatewayRpcMethods.connect,
          params: this.buildHello() as unknown as Record<string, unknown>,
        };
        connectRequestId = frame.id;
        ws.send(JSON.stringify(frame));
      };
      const onOpen = () => {
        challengeTimer = setTimeout(() => sendHello(), CHALLENGE_FALLBACK_MS);
      };
      const onMessage = (data: unknown) => {
        const frame = parseFrame(data);
        if (!frame) return;
        if (frame.type === 'res') {
          const res = frame as RpcResponseFrame;
          if (res.id !== connectRequestId) return;
          if (res.ok) {
            const payload = res.payload as { type?: string } | undefined;
            if (payload?.type !== 'hello-ok') {
              settleError(`gateway handshake unexpected payload type=${payload?.type ?? 'unknown'}`);
              return;
            }
            if (!settled) {
              settled = true;
              if (handshakeTimer) {
                clearTimeout(handshakeTimer);
                handshakeTimer = null;
              }
              this.connected = true;
              resolve(payload as unknown as HelloOk);
            }
          } else {
            settleError(`gateway handshake rejected code=${res.error?.code ?? 'unknown'}`);
          }
        } else if (!settled && (frame as { event?: string }).event === GatewayEvents.connectChallenge) {
          sendHello();
          return;
        }
      };
      const onError = (err: Error) => {
        this.logger.error(`gateway error ${err.message}`);
        settleError(`gateway error ${err.message}`);
      };
      const onClose = () => {
        if (this.ws !== ws) return;
        this.connected = false;
        if (!settled) settleError('gateway closed before handshake completed');
        if (challengeTimer) {
          clearTimeout(challengeTimer);
          challengeTimer = null;
        }
        this.rejectAllPending('gateway connection closed');
        this.scheduleReconnect();
      };
      ws.on('open', onOpen as () => void);
      ws.on('message', onMessage as (data: unknown) => void);
      ws.on('error', onError as (err: Error) => void);
      ws.on('close', onClose as (code: number, reason: Buffer) => void);
    });
  }

  private buildHello(): ClientHello {
    return {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: { id: 'claw-code', version: CLIENT_VERSION, platform: process.platform, mode: 'operator' },
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      auth: { token: this.token },
      userAgent: `claw-code/${CLIENT_VERSION}`,
    };
  }

  private allocId(): string {
    return `cc-${this.nextRequestId++}`;
  }

  /** Send an RPC request and resolve with the response payload. */
  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.ws || !this.connected) {
      return Promise.reject(new Error('gateway not connected'));
    }
    const id = this.allocId();
    const frame: RpcRequestFrame = { type: 'req', id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway rpc timeout method=${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (payload) => {
          clearTimeout(timer);
          resolve(payload);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.ws!.send(JSON.stringify(frame));
    });
  }

  /** Typed convenience wrapper for `sessions.list`. */
  listSessions(params: Record<string, unknown> = {}): Promise<unknown> {
    return this.send(GatewayRpcMethods.sessionsList, params);
  }

  /** Bind the active chat to a session key (agent picker). */
  setActiveSession(sessionKey: string): void {
    this.activeSessionKey = sessionKey;
  }

  /** Drop a session's transcript sink (thread teardown): stops routing that
   *  session's live events to a callback for a thread that no longer exists. */
  clearSessionSink(sessionKey: string): void {
    this.transcriptSinksBySession.delete(sessionKey);
    this.seenMessageIdsBySession.delete(sessionKey);
  }

  /** Session key the next send will target (null → gateway default). */
  getActiveSessionKey(): string | null {
    return this.activeSessionKey;
  }

  /** Seed delta cursor and messageId dedupe from a `getHistory` payload so
   *  a subsequent resumeSession catch-up does not replay restored history. */
  seedHistory(sessionKey: string, payload: unknown): void {
    if (!payload || typeof payload !== 'object') {
      return;
    }
    const data = payload as { messages?: unknown; deltaCursor?: unknown; cursor?: unknown };
    const cursor = data.deltaCursor ?? data.cursor;
    if (typeof cursor === 'string' && cursor) {
      this.deltaCursorBySession.set(sessionKey, cursor);
    }
    if (!Array.isArray(data.messages)) {
      return;
    }
    for (const row of data.messages) {
      const messageId =
        row && typeof row === 'object' && typeof (row as Record<string, unknown>).messageId === 'string'
          ? ((row as Record<string, unknown>).messageId as string)
          : null;
      if (messageId) {
        this.rememberSeen(sessionKey, messageId);
      }
    }
  }

  /**
   * Resume a session after a window restart: bind the session key and
   * subscribe to its transcript events; the deltaCursor catch-up then
   * replays only messages the UI has not seen yet (deduped by messageId).
   */
  resumeSession(sessionKey: string, onEvent: (event: ChatEvent) => void): void {
    this.activeSessionKey = sessionKey;
    this.transcriptSinksBySession.set(sessionKey, onEvent);
    this.subscribeSessionMessages(sessionKey, onEvent);
  }

  /**
   * Fetch a transcript tail for a session (`chat.history`, no delta cursor)
   * for UI-side history restore. Returns null on transport/RPC failure.
   */
  async getHistory(sessionKey: string): Promise<unknown> {
    if (!this.methodAdvertised(GatewayRpcMethods.chatHistory)) {
      return null;
    }
    try {
      return await this.send(GatewayRpcMethods.chatHistory, { sessionKey });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`chat.history fetch failed ${message}`);
      return null;
    }
  }

  /** Wire runtime event handlers after the handshake promise settles. */
  private attachRuntimeHandlers(): void {
    const ws = this.ws;
    if (!ws) return;
    ws.on('message', (data: unknown) => this.handleMessage(data) as never);
  }

  private handleMessage(data: unknown): void {
    const frame = parseFrame(data);
    if (!frame || frame.type !== 'res' && frame.type !== 'event') return;
    if (frame.type === 'res') {
      const res = frame as RpcResponseFrame;
      const pending = this.pending.get(res.id);
      if (!pending) return;
      this.pending.delete(res.id);
      if (res.ok) pending.resolve(res.payload);
      else pending.reject(new Error(`gateway rpc error code=${res.error?.code ?? 'unknown'}`));
      return;
    }
    const evt = frame as SessionEvent;
    this.onSessionEvent(evt);
    let routedChatEvent: ChatEvent | null = null;
    if (evt.event === GatewayEvents.sessionMessage) {
      const payload = (evt.payload ?? {}) as { sessionKey?: unknown; role?: unknown; messageId?: unknown };
      const routed = this.sinkForSession(payload.sessionKey);
      if (routed) {
        const chatEvent = mapSessionEventToChatEvent(evt);
        if (chatEvent) {
          // Live delivery counts as seen: record the id so the next reconnect's
          // catch-up replay does not surface this message a second time.
          if (typeof payload.messageId === 'string') {
            this.rememberSeen(routed.key, payload.messageId);
          }
          routedChatEvent = chatEvent;
          routed.sink(chatEvent);
        }
      }
    }
    if (evt.event === GatewayEvents.sessionEnd) {
      const endPayload = (evt.payload ?? {}) as { sessionKey?: unknown };
      const endKey = String(endPayload.sessionKey ?? this.activeSessionKey ?? DEFAULT_SESSION_KEY);
      // A resumed session only carries a transcript sink (no run entry);
      // its stream must still observe the run's end.
      const endSink =
        this.runSinksBySession.get(endKey) ?? this.transcriptSinksBySession.get(endKey) ?? null;
      this.runSinksBySession.delete(endKey);
      if (endSink) {
        endSink({ type: 'done' });
      }
    }
    // When a run sink already consumed a session message, do not emit it a
    // second time through the global onEvent (same consumer, double delivery).
    if (!routedChatEvent) {
      const chatEvent = mapSessionEventToChatEvent(evt);
      if (chatEvent) this.onEvent(chatEvent);
    }
  }

  /** Reject and clear every in-flight request (socket closed / disposed). */
  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(new Error(reason));
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const attempt = this.reconnectAttempt++;
    const delay = Math.min(this.baseDelayMs * 2 ** attempt, this.maxDelayMs);
    this.logger.info(`gateway reconnect scheduled attempt=${attempt + 1} delayMs=${delay}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err: Error) => {
        this.logger.error(`gateway reconnect failed ${err.message}`);
      });
    }, delay);
  }

  /** ChatService-compatible send entry point: RPC `chat.send` with
   * queue-mode selection (steer during an active run, enqueue otherwise),
   * then subscription to per-session message events streamed into onEvent. */
  sendMessage(
    prompt: string,
    _cwd: string,
    _model: string,
    _chatType: string,
    _onEvent: (event: ChatEvent) => void
  ): void {
    if (!this.connected) {
      _onEvent({ type: 'error', message: 'gateway not connected' });
      _onEvent({ type: 'done' });
      return;
    }
    const sessionKey = this.activeSessionKey ?? DEFAULT_SESSION_KEY;
    const existingSink = this.runSinksBySession.get(sessionKey);
    const queueMode = existingSink ? 'steer' : 'enqueue';
    this.runSinksBySession.set(sessionKey, _onEvent);
    if (existingSink && existingSink !== _onEvent) {
      // A different thread still owns a run on this shared session: end its
      // stream cleanly instead of letting it hang while the replacement sink
      // silently receives all subsequent events.
      existingSink({ type: 'done' });
    }
    void this.send(GatewayRpcMethods.chatSend, { sessionKey, text: prompt, queueMode })
      .then((payload) => {
        const key = extractSessionKey(payload) ?? sessionKey;
        this.activeSessionKey = key;
        this.runSinksBySession.set(key, _onEvent);
        if (key !== sessionKey && this.runSinksBySession.get(sessionKey) === _onEvent) {
          this.runSinksBySession.delete(sessionKey);
        }
        this.subscribeSessionMessages(key, _onEvent);
      })
      .catch((err: Error) => {
        if (this.runSinksBySession.get(sessionKey) === _onEvent) {
          this.runSinksBySession.delete(sessionKey);
        }
        _onEvent({ type: 'error', message: err.message });
        _onEvent({ type: 'done' });
      });
  }

  /** Route a session event to its session-keyed run sink.
   *
   *  Keyless frames are ambiguous: with several sessions in flight they are
   *  dropped instead of guessed, because whichever send acknowledgement ran
   *  last would otherwise claim them. Returns the sink together with its
   *  resolved session key so callers can bookkeep per session. */
  private sinkForSession(sessionKey: unknown): { sink: (event: ChatEvent) => void; key: string } | null {
    if (sessionKey === undefined || sessionKey === null) {
      const keys = new Set<string>([...this.runSinksBySession.keys(), ...this.transcriptSinksBySession.keys()]);
      if (keys.size !== 1) {
        return null;
      }
      const fallbackKey = [...keys][0];
      const sink = this.runSinksBySession.get(fallbackKey) ?? this.transcriptSinksBySession.get(fallbackKey);
      return sink ? { sink, key: fallbackKey } : null;
    }
    const key = String(sessionKey);
    const sink = this.runSinksBySession.get(key) ?? this.transcriptSinksBySession.get(key) ?? null;
    return sink ? { sink, key } : null;
  }

  /** Re-issue transcript subscriptions after reconnect (subscriptions are connection-scoped). */
  private resubscribeActiveSession(): void {
    for (const [sessionKey, sink] of this.transcriptSinksBySession) {
      this.logger.info(`gateway re-subscribing session after reconnect ${sessionKey}`);
      this.subscribeSessionMessages(sessionKey, sink);
    }
  }

  /** Subscribe to transcript events for a session key (soft method check). */
  private subscribeSessionMessages(sessionKey: string, onEvent: (event: ChatEvent) => void): void {
    this.transcriptSinksBySession.set(sessionKey, onEvent);
    if (!this.methodAdvertised(GatewayRpcMethods.sessionsMessagesSubscribe)) {
      this.logger.warn(
        `gateway does not advertise ${GatewayRpcMethods.sessionsMessagesSubscribe}; streaming unavailable`
      );
      this.retireSinks(sessionKey, onEvent);
      onEvent({ type: 'done' });
      return;
    }
    void this.send(GatewayRpcMethods.sessionsMessagesSubscribe, { sessionKeys: [sessionKey] })
      .then(() => {
        void this.catchUpHistory(sessionKey, onEvent);
      })
      .catch((err: Error) => {
        this.logger.warn(`sessions.messages.subscribe failed ${err.message}`);
        this.retireSinks(sessionKey, onEvent);
        onEvent({ type: 'done' });
      });
  }

  /** Drop the run/transcript sinks for a session only when they still point at the given callback. */
  private retireSinks(sessionKey: string, onEvent: (event: ChatEvent) => void): void {
    if (this.runSinksBySession.get(sessionKey) === onEvent) {
      this.runSinksBySession.delete(sessionKey);
    }
    if (this.transcriptSinksBySession.get(sessionKey) === onEvent) {
      this.transcriptSinksBySession.delete(sessionKey);
    }
  }

  /**
   * Catch-up after reconnect: pull transcript tail with the stored delta
   * cursor, deduplicating by messageId so resumed streams do not replay
   * already-rendered messages. Never crashes on unknown payload shapes.
   */
  private async catchUpHistory(sessionKey: string, onEvent: (event: ChatEvent) => void): Promise<void> {
    if (!this.methodAdvertised(GatewayRpcMethods.chatHistory)) {
      return;
    }
    try {
      const payload = (await this.send(GatewayRpcMethods.chatHistory, {
        sessionKey,
        deltaCursor: this.deltaCursorBySession.get(sessionKey),
      })) as {
        messages?: Array<Record<string, unknown>>;
        deltaCursor?: unknown;
        cursor?: unknown;
      } | null;
      if (!payload || !Array.isArray(payload.messages)) {
        return;
      }
      const cursor = payload.deltaCursor ?? payload.cursor;
      if (cursor !== undefined && cursor !== null) {
        this.deltaCursorBySession.set(sessionKey, cursor);
      }
      for (const row of payload.messages) {
        const messageId = typeof row.messageId === 'string' ? row.messageId : null;
        if (messageId && this.hasSeen(sessionKey, messageId)) {
          continue;
        }
        if (messageId) {
          this.rememberSeen(sessionKey, messageId);
        }
        const mapped = mapSessionEventToChatEvent({
          event: GatewayEvents.sessionMessage,
          payload: row as Record<string, unknown>,
        });
        if (mapped) {
          onEvent(mapped);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`chat.history catch-up failed ${message}`);
    }
  }

  /** Whether hello-ok advertises the given RPC method (unknown-tolerant). */
  private methodAdvertised(method: string): boolean {
    const methods = this.hello?.features?.methods;
    if (!Array.isArray(methods)) {
      return true;
    }
    return methods.includes(method);
  }

  /** Abort the run for one session: RPC `chat.abort` targeted at the given
   *  session key (falls back to the last active session); completes that
   *  session's sink. A session key from the calling thread avoids aborting
   *  another thread's run. Runs while disconnected still retire the local
   *  sinks and complete the callback, so a later reconnect cannot re-subscribe
   *  a cancelled run. */
  abort(sessionKey?: string): void {
    const key = sessionKey ?? this.activeSessionKey;
    if (!key) {
      return;
    }
    const runSink = this.runSinksBySession.get(key);
    const sink = runSink ?? this.transcriptSinksBySession.get(key) ?? null;
    if (!this.connected) {
      if (runSink && this.runSinksBySession.get(key) === runSink) {
        this.runSinksBySession.delete(key);
      }
      if (sink) {
        sink({ type: 'done' });
      }
      return;
    }
    // Retire the run sink synchronously: the abort RPC settles later, and
    // events from the old session arriving in between must not reach the
    // caller after it rebinds the thread. Retire only the entry this abort
    // started with — a newer send may have replaced the map entry.
    if (runSink && this.runSinksBySession.get(key) === runSink) {
      this.runSinksBySession.delete(key);
    }
    void this.send(GatewayRpcMethods.chatAbort, { sessionKey: key })
      .catch((err: Error) => {
        this.logger.warn(`chat.abort failed ${err.message}`);
      })
      .finally(() => {
        if (sink) {
          sink({ type: 'done' });
        }
      });
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, pending] of this.pending) {
      pending.reject(new Error('gateway client disposed'));
    }
    this.pending.clear();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}