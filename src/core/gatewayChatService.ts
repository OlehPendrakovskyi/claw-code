/**
 * Claw Code — GatewayChatService.
 *
 * WebSocket RPC client for the OpenClaw Gateway (docs/gateway/protocol/):
 * the operator `connect` handshake, `chat.send` with steer/enqueue queue
 * modes, per-session transcript subscriptions with `chat.history` catch-up,
 * and reconnect with exponential backoff. It exposes the same
 * sendMessage/abort surface as `ChatService`, so the chat panel can switch
 * backends. Never logs tokens or prompts.
 *
 * Sinks: a run sink receives one send's response and exactly one terminal
 * `done`; transcript sinks observe a session (resumed threads) and fan out
 * per session key.
 */

import type { ClientHello, HelloOk, RpcErrorPayload, RpcRequestFrame, RpcResponseFrame, SessionEvent } from './contract';
import { GatewayAuthRejectionCodes, GatewayEvents, GatewayRpcMethods } from './contract';
import { asNonEmptyString, asString } from './typeGuards';
import { createHash, randomUUID } from 'crypto';
import type { ChatEvent } from '../chat/ChatService';
import { redactEndpoint, redactPlainSecrets } from './accessInfo/redact';
import {
  DEFAULT_SESSION_KEY,
  DELTA_TRACK_LIMIT,
  extractSessionKey,
  isAssistantRole,
  mapSessionEventToChatEvent,
  parseFrame,
} from './gatewayEventMapping';

export { DEFAULT_SESSION_KEY } from './gatewayEventMapping';

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

/** Catch-up state of one session, as captured before a sink teardown that may be rolled back. */
export type SessionCatchUpSnapshot = {
  seenMessageIds?: Set<string>;
  deltaCursor?: string;
  seededCatchUpFingerprints?: string[];
};

type ChatSink = (event: ChatEvent) => void;

type PendingRequest = {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
};

/** Message fields shared by live `session.message` payloads and `chat.history` rows. */
type MessageFields = { role?: unknown; messageId?: unknown; text?: unknown; delta?: unknown; sessionKey?: unknown };

type HistoryRow = Record<string, unknown> & MessageFields;

/** A send between sendMessage() and its `chat.send` acknowledgement. */
type PendingSend = {
  id: string;
  sessionKey: string;
  sink: ChatSink;
  prompt: string;
  queueMode: 'steer' | 'enqueue';
  onSessionResolved?: (resolvedKey: string, requestedKey: string) => void;
  /** `chat.send` is on the wire, so the gateway may already stream this run. */
  issued: boolean;
  /** The send steers a run the gateway already started: aborting it must abort that run. */
  steersRemoteRun: boolean;
  /** The send replaced an issued, unacknowledged send: that run's frames are this send's to claim. */
  continuesIssuedRun: boolean;
};

/** A frame that arrived before the acknowledgement of the issued sends it may belong to. */
type BufferedFrame = { evt: SessionEvent; key: string; sends: Set<string> };

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

const CLIENT_VERSION = '0.2.1';
const PROTOCOL_VERSION = 4;
const REQUEST_TIMEOUT_MS = 30_000;
/** Max wait for connect.challenge before sending connect anyway (protocol/auth.md allows legacy fallback). */
const CHALLENGE_FALLBACK_MS = 500;
/** Finite timeout for the full connect handshake (no-response protection). */
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Cap on frames held for pre-ack sends; the oldest frame is dropped beyond it. */
const PRE_ACK_BUFFER_LIMIT = 500;
/** Cap on catch-up boundary fingerprints kept per session (latest rows win). */
const SEEDED_FINGERPRINT_LIMIT = 500;
/** Cap on remembered complete-message ids per session (oldest evicted). */
const SEEN_MESSAGE_LIMIT = 500;

const URL_IN_TEXT = /\b(?:wss?|https?):\/\/[^\s"'<>]+/gi;

const NOT_CONNECTED_MESSAGE =
  'Gateway is not connected. Run "OpenClaw: Connect to Gateway" to configure a token, or check openclaw.gateway.url.';
const CREDENTIALS_REJECTED_MESSAGE =
  'The gateway rejected the configured credentials, so the run was interrupted. Update the gateway token and retry.';
const PRE_SEND_HISTORY_FAILED_MESSAGE =
  'Pre-send history snapshot for this session failed; the send was aborted to avoid an unrecoverable response. Retry once the gateway accepts chat.history.';
const PRE_SEND_NO_BOUNDARY_MESSAGE =
  'Pre-send history snapshot did not include a usable recovery boundary; the send was aborted to avoid an unrecoverable response. Retry once the gateway returns a well-formed chat.history snapshot.';

/** Lazily require `ws` to keep it off the activation path; its CJS entry exports the constructor. */
function defaultWsFactory(url: string): WebSocketLike {
  const WebSocketCtor = require('ws') as new (url: string) => WebSocketLike;
  return new WebSocketCtor(url);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Error code of an untrusted `res.error` payload. */
function errorCode(error: unknown): string {
  return asString((error as Partial<RpcErrorPayload> | null | undefined)?.code, 'unknown');
}

/** Whether a handshake error rejects the credentials themselves (not retryable as-is). */
function isAuthRejection(error: unknown): boolean {
  const retryable = (error as Partial<RpcErrorPayload> | null | undefined)?.retryable;
  return retryable !== true && GatewayAuthRejectionCodes.has(errorCode(error));
}

function isHelloOk(payload: unknown): payload is HelloOk {
  return (payload as { type?: unknown } | null | undefined)?.type === 'hello-ok';
}

/** A frame without a session key; a key of the wrong type is malformed, not keyless. */
function isKeyless(sessionKey: unknown): boolean {
  return sessionKey === undefined || sessionKey === null || sessionKey === '';
}

function payloadFields(evt: SessionEvent): MessageFields {
  return evt.payload && typeof evt.payload === 'object' ? (evt.payload as MessageFields) : {};
}

/** Object rows of an untrusted `chat.history` messages array; anything else is ignored. */
function historyRows(messages: unknown[]): HistoryRow[] {
  return messages.filter(
    (row): row is HistoryRow => row !== null && typeof row === 'object' && !Array.isArray(row)
  );
}

function isFinalAssistantRow(row: MessageFields): boolean {
  return isAssistantRole(row.role) && asNonEmptyString(row.text) !== null;
}

/** A still-streaming assistant chunk: a delta without completed text. */
function isDeltaOnlyRow(row: MessageFields): boolean {
  return isAssistantRole(row.role) && asNonEmptyString(row.delta) !== null && asNonEmptyString(row.text) === null;
}

/** The messageId of a complete assistant frame (final text, no streaming delta), else null.
 *  Only these ids enter the seen-set: a delta shares its id with the later final row,
 *  and marking it seen would make catch-up skip that row and its finalization. */
function completeFrameId(row: MessageFields): string | null {
  const messageId = asNonEmptyString(row.messageId);
  return messageId && isFinalAssistantRow(row) && asNonEmptyString(row.delta) === null ? messageId : null;
}

/** Stable catch-up boundary fingerprint of one history row: a digest keeps untrusted text out of memory. */
function rowFingerprint(row: MessageFields): string {
  const role = typeof row.role === 'string' ? row.role : '';
  const shape = asNonEmptyString(row.delta) ? 'delta' : 'final';
  const text = typeof row.text === 'string' ? row.text : '';
  return `${role}|${shape}|${createHash('sha256').update(text).digest('base64')}`;
}

/** Longest suffix of the seeded boundary that equals a prefix of the replayed rows:
 *  a history tail is a sliding window ([A,B,C] then [B,C,D]), so a row-by-row
 *  prefix match would miss the boundary once a new row shifts it. */
function boundaryOverlap(seeded: string[], rows: HistoryRow[]): number {
  const head = rows.slice(0, seeded.length).map(rowFingerprint);
  for (let overlap = head.length; overlap > 0; overlap--) {
    const tail = seeded.slice(seeded.length - overlap);
    if (tail.every((fingerprint, i) => fingerprint === head[i])) {
      return overlap;
    }
  }
  return 0;
}

/**
 * Gateway transport + chat facade.
 *
 * Lifecycle: `connect()` opens the WS and completes the `connect` handshake
 * (role=operator, token auth, hello-ok). On socket close it reconnects with
 * exponential backoff and re-subscribes every observed session. RPCs ride
 * the same socket with per-request ids and timeouts.
 */
export class GatewayChatService {
  private url: string;
  private token: string;
  private readonly logger: Logger;
  private readonly wsFactory: WebSocketFactory;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  /** Socket of the current attempt, handshaking or live. */
  private ws: WebSocketLike | null = null;
  /** The socket once its handshake completed; null while disconnected. */
  private liveWs: WebSocketLike | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** In-flight connect() (serialized: concurrent calls share the attempt). */
  private connectPromise: Promise<void> | null = null;
  /** Bumped by every attempt and teardown, so a superseded handshake cannot apply its hello. */
  private connectGeneration = 0;
  /** Session key the next send targets (null → gateway default). */
  private activeSessionKey: string | null = null;

  /** Run sinks keyed by session; an entry also marks that session's run as active (queue-mode selection). */
  private readonly runSinksBySession = new Map<string, ChatSink>();
  /** Transcript subscribers keyed by session; a run sink is registered here too while its run streams. */
  private readonly transcriptSinksBySession = new Map<string, Set<ChatSink>>();
  /** Sessions with a live transcript subscription on the current socket. */
  private readonly subscribedSessions = new Set<string>();
  /** In-flight `sessions.messages.subscribe` RPCs, shared by concurrent callers. */
  private readonly pendingSubscribeBySession = new Map<string, Promise<boolean>>();
  /** Sessions with a `chat.abort` in flight: their late events must not repopulate the cancelled thread. */
  private readonly abortingSessions = new Set<string>();

  /** Sends awaiting their acknowledgement, keyed by the requested session. */
  private readonly preAckSends = new Map<string, PendingSend>();
  /** Frames that arrived while issued sends were unacknowledged: the ack reveals which session is theirs. */
  private preAckBufferedFrames: BufferedFrame[] = [];

  /** Latest delta cursor per session key (for catch-up after reconnect). */
  private readonly deltaCursorBySession = new Map<string, string>();
  /** Fingerprints of the rows already rendered per session: the only catch-up boundary without a cursor. */
  private readonly seededCatchUpFingerprints = new Map<string, string[]>();
  /** Complete-message ids already delivered per session (messageIds are unique per transcript only). */
  private readonly seenMessageIdsBySession = new Map<string, Set<string>>();
  /** Streamed delta text per message, so a later full-text frame emits only the unrendered remainder. */
  private readonly deltaTextByMessage = new Map<string, string>();
  /** The same for frames without a messageId: one stream per session at a time. */
  private readonly deltaTextNoIdBySession = new Map<string, string>();

  /** Latest hello-ok payload from the active connection, if any. */
  hello: HelloOk | null = null;

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
    return this.liveWs !== null;
  }

  /** Identity of the configured endpoint, for caches that credential changes must invalidate.
   *  Never log it: it embeds the token. A JSON tuple cannot collide the way a `url:token` join can. */
  getGatewayIdentity(): string {
    return JSON.stringify([this.url, this.token]);
  }

  /* ---------------------------------------------------------------- */
  /* Connection lifecycle                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Update credentials in place: threads hold this instance for lifecycle
   * actions, so replacing it would sever in-flight runs. The new endpoint may
   * reuse session keys for different sessions, so every sink is retired with
   * `done` (the provider re-validates keys before re-registering) and all
   * per-session catch-up state is dropped. An in-flight handshake used the
   * old credentials and is superseded.
   */
  updateConnection(url: string, token: string): void {
    if (this.url === url && this.token === token) {
      return;
    }
    this.url = url;
    this.token = token;
    this.connectGeneration += 1;
    this.connectPromise = null;
    this.abortRemoteRuns();
    this.forgetSubscriptions();
    for (const sessionKey of this.sinkSessionKeys()) {
      this.retireTranscriptSinks(sessionKey);
    }
    this.clearPreAckState();
    this.deltaCursorBySession.clear();
    this.seededCatchUpFingerprints.clear();
    this.seenMessageIdsBySession.clear();
    this.clearDeltaBookkeeping();
    if (!this.ws) {
      return;
    }
    this.closeSocket('gateway credentials changed');
    this.scheduleReconnect();
  }

  /**
   * Open the WebSocket and complete the operator handshake. Serialized
   * (concurrent calls join the in-flight attempt), idempotent while
   * connected; an explicit attempt cancels a scheduled reconnect. A
   * superseded attempt never resolves on its own: it adopts the newer
   * attempt, or rejects when none is pending.
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
      .then((hello) => this.completeHandshake(generation, hello))
      .finally(() => {
        if (generation === this.connectGeneration) {
          this.connectPromise = null;
        }
      });
    this.connectPromise = attempt;
    return attempt;
  }

  /** Park the client after a transport switch: abort remote runs while the socket is still
   *  writable, finish run sinks with `done`, drop resume-only sinks (the provider reopens
   *  them later), and stop reconnecting. The instance stays valid for lifecycle calls. */
  suspend(): void {
    this.stopConnecting();
    this.abortRemoteRuns();
    this.forgetSubscriptions();
    this.finishRunSinks();
    this.transcriptSinksBySession.clear();
    this.clearPreAckState();
    this.clearDeltaBookkeeping();
    this.closeSocket('gateway transport suspended');
  }

  /** Tear the client down for good. Remote runs keep running (a later window resumes them);
   *  local run sinks finish with `done`. */
  dispose(): void {
    this.disposed = true;
    this.stopConnecting();
    this.forgetSubscriptions();
    this.finishRunSinks();
    this.clearPreAckState();
    this.closeSocket('gateway client disposed');
  }

  private completeHandshake(generation: number, hello: HelloOk): Promise<void> | void {
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
    this.hello = hello;
    this.reconnectAttempt = 0;
    ws.on('message', (data: unknown) => {
      if (this.liveWs === ws) {
        this.handleMessage(data);
      }
    });
    this.resubscribeSessions();
    this.logger.info(`gateway connected protocol=${String(hello.protocol)}`);
  }

  /**
   * Full connect handshake: `connect` is sent on the pre-connect
   * `connect.challenge` event, or after a short fallback for gateways without
   * one. A socket retired mid-handshake (updateConnection, suspend or a newer
   * attempt replaced `this.ws`) never marks the client connected, and its
   * promise still settles so callers are not stranded.
   */
  private openAndHandshake(): Promise<HelloOk> {
    let ws: WebSocketLike;
    try {
      ws = this.wsFactory(this.url);
    } catch (err) {
      // `ws` throws synchronously on a malformed URL: permanent, so no reconnect.
      this.ws = null;
      return Promise.reject(new Error(`gateway connect failed ${this.redactCredentials(errorMessage(err))}`));
    }
    this.ws = ws;
    return new Promise<HelloOk>((resolve, reject) => {
      let settled = false;
      // Rejected credentials cannot succeed on retry: stop reconnecting until settings change.
      let credentialsRejected = false;
      let connectRequestId: string | null = null;
      let challengeTimer: ReturnType<typeof setTimeout> | undefined;
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(challengeTimer);
        clearTimeout(handshakeTimer);
        ws.removeListener('message', onMessage);
        return true;
      };
      const abandon = (message: string): void => {
        if (settle()) reject(new Error(message));
      };
      const fail = (message: string): void => {
        abandon(message);
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      };
      const sendHello = (): void => {
        if (connectRequestId !== null) return;
        clearTimeout(challengeTimer);
        connectRequestId = this.allocId();
        const params: ClientHello = this.buildHello();
        const frame: RpcRequestFrame = { type: 'req', id: connectRequestId, method: GatewayRpcMethods.connect, params };
        ws.send(JSON.stringify(frame));
      };
      const onMessage = (data: unknown): void => {
        const frame = parseFrame(data);
        if (frame?.type === 'event') {
          if (frame.event === GatewayEvents.connectChallenge) sendHello();
          return;
        }
        if (!frame || frame.id !== connectRequestId) return;
        if (frame.ok !== true) {
          credentialsRejected = isAuthRejection(frame.error);
          fail(`gateway handshake rejected code=${errorCode(frame.error)}`);
          return;
        }
        if (!isHelloOk(frame.payload)) {
          const type = (frame.payload as { type?: unknown } | null | undefined)?.type;
          fail(`gateway handshake unexpected payload type=${asString(type, 'unknown')}`);
          return;
        }
        if (this.ws !== ws) {
          fail('gateway handshake superseded: retired socket delivered hello-ok');
          return;
        }
        settle();
        this.liveWs = ws;
        resolve(frame.payload);
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
        this.handleSocketClosed(credentialsRejected);
      };
      const handshakeTimer = setTimeout(() => fail('gateway handshake timed out'), HANDSHAKE_TIMEOUT_MS);
      ws.on('open', () => {
        challengeTimer = setTimeout(sendHello, CHALLENGE_FALLBACK_MS);
      });
      ws.on('message', onMessage);
      ws.on('error', onError);
      ws.on('close', onClose);
    });
  }

  /** The current socket closed: subscriptions and RPCs die with it. Runs survive a
   *  reconnect, except when the gateway refused the credentials and none will follow. */
  private handleSocketClosed(credentialsRejected: boolean): void {
    this.liveWs = null;
    this.forgetSubscriptions();
    this.preAckBufferedFrames = [];
    this.rejectAllPending('gateway connection closed');
    if (credentialsRejected) {
      this.logger.warn('gateway rejected the handshake; not reconnecting until the connection settings change');
      this.finishRunSinks(CREDENTIALS_REJECTED_MESSAGE);
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const attempt = this.reconnectAttempt++;
    const delay = Math.min(this.baseDelayMs * 2 ** attempt, this.maxDelayMs);
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
  private closeSocket(reason: string): void {
    const ws = this.ws;
    this.ws = null;
    this.liveWs = null;
    this.forgetSubscriptions();
    this.rejectAllPending(reason);
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
  }

  /** Subscriptions are socket-scoped: a closing socket drops them server-side, so no unsubscribe RPCs follow. */
  private forgetSubscriptions(): void {
    this.subscribedSessions.clear();
    this.pendingSubscribeBySession.clear();
  }

  /** Strip URL userinfo, sensitive query params and the token from a
   *  transport error: `ws` echoes the full URL in messages like "Invalid URL". */
  private redactCredentials(message: string): string {
    const redacted = redactPlainSecrets(message.replace(URL_IN_TEXT, (url) => redactEndpoint(url)));
    return this.token ? redacted.split(this.token).join('***') : redacted;
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

  /* ---------------------------------------------------------------- */
  /* RPC                                                               */
  /* ---------------------------------------------------------------- */

  private allocId(): string {
    return `cc-${this.nextRequestId++}`;
  }

  /** Send an RPC request and resolve with the response payload. */
  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const ws = this.liveWs;
    if (!ws) {
      return Promise.reject(new Error(NOT_CONNECTED_MESSAGE));
    }
    const id = this.allocId();
    const frame: RpcRequestFrame = { type: 'req', id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway rpc timeout method=${method}`));
      }, REQUEST_TIMEOUT_MS);
      const request: PendingRequest = {
        resolve: (payload) => {
          clearTimeout(timer);
          resolve(payload);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.pending.set(id, request);
      try {
        ws.send(JSON.stringify(frame));
      } catch (err) {
        this.pending.delete(id);
        request.reject(new Error(`gateway rpc send failed method=${method} ${this.redactCredentials(errorMessage(err))}`));
      }
    });
  }

  /** Typed convenience wrapper for `sessions.list`. */
  listSessions(params: Record<string, unknown>): Promise<unknown> {
    return this.send(GatewayRpcMethods.sessionsList, params);
  }

  /** Reject and clear every in-flight request (socket closed / disposed). */
  private rejectAllPending(reason: string): void {
    const requests = [...this.pending.values()];
    this.pending.clear();
    for (const request of requests) {
      request.reject(new Error(reason));
    }
  }

  /** Whether hello-ok advertises the given RPC method (unknown-tolerant). */
  private methodAdvertised(method: string): boolean {
    const methods = this.hello?.features?.methods;
    return !Array.isArray(methods) || methods.includes(method);
  }

  /* ---------------------------------------------------------------- */
  /* Session binding, history seeding and resume                       */
  /* ---------------------------------------------------------------- */

  /** Bind the active chat to a session key (agent picker). */
  setActiveSession(sessionKey: string): void {
    this.activeSessionKey = sessionKey;
  }

  /** Session key the next send will target (null → gateway default). */
  getActiveSessionKey(): string | null {
    return this.activeSessionKey;
  }

  /** Whether a run on this session is locally owned (a run sink or a pre-ack send):
   *  runs of the gateway or other clients are invisible here, so abort gates skip them. */
  hasOwnedRun(sessionKey: string): boolean {
    return this.runSinksBySession.has(sessionKey) || this.preAckSends.has(sessionKey);
  }

  /** Snapshot one session's catch-up state before a teardown that may be rolled back
   *  (e.g. an abandoned rebind); null when there is nothing to preserve. */
  captureSessionState(sessionKey: string): SessionCatchUpSnapshot | null {
    const seenMessageIds = this.seenMessageIdsBySession.get(sessionKey);
    const deltaCursor = this.deltaCursorBySession.get(sessionKey);
    const seededCatchUpFingerprints = this.seededCatchUpFingerprints.get(sessionKey);
    if (!seenMessageIds && deltaCursor === undefined && !seededCatchUpFingerprints) {
      return null;
    }
    return {
      seenMessageIds: seenMessageIds && new Set(seenMessageIds),
      deltaCursor,
      seededCatchUpFingerprints: seededCatchUpFingerprints && [...seededCatchUpFingerprints],
    };
  }

  /** Restore a captureSessionState snapshot, so the next subscription replays exactly the rows missed since. */
  restoreSessionState(sessionKey: string, snapshot: SessionCatchUpSnapshot | null): void {
    if (snapshot?.seenMessageIds) {
      this.seenMessageIdsBySession.set(sessionKey, new Set(snapshot.seenMessageIds));
    }
    if (snapshot?.deltaCursor !== undefined) {
      this.deltaCursorBySession.set(sessionKey, snapshot.deltaCursor);
    }
    if (snapshot?.seededCatchUpFingerprints) {
      this.seededCatchUpFingerprints.set(sessionKey, [...snapshot.seededCatchUpFingerprints]);
    }
  }

  /** Thread teardown: stop routing the session to transcript callbacks and forget its catch-up state. */
  clearSessionSink(sessionKey: string): void {
    this.transcriptSinksBySession.delete(sessionKey);
    this.seenMessageIdsBySession.delete(sessionKey);
    this.deltaCursorBySession.delete(sessionKey);
    this.seededCatchUpFingerprints.delete(sessionKey);
    this.releaseSubscription(sessionKey);
  }

  /** Drop one transcript sink; the provider uses it to replace, not duplicate, a callback. */
  removeTranscriptSink(sessionKey: string, onEvent: ChatSink): void {
    const sinks = this.transcriptSinksBySession.get(sessionKey);
    if (!sinks) return;
    sinks.delete(onEvent);
    if (sinks.size === 0) {
      this.transcriptSinksBySession.delete(sessionKey);
      this.releaseSubscription(sessionKey);
    }
  }

  /** Re-register a transcript sink without claiming the active session. */
  rebindTranscriptSink(sessionKey: string, onEvent: ChatSink): void {
    this.addTranscriptSink(sessionKey, onEvent);
    void this.subscribeSessionMessages(sessionKey);
  }

  /**
   * Seed the delta cursor, the catch-up boundary and the seen-set from a
   * `chat.history` payload, so a later catch-up does not replay rendered
   * rows. `rememberSeen: false` is for a snapshot taken mid-run: a complete
   * row in it may be the streaming response, whose live final frame must not
   * be dropped as a duplicate.
   */
  seedHistory(sessionKey: string, payload: unknown, opts?: { rememberSeen?: boolean }): void {
    if (!payload || typeof payload !== 'object') {
      return;
    }
    const { messages, deltaCursor, cursor } = payload as { messages?: unknown; deltaCursor?: unknown; cursor?: unknown };
    const nextCursor = asNonEmptyString(deltaCursor ?? cursor);
    if (nextCursor) {
      this.deltaCursorBySession.set(sessionKey, nextCursor);
    }
    if (!Array.isArray(messages)) {
      return;
    }
    const rows = historyRows(messages);
    this.setCatchUpBoundary(sessionKey, rows);
    if (opts?.rememberSeen === false) {
      return;
    }
    for (const row of rows) {
      const messageId = completeFrameId(row);
      if (messageId) this.rememberSeen(sessionKey, messageId);
    }
  }

  /** Fetch a transcript tail for UI-side history restore; null on transport/RPC failure. */
  async getHistory(sessionKey: string): Promise<unknown> {
    if (!this.methodAdvertised(GatewayRpcMethods.chatHistory)) {
      return null;
    }
    try {
      return await this.send(GatewayRpcMethods.chatHistory, { sessionKey });
    } catch (err) {
      this.logger.warn(`chat.history fetch failed ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Resume a session after a window restart: bind the key, subscribe, and
   * catch up on the rows the UI has not rendered. `historyRendered` means
   * the provider already rendered `chat.history`: without a cursor or seeded
   * boundary the replay would then be pure duplication. Every resume caller
   * schedules its own catch-up, even when it joins an existing subscription;
   * the seen-set and boundary dedupe the repeat.
   */
  resumeSession(sessionKey: string, onEvent: ChatSink, opts?: { historyRendered?: boolean }): void {
    this.activeSessionKey = sessionKey;
    this.addTranscriptSink(sessionKey, onEvent);
    const allowUnscopedCatchUp = !opts?.historyRendered;
    const pending = this.pendingSubscribeBySession.get(sessionKey);
    if (pending) {
      void pending.then((subscribed) => {
        if (subscribed) void this.catchUpHistory(sessionKey, allowUnscopedCatchUp);
      });
      return;
    }
    if (this.subscribedSessions.has(sessionKey)) {
      void this.catchUpHistory(sessionKey, allowUnscopedCatchUp);
      return;
    }
    void this.subscribeSessionMessages(sessionKey, allowUnscopedCatchUp);
  }

  /* ---------------------------------------------------------------- */
  /* Sending                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * ChatService-compatible send: `chat.send` with queue mode `steer` while
   * the session has an active run, `enqueue` otherwise. The run sink is
   * registered at once; a run of another thread on the same session ends
   * with `done`. The transcript subscription and a pre-send history snapshot
   * (the catch-up boundary for this run) complete BEFORE `chat.send`: the
   * gateway may stream the first delta before the acknowledgement, and a
   * send without a recovery boundary could lose its response for good on a
   * reconnect. The acknowledgement may resolve a different session key;
   * `onSessionResolved` then rebinds the owning thread to it.
   */
  sendMessage(
    prompt: string,
    _cwd: string,
    _model: string,
    _chatType: string,
    onEvent: ChatSink,
    onSessionResolved?: (resolvedKey: string, requestedKey: string) => void,
    _onRunComplete?: () => void
  ): void {
    // onRunComplete stays unused: Gateway images travel inline, so no temp files need cleanup.
    const sessionKey = this.activeSessionKey ?? DEFAULT_SESSION_KEY;
    const refusal = this.sendRefusal(sessionKey);
    if (refusal) {
      onEvent({ type: 'error', message: refusal });
      onEvent({ type: 'done' });
      return;
    }
    const previousSink = this.runSinksBySession.get(sessionKey);
    const replacedSend = this.preAckSends.get(sessionKey);
    const send: PendingSend = {
      id: randomUUID(),
      sessionKey,
      sink: onEvent,
      prompt,
      queueMode: previousSink ? 'steer' : 'enqueue',
      onSessionResolved,
      issued: false,
      steersRemoteRun: this.hasRemoteRun(sessionKey),
      continuesIssuedRun: replacedSend !== undefined && this.buffersFrames(replacedSend),
    };
    if (replacedSend) {
      this.retagBufferedFrames(replacedSend.id, send.continuesIssuedRun ? send.id : null);
    }
    this.runSinksBySession.set(sessionKey, onEvent);
    this.preAckSends.set(sessionKey, send);
    if (previousSink && previousSink !== onEvent) {
      this.removeTranscriptSink(sessionKey, previousSink);
      previousSink({ type: 'done' });
    }
    this.addTranscriptSink(sessionKey, onEvent);
    void this.subscribeSessionMessages(sessionKey).then((subscribed) => this.continueAfterSubscribe(send, subscribed));
  }

  /** Why a send must not start now, or null. An abort still in flight would drop the new run's frames. */
  private sendRefusal(sessionKey: string): string | null {
    if (!this.liveWs) {
      return NOT_CONNECTED_MESSAGE;
    }
    if (!this.methodAdvertised(GatewayRpcMethods.sessionsMessagesSubscribe)) {
      return `Gateway does not advertise ${GatewayRpcMethods.sessionsMessagesSubscribe}; transcript streaming is unavailable and sends would complete without output. Update the gateway to a version that supports transcript streaming.`;
    }
    if (this.abortingSessions.has(sessionKey)) {
      return 'The previous run on this session is still aborting; retry in a moment.';
    }
    return null;
  }

  private continueAfterSubscribe(send: PendingSend, subscribed: boolean): void {
    if (!subscribed) {
      this.failPreAckSend(send, this.subscribeAbortedMessage(send.sessionKey));
      return;
    }
    if (this.isAbandoned(send)) {
      this.abandonSend(send);
      return;
    }
    void this.issueSend(send);
  }

  private async issueSend(send: PendingSend): Promise<void> {
    if (!(await this.seedPreSendHistory(send))) {
      return;
    }
    send.issued = true;
    this.send(GatewayRpcMethods.chatSend, { sessionKey: send.sessionKey, text: send.prompt, queueMode: send.queueMode })
      .then((payload) => this.acknowledgeSend(send, payload))
      .catch((err: Error) => this.failPreAckSend(send, err.message));
  }

  /** Seed the recovery boundary before `chat.send`; false when the send must not go out. */
  private async seedPreSendHistory(send: PendingSend): Promise<boolean> {
    const { sessionKey } = send;
    if (!this.methodAdvertised(GatewayRpcMethods.chatHistory) || this.deltaCursorBySession.has(sessionKey)) {
      return true;
    }
    let history: unknown;
    try {
      history = await this.send(GatewayRpcMethods.chatHistory, { sessionKey });
    } catch {
      this.failPreAckSend(send, PRE_SEND_HISTORY_FAILED_MESSAGE);
      return false;
    }
    if (this.isAbandoned(send)) {
      this.abandonSend(send);
      return false;
    }
    this.seedHistory(sessionKey, history);
    if (this.hasCatchUpBoundary(sessionKey)) {
      return true;
    }
    this.failPreAckSend(send, PRE_SEND_NO_BOUNDARY_MESSAGE);
    return false;
  }

  /** Settle a send on its acknowledgement: move the run sink to the resolved key, replay the
   *  frames buffered for it, and follow the run. A resolved key whose run belongs to another
   *  thread is a conflict: taking it over would steal that thread's live response. */
  private acknowledgeSend(send: PendingSend, payload: unknown): void {
    const requestedKey = send.sessionKey;
    if (this.preAckSends.get(requestedKey) !== send) {
      return;
    }
    const key = extractSessionKey(payload) ?? requestedKey;
    const occupant = this.runSinksBySession.get(key);
    if (occupant && occupant !== send.sink) {
      this.failPreAckSend(
        send,
        `Session "${key}" is already streaming in another chat thread. Wait for it to finish or open a different session.`
      );
      return;
    }
    this.preAckSends.delete(requestedKey);
    this.activeSessionKey = key;
    if (key !== requestedKey) {
      this.detachRunSink(requestedKey, send.sink);
    }
    this.runSinksBySession.set(key, send.sink);
    this.addTranscriptSink(key, send.sink);
    this.settleBufferedFrames(send.id, key);
    // A buffered session_end may already have finished the run: nothing is left to follow or rebind.
    if (this.runSinksBySession.get(key) !== send.sink) {
      return;
    }
    this.followAcceptedRun(key);
    if (key !== requestedKey) {
      send.onSessionResolved?.(key, requestedKey);
    }
  }

  /** Subscribe to the accepted run's session and seed its boundary when none exists yet. */
  private followAcceptedRun(sessionKey: string): void {
    void this.subscribeSessionMessages(sessionKey);
    if (!this.methodAdvertised(GatewayRpcMethods.chatHistory) || this.deltaCursorBySession.has(sessionKey)) {
      return;
    }
    this.send(GatewayRpcMethods.chatHistory, { sessionKey })
      .then((history) => {
        this.seedHistory(sessionKey, history, { rememberSeen: false });
        // The run is already accepted, so it cannot be aborted like a pre-send failure.
        if (!this.hasCatchUpBoundary(sessionKey)) {
          this.logger.warn(`post-ack history snapshot for "${sessionKey}" carried no recovery boundary; reconnect catch-up for this run may miss deltas`);
        }
      })
      .catch(() => undefined);
  }

  /** Another path (abort, steer, teardown, subscription failure) took the send's registration or sink. */
  private isAbandoned(send: PendingSend): boolean {
    return this.preAckSends.get(send.sessionKey) !== send || this.runSinksBySession.get(send.sessionKey) !== send.sink;
  }

  /** Retire an abandoned send silently: whoever took it over delivered its terminal. */
  private abandonSend(send: PendingSend): void {
    if (this.preAckSends.get(send.sessionKey) !== send) {
      return;
    }
    this.detachRunSink(send.sessionKey, send.sink);
    this.retirePreAckSend(send);
  }

  /** Retire a send that failed before its acknowledgement and deliver error + done, unless it
   *  was abandoned meanwhile and its terminal already came from elsewhere. */
  private failPreAckSend(send: PendingSend, message: string): void {
    if (this.isAbandoned(send)) {
      this.abandonSend(send);
      return;
    }
    this.detachRunSink(send.sessionKey, send.sink);
    this.retirePreAckSend(send);
    send.sink({ type: 'error', message });
    send.sink({ type: 'done' });
  }

  private retirePreAckSend(send: PendingSend): void {
    this.preAckSends.delete(send.sessionKey);
    this.untagBufferedFrames(send.id);
  }

  private clearPreAckState(): void {
    this.preAckSends.clear();
    this.preAckBufferedFrames = [];
  }

  private subscribeAbortedMessage(sessionKey: string): string {
    return `Transcript subscription for "${sessionKey}" failed; the send was aborted. Retry once the gateway accepts sessions.messages.subscribe.`;
  }

  /* ---------------------------------------------------------------- */
  /* Aborting                                                          */
  /* ---------------------------------------------------------------- */

  /** Whether the gateway already runs something for this session on our behalf. */
  private hasRemoteRun(sessionKey: string): boolean {
    const send = this.preAckSends.get(sessionKey);
    return send ? send.issued || send.steersRemoteRun : this.runSinksBySession.has(sessionKey);
  }

  /**
   * Abort the run of one session (defaults to the active session) and
   * complete its run sink with a single `done`. `chat.abort` goes out only
   * for a run the gateway started: a send still awaiting its pre-send RPCs
   * has none, and a remote abort could cancel another client's run. Only the
   * run sink is retired; other threads' transcript sinks on the session stay.
   */
  abort(sessionKey?: string): void {
    const key = sessionKey ?? this.activeSessionKey;
    if (!key) {
      return;
    }
    const runSink = this.runSinksBySession.get(key);
    const abortRemotely = this.liveWs !== null && this.hasRemoteRun(key);
    const send = this.preAckSends.get(key);
    if (send) {
      this.retirePreAckSend(send);
    }
    if (runSink) {
      this.detachRunSink(key, runSink);
    }
    this.clearSessionDeltaBookkeeping(key);
    if (!abortRemotely) {
      runSink?.({ type: 'done' });
      return;
    }
    this.abortingSessions.add(key);
    this.send(GatewayRpcMethods.chatAbort, { sessionKey: key })
      .catch((err: Error) => {
        this.logger.warn(`chat.abort failed ${err.message}`);
      })
      .finally(() => {
        this.abortingSessions.delete(key);
        runSink?.({ type: 'done' });
      });
  }

  /** Best-effort `chat.abort` for every remote run, sent before the socket closes; no reply arrives. */
  private abortRemoteRuns(): void {
    if (!this.liveWs) {
      return;
    }
    for (const sessionKey of this.runSinksBySession.keys()) {
      if (this.hasRemoteRun(sessionKey)) {
        this.send(GatewayRpcMethods.chatAbort, { sessionKey }).catch(() => undefined);
      }
    }
  }

  /** Complete every run sink (with an error first when given) and drop it from both sink roles. */
  private finishRunSinks(failure?: string): void {
    for (const [sessionKey, sink] of [...this.runSinksBySession]) {
      this.detachRunSink(sessionKey, sink);
      if (failure) sink({ type: 'error', message: failure });
      sink({ type: 'done' });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Sinks and subscriptions                                           */
  /* ---------------------------------------------------------------- */

  private addTranscriptSink(sessionKey: string, onEvent: ChatSink): void {
    const sinks = this.transcriptSinksBySession.get(sessionKey) ?? new Set<ChatSink>();
    sinks.add(onEvent);
    this.transcriptSinksBySession.set(sessionKey, sinks);
  }

  /** Drop a run sink from both sink roles. */
  private detachRunSink(sessionKey: string, sink: ChatSink): void {
    if (this.runSinksBySession.get(sessionKey) === sink) {
      this.runSinksBySession.delete(sessionKey);
    }
    this.removeTranscriptSink(sessionKey, sink);
  }

  /** Complete and drop every sink of one session: none of them will receive further events. */
  private retireTranscriptSinks(sessionKey: string): void {
    const sinks = this.sessionSinks(sessionKey);
    this.runSinksBySession.delete(sessionKey);
    this.transcriptSinksBySession.delete(sessionKey);
    this.releaseSubscription(sessionKey);
    for (const sink of sinks) {
      sink({ type: 'done' });
    }
  }

  /** Every sink of a session, the run sink first. */
  private sessionSinks(sessionKey: string): ChatSink[] {
    const runSink = this.runSinksBySession.get(sessionKey);
    const transcript = [...(this.transcriptSinksBySession.get(sessionKey) ?? [])];
    return runSink ? [runSink, ...transcript.filter((sink) => sink !== runSink)] : transcript;
  }

  private sinkSessionKeys(): Set<string> {
    return new Set([...this.runSinksBySession.keys(), ...this.transcriptSinksBySession.keys()]);
  }

  /** Release a session's socket subscription once its last sink is gone, so closed sessions
   *  do not accumulate server-side subscriptions; the unsubscribe RPC is fire-and-forget. */
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
    this.send(GatewayRpcMethods.sessionsMessagesUnsubscribe, { sessionKeys: [sessionKey] }).catch((err: Error) => {
      this.logger.warn(`sessions.messages.unsubscribe failed ${err.message}`);
    });
  }

  /** Re-issue transcript subscriptions after a reconnect. A live run keeps its cursor-gated
   *  catch-up only: an unscoped tail would replay old rows into the streaming response. */
  private resubscribeSessions(): void {
    for (const sessionKey of this.sinkSessionKeys()) {
      this.logger.info(`gateway re-subscribing session after reconnect ${sessionKey}`);
      void this.subscribeSessionMessages(sessionKey, !this.runSinksBySession.has(sessionKey));
    }
  }

  /**
   * Subscribe to transcript events for a session and catch up once
   * subscribed. Concurrent callers share one in-flight RPC: duplicates could
   * complete in either order and the loser's failure would tear down the
   * surviving stream. A stale rejection (the socket dropped and cleared the
   * slot) changes nothing; a current one ends the session's run, which can
   * no longer be observed, while resume sinks stay for the next reconnect.
   */
  private subscribeSessionMessages(sessionKey: string, allowUnscopedCatchUp = false): Promise<boolean> {
    const pending = this.pendingSubscribeBySession.get(sessionKey);
    if (pending) {
      return pending;
    }
    if (this.subscribedSessions.has(sessionKey)) {
      return Promise.resolve(true);
    }
    if (!this.methodAdvertised(GatewayRpcMethods.sessionsMessagesSubscribe)) {
      this.logger.warn(`gateway does not advertise ${GatewayRpcMethods.sessionsMessagesSubscribe}; streaming unavailable`);
      this.retireTranscriptSinks(sessionKey);
      return Promise.resolve(false);
    }
    const attempt: Promise<boolean> = this.send(GatewayRpcMethods.sessionsMessagesSubscribe, { sessionKeys: [sessionKey] })
      .then(() => {
        this.subscribedSessions.add(sessionKey);
        // Every sink may have left while the RPC was in flight.
        this.releaseSubscription(sessionKey);
        if (this.subscribedSessions.has(sessionKey)) {
          void this.catchUpHistory(sessionKey, allowUnscopedCatchUp);
        }
        return true;
      })
      .catch((err: Error) => {
        this.logger.warn(`sessions.messages.subscribe failed ${err.message}`);
        if (this.pendingSubscribeBySession.get(sessionKey) === attempt) {
          this.failUnobservableRun(sessionKey, err);
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

  /** End a session's run whose subscription failed with error + done. */
  private failUnobservableRun(sessionKey: string, err: Error): void {
    const runSink = this.runSinksBySession.get(sessionKey);
    if (!runSink) {
      return;
    }
    const unsent = this.preAckSends.get(sessionKey)?.issued === false;
    this.detachRunSink(sessionKey, runSink);
    runSink({
      type: 'error',
      message: unsent
        ? this.subscribeAbortedMessage(sessionKey)
        : `Transcript subscription for "${sessionKey}" failed: ${err.message}. The response may not appear in this thread.`,
    });
    runSink({ type: 'done' });
  }

  /* ---------------------------------------------------------------- */
  /* Inbound frames                                                    */
  /* ---------------------------------------------------------------- */

  private handleMessage(data: unknown): void {
    const frame = parseFrame(data);
    if (!frame) return;
    if (frame.type === 'res') {
      this.settleRequest(frame);
      return;
    }
    if (frame.event === GatewayEvents.sessionMessage) {
      this.routeSessionMessage(frame);
    } else if (frame.event === GatewayEvents.sessionEnd) {
      this.routeSessionEnd(frame);
    }
  }

  private settleRequest(res: RpcResponseFrame): void {
    const request = this.pending.get(res.id);
    if (!request) return;
    this.pending.delete(res.id);
    if (res.ok === true) {
      request.resolve(res.payload);
    } else {
      request.reject(new Error(`gateway rpc error code=${errorCode(res.error)}`));
    }
  }

  /**
   * Route a `session.message` to its session's sinks. Frames of an aborting
   * session are dropped. Frames that may belong to an issued, unacknowledged
   * send are buffered until its ack reveals the resolved session. Keyless
   * frames route only when exactly one session has sinks; unroutable frames
   * are dropped, never guessed.
   */
  private routeSessionMessage(evt: SessionEvent): void {
    const payload = payloadFields(evt);
    const routed = this.sinkForSession(payload.sessionKey);
    const key = routed?.key ?? asNonEmptyString(payload.sessionKey);
    if (key && this.abortingSessions.has(key)) {
      const messageId = completeFrameId(payload);
      if (messageId) this.rememberSeen(key, messageId);
      return;
    }
    if (!routed) {
      if (key) this.bufferForIssuedSends(evt, key);
      return;
    }
    const send = this.preAckSends.get(routed.key);
    if (send && this.buffersFrames(send)) {
      this.bufferPreAckFrame({ evt, key: routed.key, sends: new Set([send.id]) });
      return;
    }
    this.deliverSessionMessage(evt, routed.key, this.sinksExcludingUnsentRun(routed));
  }

  /**
   * Route a `session_end`. An end for an issued, unacknowledged send (or for
   * a sinkless key that may be its resolved key) is buffered for its ack. An
   * end arriving before a send issued `chat.send` belongs to a previous run:
   * only the observers complete. Keyless ends resolve to the single active
   * run or the single observed session, and are dropped when ambiguous.
   */
  private routeSessionEnd(evt: SessionEvent): void {
    const key = this.resolveSessionEndKey(payloadFields(evt).sessionKey);
    if (!key || this.abortingSessions.has(key)) {
      return;
    }
    const send = this.preAckSends.get(key);
    if (send && this.buffersFrames(send)) {
      this.bufferPreAckFrame({ evt, key, sends: new Set([send.id]) });
      return;
    }
    if (send) {
      this.finalizeSessionObservers(key);
      return;
    }
    if (this.sessionSinks(key).length === 0 && this.bufferForIssuedSends(evt, key)) {
      return;
    }
    this.finalizeSessionEnd(key);
  }

  private resolveSessionEndKey(sessionKey: unknown): string | null {
    if (!isKeyless(sessionKey)) {
      return asNonEmptyString(sessionKey);
    }
    const runKeys = [...this.runSinksBySession.keys()];
    return runKeys.length === 1 ? runKeys[0] : this.soleSessionKey();
  }

  /** Sinks for a frame's session key; a missing key falls back to the only observed session. */
  private sinkForSession(sessionKey: unknown): { key: string; sinks: ChatSink[] } | null {
    const key = isKeyless(sessionKey) ? this.soleSessionKey() : asNonEmptyString(sessionKey);
    if (!key) return null;
    const sinks = this.sessionSinks(key);
    return sinks.length > 0 ? { key, sinks } : null;
  }

  private soleSessionKey(): string | null {
    const keys = [...this.sinkSessionKeys()];
    return keys.length === 1 ? keys[0] : null;
  }

  /** A send that has not issued `chat.send` owns no frame: an earlier run's output reaches observers only. */
  private sinksExcludingUnsentRun(routed: { key: string; sinks: ChatSink[] }): ChatSink[] {
    const send = this.preAckSends.get(routed.key);
    return send ? routed.sinks.filter((sink) => sink !== send.sink) : routed.sinks;
  }

  /** Complete a session's observers without touching the run sink of a send that has not started. */
  private finalizeSessionObservers(sessionKey: string): void {
    const runSink = this.runSinksBySession.get(sessionKey);
    this.clearSessionDeltaBookkeeping(sessionKey);
    for (const sink of this.sessionSinks(sessionKey)) {
      if (sink !== runSink) sink({ type: 'done' });
    }
  }

  /** Finish a session's run on `session_end`: every sink gets `done`, the run sink is retired,
   *  and resume-only sinks stay subscribed. */
  private finalizeSessionEnd(sessionKey: string): void {
    const sinks = this.sessionSinks(sessionKey);
    const runSink = this.runSinksBySession.get(sessionKey);
    if (runSink) {
      this.detachRunSink(sessionKey, runSink);
    }
    this.clearSessionDeltaBookkeeping(sessionKey);
    for (const sink of sinks) {
      sink({ type: 'done' });
    }
  }

  /** Map, dedupe and fan out one session.message to the given sinks. */
  private deliverSessionMessage(evt: SessionEvent, sessionKey: string, sinks: ChatSink[]): void {
    const events = mapSessionEventToChatEvent(evt);
    if (events.length === 0) {
      return;
    }
    for (const chatEvent of this.dedupeFrameEvents(sessionKey, payloadFields(evt), events)) {
      for (const sink of sinks) {
        sink(chatEvent);
      }
    }
  }

  /** A complete frame whose id was already delivered (e.g. replayed around a reconnect) keeps
   *  only its non-text facets: tool status and usage updates must still land. */
  private dedupeFrameEvents(sessionKey: string, payload: MessageFields, events: ChatEvent[]): ChatEvent[] {
    const messageId = completeFrameId(payload);
    if (messageId && this.hasSeen(sessionKey, messageId)) {
      return events.filter((e) => e.type !== 'text');
    }
    if (messageId) {
      this.rememberSeen(sessionKey, messageId);
    }
    return this.adjustCompleteFrameEvents(sessionKey, payload, events);
  }

  /* ---------------------------------------------------------------- */
  /* Pre-ack buffering                                                 */
  /* ---------------------------------------------------------------- */

  /** Frames may already stream for this send's run: its own `chat.send`, or the issued send it replaced. */
  private buffersFrames(send: PendingSend): boolean {
    return send.issued || send.continuesIssuedRun;
  }

  private issuedSendIds(): Set<string> {
    return new Set([...this.preAckSends.values()].filter((send) => this.buffersFrames(send)).map((send) => send.id));
  }

  /** Buffer a frame for a sinkless session that may be the resolved key of any issued send. */
  private bufferForIssuedSends(evt: SessionEvent, key: string): boolean {
    const sends = this.issuedSendIds();
    if (sends.size === 0) {
      return false;
    }
    this.bufferPreAckFrame({ evt, key, sends });
    return true;
  }

  private bufferPreAckFrame(frame: BufferedFrame): void {
    this.preAckBufferedFrames.push(frame);
    if (this.preAckBufferedFrames.length > PRE_ACK_BUFFER_LIMIT) {
      this.preAckBufferedFrames.shift();
    }
  }

  /** Forget a send that will never be acknowledged; frames no other send may own are dropped. */
  private untagBufferedFrames(sendId: string): void {
    this.retagBufferedFrames(sendId, null);
  }

  /** Hand a replaced send's frames to its successor, or drop its claim when there is none. */
  private retagBufferedFrames(sendId: string, successorId: string | null): void {
    this.preAckBufferedFrames = this.preAckBufferedFrames.filter((frame) => {
      if (!frame.sends.delete(sendId)) return true;
      if (successorId) frame.sends.add(successorId);
      return frame.sends.size > 0;
    });
  }

  /** Replay the frames an acknowledged send owns, in arrival order: those buffered for it under
   *  its resolved key. Its other frames belonged to other sessions and lose its tag. */
  private settleBufferedFrames(sendId: string, resolvedKey: string): void {
    const claimed: BufferedFrame[] = [];
    this.preAckBufferedFrames = this.preAckBufferedFrames.filter((frame) => {
      if (!frame.sends.delete(sendId)) return true;
      if (frame.key === resolvedKey) claimed.push(frame);
      return frame.key !== resolvedKey && frame.sends.size > 0;
    });
    for (const frame of claimed) {
      this.replayBufferedFrame(frame);
    }
  }

  private replayBufferedFrame(frame: BufferedFrame): void {
    if (frame.evt.event === GatewayEvents.sessionEnd) {
      this.finalizeSessionEnd(frame.key);
      return;
    }
    const routed = this.sinkForSession(frame.key);
    if (routed) {
      this.deliverSessionMessage(frame.evt, frame.key, this.sinksExcludingUnsentRun(routed));
    }
  }

  /* ---------------------------------------------------------------- */
  /* Dedupe bookkeeping                                                */
  /* ---------------------------------------------------------------- */

  private hasSeen(sessionKey: string, messageId: string): boolean {
    return this.seenMessageIdsBySession.get(sessionKey)?.has(messageId) ?? false;
  }

  /** Remember a complete message for one session (oldest evicted at the cap). A repeat must
   *  not evict: churn would let old history rows replay after a reconnect. */
  private rememberSeen(sessionKey: string, messageId: string): void {
    const seen = this.seenMessageIdsBySession.get(sessionKey) ?? new Set<string>();
    this.seenMessageIdsBySession.set(sessionKey, seen);
    if (seen.has(messageId)) {
      return;
    }
    if (seen.size >= SEEN_MESSAGE_LIMIT) {
      const [oldest] = seen;
      seen.delete(oldest);
    }
    seen.add(messageId);
  }

  private hasCatchUpBoundary(sessionKey: string): boolean {
    return this.deltaCursorBySession.has(sessionKey) || this.seededCatchUpFingerprints.has(sessionKey);
  }

  /** Store the fingerprints of rendered rows, latest first to go. A still-streaming delta-only
   *  row is left out: a later cursor-less catch-up must replay its finalized form. */
  private setCatchUpBoundary(sessionKey: string, rows: HistoryRow[]): void {
    const fingerprints = rows.filter((row) => !isDeltaOnlyRow(row)).map(rowFingerprint);
    this.seededCatchUpFingerprints.set(sessionKey, fingerprints.slice(-SEEDED_FINGERPRINT_LIMIT));
  }

  private messageKey(sessionKey: string, messageId: string): string {
    return sessionKey + '\u0000' + messageId;
  }

  /**
   * A frame's full `text` must not re-emit what its message already
   * streamed as deltas (`he` + `hello` would render `hehello`): when the
   * full text extends the rendered prefix only the remainder is emitted; a
   * diverging full text is kept intact (a duplicated tail beats lost
   * content). The prefix counts only what the mapper renders: without a
   * messageId a frame carrying full text renders that text alone, so its
   * delta stays invisible. A delta-free full text completes the message.
   */
  private adjustCompleteFrameEvents(sessionKey: string, payload: MessageFields, events: ChatEvent[]): ChatEvent[] {
    if (!events.some((e) => e.type === 'text')) {
      return events;
    }
    const messageId = asNonEmptyString(payload.messageId);
    const delta = asString(payload.delta, '');
    const fullText = asString(payload.text, '');
    const key = messageId ? this.messageKey(sessionKey, messageId) : sessionKey;
    const store = messageId ? this.deltaTextByMessage : this.deltaTextNoIdBySession;
    const renderedDelta = messageId || !fullText ? delta : '';
    const prefix = (store.get(key) ?? '') + renderedDelta;
    if (!fullText) {
      this.touchDeltaRecord(store, key, prefix);
      return events;
    }
    const extendsPrefix = fullText.startsWith(prefix);
    if (!delta) {
      store.delete(key);
    } else if (extendsPrefix) {
      this.touchDeltaRecord(store, key, fullText);
    } else if (renderedDelta) {
      // A diverging mixed frame keeps the delta prefix, so the later completion still renders.
      this.touchDeltaRecord(store, key, prefix);
    }
    if (!prefix || !extendsPrefix) {
      return events;
    }
    // The mapper emits the full text as the frame's last text event.
    const fullTextIndex = events.map((e) => e.type).lastIndexOf('text');
    const remainder = fullText.slice(prefix.length);
    return events.flatMap((e, i) => {
      if (i !== fullTextIndex) return [e];
      return remainder ? [{ type: 'text' as const, text: remainder }] : [];
    });
  }

  /** Least-recently-updated eviction: an actively streaming message is re-inserted
   *  on every update so it outlives idle records past the cap. */
  private touchDeltaRecord(store: Map<string, string>, key: string, text: string): void {
    store.delete(key);
    store.set(key, text);
    if (store.size > DELTA_TRACK_LIMIT) {
      const [stalest] = store.keys();
      store.delete(stalest);
    }
  }

  /** A finished or torn-down run leaves no delta record that would make the next run
   *  treat its first cumulative frame as already streamed. */
  private clearSessionDeltaBookkeeping(sessionKey: string): void {
    this.deltaTextNoIdBySession.delete(sessionKey);
    const prefix = sessionKey + '\u0000';
    for (const key of [...this.deltaTextByMessage.keys()]) {
      if (key.startsWith(prefix)) {
        this.deltaTextByMessage.delete(key);
      }
    }
  }

  private clearDeltaBookkeeping(): void {
    this.deltaTextByMessage.clear();
    this.deltaTextNoIdBySession.clear();
  }

  /* ---------------------------------------------------------------- */
  /* History catch-up                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Replay the transcript rows a session's sinks missed (e.g. while the
   * socket was down): the tail after the stored delta cursor, or — without
   * one — the tail minus the rows the seeded fingerprint boundary already
   * covers. Without a cursor, a boundary or `allowUnscopedCatchUp` the
   * replay would be pure duplication, so it is skipped.
   *
   * Observers receive every unrendered row and a `done` per final assistant
   * row. The run sink present when the catch-up started receives the rows
   * too (delta-only chunks excepted: they cannot be deduped against chunks
   * the live stream delivered) and, when the tail ends on a final assistant
   * row, its single `done`: the run finished server-side. A run sink that is
   * still pre-ack or registered during the RPC receives nothing, since its
   * own response is still in flight.
   */
  private async catchUpHistory(sessionKey: string, allowUnscopedCatchUp: boolean): Promise<void> {
    if (!this.methodAdvertised(GatewayRpcMethods.chatHistory)) {
      return;
    }
    const requestCursor = this.deltaCursorBySession.get(sessionKey);
    if (requestCursor === undefined && !allowUnscopedCatchUp && !this.seededCatchUpFingerprints.has(sessionKey)) {
      return;
    }
    const startRunSink = this.runSinksBySession.get(sessionKey);
    try {
      const payload = await this.send(GatewayRpcMethods.chatHistory, { sessionKey, deltaCursor: requestCursor });
      const { messages, deltaCursor, cursor } = (payload ?? {}) as { messages?: unknown; deltaCursor?: unknown; cursor?: unknown };
      if (!Array.isArray(messages)) {
        return;
      }
      const nextCursor = asNonEmptyString(deltaCursor ?? cursor);
      if (nextCursor) {
        this.deltaCursorBySession.set(sessionKey, nextCursor);
      }
      const rows = historyRows(messages);
      // With a cursor the gateway already cut the payload: a boundary match there could swallow a fresh identical row.
      const seeded = requestCursor === undefined && !nextCursor ? this.seededCatchUpFingerprints.get(sessionKey) : undefined;
      this.replayRows(sessionKey, rows, seeded ? boundaryOverlap(seeded, rows) : 0, startRunSink);
      this.setCatchUpBoundary(sessionKey, rows);
    } catch (err) {
      this.logger.warn(`chat.history catch-up failed ${(err as Error).message}`);
    }
  }

  private replayRows(sessionKey: string, rows: HistoryRow[], boundarySkip: number, startRunSink: ChatSink | undefined): void {
    const replayRunSink = (): ChatSink | undefined => {
      const runSink = this.runSinksBySession.get(sessionKey);
      return runSink && runSink === startRunSink && !this.preAckSends.has(sessionKey) ? runSink : undefined;
    };
    const observers = (): ChatSink[] =>
      this.sessionSinks(sessionKey).filter(
        (sink) => sink !== startRunSink && sink !== this.runSinksBySession.get(sessionKey)
      );
    const replayedIds = new Set<string>();
    const lastIndex = rows.length - 1;
    rows.forEach((row, index) => {
      const messageId = asNonEmptyString(row.messageId);
      const final = isFinalAssistantRow(row);
      const seen = messageId !== null && (this.hasSeen(sessionKey, messageId) || replayedIds.has(messageId));
      if (index < boundarySkip || seen) {
        if (index === lastIndex && final) {
          this.recoverRenderedTail(sessionKey, row, seen, observers(), replayRunSink());
        } else if (final && (seen || this.runSinksBySession.has(sessionKey))) {
          // An observer may still stream this row if its live session_end was missed.
          for (const sink of observers()) sink({ type: 'done' });
        }
        return;
      }
      if (messageId && final) {
        replayedIds.add(messageId);
        // A local run's live final frame must still claim its own response.
        if (!this.hasOwnedRun(sessionKey)) this.rememberSeen(sessionKey, messageId);
      }
      const events = this.adjustCompleteFrameEvents(sessionKey, row, this.mapHistoryRow(row));
      const runSink = isDeltaOnlyRow(row) ? undefined : replayRunSink();
      const sinks = runSink ? [...observers(), runSink] : observers();
      for (const chatEvent of events) {
        for (const sink of sinks) sink(chatEvent);
      }
      if (final) {
        for (const sink of observers()) sink({ type: 'done' });
      }
    });
    const tail = rows[lastIndex];
    const runSink = replayRunSink();
    if (tail && isFinalAssistantRow(tail) && runSink) {
      this.completeReplayedRun(sessionKey, runSink, tail);
    }
  }

  /**
   * The tail row was rendered already (seen, or covered by the boundary),
   * yet the stream may have dropped before its `session_end`: finalize the
   * observers. A boundary row never entered the seen-set when it was seeded
   * mid-run, so while a run is registered its text may never have rendered
   * and the unrendered remainder is delivered first.
   */
  private recoverRenderedTail(
    sessionKey: string,
    row: HistoryRow,
    seen: boolean,
    observers: ChatSink[],
    runSink: ChatSink | undefined
  ): void {
    const recoverText = !seen && this.runSinksBySession.has(sessionKey);
    if (!seen && !recoverText) {
      return;
    }
    if (recoverText) {
      const sinks = runSink ? [...observers, runSink] : observers;
      for (const chatEvent of this.adjustCompleteFrameEvents(sessionKey, row, this.mapHistoryRow(row))) {
        for (const sink of sinks) sink(chatEvent);
      }
    }
    for (const sink of observers) sink({ type: 'done' });
  }

  /** The replayed tail finished the run that was streaming when the catch-up started. */
  private completeReplayedRun(sessionKey: string, runSink: ChatSink, tail: HistoryRow): void {
    this.detachRunSink(sessionKey, runSink);
    this.clearSessionDeltaBookkeeping(sessionKey);
    const messageId = asNonEmptyString(tail.messageId);
    // A late re-emission of the finished row must be filtered, not re-rendered.
    if (messageId) this.rememberSeen(sessionKey, messageId);
    runSink({ type: 'done' });
  }

  private mapHistoryRow(row: HistoryRow): ChatEvent[] {
    return mapSessionEventToChatEvent({ event: GatewayEvents.sessionMessage, payload: row });
  }
}
