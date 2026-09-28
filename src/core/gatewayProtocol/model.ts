/**
 * Claw Code — version-neutral gateway model.
 *
 * What the rest of the extension knows about the OpenClaw Gateway: the
 * requests the chat service issues and the inbound facts it reacts to, free of
 * any wire shape. A protocol adapter (see ./adapter.ts) translates between
 * this model and one wire version.
 */

/** Payload and keepalive limits of one connection. */
export type ConnectionLimits = {
  maxPayloadBytes: number;
  maxBufferedBytes: number;
  attachmentMaxBytes: number;
  attachmentMaxImageBytes: number;
  tickIntervalMs: number;
};

/** RPC methods, events and server capabilities one connection advertised. */
export type ConnectionFeatures = {
  methods: ReadonlySet<string>;
  events: ReadonlySet<string>;
  capabilities: ReadonlySet<string>;
};

/** A completed handshake. */
export type ConnectionAccepted = {
  protocolVersion: number;
  serverVersion: string;
  limits: ConnectionLimits;
  features: ConnectionFeatures;
  role: string;
  scopes: readonly string[];
  /** Session key aliases the gateway resolves (the `main` alias → its canonical main session). */
  sessionAliases: ReadonlyMap<string, string>;
};

/**
 * - `permanent`: retrying with the same settings cannot succeed.
 * - `pause`: waiting for an approval in OpenClaw; no retry until the user reconnects.
 * - `backoff`: transient; reconnect no sooner than `retryAfterMs`.
 */
export type HandshakeRejectionKind = 'permanent' | 'pause' | 'backoff';

export type HandshakeRejection = {
  kind: HandshakeRejectionKind;
  /** The most specific code the gateway sent. */
  code: string;
  /** The gateway's own message, as received (callers redact it). */
  message: string;
  /** Earliest reconnect delay the gateway asked for. */
  retryAfterMs?: number;
  /** Rate limited or waiting for an approval: without `retryAfterMs`, retry at the slowest pace. */
  throttled?: boolean;
  /** What the user can do about it. */
  hint: string;
};

/** What the user can do when client and gateway share no protocol version. */
export const PROTOCOL_MISMATCH_HINT =
  'The gateway and the extension speak different protocol versions — update the extension or the gateway, or set openclaw.gateway.protocolVersion.';

/** A rejected handshake, carrying its classification for callers of connect(). */
export class GatewayConnectError extends Error {
  constructor(
    message: string,
    readonly rejection: HandshakeRejection
  ) {
    super(message);
    this.name = 'GatewayConnectError';
  }
}

/** The operations the chat service needs from a gateway. */
export type GatewayOperation = 'send' | 'abort' | 'history' | 'subscribe' | 'unsubscribe' | 'list';

/** A file sent with a message; the gateway decides per model how images and other files reach it. */
export type SendAttachment = { name: string; mimeType: string; data: Buffer };

export type SendRequest = { sessionKey: string; text: string; runId: string; attachments?: readonly SendAttachment[] };
export type AbortRequest = { sessionKey: string; runId?: string };
export type HistoryRequest = { sessionKey: string; cursor?: string };
export type SubscriptionRequest = { sessionKey: string };

/** The gateway accepted a send; `runId` names the run its output streams under. */
export type SendAccepted = { runId: string };

/** A subscription and the canonical key the gateway resolved the requested one to. */
export type SubscriptionAccepted = { canonicalKey: string };

export type TokenUsage = { promptTokens: number; completionTokens: number; totalTokens: number };

export type TranscriptRole = 'user' | 'assistant' | 'other';

/** One persisted transcript message. */
export type TranscriptMessage = {
  role: TranscriptRole;
  /** Visible text; tool calls, thinking and media are left out. */
  text: string;
  /** Transcript entry identity; siblings of one entry share it. */
  entryId: string | null;
  /** Positive transcript-record sequence, for dedupe across live events and catch-up. */
  seq: number | null;
  /** The run that produced it, when the gateway names one. */
  runId: string | null;
  usage: TokenUsage | null;
};

/** A transcript read: a tail page, or the rows after a cursor. */
export type HistorySnapshot = {
  messages: TranscriptMessage[];
  /** Pass back to read only what follows; null when the gateway gave none. */
  cursor: string | null;
  /** The run the gateway still executes for the session, if any. */
  inFlightRunId: string | null;
  /** Run ids the gateway reports active; null when it did not say. */
  activeRunIds: readonly string[] | null;
};

/** A cursor read the gateway could not serve incrementally: drop the cursor and read a tail. */
export type HistoryReset = { reset: true };

export type HistoryRead = HistorySnapshot | HistoryReset;

/** One `sessions.list` row, reduced to what the pickers show. */
export type SessionSummary = {
  key: string;
  label: string | null;
  agentId: string | null;
  hasActiveRun: boolean;
  /** Latest activity, epoch milliseconds. */
  lastActivityMs: number | null;
  /** The session is not materialized (drained, reclaimed, ...). */
  cold: boolean;
};

export type ToolStatus = 'running' | 'done' | 'error';

/** Everything the gateway pushes that the chat service reacts to. */
export type InboundEvent =
  /** The run is alive but has produced nothing visible yet (startup phases). */
  | { kind: 'runStatus'; runId: string; sessionKey: string; seq: number }
  | {
      kind: 'runDelta';
      runId: string;
      sessionKey: string;
      seq: number;
      /** The run's whole assistant text so far, when the gateway sent a snapshot. */
      snapshotText: string | null;
      /** The new text; with `replace` it supersedes everything streamed before. */
      deltaText: string;
      replace: boolean;
    }
  | { kind: 'runFinal'; runId: string; sessionKey: string; seq: number; text: string | null; usage: TokenUsage | null }
  | { kind: 'runAborted'; runId: string; sessionKey: string; seq: number; text: string | null }
  | { kind: 'runError'; runId: string; sessionKey: string; seq: number; errorMessage: string | null; usage: TokenUsage | null }
  | {
      kind: 'toolUpdate';
      runId: string;
      sessionKey: string | null;
      seq: number;
      toolCallId: string;
      name: string;
      status: ToolStatus;
      details: string;
    }
  | { kind: 'transcriptMessage'; sessionKey: string; message: TranscriptMessage }
  | { kind: 'keepalive' }
  | { kind: 'shutdown'; reason: string; restartExpectedMs: number | null }
  | { kind: 'challenge' };

/** A parsed inbound frame. */
export type InboundFrame =
  | { type: 'response'; id: string; ok: true; payload: unknown }
  | { type: 'response'; id: string; ok: false; error: unknown }
  | { type: 'event'; connectionSeq: number | null; event: InboundEvent | null };
