/**
 * Claw Code — completing transcript rows the gateway cut.
 *
 * Live `session.message` rows and history-delta rows carry at most 8,000
 * characters of text. A cut row is read again on its own, with the gateway's
 * text ceiling, before it is rendered: one read per session at a time, each
 * entry read once, and a bounded number waiting. A row that cannot be
 * completed is rendered as it came.
 */

import type { TranscriptMessage } from './gatewayProtocol/model';

/** Reads one transcript entry; null when the gateway did not return it. */
export type EntryReader = (sessionKey: string, entryId: string) => Promise<TranscriptMessage | null>;

/** Rows of one session waiting for their read; more are rendered as they came. */
const MAX_QUEUED_PER_SESSION = 8;

type SessionQueue = { tail: Promise<unknown>; queued: number; reads: Map<string, Promise<TranscriptMessage>> };

export class TruncatedRowCompleter {
  private readonly queues = new Map<string, SessionQueue>();

  constructor(private readonly readEntry: EntryReader) {}

  /** Whether a row needs (and allows) a completing read. */
  static isIncomplete(row: TranscriptMessage): boolean {
    return row.truncated && row.entryId !== null;
  }

  /** The row uncut when the gateway serves it so; otherwise the row itself. Never rejects. */
  complete(sessionKey: string, row: TranscriptMessage): Promise<TranscriptMessage> {
    const entryId = row.entryId;
    if (!row.truncated || entryId === null) {
      return Promise.resolve(row);
    }
    const queue = this.queueFor(sessionKey);
    const existing = queue.reads.get(entryId);
    if (existing) {
      return existing;
    }
    if (queue.queued >= MAX_QUEUED_PER_SESSION) {
      return Promise.resolve(row);
    }
    queue.queued += 1;
    const read = queue.tail.then(() => this.read(sessionKey, row, entryId)).finally(() => this.release(sessionKey, queue, entryId));
    queue.reads.set(entryId, read);
    queue.tail = read;
    return read;
  }

  /** The endpoint changed: reads in flight still settle, but nothing is shared with later rows. */
  reset(): void {
    this.queues.clear();
  }

  private queueFor(sessionKey: string): SessionQueue {
    let queue = this.queues.get(sessionKey);
    if (!queue) {
      queue = { tail: Promise.resolve(), queued: 0, reads: new Map() };
      this.queues.set(sessionKey, queue);
    }
    return queue;
  }

  private async read(sessionKey: string, row: TranscriptMessage, entryId: string): Promise<TranscriptMessage> {
    try {
      const full = await this.readEntry(sessionKey, entryId);
      return full && full.text.length >= row.text.length ? { ...row, text: full.text, truncated: full.truncated } : row;
    } catch {
      return row;
    }
  }

  private release(sessionKey: string, queue: SessionQueue, entryId: string): void {
    queue.queued -= 1;
    queue.reads.delete(entryId);
    if (queue.queued === 0 && this.queues.get(sessionKey) === queue) this.queues.delete(sessionKey);
  }
}
