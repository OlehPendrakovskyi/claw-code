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
  RpcRequestFrame,
  RpcResponseFrame,
  SessionEvent,
} from './contract';
import { GatewayEvents, GatewayRpcMethods } from './contract';
import { asNonEmptyString, asStringOr } from './typeGuards';
import type { ChatEvent } from '../chat/ChatService';
import {
  DEFAULT_SESSION_KEY,
  DELTA_TRACK_LIMIT,
  extractSessionKey,
  mapSessionEventToChatEvent,
  parseFrame,
} from './gatewayEventMapping';

export {
  DEFAULT_SESSION_KEY,
  extractSessionKey,
  mapSessionEventToChatEvent,
  parseFrame,
} from './gatewayEventMapping';

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

  /** Composite identity of the configured gateway endpoint. Callers keep
   *  connection-scoped caches (e.g. the webview session-key allowlist)
   *  keyed by this value so credentials changes invalidate them; never log
   *  it — it embeds the token. */
  getGatewayIdentity(): string {
    return `${this.url}:${this.token}`;
  }
  private readonly logger: Logger;
  private readonly wsFactory: WebSocketFactory;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  private ws: WebSocketLike | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while the client is deliberately parked (transport switched away
   *  from gateway): the socket is closed and the reconnect loop stopped, but
   *  lifecycle references stay valid until the next connect()/
   *  updateConnection() resumes it. */
  private suspended = false;
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
  /** Remember streamed delta text for one message so a later complete frame
   *  with the full text can emit only the unrendered remainder instead of
   *  duplicating the already-streamed deltas. */
  private rememberDeltaText(sessionKey: string, messageId: string, delta: string): void {
    const key = this.messageKey(sessionKey, messageId);
    this.deltaTextByMessage.set(key, (this.deltaTextByMessage.get(key) ?? '') + delta);
    if (this.deltaTextByMessage.size > DELTA_TRACK_LIMIT) {
      const oldest = this.deltaTextByMessage.keys().next().value;
      if (oldest !== undefined) {
        this.deltaTextByMessage.delete(oldest);
      }
    }
  }

  /** Drop the streamed-delta record once the message is finalized. */
  private forgetDeltaText(sessionKey: string, messageId: string): void {
    this.deltaTextByMessage.delete(this.messageKey(sessionKey, messageId));
  }

  /** Composite map key that scopes a messageId to its session. */
  private messageKey(sessionKey: string, messageId: string): string {
    return sessionKey + '\u0000' + messageId;
  }

  /** Per-message streamed-delta accumulation for complete-frame dedup. */
  private deltaTextByMessage = new Map<string, string>();

  /** A complete assistant frame (full `text`, no `delta`) must not re-emit
   *  text already streamed as deltas for the same messageId: the provider
   *  appends every text event, so `he` + `hello` would render `hehello`.
   *  When the full text extends the streamed prefix, emit only the remainder;
   *  if the full text diverges from the streamed prefix, keep the full text —
   *  a duplicated tail beats lost content. Frames carrying a delta only
   *  accumulate; a delta alongside full text also adjusts that text.
   *
   *  On a mixed frame whose full text is the cumulative emitted text, the
   *  tracked prefix must jump to the full text — keeping the stale delta
   *  prefix would make the later completion frame re-emit the tail a second
   *  time. A divergent mixed frame is emitted intact and keeps the
   *  accumulated delta prefix: advancing the tracker to the full text would
   *  mark it as already emitted, so the later full-text completion frame
   *  would be reduced to an empty event and its final text lost. Only the
   *  full-text event is deduped against what earlier deltas already streamed
   *  (plus this frame's own delta on a mixed frame); rewriting the delta
   *  event too would drop a frame where delta equals the full text — e.g. a
   *  first frame carrying delta "hello", text "hello" — and lose the first
   *  content. */
  private adjustCompleteFrameEvents(
    sessionKey: string,
    payload: { messageId?: unknown; text?: unknown; delta?: unknown },
    events: ChatEvent[]
  ): ChatEvent[] {
    const messageId = asNonEmptyString(payload.messageId);
    if (!messageId) {
      return events;
    }
    const delta = asStringOr(payload.delta, '');
    const fullText = asStringOr(payload.text, '');
    const streamed = this.deltaTextByMessage.get(this.messageKey(sessionKey, messageId));
    if (delta.length > 0) {
      this.rememberDeltaText(sessionKey, messageId, delta);
    }
    if (fullText.length === 0) {
      return events;
    }
    const prefix = (streamed ?? '') + (delta.length > 0 ? delta : '');
    if (delta.length === 0) {
      this.forgetDeltaText(sessionKey, messageId);
    } else if (fullText.startsWith(prefix)) {
      this.deltaTextByMessage.set(this.messageKey(sessionKey, messageId), fullText);
    }
    if (!streamed && delta.length === 0) {
      return events;
    }
    return events
      .map((e) => {
        if (e.type !== 'text') {
          return e;
        }
        if (delta.length > 0 && e.text === delta) {
          return e;
        }
        if (e.text === fullText && fullText.startsWith(prefix)) {
          return { ...e, text: fullText.slice(prefix.length) };
        }
        return e;
      })
      .filter((e) => e.type !== 'text' || e.text.length > 0);
  }

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
  /** Keyed session.message frames that arrived for an unknown session while a
   *  pre-ack send was in flight: buffered until the acknowledgement resolves
   *  the actual session key, then re-routed (drainPreAckBufferedFrames). Each
   *  frame records the pre-ack sends in flight at arrival — a settled send's
   *  frames must be attributable to it so its failure can discard them instead
   *  of draining them into another run's sink. */
  private preAckBufferedFrames: Array<{ evt: SessionEvent; sends: Set<string> }> = [];
  /** Session keys whose pre-ack send has settled successfully (requested and
   *  resolved keys both recorded). Drain routes a buffered frame only when its
   *  session key belongs to a settled send: a frame held for a send still in
   *  flight must wait for that send's acknowledgement, or the first settled
   *  send's sink would claim another thread's frames. */
  private preAckSettledKeys = new Set<string>();
  /** Sessions with a live transcript subscription on the current socket.
   *  Cleared whenever the socket drops: every subscriber must re-subscribe
   *  after a reconnect. */
  private subscribedSessions = new Set<string>();

  /** Latest delta cursor per session key (for catch-up after reconnect). */
  private deltaCursorBySession = new Map<string, unknown>();
  /** Ordered content fingerprints of the rows a `chat.history` payload
   *  seeded per session. When the payload carried no delta cursor this is
   *  the only catch-up boundary available: the replayed tail must skip
   *  exactly these rows (in order) so an already-rendered history is not
   *  appended a second time, while rows after the seeded tail still
   *  replay. Keyed per session; overwritten by every seed. */
  private seededCatchUpFingerprints = new Map<string, string[]>();
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
   *  finalization), leaving the thread streaming forever. A stable-shape
   *  empty `delta` (e.g. `delta: ''` on the final full-text row) counts as
   *  absent: only a non-empty delta marks a streaming frame. */
  /** Stable catch-up boundary fingerprint for one history row: role, delta
   *  vs final shape, and full text. Used both when seeding the boundary from
   *  a history payload and when advancing it to the latest processed tail. */
  private static rowFingerprint(row: Record<string, unknown>): string {
    const role = typeof row.role === 'string' ? row.role : '';
    const delta = typeof row.delta === 'string' && row.delta.length > 0;
    const text = typeof row.text === 'string' ? row.text : '';
    return `${role}|${delta ? 'delta' : 'final'}|${text}`;
  }

  private isCompleteAssistantFrame(payload: {
    messageId?: unknown;
    text?: unknown;
    delta?: unknown;
  }): boolean {
    return (
      typeof payload.messageId === 'string' &&
      payload.messageId.length > 0 &&
      typeof payload.text === 'string' &&
      payload.text.length > 0 &&
      !(typeof payload.delta === 'string' && payload.delta.length > 0)
    );
  }
  /** Sessions with a `chat.abort` RPC in flight. Events for these keys are
   *  suppressed until the abort completes: the gateway may keep emitting
   *  deltas until it processes the abort, and those late events would
   *  otherwise repopulate a cancelled thread through a re-bound sink. */
  private abortingSessions = new Set<string>();
  private static readonly SEEN_MESSAGE_LIMIT = 500;

    /** Record a messageId as seen for one session (oldest entry evicted at the
   *  cap). An already-seen ID must not evict an older entry: repeated delivery
   *  would otherwise churn unrelated IDs out of the capped set and let old
   *  history rows replay after reconnect. */
  private rememberSeen(sessionKey: string, messageId: string): void {
    let seen = this.seenMessageIdsBySession.get(sessionKey);
    if (!seen) {
      seen = new Set<string>();
      this.seenMessageIdsBySession.set(sessionKey, seen);
    }
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
      this.releaseSubscription(sessionKey);
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
    this.releaseSubscription(sessionKey);
    for (const sink of retired) {
      sink({ type: 'done' });
    }
  }

  /** Whether a messageId was already delivered for one session. */
  private hasSeen(sessionKey: string, messageId: string): boolean {
    return this.seenMessageIdsBySession.get(sessionKey)?.has(messageId) ?? false;
  }

  /** Gate a live session.message frame before dispatch: complete assistant
   *  frames are claimed in the seen-set (first delivery) and duplicates are
   *  rejected, so a complete frame replayed around a reconnect is not
   *  appended twice. Deltas and textless frames pass through untouched —
   *  only complete frames may enter the seen-set, otherwise a reconnect's
   *  catch-up would skip the completed row (and its finalization) and leave
   *  the thread streaming forever. */
  private claimCompleteFrame(
    sessionKey: string,
    payload: { messageId?: unknown; text?: unknown; delta?: unknown }
  ): boolean {
    if (!this.isCompleteAssistantFrame(payload)) return true;
    const messageId = payload.messageId as string;
    if (this.hasSeen(sessionKey, messageId)) return false;
    this.rememberSeen(sessionKey, messageId);
    return true;
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
   *  (pending RPCs are rejected, transcript sinks re-subscribe). Any
   *  in-flight handshake is invalidated: it authenticated with the old
   *  credentials, so its `.then` must not mark this client connected and its
   *  `.finally` must not clear the next attempt's connectPromise. */
  updateConnection(url: string, token: string): void {
    if (this.url === url && this.token === token) { return; }
    this.url = url;
    this.token = token;
    this.suspended = false;
    this.connectGeneration += 1;
    this.connectPromise = null;
    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null;
      this.connected = false;
      this.subscribedSessions.clear();
      this.pendingSubscribeBySession.clear();
      this.preAckBufferedFrames = [];
      this.preAckSettledKeys.clear();
      this.rejectAllPending('gateway credentials changed');
      try { oldWs.close(); } catch { /* already closed */ }
      this.scheduleReconnect();
    }
  }

  /**
   * Open the WebSocket and complete the operator handshake. Serialized
   * (concurrent calls join the in-flight attempt), idempotent while
   * connected; an explicit attempt cancels any pending scheduled reconnect.
   *
   * A superseded attempt (credentials changed or a newer attempt started
   * mid-handshake) must never resolve: callers (e.g.
   * ChatServiceFactory.resolve()) would then report `connected` while
   * this.connected is still false and the next send fails as a misleading
   * disconnected error. Instead the newer generation's attempt is adopted so
   * the caller resolves only once the client is actually connected (or
   * rejects when none is pending and the client is not connected), and a
   * superseded attempt never clears a newer attempt's shared connectPromise
   * slot in its `.finally`.
   */
  connect(): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.suspended = false;
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
          this.logger.info('gateway handshake superseded by a newer connection attempt');
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
   *
   * A retired socket (updateConnection() or a newer attempt replaced
   * `this.ws` while this handshake was in flight) must not mark the client
   * connected. The stale hello-ok is rejected BEFORE the handshake settles:
   * settleError() no-ops once settled, and skipping the rejection would leak
   * this handshake promise and leave callers waiting on an outer timeout.
   * On close of a retired socket the promise must still settle — the normal
   * retirement path is a bare close event, and leaving the promise pending
   * strands callers awaiting the retired connect() attempt (forced
   * token/URL rotation would hang them forever).
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
        }
      }, HANDSHAKE_TIMEOUT_MS);
      const settleError = (msg: string) => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
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
          if (!settled) settleError('gateway handshake superseded: retired socket closed');
          return;
        }
        this.connected = false;
        this.subscribedSessions.clear();
        this.pendingSubscribeBySession.clear();
        this.preAckBufferedFrames = [];
        this.preAckSettledKeys.clear();
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

  /** Drop one session's transcript sink (thread teardown): stops routing that
   *  session's live events to a callback for a thread that no longer exists. */
  clearSessionSink(sessionKey: string): void {
    this.transcriptSinksBySession.delete(sessionKey);
    this.seenMessageIdsBySession.delete(sessionKey);
    this.deltaCursorBySession.delete(sessionKey);
    this.seededCatchUpFingerprints.delete(sessionKey);
    this.releaseSubscription(sessionKey);
  }

  /** Release a session's connection-scoped subscription once the last sink
   *  (transcript or run) for it is gone: the shared socket must not keep a
   *  server-side subscription for every closed/rebound session for the
   *  client's lifetime, and a stale subscribed entry would let a later
   *  resume skip its catch-up and lose events delivered with no sink. The
   *  entry is removed synchronously so a resume re-subscribes immediately;
   *  the unsubscribe RPC is fire-and-forget and a no-op when the gateway
   *  does not advertise it or the socket is already gone. */
  private releaseSubscription(sessionKey: string): void {
    if (this.runSinksBySession.has(sessionKey) || this.transcriptSinksBySession.has(sessionKey)) {
      return;
    }
    if (!this.subscribedSessions.delete(sessionKey)) {
      return;
    }
    if (!this.methodAdvertised(GatewayRpcMethods.sessionsMessagesUnsubscribe)) {
      return;
    }
    void this.send(GatewayRpcMethods.sessionsMessagesUnsubscribe, { sessionKeys: [sessionKey] }).catch(
      (err: Error) => {
        this.logger.warn(`sessions.messages.unsubscribe failed ${err.message}`);
      }
    );
  }

  /** Session key the next send will target (null → gateway default). */
  getActiveSessionKey(): string | null {
    return this.activeSessionKey;
  }

  /** Seed delta cursor and messageId dedupe from a `getHistory` payload so
   *  a subsequent resumeSession catch-up does not replay restored history.
   *  Only complete assistant rows may enter the seen-set: history payloads
   *  can contain streaming delta rows that share their messageId with the
   *  later completed row. Seeding a delta row would make the resume
   *  catch-up skip the completed row (and its finalization), leaving the
   *  resumed thread streaming forever — same contract as
   *  isCompleteAssistantFrame for live frames.
 *
 *  `opts.rememberSeen: false` skips the seen-set entirely: for a seed taken
 *  mid-run (post-ack catch-up), a complete row in the snapshot may be the
 *  still-streaming response, and remembering its messageId would drop the
 *  live final frame as a duplicate. */
  seedHistory(sessionKey: string, payload: unknown, opts?: { rememberSeen?: boolean }): void {
    if (!payload || typeof payload !== 'object') {
      return;
    }
    const data = payload as { messages?: unknown; deltaCursor?: unknown; cursor?: unknown };
    const cursor = data.deltaCursor ?? data.cursor;
    if (asNonEmptyString(cursor)) {
      this.deltaCursorBySession.set(sessionKey, cursor);
    }
    if (!Array.isArray(data.messages)) {
      return;
    }
    // Post-ack seeding happens while the run is still streaming: a snapshot
    // row may be the in-flight response itself, and pre-seeding its
    // messageId would make claimCompleteFrame drop the live final frame.
    // Cursor-less replay dedupe is covered by the seeded fingerprint
    // boundary, and cursor-bearing catch-up never replays pre-cursor rows,
    // so the seen-set is not needed for these rows.
    // The fingerprint boundary is seeded regardless of `rememberSeen`:
    // without it, a cursor-less reconnect after a post-ack seed has no
    // boundary at all and replays the entire history (or, mid-run, skips
    // catch-up and can lose events).
    this.seededCatchUpFingerprints.set(
      sessionKey,
      (data.messages as unknown[]).map((rowRaw) =>
        GatewayChatService.rowFingerprint(
          rowRaw && typeof rowRaw === 'object' ? (rowRaw as Record<string, unknown>) : {}
        )
      )
    );
    if (opts?.rememberSeen === false) {
      return;
    }
    for (const rowRaw of data.messages) {
      const row = rowRaw && typeof rowRaw === 'object' ? (rowRaw as Record<string, unknown>) : {};
      const messageId = asNonEmptyString(row.messageId);
      if (
        messageId &&
        this.isCompleteAssistantFrame({
          messageId: row.messageId,
          text: row.text,
          delta: row.delta,
        })
      ) {
        this.rememberSeen(sessionKey, messageId);
      }
    }
  }

  /**
   * Resume a session after a window restart: bind the session key and
   * subscribe to its transcript events; the deltaCursor catch-up then
   * replays only messages the UI has not seen yet (deduped by messageId).
   *
   * Resume is an explicit cursor path: the unscoped-tail catch-up (deduped
   * by messageId) is allowed even when no delta cursor was seeded yet —
   * but only when the provider has not already rendered `chat.history`
   * into the thread. A history-backed resume whose payload carried no
   * cursor no longer skips replay entirely: the seeded history rows are
   * remembered as an ordered catch-up boundary, so the unscoped tail
   * replay skips exactly those rows and only rows arriving after the
   * history snapshot replay — events no longer get lost between the
   * history snapshot and the subscription, and keyless seeded rows are
   * not appended a second time. A no-history resume (null RPC) keeps
   * the unscoped catch-up so events missed while the window was closed
   * still arrive.
   */
  resumeSession(
    sessionKey: string,
    onEvent: (event: ChatEvent) => void,
    opts?: { historyRendered?: boolean },
  ): void {
    this.activeSessionKey = sessionKey;
    this.addTranscriptSink(sessionKey, onEvent);
    this.subscribeSessionMessages(sessionKey, { allowUnscopedCatchUp: !opts?.historyRendered });
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

  /** Wire runtime event handlers after the handshake promise settles: a
   *  late frame on a retired socket (reconnect/updateConnection replaced
   *  it) must not route, because its events belong to the old connection and
   *  could leak stale-session deltas into the current run or finalize it
   *  early. */
  private attachRuntimeHandlers(): void {
    const ws = this.ws;
    if (!ws) return;
    ws.on('message', (data: unknown) => {
      if (this.ws !== ws) return;
      this.handleMessage(data);
    });
  }

  /** Dispatch one inbound frame: resolve pending RPCs, route session events
   *  to per-session sinks, and forward other events globally.
   *
   *  Late deltas from a run being aborted (chat.abort still in flight) must
   *  not repopulate the cancelled thread, so they are dropped while the abort
   *  is pending. Live delivery counts as seen — but only for complete
   *  frames: a streaming delta must not poison the dedupe set, otherwise a
   *  reconnect whose catch-up replays the completed row for the same
   *  messageId would skip it and never emit `done`, leaving the thread
   *  streaming forever after an interrupted delta stream. The claim also
   *  drops a duplicate complete frame (replayed around a reconnect) instead
   *  of dispatching it twice.
   *
   *  A pre-ack send may resolve to a different session than requested:
   *  keyed frames for that resolved key can arrive before the
   *  acknowledgement registers the sink under the resolved key, so they are
   *  buffered and re-routed after the ack instead of dropped. Unroutable
   *  session.message frames (e.g. ambiguous keyless frames in multi-session
   *  mode) are dropped by design in sinkForSession; emitting them on the
   *  global onEvent would leak another session's content.
   *
   *  On `session.end` a resumed session only carries a transcript sink (no
   *  run entry) and its stream must still observe the run's end: the run
   *  sink wins when present, and without one every resumed subscriber is
   *  completed. The completed run sink is retired from the transcript set
   *  as well — leaving it there retains the callback forever and replays
   *  catch-up deliveries into it after the run has ended, while sinks
   *  registered only by resumeSession (no run entry) stay subscribed.
   *  Keyless ends in multi-session mode are ambiguous and dropped: no sink
   *  is completed, so the run is cleaned up on its own lifecycle path
   *  (abort/reconnect/dispose) instead. Global onEvent only carries
   *  non-session frames; session.message frames are either routed to a sink
   *  above or dropped, never leaked globally. */
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
        if (this.abortingSessions.has(routed.key)) {
          if (this.isCompleteAssistantFrame(payload)) {
            this.rememberSeen(routed.key, payload.messageId as string);
          }
          return;
        }
        const chatEvents = mapSessionEventToChatEvent(evt);
        if (chatEvents.length > 0) {
          if (this.claimCompleteFrame(routed.key, payload)) {
            const adjusted = this.adjustCompleteFrameEvents(routed.key, payload, chatEvents);
            routedChatEvent = adjusted[0];
            for (const chatEvent of adjusted) {
              for (const sink of routed.sinks) {
                sink(chatEvent);
              }
            }
          }
        }
      } else if (
        this.preAckSendKeys.size > 0 &&
        typeof (evt.payload as { sessionKey?: unknown } | undefined)?.sessionKey === 'string' &&
        (evt.payload as { sessionKey: string }).sessionKey
      ) {
        this.preAckBufferedFrames.push({ evt, sends: new Set(this.preAckSendKeys) });
      }
    }
    if (evt.event === GatewayEvents.sessionEnd) {
      const endPayload = (evt.payload ?? {}) as { sessionKey?: unknown };
      const endKey = this.resolveSessionEndKey(endPayload.sessionKey);
      // A late `session.end` from a run being aborted must not finalize the
      // transcript-only sinks: the abort flow itself delivers `done` when
      // the abort RPC settles, mirroring the suppression of late
      // `session.message` frames.
      if (endKey && this.abortingSessions.has(endKey)) {
        return;
      }
      if (endKey) {
        const runSink = this.runSinksBySession.get(endKey);
        const transcript = [...(this.transcriptSinksBySession.get(endKey) ?? [])];
        const endSinks = runSink ? [runSink, ...transcript.filter(s => s !== runSink)] : transcript;
        this.runSinksBySession.delete(endKey);
        if (runSink) {
            this.removeTranscriptSink(endKey, runSink);
        }
        for (const endSink of endSinks) {
          endSink({ type: 'done' });
        }
      }
    }
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
   *  completing the wrong session's sink via the mutable activeSessionKey.
   *  Keyless ends prefer an unambiguous active run: transcript-only keys can
   *  belong to idle resumed sessions that no end would ever finalize, so a
   *  single run sink must not be masked by their presence. */
  private resolveSessionEndKey(sessionKey: unknown): string | null {
    if (asNonEmptyString(sessionKey)) {
      return sessionKey as string;
    }
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
    if (this.disposed || this.suspended || this.reconnectTimer) return;
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
   * then subscription to per-session message events streamed into onEvent.
   *
   * Without server-side transcript subscription the gateway will not emit
   * session events for this run: sending now would complete the turn with
   * no visible output, so the send fails explicitly instead. An abort RPC
   * still in flight targets the session key, so a send issued now would race
   * it — the new run's frames would be dropped as late-abort events and the
   * old run's session_end could finalize the new sink.
   *
   * The run sink is registered pre-ack so a concurrent resume catch-up that
   * replays a missed completed assistant row must not finalize/retire this
   * run sink while `chat.send` is still starting, or the ack's ownership
   * check would drop the actual response. A different thread still owning a
   * run on this shared session has its stream ended cleanly instead of
   * letting it hang while the replacement sink silently receives all
   * subsequent events; its transcript registration goes too, or the retired
   * callback would keep receiving events (and accumulate with every
   * steer/re-send).
   *
   * The transcript subscription is issued (and awaited) BEFORE the send RPC:
   * a gateway can emit the first `session.message` delta as soon as it
   * accepts the run, before the send acknowledgement returns, and a rejected
   * subscription retires the run sink, which would orphan an already-accepted
   * send (gateway keeps running, no listener, UI shows a completed turn with
   * no response). The resolved key is reconciled in the ack handler; until
   * then the requested key routes keyless frames. A pre-send history
   * snapshot seeds the delta cursor for a fresh run: a reconnect before a
   * post-ack snapshot seeds one would otherwise skip catch-up entirely and
   * permanently lose the deltas missed while disconnected. Cancel (abort)
   * removing this send's sink during the snapshot await — or during its
   * failure path — must bypass issuing the send: never run a prompt with no
   * listener.
   *
   * When the gateway resolves a different session whose run is still owned
   * by another thread, replacing that sink would steal the other thread's
   * live response: the occupied resolved key is treated as a conflict — this
   * send fails (with its pre-ack registration and buffered frames dropped so
   * a later drain cannot leak the abandoned run's output) and the caller can
   * retry once the other run finishes. On success the owning thread rebinds
   * to the resolved key via onSessionResolved, so its later cancel/reset/
   * close aborts the actual run rather than the stale requested key. */
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
    if (this.abortingSessions.has(sessionKey)) {
      _onEvent({
        type: 'error',
        message: 'The previous run on this session is still aborting; retry in a moment.'
      });
      _onEvent({ type: 'done' });
      return;
    }
    this.runSinksBySession.set(sessionKey, _onEvent);
    this.preAckSendKeys.add(sessionKey);
    if (existingSink && existingSink !== _onEvent) {
      this.removeTranscriptSink(sessionKey, existingSink);
      existingSink({ type: 'done' });
    }
    this.addTranscriptSink(sessionKey, _onEvent);
    const issueSend = async (): Promise<void> => {
      if (this.methodAdvertised(GatewayRpcMethods.chatHistory) && !this.deltaCursorBySession.has(sessionKey)) {
        try {
          const history = await this.send(GatewayRpcMethods.chatHistory, { sessionKey });
          if (this.runSinksBySession.get(sessionKey) !== _onEvent) {
            this.removeTranscriptSink(sessionKey, _onEvent);
            return;
          }
          this.seedHistory(sessionKey, history);
        } catch {
          if (this.runSinksBySession.get(sessionKey) !== _onEvent) {
            this.removeTranscriptSink(sessionKey, _onEvent);
            return;
          }
        }
      }
      void this.send(GatewayRpcMethods.chatSend, { sessionKey, text: prompt, queueMode })
      .then((payload) => {
        this.preAckSendKeys.delete(sessionKey);
        const key = extractSessionKey(payload) ?? sessionKey;
        this.preAckSettledKeys.add(sessionKey);
        this.preAckSettledKeys.add(key);
        this.activeSessionKey = key;
        const stillOwns = this.runSinksBySession.get(key) === _onEvent ||
          this.runSinksBySession.get(sessionKey) === _onEvent;
        if (!stillOwns) {
          return;
        }
        const existingKeySink = this.runSinksBySession.get(key);
        if (existingKeySink && existingKeySink !== _onEvent) {
          if (this.runSinksBySession.get(sessionKey) === _onEvent) {
            this.runSinksBySession.delete(sessionKey);
          }
          this.removeTranscriptSink(sessionKey, _onEvent);
          this.preAckBufferedFrames = this.preAckBufferedFrames.filter(
            (buffered) =>
              !buffered.sends.has(sessionKey) ||
              (buffered.evt.payload as { sessionKey?: unknown } | undefined)?.sessionKey !== key
          );
          _onEvent({
            type: 'error',
            message: `Session "${key}" is already streaming in another chat thread. Wait for it to finish or open a different session.`
          });
          _onEvent({ type: 'done' });
          return;
        }
        this.runSinksBySession.set(key, _onEvent);
        this.drainPreAckBufferedFrames();
        // Retire the attribution keys once no pre-ack send remains: keys that
        // outlive their drain would let a later pre-ack send admit a stale
        // late frame from an already-finished run into a live sink. With no
        // send in flight the gate is moot, so clearing is safe; while other
        // sends are still pre-ack the keys must stay for their own drains.
        if (this.preAckSendKeys.size === 0) {
          this.preAckSettledKeys.clear();
        }
        if (key !== sessionKey) {
          if (this.runSinksBySession.get(sessionKey) === _onEvent) {
            this.runSinksBySession.delete(sessionKey);
          }
          this.removeTranscriptSink(sessionKey, _onEvent);
        }
        this.addTranscriptSink(key, _onEvent);
        this.subscribeSessionMessages(key);
        if (this.methodAdvertised(GatewayRpcMethods.chatHistory) && !this.deltaCursorBySession.has(key)) {
          void this.send(GatewayRpcMethods.chatHistory, { sessionKey: key })
            .then((history) => this.seedHistory(key, history, { rememberSeen: false }))
            .catch(() => undefined);
        }
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
        if (this.preAckSendKeys.size === 0) {
          this.preAckBufferedFrames = [];
          this.preAckSettledKeys.clear();
        } else {
          this.discardPreAckFramesForSend(sessionKey);
          this.drainPreAckBufferedFrames();
        }
        _onEvent({ type: 'error', message: err.message });
        _onEvent({ type: 'done' });
      });
    };
    void this.subscribeSessionMessages(sessionKey).then((subscribed: boolean) => {
      if (subscribed) {
        if (this.runSinksBySession.get(sessionKey) !== _onEvent) {
          this.removeTranscriptSink(sessionKey, _onEvent);
          return;
        }
        void issueSend();
        return;
      }
      if (this.runSinksBySession.get(sessionKey) === _onEvent) {
        this.runSinksBySession.delete(sessionKey);
      }
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

  /** Discard every frame buffered while the send for `key` was in flight.
   *
   *  A send that settles without an acknowledgement (RPC failure or abort)
   *  never reveals its resolved session key, so its buffered frames cannot be
   *  identified by key. Frames tagged with the send's requested key are
   *  dropped wholesale rather than left for a later drain, where they could
   *  be routed into a different run's sink and leak the abandoned run's
   *  output. A surviving send loses at most its initial pre-ack deltas: its
   *  completion frame still arrives live and history catch-up recovers the
   *  rows on the next reconnect, so no content is permanently lost. */
  private discardPreAckFramesForSend(key: string): void {
    this.preAckBufferedFrames = this.preAckBufferedFrames.filter(
      (buffered) => !buffered.sends.has(key)
    );
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
    const leftover: Array<{ evt: SessionEvent; sends: Set<string> }> = [];
    for (const buffered of frames) {
      const payload = (buffered.evt.payload ?? {}) as { sessionKey?: unknown; messageId?: unknown };
      // Send attribution gate: with several pre-ack sends in flight, only
      // frames whose session key belongs to an acknowledged send may route —
      // routing every frame for a session with an installed sink would hand a
      // frame held for a still-pre-ack send to the first acknowledged sink
      // and display another thread's output in the wrong conversation. With
      // no pre-ack send left, every survivor belongs to a settled send, so
      // the gate is moot.
      if (
        this.preAckSendKeys.size > 0 &&
        !(typeof payload.sessionKey === 'string' && this.preAckSettledKeys.has(payload.sessionKey))
      ) {
        leftover.push(buffered);
        continue;
      }
      const routed = this.sinkForSession(payload.sessionKey);
      if (!routed) {
        leftover.push(buffered);
        continue;
      }
      const chatEvents = mapSessionEventToChatEvent(buffered.evt);
      if (chatEvents.length > 0) {
        if (!this.claimCompleteFrame(routed.key, payload)) {
          continue;
        }
        const adjusted = this.adjustCompleteFrameEvents(
          asNonEmptyString(payload.sessionKey) ?? DEFAULT_SESSION_KEY,
          payload,
          chatEvents
        );
        for (const chatEvent of adjusted) {
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
   *  resolved session key so callers can bookkeep per session. Delivery fans
   *  out to the union of the run sink and all transcript-only subscribers (a
   *  resumed thread) — a run sink alone would drop live deltas/tool
   *  events/usage for transcript-only subscribers on the same session while
   *  another thread is running. */
  private sinkForSession(sessionKey: unknown): { sinks: Array<((event: ChatEvent) => void)>; key: string } | null {
    if (sessionKey === undefined || sessionKey === null) {
      const keys = new Set<string>([...this.runSinksBySession.keys(), ...this.transcriptSinksBySession.keys()]);
      if (keys.size !== 1) {
        return null;
      }
      const fallbackKey = [...keys][0];
      const runSink = this.runSinksBySession.get(fallbackKey);
      const transcript = [...(this.transcriptSinksBySession.get(fallbackKey) ?? [])];
      const sinks = runSink ? [runSink, ...transcript.filter(s => s !== runSink)] : transcript;
      return sinks.length > 0 ? { sinks, key: fallbackKey } : null;
    }
    const key = String(sessionKey);
    const runSink = this.runSinksBySession.get(key);
    const transcript = [...(this.transcriptSinksBySession.get(key) ?? [])];
    const sinks = runSink ? [runSink, ...transcript.filter(s => s !== runSink)] : transcript;
    return sinks.length > 0 ? { sinks, key } : null;
  }

  /** Re-issue transcript subscriptions after reconnect (subscriptions are
   *  connection-scoped). A session with a live run keeps its cursor-gated
   *  catch-up only: an unscoped history tail replayed into the run sink would
   *  emit `done` per historical row and prematurely finalize the streaming
   *  response. */
  private resubscribeActiveSession(): void {
    for (const sessionKey of [...this.transcriptSinksBySession.keys()]) {
      this.logger.info(`gateway re-subscribing session after reconnect ${sessionKey}`);
      this.subscribeSessionMessages(sessionKey, {
        allowUnscopedCatchUp: !this.runSinksBySession.has(sessionKey),
      });
    }
  }

  /** Subscribe to transcript events for a session key (soft method check);
   *  subscription is per session, and delivery fans out to all sinks.
   *  An in-flight or already-established subscription for the same session is
   *  reused instead of issuing a duplicate RPC: both RPCs can complete in
   *  either order, and the loser's failure handler would retire the run sink
   *  of the surviving stream. A stale rejection (the socket drop already
   *  cleared the pending slot, or a newer subscribe attempt owns it now)
   *  must not retire a replacement run sink installed by a reconnect or a
   *  newer send, so the cleanup is tied to the attempt that still owns the
   *  pending entry. A transient rejection must not retire persistent resume
   *  sinks: they would vanish from transcriptSinksBySession and
   *  resubscribeActiveSession() could never restore them after reconnect.
   *  Only the run sink is retired (its late `done` still finalizes the
   *  streaming row), together with its send-time registration in the
   *  transcript set, which would otherwise let later session events or
   *  reconnect catch-up keep delivering into a failed run callback. */
  private subscribeSessionMessages(sessionKey: string, opts?: { allowUnscopedCatchUp?: boolean }): Promise<boolean> {
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
        if (this.pendingSubscribeBySession.get(sessionKey) !== attempt) {
          return false;
        }
        const runSink = this.runSinksBySession.get(sessionKey);
        this.runSinksBySession.delete(sessionKey);
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
   *
   * Catch-up is reserved for a known cursor/resume path: replaying an
   * unscoped history tail into the first subscription of a normal send
   * would duplicate prior assistant messages into the new turn. The run
   * sink is snapshotted BEFORE the chat.history RPC: run sinks must never
   * receive catch-up replay, and a send that registers its sink while the
   * RPC is in flight is exactly the raced case — capturing after the await
   * would treat the new send's sink as the catch-up-era sink, so once its
   * ack cleared the pre-ack marker neither exclusion below would match and
   * replayed rows (with their `done`) would flow into the fresh turn. The
   * snapshot also decides whether a settled catch-up may retire the run
   * sink: only the sink that already existed when the catch-up started, and
   * is not still pre-ack, may be retired by the replay tail. Exclusions are
   * checked per delivery against the CURRENT run sink, so a sink registered
   * mid-replay is excluded too; a send that raced this catch-up must not
   * receive a replayed `done`, or the ack's ownership check plus the
   * finalization would prematurely complete the new response before its own
   * first frame arrives.
   *
   * An already-seen complete assistant row still needs terminal recovery:
   * the live stream may have delivered the full frame and then dropped
   * before session_end, so sinks never got `done` and an active run would
   * stay `running` forever — the duplicate text delivery is skipped but the
   * finalization is re-emitted (repeat `done` is idempotent for consumers)
   * unless a later row re-opens the tail. Only complete assistant rows may
   * enter the seen-set: streaming delta rows share their messageId with the
   * later completed row (same contract as seedHistory/
   * isCompleteAssistantFrame), and remembering a delta would make the next
   * catch-up skip the completed row, leaving the resumed thread streaming
   * forever. A completed assistant history row (full text, no delta) must
   * also finalize: replaying only its text would leave subscribers
   * streaming forever, since catch-up never replays a session_end for it.
   * Any non-duplicate row that is not a final assistant row (user rows map
   * to no chat event) re-opens the replay tail: the live run answering that
   * trailing prompt must keep its sink.
   *
   * The run sink is retired only when the replayed tail ends on a completed
   * assistant row (both roles, like the sessionEnd path): the run is over,
   * and leaving it in runSinksBySession would make the next send select
   * queueMode 'steer' against a finished run and keep routing future deltas
   * into the old callback. A final row followed by further deltas means the
   * stream continued, so the run sink must stay. A run sink registered by a
   * send that raced this catch-up stays registered: its response is still
   * in flight and a replayed finalization must not retire it.
   */
  private async catchUpHistory(sessionKey: string, opts?: { allowUnscopedCatchUp?: boolean }): Promise<void> {
    if (!this.methodAdvertised(GatewayRpcMethods.chatHistory)) {
      return;
    }
    // A cursor-less seeded history (gateway returned messages but no
    // deltaCursor) still provides a catch-up boundary: the seeded row
    // fingerprints skip the already-rendered tail while rows after it
    // replay. Without a cursor AND without a seeded boundary the replay
    // would be pure duplication, so it stays disabled there.
    if (
      !this.deltaCursorBySession.has(sessionKey) &&
      !opts?.allowUnscopedCatchUp &&
      !this.seededCatchUpFingerprints.has(sessionKey)
    ) {
      return;
    }
    const catchUpStartRunSink = this.runSinksBySession.get(sessionKey);
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
      const isPreAckRunSink = (sink: (event: ChatEvent) => void): boolean =>
        this.preAckSendKeys.has(sessionKey) && this.runSinksBySession.get(sessionKey) === sink;
      const isRacedRunSink = (sink: (event: ChatEvent) => void): boolean =>
        this.runSinksBySession.get(sessionKey) === sink && sink !== catchUpStartRunSink;
      let seededIndex = 0;
      const seeded = this.seededCatchUpFingerprints.get(sessionKey);
      for (const row of payload.messages) {
        const rowPayload = row as { role?: unknown; text?: unknown; delta?: unknown };
        // Consume the seeded boundary in order: a replayed row that matches
        // the next not-yet-consumed seeded fingerprint was already rendered
        // into the thread and must not be appended a second time (this is
        // what keeps a cursor-less history-backed resume from duplicating
        // keyless rows, which the messageId seen-set cannot dedupe).
        if (seeded) {
          if (
            seededIndex < seeded.length &&
            seeded[seededIndex] === GatewayChatService.rowFingerprint(row)
          ) {
            seededIndex++;
            continue;
          }
        }
        const isAssistantRole = !(rowPayload.role && rowPayload.role !== 'assistant');
        const isFinalAssistantRow =
          isAssistantRole &&
          typeof rowPayload.text === 'string' &&
          rowPayload.text.length > 0 &&
          !(typeof rowPayload.delta === 'string' && rowPayload.delta.length > 0);
        const messageId = asNonEmptyString(row.messageId);
        const seen = messageId != null && this.hasSeen(sessionKey, messageId);
        if (messageId && isFinalAssistantRow && seen) {
          const sinks = [...(this.transcriptSinksBySession.get(sessionKey) ?? [])];
          for (const sink of sinks) {
            if (isPreAckRunSink(sink) || isRacedRunSink(sink)) {
              continue;
            }
            sink({ type: 'done' });
          }
          lastRowFinalized = true;
          continue;
        }
        if (messageId && seen) {
          continue;
        }
        if (messageId && isFinalAssistantRow) {
          this.rememberSeen(sessionKey, messageId);
        }
        const mapped = mapSessionEventToChatEvent({
          event: GatewayEvents.sessionMessage,
          payload: row as Record<string, unknown>,
        });
        const adjusted = this.adjustCompleteFrameEvents(sessionKey, row, mapped);
        const sinks = [...(this.transcriptSinksBySession.get(sessionKey) ?? [])];
        for (const chatEvent of adjusted) {
          for (const sink of sinks) {
            if (isPreAckRunSink(sink)) {
              continue;
            }
            sink(chatEvent);
          }
        }
        if (isFinalAssistantRow) {
          for (const sink of sinks) {
            if (isPreAckRunSink(sink) || isRacedRunSink(sink)) {
              continue;
            }
            sink({ type: 'done' });
          }
          lastRowFinalized = true;
        } else {
          lastRowFinalized = false;
        }
      }
      // Advance the boundary to the latest processed tail: every row of
      // this payload is now rendered into the thread, so a later catch-up
      // must skip them again. Without this, an id-less assistant response
      // rendered after the original seed is re-appended by the next
      // cursor-less catch-up (the messageId seen-set cannot dedupe it).
      this.seededCatchUpFingerprints.set(
        sessionKey,
        (payload.messages as Array<Record<string, unknown>>).map((rowRaw) =>
          GatewayChatService.rowFingerprint(rowRaw)
        )
      );
      if (lastRowFinalized && !this.preAckSendKeys.has(sessionKey)) {
        const runSink = this.runSinksBySession.get(sessionKey);
        if (runSink && runSink === catchUpStartRunSink) {
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
   *  a cancelled run.
   *
   *  A pre-ack send cancelled by this abort never reaches its send
   *  acknowledgement/catch, so its pre-ack registration and any frames
   *  buffered on its behalf would linger forever: a later catch-up could
   *  treat a fresh run sink on this session as pre-ack-protected and skip
   *  finalizing it, and orphaned buffered frames could replay into a later
   *  send — both are retired here. With no pre-ack send remaining, every
   *  buffered frame was held for a send that can no longer be acknowledged,
   *  keyed or not, so they are dropped wholesale. Only the aborted run's
   *  sink is retired, from both sink roles: the run sink also lives in the
   *  transcript set, so removing it stops late events for the cancelled run,
   *  while persistent resume sinks owned by other threads subscribed to this
   *  session must survive — retiring them would silently cut those threads
   *  off from later messages and catch-up. */
  abort(sessionKey?: string): void {
    const key = sessionKey ?? this.activeSessionKey;
    if (!key) {
      return;
    }
    const runSink = this.runSinksBySession.get(key);
    this.runSinksBySession.delete(key);
    this.preAckSendKeys.delete(key);
    if (this.preAckSendKeys.size === 0) {
      this.preAckBufferedFrames = [];
      this.preAckSettledKeys.clear();
    } else {
      this.discardPreAckFramesForSend(key);
    }
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

  /** Suspend the shared client: close the socket, reject pending RPCs and
   *  stop the reconnect loop until the next connect()/updateConnection().
   *  Unlike dispose() the instance stays valid — threads keep lifecycle
   *  references (abort/hasOwnedRun) — but an authenticated socket no longer
   *  lingers receiving transcript events after a transport switch to acpx.
   *  Sinks are retired with `done` so streaming threads finalize instead of
   *  waiting on events that can no longer arrive. Only run sinks are
   *  retired: persistent resume-only sinks stay registered so a later
   *  resubscribeActiveSession() restores their subscriptions and resumed
   *  threads keep receiving transcript events after the transport falls
   *  back. Pre-ack send state is retired together with the buffers — the
   *  pending sends are rejected while they wait for subscribe/history, so
   *  their continuations never run and stale keys must not cause later
   *  gateway events to be buffered for an abandoned send. */
  suspend(): void {
    this.suspended = true;
    this.connectPromise = null;
    this.connectGeneration += 1;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [sessionKey, sink] of this.runSinksBySession) {
      sink({ type: 'done' });
      this.removeTranscriptSink(sessionKey, sink);
    }
    this.runSinksBySession.clear();
    this.subscribedSessions.clear();
    this.pendingSubscribeBySession.clear();
    this.preAckSendKeys.clear();
    this.preAckBufferedFrames = [];
    this.preAckSettledKeys.clear();
    this.rejectAllPending('gateway transport suspended');
    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null;
      this.connected = false;
      try { oldWs.close(); } catch { /* already closed */ }
    } else {
      this.connected = false;
    }
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