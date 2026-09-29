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

/** The extensions spawn tries for a bare name on Windows; it runs no `.cmd` or `.bat` without a shell. */
const WINDOWS_SPAWN_EXTENSIONS = ['.com', '.exe'];

/** `env` with PATH reduced to its absolute entries, so neither the child nor what it runs comes from the workspace.
 *  With none left PATH is dropped, as an empty POSIX PATH means the cwd; the system default applies instead. */
export function envWithAbsolutePath(platform: NodeJS.Platform = process.platform, env: Env = process.env): Env {
    const key = pathKey(platform, env);
    const value = env[key];
    if (value === undefined) {
        return { ...env };
    }
    // Windows reads any spelling (`PATH`, `Path`), so every one goes and only the filtered value returns.
    const rest = Object.fromEntries(Object.entries(env).filter(([name]) => !isPathKey(platform, name)));
    const entries = absolutePathEntries(platform, value);
    return entries.length === 0 ? rest : { ...rest, [key]: entries.join(platform === 'win32' ? ';' : ':') };
}

/** `command` by an absolute path: as given when already absolute, else the first executable match on
 *  the absolute PATH entries. A bare name spawned as such would be looked up in the cwd first on
 *  Windows, and a relative path always resolves against it, so neither is ever returned. */
export function resolveOnAbsolutePath(
    command: string,
    platform: NodeJS.Platform = process.platform,
    env: Env = process.env,
    isExecutable: (filePath: string) => boolean = isExecutableFile
): string | undefined {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    if (isFullyQualified(platform, command)) {
        return command;
    }
    if (command.includes('/') || (platform === 'win32' && command.includes('\\'))) {
        return undefined;
    }
    const hasSpawnExtension = WINDOWS_SPAWN_EXTENSIONS.some(ext => command.toLowerCase().endsWith(ext));
    const names = platform === 'win32' && !hasSpawnExtension ? WINDOWS_SPAWN_EXTENSIONS.map(ext => command + ext) : [command];
    for (const dir of absolutePathEntries(platform, env[pathKey(platform, env)] ?? '')) {
        const found = names.map(name => paths.join(dir, name)).find(candidate => isExecutable(candidate));
        if (found) return found;
    }
    return undefined;
}

export function isExecutableFile(filePath: string): boolean {
    try {
        fs.accessSync(filePath, fs.constants.X_OK);
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function isFullyQualified(platform: NodeJS.Platform, filePath: string): boolean {
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
