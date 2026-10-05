/** Query-parameter names whose values are secrets; shared by the parsed and the unparsed path. */
const SENSITIVE_PARAM = /(api_?key|api-key|key|token|password|secret|credential|access_key|signature)/i;

/** Redact userinfo and sensitive query params from an endpoint URL for display. */
export function redactEndpoint(endpoint: string): string {
    try {
        const url = new URL(endpoint);
        let redacted = false;
        if (url.username) {
            url.username = '***';
            redacted = true;
        }
        if (url.password) {
            url.password = '***';
            redacted = true;
        }
        for (const key of [...url.searchParams.keys()]) {
            if (SENSITIVE_PARAM.test(key)) {
                url.searchParams.set(key, '***');
                redacted = true;
            }
        }
        return redacted ? url.toString() : endpoint;
    } catch {
        return endpoint;
    }
}

/** Words that make a key's value a secret: `token`, `OPENAI_API_KEY`, `"password"`, … */
const SENSITIVE_KEY = /token|api[_-]?key|apikey|key|secret|password|passwd|credential|access[_-]?key|signature/i;
/** A key and its `:` or `=` separator. The key is a whole run of name characters, optionally quoted, so a
 *  long run is tried once rather than from each of its characters. */
const KEY_SEPARATOR = /(?<![A-Za-z0-9_.-])(["']?[A-Za-z0-9_.-]+["']?)\s*[:=]\s*/g;
const VALUE_QUOTE = /["'`]/;
const NON_SPACE = /\S/;

/** Where a value that starts at `start` ends. A quoted value (with backslash escapes) runs to its closing
 *  quote, across lines. One with no closing quote, as in truncated stderr, runs to the end of its line,
 *  so its tail is masked too. An unquoted value is a run of `unquoted` characters. `unclosed` records,
 *  per quote character, a position after which that quote never closes. Any later opening quote lies
 *  past it and is plain text to that earlier scan, so it cannot close either. No stretch is scanned for a
 *  closing quote twice, and a pass that consumes each value it measures stays linear. */
function valueEnd(text: string, start: number, unquoted: RegExp, unclosed: Map<string, number>): number {
    const quote = text[start];
    let end = start;
    if (quote === undefined || !VALUE_QUOTE.test(quote)) {
        while (end < text.length && unquoted.test(text[end])) {
            end++;
        }
        return end;
    }
    if ((unclosed.get(quote) ?? text.length) > start) {
        for (let i = start + 1; i < text.length; i++) {
            if (text[i] === '\\') {
                i++;
            } else if (text[i] === quote) {
                return i + 1;
            }
        }
        unclosed.set(quote, start);
    }
    while (end < text.length && text[end] !== '\n' && text[end] !== '\r') {
        end++;
    }
    return end;
}

/** Mask the value of every `key=value` / `key: value` pair whose key names a secret. A pair with an
 *  ordinary key keeps its value, and scanning goes on inside it (`a=token=x` masks `token`'s value).
 *  Linear in the text's length. */
function maskSensitivePairs(text: string): string {
    let out = '';
    let copied = 0;
    const unclosed = new Map<string, number>();
    KEY_SEPARATOR.lastIndex = 0;
    for (let pair = KEY_SEPARATOR.exec(text); pair !== null; pair = KEY_SEPARATOR.exec(text)) {
        const start = KEY_SEPARATOR.lastIndex;
        if (!SENSITIVE_KEY.test(pair[1])) {
            continue;
        }
        const end = valueEnd(text, start, NON_SPACE, unclosed);
        if (end === start) {
            continue;
        }
        out += `${text.slice(copied, pair.index)}${pair[1]}=***`;
        copied = end;
        KEY_SEPARATOR.lastIndex = end;
    }
    return out + text.slice(copied);
}

/** Redact plain-text credentials in free-form output (e.g. `token=abc`, `Authorization: Bearer ***`, `{"token":"abc"}`, `OPENAI_API_KEY=abc`) so non-URL secrets never reach a report verbatim. */
export function redactPlainSecrets(text: string): string {
    return maskSensitivePairs(text)
        .replace(/(["']?authorization["']?)\s*[:=]\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\S+.*)/gi, '$1=***')
        // Any length: a short Bearer token or `Basic YTo=` is still a credential. Basic is held to
        // base64 shape (whole 4-character groups, valid padding), so prose such as "basic usage" is left alone.
        .replace(/\b(bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 ***')
        .replace(/\b(basic)\s+(?:(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)(?![A-Za-z0-9+/=])/gi, '$1 ***');
}

const SCHEME_CHAR = /[a-z0-9+.-]/i;
const LETTER = /[a-z]/i;
/** Characters that end a URL in free-form text. */
const URL_TERMINATOR = /[\s"'`<>]/;
const QUOTE = /["'`<>]/;
/** The userinfo of a network-path reference (`//alice:secret@host/x`, RFC 3986 §4.2): a `//` that starts
 *  the text or follows whitespace, a quote, a bracket, `(`, `=` or `,`, so the `//` of `https://` and of a
 *  path such as `a//b` never matches. The userinfo runs to the last `@` before the first `/`, since a
 *  password may hold `@`. A `user:password` form may also hold a quote, backtick or angle bracket, which
 *  fails toward hiding. Linear: a match never crosses a `/`. */
const NETWORK_PATH_USERINFO = /(?<![^\s"'`<>([{=,])\/\/(?:[^\s/"'`<>]*|(?=[^\s/@:"'`<>]*:)[^\s/]*)@/g;
const WHITESPACE = /\s/;
/** The `?name=` or `&name=` that opens a query pair anywhere in the text; {@link valueEnd} measures its value. */
const QUERY_NAME = /([?&])([^=&#\s"'`<>]*)=/g;
/** Characters of an unquoted query value. */
const QUERY_UNQUOTED = /[^&#\s"'`<>]/;

/** Where the scheme ending at `separator` (the index of a `://`) starts: the whole run of scheme characters
 *  before it, which must begin with a letter; undefined when there is none. */
function schemeStart(text: string, separator: number): number | undefined {
    let start = separator;
    while (start > 0 && SCHEME_CHAR.test(text[start - 1])) {
        start--;
    }
    return start < separator && LETTER.test(text[start]) ? start : undefined;
}

/** Mask every URL's userinfo before anything else touches the text, so neither the query pass nor URL
 *  splitting can cut it apart (`https://alice:private&token=abc@host` would otherwise lose its `@` to the
 *  query pass). A well-formed userinfo, up to the last `@` before the first `/`, becomes `***:***@` or
 *  `***@`, which {@link redactEndpoint} later keeps. A malformed one runs further and becomes `***@`. That
 *  is one holding a quote, backtick or angle bracket (`https://alice:p"ass@host`), or a nested `://`
 *  (`https://alice:p://ss@host`), or one in a URL that does not parse. A `://` before any `/` can only sit
 *  inside a malformed authority, so the scan goes on past it instead of starting a new URL. When a `:`
 *  comes before the first `/`, the userinfo is a `user:password` whose password may hold `/`, so a
 *  malformed one runs to the last `@` before whitespace or a later `://`. Over-matching hides more, never
 *  less. Linear: each character is visited once. */
function maskUserinfo(text: string): string {
    let out = '';
    let copied = 0;
    for (let at = text.indexOf('://'); at !== -1; at = text.indexOf('://', at + 3)) {
        const body = at + 3;
        let slash = -1;
        let colonBeforeSlash = false;
        let quote = -1;
        let atBeforeSlash = -1;
        let lastAt = -1;
        let nested = -1;
        let i = body;
        for (; i < text.length && !WHITESPACE.test(text[i]); i++) {
            if (text.startsWith('://', i)) {
                if (slash !== -1 || nested !== -1) {
                    break;
                }
                nested = i;
            }
            const c = text[i];
            if (c === '/' && slash === -1) {
                slash = i;
            } else if (c === ':' && slash === -1) {
                colonBeforeSlash = true;
            } else if (c === '@') {
                lastAt = i;
                atBeforeSlash = slash === -1 ? i : atBeforeSlash;
            } else if (quote === -1 && QUOTE.test(c)) {
                quote = i;
            }
        }
        const start = schemeStart(text, at);
        const looseEnd = colonBeforeSlash ? lastAt : atBeforeSlash;
        const malformed = (quote !== -1 && looseEnd > quote) || (nested !== -1 && looseEnd > nested) ||
            (atBeforeSlash === -1 && looseEnd !== -1 && start !== undefined && !URL.canParse(text.slice(start, i)));
        const end = malformed ? looseEnd : atBeforeSlash;
        if (start !== undefined && end !== -1 && body >= copied) {
            const masked = malformed || !text.slice(body, end).includes(':') ? '***@' : '***:***@';
            out += text.slice(copied, body) + masked;
            copied = end + 1;
        }
        at = i - 3;
    }
    return out + text.slice(copied);
}

/** The URLs of any scheme (`https://`, `wss://`, `ssh://`, `git+https://`, …) in free-form text, as
 *  [start, end) spans. A scheme is the whole run of scheme characters before `://` and must begin with a
 *  letter, so it starts after any character that cannot be part of one, `_` included
 *  (`endpoint_https://…`). A URL needs at least one character after `://`, stops at whitespace, a quote,
 *  a backtick or an angle bracket, and ends where the next one begins, so adjacent URLs (`a,https://…`)
 *  are redacted one by one. Linear in the text's length: each `://` walks back only over its own scheme. */
function urlSpans(text: string): Array<[number, number]> {
    const starts: Array<{ start: number; body: number }> = [];
    for (let at = text.indexOf('://'); at !== -1; at = text.indexOf('://', at + 3)) {
        const start = schemeStart(text, at);
        if (start !== undefined) {
            starts.push({ start, body: at + 3 });
        }
    }
    const spans: Array<[number, number]> = [];
    starts.forEach(({ start, body }, i) => {
        const limit = starts[i + 1]?.start ?? text.length;
        let end = body;
        while (end < limit && !URL_TERMINATOR.test(text[end])) {
            end++;
        }
        if (end > body) {
            spans.push([start, end]);
        }
    });
    return spans;
}
/** Punctuation and closing brackets that end a sentence or a bracketed URL rather than belong to it. */
const TRAILING_DELIMITERS = /(?<![)\]}.,;:!?])[)\]}.,;:!?]+$/;
/** The userinfo of an unparsable URL, whose authority has no knowable end (a password may hold `/`):
 *  everything up to the last `@`. An `@` in the path or query over-matches; that hides more, never less. */
const UNPARSED_URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)\S*@/i;
/** One `name=value` query parameter, matched without parsing. */
const URL_QUERY_PARAM = /([?&])([^=&#\s]*)=([^&#\s]*)/g;

/** Whether a query name is sensitive once percent-decoded (`to%6ben` is `token`); a name that does not
 *  decode counts as sensitive, so this fails toward hiding. */
function isSensitiveQueryName(name: string): boolean {
    try {
        return SENSITIVE_PARAM.test(decodeURIComponent(name.replace(/\+/g, ' ')));
    } catch {
        return true;
    }
}

/** Mask sensitive query values anywhere in the text, quoted ones included (`?to%6ben="secret"`, a
 *  backtick-quoted value), before URLs are found: a quote would otherwise end the URL before its value. */
function maskQueryPairs(text: string): string {
    let out = '';
    let copied = 0;
    const unclosed = new Map<string, number>();
    QUERY_NAME.lastIndex = 0;
    for (let pair = QUERY_NAME.exec(text); pair !== null; pair = QUERY_NAME.exec(text)) {
        const end = valueEnd(text, QUERY_NAME.lastIndex, QUERY_UNQUOTED, unclosed);
        if (isSensitiveQueryName(pair[2])) {
            out += `${text.slice(copied, pair.index)}${pair[1]}${pair[2]}=***`;
            copied = end;
        }
        QUERY_NAME.lastIndex = end;
    }
    return out + text.slice(copied);
}

/** Mask sensitive query values in an unparsable URL. */
function maskSensitiveQuery(url: string): string {
    return url.replace(URL_QUERY_PARAM, (param, separator: string, name: string) =>
        isSensitiveQueryName(name) ? `${separator}${name}=***` : param);
}

/** Redact credentials anywhere in free-form text: URL userinfo and sensitive query params first
 *  ({@link redactEndpoint}), then plain-text forms such as `token=…` and `Bearer …`
 *  ({@link redactPlainSecrets}). Use it for anything that leaves the process: logs, UI, reports. */
export function redactText(text: string): string {
    // 0. Userinfo first, so no later pass can cut it apart; then query values, which a quote, backtick or
    //    angle bracket would otherwise cut off from their URL.
    const prepared = maskQueryPairs(maskUserinfo(text).replace(NETWORK_PATH_USERINFO, '//***@'));
    let out = '';
    let copied = 0;
    for (const [start, end] of urlSpans(prepared)) {
        out += prepared.slice(copied, start) + redactUrl(prepared.slice(start, end));
        copied = end;
    }
    return redactPlainSecrets(out + prepared.slice(copied));
}

/** Redact one URL found in free-form text. */
function redactUrl(match: string): string {
    // 1. The whole match, so punctuation that belongs to a credential (`signature=!!!`) is masked with it.
    const whole = redactEndpoint(match);
    if (whole !== match) {
        return whole;
    }
    // 2. Prose may end a URL with `]`, `)`, `.` and the like, which can make it unparsable:
    //    retry without them and put them back.
    const url = match.replace(TRAILING_DELIMITERS, '');
    const trimmed = url === match ? match : redactEndpoint(url);
    if (trimmed !== url) {
        return trimmed + match.slice(url.length);
    }
    // 3. A URL that parses and needed no change has nothing left to hide: its userinfo was masked up front
    //    (maskUserinfo). One that does not parse has `user:pass@` and sensitive query values masked
    //    without parsing, over the whole match, so this fails toward hiding.
    return URL.canParse(url) ? match : maskSensitiveQuery(match.replace(UNPARSED_URL_USERINFO, '$1***@'));
}
