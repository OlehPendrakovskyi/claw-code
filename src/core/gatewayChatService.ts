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
const REQUEST_TIMEOUT_MS = 30_000;
/** Max wait for connect.challenge before sending connect anyway (protocol/auth.md allows legacy fallback). */
const CHALLENGE_FALLBACK_MS = 500;

/** Finite timeout for the full connect handshake (no-response protection). */
const HANDSHAKE_TIMEOUT_MS = 10_000;

function defaultWsFactory(url: string): WebSocketLike {
  // Lazy require keeps `ws` off the extension-activation path until connect().
  // The CommonJS entry point of `ws` exports the WebSocket constructor
  // directly; the ESM interop shape exposes it as `.default.WebSocket` /
  // `.WebSocket`. Handle both so the default factory works in every build.
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

/**
 * Map a gateway `session.message` event to a UI ChatEvent.
 * Returns null when the event carries no assistant text or usage.
 */
export function mapSessionEventToChatEvent(evt: SessionEvent): ChatEvent | null {
  if (evt.event !== GatewayEvents.sessionMessage) return null;
  const payload = (evt.payload ?? {}) as {
    role?: string;
    text?: unknown;
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
  if (typeof payload.text === 'string' && payload.text.length > 0) {
    return { type: 'text', text: payload.text };
  }
  const u = payload.usage;
  // Accept camelCase plus the snake_case aliases used across gateway/ChatService parsers.
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

  /** Open the WebSocket and complete the operator handshake. */
  connect(): Promise<void> {
    // Serialize concurrent connect() calls: a second call joins the
    // in-flight attempt instead of overwriting `this.ws` (which would bind
    // attachRuntimeHandlers() to the wrong socket).
    if (this.connectPromise) {
      return this.connectPromise;
    }
    // Idempotent when already connected: repeated connect() calls must not
    // open a second socket and overwrite `this.ws`.
    if (this.connected && this.ws) {
      return Promise.resolve();
    }
    // An explicit attempt cancels any pending scheduled reconnect so the
    // timer cannot fire mid-handshake and open yet another socket.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const attempt = this.openAndHandshake()
      .then((hello) => {
        this.hello = hello;
        this.reconnectAttempt = 0;
        this.attachRuntimeHandlers();
        this.logger.info(`gateway connected protocol=${hello.protocol}`);
      })
      .finally(() => {
        this.connectPromise = null;
      });
    this.connectPromise = attempt;
    return attempt;
  }

  private openAndHandshake(): Promise<HelloOk> {
    this.ws = this.wsFactory(this.url);
    const ws = this.ws;
    return new Promise<HelloOk>((resolve, reject) => {
      let settled = false;
      let helloSent = false;
      let connectRequestId: string | null = null;
      let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
      let challengeTimer: ReturnType<typeof setTimeout> | null = null;
      // Handshake watchdog starts at socket creation (not on `open`): a socket
      // that never emits `open` must not leave callers pending forever. On
      // expiry the promise rejects and the half-open socket is closed so
      // onClose schedules the reconnect.
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
      // protocol/handshake.md + auth.md: gate `connect` on the pre-connect
      // `connect.challenge` event when the gateway sends one (nonce-first
      // handshake). Token-only clients need no signature, but a short fallback
      // timer keeps compatibility with gateways that do not challenge.
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
      // Handshake watchdog starts at socket creation (not on `open`): a socket
      // that never emits `open` must not leave callers pending forever. On
      // expiry the promise rejects and the half-open socket is closed so
      // onClose schedules the reconnect.
      const onMessage = (data: unknown) => {
        const frame = parseFrame(data);
        if (!frame) return;
        if (frame.type === 'res') {
          const res = frame as RpcResponseFrame;
          // Protocol: response ids correlate with requests. Ignore responses
          // that do not belong to this socket's connect request (stale or
          // unrelated frames must not complete the handshake).
          if (res.id !== connectRequestId) return;
          if (res.ok) {
            const payload = res.payload as { type?: string } | undefined;
            if (payload?.type !== 'hello-ok') {
              // Correlated success with unexpected payload: reject instead of
              // leaving the handshake promise pending forever.
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
          // Pre-connect challenge observed; token auth needs no signed reply.
          // Gate the connect request on it (nonce-first handshake compatibility).
          sendHello();
          return;
        }
      };
      const onError = (err: Error) => {
        this.logger.error(`gateway error ${err.message}`);
        settleError(`gateway error ${err.message}`);
      };
      const onClose = () => {
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
    const chatEvent = mapSessionEventToChatEvent(evt);
    if (chatEvent) this.onEvent(chatEvent);
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

  /** ChatService-compatible send entry point (skeleton, no dispatch yet). */
  sendMessage(
    _prompt: string,
    _cwd: string,
    _model: string,
    _chatType: string,
    _onEvent: (event: ChatEvent) => void
  ): void {
    throw new Error('GatewayChatService.sendMessage not implemented yet (sprint 0 skeleton)');
  }

  abort(): void {
    // Skeleton: nothing to abort over the gateway yet.
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