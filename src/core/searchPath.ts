/**
 * Claw Code — PATH for the processes the extension starts itself.
 *
 * A relative PATH entry (`.`, `bin`, and on POSIX an empty one) resolves
 * against the child's cwd, which can be the workspace, so a child gets only
 * the absolute entries.
 */

import * as path from 'path';

export type Env = Record<string, string | undefined>;

/** A drive-absolute (`C:\x`) or UNC (`\\host\share`) path; a root-relative `\x` resolves against the cwd's drive. */
const WINDOWS_FULLY_QUALIFIED = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;

/** `env` with PATH reduced to its absolute entries, so neither the child nor what it runs comes from the workspace.
 *  With none left PATH is dropped, as an empty POSIX PATH means the cwd; the system default applies instead. */
export function envWithAbsolutePath(platform: NodeJS.Platform = process.platform, env: Env = process.env): Env {
    const key = pathKey(platform, env);
    const value = env[key];
    if (value === undefined) {
        return { ...env };
    }
    const { [key]: _dropped, ...rest } = env;
    const entries = absolutePathEntries(platform, value);
    return entries.length === 0 ? rest : { ...rest, [key]: entries.join(platform === 'win32' ? ';' : ':') };
}

export function absolutePathEntries(platform: NodeJS.Platform, searchPath: string): string[] {
    if (platform === 'win32') {
        return searchPath
            .split(';')
            .map(dir => dir.trim().replace(/^"(.*)"$/, '$1'))
            .filter(dir => WINDOWS_FULLY_QUALIFIED.test(dir));
    }
    return searchPath.split(':').filter(dir => path.posix.isAbsolute(dir));
}

/** Windows env names are case-insensitive (`Path`), a plain copy of the env is not; POSIX reads `PATH` only. */
export function pathKey(platform: NodeJS.Platform, env: Env): string {
    if (platform !== 'win32') {
        return 'PATH';
    }
    return Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
}
