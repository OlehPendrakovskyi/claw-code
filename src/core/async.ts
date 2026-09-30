/**
 * Asynchronous control utilities for Claw Code.
 */

/**
 * Race a promise against a timeout that rejects with an error.
 *
 * Use this variant when the caller expects a rejection on timeout.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Race a promise against a timeout that settles to `null`.
 *
 * Use this variant when the caller needs a graceful fallback value instead
 * of a rejection. The original promise continues running but its result is
 * ignored after the timeout.
 */
export function withTimeoutNull<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
