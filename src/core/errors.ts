/**
 * Error handling utilities for Claw Code.
 */

/** At most this many key names are listed for a non-Error value. */
const MAX_LISTED_KEYS = 8;

/**
 * Extract a readable message from an unknown error value.
 *
 * An Error gives its `.message` and a string is returned as is; so does the string `message` of a
 * record that carries one. Any other object is described by its key names only, never its values
 * (`Non-Error value (keys: code, path)`), because callers log and show this text and a thrown
 * object can hold credentials or prompt text. Other values use String().
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  if (typeof err === 'object' && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
    const keys = Object.keys(err);
    const listed = keys.slice(0, MAX_LISTED_KEYS).join(', ');
    const more = keys.length > MAX_LISTED_KEYS ? `, … ${keys.length - MAX_LISTED_KEYS} more` : '';
    return keys.length > 0 ? `Non-Error value (keys: ${listed}${more})` : 'Non-Error value';
  }
  return String(err);
}
