/**
 * Claw Code — starting a Node CLI (acpx, openclaw) the extension runs itself.
 *
 * Only absolute PATH entries are searched, so nothing comes from the cwd,
 * which can be the workspace. Windows cannot spawn an npm `.cmd` shim
 * without a shell, so a shimmed CLI's JS entry runs under Node instead;
 * POSIX runs the CLI itself through its shebang. The child must get the same
 * PATH (`envWithAbsolutePath`), or that shebang's `node` could still come
 * from the workspace.
 */

import * as fs from 'fs';
import * as path from 'path';
import { absolutePathEntries, isFullyQualified, pathKey, type Env } from './searchPath';
import { asRecord, parseJsonRecord } from './typeGuards';

/** How to start the CLI: `command` with `args` before the CLI's own. */
export type CliLaunch = {
    command: string;
    args: string[];
};

/** What kept the CLI from launching: the CLI itself (by the name asked for), or the Node its shim needs. */
export type CliLaunchFailure = {
    missing: string;
};

/** The filesystem reads the resolver needs, injectable for tests. */
export type LauncherHost = {
    isFile(filePath: string): boolean;
    /** A regular file this process may execute (POSIX). */
    isExecutable(filePath: string): boolean;
    readText(filePath: string): string | undefined;
};

/** A CLI found on PATH: a native binary, or a JS entry its shim runs under Node. */
type CliEntry = { native: string } | { script: string; shimDir: string };

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const SHIM_EXTENSIONS = ['.cmd', '.bat', '.ps1', ''];
const NATIVE_EXTENSIONS = new Set(['.exe', '.com']);

/** Script paths in npm (`%dp0%\`, `$basedir/`) and pnpm (`%~dp0\`, absolute) shims. */
const RELATIVE_SCRIPT_PATTERN = /"(?:%~dp0%?|%dp0%|\$basedir)[\\/]([^"%$]+?\.[cm]?js)"/i;
const ABSOLUTE_SCRIPT_PATTERN = /"([A-Za-z]:\\[^"%$]+?\.[cm]?js)"/;

const nodeHost: LauncherHost = {
    isFile(filePath) {
        try {
            return fs.statSync(filePath).isFile();
        } catch {
            return false;
        }
    },
    isExecutable(filePath) {
        try {
            fs.accessSync(filePath, fs.constants.X_OK);
            return fs.statSync(filePath).isFile();
        } catch {
            return false;
        }
    },
    readText(filePath) {
        try {
            return fs.readFileSync(filePath, 'utf8');
        } catch {
            return undefined;
        }
    },
};

const entryCache = new Map<string, CliEntry>();

/** The bare CLI `name` found on the absolute PATH entries. */
export function resolveCliLaunch(
    name: string,
    platform: NodeJS.Platform = process.platform,
    env: Env = process.env,
    host: LauncherHost = nodeHost
): CliLaunch | CliLaunchFailure {
    const dirs = absolutePathEntries(platform, env[pathKey(platform, env)] ?? '');
    if (platform !== 'win32') {
        const command = dirs.map(dir => path.posix.join(dir, name)).find(candidate => host.isExecutable(candidate));
        return command === undefined ? { missing: name } : { command, args: [] };
    }
    const pathExt = envValue(env, 'PATHEXT') ?? DEFAULT_PATHEXT;
    const entry = cachedEntry(name, dirs, pathExt, host);
    if (!entry) {
        return { missing: name };
    }
    if ('native' in entry) {
        return { command: entry.native, args: [] };
    }
    // Chosen afresh each time, so a Node installed later is picked up.
    const node = findNode(entry.shimDir, dirs, host);
    return node === undefined ? { missing: 'node' } : { command: node, args: [entry.script] };
}

/** A configured command as the extension may spawn it: an absolute path as given (a Windows
 *  shim through its JS entry), a bare name as {@link resolveCliLaunch} finds it; never a relative
 *  path, which resolves against the cwd. */
export function resolveCommandLaunch(
    command: string,
    platform: NodeJS.Platform = process.platform,
    env: Env = process.env,
    host: LauncherHost = nodeHost
): CliLaunch | CliLaunchFailure {
    if (isFullyQualified(platform, command)) {
        return platform === 'win32' && isShimPath(command) ? resolveShimAt(command, env, host) : { command, args: [] };
    }
    if (command.includes('/') || (platform === 'win32' && command.includes('\\'))) {
        return { missing: command };
    }
    return resolveCliLaunch(command, platform, env, host);
}

/** A `.cmd`, `.bat` or `.ps1` file, which spawn cannot run without a shell. */
function isShimPath(command: string): boolean {
    const ext = path.win32.extname(command).toLowerCase();
    return ext !== '' && SHIM_EXTENSIONS.includes(ext);
}

/** An absolute shim, run as its JS entry under the Node beside it or on the absolute PATH entries. */
function resolveShimAt(shimPath: string, env: Env, host: LauncherHost): CliLaunch | CliLaunchFailure {
    const shimDir = path.win32.dirname(shimPath);
    const name = path.win32.basename(shimPath, path.win32.extname(shimPath));
    const script = host.isFile(shimPath) ? (packageBinScript(name, shimDir, host) ?? shimScript(name, shimDir, host)) : undefined;
    if (!script) {
        return { missing: shimPath };
    }
    const node = findNode(shimDir, absolutePathEntries('win32', env[pathKey('win32', env)] ?? ''), host);
    return node === undefined ? { missing: 'node' } : { command: node, args: [script] };
}

/** Only fully qualified PATH entries count, so the cache key is cwd-independent. */
function cachedEntry(name: string, dirs: string[], pathExt: string, host: LauncherHost): CliEntry | undefined {
    const key = `${name}\0${dirs.join(';')}\0${pathExt}`;
    const cached = entryCache.get(key);
    // Revalidated, since an uninstall leaves PATH unchanged.
    if (cached && host.isFile('native' in cached ? cached.native : cached.script)) {
        return cached;
    }
    const entry = findEntry(name, dirs, pathExt, host);
    if (entry) {
        entryCache.set(key, entry);
    } else {
        entryCache.delete(key);
    }
    return entry;
}

/** Windows env names are case-insensitive, a plain copy of the env is not. */
function envValue(env: Env, name: string): string | undefined {
    const key = Object.keys(env).find(candidate => candidate.toUpperCase() === name);
    return key === undefined ? undefined : env[key];
}

function findEntry(name: string, dirs: string[], pathExt: string, host: LauncherHost): CliEntry | undefined {
    // A name that already carries a native extension (`openclaw.exe`) is only ever that file.
    if (NATIVE_EXTENSIONS.has(path.win32.extname(name).toLowerCase())) {
        const native = dirs.map(dir => path.win32.join(dir, name)).find(candidate => host.isFile(candidate));
        return native === undefined ? undefined : { native };
    }
    const executableExtensions = pathExt.split(';').map(ext => ext.trim().toLowerCase()).filter(Boolean);
    const extensions = [...new Set([...executableExtensions, ...SHIM_EXTENSIONS])];
    for (const dir of dirs) {
        const found = extensions.find(ext => host.isFile(path.win32.join(dir, name + ext)));
        if (found === undefined) {
            continue;
        }
        if (NATIVE_EXTENSIONS.has(found)) {
            return { native: path.win32.join(dir, name + found) };
        }
        const script = packageBinScript(name, dir, host) ?? shimScript(name, dir, host);
        if (script) {
            return { script, shimDir: dir };
        }
    }
    return undefined;
}

/** npm's global layout keeps the package beside its shims; the CLIs launched here are
 *  named after their package (acpx, openclaw). */
function packageBinScript(name: string, shimDir: string, host: LauncherHost): string | undefined {
    const packageDir = path.win32.join(shimDir, 'node_modules', name);
    const manifest = parseJson(host.readText(path.win32.join(packageDir, 'package.json')));
    const bin = manifest?.bin;
    const entry = typeof bin === 'string' ? bin : asRecord(bin)?.[name];
    if (typeof entry !== 'string') {
        return undefined;
    }
    const script = path.win32.join(packageDir, entry);
    return host.isFile(script) ? script : undefined;
}

/** Other layouts (pnpm, a project's .bin) are found from the path the shim runs. */
function shimScript(name: string, shimDir: string, host: LauncherHost): string | undefined {
    for (const ext of SHIM_EXTENSIONS) {
        const text = host.readText(path.win32.join(shimDir, name + ext));
        const script = text === undefined ? undefined : scriptInShim(text, shimDir);
        if (script && host.isFile(script)) {
            return script;
        }
    }
    return undefined;
}

function scriptInShim(text: string, shimDir: string): string | undefined {
    const relative = RELATIVE_SCRIPT_PATTERN.exec(text)?.[1];
    if (relative !== undefined) {
        return path.win32.join(shimDir, relative);
    }
    return ABSOLUTE_SCRIPT_PATTERN.exec(text)?.[1];
}

/** The Node the shim itself would pick. VS Code's own Electron is no stand-in:
 *  acpx, for one, re-runs `process.execPath` for agents, which would open an editor window. */
function findNode(shimDir: string, dirs: string[], host: LauncherHost): string | undefined {
    return [shimDir, ...dirs].map(dir => path.win32.join(dir, 'node.exe')).find(candidate => host.isFile(candidate));
}

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
    return text === undefined ? undefined : parseJsonRecord(text);
}
