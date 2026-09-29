import * as vscode from 'vscode';
import * as path from 'path';
import { absolutePathEntries, isExecutableFile, pathKey, type Env } from '../core/searchPath';

/** The part of the built-in Git extension's API this uses. */
type GitExtensionExports = { getAPI(version: 1): { git: { path: string } } };

/** A bare `git` lets Windows run a git.exe planted in the child's cwd (the workspace),
 *  and POSIX one on a relative PATH entry; only an absolute path is ever spawned. */
export async function resolveGitExecutable(): Promise<string | undefined> {
    return (await gitExtensionPath()) ?? findGitOnPath(process.platform, process.env, isExecutableFile);
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
