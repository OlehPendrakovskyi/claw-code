/**
 * Claw Code — gateway event mapping and wire-frame parsing.
 *
 * Free helpers shared by the GatewayChatService transport and its tests:
 * parsing of inbound WS frames, extraction of session keys from RPC
 * payloads, and mapping of `session.message` frames onto the UI ChatEvent
 * union. Keeping them apart from the service class leaves the transport
 * responsible only for connection lifecycle and RPC bookkeeping.
 */

import type { RpcInboundFrame, SessionEvent, SessionMessageFrame } from './contract';
import { GatewayEvents } from './contract';
import { asNonEmptyString, asString, asStringOr } from './typeGuards';
import type { ChatEvent } from '../chat/ChatService';

/** Session key used when the gateway does not echo one back. */
export const DEFAULT_SESSION_KEY = 'main';

/** Cap for per-message streamed-delta tracking (oldest entry evicted). */
export const DELTA_TRACK_LIMIT = 200;

const TOOL_CALL_STATUSES = new Set(['running', 'done', 'error', 'failed']);

/** Extract a `sessionKey` from an RPC payload, when present. */
export function extractSessionKey(payload: unknown): string | null {
  if (payload && typeof payload === 'object') {
    const key = (payload as { sessionKey?: unknown; session?: { key?: unknown } }).sessionKey ??
      (payload as { session?: { key?: unknown } }).session?.key;
    return asNonEmptyString(key);
  }
  return null;
}

/** Extract frames from mixed WS message data (string/Buffer). */
export function parseFrame(data: unknown): RpcInboundFrame | null {
  const text = typeof data === 'string' ? data : data instanceof Buffer ? data.toString('utf8') : null;
  if (!text) return null;
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    if (obj.type === 'res' || obj.type === 'event') {
      return obj as unknown as RpcInboundFrame;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fallback details for tool-call frames that carry typed fields instead of a
 * ready-made `details` string: serialize arguments/result so the UI still
 * shows the call's inputs and outcome instead of an empty details block.
 */
function serializeToolCallDetails(tc: { arguments?: unknown; result?: unknown }): string {
  const parts: string[] = [];
  if (tc.arguments !== undefined) {
    parts.push(`arguments: ${JSON.stringify(tc.arguments, null, 2)}`);
  }
  if (tc.result !== undefined) {
    parts.push(`result: ${JSON.stringify(tc.result, null, 2)}`);
  }
  return parts.join('\n');
}

/**
 * Map a gateway `session.message` event to zero or more UI ChatEvents.
 * Handles toolCall payloads, streaming text deltas, final text, and usage.
 * Frames may carry several of these at once (e.g. toolCall alongside a delta
 * and usage), so every present facet is emitted in order; returns [] when
 * the event carries none of them.
 *
 * Mixed frames carrying both the incremental delta and the full text of the
 * same content are consistent only with a messageId: the per-message dedupe
 * in GatewayChatService keeps both events in sync. Without a messageId the
 * provider would append both strings verbatim ({delta:"hello", text:"hello"}
 * renders "hellohello"), so the full text is canonical there — a snapshot
 * cannot lose content, while a delta-only frame is preserved below.
 */
export function mapSessionEventToChatEvent(evt: SessionEvent): ChatEvent[] {
  if (evt.event !== GatewayEvents.sessionMessage) return [];
  const payload = (evt.payload ?? {}) as SessionMessageFrame;
  const messageId = asNonEmptyString(payload.messageId);
  if (payload.role && payload.role !== 'assistant') return [];
  const tc = payload.toolCall;
  const events: ChatEvent[] = [];
  if (tc && typeof tc === 'object') {
    const rawStatus = asStringOr(tc.status, '');
    const status = TOOL_CALL_STATUSES.has(rawStatus) ? rawStatus : rawStatus ? 'running' : 'done';
    const id = asNonEmptyString(tc.id);
    events.push({
      type: 'toolCall',
      title: asString(tc.title, asString(tc.name, 'tool')),
      status,
      details: asString(tc.details, serializeToolCallDetails(tc)),
      ...(id ? { id } : {}),
    });
  }
  const deltaText = asNonEmptyString(payload.delta);
  const fullText = asNonEmptyString(payload.text);
  if (!messageId && fullText !== null) {
    events.push({ type: 'text', text: fullText });
  } else {
    if (deltaText !== null) {
      events.push({ type: 'text', text: deltaText });
    }
    if (fullText !== null) {
      events.push({ type: 'text', text: fullText });
    }
  }
  const u = payload.usage;
  const promptTokens = Number(u?.promptTokens ?? u?.prompt_tokens ?? u?.input_tokens ?? 0);
  const completionTokens = Number(
    u?.completionTokens ?? u?.completion_tokens ?? u?.output_tokens ?? 0
  );
  if (u && (promptTokens || completionTokens)) {
    events.push({
      type: 'usage',
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    });
  }
  return events;
}