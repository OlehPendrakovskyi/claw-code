import { redactText } from '../core/accessInfo/redact';
import { FINAL_BYTE_MARK as M, LABELS, labelWitnesses, type LabelKind } from '../core/accessInfo/witness';

const NAME = /[A-Za-z0-9_.-]/;

/** `text` read with the marked bytes `keep` holds (by index) kept and the others dropped, then decoded as the
 *  pipeline and a query name would decode it: `\u00XX` as `decodeNameEscapes` (a quote, backslash or DEL stays
 *  escaped) and a printable `%XX`. */
function reading(text: string, keep: (index: number) => boolean): string {
    let out = '';
    for (let i = 0; i < text.length; i++) {
        if (text[i] === M && NAME.test(text[i + 1] ?? '')) {
            out += keep(i + 1) ? text[i + 1] : '';
            i++;
        } else if (text[i] !== M) {
            out += text[i];
        }
    }
    return out
        .replace(/(?<!\\)\\+u00([2-7][0-9a-f])/gi, (escape, hex: string) => {
            const value = parseInt(hex, 16);
            return [0x7f, 0x5c, 0x22, 0x27, 0x60].includes(value) ? escape : String.fromCharCode(value);
        })
        .replace(/%([0-9a-f]{2})/gi, (escape, hex: string) => {
            const value = parseInt(hex, 16);
            return value >= 0x20 && value < 0x7f ? String.fromCharCode(value) : escape;
        });
}

/** Whether a decoded reading forms `word` as its kind needs, in a run of name characters. */
function forms(decoded: string, word: string, kind: LabelKind): boolean {
    for (const run of decoded.match(/[A-Za-z0-9_.-]+/g) ?? []) {
        const lower = run.toLowerCase();
        for (let at = lower.indexOf(word); at !== -1; at = lower.indexOf(word, at + 1)) {
            const before = run[at - 1] ?? '';
            const after = run[at + word.length] ?? '';
            if (kind === 'anywhere'
                || (kind === 'letters-apart' && !/[A-Za-z]/.test(before) && !/[A-Za-z]/.test(after))
                || (kind === 'word-at-end' && !/[A-Za-z0-9_]/.test(before) && after === '')) {
                return true;
            }
        }
    }
    return false;
}

/** The witness reading of `word` in `text`: its bytes kept, every other marked byte dropped. */
function witnessReading(text: string, word: string): string | undefined {
    const kept = labelWitnesses(text).get(word);
    return kept === undefined ? undefined : reading(text, index => kept.has(index));
}

describe('labelWitnesses', () => {
    it('keeps the marked bytes a label needs and drops the others (issue #63 case 8)', () => {
        const text = `p${M}a${M}s${M}s${M}x=v`;
        expect(witnessReading(text, 'pass')).toBe('pass=v');
        expect(witnessReading(text, 'token')).toBeUndefined();
    });

    it('reads a label through an escape whose digit is a marked byte (issue #63 case 9)', () => {
        expect(witnessReading(`\\u007${M}0ass=v`, 'pass')).toBe('pass=v');
        expect(witnessReading(`?%7${M}0ass=v`, 'pass')).toBe('?pass=v');
        // Backslash runs that only a dropped byte stood between are one run, which the escape follows.
        expect(forms(witnessReading(`pass\\u007${M}7\\${M}r\\u${M}0064`, 'passwd') ?? '', 'passwd', 'anywhere')).toBe(true);
    });

    it('finds each kind of label in a run, whatever separator follows (issue #63 case 10)', () => {
        const text = `toke${M}n-bearer=v`;
        expect(witnessReading(text, 'token')).toBe('token-bearer=v');
        // `bearer` ends the run whether or not the `n` stays: the witness need keep nothing.
        expect(witnessReading(text, 'bearer')).toBe('toke-bearer=v');
        expect(witnessReading(`token-beare${M}r v`, 'bearer')).toBe('token-bearer v');
    });

    it('keeps a marked byte that is no letter as the boundary `pass` needs, and reads past the word for it', () => {
        expect(witnessReading(`by${M}_pass=v`, 'pass')).toBe('by_pass=v');
        // Dropping bytes after `pass` can make an escape of fixed digits (`\u007` then `2` is `r`): the boundary is read.
        const text = `pa${M}_\\u0${M}073s${M}z\\u007${M}7${M}d2`;
        expect(forms(witnessReading(text, 'pass') ?? '', 'pass', 'letters-apart')).toBe(true);
        // A completed `pass` without its boundary does not stop a longer reading that has one (`pa`, `s`, then `s`).
        const longer = `\\\\%${M}70${M}x${M}a${M}s${M}x%7${M}3${M}p${M}h${M}r${M}as\\u00${M}65`;
        expect(forms(witnessReading(longer, 'pass') ?? '', 'pass', 'letters-apart')).toBe(true);
    });

    it('reads the characters an escape that does not go on leaves as text', () => {
        // `%a` then `u` is no escape: the `a` stays and starts `authorization`.
        const text = `%a${M}u${M}x\\u${M}0074${M}ho%7${M}2${M}i${M}za${M}0${M}t${M}0%6${M}9on`;
        expect(forms(witnessReading(text, 'authorization') ?? '', 'authorization', 'anywhere')).toBe(true);
    });

    it('knows only labels a masking pass masks', () => {
        for (const { word, kind } of LABELS) {
            const text = kind === 'word-at-end' ? `${word} dXNlcjpwYXNz` : `${word}=PRIVATE`;
            expect(redactText(text)).not.toMatch(/PRIVATE|dXNlcjpwYXNz/);
        }
    });

    it('finds a witness exactly when some reading of the marked bytes forms the label, and its reading forms it', () => {
        // Every subset of the marked bytes is a reading. A fixed-seed sample of label words split into marked bytes,
        // escapes with marked digits, and junk, checked for every label.
        let seed = 17;
        const next = (n: number): number => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) >>> 8) % n;
        const junk = ['\\', '%', 'u', '0', '7', 'x', '-', '_', ' ', 'by'];
        let formable = 0;
        for (let round = 0; round < 300; round++) {
            const { word } = LABELS[next(LABELS.length)];
            let text = next(3) === 0 ? junk[next(junk.length)] : '';
            for (const char of word) {
                const hex = char.charCodeAt(0).toString(16);
                const choice = next(10);
                text += choice < 4 ? `${M}${char}`
                    : choice < 5 ? `\\u00${hex[0]}${M}${hex[1]}`
                        : choice < 6 ? `%${M}${hex[0]}${hex[1]}`
                            : char;
                if (next(6) === 0) {
                    text += `${M}${'xz0_'[next(4)]}`;
                }
            }
            text += next(3) === 0 ? junk[next(junk.length)] : '';
            const marks: number[] = [];
            for (let i = 0; i < text.length; i++) {
                if (text[i] === M) {
                    marks.push(i + 1);
                }
            }
            if (marks.length > 8) {
                continue;
            }
            const witnesses = labelWitnesses(text);
            for (const label of LABELS) {
                let any = false;
                for (let mask = 0; mask < 1 << marks.length && !any; mask++) {
                    any = forms(reading(text, index => ((mask >> marks.indexOf(index)) & 1) === 1), label.word, label.kind);
                }
                const kept = witnesses.get(label.word);
                const own = forms(reading(text, index => kept?.has(index) ?? false), label.word, label.kind);
                expect(own).toBe(any);
                formable += any ? 1 : 0;
            }
        }
        expect(formable).toBeGreaterThan(100);
    });

    it('stays linear on large adversarial input (R64)', () => {
        const size = 128 * 1024;
        const inputs = [
            `${M}p${M}a${M}s`.repeat(size / 6),
            `pa${M}s`.repeat(size / 4),
            `\\u00${M}7`.repeat(size / 6),
            `%${M}7`.repeat(size / 4),
            `\\u007${M}0${M}ass`.repeat(size / 11),
            `authorizatio${M}x`.repeat(size / 14),
        ];
        for (const input of inputs) {
            const started = performance.now();
            labelWitnesses(input);
            expect(performance.now() - started).toBeLessThan(3000);
        }
    }, 60_000);
});
