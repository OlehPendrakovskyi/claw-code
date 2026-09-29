/**
 * Claw Code — streamed run text.
 *
 * The gateway streams a run as cumulative snapshots, suffix deltas and
 * occasional replacements. This reducer turns that stream into updates for the
 * chat panel: what extends the text already shown is appended (the common,
 * cheap case), and text that does not extend it replaces what was shown.
 */

export type RunText = {
  /** Text already delivered to the sinks. */
  rendered: string;
  /** Highest chat event sequence applied; older or repeated events are stale. */
  lastSeq: number;
};

export type RunDelta = { seq: number; deltaText: string; replace: boolean; snapshotText: string | null };

/** `append` adds `text` to what was shown; `replace` shows `text` instead of it. */
export type TextUpdate = { kind: 'append' | 'replace'; text: string };

const NO_UPDATE: TextUpdate = { kind: 'append', text: '' };

export function newRunText(): RunText {
  return { rendered: '', lastSeq: -1 };
}

/** Advance the shown text to `cumulative`. */
function advance(run: RunText, cumulative: string): TextUpdate {
  const extendsShown = cumulative.startsWith(run.rendered);
  const update: TextUpdate = extendsShown ? { kind: 'append', text: cumulative.slice(run.rendered.length) } : { kind: 'replace', text: cumulative };
  run.rendered = cumulative;
  return update;
}

/** The update a delta makes, or null when the event is stale. */
export function applyDelta(run: RunText, delta: RunDelta): TextUpdate | null {
  if (delta.seq <= run.lastSeq) {
    return null;
  }
  run.lastSeq = delta.seq;
  const cumulative = delta.snapshotText ?? (delta.replace ? delta.deltaText : run.rendered + delta.deltaText);
  return advance(run, cumulative);
}

/** The update that completes a run with its final text; none without one. */
export function applyFinal(run: RunText, finalText: string | null): TextUpdate {
  return finalText ? advance(run, finalText) : NO_UPDATE;
}

/** The text the transcript settled a run on, shown whatever was streamed (an empty one clears it). */
export function applySettled(run: RunText, text: string): TextUpdate {
  return advance(run, text);
}

/** An aborted run keeps what was shown; only a clean extension is added. */
export function applyAborted(run: RunText, text: string | null): TextUpdate {
  return text !== null && text.startsWith(run.rendered) ? advance(run, text) : NO_UPDATE;
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
