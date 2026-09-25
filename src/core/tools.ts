import { isRecord, asString, formatNamedEntry } from './accessInfo';
import { loadOpenClawConfigRecord } from './configIO';

export type ToolEntry = {
    id: string;
    label: string;
    enabled: boolean;
    path: Array<string | number>;
    source: string;
    description?: string;
};

export function getToolEnabled(entry: unknown) {
    if (isRecord(entry) && typeof entry.enabled === 'boolean') {
        return entry.enabled;
    }
    return true;
}

export function getToolDescription(entry: unknown) {
    if (!isRecord(entry)) {
        return undefined;
    }
    return (
        asString(entry.description) ??
        asString(entry.summary) ??
        asString(entry.purpose) ??
        asString(entry.details)
    );
}

export function collectToolEntries(config: Record<string, unknown>): ToolEntry[] {
    const entries: ToolEntry[] = [];
    const sources: Array<{
        source: string;
        basePath: Array<string | number>;
        value: unknown;
    }> = [
        { source: 'tools', basePath: ['tools'], value: config.tools },
        {
            source: 'mcp.tools',
            basePath: ['mcp', 'tools'],
            value: isRecord(config.mcp) ? config.mcp.tools : undefined
        },
        {
            source: 'capabilities.tools',
            basePath: ['capabilities', 'tools'],
            value: isRecord(config.capabilities) ? config.capabilities.tools : undefined
        }
    ];

    for (const source of sources) {
        if (Array.isArray(source.value)) {
            source.value.forEach((entry, index) => {
                const label = formatNamedEntry(entry) || `Tool ${index + 1}`;
                entries.push({
                    id: `${source.source}:${source.basePath.join('.')}:${index}`,
                    label,
                    enabled: getToolEnabled(entry),
                    description: getToolDescription(entry),
                    path: [...source.basePath, index],
                    source: source.source
                });
            });
        } else if (isRecord(source.value)) {
            for (const [name, entry] of Object.entries(source.value)) {
                const label = formatNamedEntry(entry, name) || name;
                entries.push({
                    id: `${source.source}:${source.basePath.join('.')}:${name}`,
                    label,
                    enabled: getToolEnabled(entry),
                    description: getToolDescription(entry),
                    path: [...source.basePath, name],
                    source: source.source
                });
            }
        }
    }

    return entries.sort((a, b) => a.label.localeCompare(b.label));
}

export async function loadToolsForOverview(): Promise<{ entries: ToolEntry[]; error?: string }> {
    const { config, error } = await loadOpenClawConfigRecord();
    if (!config) {
        return { entries: [], error };
    }
    return { entries: collectToolEntries(config), error };
}

/**
 * Reads the raw tool entry stored under `key` inside an already resolved parent
 * container (object or array).
 */
export function readEntryAtPath(
    parent: Record<string, unknown> | unknown[],
    key: string | number
): unknown {
    if (Array.isArray(parent) && typeof key === 'number') {
        return parent[key];
    }
    if (isRecord(parent) && typeof key === 'string') {
        return parent[key];
    }
    return undefined;
}

export type ToggleToolResult =
    | { ok: true; nextEntry: unknown; enabled: boolean }
    | { ok: false; reason: 'missing' | 'unsupported' };

/**
 * Computes the next stored value for a tool entry when it is toggled.
 * Returns the new enabled state so the caller can report it to the user.
 */
export function computeToolToggle(current: unknown): ToggleToolResult {
    if (typeof current === 'undefined') {
        return { ok: false, reason: 'missing' };
    }
    const currentlyEnabled = getToolEnabled(current);
    const nextEnabled = !currentlyEnabled;
    let nextEntry = current;

    if (typeof current === 'string') {
        if (!nextEnabled) {
            nextEntry = { name: current, enabled: false };
        }
    } else if (isRecord(current) && !Array.isArray(current)) {
        nextEntry = { ...current, enabled: nextEnabled };
    } else {
        return { ok: false, reason: 'unsupported' };
    }

    return { ok: true, nextEntry, enabled: nextEnabled };
}

export { extractMcpServers, extractTools } from './accessInfo';
export type { AccessInfo } from './accessInfo';
