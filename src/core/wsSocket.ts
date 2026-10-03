/**
 * The `ws` seam: the socket shape this service drives, and the one place that
 * reaches for the real package.
 *
 * Acquiring the constructor lives here rather than inline in the transport so
 * it can be replaced in a test. `require` is deliberate and stays: `ws` is
 * CommonJS, `loadWsCtor` is called synchronously from the socket factory, and
 * bundling it lazily is what keeps its module body off the extension's
 * activation path. A static `import` would run that body as soon as the
 * transport module loads, for every user including those who never connect to
 * a gateway. The `as` cast restores the type `require` erases.
 */

/** Subset of the `ws` WebSocket surface this service relies on. */
export type WebSocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, cb: (...args: never[]) => void): void;
  removeListener(event: string, cb: (...args: unknown[]) => void): void;
};

export type WebSocketFactory = (url: string) => WebSocketLike;

/** A `ws` constructor. Its CJS entry exports the class directly. */
export type WebSocketCtor = new (url: string) => WebSocketLike;

/** The real `ws` constructor, loaded on first use. */
export function loadWsCtor(): WebSocketCtor {
  return require('ws') as WebSocketCtor;
}