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

/** Client identity block of the `connect` params: `id` and `mode` are closed enums on the
 *  gateway (packages/gateway-protocol/src/client-info.ts); unknown values fail validation. */
type ClientHelloClientInfo = {
  id: 'gateway-client';
  displayName?: string;
  version: string;
  platform: string;
  mode: 'backend';
};

/** Token auth block: `auth: { token }`. */
type ClientHelloAuth = {
  token: string;
};

/**
 * First frame the client sends: `connect` request params. The gateway validates
 * them as a closed object, so no field outside this shape may be sent.
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
  permissions?: Record<string, boolean>;
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

/** Top-level `error.code` values (packages/gateway-protocol/src/gateway-error-details.ts). */
export const GatewayErrorCodes = {
  NOT_PAIRED: 'NOT_PAIRED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  FORBIDDEN: 'FORBIDDEN',
  UNAVAILABLE: 'UNAVAILABLE',
} as const;

/** Handshake failure codes carried in `error.details.code`
 *  (packages/gateway-protocol/src/connect-error-details.ts). */
export const ConnectErrorDetailCodes = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_UNAUTHORIZED: 'AUTH_UNAUTHORIZED',
  AUTH_TOKEN_MISSING: 'AUTH_TOKEN_MISSING',
  AUTH_TOKEN_MISMATCH: 'AUTH_TOKEN_MISMATCH',
  AUTH_TOKEN_NOT_CONFIGURED: 'AUTH_TOKEN_NOT_CONFIGURED',
  AUTH_PASSWORD_MISSING: 'AUTH_PASSWORD_MISSING',
  AUTH_PASSWORD_MISMATCH: 'AUTH_PASSWORD_MISMATCH',
  AUTH_PASSWORD_NOT_CONFIGURED: 'AUTH_PASSWORD_NOT_CONFIGURED',
  AUTH_BOOTSTRAP_TOKEN_INVALID: 'AUTH_BOOTSTRAP_TOKEN_INVALID',
  AUTH_DEVICE_TOKEN_MISMATCH: 'AUTH_DEVICE_TOKEN_MISMATCH',
  AUTH_SCOPE_MISMATCH: 'AUTH_SCOPE_MISMATCH',
  AUTH_RATE_LIMITED: 'AUTH_RATE_LIMITED',
  AUTH_TAILSCALE_IDENTITY_MISSING: 'AUTH_TAILSCALE_IDENTITY_MISSING',
  AUTH_TAILSCALE_PROXY_MISSING: 'AUTH_TAILSCALE_PROXY_MISSING',
  AUTH_TAILSCALE_WHOIS_FAILED: 'AUTH_TAILSCALE_WHOIS_FAILED',
  AUTH_TAILSCALE_IDENTITY_MISMATCH: 'AUTH_TAILSCALE_IDENTITY_MISMATCH',
  AUTH_IDENTITY_HEADER_REQUIRED: 'AUTH_IDENTITY_HEADER_REQUIRED',
  AUTH_VERIFIED_USER_REQUIRED: 'AUTH_VERIFIED_USER_REQUIRED',
  AUTHENTICATED_PROFILE_UNAVAILABLE: 'AUTHENTICATED_PROFILE_UNAVAILABLE',
  CONTROL_UI_ORIGIN_NOT_ALLOWED: 'CONTROL_UI_ORIGIN_NOT_ALLOWED',
  CONTROL_UI_DEVICE_IDENTITY_REQUIRED: 'CONTROL_UI_DEVICE_IDENTITY_REQUIRED',
  PROTOCOL_MISMATCH: 'PROTOCOL_MISMATCH',
  CLIENT_VERSION_MISMATCH: 'CLIENT_VERSION_MISMATCH',
  DEVICE_IDENTITY_REQUIRED: 'DEVICE_IDENTITY_REQUIRED',
  DEVICE_AUTH_INVALID: 'DEVICE_AUTH_INVALID',
  DEVICE_AUTH_DEVICE_ID_MISMATCH: 'DEVICE_AUTH_DEVICE_ID_MISMATCH',
  DEVICE_AUTH_SIGNATURE_EXPIRED: 'DEVICE_AUTH_SIGNATURE_EXPIRED',
  DEVICE_AUTH_NONCE_REQUIRED: 'DEVICE_AUTH_NONCE_REQUIRED',
  DEVICE_AUTH_NONCE_MISMATCH: 'DEVICE_AUTH_NONCE_MISMATCH',
  DEVICE_AUTH_SIGNATURE_INVALID: 'DEVICE_AUTH_SIGNATURE_INVALID',
  DEVICE_AUTH_PUBLIC_KEY_INVALID: 'DEVICE_AUTH_PUBLIC_KEY_INVALID',
  PAIRING_REQUIRED: 'PAIRING_REQUIRED',
} as const;

/** `error.details.recommendedNextStep` values a handshake failure may carry. */
export const ConnectRecoverySteps = {
  RETRY_WITH_DEVICE_TOKEN: 'retry_with_device_token',
  UPDATE_AUTH_CONFIGURATION: 'update_auth_configuration',
  UPDATE_AUTH_CREDENTIALS: 'update_auth_credentials',
  WAIT_THEN_RETRY: 'wait_then_retry',
  REVIEW_AUTH_CONFIGURATION: 'review_auth_configuration',
} as const;

/** Protocol version of the 2026.9.x gateways; the connect frame must satisfy min ≤ 4 ≤ max. */
export const GATEWAY_PROTOCOL_VERSION = 4;

/** The gateway rejects larger frames before the handshake completes (MAX_PREAUTH_PAYLOAD_BYTES). */
export const GATEWAY_PREAUTH_PAYLOAD_LIMIT_BYTES = 64 * 1024;

/** hello-ok.policy defaults of the gateway, used when a field is absent or malformed. */
export const GatewayPolicyDefaults = {
  maxPayloadBytes: 25 * 1024 * 1024,
  maxBufferedBytes: 50 * 1024 * 1024,
  attachmentMaxBytes: 20 * 1024 * 1024,
  attachmentMaxImageBytes: 6 * 1024 * 1024,
} as const;

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
