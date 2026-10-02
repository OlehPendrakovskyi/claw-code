import type { TranscriptMessage } from '../core/gatewayProtocol/model';
import { TruncatedRowCompleter } from '../core/truncatedRows';

function cutRow(entryId: string, text = 'cut'): TranscriptMessage {
    return { role: 'assistant', text, entryId, seq: 1, runId: 'r1', usage: null, truncated: true };
}

describe('TruncatedRowCompleter', () => {
    describe('complete', () => {
        it('reads an entry once, even when its row is delivered again after the read settled', async () => {
            const readEntry = vi.fn(async (_sessionKey: string, entryId: string) => ({ ...cutRow(entryId, 'cut and the rest'), truncated: false }));
            const completer = new TruncatedRowCompleter(readEntry);
            const first = await completer.complete('main', cutRow('e1'));
            const again = await completer.complete('main', { ...cutRow('e1'), seq: 2 });
            expect(readEntry).toHaveBeenCalledTimes(1);
            expect(first).toMatchObject({ text: 'cut and the rest', truncated: false, seq: 1 });
            expect(again).toMatchObject({ text: 'cut and the rest', truncated: false, seq: 2 });
        });

        it('shares only the text with a row of the same entry delivered while the read runs', async () => {
            let finishRead: (row: TranscriptMessage) => void = () => undefined;
            const readEntry = vi.fn(() => new Promise<TranscriptMessage>((resolve) => (finishRead = resolve)));
            const completer = new TruncatedRowCompleter(readEntry);
            const first = completer.complete('main', cutRow('e1'));
            const again = completer.complete('main', { ...cutRow('e1'), seq: 2, runId: 'r2' });
            await Promise.resolve();
            finishRead({ ...cutRow('e1', 'cut and the rest'), truncated: false });
            await expect(first).resolves.toMatchObject({ text: 'cut and the rest', seq: 1, runId: 'r1' });
            await expect(again).resolves.toMatchObject({ text: 'cut and the rest', truncated: false, seq: 2, runId: 'r2' });
            expect(readEntry).toHaveBeenCalledTimes(1);
        });

        it('reads the entry again after a failed read', async () => {
            const readEntry = vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce({ ...cutRow('e1', 'cut and the rest'), truncated: false });
            const completer = new TruncatedRowCompleter(readEntry);
            expect(await completer.complete('main', cutRow('e1'))).toMatchObject({ text: 'cut', truncated: true });
            expect(await completer.complete('main', cutRow('e1'))).toMatchObject({ text: 'cut and the rest', truncated: false });
            expect(readEntry).toHaveBeenCalledTimes(2);
        });

        it('forgets completed entries when the endpoint is reset', async () => {
            const readEntry = vi.fn(async (_sessionKey: string, entryId: string) => ({ ...cutRow(entryId, 'cut and the rest'), truncated: false }));
            const completer = new TruncatedRowCompleter(readEntry);
            await completer.complete('main', cutRow('e1'));
            completer.reset();
            await completer.complete('main', cutRow('e1'));
            expect(readEntry).toHaveBeenCalledTimes(2);
        });

        it('does not remember a read that settles after a reset', async () => {
            let finishRead: (row: TranscriptMessage) => void = () => undefined;
            const readEntry = vi.fn().mockImplementationOnce(() => new Promise((resolve) => (finishRead = resolve))).mockResolvedValue(null);
            const completer = new TruncatedRowCompleter(readEntry);
            const stale = completer.complete('main', cutRow('e1'));
            await Promise.resolve();
            completer.reset();
            finishRead({ ...cutRow('e1', 'old endpoint text'), truncated: false });
            await stale;
            expect(await completer.complete('main', cutRow('e1'))).toMatchObject({ text: 'cut', truncated: true });
            expect(readEntry).toHaveBeenCalledTimes(2);
        });

        describe('a read slower than the render can wait', () => {
            beforeEach(() => vi.useFakeTimers());
            afterEach(() => vi.useRealTimers());

            function deferredReader() {
                const pending: Array<{ entryId: string; resolve: (row: TranscriptMessage | null) => void }> = [];
                const readEntry = vi.fn((_sessionKey: string, entryId: string) => new Promise<TranscriptMessage | null>((resolve) => pending.push({ entryId, resolve })));
                return { readEntry, pending };
            }

            it('renders the row as it came, but starts no other read of the session until the slow one settles', async () => {
                const { readEntry, pending } = deferredReader();
                const completer = new TruncatedRowCompleter(readEntry);
                const first = completer.complete('main', cutRow('e1'));
                await vi.advanceTimersByTimeAsync(10_000);
                await expect(first).resolves.toMatchObject({ text: 'cut', truncated: true });
                const second = completer.complete('main', cutRow('e2'));
                await vi.advanceTimersByTimeAsync(0);
                expect(readEntry).toHaveBeenCalledTimes(1);
                pending[0].resolve(null);
                await vi.advanceTimersByTimeAsync(0);
                expect(readEntry).toHaveBeenLastCalledWith('main', 'e2');
                pending[1].resolve({ ...cutRow('e2', 'cut and more'), truncated: false });
                await expect(second).resolves.toMatchObject({ text: 'cut and more' });
            });

            it('times a row from its arrival, even behind a slow read of another entry', async () => {
                const { readEntry } = deferredReader();
                const completer = new TruncatedRowCompleter(readEntry);
                void completer.complete('main', cutRow('e1'));
                const second = completer.complete('main', cutRow('e2'));
                await vi.advanceTimersByTimeAsync(10_000);
                await expect(second).resolves.toMatchObject({ text: 'cut', truncated: true });
            });

            it('remembers a full text that arrives after the render gave up on it', async () => {
                const { readEntry, pending } = deferredReader();
                const completer = new TruncatedRowCompleter(readEntry);
                const first = completer.complete('main', cutRow('e1'));
                await vi.advanceTimersByTimeAsync(10_000);
                await first;
                pending[0].resolve({ ...cutRow('e1', 'cut and the rest'), truncated: false });
                await vi.advanceTimersByTimeAsync(0);
                await expect(completer.complete('main', cutRow('e1'))).resolves.toMatchObject({ text: 'cut and the rest', truncated: false });
                expect(readEntry).toHaveBeenCalledTimes(1);
            });
        });
    });
});
