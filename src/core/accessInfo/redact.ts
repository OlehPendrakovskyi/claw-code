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

/** Redact plain-text credentials in free-form output (e.g. `token=abc`, `Authorization: Bearer ***`, `{"token":"abc"}`, `OPENAI_API_KEY=abc`) so non-URL secrets never reach a report verbatim. */
export function redactPlainSecrets(text: string): string {
    const sensitiveKey =
        /(["']?[A-Za-z0-9_.-]*(?:token|api[_-]?key|apikey|key|secret|password|passwd|credential|access[_-]?key|signature)[A-Za-z0-9_.-]*["']?)\s*[:=]\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\S+)/gi;
    return text
        .replace(sensitiveKey, '$1=***')
        .replace(/(["']?authorization["']?)\s*[:=]\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\S+.*)/gi, '$1=***')
        // Any length: a short Bearer token or `Basic YTo=` is still a credential. Basic is held to
        // base64 shape (whole 4-character groups, valid padding), so prose such as "basic usage" is left alone.
        .replace(/\b(bearer)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 ***')
        .replace(/\b(basic)\s+(?:(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)(?![A-Za-z0-9+/=])/gi, '$1 ***');
}

/** A URL of any scheme (`https://`, `wss://`, `ssh://`, `git+https://`, …) inside free-form text.
 *  A match ends where another `scheme://` begins, so adjacent URLs (`a,https://…`) are redacted one by one,
 *  and starts after any character that cannot be part of a scheme, `_` included (`endpoint_https://…`). */
const URL_IN_TEXT = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/(?:(?![a-z][a-z0-9+.-]*:\/\/)[^\s"'<>])+/gi;
/** A userinfo holding a quote or angle bracket, which would end {@link URL_IN_TEXT}'s match before the `@`
 *  (`https://alice:p"ass@host`): everything from the scheme to the last `@` before the first `/` or space.
 *  Without a path this can over-match into following text; that hides more, never less. */
const QUOTED_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)(?=[^\s/@]*["'<>])[^\s/]*@/gi;
/** Punctuation and closing brackets that end a sentence or a bracketed URL rather than belong to it. */
const TRAILING_DELIMITERS = /[)\]}.,;:!?]+$/;
/** The userinfo of a parsable URL, `scheme://user:pass@`, matched without parsing: up to the last `@`
 *  before the first `/`, since a raw `@`, `?` or `#` may appear inside a password. This can over-match a
 *  URL with no path and an `@` in its query; that hides more, never less. */
const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/\s]*@/i;
/** The userinfo of an unparsable URL, whose authority has no knowable end (a password may hold `/`):
 *  everything up to the last `@`. An `@` in the path or query over-matches; that hides more, never less. */
const UNPARSED_URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)\S*@/i;
/** One `name=value` query parameter, matched without parsing. */
const URL_QUERY_PARAM = /([?&])([^=&#\s]*)=([^&#\s]*)/g;

/** Mask sensitive query values in an unparsable URL. Names are percent-decoded first (`to%6ben` is
 *  `token`); a name that does not decode is treated as sensitive, so this fails toward hiding. */
function maskSensitiveQuery(url: string): string {
    return url.replace(URL_QUERY_PARAM, (param, separator: string, name: string) => {
        let decoded: string;
        try {
            decoded = decodeURIComponent(name.replace(/\+/g, ' '));
        } catch {
            return `${separator}${name}=***`;
        }
        return SENSITIVE_PARAM.test(decoded) ? `${separator}${name}=***` : param;
    });
}

/** Redact credentials anywhere in free-form text: URL userinfo and sensitive query params first
 *  ({@link redactEndpoint}), then plain-text forms such as `token=…` and `Bearer …`
 *  ({@link redactPlainSecrets}). Use it for anything that leaves the process: logs, UI, reports. */
export function redactText(text: string): string {
    // 0. A quote or angle bracket in the userinfo would cut the URL short of its `@`: mask it first.
    return redactPlainSecrets(text.replace(QUOTED_USERINFO, '$1***@').replace(URL_IN_TEXT, match => {
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
    }));
}
