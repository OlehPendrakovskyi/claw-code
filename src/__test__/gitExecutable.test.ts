import * as path from 'path';
import * as vscode from 'vscode';
import { findGitOnPath, resolveGitExecutable } from '../webview/gitExecutable';

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

        it('searches the POSIX PATH, not a differently cased variable', () => {
            expect(findGitOnPath('linux', { Path: '/elsewhere', PATH: '/usr/bin' }, candidate => candidate.startsWith('/usr/bin'))).toBe('/usr/bin/git');
        });

        it('finds nothing when no absolute entry holds git', () => {
            expect(findGitOnPath('linux', { PATH: '.:bin' }, () => true)).toBeUndefined();
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
            // Whatever git this machine has, it is found by an absolute path (`C:\\...` on Windows).
            expect(resolved === undefined || path.isAbsolute(resolved)).toBe(true);
        });
    });
});
