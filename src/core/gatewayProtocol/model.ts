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
  /** A reusable credential the gateway issued this device for the connection's role. */
  deviceToken: string | null;
};

/** A device's signed answer to the connect challenge. */
export type DeviceProof = {
  deviceId: string;
  /** Raw public key, unpadded base64url. */
  publicKey: string;
  signature: string;
  signedAtMs: number;
  nonce: string;
};

/** A pairing request waiting for an operator's approval in OpenClaw. */
export type PairingRequest = {
  /** Null when the gateway did not name one; `openclaw devices list` shows it. */
  requestId: string | null;
  /** Why approval is needed: a new device, or a role, scope or metadata upgrade. */
  reason: string | null;
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
  /** The approval the gateway waits for. */
  pairing?: PairingRequest;
  /** The shared token was refused, but the gateway would accept this device's stored token. */
  deviceTokenRetry?: boolean;
  /** The device token the client sent is no longer valid. */
  staleDeviceToken?: boolean;
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
export type GatewayOperation = 'send' | 'abort' | 'history' | 'subscribe' | 'unsubscribe' | 'list' | 'sessionEvents';

/** A file sent with a message; the gateway decides per model how images and other files reach it. */
export type SendAttachment = { name: string; mimeType: string; data: Buffer };

export type SendRequest = { sessionKey: string; text: string; runId: string; attachments?: readonly SendAttachment[] };
export type AbortRequest = { sessionKey: string; runId?: string };
/** `cursor` reads what follows it; `olderPageOffset` reads the page before a tail. */
export type HistoryRequest = { sessionKey: string; cursor?: string; olderPageOffset?: number };
/** One transcript entry read on its own, uncut up to the gateway's text ceiling. */
export type MessageRequest = { sessionKey: string; entryId: string };
export type ListRequest = { offset?: number };

/** A failed RPC as the gateway described it; `reason` is its machine-readable cause. */
export type RpcFailure = { code: string; message: string; retryable: boolean; retryAfterMs?: number; reason?: string };
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
  /** Visible text; tool calls, thinking and media are left out. When `truncated`, only its start. */
  text: string;
  /** Transcript entry identity; siblings of one entry share it. */
  entryId: string | null;
  /** Positive transcript-record sequence, for dedupe across live events and catch-up. */
  seq: number | null;
  /** The run that produced it, when the gateway names one. */
  runId: string | null;
  usage: TokenUsage | null;
  /** The gateway cut the text for display; it must not stand in for the full reply. */
  truncated: boolean;
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
  /** Offset of the page before this one, when the transcript has older rows. */
  olderPageOffset: number | null;
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

/** One page of `sessions.list`. */
export type SessionListPage = { sessions: SessionSummary[]; nextOffset: number | null };

export type ToolStatus = 'running' | 'done' | 'error';

export type ApprovalWait = 'pending' | 'unavailable';

/** A reviewer's answer to an approval request. */
export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny';

/** What an approval guards: a shell command, or a tool action a plugin holds back. */
export type ApprovalSubject = 'exec' | 'plugin';

/** Where a prompt comes from; its id is unique only among prompts of the same source. */
export type PromptSource = ApprovalSubject | 'question';

/** A run step that waits until an operator allows or denies it. */
export type ApprovalPrompt = {
  kind: 'approval';
  id: string;
  subject: ApprovalSubject;
  /** The command, or the plugin's title for the action. */
  title: string;
  /** Lines that help decide: description, working folder, warnings. */
  details: readonly string[];
  decisions: readonly ApprovalDecision[];
  sessionKey: string | null;
  runId: string | null;
  /** The span the gateway gave it (created to expires, on its clock); timed from receipt, never against the local clock. */
  lifetimeMs: number;
};

export type QuestionOption = { label: string; description: string | null };

export type QuestionItem = {
  id: string;
  header: string;
  text: string;
  options: readonly QuestionOption[];
  multiSelect: boolean;
  /** A typed answer is accepted besides the options (always, when there are none). */
  allowsOther: boolean;
  secret: boolean;
};

/** Questions an agent asks the operator; all of them are answered together. */
export type QuestionPrompt = {
  kind: 'question';
  id: string;
  questions: readonly QuestionItem[];
  sessionKey: string | null;
  runId: string | null;
  /** The span the gateway gave it (created to expires, on its clock); timed from receipt, never against the local clock. */
  lifetimeMs: number;
};

export type OperatorPrompt = ApprovalPrompt | QuestionPrompt;

/** How a prompt stopped waiting; `withdrawn` covers resolved elsewhere and gone from the gateway. */
export const PROMPT_WITHDRAWN = 'withdrawn';

/** How a prompt stopped waiting; `withdrawn` covers resolved elsewhere and gone from the gateway. */
export type PromptOutcome = ApprovalDecision | 'answered' | 'cancelled' | 'expired' | 'withdrawn';

/** Answers by question id: one value each, or several where a question allows multiple. */
export type QuestionAnswers = Readonly<Record<string, readonly string[]>>;

/** Which prompts the connection's grants let it see and answer. */
export type PromptAccess = { approvals: boolean; questions: boolean };

export type ApprovalResolution = { id: string; subject: ApprovalSubject; decision: ApprovalDecision };

/** Answers to a question prompt, or null to decline it. */
export type QuestionReply = { id: string; answers: QuestionAnswers | null };

/** The run triple every run event carries (runStatus, runDelta, runFinal, runAborted,
 *  runError, runSideResult). Owned here so v4 `ChatEventBase` and the events reader
 *  share one shape. `toolUpdate` is deliberately NOT covered: its `sessionKey` is
 *  `string | null` and the agent-event reader parses its fields separately. */
export type ChatRunFields = { runId: string; sessionKey: string; seq: number };

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
      /** The tool's result says it waits for an approval, or that no one could be asked for one. */
      awaitingApproval: ApprovalWait | null;
    }
  /** An answer given beside the run (a /btw side question). */
  | { kind: 'runSideResult'; runId: string; sessionKey: string; seq: number; text: string; isError: boolean }
  | { kind: 'transcriptMessage'; sessionKey: string; message: TranscriptMessage }
  /** The session index changed: lists of sessions may be stale. */
  | { kind: 'sessionsChanged'; sessionKey: string | null }
  /** An approval or question waits for an operator. */
  | { kind: 'promptRequested'; prompt: OperatorPrompt }
  | { kind: 'promptResolved'; source: PromptSource; id: string; outcome: PromptOutcome }
  | { kind: 'keepalive' }
  | { kind: 'shutdown'; reason: string; restartExpectedMs: number | null }
  /** The pre-connect challenge a device signs; null fields were missing or malformed. */
  | { kind: 'challenge'; nonce: string | null; issuedAtMs: number | null };

/** A parsed inbound frame. */
export type InboundFrame =
  | { type: 'response'; id: string; ok: true; payload: unknown }
  | { type: 'response'; id: string; ok: false; error: unknown }
  | { type: 'event'; connectionSeq: number | null; event: InboundEvent | null };
