import * as fs from 'fs';
import * as path from 'path';

/** How to start acpx: `command` with `args` before acpx's own, plus extra env. */
export type AcpxLaunch = {
    command: string;
    args: string[];
    env: Record<string, string>;
};

/** The filesystem reads the resolver needs, injectable for tests. */
export type LauncherHost = {
    isFile(filePath: string): boolean;
    readText(filePath: string): string | undefined;
    /** The Electron binary VS Code runs on, used as Node when no node is found. */
    execPath: string;
};

type Env = Record<string, string | undefined>;

const ACPX = 'acpx';
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
    readText(filePath) {
        try {
            return fs.readFileSync(filePath, 'utf8');
        } catch {
            return undefined;
        }
    },
    execPath: process.execPath,
};

const cache = new Map<string, AcpxLaunch>();

/** Windows cannot spawn npm's `acpx.cmd` without a shell, so acpx's JS entry
 *  runs under Node instead; POSIX runs `acpx` itself through its shebang.
 *  Null when no acpx is installed. */
export function resolveAcpxLaunch(
    platform: NodeJS.Platform = process.platform,
    env: Env = process.env,
    host: LauncherHost = nodeHost
): AcpxLaunch | null {
    if (platform !== 'win32') {
        return { command: ACPX, args: [], env: {} };
    }
    const searchPath = envValue(env, 'PATH') ?? '';
    const pathExt = envValue(env, 'PATHEXT') ?? DEFAULT_PATHEXT;
    const cacheKey = `${searchPath}\0${pathExt}`;
    const cached = cache.get(cacheKey);
    // Revalidated, since an uninstall leaves PATH unchanged.
    if (cached && [cached.command, ...cached.args].every(file => host.isFile(file))) {
        return cached;
    }
    const launch = findWindowsLaunch(searchPath, pathExt, host);
    if (launch) {
        cache.set(cacheKey, launch);
    }
    return launch;
}

/** Windows env names are case-insensitive, a plain copy of the env is not. */
function envValue(env: Env, name: string): string | undefined {
    const key = Object.keys(env).find(candidate => candidate.toUpperCase() === name);
    return key === undefined ? undefined : env[key];
}

function pathDirs(searchPath: string): string[] {
    return searchPath.split(';').map(dir => dir.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
}

function findWindowsLaunch(searchPath: string, pathExt: string, host: LauncherHost): AcpxLaunch | null {
    const executableExtensions = pathExt.split(';').map(ext => ext.trim().toLowerCase()).filter(Boolean);
    const extensions = [...new Set([...executableExtensions, ...SHIM_EXTENSIONS])];
    for (const dir of pathDirs(searchPath)) {
        const found = extensions.find(ext => host.isFile(path.win32.join(dir, ACPX + ext)));
        if (found === undefined) {
            continue;
        }
        if (NATIVE_EXTENSIONS.has(found)) {
            return { command: path.win32.join(dir, ACPX + found), args: [], env: {} };
        }
        const script = packageBinScript(dir, host) ?? shimScript(dir, host);
        if (script) {
            return { ...nodeLaunch(dir, searchPath, host), args: [script] };
        }
    }
    return null;
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

/** The Node the shim itself would pick, else VS Code's Electron run as Node. */
function nodeLaunch(shimDir: string, searchPath: string, host: LauncherHost): Omit<AcpxLaunch, 'args'> {
    const bundled = path.win32.join(shimDir, 'node.exe');
    if (host.isFile(bundled)) {
        return { command: bundled, env: {} };
    }
    const onPath = pathDirs(searchPath).map(dir => path.win32.join(dir, 'node.exe')).find(candidate => host.isFile(candidate));
    if (onPath) {
        return { command: onPath, env: {} };
    }
    return { command: host.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
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
