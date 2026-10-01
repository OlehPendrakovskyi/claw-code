/**
 * Protocol v4 events (`chat`, `agent` tool stream, `session.message`, `tick`,
 * `shutdown`, `connect.challenge`, and the approval and question events of
 * ./prompts.ts) reduced to neutral inbound events.
 */

import type { ChatRunFields, InboundEvent, ToolStatus } from '../model';
import { displayText, readSessionMessage, readUsage } from './messages';
import { readApprovalWait, readPromptEvent } from './prompts';
import { describeJson, readDelayMs, readNonNegativeInteger, readRecord, readString, readText } from './readers';
import { Events } from './schema';

/** Longest serialized tool input or output kept for display. */
const TOOL_DETAILS_MAX_CHARS = 4000;

const AGENT_TOOL_STREAM = 'tool';

/** Longest a restart announcement may hold back reconnecting. */
const MAX_RESTART_WAIT_MS = 5 * 60_000;

type RunFields = ChatRunFields;

function readRunFields(payload: Readonly<Record<string, unknown>>): RunFields | null {
  const runId = readString(payload.runId);
  const sessionKey = readString(payload.sessionKey);
  const seq = readNonNegativeInteger(payload.seq);
  return runId && sessionKey && seq !== null ? { runId, sessionKey, seq } : null;
}

function messageText(message: unknown): string | null {
  return message === undefined ? null : displayText(message);
}

function chatEvent(payload: Readonly<Record<string, unknown>>): InboundEvent | null {
  const run = readRunFields(payload);
  if (!run) {
    return null;
  }
  switch (payload.state) {
    case 'status':
      return { kind: 'runStatus', ...run };
    case 'delta': {
      const deltaText = readText(payload.deltaText);
      if (deltaText === null) return null;
      return { kind: 'runDelta', ...run, deltaText, replace: payload.replace === true, snapshotText: messageText(payload.message) };
    }
    case 'final':
      return { kind: 'runFinal', ...run, text: messageText(payload.message), usage: readUsage(payload.usage) };
    case 'aborted':
      return { kind: 'runAborted', ...run, text: messageText(payload.message) };
    case 'error':
      return { kind: 'runError', ...run, errorMessage: readString(payload.errorMessage), usage: readUsage(payload.usage) };
    default:
      return null;
  }
}

function toolStatus(data: Readonly<Record<string, unknown>>): ToolStatus {
  if (data.phase !== 'result') return 'running';
  return data.isError === true ? 'error' : 'done';
}

function toolDetails(data: Readonly<Record<string, unknown>>): string {
  const payload = data.phase === 'start' ? data.args : data.phase === 'update' ? data.partialResult : data.result;
  return payload === undefined ? '' : describeJson(payload, TOOL_DETAILS_MAX_CHARS);
}

function sideResultEvent(payload: Readonly<Record<string, unknown>>): InboundEvent | null {
  const run = readRunFields(payload);
  const text = readText(payload.text);
  return run && text !== null ? { kind: 'runSideResult', ...run, text, isError: payload.isError === true } : null;
}

/** `agent` events of the tool stream, and `session.tool`, which carries the same payload. */
function agentEvent(payload: Readonly<Record<string, unknown>>): InboundEvent | null {
  if (payload.stream !== AGENT_TOOL_STREAM) {
    return null;
  }
  const runId = readString(payload.runId);
  const seq = readNonNegativeInteger(payload.seq);
  const data = readRecord(payload.data);
  const toolCallId = readString(data.toolCallId);
  const knownPhase = data.phase === 'start' || data.phase === 'update' || data.phase === 'result';
  if (!runId || seq === null || !toolCallId || !knownPhase) {
    return null;
  }
  return {
    kind: 'toolUpdate',
    runId,
    sessionKey: readString(payload.sessionKey),
    seq,
    toolCallId,
    name: readString(data.name) ?? 'tool',
    status: toolStatus(data),
    details: toolDetails(data),
    awaitingApproval: data.phase === 'result' ? readApprovalWait(data.result) : null,
  };
}

function shutdownEvent(payload: Readonly<Record<string, unknown>>): InboundEvent {
  return {
    kind: 'shutdown',
    reason: readString(payload.reason) ?? 'shutdown',
    restartExpectedMs: readDelayMs(payload.restartExpectedMs, MAX_RESTART_WAIT_MS) ?? null,
  };
}

/** The neutral event of one event frame; null for events this client does not consume. */
export function readEvent(event: string, payload: unknown): InboundEvent | null {
  const fields = readRecord(payload);
  switch (event) {
    case Events.chat:
      return chatEvent(fields);
    case Events.agent:
    case Events.sessionTool:
      return agentEvent(fields);
    case Events.chatSideResult:
      return sideResultEvent(fields);
    case Events.sessionsChanged:
      return { kind: 'sessionsChanged', sessionKey: readString(fields.sessionKey) };
    case Events.sessionMessage: {
      const transcript = readSessionMessage(payload);
      return transcript ? { kind: 'transcriptMessage', ...transcript } : null;
    }
    case Events.tick:
      return { kind: 'keepalive' };
    case Events.shutdown:
      return shutdownEvent(fields);
    case Events.connectChallenge:
      return { kind: 'challenge', nonce: readString(fields.nonce), issuedAtMs: readNonNegativeInteger(fields.ts) };
    default:
      return readPromptEvent(event, payload);
  }
}
