/**
 * Protocol v4 operator prompts: exec and plugin approvals and agent questions.
 * Their `*.requested` / `*.resolved` events, the backfill lists and the
 * resolve requests, reduced to and built from the neutral model.
 *
 * Verified against openclaw@2026.9.6: server-methods/exec-approval.ts,
 * plugin-approval.ts, approval-shared.ts (buildRequestedApprovalEvent,
 * handleApprovalResolve), question.ts and question-manager.ts.
 */

import type { PromptListRequest, WireRequest } from '../adapter';
import type {
  ApprovalDecision,
  ApprovalPrompt,
  ApprovalResolution,
  ApprovalSubject,
  ApprovalWait,
  ConnectionAccepted,
  InboundEvent,
  OperatorPrompt,
  PromptAccess,
  PromptOutcome,
  QuestionItem,
  QuestionOption,
  QuestionPrompt,
  QuestionReply,
  RpcFailure,
} from '../model';
import { readArray, readNonNegativeInteger, readRecord, readString, readStrings, readTrimmedString } from './readers';
import type { ApprovalResolveParams, QuestionResolveParams } from './schema';
import { Events, Methods, OperatorScopes } from './schema';

/** Decisions a request offers when it names none (the gateway's default set). */
const DEFAULT_DECISIONS: readonly ApprovalDecision[] = ['allow-once', 'allow-always', 'deny'];

/** Plugin approval detail may run to 16,384 characters; the row shows its start. */
const DETAIL_MAX_CHARS = 2000;

/** details.reason of a resolve that came too late: the prompt is gone or already settled. */
const STALE_PROMPT_REASONS: ReadonlySet<string> = new Set([
  'APPROVAL_NOT_FOUND',
  'APPROVAL_ALREADY_RESOLVED',
  'QUESTION_NOT_FOUND',
  'QUESTION_ALREADY_TERMINAL',
]);

const QUESTION_OUTCOMES: ReadonlySet<string> = new Set(['answered', 'cancelled', 'expired']);

/** Exec tool result `details.status` values (bash-tools buildExecApprovalPendingToolResult). */
const APPROVAL_WAITS: Readonly<Record<string, ApprovalWait>> = { 'approval-pending': 'pending', 'approval-unavailable': 'unavailable' };

/** `details.failureKind` of an exec a headless run could not ask about (bash-tools denyHeadlessApproval). */
const APPROVAL_REQUIRED_FAILURE = 'approval_required';

/** The error an exec tool reports when no approval client could see its request
 *  (bash-tools buildHeadlessExecApprovalDeniedMessage); the gateway gives it no code. */
const NO_APPROVAL_ROUTE_ERROR = 'cannot wait for interactive exec approval';

const RESOLVE_METHODS: Record<ApprovalSubject, string> = {
  exec: Methods.execApprovalResolve,
  plugin: Methods.pluginApprovalResolve,
};

function isDecision(value: unknown): value is ApprovalDecision {
  return typeof value === 'string' && (DEFAULT_DECISIONS as readonly string[]).includes(value);
}

/** The offered decisions in canonical order; deny is always among them so a reviewer can fail closed. */
function readDecisions(value: unknown): ApprovalDecision[] {
  const offered = readArray(value).filter(isDecision);
  if (offered.length === 0) return [...DEFAULT_DECISIONS];
  return DEFAULT_DECISIONS.filter((decision) => decision === 'deny' || offered.includes(decision));
}

function capped(text: string | null): string | null {
  return text && text.length > DETAIL_MAX_CHARS ? `${text.slice(0, DETAIL_MAX_CHARS)}…` : text;
}

function presentLines(lines: ReadonlyArray<string | null>): string[] {
  return lines.filter((line): line is string => line !== null);
}

function labelled(label: string, value: string | null): string | null {
  return value ? `${label}: ${value}` : null;
}

function execDetails(request: Readonly<Record<string, unknown>>): string[] {
  return presentLines([
    labelled('Working folder', readString(request.cwd)),
    readTrimmedString(request.warningText),
    ...readStrings(readRecord(request.commandAnalysis).warningLines),
  ]);
}

function pluginDetails(request: Readonly<Record<string, unknown>>): string[] {
  return presentLines([
    readTrimmedString(request.description),
    capped(readTrimmedString(request.detail)),
    labelled('Tool', readString(request.toolName)),
    labelled('Plugin', readString(request.pluginId)),
    request.severity === 'critical' ? 'Severity: critical' : null,
  ]);
}

/** A `*.approval.requested` payload or list row. */
function readApproval(subject: ApprovalSubject, payload: unknown): ApprovalPrompt | null {
  const fields = readRecord(payload);
  const request = readRecord(fields.request);
  const id = readString(fields.id);
  const title = subject === 'exec' ? readTrimmedString(request.command) : readTrimmedString(request.title);
  const lifetimeMs = readLifetime(fields);
  if (!id || !title || lifetimeMs === null) {
    return null;
  }
  return {
    kind: 'approval',
    id,
    subject,
    title,
    details: subject === 'exec' ? execDetails(request) : pluginDetails(request),
    decisions: readDecisions(request.allowedDecisions),
    sessionKey: readString(request.sessionKey),
    runId: readString(request.runId),
    lifetimeMs,
  };
}

/** The gateway's created→expires span: both stamps are on its clock, so no local clock enters. */
function readLifetime(fields: Readonly<Record<string, unknown>>): number | null {
  const createdAtMs = readNonNegativeInteger(fields.createdAtMs);
  const expiresAtMs = readNonNegativeInteger(fields.expiresAtMs);
  return createdAtMs === null || expiresAtMs === null ? null : Math.max(expiresAtMs - createdAtMs, 0);
}

function readOption(value: unknown): QuestionOption | null {
  const fields = readRecord(value);
  const label = readString(fields.label);
  return label ? { label, description: readString(fields.description) } : null;
}

function readQuestionItem(value: unknown): QuestionItem | null {
  const fields = readRecord(value);
  const id = readString(fields.questionId);
  const text = readString(fields.question);
  if (!id || !text) {
    return null;
  }
  const options = readArray(fields.options).flatMap((option) => readOption(option) ?? []);
  return {
    id,
    header: readString(fields.header) ?? '',
    text,
    options,
    multiSelect: fields.multiSelect === true,
    // question-manager validateAnswers takes free text unless the options are exhaustive.
    allowsOther: fields.isOther === true || options.length === 0,
    secret: fields.isSecret === true || fields.secretStore !== undefined,
  };
}

/** A pending QuestionRecord (`question.requested` payload or `question.list` row). */
function readQuestion(payload: unknown): QuestionPrompt | null {
  const fields = readRecord(payload);
  const id = readString(fields.id);
  const lifetimeMs = readLifetime(fields);
  const questions = readArray(fields.questions).flatMap((question) => readQuestionItem(question) ?? []);
  const complete = questions.length > 0 && questions.length === readArray(fields.questions).length;
  if (!id || lifetimeMs === null || fields.status !== 'pending' || !complete) {
    return null;
  }
  return { kind: 'question', id, questions, sessionKey: readString(fields.sessionKey), runId: readString(fields.runId), lifetimeMs };
}

function requested(prompt: OperatorPrompt | null): InboundEvent | null {
  return prompt ? { kind: 'promptRequested', prompt } : null;
}

function resolved(payload: unknown, outcomeOf: (fields: Readonly<Record<string, unknown>>) => PromptOutcome): InboundEvent | null {
  const fields = readRecord(payload);
  const id = readString(fields.id);
  return id ? { kind: 'promptResolved', id, outcome: outcomeOf(fields) } : null;
}

function approvalOutcome(fields: Readonly<Record<string, unknown>>): PromptOutcome {
  return isDecision(fields.decision) ? fields.decision : 'withdrawn';
}

function questionOutcome(fields: Readonly<Record<string, unknown>>): PromptOutcome {
  return typeof fields.status === 'string' && QUESTION_OUTCOMES.has(fields.status) ? (fields.status as PromptOutcome) : 'withdrawn';
}

/** The neutral event of a prompt event frame; null for malformed payloads and other events. */
export function readPromptEvent(event: string, payload: unknown): InboundEvent | null {
  switch (event) {
    case Events.execApprovalRequested:
      return requested(readApproval('exec', payload));
    case Events.pluginApprovalRequested:
      return requested(readApproval('plugin', payload));
    case Events.questionRequested:
      return requested(readQuestion(payload));
    case Events.execApprovalResolved:
    case Events.pluginApprovalResolved:
      return resolved(payload, approvalOutcome);
    case Events.questionResolved:
      return resolved(payload, questionOutcome);
    default:
      return null;
  }
}

/** Whether an exec tool result reports a pending approval, or that no one could be asked for one. */
export function readApprovalWait(result: unknown): ApprovalWait | null {
  const details = readRecord(readRecord(result).details);
  if (typeof details.status === 'string' && details.status in APPROVAL_WAITS) return APPROVAL_WAITS[details.status];
  const unasked = details.failureKind === APPROVAL_REQUIRED_FAILURE || (readString(details.error)?.includes(NO_APPROVAL_ROUTE_ERROR) ?? false);
  return unasked ? 'unavailable' : null;
}

function granted(accepted: ConnectionAccepted, scope: string, method: string): boolean {
  const scoped = accepted.scopes.includes(scope) || accepted.scopes.includes(OperatorScopes.admin);
  return scoped && accepted.features.methods.has(method);
}

/** canDeliverApprovals / the question broadcast guard: the scope, and the method to answer with.
 *  An approval a run raises names the device that started the turn as its reviewer, so only that
 *  device, or operator.admin, sees it (approval-record-lookup.ts isApprovalRecordVisibleToClient). */
export function readPromptAccess(accepted: ConnectionAccepted, provedDevice: boolean): PromptAccess {
  const reviewer = provedDevice || accepted.scopes.includes(OperatorScopes.admin);
  return {
    approvals: reviewer && granted(accepted, OperatorScopes.approvals, Methods.execApprovalResolve),
    questions: granted(accepted, OperatorScopes.questions, Methods.questionResolve),
  };
}

function listRequest(kind: OperatorPrompt['kind'], method: string): PromptListRequest {
  return { kind, request: { method, params: {} } };
}

/** Reads of the prompts that predate the connection (clients.md "Backfill exec approvals"). */
export function pendingPromptRequests({ approvals, questions }: PromptAccess): PromptListRequest[] {
  return [
    ...(approvals ? [listRequest('approval', Methods.execApprovalList), listRequest('approval', Methods.pluginApprovalList)] : []),
    ...(questions ? [listRequest('question', Methods.questionList)] : []),
  ];
}

function readApprovalRow(row: unknown): ApprovalPrompt | null {
  const kind = readRecord(row).approvalKind;
  return kind === 'exec' || kind === 'plugin' ? readApproval(kind, row) : null;
}

/** An approval list (an array of requested events) or a question list (`{ questions }`). */
export function readPendingPrompts(payload: unknown): OperatorPrompt[] | null {
  if (Array.isArray(payload)) {
    return payload.flatMap((row) => readApprovalRow(row) ?? []);
  }
  const questions = readRecord(payload).questions;
  return Array.isArray(questions) ? questions.flatMap((row) => readQuestion(row) ?? []) : null;
}

export function approvalResolveRequest({ id, subject, decision }: ApprovalResolution): WireRequest {
  const params: ApprovalResolveParams = { id, decision };
  return { method: RESOLVE_METHODS[subject], params };
}

export function questionResolveRequest({ id, answers }: QuestionReply): WireRequest {
  const params: QuestionResolveParams = answers
    ? { id, answers: { answers: Object.fromEntries(Object.entries(answers).map(([key, values]) => [key, [...values]])) } }
    : { id, cancel: true };
  return { method: Methods.questionResolve, params };
}

export function isStalePromptFailure(failure: RpcFailure): boolean {
  return failure.reason !== undefined && STALE_PROMPT_REASONS.has(failure.reason);
}
