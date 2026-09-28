import { resolveAcpxLaunch, LauncherHost } from '../chat/acpxLauncher';

const NPM = 'C:\\Users\\dev\\AppData\\Roaming\\npm';
const PNPM = 'C:\\Users\\dev\\AppData\\Local\\pnpm';
const NODEJS = 'C:\\Program Files\\nodejs';
const SYSTEM = 'C:\\Windows\\system32';
const CODE = 'C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe';
const NPM_SCRIPT = `${NPM}\\node_modules\\acpx\\dist\\cli.js`;
const PNPM_SCRIPT = `${PNPM}\\global\\5\\node_modules\\acpx\\dist\\cli.js`;

/** cmd-shim 8 (npm) output for acpx's `dist/cli.js` bin, verbatim. */
const NPM_CMD_SHIM = [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\acpx\\dist\\cli.js" %*', '',
].join('\r\n');

/** @zkochan/cmd-shim (pnpm 10) output for a global install. */
const PNPM_CMD_SHIM = [
    '@SETLOCAL',
    '@IF NOT DEFINED NODE_PATH (', `  @SET "NODE_PATH=${PNPM}\\global\\5\\node_modules"`, ') ELSE (',
    `  @SET "NODE_PATH=${PNPM}\\global\\5\\node_modules;%NODE_PATH%"`, ')',
    '@IF EXIST "%~dp0\\node.exe" (', '  "%~dp0\\node.exe"  "%~dp0\\global\\5\\node_modules\\acpx\\dist\\cli.js" %*',
    ') ELSE (', '  @SET PATHEXT=%PATHEXT:;.JS;=;%', '  node  "%~dp0\\global\\5\\node_modules\\acpx\\dist\\cli.js" %*', ')', '',
].join('\r\n');

const NPM_PS1_SHIM = '#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n'
    + '& "$basedir/node$exe"  "$basedir/node_modules/acpx/dist/cli.js" $args\n';

/** A Windows filesystem with VS Code installed: case-insensitive paths mapped to file contents. */
function fakeHost(files: Record<string, string>): LauncherHost & { reads: string[] } {
    const byPath = new Map(Object.entries({ ...files, [CODE]: '' }).map(([file, text]) => [file.toLowerCase(), text]));
    const reads: string[] = [];
    return {
        reads,
        execPath: CODE,
        isFile: file => byPath.has(file.toLowerCase()),
        readText: (file) => {
            reads.push(file);
            return byPath.get(file.toLowerCase());
        },
    };
}

function npmInstall(manifest: object = { bin: { acpx: 'dist/cli.js' } }): Record<string, string> {
    return {
        [`${NPM}\\acpx`]: '#!/bin/sh\n',
        [`${NPM}\\acpx.cmd`]: NPM_CMD_SHIM,
        [`${NPM}\\acpx.ps1`]: NPM_PS1_SHIM,
        [`${NPM}\\node_modules\\acpx\\package.json`]: JSON.stringify(manifest),
        [NPM_SCRIPT]: '#!/usr/bin/env node\n',
    };
}

const PNPM_INSTALL = {
    [`${PNPM}\\acpx`]: '#!/bin/sh\n',
    [`${PNPM}\\acpx.cmd`]: PNPM_CMD_SHIM,
    [PNPM_SCRIPT]: '#!/usr/bin/env node\n',
};

const NODE_ON_PATH = { [`${NODEJS}\\node.exe`]: '' };

function resolveOnWindows(env: Record<string, string>, host: LauncherHost): ReturnType<typeof resolveAcpxLaunch> {
    // A fresh module per call: the resolution cache must not leak between tests.
    let isolatedResolve: typeof resolveAcpxLaunch = resolveAcpxLaunch;
    jest.isolateModules(() => {
        isolatedResolve = jest.requireActual('../chat/acpxLauncher').resolveAcpxLaunch;
    });
    return isolatedResolve('win32', env, host);
}

describe('resolveAcpxLaunch', () => {
    describe('on POSIX', () => {
        it.each(['linux', 'darwin'] as const)('runs acpx itself on %s, relying on its shebang', (platform) => {
            expect(resolveAcpxLaunch(platform, {}, fakeHost({}))).toEqual({ command: 'acpx', args: [], env: {} });
        });
    });

    describe('npm global install', () => {
        it('runs the package bin under the node found on PATH', () => {
            const host = fakeHost({ ...npmInstall(), ...NODE_ON_PATH });
            const launch = resolveOnWindows({ PATH: `${SYSTEM};${NODEJS};${NPM}` }, host);
            expect(launch).toEqual({ command: `${NODEJS}\\node.exe`, args: [NPM_SCRIPT], env: {} });
        });

        it('accepts a bin declared as a plain string', () => {
            const host = fakeHost({ ...npmInstall({ bin: 'dist/cli.js' }), ...NODE_ON_PATH });
            expect(resolveOnWindows({ PATH: `${NODEJS};${NPM}` }, host)?.args).toEqual([NPM_SCRIPT]);
        });

        it('prefers a node.exe beside the shim, as the shim itself does', () => {
            const host = fakeHost({ ...npmInstall(), ...NODE_ON_PATH, [`${NPM}\\node.exe`]: '' });
            expect(resolveOnWindows({ PATH: `${NODEJS};${NPM}` }, host)?.command).toBe(`${NPM}\\node.exe`);
        });

        it('falls back to VS Code\'s Electron run as Node when no node is installed', () => {
            const launch = resolveOnWindows({ PATH: NPM }, fakeHost(npmInstall()));
            expect(launch).toEqual({ command: CODE, args: [NPM_SCRIPT], env: { ELECTRON_RUN_AS_NODE: '1' } });
        });

        it('reads the script from the .cmd shim when the manifest is unreadable', () => {
            const files = npmInstall();
            files[`${NPM}\\node_modules\\acpx\\package.json`] = '{ not json';
            expect(resolveOnWindows({ PATH: NPM }, fakeHost(files))?.args).toEqual([NPM_SCRIPT]);
        });

        it('reads the script from the PowerShell shim when that is all there is', () => {
            const host = fakeHost({ [`${NPM}\\acpx.ps1`]: NPM_PS1_SHIM, [NPM_SCRIPT]: '' });
            expect(resolveOnWindows({ PATH: NPM }, host)?.args).toEqual([NPM_SCRIPT]);
        });
    });

    describe('pnpm global install', () => {
        it('follows the %~dp0-relative script in the pnpm shim', () => {
            const host = fakeHost({ ...PNPM_INSTALL, ...NODE_ON_PATH });
            const launch = resolveOnWindows({ PATH: `${PNPM};${NODEJS}` }, host);
            expect(launch).toEqual({ command: `${NODEJS}\\node.exe`, args: [PNPM_SCRIPT], env: {} });
        });

        it('follows an absolute script path in the shim', () => {
            const store = 'D:\\pnpm-store\\acpx\\dist\\cli.js';
            const host = fakeHost({ [`${PNPM}\\acpx.cmd`]: `@SETLOCAL\r\n@"C:\\node\\node.exe"  "${store}" %*\r\n`, [store]: '' });
            expect(resolveOnWindows({ PATH: PNPM }, host)?.args).toEqual([store]);
        });
    });

    describe('PATH search', () => {
        it('takes the first PATH entry that holds a usable acpx', () => {
            const host = fakeHost({ ...npmInstall(), ...PNPM_INSTALL });
            expect(resolveOnWindows({ PATH: `${PNPM};${NPM}` }, host)?.args).toEqual([PNPM_SCRIPT]);
            expect(resolveOnWindows({ PATH: `${NPM};${PNPM}` }, host)?.args).toEqual([NPM_SCRIPT]);
        });

        it('skips a shim whose script is gone and keeps searching', () => {
            const files: Record<string, string> = { ...PNPM_INSTALL, ...npmInstall() };
            delete files[PNPM_SCRIPT];
            expect(resolveOnWindows({ PATH: `${PNPM};${NPM}` }, fakeHost(files))?.args).toEqual([NPM_SCRIPT]);
        });

        it('spawns a native acpx.exe directly', () => {
            const host = fakeHost({ 'C:\\tools\\acpx.exe': '' });
            expect(resolveOnWindows({ PATH: 'C:\\tools' }, host)).toEqual({ command: 'C:\\tools\\acpx.exe', args: [], env: {} });
        });

        it('honours PATHEXT order between executable extensions', () => {
            const host = fakeHost({ 'C:\\tools\\acpx.exe': '', 'C:\\tools\\acpx.com': '' });
            expect(resolveOnWindows({ PATH: 'C:\\tools', PATHEXT: '.EXE;.COM' }, host)?.command).toBe('C:\\tools\\acpx.exe');
            expect(resolveOnWindows({ PATH: 'C:\\tools', PATHEXT: '.COM;.EXE' }, host)?.command).toBe('C:\\tools\\acpx.com');
        });

        it('reads Path and PATHEXT whatever their case, and unquotes PATH entries', () => {
            const host = fakeHost({ ...npmInstall(), ...NODE_ON_PATH });
            const launch = resolveOnWindows({ Path: `"${NODEJS}";${NPM}`, PathExt: '.EXE;.CMD' }, host);
            expect(launch).toEqual({ command: `${NODEJS}\\node.exe`, args: [NPM_SCRIPT], env: {} });
        });

        it('returns null when no acpx is installed', () => {
            expect(resolveOnWindows({ PATH: `${SYSTEM};${NODEJS}` }, fakeHost(NODE_ON_PATH))).toBeNull();
            expect(resolveOnWindows({}, fakeHost(NODE_ON_PATH))).toBeNull();
        });
    });

    describe('cache', () => {
        let isolatedResolve: typeof resolveAcpxLaunch;

        beforeEach(() => {
            jest.isolateModules(() => {
                isolatedResolve = jest.requireActual('../chat/acpxLauncher').resolveAcpxLaunch;
            });
        });

        it('reuses the resolution for an unchanged PATH', () => {
            const host = fakeHost(npmInstall());
            const first = isolatedResolve('win32', { PATH: NPM }, host);
            const readsAfterFirst = host.reads.length;
            expect(isolatedResolve('win32', { PATH: NPM }, host)).toBe(first);
            expect(host.reads).toHaveLength(readsAfterFirst);
        });

        it('resolves again for a different PATH', () => {
            const host = fakeHost({ ...npmInstall(), ...PNPM_INSTALL });
            expect(isolatedResolve('win32', { PATH: NPM }, host)?.args).toEqual([NPM_SCRIPT]);
            expect(isolatedResolve('win32', { PATH: PNPM }, host)?.args).toEqual([PNPM_SCRIPT]);
        });

        it('drops a cached launch whose script was uninstalled', () => {
            const files: Record<string, string> = npmInstall();
            expect(isolatedResolve('win32', { PATH: NPM }, fakeHost(files))).not.toBeNull();
            delete files[NPM_SCRIPT];
            expect(isolatedResolve('win32', { PATH: NPM }, fakeHost(files))).toBeNull();
        });
    });
});
