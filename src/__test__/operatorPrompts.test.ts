import type { OperatorPrompt } from '../core/gatewayProtocol/model';
import { OperatorPromptBoard, type PromptChange } from '../core/operatorPrompts';

const NOW = 1_790_000_000_000;

function approval(id: string, expiresAtMs = NOW + 60_000): OperatorPrompt {
    return { kind: 'approval', id, subject: 'exec', title: 'ls', details: [], decisions: ['allow-once', 'deny'], sessionKey: 'agent:dev:main', runId: null, expiresAtMs };
}

function question(id: string): OperatorPrompt {
    return { kind: 'question', id, questions: [], sessionKey: 'agent:dev:main', runId: null, expiresAtMs: NOW + 60_000 };
}

function board(): { board: OperatorPromptBoard; changes: PromptChange[] } {
    const changes: PromptChange[] = [];
    const prompts = new OperatorPromptBoard(() => Date.now());
    prompts.subscribe((change) => changes.push(change));
    return { board: prompts, changes };
}

describe('OperatorPromptBoard', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(NOW);
    });

    afterEach(() => jest.useRealTimers());

    describe('add and settle', () => {
        it('announces a prompt once and settles it once', () => {
            const { board: prompts, changes } = board();
            prompts.add(approval('a1'));
            prompts.add(approval('a1'));
            prompts.settle('a1', 'deny');
            prompts.settle('a1', 'allow-once');
            expect(changes).toEqual([{ type: 'requested', prompt: approval('a1') }, { type: 'resolved', id: 'a1', outcome: 'deny' }]);
        });

        it('ignores a prompt already past its deadline', () => {
            const { board: prompts, changes } = board();
            prompts.add(approval('a1', NOW));
            expect(changes).toEqual([]);
        });

        it('expires a prompt whose deadline lies beyond one timer period', () => {
            const { board: prompts, changes } = board();
            const farDeadline = NOW + 2 ** 31 + 10_000;
            prompts.add(approval('a1', farDeadline));
            jest.advanceTimersByTime(2 ** 31 - 1);
            expect(changes).toHaveLength(1);
            jest.advanceTimersByTime(20_000);
            expect(changes[1]).toEqual({ type: 'resolved', id: 'a1', outcome: 'expired' });
        });

        it('withdraws only the kinds asked for', () => {
            const { board: prompts, changes } = board();
            prompts.add(approval('a1'));
            prompts.add(question('q1'));
            prompts.withdraw(['question']);
            expect(changes.slice(2)).toEqual([{ type: 'resolved', id: 'q1', outcome: 'withdrawn' }]);
            expect(prompts.get('a1')).toBeDefined();
        });
    });

    describe('backfill', () => {
        it('does not resurrect a prompt resolved while the list was read', () => {
            const { board: prompts, changes } = board();
            prompts.add(approval('a1'));
            const backfill = prompts.beginBackfill();
            prompts.settle('a1', 'deny');
            prompts.finishBackfill(backfill, [approval('a1')], ['approval']);
            expect(changes.map((change) => change.type)).toEqual(['requested', 'resolved']);
        });

        it('leaves questions alone when only approvals were listed', () => {
            const { board: prompts } = board();
            prompts.add(question('q1'));
            prompts.finishBackfill(prompts.beginBackfill(), [], ['approval']);
            expect(prompts.get('q1')).toBeDefined();
        });

        it('drops a backfill a newer one superseded', () => {
            const { board: prompts, changes } = board();
            const older = prompts.beginBackfill();
            prompts.beginBackfill();
            prompts.finishBackfill(older, [approval('a1')], ['approval']);
            expect(changes).toEqual([]);
        });
    });
});
