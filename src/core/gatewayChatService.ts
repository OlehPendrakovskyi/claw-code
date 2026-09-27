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

/** Fallback details for tool-call frames that carry typed fields instead of a
 *  ready-made `details` string: serialize arguments/result so the UI still
 *  shows the call's inputs and outcome instead of an empty details block. */
function serializeToolCallDetails(tc: { arguments?: unknown; result?: unknown }): string {
  const parts: string[] = [];
  if (tc.arguments !== undefined) {
    parts.push(`arguments: ${JSON.stringify(tc.arguments, null, 2)}`);
  }
  if (tc.result !== undefined) {
    parts.push(`result: ${JSON.stringify(tc.result, null, 2)}`);
  }
  return parts.join('\n');
}

/**
 * Map a gateway `session.message` event to zero or more UI ChatEvents.
 * Handles toolCall payloads, streaming text deltas, final text, and usage.
 * Frames may carry several of these at once (e.g. toolCall alongside a delta
 * and usage), so every present facet is emitted in order; returns [] when
 * the event carries none of them.
 */
export function mapSessionEventToChatEvent(evt: SessionEvent): ChatEvent[] {
  if (evt.event !== GatewayEvents.sessionMessage) return [];
  const payload = (evt.payload ?? {}) as {
    role?: string;
    text?: unknown;
    delta?: unknown;
    toolCall?: { id?: unknown; name?: unknown; title?: unknown; status?: unknown; details?: unknown; arguments?: unknown; result?: unknown } | null;
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
  if (payload.role && payload.role !== 'assistant') return [];
  const tc = payload.toolCall;
  const events: ChatEvent[] = [];
  if (tc && typeof tc === 'object') {
    const rawStatus = typeof tc.status === 'string' ? tc.status : '';
    const status = TOOL_CALL_STATUSES.has(rawStatus) ? rawStatus : rawStatus ? 'running' : 'done';
    events.push({
      type: 'toolCall',
      title: typeof tc.title === 'string' && tc.title ? tc.title : typeof tc.name === 'string' && tc.name ? tc.name : 'tool',
      status,
      details: typeof tc.details === 'string' && tc.details ? tc.details : serializeToolCallDetails(tc),
      ...(typeof tc.id === 'string' && tc.id ? { id: tc.id } : {}),
    });
  }
  if (typeof payload.delta === 'string' && payload.delta.length > 0) {
    events.push({ type: 'text', text: payload.delta });
  }
  if (typeof payload.text === 'string' && payload.text.length > 0) {
    events.push({ type: 'text', text: payload.text });
  }
  const u = payload.usage;
  const promptTokens = Number(u?.promptTokens ?? u?.prompt_tokens ?? u?.input_tokens ?? 0);
  const completionTokens = Number(
    u?.completionTokens ?? u?.completion_tokens ?? u?.output_tokens ?? 0
  );
  if (u && (promptTokens || completionTokens)) {
    events.push({
      type: 'usage',
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    });
  }
  return events;
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
  private url: string;
  private token: string;
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
  /** Monotonic connection generation: bumped by updateConnection and every
   *  new connect() attempt so a superseded handshake cannot apply stale
   *  hello/handlers to the current connection or clear a newer attempt's
   *  connectPromise from its .finally. */
  private connectGeneration = 0;
  /** Session key the last sendMessage targeted (falls back to default). */
  private activeSessionKey: string | null = null;
  /** Run sinks keyed by session so concurrent thread sends do not overwrite each other.
   *  An entry also marks that session as having an active run (queue-mode selection). */
  private runSinksBySession = new Map<string, ((event: ChatEvent) => void)>();
  /** Sessions whose run sink is registered pre-ack by an in-flight send: a
   *  resume catch-up replaying a missed completed row must not finalize that
   *  sink, or the ack's ownership check would drop the actual response. */
  private preAckSendKeys = new Set<string>();
  /** Transcript subscribers keyed by session (run or resume); re-subscribed after reconnect.
   *  Multiple threads may bind the same session, so sinks fan out per key —
   *  a later subscriber must not overwrite an earlier thread's callback. */
  private transcriptSinksBySession = new Map<string, Set<((event: ChatEvent) => void)>>();
  /** In-flight `sessions.messages.subscribe` RPCs per session. Concurrent
   *  callers (pre-send subscription and the send acknowledgement path) share
   *  one RPC instead of issuing duplicates whose independent failure handler
   *  could tear down the surviving stream. Resolved `true` on success,
   *  `false` on rejection; cleared on completion. */
  private pendingSubscribeBySession = new Map<string, Promise<boolean>>();
  // Keyed session.message frames that arrived for an unknown session while a
  // pre-ack send was in flight: buffered until the acknowledgement resolves
  // the actual session key, then re-routed (drainPreAckBufferedFrames).
  private preAckBufferedFrames: Array<SessionEvent> = [];
  /** Sessions with a live transcript subscription on the current socket.
   *  Cleared whenever the socket drops: every subscriber must re-subscribe
   *  after a reconnect. */
  private subscribedSessions = new Set<string>();

  /** Latest delta cursor per session key (for catch-up after reconnect). */
  private deltaCursorBySession = new Map<string, unknown>();
  /** Message ids already surfaced for the active session (dedup on resume). */
  /** Seen message IDs per session key, capped so long-lived sessions cannot
   *  grow memory unbounded. Keyed per session: messageIds are only unique
   *  within one session's transcript. */
  private seenMessageIdsBySession = new Map<string, Set<string>>();
  /** A session.message frame carries a complete assistant message only when
   *  it has non-empty full `text` and no streaming `delta`. Delta frames and
   *  textless tool/usage frames share the messageId with the final row, so
   *  only complete frames may enter the seen-set: marking a delta seen would
   *  make a reconnect's catch-up skip the completed history row (and its
   *  finalization), leaving the thread streaming forever. */
  private isCompleteAssistantFrame(payload: {
    messageId?: unknown;
    text?: unknown;
    delta?: unknown;
  }): boolean {
    return (
      typeof payload.messageId === 'string' &&
      typeof payload.text === 'string' &&
      payload.text.length > 0 &&
      typeof payload.delta !== 'string'
    );
  }
  /** Sessions with a `chat.abort` RPC in flight. Events for these keys are
   *  suppressed until the abort completes: the gateway may keep emitting
   *  deltas until it processes the abort, and those late events would
   *  otherwise repopulate a cancelled thread through a re-bound sink. */
  private abortingSessions = new Set<string>();
  private static readonly SEEN_MESSAGE_LIMIT = 500;

  /** Record a messageId as seen for one session (oldest entry evicted at the cap). */
  private rememberSeen(sessionKey: string, messageId: string): void {
    let seen = this.seenMessageIdsBySession.get(sessionKey);
    if (!seen) {
      seen = new Set<string>();
      this.seenMessageIdsBySession.set(sessionKey, seen);
    }
    // An already-seen ID must not evict an older entry: repeated delivery
    // would otherwise churn unrelated IDs out of the capped set and let old
    // history rows replay after reconnect.
    if (seen.has(messageId)) {
      return;
    }
    if (seen.size >= GatewayChatService.SEEN_MESSAGE_LIMIT) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) {
        seen.delete(oldest);
      }
    }
    seen.add(messageId);
  }

  /** Register a transcript sink for one session (fan-out, never overwrite). */
  private addTranscriptSink(sessionKey: string, onEvent: (event: ChatEvent) => void): void {
    let sinks = this.transcriptSinksBySession.get(sessionKey);
    if (!sinks) {
      sinks = new Set();
      this.transcriptSinksBySession.set(sessionKey, sinks);
    }
    sinks.add(onEvent);
  }

  /** Drop one transcript sink for a session; the session entry disappears when
   *  the last subscriber for that key is removed. Callers (e.g. the provider
   *  reopening a session) use it to replace, not duplicate, their callback. */
  removeTranscriptSink(sessionKey: string, onEvent: (event: ChatEvent) => void): void {
    const sinks = this.transcriptSinksBySession.get(sessionKey);
    if (!sinks) return;
    sinks.delete(onEvent);
    if (sinks.size === 0) {
      this.transcriptSinksBySession.delete(sessionKey);
    }
  }

  /** Re-register a transcript sink without claiming the active session:
   *  used by callers restoring a suspended resume callback after a run so a
   *  concurrent thread's session selection is not overwritten. */
  rebindTranscriptSink(sessionKey: string, onEvent: (event: ChatEvent) => void): void {
    this.addTranscriptSink(sessionKey, onEvent);
    this.subscribeSessionMessages(sessionKey);
  }

  /** Complete and drop every sink of one session (subscribe failure /
   *  teardown: none of them will receive further events). Retires the run
   *  sink too: leaving it in runSinksBySession would make the next
   *  sendMessage select queueMode 'steer' against a run that already
   *  ended. */
  private retireTranscriptSinks(sessionKey: string): void {
    const sinks = this.transcriptSinksBySession.get(sessionKey);
    this.transcriptSinksBySession.delete(sessionKey);
    const retired = new Set(sinks ?? []);
    const runSink = this.runSinksBySession.get(sessionKey);
    this.runSinksBySession.delete(sessionKey);
    if (runSink) {
      retired.add(runSink);
    }
    for (const sink of retired) {
      sink({ type: 'done' });
    }
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

  /** Update gateway credentials in place instead of replacing the client:
   *  threads hold this instance for lifecycle actions (abort/cancel), so a
   *  dispose-and-recreate on url/token change would sever in-flight runs.
   *  Closing the socket routes the switch through the normal reconnect path
   *  (pending RPCs are rejected, transcript sinks re-subscribe). */
  updateConnection(url: string, token: string): void {
    if (this.url === url && this.token === token) { return; }
    this.url = url;
    this.token = token;
    // Invalidate any in-flight handshake: it authenticated with the old
    // credentials, so its .then must not mark this client connected and its
    // .finally must not clear the next attempt's connectPromise.
    this.connectGeneration += 1;
    this.connectPromise = null;
    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null;
      this.connected = false;
      this.subscribedSessions.clear();
      this.pendingSubscribeBySession.clear();
      this.preAckBufferedFrames = [];
      this.rejectAllPending('gateway credentials changed');
      try { oldWs.close(); } catch { /* already closed */ }
      this.scheduleReconnect();
    }
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
    const gen = ++this.connectGeneration;
    const attempt: Promise<void> = this.openAndHandshake()
      .then((hello): Promise<void> | void => {
        if (gen !== this.connectGeneration) {
          // Superseded (credentials changed or a newer attempt started
          // mid-handshake): do not mark this client connected with the
          // stale hello or attach handlers to the retired socket.
          this.logger.info('gateway handshake superseded by a newer connection attempt');
          // connect() must never resolve a superseded handshake: callers
          // (e.g. ChatServiceFactory.resolve()) would then report
          // `connected` while this.connected is still false and the next
          // send fails as a misleading disconnected error. Adopt the
          // newer generation's attempt so the caller resolves only once
          // the client is actually connected (or reject if none is
          // pending and the client is not connected).
          if (this.connectPromise && this.connectPromise !== attempt) {
            return this.connectPromise;
          }
          if (!(this.connected && this.ws)) {
            throw new Error('gateway connection superseded by a newer attempt');
          }
          return;
        }
        this.hello = hello;
        this.reconnectAttempt = 0;
        this.attachRuntimeHandlers();
        this.resubscribeActiveSession();
        this.logger.info(`gateway connected protocol=${hello.protocol}`);
      })
      .finally(() => {
        // Only this attempt's generation may clear the shared slot; a
        // superseded attempt must not reset a newer attempt's promise.
        if (gen === this.connectGeneration) {
          this.connectPromise = null;
        }
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
              if (this.ws !== ws) {
                // Retired socket: updateConnection() or a newer attempt
                // replaced this.ws while this handshake was in flight. The
                // stale hello-ok must not mark the client connected while
                // this.ws is null or points at a different socket. Reject
                // BEFORE marking the handshake settled: settleError() no-ops
                // once settled, and skipping the rejection would leak this
                // handshake promise and leave callers waiting on an outer
                // timeout.
                settleError('gateway handshake superseded: retired socket delivered hello-ok');
                return;
              }
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
        if (this.ws !== ws) {
          // Retired socket: updateConnection() or a newer attempt replaced
          // this.ws, so the shared-state cleanup below belongs to the current
          // socket. This handshake's promise must still settle, though: the
          // normal retirement path is a bare close event, and leaving the
          // promise pending strands callers awaiting the retired connect()
          // attempt (forced token/URL rotation would hang them forever).
          if (!settled) settleError('gateway handshake superseded: retired socket closed');
          return;
        }
        this.connected = false;
        this.subscribedSessions.clear();
        this.pendingSubscribeBySession.clear();
        this.preAckBufferedFrames = [];
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
      return Promise.reject(
        new Error('Gateway is not connected. Run "OpenClaw: Connect to Gateway" to configure a token, or check openclaw.gateway.url.')
      );
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
    this.deltaCursorBySession.delete(sessionKey);
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
    this.addTranscriptSink(sessionKey, onEvent);
    // Resume is an explicit cursor path: allow the unscoped-tail catch-up
    // (deduped by messageId) even when no delta cursor was seeded yet.
    this.subscribeSessionMessages(sessionKey, { allowUnscopedCatchUp: true });
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
    // A late frame on a retired socket (reconnect/updateConnection replaced
    // it) must not route: its events belong to the old connection and could
    // leak stale-session deltas into the current run or finalize it early.
    ws.on('message', (data: unknown) => {
      if (this.ws !== ws) return;
      this.handleMessage(data);
    });
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
    let isSessionMessage = evt.event === GatewayEvents.sessionMessage;
    if (isSessionMessage) {
      const payload = (evt.payload ?? {}) as { sessionKey?: unknown; role?: unknown; messageId?: unknown };
      const routed = this.sinkForSession(payload.sessionKey);
      if (routed) {
        // Late deltas from a run being aborted (chat.abort still in flight)
        // must not repopulate the cancelled thread; drop them while the
        // abort is pending.
        if (this.abortingSessions.has(routed.key)) {
          if (this.isCompleteAssistantFrame(payload)) {
            this.rememberSeen(routed.key, payload.messageId as string);
          }
          return;
        }
        const chatEvents = mapSessionEventToChatEvent(evt);
        if (chatEvents.length > 0) {
          // Live delivery counts as seen — but only for complete frames:
          // a streaming delta must not poison the dedupe set, otherwise a
          // reconnect whose catch-up replays the completed row for the same
          // messageId would skip it and never emit `done`, leaving the
          // thread streaming forever after an interrupted delta stream.
          if (this.isCompleteAssistantFrame(payload)) {
            this.rememberSeen(routed.key, payload.messageId as string);
          }
          routedChatEvent = chatEvents[0];
          for (const chatEvent of chatEvents) {
            for (const sink of routed.sinks) {
              sink(chatEvent);
            }
          }
        }
      } else if (
        this.preAckSendKeys.size > 0 &&
        typeof (evt.payload as { sessionKey?: unknown } | undefined)?.sessionKey === 'string' &&
        (evt.payload as { sessionKey: string }).sessionKey
      ) {
        // A pre-ack send may resolve to a different session than requested:
        // keyed frames for that resolved key can arrive before the
        // acknowledgement registers the sink under the resolved key. Buffer
        // them and re-route after the ack instead of dropping the run's
        // initial deltas/tool events.
        this.preAckBufferedFrames.push(evt);
      } else {
        // Unroutable session.message frames (e.g. ambiguous keyless frames in
        // multi-session mode) are dropped by design in sinkForSession; emitting
        // them on the global onEvent would leak another session's content.
      }
    }
    if (evt.event === GatewayEvents.sessionEnd) {
      const endPayload = (evt.payload ?? {}) as { sessionKey?: unknown };
      const endKey = this.resolveSessionEndKey(endPayload.sessionKey);
      if (endKey) {
        // A resumed session only carries a transcript sink (no run entry);
        // its stream must still observe the run's end. The run sink wins
        // when present; without one every resumed subscriber is completed.
        const runSink = this.runSinksBySession.get(endKey);
        const transcript = [...(this.transcriptSinksBySession.get(endKey) ?? [])];
        // Fan out to the union of the run sink and all transcript-only
        // subscribers (deduplicated): a resumed thread on the same session
        // must still observe the run's end and commit its pending response.
        const endSinks = runSink ? [runSink, ...transcript.filter(s => s !== runSink)] : transcript;
        this.runSinksBySession.delete(endKey);
        // Retire the completed run sink from the transcript set as well;
        // leaving it there retains the callback forever and replays catch-up
        // deliveries into it after the run has ended. Sinks registered only
        // by resumeSession (no run entry) stay subscribed.
        if (runSink) {
            this.removeTranscriptSink(endKey, runSink);
        }
        for (const endSink of endSinks) {
          endSink({ type: 'done' });
        }
      }
      // Keyless ends in multi-session mode are ambiguous and dropped:
      // no sink is completed, so the run is cleaned up on its own
      // lifecycle path (abort/reconnect/dispose) instead.
    }
    // Global onEvent only carries non-session frames; session.message frames
    // are either routed to a sink above or dropped, never leaked globally.
    if (!routedChatEvent && !isSessionMessage) {
      const chatEvents = mapSessionEventToChatEvent(evt);
      for (const chatEvent of chatEvents) this.onEvent(chatEvent);
    }
  }

  /** Reject and clear every in-flight request (socket closed / disposed). */
  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(new Error(reason));
    }
  }

  /** Resolve the session key for a `session.end` frame. Valid keys pass
   *  through; a keyless/ambiguous end is routed only when exactly one
   *  session sink exists (the gateway's own default is unknown here), and
   *  returns null otherwise so the caller drops the frame instead of
   *  completing the wrong session's sink via the mutable activeSessionKey. */
  private resolveSessionEndKey(sessionKey: unknown): string | null {
    if (typeof sessionKey === 'string' && sessionKey.length > 0) {
      return sessionKey;
    }
    // Keyless ends prefer an unambiguous active run: transcript-only keys can
    // belong to idle resumed sessions that no end would ever finalize, so a
    // single run sink must not be masked by their presence.
    const runKeys = [...this.runSinksBySession.keys()];
    if (runKeys.length === 1) {
      return runKeys[0];
    }
    const sinkKeys = new Set<string>([
      ...runKeys,
      ...this.transcriptSinksBySession.keys()
    ]);
    if (sinkKeys.size === 1) {
      return sinkKeys.values().next().value ?? null;
    }
    return null;
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
    _onEvent: (event: ChatEvent) => void,
    onSessionResolved?: (resolvedKey: string, requestedKey: string) => void
  ): void {
    if (!this.connected) {
      _onEvent({
        type: 'error',
        message:
          'Gateway is not connected. Run "OpenClaw: Connect to Gateway" to configure a token, or check openclaw.gateway.url.'
      });
      _onEvent({ type: 'done' });
      return;
    }
    const sessionKey = this.activeSessionKey ?? DEFAULT_SESSION_KEY;
    // Without server-side transcript subscription the gateway will not emit
    // session events for this run: sending now would complete the turn with
    // no visible output. Fail the send explicitly instead.
    if (!this.methodAdvertised(GatewayRpcMethods.sessionsMessagesSubscribe)) {
      _onEvent({
        type: 'error',
        message: `Gateway does not advertise ${GatewayRpcMethods.sessionsMessagesSubscribe}; transcript streaming is unavailable and sends would complete without output. Update the gateway to a version that supports transcript streaming.`
      });
      _onEvent({ type: 'done' });
      return;
    }
    const existingSink = this.runSinksBySession.get(sessionKey);
    const queueMode = existingSink ? 'steer' : 'enqueue';
    // An abort RPC is still in flight for this session: it targets the
    // session key, so a send issued now would race it — the new run's
    // frames would be dropped as late-abort events and the old run's
    // session_end could finalize the new sink. Fail the send until the
    // abort settles.
    if (this.abortingSessions.has(sessionKey)) {
      _onEvent({
        type: 'error',
        message: 'The previous run on this session is still aborting; retry in a moment.'
      });
      _onEvent({ type: 'done' });
      return;
    }
    this.runSinksBySession.set(sessionKey, _onEvent);
    // Mark the pre-ack registration: a concurrent resume catch-up that
    // replays a missed completed assistant row must not finalize/retire
    // this run sink while `chat.send` is still starting, or the ack's
    // ownership check would drop the actual response.
    this.preAckSendKeys.add(sessionKey);
    if (existingSink && existingSink !== _onEvent) {
      // A different thread still owns a run on this shared session: end its
      // stream cleanly instead of letting it hang while the replacement sink
      // silently receives all subsequent events. Its transcript registration
      // must go too, or the retired callback would keep receiving events
      // (and accumulate with every steer/re-send).
      this.removeTranscriptSink(sessionKey, existingSink);
      existingSink({ type: 'done' });
    }
    // Subscribe BEFORE the send RPC: a gateway can emit the first
    // `session.message` delta as soon as it accepts the run, before the send
    // acknowledgement returns. Subscribing after the ack would race that
    // delivery and drop the initial tokens/tool events. The resolved key is
    // reconciled below; until then the requested key routes keyless frames.
    // The subscribe acknowledgement is awaited before issuing `chat.send`:
    // a rejected subscription retires the run sink, which would orphan an
    // already-accepted send (gateway keeps running, no listener, UI shows a
    // completed turn with no response).
    this.addTranscriptSink(sessionKey, _onEvent);
    const issueSend = async (): Promise<void> => {
      // A fresh run has no delta cursor (only history/seed paths set one), so
      // a reconnect before a post-ack snapshot seeds one would skip catch-up
      // entirely and permanently lose the deltas missed while disconnected.
      // Seed the cursor from a pre-send history snapshot instead: reconnect
      // catch-up then always covers the run, and the snapshot's seen-ids keep
      // the prior transcript out of the replay.
      if (this.methodAdvertised(GatewayRpcMethods.chatHistory) && !this.deltaCursorBySession.has(sessionKey)) {
        try {
          const history = await this.send(GatewayRpcMethods.chatHistory, { sessionKey });
          // Cancel (abort) removed this send's sink during the snapshot
          // await: never issue the send for a cancelled run.
          if (this.runSinksBySession.get(sessionKey) !== _onEvent) {
            this.removeTranscriptSink(sessionKey, _onEvent);
            return;
          }
          this.seedHistory(sessionKey, history);
        } catch {
          // Snapshot failure must not bypass the cancelled-run check either:
          // an abort that landed during this await removed the sink, and
          // issuing the send now would run the prompt with no listener.
          if (this.runSinksBySession.get(sessionKey) !== _onEvent) {
            this.removeTranscriptSink(sessionKey, _onEvent);
            return;
          }
          // Snapshot failure leaves no cursor: the run still streams live,
          // and the post-ack seed below retries once the send is accepted.
        }
      }
      void this.send(GatewayRpcMethods.chatSend, { sessionKey, text: prompt, queueMode })
      .then((payload) => {
        this.preAckSendKeys.delete(sessionKey);
        const key = extractSessionKey(payload) ?? sessionKey;
        this.activeSessionKey = key;
        const stillOwns = this.runSinksBySession.get(key) === _onEvent ||
          this.runSinksBySession.get(sessionKey) === _onEvent;
        if (!stillOwns) {
          // Cancel (abort) removed this run's sink while the RPC was in
          // flight: never resurrect it here, or the cancelled run would be
          // re-registered for the session and late events would revive the
          // abandoned thread.
          return;
        }
        const existingKeySink = this.runSinksBySession.get(key);
        if (existingKeySink && existingKeySink !== _onEvent) {
          // The gateway resolved this send to a session whose run is still
          // owned by another thread. The pre-send busy check could not cover
          // this (resolution happens after the RPC), and replacing that sink
          // would steal the other thread's live response: its subsequent
          // deltas would be routed here while the original chat loses its
          // stream. Treat the occupied resolved key as a conflict: fail this
          // send and let the caller retry once the other run finishes.
          if (this.runSinksBySession.get(sessionKey) === _onEvent) {
            this.runSinksBySession.delete(sessionKey);
          }
          // This send's pre-ack registration in the transcript set must be
          // dropped as well, or the failed send's callback would linger and
          // receive later events for the occupied session.
          this.removeTranscriptSink(sessionKey, _onEvent);
          _onEvent({
            type: 'error',
            message: `Session "${key}" is already streaming in another chat thread. Wait for it to finish or open a different session.`
          });
          _onEvent({ type: 'done' });
          return;
        }
        this.runSinksBySession.set(key, _onEvent);
        // The resolved key now has a sink: re-route any frames buffered while
        // this send was pre-ack (initial deltas keyed with the resolved key).
        this.drainPreAckBufferedFrames();
        if (key !== sessionKey) {
          // Drop this send's pre-ack subscription on the requested key when
          // the gateway resolved a different one; the resolved key above is
          // now the routed transcript target.
          if (this.runSinksBySession.get(sessionKey) === _onEvent) {
            this.runSinksBySession.delete(sessionKey);
          }
          this.removeTranscriptSink(sessionKey, _onEvent);
        }
        this.addTranscriptSink(key, _onEvent);
        this.subscribeSessionMessages(key);
        // Fallback cursor seed for a gateway-resolved key change (the
        // pre-send seed above keyed the requested session): a one-shot
        // history snapshot seeds the cursor and seen-ids; nothing is
        // replayed here — the cursor only enables the next catch-up.
        if (this.methodAdvertised(GatewayRpcMethods.chatHistory) && !this.deltaCursorBySession.has(key)) {
          void this.send(GatewayRpcMethods.chatHistory, { sessionKey: key })
            .then((history) => this.seedHistory(key, history))
            .catch(() => undefined);
        }
        // The gateway may resolve a different session than requested (e.g.
        // the requested key was unbound). The run now lives under `key`, so
        // the owning thread must rebind too — otherwise its later
        // cancel/reset/close aborts the stale requested key and the actual
        // run stays active.
        if (key !== sessionKey) {
          onSessionResolved?.(key, sessionKey);
        }
      })
      .catch((err: Error) => {
        this.preAckSendKeys.delete(sessionKey);
        if (this.runSinksBySession.get(sessionKey) === _onEvent) {
          this.runSinksBySession.delete(sessionKey);
        }
        this.removeTranscriptSink(sessionKey, _onEvent);
        // The send failed: buffered pre-ack frames cannot route to this
        // send's sinks. Drop leftovers when no other send is pre-ack.
        this.drainPreAckBufferedFrames();
        _onEvent({ type: 'error', message: err.message });
        _onEvent({ type: 'done' });
      });
    };
    void this.subscribeSessionMessages(sessionKey).then((subscribed: boolean) => {
      if (subscribed) {
        // Cancellation during the subscribe await must not issue the send:
        // abort() removed this callback's pre-ack run-sink registration
        // and its completion already finalized the run sink.
        if (this.runSinksBySession.get(sessionKey) !== _onEvent) {
          this.removeTranscriptSink(sessionKey, _onEvent);
          return;
        }
        void issueSend();
        return;
      }
      // Subscription failed (or is unsupported): the gateway would run the
      // send with no transcript listener. Fail this send before issuing it.
      if (this.runSinksBySession.get(sessionKey) === _onEvent) {
        this.runSinksBySession.delete(sessionKey);
      }
      // The subscribe helper's failure paths (unsupported-method retire and
      // rejection catch) already finalized this sink with a `done`: emitting
      // another one here would make the provider finalize the run twice.
      const unfinalized = this.transcriptSinksBySession.get(sessionKey)?.has(_onEvent);
      this.removeTranscriptSink(sessionKey, _onEvent);
      _onEvent({
        type: 'error',
        message: `Transcript subscription for "${sessionKey}" failed; the send was aborted. Retry once the gateway accepts sessions.messages.subscribe.`
      });
      if (unfinalized) {
        _onEvent({ type: 'done' });
      }
    });
  }

  /** Re-route frames buffered while a send was pre-ack: the acknowledgement
   *  (or failure) has settled the send's sink registrations, so unmatched
   *  frames stay buffered while another send is still pre-ack and are
   *  dropped once none remains. */
  private drainPreAckBufferedFrames(): void {
    if (this.preAckBufferedFrames.length === 0) {
      return;
    }
    const frames = this.preAckBufferedFrames;
    this.preAckBufferedFrames = [];
    const leftover: Array<SessionEvent> = [];
    for (const evt of frames) {
      const payload = (evt.payload ?? {}) as { sessionKey?: unknown; messageId?: unknown };
      const routed = this.sinkForSession(payload.sessionKey);
      if (!routed) {
        leftover.push(evt);
        continue;
      }
      const chatEvents = mapSessionEventToChatEvent(evt);
      if (chatEvents.length > 0) {
        if (this.isCompleteAssistantFrame(payload)) {
          this.rememberSeen(routed.key, payload.messageId as string);
        }
        for (const chatEvent of chatEvents) {
          for (const sink of routed.sinks) {
            sink(chatEvent);
          }
        }
      }
    }
    if (this.preAckSendKeys.size > 0) {
      this.preAckBufferedFrames.push(...leftover);
    }
  }

  /** Route a session event to its session-keyed run sink.
   *
   *  Keyless frames are ambiguous: with several sessions in flight they are
   *  dropped instead of guessed, because whichever send acknowledgement ran
   *  last would otherwise claim them. Returns the sink together with its
   *  resolved session key so callers can bookkeep per session. */
  private sinkForSession(sessionKey: unknown): { sinks: Array<((event: ChatEvent) => void)>; key: string } | null {
    if (sessionKey === undefined || sessionKey === null) {
      const keys = new Set<string>([...this.runSinksBySession.keys(), ...this.transcriptSinksBySession.keys()]);
      if (keys.size !== 1) {
        return null;
      }
      const fallbackKey = [...keys][0];
      const runSink = this.runSinksBySession.get(fallbackKey);
      const sinks = runSink ? [runSink] : [...(this.transcriptSinksBySession.get(fallbackKey) ?? [])];
      return sinks.length > 0 ? { sinks, key: fallbackKey } : null;
    }
    const key = String(sessionKey);
    const runSink = this.runSinksBySession.get(key);
    const transcript = [...(this.transcriptSinksBySession.get(key) ?? [])];
    // Fan out to the union: a run sink alone would drop live deltas/tool
    // events/usage for transcript-only subscribers (a resumed thread) on the
    // same session while another thread is running.
    const sinks = runSink ? [runSink, ...transcript.filter(s => s !== runSink)] : transcript;
    return sinks.length > 0 ? { sinks, key } : null;
  }

  /** Re-issue transcript subscriptions after reconnect (subscriptions are connection-scoped). */
  private resubscribeActiveSession(): void {
    for (const sessionKey of [...this.transcriptSinksBySession.keys()]) {
      this.logger.info(`gateway re-subscribing session after reconnect ${sessionKey}`);
      // A session with a live run keeps its cursor-gated catch-up only: an
      // unscoped history tail replayed into the run sink would emit `done`
      // per historical row and prematurely finalize the streaming response.
      this.subscribeSessionMessages(sessionKey, {
        allowUnscopedCatchUp: !this.runSinksBySession.has(sessionKey),
      });
    }
  }

  /** Subscribe to transcript events for a session key (soft method check);
   *  subscription is per session, and delivery fans out to all sinks. */
  private subscribeSessionMessages(sessionKey: string, opts?: { allowUnscopedCatchUp?: boolean }): Promise<boolean> {
    // Reuse an in-flight or already-established subscription for the same
    // session instead of issuing a duplicate RPC: both RPCs can complete in
    // either order, and the loser's failure handler would retire the run
    // sink of the surviving stream.
    const pending = this.pendingSubscribeBySession.get(sessionKey);
    if (pending) {
      return pending;
    }
    if (this.subscribedSessions.has(sessionKey)) {
      return Promise.resolve(true);
    }
    if (!this.methodAdvertised(GatewayRpcMethods.sessionsMessagesSubscribe)) {
      this.logger.warn(
        `gateway does not advertise ${GatewayRpcMethods.sessionsMessagesSubscribe}; streaming unavailable`
      );
      this.retireTranscriptSinks(sessionKey);
      return Promise.resolve(false);
    }
    const attempt = this.send(GatewayRpcMethods.sessionsMessagesSubscribe, { sessionKeys: [sessionKey] })
      .then((): boolean => {
        this.subscribedSessions.add(sessionKey);
        void this.catchUpHistory(sessionKey, opts);
        return true;
      })
      .catch((err: Error): boolean => {
        this.logger.warn(`sessions.messages.subscribe failed ${err.message}`);
        // A stale rejection (the socket drop already cleared the pending
        // slot, or a newer subscribe attempt owns it now) must not retire a
        // replacement run sink installed by a reconnect or a newer send:
        // tie the cleanup to the attempt that still owns the pending entry.
        if (this.pendingSubscribeBySession.get(sessionKey) !== attempt) {
          return false;
        }
        // A transient subscribe rejection must not retire persistent resume
        // sinks: they would vanish from transcriptSinksBySession and
        // resubscribeActiveSession() could never restore them after
        // reconnect. Retire only the run sink (its late `done` still
        // finalizes the streaming row); the persistent sinks stay
        // registered for the reconnect re-subscription.
        const runSink = this.runSinksBySession.get(sessionKey);
        this.runSinksBySession.delete(sessionKey);
        // The run sink was also registered in the transcript set at send
        // time; leaving it there would let later session events or reconnect
        // catch-up keep delivering into a failed run callback. Persistent
        // resume sinks (no run entry) stay registered for the reconnect
        // re-subscription.
        if (runSink) {
          this.removeTranscriptSink(sessionKey, runSink);
          runSink({ type: 'done' });
        }
        return false;
      })
      .finally(() => {
        if (this.pendingSubscribeBySession.get(sessionKey) === attempt) {
          this.pendingSubscribeBySession.delete(sessionKey);
        }
      });
    this.pendingSubscribeBySession.set(sessionKey, attempt);
    return attempt;
  }

  /**
   * Catch-up after reconnect: pull transcript tail with the stored delta
   * cursor, deduplicating by messageId so resumed streams do not replay
   * already-rendered messages. Never crashes on unknown payload shapes.
   */
  private async catchUpHistory(sessionKey: string, opts?: { allowUnscopedCatchUp?: boolean }): Promise<void> {
    if (!this.methodAdvertised(GatewayRpcMethods.chatHistory)) {
      return;
    }
    // Catch-up is reserved for a known cursor/resume path: replaying an
    // unscoped history tail into the first subscription of a normal send
    // would duplicate prior assistant messages into the new turn.
    if (!this.deltaCursorBySession.has(sessionKey) && !opts?.allowUnscopedCatchUp) {
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
      let lastRowFinalized = false;
      // The pre-ack registration of an in-flight send is protected: the
      // replay may not finalize/retire that sink, or the send ack's ownership
      // check would treat the run as retired and drop its actual response.
      const protectedRunSink = this.preAckSendKeys.has(sessionKey)
        ? this.runSinksBySession.get(sessionKey)
        : undefined;
      // The protected sink is excluded from ALL catch-up delivery below, not
      // just the final `done`: replayed historical text/tool/usage events
      // would otherwise flow into the new send's run callback, so the next
      // response starts with the prior transcript appended to its
      // pendingAssistantText.
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
        // A completed assistant history row (full text, no delta) must also
        // finalize: replaying only its text would leave subscribers streaming
        // forever, since catch-up never replays a session_end for it.
        const rowPayload = row as { role?: unknown; text?: unknown; delta?: unknown };
        const isFinalAssistantRow =
          rowPayload.role === 'assistant' &&
          typeof rowPayload.text === 'string' &&
          rowPayload.text.length > 0 &&
          typeof rowPayload.delta !== 'string';
        const sinks = [...(this.transcriptSinksBySession.get(sessionKey) ?? [])];
        for (const chatEvent of mapped) {
          for (const sink of sinks) {
            if (sink === protectedRunSink) {
              continue;
            }
            sink(chatEvent);
          }
        }
        if (isFinalAssistantRow) {
          for (const sink of sinks) {
            if (sink === protectedRunSink) {
              continue;
            }
            sink({ type: 'done' });
          }
          lastRowFinalized = true;
        } else {
          // Any non-duplicate row that is not a final assistant row (user
          // rows map to no chat event) re-opens the replay tail: the live run
          // answering that trailing prompt must keep its sink.
          lastRowFinalized = false;
        }
      }
      // Retire the run sink only when the replayed tail ends on a completed
      // assistant row (both roles, like the sessionEnd path): the run is
      // over, and leaving it in runSinksBySession would make the next send
      // select queueMode 'steer' against a finished run and keep routing
      // future deltas into the old callback. A final row followed by further
      // deltas means the stream continued, so the run sink must stay. The
      // protected pre-ack sink of an in-flight send stays registered.
      if (lastRowFinalized) {
        const runSink = this.runSinksBySession.get(sessionKey);
        if (runSink && runSink !== protectedRunSink) {
          this.runSinksBySession.delete(sessionKey);
          this.removeTranscriptSink(sessionKey, runSink);
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

  /** Whether a run on this session is locally owned (a registered run sink
   *  or a still pre-ack send): runs owned by the gateway or another client
   *  are invisible here, so callers gating aborts on this must skip them. */
  hasOwnedRun(sessionKey: string): boolean {
    return this.runSinksBySession.has(sessionKey) || this.preAckSendKeys.has(sessionKey);
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
    this.runSinksBySession.delete(key);
    // A pre-ack send cancelled by this abort never reaches its send
    // acknowledgement/catch, so its pre-ack registration and any frames
    // buffered on its behalf would linger forever: a later catch-up could
    // treat a fresh run sink on this session as pre-ack-protected and skip
    // finalizing it, and orphaned buffered frames could replay into a later
    // send. Retire both here.
    this.preAckSendKeys.delete(key);
    if (this.preAckSendKeys.size === 0) {
      // No pre-ack send remains: every buffered frame was held for a send
      // that can no longer be acknowledged, keyed or not.
      this.preAckBufferedFrames = [];
    } else {
      this.preAckBufferedFrames = this.preAckBufferedFrames.filter(
        (evt) => (evt.payload as { sessionKey?: unknown } | undefined)?.sessionKey !== key
      );
    }
    // Retire only the aborted run's sink, from both sink roles: the run
    // sink also lives in the transcript set, so removing it stops late
    // events for the cancelled run. Persistent resume sinks owned by other
    // threads subscribed to this session must survive — retiring them would
    // silently cut those threads off from later messages and catch-up.
    if (runSink) {
      this.removeTranscriptSink(key, runSink);
    }
    if (!this.connected) {
      runSink?.({ type: 'done' });
      return;
    }
    this.abortingSessions.add(key);
    void this.send(GatewayRpcMethods.chatAbort, { sessionKey: key })
      .catch((err: Error) => {
        this.logger.warn(`chat.abort failed ${err.message}`);
      })
      .finally(() => {
        this.abortingSessions.delete(key);
        if (runSink) {
          runSink({ type: 'done' });
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