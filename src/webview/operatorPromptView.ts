/**
 * Claw Code — approval and question rows of the chat panel.
 *
 * What the provider keeps per operator prompt, how a row reads in the
 * webview, and the checks an answer from the webview must pass before it
 * goes to the gateway.
 */

import type { ApprovalDecision, OperatorPrompt, PromptOutcome, QuestionAnswers, QuestionItem, QuestionPrompt } from '../core/gatewayProtocol/model';

export type PromptRowState = 'pending' | 'submitting' | 'resolved';

export type PromptRow<Gateway> = {
    prompt: OperatorPrompt;
    /** The client the prompt arrived on, and the only one that can answer it. */
    gateway: Gateway;
    /** Local-clock deadline. */
    expiresAtMs: number;
    state: PromptRowState;
    outcome: PromptOutcome | null;
    /** The last answer sent from this window, even one whose reply was lost. */
    submitted: PromptOutcome | null;
    error: string | null;
};

/** A row as the webview renders it. */
export type PromptView = OperatorPrompt & { expiresAtMs: number; state: PromptRowState; status: string };

const OUTCOME_LABELS: Record<PromptOutcome, string> = {
    'allow-once': 'Allowed once',
    'allow-always': 'Always allowed',
    deny: 'Denied',
    answered: 'Answered',
    cancelled: 'Cancelled',
    expired: 'Expired without an answer',
    withdrawn: 'No longer pending',
};

/** Outcomes that record someone's answer, as opposed to the request going away. */
const ANSWER_OUTCOMES: ReadonlySet<PromptOutcome> = new Set(['allow-once', 'allow-always', 'deny', 'answered', 'cancelled']);

const SUBMITTING_STATUS = 'Sending…';

export const INCOMPLETE_ANSWER_MESSAGE = 'Answer every question: pick an option or type an answer.';

export function newPromptRow<Gateway>(prompt: OperatorPrompt, gateway: Gateway, expiresAtMs: number): PromptRow<Gateway> {
    return { prompt, gateway, expiresAtMs, state: 'pending', outcome: null, submitted: null, error: null };
}

function resolvedStatus(outcome: PromptOutcome, answeredHere: boolean): string {
    const label = OUTCOME_LABELS[outcome];
    return answeredHere || !ANSWER_OUTCOMES.has(outcome) ? label : `${label} elsewhere`;
}

function rowStatus<Gateway>(row: PromptRow<Gateway>): string {
    if (row.state === 'resolved' && row.outcome) return resolvedStatus(row.outcome, row.submitted === row.outcome);
    if (row.state === 'submitting') return SUBMITTING_STATUS;
    return row.error ?? '';
}

export function toPromptView<Gateway>(row: PromptRow<Gateway>): PromptView {
    return { ...row.prompt, expiresAtMs: row.expiresAtMs, state: row.state, status: rowStatus(row) };
}

export function isOfferedDecision(prompt: OperatorPrompt, value: unknown): value is ApprovalDecision {
    return prompt.kind === 'approval' && typeof value === 'string' && (prompt.decisions as readonly string[]).includes(value);
}

/** An option label is kept exactly as offered; typed text is trimmed, except a secret's. */
function typedOrPicked(question: QuestionItem, value: string): string {
    const picked = question.options.some((option) => option.label === value);
    return picked || question.secret ? value : value.trim();
}

function answerValues(question: QuestionItem, raw: unknown): string[] | null {
    if (!Array.isArray(raw) || !raw.every((value): value is string => typeof value === 'string')) {
        return null;
    }
    const values = raw.map((value) => typedOrPicked(question, value)).filter((value) => value !== '');
    const known = question.allowsOther || values.every((value) => question.options.some((option) => option.label === value));
    const counted = values.length === 1 || (question.multiSelect && values.length > 1);
    return known && counted ? values : null;
}

/** Answers from the webview for every question of the prompt, or null when one is missing or not allowed. */
export function readQuestionAnswers(prompt: QuestionPrompt, raw: unknown): QuestionAnswers | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return null;
    }
    const byId = raw as Record<string, unknown>;
    const answers: Record<string, string[]> = {};
    for (const question of prompt.questions) {
        const values = Object.prototype.hasOwnProperty.call(byId, question.id) ? answerValues(question, byId[question.id]) : null;
        if (!values) return null;
        answers[question.id] = values;
    }
    return answers;
}
