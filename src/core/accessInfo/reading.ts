/** A normalisation of an input text, with the input range each of its characters came from (design S2,
 *  docs/design/credential-redaction.md). `from[i]` and `to[i]` bound the input characters that character `i`
 *  stands for: one character for a copied one, the whole escape for one an escape decodes (`p` for `p`), and
 *  the whole match for any other replacement. Ranges never decrease along the text, so a span of the reading maps
 *  to one span of the input. */
export interface Reading {
    readonly text: string;
    readonly from: Int32Array;
    readonly to: Int32Array;
    /** The input ranges the masks made so far hide (design S1), whatever text replaced them: `token: PRIVATE` made
     *  `token=***` hides the range of `PRIVATE`. A pass that copies or rewrites masked text keeps them. */
    readonly hidden?: ReadonlyArray<readonly [number, number]>;
}

/** The input itself, each character standing for itself. */
export function readingOf(input: string): Reading {
    const from = new Int32Array(input.length);
    const to = new Int32Array(input.length);
    for (let i = 0; i < input.length; i++) {
        from[i] = i;
        to[i] = i + 1;
    }
    return { text: input, from, to };
}

/** Builds a reading from pieces of another: stretches copied with their ranges, and text put in for a stretch,
 *  standing for the input range that stretch came from. Linear in what is appended. */
export class ReadingBuilder {
    private readonly parts: string[] = [];
    private readonly masked: Array<readonly [number, number]> = [];
    /** Whether all that was appended is `source` copied in order from its start. Such a prefix is only counted, not
     *  copied, until something else is appended ({@link materialize}), and {@link build} returns `source` itself
     *  when it is the whole: a pass that changes nothing costs no copy. */
    private unchanged = true;
    private from: Int32Array;
    private to: Int32Array;
    private length = 0;

    constructor(private readonly source: Reading) {
        // Grown by doubling as text is appended, so a builder that ends up returning its source allocates little.
        this.from = new Int32Array(16);
        this.to = new Int32Array(16);
    }

    /** Appends `source.text` from `start` to `end`, each character with its own range. */
    copy(start: number, end: number): void {
        if (end <= start) {
            return;
        }
        if (this.unchanged && start === this.length) {
            this.length = end;
            return;
        }
        this.materialize();
        this.reserve(end - start);
        this.parts.push(this.source.text.slice(start, end));
        this.from.set(this.source.from.subarray(start, end), this.length);
        this.to.set(this.source.to.subarray(start, end), this.length);
        this.length += end - start;
    }

    /** Appends `text` in place of `source.text` from `start` to `end`: each of its characters stands for the input
     *  range that whole stretch came from. An empty stretch (an insertion) stands for what lies between its
     *  neighbours, so ranges never decrease: the overlap of their ranges when both came from one replacement
     *  (between the `A` and `B` that `%41` became), else the empty range right after the character before it. */
    put(text: string, start: number, end: number): void {
        if (text === '') {
            return;
        }
        this.materialize();
        const [from, to] = end > start ? [this.source.from[start], this.source.to[end - 1]] : this.between(start);
        this.reserve(text.length);
        this.parts.push(text);
        this.from.fill(from, this.length, this.length + text.length);
        this.to.fill(to, this.length, this.length + text.length);
        this.length += text.length;
    }

    /** {@link put}, for a mask: `text` hides `source.text` from `start` to `end`, and that stretch's input range is
     *  recorded as hidden. */
    mask(text: string, start: number, end: number): void {
        this.materialize();
        if (end > start) {
            this.masked.push([this.source.from[start], this.source.to[end - 1]]);
        }
        this.put(text, start, end);
    }

    /** Records `source.text` from `start` to `end` as hidden, with no text: for an edit put in with {@link put}
     *  whose text hides only parts of what it replaces, such as a re-serialised URL. */
    hide(start: number, end: number): void {
        this.materialize();
        if (end > start) {
            this.masked.push([this.source.from[start], this.source.to[end - 1]]);
        }
    }

    /** The number of characters appended so far. */
    get size(): number {
        return this.length;
    }

    /** Drops every character appended after the first `size`, for a scanner that backs out what it appended. */
    truncate(size: number): void {
        if (this.unchanged) {
            this.length = Math.min(this.length, size);
            return;
        }
        let excess = this.length - size;
        while (excess > 0) {
            const last = this.parts[this.parts.length - 1];
            if (last.length <= excess) {
                this.parts.pop();
                excess -= last.length;
            } else {
                this.parts[this.parts.length - 1] = last.slice(0, last.length - excess);
                excess = 0;
            }
        }
        this.length = size;
    }

    build(): Reading {
        if (this.unchanged && this.length === this.source.text.length) {
            return this.source;
        }
        this.materialize();
        const hidden = this.masked.length === 0 ? this.source.hidden : [...(this.source.hidden ?? []), ...this.masked];
        return { text: this.parts.join(''), from: this.from.slice(0, this.length), to: this.to.slice(0, this.length), hidden };
    }

    /** Copies in the prefix of `source` counted so far, once something other than an in-order copy is appended. */
    private materialize(): void {
        if (!this.unchanged) {
            return;
        }
        this.unchanged = false;
        const prefix = this.length;
        this.length = 0;
        if (prefix > 0) {
            this.reserve(prefix);
            this.parts.push(this.source.text.slice(0, prefix));
            this.from.set(this.source.from.subarray(0, prefix), 0);
            this.to.set(this.source.to.subarray(0, prefix), 0);
            this.length = prefix;
        }
    }

    /** The range an insertion before `source` character `index` stands for (see {@link put}). */
    private between(index: number): [number, number] {
        const length = this.source.text.length;
        if (index === 0) {
            const at = length > 0 ? this.source.from[0] : 0;
            return [at, at];
        }
        const prevFrom = this.source.from[index - 1];
        const prevTo = this.source.to[index - 1];
        if (index < length && this.source.from[index] < prevTo) {
            return [Math.max(prevFrom, this.source.from[index]), Math.min(prevTo, this.source.to[index])];
        }
        return [prevTo, prevTo];
    }

    private reserve(extra: number): void {
        if (this.length + extra <= this.from.length) {
            return;
        }
        const capacity = Math.max(this.length + extra, this.from.length * 2);
        const from = new Int32Array(capacity);
        const to = new Int32Array(capacity);
        from.set(this.from.subarray(0, this.length));
        to.set(this.to.subarray(0, this.length));
        this.from = from;
        this.to = to;
    }
}

/** `reading` with every match of the global `pattern` replaced as `String.prototype.replace` would replace it,
 *  each replacement standing for the input range of its match. */
export function replaceInReading(reading: Reading, pattern: RegExp, replacer: (match: RegExpExecArray) => string): Reading {
    pattern.lastIndex = 0;
    let match = pattern.exec(reading.text);
    if (match === null) {
        // Nothing to replace: the reading stands as it is, with no copy.
        return reading;
    }
    const builder = new ReadingBuilder(reading);
    let copied = 0;
    for (; match !== null; match = pattern.exec(reading.text)) {
        const start = match.index;
        const end = start + match[0].length;
        builder.copy(copied, start);
        builder.put(replacer(match), start, end);
        copied = end;
        if (match[0] === '') {
            pattern.lastIndex = nextIndex(reading.text, pattern.lastIndex, pattern.unicode || pattern.flags.includes('v'));
        }
    }
    builder.copy(copied, reading.text.length);
    return builder.build();
}

/** The index after `index` in `text`, as `String.prototype.replace` advances past an empty match: by a whole code
 *  point for a Unicode pattern, so it never lands inside a surrogate pair, else by one unit. */
function nextIndex(text: string, index: number, unicode: boolean): number {
    if (!unicode || index + 1 >= text.length) {
        return index + 1;
    }
    const unit = text.charCodeAt(index);
    const following = text.charCodeAt(index + 1);
    return unit >= 0xd800 && unit <= 0xdbff && following >= 0xdc00 && following <= 0xdfff ? index + 2 : index + 1;
}

/** One piece of what a match of {@link rewriteInReading} becomes, over `source.text` from `start` to `end`: that text
 *  copied, other `text` put in its place, or other `text` masking it. */
export type Piece =
    | { readonly copy: true; readonly start: number; readonly end: number }
    | { readonly put: string; readonly start: number; readonly end: number }
    | { readonly mask: string; readonly start: number; readonly end: number };

/** `reading` with every match of the global `pattern` rewritten as `rewrite` says, piece by piece, in order and
 *  covering the match, or left as it is when `rewrite` gives undefined. The text is what `String.prototype.replace`
 *  would give with the pieces' texts joined; a masked piece is recorded as hidden. */
export function rewriteInReading(reading: Reading, pattern: RegExp, rewrite: (match: RegExpExecArray) => readonly Piece[] | undefined): Reading {
    pattern.lastIndex = 0;
    let match = pattern.exec(reading.text);
    if (match === null) {
        return reading;
    }
    const builder = new ReadingBuilder(reading);
    let copied = 0;
    for (; match !== null; match = pattern.exec(reading.text)) {
        if (match[0] === '') {
            // As String.prototype.replace does: step past an empty match, by a whole code point for a Unicode pattern.
            pattern.lastIndex = nextIndex(reading.text, pattern.lastIndex, pattern.unicode || pattern.flags.includes('v'));
        }
        const pieces = rewrite(match);
        if (pieces === undefined) {
            continue;
        }
        builder.copy(copied, match.index);
        for (const piece of pieces) {
            if ('copy' in piece) {
                builder.copy(piece.start, piece.end);
            } else if ('put' in piece) {
                builder.put(piece.put, piece.start, piece.end);
            } else {
                builder.mask(piece.mask, piece.start, piece.end);
            }
        }
        copied = match.index + match[0].length;
    }
    builder.copy(copied, reading.text.length);
    return builder.build();
}
