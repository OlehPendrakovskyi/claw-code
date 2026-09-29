import { resolveCliLaunch, resolveCommandLaunch, type LauncherHost } from '../core/cliLauncher';

/** Either result shape, so expectations can read any field. */
type LaunchResult = { command?: string; args?: string[]; missing?: string };

const NPM = 'C:\\Users\\dev\\AppData\\Roaming\\npm';
const PNPM = 'C:\\Users\\dev\\AppData\\Local\\pnpm';
const NODEJS = 'C:\\Program Files\\nodejs';
const SYSTEM = 'C:\\Windows\\system32';
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


/** A filesystem of paths mapped to file contents, matched case-insensitively
 *  as on Windows; every file counts as executable. */
function fakeHost(files: Record<string, string>): LauncherHost & { reads: string[] } {
    const byPath = new Map(Object.entries(files).map(([file, text]) => [file.toLowerCase(), text]));
    const reads: string[] = [];
    return {
        reads,
        isFile: file => byPath.has(file.toLowerCase()),
        isExecutable: file => byPath.has(file.toLowerCase()),
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

const NODE_EXE = `${NODEJS}\\node.exe`;
const NODE_ON_PATH = { [NODE_EXE]: '' };
const NPM_LAUNCH = { command: NODE_EXE, args: [NPM_SCRIPT] };

/** A fresh module, so the resolution cache never leaks between tests. */
function isolatedResolver(): typeof resolveCliLaunch {
    let isolated: typeof resolveCliLaunch = resolveCliLaunch;
    jest.isolateModules(() => {
        isolated = jest.requireActual('../core/cliLauncher').resolveCliLaunch;
    });
    return isolated;
}

function resolveOnWindows(env: Record<string, string>, files: Record<string, string>): LaunchResult {
    return isolatedResolver()('acpx', 'win32', env, fakeHost(files));
}

describe('cliLauncher', () => {
    describe('on POSIX', () => {
        it.each(['linux', 'darwin'] as const)('runs acpx itself on %s by its absolute path, relying on its shebang', (platform) => {
            const host = fakeHost({ '/usr/local/bin/acpx': '' });
            expect(resolveCliLaunch('acpx', platform, { PATH: '/usr/bin:/usr/local/bin' }, host)).toEqual({ command: '/usr/local/bin/acpx', args: [] });
        });

        it.each(['', '.', 'bin', 'node_modules/.bin'])('ignores the cwd-relative PATH entry %p, which the workspace could fill', (relative) => {
            const planted = { [`${relative === '' ? '.' : relative}/acpx`]: '', 'acpx': '' };
            expect(resolveCliLaunch('acpx', 'linux', { PATH: `${relative}:/opt/none` }, fakeHost(planted))).toEqual({ missing: 'acpx' });
            const launch = resolveCliLaunch('acpx', 'linux', { PATH: `${relative}:/usr/bin` }, fakeHost({ ...planted, '/usr/bin/acpx': '' }));
            expect(launch).toEqual({ command: '/usr/bin/acpx', args: [] });
        });

        it('skips a non-executable acpx', () => {
            const host = { ...fakeHost({ '/a/acpx': '', '/b/acpx': '' }), isExecutable: (file: string) => file === '/b/acpx' };
            expect(resolveCliLaunch('acpx', 'linux', { PATH: '/a:/b' }, host)).toEqual({ command: '/b/acpx', args: [] });
        });

        it('reports acpx missing without a PATH', () => {
            expect(resolveCliLaunch('acpx', 'linux', {}, fakeHost({ 'acpx': '' }))).toEqual({ missing: 'acpx' });
        });
    });

    describe('npm global install', () => {
        it('runs the package bin under the node found on PATH', () => {
            const launch = resolveOnWindows({ PATH: `${SYSTEM};${NODEJS};${NPM}` }, { ...npmInstall(), ...NODE_ON_PATH });
            expect(launch).toEqual(NPM_LAUNCH);
        });

        it('accepts a bin declared as a plain string', () => {
            const launch = resolveOnWindows({ PATH: `${NODEJS};${NPM}` }, { ...npmInstall({ bin: 'dist/cli.js' }), ...NODE_ON_PATH });
            expect(launch).toEqual(NPM_LAUNCH);
        });

        it('prefers a node.exe beside the shim, as the shim itself does', () => {
            const launch = resolveOnWindows({ PATH: `${NODEJS};${NPM}` }, { ...npmInstall(), ...NODE_ON_PATH, [`${NPM}\\node.exe`]: '' });
            expect(launch.command).toBe(`${NPM}\\node.exe`);
        });

        it('reports a missing Node rather than running acpx under VS Code\'s Electron', () => {
            expect(resolveOnWindows({ PATH: NPM }, npmInstall())).toEqual({ missing: 'node' });
        });

        it('reads the script from the .cmd shim when the manifest is unreadable', () => {
            const files = { ...npmInstall(), ...NODE_ON_PATH, [`${NPM}\\node_modules\\acpx\\package.json`]: '{ not json' };
            expect(resolveOnWindows({ PATH: `${NPM};${NODEJS}` }, files)).toEqual(NPM_LAUNCH);
        });

        it('reads the script from the PowerShell shim when that is all there is', () => {
            const files = { [`${NPM}\\acpx.ps1`]: NPM_PS1_SHIM, [NPM_SCRIPT]: '', ...NODE_ON_PATH };
            expect(resolveOnWindows({ PATH: `${NPM};${NODEJS}` }, files)).toEqual(NPM_LAUNCH);
        });
    });

    describe('pnpm global install', () => {
        it('follows the %~dp0-relative script in the pnpm shim', () => {
            const launch = resolveOnWindows({ PATH: `${PNPM};${NODEJS}` }, { ...PNPM_INSTALL, ...NODE_ON_PATH });
            expect(launch).toEqual({ command: NODE_EXE, args: [PNPM_SCRIPT] });
        });

        it('follows an absolute script path in the shim', () => {
            const store = 'D:\\pnpm-store\\acpx\\dist\\cli.js';
            const files = { [`${PNPM}\\acpx.cmd`]: `@SETLOCAL\r\n@"C:\\node\\node.exe"  "${store}" %*\r\n`, [store]: '', ...NODE_ON_PATH };
            expect(resolveOnWindows({ PATH: `${PNPM};${NODEJS}` }, files).args).toEqual([store]);
        });
    });

    describe('PATH search', () => {
        it('takes the first PATH entry that holds a usable acpx', () => {
            const files = { ...npmInstall(), ...PNPM_INSTALL, ...NODE_ON_PATH };
            expect(resolveOnWindows({ PATH: `${PNPM};${NPM};${NODEJS}` }, files).args).toEqual([PNPM_SCRIPT]);
            expect(resolveOnWindows({ PATH: `${NPM};${PNPM};${NODEJS}` }, files).args).toEqual([NPM_SCRIPT]);
        });

        it('skips a shim whose script is gone and keeps searching', () => {
            const files: Record<string, string> = { ...PNPM_INSTALL, ...npmInstall(), ...NODE_ON_PATH };
            delete files[PNPM_SCRIPT];
            expect(resolveOnWindows({ PATH: `${PNPM};${NPM};${NODEJS}` }, files)).toEqual(NPM_LAUNCH);
        });

        it('spawns a native acpx.exe directly', () => {
            expect(resolveOnWindows({ PATH: 'C:\\tools' }, { 'C:\\tools\\acpx.exe': '' })).toEqual({ command: 'C:\\tools\\acpx.exe', args: [] });
        });

        it('honours PATHEXT order between executable extensions', () => {
            const files = { 'C:\\tools\\acpx.exe': '', 'C:\\tools\\acpx.com': '' };
            expect(resolveOnWindows({ PATH: 'C:\\tools', PATHEXT: '.EXE;.COM' }, files).command).toBe('C:\\tools\\acpx.exe');
            expect(resolveOnWindows({ PATH: 'C:\\tools', PATHEXT: '.COM;.EXE' }, files).command).toBe('C:\\tools\\acpx.com');
        });

        it('reads Path and PATHEXT whatever their case, and unquotes PATH entries', () => {
            const launch = resolveOnWindows({ Path: `"${NODEJS}";${NPM}`, PathExt: '.EXE;.CMD' }, { ...npmInstall(), ...NODE_ON_PATH });
            expect(launch).toEqual(NPM_LAUNCH);
        });

        it('reports acpx missing when none is installed', () => {
            expect(resolveOnWindows({ PATH: `${SYSTEM};${NODEJS}` }, NODE_ON_PATH)).toEqual({ missing: 'acpx' });
            expect(resolveOnWindows({}, NODE_ON_PATH)).toEqual({ missing: 'acpx' });
        });

        it.each(['.', 'node_modules\\.bin', 'C:tools', '\\tools', 'tools'])(
            'ignores the cwd-relative PATH entry %p, which the workspace could fill',
            (relative) => {
                const planted = {
                    [`${relative}\\acpx.cmd`]: NPM_CMD_SHIM,
                    [`${relative}\\node_modules\\acpx\\package.json`]: JSON.stringify({ bin: 'dist/cli.js' }),
                    [`${relative}\\node_modules\\acpx\\dist\\cli.js`]: '',
                    [`${relative}\\node.exe`]: '',
                };
                expect(resolveOnWindows({ PATH: relative }, planted)).toEqual({ missing: 'acpx' });
                const launch = resolveOnWindows({ PATH: `${relative};${NPM};${NODEJS}` }, { ...planted, ...npmInstall(), ...NODE_ON_PATH });
                expect(launch).toEqual(NPM_LAUNCH);
            });

        it('never takes node.exe from a cwd-relative PATH entry', () => {
            expect(resolveOnWindows({ PATH: `.;${NPM}` }, { ...npmInstall(), '.\\node.exe': '' })).toEqual({ missing: 'node' });
        });

        it('accepts a UNC PATH entry', () => {
            const share = '\\\\server\\tools';
            expect(resolveOnWindows({ PATH: share }, { [`${share}\\acpx.exe`]: '' })).toEqual({ command: `${share}\\acpx.exe`, args: [] });
        });
    });

    describe('cache', () => {
        let resolve: typeof resolveCliLaunch;
        const env = { PATH: `${NPM};${NODEJS}` };

        beforeEach(() => {
            resolve = isolatedResolver();
        });

        it('reuses the acpx found for an unchanged PATH', () => {
            const host = fakeHost({ ...npmInstall(), ...NODE_ON_PATH });
            const first = resolve('acpx', 'win32', env, host);
            const readsAfterFirst = host.reads.length;
            expect(resolve('acpx', 'win32', env, host)).toEqual(first);
            expect(host.reads).toHaveLength(readsAfterFirst);
        });

        it('resolves again for a different PATH', () => {
            const host = fakeHost({ ...npmInstall(), ...PNPM_INSTALL, ...NODE_ON_PATH });
            expect(resolve('acpx', 'win32', env, host)).toEqual(NPM_LAUNCH);
            expect(resolve('acpx', 'win32', { PATH: `${PNPM};${NODEJS}` }, host)).toEqual({ command: NODE_EXE, args: [PNPM_SCRIPT] });
        });

        it('picks up a Node installed after the first lookup', () => {
            const files: Record<string, string> = npmInstall();
            expect(resolve('acpx', 'win32', env, fakeHost(files))).toEqual({ missing: 'node' });
            Object.assign(files, NODE_ON_PATH);
            expect(resolve('acpx', 'win32', env, fakeHost(files))).toEqual(NPM_LAUNCH);
        });

        it('finds an acpx installed after a failed lookup', () => {
            const files: Record<string, string> = { ...NODE_ON_PATH };
            expect(resolve('acpx', 'win32', env, fakeHost(files))).toEqual({ missing: 'acpx' });
            Object.assign(files, npmInstall());
            expect(resolve('acpx', 'win32', env, fakeHost(files))).toEqual(NPM_LAUNCH);
        });

        it('drops a cached launch whose script was uninstalled', () => {
            const files: Record<string, string> = { ...npmInstall(), ...NODE_ON_PATH };
            expect(resolve('acpx', 'win32', env, fakeHost(files))).toEqual(NPM_LAUNCH);
            delete files[NPM_SCRIPT];
            expect(resolve('acpx', 'win32', env, fakeHost(files))).toEqual({ missing: 'acpx' });
        });
    });
    describe('resolveCommandLaunch', () => {
        const OPENCLAW_SCRIPT = `${NPM}\\node_modules\\openclaw\\openclaw.mjs`;
        const openclawInstall = {
            [`${NPM}\\openclaw.cmd`]: NPM_CMD_SHIM.split('acpx\\dist\\cli.js').join('openclaw\\openclaw.mjs'),
            [`${NPM}\\node_modules\\openclaw\\package.json`]: JSON.stringify({ bin: { openclaw: 'openclaw.mjs' } }),
            [OPENCLAW_SCRIPT]: '#!/usr/bin/env node\n',
        };

        it('runs an npm-installed openclaw on Windows as its JS entry under Node', () => {
            const launch = resolveCommandLaunch('openclaw', 'win32', { Path: `.;${NPM};${NODEJS}` }, fakeHost({ ...openclawInstall, ...NODE_ON_PATH }));
            expect(launch).toEqual({ command: NODE_EXE, args: [OPENCLAW_SCRIPT] });
        });

        it('finds a name given with its native extension as that file only', () => {
            const host = fakeHost({ [`${NPM}\\openclaw.exe`]: '', ...openclawInstall });
            expect(resolveCommandLaunch('openclaw.exe', 'win32', { Path: NPM }, host)).toEqual({ command: `${NPM}\\openclaw.exe`, args: [] });
            expect(resolveCommandLaunch('openclaw.exe', 'win32', { Path: NODEJS }, host)).toEqual({ missing: 'openclaw.exe' });
        });

        it('keeps an absolute command, and refuses a relative one, which resolves against the cwd', () => {
            expect(resolveCommandLaunch('/opt/openclaw/bin/openclaw', 'linux', {}, fakeHost({}))).toEqual({ command: '/opt/openclaw/bin/openclaw', args: [] });
            expect(resolveCommandLaunch('C:\\Tools\\openclaw.exe', 'win32', {}, fakeHost({}))).toEqual({ command: 'C:\\Tools\\openclaw.exe', args: [] });
            expect(resolveCommandLaunch('./bin/openclaw', 'linux', { PATH: '/usr/bin' }, fakeHost({ '/usr/bin/openclaw': '' }))).toEqual({ missing: './bin/openclaw' });
            expect(resolveCommandLaunch('tools\\openclaw.exe', 'win32', { Path: NPM }, fakeHost({}))).toEqual({ missing: 'tools\\openclaw.exe' });
        });

        it('finds a bare name on the absolute POSIX PATH entries only', () => {
            const host = fakeHost({ 'bin/openclaw': '', '/usr/local/bin/openclaw': '' });
            expect(resolveCommandLaunch('openclaw', 'linux', { PATH: '.:bin:/usr/local/bin' }, host)).toEqual({ command: '/usr/local/bin/openclaw', args: [] });
            expect(resolveCommandLaunch('openclaw', 'linux', { PATH: '.:bin' }, host)).toEqual({ missing: 'openclaw' });
        });

        it('keeps the cache of one CLI apart from another in the same folder', () => {
            const resolve = isolatedResolver();
            const host = fakeHost({ ...npmInstall(), ...openclawInstall, ...NODE_ON_PATH });
            const env = { PATH: `${NPM};${NODEJS}` };
            expect(resolve('acpx', 'win32', env, host)).toEqual(NPM_LAUNCH);
            expect(resolve('openclaw', 'win32', env, host)).toEqual({ command: NODE_EXE, args: [OPENCLAW_SCRIPT] });
        });
    });
});
