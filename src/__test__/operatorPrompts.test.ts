import type { OperatorPrompt } from '../core/gatewayProtocol/model';
import { MAX_PENDING_PER_KIND, OperatorPromptBoard, type PromptChange } from '../core/operatorPrompts';

const NOW = 1_790_000_000_000;

function approval(id: string, lifetimeMs = 60_000): OperatorPrompt {
    return { kind: 'approval', id, subject: 'exec', title: 'ls', details: [], decisions: ['allow-once', 'deny'], sessionKey: 'agent:dev:main', runId: null, lifetimeMs };
}

function pluginApproval(id: string): OperatorPrompt {
    return { kind: 'approval', id, subject: 'plugin', title: 'Write', details: [], decisions: ['allow-once', 'deny'], sessionKey: 'agent:dev:main', runId: null, lifetimeMs: 60_000 };
}

function question(id: string): OperatorPrompt {
    return { kind: 'question', id, questions: [], sessionKey: 'agent:dev:main', runId: null, lifetimeMs: 60_000 };
}

function board(onOverflow = jest.fn()): { board: OperatorPromptBoard; changes: PromptChange[] } {
    const changes: PromptChange[] = [];
    const prompts = new OperatorPromptBoard({ now: () => Date.now(), onOverflow });
    prompts.subscribe((change) => changes.push(change));
    return { board: prompts, changes };
}

function resolvedOf(changes: PromptChange[]): Array<[string, string]> {
    return changes.flatMap((change): Array<[string, string]> => (change.type === 'resolved' ? [[change.key, change.outcome]] : []));
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
            prompts.settle('exec:a1', 'deny');
            prompts.settle('exec:a1', 'allow-once');
            expect(changes).toEqual([{ type: 'requested', key: 'exec:a1', prompt: approval('a1'), expiresAtMs: NOW + 60_000 }, { type: 'resolved', key: 'exec:a1', outcome: 'deny' }]);
        });

        it('times a prompt from its receipt for the lifetime the gateway gave it', () => {
            const { board: prompts, changes } = board();
            prompts.add(approval('a1', 5000));
            jest.advanceTimersByTime(4999);
            expect(resolvedOf(changes)).toEqual([]);
            jest.advanceTimersByTime(1);
            expect(resolvedOf(changes)).toEqual([['exec:a1', 'expired']]);
        });

        it('expires a prompt whose deadline lies beyond one timer period', () => {
            const { board: prompts, changes } = board();
            prompts.add(approval('a1', 2 ** 31 + 10_000));
            jest.advanceTimersByTime(2 ** 31 - 1);
            expect(changes).toHaveLength(1);
            jest.advanceTimersByTime(20_000);
            expect(changes[1]).toEqual({ type: 'resolved', key: 'exec:a1', outcome: 'expired' });
        });

        it('withdraws the oldest prompt of a kind once it holds as many as it keeps, and says so', () => {
            const onOverflow = jest.fn();
            const { board: prompts, changes } = board(onOverflow);
            for (let i = 0; i <= MAX_PENDING_PER_KIND; i++) prompts.add(approval(`a${i}`));
            prompts.add(question('q1'));
            expect(resolvedOf(changes)).toEqual([['exec:a0', 'withdrawn']]);
            expect(onOverflow).toHaveBeenCalledTimes(1);
        });

        it('keeps prompts of different sources apart, though they share an id', () => {
            const { board: prompts, changes } = board();
            prompts.add(approval('x1'));
            prompts.add(pluginApproval('x1'));
            prompts.add(question('x1'));
            prompts.settle('plugin:x1', 'deny');
            expect(changes.map((change) => change.key)).toEqual(['exec:x1', 'plugin:x1', 'question:x1', 'plugin:x1']);
            expect(prompts.get('exec:x1')).toBeDefined();
            expect(prompts.get('question:x1')).toBeDefined();
        });

        it('withdraws only the kinds asked for', () => {
            const { board: prompts, changes } = board();
            prompts.add(approval('a1'));
            prompts.add(question('q1'));
            prompts.withdraw(['question']);
            expect(changes.slice(2)).toEqual([{ type: 'resolved', key: 'question:q1', outcome: 'withdrawn' }]);
            expect(prompts.get('exec:a1')).toBeDefined();
        });
    });

    describe('backfill', () => {
        it('does not resurrect a prompt resolved while the list was read', () => {
            const { board: prompts, changes } = board();
            prompts.add(approval('a1'));
            const backfill = prompts.beginBackfill();
            prompts.settle('exec:a1', 'deny');
            prompts.finishBackfill(backfill, [approval('a1')], ['exec']);
            expect(changes.map((change) => change.type)).toEqual(['requested', 'resolved']);
        });

        it('leaves questions alone when only approvals were listed', () => {
            const { board: prompts } = board();
            prompts.add(question('q1'));
            prompts.finishBackfill(prompts.beginBackfill(), [], ['exec']);
            expect(prompts.get('question:q1')).toBeDefined();
        });

        it('settles a prompt answered before its reply was lost with that answer, once the list no longer has it', () => {
            const { board: prompts, changes } = board();
            prompts.add(approval('a1'));
            prompts.add(approval('a2'));
            prompts.noteSubmission('exec:a1', 'allow-once');
            prompts.noteSubmission('exec:a2', 'deny');
            prompts.finishBackfill(prompts.beginBackfill(), [approval('a2')], ['exec']);
            expect(resolvedOf(changes)).toEqual([['exec:a1', 'allow-once']]);
            prompts.finishBackfill(prompts.beginBackfill(), [], ['exec']);
            expect(resolvedOf(changes)).toEqual([['exec:a1', 'allow-once'], ['exec:a2', 'withdrawn']]);
        });

        it('settles only the sources whose list was read', () => {
            const { board: prompts, changes } = board();
            prompts.add(approval('a1'));
            prompts.add(pluginApproval('p1'));
            prompts.finishBackfill(prompts.beginBackfill(), [], ['exec']);
            expect(resolvedOf(changes)).toEqual([['exec:a1', 'withdrawn']]);
            expect(prompts.get('plugin:p1')).toBeDefined();
        });

        it('drops a backfill cancelled before it finished', () => {
            const { board: prompts, changes } = board();
            const backfill = prompts.beginBackfill();
            prompts.cancelBackfill();
            prompts.finishBackfill(backfill, [approval('a1')], ['exec']);
            expect(changes).toEqual([]);
        });

        it('drops a backfill a newer one superseded', () => {
            const { board: prompts, changes } = board();
            const older = prompts.beginBackfill();
            prompts.beginBackfill();
            prompts.finishBackfill(older, [approval('a1')], ['exec']);
            expect(changes).toEqual([]);
        });
    });
});
