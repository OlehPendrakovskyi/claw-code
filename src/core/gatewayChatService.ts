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
import { redactText, redactTextAndSecret } from './accessInfo/redact';
import type { ClientHello, GatewayProtocolAdapter, WireRequest } from './gatewayProtocol/adapter';
import type { DeviceCredentialStore, DeviceIdentity, StoredDeviceToken } from './gatewayProtocol/deviceIdentity';
import type { WebSocketFactory, WebSocketLike } from './wsSocket';
import { loadWsCtor } from './wsSocket';
import { proveDevice } from './gatewayProtocol/deviceIdentity';
import type {
  ApprovalDecision,
  ApprovalWait,
  ConnectionAccepted,
  ConnectionLimits,
  DeviceProof,
  HandshakeRejection,
  HistoryRead,
  HistorySnapshot,
  InboundEvent,
  InboundFrame,
  OperatorPrompt,
  PairingRequest,
  PromptAccess,
  PromptOutcome,
  QuestionAnswers,
  RpcFailure,
  SendAttachment,
  SessionSummary,
  TokenUsage,
  TranscriptMessage,
} from './gatewayProtocol/model';
import { GatewayConnectError } from './gatewayProtocol/model';
import type { ProtocolRange, ProtocolSetting } from './gatewayProtocol/registry';
import { handshakeAdapter, isAdapter, negotiatedAdapter, resolveProtocolSetting } from './gatewayProtocol/registry';
import { applyAborted, applyDelta, applyFinal, applySettled, BoundedSet, newRunText } from './gatewayRunText';
import type { RunText, TextUpdate } from './gatewayRunText';
import { OperatorPromptBoard, promptKey } from './operatorPrompts';
import type { PromptListener } from './operatorPrompts';
import { TruncatedRowCompleter } from './truncatedRows';
import { errorMessage } from './errors';
import { withTimeout, withTimeoutNull } from './async';
import { capText } from './text';
import { GATEWAY_MESSAGE_LIMIT, HISTORY_READ_TIMEOUT_MS, CLIENT_VERSION } from './constants';
import { isImageMime } from './media';
import { PROMPT_WITHDRAWN } from './gatewayProtocol/model';

/** The session a thread targets until it opens another one; the gateway resolves the alias. */
export const DEFAULT_SESSION_KEY = 'main';

/** Minimal logger seam; default is a silent no-op. */
export type Logger = {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
};

export type { WebSocketLike, WebSocketFactory } from './wsSocket';

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
  /** This client's device identity and the tokens gateways issued it; without it the client connects as no device. */
  deviceCredentials?: DeviceCredentialStore;
  /** Whether a stored device token may be offered to `url` after it refused the shared token (loopback only). */
  trustsDeviceTokenRetry?: (url: string) => boolean;
};

/** A pairing approval the client waits for: pending (and retried), approved, or given up on. */
export type PairingState =
  | { status: 'pending'; request: PairingRequest; hint: string }
  | { status: 'approved' }
  | { status: 'expired'; request: PairingRequest; hint: string };

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
  /** The key the gateway resolved the send's session to. */
  canonicalKey: string;
  /** `unconfirmed`: the send went out but its answer was lost; it is re-sent under the same run id. */
  stage: 'preparing' | 'issued' | 'unconfirmed' | 'accepted';
  send: GatewaySend;
  /** `chat.send` attempts so far; the idempotency key makes a repeat safe. */
  attempts: number;
  /** Its own run plus the live runs of the session it may have steered into; done once all ended. */
  followed: Set<string>;
};

type RunEvent = Extract<InboundEvent, { runId: string }>;

type ChallengeEvent = Extract<InboundEvent, { kind: 'challenge' }>;

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
  liveRuns: Map<string, LiveRun>;
  finishedRuns: BoundedSet<string>;
  /** Runs rendered from `chat` events, whose transcript rows must not render again. */
  streamedRuns: BoundedSet<string>;
  /** Events of an issued, unacknowledged send's session whose run is not known yet. */
  unclaimed: RunEvent[];
  catchUp: Promise<void> | null;
  catchUpAgain: boolean;
  aborting: boolean;
  /** Tool updates already shown, as `agent` and `session.tool` may both carry one. */
  toolUpdates: BoundedSet<string>;
  /** Transcript rows held back while a cut row among them is read in full; later rows queue behind. */
  rowsInFlight: Promise<void> | null;
};

/** `deviceId`: the identity the handshake proved, or null for a device-less connection. */
type Connection = { adapter: GatewayProtocolAdapter; accepted: ConnectionAccepted; deviceId: string | null };

/** The identity one handshake proves, and the token its gateway issued it before. */
type DeviceAuth = { identity: DeviceIdentity; storedToken: StoredDeviceToken | null };

/** What one handshake presented, for judging how its rejection may be retried. */
/** `url` and `gateway` (its origin) are fixed when the attempt opens, so a late answer cannot act on newer settings. */
type HandshakeAttempt = { url: string; gateway: string; device: DeviceAuth | null; sentDeviceToken: boolean };

/** Where a local run started: that connection, and the device it proved (null without one). */
type RunOrigin = { connection: number; deviceId: string | null };

/** The pairing approval being waited for, since the first rejection asked for it. */
type PairingWait = { sinceMs: number; expired: boolean };

/** A cancel made while disconnected: the device that started its runs may stop them after the next handshake. */
type QueuedAbort = {
  state: SessionState;
  runIds: string[];
  deviceId: string;
  sink: ChatSink;
  /** Some of the cancelled runs could not be stopped anyway. */
  runContinues: boolean;
  /** Times its abort already went out and was lost with the socket. */
  resends: number;
  timer: ReturnType<typeof setTimeout>;
};

/** `lost`: the socket closed before the gateway answered. */
type AbortOutcome = 'stopped' | 'refused' | 'lost';

/** A run seen streaming, and the connection it was last heard on. */
/** `streamedLive`: text came from `chat` deltas, which the gateway may never keep (a transcript row is kept text). */
type LiveRun = RunText & { heardOn: number | null; streamedLive: boolean };

/** What a catch-up read started from. */
type CatchUpBaseline = { lastSeq: number; runs: ReadonlyMap<string, number> };

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

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

const NOT_CONNECTED_MESSAGE =
  'Gateway is not connected. Run "OpenClaw: Connect to Gateway" to configure a token, or check openclaw.gateway.url.';
const RUN_FAILED_MESSAGE = 'The gateway reported that the run failed.';
const RUN_CONTINUES_NOTICE =
  'Could not stop the run: the gateway lets only the connection or the device identity that started it stop it, and neither is connected now. It continues on the gateway.';
/** `chat.send` attempts before an unanswered send is given up. */
const MAX_SEND_ATTEMPTS = 3;
/** Bounds on paging: `sessions.list` pages of 100, and history pages before the latest. */
const MAX_SESSION_PAGES = 10;
const MAX_OLDER_HISTORY_PAGES = 4;
const SEND_RETRY_DELAY_MS = 1000;
/** Longest a handshake waits for SecretStorage before connecting without a device identity. */
const DEVICE_LOAD_TIMEOUT_MS = 5000;

/** Longest a final without a message waits for the transcript to say what the reply was. */
const SETTLE_FROM_HISTORY_TIMEOUT_MS = HISTORY_READ_TIMEOUT_MS;
/** A pending approval is retried at this pace; every attempt keeps the gateway's request alive. */
const PAIRING_RETRY_DELAY_MS = 5000;
/** How long an unanswered pairing request is retried before the client stops and says so. */
const PAIRING_WAIT_LIMIT_MS = 15 * 60_000;
/** How long a cancel made while disconnected waits for the next handshake. */
const QUEUED_ABORT_LIMIT_MS = 120_000;
/** How often an abort lost with its socket is held for the next handshake again. */
const MAX_ABORT_RESENDS = 2;
/** The official client's reset backoff before its one retry with a stored device token. */
const DEVICE_TOKEN_RETRY_DELAY_MS = 250;
const SEND_UNCONFIRMED_MESSAGE =
  'The gateway did not confirm the send before the connection dropped or timed out; the message may still run — reopen the session to check.';

const PROMPT_KINDS: readonly OperatorPrompt['kind'][] = ['approval', 'question'];
const NO_PROMPT_ACCESS: PromptAccess = { approvals: false, questions: false };
const PROMPT_GONE_MESSAGE = 'This request is no longer pending, or does not offer that answer.';
const APPROVAL_ELSEWHERE_NOTICE =
  'This run is waiting for approval in OpenClaw. Approve it in the OpenClaw Control UI; to approve here, this client needs a paired device identity with the operator.approvals scope.';
const APPROVAL_UNAVAILABLE_NOTICE =
  'A command in this run needed approval, but no approval client could see the request, so it did not run. Approving here needs a paired device identity with the operator.approvals scope.';

/** A request the client refused to send because its frame exceeds the gateway's payload limit. */
class FrameTooLargeError extends Error {}

/** A request that never reached the gateway. */
class RequestNotSentError extends Error {}

/** An operator prompt answer whose reply was lost (drop, timeout): the gateway may still have applied it. */
export class PromptAnswerUnconfirmedError extends Error {}

function neverSent(err: unknown): boolean {
  return err instanceof FrameTooLargeError || err instanceof RequestNotSentError;
}

/** The gateway answered a request with an error. */
class RpcRejectedError extends Error {
  constructor(
    message: string,
    readonly failure: RpcFailure
  ) {
    super(message);
  }
}

/** A token large enough to push `connect` past the pre-auth limit would be dropped by the gateway. */
function oversizedConnectRejection(limitBytes: number): HandshakeRejection {
  return {
    kind: 'permanent',
    code: 'CONNECT_FRAME_TOO_LARGE',
    message: `connect frame exceeds the ${Math.round(limitBytes / 1024)} KiB pre-auth limit`,
    hint: 'The configured gateway token is too large — run "OpenClaw: Connect to Gateway" to update it.',
  };
}

/** Open a socket through the real `ws`, loading the package on first use. */
function defaultWsFactory(url: string): WebSocketLike {
  return new (loadWsCtor())(url);
}



/** Run `use` on a value now, or once its promise resolves. */
function whenReady<T>(value: T | Promise<T>, use: (ready: T) => void): void {
  if (value instanceof Promise) void value.then(use);
  else use(value);
}



/** Device tokens are kept per gateway origin, so one gateway's token never reaches another. */
function gatewayKey(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
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

/** Appends go out as `text`; a replacement supersedes what the run showed. */
function updateEvent(update: TextUpdate): ChatEvent[] {
  return update.kind === 'replace' ? [{ type: 'textReplace', text: update.text }] : textEvent(update.text);
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
    toolUpdates: new BoundedSet(RUN_HISTORY_LIMIT),
    rowsInFlight: null,
  };
}

function highestSeq(messages: readonly TranscriptMessage[], floor: number): number {
  return messages.reduce((max, message) => Math.max(max, message.seq ?? 0), floor);
}

/** The last assistant row each run left in a transcript read. */
function finalRowByRun(messages: readonly TranscriptMessage[]): Map<string, TranscriptMessage> {
  const rows = new Map<string, TranscriptMessage>();
  for (const message of messages) {
    if (message.role === 'assistant' && message.runId && message.text) rows.set(message.runId, message);
  }
  return rows;
}

/** Appended where the gateway cut a row it showed only in part. */
const TRUNCATED_SUFFIX = '…';

/** The update a transcript row makes to its run's text. A cut row is only the start of the
 *  reply, so it may extend what streamed but never replaces it; a whole row may. */
function applyRow(run: RunText, row: TranscriptMessage | undefined): TextUpdate {
  if (!row) return applyFinal(run, null);
  return row.truncated ? applyAborted(run, row.text) : applyFinal(run, row.text);
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
  private readonly deviceCredentials: DeviceCredentialStore | null;
  private readonly trustsDeviceTokenRetry: (url: string) => boolean;

  /** Socket of the current attempt, handshaking or live. */
  private ws: WebSocketLike | null = null;
  /** The socket once its handshake completed; null while disconnected. */
  private liveWs: WebSocketLike | null = null;
  private connection: Connection | null = null;
  /** Handshakes completed so far; tells runs heard on the current socket from older ones. */
  private connectionCount = 0;
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
  /** Runs this client started → where they started: only that connection or device may stop them. */
  private readonly localRuns = new Map<string, RunOrigin>();
  /** The one retry with a stored device token a refused shared token allows, until a handshake succeeds. */
  private deviceTokenRetry: 'unused' | 'pending' | 'spent' = 'unused';
  private pairingWait: PairingWait | null = null;
  /** The identity the latest handshake proved; a queued abort waits for it to connect again. */
  private lastDeviceId: string | null = null;
  private readonly queuedAborts = new Set<QueuedAbort>();
  private readonly pairingListeners = new Set<(state: PairingState) => void>();
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly sessionsChangedListeners = new Set<(sessionKey: string | null) => void>();
  /** Approvals and questions waiting for an operator, across reconnects. */
  private readonly prompts = new OperatorPromptBoard({ onOverflow: () => this.warnPromptOverflow() });
  private promptOverflowWarned = false;
  private readonly rowCompleter = new TruncatedRowCompleter((sessionKey, entryId) => this.readEntry(sessionKey, entryId));

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
    this.deviceCredentials = deps.deviceCredentials ?? null;
    this.trustsDeviceTokenRetry = deps.trustsDeviceTokenRetry ?? (() => false);
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

  /** Observe pairing approvals this client waits for; returns the unsubscribe. */
  onPairingChange(listener: (state: PairingState) => void): () => void {
    this.pairingListeners.add(listener);
    return () => this.pairingListeners.delete(listener);
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
    this.forgetDeviceAuthState();
    this.connectGeneration += 1;
    this.connectPromise = null;
    this.abortRemoteRuns();
    this.clearRetryTimers();
    this.retireAllSinks();
    this.sessions.clear();
    this.aliases.clear();
    this.releaseEndpointState();
    if (!this.ws) {
      return;
    }
    this.closeSocket('gateway connection settings changed');
    this.scheduleReconnect();
  }

  /** The stored device identity changed (reset, or replaced by another window): prove the current one. */
  resetDeviceIdentity(): void {
    this.forgetDeviceAuthState();
    if (!this.ws || this.disposed) {
      return;
    }
    this.closeSocket('gateway device identity changed');
    this.scheduleReconnect();
  }

  /** Pairing waits and the token retry belong to one identity at one endpoint. */
  private forgetDeviceAuthState(): void {
    this.pairingWait = null;
    this.deviceTokenRetry = 'unused';
    this.lastDeviceId = null;
    this.abandonQueuedAborts();
  }

  /**
   * Open the WebSocket and complete the handshake. Serialized (concurrent
   * calls join the in-flight attempt), idempotent while connected; an
   * explicit attempt cancels a scheduled reconnect. A superseded attempt
   * adopts the newer attempt, or rejects when none is pending.
   */
  connect(): Promise<void> {
    // Only an explicit attempt, not a scheduled reconnect, restarts a pairing wait that gave up.
    if (this.pairingWait?.expired && !this.disposed && !this.liveWs) this.pairingWait = null;
    return this.openConnection();
  }

  private openConnection(): Promise<void> {
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
    this.releaseEndpointState();
    this.closeSocket('gateway transport suspended');
  }

  /** Tear the client down for good. Remote runs keep running (a later window resumes them). */
  dispose(): void {
    this.disposed = true;
    this.stopConnecting();
    this.retireAllSinks();
    this.releaseEndpointState();
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
    this.connectionCount += 1;
    this.negotiatedVersion = connection.adapter.version;
    this.reconnectAttempt = 0;
    this.restartDelayMs = 0;
    this.deviceTokenRetry = 'unused';
    this.endPairingWait();
    this.lastDeviceId = connection.deviceId;
    this.sendQueuedAborts(connection.deviceId);
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
    this.subscribeSessionEvents();
    this.backfillPrompts(connection);
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

  /** Session index changes and tool events of observed sessions reach only subscribed connections. */
  private subscribeSessionEvents(): void {
    if (!this.supports('sessionEvents')) {
      return;
    }
    this.request((adapter) => adapter.sessionEventsRequest()).catch((err: Error) => {
      this.logger.warn(`sessions.subscribe failed ${err.message}`);
    });
  }

  /** Observe changes of the gateway's session index (a session was created, renamed or removed). */
  onSessionsChanged(listener: (sessionKey: string | null) => void): () => void {
    this.sessionsChangedListeners.add(listener);
    return () => this.sessionsChangedListeners.delete(listener);
  }

  /* ---------------------------------------------------------------- */
  /* Operator prompts: approvals and agent questions                   */
  /* ---------------------------------------------------------------- */

  /** Observe approvals and questions waiting for an operator; pending ones are replayed first.
   *  A prompt's session key is canonical, or the session of the run it names. */
  onApprovalRequest(listener: PromptListener): () => void {
    return this.prompts.subscribe(listener);
  }

  /** Which prompts the live connection may see and answer; none while disconnected. */
  getPromptAccess(): PromptAccess {
    const connection = this.connection;
    return connection ? connection.adapter.promptAccess(connection.accepted, connection.deviceId !== null) : NO_PROMPT_ACCESS;
  }

  /** Answer a pending approval by its prompt key; one settled meanwhile elsewhere is withdrawn instead. */
  async resolveApproval(key: string, decision: ApprovalDecision): Promise<void> {
    const prompt = this.prompts.get(key);
    if (prompt?.kind !== 'approval' || !prompt.decisions.includes(decision)) {
      throw new Error(PROMPT_GONE_MESSAGE);
    }
    await this.settlePrompt(key, decision, (adapter) => adapter.approvalResolveRequest({ id: prompt.id, subject: prompt.subject, decision }));
  }

  /** Answer every question of a pending question prompt at once, or decline it with null. */
  async answerQuestion(key: string, answers: QuestionAnswers | null): Promise<void> {
    const prompt = this.prompts.get(key);
    if (prompt?.kind !== 'question') {
      throw new Error(PROMPT_GONE_MESSAGE);
    }
    await this.settlePrompt(key, answers ? 'answered' : 'cancelled', (adapter) => adapter.questionReplyRequest({ id: prompt.id, answers }));
  }

  /** An answer whose reply is lost (drop, timeout) may still have been applied: the next backfill settles it.
   *  One never sent or refused is forgotten, so no later settle reads it as given here. */
  private async settlePrompt(key: string, outcome: PromptOutcome, build: (adapter: GatewayProtocolAdapter) => WireRequest): Promise<void> {
    this.prompts.noteSubmission(key, outcome);
    try {
      await this.request(build);
      this.prompts.settle(key, outcome);
    } catch (err) {
      if (err instanceof RpcRejectedError && (this.connection?.adapter ?? this.offeredAdapter()).isStalePromptFailure(err.failure)) {
        this.prompts.settle(key, PROMPT_WITHDRAWN);
        return;
      }
      if (err instanceof RpcRejectedError || neverSent(err)) {
        this.prompts.forgetSubmission(key);
        throw err;
      }
      throw new PromptAnswerUnconfirmedError(errorMessage(err));
    }
  }

  private warnPromptOverflow(): void {
    if (this.promptOverflowWarned) return;
    this.promptOverflowWarned = true;
    this.logger.warn('gateway announced more pending prompts than kept; the oldest are withdrawn');
  }

  /** The canonical session a prompt waits in: its own key, else the session following its run. */
  private locatePrompt(prompt: OperatorPrompt): OperatorPrompt {
    const runId = prompt.runId;
    const runSession = runId ? [...this.sessions.values()].find((state) => state.liveRuns.has(runId) || state.owned?.followed.has(runId)) : undefined;
    const sessionKey = prompt.sessionKey ? this.canonicalSessionKey(prompt.sessionKey) : (runSession?.key ?? null);
    return sessionKey === prompt.sessionKey ? prompt : { ...prompt, sessionKey };
  }

  /** Announce what waited before this connection; prompts of kinds it may no longer see are gone for it. */
  private backfillPrompts({ adapter, accepted, deviceId }: Connection): void {
    const access = adapter.promptAccess(accepted, deviceId !== null);
    this.prompts.withdraw(PROMPT_KINDS.filter((kind) => !(kind === 'approval' ? access.approvals : access.questions)));
    if (!access.approvals) {
      this.logger.info('approvals are not visible to this connection (operator.approvals and a device identity needed): shown as notices only');
    }
    const reads = adapter.pendingPromptRequests(access, accepted);
    if (reads.length === 0) {
      return;
    }
    const backfill = this.prompts.beginBackfill();
    const lists = reads.map((list) =>
      this.request(() => list.request)
        .then(({ adapter: answered, payload }) => ({ source: list.source, prompts: answered.parsePendingPrompts(list, payload) }))
        .catch((err: Error) => {
          this.logger.warn(`${list.request.method} failed ${err.message}`);
          return { source: list.source, prompts: null };
        })
    );
    // Only a source whose list was read settles what it no longer lists; the others keep theirs.
    void Promise.all(lists).then((results) => {
      const listed = results.flatMap((result) => result.prompts ?? []).map((prompt) => this.locatePrompt(prompt));
      this.prompts.finishBackfill(backfill, listed, results.filter((result) => result.prompts !== null).map((result) => result.source));
    });
  }

  /** A tool waits for an approval this connection cannot show, or no one could be asked: say so. */
  private approvalWaitNotice(wait: ApprovalWait | null): ChatEvent[] {
    if (wait === 'unavailable') return [{ type: 'notice', text: APPROVAL_UNAVAILABLE_NOTICE }];
    if (wait === 'pending' && !this.getPromptAccess().approvals) return [{ type: 'notice', text: APPROVAL_ELSEWHERE_NOTICE }];
    return [];
  }

  /** Prompts and full-row reads belong to one endpoint. */
  private releaseEndpointState(): void {
    this.prompts.cancelBackfill();
    this.prompts.withdraw(PROMPT_KINDS);
    this.rowCompleter.reset();
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
    const url = this.url;
    const gateway = gatewayKey(url);
    const deviceAuth = this.loadDeviceAuth(gateway);
    return new Promise<Connection>((resolve, reject) => {
      let settled = false;
      // Kept for the close that follows the error frame: it must not reclassify the rejection.
      let rejection: HandshakeRejection | null = null;
      let connectRequestId: string | null = null;
      const attempt: HandshakeAttempt = { url, gateway, device: null, sentDeviceToken: false };
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
        if (this.ws !== ws) {
          fail('gateway handshake superseded: retired socket delivered its rejection');
          return;
        }
        // Only the live handshake listener gets here, so the handshake is still unsettled.
        settle();
        rejection = this.reviewRejection({ ...rejected, message: this.redactGatewayMessage(rejected.message) }, attempt);
        const detail = rejection.message ? `: ${rejection.message}` : '';
        reject(new GatewayConnectError(`gateway handshake rejected code=${rejection.code}${detail}`, rejection));
        closeQuietly();
      };
      const transmitHello = (requestId: string, challenge: ChallengeEvent, device: DeviceAuth | null): void => {
        if (settled) return;
        attempt.device = device;
        const hello = this.nextClientHello(range, device);
        attempt.sentDeviceToken = hello.deviceToken !== undefined;
        const proof = device ? this.deviceProof(adapter, hello, device.identity, challenge) : undefined;
        if (proof === null) {
          fail('gateway connect challenge carries no usable nonce or timestamp');
          return;
        }
        const serialized = adapter.encodeRequest(requestId, adapter.connectRequest(hello, proof));
        if (Buffer.byteLength(serialized) > adapter.preAuthPayloadLimitBytes) {
          failRejected(oversizedConnectRejection(adapter.preAuthPayloadLimitBytes));
          return;
        }
        ws.send(serialized);
      };
      const sendHello = (challenge: ChallengeEvent): void => {
        if (connectRequestId !== null) return;
        const requestId = this.allocId();
        connectRequestId = requestId;
        whenReady(deviceAuth, (device) => transmitHello(requestId, challenge, device));
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
        const ungranted = negotiated.grantRejection(accepted);
        if (ungranted) {
          failRejected(ungranted);
          return;
        }
        if (this.ws !== ws) {
          fail('gateway handshake superseded: retired socket delivered its hello');
          return;
        }
        settle();
        this.liveWs = ws;
        this.keepIssuedDeviceToken(attempt, accepted);
        resolve({ adapter: negotiated, accepted, deviceId: attempt.device?.identity.deviceId ?? null });
      };
      const onMessage = (data: unknown): void => {
        const text = frameText(data);
        const frame = text === null ? null : adapter.decodeFrame(text);
        if (frame?.type === 'event') {
          if (frame.event?.kind === 'challenge') sendHello(frame.event);
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
        this.handleSocketClosed(rejection, attempt.device !== null);
      };
      const handshakeTimer = setTimeout(() => fail('gateway handshake timed out waiting for connect.challenge or hello'), HANDSHAKE_TIMEOUT_MS);
      ws.on('message', onMessage);
      ws.on('error', onError);
      ws.on('close', onClose);
    });
  }

  /** The identity this handshake proves, or null to connect without one (no store, or SecretStorage failed). */
  private loadDeviceAuth(gateway: string): Promise<DeviceAuth | null> | null {
    const store = this.deviceCredentials;
    if (!store) {
      return null;
    }
    const load = async (): Promise<DeviceAuth> => {
      const identity = await store.loadIdentity();
      const storedToken = await store.loadToken(gateway, identity.deviceId).catch(() => null);
      return { identity, storedToken };
    };
    return withTimeout(load(), DEVICE_LOAD_TIMEOUT_MS, 'SecretStorage timed out').catch((err: unknown) => {
      this.logger.warn(`gateway device identity unavailable; connecting without one ${errorMessage(err)}`);
      return null;
    });
  }

  /** The hello of the next attempt; it carries the stored device token once, when a retry with it is due. */
  private nextClientHello(range: ProtocolRange, device: DeviceAuth | null): ClientHello {
    const hello = { token: this.token, minProtocol: range.min, maxProtocol: range.max, clientVersion: CLIENT_VERSION, platform: process.platform };
    const retryToken = this.deviceTokenRetry === 'pending' ? device?.storedToken?.token : undefined;
    if (!retryToken) {
      return hello;
    }
    this.deviceTokenRetry = 'spent';
    return { ...hello, deviceToken: retryToken };
  }

  /** Null when the challenge lacks the nonce or timestamp a device signs. */
  private deviceProof(adapter: GatewayProtocolAdapter, hello: ClientHello, identity: DeviceIdentity, challenge: ChallengeEvent): DeviceProof | null {
    const { nonce, issuedAtMs } = challenge;
    if (nonce === null || issuedAtMs === null) {
      return null;
    }
    return proveDevice(identity, adapter, hello, { nonce, issuedAtMs });
  }

  /** Persist a token the hello issued, unless it is the stored one, whose recorded grant stays. */
  private keepIssuedDeviceToken({ device, gateway }: HandshakeAttempt, accepted: ConnectionAccepted): void {
    const store = this.deviceCredentials;
    const token = accepted.deviceToken;
    if (!store || !device || !token || device.storedToken?.token === token) {
      return;
    }
    const record: StoredDeviceToken = { deviceId: device.identity.deviceId, role: accepted.role, token, scopes: accepted.scopes };
    store.storeToken(gateway, record).catch((err: unknown) => {
      this.logger.warn(`storing the gateway device token failed ${errorMessage(err)}`);
    });
  }

  /** Act on what a rejection says about this device's token, and allow the one retry the gateway offers. */
  private reviewRejection(rejection: HandshakeRejection, attempt: HandshakeAttempt): HandshakeRejection {
    const store = this.deviceCredentials;
    if (rejection.staleDeviceToken && attempt.sentDeviceToken && store && attempt.device) {
      this.logger.warn('gateway refused the stored device token; forgetting it');
      store.clearToken(attempt.gateway, attempt.device.identity.deviceId).catch((err: unknown) => {
        this.logger.warn(`clearing the gateway device token failed ${errorMessage(err)}`);
      });
    }
    if (!this.allowsDeviceTokenRetry(rejection, attempt)) {
      return rejection;
    }
    this.deviceTokenRetry = 'pending';
    return { ...rejection, kind: 'backoff', retryAfterMs: DEVICE_TOKEN_RETRY_DELAY_MS };
  }

  /** shouldRetryGatewayWithDeviceToken: once, with a stored token, and only to a trusted endpoint. */
  private allowsDeviceTokenRetry(rejection: HandshakeRejection, attempt: HandshakeAttempt): boolean {
    return (
      rejection.deviceTokenRetry === true &&
      this.deviceTokenRetry === 'unused' &&
      !attempt.sentDeviceToken &&
      Boolean(attempt.device?.storedToken) &&
      this.trustsDeviceTokenRetry(attempt.url)
    );
  }

  /** Nothing tells a rejected client that its device was approved, so a pending approval is asked
   *  about again at a slow pace, until approved or the wait limit passes. */
  private notePairingRequired(pairing: PairingRequest, hint: string): void {
    const wait = (this.pairingWait ??= { sinceMs: Date.now(), expired: false });
    if (wait.expired) {
      return;
    }
    if (Date.now() - wait.sinceMs < PAIRING_WAIT_LIMIT_MS) {
      this.announcePairing({ status: 'pending', request: pairing, hint });
      return;
    }
    wait.expired = true;
    this.logger.warn('gateway device pairing was not approved in time; no longer retrying');
    this.announcePairing({ status: 'expired', request: pairing, hint });
  }

  private awaitsPairing(rejection: HandshakeRejection): boolean {
    return rejection.pairing !== undefined && this.pairingWait !== null && !this.pairingWait.expired;
  }

  private endPairingWait(): void {
    if (!this.pairingWait) {
      return;
    }
    this.pairingWait = null;
    this.announcePairing({ status: 'approved' });
  }

  private announcePairing(state: PairingState): void {
    for (const listener of [...this.pairingListeners]) listener(state);
  }

  /** The current socket closed: subscriptions and RPCs die with it. Accepted runs survive a
   *  reconnect, except after a permanent or pause rejection, when none follows until the
   *  user reconnects or changes the settings, or the gateway approves this device. */
  private handleSocketClosed(rejection: HandshakeRejection | null, provedDevice: boolean): void {
    this.liveWs = null;
    this.connection = null;
    this.stopKeepalive();
    this.announceConnection(false);
    this.forgetSubscriptions();
    this.rejectAllPending('gateway connection closed');
    // Only a device the gateway can pair is worth waiting for.
    if (rejection?.pairing && provedDevice) {
      this.notePairingRequired(rejection.pairing, rejection.hint);
    }
    if (rejection?.pairing && this.pairingWait?.expired) {
      this.logger.warn('gateway device pairing was not approved in time; not reconnecting until the next connect');
      this.finishOwnedRuns(`The gateway rejected this connection, so the run was interrupted. ${rejection.hint}`);
      return;
    }
    if (rejection?.kind === 'pause' && this.awaitsPairing(rejection)) {
      this.logger.info('gateway waits for this device to be approved; asking again shortly');
      this.finishOwnedRuns(`The gateway rejected this connection, so the run was interrupted. ${rejection.hint}`);
      this.reconnectAttempt = 0;
      this.scheduleReconnect(PAIRING_RETRY_DELAY_MS);
      return;
    }
    if (rejection && rejection.kind !== 'backoff') {
      this.logger.warn(`gateway rejected the handshake code=${rejection.code}; not reconnecting until the connection settings change`);
      this.finishOwnedRuns(`The gateway rejected this connection, so the run was interrupted. ${rejection.hint}`);
      return;
    }
    // A restart announcement delays only the reconnect right after it; failed attempts back off as usual.
    const restartDelayMs = this.restartDelayMs;
    this.restartDelayMs = 0;
    this.scheduleReconnect(Math.max(rejection ? this.minimumRetryDelay(rejection) : 0, restartDelayMs));
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
      this.openConnection().catch((err: Error) => {
        // A pending approval fails every attempt until it is granted; that is waiting, not an error.
        const message = `gateway reconnect failed ${this.redactCredentials(err.message)}`;
        if (err instanceof GatewayConnectError && err.rejection.pairing) this.logger.info(message);
        else this.logger.error(message);
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
    this.clearRetryTimers();
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
    return this.token ? redactTextAndSecret(message, this.token) : redactText(message);
  }

  /** A gateway message is shown to the user: strip credentials and cap its length. */
  private redactGatewayMessage(message: string): string {
    const redacted = this.redactCredentials(message);
    return capText(redacted, GATEWAY_MESSAGE_LIMIT) ?? redacted;
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
      return Promise.reject(new RequestNotSentError(NOT_CONNECTED_MESSAGE));
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
        pendingRequest.reject(new RequestNotSentError(`gateway rpc send failed method=${wire.method} ${this.redactCredentials(errorMessage(err))}`));
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

  /** The gateway's sessions, as the pickers show them, paged through up to a bound. */
  async listSessions(): Promise<SessionSummary[]> {
    const byKey = new Map<string, SessionSummary>();
    let offset: number | null = 0;
    for (let page = 0; page < MAX_SESSION_PAGES && offset !== null; page++) {
      const at: number = offset;
      const { adapter, payload } = await this.request((wire) => wire.listRequest({ offset: at }));
      const listed = adapter.parseSessionList(payload);
      if (!listed) {
        throw new Error('gateway returned a malformed session list');
      }
      for (const session of listed.sessions) if (!byKey.has(session.key)) byKey.set(session.key, session);
      offset = listed.nextOffset !== null && listed.nextOffset > at ? listed.nextOffset : null;
    }
    return [...byKey.values()];
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
    if (this.hasSinks(state)) {
      return;
    }
    // Nobody hears the session any more, so its runs would end unseen: forget them.
    state.liveRuns.clear();
    if (!state.subscribed) {
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
    if (current.owned?.stage === 'unconfirmed') this.transmit(current.owned);
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
      const latest = await this.readHistory(sessionKey);
      return latest && !('reset' in latest) ? await this.withOlderPages(sessionKey, latest) : null;
    } catch (err) {
      this.logger.warn(`chat.history fetch failed ${errorMessage(err)}`);
      return null;
    }
  }

  /** Prepend up to a bound of older pages, so a restored thread shows more than the last page. */
  private async withOlderPages(sessionKey: string, latest: HistorySnapshot): Promise<HistorySnapshot> {
    let messages = latest.messages;
    let olderPageOffset = latest.olderPageOffset;
    for (let page = 0; page < MAX_OLDER_HISTORY_PAGES && olderPageOffset !== null; page++) {
      const offset: number = olderPageOffset;
      const older = await this.readHistory(sessionKey, { olderPageOffset: offset });
      if (!older || 'reset' in older) break;
      const oldestShown = messages.find((message) => message.seq !== null)?.seq ?? Infinity;
      messages = [...older.messages.filter((message) => message.seq === null || message.seq < oldestShown), ...messages];
      olderPageOffset = older.olderPageOffset !== null && older.olderPageOffset > offset ? older.olderPageOffset : null;
    }
    return { ...latest, messages, olderPageOffset };
  }

  private async readHistory(sessionKey: string, page: { cursor?: string; olderPageOffset?: number } = {}): Promise<HistoryRead | null> {
    const { adapter, payload } = await this.request((wire) => wire.historyRequest({ sessionKey, ...page }));
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
      const limit = isImageMime(mimeType) ? limits.attachmentMaxImageBytes : limits.attachmentMaxBytes;
      if (data.byteLength > limit) {
        return `Attachment "${name}" is ${data.byteLength} bytes; the gateway accepts at most ${limit} bytes per ${isImageMime(mimeType) ? 'image' : 'file'}.`;
      }
    }
    return null;
  }

  /** Register the send's run; a previous run sink of another thread on the session ends with `done`. */
  private takeOverRun(state: SessionState, send: GatewaySend): OwnedRun {
    const runId = randomUUID();
    const previous = state.owned;
    // Only runs heard on this socket are known to be live; older ones are settled by catch-up.
    const heardNow = [...state.liveRuns].filter(([, run]) => run.heardOn === this.connectionCount).map(([id]) => id);
    const followed = new Set<string>([runId, ...heardNow]);
    for (const inherited of previous?.followed ?? []) {
      if (!state.finishedRuns.has(inherited) && inherited !== previous?.runId) followed.add(inherited);
    }
    if (previous && previous.stage !== 'preparing') followed.add(previous.runId);
    const owned: OwnedRun = {
      sink: send.onEvent,
      runId,
      requestedKey: send.sessionKey,
      canonicalKey: send.sessionKey,
      stage: 'preparing',
      send,
      attempts: 0,
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
    owned.canonicalKey = canonicalKey;
    this.transmit(owned);
  }

  /** Put `chat.send` on the wire, or once more under the same run id when its answer was lost. */
  private transmit(owned: OwnedRun): void {
    owned.stage = 'issued';
    owned.attempts += 1;
    this.rememberLocalRun(owned.runId);
    const { send } = owned;
    const request = { sessionKey: owned.canonicalKey, text: send.prompt, runId: owned.runId, attachments: send.attachments };
    this.request((adapter) => adapter.sendRequest(request))
      .then((result) => this.acceptSend(owned, result))
      .catch((err: Error) => this.handleSendFailure(owned, err));
  }

  /** A lost answer or a retryable refusal is tried again (the idempotency key makes that safe);
   *  anything else, or the last attempt, ends the send with the reason. */
  private handleSendFailure(owned: OwnedRun, err: Error): void {
    const state = this.stateOwning(owned);
    if (!state || owned.stage !== 'issued') {
      return;
    }
    const attemptsLeft = owned.attempts < MAX_SEND_ATTEMPTS;
    if (err instanceof RpcRejectedError && err.failure.retryable && attemptsLeft) {
      this.retryLater(owned, err.failure.retryAfterMs ?? SEND_RETRY_DELAY_MS);
      return;
    }
    const unconfirmed = !(err instanceof RpcRejectedError || neverSent(err));
    if (unconfirmed && attemptsLeft) {
      owned.stage = 'unconfirmed';
      // Still connected (an RPC timeout): ask again now; otherwise the next handshake does.
      if (this.liveWs) this.transmit(owned);
      return;
    }
    this.failOwned(state, owned, this.sendFailureMessage(err));
  }

  private retryLater(owned: OwnedRun, delayMs: number): void {
    owned.stage = 'unconfirmed';
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      if (this.stateOwning(owned) && owned.stage === 'unconfirmed' && this.liveWs) this.transmit(owned);
    }, delayMs);
    timer.unref?.();
    this.retryTimers.add(timer);
  }

  private clearRetryTimers(): void {
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
  }

  private rememberLocalRun(runId: string): void {
    this.localRuns.delete(runId);
    this.localRuns.set(runId, { connection: this.connectionCount, deviceId: this.connection?.deviceId ?? null });
    if (this.localRuns.size > RUN_HISTORY_LIMIT) {
      const [oldest] = this.localRuns.keys();
      this.localRuns.delete(oldest);
    }
  }

  /** Only a typed answer proves the gateway refused the send; any other failure after the frame
   *  went out (a drop, a tick or RPC timeout) leaves it possibly running. */
  private sendFailureMessage(err: Error): string {
    if (err instanceof FrameTooLargeError) return `The message was not sent: ${err.message}. Remove attachments or shorten it.`;
    if (err instanceof RequestNotSentError) return `The message was not sent: ${err.message}`;
    if (err instanceof RpcRejectedError) return `The gateway rejected the send: ${err.message}`;
    return SEND_UNCONFIRMED_MESSAGE;
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
      owned.followed.delete(owned.runId);
      owned.runId = accepted.runId;
      owned.followed.add(accepted.runId);
      this.rememberLocalRun(accepted.runId);
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

  /** The local runs a cancel concerns: those this client started, still going. */
  private localRunsOf(state: SessionState, owned: OwnedRun): string[] {
    return [...owned.followed].filter((runId) => this.localRuns.has(runId) && !state.finishedRuns.has(runId));
  }

  /** The gateway lets only the connection or the device that started a run stop it (canRequesterAbortChatRun). */
  private stoppableHere(runId: string): boolean {
    const origin = this.localRuns.get(runId);
    const deviceId = this.connection?.deviceId ?? null;
    if (!this.liveWs || !origin) {
      return false;
    }
    return origin.connection === this.connectionCount || (deviceId !== null && origin.deviceId === deviceId);
  }

  /**
   * Cancel the local run of a session and complete its sink with one `done`.
   * `chat.abort` goes out only for runs this connection, or this device over
   * an earlier connection, started; a send still preparing has none. While
   * disconnected, the abort of a run this device started waits for the next
   * handshake. A run the gateway will not let this connection stop
   * keeps running and streaming to the session's observers, and the sink
   * says so. Transcript sinks of other threads on the session stay.
   */
  abort(sessionKey: string): void {
    const state = this.stateFor(sessionKey);
    const owned = state?.owned;
    if (!state || !owned) {
      return;
    }
    state.owned = null;
    state.unclaimed = [];
    const runIds = owned.stage === 'preparing' ? [] : this.localRunsOf(state, owned);
    const stoppable = runIds.filter((runId) => this.stoppableHere(runId));
    const queueable = runIds.filter((runId) => this.stoppableOnReconnect(runId));
    const unstoppable = runIds.length > stoppable.length + queueable.length;
    if (stoppable.length > 0) {
      this.sendAborts(state, stoppable, owned.sink, unstoppable);
      return;
    }
    if (this.lastDeviceId && queueable.length > 0) {
      this.queueAbort(state, queueable, this.lastDeviceId, owned.sink, unstoppable);
      return;
    }
    this.completeAbortedSink(owned.sink, unstoppable);
    this.releaseIfIdle(state);
  }

  /** Disconnected, but the device that started the run will connect again and may stop it then. */
  private stoppableOnReconnect(runId: string): boolean {
    const deviceId = this.localRuns.get(runId)?.deviceId ?? null;
    return !this.liveWs && !this.disposed && deviceId !== null && deviceId === this.lastDeviceId;
  }

  /** Hold a cancel for the next handshake; its sink completes once the gateway answered, as a sent abort's does. */
  private queueAbort(state: SessionState, runIds: string[], deviceId: string, sink: ChatSink, runContinues: boolean, resends = 0): void {
    state.aborting = true;
    const timer = setTimeout(() => this.endQueuedAbort(queued, true), QUEUED_ABORT_LIMIT_MS);
    const queued: QueuedAbort = { state, runIds, deviceId, sink, runContinues, resends, timer };
    queued.timer.unref?.();
    this.queuedAborts.add(queued);
    this.logger.info(`gateway disconnected; chat.abort waits for the next handshake runs=${runIds.length}`);
  }

  /** After a handshake the same device sends the queued aborts; another identity may not. */
  private sendQueuedAborts(deviceId: string | null): void {
    for (const queued of [...this.queuedAborts]) {
      const { state } = queued;
      const unfinished = queued.runIds.filter((runId) => !state.finishedRuns.has(runId));
      if (deviceId !== queued.deviceId || this.sessions.get(state.key) !== state) {
        this.endQueuedAbort(queued, true);
      } else if (unfinished.length === 0) {
        this.endQueuedAbort(queued, queued.runContinues);
      } else {
        clearTimeout(queued.timer);
        this.queuedAborts.delete(queued);
        this.sendAborts(state, unfinished, queued.sink, queued.runContinues, queued.resends);
      }
    }
  }

  /** A queued abort that will not be sent: its sink completes, with the notice when runs may go on. */
  private endQueuedAbort(queued: QueuedAbort, runContinues: boolean): void {
    clearTimeout(queued.timer);
    this.queuedAborts.delete(queued);
    queued.state.aborting = false;
    this.completeAbortedSink(queued.sink, runContinues);
    this.releaseIfIdle(queued.state);
  }

  private abandonQueuedAborts(): void {
    for (const queued of [...this.queuedAborts]) this.endQueuedAbort(queued, true);
  }

  private completeAbortedSink(sink: ChatSink, runContinues: boolean): void {
    if (runContinues) sink({ type: 'notice', text: RUN_CONTINUES_NOTICE });
    sink({ type: 'done' });
  }

  /** `chat.abort` per run; a stopped run ends, one the gateway refused to stop is still followed
   *  by the session's observers. The sink completes once the gateway answered. An abort lost with
   *  its socket waits for the next handshake, a bounded number of times. */
  private sendAborts(state: SessionState, runIds: string[], sink: ChatSink, runContinues: boolean, resends = 0): void {
    state.aborting = true;
    const aborts = runIds.map((runId) =>
      this.request((adapter) => adapter.abortRequest({ sessionKey: state.key, runId }))
        .then((): AbortOutcome => {
          // Catch-up or the run's own aborted event may have ended it meanwhile.
          if (!state.finishedRuns.has(runId)) this.finishRun(state, runId);
          return 'stopped';
        })
        .catch((err: Error): AbortOutcome => {
          this.logger.warn(`chat.abort failed ${err.message}`);
          return err instanceof RpcRejectedError ? 'refused' : 'lost';
        })
    );
    void Promise.all(aborts).then((outcomes) => {
      const resend = runIds.filter((runId, index) => outcomes[index] === 'lost' && this.stoppableOnReconnect(runId));
      const failed = outcomes.filter((outcome) => outcome !== 'stopped').length > resend.length;
      if (this.lastDeviceId && resend.length > 0 && resends < MAX_ABORT_RESENDS) {
        this.queueAbort(state, resend, this.lastDeviceId, sink, runContinues || failed, resends + 1);
        return;
      }
      state.aborting = false;
      this.completeAbortedSink(sink, runContinues || outcomes.some((outcome) => outcome !== 'stopped'));
      this.releaseIfIdle(state);
    });
  }

  /** Best-effort `chat.abort` for every run this connection may stop, sent before the socket closes. */
  private abortRemoteRuns(): void {
    for (const state of this.sessions.values()) {
      const owned = state.owned;
      if (!owned || owned.stage === 'preparing') continue;
      for (const runId of this.localRunsOf(state, owned).filter((id) => this.stoppableHere(id))) {
        this.request((adapter) => adapter.abortRequest({ sessionKey: state.key, runId })).catch(() => undefined);
      }
    }
  }

  /** Complete every run sink (with an error first when given). */
  private finishOwnedRuns(failure?: string): void {
    this.abandonQueuedAborts();
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
      const failure = pendingRequest.adapter.parseRpcFailure(frame.error);
      const detail = failure.message ? `: ${this.redactGatewayMessage(failure.message)}` : '';
      pendingRequest.reject(new RpcRejectedError(`gateway rpc error code=${failure.code}${detail}`, failure));
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
    // Prompt events are dropped for slow clients, and the gap is their only trace.
    if (this.connection) this.backfillPrompts(this.connection);
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
      case 'sessionsChanged':
        for (const listener of [...this.sessionsChangedListeners]) listener(event.sessionKey);
        return;
      case 'promptRequested':
        this.prompts.add(this.locatePrompt(event.prompt));
        return;
      case 'promptResolved':
        this.prompts.settle(promptKey(event.source, event.id), event.outcome);
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
    // A session nobody observes would only collect runs whose end it may never hear.
    if (!state || !this.hasSinks(state) || state.finishedRuns.has(event.runId)) {
      return;
    }
    const owned = state.owned;
    if (owned?.stage === 'issued' && !owned.followed.has(event.runId) && !state.liveRuns.has(event.runId)) {
      state.unclaimed.push(event);
      if (state.unclaimed.length > UNCLAIMED_EVENT_LIMIT) state.unclaimed.shift();
      return;
    }
    if (event.kind === 'runFinal' && event.text === null && this.supports('history') && (state.rowsInFlight || this.needsSettling(state, event.runId))) {
      // Queued on arrival, so the session's later events wait until the transcript answered.
      this.queueRows(state, (state.rowsInFlight ?? Promise.resolve()).then(() => this.finishFromHistory(state, event)));
      return;
    }
    this.afterQueuedRows(state, () => {
      if (!state.finishedRuns.has(event.runId)) this.applyRunEvent(state, event);
    });
  }

  /** A final without a message after streamed text: like OpenClaw's own clients, the transcript says
   *  what the reply was. Its last assistant row of the run replaces the streamed text; none clears it
   *  (the partial text was never kept). When the transcript cannot tell, the streamed text stays. */
  private async finishFromHistory(state: SessionState, event: Extract<RunEvent, { kind: 'runFinal' }>): Promise<void> {
    const run = state.liveRuns.get(event.runId);
    if (state.finishedRuns.has(event.runId)) {
      return;
    }
    if (!run || !this.needsSettling(state, event.runId)) {
      this.applyRunEvent(state, event);
      return;
    }
    const settled = await this.settledRunText(state.key, event.runId);
    if (state.finishedRuns.has(event.runId)) {
      return;
    }
    if (settled === null) {
      this.applyRunEvent(state, event);
      return;
    }
    this.deliver(this.runSinks(state, event.runId), [...updateEvent(applySettled(run, settled)), ...usageEvent(event.usage)]);
    state.streamedRuns.add(event.runId);
    this.finishRun(state, event.runId);
  }

  /** Whether the run shows live-streamed text that a final without a message leaves unconfirmed. */
  private needsSettling(state: SessionState, runId: string): boolean {
    const run = state.liveRuns.get(runId);
    return run !== undefined && run.streamedLive && run.rendered !== '';
  }

  /** The text the transcript holds for a run: its last assistant row with text, '' when it has none;
   *  null when the transcript could not be read in time. */
  private async settledRunText(sessionKey: string, runId: string): Promise<string | null> {
    const read = (async (): Promise<string | null> => {
      const history = await this.readHistory(sessionKey);
      if (!history || 'reset' in history) return null;
      const row = [...history.messages].reverse().find((message) => message.role === 'assistant' && message.runId === runId && message.text);
      return row ? (await this.rowCompleter.complete(sessionKey, row)).text : '';
    })().catch(() => null);
    return withTimeoutNull(read, SETTLE_FROM_HISTORY_TIMEOUT_MS);
  }

  /** The run's text state; `heardOn` null when no event proved the run live on this socket yet. */
  private liveRun(state: SessionState, runId: string, heardOn: number | null = this.connectionCount): LiveRun {
    let run = state.liveRuns.get(runId);
    if (!run) {
      run = { ...newRunText(), heardOn, streamedLive: false };
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
    run.heardOn = this.connectionCount;
    const sinks = this.runSinks(state, event.runId);
    switch (event.kind) {
      case 'runStatus':
        return;
      case 'runDelta': {
        const update = applyDelta(run, event);
        if (update?.text) {
          state.streamedRuns.add(event.runId);
          run.streamedLive = true;
        }
        this.deliver(sinks, update ? updateEvent(update) : []);
        return;
      }
      case 'toolUpdate': {
        const update = `${event.runId}|${event.toolCallId}|${event.seq}`;
        if (state.toolUpdates.has(update)) return;
        state.toolUpdates.add(update);
        const toolCall: ChatEvent = { type: 'toolCall', id: event.toolCallId, title: event.name, status: event.status, details: event.details };
        this.deliver(sinks, [toolCall, ...this.approvalWaitNotice(event.awaitingApproval)]);
        return;
      }
      case 'runSideResult':
        this.deliver(sinks, [event.isError ? { type: 'error', message: event.text } : { type: 'text', text: event.text }]);
        return;
      case 'runFinal':
        this.deliver(sinks, [...updateEvent(applyFinal(run, event.text)), ...usageEvent(event.usage)]);
        break;
      case 'runAborted':
        this.deliver(sinks, updateEvent(applyAborted(run, event.text)));
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
    // `sessions.subscribe` delivers every session's rows; an unobserved one keeps its position for a later replay.
    if (!state || !this.hasSinks(state)) {
      return;
    }
    state.lastSeq = Math.max(state.lastSeq, message.seq ?? 0);
    const runId = message.runId;
    if (message.role !== 'assistant' || runId === null || state.finishedRuns.has(runId)) {
      return;
    }
    if (!message.text || state.streamedRuns.has(runId)) {
      this.afterQueuedRows(state, () => this.deliver(this.runSinks(state, runId), usageEvent(message.usage)));
      return;
    }
    state.streamedRuns.add(runId);
    // A row alone does not prove the run still streams, so a later send does not wait for it.
    const run = this.liveRun(state, runId, null);
    this.renderRows(state, [message], ([row]) => {
      if (state.finishedRuns.has(runId)) return;
      this.deliver(this.runSinks(state, runId), [...updateEvent(applyRow(run, row)), ...usageEvent(row.usage)]);
    });
  }

  /** Render transcript rows in arrival order. A cut row is read in full first; the rows and run
   *  events of the session that arrive meanwhile wait behind it, so nothing overtakes it. A read
   *  slower than the render timeout renders the row as it came, still first; the read keeps its
   *  own place in the completer's per-session queue until it settles. */
  private renderRows(state: SessionState, rows: readonly TranscriptMessage[], render: (rows: readonly TranscriptMessage[]) => void): void {
    if (!state.rowsInFlight && !rows.some(TruncatedRowCompleter.isIncomplete)) {
      render(rows);
      return;
    }
    const completed = Promise.all(rows.map((row) => this.rowCompleter.complete(state.key, row)));
    this.queueRows(state, (state.rowsInFlight ?? Promise.resolve()).then(() => completed).then(render));
  }

  /** Run `task` after the transcript work queued on the session, or now when none is queued. */
  private afterQueuedRows(state: SessionState, task: () => void): void {
    if (!state.rowsInFlight) {
      task();
      return;
    }
    this.queueRows(state, state.rowsInFlight.then(task));
  }

  private queueRows(state: SessionState, work: Promise<unknown>): void {
    const turn = work.then(
      () => undefined,
      (err: unknown) => this.logger.warn(`transcript row render failed ${errorMessage(err)}`)
    );
    state.rowsInFlight = turn;
    void turn.then(() => {
      if (state.rowsInFlight === turn) state.rowsInFlight = null;
    });
  }

  /** One transcript entry read uncut, for a row the gateway cut. */
  private async readEntry(sessionKey: string, entryId: string): Promise<TranscriptMessage | null> {
    if (!this.supports('history')) {
      return null;
    }
    const { adapter, payload } = await this.request((wire) => wire.messageRequest({ sessionKey, entryId }));
    const read = adapter.parseHistory(payload);
    return read && !('reset' in read) ? (read.messages.find((message) => message.entryId === entryId) ?? null) : null;
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
    // Taken before the read: events arriving during it must not narrow what it replays or settles.
    const before: CatchUpBaseline = { lastSeq: state.lastSeq, runs: this.runProgress(state) };
    const read = await this.readCatchUp(state, before);
    if (!read || this.sessions.get(state.key) !== state) {
      return;
    }
    const fresh = read.messages.filter((message) => message.seq === null ? !hasBoundary && allowTail : message.seq > before.lastSeq);
    state.cursor = read.cursor ?? state.cursor;
    state.lastSeq = highestSeq(read.messages, state.lastSeq);
    if (hasBoundary || allowTail) this.replayRows(state, fresh);
    this.settleInactiveRuns(state, read, before.runs);
  }

  /** Each tracked run with the sequence of the last event applied to it. */
  private runProgress(state: SessionState): Map<string, number> {
    return new Map(this.trackedRuns(state).map((runId) => [runId, state.liveRuns.get(runId)?.lastSeq ?? -1]));
  }

  /** The rows after the cursor; a reset cursor falls back to a tail read. */
  private async readCatchUp(state: SessionState, before: CatchUpBaseline): Promise<HistorySnapshot | null> {
    const cursor = state.cursor;
    const read = await this.readHistory(state.key, cursor === null ? {} : { cursor });
    if (read && !('reset' in read)) {
      return read;
    }
    state.cursor = null;
    const tail = cursor === null ? null : await this.readHistory(state.key);
    if (!tail || 'reset' in tail) {
      return null;
    }
    // A reset transcript restarts its sequence: the old position no longer bounds it.
    if (highestSeq(tail.messages, 0) < before.lastSeq) {
      before.lastSeq = 0;
      state.lastSeq = 0;
    }
    return tail;
  }

  private replayRows(state: SessionState, rows: readonly TranscriptMessage[]): void {
    const tracked = new Set(this.trackedRuns(state));
    const shown = rows.filter((row) => {
      const ownedByTrackedRun = row.runId !== null && (tracked.has(row.runId) || state.streamedRuns.has(row.runId));
      return row.role === 'assistant' && row.text !== '' && !ownedByTrackedRun;
    });
    this.renderRows(state, shown, (completed) => {
      for (const row of completed) {
        const text = row.truncated ? row.text + TRUNCATED_SUFFIX : row.text;
        this.deliver([...state.observers], [...textEvent(text), ...usageEvent(row.usage), { type: 'done' }]);
      }
    });
  }

  /** A tracked run the gateway no longer reports active ended while the socket was away. A run
   *  never seen and absent from the transcript may still wait in a queue, so it stays tracked, and
   *  a run that started or moved on while the read was in flight is newer than the read. */
  private settleInactiveRuns(state: SessionState, read: HistorySnapshot, before: ReadonlyMap<string, number>): void {
    const active = read.activeRunIds ?? (read.inFlightRunId ? [read.inFlightRunId] : null);
    if (active === null) {
      return;
    }
    const finalRows = finalRowByRun(read.messages);
    const mentioned = new Set(read.messages.flatMap((message) => message.runId ?? []));
    for (const runId of this.trackedRuns(state)) {
      const known = state.liveRuns.has(runId) || mentioned.has(runId);
      const unchangedSinceRead = before.has(runId) && before.get(runId) === (state.liveRuns.get(runId)?.lastSeq ?? -1);
      if (active.includes(runId) || !known || !unchangedSinceRead) continue;
      this.settleRun(state, runId, finalRows.get(runId));
    }
  }

  /** End a run with the last row it left, completed first when the gateway cut it. */
  private settleRun(state: SessionState, runId: string, finalRow: TranscriptMessage | undefined): void {
    const run = this.liveRun(state, runId);
    this.renderRows(state, finalRow ? [finalRow] : [], ([row]) => {
      // Its end may have been heard while the row was read.
      if (state.finishedRuns.has(runId)) return;
      this.deliver(this.runSinks(state, runId), updateEvent(applyRow(run, row)));
      this.finishRun(state, runId);
    });
  }
}
