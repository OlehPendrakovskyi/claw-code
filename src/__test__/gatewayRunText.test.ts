/**
 * The reducer of streamed gateway run text into append and replace updates.
 */

import { applyAborted, applyDelta, applyFinal, BoundedSet, newRunText } from '../core/gatewayRunText';
import type { RunDelta } from '../core/gatewayRunText';

function delta(seq: number, deltaText: string, opts: Partial<RunDelta> = {}): RunDelta {
    return { seq, deltaText, replace: false, snapshotText: null, ...opts };
}

describe('gatewayRunText', () => {
    const append = (text: string) => ({ kind: 'append', text });
    const replace = (text: string) => ({ kind: 'replace', text });

    describe('applyDelta', () => {
        it('appends suffix deltas', () => {
            const run = newRunText();
            expect(applyDelta(run, delta(1, 'Echo:'))).toEqual(append('Echo:'));
            expect(applyDelta(run, delta(2, '  Activ'))).toEqual(append('  Activ'));
            expect(run.rendered).toBe('Echo:  Activ');
        });

        it('prefers the cumulative snapshot, recovering a dropped delta', () => {
            const run = newRunText();
            applyDelta(run, delta(1, 'Echo:', { snapshotText: 'Echo:' }));
            expect(applyDelta(run, delta(3, 'ive', { snapshotText: 'Echo:  Active' }))).toEqual(append('  Active'));
        });

        it('drops stale and repeated sequences', () => {
            const run = newRunText();
            applyDelta(run, delta(5, 'a'));
            expect(applyDelta(run, delta(5, 'a'))).toBeNull();
            expect(applyDelta(run, delta(4, 'b'))).toBeNull();
            expect(run.rendered).toBe('a');
        });

        it('appends the rest of a replacement that extends the shown text', () => {
            const run = newRunText();
            applyDelta(run, delta(1, 'hel'));
            expect(applyDelta(run, delta(2, 'hello', { replace: true }))).toEqual(append('lo'));
        });

        it('replaces the shown text with a replacement that diverges, and appends later deltas to it', () => {
            const run = newRunText();
            applyDelta(run, delta(1, 'hello'));
            expect(applyDelta(run, delta(2, 'goodbye', { replace: true }))).toEqual(replace('goodbye'));
            expect(applyDelta(run, delta(3, ' now'))).toEqual(append(' now'));
            expect(run.rendered).toBe('goodbye now');
        });
    });

    describe('applyFinal', () => {
        it('appends the unrendered rest of the final text', () => {
            const run = newRunText();
            applyDelta(run, delta(1, 'Echo:'));
            expect(applyFinal(run, 'Echo: done')).toEqual(append(' done'));
        });

        it('replaces the shown text with a diverging final text, once', () => {
            const run = newRunText();
            applyDelta(run, delta(1, 'draft'));
            expect(applyFinal(run, 'final answer')).toEqual(replace('final answer'));
            expect(run.rendered).toBe('final answer');
        });

        it('changes nothing without any text', () => {
            expect(applyFinal(newRunText(), null)).toEqual(append(''));
            expect(applyFinal(newRunText(), '')).toEqual(append(''));
        });
    });

    describe('applyAborted', () => {
        it('adds only a clean extension of the shown text', () => {
            const run = newRunText();
            applyDelta(run, delta(1, 'part'));
            expect(applyAborted(run, 'partial')).toEqual(append('ial'));
            expect(applyAborted(run, 'other')).toEqual(append(''));
            expect(applyAborted(run, null)).toEqual(append(''));
            expect(run.rendered).toBe('partial');
        });
    });

    describe('BoundedSet', () => {
        it('forgets the oldest entry beyond its limit', () => {
            const set = new BoundedSet<string>(2);
            set.add('a');
            set.add('b');
            set.add('c');
            expect([set.has('a'), set.has('b'), set.has('c')]).toEqual([false, true, true]);
        });

        it('treats a re-added entry as the newest', () => {
            const set = new BoundedSet<string>(2);
            set.add('a');
            set.add('b');
            set.add('a');
            set.add('c');
            expect([set.has('a'), set.has('b'), set.has('c')]).toEqual([true, false, true]);
        });

        it('deletes and clears', () => {
            const set = new BoundedSet<number>(3);
            set.add(1);
            set.add(2);
            set.delete(1);
            expect(set.has(1)).toBe(false);
            set.clear();
            expect(set.has(2)).toBe(false);
        });
    });
});
