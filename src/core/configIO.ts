import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { TextDecoder, TextEncoder } from 'util';
import { isRecord } from './accessInfo';

export async function readOpenClawConfig(
    configPath: string
): Promise<{ config: unknown | null; error?: string }> {
    const uri = vscode.Uri.file(configPath);
    try {
        const raw = await vscode.workspace.fs.readFile(uri);
        const decoder = new TextDecoder();
        const contents = decoder.decode(raw);
        if (!contents.trim()) {
            return { config: null, error: 'Config file is empty.' };
        }
        return { config: JSON.parse(contents) };
    } catch (error) {
        if (error instanceof Error && 'code' in error) {
            return { config: null, error: 'Config file not found.' };
        }
        return { config: null, error: 'Unable to read config file.' };
    }
}

export function getOpenClawConfigPath() {
    return path.join(os.homedir(), '.openclaw', 'openclaw.json');
}

export async function loadOpenClawConfigRecord(): Promise<{
    config: Record<string, unknown> | null;
    error?: string;
    path: string;
}> {
    const configPath = getOpenClawConfigPath();
    const result = await readOpenClawConfig(configPath);
    if (!result.config || !isRecord(result.config)) {
        return {
            config: null,
            error: result.error ?? 'Config file not found.',
            path: configPath
        };
    }
    return { config: result.config, error: result.error, path: configPath };
}

export async function writeOpenClawConfigRecord(configPath: string, config: Record<string, unknown>) {
    const encoder = new TextEncoder();
    const contents = `${JSON.stringify(config, null, 2)}\n`;
    await vscode.workspace.fs.writeFile(vscode.Uri.file(configPath), encoder.encode(contents));
}

export function getValueAtPath(root: unknown, pathSegments: Array<string | number>) {
    let current = root;
    for (const segment of pathSegments) {
        if (Array.isArray(current) && typeof segment === 'number') {
            if (segment < 0 || segment >= current.length) {
                return undefined;
            }
            current = current[segment];
            continue;
        }
        if (isRecord(current) && typeof segment === 'string') {
            if (!(segment in current)) {
                return undefined;
            }
            current = current[segment];
            continue;
        }
        return undefined;
    }
    return current;
}

export function getParentAtPath(
    root: unknown,
    pathSegments: Array<string | number>
): { parent: Record<string, unknown> | unknown[]; key: string | number } | null {
    if (pathSegments.length === 0) {
        return null;
    }
    const parentPath = pathSegments.slice(0, -1);
    const key = pathSegments[pathSegments.length - 1];
    const parent = getValueAtPath(root, parentPath);
    if (Array.isArray(parent) && typeof key === 'number') {
        return { parent, key };
    }
    if (isRecord(parent) && typeof key === 'string') {
        return { parent, key };
    }
    return null;
}
