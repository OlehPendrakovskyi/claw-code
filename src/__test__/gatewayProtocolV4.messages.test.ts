import { toTranscriptMessage, displayText, readSessionList, readSessionMessage, readUsage } from '../core/gatewayProtocol/v4/messages';
import { TRUNCATION_MARKER } from '../core/gatewayProtocol/v4/schema';

describe('gateway protocol v4 message readers', () => {
    describe('displayText', () => {
        it('reads string content, text blocks and a bare text field', () => {
            expect(displayText({ content: 'hello' })).toBe('hello');
            expect(displayText({ content: [{ type: 'text', text: 'a' }, { type: 'image', text: 'ignored' }, { type: 'text', text: 'b' }] })).toBe('ab');
            expect(displayText({ content: [] })).toBe('');
            expect(displayText({ text: 'plain' })).toBe('plain');
        });

        it('returns an empty string for malformed input and non-text blocks', () => {
            expect(displayText('junk')).toBe('');
            expect(displayText(null)).toBe('');
            expect(displayText(undefined)).toBe('');
            expect(displayText(5)).toBe('');
            expect(displayText({ content: [{ type: 'image' }] })).toBe('');
            expect(displayText({ content: [{ text: 7 }] })).toBe('');
            expect(displayText({ text: 7 })).toBe('');
            expect(displayText({})).toBe('');
        });
    });

    describe('readUsage', () => {
        it.each([
            ['input/output', { input: 3, output: 4 }, { promptTokens: 3, completionTokens: 4, totalTokens: 7 }],
            ['camelCase', { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, { promptTokens: 1, completionTokens: 2, totalTokens: 3 }],
            ['legacy camel', { promptTokens: 5, completionTokens: 6 }, { promptTokens: 5, completionTokens: 6, totalTokens: 11 }],
            ['snake_case', { input_tokens: 2, output_tokens: 3, total_tokens: 5 }, { promptTokens: 2, completionTokens: 3, totalTokens: 5 }],
            ['legacy snake', { prompt_tokens: 7, completion_tokens: 8 }, { promptTokens: 7, completionTokens: 8, totalTokens: 15 }],
            ['total only', { totalTokens: 9 }, { promptTokens: 0, completionTokens: 0, totalTokens: 9 }],
            ['total_tokens alias', { total: 9 }, { promptTokens: 0, completionTokens: 0, totalTokens: 9 }],
        ])('reads the %s spelling', (_label, value, expected) => {
            expect(readUsage(value)).toEqual(expected);
        });

        it('prefers the first spelling that yields a non-negative count', () => {
            expect(readUsage({ input: -1, inputTokens: 2, outputTokens: 3 })).toEqual({ promptTokens: 2, completionTokens: 3, totalTokens: 5 });
        });

        it('returns null without any counts, and nulls negative-only counts', () => {
            expect(readUsage({})).toBeNull();
            expect(readUsage({ input: 0, output: 0 })).toBeNull();
            expect(readUsage({ input: -1, output: -2 })).toBeNull();
        });

        it('returns null for non-records', () => {
            for (const junk of [undefined, null, 'x', 5, [], true]) {
                expect(readUsage(junk)).toBeNull();
            }
        });
    });

    describe('toTranscriptMessage', () => {
        it('reads role, text, ids and usage of a plain row', () => {
            expect(toTranscriptMessage({ role: 'user', content: 'hi', __openclaw: { id: 'row-1', seq: 4 } })).toEqual({
                role: 'user',
                text: 'hi',
                entryId: 'row-1',
                seq: 4,
                runId: null,
                usage: null,
                truncated: false,
            });
        });

        it('reads usage only on assistant rows', () => {
            expect(toTranscriptMessage({ role: 'assistant', content: 'x', usage: { input: 2, output: 3 } })?.usage).toEqual({ promptTokens: 2, completionTokens: 3, totalTokens: 5 });
            expect(toTranscriptMessage({ role: 'user', content: 'x', usage: { input: 2, output: 3 } })?.usage).toBeNull();
        });

        it('cuts a truncation marker out of the text and flags it', () => {
            const message = toTranscriptMessage({ role: 'assistant', content: `before${TRUNCATION_MARKER}` });
            expect(message).toMatchObject({ text: 'before', truncated: true });
        });

        it('keeps the marker text intact when only meta says truncated', () => {
            const text = `keep${TRUNCATION_MARKER}`;
            expect(toTranscriptMessage({ role: 'assistant', content: text, __openclaw: { truncated: true } })).toMatchObject({ truncated: true });
            expect(toTranscriptMessage({ role: 'assistant', content: text })).toMatchObject({ truncated: true });
        });

        it('maps unknown roles to other', () => {
            expect(toTranscriptMessage({ role: 'tool', content: 'x' })?.role).toBe('other');
            expect(toTranscriptMessage({ content: 'x' })?.role).toBe('other');
        });

        it('strips the role suffixes from an idempotency key, preferring envelope ids', () => {
            expect(toTranscriptMessage({ role: 'user', content: 'x', __openclaw: { idempotencyKey: 'run-1:user' } })?.runId).toBe('run-1');
            expect(toTranscriptMessage({ role: 'assistant', content: 'x', __openclaw: { idempotencyKey: 'run-1:assistant' } })?.runId).toBe('run-1');
            expect(toTranscriptMessage({ role: 'user', content: 'x', __openclaw: { idempotencyKey: 'run-1' } })?.runId).toBe('run-1');
            expect(toTranscriptMessage({ role: 'user', content: 'x', __openclaw: { idempotencyKey: 'run-1:user', runId: 'real' } })?.runId).toBe('real');
            expect(toTranscriptMessage({ role: 'user', content: 'x', __openclaw: { idempotencyKey: 'run-1:user' } }, { runId: 'envelope' })?.runId).toBe('envelope');
        });

        it('prefers an envelope messageSeq over the meta one and rejects junk seqs', () => {
            expect(toTranscriptMessage({ role: 'user', content: 'x', __openclaw: { seq: 7 } }, { messageSeq: 9 })?.seq).toBe(9);
            expect(toTranscriptMessage({ role: 'user', content: 'x', __openclaw: { seq: 7 } }, { messageSeq: -1 })?.seq).toBe(7);
            expect(toTranscriptMessage({ role: 'user', content: 'x', __openclaw: { seq: 'junk' } })?.seq).toBeNull();
        });

        it('returns null for non-records', () => {
            for (const junk of [undefined, null, 'x', 5, []]) {
                expect(toTranscriptMessage(junk)).toBeNull();
            }
        });
    });

    describe('readSessionMessage', () => {
        it('pairs a session key with its transcript row', () => {
            expect(readSessionMessage({ sessionKey: 'main', message: { role: 'user', content: 'hi' } })).toMatchObject({
                sessionKey: 'main',
                message: { text: 'hi', role: 'user' },
            });
        });

        it('returns null without a session key or a usable message', () => {
            expect(readSessionMessage({ message: { role: 'user', content: 'hi' } })).toBeNull();
            expect(readSessionMessage({ sessionKey: 'main', message: 'junk' })).toBeNull();
            expect(readSessionMessage({ sessionKey: 5, message: { role: 'user', content: 'hi' } })).toBeNull();
            expect(readSessionMessage('junk')).toBeNull();
            expect(readSessionMessage(null)).toBeNull();
        });
    });

    describe('readSessionList', () => {
        const row = (over: object = {}) => ({ key: 'main', label: 'Main', agentId: 'main', hasActiveRun: false, lastActivityAt: 10, ...over });

        it('reads a page with its next offset only when more rows follow', () => {
            expect(readSessionList({ sessions: [row()], hasMore: true, nextOffset: 3 })).toEqual({
                sessions: [{ key: 'main', label: 'Main', agentId: 'main', hasActiveRun: false, lastActivityMs: 10, cold: false }],
                nextOffset: 3,
            });
            expect(readSessionList({ sessions: [row()], hasMore: false, nextOffset: 3 })?.nextOffset).toBeNull();
            expect(readSessionList({ sessions: [row()] })?.nextOffset).toBeNull();
            expect(readSessionList({ sessions: [row()], hasMore: true })?.nextOffset).toBeNull();
        });

        it('drops rows without a key and keeps the rest', () => {
            const page = readSessionList({ sessions: [row(), row({ key: '' }), 'junk', row({ key: 'second' })] });
            expect(page?.sessions.map((session) => session.key)).toEqual(['main', 'second']);
        });

        it('marks a session cold on any placement outside the warm states', () => {
            expect(readSessionList({ sessions: [row({ placement: { state: 'local' } })] })?.sessions[0]?.cold).toBe(false);
            expect(readSessionList({ sessions: [row({ placement: { state: 'active' } })] })?.sessions[0]?.cold).toBe(false);
            expect(readSessionList({ sessions: [row({ placement: { state: 'archived' } })] })?.sessions[0]?.cold).toBe(true);
            expect(readSessionList({ sessions: [row({ placement: 'junk' })] })?.sessions[0]?.cold).toBe(false);
        });

        it('takes the latest of the three activity stamps and tolerates absent ones', () => {
            expect(readSessionList({ sessions: [row({ lastActivityAt: 10, lastInteractionAt: 30, updatedAt: 20 })] })?.sessions[0]?.lastActivityMs).toBe(30);
            expect(readSessionList({ sessions: [row({ lastActivityAt: 'x', lastInteractionAt: null, updatedAt: 20 })] })?.sessions[0]?.lastActivityMs).toBe(20);
            expect(readSessionList({ sessions: [row({ lastActivityAt: undefined, lastInteractionAt: undefined, updatedAt: undefined })] })?.sessions[0]?.lastActivityMs).toBeNull();
        });

        it('falls back to displayName and flags an active run from the id list', () => {
            expect(readSessionList({ sessions: [row({ label: undefined, displayName: 'Shown' })] })?.sessions[0]?.label).toBe('Shown');
            expect(readSessionList({ sessions: [row({ hasActiveRun: false, activeRunIds: ['r1'] })] })?.sessions[0]?.hasActiveRun).toBe(true);
            expect(readSessionList({ sessions: [row({ hasActiveRun: true })] })?.sessions[0]?.hasActiveRun).toBe(true);
        });

        it('returns null when the payload is not a list', () => {
            for (const junk of [undefined, null, 'x', 5, {}, { sessions: 'no' }]) {
                expect(readSessionList(junk)).toBeNull();
            }
        });
    });
});
