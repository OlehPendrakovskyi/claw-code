import { REDACT_MAX_CHARS, redactText } from '../core/accessInfo/redact';
import { maskHiddenIn, readingOf, ReadingBuilder } from '../core/accessInfo/reading';

/** A stripped terminal code whose final byte a reading may keep or drop, as the acceptance test writes them: `ESC(`
 *  takes any of these bytes as its final byte, `ESC[0` only one that is no CSI parameter (no digit). */
// eslint-disable-next-line no-control-regex
const CODE = /\u001b(?:\(|\[0)([0-9A-Za-z_])/g;

/** `input` with each {@link CODE} replaced by its final byte or by nothing, for every subset of them. */
function plainReadings(input: string): string[] {
    const codes = [...input.matchAll(CODE)].length;
    const readings: string[] = [];
    for (let subset = 0; subset < 1 << codes; subset++) {
        let k = 0;
        readings.push(input.replace(CODE, (_, byte: string) => (((subset >> k++) & 1) === 1 ? byte : '')));
    }
    return readings;
}

describe('redactText on every reading of stripped final bytes (#82 S-d, design S3, S4)', () => {
    it('masks a value that a label needing some of the final bytes but not others opens (issue #63 case 8)', () => {
        expect(redactText('p\u001b(a\u001b(s\u001b(s\u001b(x=PRIVATE')).toBe('p=***');
    });

    it('masks a value that a final byte completing an escape opens (issue #63 case 9)', () => {
        expect(redactText('\\u007\u001b(0ass=PRIVATE')).toBe('zss=***');
        expect(redactText('https://h/?%7\u001b(0ass=PRIVATE')).toBe('https://h/?%7ass=***');
    });

    it('masks a value after a key that a bounded word ends (issue #63 case 10)', () => {
        expect(redactText('toke\u001b(n-bearer=PRIVATE')).toBe('toke-bearer=***');
        expect(redactText('toke\u001b(n-basic=PRIVATE')).toBe('toke-basic=***');
        expect(redactText('toke\u001b(n.bearer: PRIVATE')).toBe('toke.bearer: ***');
    });

    it('reads every subset of a short segment\'s bytes, and text and query names apart (#88 review)', () => {
        // Keeping one of the two bytes gives a Basic payload of valid length (`privatex`).
        expect(redactText('Basic private\u001b(x\u001b(y')).toBe('Basic***');
        expect(redactText('Basic "private\u001b(x\u001b(y"')).toBe('Basic***');
        // Keeping only the `2` spells `\u0022`, a quote that makes `token\"` a key.
        expect(redactText('token\\u002\u001b(1\u001b(2=PRIVATE')).toBe('token\\u002=***');
        // Only a query name reads `%70ass` as `pass`, so it does not stand in for the `pass` text needs.
        expect(redactText('%70ass-p\u001b(a\u001b(s\u001b(s\u001b(x=PRIVATE')).toBe('%70ass-p=***');
    });

    it('shows the base reading, so text no reading masks is left as it was', () => {
        expect(redactText('\u001b[1mname=value')).toBe('name=value');
        expect(redactText('by\u001b(pass=1')).toBe('byass=1');
        expect(redactText('pa\u001b(s\u001b(sx=1')).toBe('pax=1');
    });

    it('masks a base edit whole when another reading hides part of it (fail closed)', () => {
        // Keeping the bytes reads `tokenprivatevalue:public`, a key and its value: `public` is hidden too.
        const coded = 'toxken'.split('').map(char => `\u001b(${char}`).join('');
        expect(redactText(`Basic ${coded}privatevalue:public`)).toBe('Basic ***:***');
        // The base reading writes `= ` as `=`, an edit that stands for the dropped `a` and the space another reading
        // hides with its value.
        expect(redactText('sessiontoken=\u001b(a b,')).toBe('sessiontoken***');
    });

    it('gathers the ranges of a reading that masks more values than a call takes arguments', () => {
        // Just under the size limit (R64), where a spread into `push` already overflows.
        const input = `\u001b(t\u001b(o\u001b(k\u001b(e\u001b(n=v\n${'key=a\n'.repeat(174_000)}`;
        expect(input.length).toBeLessThanOrEqual(REDACT_MAX_CHARS);
        const output = redactText(input);
        expect(output.startsWith('token=***\nkey=***\n')).toBe(true);
        expect(output).not.toMatch(/=a\n/);
    }, 60_000);

    it('hides a value whenever some subset of one segment\'s final bytes, redacted as plain text, hides it, and only then (S9)', () => {
        // A fixed-seed sample of label spellings split by codes, junk codes, and escapes whose low digit is a final
        // byte, before each separator and context a masking pass reads. Every subset is a reading. The guarantee
        // holds where what masks the value needs the bytes of one segment, with at most four of them (S3); other
        // inputs are judged for over-redaction only, and design open question 4 tracks their leaks.
        let seed = 7;
        const next = (n: number): number => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) >>> 8) % n;
        const words = ['token', 'api_key', 'key', 'secret', 'password', 'passwd', 'pass', 'credential', 'signature',
            'authorization', 'cookie', 'set-cookie', 'bearer', 'basic'];
        const code = (byte: string): string => (next(2) === 0 || /[0-9]/.test(byte) ? `\u001b(${byte}` : `\u001b[0${byte}`);
        const leaks: string[] = [];
        const over: string[] = [];
        let judged = 0;
        const codes = (text: string): number => [...text.matchAll(CODE)].length;
        for (let round = 0; round < 4000; round++) {
            const word = words[next(words.length)];
            let label = '';
            for (const char of word) {
                const choice = next(10);
                const hex = char.charCodeAt(0).toString(16);
                label += choice < 3 && /[A-Za-z0-9_]/.test(char) ? code(char)
                    : choice < 4 ? `${next(2) === 0 ? '\\u00' : '%'}${hex[0]}${code(hex[1])}`
                        : char;
                if (next(7) === 0) {
                    label += code('xz0_m'[next(5)]);
                }
            }
            // A label a query name decodes before the run (`%70ass`), and separators and Basic payloads that some of
            // the final bytes spell or make valid (`\\u0022` is a quote, `\\u003d` an `=`, and `PRIVATEx` has a
            // valid Basic length), as Copilot found on #88.
            const before = ['', 'x', 'by', '_', 'x-', '"', 'https://h.example/?', 'https://h.example/?a=1&', '%70ass-'][next(9)];
            const after = word === 'bearer' || word === 'basic'
                ? [' PRIVATE', ' "PRIVATE"', '\tPRIVATE', ` PRIVATE${code('x')}${code('y')}`, ` "PRIVATE${code('x')}${code('y')}"`][next(5)]
                : ['=PRIVATE', ': PRIVATE', '":"PRIVATE"', '\\":\\"PRIVATE\\"', '=PRIVATE&b=2', ' = PRIVATE',
                    `\\u002${code('1')}${code('2')}=PRIVATE`, `\\u003${code('d')}PRIVATE`, `%3${code('d')}PRIVATE`][next(9)];
            const input = before + label + after;
            if (codes(input) > 7) {
                continue;
            }
            // A key's escaped separator is in the label's segment; a Basic or Bearer payload is a segment of its own.
            const bounded = word === 'bearer' || word === 'basic';
            const oneSegment = bounded
                ? codes(label) <= 4 && codes(after) <= 4 && (codes(label) === 0 || codes(after) === 0)
                : codes(label) + codes(after) <= 4;
            const hidden = plainReadings(input).some(plain => !redactText(plain).includes('PRIVATE'));
            const output = redactText(input);
            if (hidden && oneSegment && output.includes('PRIVATE')) {
                leaks.push(input);
            } else if (!hidden && !output.includes('PRIVATE')) {
                over.push(input);
            }
            judged += hidden && oneSegment ? 1 : 0;
        }
        expect(leaks).toEqual([]);
        expect(over).toEqual([]);
        expect(judged).toBeGreaterThan(1000);
    }, 60_000);
});

describe('the cost of the readings (design S7, R64)', () => {
    it('stays linear on costly text whose final bytes make every reading differ', () => {
        // Each label spelled in codes, so each witness keeps other bytes, before text the pipeline is slowest on.
        // Every reading runs the pipeline once: up to 16 times `main`'s cost, well within the bound at 32 KiB. The
        // labels repeat, so that a reading per marked byte (hundreds of them) would not be.
        const size = 32 * 1024;
        const coded = (word: string): string => word.split('').map(char => `\u001b(${char}`).join('');
        const labels = ['token', 'key', 'secret', 'password', 'passwd', 'passphrase', 'credential', 'signature',
            'authorization', 'cookie', 'pass', 'bearer', 'basic'].map(word => `x${coded(word)}y `).join('').repeat(16);
        const inputs = [
            Array.from({ length: 250 }, (_, depth) => '\\'.repeat(depth + 1) + '"https://x/?token=x').join('\n'),
            'https://a:b/ x'.repeat(size / 14),
            'x://a:b c '.repeat(size / 10),
            'a=b'.repeat(size / 3),
        ];
        for (const input of inputs) {
            const started = performance.now();
            redactText(labels + input);
            expect(performance.now() - started).toBeLessThan(3000);
        }
    }, 60_000);
});

describe('maskHiddenIn (design S4)', () => {
    /** A reading of `input` that copies it, puts `put` in place of `input` from `start` to `end`, and masks that
     *  stretch as `***` when `mask` holds. */
    const edited = (input: string, start: number, end: number, put: string, mask = false) => {
        const builder = new ReadingBuilder(readingOf(input));
        builder.copy(0, start);
        if (mask) {
            builder.mask(put, start, end);
        } else {
            builder.put(put, start, end);
        }
        builder.copy(end, input.length);
        return builder.build();
    };

    it('masks the copied characters other ranges hide, adjacent ones as one mask', () => {
        const masked = maskHiddenIn(readingOf('a=bcd e'), [[2, 3], [3, 5]], 7, '***');
        expect(masked.text).toBe('a=*** e');
        expect(masked.hidden).toEqual([[2, 5]]);
    });

    it('returns the reading itself when the ranges hide nothing it shows', () => {
        const reading = edited('a=PRIVATE', 2, 9, '***', true);
        expect(maskHiddenIn(reading, [[2, 9]], 9, '***')).toBe(reading);
        expect(maskHiddenIn(reading, [], 9, '***')).toBe(reading);
    });

    it('masks an edit whole when the ranges hide part of what it stands for and it does not', () => {
        // `x = ` written as `x=`: the edit stands for the space the ranges hide.
        const reading = edited('x = v', 1, 4, '=');
        expect(maskHiddenIn(reading, [[3, 4]], 5, '***').text).toBe('x***v');
    });

    it('takes a mask of the reading\'s own into a new mask next to it', () => {
        const reading = edited('a=PRIVATE b', 2, 9, '***', true);
        expect(maskHiddenIn(reading, [[9, 11]], 11, '***').text).toBe('a=***');
        // An inserted mask stands for no input, and is taken in all the same.
        const inserted = edited('a=b', 2, 2, '***');
        expect(maskHiddenIn(inserted, [[1, 2]], 3, '***').text).toBe('a***b');
    });
});
