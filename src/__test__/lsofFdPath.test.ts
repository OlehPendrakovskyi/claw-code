import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { LSOF_PATH, LSOF_TIMEOUT_MS, openedPathFromLsof } from '../webview/lsofFdPath';
import { makeTempDir } from './helpers/tempDir';

// The real execFile unless a test answers for it, so the macOS tests still reach lsof.
jest.mock('child_process', () => {
    const actual = jest.requireActual<typeof import('child_process')>('child_process');
    return { ...actual, execFile: jest.fn(actual.execFile) };
});

const execFileMock = jest.mocked(childProcess.execFile);

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

describe('lsofFdPath', () => {
    describe('openedPathFromLsof', () => {
        /** Answers the next lsof call with `stdout`, or fails it with `error`. */
        const answer = (stdout: string, error: Error | null = null): void => {
            execFileMock.mockImplementationOnce(((_file: string, _args: string[], _options: object, callback: ExecFileCallback) => {
                callback(error, stdout, '');
                return {} as childProcess.ChildProcess;
            }) as typeof childProcess.execFile);
        };

        beforeEach(() => {
            execFileMock.mockClear();
        });

        it('asks the absolute lsof about this process\'s fd, in a UTF-8 locale and with a timeout', async () => {
            answer(`p${process.pid}\nf7\nn/work/a.ts\n`);
            await openedPathFromLsof(7);
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
            expect(await openedPathFromLsof(7)).toBe('/work/with space/a.ts');
        });

        it('cannot tell when lsof fails, times out or is missing', async () => {
            answer('', Object.assign(new Error('spawn /usr/sbin/lsof ENOENT'), { code: 'ENOENT' }));
            expect(await openedPathFromLsof(7)).toBeUndefined();
        });

        it('cannot tell when the output names no file', async () => {
            answer(`p${process.pid}\nf7\n`);
            expect(await openedPathFromLsof(7)).toBeUndefined();
        });
    });

    describe('openedPathFromLsof against the real lsof', () => {
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

        // An escaped name would never equal the stored path and reject every such attachment.
        macOnly.each(['plain.txt', 'with space.txt', 'нотатка.txt', 'clip-📎.txt', 'back\\slash.txt'])(
            'reports %s exactly as it was opened',
            async (name) => {
                const file = path.join(dir, name);
                fs.writeFileSync(file, 'x');
                const handle = await fs.promises.open(file, 'r');
                try {
                    expect(await openedPathFromLsof(handle.fd)).toBe(file);
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
                expect(await openedPathFromLsof(handle.fd)).toBe(path.join(dir, 'b', 'note.txt'));
            } finally {
                await handle.close();
            }
        });
    });
});
