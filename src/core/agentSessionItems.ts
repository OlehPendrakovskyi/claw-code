/**
 * Claw Code — agent session list helpers.
 *
 * Pure, VS Code-free helpers over `sessions.list` payloads and
 * `chat.history` rows. Only main-agent sessions are surfaced (child/subagent
 * or foreign sessions are filtered out); each row carries a hasActiveRun
 * indicator and a cold-placement flag for non-materialized sessions.
 */

import type { SessionRow } from './contract';

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

/** Numeric millisecond value of a picker timestamp for ordering. */
function updatedAtMs(value: string | null): number {
  if (value === null) {
    return 0;
  }
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? 0 : ts;
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
export function isMainAgentSessionKey(key: unknown): boolean {
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

/**
 * Map `chat.history` rows into transcript messages. Non-assistant/user rows
 * (tool-only or unknown roles) are skipped; empty text yields nothing.
 *
 * A history row can appear twice for one messageId: first as a streaming
 * delta (partial `text`, non-empty `delta`), then as the completed row.
 * Delta-only rows are skipped so the completed row survives deduplication —
 * keeping the first (partial) row would truncate the restored transcript.
 * Rows carrying BOTH a delta and completed text are kept: the gateway emits
 * mixed frames with the full text (the delta is an un-rendered partial the
 * mapper never renders), so dropping the row would lose its content on
 * restore, and its text being final means recording the id cannot shadow a
 * longer completed row.
 */
export function mapHistoryMessages(payload: unknown): HistoryMessage[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const messages = (payload as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return [];
  }
  const out: HistoryMessage[] = [];
  const seenIds = new Set<string>();
  for (const row of messages) {
    if (!row || typeof row !== 'object') {
      continue;
    }
    const rec = row as {
      role?: unknown;
      text?: unknown;
      delta?: unknown;
      messageId?: unknown;
    };
    const messageId =
      typeof rec.messageId === 'string' && rec.messageId ? rec.messageId : null;
    const role = rec.role === 'user' ? 'user' : rec.role === 'assistant' ? 'assistant' : null;
    if (!role || typeof rec.text !== 'string' || !rec.text) {
      continue;
    }
    // Delta-only rows (no non-empty text) are already dropped by the
    // text check above; mixed delta+text rows keep the completed text.
    // Complete rows may repeat in chat.history (e.g. snapshot + tail overlap
    // on restore); dedupe by messageId while retaining rows without an id.
    // An empty string id is missing, not a dedup key: keying it would drop
    // every idless history row after the first.
    // Only delta-ONLY rows would need skipping here, and those never reach
    // this point (their empty text fails the check above): a non-empty
    // `delta` alongside usable `text` marks a mixed frame whose text is
    // already the completed content, so the row is kept and its id recorded
    // — skipping mixed rows would silently drop restored transcript rows.
    if (messageId) {
      if (seenIds.has(messageId)) {
        continue;
      }
      seenIds.add(messageId);
    }
    out.push({
      role,
      content: rec.text,
      messageId,
    });
  }
  return out;
}

/** Whether a history row was already surfaced (resume dedup by messageId). */
export function isDuplicateMessage(messageId: string | null, seen: ReadonlySet<string>): boolean {
  return messageId !== null && seen.has(messageId);
}
