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

import type { OperatorPrompt, PromptOutcome, PromptSource } from './gatewayProtocol/model';
import { PROMPT_WITHDRAWN } from './gatewayProtocol/model';
import { MAX_TIMER_DELAY_MS } from './typeGuards';

/** `key` names the prompt across sources (see {@link promptKey}); `expiresAtMs` is the local-clock deadline. */
export type PromptChange =
  | { type: 'requested'; key: string; prompt: OperatorPrompt; expiresAtMs: number }
  | { type: 'resolved'; key: string; outcome: PromptOutcome };

export type PromptListener = (change: PromptChange) => void;

type PromptKind = OperatorPrompt['kind'];

type PendingPrompt = { key: string; prompt: OperatorPrompt; expiresAtMs: number; expiry: ReturnType<typeof setTimeout> };

/** Pending prompts kept per kind; past it the oldest is withdrawn, so a flooding gateway cannot grow the board. */
export const MAX_PENDING_PER_KIND = 256;

/** A prompt's identity here: the gateway keeps exec approvals, plugin approvals and questions
 *  apart, so an id is unique only within its source. */
export function promptKey(source: PromptSource, id: string): string {
  return `${source}:${id}`;
}

export function sourceOf(prompt: OperatorPrompt): PromptSource {
  return prompt.kind === 'approval' ? prompt.subject : 'question';
}

export function keyOf(prompt: OperatorPrompt): string {
  return promptKey(sourceOf(prompt), prompt.id);
}

/** A backfill read in flight, by prompt key: what changed meanwhile must win over its older answer. */
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
    for (const { key, prompt, expiresAtMs } of this.pending.values()) listener({ type: 'requested', key, prompt, expiresAtMs });
    return () => this.listeners.delete(listener);
  }

  get(key: string): OperatorPrompt | undefined {
    return this.pending.get(key)?.prompt;
  }

  /** A prompt is announced once; a repeat (live event and backfill row) is ignored. A request
   *  during a backfill is noted even then: it proves the prompt pending, whatever an older list says. */
  add(prompt: OperatorPrompt): void {
    const key = keyOf(prompt);
    this.backfill?.requested.add(key);
    if (this.pending.has(key)) {
      return;
    }
    this.makeRoomFor(prompt.kind);
    const expiresAtMs = this.now() + prompt.lifetimeMs;
    const entry: PendingPrompt = { key, prompt, expiresAtMs, expiry: this.armExpiry(key, expiresAtMs) };
    this.pending.set(key, entry);
    this.emit({ type: 'requested', key, prompt, expiresAtMs });
  }

  settle(key: string, outcome: PromptOutcome): void {
    this.backfill?.resolved.add(key);
    this.submissions.delete(key);
    const entry = this.pending.get(key);
    if (!entry) {
      return;
    }
    clearTimeout(entry.expiry);
    this.pending.delete(key);
    this.emit({ type: 'resolved', key, outcome });
  }

  /** An answer is on its way; if its reply is lost and the prompt then vanishes, this was its outcome. */
  noteSubmission(key: string, outcome: PromptOutcome): void {
    this.submissions.set(key, outcome);
  }

  /** The answer never reached the gateway, or it refused it: nothing was applied. */
  forgetSubmission(key: string): void {
    this.submissions.delete(key);
  }

  /** Every pending prompt of the kinds is gone for this client (access lost, endpoint changed). */
  withdraw(kinds: readonly PromptKind[]): void {
    for (const { key, prompt } of [...this.pending.values()]) {
      if (kinds.includes(prompt.kind)) this.settle(key, PROMPT_WITHDRAWN);
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

  /** Apply a backfill: `listed` is what the gateway still has pending of the `covered` sources,
   *  the ones whose list was read. A prompt gone from it settles with an answer sent before, else
   *  as withdrawn; one still listed was not answered. A backfill superseded by a newer one is dropped. */
  finishBackfill(backfill: Backfill, listed: readonly OperatorPrompt[], covered: readonly PromptSource[]): void {
    if (this.backfill !== backfill) {
      return;
    }
    this.backfill = null;
    const listedKeys = new Set(listed.map(keyOf));
    for (const { key, prompt } of [...this.pending.values()]) {
      if (!covered.includes(sourceOf(prompt)) || backfill.requested.has(key)) continue;
      if (listedKeys.has(key)) this.submissions.delete(key);
      else this.settle(key, this.submissions.get(key) ?? PROMPT_WITHDRAWN);
    }
    for (const prompt of listed) {
      if (!backfill.resolved.has(keyOf(prompt))) this.add(prompt);
    }
  }

  private makeRoomFor(kind: PromptKind): void {
    const ofKind = [...this.pending.values()].filter((entry) => entry.prompt.kind === kind);
    if (ofKind.length < MAX_PENDING_PER_KIND) {
      return;
    }
    this.onOverflow();
    this.settle(ofKind[0].key, PROMPT_WITHDRAWN);
  }

  private armExpiry(key: string, expiresAtMs: number): ReturnType<typeof setTimeout> {
    const delay = Math.min(Math.max(expiresAtMs - this.now(), 0), MAX_TIMER_DELAY_MS);
    const timer = setTimeout(() => this.expire(key), delay);
    timer.unref?.();
    return timer;
  }

  private expire(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) {
      return;
    }
    if (entry.expiresAtMs > this.now()) {
      entry.expiry = this.armExpiry(key, entry.expiresAtMs);
      return;
    }
    this.settle(key, 'expired');
  }

  private emit(change: PromptChange): void {
    for (const listener of [...this.listeners]) listener(change);
  }
}
