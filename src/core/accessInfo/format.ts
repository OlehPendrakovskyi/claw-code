import { asString } from './util.js';
import { joinBoundary, redactEndpointText, redactText } from './redact.js';
import { isRecord, uniqSorted } from './util.js';
import type { AccessInfo, RedactedLabel } from './types.js';

/** Render a compact one-line access summary. */
export function formatAccessSummaryShort(info: AccessInfo, configError?: string, cliError?: string) {
    const parts: string[] = [];
    if (info.mcpServers.length > 0) {
        parts.push(`MCP: ${info.mcpServers.length}`);
    }
    if (info.tools.length > 0) {
        parts.push(`Tools: ${info.tools.length}`);
    }
    if (info.keySources.length > 0) {
        const keyTypes = summarizeKeySources(info.keySources);
        parts.push(`Keys: ${keyTypes}`);
    }
    if (parts.length === 0) {
        parts.push('Not generated yet');
    }
    if (configError) {
        parts.push('Config unavailable');
    }
    if (cliError) {
        parts.push('CLI error');
    }
    return parts.join(' | ');
}

/** Render a full Markdown access summary report with redacted errors, endpoints and CLI output. */
export function formatAccessSummaryMarkdown(
    info: AccessInfo,
    configError?: string,
    cliError?: string,
    cliOutput?: string,
    configPath?: string
) {
    const lines: string[] = [];
    lines.push('# OpenClaw access summary');
    lines.push(`Generated: ${new Date().toLocaleString()}`);
    lines.push('');

    if (configError) {
        lines.push(`Config issue: ${redactText(configError)}`);
        lines.push('');
    }
    if (cliError) {
        lines.push(`CLI issue: ${redactText(cliError)}`);
        lines.push('');
    }

    lines.push('## MCP servers');
    // MCP server and tool labels were redacted part by part when they were built (RedactedLabel); every other
    // list can carry endpoints or secrets and is rendered through redactText.
    lines.push(formatList(info.mcpServers, 'No MCP servers detected in config or CLI output.'));
    lines.push('');

    lines.push('## Tools');
    lines.push(formatList(info.tools, 'No tools detected in config.'));
    lines.push('');

    lines.push('## Keys and credentials');
    lines.push(
        formatList(
            info.keySources.map(redactText),
            'No key sources detected. If you use environment variables, they may not appear in config.'
        )
    );
    lines.push('');

    lines.push('## Network endpoints');
    lines.push(formatList(info.networkEndpoints.map(redactText), 'No network endpoints detected.'));
    lines.push('');

    lines.push('## Local files');
    // Key sources and paths come from config values (`{ env: 'X=…' }`, `{ file: '…/token=…' }`), so they are redacted too.
    const files = configPath ? uniqSorted([configPath, ...info.localFiles]) : info.localFiles;
    lines.push(formatList(files.map(redactText), 'No local files detected.'));
    lines.push('');

    if (info.notes.length > 0) {
        lines.push('## Notes');
        lines.push(formatList(info.notes, ''));
        lines.push('');
    }

    lines.push('## CLI status --all output');
    if (cliOutput) {
        lines.push('```');
        lines.push(redactText(cliOutput).trim());
        lines.push('```');
    } else {
        lines.push('No CLI output captured.');
    }

    return lines.join('\n');
}

/** Render a bulleted list, or the empty message when the list is empty. */
export function formatList(items: string[], emptyMessage: string) {
    if (items.length === 0) {
        return emptyMessage;
    }
    return items.map((item) => `- ${item}`).join('\n');
}

/** Pick the first string value among common identity fields, honouring the fallback name, as a
 *  {@link RedactedLabel}. */
export function formatNamedEntry(entry: unknown, fallbackName?: string): RedactedLabel | undefined {
    const label = namedEntryLabel(entry, fallbackName);
    // The one place a RedactedLabel is made: namedEntryLabel redacts every part it returns.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the brand's only constructor
    return label === undefined ? undefined : (label as RedactedLabel);
}

function namedEntryLabel(entry: unknown, fallbackName?: string): string | undefined {
    // Every label this returns reaches the UI (Overview, reports), so each part is redacted. A string entry
    // may be a whole endpoint: see redactEndpointText.
    // Names, ids and fallbacks (tool and MCP map keys) can be whole URLs too, so they are redacted as endpoints.
    // A fallback that redaction empties (a key of nothing but a terminal sequence) becomes `***`, so no caller
    // falls back to its raw key.
    const safeFallback = fallbackName === undefined ? undefined : redactEndpointText(fallbackName) || '***';
    // A part that redaction empties (a label of nothing but terminal codes) counts as absent, so the redacted
    // fallback, never a caller's raw key, takes its place.
    if (typeof entry === 'string') {
        return redactEndpointText(entry) || safeFallback;
    }
    if (!isRecord(entry)) {
        return safeFallback;
    }
    const rawName = asString(entry.name) ?? asString(entry.id);
    const name = (rawName !== undefined ? redactEndpointText(rawName) : undefined) || safeFallback;
    const rawEndpoint =
        asString(entry.url) ?? asString(entry.endpoint) ?? asString(entry.host);
    const endpoint = (rawEndpoint !== undefined ? redactEndpointText(rawEndpoint) : undefined) || undefined;
    if (name && endpoint) {
        // Each part was redacted alone, but a credential can be split across them (name `token=` or `Bearer`
        // and endpoint `PRIVATE`; name `https://alice:PREFIX/` and endpoint `SUFFIX@host`). joinBoundary says
        // when: the endpoint is then masked whole, and the name cut where the credential starts. The assembled
        // label is not redacted again: the parts' masks would be plain text to a second pass, which would cut a
        // masked endpoint's closing parenthesis.
        // The boundary is judged on the raw text the name came from: redaction may already have taken what marks
        // the credential (`Bearer "PREFIX` loses its quote), and the part shown is redacted afterwards.
        const rawLeft = rawName !== undefined && redactEndpointText(rawName) !== '' ? rawName : fallbackName;
        const boundary = joinBoundary(rawLeft ?? name, rawEndpoint);
        return boundary.maskRight ? `${redactEndpointText(boundary.left) || '***'} (***)` : `${name} (${endpoint})`;
    }
    return name ?? endpoint ?? safeFallback ?? '';
}

/** Categorize key sources into env / file / config buckets for compact display. */
export function summarizeKeySources(sources: string[]) {
    const categories = new Set<string>();
    for (const source of sources) {
        if (source.startsWith('Environment variable:')) {
            categories.add('env');
        } else if (source.startsWith('Key file:')) {
            categories.add('file');
        } else {
            categories.add('config');
        }
    }
    return categories.size > 0 ? [...categories].sort().join(', ') : 'none';
}