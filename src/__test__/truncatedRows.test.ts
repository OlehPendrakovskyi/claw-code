import type { TranscriptMessage } from '../core/gatewayProtocol/model';
import { TruncatedRowCompleter } from '../core/truncatedRows';

function cutRow(entryId: string, text = 'cut'): TranscriptMessage {
    return { role: 'assistant', text, entryId, seq: 1, runId: 'r1', usage: null, truncated: true };
}

describe('TruncatedRowCompleter', () => {
    describe('complete', () => {
        it('reads an entry once, even when its row is delivered again after the read settled', async () => {
            const readEntry = jest.fn(async (_sessionKey: string, entryId: string) => ({ ...cutRow(entryId, 'cut and the rest'), truncated: false }));
            const completer = new TruncatedRowCompleter(readEntry);
            const first = await completer.complete('main', cutRow('e1'));
            const again = await completer.complete('main', { ...cutRow('e1'), seq: 2 });
            expect(readEntry).toHaveBeenCalledTimes(1);
            expect(first).toMatchObject({ text: 'cut and the rest', truncated: false, seq: 1 });
            expect(again).toMatchObject({ text: 'cut and the rest', truncated: false, seq: 2 });
        });

        it('reads the entry again after a failed read', async () => {
            const readEntry = jest.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValueOnce({ ...cutRow('e1', 'cut and the rest'), truncated: false });
            const completer = new TruncatedRowCompleter(readEntry);
            expect(await completer.complete('main', cutRow('e1'))).toMatchObject({ text: 'cut', truncated: true });
            expect(await completer.complete('main', cutRow('e1'))).toMatchObject({ text: 'cut and the rest', truncated: false });
            expect(readEntry).toHaveBeenCalledTimes(2);
        });

        it('forgets completed entries when the endpoint is reset', async () => {
            const readEntry = jest.fn(async (_sessionKey: string, entryId: string) => ({ ...cutRow(entryId, 'cut and the rest'), truncated: false }));
            const completer = new TruncatedRowCompleter(readEntry);
            await completer.complete('main', cutRow('e1'));
            completer.reset();
            await completer.complete('main', cutRow('e1'));
            expect(readEntry).toHaveBeenCalledTimes(2);
        });

        it('does not remember a read that settles after a reset', async () => {
            let finishRead: (row: TranscriptMessage) => void = () => undefined;
            const readEntry = jest.fn().mockImplementationOnce(() => new Promise((resolve) => (finishRead = resolve))).mockResolvedValue(null);
            const completer = new TruncatedRowCompleter(readEntry);
            const stale = completer.complete('main', cutRow('e1'));
            await Promise.resolve();
            completer.reset();
            finishRead({ ...cutRow('e1', 'old endpoint text'), truncated: false });
            await stale;
            expect(await completer.complete('main', cutRow('e1'))).toMatchObject({ text: 'cut', truncated: true });
            expect(readEntry).toHaveBeenCalledTimes(2);
        });
    });
});
