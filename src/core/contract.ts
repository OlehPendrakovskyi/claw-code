/**
 * Claw Code — Gateway protocol contract types.
 *
 * This module is the SINGLE source of truth for OpenClaw Gateway WebSocket
 * protocol types used inside the extension. All shapes mirror the protocol
 * documentation:
 *
 * - Framing / transport:    docs/gateway/protocol/transport.md
 * - Connect / hello-ok:     /app/docs/gateway/protocol/handshake.md
 * - RPC method families:    /app/docs/gateway/protocol/rpc-methods.md
 * - Auth / device pairing:  /app/docs/gateway/protocol/auth.md
 *
 * The protocol is NOT frozen yet: every field is additive and/or optional.
 * Unknown-tolerant typing (`[key: string]: unknown` index signatures and
 * optional fields) keeps parsing forward-compatible with newer gateways.
 */

/* ------------------------------------------------------------------ */
/* Framing (transport.md)                                              */
/* ------------------------------------------------------------------ */

/** Error payload of a failed response (`{code, message, details?...}`). */
export type RpcErrorPayload = {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
};

/** Request frame: `{type:"req", id, method, params, traceparent?}`. */
export type RpcRequestFrame = {
  type: 'req';
  /** Unique per-connection request id (correlates with `res`). */
  id: string;
  method: string;
  params?: Record<string, unknown>;
  /** Optional W3C trace context continued by the Gateway. */
  traceparent?: string;
};

/** Response frame: `{type:"res", id, ok, payload|error}`. */
export type RpcResponseFrame = {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: RpcErrorPayload;
};

/** Event frame: `{type:"event", event, payload, seq?, stateVersion?...}`. */
type RpcEventFrame = {
  type: 'event';
  event: string;
  payload: unknown;
  seq?: number;
  stateVersion?: number;
  recipientProfileId?: string;
};

/** Union of every inbound frame the client must handle. */
export type RpcInboundFrame = RpcResponseFrame | RpcEventFrame;

/* ------------------------------------------------------------------ */
/* Handshake (handshake.md)                                            */
/* ------------------------------------------------------------------ */

/** Client identity block of the `connect` params. */
type ClientHelloClientInfo = {
  id: string;
  version: string;
  platform: string;
  mode: 'operator' | 'node';
};

/** Token auth block: `auth: { token }`. */
type ClientHelloAuth = {
  token: string;
};

/**
 * First frame the client sends: `connect` request params.
 * Only the operator-role subset is modelled here; node-specific fields
 * (`caps`, `commands`, `permissions`, `device`) are optional and additive.
 */
export type ClientHello = {
  /** Lowest protocol version the client supports (currently 4). */
  minProtocol: number;
  /** Highest protocol version the client supports. */
  maxProtocol: number;
  client: ClientHelloClientInfo;
  /** Requested role; this extension always connects as `operator`. */
  role: 'operator';
  /** Requested scopes, e.g. `["operator.read", "operator.write"]`. */
  scopes: string[];
  caps?: string[];
  commands?: string[];
  permissions?: Record<string, boolean | string>;
  auth: ClientHelloAuth;
  locale?: string;
  userAgent?: string;
  /** Device-identity fields (optional for token-only clients). */
  device?: {
    id: string;
    publicKey?: string;
    signature?: string;
    signedAt?: number;
    nonce?: string;
  };
  /** Extra additive fields the Gateway may add later. */
  [key: string]: unknown;
};

/** Server identity block from `hello-ok`. */
type HelloOkServer = {
  version: string;
  connId: string;
};

/** Advertised method/event families from `hello-ok`. */
type HelloOkFeatures = {
  methods: string[];
  events: string[];
};

/** Negotiated authorization from `hello-ok`. */
type HelloOkAuth = {
  role: string;
  scopes: string[];
};

/** Size/keepalive policy advertised by the Gateway. */
type HelloOkPolicy = {
  maxPayload: number;
  maxBufferedBytes: number;
  tickIntervalMs: number;
  attachments?: { maxBytes: number; maxImageBytes: number };
};

/** Payload of the successful `hello-ok` response. */
export type HelloOk = {
  type: 'hello-ok';
  protocol: number;
  server: HelloOkServer;
  features: HelloOkFeatures;
  snapshot?: Record<string, unknown>;
  auth: HelloOkAuth;
  policy: HelloOkPolicy;
  deviceToken?: string;
  controlUiUrl?: string;
  [key: string]: unknown;
};

/* ------------------------------------------------------------------ */
/* Session / chat events (rpc-methods.md, rpc-session-control.md)      */
/* ------------------------------------------------------------------ */

/**
 * Session-list row as returned by `sessions.list` / broadcast via
 * `sessions.changed`. All projections are optional and additive.
 */
export type SessionRow = {
  key: string;
  label?: string;
  agentId?: string;
  agentRuntime?: Record<string, unknown>;
  hasActiveRun?: boolean;
  activeRunIds?: string[] | null;
  archived?: boolean;
  createdAt?: string;
  updatedAt?: string;
  lastActivityAt?: string | null;
  lastInteractionAt?: string | null;
  activeMinutes?: number | null;
  placement?: SessionRowPlacement;
  owner?: SessionRowOwner;
  participants?: SessionRowParticipant[];
  participantCount?: number;
  [key: string]: unknown;
};

/** Placement projection of a {@link SessionRow}. */
type SessionRowPlacement = {
  state:
    | 'local'
    | 'requested'
    | 'provisioning'
    | 'syncing'
    | 'starting'
    | 'active'
    | 'draining'
    | 'reconciling'
    | 'reclaimed'
    | 'failed';
  [key: string]: unknown;
};

/** Owner projection of a {@link SessionRow}. */
type SessionRowOwner = {
  type: string;
  id: string;
  label?: string;
  assignedBy?: string;
  assignedAt?: string;
};

/** Participant entry of a {@link SessionRow}. */
type SessionRowParticipant = {
  type: string;
  id: string;
  label?: string;
};

/**
 * Raw `session.message` payload: every field is `unknown` because the wire
 * format is parsed without validation and narrowed at the edges.
 */
export type SessionMessageFrame = {
  role?: unknown;
  text?: unknown;
  delta?: unknown;
  messageId?: unknown;
  toolCall?: {
    id?: unknown;
    name?: unknown;
    title?: unknown;
    status?: unknown;
    details?: unknown;
    arguments?: unknown;
    result?: unknown;
  } | null;
  usage?: {
    promptTokens?: unknown;
    completionTokens?: unknown;
    totalTokens?: unknown;
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    input_tokens?: unknown;
    output_tokens?: unknown;
    total_tokens?: unknown;
  } | null;
  [key: string]: unknown;
};

/**
 * A gateway event frame reduced to what the chat client routes on. Payloads
 * are untrusted and narrowed where they are read; unknown event names are
 * ignored, never rejected.
 */
export type SessionEvent = {
  event: string;
  payload: unknown;
};

/* ------------------------------------------------------------------ */
/* RPC method names (rpc-methods.md)                                   */
/* ------------------------------------------------------------------ */

/** Handshake error codes that reject the credentials themselves. */
export const GatewayAuthRejectionCodes: ReadonlySet<string> = new Set([
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INVALID_TOKEN',
]);

/** Operator RPC methods used by this extension (subset of the catalog). */
export const GatewayRpcMethods = {
  /** Handshake request — see handshake.md. */
  connect: 'connect',
  /** Session index. */
  sessionsList: 'sessions.list',
  /** Per-session transcript events subscription. */
  sessionsMessagesSubscribe: 'sessions.messages.subscribe',
  sessionsMessagesUnsubscribe: 'sessions.messages.unsubscribe',
  /** Send a chat turn into a session. */
  chatSend: 'chat.send',
  /** Transcript tail with delta cursors. */
  chatHistory: 'chat.history',
  /** Abort active work in a session. */
  chatAbort: 'chat.abort',
} as const;

/** Known event names emitted by the Gateway (subset, additive). */
export const GatewayEvents = {
  connectChallenge: 'connect.challenge',
  sessionMessage: 'session.message',
  sessionEnd: 'session_end',
} as const;
