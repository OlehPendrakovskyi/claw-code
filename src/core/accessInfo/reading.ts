/** A normalisation of an input text, with the input range each of its characters came from (design S2,
 *  docs/design/credential-redaction.md). `from[i]` and `to[i]` bound the input characters that character `i`
 *  stands for: one character for a copied one, the whole escape for one an escape decodes (`p` for `p`), and
 *  the whole match for any other replacement. Ranges never decrease along the text, so a span of the reading maps
 *  to one span of the input. */
export interface Reading {
    readonly text: string;
    readonly from: Int32Array;
    readonly to: Int32Array;
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
    private from: Int32Array;
    private to: Int32Array;
    private length = 0;

    constructor(private readonly source: Reading) {
        this.from = new Int32Array(Math.max(16, source.text.length));
        this.to = new Int32Array(Math.max(16, source.text.length));
    }

    /** Appends `source.text` from `start` to `end`, each character with its own range. */
    copy(start: number, end: number): void {
        if (end <= start) {
            return;
        }
        this.reserve(end - start);
        this.parts.push(this.source.text.slice(start, end));
        this.from.set(this.source.from.subarray(start, end), this.length);
        this.to.set(this.source.to.subarray(start, end), this.length);
        this.length += end - start;
    }

    /** Appends `text` in place of `source.text` from `start` to `end`: each of its characters stands for the input
     *  range that whole stretch came from. An empty stretch stands for the empty range where it lies. */
    put(text: string, start: number, end: number): void {
        if (text === '') {
            return;
        }
        const at = start < this.source.text.length ? this.source.from[start] : this.inputEnd();
        const from = end > start ? this.source.from[start] : at;
        const to = end > start ? this.source.to[end - 1] : at;
        this.reserve(text.length);
        this.parts.push(text);
        this.from.fill(from, this.length, this.length + text.length);
        this.to.fill(to, this.length, this.length + text.length);
        this.length += text.length;
    }

    /** The number of characters appended so far. */
    get size(): number {
        return this.length;
    }

    /** Drops every character appended after the first `size`, for a scanner that backs out what it appended. */
    truncate(size: number): void {
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
        return { text: this.parts.join(''), from: this.from.slice(0, this.length), to: this.to.slice(0, this.length) };
    }

    private inputEnd(): number {
        const last = this.source.text.length - 1;
        return last >= 0 ? this.source.to[last] : 0;
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
            pattern.lastIndex++;
        }
    }
    builder.copy(copied, reading.text.length);
    return builder.build();
}
