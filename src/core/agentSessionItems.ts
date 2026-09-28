/**
 * Claw Code — agent session list helpers.
 *
 * Pure, VS Code-free helpers over `sessions.list` payloads and
 * `chat.history` rows. Only main-agent sessions are surfaced (child/subagent
 * or foreign sessions are filtered out); each row carries a hasActiveRun
 * indicator and a cold-placement flag for non-materialized sessions.
 */

import type { SessionRow } from './contract';
import { isAssistantRole } from './gatewayEventMapping';

/** Result of parsing an unknown `sessions.list` payload. */
export type ParsedSessionList = {
  rows: SessionRow[];
  /** Whether the payload looked like a list at all (diagnostics only). */
  ok: boolean;
};

/** Flattened picker/list item derived from a SessionRow. */
export type AgentSessionItem = {
  /** Session key to target with `chat.send` / `chat.history`. */
  sessionKey: string;
  /** Display label (falls back to the agent id or session key). */
  label: string;
  /** Agent id owning the session, when known. */
  agentId: string | null;
  /** Gateway-reported active run indicator. */
  hasActiveRun: boolean;
  /** Last activity timestamp (ISO string) when provided. */
  updatedAt: string | null;
  /** True when the session is not materialized (cold placement). */
  cold: boolean;
};

/** Placement states that represent a live, materialized session. */
const WARM_PLACEMENT_STATES = new Set(['local', 'active']);

/**
 * Parse an unknown RPC payload into session rows. Tolerates `{sessions: []}`,
 * bare arrays, and missing/ malformed entries; never throws.
 */
export function parseSessionRows(payload: unknown): ParsedSessionList {
  if (!payload || typeof payload !== 'object') {
    return { rows: [], ok: false };
  }
  const holder = payload as { sessions?: unknown; rows?: unknown; [key: string]: unknown };
  const raw = Array.isArray(payload)
    ? payload
    : Array.isArray(holder.sessions)
      ? holder.sessions
      : Array.isArray(holder.rows)
        ? holder.rows
        : null;
  if (!raw) {
    return { rows: [], ok: false };
  }
  const rows: SessionRow[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const row = entry as SessionRow;
    if (typeof row.key !== 'string' || !row.key) {
      continue;
    }
    rows.push(row);
  }
  return { rows, ok: true };
}

/**
 * Whether a session row is a main session of an agent (not a subagent/child
 * run and not a foreign session). Main sessions use the `agent:<id>:main`
 * key shape; the bare `main` default operator session is also accepted.
 */
export function isMainAgentSession(row: SessionRow): boolean {
  const key = row.key;
  if (!key) {
    return false;
  }
  if (key === 'main') {
    return true;
  }
  const parts = key.split(':');
  return (
    parts.length === 3 &&
    parts[0] === 'agent' &&
    parts[1] !== '' &&
    parts[2] === 'main'
  );
}

/**
 * Whether the session is cold: its placement state reports a
 * not-yet-materialized (drained/reclaiming/failed/…) session.
 */
export function isColdSession(row: SessionRow): boolean {
  const state = row.placement?.state;
  if (!state) {
    return false;
  }
  return !WARM_PLACEMENT_STATES.has(state);
}

/** Pick the freshest activity timestamp available on the row.
 *
 *  Rows may carry a stale `lastActivityAt` next to a newer `lastInteractionAt`,
 *  so the candidates are compared and the newest one wins instead of the first
 *  truthy field deciding the picker's sort order. Unparseable values are
 *  ignored (they sort as oldest via the caller's numeric comparator). */
function rowUpdatedAt(row: SessionRow): string | null {
  let freshest: string | null = null;
  for (const value of [row.lastActivityAt, row.lastInteractionAt, row.updatedAt]) {
    if (typeof value !== 'string' || !value) {
      continue;
    }
    const ts = Date.parse(value);
    if (Number.isNaN(ts)) {
      continue;
    }
    if (freshest === null || ts > Date.parse(freshest)) {
      freshest = value;
    }
  }
  return freshest;
}

/** Millisecond value of a picker timestamp for ordering (rowUpdatedAt only keeps parseable values). */
function updatedAtMs(value: string | null): number {
  return value === null ? 0 : Date.parse(value);
}

/** Derive a human-readable label for a session row. */
function rowLabel(row: SessionRow): string {
  if (typeof row.label === 'string' && row.label) {
    return row.label;
  }
  if (typeof row.agentId === 'string' && row.agentId) {
    return row.agentId;
  }
  return row.key;
}

/** Convert parsed rows into filtered, sorted picker items. */
export function toAgentSessionItems(rows: SessionRow[]): AgentSessionItem[] {
  const items = rows
    .filter(isMainAgentSession)
    .map((row) => ({
      sessionKey: row.key,
      label: rowLabel(row),
      agentId: typeof row.agentId === 'string' && row.agentId ? row.agentId : null,
      hasActiveRun: row.hasActiveRun === true || Array.isArray(row.activeRunIds) && row.activeRunIds.length > 0,
      updatedAt: rowUpdatedAt(row),
      cold: isColdSession(row),
    }));
  items.sort((a, b) => {
    if (a.hasActiveRun !== b.hasActiveRun) {
      return a.hasActiveRun ? -1 : 1;
    }
    // Sort by the parsed instant, not the string: ISO timestamps can carry
    // UTC offsets, and lexicographic order on such strings disagrees with
    // real time (`...+02:00` can be older than an earlier-sorting `Z` row).
    return updatedAtMs(b.updatedAt) - updatedAtMs(a.updatedAt);
  });
  return items;
}

/** Convenience: parse + filter + sort in one call. */
export function buildAgentSessionItems(payload: unknown): AgentSessionItem[] {
  return toAgentSessionItems(parseSessionRows(payload).rows);
}

/** Shape-only main-session check for webview-supplied keys: the same filter
 *  as isMainAgentSession, usable before any sessions.list rows are fetched. */
export function isMainAgentSessionKey(key: unknown): key is string {
  return typeof key === 'string' && isMainAgentSession({ key } as SessionRow);
}

/** A restored transcript message (deduplicated by messageId upstream). */
export type HistoryMessage = {
  role: 'user' | 'assistant';
  content: string;
  messageId: string | null;
};

/** Cold-placeholder message text shown for non-materialized sessions. */
export const COLD_SESSION_PLACEHOLDER = 'Session is unloaded — history will load once it starts.';

/** Transcript role of a history row, or null for tool-only/unknown rows. An omitted role is
 *  assistant output, as in the live stream (isAssistantRole). */
function historyRole(role: unknown): HistoryMessage['role'] | null {
  if (role === 'user') {
    return 'user';
  }
  return isAssistantRole(role) ? 'assistant' : null;
}

/**
 * Map `chat.history` rows into transcript messages. Tool-only/unknown rows and
 * rows without text are skipped. A messageId can repeat (a streaming partial
 * next to its completed row, or snapshot/tail overlap): the longest text wins,
 * ties going to the later row, at the position of the first occurrence.
 */
export function mapHistoryMessages(payload: unknown): HistoryMessage[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const rows = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(rows)) {
    return [];
  }
  const out: HistoryMessage[] = [];
  const indexById = new Map<string, number>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      continue;
    }
    const rec = row as { role?: unknown; text?: unknown; messageId?: unknown };
    const role = historyRole(rec.role);
    if (!role || typeof rec.text !== 'string' || !rec.text) {
      continue;
    }
    // An empty id is missing, not a dedupe key.
    const messageId = typeof rec.messageId === 'string' && rec.messageId ? rec.messageId : null;
    const message: HistoryMessage = { role, content: rec.text, messageId };
    const seenAt = messageId === null ? undefined : indexById.get(messageId);
    if (seenAt === undefined) {
      if (messageId !== null) {
        indexById.set(messageId, out.length);
      }
      out.push(message);
      continue;
    }
    if (message.content.length >= out[seenAt].content.length) {
      out[seenAt] = message;
    }
  }
  return out;
}
