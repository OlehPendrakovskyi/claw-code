import {
    asString,
    createEmptyAccessInfo,
    extractAccessInfoFromCli,
    extractAccessInfoFromConfig,
    extractEnvVarName,
    extractMcpServers,
    extractTools,
    formatAccessSummaryMarkdown,
    formatAccessSummaryShort,
    formatList,
    formatNamedEntry,
    getEnvVarFromRecord,
    getFilePathFromRecord,
    isKeyIndicator,
    isRecord,
    isUrl,
    looksLikePath,
    mergeAccessInfo,
    scanAccessInfo,
    summarizeKeySources,
    uniqueList,
    type AccessInfo
} from '../core/accessInfo';

const newSets = () => ({
    keySources: new Set<string>(),
    localFiles: new Set<string>(),
    endpoints: new Set<string>(),
    notes: new Set<string>()
});

const infoWith = (overrides: Partial<AccessInfo>): AccessInfo => ({
    ...createEmptyAccessInfo(),
    ...overrides
});

describe('primitives', () => {
    it('isRecord accepts plain objects only', () => {
        expect(isRecord({})).toBe(true);
        expect(isRecord({ a: 1 })).toBe(true);
        expect(isRecord([])).toBe(true);
        expect(isRecord(null)).toBe(false);
        expect(isRecord(undefined)).toBe(false);
        expect(isRecord('x')).toBe(false);
        expect(isRecord(1)).toBe(false);
    });

    it('asString returns strings only', () => {
        expect(asString('abc')).toBe('abc');
        expect(asString(1)).toBeUndefined();
        expect(asString(undefined)).toBeUndefined();
    });

    it('uniqueList drops empties, de-dupes and sorts', () => {
        expect(uniqueList(['b', 'a', 'b', '', '  ', 'c'])).toEqual(['a', 'b', 'c']);
    });

    it('uniqueList returns an empty list for empty input', () => {
        expect(uniqueList([])).toEqual([]);
    });

    it('isKeyIndicator matches credential-ish keys case-insensitively', () => {
        expect(isKeyIndicator('api_key')).toBe(true);
        expect(isKeyIndicator('API-KEY')).toBe(true);
        expect(isKeyIndicator('token')).toBe(true);
        expect(isKeyIndicator('passwordHash')).toBe(true);
        expect(isKeyIndicator('credential')).toBe(true);
        expect(isKeyIndicator('secret')).toBe(true);
        expect(isKeyIndicator('tools')).toBe(false);
    });

    it('isUrl detects http(s) schemes', () => {
        expect(isUrl('https://example.com')).toBe(true);
        expect(isUrl('http://127.0.0.1:18789/')).toBe(true);
        expect(isUrl('ftp://example.com')).toBe(false);
        expect(isUrl('/home/node/.openclaw')).toBe(false);
    });

    it('looksLikePath needs a separator and must not be a URL', () => {
        expect(looksLikePath('/home/node/file.json')).toBe(true);
        expect(looksLikePath('C:\\Users\\me\\file.json')).toBe(true);
        expect(looksLikePath('https://example.com/x')).toBe(false);
        expect(looksLikePath('plain')).toBe(false);
    });

    it('extractEnvVarName recognises the supported forms', () => {
        expect(extractEnvVarName('${OPENAI_KEY}')).toBe('OPENAI_KEY');
        expect(extractEnvVarName('$OPENAI_KEY')).toBe('OPENAI_KEY');
        expect(extractEnvVarName('env:OPENAI_KEY')).toBe('OPENAI_KEY');
        expect(extractEnvVarName('ENV:OPENAI_KEY')).toBe('OPENAI_KEY');
        expect(extractEnvVarName('plain-value')).toBeUndefined();
    });
});

describe('createEmptyAccessInfo', () => {
    it('starts with empty, independent buckets', () => {
        const info = createEmptyAccessInfo();
        expect(info).toEqual({
            mcpServers: [],
            tools: [],
            keySources: [],
            networkEndpoints: [],
            localFiles: [],
            notes: []
        });
        expect(createEmptyAccessInfo().mcpServers).not.toBe(info.mcpServers);
    });
});

describe('formatNamedEntry', () => {
    it('passes strings through', () => {
        expect(formatNamedEntry('filesystem')).toBe('filesystem');
    });

    it('combines name and endpoint when both exist', () => {
        expect(formatNamedEntry({ name: 'github', url: 'https://api.github.com' })).toBe(
            'github (https://api.github.com)'
        );
        expect(formatNamedEntry({ id: 'github', endpoint: 'https://api.github.com' })).toBe(
            'github (https://api.github.com)'
        );
        expect(formatNamedEntry({ name: 'local', host: '127.0.0.1' })).toBe('local (127.0.0.1)');
    });

    it('falls back to the name or fallback label', () => {
        expect(formatNamedEntry({ name: 'solo' })).toBe('solo');
        expect(formatNamedEntry({ url: 'https://only.url' })).toBe('https://only.url');
        expect(formatNamedEntry({ description: 'ignored' }, 'fallback')).toBe('fallback');
        expect(formatNamedEntry(42, 'fallback')).toBe('fallback');
    });
});

describe('extractMcpServers', () => {
    it('collects mcp as an array', () => {
        expect(extractMcpServers({ mcp: ['alpha', { name: 'beta' }] })).toEqual(['alpha', 'beta']);
    });

    it('collects mcp.servers as an array or record', () => {
        expect(extractMcpServers({ mcp: { servers: ['alpha'] } })).toEqual(['alpha']);
        expect(extractMcpServers({ mcp: { servers: { myServer: { url: 'https://s' } } } })).toEqual([
            'myServer (https://s)'
        ]);
    });

    it('collects top-level mcpServers', () => {
        expect(extractMcpServers({ mcpServers: ['legacy'] })).toEqual(['legacy']);
    });
});

describe('extractTools', () => {
    it('collects tools from every known location', () => {
        const config = {
            tools: ['read'],
            mcp: { tools: { grep: { url: 'https://grep' } } },
            capabilities: { tools: ['bash'] }
        };
        expect(extractTools(config)).toEqual(['bash', 'grep (https://grep)', 'read']);
    });
});

describe('scanAccessInfo', () => {
    it('records endpoints and paths found in string values', () => {
        const { endpoints, localFiles } = newSets();
        scanAccessInfo({ url: 'https://gw.local', file: '/etc/openclaw/x.json' }, [], new Set(), localFiles, endpoints, new Set());
        expect([...endpoints]).toEqual(['https://gw.local']);
        expect([...localFiles]).toEqual(['/etc/openclaw/x.json']);
    });

    it('records env vars declared under key-ish records', () => {
        const { keySources } = newSets();
        scanAccessInfo({ apiKey: { env: 'OPENAI_KEY' } }, [], keySources, new Set(), new Set(), new Set());
        expect([...keySources]).toEqual([
            'Environment variable: OPENAI_KEY',
            'Config value: apiKey.env'
        ]);
    });

    it('records key files declared under key-ish records', () => {
        const { keySources, localFiles } = newSets();
        scanAccessInfo({ token: { path: '/run/secrets/token' } }, [], keySources, localFiles, new Set(), new Set());
        expect([...keySources]).toEqual(['Key file: /run/secrets/token']);
        expect([...localFiles]).toEqual(['/run/secrets/token']);
    });

    it('resolves ${VAR} references under key-ish keys', () => {
        const { keySources } = newSets();
        scanAccessInfo({ secret: '${MY_SECRET}' }, [], keySources, new Set(), new Set(), new Set());
        expect([...keySources]).toEqual(['Environment variable: MY_SECRET']);
    });

    it('falls back to a config path label for opaque key values', () => {
        const { keySources } = newSets();
        scanAccessInfo({ credentials: { password: 'literal' } }, [], keySources, new Set(), new Set(), new Set());
        expect([...keySources]).toEqual(['Config value: credentials.password']);
    });

    it('walks arrays with an index path', () => {
        const { keySources } = newSets();
        scanAccessInfo({ keys: ['${A_KEY}'] }, [], keySources, new Set(), new Set(), new Set());
        expect([...keySources]).toEqual(['Environment variable: A_KEY']);
    });

    it('stops recursing past the depth limit', () => {
        const { endpoints } = newSets();
        let node: Record<string, unknown> = { leaf: 'https://deep.example' };
        for (let i = 0; i < 20; i += 1) {
            node = { nested: node };
        }
        scanAccessInfo(node, [], new Set(), new Set(), endpoints, new Set());
        expect(endpoints.size).toBe(0);
    });
});

describe('extractAccessInfoFromConfig', () => {
    it('always records the config path', () => {
        const info = extractAccessInfoFromConfig(null, '/home/x/.openclaw/openclaw.json');
        expect(info.localFiles).toEqual(['/home/x/.openclaw/openclaw.json']);
    });

    it('returns an empty info for non-record configs', () => {
        const info = extractAccessInfoFromConfig('nope', '/tmp/c.json');
        expect(info.mcpServers).toEqual([]);
        expect(info.tools).toEqual([]);
        expect(info.keySources).toEqual([]);
    });

    it('extracts servers, tools, keys, endpoints and files from a record', () => {
        const info = extractAccessInfoFromConfig(
            {
                mcp: { servers: { gh: { url: 'https://api.github.com' } } },
                tools: ['read', 'bash'],
                apiKey: { env: 'OPENAI_KEY' },
                gateway: { url: 'https://gw.example' }
            },
            '/tmp/openclaw.json'
        );
        expect(info.mcpServers).toEqual(['gh (https://api.github.com)']);
        expect(info.tools).toEqual(['bash', 'read']);
        expect(info.keySources).toEqual([
            'Config value: apiKey.env',
            'Environment variable: OPENAI_KEY'
        ]);
        expect(info.networkEndpoints).toContain('https://gw.example');
        expect(info.localFiles).toEqual(['/tmp/openclaw.json']);
    });
});

describe('extractAccessInfoFromCli', () => {
    it('returns empty info without output', () => {
        expect(extractAccessInfoFromCli(undefined)).toEqual(createEmptyAccessInfo());
        expect(extractAccessInfoFromCli('')).toEqual(createEmptyAccessInfo());
    });

    it('extracts and de-dupes urls', () => {
        expect(extractAccessInfoFromCli('a https://one.two b https://one.two c http://three').networkEndpoints).toEqual([
            'http://three',
            'https://one.two'
        ]);
    });
});

describe('mergeAccessInfo', () => {
    it('unions every bucket', () => {
        const base = infoWith({
            mcpServers: ['a'],
            tools: ['t1'],
            keySources: ['Environment variable: A'],
            networkEndpoints: ['https://a'],
            localFiles: ['/a'],
            notes: ['n1']
        });
        const extra = infoWith({
            mcpServers: ['b'],
            tools: ['t2'],
            keySources: ['Key file: /b'],
            networkEndpoints: ['https://b'],
            localFiles: ['/b'],
            notes: ['n2']
        });
        const merged = mergeAccessInfo(base, extra);
        expect(merged.mcpServers).toEqual(['a', 'b']);
        expect(merged.tools).toEqual(['t1', 't2']);
        expect(merged.keySources).toEqual(['Environment variable: A', 'Key file: /b']);
        expect(merged.networkEndpoints).toEqual(['https://a', 'https://b']);
        expect(merged.localFiles).toEqual(['/a', '/b']);
        expect(merged.notes).toEqual(['n1', 'n2']);
    });

    it('does not mutate its inputs', () => {
        const base = infoWith({ tools: ['t1'] });
        const extra = infoWith({ tools: ['t2'] });
        mergeAccessInfo(base, extra);
        expect(base.tools).toEqual(['t1']);
        expect(extra.tools).toEqual(['t2']);
    });
});

describe('summarizeKeySources', () => {
    it('classifies and sorts key source kinds', () => {
        expect(summarizeKeySources(['Key file: /f', 'Environment variable: X', 'Config value: y'])).toBe(
            'config, env, file'
        );
    });

    it('returns none for empty input', () => {
        expect(summarizeKeySources([])).toBe('none');
    });
});

describe('getEnvVarFromRecord', () => {
    it('reads env, envVar and environment keys', () => {
        expect(getEnvVarFromRecord({ env: 'A' })).toBe('A');
        expect(getEnvVarFromRecord({ envVar: 'B' })).toBe('B');
        expect(getEnvVarFromRecord({ environment: 'C' })).toBe('C');
        expect(getEnvVarFromRecord({ other: 'D' })).toBeUndefined();
    });
});

describe('getFilePathFromRecord', () => {
    it('returns only path-like values', () => {
        expect(getFilePathFromRecord({ path: '/etc/x' })).toBe('/etc/x');
        expect(getFilePathFromRecord({ file: 'C:\\x' })).toBe('C:\\x');
        expect(getFilePathFromRecord({ filePath: 'nosep' })).toBeUndefined();
    });
});

describe('formatList', () => {
    it('renders bullet items', () => {
        expect(formatList(['a', 'b'], 'empty')).toBe('- a\n- b');
    });

    it('renders the empty message when there are no items', () => {
        expect(formatList([], 'nothing here')).toBe('nothing here');
    });
});

describe('formatAccessSummaryShort', () => {
    it('reports counts and key kinds', () => {
        const info = infoWith({
            mcpServers: ['gh'],
            tools: ['read', 'bash'],
            keySources: ['Environment variable: OPENAI_KEY']
        });
        expect(formatAccessSummaryShort(info)).toBe('MCP: 1 | Tools: 2 | Keys: env');
    });

    it('reports errors alongside the counts', () => {
        const info = infoWith({ tools: ['read'] });
        expect(formatAccessSummaryShort(info, 'boom', 'cli failed')).toBe(
            'Tools: 1 | Config unavailable | CLI error'
        );
    });

    it('reports a placeholder when nothing was generated', () => {
        expect(formatAccessSummaryShort(createEmptyAccessInfo())).toBe('Not generated yet');
    });
});

describe('formatAccessSummaryMarkdown', () => {
    it('renders every section', () => {
        const info = infoWith({
            mcpServers: ['gh'],
            tools: ['read'],
            keySources: ['Environment variable: OPENAI_KEY'],
            networkEndpoints: ['https://gw.example'],
            localFiles: ['/tmp/x'],
            notes: ['note']
        });
        const markdown = formatAccessSummaryMarkdown(info, undefined, undefined, 'cli output', '/tmp/openclaw.json');
        expect(markdown).toContain('# OpenClaw access summary');
        expect(markdown).toContain('## MCP servers\n- gh');
        expect(markdown).toContain('## Tools\n- read');
        expect(markdown).toContain('## Keys and credentials\n- Environment variable: OPENAI_KEY');
        expect(markdown).toContain('## Local files\n- /tmp/openclaw.json\n- /tmp/x');
        expect(markdown).toContain('## Notes\n- note');
        expect(markdown).toContain('```\ncli output\n```');
    });

    it('surfaces config and CLI issues', () => {
        const markdown = formatAccessSummaryMarkdown(createEmptyAccessInfo(), 'no config', 'cli exploded');
        expect(markdown).toContain('Config issue: no config');
        expect(markdown).toContain('CLI issue: cli exploded');
        expect(markdown).toContain('No CLI output captured.');
    });
});
