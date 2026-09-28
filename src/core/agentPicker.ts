/**
 * Claw Code — agent picker.
 *
 * Lists main-agent sessions over the gateway transport for the command
 * palette picker (the webview session list uses the same helpers).
 */

import type { SessionSummary } from './gatewayProtocol/model';
import { buildAgentSessionItems } from './agentSessionItems';
import type { AgentSessionItem } from './agentSessionItems';
export * from './agentSessionItems';

/** Transport surface the picker needs (satisfied by GatewayChatService). */
export type SessionListTransport = {
  listSessions(): Promise<SessionSummary[]>;
};

/** QuickPick seam so core stays VS Code-free and testable. */
export type QuickPickLike = {
  show(items: AgentSessionItem[]): Promise<AgentSessionItem | undefined>;
};

/** Agent picker facade: lists main-agent sessions and lets the user choose one. */
export class AgentPicker {
  constructor(
    private readonly transport: SessionListTransport | null,
    private readonly quickPick: QuickPickLike
  ) {}

  /** Main-agent sessions (filtered + sorted); empty without a transport or on RPC failure. */
  async listMainSessions(): Promise<AgentSessionItem[]> {
    if (!this.transport) {
      return [];
    }
    try {
      return buildAgentSessionItems(await this.transport.listSessions());
    } catch {
      return [];
    }
  }

  /** Show the QuickPick and return the selected item (undefined on cancel or without sessions). */
  async pick(): Promise<AgentSessionItem | undefined> {
    const items = await this.listMainSessions();
    if (items.length === 0) {
      return undefined;
    }
    return this.quickPick.show(items);
  }
}
