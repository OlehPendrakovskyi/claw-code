/**
 * Claw Code — agent picker and session list helpers.
 *
 * Pure, VS Code-free helpers over `sessions.list` payloads used by both the
 * command palette picker and the webview session list. Only main-agent
 * sessions are surfaced (child/subagent or foreign sessions are filtered
 * out); each row carries a hasActiveRun indicator and a cold-placement flag
 * for non-materialized sessions.
 */

import { buildAgentSessionItems } from './agentSessionItems';
import type { AgentSessionItem } from './agentSessionItems';
export * from './agentSessionItems';

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
