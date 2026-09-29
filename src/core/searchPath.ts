/**
 * Claw Code — PATH for the processes the extension starts itself.
 *
 * A relative PATH entry (`.`, `bin`, and on POSIX an empty one) resolves
 * against the child's cwd, which can be the workspace, so a child gets only
 * the absolute entries.
 */

import * as fs from 'fs';
import * as path from 'path';

export type Env = Record<string, string | undefined>;

/** A drive-absolute (`C:\x`) or UNC (`\\host\share`) path; a root-relative `\x` resolves against the cwd's drive. */
const WINDOWS_FULLY_QUALIFIED = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;

/** Set in a Windows env, any value, this stops a bare name being looked up in the cwd first: it is
 *  honoured by CreateProcess and SearchPath, cmd.exe, and libuv since 1.48 (so Node children too). */
const NO_CWD_EXE_LOOKUP = 'NoDefaultCurrentDirectoryInExePath';

/** `env` with PATH reduced to its absolute entries, so neither the child nor what it runs comes from the workspace.
 *  With none left PATH is dropped, as an empty POSIX PATH means the cwd; the system default applies instead.
 *  On Windows the implicit cwd lookup of every descendant is switched off as well. */
export function envWithAbsolutePath(platform: NodeJS.Platform = process.platform, env: Env = process.env): Env {
    const key = pathKey(platform, env);
    const value = env[key];
    // Windows reads any spelling (`PATH`, `Path`), so every one goes and only the filtered value returns.
    const rest = Object.fromEntries(Object.entries(env).filter(([name]) => !isPathKey(platform, name) && !isNoCwdLookupKey(platform, name)));
    const guarded = platform === 'win32' ? { ...rest, [NO_CWD_EXE_LOOKUP]: '1' } : rest;
    if (value === undefined) {
        return platform === 'win32' ? guarded : { ...env };
    }
    const entries = absolutePathEntries(platform, value);
    return entries.length === 0 ? guarded : { ...guarded, [key]: entries.join(platform === 'win32' ? ';' : ':') };
}

function isNoCwdLookupKey(platform: NodeJS.Platform, name: string): boolean {
    return platform === 'win32' && name.toUpperCase() === NO_CWD_EXE_LOOKUP.toUpperCase();
}

export function isExecutableFile(filePath: string): boolean {
    try {
        fs.accessSync(filePath, fs.constants.X_OK);
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

export function isFullyQualified(platform: NodeJS.Platform, filePath: string): boolean {
    return platform === 'win32' ? WINDOWS_FULLY_QUALIFIED.test(filePath) : path.posix.isAbsolute(filePath);
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
    return Object.keys(env).find(key => isPathKey(platform, key)) ?? 'PATH';
}

function isPathKey(platform: NodeJS.Platform, name: string): boolean {
    return platform === 'win32' ? name.toUpperCase() === 'PATH' : name === 'PATH';
}
