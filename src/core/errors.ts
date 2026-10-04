/**
 * Error handling utilities for Claw Code.
 */

/**
 * Extract a readable message from an unknown error value.
 *
 * An Error gives its `.message` and a string is returned as is. Any other object is described
 * generically — `Non-Error value (object)` or `(array)` — with nothing taken from it, neither values
 * nor key names: callers log and show this text without redacting it, and a thrown object's fields
 * and even its keys can carry credentials or prompt text. Other values use String().
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  if (typeof err === 'object' && err !== null) {
    return `Non-Error value (${Array.isArray(err) ? 'array' : 'object'})`;
  }
  return String(err);
}
