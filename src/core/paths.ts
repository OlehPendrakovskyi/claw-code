import * as fs from 'fs';

/**
 * Resolve a path to its canonical spelling, falling back to the input on failure.
 *
 * The realpath resolver is injectable so tests can patch `fs.promises.realpath`;
 * the default reads it at call time rather than closing over the module binding.
 */
export function canonicalizePath(
  path: string,
  realpath: (p: string) => Promise<string> = (p) => fs.promises.realpath(p)
): Promise<string> {
  return realpath(path).catch(() => path);
}
