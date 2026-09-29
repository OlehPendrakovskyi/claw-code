import { envWithAbsolutePath } from '../core/searchPath';

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
});
