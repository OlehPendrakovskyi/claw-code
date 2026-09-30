/**
 * Text manipulation utilities for Claw Code.
 */

/**
 * Cap a string at a maximum length with an ellipsis.
 *
 * Returns the original value when it is null or fits within the limit; otherwise
 * returns the first `max` characters followed by '…'.
 */
export function capText(value: string | null, max: number): string | null {
  return value && value.length > max ? `${value.slice(0, max)}…` : value;
}
