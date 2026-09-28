import * as fs from 'fs';
import * as path from 'path';

/** How to start acpx: `command` with `args` before acpx's own. */
export type AcpxLaunch = {
    command: string;
    args: string[];
};

/** What kept acpx from launching. */
export type AcpxLaunchFailure = {
    missing: 'acpx' | 'node';
};

/** The filesystem reads the resolver needs, injectable for tests. */
export type LauncherHost = {
    isFile(filePath: string): boolean;
    readText(filePath: string): string | undefined;
};

type Env = Record<string, string | undefined>;

/** An acpx found on PATH: a native binary, or a JS entry its shim runs under Node. */
type AcpxEntry = { native: string } | { script: string; shimDir: string };

const ACPX = 'acpx';
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const SHIM_EXTENSIONS = ['.cmd', '.bat', '.ps1', ''];
const NATIVE_EXTENSIONS = new Set(['.exe', '.com']);

/** Script paths in npm (`%dp0%\`, `$basedir/`) and pnpm (`%~dp0\`, absolute) shims. */
const RELATIVE_SCRIPT_PATTERN = /"(?:%~dp0%?|%dp0%|\$basedir)[\\/]([^"%$]+?\.[cm]?js)"/i;
const ABSOLUTE_SCRIPT_PATTERN = /"([A-Za-z]:\\[^"%$]+?\.[cm]?js)"/;

/** A drive-absolute (`C:\x`) or UNC (`\\host\share`) path; anything else
 *  resolves against the cwd, which is the workspace a repo controls. */
const FULLY_QUALIFIED_PATH = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/;

const nodeHost: LauncherHost = {
    isFile(filePath) {
        try {
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

const entryCache = new Map<string, AcpxEntry>();

/** Windows cannot spawn npm's `acpx.cmd` without a shell, so acpx's JS entry
 *  runs under Node instead; POSIX runs `acpx` itself through its shebang. */
export function resolveAcpxLaunch(
    platform: NodeJS.Platform = process.platform,
    env: Env = process.env,
    host: LauncherHost = nodeHost
): AcpxLaunch | AcpxLaunchFailure {
    if (platform !== 'win32') {
        return { command: ACPX, args: [] };
    }
    const dirs = searchDirs(envValue(env, 'PATH') ?? '');
    const pathExt = envValue(env, 'PATHEXT') ?? DEFAULT_PATHEXT;
    const entry = cachedEntry(dirs, pathExt, host);
    if (!entry) {
        return { missing: ACPX };
    }
    if ('native' in entry) {
        return { command: entry.native, args: [] };
    }
    // Chosen afresh each time, so a Node installed later is picked up.
    const node = findNode(entry.shimDir, dirs, host);
    return node === undefined ? { missing: 'node' } : { command: node, args: [entry.script] };
}

/** Only fully qualified PATH entries count, so the cache key is cwd-independent. */
function cachedEntry(dirs: string[], pathExt: string, host: LauncherHost): AcpxEntry | undefined {
    const key = `${dirs.join(';')}\0${pathExt}`;
    const cached = entryCache.get(key);
    // Revalidated, since an uninstall leaves PATH unchanged.
    if (cached && host.isFile('native' in cached ? cached.native : cached.script)) {
        return cached;
    }
    const entry = findAcpxEntry(dirs, pathExt, host);
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

function searchDirs(searchPath: string): string[] {
    return searchPath
        .split(';')
        .map(dir => dir.trim().replace(/^"(.*)"$/, '$1'))
        .filter(dir => FULLY_QUALIFIED_PATH.test(dir));
}

function findAcpxEntry(dirs: string[], pathExt: string, host: LauncherHost): AcpxEntry | undefined {
    const executableExtensions = pathExt.split(';').map(ext => ext.trim().toLowerCase()).filter(Boolean);
    const extensions = [...new Set([...executableExtensions, ...SHIM_EXTENSIONS])];
    for (const dir of dirs) {
        const found = extensions.find(ext => host.isFile(path.win32.join(dir, ACPX + ext)));
        if (found === undefined) {
            continue;
        }
        if (NATIVE_EXTENSIONS.has(found)) {
            return { native: path.win32.join(dir, ACPX + found) };
        }
        const script = packageBinScript(dir, host) ?? shimScript(dir, host);
        if (script) {
            return { script, shimDir: dir };
        }
    }
    return undefined;
}

/** npm's global layout keeps the package beside its shims. */
function packageBinScript(shimDir: string, host: LauncherHost): string | undefined {
    const packageDir = path.win32.join(shimDir, 'node_modules', ACPX);
    const manifest = parseJson(host.readText(path.win32.join(packageDir, 'package.json')));
    const bin = manifest?.bin;
    const entry = typeof bin === 'string' ? bin : asRecord(bin)?.[ACPX];
    if (typeof entry !== 'string') {
        return undefined;
    }
    const script = path.win32.join(packageDir, entry);
    return host.isFile(script) ? script : undefined;
}

/** Other layouts (pnpm, a project's .bin) are found from the path the shim runs. */
function shimScript(shimDir: string, host: LauncherHost): string | undefined {
    for (const ext of SHIM_EXTENSIONS) {
        const text = host.readText(path.win32.join(shimDir, ACPX + ext));
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
 *  acpx re-runs `process.execPath` for agents, which would open an editor window. */
function findNode(shimDir: string, dirs: string[], host: LauncherHost): string | undefined {
    return [shimDir, ...dirs].map(dir => path.win32.join(dir, 'node.exe')).find(candidate => host.isFile(candidate));
}

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
    if (text === undefined) {
        return undefined;
    }
    try {
        return asRecord(JSON.parse(text.replace(/^\uFEFF/, '')));
    } catch {
        return undefined;
    }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
