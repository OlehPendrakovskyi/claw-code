/**
 * Claw Code — pending operator prompts.
 *
 * The approvals and questions a gateway connection waits on an operator for,
 * kept across reconnects: a prompt leaves once it is resolved (here or
 * elsewhere), reaches its deadline, or a backfill read no longer lists it.
 * Deadlines run on the local clock from receipt, for the lifetime the gateway
 * gave the prompt, so a skewed clock neither drops nor shortens one; a backfill
 * row may so outlive its real deadline until the gateway says otherwise.
 */

import type { OperatorPrompt, PromptOutcome } from './gatewayProtocol/model';

/** `expiresAtMs` is the local-clock deadline. */
export type PromptChange =
  | { type: 'requested'; prompt: OperatorPrompt; expiresAtMs: number }
  | { type: 'resolved'; id: string; outcome: PromptOutcome };

export type PromptListener = (change: PromptChange) => void;

type PromptKind = OperatorPrompt['kind'];

type PendingPrompt = { prompt: OperatorPrompt; expiresAtMs: number; expiry: ReturnType<typeof setTimeout> };

/** Node timers overflow past this delay; a later deadline is re-armed when this one fires. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** Pending prompts kept per kind; past it the oldest is withdrawn, so a flooding gateway cannot grow the board. */
export const MAX_PENDING_PER_KIND = 256;

/** A backfill read in flight: what changed meanwhile must win over its older answer. */
export type Backfill = { readonly requested: Set<string>; readonly resolved: Set<string> };

export type BoardOptions = { now?: () => number; onOverflow?: () => void };

export class OperatorPromptBoard {
  private readonly pending = new Map<string, PendingPrompt>();
  private readonly listeners = new Set<PromptListener>();
  /** Answers sent whose outcome the gateway may have applied without the answer reaching us. */
  private readonly submissions = new Map<string, PromptOutcome>();
  private backfill: Backfill | null = null;
  private readonly now: () => number;
  private readonly onOverflow: () => void;

  constructor({ now = Date.now, onOverflow = () => undefined }: BoardOptions = {}) {
    this.now = now;
    this.onOverflow = onOverflow;
  }

  /** Observe prompts; the ones already pending are replayed first. Returns the unsubscribe. */
  subscribe(listener: PromptListener): () => void {
    this.listeners.add(listener);
    for (const { prompt, expiresAtMs } of this.pending.values()) listener({ type: 'requested', prompt, expiresAtMs });
    return () => this.listeners.delete(listener);
  }

  get(id: string): OperatorPrompt | undefined {
    return this.pending.get(id)?.prompt;
  }

  /** A prompt is announced once; a repeat (live event and backfill row) is ignored. */
  add(prompt: OperatorPrompt): void {
    if (this.pending.has(prompt.id)) {
      return;
    }
    this.backfill?.requested.add(prompt.id);
    this.makeRoomFor(prompt.kind);
    const expiresAtMs = this.now() + prompt.lifetimeMs;
    const entry: PendingPrompt = { prompt, expiresAtMs, expiry: this.armExpiry(prompt.id, expiresAtMs) };
    this.pending.set(prompt.id, entry);
    this.emit({ type: 'requested', prompt, expiresAtMs });
  }

  settle(id: string, outcome: PromptOutcome): void {
    this.backfill?.resolved.add(id);
    this.submissions.delete(id);
    const entry = this.pending.get(id);
    if (!entry) {
      return;
    }
    clearTimeout(entry.expiry);
    this.pending.delete(id);
    this.emit({ type: 'resolved', id, outcome });
  }

  /** An answer is on its way; if its reply is lost and the prompt then vanishes, this was its outcome. */
  noteSubmission(id: string, outcome: PromptOutcome): void {
    this.submissions.set(id, outcome);
  }

  /** The gateway refused the answer: it applied nothing. */
  forgetSubmission(id: string): void {
    this.submissions.delete(id);
  }

  /** Every pending prompt of the kinds is gone for this client (access lost, endpoint changed). */
  withdraw(kinds: readonly PromptKind[]): void {
    for (const { prompt } of [...this.pending.values()]) {
      if (kinds.includes(prompt.kind)) this.settle(prompt.id, 'withdrawn');
    }
  }

  /** The endpoint changed: lists read from the old one must not add its prompts. */
  cancelBackfill(): void {
    this.backfill = null;
  }

  /** Call before issuing the backfill reads, so events racing them are neither lost nor resurrected. */
  beginBackfill(): Backfill {
    this.backfill = { requested: new Set(), resolved: new Set() };
    return this.backfill;
  }

  /** Apply a backfill: `listed` is what the gateway still has pending of the `covered` kinds.
   *  A prompt gone from it settles with an answer sent before, else as withdrawn; one still listed
   *  was not answered. A backfill superseded by a newer one is dropped. */
  finishBackfill(backfill: Backfill, listed: readonly OperatorPrompt[], covered: readonly PromptKind[]): void {
    if (this.backfill !== backfill) {
      return;
    }
    this.backfill = null;
    const listedIds = new Set(listed.map((prompt) => prompt.id));
    for (const { prompt } of [...this.pending.values()]) {
      if (!covered.includes(prompt.kind) || backfill.requested.has(prompt.id)) continue;
      if (listedIds.has(prompt.id)) this.submissions.delete(prompt.id);
      else this.settle(prompt.id, this.submissions.get(prompt.id) ?? 'withdrawn');
    }
    for (const prompt of listed) {
      if (!backfill.resolved.has(prompt.id)) this.add(prompt);
    }
  }

  private makeRoomFor(kind: PromptKind): void {
    const ofKind = [...this.pending.values()].filter((entry) => entry.prompt.kind === kind);
    if (ofKind.length < MAX_PENDING_PER_KIND) {
      return;
    }
    this.onOverflow();
    this.settle(ofKind[0].prompt.id, 'withdrawn');
  }

  private armExpiry(id: string, expiresAtMs: number): ReturnType<typeof setTimeout> {
    const delay = Math.min(Math.max(expiresAtMs - this.now(), 0), MAX_TIMER_DELAY_MS);
    const timer = setTimeout(() => this.expire(id), delay);
    timer.unref?.();
    return timer;
  }

  private expire(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) {
      return;
    }
    if (entry.expiresAtMs > this.now()) {
      entry.expiry = this.armExpiry(id, entry.expiresAtMs);
      return;
    }
    this.settle(id, 'expired');
  }

  private emit(change: PromptChange): void {
    for (const listener of [...this.listeners]) listener(change);
  }
}
