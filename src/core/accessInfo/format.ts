import { asString } from './util.js';
import { redactEndpoint, redactPlainSecrets } from './redact.js';
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
        lines.push(`Config issue: ${redactPlainSecrets(configError.replace(/https?:\/\/\S+/g, (m) => redactEndpoint(m)))}`);
        lines.push('');
    }
    if (cliError) {
        lines.push(`CLI issue: ${redactPlainSecrets(cliError.replace(/https?:\/\/\S+/g, (m) => redactEndpoint(m)))}`);
        lines.push('');
    }

    lines.push('## MCP servers');
    lines.push(formatList(info.mcpServers, 'No MCP servers detected in config or CLI output.'));
    lines.push('');

    lines.push('## Tools');
    lines.push(formatList(info.tools, 'No tools detected in config.'));
    lines.push('');

    lines.push('## Keys and credentials');
    lines.push(
        formatList(
            info.keySources,
            'No key sources detected. If you use environment variables, they may not appear in config.'
        )
    );
    lines.push('');

    lines.push('## Network endpoints');
    lines.push(formatList(info.networkEndpoints, 'No network endpoints detected.'));
    lines.push('');

    lines.push('## Local files');
    const files = configPath ? uniqSorted([configPath, ...info.localFiles]) : info.localFiles;
    lines.push(formatList(files, 'No local files detected.'));
    lines.push('');

    if (info.notes.length > 0) {
        lines.push('## Notes');
        lines.push(formatList(info.notes, ''));
        lines.push('');
    }

    lines.push('## CLI status --all output');
    if (cliOutput) {
        lines.push('```');
        lines.push(redactPlainSecrets(cliOutput.replace(/https?:\/\/\S+/g, (m) => redactEndpoint(m))).trim());
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
    if (typeof entry === 'string') {
        return redactEndpoint(entry);
    }
    if (!isRecord(entry)) {
        return fallbackName;
    }
    const name = asString(entry.name) ?? asString(entry.id) ?? fallbackName;
    const rawEndpoint =
        asString(entry.url) ?? asString(entry.endpoint) ?? asString(entry.host);
    const endpoint = rawEndpoint !== undefined ? redactEndpoint(rawEndpoint) : undefined;
    if (name && endpoint) {
        return `${name} (${endpoint})`;
    }
    return name ?? endpoint ?? fallbackName ?? '';
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