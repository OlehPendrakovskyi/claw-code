/** Query-parameter names whose values are secrets; shared by the parsed and the unparsed path. */
const SENSITIVE_PARAM = /(api_?key|api-key|key|token|password|passwd|secret|credential|access_key|signature|authorization)/i;

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
const AUTHORIZATION_KEY = /authorization/i;
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

/** Mask the value of every `key=value` / `key: value` pair whose key names a secret, as `key=***`. With
 *  `quotedOnly`, only quoted values are masked, and each stays quoted (`"token":"***"`), so a later full
 *  pass consumes just that quoted value rather than the text after it. A pair with an ordinary key keeps
 *  its value, and scanning goes on inside it (`a=token=x` masks `token`'s value). Linear in the text's
 *  length. */
function maskSensitivePairs(text: string, quotedOnly = false): string {
    let out = '';
    let copied = 0;
    const unclosed = new Map<string, number>();
    KEY_SEPARATOR.lastIndex = 0;
    for (let pair = KEY_SEPARATOR.exec(text); pair !== null; pair = KEY_SEPARATOR.exec(text)) {
        const start = KEY_SEPARATOR.lastIndex;
        const quoted = VALUE_QUOTE.test(text[start] ?? '');
        // A quoted Authorization value is a credential too; unquoted ones are left to the Authorization rule.
        const sensitive = SENSITIVE_KEY.test(pair[1]) || (quoted && AUTHORIZATION_KEY.test(pair[1]));
        if (!sensitive || (quotedOnly && !quoted)) {
            continue;
        }
        const end = valueEnd(text, start, NON_SPACE, unclosed);
        if (end === start) {
            continue;
        }
        out += quotedOnly
            ? `${text.slice(copied, start)}${text[start]}***${text[start]}`
            : `${text.slice(copied, pair.index)}${pair[1]}=***`;
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
/** The userinfo of a network-path reference (`//alice:secret@host/x`, RFC 3986 §4.2): a `//` that starts
 *  the text or follows whitespace, a quote, a bracket, `(`, `=` or `,`, so the `//` of `https://` and of a
 *  path such as `a//b` never matches. The userinfo runs to the last `@` before the first `/`, since a
 *  password may hold `@`. A `user:password` form may also hold a quote, backtick or angle bracket, or
 *  spaces up to the first `@` on its line, which fails toward hiding. Linear: a match never crosses a `/`
 *  or a line break. */
const NETWORK_PATH_USERINFO = /(?<![^\s"'`<>([{=,])\/\/(?:[^\s/"'`<>]*@|(?=[^\s/@:"'`<>]*:)(?:[^\s/]*@|[^/\r\n@]*@))/g;
const WHITESPACE = /\s/;
/** The `?name=` or `&name=` that opens a query pair anywhere in the text; {@link valueEnd} measures its value. */
const QUERY_NAME = /([?&])([^=&#?\s"'`<>]*)=/g;
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

/** Mask every URL's userinfo before the query pass or URL splitting can cut it apart
 *  (`https://alice:private&token=abc@host` would otherwise lose its `@` to the query pass). A URL that
 *  parses has the standard authority, ending at `/`, `?` or `#`. Its userinfo, up to the last `@` there,
 *  becomes `***:***@` or `***@`, which {@link redactEndpoint} later keeps, and an `@` in its query or
 *  fragment is left alone. A URL that does not parse is malformed (`https://alice:p"ass@host/`,
 *  `https://alice:p://ss@host`), and its userinfo becomes `***@`, running to the last `@` before the first
 *  `/`. When a `:` comes before that `/`, the userinfo is a `user:password` whose password may hold `/`,
 *  so it runs to the last `@` before whitespace or a later `://`. A `://` before any `/` can only sit
 *  inside a malformed authority, so the scan goes on past it instead of starting a new URL. Over-matching
 *  hides more, never less. Linear: each character is visited once. */
function maskUserinfo(text: string): string {
    let out = '';
    let copied = 0;
    for (let at = text.indexOf('://'); at !== -1; at = text.indexOf('://', at + 3)) {
        const body = at + 3;
        let slash = -1;
        let authorityEnd = -1;
        let colonBeforeSlash = false;
        let atBeforeSlash = -1;
        let atInAuthority = -1;
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
            if ((c === '/' || c === '?' || c === '#') && authorityEnd === -1) {
                authorityEnd = i;
            }
            if (c === '/' && slash === -1) {
                slash = i;
            } else if (c === ':' && slash === -1) {
                colonBeforeSlash = true;
            } else if (c === '@') {
                lastAt = i;
                atBeforeSlash = slash === -1 ? i : atBeforeSlash;
                atInAuthority = authorityEnd === -1 ? i : atInAuthority;
            }
        }
        // `https://alice:pass word@host`: a space ended the scan inside a `user:password`. Fail toward hiding by
        // running on to the first `@` on the line, unless a `/` or another `://` comes first.
        let spacedAt = -1;
        if (i < text.length && slash === -1 && colonBeforeSlash && lastAt === -1) {
            let j = i;
            while (j < text.length && !'/\r\n@'.includes(text[j]) && !text.startsWith('://', j)) {
                j++;
            }
            if (text[j] === '@') {
                spacedAt = j;
                i = j;
            }
        }
        const start = schemeStart(text, at);
        // A URL that parses has the standard authority, ending at `/`, `?` or `#` (`https://host?e=a@b` has
        // no userinfo). One that does not is malformed: its userinfo runs as far as it can (see above).
        // Only a URL with an `@` can have a userinfo, so only such a URL is parsed.
        const parsable = spacedAt === -1 && lastAt !== -1 && start !== undefined &&
            URL.canParse(text.slice(start, i).replace(TRAILING_DELIMITERS, ''));
        const end = spacedAt !== -1 ? spacedAt : parsable ? atInAuthority : colonBeforeSlash ? lastAt : atBeforeSlash;
        if (start !== undefined && end !== -1 && body >= copied) {
            const masked = parsable && text.slice(body, end).includes(':') ? '***:***@' : '***@';
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
/** One `name=value` query parameter, matched without parsing. A name holds no `?`, `&` or `=`, so each
 *  candidate name is scanned once, a failed one included. */
const URL_QUERY_PARAM = /([?&])([^=&#?\s]*)=([^&#\s]*)/g;

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
        // An ordinary pair keeps its value, and scanning goes on inside it (`?q='public&token=x'`).
        if (!isSensitiveQueryName(pair[2])) {
            continue;
        }
        const end = valueEnd(text, QUERY_NAME.lastIndex, QUERY_UNQUOTED, unclosed);
        out += `${text.slice(copied, pair.index)}${pair[1]}${pair[2]}=***`;
        copied = end;
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
    // 0. Whole quoted credentials first (`{"password":"a?token=b\"tail"}`), so no later pass can eat an escape
    //    inside one; then userinfo, so nothing can cut it apart; then query values, which a quote, backtick
    //    or angle bracket would otherwise cut off from their URL.
    const quotedMasked = maskSensitivePairs(text, true);
    const prepared = maskQueryPairs(maskUserinfo(quotedMasked).replace(NETWORK_PATH_USERINFO, '//***@'));
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
