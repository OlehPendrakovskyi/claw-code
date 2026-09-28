/**
 * Claw Code — agent session list helpers.
 *
 * Pure, VS Code-free helpers over the gateway's session summaries and
 * transcript snapshots (see gatewayProtocol/model.ts). Only main-agent
 * sessions are surfaced (child/subagent or foreign sessions are filtered out);
 * each item carries a hasActiveRun indicator and a cold-placement flag.
 */

import type { HistorySnapshot, SessionSummary } from './gatewayProtocol/model';

/** Flattened picker/list item derived from a SessionSummary. */
export type AgentSessionItem = {
  /** Session key to target with sends and history reads. */
  sessionKey: string;
  /** Display label (falls back to the agent id or session key). */
  label: string;
  /** Agent id owning the session, when known. */
  agentId: string | null;
  /** Gateway-reported active run indicator. */
  hasActiveRun: boolean;
  /** Last activity as an ISO timestamp, when known. */
  updatedAt: string | null;
  /** True when the session is not materialized (cold placement). */
  cold: boolean;
};

/** The bare default alias the gateway resolves to its default agent's main session. */
const DEFAULT_MAIN_KEY = 'main';

/** Main sessions use the `agent:<id>:main` key shape; the bare `main` alias is also accepted. */
export function isMainAgentSessionKey(key: unknown): key is string {
  if (typeof key !== 'string' || !key) {
    return false;
  }
  if (key === DEFAULT_MAIN_KEY) {
    return true;
  }
  const parts = key.split(':');
  return parts.length === 3 && parts[0] === 'agent' && parts[1] !== '' && parts[2] === DEFAULT_MAIN_KEY;
}

function toItem(session: SessionSummary): AgentSessionItem {
  return {
    sessionKey: session.key,
    label: session.label ?? session.agentId ?? session.key,
    agentId: session.agentId,
    hasActiveRun: session.hasActiveRun,
    updatedAt: session.lastActivityMs === null ? null : new Date(session.lastActivityMs).toISOString(),
    cold: session.cold,
  };
}

function lastActivityMs(item: AgentSessionItem): number {
  return item.updatedAt === null ? 0 : Date.parse(item.updatedAt);
}

/** Main-agent sessions as picker items: running ones first, then the most recently active. */
export function buildAgentSessionItems(sessions: readonly SessionSummary[]): AgentSessionItem[] {
  return sessions
    .filter((session) => isMainAgentSessionKey(session.key))
    .map(toItem)
    .sort((a, b) => {
      if (a.hasActiveRun !== b.hasActiveRun) {
        return a.hasActiveRun ? -1 : 1;
      }
      return lastActivityMs(b) - lastActivityMs(a);
    });
}

/** A restored transcript message. */
export type HistoryMessage = {
  role: 'user' | 'assistant';
  content: string;
  entryId: string | null;
};

/** Cold-placeholder message text shown for non-materialized sessions. */
export const COLD_SESSION_PLACEHOLDER = 'Session is unloaded — history will load once it starts.';

/**
 * A history snapshot as transcript messages. Rows without text, and rows that
 * are neither user nor assistant turns (tool results, notices), are skipped.
 * One transcript entry can project into several rows; they stay in order.
 */
export function mapHistoryMessages(snapshot: HistorySnapshot | null): HistoryMessage[] {
  return (snapshot?.messages ?? []).flatMap((message) =>
    message.role !== 'other' && message.text ? [{ role: message.role, content: message.text, entryId: message.entryId }] : []
  );
}
