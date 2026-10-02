/**
 * Claw Code — the bounded read loop shared by the file readers.
 *
 * Readers differ in how much they trust the file they were handed: the
 * attachment reader re-checks a verified handle, the acpx config reader
 * follows symlinks on purpose. That policy stays with each caller. What they
 * share is the mechanics of draining a descriptor, and that part is here so
 * the "a single read() may come up short" rule is written down once.
 */

import { Buffer } from 'node:buffer';

/** Chunk size for the reads after the first, once the file's size is known. */
const FOLLOW_UP_CHUNK_BYTES = 64 * 1024;

/**
 * Drain a descriptor into a buffer, stopping at EOF or one byte past the cap.
 *
 * A single read() is not guaranteed to fill the buffer it is given, so a
 * one-shot read can accept a truncated file or let a file that grew past the
 * cap slip through — the short result lands under the limit. Both readers
 * therefore loop, and both compare the outcome against their own cap
 * themselves: the returned buffer may hold `maxBytes + 1` bytes, which is the
 * caller's signal to refuse the file.
 *
 * `firstChunkBytes` sizes the opening read from the caller's stat result, so a
 * small file never allocates the whole cap; later reads use a fixed chunk.
 */
async function collect(
    read: (buffer: Buffer, offset: number) => Promise<number>,
    maxBytes: number,
    firstChunkBytes: number,
): Promise<Buffer> {
    const limit = maxBytes + 1;
    const chunks: Buffer[] = [];
    let total = 0;
    let chunkSize = Math.min(limit, firstChunkBytes);
    while (total < limit) {
        const chunk = Buffer.allocUnsafe(Math.min(chunkSize, limit - total));
        const bytesRead = await read(chunk, total);
        if (bytesRead === 0) {
            break;
        }
        chunks.push(chunk.subarray(0, bytesRead));
        total += bytesRead;
        chunkSize = FOLLOW_UP_CHUNK_BYTES;
    }
    return Buffer.concat(chunks, total);
}

/** {@link collect} over an already-verified file handle. */
export async function readBoundedAsync(
    handle: { read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }> },
    maxBytes: number,
    statSize: number,
): Promise<Buffer> {
    return collect((buffer, offset) => handle.read(buffer, 0, buffer.length, offset).then((r) => r.bytesRead), maxBytes, statSize + 1);
}

/** {@link collect} over a descriptor opened with the blocking `fs` API. */
export function readBoundedSync(
    read: (buffer: Buffer, offset: number, length: number, position: number) => number,
    maxBytes: number,
    statSize: number,
): Buffer {
    const limit = maxBytes + 1;
    const buffer = Buffer.alloc(Math.min(limit, statSize + 1));
    let total = 0;
    while (total < buffer.length) {
        const readCount = read(buffer, total, buffer.length - total, total);
        if (readCount === 0) {
            break;
        }
        total += readCount;
    }
    return buffer.subarray(0, total);
}
