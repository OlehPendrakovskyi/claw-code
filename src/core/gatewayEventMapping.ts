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
import { asNonEmptyString, asString } from './typeGuards';
import type { ChatEvent, UsageInfo } from '../chat/ChatService';

/** Session key used when the gateway does not echo one back. */
export const DEFAULT_SESSION_KEY = 'main';

/** Cap for per-message streamed-delta tracking (least recently updated entry evicted). */
export const DELTA_TRACK_LIMIT = 200;

/** A wire-provided token count: only a finite, non-negative number counts; strings and booleans do not. */
function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Extract a `sessionKey` from an RPC payload, when present. */
export function extractSessionKey(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const { sessionKey, session } = payload as { sessionKey?: unknown; session?: unknown };
  return asNonEmptyString(sessionKey) ?? asNonEmptyString((session as { key?: unknown } | null | undefined)?.key);
}

/** Whether a row or frame carries assistant content: an omitted or null role
 *  counts as assistant, any other value (including falsy junk) does not. */
export function isAssistantRole(role: unknown): boolean {
  return role === undefined || role === null || role === 'assistant';
}

function isInboundFrame(value: unknown): value is RpcInboundFrame {
  const type = (value as { type?: unknown } | null)?.type;
  return type === 'res' || type === 'event';
}

/** Extract frames from mixed WS message data (string/Buffer). */
export function parseFrame(data: unknown): RpcInboundFrame | null {
  const text = typeof data === 'string' ? data : data instanceof Buffer ? data.toString('utf8') : null;
  if (!text) return null;
  try {
    const frame: unknown = JSON.parse(text);
    return isInboundFrame(frame) ? frame : null;
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
  if (!isAssistantRole(payload.role)) return [];
  const tc = payload.toolCall;
  const events: ChatEvent[] = [];
  if (tc && typeof tc === 'object' && !Array.isArray(tc)) {
    const id = asNonEmptyString(tc.id);
    events.push({
      type: 'toolCall',
      title: asString(tc.title, asString(tc.name, 'tool')),
      // An omitted status is not terminal: like the acpx mapper, keep the
      // invocation visible as running so hideToolActivity cannot hide it.
      status: asString(tc.status, 'running'),
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
  const usage = usageOf(payload.usage);
  if (usage) {
    events.push({ type: 'usage', usage });
  }
  return events;
}

/** Usage of a frame, each count read from the first alias holding a valid number. A total-only
 *  frame is a real usage update; without a total it is prompt + completion. */
function usageOf(u: SessionMessageFrame['usage']): UsageInfo | null {
  if (!u || typeof u !== 'object' || Array.isArray(u)) {
    return null;
  }
  const promptTokens = tokenCount(u.promptTokens) ?? tokenCount(u.prompt_tokens) ?? tokenCount(u.input_tokens) ?? 0;
  const completionTokens =
    tokenCount(u.completionTokens) ?? tokenCount(u.completion_tokens) ?? tokenCount(u.output_tokens) ?? 0;
  const totalTokens = tokenCount(u.totalTokens) ?? tokenCount(u.total_tokens) ?? promptTokens + completionTokens;
  return promptTokens || completionTokens || totalTokens ? { promptTokens, completionTokens, totalTokens } : null;
}
