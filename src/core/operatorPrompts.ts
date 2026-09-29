/**
 * Claw Code — pending operator prompts.
 *
 * The approvals and questions a gateway connection waits on an operator for,
 * kept across reconnects: a prompt leaves once it is resolved (here or
 * elsewhere), reaches its deadline, or a backfill read no longer lists it.
 */

import type { OperatorPrompt, PromptOutcome } from './gatewayProtocol/model';

export type PromptChange = { type: 'requested'; prompt: OperatorPrompt } | { type: 'resolved'; id: string; outcome: PromptOutcome };

export type PromptListener = (change: PromptChange) => void;

type PromptKind = OperatorPrompt['kind'];

type PendingPrompt = { prompt: OperatorPrompt; expiry: ReturnType<typeof setTimeout> };

/** Node timers overflow past this delay; a later deadline is re-armed when this one fires. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** A backfill read in flight: what changed meanwhile must win over its older answer. */
export type Backfill = { readonly requested: Set<string>; readonly resolved: Set<string> };

export class OperatorPromptBoard {
  private readonly pending = new Map<string, PendingPrompt>();
  private readonly listeners = new Set<PromptListener>();
  private backfill: Backfill | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** Observe prompts; the ones already pending are replayed first. Returns the unsubscribe. */
  subscribe(listener: PromptListener): () => void {
    this.listeners.add(listener);
    for (const { prompt } of this.pending.values()) listener({ type: 'requested', prompt });
    return () => this.listeners.delete(listener);
  }

  get(id: string): OperatorPrompt | undefined {
    return this.pending.get(id)?.prompt;
  }

  /** A prompt is announced once; a repeat (live event and backfill row) is ignored. */
  add(prompt: OperatorPrompt): void {
    if (this.pending.has(prompt.id) || prompt.expiresAtMs <= this.now()) {
      return;
    }
    this.backfill?.requested.add(prompt.id);
    this.pending.set(prompt.id, { prompt, expiry: this.armExpiry(prompt) });
    this.emit({ type: 'requested', prompt });
  }

  settle(id: string, outcome: PromptOutcome): void {
    this.backfill?.resolved.add(id);
    const entry = this.pending.get(id);
    if (!entry) {
      return;
    }
    clearTimeout(entry.expiry);
    this.pending.delete(id);
    this.emit({ type: 'resolved', id, outcome });
  }

  /** Every pending prompt of the kinds is gone for this client (access lost, endpoint changed). */
  withdraw(kinds: readonly PromptKind[]): void {
    for (const { prompt } of [...this.pending.values()]) {
      if (kinds.includes(prompt.kind)) this.settle(prompt.id, 'withdrawn');
    }
  }

  /** Call before issuing the backfill reads, so events racing them are neither lost nor resurrected. */
  beginBackfill(): Backfill {
    this.backfill = { requested: new Set(), resolved: new Set() };
    return this.backfill;
  }

  /** Apply a backfill: `listed` is what the gateway still has pending of the `covered` kinds.
   *  A backfill superseded by a newer one is dropped. */
  finishBackfill(backfill: Backfill, listed: readonly OperatorPrompt[], covered: readonly PromptKind[]): void {
    if (this.backfill !== backfill) {
      return;
    }
    this.backfill = null;
    const listedIds = new Set(listed.map((prompt) => prompt.id));
    for (const { prompt } of [...this.pending.values()]) {
      const vanished = covered.includes(prompt.kind) && !listedIds.has(prompt.id) && !backfill.requested.has(prompt.id);
      if (vanished) this.settle(prompt.id, 'withdrawn');
    }
    for (const prompt of listed) {
      if (!backfill.resolved.has(prompt.id)) this.add(prompt);
    }
  }

  private armExpiry(prompt: OperatorPrompt): ReturnType<typeof setTimeout> {
    const delay = Math.min(Math.max(prompt.expiresAtMs - this.now(), 0), MAX_TIMER_DELAY_MS);
    const timer = setTimeout(() => this.expire(prompt), delay);
    timer.unref?.();
    return timer;
  }

  private expire(prompt: OperatorPrompt): void {
    const entry = this.pending.get(prompt.id);
    if (!entry) {
      return;
    }
    if (prompt.expiresAtMs > this.now()) {
      entry.expiry = this.armExpiry(prompt);
      return;
    }
    this.settle(prompt.id, 'expired');
  }

  private emit(change: PromptChange): void {
    for (const listener of [...this.listeners]) listener(change);
  }
}
