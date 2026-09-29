/**
 * Claw Code — completing transcript rows the gateway cut.
 *
 * Live `session.message` rows and history-delta rows carry at most 8,000
 * characters of text. A cut row is read again on its own, with the gateway's
 * text ceiling, before it is rendered: one read per session at a time, each
 * entry read once (a completed entry is remembered), and a bounded number waiting. A row that cannot be
 * completed is rendered as it came.
 */

import type { TranscriptMessage } from './gatewayProtocol/model';

/** Reads one transcript entry; null when the gateway did not return it. */
export type EntryReader = (sessionKey: string, entryId: string) => Promise<TranscriptMessage | null>;

/** Rows of one session waiting for their read; more are rendered as they came. */
const MAX_QUEUED_PER_SESSION = 8;

/** The session's later rows and run events wait behind a read, so a row whose read is slow is
 *  rendered as it came early; the read itself keeps the session's turn until it settles (the
 *  gateway request has its own timeout), so a slow gateway never serves two reads of one session at once. */
const READ_TIMEOUT_MS = 10_000;

/** Completed entries remembered across sessions, so a row delivered again (live racing catch-up) is not read again. */
const MAX_REMEMBERED_ENTRIES = 256;

type CompletedText = Pick<TranscriptMessage, 'text' | 'truncated'>;

type SessionQueue = { tail: Promise<unknown>; queued: number; reads: Map<string, Promise<TranscriptMessage>> };

export class TruncatedRowCompleter {
  private readonly queues = new Map<string, SessionQueue>();
  private readonly completed = new Map<string, CompletedText>();
  private epoch = 0;

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
    const remembered = this.completed.get(completedKey(sessionKey, entryId));
    if (remembered) {
      return Promise.resolve({ ...row, ...remembered });
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
    const epoch = this.epoch;
    const entryRead = queue.tail.then(() => this.readCompleted(sessionKey, row, entryId, epoch));
    const settled = entryRead.finally(() => this.release(sessionKey, queue, entryId));
    // Timed from arrival, so a row waits at most READ_TIMEOUT_MS even behind a slow read of another entry.
    const read = withTimeout(entryRead).then((text) => (text ? { ...row, ...text } : row));
    queue.reads.set(entryId, read);
    queue.tail = settled;
    return read;
  }

  /** The endpoint changed: reads in flight still settle, but nothing is shared with later rows. */
  reset(): void {
    this.queues.clear();
    this.completed.clear();
    this.epoch += 1;
  }

  private queueFor(sessionKey: string): SessionQueue {
    let queue = this.queues.get(sessionKey);
    if (!queue) {
      queue = { tail: Promise.resolve(), queued: 0, reads: new Map() };
      this.queues.set(sessionKey, queue);
    }
    return queue;
  }

  /** The entry's full text, remembered for later rows even when it arrives after the timeout; null when not served. */
  private async readCompleted(sessionKey: string, row: TranscriptMessage, entryId: string, epoch: number): Promise<CompletedText | null> {
    try {
      const full = await this.readEntry(sessionKey, entryId);
      if (!full || full.text.length < row.text.length) {
        return null;
      }
      const text: CompletedText = { text: full.text, truncated: full.truncated };
      if (epoch === this.epoch) this.remember(completedKey(sessionKey, entryId), text);
      return text;
    } catch {
      return null;
    }
  }

  private remember(key: string, text: CompletedText): void {
    this.completed.set(key, text);
    if (this.completed.size > MAX_REMEMBERED_ENTRIES) {
      this.completed.delete(this.completed.keys().next().value as string);
    }
  }

  private release(sessionKey: string, queue: SessionQueue, entryId: string): void {
    queue.queued -= 1;
    queue.reads.delete(entryId);
    if (queue.queued === 0 && this.queues.get(sessionKey) === queue) this.queues.delete(sessionKey);
  }
}

/** `read`'s result, or null once the render can no longer wait for it. */
async function withTimeout(read: Promise<CompletedText | null>): Promise<CompletedText | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function completedKey(sessionKey: string, entryId: string): string {
  return `${sessionKey}\u0000${entryId}`;
}
