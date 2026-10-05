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
/** A value at a given position: a quoted string (with escapes) or a run of non-space characters. */
const VALUE_AT = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\S+/y;

/** Mask the value of every `key=value` / `key: value` pair whose key names a secret. A pair with an
 *  ordinary key keeps its value, and scanning goes on inside it (`a=token=x` masks `token`'s value).
 *  Linear in the text's length. */
function maskSensitivePairs(text: string): string {
    let out = '';
    let copied = 0;
    KEY_SEPARATOR.lastIndex = 0;
    for (let pair = KEY_SEPARATOR.exec(text); pair !== null; pair = KEY_SEPARATOR.exec(text)) {
        const valueStart = KEY_SEPARATOR.lastIndex;
        VALUE_AT.lastIndex = valueStart;
        if (!SENSITIVE_KEY.test(pair[1]) || !VALUE_AT.test(text)) {
            continue;
        }
        out += `${text.slice(copied, pair.index)}${pair[1]}=***`;
        copied = VALUE_AT.lastIndex;
        KEY_SEPARATOR.lastIndex = copied;
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
const URL_TERMINATOR = /[\s"'<>]/;
const QUOTE = /["'<>]/;
const WHITESPACE = /\s/;
/** A `name=value` query pair anywhere in the text, its value possibly quoted. */
const QUERY_PAIR = /([?&])([^=&#\s"'<>]*)=("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^&#\s"'<>]*)/g;

/** Where the scheme ending at `separator` (the index of a `://`) starts: the whole run of scheme characters
 *  before it, which must begin with a letter; undefined when there is none. */
function schemeStart(text: string, separator: number): number | undefined {
    let start = separator;
    while (start > 0 && SCHEME_CHAR.test(text[start - 1])) {
        start--;
    }
    return start < separator && LETTER.test(text[start]) ? start : undefined;
}

/** Mask a userinfo holding a quote or angle bracket, which would end a URL found by {@link urlSpans} before
 *  its `@` (`https://alice:p"ass@host`, `https://alice:p/"ass@host`). The mask runs from the scheme to the
 *  last `@` before the first `/`. When a `:` comes before that `/`, the userinfo is a `user:password`
 *  whose password may hold `/`, so the mask runs to the last `@` before whitespace or the next `://`.
 *  Over-matching hides more, never less. Linear: each character is visited once. */
function maskQuotedUserinfo(text: string): string {
    let out = '';
    let copied = 0;
    for (let at = text.indexOf('://'); at !== -1; at = text.indexOf('://', at + 3)) {
        const body = at + 3;
        let slash = -1;
        let colonBeforeSlash = false;
        let quote = -1;
        let atBeforeSlash = -1;
        let lastAt = -1;
        let i = body;
        for (; i < text.length && !WHITESPACE.test(text[i]) && !text.startsWith('://', i); i++) {
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
        const end = colonBeforeSlash ? lastAt : atBeforeSlash;
        if (schemeStart(text, at) !== undefined && quote !== -1 && end > quote) {
            out += `${text.slice(copied, body)}***@`;
            copied = end + 1;
        }
        at = i - 3;
    }
    return out + text.slice(copied);
}

/** The URLs of any scheme (`https://`, `wss://`, `ssh://`, `git+https://`, …) in free-form text, as
 *  [start, end) spans. A scheme is the whole run of scheme characters before `://` and must begin with a
 *  letter, so it starts after any character that cannot be part of one, `_` included
 *  (`endpoint_https://…`). A URL needs at least one character after `://`, stops at whitespace, a quote or
 *  an angle bracket, and ends where the next one begins, so adjacent URLs (`a,https://…`) are redacted one
 *  by one. Linear in the text's length: each `://` walks back only over its own scheme. */
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
/** The userinfo of a parsable URL, `scheme://user:pass@`, matched without parsing: up to the last `@`
 *  before the first `/`, since a raw `@`, `?` or `#` may appear inside a password. This can over-match a
 *  URL with no path and an `@` in its query; that hides more, never less. */
const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/i;
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

/** Mask sensitive query values anywhere in the text, quoted ones included (`?to%6ben="secret"`), before
 *  URLs are found: a quote would otherwise end the URL before its value. */
function maskQueryPairs(text: string): string {
    return text.replace(QUERY_PAIR, (pair, separator: string, name: string) =>
        isSensitiveQueryName(name) ? `${separator}${name}=***` : pair);
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
    // 0. A quote or angle bracket would cut a URL short of its `@` or of a query value: mask those first.
    const prepared = maskQuotedUserinfo(maskQueryPairs(text));
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
    // 3. Still unparsable or unchanged: mask `user:pass@` and sensitive query values without
    //    parsing, over the whole match, so this fails toward hiding.
    const userinfo = URL.canParse(url) ? URL_USERINFO : UNPARSED_URL_USERINFO;
    return maskSensitiveQuery(match.replace(userinfo, '$1***@'));
}
