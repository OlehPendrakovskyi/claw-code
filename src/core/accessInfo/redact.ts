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
        /(["']?[A-Za-z0-9_.-]*(?:token|api[_-]?key|apikey|secret|password|passwd|credential|access[_-]?key)[A-Za-z0-9_.-]*["']?)\s*[:=]\s*("[^"]*"|'[^']*'|`[^`]*`|\S+)/gi;
    return text
        .replace(sensitiveKey, '$1=***')
        .replace(/(["']?authorization["']?)\s*[:=]\s*("[^"]*"|'[^']*'|`[^`]*`|\S+.*)/gi, '$1=***')
        .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***');
}

/** A URL of any scheme (`https://`, `wss://`, `ssh://`, `git+https://`, …) inside free-form text. */
const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
/** Punctuation and closing brackets that end a sentence or a bracketed URL rather than belong to it. */
const TRAILING_DELIMITERS = /[)\]}.,;:!?]+$/;
/** The userinfo of a URL, `scheme://user:pass@`, matched without parsing. */
const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]+@/i;
/** A query parameter whose name matches SENSITIVE_PARAM, matched without parsing. */
const URL_SENSITIVE_QUERY = new RegExp(`([?&][^=&#\\s]*${SENSITIVE_PARAM.source}[^=&#\\s]*=)[^&#\\s]*`, 'gi');

/** Redact credentials anywhere in free-form text: URL userinfo and sensitive query params first
 *  ({@link redactEndpoint}), then plain-text forms such as `token=…` and `Bearer …`
 *  ({@link redactPlainSecrets}). Use it for anything that leaves the process: logs, UI, reports. */
export function redactText(text: string): string {
    return redactPlainSecrets(text.replace(URL_IN_TEXT, match => {
        // Prose around a URL ends it with `]`, `)`, `.` and the like, which would make it unparsable.
        const url = match.replace(TRAILING_DELIMITERS, '');
        const redacted = redactEndpoint(url);
        // An unparsable URL comes back unchanged: still mask its `user:pass@` and sensitive query
        // values without parsing, so this fails toward hiding.
        const safe = redacted === url ? url.replace(URL_USERINFO, '$1***@').replace(URL_SENSITIVE_QUERY, '$1***') : redacted;
        return safe + match.slice(url.length);
    }));
}
