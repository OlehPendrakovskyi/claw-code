import { readingOf, ReadingBuilder, replaceInReading, type Reading } from '../core/accessInfo/reading';
import * as fs from 'fs';
import * as path from 'path';
import { readingForRedaction, redactText, redactTextReading, stripTerminalCodes } from '../core/accessInfo/redact';

type GoldenCase = { input: string; normalized: string; stripped: string };

/** Whether `value` is a golden case: three strings. */
function isGoldenCase(value: unknown): value is GoldenCase {
    return typeof value === 'object' && value !== null && 'input' in value && 'normalized' in value && 'stripped' in value
        && typeof value.input === 'string' && typeof value.normalized === 'string' && typeof value.stripped === 'string';
}

/** Inputs and their normalisation before #82 S-a, generated once from the pre-refactor implementation. */
const golden: { cases: GoldenCase[] } = (() => {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/__test__/fixtures/redact-normalization-golden.json'), 'utf8'));
    const cases: unknown = typeof parsed === 'object' && parsed !== null && 'cases' in parsed ? parsed.cases : undefined;
    if (!Array.isArray(cases) || !cases.every(isGoldenCase)) {
        throw new Error('redact-normalization-golden.json: expected { cases: { input, normalized, stripped }[] }');
    }
    return { cases };
})();

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
        // An insertion inside an earlier replacement stands for the overlap of its neighbours, so ranges never
        // decrease: `%41` became `AB`, both from `[0, 3)`, and a `-` put between them stands for `[0, 3)` too.
        const composed = replaceInReading(replaceInReading(readingOf('%41'), /%41/g, () => 'AB'), /(?=B)/g, () => '-');
        expect(composed.text).toBe('A-B');
        expect([...composed.from]).toEqual([0, 0, 0]);
        expect([...composed.to]).toEqual([3, 3, 3]);
        expectWellFormed('%41', composed);
        // An insertion at either end stands for the empty range there.
        const ends = replaceInReading(readingOf('ab'), /^|$/g, () => '|');
        expect(ends.text).toBe('|ab|');
        expect([ends.from[0], ends.to[0], ends.from[3], ends.to[3]]).toEqual([0, 0, 2, 2]);
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
    it('has the text the normalisation had before readings (S-a), on a golden corpus', () => {
        // Generated from the implementation at the commit it names; a difference is a change in what redactText
        // masks, so the corpus is not regenerated to make it pass.
        expect(golden.cases.length).toBeGreaterThan(1000);
        for (const { input, normalized, stripped } of golden.cases) {
            const reading = readingForRedaction(input);
            expect(reading.text).toBe(normalized);
            expect(stripTerminalCodes(input)).toBe(stripped);
            expectWellFormed(input, reading);
        }
    });

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
        // `Math.imul` keeps the product in 32 bits; a plain `*` overflows 2^53, loses the low bits and cycles early.
        const next = (n: number): number => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) >>> 8) % n;
        const inputs = new Set<string>();
        for (let round = 0; round < 2000; round++) {
            let input = '';
            for (let k = 1 + next(10); k > 0; k--) {
                input += atoms[next(atoms.length)];
            }
            inputs.add(input);
            expectWellFormed(input, readingForRedaction(input));
        }
        // The sample is about as varied as it claims (short inputs repeat), which a generator that cycles would not be.
        expect(inputs.size).toBeGreaterThan(1500);
    });
});

/** The input text of each range `reading` records as hidden. */
const hiddenTexts = (input: string, reading: Reading): string[] => (reading.hidden ?? []).map(([from, to]) => input.slice(from, to));

/** Redaction outputs before #82 S-b, generated once from the implementation it names. */
const outputs: { cases: Array<{ input: string; redactText: string }> } = (() => {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/__test__/fixtures/redact-output-golden.json'), 'utf8'));
    const cases: unknown = typeof parsed === 'object' && parsed !== null && 'cases' in parsed ? parsed.cases : undefined;
    const isCase = (value: unknown): value is { input: string; redactText: string } => typeof value === 'object' && value !== null
        && 'input' in value && 'redactText' in value && typeof value.input === 'string' && typeof value.redactText === 'string';
    if (!Array.isArray(cases) || !cases.every(isCase)) {
        throw new Error('redact-output-golden.json: expected { cases: { input, redactText }[] }');
    }
    return { cases };
})();

describe('redactTextReading', () => {
    it('records the input range of every value a pass masks, whatever text replaced it (S1)', () => {
        const cases: Array<[string, string, string[]]> = [
            ['token=PRIVATE', 'token=***', ['PRIVATE']],
            ['token: PRIVATE_PREFIX PRIVATE_SUFFIX', 'token=***', ['PRIVATE_PREFIX PRIVATE_SUFFIX']],
            ['see https://alice:pw@h.example/x', 'see https://***:***@h.example/x', ['alice:pw']],
            ['see //alice:pw@host/x', 'see //***@host/x', ['alice:pw']],
            ['Bearer abc', 'Bearer ***', ['abc']],
            ['Basic dXNlcjpwYXNz', 'Basic ***', [' dXNlcjpwYXNz']],
            ['Authorization: Basic dXNlcjpwYXNz', 'Authorization=***', ['Basic dXNlcjpwYXNz']],
            ['https://h.example/?token=abc', 'https://h.example/?token=***', ['abc']],
            // A quoted value is masked between its quotes first, then the pair whole.
            ['{"password":"x y"}', '{"password"=***}', ['x y', '"x y"']],
            // Through the normalisation maps: the value's own input range.
            ['\\u0070ass=x', 'pass=***', ['x']],
            // A literal `***` is no mask.
            ['see *** here', 'see *** here', []],
        ];
        for (const [input, text, hidden] of cases) {
            const reading = redactTextReading(input);
            expect(reading.text).toBe(text);
            expect(hiddenTexts(input, reading)).toEqual(hidden);
        }
    });

    it('has redactText\'s output as its text, and shows nothing it records as hidden (S5)', () => {
        for (const { input, redactText: expected } of outputs.cases) {
            const reading = redactTextReading(input);
            expect(reading.text).toBe(expected);
            expect(redactText(input)).toBe(expected);
            const hidden = new Uint8Array(input.length);
            for (const [from, to] of reading.hidden ?? []) {
                expect(0 <= from && from <= to && to <= input.length).toBe(true);
                hidden.fill(1, from, to);
            }
            // A character copied from the input (a one-character range) is never one a mask hid.
            for (let i = 0; i < reading.text.length; i++) {
                if (reading.to[i] - reading.from[i] === 1 && reading.text[i] === input[reading.from[i]]) {
                    expect(hidden[reading.from[i]]).toBe(0);
                }
            }
        }
    });
});
