/** Query-parameter names whose values are secrets; shared by the parsed and the unparsed path. */
const SENSITIVE_PARAM = /(api_?key|api-key|key|token|password|passwd|passphrase|(?<![a-z])pass(?![a-z])|secret|credential|access_key|signature|authorization|cookie)/i;

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
        // One detached pass, assigned once: `searchParams.set` per name rescans the list and reserialises the
        // URL, which is quadratic in the number of sensitive names. As `set` does, the first of a sensitive
        // name's entries keeps its place, masked, and the others go.
        const query = new URLSearchParams();
        const masked = new Set<string>();
        for (const [key, value] of url.searchParams) {
            if (!SENSITIVE_PARAM.test(key)) {
                query.append(key, value);
            } else if (!masked.has(key)) {
                masked.add(key);
                query.append(key, '***');
            }
        }
        if (masked.size > 0) {
            url.search = query.toString();
            redacted = true;
        }
        return redacted ? url.toString() : endpoint;
    } catch {
        return endpoint;
    }
}

/** Words that make a key's value a secret: `token`, `OPENAI_API_KEY`, `"password"`, `pass`, `db_pass`, … A bare
 *  `pass` must stand apart from other letters, so `bypass` and `passenger` are left alone. */
const SENSITIVE_KEY = /token|api[_-]?key|apikey|key|secret|password|passwd|passphrase|(?<![a-z])pass(?![a-z])|credential|access[_-]?key|signature/i;
/** Whitespace, raw or serialised (`\t`, `\n`, `\r` in JSON, or `\u0009`, `\u000a`, `\u000d`, with a longer backslash
 *  run at any deeper level), and
 *  JSON's short escapes of backspace and form feed (`\b`, `\f`), control bytes that would otherwise split a
 *  label from its value. A serialised one is matched only from the start of its backslash run, so a long run is
 *  tried once. They are not stripped from the text: `\b` also starts Windows path segments (`C:\bin`). */
const SPACE = String.raw`(?:\s|(?<!\\)\\+(?:[tnrbf]|u000[9aAdD]))`;
/** A key and its `:` or `=` separator. The key is a whole run of name characters, optionally quoted, with
 *  escaped quotes too (`\"token\"` inside a JSON string, `\\\"token\\\"` inside one serialised again), so a
 *  long run is tried once rather than from each of its characters or backslashes. A key may also start at a
 *  name character right after a backslash (`C:\secrets\OPENAI_API_KEY=…`, `failure\nOPENAI_API_KEY=…` inside a
 *  JSON string), or at an escaped quote right after serialised whitespace (`\n\"token\": …`); never inside a
 *  backslash run, nor at an escape letter right before another backslash, so a run of escapes (`\n\n\n…`)
 *  does not start a match at each one. After a backslash, `\token` may be a path segment or a tab and `oken`,
 *  so {@link maskSensitivePairs} tests such a key both ways. */
const KEY_SEPARATOR = new RegExp(String.raw`(?:(?<![A-Za-z0-9_.\\-])|(?<=\\)(?=[A-Za-z0-9_.-])(?![tnrbf]\\)|(?<=\\[tnrbf])(?=\\*["']))(\\*["']?[A-Za-z0-9_.-]+\\*["']?)${SPACE}*[:=]${SPACE}*`, 'g');
const VALUE_QUOTE = /["'`]/;
/** Header names whose whole value is a credential: `Authorization`, `Cookie`, `Set-Cookie`. */
const CREDENTIAL_HEADER_KEY = /authorization|cookie/i;
/** A credential header and its whole value (quoted, or the rest of the line), masked as `Name=***`. A value
 *  that is already a bare {@link MASK} ending a JSON field (a quoted value masked by an earlier pass, then `,`, a
 *  closing bracket or the end) is left alone, so the fields after it survive. Anything else after it,
 *  such as `; session=…` in a Cookie header, is still part of the header and is masked. A name right after
 *  `?` or `&` is a query parameter, which the query passes handle. A quoted value stays on its line, so an unterminated one never sends the match
 *  scanning to the end of the text. */
// eslint-disable-next-line no-control-regex
const CREDENTIAL_HEADER = new RegExp(
    String.raw`(?<![?&])(["']?(?:authorization|(?:set-)?cookie)["']?)${SPACE}*[:=]${SPACE}*(?!\u0000(?:[,)\]}]|$))("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|${'`'}(?:\\.|[^${'`'}\\\r\n])*${'`'}|\S+.*)`,
    'gi'
);
const NON_SPACE = /\S/;
/** A value an earlier pass already masked, left bare (`?token=*** ok`). Only {@link MASK} counts: a `***` in the
 *  input is text like any other (`password=*** PRIVATE` is a password holding spaces). */
// eslint-disable-next-line no-control-regex
const MASKED_VALUE = /\u0000(?=\s|$)/y;
/** What a pass writes in place of a value until the text is returned, where it becomes `***`. It is a control
 *  byte, which {@link stripTerminalCodes} removes from the input first, so no input can pose as a mask. */
const MASK = '\u0000';
// eslint-disable-next-line no-control-regex
const MASKS = /\u0000/g;

/** A JSON `\\u00XX` escape of a printable ASCII character, at any depth (with its whole backslash run). */
const PRINTABLE_ESCAPE = /(?<!\\)\\+u00([2-7][0-9a-f])/gi;
/** Quotes, which delimit strings: an escape of one becomes a backslash-escaped quote at the same depth. */
const QUOTE_CODES = new Set([0x22, 0x27, 0x60]);
const BACKSLASH_CODE = 0x5c;

/** A JSON-escaped `/`, with its whole backslash run. */
const SLASH_ESCAPE = /(?<!\\)\\+\//g;

/** Text with the JSON escapes of printable characters decoded, at any depth (`"to\\u006ben"` is `"token"`,
 *  `alice:pw\\u0040host` is `alice:pw@host`, `\\/\\/host` is `//host`), so a key, a URL or its delimiters spelled
 *  with them are still recognised. A backslash stays escaped and a quote becomes a backslash-escaped one
 *  ({@link quoteEscapeRun}), so a key quoted with `\\u0022` is found and no string's structure changes. */
function decodeNameEscapes(text: string): string {
    return text.replace(PRINTABLE_ESCAPE, (escape, code: string) => {
        const value = parseInt(code, 16);
        if (value === 0x7f || value === BACKSLASH_CODE) {
            return escape;
        }
        const char = String.fromCharCode(value);
        return QUOTE_CODES.has(value) ? '\\'.repeat(quoteEscapeRun(escape.indexOf('u'))) + char : char;
    })
        // JSON may escape `/` (`\/\/alice:pw@host\/x`), at any depth; only the backslashes before a `/` go.
        .replace(SLASH_ESCAPE, '/');
}

/** How many backslashes escape a quote that a `\\u00XX` escape after `run` backslashes spells: as many when
 *  `run` is odd (`\\u0022` is `\\"`, `\\\\\\u0022` is `\\\\\\"`), and when even one layer of escaping
 *  maps `run` to `run / 2`, so `\\\\u0022` is `\\\\\\"`. */
function quoteEscapeRun(run: number): number {
    return run % 2 === 1 ? run : 2 * quoteEscapeRun(run / 2) + 1;
}

/** Text with every {@link MASK} shown as `***`. */
function unmask(text: string): string {
    return text.replace(MASKS, '***');
}

/** How many backslashes escape the quote a value opens with, as inside a JSON string (`"password=\\"a b\\""`:
 *  1) or one serialised again (3, 7, …); 0 when it opens with none. */
function escapedQuoteRun(text: string, start: number): number {
    let run = 0;
    while (text[start + run] === '\\') {
        run++;
    }
    return run > 0 && VALUE_QUOTE.test(text[start + run] ?? '') ? run : 0;
}

/** Whether a value opens with a backslash-escaped quote ({@link escapedQuoteRun}). */
function isEscapedQuote(text: string, start: number): boolean {
    return escapedQuoteRun(text, start) > 0;
}

/** Where a value opened by an escaped quote ends: after the matching escaped quote. Without one it ends
 *  where the outermost enclosing string does, at an unescaped `"`, or at the end of the line, so its tail is
 *  masked too. A value opened by k backslashes and a quote is closed by a run of n backslashes before that
 *  quote when n % (2k + 2) === k: one layer of escaping maps n to (n - 1) / 2, so a run that unescapes to an
 *  escaped backslash before the quote does not close it (with k = 1, `\"` does, the interior `\\\"` does
 *  not). Each scan stops at the outermost string's end, which keeps a pass linear. */
function escapedValueEnd(text: string, start: number): number {
    const opening = escapedQuoteRun(text, start);
    const quote = text[start + opening];
    let i = start + opening + 1;
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
            if (run % (2 * opening + 2) === opening) {
                return i + run + 1;
            }
            i += run + 1;
        } else if (text[i + run] === '"' && run % 2 === 1) {
            // An escaped `"` inside a value opened by `\'` or a backtick, not the enclosing string's end.
            i += run + 1;
        } else {
            i += run;
        }
    }
    return i;
}

/** Where an unquoted secret ends: at the end of its line. A password may hold spaces, and words that look
 *  like further fields (`password=correct horse page=x`); free-form text cannot show where it stops, so
 *  everything after it on the line is masked with it. Trailing whitespace is left outside. */
function unquotedSecretEnd(text: string, start: number): number {
    let end = start;
    while (end < text.length && text[end] !== '\n' && text[end] !== '\r') {
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
                if (text[i] !== '\\') {
                    i++;
                    continue;
                }
                // As in valueEnd: before a `'` or backtick, any backslash run escapes it.
                let run = 1;
                if (c !== '"') {
                    while (text[i + run] === '\\') {
                        run++;
                    }
                }
                i += run + 1;
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
    // JSON escapes neither `'` nor a backtick but doubles the backslash before one (`'a\\'b'` becomes
    // `'a\\\\'b'`), so for these any backslash run before the quote escapes it: this fails toward hiding.
    const anyRunEscapes = quote !== '"';
    if ((unclosed.get(quote) ?? text.length) > start) {
        for (let i = start + 1; i < text.length; i++) {
            if (text[i] === '\\') {
                if (anyRunEscapes) {
                    while (text[i + 1] === '\\') {
                        i++;
                    }
                }
                i++;
            } else if (text[i] === quote) {
                return i + 1;
            }
        }
        unclosed.set(quote, start);
    }
    return text.length;
}

/** The run of name characters that ends just before the backslash run ending at `index` (`to` in `to\bken`). */
function nameRunBefore(text: string, index: number): string {
    let end = index;
    while (end > 0 && text[end - 1] === '\\') {
        end--;
    }
    let start = end;
    while (start > 0 && /[A-Za-z0-9_.-]/.test(text[start - 1])) {
        start--;
    }
    return text.slice(start, end);
}

/** A URL's host and port, right after `//` or after a userinfo's `@` (`https://keycloak.example:8443/mcp`),
 *  which a key pattern would read as the pair `keycloak.example: 8443`. Only a run of digits that ends the
 *  authority counts as a port, so a password (`//token:1234@host`) is no host. */
const URL_HOST_PORT = /(?<=\/\/(?:[^\s/@]*@)?)[A-Za-z0-9_.-]+:\d+(?=[/?#\s"'`)\]}>,]|$)/y;

/** Whether the key at `index` is a URL's host followed by its port ({@link URL_HOST_PORT}). */
function isUrlHostPort(text: string, index: number): boolean {
    if (text[index - 1] !== '/' && text[index - 1] !== '@') {
        return false;
    }
    URL_HOST_PORT.lastIndex = index;
    return URL_HOST_PORT.test(text);
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
        // An Authorization or Cookie value is a credential too, under any key naming one (`cookie_header`), masked
        // whole: a bare one to the end of its line, since a cookie list holds `name=value` pairs of its own.
        // is left to CREDENTIAL_HEADER, which takes the rest of its line.
        // A key right after a backslash that starts with `t`, `n`, `r`, `b` or `f` may follow an escape
        // (`\npass=…`): its name is then the rest, so both readings are tested. The escape may also sit inside
        // the name (`to\bken=…`, JSON's backspace), so the name run before the escape is joined to the rest too.
        const name = text[pair.index - 1] === '\\' && /^[tnrbf]/.test(pair[1])
            ? [pair[1], pair[1].slice(1), `${nameRunBefore(text, pair.index)}${pair[1].slice(1)}`]
            : [pair[1]];
        const header = name.some(key => CREDENTIAL_HEADER_KEY.test(key));
        const sensitive = header || name.some(key => SENSITIVE_KEY.test(key));
        if (!sensitive || (quotedOnly && !quoted) || isUrlHostPort(text, pair.index)) {
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
        const opening = escaped ? text.slice(start, start + escapedQuoteRun(text, start) + 1) : text[start];
        out += quotedOnly
            ? `${text.slice(copied, start)}${opening}***${opening}`
            : `${text.slice(copied, pair.index)}${pair[1]}=${MASK}`;
        copied = end;
        KEY_SEPARATOR.lastIndex = end;
    }
    return out + text.slice(copied);
}

/** A terminal control sequence: any CSI form (ECMA-48), with parameter bytes `0-?` (digits, `;`, `:`, `?`, …),
 *  intermediate bytes ` -/` and a final byte `@-~`, as in `ESC[31m`, `ESC[?25h` or `ESC[38:2:1:2:3m`, or opened
 *  by the single C1 byte CSI (U+009B); or a control string, OSC (`ESC]0;title`), DCS (`ESC P`), SOS (`ESC X`), PM
 *  (`ESC ^`) or APC (`ESC _`), or their C1 bytes (U+009D, U+0090, U+0098, U+009E, U+009F), whole up to BEL or ST
 *  (`ESC\\` or U+009C), so its text does not stay between a label and its value. A truncated one runs to the next
 *  ESC, BEL, ST or line
 *  break, so no sequence scans past another and stripping stays linear. The same sequences serialised, with
 *  ESC written as `\\u001b` or `\\x1b` (JSON on stderr: `"token\\u001b[0m=…"`), and the C1 bytes as `\\u00XX` or
 *  `\\xXX`, are stripped too; a serialised control string stops at the next backslash or quote, so it never runs past the end of its string. ESC serialised
 *  again (`\\\\u001b` in nested JSON) is matched with its whole backslash run, which goes with it, so no
 *  backslash is left escaping the next character, a closing quote included. A match starts only where a
 *  run does, which keeps a long run linear. */
// eslint-disable-next-line no-control-regex
const TERMINAL_CODE = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|(?:\u001b[\]PX^_]|[\u009d\u0090\u0098\u009e\u009f])[^\u0007\u001b\u009c\r\n]*(?:\u0007|\u001b\\|\u009c)?|(?<!\\)\\+(?:(?:u001b|x1b)\[|u009b|x9b)[0-?]*[ -/]*[@-~]|(?<!\\)\\+(?:(?:u001b|x1b)[\]PX^_]|u009d|x9d|u0090|x90|u0098|x98|u009e|x9e|u009f|x9f)[^\\"\r\n]*(?:\\+(?:u0007|x07|u009c|x9c)|\\+(?:u001b|x1b)\\+)?/gi;

/** A control byte other than a tab or a line ending (`NUL`, `BS`, `DEL`, a lone `ESC`, a C1 control), raw or serialised
 *  as `\\u0000` or `\\x00` at any depth, with its whole backslash run, as in {@link TERMINAL_CODE}. */
// eslint-disable-next-line no-control-regex
const CONTROL_BYTE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|(?<!\\)\\+(?:u00|x)(?:0[0-8bcef]|1[0-9a-f]|7f|[89][0-9a-f])/gi;

/** Text without terminal colour and other CSI codes, or any other control byte but tabs and line endings,
 *  which could sit between a label and its value (`token\u0000=…`). */
export function stripTerminalCodes(text: string): string {
    return stripCsiSequences(text).replace(TERMINAL_CODE, '').replace(CONTROL_BYTE, '');
}

/** The opener of a CSI sequence, raw or serialised with its whole backslash run, as in {@link TERMINAL_CODE}. */
const CSI_OPENER_SOURCE = String.raw`\u001b\[|\u009b|(?<!\\)\\+(?:(?:u001b|x1b)\[|u009b|x9b)`;
const NEXT_CSI_OPENER = new RegExp(CSI_OPENER_SOURCE, 'gi');
const CSI_OPENER_HERE = new RegExp(CSI_OPENER_SOURCE, 'iy');

/** Text without its complete CSI sequences, innermost first: an opener inside an unfinished sequence starts a
 *  nested one, and once that one ends the outer one goes on, so `to\e[\e[0m0mken` is `token` rather than
 *  `to[0mken` with the name hidden. A byte that fits no sequence ends every open one, which is dropped with
 *  its parameters, so `to\e[0\0ken` is `token` too; the byte stays.
 *  Linear: text outside a sequence is copied a stretch at a time, a byte inside one is copied once, and a
 *  sequence's bytes are dropped once. */
function stripCsiSequences(text: string): string {
    const out: string[] = [];
    const open: { at: number; intermediate: boolean }[] = [];
    let i = 0;
    while (i < text.length) {
        if (open.length === 0) {
            NEXT_CSI_OPENER.lastIndex = i;
            const next = NEXT_CSI_OPENER.exec(text);
            if (next === null) {
                break;
            }
            out.push(text.slice(i, next.index));
            i = next.index;
        }
        CSI_OPENER_HERE.lastIndex = i;
        const opener = CSI_OPENER_HERE.exec(text);
        if (opener !== null) {
            open.push({ at: out.length, intermediate: false });
            out.push(opener[0]);
            i = CSI_OPENER_HERE.lastIndex;
            continue;
        }
        const char = text[i++];
        out.push(char);
        const sequence = open[open.length - 1];
        if (!sequence.intermediate && char >= '0' && char <= '?') {
            continue;
        }
        if (char >= ' ' && char <= '/') {
            sequence.intermediate = true;
        } else if (char >= '@' && char <= '~') {
            out.length = sequence.at;
            open.pop();
        } else {
            out.length = open[0].at;
            out.push(char);
            open.length = 0;
        }
    }
    return out.join('') + text.slice(i);
}

const BEARER = new RegExp(String.raw`\b(bearer)${SPACE}+`, 'gi');
/** A Bearer token at a given position: quoted (to its closing quote or the end of its line) or bare. In a
 *  single-quoted one, any backslash run escapes the quote after it, as in {@link valueEnd}. A bare one may hold
 *  a JSON-escaped `/` (`prefix\\/suffix`), at any depth. */
const BEARER_TOKEN = /"(?:\\.|[^"\\\r\n])*"?|'(?:\\+[^\\\r\n]|\\+(?=[\r\n]|$)|[^'\\\r\n])*'?|`(?:\\+[^\\\r\n]|\\+(?=[\r\n]|$)|[^`\\\r\n])*`?|(?:[A-Za-z0-9._~+/-]|\\+\/)+=*/y;

/** Mask every Bearer token, of any length (a short one is still a credential), as `Bearer ***`. A token
 *  opened by an escaped quote, as in serialized error details (`"sent Bearer \\"a b\\""`), runs to its matching
 *  escaped quote, past escaped interior quotes, or without one to the end of the enclosing string or line.
 *  Linear: each pass consumes the token it measures. */
function maskBearerTokens(text: string): string {
    let out = '';
    let copied = 0;
    const unclosed = new Map<string, number>();
    BEARER.lastIndex = 0;
    for (let match = BEARER.exec(text); match !== null; match = BEARER.exec(text)) {
        const start = BEARER.lastIndex;
        let end = start;
        // A quoted token is measured like a quoted value (valueEnd): to its closing quote across lines, or with
        // none to the end of the text; one opened by an escaped quote to the end of its enclosing string.
        if (isEscapedQuote(text, start) || VALUE_QUOTE.test(text[start] ?? '')) {
            end = valueEnd(text, start, NON_SPACE, unclosed);
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
    return unmask(maskPlainSecrets(decodeNameEscapes(text.replace(MASKS, ''))));
}

/** {@link redactPlainSecrets}, leaving each value it masks as {@link MASK}. */
function maskPlainSecrets(text: string): string {
    return maskBearerTokens(maskSensitivePairs(text).replace(CREDENTIAL_HEADER, '$1=***'))
        // A quoted or escaped-quoted value (`Basic "dXNlcjpwYXNz"`, `Basic \\"…\\"` in JSON) is held to the same
        // base64 tests as a bare one below, to its closing quote or the end of its run.
        // A quoted or escaped-quoted value (`Basic "dXNlcjpwYXNz"`, `Basic \\"…\\"` in JSON) is held to the same
        // tests as a bare one, to its closing quote or the end of its run.
        .replace(QUOTED_BASIC, (match, word: string, _escape: string, _quote: string, value: string) =>
            isBasicCredential(value) ? `${word} ***` : match)
        .replace(BARE_BASIC, (match, word: string, value: string) => isBasicCredential(value) ? `${word} ***` : match);
}

/** Whether a value after `Basic` is a credential (see {@link BASE64_WHOLE}, {@link BASE64_ENCODED} and
 *  {@link decodesToPair}), so prose such as "basic usage" or "Basic Authentication" is left alone. */
function isBasicCredential(value: string): boolean {
    // JSON may escape `/` (`dXNlcjo\\/Pz8=`): the decoded token is judged, and the caller masks the whole span.
    const token = value.replace(/\\+\//g, '/');
    return BASE64_WHOLE.test(token) || BASE64_ENCODED.test(token) || decodesToPair(token);
}

/** Whether base64, padded or not and of any length, decodes to text holding a `:`, as a `user:password` pair
 *  does (`ejpzcmtkcw` is `z:srkds`, `OmE` is `:a`, `w6k6eA` is `é:x`), whatever its letters look like. The bytes
 *  must be valid UTF-8 with no control character, which leaves almost all prose alone. */
function decodesToPair(value: string): boolean {
    const bytes = Buffer.from(value, 'base64');
    if (!bytes.includes(0x3a)) {
        return false;
    }
    try {
        return !CONTROL_CHARACTER.test(UTF8.decode(bytes));
    } catch {
        return false;
    }
}

/** `Basic` and a quoted or escaped-quoted value: the word, then the value inside its quotes. */
const QUOTED_BASIC = new RegExp(String.raw`\b(basic)${SPACE}+(\\*)(["'${'`'}])((?:[A-Za-z0-9+/]|\\+\/)+=*)(?:\2\3)?(?![A-Za-z0-9+/=])`, 'gi');
/** `Basic` and a bare value. */
const BARE_BASIC = new RegExp(String.raw`\b(basic)${SPACE}+((?:[A-Za-z0-9+/]|\\+\/)+=*)(?![A-Za-z0-9+/=])`, 'gi');
/** A strict UTF-8 decoder: invalid bytes throw. */
const UTF8 = new TextDecoder('utf-8', { fatal: true });
/** A C0 or C1 control character, or DEL. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
/** Whole base64: 4-character groups with valid padding. Any length: `Basic YTo=` is still a credential. */
const BASE64_WHOLE = /^(?:(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/;
/** Unpadded or truncated base64 that looks encoded: eight or more characters holding a digit, `+`, `/` or a
 *  capital after the first (`Zm9vOmJhcg`). Case-sensitive on purpose, so "Authentication" is left alone. */
const BASE64_ENCODED = /^(?=[A-Za-z0-9+/]{8})(?=[A-Za-z0-9+/]*[0-9+/]|[A-Za-z0-9+/][A-Za-z0-9+/]*[A-Z])[A-Za-z0-9+/]+=*$/;

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
/** A `user:digits` right after `//` that reads as a host and port, followed by a space or tab. */
const PORT_THEN_SPACE = /[^\s/@:"'`<>]*:\d+[ \t]+/y;

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
        if ((at > 0 && !NETWORK_PATH_BOUNDARY.test(text[at - 1])) || at < copied) {
            continue;
        }
        NON_PORT_USERINFO.lastIndex = at + 2;
        if (!NON_PORT_USERINFO.test(text)) {
            // `//alice:123 PRIVATE/part@host`: a prefix that reads as a host and port, then a space. The run
            // from the first `/` after it to whitespace is still the password when it holds an `@`, as for
            // `https://` (maskUserinfo); `//host:8080 see /docs` holds none and keeps its text.
            PORT_THEN_SPACE.lastIndex = at + 2;
            if (!PORT_THEN_SPACE.test(text)) {
                continue;
            }
            // Neither scan crosses another reference's `//` (`//public:8080 then //alice:…`, `/docs,//alice:…`):
            // the outer loop takes that one up from there.
            const startsReference = (j: number) => text.startsWith('//', j) && NETWORK_PATH_BOUNDARY.test(text[j - 1]);
            let slash = PORT_THEN_SPACE.lastIndex;
            while (slash < text.length && text[slash] !== '/' && text[slash] !== '\n' && text[slash] !== '\r') {
                slash++;
            }
            if (startsReference(slash)) {
                from = slash;
                continue;
            }
            let runAt = -1;
            let k = slash;
            for (; text[slash] === '/' && k < text.length && !WHITESPACE.test(text[k]) && !(k > slash && startsReference(k)); k++) {
                runAt = text[k] === '@' ? k : runAt;
            }
            if (runAt !== -1) {
                out += `${text.slice(copied, at + 2)}***@`;
                copied = runAt + 1;
            }
            from = Math.max(from, runAt !== -1 ? runAt + 1 : k);
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
/** The `?name=` or `&name=` that opens a query pair anywhere in the text; {@link valueEnd} measures its value.
 *  A name may hold the tabs and line breaks a URL parser drops (`?to\nken=`). */
const QUERY_NAME = /([?&])((?:[^=&#?\s"'`<>]|[\t\r\n])*)=/g;
const QUERY_VALUE_STOP = /[&#\s]/;
/** A run of whitespace, raw or serialised ({@link SPACE}), possibly empty. */
const LEADING_SPACE = new RegExp(`${SPACE}*`, 'y');
const EMBEDDED_DELIMITER = /["'`<>]/;
/** What may follow a quote, backtick or angle bracket that closes the text around a query value. */
const VALUE_CLOSER = /[\s>"'`,;)\]}]/;

/** Where an unquoted sensitive query value ends: at `&`, `#` or whitespace other than a tab or line break,
 *  which a URL parser drops inside a URL (`?token=PREFIX\nSUFFIX` holds `PREFIXSUFFIX`), so the value runs
 *  across them; trailing ones are left outside. A quote, backtick or angle
 *  bracket ends it only where it closes the surrounding text (`href="…?token=abc">`), that is, when
 *  followed by whitespace, a closer or the end. So `to%6ben=abc"PRIVATE` is masked whole; over-matching
 *  hides more, never less. */
function sensitiveQueryValueEnd(text: string, start: number): number {
    let end = start;
    while (end < text.length && (!QUERY_VALUE_STOP.test(text[end]) || PARSER_IGNORED_CHAR.test(text[end]))) {
        if (EMBEDDED_DELIMITER.test(text[end]) && (end + 1 === text.length || VALUE_CLOSER.test(text[end + 1]))) {
            break;
        }
        end++;
    }
    // Breaks that end the text, or come right before a stop, belong to no value: leave the line boundary.
    while (end > start && PARSER_IGNORED_CHAR.test(text[end - 1])) {
        end--;
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
 *  and `https:alice:pw@host` all carry `alice:pw` as userinfo. It drops tabs and line breaks too, so they may
 *  sit in the run (`https:\nalice:pw@host`) and inside the scheme itself (`ht\ntps:alice:pw@host`). */
const SPECIAL_SCHEME = /(?<![a-z0-9+.-])(?:h[\t\r\n]*t[\t\r\n]*t[\t\r\n]*p(?:[\t\r\n]*s)?|w[\t\r\n]*s(?:[\t\r\n]*s)?|f[\t\r\n]*t[\t\r\n]*p)[\t\r\n]*:[/\\\t\r\n]*/gi;
const LINE_BREAK = /[\r\n]/g;
/** What ends an authority for a URL parser: `/`, `\`, `?`, `#`, or whitespace other than a tab or line break. */
const AUTHORITY_STOP = /[/\\?#]|[^\S\t\r\n]/g;
const BREAK = /[\t\r\n]/g;

/** Rewrite the separator of a special-scheme URL spelled other than `://` (`https:/`, `https:\\`, `https:`,
 *  `https:///`, `https:\n`) as `://` when its userinfo passes should see it as a parser would: an `@` follows on
 *  its line, or the authority, read across tabs and line breaks, holds an `@` with a break before it
 *  (`https:/alice:pw\nSUFFIX@host`, or a username alone: `https:ghp_PREFIX\nSUFFIX@host`). The redacted text
 *  shows the standard spelling, as {@link redactEndpoint} does. Linear: the next `@`, break and authority end
 *  are each found once per stretch. */
function normalizeSpecialSchemes(text: string): string {
    let out = '';
    let copied = 0;
    let nextAt = -1;
    let nextLineBreak = -1;
    let nextBreak = -1;
    let stop = -1;
    let lastAt = -1;

    /** Whether the authority from `end`, read across breaks, has an `@` with a break before it. Stop
     *  characters do not depend on where a scan starts, so a stretch is scanned once. */
    const userinfoAcrossBreaks = (end: number, colon: number): boolean => {
        if (stop < end) {
            AUTHORITY_STOP.lastIndex = end;
            stop = AUTHORITY_STOP.exec(text)?.index ?? text.length;
            lastAt = -1;
            for (let k = stop - 1; k >= end; k--) {
                if (text[k] === '@') {
                    lastAt = k;
                    break;
                }
            }
        }
        if (lastAt < end) {
            return false;
        }
        if (nextBreak < colon) {
            BREAK.lastIndex = colon;
            nextBreak = BREAK.exec(text)?.index ?? text.length;
        }
        return nextBreak < lastAt;
    };

    SPECIAL_SCHEME.lastIndex = 0;
    for (let match = SPECIAL_SCHEME.exec(text); match !== null; match = SPECIAL_SCHEME.exec(text)) {
        const end = SPECIAL_SCHEME.lastIndex;
        const colon = match.index + match[0].indexOf(':');
        if (text.slice(colon, end) === '://' || end >= text.length || WHITESPACE.test(text[end])) {
            continue;
        }
        if (nextAt < end) {
            nextAt = text.indexOf('@', end);
            nextAt = nextAt === -1 ? text.length : nextAt;
        }
        if (nextLineBreak < end) {
            LINE_BREAK.lastIndex = end;
            nextLineBreak = LINE_BREAK.exec(text)?.index ?? text.length;
        }
        if (nextAt >= nextLineBreak && !userinfoAcrossBreaks(end, colon)) {
            continue;
        }
        out += `${text.slice(copied, match.index)}${text.slice(match.index, colon).replace(PARSER_IGNORED, '')}://`;
        copied = end;
    }
    return out + text.slice(copied);
}

/** A tab or line break, which a URL parser drops anywhere in a URL. */
const PARSER_IGNORED = /[\t\r\n]/g;
const PARSER_IGNORED_CHAR = /[\t\r\n]/;
/** A tab or line break serialised (`\\t`, `\\n`, `\\r`, or `\\u0009`, `\\u000a`, `\\u000d`) at any depth, with its
 *  whole backslash run. */
const SERIALISED_BREAK = /(?<!\\)\\+(?:[tnr]|u000[9aAdD])/g;

/** Mask a URL userinfo that tabs or line breaks split, as a URL parser reads it: it drops them anywhere in a
 *  URL, so `https://ali\nce:pw@host` and `https://alice:123\nmore\npw@host` carry a password, and so does a
 *  network-path reference resolved against a base (`//ali\nce:pw@host`, a `//` at the start of the text or
 *  after {@link NETWORK_PATH_BOUNDARY}). The authority runs, across them, to the first `/`, `?`, `#` or other
 *  whitespace; its userinfo runs to the last `@` there and is masked as `***@`, a username alone too: a token
 *  may sit there (`https://ghp_PREFIX\nSUFFIX@github.com`), so `https://example.com\nbob@example.org`, which a
 *  parser reads as one URL, is masked as one. Linear: a scan stops at the next `/`, and the search for the next
 *  `//` resumes there. */
function maskBrokenUserinfo(text: string): string {
    let out = '';
    let copied = 0;
    for (let at = text.indexOf('//'); at !== -1; at = text.indexOf('//', at + 2)) {
        const scheme = text[at - 1] === ':' && schemeStart(text, at - 1) !== undefined;
        if (!scheme && at > 0 && !NETWORK_PATH_BOUNDARY.test(text[at - 1])) {
            continue;
        }
        const body = at + 2;
        let broken = false;
        let lastAt = -1;
        let k = body;
        for (; k < text.length; k++) {
            const c = text[k];
            if (c === '\t' || c === '\r' || c === '\n') {
                broken = true;
            } else if (c === '/' || c === '?' || c === '#' || WHITESPACE.test(c)) {
                break;
            } else if (c === '@') {
                lastAt = k;
            }
        }
        if (broken && lastAt !== -1 && body >= copied) {
            out += `${text.slice(copied, body)}***@`;
            copied = lastAt + 1;
        }
        at = Math.max(at, k - 2);
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
        // A username may hold whitespace too (`https://alice smith:pass@host`): with no `:` before the space, one
        // after it on the same stretch makes what follows a `user:password`, and the same run applies.
        let spacedAt = -1;
        if (i < text.length && slash === -1 && lastAt === -1) {
            const ambiguous = colonBeforeSlash && start !== undefined && !URL.canParse(text.slice(start, i));
            let colonSeen = colonBeforeSlash;
            let j = i;
            for (; j < text.length && text[j] !== '\r' && text[j] !== '\n'; j++) {
                if (!ambiguous && (text[j] === '/' || text.startsWith('://', j))) {
                    break;
                }
                colonSeen ||= text[j] === ':';
                spacedAt = text[j] === '@' && colonSeen ? j : spacedAt;
            }
            // `https://alice:123 PRIVATE/part@host`: the prefix parses as a host and port, so the scan above stopped
            // at the `/`. A run with no whitespace from there to an `@` is still the password: fail toward hiding.
            // A `:` with nothing after it before the space (`https://example.com: docs/a@b`) is prose punctuation.
            if (spacedAt === -1 && !ambiguous && colonBeforeSlash && text[j] === '/' && text[i - 1] !== ':') {
                for (let k = j; k < text.length && !WHITESPACE.test(text[k]) && !text.startsWith('://', k); k++) {
                    spacedAt = text[k] === '@' ? k : spacedAt;
                }
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
        // A URL inside serialised JSON ends at an escaped quote (`…/x\"}`): its backslashes escape the quote and
        // stay outside the URL, which a parser would otherwise turn into `/` and so unescape the quote.
        if (end < limit && VALUE_QUOTE.test(text[end])) {
            while (end > body && text[end - 1] === '\\') {
                end--;
            }
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
        // A URL parser drops tabs and line breaks before decoding: `to\tken` is `token`. Serialised, as
        // `to\\tken` in JSON at any depth, they are dropped too; a `\token` path segment is read both ways.
        return [name, name.replace(SERIALISED_BREAK, '')].some(candidate =>
            SENSITIVE_PARAM.test(decodeURIComponent(candidate.replace(PARSER_IGNORED, '').replace(/\+/g, ' '))));
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
    // The quote that opens the token a query name sits in (`"https://host/?token=…"` in JSON), and whether a `?`
    // comes before the name in that token, found by scanning back to whitespace or a quote. A scan stops where
    // the previous one started: the same token, same answer.
    let floor = 0;
    let floorToken: QueryToken = { opening: undefined, inQuery: false };
    const closeRuns = closeRunsOf(text);
    const tokenBefore = (index: number): QueryToken => {
        let inQuery = false;
        let token: QueryToken | undefined;
        for (let i = index - 1; i >= floor && token === undefined; i--) {
            if (WHITESPACE.test(text[i])) {
                token = { opening: undefined, inQuery };
            } else if (VALUE_QUOTE.test(text[i])) {
                let run = 0;
                while (text[i - 1 - run] === '\\') {
                    run++;
                }
                token = { opening: { quote: text[i], run }, inQuery };
            }
            inQuery ||= text[i] === '?';
        }
        token ??= { opening: floorToken.opening, inQuery: inQuery || floorToken.inQuery };
        floor = index;
        floorToken = token;
        return token;
    };
    QUERY_NAME.lastIndex = 0;
    for (let pair = QUERY_NAME.exec(text); pair !== null; pair = QUERY_NAME.exec(text)) {
        // An ordinary pair keeps its value, and scanning goes on inside it (`?q='public&token=x'`).
        if (!isSensitiveQueryName(pair[2])) {
            continue;
        }
        // `?token= value`: the value starts after any whitespace, a line break included, as in the plain-text pairs.
        // Serialised whitespace (`\t` in JSON) too, so a quoted value after it is still seen as quoted.
        LEADING_SPACE.lastIndex = QUERY_NAME.lastIndex;
        LEADING_SPACE.test(text);
        const start = LEADING_SPACE.lastIndex;
        // A quoted value, or an array or object (`?tokens=[ "a", "b" ]`), is measured whole by valueEnd.
        const quoted = isEscapedQuote(text, start) || VALUE_QUOTE.test(text[start] ?? '') || text[start] === '[' || text[start] === '{';
        // An unquoted value in a URL that a quote opens runs to that quote's close, a space included
        // (`{"url":"https://host/?token=PREFIX SUFFIX"}`); in a free-text query, a space ends it. An `&` pair
        // with no `?` before it in its token is no query (`/home/options&password=PREFIX SUFFIX/x`): its value
        // runs to the end of the line, as a plain-text secret's does.
        const token = quoted ? undefined : tokenBefore(pair.index);
        const end = token === undefined ? valueEnd(text, start, NON_SPACE, unclosed)
            : token.opening !== undefined ? quotedUrlValueEnd(text, start, token.opening, closeRuns)
                : pair[1] === '?' || token.inQuery ? sensitiveQueryValueEnd(text, start) : unquotedSecretEnd(text, start);
        out += `${text.slice(copied, pair.index)}${pair[1]}${pair[2]}=${MASK}`;
        copied = end;
        QUERY_NAME.lastIndex = end;
    }
    return out + text.slice(copied);
}

/** The quote that opens a quoted string, and the backslash run that escapes it (0 in plain JSON). */
interface QuoteOpening {
    quote: string;
    run: number;
}

/** What {@link maskQueryPairs} reads of the token a query name sits in: the quote that opens it, if any, and
 *  whether a `?` comes before the name in it. */
interface QueryToken {
    opening: QuoteOpening | undefined;
    inQuery: boolean;
}

/** Where an unquoted query value ends inside a quoted URL: at `&`, `#`, or the quote that closes the string,
 *  one escaped no deeper than the opening one, so an escaped interior quote is passed. A URL parser drops line
 *  breaks, so in a closed string the value runs across them to that close, `&` or `#`
 *  (`"https://host/?token=PREFIX\nSUFFIX&ok=1"`). With no close ahead the string gives no end, so the value
 *  ends as an unquoted one does ({@link sensitiveQueryValueEnd}), across breaks to `&`, `#` or a space.
 *  `closeRuns` says up front whether a close lies ahead, so a value without one is never searched for it. */
function quotedUrlValueEnd(text: string, start: number, opening: QuoteOpening, closeRuns: CloseRuns): number {
    if (closeRuns(opening.quote)[start] > opening.run) {
        return sensitiveQueryValueEnd(text, start);
    }
    let i = start;
    for (; i < text.length && text[i] !== '&' && text[i] !== '#'; i++) {
        if (text[i] !== opening.quote) {
            continue;
        }
        let run = 0;
        while (text[i - 1 - run] === '\\') {
            run++;
        }
        if (run <= opening.run) {
            return i - run;
        }
    }
    return i;
}

/** For a quote character, per position, the shortest backslash run before that quote anywhere from there on
 *  ({@link NO_CLOSE} with none): a value opened at depth k has a close ahead exactly when it is at most k. */
type CloseRuns = (quote: string) => Uint32Array;
const NO_CLOSE = 0xffffffff;

/** {@link CloseRuns} for `text`, each quote's table built once, in two linear passes, on first use. */
function closeRunsOf(text: string): CloseRuns {
    const tables = new Map<string, Uint32Array>();
    return quote => {
        const known = tables.get(quote);
        if (known !== undefined) {
            return known;
        }
        const runBefore = new Uint32Array(text.length + 1);
        for (let i = 0; i < text.length; i++) {
            runBefore[i + 1] = text[i] === '\\' ? runBefore[i] + 1 : 0;
        }
        const table = new Uint32Array(text.length + 1);
        table[text.length] = NO_CLOSE;
        for (let i = text.length - 1; i >= 0; i--) {
            table[i] = text[i] === quote ? Math.min(runBefore[i], table[i + 1]) : table[i + 1];
        }
        tables.set(quote, table);
        return table;
    };
}

/** Mask sensitive query values in an unparsable URL. */
function maskSensitiveQuery(url: string): string {
    return url.replace(URL_QUERY_PARAM, (param, separator: string, name: string) =>
        isSensitiveQueryName(name) ? `${separator}${name}=***` : param);
}

/** Redact a value that may be one whole endpoint (a label, a report's endpoint list), before and after the URL
 *  parser serialises it. Terminal codes go first: the URL parser would percent-encode one that splits a query name (`to\u001b[0mken` becomes `to%1B[0mken`), and redactText could no longer read
 *  the name. redactEndpoint then masks the URL as a parser reads it (line breaks dropped, a query value holding
 *  a space masked whole), and redactText covers what does not parse, which redactEndpoint leaves unchanged. */
export function redactEndpointText(value: string): string {
    // redactText runs on the raw text first too: the parser percent-encodes what marks a credential (the quotes
    // of `?config={"token":"PRIVATE"}` become `%22`), so its output alone would hide the credential from it.
    return redactText(redactEndpoint(redactText(stripTerminalCodes(value))));
}

/** Whether a value written right after `label` would be masked as a credential: the label ends where one
 *  starts (`Bearer`, `token=`, `Basic`). Probes are a plain value and a valid Basic credential, which a plain
 *  value would not pass for. A caller that joins the label to a value redacted on its own masks that value. */
export function endsAtCredential(label: string): boolean {
    return [`${label} x`, `${label} dXNlcjpwYXNz`].some(masksCredential);
}

/** Whether {@link redactText} masks something in `text`, rather than only normalising it (a terminal code
 *  dropped, an escape decoded, a scheme spelled `://`). */
function masksCredential(text: string): boolean {
    return redactText(text) !== normalizeForRedaction(text);
}

/** A URL authority that ends the text with a `:` and no `@` yet (`https://alice:PRIVATE/`): a userinfo whose
 *  password may go on in whatever is joined after it. */
const OPEN_USERINFO = /\/\/[^\s@/]*:[^\s@]*$/;
/** A URL authority that ends the text with no `@`, `:` or path yet (`https://ghp_PRIVATE`): a username alone,
 *  which a token may be, when what is joined after it opens with the rest of a userinfo ({@link USERINFO_HEAD}). */
const OPEN_AUTHORITY = /\/\/[^\s@/?#\\]*$/;
/** Text that opens with the rest of a userinfo: anything up to an `@`, before any `/`, `?`, `#` or whitespace. */
const USERINFO_HEAD = /^[^\s/?#\\]*@/;
/** What {@link joinBoundary} appends to close an open userinfo. */
const USERINFO_TAIL = 'x@h';

/** How to show `left` joined to a `right` that is redacted on its own, when a credential may span them. It
 *  spans them when `left` ends where a credential's value starts (`Bearer`, `token=`), or ends inside a URL
 *  userinfo (`https://alice:` or `https://alice:PREFIX/`, with `right` holding the rest up to `@`, or a username
 *  alone, `https://ghp_PREFIX`, when the raw `right` opens with `SUFFIX@`); probes with and without a display
 *  delimiter show which. Then `right` is to be masked whole, and `left` is cut at the first mask its probe
 *  shows (`https://***`). */
export function joinBoundary(left: string, right = ''): { left: string; maskRight: boolean } {
    // An open userinfo is checked first: an earlier credential (`token=OLD https://alice:PREFIX/`) would end
    // the search before it, and redacting the prefix alone cannot see the `@` it lacks. A special scheme spelled
    // without `//` (`https:alice:PREFIX/`) gets it from the `@` the probe adds, before a URL parser's dropped
    // tabs and line breaks (`https://alice:PREFIX\n` + `SUFFIX@host`) come out and could join it to a word.
    const userinfoProbe = normalizeSpecialSchemes(`${left}${USERINFO_TAIL}`).replace(PARSER_IGNORED, '');
    const authority = userinfoProbe.slice(0, -USERINFO_TAIL.length);
    const opensUserinfo = OPEN_USERINFO.test(authority)
        || (OPEN_AUTHORITY.test(authority) && USERINFO_HEAD.test(right.replace(PARSER_IGNORED, '')));
    if (opensUserinfo && masksCredential(userinfoProbe)) {
        return { left: upToFirstMask(redactText(userinfoProbe)), maskRight: true };
    }
    if (endsAtCredential(left)) {
        return { left, maskRight: true };
    }
    const probe = `${left} (x@h)`;
    if (!masksCredential(probe)) {
        return { left, maskRight: false };
    }
    const redacted = redactText(probe);
    return { left: redacted.startsWith(`${normalizeForRedaction(left)} `) ? left : upToFirstMask(redacted), maskRight: true };
}

/** Redacted text cut after its first `***`. */
function upToFirstMask(redacted: string): string {
    return redacted.slice(0, redacted.indexOf('***') + 3);
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
    const plain = normalizeForRedaction(text);
    const userinfoMasked = maskAmbiguousNetworkUserinfo(maskUserinfo(maskBrokenUserinfo(plain)).replace(NETWORK_PATH_USERINFO, '//***@'));
    const prepared = maskQueryPairs(maskSensitivePairs(userinfoMasked, true));
    let out = '';
    let copied = 0;
    for (const [start, end] of urlSpans(prepared)) {
        out += prepared.slice(copied, start) + redactUrl(prepared.slice(start, end)).replace(MASKED_QUERY_VALUE, `$1${MASK}`);
        copied = end;
    }
    return unmask(maskPlainSecrets(out + prepared.slice(copied)));
}

/** Text as {@link redactText} reads it before masking anything. */
function normalizeForRedaction(text: string): string {
    return normalizeSpecialSchemes(decodeNameEscapes(stripTerminalCodes(text)));
}

/** {@link redactText}, with every form a known `secret` can take in its output masked too: as given,
 *  JSON-serialised, and either one as redactText normalises it (an escape decoded, a terminal code dropped).
 *  The text is redacted first, so a secret that is also a credential's label (`token`) cannot hide that
 *  credential's value. The longest form goes first, so no shorter one leaves part of it. */
export function redactTextAndSecret(text: string, secret: string): string {
    const serialised = JSON.stringify(secret).slice(1, -1);
    const forms = [...new Set([secret, serialised, normalizeForRedaction(secret), normalizeForRedaction(serialised)])]
        .filter(form => form !== '')
        .sort((a, b) => b.length - a.length);
    return forms.reduce((redacted, form) => redacted.split(form).join('***'), redactText(text));
}

/** A sensitive query value {@link redactUrl} masked: a whole `***` value, which the URL span ends or `&` or `#`
 *  follows. The span ends at whitespace, so the value cannot go on past it. */
const MASKED_QUERY_VALUE = /([?&][^=&#?\s]*=)\*\*\*(?=[&#]|$)/g;

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
