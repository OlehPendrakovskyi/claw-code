/**
 * Error handling utilities for Claw Code.
 */

/** Longest message produced for a value that is not an Error, so a large thrown object stays readable. */
const MAX_NON_ERROR_LENGTH = 300;

/**
 * Extract a readable message from an unknown error value.
 *
 * An Error gives its `.message` and a string is returned as is. A record with a string `message`
 * gives that message. Any other value is serialised as JSON, capped at MAX_NON_ERROR_LENGTH
 * characters, rather than rendered as `[object Object]`. Callers that show the result to a user
 * or a log still redact it.
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
    try {
      const json = JSON.stringify(err);
      if (json !== undefined) {
        return json.length > MAX_NON_ERROR_LENGTH ? `${json.slice(0, MAX_NON_ERROR_LENGTH)}…` : json;
      }
    } catch {
      // A cyclic or otherwise unserialisable value falls through to String().
    }
  }
  return String(err);
}
