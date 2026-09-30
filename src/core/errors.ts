/**
 * Error handling utilities for Claw Code.
 */

/**
 * Extract a readable message from an unknown error value.
 *
 * Returns the `.message` property when the value is an Error instance,
 * otherwise the string representation of the value.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
