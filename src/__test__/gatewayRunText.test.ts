/**
 * The append-only reducer of streamed gateway run text.
 */

import { applyAborted, applyDelta, applyFinal, BoundedSet, newRunText } from '../core/gatewayRunText';
import type { RunDelta } from '../core/gatewayRunText';

function delta(seq: number, deltaText: string, opts: Partial<RunDelta> = {}): RunDelta {
    return { seq, deltaText, replace: false, snapshotText: null, ...opts };
}

describe('gatewayRunText', () => {
    describe('applyDelta', () => {
        it('appends suffix deltas', () => {
            const run = newRunText();
            expect(applyDelta(run, delta(1, 'Echo:'))).toBe('Echo:');
            expect(applyDelta(run, delta(2, '  Activ'))).toBe('  Activ');
            expect(run.rendered).toBe('Echo:  Activ');
        });

        it('prefers the cumulative snapshot, recovering a dropped delta', () => {
            const run = newRunText();
            applyDelta(run, delta(1, 'Echo:', { snapshotText: 'Echo:' }));
            expect(applyDelta(run, delta(3, 'ive', { snapshotText: 'Echo:  Active' }))).toBe('  Active');
        });

        it('drops stale and repeated sequences', () => {
            const run = newRunText();
            applyDelta(run, delta(5, 'a'));
            expect(applyDelta(run, delta(5, 'a'))).toBeNull();
            expect(applyDelta(run, delta(4, 'b'))).toBeNull();
            expect(run.rendered).toBe('a');
        });

        it('emits the rest of a replacement that extends the shown text', () => {
            const run = newRunText();
            applyDelta(run, delta(1, 'hel'));
            expect(applyDelta(run, delta(2, 'hello', { replace: true }))).toBe('lo');
            expect(run.held).toBeNull();
        });

        it('holds a replacement that diverges, and builds later deltas on it', () => {
            const run = newRunText();
            applyDelta(run, delta(1, 'hello'));
            expect(applyDelta(run, delta(2, 'goodbye', { replace: true }))).toBe('');
            expect(run.held).toBe('goodbye');
            expect(applyDelta(run, delta(3, ' now'))).toBe('');
            expect(run).toMatchObject({ rendered: 'hello', held: 'goodbye now' });
        });
    });

    describe('applyFinal', () => {
        it('emits the unrendered rest of the final text', () => {
            const run = newRunText();
            applyDelta(run, delta(1, 'Echo:'));
            expect(applyFinal(run, 'Echo: done')).toBe(' done');
        });

        it('emits a diverging final text in full after a separator', () => {
            const run = newRunText();
            applyDelta(run, delta(1, 'draft'));
            expect(applyFinal(run, 'final answer')).toBe('\n\nfinal answer');
            expect(run.rendered).toBe('final answer');
        });

        it('settles held text when the final carries no message', () => {
            const run = newRunText();
            applyDelta(run, delta(1, 'hello'));
            applyDelta(run, delta(2, 'goodbye', { replace: true }));
            expect(applyFinal(run, null)).toBe('\n\ngoodbye');
        });

        it('emits nothing without any text', () => {
            expect(applyFinal(newRunText(), null)).toBe('');
            expect(applyFinal(newRunText(), '')).toBe('');
        });
    });

    describe('applyAborted', () => {
        it('adds only a clean extension of the shown text', () => {
            const run = newRunText();
            applyDelta(run, delta(1, 'part'));
            expect(applyAborted(run, 'partial')).toBe('ial');
            expect(applyAborted(run, 'other')).toBe('');
            expect(applyAborted(run, null)).toBe('');
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
