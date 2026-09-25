import { sortBy, uniq } from 'lodash-es';
import type { AccessInfo } from './types.js';

/** Check that a value is a non-null object (arrays included, by design). */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/** Resolve a string value from `value`, returning undefined for anything else. */
export function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

/** Detect http(s) URLs. */
export function isUrl(value: string) {
    return /^https?:\/\//i.test(value);
}

/** Detect values that look like filesystem paths rather than URLs. */
export function looksLikePath(value: string) {
    return /[\\/]/.test(value) && !isUrl(value);
}

/** Detect config keys or path segments that indicate credentials. */
export function isKeyIndicator(segment: string) {
    return /(key|token|secret|apikey|api_key|password|credential)/i.test(segment);
}

/** Extract the environment-variable name referenced by a string value, if any. */
export function extractEnvVarName(value: string) {
    const match =
        value.match(/\$\{([A-Z0-9_]+)\}/) ||
        value.match(/\$([A-Z0-9_]+)/) ||
        value.match(/env:([A-Z0-9_]+)/i) ||
        value.match(/ENV:([A-Z0-9_]+)/);
    return match ? match[1] : undefined;
}

/** Read the environment-variable name from a key entry record (`env`, `envVar` or `environment`); non-string and empty values are skipped and the chain continues. */
export function getEnvVarFromRecord(entry: Record<string, unknown>) {
    for (const candidate of [entry.env, entry.envVar, entry.environment]) {
        const value = asString(candidate);
        if (value) {
            return value;
        }
    }
    return undefined;
}

/** Read a plausible filesystem path from a key entry record (`path`, `file` or `filePath`); non-string values are skipped and the chain continues. */
export function getFilePathFromRecord(entry: Record<string, unknown>) {
    const fileValue = asString(entry.path) ?? asString(entry.file) ?? asString(entry.filePath);
    if (!fileValue) {
        return undefined;
    }
    return looksLikePath(fileValue) ? fileValue : undefined;
}

/** Create an AccessInfo with all collections empty. */
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

/** De-duplicate strings, drop blank entries and return the result sorted. */
export function uniqSorted(items: string[]): string[] {
    return sortBy(uniq(items.filter((item) => item && item.trim().length > 0)));
}