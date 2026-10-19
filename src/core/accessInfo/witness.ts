/** Witnesses for span-based masking (design S3, docs/design/credential-redaction.md): for each credential label, a
 *  reading of a stripped terminal code's final bytes that forms the label. The text read here is the stripped text
 *  before R79 resolves it: each final byte that is a name character stands after {@link FINAL_BYTE_MARK}, and a
 *  reading keeps or drops each such byte. */

/** Marks a stripped sequence's final byte that is a name character. A Unicode noncharacter, reserved for internal
 *  use: stripping removes it from its input first, so no input can pose as a mark. */
export const FINAL_BYTE_MARK = '﷐';

/** Where a label may sit in a run of name characters, as the regex of the pass that reads it says: anywhere
 *  (`SENSITIVE_KEY`, `CREDENTIAL_HEADER_KEY`), apart from other letters (`pass`), or as a whole word that ends the
 *  run (`LABEL_WORD`). */
export type LabelKind = 'anywhere' | 'letters-apart' | 'word-at-end';

/** Every credential label a masking pass reads. Spellings a regex accepts beyond these (`api_key`, `access-key`,
 *  `set-cookie`) each contain one of them. */
export const LABELS: ReadonlyArray<{ readonly word: string; readonly kind: LabelKind }> = [
    ...['token', 'key', 'secret', 'password', 'passwd', 'passphrase', 'credential', 'signature', 'authorization', 'cookie']
        .map(word => ({ word, kind: 'anywhere' as const })),
    { word: 'pass', kind: 'letters-apart' },
    { word: 'bearer', kind: 'word-at-end' },
    { word: 'basic', kind: 'word-at-end' },
];

const NAME_CHAR = /[A-Za-z0-9_.-]/;
const LETTER = /[A-Za-z]/;
const WORD_CHAR = /[A-Za-z0-9_]/;
const HEX = /[0-9A-Fa-f]/;

/** One unit of a segment: a name character, fixed or a marked final byte a reading may drop; a backslash run, which
 *  may open a `\u00XX` escape; or a `%`, which may open a `%XX` one. */
type Unit = { readonly kind: 'name'; readonly char: string; readonly optional: boolean; readonly index: number }
    | { readonly kind: 'backslash' | 'percent'; readonly index: number };

/** The class of the last character a reading kept, which a bounded label's start depends on: none or one that is
 *  no word character, a letter, or another word character (a digit or `_`). */
const Prev = { Boundary: 0, Letter: 1, OtherWord: 2 } as const;
type Prev = typeof Prev[keyof typeof Prev];
/** Each class by its number, as a state key holds it. */
const PREVS: readonly Prev[] = [Prev.Boundary, Prev.Letter, Prev.OtherWord];

/** Where an escape stands after the characters read so far: none; a backslash run, then `u`, `0`, `0` and the high
 *  digit (`2`–`7`, kept in the low bits); or `%` and its high digit (`0`–`F`). */
const Esc = { None: 0, Backslash: 1, U: 2, U0: 3, U00: 4, U00High: 5, Percent: 11, PercentHigh: 12 } as const;
/** One past the largest escape state: `U00High` takes six values (`2`–`7`), `PercentHigh` sixteen. */
const ESC_STATES = Esc.PercentHigh + 16;
/** For each label, the marked bytes to keep, by their index in `text` (the byte after its mark), so that each
 *  segment that some reading of its bytes lets form the label forms it. A segment is a maximal stretch of name
 *  characters, marked bytes, backslash runs and `%` that holds at least one mark; a label no segment can form is
 *  absent. A decoded escape (`\u0070`, `%70`) joins the run as the character it decodes to, as `decodeNameEscapes`
 *  and a query name's percent-decoding read it, and one that does not decode breaks the run. Linear: each label
 *  reads each segment once forward, with a bounded number of states per unit, and its match once back (R64). */
export function labelWitnesses(text: string): Map<string, ReadonlySet<number>> {
    const witnesses = new Map<string, Set<number>>();
    for (const units of segments(text)) {
        // With no escape, a segment can only form a word whose letters it holds: the others are not read.
        const escapes = units.some(unit => unit.kind !== 'name');
        const letters = new Set(units.map(unit => (unit.kind === 'name' ? unit.char.toLowerCase() : '')));
        for (const label of LABELS) {
            if (!escapes && !label.word.split('').every(letter => letters.has(letter))) {
                continue;
            }
            const kept = segmentWitness(units, label.word, label.kind);
            if (kept !== undefined) {
                const all = witnesses.get(label.word) ?? new Set<number>();
                kept.forEach(index => all.add(index));
                witnesses.set(label.word, all);
            }
        }
    }
    return witnesses;
}

/** The segments of `text` that hold a marked byte, as units. */
function segments(text: string): Unit[][] {
    const found: Unit[][] = [];
    let units: Unit[] = [];
    let marked = false;
    const close = (): void => {
        if (marked) {
            found.push(units);
        }
        units = [];
        marked = false;
    };
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (char === FINAL_BYTE_MARK && NAME_CHAR.test(text[i + 1] ?? '')) {
            units.push({ kind: 'name', char: text[i + 1], optional: true, index: i + 1 });
            marked = true;
            i++;
        } else if (NAME_CHAR.test(char)) {
            units.push({ kind: 'name', char, optional: false, index: i });
        } else if (char === '\\') {
            let end = i;
            while (text[end + 1] === '\\') {
                end++;
            }
            units.push({ kind: 'backslash', index: i });
            i = end;
        } else if (char === '%') {
            units.push({ kind: 'percent', index: i });
        } else {
            close();
        }
    }
    close();
    return found;
}

/** The class of a character a reading keeps. */
function classOf(char: string): Prev {
    return LETTER.test(char) ? Prev.Letter : WORD_CHAR.test(char) ? Prev.OtherWord : Prev.Boundary;
}

/** The character a `\u00XX` escape decodes to, as `decodeNameEscapes` decodes it, or undefined when it stays: a
 *  backslash or DEL stays escaped, and a quote becomes an escaped quote, which breaks a name as well. */
function decodedU(high: number, low: string): string | undefined {
    const value = high * 16 + parseInt(low, 16);
    if (value === 0x7f || value === 0x5c || value === 0x22 || value === 0x27 || value === 0x60) {
        return undefined;
    }
    return String.fromCharCode(value);
}

/** The character a `%XX` escape decodes to when it is a printable ASCII one, or undefined. */
function decodedPercent(high: number, low: string): string | undefined {
    const value = high * 16 + parseInt(low, 16);
    return value >= 0x20 && value < 0x7f ? String.fromCharCode(value) : undefined;
}

/** The bit that marks a state as reached, apart from the matched-prefix bits below it. */
const PRESENT = 1 << 15;

/** A matcher state: the escape being read, the class of the last kept character, the prefix bits of the word
 *  matched so far, and whether the word is done and waits for the boundary its kind needs. */
type State = { readonly esc: number; readonly prev: Prev; readonly bits: number; readonly done: boolean };
/** A state as a number, for a map key: done, escape and class (prefix bits are kept apart). */
const keyOf = ({ esc, prev, done }: State): number => ((done ? ESC_STATES : 0) + esc) * 3 + prev;
const stateOf = (key: number, bits: number): State => {
    const done = key >= ESC_STATES * 3;
    const rest = done ? key - ESC_STATES * 3 : key;
    return { esc: Math.floor(rest / 3), prev: PREVS[rest % 3] ?? Prev.Boundary, bits, done };
};
/** What reading a unit leads to from a state: a next state, or the word's acceptance. */
type Step = State | 'accept';

/** The name characters an escape that does not go on leaves as text, after its backslashes or `%`: the `u`, the
 *  zeros and the high digit it read. They join the name again, so `%a` then `u` still holds the `a` of a word. */
function leftOver(esc: number): string {
    if (esc >= Esc.U00High && esc < Esc.U00High + 6) {
        return `u00${esc - Esc.U00High + 2}`;
    }
    if (esc >= Esc.PercentHigh) {
        return (esc - Esc.PercentHigh).toString(16);
    }
    return esc === Esc.U ? 'u' : esc === Esc.U0 ? 'u0' : esc === Esc.U00 ? 'u00' : '';
}

/** The marked bytes of one segment's first reading that forms `word`, or undefined when none does. A bounded word is
 *  accepted only once the reading shows the boundary its kind needs after it: a character that is no letter (`pass`)
 *  or no name character (`bearer`, `basic`), a break, or the segment's end. Bytes dropped after a word can make an
 *  escape of fixed digits (`\u007` then `2`), so the boundary is read, not assumed. */
function segmentWitness(units: readonly Unit[], word: string, kind: LabelKind): ReadonlySet<number> | undefined {
    const positions = new Map<string, number>();
    word.split('').forEach((letter, j) => positions.set(letter, (positions.get(letter) ?? 0) | (1 << j)));
    const full = 1 << word.length;

    /** A name character (plain or decoded) read from a state: the states it leads to, or the word's acceptance.
     *  A bounded word that completes still lets its shorter prefixes go on: the completed reading may lack its
     *  boundary where a longer one (`pa` then `s`, `s`) has it. */
    const readChar = (state: State, char: string): Step[] => {
        if (state.done) {
            const bounded = kind === 'letters-apart' ? !LETTER.test(char) : !NAME_CHAR.test(char);
            return bounded ? ['accept'] : [];
        }
        if (!NAME_CHAR.test(char)) {
            return [{ esc: Esc.None, prev: Prev.Boundary, bits: 0, done: false }];
        }
        const start = kind === 'anywhere' || (kind === 'letters-apart' ? state.prev !== Prev.Letter : state.prev === Prev.Boundary);
        const advanced = ((state.bits | (start ? 1 : 0)) & (positions.get(char.toLowerCase()) ?? 0)) << 1;
        const going: State = { esc: Esc.None, prev: classOf(char), bits: advanced & (full - 1), done: false };
        if ((advanced & full) === 0) {
            return [going];
        }
        return kind === 'anywhere' ? ['accept'] : [{ esc: Esc.None, prev: classOf(char), bits: 0, done: true }, going];
    };
    /** A break (a character that is no name character, or an escape that does not go on) from a state. */
    const breakFrom = (state: State): Step => state.done ? 'accept' : { esc: Esc.None, prev: Prev.Boundary, bits: 0, done: false };
    /** Reading `unit` from `state`: the states it leads to and the word's acceptance; none when the path dies. */
    const step = (state: State, unit: Unit): Step[] => {
        const { esc } = state;
        if (esc === Esc.None) {
            if (unit.kind === 'name') {
                return readChar(state, unit.char);
            }
            // An escape may decode to a character of the word: what was matched waits for it.
            return [{ ...state, esc: unit.kind === 'backslash' ? Esc.Backslash : Esc.Percent }];
        }
        const char = unit.kind === 'name' ? unit.char : '';
        if (esc === Esc.Backslash && unit.kind === 'backslash') {
            // Backslash runs that only dropped bytes stood between are one run, which an escape may follow.
            return [state];
        }
        let next: number | undefined;
        let decoded: string | undefined;
        if (esc === Esc.Backslash) {
            next = char === 'u' || char === 'U' ? Esc.U : undefined;
        } else if (esc === Esc.U) {
            next = char === '0' ? Esc.U0 : undefined;
        } else if (esc === Esc.U0) {
            next = char === '0' ? Esc.U00 : undefined;
        } else if (esc === Esc.U00) {
            next = char >= '2' && char <= '7' && char !== '' ? Esc.U00High + Number(char) - 2 : undefined;
        } else if (esc >= Esc.U00High && esc < Esc.U00High + 6) {
            decoded = HEX.test(char) ? decodedU(esc - Esc.U00High + 2, char) : undefined;
        } else if (esc === Esc.Percent) {
            next = HEX.test(char) ? Esc.PercentHigh + parseInt(char, 16) : undefined;
        } else {
            decoded = HEX.test(char) ? decodedPercent(esc - Esc.PercentHigh, char) : undefined;
        }
        if (next !== undefined) {
            return [{ ...state, esc: next }];
        }
        if (decoded !== undefined) {
            return readChar({ ...state, esc: Esc.None }, decoded);
        }
        // The escape does not go on: its backslashes or `%` stay as text and break the name, the characters it read
        // join the name again, and then this unit is read.
        let after: Step[] = [breakFrom(state)];
        for (const left of leftOver(esc)) {
            after = after.flatMap(next2 => next2 === 'accept' ? ['accept' as const] : readChar(next2, left));
        }
        return after.flatMap(next2 => next2 === 'accept' ? ['accept' as const] : step(next2, unit));
    };

    // The states after each unit, sparse: from `offsets[k]` in `keys` and `masks`.
    const offsets = new Int32Array(units.length + 1);
    const keys: number[] = [];
    const masks: number[] = [];
    const initial: State = { esc: Esc.None, prev: Prev.Boundary, bits: 0, done: false };
    let current = new Map<number, number>([[keyOf(initial), PRESENT]]);
    let accepted = -1;
    for (let k = 0; k < units.length && accepted === -1; k++) {
        const unit = units[k];
        const next = new Map<number, number>();
        const add = (state: State): void => {
            const key = keyOf(state);
            next.set(key, (next.get(key) ?? 0) | state.bits | PRESENT);
        };
        for (const [key, mask] of current) {
            const state = stateOf(key, mask & ~PRESENT);
            if (unit.kind === 'name' && unit.optional) {
                add(state);
            }
            for (const result of step(state, unit)) {
                if (result === 'accept') {
                    accepted = k;
                } else {
                    add(result);
                }
            }
        }
        offsets[k] = keys.length;
        for (const [key, mask] of next) {
            keys.push(key);
            masks.push(mask);
        }
        current = next;
    }
    offsets[units.length] = keys.length;
    if (accepted === -1) {
        // At the segment's end, a done word has its boundary.
        let end = false;
        for (const key of current.keys()) {
            end ||= stateOf(key, 0).done;
        }
        if (!end) {
            return undefined;
        }
        accepted = units.length;
    }

    /** The states after unit `k` (the initial state for `k` = -1). */
    const statesAfter = (k: number): Array<[number, number]> => {
        if (k < 0) {
            return [[keyOf(initial), PRESENT]];
        }
        const out: Array<[number, number]> = [];
        for (let s = offsets[k]; s < offsets[k + 1]; s++) {
            out.push([keys[s], masks[s]]);
        }
        return out;
    };
    /** Whether `state` has the prefix `bits` asks for (-1: any). */
    const has = (mask: number, bits: number): boolean => bits === -1 || (mask & bits) !== 0;
    /** The single prefix bits of a mask, and none, to try one at a time. */
    const tries = (mask: number): number[] => [0, ...word.split('').map((_, j) => 1 << j).filter(bit => (mask & bit) !== 0)];

    // Back from the acceptance: at each unit, the state it led to, and whether it was read or, a marked byte,
    // dropped. At the end of the segment, the target is any done state.
    const kept = new Set<number>();
    let target: { key: number; bits: number } | 'accept' | 'done' = accepted === units.length ? 'done' : 'accept';
    for (let k = Math.min(accepted, units.length - 1); k >= 0; k--) {
        const unit = units[k];
        const states = statesAfter(k - 1);
        if (target === 'done') {
            // Units after the acceptance are not read; find a done state after unit k from which the reading ends.
            const done = statesAfter(k).find(([key]) => stateOf(key, 0).done);
            if (done === undefined) {
                return undefined;
            }
            target = { key: done[0], bits: -1 };
        }
        let found = false;
        if (target !== 'accept' && unit.kind === 'name' && unit.optional) {
            const goal = target;
            found = states.some(([key, mask]) => key === goal.key && has(mask, goal.bits));
        }
        if (!found) {
            const goal = target;
            for (const [key, mask] of states) {
                for (const bits of tries(mask & ~PRESENT)) {
                    const reached = step(stateOf(key, bits), unit).some(result => goal === 'accept'
                        ? result === 'accept'
                        : result !== 'accept' && keyOf(result) === goal.key && has(result.bits | PRESENT, goal.bits));
                    if (reached) {
                        target = { key, bits: bits === 0 ? -1 : bits };
                        found = true;
                        break;
                    }
                }
                if (found) {
                    break;
                }
            }
            if (!found) {
                return undefined;
            }
            if (unit.kind === 'name' && unit.optional) {
                kept.add(unit.index);
            }
        }
    }
    return kept;
}
