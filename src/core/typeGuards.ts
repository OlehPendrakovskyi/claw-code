/**
 * Claw Code — canonical runtime type guards and coercion helpers.
 *
 * Small, dependency-free primitives for narrowing and coercing `unknown`
 * payload fields (gateway frames, history rows, JSON parses, settings values).
 * This module is the single home for the guard/read vocabulary: protocol
 * modules under `gatewayProtocol/` re-export these through `v4/readers.ts`, and
 * the webview/chat layers import them directly.
 *
 * Design notes:
 * - None of the readers throws; a value that does not narrow yields an empty
 *   result (`null`, `undefined`, a default, or a frozen empty record).
 * - The half-open record check excludes arrays by design; `isPlainObject` from
 *   lodash is *not* equivalent (it also rejects class instances and dates).
 */

/** A record of unknown values; the shape guarded payloads narrow to. */
export type UnknownRecord = Readonly<Record<string, unknown>>;

const EMPTY_RECORD: UnknownRecord = Object.freeze({});

/** Node timers overflow beyond this delay (and then fire after 1 ms). */
/** Largest delay usable in `setTimeout`; re-exported from the constants registry. */
export { MAX_TIMER_DELAY_MS } from './constants';
import { MAX_TIMER_DELAY_MS } from './constants';

/** A non-array object, else false. */
export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value as a record, or a frozen empty one. */
export function readRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : EMPTY_RECORD;
}

/** Return `value` when it is a non-empty string, `null` otherwise. */
export function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Return `value` when it is a non-empty string, `fallback` otherwise. */
export function asString(value: unknown, fallback: string): string {
  return asNonEmptyString(value) ?? fallback;
}

/** A non-empty string, else null. */
export function readString(value: unknown): string | null {
  return asNonEmptyString(value);
}

/** `value` when it is a non-empty string, `fallback` otherwise. */
export function readStringOr(value: unknown, fallback: string): string {
  return readString(value) ?? fallback;
}

/** Any string, the empty one included, else null. */
export function readText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A non-empty string after trimming, else null. */
export function readTrimmedString(value: unknown): string | null {
  return typeof value === 'string' ? asNonEmptyString(value.trim()) : null;
}

/** A value that is a string, or absent (`undefined`) — never `null`. */
export function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

/** An integer index `0 <= value < length`. */
export function isIndexInRange(value: unknown, length: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < length;
}

export function readNonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

export function readPositiveInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null;
}

export function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The first finite, non-negative number among `names` on `record`; null when
 * there is none. Iterates alias spellings the gateway uses for one value
 * (e.g. `input` / `inputTokens` / `prompt_tokens`). Aggregation stays with the
 * caller: this only picks the first candidate, it does not combine them.
 */
export function firstFinite(record: Readonly<Record<string, unknown>>, names: readonly string[]): number | null {
  for (const name of names) {
    const value = readFiniteNumber(record[name]);
    if (value !== null && value >= 0) return value;
  }
  return null;
}

export function readDelayMs(value: unknown, maxMs = MAX_TIMER_DELAY_MS): number | undefined {
  const delay = readFiniteNumber(value);
  return delay !== null && delay >= 0 ? Math.min(delay, maxMs) : undefined;
}

export function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function readStrings(value: unknown): string[] {
  return readArray(value).filter((item): item is string => typeof item === 'string' && item.length > 0);
}

/** The value as a record when it is a non-array object, `undefined` otherwise (arrays included). */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? (value as Record<string, unknown>) : undefined;
}

/** `value[key]` read as a non-empty string, or `value[key][subKey]` when `subKey` is given; null when a step is not a record or the field is absent. */
export function readNestedString(value: unknown, key: string, subKey?: string): string | null {
  const nested = readRecord(value)[key];
  return readString(subKey === undefined ? nested : readRecord(nested)[subKey]);
}

/**
 * Parse JSON text into a plain record, or `undefined` when it is malformed or
 * not an object. A leading BOM, which some files on disk carry, is stripped.
 */
export function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text.replace(/^\uFEFF/, '')));
  } catch {
    return undefined;
  }
}

/** Serialize a tool payload for display; values JSON cannot represent become a placeholder. */
export function describeJson(value: unknown, maxChars: number): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '');
  } catch {
    text = '[unserializable]';
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
