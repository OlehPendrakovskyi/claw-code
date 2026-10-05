/**
 * Error handling utilities for Claw Code.
 */

/**
 * Extract a readable message from an unknown error value.
 *
 * An Error gives its `.message` and a string is returned as is, so the result can still carry URL
 * credentials, tokens or prompt text: sanitize it (for example with `redactText`) before logging or
 * showing it. Any other object is described generically — `Non-Error value (object)`, `(array)` or
 * `(function)` — with nothing taken from it, neither values nor key names, since a thrown object's
 * fields and even its keys can carry the same. Other values use String().
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
  if (typeof err === 'function') {
    // String() would print its source or call a custom toString: take nothing from it either.
    return 'Non-Error value (function)';
  }
  return String(err);
}
