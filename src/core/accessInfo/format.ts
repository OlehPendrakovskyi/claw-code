import { asString } from './util.js';
import { endsAtCredential, redactEndpoint, redactText, stripTerminalCodes } from './redact.js';
import { isRecord, uniqSorted } from './util.js';
import type { AccessInfo } from './types.js';

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
    // Labels can carry endpoints or secrets; every list that can is rendered through redactText.
    lines.push(formatList(info.mcpServers.map(redactText), 'No MCP servers detected in config or CLI output.'));
    lines.push('');

    lines.push('## Tools');
    lines.push(formatList(info.tools.map(redactText), 'No tools detected in config.'));
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

/** Pick the first string value among common identity fields, honouring the fallback name. */
export function formatNamedEntry(entry: unknown, fallbackName?: string) {
    // Every label this returns reaches the UI (Overview, reports), so each part is redacted. A string entry
    // may be a whole endpoint: see redactEndpointLabel.
    const safeFallback = fallbackName === undefined ? undefined : redactText(fallbackName);
    if (typeof entry === 'string') {
        return redactEndpointLabel(entry);
    }
    if (!isRecord(entry)) {
        return safeFallback;
    }
    const rawName = asString(entry.name) ?? asString(entry.id);
    const name = rawName !== undefined ? redactText(rawName) : safeFallback;
    const rawEndpoint =
        asString(entry.url) ?? asString(entry.endpoint) ?? asString(entry.host);
    const endpoint = rawEndpoint !== undefined ? redactEndpointLabel(rawEndpoint) : undefined;
    if (name && endpoint) {
        // Each part was redacted alone, but a credential can be split across them (name `token=`, endpoint
        // `PRIVATE`, or name `Bearer`). When the name ends where a credential's value starts, the endpoint is
        // that value and is masked whole.
        return endsAtCredential(name) ? `${name} (***)` : `${name} (${endpoint})`;
    }
    return name ?? endpoint ?? safeFallback ?? '';
}

/** Redact a value that may be one whole endpoint, before and after the URL parser serialises it. Terminal codes go first: the URL parser would percent-encode
 *  one that splits a query name (`to\u001b[0mken` becomes `to%1B[0mken`), and redactText could no longer read
 *  the name. redactEndpoint then masks the URL as a parser reads it (line breaks dropped, a query value holding
 *  a space masked whole), and redactText covers what does not parse, which redactEndpoint leaves unchanged. */
function redactEndpointLabel(value: string): string {
    // redactText runs on the raw text first too: the parser percent-encodes what marks a credential (the quotes
    // of `?config={"token":"PRIVATE"}` become `%22`), so its output alone would hide the credential from it.
    return redactText(redactEndpoint(redactText(stripTerminalCodes(value))));
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