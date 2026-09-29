import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

type Env = Record<string, string | undefined>;

/** The part of the built-in Git extension's API this uses. */
type GitExtensionExports = { getAPI(version: 1): { git: { path: string } } };

/** A drive-absolute (`C:\x`) or UNC (`\\host\share`) path; a root-relative `\x` resolves against the cwd's drive. */
const WINDOWS_FULLY_QUALIFIED = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;

/** A bare `git` lets Windows run a git.exe planted in the child's cwd (the workspace),
 *  and POSIX one on a relative PATH entry; only an absolute path is ever spawned. */
export async function resolveGitExecutable(): Promise<string | undefined> {
    return (await gitExtensionPath()) ?? findGitOnPath(process.platform, process.env, isExecutableFile);
}

/** The environment for the git child: PATH reduced to its absolute entries, so helpers git runs cannot come from the workspace either.
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

/** The first `git` on the absolute PATH entries. */
export function findGitOnPath(
    platform: NodeJS.Platform,
    env: Env,
    isExecutable: (filePath: string) => boolean
): string | undefined {
    const join = platform === 'win32' ? path.win32.join : path.posix.join;
    const name = platform === 'win32' ? 'git.exe' : 'git';
    return absolutePathEntries(platform, env[pathKey(platform, env)] ?? '')
        .map(dir => join(dir, name))
        .find(candidate => isExecutable(candidate));
}

/** The Git extension resolves `git.path` and its own search to an absolute path; it may be disabled or not yet activated. */
async function gitExtensionPath(): Promise<string | undefined> {
    try {
        const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
        if (!extension) {
            return undefined;
        }
        const exports = extension.isActive ? extension.exports : await extension.activate();
        const gitPath = exports.getAPI(1).git.path;
        return path.isAbsolute(gitPath) ? gitPath : undefined;
    } catch {
        return undefined;
    }
}

function absolutePathEntries(platform: NodeJS.Platform, searchPath: string): string[] {
    if (platform === 'win32') {
        return searchPath
            .split(';')
            .map(dir => dir.trim().replace(/^"(.*)"$/, '$1'))
            .filter(dir => WINDOWS_FULLY_QUALIFIED.test(dir));
    }
    return searchPath.split(':').filter(dir => path.posix.isAbsolute(dir));
}

/** Windows env names are case-insensitive (`Path`), a plain copy of the env is not; POSIX reads `PATH` only. */
function pathKey(platform: NodeJS.Platform, env: Env): string {
    if (platform !== 'win32') {
        return 'PATH';
    }
    return Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
}

function isExecutableFile(filePath: string): boolean {
    try {
        fs.accessSync(filePath, fs.constants.X_OK);
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}
