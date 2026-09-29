/**
 * Protocol v4 approvals and questions: parsing and request framing, checked
 * against the schemas exported from the real gateway.
 */

import { v4Adapter } from '../core/gatewayProtocol/v4/adapter';
import { assertValidRequest, assertValidResult, eventFrame, payloads } from './helpers/gatewayV4';

function decodedEvent(frame: string): unknown {
    const decoded = v4Adapter.decodeFrame(frame);
    return decoded?.type === 'event' ? decoded.event : undefined;
}

function framed(wire: { method: string; params: object }): { method: string; params: Record<string, unknown> } {
    return assertValidRequest(v4Adapter.encodeRequest('cc-1', wire));
}

function accepted(scopes: string[], methods?: string[]) {
    const hello = v4Adapter.parseHello(payloads.helloOk({ scopes, methods }));
    if (!hello) throw new Error('hello did not parse');
    return hello;
}

describe('gateway protocol v4 prompts', () => {
    describe('access', () => {
        it('grants each kind by its scope, or operator.admin, and only where the gateway offers the resolve method', () => {
            expect(v4Adapter.promptAccess(accepted(['operator.read', 'operator.write']), true)).toEqual({ approvals: false, questions: false });
            expect(v4Adapter.promptAccess(accepted(['operator.read', 'operator.approvals']), true)).toEqual({ approvals: true, questions: false });
            expect(v4Adapter.promptAccess(accepted(['operator.admin']), false)).toEqual({ approvals: true, questions: true });
            expect(v4Adapter.promptAccess(accepted(['operator.admin'], ['chat.send']), true)).toEqual({ approvals: false, questions: false });
        });

        it('shows run approvals only to a proven device, as they name the device that started the turn', () => {
            expect(v4Adapter.promptAccess(accepted(['operator.approvals', 'operator.questions']), false)).toEqual({ approvals: false, questions: true });
        });

        it('lists the pending prompts of the granted kinds only', () => {
            const reads = v4Adapter.pendingPromptRequests({ approvals: false, questions: true });
            expect(reads.map(({ kind, request }) => [kind, framed(request).method])).toEqual([['question', 'question.list']]);
            const all = v4Adapter.pendingPromptRequests({ approvals: true, questions: true }).map(({ request }) => framed(request).method);
            expect(all).toEqual(['exec.approval.list', 'plugin.approval.list', 'question.list']);
        });
    });

    describe('events and lists', () => {
        it('reads list rows of both approval kinds and pending questions, skipping malformed rows', () => {
            const execRows = [{ approvalKind: 'exec', ...payloads.execApproval({ id: 'a1' }, 'ls') }];
            const pluginRows = [{ approvalKind: 'plugin', ...payloads.pluginApproval({ id: 'plugin:1' }, 'Write') }];
            const questionList = { questions: [payloads.question({ id: 'q1' }, [{ questionId: 'pick', question: 'Which?' }])] };
            assertValidResult('exec.approval.list', execRows);
            assertValidResult('plugin.approval.list', pluginRows);
            assertValidResult('question.list', questionList);
            const [execList, pluginList, questionRead] = v4Adapter.pendingPromptRequests({ approvals: true, questions: true });
            expect(v4Adapter.parsePendingPrompts(execList, execRows)?.map((prompt) => prompt.id)).toEqual(['a1']);
            expect(v4Adapter.parsePendingPrompts(pluginList, pluginRows)?.map((prompt) => prompt.id)).toEqual(['plugin:1']);
            expect(v4Adapter.parsePendingPrompts(questionRead, questionList)?.map((prompt) => prompt.id)).toEqual(['q1']);
            expect(v4Adapter.parsePendingPrompts(execList, [{ id: 'x', request: {} }, ...execRows])).toHaveLength(1);
            expect(v4Adapter.parsePendingPrompts(execList, pluginRows)).toEqual([]);
            expect(v4Adapter.parsePendingPrompts(execList, { nope: true })).toBeNull();
            expect(v4Adapter.parsePendingPrompts(questionRead, { nope: true })).toBeNull();
        });

        it('takes a list row\'s subject from its list, as approvalKind is optional', () => {
            const [execList, pluginList] = v4Adapter.pendingPromptRequests({ approvals: true, questions: false });
            const execRows = [payloads.execApproval({ id: 'a1' }, 'ls')];
            const pluginRows = [payloads.pluginApproval({ id: 'plugin:1' }, 'Write')];
            assertValidResult('exec.approval.list', execRows);
            assertValidResult('plugin.approval.list', pluginRows);
            expect(v4Adapter.parsePendingPrompts(execList, execRows)).toMatchObject([{ id: 'a1', subject: 'exec', title: 'ls' }]);
            expect(v4Adapter.parsePendingPrompts(pluginList, pluginRows)).toMatchObject([{ id: 'plugin:1', subject: 'plugin', title: 'Write' }]);
        });

        it('keeps a long plugin detail to its start and flags a critical one', () => {
            const payload = payloads.pluginApproval({ id: 'plugin:1' }, 'Write', { detail: 'x'.repeat(3000), severity: 'critical' });
            const event = decodedEvent(eventFrame('plugin.approval.requested', payload)) as { prompt: { details: string[] } };
            expect(event.prompt.details[1]).toHaveLength(2001);
            expect(event.prompt.details).toContain('Severity: critical');
        });

        it('reads an unknown resolution decision as withdrawn and ignores prompt events without an id', () => {
            const unknown = JSON.stringify({ type: 'event', event: 'exec.approval.resolved', payload: { id: 'a1', decision: 'maybe', ts: 1 } });
            expect(decodedEvent(unknown)).toEqual({ kind: 'promptResolved', id: 'a1', outcome: 'withdrawn' });
            expect(decodedEvent(JSON.stringify({ type: 'event', event: 'question.resolved', payload: { status: 'expired' } }))).toBeNull();
        });

        it('reads whether an exec tool result waits for an approval', () => {
            const tool = (details: unknown) => decodedEvent(eventFrame('agent', payloads.tool({ runId: 'r', seq: 1 }, { phase: 'result', name: 'exec', toolCallId: 't', result: { details } })));
            expect(tool({ status: 'approval-pending' })).toMatchObject({ awaitingApproval: 'pending' });
            expect(tool({ status: 'approval-unavailable' })).toMatchObject({ awaitingApproval: 'unavailable' });
            expect(tool({ status: 'failed', failureKind: 'approval_required' })).toMatchObject({ awaitingApproval: 'unavailable' });
            expect(tool({ status: 'error', error: 'exec denied: Headless runs cannot wait for interactive exec approval.' })).toMatchObject({ awaitingApproval: 'unavailable' });
            expect(tool({ status: 'completed' })).toMatchObject({ awaitingApproval: null });
            expect(tool({ status: 'toString', failureKind: 'approval_required' })).toMatchObject({ awaitingApproval: 'unavailable' });
        });
    });

    describe('requests', () => {
        it('resolves exec and plugin approvals through their own methods', () => {
            expect(framed(v4Adapter.approvalResolveRequest({ id: 'a1', subject: 'exec', decision: 'allow-always' }))).toMatchObject({ method: 'exec.approval.resolve', params: { id: 'a1', decision: 'allow-always' } });
            expect(framed(v4Adapter.approvalResolveRequest({ id: 'plugin:1', subject: 'plugin', decision: 'deny' }))).toMatchObject({ method: 'plugin.approval.resolve', params: { id: 'plugin:1', decision: 'deny' } });
        });

        it('answers a question with every answer, or cancels it', () => {
            expect(framed(v4Adapter.questionReplyRequest({ id: 'q1', answers: { pick: ['A', 'B'] } })).params).toEqual({ id: 'q1', answers: { answers: { pick: ['A', 'B'] } } });
            expect(framed(v4Adapter.questionReplyRequest({ id: 'q1', answers: null })).params).toEqual({ id: 'q1', cancel: true });
        });

        it('reads one transcript entry at the gateway text ceiling', () => {
            expect(framed(v4Adapter.messageRequest({ sessionKey: 'agent:dev:main', entryId: 'e1' })).params).toEqual({ sessionKey: 'agent:dev:main', messageId: 'e1', limit: 1, maxChars: 500_000 });
        });

        it('tells a resolve that came too late from other failures by the error reason', () => {
            const failure = (reason?: string) => v4Adapter.parseRpcFailure({ code: 'INVALID_REQUEST', message: 'x', ...(reason ? { details: { reason } } : {}) });
            expect(v4Adapter.isStalePromptFailure(failure('APPROVAL_ALREADY_RESOLVED'))).toBe(true);
            expect(v4Adapter.isStalePromptFailure(failure('QUESTION_NOT_FOUND'))).toBe(true);
            expect(v4Adapter.isStalePromptFailure(failure('APPROVAL_ALLOW_ALWAYS_UNAVAILABLE'))).toBe(false);
            expect(v4Adapter.isStalePromptFailure(failure())).toBe(false);
        });
    });
});
