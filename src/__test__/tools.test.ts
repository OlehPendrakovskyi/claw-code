import * as vscode from 'vscode';
import {
    collectToolEntries,
    computeToolToggle,
    getToolDescription,
    getToolEnabled,
    loadToolsForOverview,
    readEntryAtPath,
    type ToolEntry
} from '../core/tools';
import { extractMcpServers, extractTools } from '../core/tools';

const configRecord = (config: Record<string, unknown>) => config;

describe('getToolEnabled', () => {
    it('reads an explicit boolean flag', () => {
        expect(getToolEnabled({ enabled: false })).toBe(false);
        expect(getToolEnabled({ enabled: true })).toBe(true);
    });

    it('defaults to enabled when the flag is missing or not boolean', () => {
        expect(getToolEnabled({ name: 'x' })).toBe(true);
        expect(getToolEnabled({ enabled: 'no' })).toBe(true);
        expect(getToolEnabled('x')).toBe(true);
        expect(getToolEnabled(undefined)).toBe(true);
    });
});

describe('getToolDescription', () => {
    it('prefers description, then summary, purpose and details', () => {
        expect(getToolDescription({ description: 'd' })).toBe('d');
        expect(getToolDescription({ summary: 's' })).toBe('s');
        expect(getToolDescription({ purpose: 'p' })).toBe('p');
        expect(getToolDescription({ details: 'x' })).toBe('x');
        expect(getToolDescription({ summary: 's', purpose: 'p' })).toBe('s');
    });

    it('returns undefined for non-records and unknown fields', () => {
        expect(getToolDescription('plain')).toBeUndefined();
        expect(getToolDescription({ other: 1 })).toBeUndefined();
    });
});

describe('collectToolEntries', () => {
    it('returns an empty list when no tool sources exist', () => {
        expect(collectToolEntries(configRecord({}))).toEqual([]);
    });

    it('collects array sources with indexed paths', () => {
        const entries = collectToolEntries(configRecord({ tools: ['read', 'bash'] }));
        expect(entries.map(e => e.label)).toEqual(['bash', 'read']);
        expect(entries.find(e => e.label === 'read')?.path).toEqual(['tools', 0]);
        expect(entries.every(e => e.enabled)).toBe(true);
        expect(entries.every(e => e.source === 'tools')).toBe(true);
    });

    it('collects record sources with named paths', () => {
        const entries = collectToolEntries(
            configRecord({ mcp: { tools: { grep: { url: 'https://grep' } } } })
        );
        expect(entries).toHaveLength(1);
        expect(entries[0].label).toBe('grep (https://grep)');
        expect(entries[0].path).toEqual(['mcp', 'tools', 'grep']);
        expect(entries[0].source).toBe('mcp.tools');
    });

    it('collects every source and keeps disabled flags', () => {
        const entries = collectToolEntries(
            configRecord({
                tools: [{ name: 'zeta', enabled: false }],
                mcp: { tools: { alpha: { enabled: true } } },
                capabilities: { tools: ['mid'] }
            })
        );
        expect(entries.map(e => e.label)).toEqual(['alpha', 'mid', 'zeta']);
        expect(entries.find(e => e.label === 'zeta')?.enabled).toBe(false);
    });

    it('sorts entries by label', () => {
        const entries = collectToolEntries(configRecord({ tools: ['c', 'a', 'b'] }));
        expect(entries.map(e => e.label)).toEqual(['a', 'b', 'c']);
    });
});

describe('readEntryAtPath', () => {
    it('reads an array element by numeric key', () => {
        expect(readEntryAtPath(['a', 'b'], 1)).toBe('b');
    });

    it('reads an object property by string key', () => {
        expect(readEntryAtPath({ tool: { enabled: true } }, 'tool')).toEqual({ enabled: true });
    });

    it('returns undefined when the container and key types do not match', () => {
        expect(readEntryAtPath({ a: 1 }, 0)).toBeUndefined();
        expect(readEntryAtPath(['a'], 'key')).toBeUndefined();
    });
});

describe('computeToolToggle', () => {
    it('reports missing entries', () => {
        expect(computeToolToggle(undefined)).toEqual({ ok: false, reason: 'missing' });
    });

    it('disables an enabled record', () => {
        expect(computeToolToggle({ name: 'x', enabled: true })).toEqual({
            ok: true,
            nextEntry: { name: 'x', enabled: false },
            enabled: false
        });
    });

    it('enables a disabled record', () => {
        expect(computeToolToggle({ name: 'x', enabled: false })).toEqual({
            ok: true,
            nextEntry: { name: 'x', enabled: true },
            enabled: true
        });
    });

    it('converts a bare string into a disabled record', () => {
        expect(computeToolToggle('filesystem')).toEqual({
            ok: true,
            nextEntry: { name: 'filesystem', enabled: false },
            enabled: false
        });
    });

    it('reports unsupported entry shapes', () => {
        expect(computeToolToggle(42)).toEqual({ ok: false, reason: 'unsupported' });
    });
});

describe('loadToolsForOverview', () => {
    it('returns collected entries from the loaded config', async () => {
        jest.resetModules();
        jest.doMock('../core/configIO', () => ({
            loadOpenClawConfigRecord: jest.fn(async () => ({
                config: { tools: ['read'] },
                path: '/tmp/openclaw.json'
            }))
        }));
        const { loadToolsForOverview: load } = require('../core/tools');
        const result = await load();
        expect(result.entries.map((e: ToolEntry) => e.label)).toEqual(['read']);
        expect(result.error).toBeUndefined();
        jest.dontMock('../core/configIO');
    });

    it('propagates the config error and returns no entries', async () => {
        jest.resetModules();
        jest.doMock('../core/configIO', () => ({
            loadOpenClawConfigRecord: jest.fn(async () => ({
                config: null,
                error: 'Config file not found.',
                path: '/tmp/openclaw.json'
            }))
        }));
        const { loadToolsForOverview: load } = require('../core/tools');
        const result = await load();
        expect(result.entries).toEqual([]);
        expect(result.error).toBe('Config file not found.');
        jest.dontMock('../core/configIO');
    });
});

describe('tools re-exports', () => {
    it('re-exports the access-info helpers', () => {
        expect(typeof extractMcpServers).toBe('function');
        expect(typeof extractTools).toBe('function');
    });

    it('re-exported helpers keep their behaviour', () => {
        expect(extractTools({ tools: ['read'] })).toEqual(['read']);
        expect(extractMcpServers({ mcpServers: ['legacy'] })).toEqual(['legacy']);
    });
});

describe('vscode mock sanity', () => {
    it('exposes the APIs core modules rely on', () => {
        expect(typeof vscode.workspace.getConfiguration).toBe('function');
        expect(typeof vscode.Uri.file).toBe('function');
    });
});
