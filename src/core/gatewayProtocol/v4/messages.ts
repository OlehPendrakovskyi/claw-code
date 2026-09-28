/**
 * Protocol v4 transcript and session rows: display messages, `session.message`
 * payloads and `sessions.list` rows, reduced to the neutral model.
 */

import type { SessionListPage, SessionSummary, TokenUsage, TranscriptMessage, TranscriptRole } from '../model';
import { TRUNCATION_MARKER } from './schema';
import {
  isRecord,
  readArray,
  readFiniteNumber,
  readNonNegativeInteger,
  readPositiveInteger,
  readRecord,
  readString,
  readText,
} from './readers';

/** Metadata envelope of a display message (DisplayMessage.__openclaw). */
const OPENCLAW_META_FIELD = '__openclaw';

/** User rows carry `<runId>:user` as their idempotency key. */
const USER_TURN_SUFFIX = ':user';

/** Placement states of a materialized session. */
const WARM_PLACEMENT_STATES: ReadonlySet<string> = new Set(['local', 'active']);

function roleOf(value: unknown): TranscriptRole {
  return value === 'user' || value === 'assistant' ? value : 'other';
}

function blockText(block: unknown): string {
  const fields = readRecord(block);
  return fields.type === 'text' ? (readText(fields.text) ?? '') : '';
}

/** Visible text of a display message: string content, text blocks, or a bare `text`. */
export function displayText(message: unknown): string {
  const fields = readRecord(message);
  if (typeof fields.content === 'string') {
    return fields.content;
  }
  if (Array.isArray(fields.content)) {
    return fields.content.map(blockText).join('');
  }
  return readText(fields.text) ?? '';
}

function firstCount(fields: Readonly<Record<string, unknown>>, names: readonly string[]): number | null {
  for (const name of names) {
    const count = readFiniteNumber(fields[name]);
    if (count !== null && count >= 0) return count;
  }
  return null;
}

/** Token usage from any of the field spellings the gateway passes through; null when it has none. */
export function readUsage(value: unknown): TokenUsage | null {
  if (!isRecord(value)) {
    return null;
  }
  const promptTokens = firstCount(value, ['input', 'inputTokens', 'promptTokens', 'input_tokens', 'prompt_tokens']) ?? 0;
  const completionTokens =
    firstCount(value, ['output', 'outputTokens', 'completionTokens', 'output_tokens', 'completion_tokens']) ?? 0;
  const totalTokens = firstCount(value, ['totalTokens', 'total', 'total_tokens']) ?? promptTokens + completionTokens;
  return promptTokens || completionTokens || totalTokens ? { promptTokens, completionTokens, totalTokens } : null;
}

/** Rows carry their run's idempotency key: bare on assistant rows, `<runId>:user` on the user turn. */
function runIdOfIdempotencyKey(idempotencyKey: string | null): string | null {
  return idempotencyKey?.endsWith(USER_TURN_SUFFIX) ? readString(idempotencyKey.slice(0, -USER_TURN_SUFFIX.length)) : idempotencyKey;
}

/** A display message (chat.history tail row) as a transcript message. */
export function toTranscriptMessage(message: unknown, envelope?: { messageSeq?: unknown; runId?: unknown }): TranscriptMessage | null {
  if (!isRecord(message)) {
    return null;
  }
  const meta = readRecord(message[OPENCLAW_META_FIELD]);
  const role = roleOf(message.role);
  const shown = displayText(message);
  const cut = shown.endsWith(TRUNCATION_MARKER);
  const text = cut ? shown.slice(0, -TRUNCATION_MARKER.length) : shown;
  return {
    role,
    text,
    entryId: readString(meta.id),
    seq: readPositiveInteger(envelope?.messageSeq) ?? readPositiveInteger(meta.seq),
    runId: readString(envelope?.runId) ?? readString(meta.runId) ?? runIdOfIdempotencyKey(readString(meta.idempotencyKey)),
    usage: role === 'assistant' ? readUsage(message.usage) : null,
    truncated: cut || meta.truncated === true,
  };
}

/** A `session.message` payload (live, or replayed from a history delta). */
export function readSessionMessage(payload: unknown): { sessionKey: string; message: TranscriptMessage } | null {
  const fields = readRecord(payload);
  const sessionKey = readString(fields.sessionKey);
  const message = toTranscriptMessage(fields.message, fields);
  return sessionKey && message ? { sessionKey, message } : null;
}

export function readTranscript(rows: readonly unknown[], readRow: (row: unknown) => TranscriptMessage | null): TranscriptMessage[] {
  return rows.flatMap((row) => readRow(row) ?? []);
}

function latestActivityMs(row: Readonly<Record<string, unknown>>): number | null {
  const stamps = [row.lastActivityAt, row.lastInteractionAt, row.updatedAt].flatMap((value) => readFiniteNumber(value) ?? []);
  return stamps.length > 0 ? Math.max(...stamps) : null;
}

function readSessionRow(value: unknown): SessionSummary | null {
  const row = readRecord(value);
  const key = readString(row.key);
  if (!key) {
    return null;
  }
  const placementState = readString(readRecord(row.placement).state);
  const activeRunIds = readArray(row.activeRunIds);
  return {
    key,
    label: readString(row.label) ?? readString(row.displayName),
    agentId: readString(row.agentId),
    hasActiveRun: row.hasActiveRun === true || activeRunIds.length > 0,
    lastActivityMs: latestActivityMs(row),
    cold: placementState !== null && !WARM_PLACEMENT_STATES.has(placementState),
  };
}

/** `sessions.list` rows; null when the payload is not a list. */
export function readSessionList(payload: unknown): SessionListPage | null {
  const fields = readRecord(payload);
  if (!Array.isArray(fields.sessions)) {
    return null;
  }
  const nextOffset = fields.hasMore === true ? readNonNegativeInteger(fields.nextOffset) : null;
  return { sessions: fields.sessions.flatMap((row) => readSessionRow(row) ?? []), nextOffset };
}
