import { compact, get, map } from 'lodash-es';
import { redactEndpointText } from './redact.js';
import { formatNamedEntry } from './format.js';
import {
    createEmptyAccessInfo,
    getEnvVarFromRecord,
    getFilePathFromRecord,
    isKeyIndicator,
    isRecord,
    isUrl,
    looksLikePath,
    extractEnvVarName,
    uniqSorted
} from './util.js';
import type { AccessInfo } from './types.js';

/** Add a label per entry to `results`, skipping entries without a formattable label. */
function addEntryLabels(results: Set<string>, entries: unknown[]) {
    for (const label of compact(map(entries, (entry) => formatNamedEntry(entry)))) {
        results.add(label);
    }
}

/** Add a `name (endpoint)` label per named record entry to `results`. */
function addRecordLabels(results: Set<string>, entries: Record<string, unknown>) {
    for (const [name, entry] of Object.entries(entries)) {
        const label = formatNamedEntry(entry, name);
        if (label) {
            results.add(label);
        }
    }
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

/** Extract network endpoints from CLI output, redacting credentials. */
export function extractAccessInfoFromCli(output?: string): AccessInfo {
    const info = createEmptyAccessInfo();
    if (!output) {
        return info;
    }
    const urls = output.match(/https?:\/\/\S+/g) ?? [];
    info.networkEndpoints = uniqSorted(map(urls, redactEndpointText));
    return info;
}

/** Merge two AccessInfo objects, de-duplicating all collections. */
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

/** Collect MCP server labels from the common config layouts (`mcp`, `mcp.servers`, `mcpServers`). */
export function extractMcpServers(config: Record<string, unknown>): string[] {
    const results = new Set<string>();
    const mcp = get(config, 'mcp');
    if (Array.isArray(mcp)) {
        addEntryLabels(results, mcp);
    }
    if (isRecord(mcp)) {
        const servers = get(mcp, 'servers');
        if (Array.isArray(servers)) {
            addEntryLabels(results, servers);
        } else if (isRecord(servers)) {
            addRecordLabels(results, servers);
        }
    }
    const mcpServers = get(config, 'mcpServers');
    if (Array.isArray(mcpServers)) {
        addEntryLabels(results, mcpServers);
    }
    return uniqSorted([...results]);
}

/** Collect tool labels from `tools`, `mcp.tools` and `capabilities.tools` config sections. */
export function extractTools(config: Record<string, unknown>): string[] {
    const results = new Set<string>();
    const sources = [get(config, 'tools')];
    if (isRecord(config.mcp)) {
        sources.push(get(config.mcp, 'tools'));
    }
    if (isRecord(config.capabilities)) {
        sources.push(get(config.capabilities, 'tools'));
    }

    for (const source of sources) {
        if (Array.isArray(source)) {
            addEntryLabels(results, source);
        } else if (isRecord(source)) {
            addRecordLabels(results, source);
        }
    }

    return uniqSorted([...results]);
}

/** Recursively scan a config value for key sources, local files, endpoints and notes. */
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
            endpoints.add(redactEndpointText(value));
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
