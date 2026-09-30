import { execFile } from 'child_process';

/** Absolute, so an lsof planted on PATH is never the one run. */
export const LSOF_PATH = '/usr/sbin/lsof';
export const LSOF_TIMEOUT_MS = 2000;

/** The single-character escapes lsof writes after a backslash. */
const LSOF_ESCAPES = new Map([['\\', '\\'], ['b', '\b'], ['f', '\f'], ['n', '\n'], ['r', '\r'], ['t', '\t']]);

/** The full path macOS reports for this process's open descriptor `fd`, as lsof prints it
 *  (escaped, see {@link decodeLsofName}), or undefined when lsof cannot tell (missing, timed
 *  out, no name in its output). Unlike /dev/fd it follows the opened file, so a parent
 *  directory renamed in place shows up. */
export function lsofNameForFd(fd: number): Promise<string | undefined> {
    return new Promise(resolve => {
        execFile(
            LSOF_PATH,
            ['-w', '-a', '-p', String(process.pid), '-d', String(fd), '-Fn'],
            // A UTF-8 locale, so lsof prints printable non-ASCII names as they are.
            { env: { LC_ALL: 'en_US.UTF-8' }, timeout: LSOF_TIMEOUT_MS, encoding: 'utf8' },
            (error, stdout) => resolve(error ? undefined : nameField(stdout)),
        );
    });
}

/** Whether lsof prints `filePath` in a form that decodes back to it alone. lsof shows a
 *  control character as `^X`, which a literal caret followed by X also reads as. */
export function lsofShowsUnambiguously(filePath: string): boolean {
    return [...filePath].every(char => char !== '^' && char.charCodeAt(0) >= 0x20);
}

/** The path behind lsof's rendering of a name: `\\`, `\t` and the like, and `\xHH` for each
 *  byte of a non-printable character. Undefined for a caret, which may stand for a control
 *  character, and for an escape lsof never writes. */
export function decodeLsofName(name: string): string | undefined {
    const bytes: number[] = [];
    let i = 0;
    while (i < name.length) {
        // By code point, so a character outside the BMP keeps both halves of its surrogate pair.
        const char = String.fromCodePoint(name.codePointAt(i)!);
        i += char.length;
        if (char === '^') {
            return undefined;
        }
        if (char !== '\\') {
            bytes.push(...Buffer.from(char, 'utf8'));
            continue;
        }
        const next = name[i++];
        const hex = name.slice(i, i + 2);
        const escaped = next === undefined ? undefined : LSOF_ESCAPES.get(next);
        if (next === 'x' && /^[0-9a-f]{2}$/i.test(hex)) {
            bytes.push(parseInt(hex, 16));
            i += 2;
        } else if (escaped !== undefined) {
            bytes.push(...Buffer.from(escaped, 'utf8'));
        } else {
            return undefined;
        }
    }
    return Buffer.from(bytes).toString('utf8');
}

/** `-Fn` prints one field per line; the name field starts with `n`. */
function nameField(output: string): string | undefined {
    return output.split('\n').find(line => line.startsWith('n'))?.slice(1);
}
