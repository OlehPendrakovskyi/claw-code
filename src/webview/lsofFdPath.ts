import { execFile } from 'child_process';

/** Absolute, so an lsof planted on PATH is never the one run. */
export const LSOF_PATH = '/usr/sbin/lsof';
export const LSOF_TIMEOUT_MS = 2000;

/** The full path macOS reports for this process's open descriptor `fd`, or undefined when
 *  lsof cannot tell (missing, timed out, no name in its output). Unlike /dev/fd it follows
 *  the opened file, so a parent directory renamed in place shows up. */
export function openedPathFromLsof(fd: number): Promise<string | undefined> {
    return new Promise(resolve => {
        execFile(
            LSOF_PATH,
            ['-w', '-a', '-p', String(process.pid), '-d', String(fd), '-Fn'],
            // A UTF-8 locale, so lsof prints non-ASCII names as they are instead of escaping them.
            { env: { LC_ALL: 'en_US.UTF-8' }, timeout: LSOF_TIMEOUT_MS, encoding: 'utf8' },
            (error, stdout) => resolve(error ? undefined : nameField(stdout)),
        );
    });
}

/** `-Fn` prints one field per line; the name field starts with `n`. */
function nameField(output: string): string | undefined {
    return output.split('\n').find(line => line.startsWith('n'))?.slice(1);
}
