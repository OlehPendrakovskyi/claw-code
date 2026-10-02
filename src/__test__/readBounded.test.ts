import { Buffer } from 'node:buffer';
import { readBoundedAsync, readBoundedSync } from '../core/readBounded';

const CONTENT = 'abcdefghijkl'; // 12 bytes, so a 10-byte cap has a byte past it to find
const CAP = 10;

/** A reader that hands over at most `chunk` bytes per call, whatever the
 *  buffer size, so the loop's continue-after-a-short-read is what completes
 *  the file rather than a single read filling the request. The sizes it
 *  returned are recorded so the EOF read can be asserted, not just its count. */
function shortAsyncReader(chunk: number) {
    const sizes: number[] = [];
    const read = async (buffer: Buffer, _offset: number, _length: number, position: number): Promise<{ bytesRead: number }> => {
        const bytesRead = Math.max(0, Math.min(chunk, buffer.length, CONTENT.length - position));
        CONTENT.slice(position, position + bytesRead).split('').forEach((char, i) => { buffer[i] = char.charCodeAt(0); });
        sizes.push(bytesRead);
        return { bytesRead };
    };
    return { handle: { read }, sizes };
}

/** The blocking twin of {@link shortAsyncReader}. */
function shortSyncReader(chunk: number) {
    const sizes: number[] = [];
    const read = (buffer: Buffer, offset: number, length: number, position: number): number => {
        const bytesRead = Math.max(0, Math.min(chunk, length, CONTENT.length - position));
        CONTENT.slice(position, position + bytesRead).split('').forEach((char, i) => { buffer[offset + i] = char.charCodeAt(0); });
        sizes.push(bytesRead);
        return bytesRead;
    };
    return { read, sizes };
}

describe('readBoundedAsync', () => {
    it('keeps reading past a short read until the file is drained', async () => {
        const { handle, sizes } = shortAsyncReader(3);
        const bytes = await readBoundedAsync(handle, CONTENT.length, CONTENT.length);
        expect(bytes.toString()).toBe(CONTENT);
        expect(sizes.length).toBeGreaterThan(1);
        expect(Math.max(...sizes)).toBeLessThan(CAP);
    });

    it('stops on the zero-length read that ends the file', async () => {
        const { handle, sizes } = shortAsyncReader(4);
        await readBoundedAsync(handle, CONTENT.length, CONTENT.length);
        // 3 reads of 4/4/4 bytes over 12, then the read that reports EOF.
        expect(sizes).toEqual([4, 4, 4, 0]);
    });

    it('returns one byte past the cap so the caller can refuse the file', async () => {
        const { handle } = shortAsyncReader(2);
        const bytes = await readBoundedAsync(handle, CAP, CAP);
        expect(bytes.length).toBe(CAP + 1);
    });
});

describe('readBoundedSync', () => {
    it('keeps reading past a short read until the file is drained', async () => {
        const { read, sizes } = shortSyncReader(3);
        const bytes = readBoundedSync(read, CONTENT.length, CONTENT.length);
        expect(bytes.toString()).toBe(CONTENT);
        expect(sizes.length).toBeGreaterThan(1);
        expect(Math.max(...sizes)).toBeLessThan(CAP);
    });

    it('stops on the zero-length read that ends the file', async () => {
        const { read, sizes } = shortSyncReader(4);
        readBoundedSync(read, CONTENT.length, CONTENT.length);
        // 3 reads of 4/4/4 bytes over 12, then the read that reports EOF.
        expect(sizes).toEqual([4, 4, 4, 0]);
    });

    it('returns one byte past the cap so the caller can refuse the file', () => {
        const { read } = shortSyncReader(2);
        expect(readBoundedSync(read, CAP, CAP).length).toBe(CAP + 1);
    });

    it('stops at the stat size plus one, so growth below the cap reads short', () => {
        const { read } = shortSyncReader(3);
        // The stat that sized the buffer saw 4 bytes; the file is 12 now, still
        // under the cap. The sync form cannot read to EOF, so it returns what
        // its allocation holds and the caller re-checks the length.
        const bytes = readBoundedSync(read, CONTENT.length, 4);
        expect(bytes.length).toBe(5);
    });
});
