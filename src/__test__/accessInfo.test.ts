import {
    asString,
    createEmptyAccessInfo,
    extractAccessInfoFromCli,
    extractAccessInfoFromConfig,
    redactEndpoint,
    redactPlainSecrets,
    redactText,
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
    uniqSorted,
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

describe('redactPlainSecrets', () => {
    it('masks plain-text credentials and bearer tokens', () => {
        expect(redactPlainSecrets('token=abc123')).toBe('token=***');
        expect(redactPlainSecrets('api_key="sk-123"')).toBe('api_key=***');
        expect(redactPlainSecrets('Authorization: Bearer abcdef123456')).toBe('Authorization=***');
        expect(redactPlainSecrets('plain text stays')).toBe('plain text stays');
    });

    it('masks quoted JSON keys and prefixed environment names', () => {
        expect(redactPlainSecrets('{"token":"secret"}')).toBe('{"token"=***}');
        expect(redactPlainSecrets('OPENAI_API_KEY=secret')).toBe('OPENAI_API_KEY=***');
        expect(redactPlainSecrets('AWS_SECRET_ACCESS_KEY=abc')).toBe('AWS_SECRET_ACCESS_KEY=***');
        expect(redactPlainSecrets('"Authorization":"Basic dXNlcjpwYXNz"')).toBe('"Authorization"=***');
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

    it('redacts a malformed endpoint from CLI output everywhere in the report', () => {
        const cliOutput = 'gateway https://alice:secret@[bad';
        const info = extractAccessInfoFromCli(cliOutput);
        const markdown = formatAccessSummaryMarkdown(info, undefined, undefined, cliOutput);
        expect(markdown).not.toContain('secret');
        expect(markdown).not.toContain('alice');
    });

    it('redacts a special-scheme endpoint spelled without `//` in named entries', () => {
        expect(formatNamedEntry({ name: 'gh', url: 'https:/alice:secret@host.example/x' })).toBe('gh (https://***:***@host.example/x)');
        expect(formatNamedEntry({ name: 'gh', url: 'https:\\\\alice:secret@host.example/x' })).not.toMatch(/alice|secret/);
    });

    it('redacts names, ids and fallbacks in named entries', () => {
        expect(formatNamedEntry({ name: 'token=PRIVATE' })).not.toContain('PRIVATE');
        expect(formatNamedEntry({ id: 'https://alice:secret@[bad' })).not.toMatch(/alice|secret/);
        expect(formatNamedEntry({}, 'token=PRIVATE')).not.toContain('PRIVATE');
        expect(formatNamedEntry(42, 'token=PRIVATE')).not.toContain('PRIVATE');
    });

    it('redacts malformed endpoints in MCP server and tool labels', () => {
        const info = infoWith({
            mcpServers: [formatNamedEntry({ name: 'remote', url: 'https://alice:secret@[bad' }) ?? ''],
            tools: ['fetch (https://bob:hunter2@[bad)'],
        });
        const markdown = formatAccessSummaryMarkdown(info);
        expect(markdown).not.toMatch(/alice|secret|bob|hunter2/);
    });

    it('redacts key sources and local files taken from config values', () => {
        const info = extractAccessInfoFromConfig(
            { credentials: { env: 'OPENAI_API_KEY=PRIVATE', file: '/run/secrets/token=PRIVATE' } },
            '/tmp/openclaw.json'
        );
        expect(info.keySources.join('\n')).toContain('PRIVATE');
        const markdown = formatAccessSummaryMarkdown(info);
        expect(markdown).toContain('- Environment variable: OPENAI_API_KEY=***');
        expect(markdown).toContain('## Local files\n- /run/secrets/token=***');
        expect(markdown).not.toContain('PRIVATE');
    });

    it('surfaces config and CLI issues', () => {
        const markdown = formatAccessSummaryMarkdown(createEmptyAccessInfo(), 'no config', 'cli exploded');
        expect(markdown).toContain('Config issue: no config');
        expect(markdown).toContain('CLI issue: cli exploded');
        expect(markdown).toContain('No CLI output captured.');
    });
});

describe('redactText', () => {
    it('redacts URL userinfo inside free-form text', () => {
        expect(redactText('failed: https://alice:secret@host.example/repo.git (exit 1)')).toBe(
            'failed: https://***:***@host.example/repo.git (exit 1)'
        );
    });

    it('redacts URLs of any scheme, including ssh and git+https', () => {
        expect(redactText('ssh://bob:pw@git.example/x and git+https://carol:tok@h.example/y')).toBe(
            'ssh://***:***@git.example/x and git+https://***:***@h.example/y'
        );
    });

    it('redacts sensitive query values and plain-text secrets in the same text', () => {
        // The plain-text pass treats everything after `api_key=` up to the next pair on the line as the value,
        // so later query params and words go too: it errs toward hiding, never toward showing.
        expect(redactText('GET https://api.example/v1?api_key=abc&page=2 with token=xyz')).toBe(
            'GET https://api.example/v1?api_key=*** token=***'
        );
    });

    it('leaves text without credentials unchanged', () => {
        expect(redactText('connect ECONNREFUSED http://127.0.0.1:18789')).toBe('connect ECONNREFUSED http://127.0.0.1:18789');
    });

    it('redacts a URL that ends in brackets or sentence punctuation, keeping the punctuation', () => {
        expect(redactText('failed [https://alice:secret@host.example]')).toBe('failed [https://***:***@host.example/]');
        expect(redactText('see (https://alice:secret@host.example/x).')).toBe('see (https://***:***@host.example/x).');
    });

    it('still masks userinfo when the URL cannot be parsed', () => {
        expect(redactText('bad https://alice:secret@[not-a-host/x')).toBe('bad https://***@[not-a-host/x');
    });

    it('masks a percent-encoded sensitive query name when the URL cannot be parsed', () => {
        expect(redactText('bad https://[not-a-host/x?to%6ben=secret&page=2')).toBe('bad https://[not-a-host/x?to%6ben=***&page=2');
    });

    it('masks a query value whose name does not decode, failing toward hiding', () => {
        expect(redactText('bad https://[not-a-host/x?a%E0=secret')).toBe('bad https://[not-a-host/x?a%E0=***');
    });

    it('masks a password containing ? or # when the URL cannot be parsed', () => {
        expect(redactText('bad https://alice:p?ss@[not-a-host/x')).toBe('bad https://***@[not-a-host/x');
        expect(redactText('bad https://alice:p#ss@[not-a-host/x')).toBe('bad https://***@[not-a-host/x');
    });

    it('masks a password containing @ when the URL cannot be parsed', () => {
        expect(redactText('bad https://alice:p@ss@[not-a-host/x')).toBe('bad https://***@[not-a-host/x');
    });

    it('masks a password containing / when the URL cannot be parsed', () => {
        expect(redactText('failed https://alice:p/ss@[not-a-host/x')).toBe('failed https://***@[not-a-host/x');
    });

    it('masks a userinfo holding a quote or angle bracket', () => {
        // These parse (URL percent-encodes the character), so the userinfo keeps its user:password shape.
        expect(redactText('failed https://alice:p"ass@host/x')).toBe('failed https://***:***@host/x');
        expect(redactText("failed https://alice:p'ass@host/x")).toBe('failed https://***:***@host/x');
        expect(redactText('failed https://alice:p<ss@host/x')).toBe('failed https://***:***@host/x');
    });

    it('masks the userinfo of a network-path reference', () => {
        expect(redactText('request //alice:secret@host.example/x failed')).toBe('request //***@host.example/x failed');
        expect(redactText('url="//alice:secret@host.example/x"')).toBe('url="//***@host.example/x"');
        expect(redactText('request //alice:p@ss@host.example/x failed')).toBe('request //***@host.example/x failed');
    });

    it('masks a network-path userinfo holding a quote, backtick or angle bracket', () => {
        expect(redactText('request //alice:p"ass@host.example/x failed')).toBe('request //***@host.example/x failed');
        expect(redactText("request //alice:p'ass@host.example/x failed")).toBe('request //***@host.example/x failed');
        expect(redactText('request //alice:p`ass@host.example/x failed')).toBe('request //***@host.example/x failed');
        expect(redactText('request //alice:p<ss@host.example/x failed')).toBe('request //***@host.example/x failed');
    });

    it('leaves a path with a double slash and an @ alone', () => {
        expect(redactText('see a//b@c and https://host.example//x@y')).toBe('see a//b@c and https://host.example//x@y');
    });

    it('keeps the backticks around a Markdown-wrapped URL', () => {
        expect(redactText('see `https://alice:secret@host.example/x` here')).toBe('see `https://***:***@host.example/x` here');
        expect(redactText('see `//alice:secret@host.example/x`')).toBe('see `//***@host.example/x`');
    });

    it('masks a userinfo holding a backtick', () => {
        expect(redactText('failed https://alice:p`ass@host.example/x')).toBe('failed https://***:***@host.example/x');
    });

    it('masks a userinfo holding a nested ://', () => {
        expect(redactText('failed https://alice:p://ss@host.example/x')).toBe('failed https://***@host.example/x');
        expect(redactText('failed https://alice:p://ss://tail@host.example/x')).toBe('failed https://***@host.example/x');
    });

    it('still redacts adjacent URLs one by one', () => {
        expect(redactText('a,https://alice:secret@host.example/x,wss://bob:pw@other.example/y')).toBe('a,https://***:***@host.example/x,wss://***:***@other.example/y');
    });

    it('masks a userinfo holding both a slash and a quote', () => {
        expect(redactText('failed https://alice:p/"ass@host/x')).toBe('failed https://***@host/x');
    });

    it('leaves a JSON URL followed by an email alone', () => {
        expect(redactText('{"url":"https://host.example/x","email":"a@b.example"}')).toBe('{"url":"https://host.example/x","email":"a@b.example"}');
    });

    it('masks a quoted value under an encoded sensitive key in an unparsable URL', () => {
        expect(redactText('bad https://[bad/x?to%6ben="super-secret"')).toBe('bad https://[bad/x?to%6ben=***');
        expect(redactText("bad https://[bad/x?page=2&to%6ben='super-secret'")).toBe('bad https://[bad/x?page=2&to%6ben=***');
    });

    it('masks a closed quoted value that spans lines', () => {
        expect(redactText("secret='first-line\nprivate-second-line' next")).toBe('secret=*** next');
        expect(redactText('GET https://[bad/x?token="first\nsecond" ok')).toBe('GET https://[bad/x?token=*** ok');
    });

    it('leaves an @ in the query or fragment of a valid URL alone', () => {
        expect(redactText('see https://host.example?email=user@example.com')).toBe('see https://host.example?email=user@example.com');
        expect(redactText('see https://host.example#user@example.com')).toBe('see https://host.example#user@example.com');
    });

    it('masks a sensitive query pair inside the quoted value of an ordinary one', () => {
        expect(redactText("GET https://host.example/?q='public&to%6ben=secret'")).not.toContain('secret');
    });

    it('masks a whole quoted credential whose value looks like a query', () => {
        const json = JSON.stringify({ password: 'prefix?token=abc"private-tail' });
        expect(redactText(json)).toBe('{"password"=***}');
    });

    it('masks percent-encoded passwd and authorization query values', () => {
        expect(redactText('GET https://host.example/x?p%61sswd=private-value')).not.toContain('private-value');
        expect(redactText('GET https://host.example/x?author%69zation=private-value')).not.toContain('private-value');
        expect(redactText('GET https://[bad/x?p%61sswd=private-value ok')).toBe('GET https://[bad/x?p%61sswd=*** ok');
        expect(redactText('GET https://[bad/x?author%69zation=private-value ok')).toBe('GET https://[bad/x?author%69zation=*** ok');
    });

    it('masks a userinfo whose password holds a quoted query-like pair', () => {
        expect(redactText('failed https://alice:private&token="abc@host.example/x"')).toBe('failed https://***:***@host.example/x"');
        expect(redactText('failed //alice:private&token="abc@host.example/x"')).toBe('failed //***@host.example/x"');
    });

    it('masks a whole quoted Authorization value whose text looks like a query', () => {
        const json = JSON.stringify({ Authorization: 'prefix?to%6ben=abc"private-tail' });
        expect(redactText(json)).not.toContain('private-tail');
    });

    it('masks cookie headers and cookie query values', () => {
        expect(redactText('Cookie: theme=dark; session=abc123')).toBe('Cookie=***');
        expect(redactText('Set-Cookie: session=abc123; Path=/; HttpOnly\nnext')).toBe('Set-Cookie=***\nnext');
        expect(redactText('{"Cookie":"theme=dark; session=abc123","ok":1}')).toBe('{"Cookie"=***,"ok":1}');
        expect(redactText('{"Authorization":"Bearer abc","ok":1}')).toBe('{"Authorization"=***,"ok":1}');
        expect(redactText('Cookie: "theme=dark"; session=abc123')).toBe('Cookie=***');
        expect(redactText('GET https://host.example/?cookie=session-secret')).not.toContain('session-secret');
        expect(redactText('GET https://[bad/x?cookie=session-secret ok')).toBe('GET https://[bad/x?cookie=*** ok');
    });

    it('masks pass and passphrase values in URLs, plain text and JSON, but not bypass', () => {
        expect(redactText('https://host.example/?pass=PRIVATE')).toBe('https://host.example/?pass=***');
        expect(redactEndpoint('https://host.example/?pass=PRIVATE&page=2')).toBe('https://host.example/?pass=***&page=2');
        expect(redactPlainSecrets('pass=PRIVATE')).toBe('pass=***');
        expect(redactText('db_pass: PRIVATE')).toBe('db_pass=***');
        expect(redactText('{"passphrase":"PRIVATE","ok":1}')).toBe('{"passphrase"=***,"ok":1}');
        expect(redactText('?passphrase=PRIVATE')).toBe('?passphrase=***');
        expect(redactText('bypass=ok passenger=yes')).toBe('bypass=ok passenger=yes');
    });

    it('masks a credential that serialised whitespace separates from its label', () => {
        expect(redactText(JSON.stringify({ reason: 'token\t=PRIVATE' }))).not.toContain('PRIVATE');
        expect(redactText(JSON.stringify({ reason: 'token:\n PRIVATE' }))).not.toContain('PRIVATE');
        expect(redactText(JSON.stringify({ reason: 'sent Bearer\tPRIVATE', ok: 1 }))).toBe('{"reason":"sent Bearer ***","ok":1}');
        expect(redactText(JSON.stringify({ reason: 'Authorization\r\n: PRIVATE' }))).not.toContain('PRIVATE');
        expect(redactText(JSON.stringify({ detail: JSON.stringify({ reason: 'token\t=PRIVATE' }) }))).not.toContain('PRIVATE');
    });

    it('masks a Bearer or Basic credential after whitespace serialised at any depth', () => {
        let bearer = 'Bearer\tPRIVATE_VALUE';
        let basic = 'Basic\tYTo=';
        for (let depth = 0; depth < 6; depth++) {
            bearer = JSON.stringify(bearer);
            basic = JSON.stringify(basic);
            expect(redactText(bearer)).not.toContain('PRIVATE');
            expect(redactText(basic)).not.toContain('YTo=');
        }
    });

    it('masks a credential whose key follows a Windows path backslash, raw and serialised', () => {
        expect(redactText('C:\\secrets\\OPENAI_API_KEY=PRIVATE_VALUE')).toBe('C:\\secrets\\OPENAI_API_KEY=***');
        expect(redactText(JSON.stringify({ path: 'C:\\secrets\\OPENAI_API_KEY=PRIVATE_VALUE' }))).not.toContain('PRIVATE');
        expect(redactText('C:\\Users\\me\\token: PRIVATE_VALUE')).toBe('C:\\Users\\me\\token=***');
        // After an escape letter, the key is read both ways: `\npass` is `pass` after a newline.
        expect(redactText(JSON.stringify({ reason: 'failure\npass=PRIVATE_VALUE' }))).not.toContain('PRIVATE');
        expect(redactText(JSON.stringify({ reason: 'failure\ncookie: PRIVATE_VALUE' }))).not.toContain('PRIVATE');
    });

    it('masks a credential whose key follows serialised whitespace', () => {
        expect(redactText(JSON.stringify({ reason: 'failure\nOPENAI_API_KEY=PRIVATE_VALUE' }))).toBe('{"reason":"failure\\nOPENAI_API_KEY=***');
        expect(redactText(JSON.stringify({ reason: 'x\ttoken=PRIVATE_VALUE' }))).not.toContain('PRIVATE');
        expect(redactText(JSON.stringify(JSON.stringify({ reason: 'failure\r\npassword: PRIVATE_VALUE' })))).not.toContain('PRIVATE');
    });

    it('masks a value opened by an escaped single quote or backtick past an escaped double quote', () => {
        expect(redactText('password=\\\'prefix\\"PRIVATE_SUFFIX\\\'')).toBe('password=***');
        expect(redactText('password=\\`prefix\\"PRIVATE_SUFFIX\\`')).toBe('password=***');
        // The enclosing string's own end still stops it.
        expect(redactText('{"a":"password=\\\'PRIVATE","ok":1}')).toBe('{"a":"password=***","ok":1}');
    });

    it('masks a serialised composite credential whose single-quoted string holds an escaped quote', () => {
        expect(redactText(JSON.stringify({ reason: "tokens=['prefix\\' ]PRIVATE_SUFFIX']" }))).not.toContain('PRIVATE');
        expect(redactText(JSON.stringify({ reason: 'tokens=[`prefix\\` ]PRIVATE_SUFFIX`]' }))).not.toContain('PRIVATE');
        // Unserialised, the string and the array close where they should.
        expect(redactText("tokens=['a\\' ]b'] ok")).toBe('tokens=*** ok');
    });

    it('masks a bare value under any key naming a cookie, to the end of its line', () => {
        expect(redactText('cookie_header=PRIVATE_VALUE')).toBe('cookie_header=***');
        expect(redactText('cookieHeader=PRIVATE_VALUE\nnext')).toBe('cookieHeader=***\nnext');
        expect(redactText('session_cookie: theme=dark; session=PRIVATE')).toBe('session_cookie=***');
    });

    it('masks a single-quoted credential whose escaped quote JSON serialisation doubled the backslash of', () => {
        expect(redactText(JSON.stringify({ reason: "password='prefix\\'PRIVATE_SUFFIX'" }))).not.toContain('PRIVATE');
        expect(redactText(JSON.stringify({ reason: "sent Bearer 'prefix\\'PRIVATE_SUFFIX'" }))).not.toContain('PRIVATE');
        expect(redactText(JSON.stringify({ reason: 'token=`prefix\\`PRIVATE_SUFFIX`' }))).not.toContain('PRIVATE');
        // Unserialised, the same values are masked whole and the text after them survives.
        expect(redactText("password='prefix\\'PRIVATE_SUFFIX' ok")).toBe('password=*** ok');
    });

    it('masks a network-path userinfo whose password holds a slash', () => {
        expect(redactText('clone failed: //alice:p/ss@host.example/repo.git')).toBe('clone failed: //***@host.example/repo.git');
        expect(redactText('see a//b@c')).toBe('see a//b@c');
    });

    it('masks the userinfo of a URL nested in another URL\'s query or fragment', () => {
        expect(redactText('failed https://public.example?redirect=https://alice:p"PRIVATE@host.example/x')).not.toContain('PRIVATE');
        expect(redactText('failed https://public.example?redirect=https://alice:p`PRIVATE@host.example/x')).not.toContain('PRIVATE');
        expect(redactText('failed https://public.example#next=https://alice:p"PRIVATE@host.example/x')).not.toContain('PRIVATE');
    });

    it('masks a userinfo with a slash before a nested ://', () => {
        expect(redactText('failed https://alice:PRIVATE_PREFIX/ss://tail@host.example/x')).toBe('failed https://***@host.example/x');
    });

    it('masks a credential quoted with escaped quotes inside a JSON string', () => {
        const json = JSON.stringify({ reason: 'password="PRIVATE_PREFIX PRIVATE_SUFFIX"', ok: 1 });
        const redacted = redactText(json);
        expect(redacted).not.toContain('PRIVATE');
        expect(redacted).toContain('"ok":1');
        expect(redactText(JSON.stringify({ reason: 'token="PRIVATE_PREFIX PRIVATE_SUFFIX' }))).not.toContain('PRIVATE');
    });

    it('does not take an encoded interior quote for the closing one', () => {
        // The value holds an escaped quote; serialised, it becomes \\\" inside \"…\".
        const json = JSON.stringify({ reason: 'password="PRIVATE_PREFIX\\"PRIVATE_SUFFIX"' });
        expect(redactText(json)).not.toContain('PRIVATE');
    });

    it('masks a sensitive query value quoted with escaped quotes inside a JSON string', () => {
        expect(redactText(JSON.stringify({ reason: '?to%6ben="PRIVATE_PREFIX PRIVATE_SUFFIX"' }))).not.toContain('PRIVATE');
    });

    it('masks a credential under an escaped JSON key inside a string field', () => {
        const json = JSON.stringify({ reason: '{"token":"PRIVATE_VALUE","page":2}' });
        const redacted = redactText(json);
        expect(redacted).not.toContain('PRIVATE_VALUE');
        expect(redacted).toContain('page');
    });

    it('masks the rest of a credential value whose brackets do not match', () => {
        expect(redactText('token: ["x"} PRIVATE_VALUE')).not.toContain('PRIVATE_VALUE');
        expect(redactText('token: [{"a": 1]} PRIVATE_VALUE')).not.toContain('PRIVATE_VALUE');
    });

    it('masks a quoted Bearer token', () => {
        expect(redactText('sent Bearer "abc def" ok')).toBe('sent Bearer *** ok');
        expect(redactText("sent bearer 'a\\'b'")).toBe('sent bearer ***');
        expect(redactText('sent Bearer "unterminated value')).toBe('sent Bearer ***');
    });

    it('masks a Bearer token opened by an escaped quote, as in serialized details', () => {
        expect(redactText(JSON.stringify({ reason: 'sent Bearer "PRIVATE_PREFIX PRIVATE_SUFFIX"', ok: 1 }))).toBe('{"reason":"sent Bearer ***","ok":1}');
        // An escaped interior quote does not end the token.
        expect(redactText(JSON.stringify({ reason: 'sent Bearer "a\\"PRIVATE b"', ok: 1 }))).toBe('{"reason":"sent Bearer ***","ok":1}');
        // Without a closing quote it runs to the end of the enclosing string.
        expect(redactText(JSON.stringify({ reason: 'sent Bearer "PRIVATE_PREFIX PRIVATE_SUFFIX', ok: 1 }))).toBe('{"reason":"sent Bearer ***","ok":1}');
    });

    it('masks a credential in JSON serialised more than once', () => {
        const twice = JSON.stringify({ detail: JSON.stringify({ token: 'PRIVATE', ok: 1 }) });
        expect(redactText(twice)).toBe('{"detail":"{\\"token\\"=***,\\"ok\\":1}"}');
        const thrice = JSON.stringify({ reason: JSON.stringify({ detail: JSON.stringify({ token: 'PRIVATE' }) }) });
        expect(redactText(thrice)).not.toContain('PRIVATE');
        // An escaped interior quote at the deeper level does not end the value.
        expect(redactText(JSON.stringify({ detail: JSON.stringify({ token: 'a"PRIVATE b' }) }))).not.toContain('PRIVATE');
    });

    it('treats a `***` in the input as text, not as a mask', () => {
        expect(redactText('password=*** PRIVATE_SUFFIX')).toBe('password=***');
        expect(redactText('Cookie: ***, PRIVATE_SUFFIX')).toBe('Cookie=***');
        expect(redactPlainSecrets('password=*** PRIVATE_SUFFIX')).toBe('password=***');
        // A mask a pass wrote still keeps the text after it.
        expect(redactText('GET https://host.example/?token=`a b` ok')).toBe('GET https://host.example/?token=*** ok');
    });

    it('strips control bytes that could split a credential name, keeping tabs and line endings', () => {
        expect(redactText('token\u0000=PRIVATE')).toBe('token=***');
        expect(redactText('to\u0008ken\u007f=PRIVATE')).toBe('token=***');
        expect(redactText(JSON.stringify({ error: 'token\u0001=PRIVATE' }))).not.toContain('PRIVATE');
        expect(redactText('a\tb\r\nc\u0000d')).toBe('a\tb\r\ncd');
        // An escape serialised again goes with its whole backslash run, so no quote is left escaped.
        expect(redactText('{"a":"x\\\\u0000","b":"keep"}')).toBe('{"a":"x","b":"keep"}');
        expect(redactText(JSON.stringify({ detail: JSON.stringify({ error: 'token\u0000=PRIVATE_VALUE' }) }))).not.toContain('PRIVATE');
    });

    it('strips C1 control sequences and controls, raw and serialised, before matching credentials', () => {
        expect(redactText('token\u009b0m=PRIVATE_VALUE')).toBe('token=***');
        expect(redactText('token\u009d0;title\u009c=PRIVATE_VALUE')).toBe('token=***');
        expect(redactText('to\u0085ken=PRIVATE_VALUE')).toBe('token=***');
        expect(redactText('{"error":"token\\u009b0m=PRIVATE_VALUE"}')).not.toContain('PRIVATE');
    });

    it('strips terminal codes serialised more than once before matching credentials', () => {
        expect(redactText(JSON.stringify({ detail: JSON.stringify({ error: 'token\u001b[0m=PRIVATE_VALUE' }) }))).not.toContain('PRIVATE');
        expect(redactText(JSON.stringify({ a: JSON.stringify({ b: JSON.stringify({ error: 'token\u001b[31m=PRIVATE_VALUE' }) }) }))).not.toContain('PRIVATE');
    });

    it('masks the userinfo of a special-scheme URL spelled without `//`, as a URL parser reads it', () => {
        expect(redactText('https:/alice:secret@host.example/x')).toBe('https://***:***@host.example/x');
        expect(redactText('see https:\\\\alice:secret@host.example/x now')).toBe('see https://***:***@host.example/x now');
        expect(redactText('https:alice:secret@host.example')).toBe('https://***:***@host.example/');
        expect(redactText('WSS:/\\alice:secret@host.example')).toBe('wss://***:***@host.example/');
        expect(redactText('https:///alice:secret@host.example/x')).toBe('https://***:***@host.example/x');
        // Without an `@` on its line there is no userinfo, and the text keeps its spelling.
        expect(redactText('the https: scheme, http:/x\nmail bob@example.com')).toBe('the https: scheme, http:/x\nmail bob@example.com');
    });

    it('strips serialised terminal codes before matching credentials', () => {
        // An unquoted value runs to the end of its line, the closing `"}` included: it errs toward hiding.
        expect(redactText(JSON.stringify({ error: 'token\u001b[0m=PRIVATE_VALUE' }))).toBe('{"error":"token=***');
        expect(redactText('token\\x1b[31m=PRIVATE_VALUE')).toBe('token=***');
        expect(redactText(JSON.stringify({ error: 'token\u001b]0;title\u0007=PRIVATE_VALUE' }))).toBe('{"error":"token=***');
        // A serialised OSC never runs past the end of its string.
        expect(redactText('{"a":"\\u001b]0;title","b":"keep"}')).toBe('{"a":"","b":"keep"}');
    });

    it('masks an unquoted password holding spaces, to the next pair or the end of its line', () => {
        expect(redactText('password=correct horse battery staple')).toBe('password=***');
        expect(redactText('login password=correct horse battery staple user=bob\nnext line')).toBe('login password=*** user=bob\nnext line');
        expect(redactText('token: PRIVATE_PREFIX PRIVATE_SUFFIX')).toBe('token=***');
    });

    it('masks a whole array or object credential value, spaced and nested', () => {
        expect(redactText('{ "tokens": [ "PRIVATE" ], "ok": 1 }')).toBe('{ "tokens"=***, "ok": 1 }');
        expect(redactText('{ "credentials": { "value": "PRIVATE", "more": [1, "]"] }, "ok": 1 }')).toBe('{ "credentials"=***, "ok": 1 }');
        expect(redactText('token: [ "PRIVATE"')).not.toContain('PRIVATE');
    });

    it('masks unpadded or truncated Basic values but keeps prose', () => {
        expect(redactText('sent Basic Zm9vOmJhcg')).toBe('sent Basic ***');
        expect(redactText('sent Basic dXNlcjpwYXN')).toBe('sent Basic ***');
        expect(redactText('uses Basic Authentication and basic configuration')).toBe('uses Basic Authentication and basic configuration');
    });

    it('strips OSC sequences, terminated or truncated, before matching credentials', () => {
        expect(redactText('token\u001b]0;title\u0007=PRIVATE_VALUE')).not.toContain('PRIVATE_VALUE');
        expect(redactText('token\u001b]0;title\u001b\\=PRIVATE_VALUE')).not.toContain('PRIVATE_VALUE');
        expect(redactText('ok \u001b]0;never ends\nnext token=PRIVATE_VALUE')).not.toContain('PRIVATE_VALUE');
    });

    it('masks array and object header values whole', () => {
        expect(redactText(JSON.stringify({ headers: { Cookie: ['session=PRIVATE_COOKIE'] } }, null, 2))).not.toContain('PRIVATE_COOKIE');
        expect(redactText(JSON.stringify({ headers: { Authorization: { scheme: 'Bearer', value: 'PRIVATE_AUTH' } } }, null, 2))).not.toContain('PRIVATE_AUTH');
    });

    it('strips every CSI form before matching credentials', () => {
        expect(redactText('token\u001b[?25h=PRIVATE_VALUE')).not.toContain('PRIVATE_VALUE');
        expect(redactText('token\u001b[38:2:1:2:3m=PRIVATE_VALUE')).not.toContain('PRIVATE_VALUE');
        expect(redactText('token\u001b[1 q=PRIVATE_VALUE')).not.toContain('PRIVATE_VALUE');
    });

    it('masks credentials around terminal colour codes', () => {
        expect(redactText('\u001b[31mtoken\u001b[0m=PRIVATE_VALUE')).not.toContain('PRIVATE_VALUE');
        expect(redactText('Authorization: Bearer \u001b[1mPRIVATE_VALUE\u001b[0m')).not.toContain('PRIVATE_VALUE');
        expect(redactText('bearer \u001b[33mPRIVATE_VALUE')).not.toContain('PRIVATE_VALUE');
    });

    it('masks a userinfo holding spaces', () => {
        expect(redactText('failed https://alice:pass word@host.example/x')).toBe('failed https://***@host.example/x');
        expect(redactText('failed //alice:pass word@host.example/x')).toBe('failed //***@host.example/x');
        expect(redactText('failed //alice:part one@PRIVATE_SUFFIX@host.example/x')).toBe('failed //***@host.example/x');
        expect(redactText('failed https://alice:part one@PRIVATE_SUFFIX@host.example/x')).toBe('failed https://***@host.example/x');
        expect(redactText('clone failed: https://alice:PRIVATE_PREFIX PRIVATE_SUFFIX/word@host.example/repo')).not.toMatch(/PRIVATE|alice/);
        expect(redactText('clone failed: //alice:PRIVATE_PREFIX PRIVATE_SUFFIX/word@host.example/repo')).not.toMatch(/PRIVATE|alice/);
        expect(redactText('see https://example.com: docs/a@b')).toBe('see https://example.com: docs/a@b');
        expect(redactText(`//alice:PRIVATE_PREFIX ${'a'.repeat(260)}/PRIVATE_SUFFIX@host.example/repo`)).not.toContain('PRIVATE');
        expect(redactText('https://alice:PRIVATE_PREFIX word://tail@host.example/repo')).not.toMatch(/PRIVATE|alice/);
    });

    it('masks a query value that follows whitespace after the =', () => {
        expect(redactText('GET https://host.example/?token= PRIVATE_VALUE')).not.toContain('PRIVATE_VALUE');
        expect(redactText('GET https://[bad/x?to%6ben= PRIVATE_VALUE')).not.toContain('PRIVATE_VALUE');
        expect(redactText('GET https://[bad/x?token=\nPRIVATE_VALUE')).not.toContain('PRIVATE_VALUE');
        expect(redactText('GET https://[bad/x?token=\u00a0PRIVATE_VALUE')).not.toContain('PRIVATE_VALUE');
    });

    it('masks an unquoted query value holding a quote, backtick or angle bracket', () => {
        expect(redactText('bad https://[bad/x?to%6ben=abc"PRIVATE_SUFFIX')).toBe('bad https://[bad/x?to%6ben=***');
        expect(redactText('bad https://[bad/x?to%6ben=abc`PRIVATE_SUFFIX')).toBe('bad https://[bad/x?to%6ben=***');
        expect(redactText('bad https://[bad/x?to%6ben=abc<PRIVATE_SUFFIX')).toBe('bad https://[bad/x?to%6ben=***');
    });

    it('keeps the quote that closes an attribute around a sensitive query value', () => {
        expect(redactText('<a href="https://[bad/x?to%6ben=abc">x</a>')).toBe('<a href="https://[bad/x?to%6ben=***">x</a>');
    });

    it('masks a sensitive value after a run of question marks', () => {
        // A parsable URL is re-serialised by URL, which percent-encodes the extra `?`s.
        expect(redactText('GET https://host.example/x???token=abc ok')).not.toContain('abc');
        expect(redactText('GET https://[bad/x???token=abc ok')).toBe('GET https://[bad/x???token=*** ok');
    });

    it('masks a backtick-quoted query value', () => {
        expect(redactText('GET https://host.example/?token=`secret value` ok')).toBe('GET https://host.example/?token=*** ok');
        expect(redactText('GET https://[bad/x?to%6ben=`secret value` ok')).toBe('GET https://[bad/x?to%6ben=*** ok');
    });

    it('masks a userinfo whose password holds a query-like pair', () => {
        expect(redactText('failed https://alice:private&token=abc@host.example/x')).toBe('failed https://***:***@host.example/x');
        expect(redactText('failed //alice:private&token=abc@host.example/x')).toBe('failed //***@host.example/x');
    });

    it('masks everything after an unterminated quoted value, which may span lines', () => {
        expect(redactText('failed: password="correct horse battery staple\nnext line')).toBe('failed: password=***');
        expect(redactText('password="first\nPRIVATE_VALUE')).not.toContain('PRIVATE_VALUE');
        expect(redactText("failed: token='correct horse battery staple")).toBe('failed: token=***');
    });

    it('masks the tail of an unterminated quoted query value', () => {
        expect(redactText('GET https://host.example/?token="correct horse battery staple\nok')).toBe('GET https://host.example/?token=***');
    });

    it('masks a quoted query value containing spaces', () => {
        expect(redactText('bad https://[bad/x?password="super secret" next')).toBe('bad https://[bad/x?password=*** next');
    });

    it('masks a sensitive pair inside the value of an ordinary one', () => {
        expect(redactText('a=token=xyz')).toBe('a=token=***');
    });

    it('stays linear on large adversarial input', () => {
        // 256 KiB keeps the suite quick under coverage and parallel load; quadratic forms take minutes here.
        const size = 256 * 1024;
        const inputs = [
            'https://' + 'a'.repeat(size),
            'a'.repeat(size),
            'x'.repeat(size) + '=1',
            'bearer ' + 'a'.repeat(size),
            'https://x' + '.'.repeat(size) + 'a',
            '?a="'.repeat(size / 4),
            'a=b'.repeat(size / 3),
            'a://'.repeat(size / 4),
            'https://h.example/?' + Array.from({ length: size / 16 }, (_, i) => `token${i}=x`).join('&'),
            "password='" + '\\\\'.repeat(size / 2),
            "bearer '" + '\\\\'.repeat(size / 2) + '\n',
            'tokens=[\'' + '\\\\'.repeat(size / 2),
            '\\\\'.repeat(size / 2) + 'u001',
            'token' + '\\\\'.repeat(size / 2) + '=',
            'bearer' + '\\\\'.repeat(size / 2) + 'x',
            '\u009d'.repeat(size / 2),
            '\\\\n'.repeat(size / 3) + 'token',
            'a\\\\n'.repeat(size / 4) + '=',
            '\\a'.repeat(size / 2) + '=',
            '\\aaaa'.repeat(size / 5),
            'token' + '\\\\'.repeat(size / 2) + 't=',
            'https://a:' + '"'.repeat(size),
            ' //'.repeat(size / 3),
            'x://a: '.repeat(size / 7),
            ' //a: '.repeat(size / 6),
            '=//a:'.repeat(size / 5),
            '\u001b]'.repeat(size / 2),
            ' //a:b c'.repeat(size / 8),
            'x://a:b c '.repeat(size / 10),
            'cookie: "'.repeat(size / 9) + '\n',
            'https://a:' + '://'.repeat(size / 3),
            'token="x\n'.repeat(size / 9),
            'token="'.repeat(size / 7),
            '?'.repeat(size),
            'https://[bad/' + '?'.repeat(size),
            'token=`'.repeat(size / 7) + "?a='".repeat(size / 4),
            '?a="'.repeat(size / 4) + '\n',
            'password=a' + ' b'.repeat(size / 2),
            'password=a' + ' b.c'.repeat(size / 4),
            'token=*** '.repeat(size / 10),
            "bearer \\'".repeat(size / 9),
            'bearer \\"\\\\'.repeat(size / 11),
            'https:/a@'.repeat(size / 9),
            'http:x'.repeat(size / 6) + '@',
            '\\u001b]'.repeat(size / 7),
            '\\'.repeat(size) + '"',
            'token=\\\\\\"'.repeat(size / 10),
            '\\\\\\"token\\\\\\":'.repeat(size / 14),
        ];
        for (const input of inputs) {
            const started = performance.now();
            redactText(input);
            expect(performance.now() - started).toBeLessThan(3000);
        }
        // The per-input bound is the check; the test as a whole may run long under coverage and parallel load.
    }, 60_000);

    it('leaves a quoted URL without userinfo alone', () => {
        expect(redactText('<a href="https://host.example/x">docs</a>')).toBe('<a href="https://host.example/x">docs</a>');
    });

    it('leaves an @ in the path of a parsable URL without userinfo alone', () => {
        expect(redactText('see https://github.com/@scope/pkg')).toBe('see https://github.com/@scope/pkg');
    });

    it('redacts a URL glued to a preceding underscore or word', () => {
        expect(redactText('endpoint_https://alice:secret@host.example/x')).toBe('endpoint_https://***:***@host.example/x');
    });

    it('masks a JSON credential value that contains escaped quotes', () => {
        expect(redactText('{"token":"abc\\"def","page":2}')).toBe('{"token"=***,"page":2}');
        expect(redactText("{'secret':'a\\'b'}")).not.toContain('b\'');
    });

    it('masks short Basic and Bearer credentials, but not prose after the word basic', () => {
        expect(redactText('auth failed: Basic YTo=')).toBe('auth failed: Basic ***');
        expect(redactText('header Bearer abc')).toBe('header Bearer ***');
        expect(redactText('see the basic usage guide')).toBe('see the basic usage guide');
    });

    it('masks plain-text key and signature values outside URLs', () => {
        expect(redactText('failed: key=abc signature=def page=2')).toBe('failed: key=*** signature=*** page=2');
    });

    it('masks punctuation that belongs to a sensitive query value', () => {
        expect(redactText('GET https://api.example/?signature=!!!')).toBe('GET https://api.example/?signature=***');
    });

    it('redacts adjacent URLs one by one', () => {
        expect(redactText('https://public.example/a,https://alice:secret@private.example/b')).toBe(
            'https://public.example/a,https://***:***@private.example/b'
        );
    });

    it('still masks sensitive query values when the URL cannot be parsed', () => {
        // The plain-text pass then also recognises `signature=` and, as with `api_key=` above, treats
        // the rest of the token as its value: it errs toward hiding.
        expect(redactText('bad https://[not-a-host/x?signature=grant-access&page=2&key=zz')).toBe(
            'bad https://[not-a-host/x?signature=***'
        );
    });
});

describe('redactEndpoint', () => {
    it('masks each sensitive name once, in its first place, as searchParams.set did', () => {
        expect(redactEndpoint('https://h.example/?token=a&q=x%20y&token=b&page=2')).toBe('https://h.example/?token=***&q=x+y&page=2');
    });

    it('redacts userinfo from URLs', () => {
        expect(redactEndpoint('https://user:secret@example.com/mcp')).toBe(
            'https://***:***@example.com/mcp'
        );
    });

    it('redacts sensitive query parameters', () => {
        expect(redactEndpoint('https://gw.example.com/ws?api_key=abc123&x=1')).toBe(
            'https://gw.example.com/ws?api_key=***&x=1'
        );
        expect(redactEndpoint('https://gw.example.com/ws?token=t&y=2')).toContain('token=***');
    });

    it('keeps ordinary URLs untouched', () => {
        expect(redactEndpoint('https://example.com/path?x=1')).toBe('https://example.com/path?x=1');
        expect(redactEndpoint('127.0.0.1:18789')).toBe('127.0.0.1:18789');
    });
});

describe('uniqSorted', () => {
    it('deduplicates, drops blank and whitespace-only entries, and sorts', () => {
        expect(uniqSorted(['b', 'a', 'b', '', '   ', 'c'])).toEqual(['a', 'b', 'c']);
    });

    it('keeps single values and returns an empty array for blank input', () => {
        expect(uniqSorted(['x'])).toEqual(['x']);
        expect(uniqSorted(['', ' '])).toEqual([]);
    });
});

describe('accessInfo getter fallback semantics', () => {
    it('getEnvVarFromRecord skips non-string values and continues the chain', () => {
        expect(getEnvVarFromRecord({ env: 123, envVar: 'OPENAI_KEY' } as Record<string, unknown>)).toBe('OPENAI_KEY');
        expect(getEnvVarFromRecord({ env: null, environment: 'FOO' } as Record<string, unknown>)).toBe('FOO');
        expect(getEnvVarFromRecord({})).toBeUndefined();
        expect(getEnvVarFromRecord({ env: '', envVar: 'OPENAI_KEY' })).toBe('OPENAI_KEY');
        expect(getEnvVarFromRecord({ envVar: '' })).toBeUndefined();
    });

    it('getFilePathFromRecord skips non-string values and continues the chain', () => {
        expect(getFilePathFromRecord({ path: 42, file: '/tmp/key.pem' } as Record<string, unknown>)).toBe('/tmp/key.pem');
        expect(getFilePathFromRecord({ path: '/tmp/key.pem' })).toBe('/tmp/key.pem');
        expect(getFilePathFromRecord({ path: 'just words' })).toBeUndefined();
    });
});
