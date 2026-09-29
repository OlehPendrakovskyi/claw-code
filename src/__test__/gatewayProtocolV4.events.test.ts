import { readEvent } from '../core/gatewayProtocol/v4/events';
import type { InboundEvent } from '../core/gatewayProtocol/model';
import { Events } from '../core/gatewayProtocol/v4/schema';

const run = { runId: 'r1', sessionKey: 'main', seq: 1 };

describe('gateway protocol v4 event table', () => {
    describe('chat events', () => {
        it.each([
            ['status', { ...run, state: 'status' }, { kind: 'runStatus', ...run }],
            ['delta', { ...run, state: 'delta', deltaText: 'chunk' }, { kind: 'runDelta', ...run, deltaText: 'chunk', replace: false, snapshotText: null }],
            ['delta replace', { ...run, state: 'delta', deltaText: 'chunk', replace: true, message: { content: 'snapshot' } }, { kind: 'runDelta', ...run, deltaText: 'chunk', replace: true, snapshotText: 'snapshot' }],
            ['final', { ...run, state: 'final', message: { content: 'done' }, usage: { input: 1, output: 2 } }, { kind: 'runFinal', ...run, text: 'done', usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } }],
            ['aborted', { ...run, state: 'aborted', message: { content: 'partial' } }, { kind: 'runAborted', ...run, text: 'partial' }],
            ['error', { ...run, state: 'error', errorMessage: 'boom', usage: { totalTokens: 4 } }, { kind: 'runError', ...run, errorMessage: 'boom', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 4 } }],
        ])('maps the %s state', (_label, payload, expected) => {
            expect(readEvent(Events.chat, payload)).toEqual(expected);
        });

        it('returns null for unknown states, a missing delta text and malformed run fields', () => {
            expect(readEvent(Events.chat, { ...run, state: 'thinking' })).toBeNull();
            expect(readEvent(Events.chat, { ...run, state: 'delta' })).toBeNull();
            expect(readEvent(Events.chat, { runId: 'r1', sessionKey: 'main', seq: -1, state: 'status' })).toBeNull();
            expect(readEvent(Events.chat, { runId: 'r1', seq: 1, state: 'status' })).toBeNull();
            expect(readEvent(Events.chat, 'junk')).toBeNull();
        });
    });

    describe('tool stream events', () => {
        const tool = (data: object, over: object = {}) => ({ stream: 'tool', runId: 'r1', seq: 1, sessionKey: 'main', data: { toolCallId: 't1', ...data }, ...over });
        const asTool = (event: ReturnType<typeof readEvent>) => event as Extract<InboundEvent, { kind: 'toolUpdate' }>;

        it.each([
            ['start', tool({ phase: 'start', name: 'bash', args: { cmd: 'ls' } }), { status: 'running', details: '{\n  "cmd": "ls"\n}', awaitingApproval: null }],
            ['update', tool({ phase: 'update', partialResult: 'so' }), { status: 'running', details: 'so' }],
            ['result done', tool({ phase: 'result', result: 'ok' }), { status: 'done', details: 'ok', awaitingApproval: null }],
            ['result error', tool({ phase: 'result', isError: true, result: 'bad' }), expect.objectContaining({ status: 'error' })],
        ] as const)('maps a %s phase', (_label, payload, expected) => {
            expect(readEvent(Events.agent, payload)).toMatchObject(expected);
        });

        it('reads the same payload on session.tool and awaits an approval on a result phase', () => {
            const data = { phase: 'result', result: { details: { status: 'approval-pending' } } };
            expect(readEvent(Events.sessionTool, tool(data))).toMatchObject({ status: 'done', awaitingApproval: 'pending' });
        });

        it('reports an approval no one could be asked for as unavailable', () => {
            const data = { phase: 'result', result: { details: { failureKind: 'approval_required' } } };
            expect(readEvent(Events.agent, tool(data))).toMatchObject({ awaitingApproval: 'unavailable' });
            const errorData = { phase: 'result', result: { details: { error: 'cannot wait for interactive exec approval: headless' } } };
            expect(readEvent(Events.agent, tool(errorData))).toMatchObject({ awaitingApproval: 'unavailable' });
        });

        it('returns null without a tool stream, run fields, call id or known phase', () => {
            expect(readEvent(Events.agent, { runId: 'r1', seq: 1, data: { toolCallId: 't1', phase: 'start' } })).toBeNull();
            expect(readEvent(Events.agent, { stream: 'tool', data: { toolCallId: 't1', phase: 'start' } })).toBeNull();
            expect(readEvent(Events.agent, tool({ phase: 'start' }, { seq: 'x' }))).toBeNull();
            expect(readEvent(Events.agent, tool({ phase: 'start' }, { runId: '' }))).toBeNull();
            expect(readEvent(Events.agent, { stream: 'tool', runId: 'r1', seq: 1, data: { phase: 'start' } })).toBeNull();
            expect(readEvent(Events.agent, { stream: 'tool', runId: 'r1', seq: 1, data: { toolCallId: 't1' } })).toBeNull();
            expect(readEvent(Events.agent, tool({ phase: 'start' }, { sessionKey: 5 }))).toMatchObject({ sessionKey: null });
        });

        it('names an unnamed tool and caps serialized details', () => {
            expect(asTool(readEvent(Events.agent, tool({ phase: 'start' })))?.name).toBe('tool');
            const longArgs = { phase: 'start', args: { blob: 'x'.repeat(5000) } };
            const details = asTool(readEvent(Events.agent, tool(longArgs)))?.details ?? '';
            expect(details.length).toBe(4001);
            expect(details.startsWith('{')).toBe(true);
            expect(details.endsWith('…')).toBe(true);
        });
    });

    describe('chat.side_result', () => {
        it('carries the text and the error flag', () => {
            expect(readEvent(Events.chatSideResult, { ...run, text: 'note', isError: true })).toEqual({ kind: 'runSideResult', ...run, text: 'note', isError: true });
            expect(readEvent(Events.chatSideResult, { ...run, text: 'note' })).toEqual({ kind: 'runSideResult', ...run, text: 'note', isError: false });
            expect(readEvent(Events.chatSideResult, { ...run })).toBeNull();
            expect(readEvent(Events.chatSideResult, { ...run, text: 5 })).toBeNull();
        });
    });

    describe('plain events', () => {
        it('maps sessions.changed with or without a session key', () => {
            expect(readEvent(Events.sessionsChanged, { sessionKey: 'main' })).toEqual({ kind: 'sessionsChanged', sessionKey: 'main' });
            expect(readEvent(Events.sessionsChanged, {})).toEqual({ kind: 'sessionsChanged', sessionKey: null });
        });

        it('turns a session.message payload into a transcript event and drops an unusable one', () => {
            expect(readEvent(Events.sessionMessage, { sessionKey: 'main', message: { role: 'user', content: 'hi' } })).toMatchObject({ kind: 'transcriptMessage', sessionKey: 'main', message: { text: 'hi' } });
            expect(readEvent(Events.sessionMessage, { message: { role: 'user', content: 'hi' } })).toBeNull();
        });

        it('maps a tick to a keepalive whatever the payload', () => {
            expect(readEvent(Events.tick, {})).toEqual({ kind: 'keepalive' });
            expect(readEvent(Events.tick, 'junk')).toEqual({ kind: 'keepalive' });
        });

        it('maps shutdown with a capped restart wait and defaulted reason', () => {
            expect(readEvent(Events.shutdown, { reason: 'update', restartExpectedMs: 900 })).toEqual({ kind: 'shutdown', reason: 'update', restartExpectedMs: 900 });
            expect(readEvent(Events.shutdown, { restartExpectedMs: 1e12 })).toEqual({ kind: 'shutdown', reason: 'shutdown', restartExpectedMs: 5 * 60_000 });
            expect(readEvent(Events.shutdown, { restartExpectedMs: -3 })).toEqual({ kind: 'shutdown', reason: 'shutdown', restartExpectedMs: null });
            expect(readEvent(Events.shutdown, 'junk')).toEqual({ kind: 'shutdown', reason: 'shutdown', restartExpectedMs: null });
        });

        it('maps a connect challenge to its nonce and issued stamp', () => {
            expect(readEvent(Events.connectChallenge, { nonce: 'n-1', ts: 123 })).toEqual({ kind: 'challenge', nonce: 'n-1', issuedAtMs: 123 });
            expect(readEvent(Events.connectChallenge, {})).toEqual({ kind: 'challenge', nonce: null, issuedAtMs: null });
            expect(readEvent(Events.connectChallenge, { ts: -1 })).toMatchObject({ issuedAtMs: null });
        });
    });

    describe('unknown events fall through to the prompt reader', () => {
        it('reads an exec approval request', () => {
            const payload = { id: 'a1', createdAtMs: 100, expiresAtMs: 200, request: { command: 'ls', allowedDecisions: ['allow-once'] } };
            expect(readEvent(Events.execApprovalRequested, payload)).toMatchObject({ kind: 'promptRequested', prompt: { kind: 'approval', id: 'a1', subject: 'exec', title: 'ls', lifetimeMs: 100 } });
        });

        it('reads a question resolution', () => {
            expect(readEvent(Events.questionResolved, { id: 'q1', status: 'answered' })).toEqual({ kind: 'promptResolved', source: 'question', id: 'q1', outcome: 'answered' });
        });

        it('returns null for an event no reader consumes', () => {
            expect(readEvent('something.new', { id: 'x' })).toBeNull();
            expect(readEvent('something.new', 'junk')).toBeNull();
            expect(readEvent(Events.execApprovalRequested, 'junk')).toBeNull();
        });
    });
});
