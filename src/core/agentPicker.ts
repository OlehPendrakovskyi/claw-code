/**
 * Claw Code — agent picker and session list helpers.
 *
 * Pure, VS Code-free helpers over `sessions.list` payloads used by both the
 * command palette picker and the webview session list. Only main-agent
 * sessions are surfaced (child/subagent or foreign sessions are filtered
 * out); each row carries a hasActiveRun indicator and a cold-placement flag
 * for non-materialized sessions.
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
  if (key.toLowerCase().includes('subagent')) {
    return false;
  }
  if (key === 'main') {
    return true;
  }
  const parts = key.split(':');
  return parts.length === 3 && parts[0] === 'agent' && parts[2] === 'main';
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

/** Pick the freshest activity timestamp available on the row. */
function rowUpdatedAt(row: SessionRow): string | null {
  for (const value of [row.lastActivityAt, row.lastInteractionAt, row.updatedAt]) {
    if (typeof value === 'string' && value) {
      return value;
    }
  }
  return null;
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
    return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
  });
  return items;
}

/** Convenience: parse + filter + sort in one call. */
export function buildAgentSessionItems(payload: unknown): AgentSessionItem[] {
  return toAgentSessionItems(parseSessionRows(payload).rows);
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
  for (const row of messages) {
    if (!row || typeof row !== 'object') {
      continue;
    }
    const rec = row as { role?: unknown; text?: unknown; messageId?: unknown };
    const role = rec.role === 'user' ? 'user' : rec.role === 'assistant' ? 'assistant' : null;
    if (!role || typeof rec.text !== 'string' || !rec.text) {
      continue;
    }
    out.push({
      role,
      content: rec.text,
      messageId: typeof rec.messageId === 'string' ? rec.messageId : null,
    });
  }
  return out;
}

/** Whether a history row was already surfaced (resume dedup by messageId). */
export function isDuplicateMessage(messageId: string | null, seen: ReadonlySet<string>): boolean {
  return messageId !== null && seen.has(messageId);
}

/** Transport surface the picker needs (satisfied by GatewayChatService). */
export type SessionListTransport = {
  listSessions(params?: Record<string, unknown>): Promise<unknown>;
};

/** QuickPick seam so core stays VS Code-free and testable. */
export type QuickPickLike = {
  show(items: AgentSessionItem[]): Promise<AgentSessionItem | undefined>;
};

/**
 * Agent picker facade: lists main-agent sessions over the gateway transport
 * and binds the chosen session key to the active chat.
 */
export class AgentPicker {
  constructor(
    private readonly transport: SessionListTransport | null,
    private readonly quickPick?: QuickPickLike
  ) {}

  /**
   * List main-agent sessions (filtered + sorted). Returns an empty list
   * when no transport is available or the RPC fails.
   */
  async listMainSessions(): Promise<AgentSessionItem[]> {
    if (!this.transport) {
      return [];
    }
    try {
      const payload = await this.transport.listSessions({});
      return buildAgentSessionItems(payload);
    } catch {
      return [];
    }
  }

  /**
   * Show the QuickPick and return the selected item (undefined on cancel).
   * No-op (undefined) when the gateway transport is unavailable.
   */
  async pick(): Promise<AgentSessionItem | undefined> {
    if (!this.quickPick) {
      return undefined;
    }
    const items = await this.listMainSessions();
    if (items.length === 0) {
      return undefined;
    }
    return this.quickPick.show(items);
  }
}
