/**
 * Claw Code — streamed run text.
 *
 * The chat panel only appends text, while the gateway streams a run as
 * cumulative snapshots, suffix deltas and occasional replacements. This
 * reducer turns that stream into append-only chunks: what extends the text
 * already shown is emitted, and a replacement that does not extend it is held
 * back until the run's final text settles it.
 */

/** Separates a final text that diverges from what was already shown. */
const DIVERGENCE_SEPARATOR = '\n\n';

export type RunText = {
  /** Text already delivered to the sinks. */
  rendered: string;
  /** Latest cumulative text that does not extend `rendered`. */
  held: string | null;
  /** Highest chat event sequence applied; older or repeated events are stale. */
  lastSeq: number;
};

export type RunDelta = { seq: number; deltaText: string; replace: boolean; snapshotText: string | null };

export function newRunText(): RunText {
  return { rendered: '', held: null, lastSeq: -1 };
}

/** Advance the rendered text to `cumulative`; returns the chunk to append, or '' when it diverges. */
function advance(run: RunText, cumulative: string): string {
  if (!cumulative.startsWith(run.rendered)) {
    run.held = cumulative;
    return '';
  }
  const chunk = cumulative.slice(run.rendered.length);
  run.rendered = cumulative;
  run.held = null;
  return chunk;
}

/** The chunk a delta adds, or null when the event is stale. */
export function applyDelta(run: RunText, delta: RunDelta): string | null {
  if (delta.seq <= run.lastSeq) {
    return null;
  }
  run.lastSeq = delta.seq;
  const base = run.held ?? run.rendered;
  const cumulative = delta.snapshotText ?? (delta.replace ? delta.deltaText : base + delta.deltaText);
  return advance(run, cumulative);
}

/** The chunk that completes a run: the unrendered rest of its final text, or all of it when it diverges. */
export function applyFinal(run: RunText, finalText: string | null): string {
  const text = finalText ?? run.held;
  if (text === null || text === '') {
    return '';
  }
  if (text.startsWith(run.rendered)) {
    return advance(run, text);
  }
  run.rendered = text;
  run.held = null;
  return DIVERGENCE_SEPARATOR + text;
}

/** An aborted run keeps what was shown; only a clean extension is added. */
export function applyAborted(run: RunText, text: string | null): string {
  return text !== null && text.startsWith(run.rendered) ? advance(run, text) : '';
}

/** An insertion-ordered set that forgets its oldest entries beyond `limit`. */
export class BoundedSet<T> {
  private readonly items = new Set<T>();

  constructor(private readonly limit: number) {}

  has(item: T): boolean {
    return this.items.has(item);
  }

  add(item: T): void {
    this.items.delete(item);
    this.items.add(item);
    if (this.items.size > this.limit) {
      const [oldest] = this.items;
      this.items.delete(oldest);
    }
  }

  delete(item: T): void {
    this.items.delete(item);
  }

  clear(): void {
    this.items.clear();
  }
}
