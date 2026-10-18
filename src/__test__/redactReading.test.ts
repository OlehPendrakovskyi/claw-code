import { readingOf, ReadingBuilder, replaceInReading, type Reading } from '../core/accessInfo/reading';
import { readingForRedaction } from '../core/accessInfo/redact';

/** The input range character `i` of `reading` stands for, as a string of `input`. */
const source = (input: string, reading: Reading, i: number): string => input.slice(reading.from[i], reading.to[i]);

/** Checks the map invariants of design S2 for `reading` of `input`. */
function expectWellFormed(input: string, reading: Reading): void {
    expect(reading.from).toHaveLength(reading.text.length);
    expect(reading.to).toHaveLength(reading.text.length);
    for (let i = 0; i < reading.text.length; i++) {
        expect(reading.from[i]).toBeGreaterThanOrEqual(0);
        expect(reading.from[i]).toBeLessThanOrEqual(reading.to[i]);
        expect(reading.to[i]).toBeLessThanOrEqual(input.length);
        if (i > 0) {
            expect(reading.from[i]).toBeGreaterThanOrEqual(reading.from[i - 1]);
            expect(reading.to[i]).toBeGreaterThanOrEqual(reading.to[i - 1]);
        }
        // A character that stands for one input character is that character.
        if (reading.to[i] - reading.from[i] === 1) {
            expect(reading.text[i]).toBe(input[reading.from[i]]);
        }
    }
}

describe('reading', () => {
    it('maps the input to itself', () => {
        const reading = readingOf('token=x');
        expect(reading.text).toBe('token=x');
        expectWellFormed('token=x', reading);
        expect([...reading.from]).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it('maps a replacement to the range of its match, as String.prototype.replace replaces', () => {
        const input = 'a%41b%42';
        const reading = replaceInReading(readingOf(input), /%([0-9A-F]{2})/g, ([, hex]) => String.fromCharCode(parseInt(hex, 16)));
        expect(reading.text).toBe(input.replace(/%([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))));
        expect(source(input, reading, 1)).toBe('%41');
        expect(source(input, reading, 2)).toBe('b');
        expectWellFormed(input, reading);
        // An empty match puts its text in an empty range where it lies, and copies the character after it.
        const inserted = replaceInReading(readingOf('ab'), /(?=b)/g, () => '-');
        expect(inserted.text).toBe('a-b');
        expect([inserted.from[1], inserted.to[1]]).toEqual([1, 1]);
        // A Unicode pattern steps past an empty match by a whole code point, never into a surrogate pair.
        for (const pattern of [/(?:)/gu, /(?:)/g]) {
            expect(replaceInReading(readingOf('a😀'), pattern, () => '-').text).toBe('a😀'.replace(pattern, '-'));
        }
    });

    it('backs out what a scanner appended', () => {
        const builder = new ReadingBuilder(readingOf('abcdef'));
        builder.copy(0, 2);
        builder.copy(2, 5);
        builder.truncate(3);
        builder.copy(5, 6);
        const reading = builder.build();
        expect(reading.text).toBe('abcf');
        expect([...reading.from]).toEqual([0, 1, 2, 5]);
    });
});

describe('readingForRedaction', () => {
    it('maps a decoded escape to the whole escape', () => {
        const input = '\\u0070ass=x';
        const reading = readingForRedaction(input);
        expect(reading.text).toBe('pass=x');
        expect(source(input, reading, 0)).toBe('\\u0070');
        expect(source(input, reading, 1)).toBe('a');
        expectWellFormed(input, reading);
        const slash = readingForRedaction('a\\/b');
        expect(slash.text).toBe('a/b');
        expect(source('a\\/b', slash, 1)).toBe('\\/');
    });

    it('drops a stripped terminal code and keeps the characters around it in place', () => {
        const input = 'x\u001b[31mtoken\u001b[0m=v';
        const reading = readingForRedaction(input);
        expect(reading.text).toBe('xtoken=v');
        expect(input.slice(reading.from[1], reading.to[5])).toBe('token');
        expect(source(input, reading, 6)).toBe('=');
        expectWellFormed(input, reading);
    });

    it('maps a kept final byte to itself, not to its sequence (R79)', () => {
        // CSI and `ESC I+ F` forms, raw and serialised: the kept `t` stands for the input `t` alone.
        for (const code of ['\u001b[', '\u001b(', '\\u001b[', '\\u001b(', '\\x1b(', '\\\\u001b(']) {
            const input = `x ${code}token=v`;
            const reading = readingForRedaction(input);
            expect(reading.text).toBe('x token=v');
            expect(source(input, reading, 2)).toBe('t');
            expect(reading.from[2]).toBe(2 + code.length);
            expectWellFormed(input, reading);
        }
    });

    it('maps a rewritten scheme to its whole spelling', () => {
        const input = 'see https:/alice:pw@h.example';
        const reading = readingForRedaction(input);
        expect(reading.text).toBe('see https://alice:pw@h.example');
        expect(source(input, reading, 4)).toBe('https:/');
        expect(source(input, reading, 12)).toBe('a');
        expectWellFormed(input, reading);
    });

    it('keeps its maps well formed on varied input', () => {
        // A fixed-seed mix of codes, escapes, breaks, schemes and labels, the shapes the normalisation steps rewrite.
        const atoms = ['\u001b[', '\u001b(', '\u001b]', '\u009b', '\u0007', '\\u001b[', '\\x1b(', '\\u0070', '\\u00', '\\/', '\\"', '\\t',
            '\t', '\n', '\u0000', '﷐', 'token', 'pass', '=', ' ', '@', '//', 'https://', 'https:/', 'h\tttp:', 'a', '0', 'm', 'é', '😀'];
        let seed = 11;
        const next = (n: number): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 8) % n;
        for (let round = 0; round < 2000; round++) {
            let input = '';
            for (let k = 1 + next(10); k > 0; k--) {
                input += atoms[next(atoms.length)];
            }
            expectWellFormed(input, readingForRedaction(input));
        }
    });
});
