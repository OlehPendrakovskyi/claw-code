import { compact, get, isString, map, sortBy, uniq } from 'lodash-es';

export type AccessSummary = {
    short: string;
    markdown: string;
    generatedAt: Date;
};

export type AccessInfo = {
    mcpServers: string[];
    tools: string[];
    keySources: string[];
    networkEndpoints: string[];
    localFiles: string[];
    notes: string[];
};

/** De-duplicate strings, drop blank entries and return the result sorted. */
function uniqSorted(items: string[]): string[] {
    return sortBy(uniq(items.filter((item) => item && item.trim().length > 0)));
}

/** Extract access-relevant details (servers, tools, keys, endpoints, files) from a config object. */
export function extractAccessInfoFromConfig(config: unknown, configPath: string): AccessInfo {
    const info = createEmptyAccessInfo();
    info.localFiles.push(configPath);

    if (!isRecord(config)) {
        return info;
    }

    info.mcpServers = extractMcpServers(config);
    info.tools = extractTools(config);

    const keySources = new Set<string>();
    const localFiles = new Set<string>(info.localFiles);
    const endpoints = new Set<string>();
    const notes = new Set<string>();


    scanAccessInfo(config, [], keySources, localFiles, endpoints, notes);

    info.keySources = uniqSorted([...keySources]);
    info.localFiles = uniqSorted([...localFiles]);
    info.networkEndpoints = uniqSorted([...endpoints]);
    info.notes = uniqSorted([...notes]);

    return info;
}

export function extractAccessInfoFromCli(output?: string): AccessInfo {
    const info = createEmptyAccessInfo();
    if (!output) {
        return info;
    }
    const urls = output.match(/https?:\/\/\S+/g) ?? [];
    info.networkEndpoints = uniqSorted(map(urls, redactEndpoint));
    return info;
}

export function mergeAccessInfo(base: AccessInfo, extra: AccessInfo): AccessInfo {
    return {
        mcpServers: uniqSorted([...base.mcpServers, ...extra.mcpServers]),
        tools: uniqSorted([...base.tools, ...extra.tools]),
        keySources: uniqSorted([...base.keySources, ...extra.keySources]),
        networkEndpoints: uniqSorted([...base.networkEndpoints, ...extra.networkEndpoints]),
        localFiles: uniqSorted([...base.localFiles, ...extra.localFiles]),
        notes: uniqSorted([...base.notes, ...extra.notes])
    };
}

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

export function formatList(items: string[], emptyMessage: string) {
    if (items.length === 0) {
        return emptyMessage;
    }
    return items.map((item) => `- ${item}`).join('\n');
}

export function createEmptyAccessInfo(): AccessInfo {
    return {
        mcpServers: [],
        tools: [],
        keySources: [],
        networkEndpoints: [],
        localFiles: [],
        notes: []
    };
}

export function extractMcpServers(config: Record<string, unknown>): string[] {
    const results = new Set<string>();
    const addLabels = (entries: unknown[]) => {
        for (const label of compact(map(entries, (entry) => formatNamedEntry(entry)))) {
            results.add(label);
        }
    };
    const mcp = get(config, 'mcp');
    if (Array.isArray(mcp)) {
        addLabels(mcp);
    }
    if (isRecord(mcp)) {
        const servers = get(mcp, 'servers');
        if (Array.isArray(servers)) {
            addLabels(servers);
        } else if (isRecord(servers)) {
            for (const [name, entry] of Object.entries(servers)) {
                const label = formatNamedEntry(entry, name);
                if (label) {
                    results.add(label);
                }
            }
        }
    }
    const mcpServers = get(config, 'mcpServers');
    if (Array.isArray(mcpServers)) {
        addLabels(mcpServers);
    }
    return uniqSorted([...results]);
}

export function extractTools(config: Record<string, unknown>): string[] {
    const results = new Set<string>();
    const addLabels = (entries: unknown[]) => {
        for (const label of compact(map(entries, (entry) => formatNamedEntry(entry)))) {
            results.add(label);
        }
    };
    const sources = [get(config, 'tools')];
    if (isRecord(config.mcp)) {
        sources.push(get(config.mcp, 'tools'));
    }
    if (isRecord(config.capabilities)) {
        sources.push(get(config.capabilities, 'tools'));
    }

    for (const source of sources) {
        if (Array.isArray(source)) {
            addLabels(source);
        } else if (isRecord(source)) {
            for (const [name, entry] of Object.entries(source)) {
                const label = formatNamedEntry(entry, name);
                if (label) {
                    results.add(label);
                }
            }
        }
    }

    return uniqSorted([...results]);
}

/** Redact userinfo and sensitive query params from an endpoint URL for display. */
export function redactEndpoint(endpoint: string): string {
    const sensitiveParam = /(api_?key|api-key|key|token|password|secret|credential|access_key|signature)/i;
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
            if (sensitiveParam.test(key)) {
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

/** Pick the first string value among common identity fields, honouring the fallback name. */
export function formatNamedEntry(entry: unknown, fallbackName?: string) {
    if (typeof entry === 'string') {
        return redactEndpoint(entry);
    }
    if (!isRecord(entry)) {
        return fallbackName;
    }
    const name = (isString(entry.name) ? entry.name : undefined) ?? (isString(entry.id) ? entry.id : undefined) ?? fallbackName;
    const rawEndpoint =
        (isString(entry.url) ? entry.url : undefined) ??
        (isString(entry.endpoint) ? entry.endpoint : undefined) ??
        (isString(entry.host) ? entry.host : undefined);
    const endpoint = rawEndpoint !== undefined ? redactEndpoint(rawEndpoint) : undefined;
    if (name && endpoint) {
        return `${name} (${endpoint})`;
    }
    return name ?? endpoint ?? fallbackName ?? '';
}

export function scanAccessInfo(
    value: unknown,
    pathSegments: string[],
    keySources: Set<string>,
    localFiles: Set<string>,
    endpoints: Set<string>,
    notes: Set<string>,
    depth = 0
) {
    if (depth > 8) {
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((entry, index) =>
            scanAccessInfo(entry, [...pathSegments, String(index)], keySources, localFiles, endpoints, notes, depth + 1)
        );
        return;
    }
    if (isRecord(value)) {
        for (const [key, entry] of Object.entries(value)) {
            if (isKeyIndicator(key) && isRecord(entry)) {
                const envVar = getEnvVarFromRecord(entry);
                if (envVar) {
                    keySources.add(`Environment variable: ${envVar}`);
                }
                const filePath = getFilePathFromRecord(entry);
                if (filePath) {
                    keySources.add(`Key file: ${filePath}`);
                    localFiles.add(filePath);
                }
            }
            scanAccessInfo(entry, [...pathSegments, key], keySources, localFiles, endpoints, notes, depth + 1);
        }
        return;
    }
    if (typeof value === 'string') {
        if (isUrl(value)) {
            endpoints.add(redactEndpoint(value));
        } else if (looksLikePath(value)) {
            localFiles.add(value);
        }
        if (pathSegments.some(isKeyIndicator)) {
            const envVar = extractEnvVarName(value);
            if (envVar) {
                keySources.add(`Environment variable: ${envVar}`);
                return;
            }
            if (looksLikePath(value)) {
                keySources.add(`Key file: ${value}`);
                return;
            }
            const pathLabel = pathSegments.join('.');
            keySources.add(`Config value: ${pathLabel}`);
        }
    }
}

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

/** Read the environment-variable name from a key entry record (`env`, `envVar` or `environment`). */
export function getEnvVarFromRecord(entry: Record<string, unknown>) {
    const envValue = get(entry, 'env') ?? get(entry, 'envVar') ?? get(entry, 'environment');
    return isString(envValue) ? envValue : undefined;
}

/** Read a plausible filesystem path from a key entry record (`path`, `file` or `filePath`). */
export function getFilePathFromRecord(entry: Record<string, unknown>) {
    const fileValue = get(entry, 'path') ?? get(entry, 'file') ?? get(entry, 'filePath');
    if (isString(fileValue) && looksLikePath(fileValue)) {
        return fileValue;
    }
    return undefined;
}

export function extractEnvVarName(value: string) {
    const match =
        value.match(/\$\{([A-Z0-9_]+)\}/) ||
        value.match(/\$([A-Z0-9_]+)/) ||
        value.match(/env:([A-Z0-9_]+)/i) ||
        value.match(/ENV:([A-Z0-9_]+)/);
    return match ? match[1] : undefined;
}

export function isKeyIndicator(segment: string) {
    return /(key|token|secret|apikey|api_key|password|credential)/i.test(segment);
}

export function isUrl(value: string) {
    return /^https?:\/\//i.test(value);
}

export function looksLikePath(value: string) {
    return /[\\/]/.test(value) && !isUrl(value);
}

/** Check that a value is a non-null object (arrays included, by design). */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** Resolve a string value from `value`, returning undefined for anything else. */
export function asString(value: unknown): string | undefined {
    return isString(value) ? value : undefined;
}
