/**
 * Claw Code — GatewayChatService.
 *
 * WebSocket client for the OpenClaw Gateway: socket, handshake, keepalive,
 * reconnect with backoff, RPC correlation, and the bookkeeping that turns
 * gateway runs into the chat panel's event streams. Every wire shape comes
 * from the negotiated protocol adapter (./gatewayProtocol); this class works
 * on the neutral model only. Never logs tokens or prompts.
 *
 * Sinks: a send's run sink receives that run's output and exactly one
 * terminal `done`; transcript sinks observe a session (resumed threads).
 * Sessions are keyed by the gateway's canonical key, learned from the
 * subscription response: `main` is an alias of `agent:<id>:main`.
 */

import { randomUUID } from 'crypto';
import type { ChatEvent } from '../chat/ChatService';
import { redactEndpoint, redactPlainSecrets } from './accessInfo/redact';
import type { GatewayProtocolAdapter, WireRequest } from './gatewayProtocol/adapter';
import type {
  ConnectionAccepted,
  ConnectionLimits,
  HandshakeRejection,
  HistoryRead,
  HistorySnapshot,
  InboundEvent,
  InboundFrame,
  SendAttachment,
  SessionSummary,
  TokenUsage,
  TranscriptMessage,
} from './gatewayProtocol/model';
import { GatewayConnectError } from './gatewayProtocol/model';
import type { ProtocolRange, ProtocolSetting } from './gatewayProtocol/registry';
import { handshakeAdapter, isAdapter, negotiatedAdapter, resolveProtocolSetting } from './gatewayProtocol/registry';
import { applyAborted, applyDelta, applyFinal, BoundedSet, newRunText } from './gatewayRunText';
import type { RunText } from './gatewayRunText';

/** The session a thread targets until it opens another one; the gateway resolves the alias. */
export const DEFAULT_SESSION_KEY = 'main';

/** Minimal logger seam; default is a silent no-op. */
export type Logger = {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
};

/** Subset of the `ws` WebSocket surface this service relies on. */
export type WebSocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, cb: (...args: never[]) => void): void;
  removeListener(event: string, cb: (...args: unknown[]) => void): void;
};

export type WebSocketFactory = (url: string) => WebSocketLike;

export type GatewayChatServiceOptions = {
  /** Gateway URL, e.g. `ws://nas.local:18789`. */
  url: string;
  /** Gateway auth token (never logged). */
  token: string;
  /** Which protocol versions the handshake offers. */
  protocol?: ProtocolSetting;
  logger?: Logger;
  /** WebSocket constructor/factory override for tests. */
  wsFactory?: WebSocketFactory;
  /** Reconnect base delay in ms (exponential backoff seed). */
  reconnectBaseDelayMs?: number;
  /** Reconnect max delay in ms. */
  reconnectMaxDelayMs?: number;
};

/** A local send: the run it starts and the sink that receives it. */
export type GatewaySend = {
  sessionKey: string;
  prompt: string;
  /** Files sent with the prompt, checked against the gateway's attachment and frame limits. */
  attachments?: readonly SendAttachment[];
  onEvent: ChatSink;
  /** The gateway resolved `sessionKey` to another (canonical) key; called before the send goes out. */
  onSessionResolved?: (resolvedKey: string, requestedKey: string) => void;
};

/** Catch-up position of one session, as captured before a teardown that may be rolled back. */
export type SessionCatchUpSnapshot = { cursor: string | null; lastSeq: number };

type ChatSink = (event: ChatEvent) => void;

/** An answered RPC with the adapter of the connection it went out on, which parses the payload. */
type RpcResult = { adapter: GatewayProtocolAdapter; payload: unknown };

type PendingRequest = {
  adapter: GatewayProtocolAdapter;
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
};

/** The run a local send started, and the runs its sink follows. */
type OwnedRun = {
  sink: ChatSink;
  runId: string;
  requestedKey: string;
  stage: 'preparing' | 'issued' | 'accepted';
  /** Its own run plus the live runs of the session it may have steered into; done once all ended. */
  followed: Set<string>;
};

type RunEvent = Extract<InboundEvent, { runId: string }>;

type SessionState = {
  key: string;
  observers: Set<ChatSink>;
  owned: OwnedRun | null;
  /** Subscribed on the current socket under this (canonical) key. */
  subscribed: boolean;
  subscribing: Promise<string | null> | null;
  cursor: string | null;
  /** Highest transcript sequence already shown or seeded. */
  lastSeq: number;
  /** Runs seen streaming and not finished yet. */
  liveRuns: Map<string, RunText>;
  finishedRuns: BoundedSet<string>;
  /** Runs rendered from `chat` events, whose transcript rows must not render again. */
  streamedRuns: BoundedSet<string>;
  /** Events of an issued, unacknowledged send's session whose run is not known yet. */
  unclaimed: RunEvent[];
  catchUp: Promise<void> | null;
  catchUpAgain: boolean;
  aborting: boolean;
  /** Runs cancelled while disconnected: their `chat.abort` goes out after the next handshake. */
  pendingAborts: Set<string>;
};

type Connection = { adapter: GatewayProtocolAdapter; accepted: ConnectionAccepted };

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

const CLIENT_VERSION = '0.2.1';
const REQUEST_TIMEOUT_MS = 30_000;
/** The gateway sends connect.challenge at once; this bounds the whole handshake. */
const HANDSHAKE_TIMEOUT_MS = 15_000;
/** Close code the reference client uses when ticks stop. */
const TICK_TIMEOUT_CLOSE_CODE = 4000;
const RUN_HISTORY_LIMIT = 200;
const LIVE_RUN_LIMIT = 50;
const UNCLAIMED_EVENT_LIMIT = 200;
const ALIAS_LIMIT = 256;
const IDLE_SESSION_LIMIT = 100;
/** Longest gateway-supplied message kept in errors shown to the user. */
const GATEWAY_MESSAGE_LIMIT = 300;

const URL_IN_TEXT = /\b(?:wss?|https?):\/\/[^\s"'<>]+/gi;

const NOT_CONNECTED_MESSAGE =
  'Gateway is not connected. Run "OpenClaw: Connect to Gateway" to configure a token, or check openclaw.gateway.url.';
const RUN_FAILED_MESSAGE = 'The gateway reported that the run failed.';
const SEND_UNCONFIRMED_MESSAGE =
  'The connection dropped before the gateway confirmed the send; the message may still run — reopen the session to check.';

/** A request the client refused to send because its frame exceeds the gateway's payload limit. */
class FrameTooLargeError extends Error {}

/** A token large enough to push `connect` past the pre-auth limit would be dropped by the gateway. */
function oversizedConnectRejection(limitBytes: number): HandshakeRejection {
  return {
    kind: 'permanent',
    code: 'CONNECT_FRAME_TOO_LARGE',
    message: `connect frame exceeds the ${Math.round(limitBytes / 1024)} KiB pre-auth limit`,
    hint: 'The configured gateway token is too large — run "OpenClaw: Connect to Gateway" to update it.',
  };
}

/** Lazily require `ws` to keep it off the activation path; its CJS entry exports the constructor. */
function defaultWsFactory(url: string): WebSocketLike {
  const WebSocketCtor = require('ws') as new (url: string) => WebSocketLike;
  return new WebSocketCtor(url);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function frameText(data: unknown): string | null {
  if (typeof data === 'string') return data;
  return data instanceof Buffer ? data.toString('utf8') : null;
}

function usageEvent(usage: TokenUsage | null): ChatEvent[] {
  return usage ? [{ type: 'usage', usage }] : [];
}

function textEvent(text: string): ChatEvent[] {
  return text ? [{ type: 'text', text }] : [];
}

function newSessionState(key: string): SessionState {
  return {
    key,
    observers: new Set(),
    owned: null,
    subscribed: false,
    subscribing: null,
    cursor: null,
    lastSeq: 0,
    liveRuns: new Map(),
    finishedRuns: new BoundedSet(RUN_HISTORY_LIMIT),
    streamedRuns: new BoundedSet(RUN_HISTORY_LIMIT),
    unclaimed: [],
    catchUp: null,
    catchUpAgain: false,
    aborting: false,
    pendingAborts: new Set(),
  };
}

function highestSeq(messages: readonly TranscriptMessage[], floor: number): number {
  return messages.reduce((max, message) => Math.max(max, message.seq ?? 0), floor);
}

/** The last assistant text each run left in a transcript read. */
function finalTextByRun(messages: readonly TranscriptMessage[]): Map<string, string> {
  const texts = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'assistant' && message.runId && message.text) texts.set(message.runId, message.text);
  }
  return texts;
}

/**
 * Gateway transport + chat facade.
 *
 * Lifecycle: `connect()` opens the WS and completes the handshake. On socket
 * close it reconnects with exponential backoff, re-subscribes every observed
 * session and catches up on what the socket missed.
 */
export class GatewayChatService {
  private url: string;
  private token: string;
  private protocol: ProtocolSetting;
  private readonly logger: Logger;
  private readonly wsFactory: WebSocketFactory;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  /** Socket of the current attempt, handshaking or live. */
  private ws: WebSocketLike | null = null;
  /** The socket once its handshake completed; null while disconnected. */
  private liveWs: WebSocketLike | null = null;
  private connection: Connection | null = null;
  /** Kept after a disconnect so the status line can still name it. */
  private negotiatedVersion: number | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastInboundAt = 0;
  private lastConnectionSeq: number | null = null;
  /** Announced by a `shutdown` event: reconnect no sooner than the gateway expects to be back. */
  private restartDelayMs = 0;
  private disposed = false;
  /** In-flight connect() (serialized: concurrent calls share the attempt). */
  private connectPromise: Promise<void> | null = null;
  /** Bumped by every attempt and teardown, so a superseded handshake cannot apply its hello. */
  private connectGeneration = 0;

  private readonly sessions = new Map<string, SessionState>();
  /** Requested key → canonical key, as the gateway resolved it. */
  private readonly aliases = new Map<string, string>();
  /** Run ids this client started: only these are ever aborted. */
  private readonly localRunIds = new BoundedSet<string>(RUN_HISTORY_LIMIT);

  private readonly connectionListeners = new Set<(connected: boolean) => void>();
  /** Last state told to the listeners: a hello followed by a same-tick close announces nothing. */
  private announcedConnected = false;

  constructor(deps: GatewayChatServiceOptions) {
    this.url = deps.url;
    this.token = deps.token;
    this.protocol = deps.protocol ?? 'auto';
    this.logger = deps.logger ?? silentLogger;
    this.wsFactory = deps.wsFactory ?? defaultWsFactory;
    this.baseDelayMs = deps.reconnectBaseDelayMs ?? 1000;
    this.maxDelayMs = deps.reconnectMaxDelayMs ?? 30_000;
  }

  /** Whether the socket is currently open and handshook. */
  get isRunning(): boolean {
    return this.liveWs !== null;
  }

  /** The protocol version of the latest handshake, or null before the first one. */
  getProtocolVersion(): number | null {
    return this.negotiatedVersion;
  }

  /** Observe handshake completions and socket losses; returns the unsubscribe. */
  onConnectionStateChange(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  /** Payload and attachment limits the gateway advertised on the latest handshake. */
  getTransportLimits(): ConnectionLimits {
    return { ...(this.connection?.accepted.limits ?? this.offeredAdapter().defaultLimits()) };
  }

  /** Bytes one attachment adds to a send on the current (or offered) protocol, for budgeting a prompt. */
  attachmentWireBytes(attachment: { name: string; mimeType: string; byteLength: number }): number {
    return (this.connection?.adapter ?? this.offeredAdapter()).attachmentWireBytes(attachment);
  }

  /** Identity of the configured endpoint, for caches that credential changes must invalidate.
   *  Never log it: it embeds the token. A JSON tuple cannot collide the way a `url:token` join can. */
  getGatewayIdentity(): string {
    return JSON.stringify([this.url, this.token]);
  }

  /** The canonical key the gateway resolved `sessionKey` to, as far as this client learned it. */
  canonicalSessionKey(sessionKey: string): string {
    return this.aliases.get(sessionKey) ?? sessionKey;
  }

  /* ---------------------------------------------------------------- */
  /* Connection lifecycle                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Update the endpoint in place: threads hold this instance for lifecycle
   * actions, so replacing it would sever them. Another endpoint (or protocol)
   * may reuse session keys for different sessions, so every sink is retired
   * with `done` and all per-session state is dropped.
   */
  updateConnection(url: string, token: string, protocol: ProtocolSetting = this.protocol): void {
    if (this.url === url && this.token === token && this.protocol === protocol) {
      return;
    }
    this.url = url;
    this.token = token;
    this.protocol = protocol;
    this.connectGeneration += 1;
    this.connectPromise = null;
    this.abortRemoteRuns();
    this.retireAllSinks();
    this.sessions.clear();
    this.aliases.clear();
    if (!this.ws) {
      return;
    }
    this.closeSocket('gateway connection settings changed');
    this.scheduleReconnect();
  }

  /**
   * Open the WebSocket and complete the handshake. Serialized (concurrent
   * calls join the in-flight attempt), idempotent while connected; an
   * explicit attempt cancels a scheduled reconnect. A superseded attempt
   * adopts the newer attempt, or rejects when none is pending.
   */
  connect(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('gateway client disposed'));
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    if (this.liveWs) {
      return Promise.resolve();
    }
    this.clearReconnectTimer();
    const generation = ++this.connectGeneration;
    const attempt: Promise<void> = this.openAndHandshake()
      .then((connection) => this.completeHandshake(generation, connection))
      .finally(() => {
        if (generation === this.connectGeneration) {
          this.connectPromise = null;
        }
      });
    this.connectPromise = attempt;
    return attempt;
  }

  /** Park the client after a transport switch: abort local runs while the socket is still
   *  writable, finish every sink, and stop reconnecting. The instance stays valid. */
  suspend(): void {
    this.stopConnecting();
    this.abortRemoteRuns();
    this.retireAllSinks();
    this.closeSocket('gateway transport suspended');
  }

  /** Tear the client down for good. Remote runs keep running (a later window resumes them). */
  dispose(): void {
    this.disposed = true;
    this.stopConnecting();
    this.retireAllSinks();
    this.closeSocket('gateway client disposed');
  }

  private handshakeRange(): ProtocolRange {
    return resolveProtocolSetting(this.protocol);
  }

  private offeredAdapter(): GatewayProtocolAdapter {
    return handshakeAdapter(this.handshakeRange());
  }

  private completeHandshake(generation: number, connection: Connection): Promise<void> | void {
    if (generation !== this.connectGeneration) {
      this.logger.info('gateway handshake superseded by a newer connection attempt');
      if (this.connectPromise) {
        return this.connectPromise;
      }
      throw new Error('gateway connection superseded by a newer attempt');
    }
    const ws = this.liveWs;
    if (!ws) {
      throw new Error('gateway connection closed during the handshake');
    }
    this.connection = connection;
    this.negotiatedVersion = connection.adapter.version;
    this.reconnectAttempt = 0;
    this.restartDelayMs = 0;
    this.lastConnectionSeq = null;
    ws.on('message', (data: unknown) => {
      if (this.liveWs === ws) {
        this.handleMessage(connection.adapter, data);
      }
    });
    this.startKeepalive(ws, connection.accepted.limits.tickIntervalMs);
    const { accepted } = connection;
    this.logger.info(`gateway connected protocol=v${accepted.protocolVersion} server=${accepted.serverVersion} role=${accepted.role}`);
    this.warnAboutMissingOperations(connection);
    this.adoptSessionAliases(accepted.sessionAliases);
    this.flushPendingAborts();
    this.resubscribeSessions();
    this.announceConnection(true);
  }

  /** The hello names the main-session alias: state kept under the alias moves to its canonical key. */
  private adoptSessionAliases(aliases: ReadonlyMap<string, string>): void {
    for (const [alias, canonicalKey] of aliases) {
      this.rememberAlias(alias, canonicalKey);
      const aliasState = this.sessions.get(alias);
      if (aliasState) this.mergeInto(aliasState, canonicalKey);
    }
  }

  private warnAboutMissingOperations({ adapter, accepted }: Connection): void {
    const missing = adapter.missingOperations(accepted.features);
    if (missing.length > 0) {
      this.logger.warn(`gateway protocol v${adapter.version} lacks required operations: ${missing.join(', ')}`);
    }
  }

  /**
   * Full handshake: `connect` goes out on the gateway's `connect.challenge`.
   * A socket retired mid-handshake (updateConnection, suspend or a newer
   * attempt replaced `this.ws`) never marks the client connected, and its
   * promise still settles so callers are not stranded.
   */
  private openAndHandshake(): Promise<Connection> {
    let ws: WebSocketLike;
    try {
      ws = this.wsFactory(this.url);
    } catch (err) {
      // `ws` throws synchronously on a malformed URL: permanent, so no reconnect.
      this.ws = null;
      return Promise.reject(new Error(`gateway connect failed ${this.redactCredentials(errorMessage(err))}`));
    }
    this.ws = ws;
    const range = this.handshakeRange();
    const adapter = handshakeAdapter(range);
    return new Promise<Connection>((resolve, reject) => {
      let settled = false;
      // Kept for the close that follows the error frame: it must not reclassify the rejection.
      let rejection: HandshakeRejection | null = null;
      let connectRequestId: string | null = null;
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(handshakeTimer);
        ws.removeListener('message', onMessage);
        return true;
      };
      const closeQuietly = (): void => {
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      };
      const abandon = (message: string): void => {
        if (settle()) reject(new Error(message));
      };
      const fail = (message: string): void => {
        abandon(message);
        closeQuietly();
      };
      const failRejected = (rejected: HandshakeRejection): void => {
        // Only the live handshake listener gets here, so the handshake is still unsettled.
        settle();
        rejection = { ...rejected, message: this.redactGatewayMessage(rejected.message) };
        const detail = rejection.message ? `: ${rejection.message}` : '';
        reject(new GatewayConnectError(`gateway handshake rejected code=${rejection.code}${detail}`, rejection));
        closeQuietly();
      };
      const sendHello = (): void => {
        if (connectRequestId !== null) return;
        connectRequestId = this.allocId();
        const hello = adapter.connectRequest({
          token: this.token,
          minProtocol: range.min,
          maxProtocol: range.max,
          clientVersion: CLIENT_VERSION,
          platform: process.platform,
        });
        const serialized = adapter.encodeRequest(connectRequestId, hello);
        if (Buffer.byteLength(serialized) > adapter.preAuthPayloadLimitBytes) {
          failRejected(oversizedConnectRejection(adapter.preAuthPayloadLimitBytes));
          return;
        }
        ws.send(serialized);
      };
      const accept = (payload: unknown): void => {
        const accepted = adapter.parseHello(payload);
        if (!accepted) {
          fail('gateway handshake returned no hello');
          return;
        }
        const negotiated = negotiatedAdapter(range, accepted.protocolVersion);
        if (!isAdapter(negotiated)) {
          failRejected(negotiated);
          return;
        }
        if (this.ws !== ws) {
          fail('gateway handshake superseded: retired socket delivered its hello');
          return;
        }
        settle();
        this.liveWs = ws;
        resolve({ adapter: negotiated, accepted });
      };
      const onMessage = (data: unknown): void => {
        const text = frameText(data);
        const frame = text === null ? null : adapter.decodeFrame(text);
        if (frame?.type === 'event') {
          if (frame.event?.kind === 'challenge') sendHello();
          return;
        }
        if (!frame || frame.id !== connectRequestId) return;
        if (frame.ok) {
          accept(frame.payload);
        } else {
          failRejected(adapter.classifyRejection(frame.error));
        }
      };
      const onError = (err: Error): void => {
        const message = this.redactCredentials(errorMessage(err));
        this.logger.error(`gateway error ${message}`);
        fail(`gateway error ${message}`);
      };
      const onClose = (): void => {
        if (this.ws !== ws) {
          abandon('gateway handshake superseded: retired socket closed');
          return;
        }
        abandon('gateway closed before handshake completed');
        this.handleSocketClosed(rejection);
      };
      const handshakeTimer = setTimeout(() => fail('gateway handshake timed out waiting for connect.challenge or hello'), HANDSHAKE_TIMEOUT_MS);
      ws.on('message', onMessage);
      ws.on('error', onError);
      ws.on('close', onClose);
    });
  }

  /** The current socket closed: subscriptions and RPCs die with it. Accepted runs survive a
   *  reconnect, except after a permanent or pause rejection, when none follows until the
   *  user reconnects or changes the settings. */
  private handleSocketClosed(rejection: HandshakeRejection | null): void {
    this.liveWs = null;
    this.connection = null;
    this.stopKeepalive();
    this.announceConnection(false);
    this.forgetSubscriptions();
    this.rejectAllPending('gateway connection closed');
    if (rejection && rejection.kind !== 'backoff') {
      this.logger.warn(`gateway rejected the handshake code=${rejection.code}; not reconnecting until the connection settings change`);
      this.finishOwnedRuns(`The gateway rejected this connection, so the run was interrupted. ${rejection.hint}`);
      return;
    }
    this.scheduleReconnect(Math.max(rejection ? this.minimumRetryDelay(rejection) : 0, this.restartDelayMs));
  }

  /** A rate limit or a pending approval without a delay still must not be hammered. */
  private minimumRetryDelay(rejection: HandshakeRejection): number {
    return rejection.retryAfterMs ?? (rejection.throttled ? this.maxDelayMs : 0);
  }

  private scheduleReconnect(minimumDelayMs = 0): void {
    if (this.reconnectTimer || this.disposed) return;
    const attempt = this.reconnectAttempt++;
    const delay = Math.max(Math.min(this.baseDelayMs * 2 ** attempt, this.maxDelayMs), minimumDelayMs);
    this.logger.info(`gateway reconnect scheduled attempt=${attempt + 1} delayMs=${delay}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err: Error) => {
        this.logger.error(`gateway reconnect failed ${this.redactCredentials(err.message)}`);
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Invalidate any in-flight handshake and cancel scheduled reconnects. */
  private stopConnecting(): void {
    this.connectGeneration += 1;
    this.connectPromise = null;
    this.clearReconnectTimer();
  }

  /** Drop the current socket and fail its RPCs; its close event is then ignored as retired. */
  private closeSocket(reason: string, code?: number): void {
    const ws = this.ws;
    this.ws = null;
    this.liveWs = null;
    this.connection = null;
    this.stopKeepalive();
    this.announceConnection(false);
    this.forgetSubscriptions();
    this.rejectAllPending(reason);
    try {
      if (code === undefined) ws?.close();
      else ws?.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  /** Silence past two tick intervals means a dead connection the socket has not noticed. */
  private startKeepalive(ws: WebSocketLike, tickIntervalMs: number): void {
    this.stopKeepalive();
    this.lastInboundAt = Date.now();
    this.keepaliveTimer = setInterval(() => {
      if (this.liveWs !== ws || Date.now() - this.lastInboundAt <= tickIntervalMs * 2) {
        return;
      }
      this.logger.warn('gateway ticks stopped; reconnecting');
      this.closeSocket('gateway tick timeout', TICK_TIMEOUT_CLOSE_CODE);
      this.scheduleReconnect();
    }, tickIntervalMs);
    this.keepaliveTimer.unref?.();
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  /** Subscriptions are socket-scoped: a closing socket drops them server-side. */
  private forgetSubscriptions(): void {
    for (const state of this.sessions.values()) {
      state.subscribed = false;
      state.subscribing = null;
    }
  }

  private announceConnection(connected: boolean): void {
    if (this.announcedConnected === connected) {
      return;
    }
    this.announcedConnected = connected;
    for (const listener of [...this.connectionListeners]) {
      listener(connected);
    }
  }

  /** Strip URL userinfo, sensitive query params and the token from a
   *  transport error: `ws` echoes the full URL in messages like "Invalid URL". */
  private redactCredentials(message: string): string {
    const redacted = redactPlainSecrets(message.replace(URL_IN_TEXT, (url) => redactEndpoint(url)));
    return this.token ? redacted.split(this.token).join('***') : redacted;
  }

  /** A gateway message is shown to the user: strip credentials and cap its length. */
  private redactGatewayMessage(message: string): string {
    const redacted = this.redactCredentials(message);
    return redacted.length > GATEWAY_MESSAGE_LIMIT ? `${redacted.slice(0, GATEWAY_MESSAGE_LIMIT)}…` : redacted;
  }

  /* ---------------------------------------------------------------- */
  /* RPC                                                               */
  /* ---------------------------------------------------------------- */

  private allocId(): string {
    return `cc-${this.nextRequestId++}`;
  }

  private request(build: (adapter: GatewayProtocolAdapter) => WireRequest): Promise<RpcResult> {
    const ws = this.liveWs;
    const connection = this.connection;
    if (!ws || !connection) {
      return Promise.reject(new Error(NOT_CONNECTED_MESSAGE));
    }
    const id = this.allocId();
    const wire = build(connection.adapter);
    const frame = connection.adapter.encodeRequest(id, wire);
    const frameBytes = Buffer.byteLength(frame);
    if (frameBytes > connection.accepted.limits.maxPayloadBytes) {
      return Promise.reject(new FrameTooLargeError(`${wire.method} is ${frameBytes} bytes, over the gateway's ${connection.accepted.limits.maxPayloadBytes}-byte frame limit`));
    }
    const { adapter } = connection;
    return new Promise<RpcResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway rpc timeout method=${wire.method}`));
      }, REQUEST_TIMEOUT_MS);
      const pendingRequest: PendingRequest = {
        adapter,
        resolve: (payload) => {
          clearTimeout(timer);
          resolve({ adapter, payload });
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.pending.set(id, pendingRequest);
      try {
        ws.send(frame);
      } catch (err) {
        this.pending.delete(id);
        pendingRequest.reject(new Error(`gateway rpc send failed method=${wire.method} ${this.redactCredentials(errorMessage(err))}`));
      }
    });
  }

  /** Reject and clear every in-flight request (socket closed / disposed). */
  private rejectAllPending(reason: string): void {
    const requests = [...this.pending.values()];
    this.pending.clear();
    for (const pendingRequest of requests) {
      pendingRequest.reject(new Error(reason));
    }
  }

  private supports(operation: Parameters<GatewayProtocolAdapter['supports']>[1]): boolean {
    const connection = this.connection;
    return connection !== null && connection.adapter.supports(connection.accepted.features, operation);
  }

  /** The main sessions of the gateway, as the pickers show them. */
  async listSessions(): Promise<SessionSummary[]> {
    const { adapter, payload } = await this.request((wire) => wire.listRequest());
    const sessions = adapter.parseSessionList(payload);
    if (!sessions) {
      throw new Error('gateway returned a malformed session list');
    }
    return sessions;
  }

  /* ---------------------------------------------------------------- */
  /* Sessions and their keys                                           */
  /* ---------------------------------------------------------------- */

  private stateFor(sessionKey: string): SessionState | undefined {
    return this.sessions.get(this.canonicalSessionKey(sessionKey));
  }

  private ensureState(sessionKey: string): SessionState {
    const key = this.canonicalSessionKey(sessionKey);
    let state = this.sessions.get(key);
    if (!state) {
      state = newSessionState(key);
      this.sessions.set(key, state);
      this.evictIdleSessions();
    }
    return state;
  }

  private hasSinks(state: SessionState): boolean {
    return state.owned !== null || state.observers.size > 0;
  }

  private evictIdleSessions(): void {
    const idle = [...this.sessions.values()].filter((state) => !this.hasSinks(state) && !state.subscribing);
    for (const state of idle.slice(0, Math.max(0, idle.length - IDLE_SESSION_LIMIT))) {
      this.sessions.delete(state.key);
    }
  }

  private rememberAlias(requestedKey: string, canonicalKey: string): void {
    this.aliases.delete(requestedKey);
    this.aliases.set(requestedKey, canonicalKey);
    if (this.aliases.size > ALIAS_LIMIT) {
      const [oldest] = this.aliases.keys();
      this.aliases.delete(oldest);
    }
  }

  /** Subscribe a session; resolves to its canonical key, or null when the gateway refused. */
  private subscribe(state: SessionState): Promise<string | null> {
    if (state.subscribed) {
      return Promise.resolve(state.key);
    }
    if (state.subscribing) {
      return state.subscribing;
    }
    const attempt = this.request((adapter) => adapter.subscribeRequest({ sessionKey: state.key }))
      .then((result) => this.acceptSubscription(state, result))
      .catch((err: Error) => {
        this.logger.warn(`sessions.messages.subscribe failed ${err.message}`);
        return null;
      })
      .finally(() => {
        if (state.subscribing === attempt) state.subscribing = null;
      });
    state.subscribing = attempt;
    return attempt;
  }

  private acceptSubscription(state: SessionState, { adapter, payload }: RpcResult): string | null {
    const accepted = adapter.parseSubscription(payload);
    if (!accepted || this.sessions.get(state.key) !== state) {
      return accepted?.canonicalKey ?? null;
    }
    const canonical = accepted.canonicalKey === state.key ? state : this.mergeInto(state, accepted.canonicalKey);
    canonical.subscribed = true;
    this.releaseIfIdle(canonical);
    return canonical.key;
  }

  /** Move an alias's state under its canonical key. A second local run there is a conflict:
   *  taking the session over would steal the other thread's live response. */
  private mergeInto(alias: SessionState, canonicalKey: string): SessionState {
    this.rememberAlias(alias.key, canonicalKey);
    this.sessions.delete(alias.key);
    const target = this.sessions.get(canonicalKey) ?? newSessionState(canonicalKey);
    this.sessions.set(canonicalKey, target);
    for (const sink of alias.observers) target.observers.add(sink);
    for (const [runId, run] of alias.liveRuns) if (!target.liveRuns.has(runId)) target.liveRuns.set(runId, run);
    target.cursor ??= alias.cursor;
    target.lastSeq = Math.max(target.lastSeq, alias.lastSeq);
    const moving = alias.owned;
    if (moving && target.owned && target.owned.sink !== moving.sink) {
      this.failOwned(alias, moving, `Session "${canonicalKey}" is already streaming in another chat thread. Wait for it to finish or open a different session.`);
    } else if (moving) {
      target.owned = moving;
    }
    return target;
  }

  /** Release a session's socket subscription once its last sink is gone; fire-and-forget. */
  private releaseIfIdle(state: SessionState): void {
    if (this.hasSinks(state) || !state.subscribed) {
      return;
    }
    state.subscribed = false;
    if (!this.supports('unsubscribe')) {
      return;
    }
    this.request((adapter) => adapter.unsubscribeRequest({ sessionKey: state.key })).catch((err: Error) => {
      this.logger.warn(`sessions.messages.unsubscribe failed ${err.message}`);
    });
  }

  /** Re-issue subscriptions after a reconnect and catch up on what the socket missed. */
  private resubscribeSessions(): void {
    for (const state of [...this.sessions.values()]) {
      if (this.hasSinks(state)) {
        this.logger.info(`gateway re-subscribing session after reconnect ${state.key}`);
        void this.observe(state, false);
      }
    }
  }

  /** Subscribe, then catch up. A refused subscription leaves the sinks for the next reconnect,
   *  except a run that can no longer be observed. */
  private async observe(state: SessionState, allowTail: boolean): Promise<void> {
    const canonicalKey = await this.subscribe(state);
    const current = canonicalKey === null ? undefined : this.sessions.get(canonicalKey);
    if (!current) {
      if (this.liveWs) this.failUnobservableRun(state);
      return;
    }
    await this.catchUp(current, allowTail);
  }

  private failUnobservableRun(state: SessionState): void {
    const owned = state.owned;
    if (owned?.stage === 'accepted') {
      this.failOwned(state, owned, `Transcript subscription for "${state.key}" failed. The response may not appear in this thread.`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Transcript sinks, history seeding and resume                     */
  /* ---------------------------------------------------------------- */

  /** Whether a run on this session was started here: runs of other clients are invisible to abort gates. */
  hasOwnedRun(sessionKey: string): boolean {
    return (this.stateFor(sessionKey)?.owned ?? null) !== null;
  }

  /** Snapshot one session's catch-up position before a teardown that may be rolled back. */
  captureSessionState(sessionKey: string): SessionCatchUpSnapshot | null {
    const state = this.stateFor(sessionKey);
    return state && (state.cursor !== null || state.lastSeq > 0) ? { cursor: state.cursor, lastSeq: state.lastSeq } : null;
  }

  /** Restore a captureSessionState snapshot, so the next subscription replays exactly what was missed. */
  restoreSessionState(sessionKey: string, snapshot: SessionCatchUpSnapshot | null): void {
    if (!snapshot) {
      return;
    }
    const state = this.ensureState(sessionKey);
    state.cursor = snapshot.cursor;
    state.lastSeq = snapshot.lastSeq;
  }

  /** Thread teardown: stop routing the session to transcript sinks and forget its catch-up position. */
  clearSessionSink(sessionKey: string): void {
    const state = this.stateFor(sessionKey);
    if (!state) {
      return;
    }
    state.observers.clear();
    state.cursor = null;
    state.lastSeq = 0;
    this.releaseIfIdle(state);
  }

  /** Drop one transcript sink; the provider uses it to replace, not duplicate, a callback. */
  removeTranscriptSink(sessionKey: string, onEvent: ChatSink): void {
    const state = this.stateFor(sessionKey);
    if (!state?.observers.delete(onEvent)) {
      return;
    }
    this.releaseIfIdle(state);
  }

  /** Re-register a transcript sink; it hears what follows the session's catch-up position. */
  rebindTranscriptSink(sessionKey: string, onEvent: ChatSink): void {
    const state = this.ensureState(sessionKey);
    state.observers.add(onEvent);
    void this.observe(state, false);
  }

  /**
   * Remember what a rendered history snapshot covered, so a later catch-up
   * replays only what follows it, and which runs it reports still active.
   */
  seedHistory(sessionKey: string, snapshot: HistorySnapshot | null): void {
    if (!snapshot) {
      return;
    }
    const state = this.ensureState(sessionKey);
    state.cursor = snapshot.cursor ?? state.cursor;
    state.lastSeq = highestSeq(snapshot.messages, state.lastSeq);
    const activeRunIds = snapshot.activeRunIds ?? (snapshot.inFlightRunId ? [snapshot.inFlightRunId] : []);
    for (const runId of activeRunIds) this.liveRun(state, runId);
  }

  /** A transcript tail for UI-side history restore; null on transport/RPC failure. */
  async getHistory(sessionKey: string): Promise<HistorySnapshot | null> {
    if (!this.supports('history')) {
      return null;
    }
    try {
      const read = await this.readHistory(sessionKey);
      return read && !('reset' in read) ? read : null;
    } catch (err) {
      this.logger.warn(`chat.history fetch failed ${errorMessage(err)}`);
      return null;
    }
  }

  private async readHistory(sessionKey: string, cursor?: string): Promise<HistoryRead | null> {
    const { adapter, payload } = await this.request((wire) => wire.historyRequest({ sessionKey, cursor }));
    return adapter.parseHistory(payload);
  }

  /**
   * Resume a session after a window restart: subscribe and catch up on what
   * the UI has not rendered. `historyRendered` means the provider rendered
   * and seeded a history snapshot, so an unscoped tail would only repeat it.
   */
  resumeSession(sessionKey: string, onEvent: ChatSink, opts?: { historyRendered?: boolean }): void {
    const state = this.ensureState(sessionKey);
    state.observers.add(onEvent);
    void this.observe(state, !opts?.historyRendered);
  }

  /* ---------------------------------------------------------------- */
  /* Sending                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Start a run on a session. The session is subscribed (and its key
   * resolved) before `chat.send` goes out, so its output cannot race the
   * subscription. The send follows its own run and the session's live runs
   * it may steer into, and ends with one `done` once all of them finished.
   * `chat.send` is issued at most once.
   */
  sendMessage(send: GatewaySend): void {
    const refusal = this.sendRefusal(send);
    if (refusal) {
      send.onEvent({ type: 'error', message: refusal });
      send.onEvent({ type: 'done' });
      return;
    }
    const state = this.ensureState(send.sessionKey);
    const owned = this.takeOverRun(state, send);
    void this.subscribe(state).then((canonicalKey) => this.issueSend(owned, send, canonicalKey));
  }

  /** Why a send must not start now, or null. An abort still in flight would swallow the new run. */
  private sendRefusal(send: GatewaySend): string | null {
    const connection = this.connection;
    if (!this.liveWs || !connection) {
      return NOT_CONNECTED_MESSAGE;
    }
    const missing = connection.adapter.missingOperations(connection.accepted.features);
    if (missing.length > 0) {
      return `The gateway (protocol v${connection.adapter.version}) does not offer ${missing.join(', ')}, so replies cannot stream. Update the gateway.`;
    }
    if (this.stateFor(send.sessionKey)?.aborting) {
      return 'The previous run on this session is still aborting; retry in a moment.';
    }
    return this.attachmentRefusal(send.attachments ?? [], connection.accepted.limits);
  }

  /** A file over the gateway's advertised per-attachment ceiling would be rejected after upload. */
  private attachmentRefusal(attachments: readonly SendAttachment[], limits: ConnectionLimits): string | null {
    for (const { name, mimeType, data } of attachments) {
      const limit = mimeType.startsWith('image/') ? limits.attachmentMaxImageBytes : limits.attachmentMaxBytes;
      if (data.byteLength > limit) {
        return `Attachment "${name}" is ${data.byteLength} bytes; the gateway accepts at most ${limit} bytes per ${mimeType.startsWith('image/') ? 'image' : 'file'}.`;
      }
    }
    return null;
  }

  /** Register the send's run; a previous run sink of another thread on the session ends with `done`. */
  private takeOverRun(state: SessionState, send: GatewaySend): OwnedRun {
    const runId = randomUUID();
    const previous = state.owned;
    const followed = new Set<string>([runId, ...state.liveRuns.keys()]);
    for (const inherited of previous?.followed ?? []) {
      if (!state.finishedRuns.has(inherited) && inherited !== previous?.runId) followed.add(inherited);
    }
    if (previous && previous.stage !== 'preparing') followed.add(previous.runId);
    const owned: OwnedRun = {
      sink: send.onEvent,
      runId,
      requestedKey: send.sessionKey,
      stage: 'preparing',
      followed,
    };
    state.owned = owned;
    if (previous && previous.sink !== send.onEvent) {
      previous.sink({ type: 'done' });
    }
    return owned;
  }

  private issueSend(owned: OwnedRun, send: GatewaySend, canonicalKey: string | null): void {
    const state = canonicalKey === null ? this.stateOwning(owned) : this.sessions.get(canonicalKey);
    if (!state || state.owned !== owned) {
      return;
    }
    if (canonicalKey === null) {
      this.failOwned(state, owned, `Transcript subscription for "${send.sessionKey}" failed; the send was not issued. Retry once the gateway accepts sessions.messages.subscribe.`);
      return;
    }
    if (canonicalKey !== send.sessionKey) {
      send.onSessionResolved?.(canonicalKey, send.sessionKey);
      if (state.owned !== owned) return;
    }
    owned.stage = 'issued';
    this.localRunIds.add(owned.runId);
    const request = { sessionKey: canonicalKey, text: send.prompt, runId: owned.runId, attachments: send.attachments };
    this.request((adapter) => adapter.sendRequest(request))
      .then((result) => this.acceptSend(owned, result))
      .catch((err: Error) => {
        const current = this.stateOwning(owned);
        if (!current) return;
        this.failOwned(current, owned, this.sendFailureMessage(err));
      });
  }

  private sendFailureMessage(err: Error): string {
    if (err instanceof FrameTooLargeError) return `The message was not sent: ${err.message}. Remove attachments or shorten it.`;
    if (err.message === 'gateway connection closed') return SEND_UNCONFIRMED_MESSAGE;
    return `The gateway rejected the send: ${err.message}`;
  }

  private stateOwning(owned: OwnedRun): SessionState | undefined {
    return [...this.sessions.values()].find((state) => state.owned === owned);
  }

  /** The ack names the run; events of that run that raced the ack are replayed in order. */
  private acceptSend(owned: OwnedRun, { adapter, payload }: RpcResult): void {
    const state = this.stateOwning(owned);
    if (!state) {
      return;
    }
    owned.stage = 'accepted';
    const accepted = adapter.parseSendAccepted(payload);
    if (accepted && accepted.runId !== owned.runId) {
      this.logger.warn('gateway acknowledged the send under another run id; following it');
      owned.followed.add(accepted.runId);
      this.localRunIds.add(accepted.runId);
    }
    const unclaimed = state.unclaimed;
    state.unclaimed = [];
    for (const event of unclaimed) this.routeRunEvent(event);
  }

  /** Retire a send that failed and deliver error + done; events held for it go to the observers. */
  private failOwned(state: SessionState, owned: OwnedRun, message: string): void {
    state.owned = null;
    const unclaimed = state.unclaimed;
    state.unclaimed = [];
    for (const event of unclaimed) this.routeRunEvent(event);
    owned.sink({ type: 'error', message });
    owned.sink({ type: 'done' });
    this.releaseIfIdle(state);
  }

  /* ---------------------------------------------------------------- */
  /* Aborting                                                          */
  /* ---------------------------------------------------------------- */

  /** The runs a cancel may stop: those this client started, still going. */
  private abortableRuns(state: SessionState, owned: OwnedRun): string[] {
    return [...owned.followed].filter((runId) => this.localRunIds.has(runId) && !state.finishedRuns.has(runId));
  }

  /**
   * Cancel the local run of a session and complete its sink with one `done`.
   * `chat.abort` goes out only for runs this client started; a send still
   * preparing has none. Transcript sinks of other threads on the session stay.
   */
  abort(sessionKey: string): void {
    const state = this.stateFor(sessionKey);
    const owned = state?.owned;
    if (!state || !owned) {
      return;
    }
    state.owned = null;
    state.unclaimed = [];
    const runIds = owned.stage === 'preparing' ? [] : this.abortableRuns(state, owned);
    for (const runId of runIds) this.finishRun(state, runId);
    if (runIds.length > 0 && this.liveWs) {
      this.sendAborts(state, runIds, owned.sink);
      return;
    }
    for (const runId of runIds) state.pendingAborts.add(runId);
    owned.sink({ type: 'done' });
    this.releaseIfIdle(state);
  }

  /** `chat.abort` per run; the sink completes once the gateway answered. */
  private sendAborts(state: SessionState, runIds: string[], sink?: ChatSink): void {
    state.aborting = true;
    const aborts = runIds.map((runId) =>
      this.request((adapter) => adapter.abortRequest({ sessionKey: state.key, runId })).catch((err: Error) => {
        this.logger.warn(`chat.abort failed ${err.message}`);
      })
    );
    void Promise.all(aborts).then(() => {
      state.aborting = false;
      sink?.({ type: 'done' });
      this.releaseIfIdle(state);
    });
  }

  private flushPendingAborts(): void {
    for (const state of this.sessions.values()) {
      const runIds = [...state.pendingAborts];
      state.pendingAborts.clear();
      if (runIds.length > 0) this.sendAborts(state, runIds);
    }
  }

  /** Best-effort `chat.abort` for every local run, sent before the socket closes; no reply is awaited. */
  private abortRemoteRuns(): void {
    if (!this.liveWs) {
      return;
    }
    for (const state of this.sessions.values()) {
      const owned = state.owned;
      if (!owned || owned.stage === 'preparing') continue;
      for (const runId of this.abortableRuns(state, owned)) {
        this.request((adapter) => adapter.abortRequest({ sessionKey: state.key, runId })).catch(() => undefined);
      }
    }
  }

  /** Complete every run sink (with an error first when given). */
  private finishOwnedRuns(failure?: string): void {
    for (const state of this.sessions.values()) {
      const owned = state.owned;
      if (!owned) continue;
      state.owned = null;
      state.unclaimed = [];
      if (failure) owned.sink({ type: 'error', message: failure });
      owned.sink({ type: 'done' });
    }
  }

  /** Every sink ends with `done`; none will receive further events. */
  private retireAllSinks(): void {
    this.finishOwnedRuns();
    for (const state of this.sessions.values()) {
      const observers = [...state.observers];
      state.observers.clear();
      state.liveRuns.clear();
      for (const sink of observers) sink({ type: 'done' });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Inbound frames                                                    */
  /* ---------------------------------------------------------------- */

  private handleMessage(adapter: GatewayProtocolAdapter, data: unknown): void {
    this.lastInboundAt = Date.now();
    const text = frameText(data);
    const frame = text === null ? null : adapter.decodeFrame(text);
    if (!frame) {
      return;
    }
    if (frame.type === 'response') {
      this.settleRequest(frame);
      return;
    }
    this.noteConnectionSeq(frame.connectionSeq);
    if (frame.event) this.handleEvent(frame.event);
  }

  private settleRequest(frame: Extract<InboundFrame, { type: 'response' }>): void {
    const pendingRequest = this.pending.get(frame.id);
    if (!pendingRequest) return;
    this.pending.delete(frame.id);
    if (frame.ok) {
      pendingRequest.resolve(frame.payload);
    } else {
      pendingRequest.reject(new Error(`gateway rpc error code=${pendingRequest.adapter.errorCode(frame.error)}`));
    }
  }

  /** A gap in the connection's event sequence means dropped events: catch up from the cursors. */
  private noteConnectionSeq(seq: number | null): void {
    if (seq === null) {
      return;
    }
    const gap = this.lastConnectionSeq !== null && seq > this.lastConnectionSeq + 1;
    this.lastConnectionSeq = seq;
    if (!gap) {
      return;
    }
    this.logger.warn('gateway event sequence gap; catching up from history');
    for (const state of this.sessions.values()) {
      if (this.hasSinks(state) && state.subscribed) void this.catchUp(state, false);
    }
  }

  private handleEvent(event: InboundEvent): void {
    switch (event.kind) {
      case 'transcriptMessage':
        this.routeTranscriptMessage(event.sessionKey, event.message);
        return;
      case 'shutdown':
        this.logger.info(`gateway shutting down reason=${event.reason}`);
        this.restartDelayMs = event.restartExpectedMs ?? 0;
        return;
      case 'keepalive':
      case 'challenge':
        return;
      default:
        this.routeRunEvent(event);
    }
  }

  private sessionOfRun(event: RunEvent): SessionState | undefined {
    if (event.sessionKey) {
      return this.stateFor(event.sessionKey);
    }
    return [...this.sessions.values()].find((state) => state.liveRuns.has(event.runId) || state.owned?.followed.has(event.runId));
  }

  /** Route one run event to its session's sinks; unknown sessions have no sinks and are dropped. */
  private routeRunEvent(event: RunEvent): void {
    const state = this.sessionOfRun(event);
    if (!state || state.finishedRuns.has(event.runId)) {
      return;
    }
    const owned = state.owned;
    if (owned?.stage === 'issued' && !owned.followed.has(event.runId) && !state.liveRuns.has(event.runId)) {
      state.unclaimed.push(event);
      if (state.unclaimed.length > UNCLAIMED_EVENT_LIMIT) state.unclaimed.shift();
      return;
    }
    this.applyRunEvent(state, event);
  }

  private liveRun(state: SessionState, runId: string): RunText {
    let run = state.liveRuns.get(runId);
    if (!run) {
      run = newRunText();
      state.liveRuns.set(runId, run);
      if (state.liveRuns.size > LIVE_RUN_LIMIT) {
        const [stalest] = state.liveRuns.keys();
        state.liveRuns.delete(stalest);
      }
    }
    return run;
  }

  /** Sinks that hear a run: the session's observers and the local send following it. */
  private runSinks(state: SessionState, runId: string): ChatSink[] {
    const sinks = new Set(state.observers);
    if (state.owned?.followed.has(runId)) sinks.add(state.owned.sink);
    return [...sinks];
  }

  private deliver(sinks: readonly ChatSink[], events: readonly ChatEvent[]): void {
    for (const event of events) {
      for (const sink of sinks) sink(event);
    }
  }

  private applyRunEvent(state: SessionState, event: RunEvent): void {
    const run = this.liveRun(state, event.runId);
    const sinks = this.runSinks(state, event.runId);
    switch (event.kind) {
      case 'runStatus':
        return;
      case 'runDelta': {
        const chunk = applyDelta(run, event);
        if (chunk) state.streamedRuns.add(event.runId);
        this.deliver(sinks, textEvent(chunk ?? ''));
        return;
      }
      case 'toolUpdate':
        this.deliver(sinks, [{ type: 'toolCall', id: event.toolCallId, title: event.name, status: event.status, details: event.details }]);
        return;
      case 'runFinal':
        this.deliver(sinks, [...textEvent(applyFinal(run, event.text)), ...usageEvent(event.usage)]);
        break;
      case 'runAborted':
        this.deliver(sinks, textEvent(applyAborted(run, event.text)));
        break;
      case 'runError':
        this.deliver(sinks, [...usageEvent(event.usage), { type: 'error', message: event.errorMessage ?? RUN_FAILED_MESSAGE }]);
        break;
    }
    state.streamedRuns.add(event.runId);
    this.finishRun(state, event.runId);
  }

  /** A run ended: observers complete, and the local send completes once all its runs did.
   *  Callers pass only unfinished runs, so each run ends once. */
  private finishRun(state: SessionState, runId: string): void {
    state.finishedRuns.add(runId);
    state.liveRuns.delete(runId);
    this.deliver([...state.observers], [{ type: 'done' }]);
    const owned = state.owned;
    if (!owned?.followed.delete(runId)) {
      return;
    }
    if (owned.followed.size === 0) {
      state.owned = null;
      owned.sink({ type: 'done' });
      this.releaseIfIdle(state);
    }
  }

  /** Live transcript rows move the catch-up position. An assistant row reports its run's usage
   *  (`chat` events carry none), and a row of a run not seen streaming yet starts that run's
   *  text, so its later `chat` events only add what follows. */
  private routeTranscriptMessage(sessionKey: string, message: TranscriptMessage): void {
    const state = this.stateFor(sessionKey);
    if (!state) {
      return;
    }
    state.lastSeq = Math.max(state.lastSeq, message.seq ?? 0);
    const runId = message.runId;
    if (message.role !== 'assistant' || runId === null || state.finishedRuns.has(runId)) {
      return;
    }
    const events = usageEvent(message.usage);
    if (message.text && !state.streamedRuns.has(runId)) {
      state.streamedRuns.add(runId);
      events.unshift(...textEvent(applyFinal(this.liveRun(state, runId), message.text)));
    }
    this.deliver(this.runSinks(state, runId), events);
  }

  /* ---------------------------------------------------------------- */
  /* History catch-up                                                  */
  /* ---------------------------------------------------------------- */

  /** One catch-up per session at a time; a request arriving mid-way runs once more after it. */
  private catchUp(state: SessionState, allowTail: boolean): Promise<void> {
    if (state.catchUp) {
      state.catchUpAgain = true;
      return state.catchUp;
    }
    const running = this.runCatchUp(state, allowTail)
      .catch((err: unknown) => this.logger.warn(`chat.history catch-up failed ${errorMessage(err)}`))
      .finally(() => {
        state.catchUp = null;
        if (state.catchUpAgain) {
          state.catchUpAgain = false;
          void this.catchUp(state, false);
        }
      });
    state.catchUp = running;
    return running;
  }

  private trackedRuns(state: SessionState): string[] {
    const runs = new Set(state.liveRuns.keys());
    const owned = state.owned;
    if (owned && owned.stage !== 'preparing') for (const runId of owned.followed) runs.add(runId);
    return [...runs].filter((runId) => !state.finishedRuns.has(runId));
  }

  /**
   * Replay what the sinks missed: the rows after the cursor (or, without one,
   * after the highest sequence shown), then finish tracked runs the gateway
   * no longer reports active, with the last text they left.
   */
  private async runCatchUp(state: SessionState, allowTail: boolean): Promise<void> {
    const hasBoundary = state.cursor !== null || state.lastSeq > 0;
    if (!this.supports('history') || (!hasBoundary && !allowTail && this.trackedRuns(state).length === 0)) {
      return;
    }
    const read = await this.readCatchUp(state);
    if (!read || this.sessions.get(state.key) !== state) {
      return;
    }
    const fresh = read.messages.filter((message) => message.seq === null ? !hasBoundary && allowTail : message.seq > state.lastSeq);
    state.cursor = read.cursor ?? state.cursor;
    state.lastSeq = highestSeq(read.messages, state.lastSeq);
    if (hasBoundary || allowTail) this.replayRows(state, fresh);
    this.settleInactiveRuns(state, read);
  }

  /** The rows after the cursor; a reset cursor falls back to a tail read. */
  private async readCatchUp(state: SessionState): Promise<HistorySnapshot | null> {
    const cursor = state.cursor;
    const read = await this.readHistory(state.key, cursor ?? undefined);
    if (read && !('reset' in read)) {
      return read;
    }
    state.cursor = null;
    const tail = cursor === null ? null : await this.readHistory(state.key);
    if (!tail || 'reset' in tail) {
      return null;
    }
    // A reset transcript restarts its sequence: the old position no longer bounds it.
    if (highestSeq(tail.messages, 0) < state.lastSeq) state.lastSeq = 0;
    return tail;
  }

  private replayRows(state: SessionState, rows: readonly TranscriptMessage[]): void {
    const tracked = new Set(this.trackedRuns(state));
    for (const row of rows) {
      const ownedByTrackedRun = row.runId !== null && (tracked.has(row.runId) || state.streamedRuns.has(row.runId));
      if (row.role !== 'assistant' || !row.text || ownedByTrackedRun) continue;
      this.deliver([...state.observers], [...textEvent(row.text), ...usageEvent(row.usage), { type: 'done' }]);
    }
  }

  /** A tracked run the gateway no longer reports active ended while the socket was away. A run
   *  never seen and absent from the transcript may still wait in a queue, so it stays tracked. */
  private settleInactiveRuns(state: SessionState, read: HistorySnapshot): void {
    const active = read.activeRunIds ?? (read.inFlightRunId ? [read.inFlightRunId] : null);
    if (active === null) {
      return;
    }
    const finalTexts = finalTextByRun(read.messages);
    const mentioned = new Set(read.messages.flatMap((message) => message.runId ?? []));
    for (const runId of this.trackedRuns(state)) {
      const known = state.liveRuns.has(runId) || mentioned.has(runId);
      if (active.includes(runId) || !known) continue;
      const run = this.liveRun(state, runId);
      this.deliver(this.runSinks(state, runId), textEvent(applyFinal(run, finalTexts.get(runId) ?? null)));
      this.finishRun(state, runId);
    }
  }
}
