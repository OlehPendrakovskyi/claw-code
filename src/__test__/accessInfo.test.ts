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
        // The plain-text pass treats everything after `api_key=` up to whitespace as the value,
        // so later query params go too: it errs toward hiding, never toward showing.
        expect(redactText('GET https://api.example/v1?api_key=abc&page=2 with token=xyz')).toBe(
            'GET https://api.example/v1?api_key=*** with token=***'
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
        expect(redactText('failed https://alice:p"ass@host/x')).toBe('failed https://***@host/x');
        expect(redactText("failed https://alice:p'ass@host/x")).toBe('failed https://***@host/x');
        expect(redactText('failed https://alice:p<ss@host/x')).toBe('failed https://***@host/x');
    });

    it('masks the userinfo of a network-path reference', () => {
        expect(redactText('request //alice:secret@host.example/x failed')).toBe('request //***@host.example/x failed');
        expect(redactText('url="//alice:secret@host.example/x"')).toBe('url="//***@host.example/x"');
        expect(redactText('request //alice:p@ss@host.example/x failed')).toBe('request //***@host.example/x failed');
    });

    it('leaves a path with a double slash and an @ alone', () => {
        expect(redactText('see a//b@c and https://host.example//x@y')).toBe('see a//b@c and https://host.example//x@y');
    });

    it('keeps the backticks around a Markdown-wrapped URL', () => {
        expect(redactText('see `https://alice:secret@host.example/x` here')).toBe('see `https://***:***@host.example/x` here');
        expect(redactText('see `//alice:secret@host.example/x`')).toBe('see `//***@host.example/x`');
    });

    it('masks a userinfo holding a backtick', () => {
        expect(redactText('failed https://alice:p`ass@host.example/x')).toBe('failed https://***@host.example/x');
    });

    it('masks a userinfo holding a nested ://', () => {
        expect(redactText('failed https://alice:p://ss@host.example/x')).toBe('failed https://***@host.example/x');
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

    it('masks the tail of an unterminated quoted value, as in truncated stderr', () => {
        expect(redactText('failed: password="correct horse battery staple\nnext line')).toBe('failed: password=***\nnext line');
        expect(redactText("failed: token='correct horse battery staple")).toBe('failed: token=***');
    });

    it('masks the tail of an unterminated quoted query value', () => {
        expect(redactText('GET https://host.example/?token="correct horse battery staple\nok')).toBe('GET https://host.example/?token=***\nok');
    });

    it('masks a quoted query value containing spaces', () => {
        expect(redactText('bad https://[bad/x?password="super secret" next')).toBe('bad https://[bad/x?password=*** next');
    });

    it('masks a sensitive pair inside the value of an ordinary one', () => {
        expect(redactText('a=token=xyz')).toBe('a=token=***');
    });

    it('stays linear on 1 MiB of adversarial input', () => {
        const size = 1024 * 1024;
        const inputs = [
            'https://' + 'a'.repeat(size),
            'a'.repeat(size),
            'x'.repeat(size) + '=1',
            'bearer ' + 'a'.repeat(size),
            'https://x' + '.'.repeat(size) + 'a',
            '?a="'.repeat(size / 4),
            'a=b'.repeat(size / 3),
            'a://'.repeat(size / 4),
            'https://a:' + '"'.repeat(size),
            ' //'.repeat(size / 3),
            'https://a:' + '://'.repeat(size / 3),
            'token="x\n'.repeat(size / 9),
            '?a="'.repeat(size / 4) + '\n',
        ];
        for (const input of inputs) {
            const started = performance.now();
            redactText(input);
            // Linear work takes tens of milliseconds; the quadratic forms took hours.
            expect(performance.now() - started).toBeLessThan(3000);
        }
    });

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
