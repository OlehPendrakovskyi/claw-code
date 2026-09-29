import { envWithAbsolutePath, resolveOnAbsolutePath } from '../core/searchPath';

describe('searchPath', () => {
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
        });

        it('leaves one Windows PATH spelling, as Windows reads any of them', () => {
            expect(envWithAbsolutePath('win32', { PATH: 'C:\\Git\\cmd;tools', Path: '.;node_modules\\.bin', HOME: 'h' })).toEqual({ PATH: 'C:\\Git\\cmd', HOME: 'h' });
            expect(envWithAbsolutePath('win32', { Path: 'tools', path: '.' })).toEqual({});
        });
    });

    describe('resolveOnAbsolutePath', () => {
        const on = (...files: string[]) => (candidate: string) => files.includes(candidate);

        it('keeps an absolute command as given', () => {
            expect(resolveOnAbsolutePath('/opt/openclaw/bin/openclaw', 'linux', {}, on())).toBe('/opt/openclaw/bin/openclaw');
            expect(resolveOnAbsolutePath('C:\\Tools\\openclaw.exe', 'win32', {}, on())).toBe('C:\\Tools\\openclaw.exe');
        });

        it('finds a bare name on the absolute PATH entries only', () => {
            expect(resolveOnAbsolutePath('openclaw', 'linux', { PATH: '.:bin:/usr/local/bin' }, on('bin/openclaw', '/usr/local/bin/openclaw'))).toBe('/usr/local/bin/openclaw');
            expect(resolveOnAbsolutePath('openclaw', 'linux', { PATH: '.:bin' }, () => true)).toBeUndefined();
        });

        it('looks for what spawn can run on Windows, never in the cwd', () => {
            const found = resolveOnAbsolutePath('wsl', 'win32', { Path: '.;C:\\Windows\\System32' }, on('C:\\Windows\\System32\\wsl.exe'));
            expect(found).toBe('C:\\Windows\\System32\\wsl.exe');
            expect(resolveOnAbsolutePath('openclaw', 'win32', { Path: 'C:\\npm' }, on('C:\\npm\\openclaw.cmd'))).toBeUndefined();
        });

        it('refuses a relative path, which resolves against the cwd', () => {
            expect(resolveOnAbsolutePath('./bin/openclaw', 'linux', { PATH: '/usr/bin' }, () => true)).toBeUndefined();
            expect(resolveOnAbsolutePath('tools\\openclaw.exe', 'win32', { Path: 'C:\\x' }, () => true)).toBeUndefined();
        });
    });
});
