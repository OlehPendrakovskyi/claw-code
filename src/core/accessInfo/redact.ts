/** Query-parameter names whose values are secrets; shared by the parsed and the unparsed path. */
const SENSITIVE_PARAM = /(api_?key|api-key|key|token|password|passwd|secret|credential|access_key|signature|authorization|cookie)/i;

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
/** A key and its `:` or `=` separator. The key is a whole run of name characters, optionally quoted, with
 *  escaped quotes too (`\"token\"` inside a JSON string), so a long run is tried once rather than from each
 *  of its characters. */
const KEY_SEPARATOR = /(?<![A-Za-z0-9_.-])(\\?["']?[A-Za-z0-9_.-]+\\?["']?)\s*[:=]\s*/g;
const VALUE_QUOTE = /["'`]/;
/** Header names whose whole value is a credential: `Authorization`, `Cookie`, `Set-Cookie`. */
const CREDENTIAL_HEADER_KEY = /authorization|cookie/i;
/** A credential header and its whole value (quoted, or the rest of the line), masked as `Name=***`. A value
 *  that is already a bare `***` ending a JSON field (a quoted value masked by an earlier pass, then `,`, a
 *  closing bracket or the end) is left alone, so the fields after it survive. Anything else after it,
 *  such as `; session=…` in a Cookie header, is still part of the header and is masked. A name right after
 *  `?` or `&` is a query parameter, which the query passes handle. A quoted value stays on its line, so an unterminated one never sends the match
 *  scanning to the end of the text. */
const CREDENTIAL_HEADER = /(?<![?&])(["']?(?:authorization|(?:set-)?cookie)["']?)\s*[:=]\s*(?!\*\*\*(?:[,)\]}]|$))("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|`(?:\\.|[^`\\\r\n])*`|\S+.*)/gi;
const NON_SPACE = /\S/;
/** The key and separator of a pair that follows an unquoted secret on its line (`page=2`, `"name":`). */
const NEXT_PAIR = /\\?["']?[A-Za-z0-9_.-]+\\?["']?[ \t]*[:=]/y;
/** A value an earlier pass already masked, left bare (`?token=*** ok`). */
const MASKED_VALUE = /\*\*\*(?=\s|$)/y;

/** Whether a value opens with a backslash-escaped quote, as inside a JSON string (`"password=\\"a b\\""`). */
function isEscapedQuote(text: string, start: number): boolean {
    return text[start] === '\\' && VALUE_QUOTE.test(text[start + 1] ?? '');
}

/** Where a value opened by an escaped quote ends: after the matching escaped quote. Without one it ends
 *  where the enclosing string does, at an unescaped `"`, or at the end of the line, so its tail is masked
 *  too. A run of n backslashes before the quote encodes it twice over: the outer string unescapes it to
 *  (n - 1) / 2 backslashes and a quote, which closes the value only when that count is even, so only
 *  n % 4 === 1 closes (`\"` does, the interior `\\\"` does not). Each scan stops at the enclosing string's
 *  end, which keeps a pass linear. */
function escapedValueEnd(text: string, start: number): number {
    const quote = text[start + 1];
    let i = start + 2;
    while (i < text.length && text[i] !== '"' && text[i] !== '\n' && text[i] !== '\r') {
        if (text[i] !== '\\') {
            i++;
            continue;
        }
        let run = 0;
        while (text[i + run] === '\\') {
            run++;
        }
        if (text[i + run] === quote) {
            if (run % 4 === 1) {
                return i + run + 1;
            }
            i += run + 1;
        } else {
            i += run;
        }
    }
    return i;
}

/** Where an unquoted secret ends. A password may hold spaces (`password=correct horse battery staple`),
 *  so the value runs to the end of its line, or to just before the next `key=` / `key:` pair on it, so that
 *  pair is still scanned (`key=a signature=b page=2`). Trailing whitespace is left outside. Linear: each
 *  space is followed by at most one name run, and no two runs overlap. */
function unquotedSecretEnd(text: string, start: number): number {
    let end = start;
    while (end < text.length && text[end] !== '\n' && text[end] !== '\r') {
        if (text[end] === ' ' || text[end] === '\t') {
            NEXT_PAIR.lastIndex = end + 1;
            if (NEXT_PAIR.test(text)) {
                break;
            }
        }
        end++;
    }
    while (end > start && (text[end - 1] === ' ' || text[end - 1] === '\t')) {
        end--;
    }
    return end;
}

/** Where an array or object value (`[ "a", "b" ]`, `{ "value": "x" }`) ends: after its matching bracket,
 *  skipping quoted strings and their escapes, so nested and spaced contents are masked with it. One that
 *  never closes, holds an unclosed string or a mismatched bracket, runs to the end of the text. A pass consumes the value it
 *  measures, so no stretch is scanned twice. */
function compositeValueEnd(text: string, start: number): number {
    const closers: string[] = [];
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (VALUE_QUOTE.test(c)) {
            i++;
            while (i < text.length && text[i] !== c) {
                i += text[i] === '\\' ? 2 : 1;
            }
        } else if (c === '[' || c === '{') {
            closers.push(c === '[' ? ']' : '}');
        } else if (c === ']' || c === '}') {
            // A bracket that does not close the innermost open one leaves the value's end unknown.
            if (closers.pop() !== c) {
                return text.length;
            }
            if (closers.length === 0) {
                return i + 1;
            }
        }
    }
    return text.length;
}

/** Where a value that starts at `start` ends. A quoted value (with backslash escapes) runs to its closing
 *  quote, across lines. One with no closing quote, as in truncated stderr, runs to the end of the text: a
 *  quoted value may span lines, so everything after an unclosed one is ambiguous. An unquoted value is a run
 *  of `unquoted` characters. `unclosed` records, per quote character, a position after which that quote
 *  never closes. Any later opening quote lies past it and is plain text to that earlier scan, so it cannot
 *  close either. No stretch is scanned for a closing quote twice, and a pass that consumes each value it
 *  measures stays linear. */
function valueEnd(text: string, start: number, unquoted: RegExp, unclosed: Map<string, number>): number {
    if (isEscapedQuote(text, start)) {
        return escapedValueEnd(text, start);
    }
    if (text[start] === '[' || text[start] === '{') {
        return compositeValueEnd(text, start);
    }
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
    return text.length;
}

/** Mask the value of every `key=value` / `key: value` pair whose key names a secret, as `key=***`. With
 *  `quotedOnly`, only quoted values are masked, and each stays quoted (`"token":"***"`), so a later full
 *  pass consumes just that quoted value rather than the text after it. An unquoted value may hold spaces
 *  ({@link unquotedSecretEnd}); a bare `***` left by an earlier pass is skipped. A pair with an ordinary key keeps
 *  its value, and scanning goes on inside it (`a=token=x` masks `token`'s value). Linear in the text's
 *  length. */
function maskSensitivePairs(text: string, quotedOnly = false): string {
    let out = '';
    let copied = 0;
    const unclosed = new Map<string, number>();
    KEY_SEPARATOR.lastIndex = 0;
    for (let pair = KEY_SEPARATOR.exec(text); pair !== null; pair = KEY_SEPARATOR.exec(text)) {
        const start = KEY_SEPARATOR.lastIndex;
        const escaped = isEscapedQuote(text, start);
        const quoted = escaped || VALUE_QUOTE.test(text[start] ?? '');
        const composite = text[start] === '[' || text[start] === '{';
        // A quoted, array or object Authorization or Cookie value is a credential too, masked whole; a bare one
        // is left to CREDENTIAL_HEADER, which takes the rest of its line.
        const sensitive = SENSITIVE_KEY.test(pair[1]) || ((quoted || composite) && CREDENTIAL_HEADER_KEY.test(pair[1]));
        if (!sensitive || (quotedOnly && !quoted)) {
            continue;
        }
        MASKED_VALUE.lastIndex = start;
        if (!quoted && !composite && MASKED_VALUE.test(text)) {
            continue;
        }
        const end = quoted || composite ? valueEnd(text, start, NON_SPACE, unclosed) : unquotedSecretEnd(text, start);
        if (end === start) {
            continue;
        }
        const opening = escaped ? text.slice(start, start + 2) : text[start];
        out += quotedOnly
            ? `${text.slice(copied, start)}${opening}***${opening}`
            : `${text.slice(copied, pair.index)}${pair[1]}=***`;
        copied = end;
        KEY_SEPARATOR.lastIndex = end;
    }
    return out + text.slice(copied);
}

/** A terminal control sequence: any CSI form (ECMA-48), with parameter bytes `0-?` (digits, `;`, `:`, `?`, …),
 *  intermediate bytes ` -/` and a final byte `@-~`, as in `ESC[31m`, `ESC[?25h` or `ESC[38:2:1:2:3m`; or an OSC
 *  sequence (`ESC]0;title`) ended by BEL or ST (`ESC\\`). A truncated OSC runs to the next ESC, BEL or line
 *  break, so no sequence scans past another and stripping stays linear. The same sequences serialised, with
 *  ESC written as `\\u001b` or `\\x1b` (JSON on stderr: `"token\\u001b[0m=…"`), are stripped too; a serialised
 *  OSC stops at the next backslash or quote, so it never runs past the end of its string. */
// eslint-disable-next-line no-control-regex
const TERMINAL_CODE = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b\r\n]*(?:\u0007|\u001b\\)?|\\(?:u001b|x1b)\[[0-?]*[ -/]*[@-~]|\\(?:u001b|x1b)\][^\\"\r\n]*(?:\\(?:u0007|x07)|\\(?:u001b|x1b)\\\\)?/gi;

/** Text without terminal colour and other CSI codes, which could sit between a label and its value. */
export function stripTerminalCodes(text: string): string {
    return text.replace(TERMINAL_CODE, '');
}

const BEARER = /\b(bearer)\s+/gi;
/** A Bearer token at a given position: quoted (to its closing quote or the end of its line) or bare. */
const BEARER_TOKEN = /"(?:\\.|[^"\\\r\n])*"?|'(?:\\.|[^'\\\r\n])*'?|[A-Za-z0-9._~+/-]+=*/y;

/** Mask every Bearer token, of any length (a short one is still a credential), as `Bearer ***`. A token
 *  opened by an escaped quote, as in serialized error details (`"sent Bearer \\"a b\\""`), runs to its matching
 *  escaped quote, past escaped interior quotes, or without one to the end of the enclosing string or line.
 *  Linear: each pass consumes the token it measures. */
function maskBearerTokens(text: string): string {
    let out = '';
    let copied = 0;
    BEARER.lastIndex = 0;
    for (let match = BEARER.exec(text); match !== null; match = BEARER.exec(text)) {
        const start = BEARER.lastIndex;
        let end = start;
        if (isEscapedQuote(text, start)) {
            end = escapedValueEnd(text, start);
        } else {
            BEARER_TOKEN.lastIndex = start;
            if (BEARER_TOKEN.test(text)) {
                end = BEARER_TOKEN.lastIndex;
            }
        }
        if (end === start) {
            continue;
        }
        out += `${text.slice(copied, match.index)}${match[1]} ***`;
        copied = end;
        BEARER.lastIndex = end;
    }
    return out + text.slice(copied);
}

/** Redact plain-text credentials in free-form output (e.g. `token=abc`, `Authorization: Bearer ***`, `{"token":"abc"}`, `OPENAI_API_KEY=abc`) so non-URL secrets never reach a report verbatim. */
export function redactPlainSecrets(text: string): string {
    return maskBearerTokens(maskSensitivePairs(text).replace(CREDENTIAL_HEADER, '$1=***'))
        // Any length: `Basic YTo=` is still a credential. Basic is held to base64 shape (whole 4-character
        // groups, valid padding), so prose such as "basic usage" is left alone.
        .replace(/\b(basic)\s+(?:(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)(?![A-Za-z0-9+/=])/gi, '$1 ***')
        // An unpadded or truncated value (`Basic Zm9vOmJhcg`) is still a credential when it looks encoded: eight or
        // more base64 characters holding a digit, `+`, `/` or a capital after the first. Case-sensitive on
        // purpose, so prose such as "Basic Authentication" is left alone.
        .replace(/\b([Bb][Aa][Ss][Ii][Cc])\s+(?=[A-Za-z0-9+/]{8})(?=[A-Za-z0-9+/]*[0-9+/]|[A-Za-z0-9+/][A-Za-z0-9+/]*[A-Z])[A-Za-z0-9+/]+=*(?![A-Za-z0-9+/=])/g, '$1 ***');
}

const SCHEME_CHAR = /[a-z0-9+.-]/i;
const LETTER = /[a-z]/i;
/** Characters that end a URL in free-form text. */
const URL_TERMINATOR = /[\s"'`<>]/;
/** The userinfo of a network-path reference (`//alice:secret@host/x`, RFC 3986 §4.2): a `//` that starts
 *  the text or follows whitespace, a quote, a bracket, `(`, `=` or `,`, so the `//` of `https://` and of a
 *  path such as `a//b` never matches. The userinfo runs to the last `@` before the first `/`, since a
 *  password may hold `@`. A `user:password` form may also hold a quote, backtick or angle bracket, spaces
 *  (running to the last `@` before a `/` or the end of its line), or a `/` (`//alice:p/ss@host`, running to the last `@` before
 *  whitespace or a character that could start another reference). This fails toward hiding, so a
 *  `//host:port/…@…` can be over-masked. A password holding both spaces and `/` is left to
 *  {@link maskAmbiguousNetworkUserinfo}. Linear: no match crosses a line break or a character that could
 *  start another match. */
const NETWORK_PATH_USERINFO = /(?<![^\s"'`<>([{=,])\/\/(?:[^\s/"'`<>]*@|(?=[^\s/@:"'`<>]*:)(?:[^\s/]*@|[^/\r\n]*@|[^\s"'`<>([{=,]*@))/g;
const WHITESPACE = /\s/;
/** What may precede the `//` of a network-path reference, as in {@link NETWORK_PATH_USERINFO}. */
const NETWORK_PATH_BOUNDARY = /[\s"'`<>([{=,]/;
/** A `user:password-start` right after `//`, whose second part holds a non-digit, so it is no `host:port`. */
const NON_PORT_USERINFO = /[^\s/@:"'`<>]*:[^\s/@]*[^\d\s/@]/y;

/** Mask a network-path userinfo whose password holds both spaces and `/`
 *  (`//alice:pass word/x@host`), which {@link NETWORK_PATH_USERINFO} cannot delimit: from `//` to the last `@`
 *  before the end of the line or the next reference. It applies only where what follows `user:` cannot be a
 *  port. Linear: a scan stops where the next reference could start, and the search resumes there. */
function maskAmbiguousNetworkUserinfo(text: string): string {
    let out = '';
    let copied = 0;
    let from = 0;
    for (let at = text.indexOf('//', from); at !== -1; at = text.indexOf('//', from)) {
        from = at + 2;
        NON_PORT_USERINFO.lastIndex = at + 2;
        if ((at > 0 && !NETWORK_PATH_BOUNDARY.test(text[at - 1])) || at < copied || !NON_PORT_USERINFO.test(text)) {
            continue;
        }
        let lastAt = -1;
        let j = at + 2;
        while (j < text.length && text[j] !== '\n' && text[j] !== '\r' &&
            !(text.startsWith('//', j) && NETWORK_PATH_BOUNDARY.test(text[j - 1]))) {
            lastAt = text[j] === '@' ? j : lastAt;
            j++;
        }
        if (lastAt !== -1) {
            out += `${text.slice(copied, at + 2)}***@`;
            copied = lastAt + 1;
        }
        from = Math.max(from, lastAt !== -1 ? lastAt + 1 : j);
    }
    return out + text.slice(copied);
}
/** The `?name=` or `&name=` that opens a query pair anywhere in the text; {@link valueEnd} measures its value. */
const QUERY_NAME = /([?&])([^=&#?\s"'`<>]*)=/g;
const QUERY_VALUE_STOP = /[&#\s]/;
const EMBEDDED_DELIMITER = /["'`<>]/;
/** What may follow a quote, backtick or angle bracket that closes the text around a query value. */
const VALUE_CLOSER = /[\s>"'`,;)\]}]/;

/** Where an unquoted sensitive query value ends: at `&`, `#` or whitespace. A quote, backtick or angle
 *  bracket ends it only where it closes the surrounding text (`href="…?token=abc">`), that is, when
 *  followed by whitespace, a closer or the end. So `to%6ben=abc"PRIVATE` is masked whole; over-matching
 *  hides more, never less. */
function sensitiveQueryValueEnd(text: string, start: number): number {
    let end = start;
    while (end < text.length && !QUERY_VALUE_STOP.test(text[end])) {
        if (EMBEDDED_DELIMITER.test(text[end]) && (end + 1 === text.length || VALUE_CLOSER.test(text[end + 1]))) {
            break;
        }
        end++;
    }
    return end;
}

/** Where the scheme ending at `separator` (the index of a `://`) starts: the whole run of scheme characters
 *  before it, which must begin with a letter; undefined when there is none. */
function schemeStart(text: string, separator: number): number | undefined {
    let start = separator;
    while (start > 0 && SCHEME_CHAR.test(text[start - 1])) {
        start--;
    }
    return start < separator && LETTER.test(text[start]) ? start : undefined;
}

/** A special scheme (`http`, `https`, `ws`, `wss`, `ftp`) and the slashes after it. A URL parser takes any run
 *  of `/` and `\` there, or none, as the start of the authority: `https:/alice:pw@host`, `https:\\alice:pw@host`
 *  and `https:alice:pw@host` all carry `alice:pw` as userinfo. */
const SPECIAL_SCHEME = /(?<![a-z0-9+.-])(?:https?|wss?|ftp):[/\\]*/gi;
const LINE_BREAK = /[\r\n]/g;

/** Rewrite the separator of a special-scheme URL spelled other than `://` (`https:/`, `https:\\`, `https:`,
 *  `https:///`) as `://` when an `@` follows on its line, so the userinfo passes find it as a parser would.
 *  The redacted text shows the standard spelling, as {@link redactEndpoint} does. Linear: the next `@` and
 *  line break are each found once per stretch. */
function normalizeSpecialSchemes(text: string): string {
    let out = '';
    let copied = 0;
    let nextAt = -1;
    let nextBreak = -1;
    SPECIAL_SCHEME.lastIndex = 0;
    for (let match = SPECIAL_SCHEME.exec(text); match !== null; match = SPECIAL_SCHEME.exec(text)) {
        const end = SPECIAL_SCHEME.lastIndex;
        const separator = match[0].slice(match[0].indexOf(':'));
        if (separator === '://' || end >= text.length || WHITESPACE.test(text[end])) {
            continue;
        }
        if (nextAt < end) {
            nextAt = text.indexOf('@', end);
            nextAt = nextAt === -1 ? text.length : nextAt;
        }
        if (nextBreak < end) {
            LINE_BREAK.lastIndex = end;
            nextBreak = LINE_BREAK.exec(text)?.index ?? text.length;
        }
        if (nextAt >= nextBreak) {
            continue;
        }
        out += `${text.slice(copied, match.index)}${match[0].slice(0, match[0].indexOf(':'))}://`;
        copied = end;
    }
    return out + text.slice(copied);
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
        let malformedTail = false;
        const start = schemeStart(text, at);
        let i = body;
        for (; i < text.length && !WHITESPACE.test(text[i]); i++) {
            // A `://` inside the authority sits in a malformed one (`alice:p://ss://x@host`): skip its `//`, which
            // is no path, and go on. One after the authority ends (`/`, `?` or `#`) starts the next URL, as in
            // `https://host?redirect=https://…`, unless what came before is an unparsable `user:…` with no `@`
            // yet (`alice:P/ss://tail@host`): then the whole run stays one malformed userinfo, so its prefix is
            // not left behind.
            if (text.startsWith('://', i)) {
                if (authorityEnd !== -1 && !malformedTail) {
                    const ambiguous = start !== undefined && colonBeforeSlash && lastAt === -1 && !URL.canParse(text.slice(start, i));
                    if (!ambiguous) {
                        break;
                    }
                    malformedTail = true;
                }
                nested = nested === -1 ? i : nested;
                colonBeforeSlash = true;
                i += 2;
                continue;
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
        // running on to the last `@` (the password may hold `@` too) before a `/`, the end of the line or another
        // `://`. When the text before the space does not parse (`alice:PRIVATE` is no port), it is one ambiguous
        // authority to the end of its line, `/` and nested `://` included (`alice:P word://tail@host`); with no
        // `@` in that stretch it holds no userinfo and is skipped whole, so no stretch is scanned twice.
        let spacedAt = -1;
        if (i < text.length && slash === -1 && colonBeforeSlash && lastAt === -1) {
            const ambiguous = start !== undefined && !URL.canParse(text.slice(start, i));
            let j = i;
            for (; j < text.length && text[j] !== '\r' && text[j] !== '\n'; j++) {
                if (!ambiguous && (text[j] === '/' || text.startsWith('://', j))) {
                    break;
                }
                spacedAt = text[j] === '@' ? j : spacedAt;
            }
            i = spacedAt !== -1 ? spacedAt : ambiguous ? j : i;
        }
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
        // `?token= value`: the value starts after any whitespace, a line break included, as in the plain-text pairs.
        let start = QUERY_NAME.lastIndex;
        while (WHITESPACE.test(text[start] ?? '')) {
            start++;
        }
        const quoted = isEscapedQuote(text, start) || VALUE_QUOTE.test(text[start] ?? '');
        const end = quoted ? valueEnd(text, start, NON_SPACE, unclosed) : sensitiveQueryValueEnd(text, start);
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
    // 0. Userinfo first, so no later pass can take its `@` (`https://alice:p&token="x@host`); then whole
    //    quoted credentials (`{"password":"a?token=b\"tail"}`), so the query pass cannot eat an escape inside
    //    one; then query values, which a quote, backtick or angle bracket would otherwise cut off from their URL.
    // Terminal colour codes could sit between a label and its value (`token\u001b[0m=…`): drop them first.
    // A special scheme spelled `https:/` or `https:\\` gets `://`, so its userinfo is found as a parser finds it.
    const plain = normalizeSpecialSchemes(stripTerminalCodes(text));
    const userinfoMasked = maskAmbiguousNetworkUserinfo(maskUserinfo(plain).replace(NETWORK_PATH_USERINFO, '//***@'));
    const prepared = maskQueryPairs(maskSensitivePairs(userinfoMasked, true));
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
