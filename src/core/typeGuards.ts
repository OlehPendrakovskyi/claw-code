/**
 * Claw Code — runtime type guards and coercion helpers.
 *
 * Small, dependency-free utilities for narrowing unknown protocol payload
 * fields (gateway frames, history rows, settings values). They centralize the
 * recurring `typeof x === 'string' && x` idiom so call sites read as intent
 * instead of mechanics.
 */

/**
 * Return `value` when it is a non-empty string, `null` otherwise.
 * Whitespace-only strings are kept: the historical `x ? x : fallback`
 * call sites this replaces also treated them as truthy.
 */
export function asNonEmptyString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return null;
}

/**
 * Return `value` when it is a non-empty string, `fallback` otherwise.
 */
export function asString(value: unknown, fallback: string): string {
  return asNonEmptyString(value) ?? fallback;
}

/**
 * Return `value` when it is a string (possibly empty), `fallback` otherwise.
 */
export function asStringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Return `value` when it is a non-null object (arrays excluded), cast to
 * `Record<string, unknown>`; `null` otherwise.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * Return `value` when it is an array; `null` otherwise.
 */
export function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/**
 * Return `value` when it is a finite number; `fallback` otherwise.
 */
export function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
