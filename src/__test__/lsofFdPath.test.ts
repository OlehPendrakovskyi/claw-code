import type { MockedFunction } from 'vitest';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { LSOF_PATH, LSOF_RETRY_AFTER_MS, LSOF_TIMEOUT_MS, decodeLsofName, lsofNameForFd, lsofShowsUnambiguously } from '../webview/lsofFdPath';
import { makeTempDir } from './helpers/tempDir';

// The real execFile unless a test answers for it, so the macOS tests still reach lsof.
vi.mock('child_process', async () => {
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    return { ...actual, execFile: vi.fn(actual.execFile) };
});

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

describe('lsofFdPath', () => {
    describe('lsofNameForFd', () => {
        // A fresh module per test, so one test's failed run never backs off the next test's lsof.
        let lsof: typeof import('../webview/lsofFdPath');
        let execFileMock: MockedFunction<typeof childProcess.execFile>;
        let now: number;

        /** Answers the next lsof call with `stdout`, or fails it with `error`. */
        const answer = (stdout: string, error: Error | null = null): void => {
            execFileMock.mockImplementationOnce(((_file: string, _args: string[], _options: object, callback: ExecFileCallback) => {
                callback(error, stdout, '');
                return {} as childProcess.ChildProcess;
            }) as typeof childProcess.execFile);
        };
        const fail = () => answer('', Object.assign(new Error('spawn /usr/sbin/lsof ENOENT'), { code: 'ENOENT' }));

        beforeEach(async () => {
            vi.resetModules();
            lsof = await vi.importActual<typeof import('../webview/lsofFdPath')>('../webview/lsofFdPath');
            execFileMock = (await vi.importMock<typeof childProcess>('child_process')).execFile as unknown as MockedFunction<typeof childProcess.execFile>;
            execFileMock.mockClear();
            now = 1_000_000;
            vi.spyOn(Date, 'now').mockImplementation(() => now);
        });

        afterEach(() => {
            vi.mocked(Date.now).mockRestore();
        });

        it('asks the absolute lsof about this process\'s fd, in a UTF-8 locale and with a timeout', async () => {
            answer(`p${process.pid}\nf7\nn/work/a.ts\n`);
            await lsof.lsofNameForFd(7);
            expect(execFileMock).toHaveBeenCalledWith(
                LSOF_PATH,
                ['-w', '-a', '-p', String(process.pid), '-d', '7', '-Fn'],
                { env: { LC_ALL: 'en_US.UTF-8' }, timeout: LSOF_TIMEOUT_MS, encoding: 'utf8' },
                expect.any(Function),
            );
            expect(path.isAbsolute(LSOF_PATH)).toBe(true);
        });

        it('returns the name field of the output', async () => {
            answer(`p${process.pid}\nf7\nn/work/with space/a.ts\n`);
            expect(await lsof.lsofNameForFd(7)).toBe('/work/with space/a.ts');
        });

        it('cannot tell when lsof fails, times out or is missing', async () => {
            fail();
            expect(await lsof.lsofNameForFd(7)).toBeUndefined();
        });

        it('cannot tell when the output names no file', async () => {
            answer(`p${process.pid}\nf7\n`);
            expect(await lsof.lsofNameForFd(7)).toBeUndefined();
        });

        it('does not ask a failed lsof again until the retry delay has passed', async () => {
            fail();
            await lsof.lsofNameForFd(7);
            now += LSOF_RETRY_AFTER_MS - 1;
            expect(await lsof.lsofNameForFd(8)).toBeUndefined();
            expect(execFileMock).toHaveBeenCalledTimes(1);
            now += 1;
            answer(`p${process.pid}\nf9\nn/work/a.ts\n`);
            expect(await lsof.lsofNameForFd(9)).toBe('/work/a.ts');
            expect(execFileMock).toHaveBeenCalledTimes(2);
        });

        it('keeps asking an lsof that answers', async () => {
            answer(`p${process.pid}\nf7\nn/work/a.ts\n`);
            answer(`p${process.pid}\nf8\nn/work/b.ts\n`);
            await lsof.lsofNameForFd(7);
            expect(await lsof.lsofNameForFd(8)).toBe('/work/b.ts');
            expect(execFileMock).toHaveBeenCalledTimes(2);
        });
    });

    describe('lsofShowsUnambiguously', () => {
        it('accepts printable names, backslashes and non-ASCII included', () => {
            expect(lsofShowsUnambiguously('/w/back\\slash нотатка 📎 "q" 100%.txt')).toBe(true);
        });

        it('refuses a caret or a control character, which lsof prints alike', () => {
            for (const filePath of ['/w/caret^A.txt', '/w/ctl\x01.txt', '/w/tab\t.txt', '/w/nl\n.txt']) {
                expect(lsofShowsUnambiguously(filePath)).toBe(false);
            }
        });
    });

    describe('decodeLsofName', () => {
        it('undoes lsof\'s backslash escapes and hex bytes', () => {
            expect(decodeLsofName('/w/back\\\\slash\\tx\\nx\\x7fx\\xe2\\x80\\x8bx')).toBe('/w/back\\slash\tx\nx\x7fx\u200bx');
        });

        it('keeps characters outside the BMP whole', () => {
            expect(decodeLsofName('/w/clip-📎.txt')).toBe('/w/clip-📎.txt');
        });

        it('refuses a caret, which may stand for a control character', () => {
            expect(decodeLsofName('/w/ctl^Ax')).toBeUndefined();
        });

        it('refuses an escape lsof never writes', () => {
            for (const name of ['/w/\\q', '/w/\\x4', '/w/\\xzz', '/w/trailing\\']) {
                expect(decodeLsofName(name)).toBeUndefined();
            }
        });
    });

    describe('lsofNameForFd against the real lsof', () => {
        const macOnly = process.platform === 'darwin' ? it : it.skip;
        let dir: string;

        beforeEach(() => {
            if (process.platform === 'darwin') {
                dir = makeTempDir('claw-lsof-');
            }
        });

        afterEach(() => {
            if (process.platform === 'darwin') {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        // Names seen escaped or kept by lsof on a macOS runner; each must decode back to itself.
        macOnly.each([
            'plain.txt', 'with space.txt', 'нотатка.txt', 'clip-📎.txt', 'back\\slash.txt', 'tab\tx', 'nl\nx',
            'del\x7fx', 'zero\u200bwidth', 'nbsp\u00a0x', 'c1\u0085x', 'rtl\u202ex', 'pct%x', 'quote"x',
        ])(
            'reports %j so that it decodes to the opened path',
            async (name) => {
                const file = path.join(dir, name);
                fs.writeFileSync(file, 'x');
                const handle = await fs.promises.open(file, 'r');
                try {
                    expect(decodeLsofName((await lsofNameForFd(handle.fd))!)).toBe(file);
                } finally {
                    await handle.close();
                }
            },
        );

        macOnly('follows the opened file when its parent directory is renamed', async () => {
            const original = path.join(dir, 'a');
            fs.mkdirSync(original);
            fs.writeFileSync(path.join(original, 'note.txt'), 'x');
            const handle = await fs.promises.open(path.join(original, 'note.txt'), 'r');
            try {
                fs.renameSync(original, path.join(dir, 'b'));
                expect(decodeLsofName((await lsofNameForFd(handle.fd))!)).toBe(path.join(dir, 'b', 'note.txt'));
            } finally {
                await handle.close();
            }
        });
    });
});
