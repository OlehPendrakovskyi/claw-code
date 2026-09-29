import * as vscode from 'vscode';
import { envWithAbsolutePath, findGitOnPath, resolveGitExecutable } from '../webview/gitExecutable';

type ExtensionsStub = { getExtension: (id: string) => unknown };

describe('gitExecutable', () => {
    afterEach(() => {
        delete (vscode as { extensions?: ExtensionsStub }).extensions;
    });

    describe('findGitOnPath', () => {
        it('skips relative POSIX PATH entries a workspace could plant git in', () => {
            const found = findGitOnPath('linux', { PATH: 'bin:./tools::/usr/bin' }, candidate => candidate !== '/nope');
            expect(found).toBe('/usr/bin/git');
        });

        it('takes only drive-absolute or UNC Windows entries, and git.exe', () => {
            const seen: string[] = [];
            const found = findGitOnPath('win32', { Path: 'tools;\\rooted;"C:\\Program Files\\Git\\cmd"' }, candidate => {
                seen.push(candidate);
                return true;
            });
            expect(seen).toEqual(['C:\\Program Files\\Git\\cmd\\git.exe']);
            expect(found).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
        });

        it('finds nothing when no absolute entry holds git', () => {
            expect(findGitOnPath('linux', { PATH: '.:bin' }, () => true)).toBeUndefined();
        });
    });

    describe('envWithAbsolutePath', () => {
        it('drops relative PATH entries under the env\'s own key spelling', () => {
            expect(envWithAbsolutePath('win32', { Path: '.;C:\\Git\\cmd;tools', HOME: 'h' })).toEqual({ Path: 'C:\\Git\\cmd', HOME: 'h' });
            expect(envWithAbsolutePath('linux', { PATH: '.:/usr/bin:bin' })).toEqual({ PATH: '/usr/bin' });
        });

        it('drops PATH when no absolute entry is left, as an empty POSIX PATH searches the cwd', () => {
            expect(envWithAbsolutePath('linux', { PATH: '.:bin', HOME: 'h' })).toEqual({ HOME: 'h' });
            expect(envWithAbsolutePath('linux', { PATH: '' })).toEqual({});
            expect(envWithAbsolutePath('win32', { Path: 'tools' })).toEqual({});
        });

        it('cleans the POSIX PATH, not a differently cased variable', () => {
            expect(envWithAbsolutePath('linux', { Path: 'bin', PATH: '.:/usr/bin' })).toEqual({ Path: 'bin', PATH: '/usr/bin' });
            expect(findGitOnPath('linux', { Path: '/elsewhere', PATH: '/usr/bin' }, candidate => candidate.startsWith('/usr/bin'))).toBe('/usr/bin/git');
        });
    });

    describe('resolveGitExecutable', () => {
        it('prefers the Git extension\'s absolute git path', async () => {
            (vscode as { extensions?: ExtensionsStub }).extensions = {
                getExtension: () => ({ isActive: true, exports: { getAPI: () => ({ git: { path: '/opt/git/bin/git' } }) } }),
            };
            await expect(resolveGitExecutable()).resolves.toBe('/opt/git/bin/git');
        });

        it('ignores a relative path from the Git extension', async () => {
            (vscode as { extensions?: ExtensionsStub }).extensions = {
                getExtension: () => ({ isActive: true, exports: { getAPI: () => ({ git: { path: 'git' } }) } }),
            };
            const resolved = await resolveGitExecutable();
            expect(resolved === undefined || resolved.startsWith('/')).toBe(true);
        });
    });
});
