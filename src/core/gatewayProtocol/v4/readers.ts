/**
 * Narrowing readers for untrusted gateway payloads: each returns a typed value
 * or an empty result, and none of them throws.
 */

type UnknownRecord = Readonly<Record<string, unknown>>;

const EMPTY_RECORD: UnknownRecord = Object.freeze({});

/** Node timers overflow beyond this delay. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : EMPTY_RECORD;
}

/** A non-empty string, else null. */
export function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Any string, the empty one included, else null. */
export function readText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function readTrimmedString(value: unknown): string | null {
  return typeof value === 'string' ? readString(value.trim()) : null;
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

export function readDelayMs(value: unknown): number | undefined {
  const delay = readFiniteNumber(value);
  return delay !== null && delay >= 0 ? Math.min(delay, MAX_TIMER_DELAY_MS) : undefined;
}

export function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function readStrings(value: unknown): string[] {
  return readArray(value).filter((item): item is string => typeof item === 'string' && item.length > 0);
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
