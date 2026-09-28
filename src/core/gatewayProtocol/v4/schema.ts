/**
 * OpenClaw Gateway protocol v4 — wire types.
 *
 * Verified against openclaw@2026.9.6 (PROTOCOL_VERSION 4): the TypeBox schemas
 * of packages/gateway-protocol/src/schema/{frames,logs-chat,sessions}.ts and,
 * where the gateway has no schema, its handler sources
 * (server-methods/chat-send-handler.ts, chat-history-handler.ts,
 * sessions-subscriptions.ts, server-session-events.ts, server-chat.ts).
 * `closedObject` schemas reject unknown fields, so every outbound type below
 * lists the only fields a request may carry. Inbound types describe what the
 * gateway sends; payloads are still parsed as untrusted input.
 * Test fixtures: src/__test__/fixtures/openclaw-protocol-v4/.
 */

export const PROTOCOL_VERSION = 4;

/** MAX_PREAUTH_PAYLOAD_BYTES: larger frames are dropped before the handshake completes. */
export const MAX_PREAUTH_PAYLOAD_BYTES = 64 * 1024;

/** hello-ok.policy defaults (server-constants.ts, chat-attachment-policy.ts, gateway-client). */
export const PolicyDefaults = {
  maxPayload: 25 * 1024 * 1024,
  maxBufferedBytes: 50 * 1024 * 1024,
  attachmentMaxBytes: 20 * 1024 * 1024,
  attachmentMaxImageBytes: 6 * 1024 * 1024,
  tickIntervalMs: 30_000,
} as const;

export const Methods = {
  connect: 'connect',
  chatSend: 'chat.send',
  chatAbort: 'chat.abort',
  sessionsSubscribe: 'sessions.subscribe',
  chatHistory: 'chat.history',
  sessionsList: 'sessions.list',
  sessionsMessagesSubscribe: 'sessions.messages.subscribe',
  sessionsMessagesUnsubscribe: 'sessions.messages.unsubscribe',
} as const;

export const Events = {
  connectChallenge: 'connect.challenge',
  chat: 'chat',
  agent: 'agent',
  sessionMessage: 'session.message',
  sessionTool: 'session.tool',
  sessionsChanged: 'sessions.changed',
  chatSideResult: 'chat.side_result',
  tick: 'tick',
  shutdown: 'shutdown',
} as const;

/** GATEWAY_CLIENT_IDS / GATEWAY_CLIENT_MODES are closed enums; `gateway-client`/`backend` is the
 *  trusted local backend pair that may connect on loopback with the shared token and no device. */
export const ClientIdentity = { id: 'gateway-client', mode: 'backend' } as const;

/** GATEWAY_CLIENT_CAPS: `tool-events` registers this connection for its runs' tool lifecycle;
 *  `session-scoped-events` limits `chat`/`agent`/`session.tool`/`chat.side_result` to sessions this
 *  connection subscribed with `sessions.messages.subscribe` (server-start.ts SESSION_SUBSCRIPTION_EVENTS). */
export const ClientCaps = { toolEvents: 'tool-events', sessionScopedEvents: 'session-scoped-events' } as const;

/** The display projection cuts longer text (chat-display-projection.helpers.ts truncateChatHistoryText). */
export const TRUNCATION_MARKER = '\n...(truncated)...';

/** ChatHistoryParamsSchema's maxChars ceiling; without it rows are cut at 8,000 characters. */
export const HISTORY_MAX_CHARS = 500_000;

export const OperatorScopes = { read: 'operator.read', write: 'operator.write' } as const;

/* ---------------------------------------------------------------- */
/* Frames (frames.ts)                                                */
/* ---------------------------------------------------------------- */

export type RequestFrame = {
  type: 'req';
  id: string;
  method: string;
  params?: unknown;
  traceparent?: string;
};

export type ErrorShape = {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
};

export type ResponseFrame = { type: 'res'; id: string; ok: boolean; payload?: unknown; error?: ErrorShape };

export type EventFrame = { type: 'event'; event: string; payload?: unknown; seq?: number; stateVersion?: unknown };

/** connect.challenge payload (server/ws-connection.ts). */
export type ConnectChallenge = { nonce: string; ts: number; capabilities?: string[] };

/** ConnectParamsSchema, restricted to the fields this client sends. */
export type ConnectParams = {
  minProtocol: number;
  maxProtocol: number;
  client: {
    id: typeof ClientIdentity.id;
    displayName?: string;
    version: string;
    platform: string;
    mode: typeof ClientIdentity.mode;
  };
  caps?: string[];
  role?: string;
  scopes?: string[];
  auth?: { token?: string };
  locale?: string;
  userAgent?: string;
};

/** SessionDefaultsSchema (snapshot.ts): the alias `mainKey` resolves to `mainSessionKey`. */
export type SessionDefaults = { defaultAgentId: string; mainKey: string; mainSessionKey: string };

export type HelloOk = {
  type: 'hello-ok';
  protocol: number;
  server: { version: string; connId: string; buildId?: string; bootId?: string };
  features: { methods: string[]; events: string[]; capabilities?: string[] };
  snapshot: { sessionDefaults?: SessionDefaults; [field: string]: unknown };
  auth: { role: string; scopes: string[]; method?: string; deviceToken?: string };
  policy: {
    maxPayload: number;
    maxBufferedBytes: number;
    tickIntervalMs: number;
    attachments?: { maxBytes: number; maxImageBytes: number };
  };
  controlUiUrl?: string;
};

export type TickEvent = { ts: number };

export type ShutdownEvent = { reason: string; restartExpectedMs?: number };

/* ---------------------------------------------------------------- */
/* Chat (logs-chat.ts)                                               */
/* ---------------------------------------------------------------- */

/** ChatAttachmentSchema, as chat-attachments.ts parseMessageWithAttachments reads it: `content` is
 *  base64 (a data: URL prefix is stripped), the MIME type is re-sniffed, decoded sizes are checked
 *  against hello-ok.policy.attachments; there is no per-message count limit. */
export type ChatAttachment = {
  type: 'image' | 'file';
  mimeType: string;
  fileName: string;
  content: string;
  sizeBytes: number;
  origin: 'file';
};

/** ChatSendParamsSchema: `message` and `idempotencyKey` are required; the key becomes the runId.
 *  `queueMode` is left out, so the session's stored queue mode decides start-or-steer. */
export type ChatSendParams = { sessionKey: string; message: string; idempotencyKey: string; attachments?: ChatAttachment[] };

/** The ack reports admission only: no session key, no transcript row. */
export type ChatSendResult = {
  runId: string;
  status: 'started' | 'in_flight' | 'ok' | 'error' | 'timeout' | 'accepted';
  messageSeq?: number;
  interruptedActiveRun?: boolean;
};

export type ChatAbortParams = { sessionKey: string; runId?: string };

export type ChatHistoryParams = { sessionKey: string; cursor?: string; offset?: number; maxChars?: number };

/** A transcript row as display-projected by the gateway (chat-display-projection.core.ts). */
export type DisplayMessage = {
  role: string;
  content?: string | DisplayContentBlock[];
  text?: string;
  usage?: Record<string, number | Record<string, number>>;
  __openclaw?: { id?: string; seq?: number; runId?: string; idempotencyKey?: string; kind?: string; truncated?: boolean };
};

export type DisplayContentBlock = { type: string; text?: string; [field: string]: unknown };

/** Tail read (no cursor): display rows plus an optional cursor for later catch-up. */
export type ChatHistoryTailResult = {
  sessionKey: string;
  sessionId?: string;
  messages: DisplayMessage[];
  deltaCursor?: string;
  hasMore?: boolean;
  nextOffset?: number | null;
  sessionInfo?: { key?: string; hasActiveRun?: boolean; activeRunIds?: string[] };
  inFlightRun?: { runId: string; text: string };
};

/** ChatHistoryDeltaResultSchema: `messages` are `session.message` payloads. */
export type ChatHistoryDeltaResult = {
  kind: 'delta';
  messages: SessionMessageEvent[];
  deltaCursor: string;
  sessionInfo: unknown;
  inFlightRun?: unknown;
};

/** ChatHistoryResetResultSchema: the cursor is unusable; read a fresh tail. */
export type ChatHistoryResetResult = { kind: 'reset' };

type ChatEventBase = { runId: string; sessionKey: string; agentId?: string; seq: number };

/** ChatEventSchema union. `status` events only report startup phases. */
export type ChatEvent =
  | (ChatEventBase & { state: 'status'; phase: string })
  | (ChatEventBase & { state: 'delta'; deltaText: string; replace?: boolean; message?: DisplayMessage; usage?: unknown })
  | (ChatEventBase & { state: 'final'; message?: DisplayMessage; usage?: unknown; stopReason?: string })
  | (ChatEventBase & { state: 'aborted'; message?: DisplayMessage; errorMessage?: string; stopReason?: string })
  | (ChatEventBase & { state: 'error'; message?: DisplayMessage; errorMessage?: string; errorKind?: string; usage?: unknown });

/** AgentEventSchema plus the session snapshot the broadcast spreads in. */
export type AgentEvent = {
  runId: string;
  seq: number;
  stream: string;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};

/** `agent` event data of stream `tool` (agent-tools events). */
export type ToolEventData = {
  phase: 'start' | 'update' | 'result';
  name: string;
  toolCallId: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  meta?: string;
};

/* ---------------------------------------------------------------- */
/* Sessions (sessions.ts)                                            */
/* ---------------------------------------------------------------- */

export type SessionsMessagesSubscribeParams = { key: string };
export type SessionsMessagesUnsubscribeParams = { key: string };

/** The canonical key: `main` resolves to `agent:<default agent>:main`. */
export type SessionsMessagesSubscribeResult = { subscribed: boolean; key: string };

export type SessionsListParams = { limit?: number; offset?: number };

export type SessionRow = {
  key: string;
  agentId?: string;
  label?: string;
  displayName?: string;
  updatedAt?: number | null;
  lastActivityAt?: number;
  lastInteractionAt?: number;
  hasActiveRun?: boolean;
  activeRunIds?: string[] | null;
  placement?: { state: string };
};

export type SessionsListResult = { sessions: SessionRow[]; hasMore?: boolean; nextOffset?: number | null };

/** chat.side_result payload (chat-broadcast.ts broadcastSideResult): a /btw answer beside the run. */
export type ChatSideResult = { kind?: string; runId: string; sessionKey: string; seq: number; text?: string; isError?: boolean };

/** sessions.changed payload, reduced to the key it names (keyless changes invalidate every list). */
export type SessionsChangedEvent = { sessionKey?: string; reason?: string };

/** session.message payload (session-transcript-message.ts). */
export type SessionMessageEvent = {
  sessionKey: string;
  agentId?: string;
  message: DisplayMessage;
  messageId?: string;
  messageSeq?: number;
  runId?: string;
};
