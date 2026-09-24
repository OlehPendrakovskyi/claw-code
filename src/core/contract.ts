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

import type { ChatEvent, UsageInfo } from '../chat/ChatService';

/* ------------------------------------------------------------------ */
/* Framing (transport.md)                                              */
/* ------------------------------------------------------------------ */

/** Frame types on the wire: `{type:"req"|"res"|"event", ...}`. */
export type RpcFrameType = 'req' | 'res' | 'event';

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
export type RpcEventFrame = {
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
export type ClientHelloClientInfo = {
  id: string;
  version: string;
  platform: string;
  mode: 'operator' | 'node';
};

/** Token auth block: `auth: { token }`. */
export type ClientHelloAuth = {
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

/** Pre-connect challenge the Gateway emits before `connect`. */
export type GatewayChallengeEvent = {
  event: 'connect.challenge';
  payload: { nonce: string; ts: number };
};

/** Server identity block from `hello-ok`. */
export type HelloOkServer = {
  version: string;
  connId: string;
};

/** Advertised method/event families from `hello-ok`. */
export type HelloOkFeatures = {
  methods: string[];
  events: string[];
};

/** Negotiated authorization from `hello-ok`. */
export type HelloOkAuth = {
  role: string;
  scopes: string[];
};

/** Size/keepalive policy advertised by the Gateway. */
export type HelloOkPolicy = {
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
  placement?: {
    state: 'local' | 'requested' | 'provisioning' | 'syncing' | 'starting' | 'active' | 'draining' | 'reconciling' | 'reclaimed' | 'failed';
    [key: string]: unknown;
  };
  owner?: { type: string; id: string; label?: string; assignedBy?: string; assignedAt?: string };
  participants?: Array<{ type: string; id: string; label?: string }>;
  participantCount?: number;
  [key: string]: unknown;
};

/** Payload of `session.message` transcript events. */
export type SessionMessagePayload = {
  sessionKey?: string;
  agentId?: string;
  messageId?: string;
  role?: string;
  text?: string;
  usage?: Partial<UsageInfo>;
  [key: string]: unknown;
};

/**
 * Union of session-related events a chat client cares about.
 * Unknown event names are preserved so subscribers can ignore them safely.
 */
export type SessionEvent =
  | { event: 'session.message'; payload: SessionMessagePayload }
  | { event: 'sessions.changed'; payload: { key?: string; reason?: string; [key: string]: unknown } }
  | { event: 'session.approval'; payload: Record<string, unknown> }
  | { event: 'session_start'; payload: Record<string, unknown> }
  | { event: 'session_end'; payload: Record<string, unknown> }
  | { event: 'session.pending'; payload: Record<string, unknown> }
  /** Anything the protocol adds later; never fail on it. */
  | { event: string; payload: unknown };

/* ------------------------------------------------------------------ */
/* RPC method names (rpc-methods.md)                                   */
/* ------------------------------------------------------------------ */

/** Operator RPC methods used by this extension (subset of the catalog). */
export const GatewayRpcMethods = {
  /** Handshake request — see handshake.md. */
  connect: 'connect',
  /** Session index. */
  sessionsList: 'sessions.list',
  /** Subscribe to session change events for this socket. */
  sessionsSubscribe: 'sessions.subscribe',
  /** Per-session transcript events subscription. */
  sessionsMessagesSubscribe: 'sessions.messages.subscribe',
  sessionsMessagesUnsubscribe: 'sessions.messages.unsubscribe',
  /** Send a chat turn into a session. */
  chatSend: 'chat.send',
  /** Transcript tail with delta cursors. */
  chatHistory: 'chat.history',
  /** Abort active work in a session. */
  chatAbort: 'chat.abort',
  /** Inject a message into an active run. */
  chatInject: 'chat.inject',
} as const;

/** Known event names emitted by the Gateway (subset, additive). */
export const GatewayEvents = {
  connectChallenge: 'connect.challenge',
  sessionMessage: 'session.message',
  sessionsChanged: 'sessions.changed',
  sessionApproval: 'session.approval',
  sessionStart: 'session_start',
  sessionEnd: 'session_end',
} as const;

/* ------------------------------------------------------------------ */
/* ChatEvent bridge                                                    */
/* ------------------------------------------------------------------ */

/** Map a gateway usage-ish payload to the UI `UsageInfo`. */
export function mapUsage(payload: SessionMessagePayload): UsageInfo | undefined {
  const usage = (payload.usage ?? {}) as Record<string, unknown>;
  const promptTokens = Number(usage.promptTokens ?? usage.prompt_tokens ?? 0);
  const completionTokens = Number(usage.completionTokens ?? usage.completion_tokens ?? 0);
  if (promptTokens <= 0 && completionTokens <= 0) return undefined;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

/**
 * Bridge a gateway session event to the ChatService `ChatEvent` union the
 * chat panel already understands. Returns `null` when nothing maps.
 */
export function sessionEventToChatEvent(evt: SessionEvent): ChatEvent | null {
  if (evt.event !== GatewayEvents.sessionMessage) return null;
  const payload = (evt.payload ?? {}) as SessionMessagePayload;
  if (payload.role && payload.role !== 'assistant') return null;
  const text = payload.text;
  if (typeof text === 'string' && text.length > 0) {
    return { type: 'text', text };
  }
  const usage = mapUsage(payload);
  if (usage) return { type: 'usage', usage };
  return null;
}