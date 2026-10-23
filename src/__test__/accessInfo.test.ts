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
    type AccessInfo,
    type RedactedLabel
} from '../core/accessInfo';
import { redactTextAndSecret, joinBoundary, stripTerminalCodes } from '../core/accessInfo/redact';

const newSets = () => ({
    keySources: new Set<string>(),
    localFiles: new Set<string>(),
    endpoints: new Set<string>(),
    notes: new Set<string>()
});

/** MCP server or tool labels, each built from its entry as extraction builds one. */
const labels = (...entries: unknown[]): RedactedLabel[] => entries.flatMap(entry => formatNamedEntry(entry) ?? []);

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
            tools: labels('read'),
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
                tools: labels('read', 'bash'),
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
            mcpServers: labels('a'),
            tools: labels('t1'),
            keySources: ['Environment variable: A'],
            networkEndpoints: ['https://a'],
            localFiles: ['/a'],
            notes: ['n1']
        });
        const extra = infoWith({
            mcpServers: labels('b'),
            tools: labels('t2'),
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
        const base = infoWith({ tools: labels('t1') });
        const extra = infoWith({ tools: labels('t2') });
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
            mcpServers: labels('gh'),
            tools: labels('read', 'bash'),
            keySources: ['Environment variable: OPENAI_KEY']
        });
        expect(formatAccessSummaryShort(info)).toBe('MCP: 1 | Tools: 2 | Keys: env');
    });

    it('reports errors alongside the counts', () => {
        const info = infoWith({ tools: labels('read') });
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
            mcpServers: labels('gh'),
            tools: labels('read'),
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

    it('redacts a string entry as a whole endpoint, a query value holding a space included', () => {
        expect(formatNamedEntry('https://host.example/?token=prefix PRIVATE_SUFFIX')).toBe('https://host.example/?token=***');
        expect(formatNamedEntry('plain-name')).toBe('plain-name');
    });

    it('redacts an endpoint whose query name a terminal code splits, with userinfo, string and structured', () => {
        const url = 'https://alice:pw@host.example/?to\u001b[0mken=PRIVATE_QUERY&ok=1';
        expect(formatNamedEntry(url)).not.toMatch(/PRIVATE|alice|pw@/);
        expect(formatNamedEntry({ name: 'gh', url })).not.toMatch(/PRIVATE|alice|pw@/);
        // The whole-URL handling of a value holding a space stays.
        expect(formatNamedEntry({ name: 'gh', url: 'https://host.example/?token=prefix PRIVATE_SUFFIX' })).toBe('gh (https://host.example/?token=***)');
    });

    it('redacts a named-entry label as assembled, a credential split across name and endpoint included', () => {
        expect(formatNamedEntry({ name: 'token=', url: 'PRIVATE_VALUE' })).toBe('token= (***)');
        expect(formatNamedEntry({ name: 'Bearer', url: 'PRIVATE_VALUE' })).not.toContain('PRIVATE');
        expect(formatNamedEntry({ name: 'Basic', url: 'dXNlcjpwYXNz' })).toBe('Basic (***)');
        expect(formatNamedEntry({ name: 'https://alice:', url: 'PRIVATE_PASSWORD@host.example/x' })).toBe('https://*** (***)');
        // A password prefix in the name is masked with it, whether the name is a name, an id or the fallback.
        const prefix = 'https://alice:PRIVATE_PREFIX';
        expect(formatNamedEntry({ name: prefix, url: 'PRIVATE_SUFFIX@host.example/x' })).toBe('https://*** (***)');
        expect(formatNamedEntry({ id: prefix, url: 'PRIVATE_SUFFIX@host.example/x' })).toBe('https://*** (***)');
        expect(formatNamedEntry({ url: 'PRIVATE_SUFFIX@host.example/x' }, prefix)).toBe('https://*** (***)');
        // A prefix holding `/`, which the display delimiter would separate from the `@`.
        expect(formatNamedEntry({ name: 'https://alice:PRIVATE_PREFIX/', url: 'PRIVATE_SUFFIX@host.example/x' })).toBe('https://*** (***)');
        // A prefix ending in a tab or line break, which a URL parser drops.
        for (const eol of ['\t', '\n', '\r\n']) {
            expect(formatNamedEntry({ name: `https://alice:PRIVATE_PREFIX${eol}`, url: 'PRIVATE_SUFFIX@host.example/x' })).not.toContain('PRIVATE');
        }
        // A credential earlier in the name does not hide the open userinfo after it, a special scheme without
        // `//` included.
        for (const gap of [' ', '\n']) {
            for (const scheme of ['https://', 'https:']) {
                const label = formatNamedEntry({ name: `auth token=OLD_SECRET${gap}${scheme}alice:PRIVATE_PREFIX/`, url: 'PRIVATE_SUFFIX@host.example/x' });
                expect(label).not.toMatch(/PRIVATE|OLD_SECRET/);
                expect(label).toMatch(/\(\*\*\*\)$/);
            }
        }
        expect(formatNamedEntry({ name: 'https:alice:PRIVATE_PREFIX/', url: 'PRIVATE_SUFFIX@host.example/x' })).toBe('https://*** (***)');
        // A username alone split across the parts, which a token may be, whether the name is a name, an id or the fallback.
        const username = 'https://ghp_PRIVATE_PREFIX';
        const rest = 'PRIVATE_SUFFIX@github.com/repo';
        expect(formatNamedEntry({ name: username, url: rest })).toBe('https://*** (***)');
        expect(formatNamedEntry({ id: username, url: rest })).toBe('https://*** (***)');
        expect(formatNamedEntry({ url: rest }, username)).toBe('https://*** (***)');
        expect(formatNamedEntry({ name: 'https:ghp_PRIVATE_PREFIX\n', url: rest })).not.toContain('PRIVATE');
        // An escaped `@` or a terminal code in either part, which redaction decodes or drops, still marks one.
        expect(formatNamedEntry({ name: username, url: 'PRIVATE_SUFFIX\\u0040github.com/repo' })).toBe('https://*** (***)');
        expect(formatNamedEntry({ name: `${username}\u001b[0m`, url: rest })).toBe('https://*** (***)');
        // An ordinary URL label keeps its endpoint.
        expect(formatNamedEntry({ name: 'https://github.com', url: 'https://github.com/repo' })).toBe('https://github.com (https://github.com/repo)');
        // A credential complete in the name does not cross into an independent endpoint.
        expect(formatNamedEntry({ name: 'remote token="PRIVATE"', url: 'https://api.example/mcp' })).toBe('remote token=*** (https://api.example/mcp)');
        // A name ending in a host and port is no unfinished password unless an `@` follows in the endpoint.
        expect(formatNamedEntry({ name: 'http://localhost:3000', url: 'http://localhost:3000/mcp' })).toBe('http://localhost:3000 (http://localhost:3000/mcp)');
        expect(formatNamedEntry({ name: 'http://127.0.0.1:18789', url: 'ECONNREFUSED' })).toBe('http://127.0.0.1:18789 (ECONNREFUSED)');
        expect(formatNamedEntry({ name: 'https://alice:123', url: 'PRIVATE_SUFFIX@host.example/x' })).toBe('https://*** (***)');
        // A name that redaction only normalises (a terminal code, an escape) keeps its endpoint.
        expect(formatNamedEntry({ name: 'failed\u001b[0m', url: 'https://api.github.com' })).toBe('failed (https://api.github.com)');
        expect(formatNamedEntry({ name: 'fail\\u0065d', url: 'https://api.github.com' })).toBe('failed (https://api.github.com)');
        expect(formatNamedEntry({ name: 'Bearer\u001b[0m', url: 'PRIVATE_VALUE' })).toBe('Bearer (***)');
        // A plain URL name keeps its text.
        expect(formatNamedEntry({ name: 'https://gh.example', url: 'https://gh.example/mcp' })).toBe('https://gh.example (https://gh.example/mcp)');
        expect(formatNamedEntry({ name: 'mail', url: 'bob@example.org' })).toBe('mail (bob@example.org)');
        expect(formatNamedEntry({ name: 'gh', url: 'https://host.example/mcp' })).toBe('gh (https://host.example/mcp)');
    });

    it('redacts a credential the URL parser would percent-encode out of reach, in endpoint labels', () => {
        const url = 'https://user:pw@host.example/?config={"token":"PRIVATE"}';
        expect(formatNamedEntry({ name: 'gh', url })).not.toMatch(/PRIVATE|user:pw/);
        expect(formatNamedEntry(url)).not.toMatch(/PRIVATE|user:pw/);
    });

    it('redacts an extracted endpoint before URL serialisation, through to the report', () => {
        const url = 'https://user:pw@host.example/?config={"token":"PRIVATE_VALUE"}';
        const info = extractAccessInfoFromConfig({ gateway: { url } }, '/tmp/openclaw.json');
        expect(info.networkEndpoints.join('\n')).not.toMatch(/PRIVATE|user:pw/);
        expect(formatAccessSummaryMarkdown(info)).not.toMatch(/PRIVATE|user:pw/);
        const cli = extractAccessInfoFromCli(`gateway ${url}`);
        expect(formatAccessSummaryMarkdown(cli)).not.toMatch(/PRIVATE|user:pw/);
    });

    it('redacts CLI output before cutting URLs out of it, a userinfo split by a tab or line break included', () => {
        for (const sep of ['\t', '\n', '\r\n']) {
            const output = `Gateway: https://alice:PRIVATE_PREFIX${sep}PRIVATE_SUFFIX@host.example/x`;
            const info = extractAccessInfoFromCli(output);
            expect(info.networkEndpoints.join('\n')).not.toContain('PRIVATE');
            expect(formatAccessSummaryMarkdown(info, undefined, undefined, output)).not.toContain('PRIVATE');
        }
    });

    it('redacts names, ids and fallbacks that are whole URLs as endpoints', () => {
        const url = 'https://host.example/?token=PREFIX PRIVATE_SUFFIX';
        expect(formatNamedEntry({ name: url })).not.toContain('PRIVATE');
        expect(formatNamedEntry({ id: url })).not.toContain('PRIVATE');
        expect(formatNamedEntry({}, url)).not.toContain('PRIVATE');
        expect(formatNamedEntry(42, url)).not.toContain('PRIVATE');
    });

    it('judges a credential split across name and endpoint on the raw name, quoted forms included', () => {
        expect(formatNamedEntry({ name: 'Bearer "PRIVATE_PREFIX', url: 'PRIVATE_SUFFIX"' })).not.toContain('PRIVATE');
        expect(formatNamedEntry({ id: 'Bearer "PRIVATE_PREFIX', url: 'PRIVATE_SUFFIX"' })).not.toContain('PRIVATE');
        expect(formatNamedEntry({ url: 'PRIVATE_SUFFIX"' }, 'Bearer "PRIVATE_PREFIX')).not.toContain('PRIVATE');
        expect(formatNamedEntry({ name: "token='PRIVATE_PREFIX", url: "PRIVATE_SUFFIX'" })).not.toContain('PRIVATE');
    });

    it('uses the redacted fallback when redaction empties an entry or its name', () => {
        expect(formatNamedEntry('\u001b[0m', 'token=PRIVATE_VALUE')).toBe('token=***');
        expect(formatNamedEntry({ name: '\u001b[0m' }, 'token=PRIVATE_VALUE')).toBe('token=***');
        expect(formatNamedEntry({ name: '\u001b[0m', url: '\u001b[0m' }, 'token=PRIVATE_VALUE')).toBe('token=***');
        // A fallback that redaction empties too becomes `***`, never empty.
        expect(formatNamedEntry(true, '\u001b]0;token=PRIVATE_VALUE\u0007')).toBe('***');
    });

    it('redacts names, ids and fallbacks in named entries', () => {
        expect(formatNamedEntry({ name: 'token=PRIVATE' })).not.toContain('PRIVATE');
        expect(formatNamedEntry({ id: 'https://alice:secret@[bad' })).not.toMatch(/alice|secret/);
        expect(formatNamedEntry({}, 'token=PRIVATE')).not.toContain('PRIVATE');
        expect(formatNamedEntry(42, 'token=PRIVATE')).not.toContain('PRIVATE');
    });

    it('keeps the endpoint beside a masked credential in MCP server and tool labels, from extraction to the report', () => {
        const info = extractAccessInfoFromConfig(
            {
                mcpServers: [{ name: 'remote token="PRIVATE_VALUE"', url: 'https://api.example/mcp' }],
                tools: { fetch: { name: "fetch password='PRIVATE_VALUE'", url: 'https://tools.example/fetch' } },
            },
            '/tmp/openclaw.json'
        );
        const markdown = formatAccessSummaryMarkdown(info);
        expect(markdown).toContain('## MCP servers\n- remote token=*** (https://api.example/mcp)');
        expect(markdown).toContain('## Tools\n- fetch password=*** (https://tools.example/fetch)');
        expect(markdown).not.toContain('PRIVATE');
    });

    it('takes MCP server and tool labels only as formatNamedEntry built them', () => {
        // @ts-expect-error raw text is not a RedactedLabel, so it cannot reach the report unredacted
        const raw: AccessInfo['tools'] = ['fetch token=PRIVATE_VALUE'];
        expect(raw).toHaveLength(1);
        expect(labels('fetch token=PRIVATE_VALUE')).toEqual(['fetch token=***']);
    });

    it('redacts malformed endpoints in MCP server and tool labels', () => {
        const info = infoWith({
            mcpServers: labels({ name: 'remote', url: 'https://alice:secret@[bad' }),
            tools: labels('fetch (https://bob:hunter2@[bad)'),
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

    it('masks a spaced password after a `?` in a local file path whole, in both report sections', () => {
        const info = extractAccessInfoFromConfig(
            { credentials: { file: '/run/credentials?password=PRIVATE_PREFIX PRIVATE_SUFFIX/config.json' } },
            '/tmp/openclaw.json'
        );
        const markdown = formatAccessSummaryMarkdown(info);
        expect(markdown).toContain('## Local files\n- /run/credentials?password=***');
        expect(markdown).toContain('Key file: /run/credentials?password=***');
        expect(markdown).not.toContain('PRIVATE');
    });

    it('masks a spaced password after `&` in a local file path whole', () => {
        const info = extractAccessInfoFromConfig(
            { credentials: { file: '/home/user/options&password=PRIVATE_PREFIX PRIVATE_SUFFIX/config.json' } },
            '/tmp/openclaw.json'
        );
        const markdown = formatAccessSummaryMarkdown(info);
        expect(markdown).toContain('- /home/user/options&password=***');
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
    it('masks a credential whose name repeated serialised control escapes split, keeping Windows paths', () => {
        for (const name of ['to\b\bken', 't\bo\bken', 't\no\tken', 'pa\fss\rword']) {
            expect(redactText(JSON.stringify({ error: `${name}=PRIVATE_VALUE` }))).not.toContain('PRIVATE');
        }
        expect(redactText('{"p":"C:\\\\temp\\\\bin\\\\app.exe","ok":1}')).toBe('{"p":"C:\\\\temp\\\\bin\\\\app.exe","ok":1}');
    });

    it('masks a known secret holding a URL whose host the URL parser lowercases (redactTextAndSecret)', () => {
        const secret = 'opaque_ftp://alice:pw@PRIVATE_HOST/path';
        expect(redactTextAndSecret(`failed: ${secret}`, secret)).toMatch(/^failed: \*\*\*[:*]*$/);
        expect(redactTextAndSecret(`failed: prefix_${secret}`, secret)).not.toMatch(/private_host|path|opaque/i);
        // Unrelated text keeps its case and its delimiters beside a mask.
        expect(redactTextAndSecret('token="PRIVATE" Host ok', secret)).toBe('token=*** Host ok');
    });

    it('masks a known secret in any case beside a character that lowercasing lengthens (redactTextAndSecret)', () => {
        expect(redactTextAndSecret('İ abc', 'ABC')).toBe('İ ***');
        expect(redactTextAndSecret('İ failed abc.example/x', 'ABC.example')).toBe('İ failed ***/x');
    });

    it('masks a non-ASCII secret echoed with \\u escapes, in either hex case (redactTextAndSecret)', () => {
        const secret = 'opaque-秘密_PRIVATE_VALUE';
        expect(redactTextAndSecret('boom opaque-\\u79d8\\u5bc6_PRIVATE_VALUE', secret)).toBe('boom ***');
        expect(redactTextAndSecret('boom opaque-\\u79D8\\u5BC6_PRIVATE_VALUE', secret)).toBe('boom ***');
        expect(redactTextAndSecret('boom opaque-\\ud83d\\udd11x', 'opaque-🔑x')).toBe('boom ***');
        // Raw and escaped units mixed, and an escape serialised again.
        expect(redactTextAndSecret('authentication failed: opaque-\\u79d8密_PRIVATE_VALUE', secret)).toBe('authentication failed: ***');
        expect(redactTextAndSecret('authentication failed: opaque-秘\\\\u5BC6_PRIVATE_VALUE', secret)).toBe('authentication failed: ***');
    });

    it('masks a known secret holding a backslash, a quote or a line break at any serialisation depth (redactTextAndSecret)', () => {
        for (const secret of ['opaque-\\PRIVATE_SUFFIX', 'opaque-"PRIVATE_SUFFIX', 'opaque-\nPRIVATE_SUFFIX']) {
            let echo = secret;
            for (let depth = 1; depth <= 4; depth++) {
                echo = JSON.stringify(echo);
                expect(redactTextAndSecret(`boom ${echo}`, secret)).not.toMatch(/PRIVATE_SUFFIX|opaque/);
            }
        }
    });

    it('masks a known secret holding a URL whose internationalised host the URL parser punycodes (redactTextAndSecret)', () => {
        const secret = 'opaque_ftp://alice:pw@例え.example/PRIVATE_PATH';
        expect(redactTextAndSecret(`failed ${secret}`, secret)).toBe('failed ***');
        expect(redactTextAndSecret(`failed prefix_${secret}`, secret)).not.toMatch(/PRIVATE_PATH|xn--|例え/);
    });

    it('masks a malformed URL password holding both a `/` and a tab or line break', () => {
        for (const eol of ['\t', '\n', '\r\n']) {
            expect(redactText(`clone https://alice:PRIVATE_PREFIX/part${eol}PRIVATE_SUFFIX@host.example/repo failed`)).toBe('clone https://***@host.example/repo failed');
        }
        // A host and port with a path keeps the next line, an address on it included.
        expect(redactText('see https://host:8080/path\nbob@example.org ok')).toBe('see https://host:8080/path\nbob@example.org ok');
    });

    it('masks a malformed URL password holding both a `/` and a space (issue #43 case 1)', () => {
        // The password holds both a `/` and a space, which is no host:port and the authority
        // does not parse as a whole — userinfo runs to the last `@`, `/` and whitespace included.
        expect(redactText('clone https://alice:PRIVATE_PREFIX/PRIVATE_SUFFIX with space@host.example/repo failed')).not.toContain('PRIVATE_PREFIX');
        expect(redactText('clone https://alice:PRIVATE_PREFIX/PRIVATE_SUFFIX with space@host.example/repo failed')).not.toContain('PRIVATE_SUFFIX');
        expect(redactText('clone https://alice:PRIVATE_PREFIX/PRIVATE_SUFFIX with space@host.example/repo failed')).toContain('***');
    });

    it('joins a URL userinfo fragment with a continuation in structured error details (issue #43 cases 2, 3)', () => {
        const message = 'https://alice:PRIVATE_PREFIX/';
        const details = { reason: 'PRIVATE_SUFFIX@host.example/x' };
        expect(joinBoundary(message, JSON.stringify(details, null, 2)).maskRight).toBe(true);
        expect(joinBoundary(message, JSON.stringify(details, null, 2)).left).not.toContain('PRIVATE_PREFIX');
        // A spaced continuation across the join.
        const { left: out, maskRight } = joinBoundary('https://alice:PRIVATE_PREFIX/', 'PRIVATE_SUFFIX with space@host.example/x');
        expect(maskRight).toBe(true);
        expect(out).toContain('***');
        expect(out).not.toContain('PRIVATE_PREFIX');
    });

    it('still joins a credential whose left side terminal codes leave unchanged (issue #43 case 2)', () => {
        // The left fragment is not the text redaction keeps (a terminal code comes out first), but it holds
        // no credential of its own: the `@` the details add is still what completes the userinfo across the
        // join. Raw equality would read the normalisation difference as an existing mask and skip the check.
        const message = '\u001b[31mhttps://alice:PRIVATE_PREFIX/\u001b[0m';
        const details = { reason: 'PRIVATE_SUFFIX@host.example/x' };
        const { left, maskRight } = joinBoundary(message, JSON.stringify(details, null, 2));
        expect(maskRight).toBe(true);
        expect(left).not.toContain('PRIVATE_PREFIX');
    });

    it('joins a userinfo continuation even when the left side already masks an earlier credential (issue #43 case 2)', () => {
        // The left carries an earlier, independent credential (`token=…`), which masks on its own. The join
        // still forms a second credential across it, and requiring the whole left side to be credential-free
        // would skip it. The earlier mask is kept; the joined credential is what the cut covers.
        const message = 'auth token=OLD_SECRET https://alice:PRIVATE_PREFIX/';
        const details = { reason: 'PRIVATE_SUFFIX@host.example/x' };
        const { left, maskRight } = joinBoundary(message, JSON.stringify(details, null, 2));
        expect(maskRight).toBe(true);
        expect(left).not.toContain('PRIVATE_PREFIX');
        expect(left).not.toContain('OLD_SECRET');
    });

    it('does not mask a credential-free right side that only terminal codes change (issue #43 case 2)', () => {
        // Redaction leaves the right as its normalised form: the ANSI codes come out but no credential
        // appears, so the join holds none. Comparing the joined redaction with the raw right would read the
        // normalisation as a credential, cut the message at its first two characters and mask benign text.
        const { left, maskRight } = joinBoundary('failed', '\u001b[31mquota exceeded\u001b[0m');
        expect(maskRight).toBe(false);
        expect(left).toBe('failed');
    });

    it('joins a split credential when the right side also holds an independent credential (issue #43 case 2)', () => {
        // Both sides carry a credential: `right` masks its own `token=OTHER`, so comparing it with its normalised
        // form says nothing about the join. What the join forms is what the joined redaction masks beyond
        // each side's own (`password` + `=PRIVATE`, `?tok` + `en=PRIVATE`).
        for (const [left, right] of [['password', '=PRIVATE token=OTHER'], ['https://host.example/?tok', 'en=PRIVATE token=OTHER']]) {
            const boundary = joinBoundary(left, right);
            expect(boundary.maskRight).toBe(true);
            expect(boundary.left).not.toContain('PRIVATE');
        }
        // A userinfo whose `@` comes in pretty-printed details after an independent token, on either side of it.
        for (const details of [{ token: 'OTHER', reason: 'PRIVATE_SUFFIX@host.example/x' }, { reason: 'PRIVATE_SUFFIX@host.example/x', token: 'OTHER' }]) {
            const boundary = joinBoundary('https://alice:PRIVATE_PREFIX/', JSON.stringify(details, null, 2));
            expect(boundary.maskRight).toBe(true);
            expect(boundary.left).not.toContain('PRIVATE_PREFIX');
        }
        // Look-alikes: a `host:port` before a detail with an `@`, and an independent detail credential, stay as they are.
        expect(joinBoundary('see https://host.example:8080/', JSON.stringify({ reason: 'mail admin@example.com' }, null, 2))).toEqual({ left: 'see https://host.example:8080/', maskRight: false });
        expect(joinBoundary('request failed', JSON.stringify({ token: 'OTHER' }))).toEqual({ left: 'request failed', maskRight: false });
    });

    it('does not read an escape or terminal code split across the join as a credential (issue #43 case 2)', () => {
        // `fail\\u00` + `65d` decodes to `failed` only when the two are normalised together, and the shown label
        // keeps them apart: each side is normalised on its own, so the join forms nothing and nothing is cut.
        expect(joinBoundary('fail\\u00', '65d')).toEqual({ left: 'fail\\u00', maskRight: false });
        expect(joinBoundary('fail\u001b[', '31m quota exceeded')).toEqual({ left: 'fail\u001b[', maskRight: false });
        expect(formatNamedEntry({ name: 'fail\\u00', url: '65d.example' })).toBe('fail\\u00 (65d.example)');
    });

    it('joins a special scheme spelled without `//` to a structured or spaced continuation', () => {
        // `https:alice:PREFIX/` and `https:/alice:PREFIX/` are userinfo to a URL parser; the delimited probe reads
        // the left with that spelling normalised, as the direct probe does, or the continuation would be shown.
        for (const name of ['https:alice:PRIVATE_PREFIX/', 'https:/alice:PRIVATE_PREFIX/']) {
            for (const right of [JSON.stringify({ reason: 'PRIVATE_SUFFIX@host.example/x' }, null, 2), 'PRIVATE_SUFFIX with space@host.example/x']) {
                expect(joinBoundary(name, right)).toEqual({ left: 'https://***', maskRight: true });
                expect(formatNamedEntry({ name, url: right })).not.toContain('PRIVATE');
            }
        }
    });

    it('keeps the label through its mask when an unterminated OSC or DCS ends the left side', () => {
        // Normalising the left with the probe's tail would let the open sequence swallow the tail: no mask would
        // remain and the label would be cut to `ht`. The left is normalised on its own.
        for (const open of ['\u001b]', '\u001bP']) {
            for (const right of ['PRIVATE_SUFFIX@host.example/x', 'PRIVATE_SUFFIX with x@host.example/x']) {
                expect(joinBoundary(`https://alice:PRIVATE_PREFIX/${open}`, right)).toEqual({ left: 'https://***', maskRight: true });
                expect(formatNamedEntry({ name: `https://alice:PRIVATE_PREFIX/${open}`, url: right })).toBe('https://*** (***)');
            }
        }
    });

    it('masks the value after a label that ends at a credential even when the label holds an earlier one', () => {
        // The label's own `token="OLD"` (or userinfo) masks on its own; it must not exempt the label from ending
        // at `Bearer`, or the value joined after it is shown as it is (`token=*** Bearer (PRIVATE)`).
        for (const name of ['token="OLD" Bearer', 'token=OLD\nBearer', 'https://alice:OLD@host.example/ Bearer']) {
            const label = formatNamedEntry({ name, url: 'PRIVATE' });
            expect(label).not.toContain('PRIVATE');
            expect(label).not.toContain('OLD');
        }
    });

    it('masks a malformed URL password holding an earlier `@` and a space up to the last `@` on the line', () => {
        // The `@` before the space does not end the password while the URL up to the space does not parse
        // (`alice:PRIVATE_PREFIX` is no host and port): stopping there would leave `middle with PRIVATE_SUFFIX` behind.
        expect(redactText('https://alice:PRIVATE_PREFIX/part@middle with PRIVATE_SUFFIX@host.example/x')).toBe('https://***@host.example/x');
        // A tab or line break, which a URL parser drops, does not end it either.
        for (const brk of ['\t', '\n', '\r\n']) {
            expect(redactText(`https://alice:PRIVATE_PREFIX/part@middle${brk}PRIVATE_SUFFIX@host.example/x`)).toBe('https://***@host.example/x');
        }
        // Look-alikes: a URL that parses with its `@` is complete, and an `@` in a parsable path is no userinfo.
        expect(redactText('https://alice:pw@host.example/a see bob@example.org')).toBe('https://***:***@host.example/a see bob@example.org');
        expect(redactText('https://host.example:8080/a@b see bob@example.org')).toBe('https://host.example:8080/a@b see bob@example.org');
    });

    it('keeps a malformed URL password whole through an earlier `@` and a nested `://` while its URL does not parse', () => {
        // The `@` after `part` does not end the password, and neither does the `://` after it: stopping at either
        // would leave `PRIVATE_SUFFIX` visible.
        expect(redactText('https://alice:PRIVATE/part@PRIVATE_SUFFIX/word://tail with x@host.example/x')).toBe('https://***@host.example/x');
        expect(redactText('https://alice:PRIVATE/part@PRIVATE_SUFFIX/word://tail@host.example/x')).toBe('https://***@host.example/x');
        // Look-alike: a URL that parses with its `@` ends where it ends, and a nested URL in its query is its own.
        expect(redactText('https://alice:pw@host.example/r?u=https://other.example/x see bob@example.org')).toBe('https://***:***@host.example/r?u=https://other.example/x see bob@example.org');
    });

    it('joins a split query credential even when re-serialising the URL lengthens the output', () => {
        // `é` becomes `%C3%A9` when the joined URL is serialised, which outweighs the masked one-character value:
        // a length comparison would miss the `?token=x` the join forms.
        expect(joinBoundary('https://host/é?tok', 'en=x')).toEqual({ left: 'https://host/%C3%A9?token=***', maskRight: true });
        expect(formatNamedEntry({ name: 'https://host/é?tok', url: 'en=x' })).not.toContain('(en=x)');
        // Look-alike: serialising drops a default port without masking anything, which forms no credential.
        expect(joinBoundary('https://host.example:443', 'x')).toEqual({ left: 'https://host.example:443', maskRight: false });
    });

    it('does not cut a label when joining it to the right side masks less than masking them apart', () => {
        // `pass=PRIVATE` masks on its own, but `nearbypass` is no whole sensitive key: the join hides nothing more,
        // so it forms no credential, and the label is not cut at a mask that is not there (`ne`).
        expect(joinBoundary('nearby', 'pass=PRIVATE')).toEqual({ left: 'nearby', maskRight: false });
        expect(formatNamedEntry({ name: 'nearby', url: 'pass=PRIVATE' })).toBe('nearby (pass=***)');
    });

    it('does not read a literal `***` or a side\'s own mask as one the join formed (issue #63 case 6)', () => {
        // A literal `***` in the input is no mask the join produced.
        expect(joinBoundary('*** nearby', 'pass=PRIVATE')).toEqual({ left: '*** nearby', maskRight: false });
        expect(formatNamedEntry({ name: '*** nearby', url: 'pass=PRIVATE' })).toBe('*** nearby (pass=***)');
        // The join masks less (`thenpass` is no whole key), while the left's own credential leaves a mask in both
        // renderings: the join hides nothing the sides show apart.
        expect(joinBoundary('see https://alice:pw@h.example/ then', 'pass=PRIVATE')).toEqual({ left: 'see https://alice:pw@h.example/ then', maskRight: false });
        expect(formatNamedEntry({ name: 'see https://alice:pw@h.example/ then', url: 'pass=PRIVATE' })).toBe('see https://***:***@h.example/ then (pass=***)');
        // A credential the left side carries on into the right still masks the right, beside a literal `***`.
        expect(joinBoundary('*** token=PRIVATE_PREFIX', 'PRIVATE_SUFFIX more')).toEqual({ left: '*** token=PRIVATE_PREFIX', maskRight: true });
        expect(formatNamedEntry({ name: '*** token=PRIVATE_PREFIX', url: 'PRIVATE_SUFFIX more' })).toBe('*** token=*** (***)');
    });

    it('ends a malformed URL password run at U+2028 and U+2029 as at a line break', () => {
        // The run goes to the last `@` on its line; the line and paragraph separators end a line as LF does, so an
        // email on the next line is no part of the password.
        for (const brk of ['\u2028', '\u2029', '\n']) {
            for (const text of [`https://alice:note/part ${brk}mail bob@example.org`, `https://alice:note ${brk}mail bob@example.org`]) {
                expect(redactText(text)).toBe(text);
            }
        }
    });

    it('ends a network-path password run at U+2028 and U+2029 as at a line break (issue #63 case 7)', () => {
        // The `//` form reads lines as the `https://` form does: neither a password run nor the search for a path
        // after a port-like prefix goes past a line or paragraph separator.
        for (const brk of [' ', ' ', '\n', '\r']) {
            for (const text of [
                `see //alice:note ${brk}mail bob@example.org`,
                `see //alice:note/part ${brk}mail bob@example.org`,
                `see //host:8080 ${brk}/docs@example.org`,
            ]) {
                expect(redactText(text)).toBe(text);
            }
            // A password on the line before the separator is still masked.
            expect(redactText(`fetch //alice:pass PRIVATE_SUFFIX/x@host.example/repo${brk}mail bob@example.org`))
                .toBe(`fetch //***@host.example/repo${brk}mail bob@example.org`);
        }
    });

    it('parses each URL prefix once across the scan gates, the host check and the userinfo end', () => {
        // R77: the costly property is asked once per match. Count how often the parser sees one prefix: a
        // malformed one the whitespace gate, the host check and `parsable` all ask about, and a parsable one
        // the nested-`://` gate and `parsable` both ask about.
        const cases = [
            { prefix: 'https://alice:PRIVATE_PREFIX/part@middle', text: 'https://alice:PRIVATE_PREFIX/part@middle with PRIVATE_SUFFIX@host.example/x', expected: 'https://***@host.example/x' },
            { prefix: 'https://alice:pw@host.example/r?u=https', text: 'https://alice:pw@host.example/r?u=https://other.example/x', expected: 'https://***:***@host.example/r?u=https://other.example/x' },
        ];
        for (const { prefix, text, expected } of cases) {
            let seen = 0;
            class CountingURL extends URL {
                constructor(url: string | URL, base?: string | URL) {
                    seen += String(url) === prefix ? 1 : 0;
                    super(url, base);
                }
                static override canParse(url: string | URL, base?: string | URL): boolean {
                    seen += String(url) === prefix ? 1 : 0;
                    return super.canParse(url, base);
                }
            }
            vi.stubGlobal('URL', CountingURL);
            try {
                expect(redactText(text)).toBe(expected);
            } finally {
                vi.unstubAllGlobals();
            }
            expect(seen).toBe(1);
        }
    });

    it('masks a malformed URL up to its last `@` when the same-line run does not apply', () => {
        // The invalid port makes the URL malformed, and its userinfo runs to its last `@`, not to the first
        // authority `@`; the quote keeps a later pass from finding that last `@`.
        expect(redactText('https://alice:pass@middle:bad/path"PRIVATE_SUFFIX@host.example')).not.toContain('PRIVATE_SUFFIX');
        expect(redactText('https://alice:pass@middle:bad/path"PRIVATE_SUFFIX@host.example')).not.toContain('pass');
    });

    it('masks a malformed URL password holding a space and scheme-like text up to the last `@` on the line', () => {
        // `word://` after the space is part of the password, not a new URL: starting one there would leave the
        // password's prefix visible (`https://alice:PRIVATE_PREFIX/part with word://***@host`).
        expect(redactText('https://alice:PRIVATE_PREFIX/part with word://tail@host.example/x')).toBe('https://***@host.example/x');
        expect(redactText('clone https://alice:PRIVATE_PREFIX/part word://x://tail@host.example/x failed')).toBe('clone https://***@host.example/x failed');
        // Look-alike: a `host:port` reference keeps the prose after it, and a later URL's own userinfo is masked
        // on its own.
        expect(redactText('see https://host.example:8080 docs and wss://other@host.example/x')).toBe('see https://host.example:8080 docs and wss://***@host.example/x');
    });

    it('asserts what formatNamedEntry emits for a credential split across name and endpoint (issue #43 case 3)', () => {
        // Case 3 is a regression in a caller, not in joinBoundary: the label must not carry the credential.
        expect(formatNamedEntry({ name: 'https://alice:PRIVATE_PREFIX/', url: 'PRIVATE_SUFFIX@host.example/x' })).not.toContain('PRIVATE');
        expect(formatNamedEntry({ name: 'Bearer', url: 'PRIVATE_TOKEN' })).not.toContain('PRIVATE');
    });

    it('masks a quoted URL query value across a line break up to the next `&` or `#`', () => {
        for (const delimiter of ['&', '#']) {
            const text = `fetch "https://host.example/?token=PREFIX\nPRIVATE_SUFFIX${delimiter}ok=1" failed`;
            expect(redactText(text)).toMatch(/^fetch "https:\/\/host\.example\/\?token=\*\*\*/);
            expect(redactText(text)).not.toContain('PRIVATE');
            expect(redactText(JSON.stringify({ reason: text }))).not.toContain('PRIVATE');
        }
        // An unclosed string gives no end: the value runs, as an unquoted one, across breaks to a space.
        for (const eol of ['\n', '\r\n', '\t']) {
            expect(redactText(`fetch "https://host.example/?token=PREFIX${eol}PRIVATE_SUFFIX`)).not.toContain('PRIVATE');
            expect(redactText(JSON.stringify({ reason: `fetch "https://host.example/?token=PREFIX${eol}PRIVATE_SUFFIX` }))).not.toContain('PRIVATE');
        }
        expect(redactText('fetch "https://host.example/?token=PRIVATE\nnext line&x')).not.toContain('PRIVATE');
    });

    it('keeps the host and port of a credential-free URL whose host holds a secret word', () => {
        for (const url of ['https://keycloak.example:8443/mcp', 'https://token-service.example:443', 'wss://secret.example:9000?x=1']) {
            expect(redactText(url)).toBe(url);
            expect(redactText(`see ${url} ok`)).toBe(`see ${url} ok`);
        }
        expect(formatNamedEntry({ name: 'auth', url: 'https://keycloak.example:8443/mcp' })).toBe('auth (https://keycloak.example:8443/mcp)');
        // A userinfo is still masked, and a digit password is no port.
        expect(redactText('https://alice:pw@keycloak.example:8443/x')).toBe('https://***:***@keycloak.example:8443/x');
        expect(redactPlainSecrets('//token:1234@host')).not.toContain('1234');
    });

    it('masks a spaced secret after an `&` that opens no query to the end of its line', () => {
        expect(redactText('auth failed: options=x&password=PRIVATE_PREFIX PRIVATE_SUFFIX\nnext')).toBe('auth failed: options=x&password=***\nnext');
        expect(redactText('/home/user/options&password=PRIVATE_PREFIX PRIVATE_SUFFIX/config.json')).toBe('/home/user/options&password=***');
        // In a query a space still ends the value, so the prose after the URL survives.
        expect(redactText('see https://h.example/?a=1&token=PRIVATE then prose')).toBe('see https://h.example/?a=1&token=*** then prose');
        expect(redactText('?x=1&token=PRIVATE ok')).toBe('?x=1&token=*** ok');
        // A `?` with no `://` before it in its token is a path character, not a query: the value runs to the line end.
        expect(redactText('c?x=1&token=PRIVATE ok')).toBe('c?x=1&token=***');
        expect(redactText('/run/credentials?password=PRIVATE_PREFIX PRIVATE_SUFFIX/config.json')).toBe('/run/credentials?password=***');
    });

    it('strips a control sequence nested in another, raw or serialised', () => {
        expect(redactText('to\u001b[\u001b[0m0mken=PRIVATE_VALUE')).toBe('token=***');
        expect(redactText('to\u001b[1\u001b[\u001b[0m;2m3mken=PRIVATE_VALUE')).toBe('token=***');
        expect(redactText(JSON.stringify({ e: 'to\u001b[\u001b[0m0mken=PRIVATE_VALUE' }))).not.toContain('PRIVATE');
        // A sequence broken by a byte that fits none is dropped, its parameters too; the byte stays, unless it
        // opens a run of tabs and line breaks, which goes with it so no name is split.
        expect(redactText('a\u001b[\u0000b')).toBe('ab');
        for (const eol of ['\t', '\n', '\r\n', '\n\n']) {
            expect(redactText(`to\u001b[${eol}ken=PRIVATE_VALUE`)).toBe('token=***');
            expect(redactText(`to\u001b[1${eol}ken=PRIVATE_VALUE`)).toBe('token=***');
        }
        // A sequence whose printable bytes are escaped too, raw or in a details string.
        expect(redactText('to\\u001b\\u005b0mken=PRIVATE_VALUE')).toBe('token=***');
        expect(redactText(JSON.stringify({ reason: 'to\\u001b\\u005b0mken=PRIVATE_VALUE' }))).not.toContain('PRIVATE');
        expect(redactText('to\u001b[0\u0000ken=PRIVATE_VALUE')).toBe('token=***');
        expect(redactText('to\u001b[\u001b[0\u0000ken=PRIVATE_VALUE')).toBe('token=***');
    });

    it('keeps a terminal code\'s final byte that completes a credential label (issue #56)', () => {
        // `ESC[t` is a whole CSI sequence: stripping all of it would take the label's first letter.
        expect(redactText('\u001b[token=PRIVATE_VALUE')).toBe('token=***');
        expect(redactText('\u001b[pass=PRIVATE_VALUE')).toBe('pass=***');
        expect(redactText('\u001b[bearer PRIVATE_VALUE')).toBe('bearer ***');
        expect(redactText('\u001b(token=PRIVATE_VALUE')).toBe('token=***');
        // The final byte may end the label as well as start it.
        expect(redactText('toke\u001b[n=PRIVATE_VALUE')).toBe('token=***');
        const leaks = ['\u001b[token=PRIVATE_VALUE', '\u001b(token=PRIVATE_VALUE', 'toke\u001b[n=PRIVATE_VALUE', '\u001b[bearer PRIVATE_VALUE'];
        for (const leak of leaks) {
            for (const escape of ['\\u001b', '\\x1b']) {
                expect(redactText(leak.replace('\u001b', escape))).toBe(redactText(leak));
            }
            expect(redactText(JSON.stringify({ e: leak }))).not.toContain('PRIVATE');
            expect(redactText(JSON.stringify({ d: JSON.stringify({ e: leak }) }))).not.toContain('PRIVATE');
            expect(redactText(JSON.stringify({ e: leak }, null, 2))).not.toContain('PRIVATE');
        }
    });

    it('judges a kept final byte on the text left once every code and control byte is gone (issue #56)', () => {
        // Another code or a control byte between the final byte and the rest of the label.
        expect(redactText('\u001b(t\u0000oken=PRIVATE_VALUE')).toBe('token=***');
        expect(redactText('tok\u0000\u001b(en=PRIVATE_VALUE')).toBe('token=***');
        expect(redactText('\u001b[t\u001b[0moken=PRIVATE_VALUE')).toBe('token=***');
        expect(redactText('\u001b(t\u001b(Boken=PRIVATE_VALUE')).toBe('token=***');
        // However many codes stand between them.
        expect(redactText(`toke${'\u001b[0m'.repeat(26)}\u001b[n=PRIVATE_VALUE`)).toBe('token=***');
        // A byte that a kept neighbour would hide (`mpass` holds no bare `pass`) is judged on its own.
        expect(redactText('\u001b[0m\u001b[pass=PRIVATE_VALUE')).toBe('pass=***');
        // A label that needs two final bytes keeps both.
        expect(redactText('\u001b[t\u001b[oken=PRIVATE_VALUE')).toBe('token=***');
        // `bearer` and `basic` label only as a whole word ending the run, so inside a name they hide no byte.
        expect(redactText('bearertoke\u001b[n=PRIVATE_VALUE')).toBe('bearertoken=***');
        expect(redactText('basictoke\u001b[n=PRIVATE_VALUE')).toBe('basictoken=***');
        expect(redactText('x.bearertoke\u001b[n=PRIVATE_VALUE')).toBe('x.bearertoken=***');
    });

    it('drops the internal final-byte mark from the input (issue #56)', () => {
        expect(stripTerminalCodes('name\ufdd0=value')).toBe('name=value');
        expect(redactText('a\ufdd0token=PRIVATE_VALUE')).toBe('atoken=***');
    });

    it('still strips a final byte that completes no credential label (issue #56)', () => {
        expect(redactText('\u001b[1mname=value')).toBe('name=value');
        expect(redactText('\u001b[0mtoken=PRIVATE_VALUE')).toBe('token=***');
        expect(redactText('\u001b[2Jpassenger=1')).toBe('passenger=1');
        expect(redactText('\u001b[Hbypass=1')).toBe('bypass=1');
        expect(redactText('\u001b(Bname=value')).toBe('name=value');
    });

    it('keeps masking every final-byte shape reviewed for issue #63 cases 8 and 10', () => {
        // A rule that picked one reading of a run's final bytes broke other passes in six review rounds of #81. These
        // shapes each leaked under one of those rules; masking every reading (#82 S-d) must keep masking them.
        expect(redactText('by\u001b(pass=1')).toBe('byass=1');
        expect(redactText('pa\u001b(s\u001b(sx=1')).toBe('pax=1');
        for (const text of [
            'by\u001b(_pass=PRIVATE',
            'pass\u001b(_x=PRIVATE',
            '"\u001b(p\u001b(a\u001b(s\u001b(s\u001b(0\\nx\\":PRIVATE',
            'x-\u001b(p\u001b(a\u001b(s\u001b(s\\t=PRIVATE',
            '?a&\u001b(p\u001b(ass\\":PRIVATE',
            'https://h.example/?to\u001b(ken+x=PRIVATE',
            'https://h.example/?toke\u001b(n\tx=PRIVATE',
            'https://h.example/?toke\u001b(n\\tx=PRIVATE',
            'toke\u001b(n\\bx=PRIVATE',
        ]) {
            expect(redactText(text)).not.toContain('PRIVATE');
        }
        expect(redactText('toke\u001b(n-bearer PRIVATE')).toBe('toke-bearer ***');
        expect(redactText('\u001b[0mtoken=PRIVATE')).toBe('token=***');
        expect(redactText('\u001b(to\u001b(ken more')).toBe('token more');
    });

    it('masks every label spelling a masking pass reads with any of its letters as a final byte (issue #63 case 8)', () => {
        const spellings = ['token', 'api_key', 'api-key', 'apikey', 'key', 'secret', 'password', 'passwd', 'passphrase', 'pass',
            'credential', 'access_key', 'access-key', 'signature', 'authorization', 'cookie', 'set-cookie'];
        for (const word of spellings) {
            for (let at = 0; at < word.length; at++) {
                if (!/[A-Za-z0-9_]/.test(word[at])) {
                    continue;
                }
                const split = `${word.slice(0, at)}\u001b(${word[at]}${word.slice(at + 1)}`;
                expect(redactText(`${split}=PRIVATE`)).not.toContain('PRIVATE');
            }
        }
        for (const word of ['bearer', 'basic']) {
            for (let at = 0; at < word.length; at++) {
                expect(redactText(`${word.slice(0, at)}\u001b(${word[at]}${word.slice(at + 1)} dXNlcjpwYXNz`)).not.toContain('dXNlcjpwYXNz');
            }
        }
    });

    it('masks a value after a run whose final bytes spell both a key and a word (issue #63 case 10)', () => {
        const coded = (word: string): string => word.split('').map(char => `\u001b(${char}`).join('');
        // A key name runs on through a serialised control to the `=`, however far it lies, so the value is hidden; a
        // rule that chose the word here, or looked only a bounded way ahead, let it through in #81.
        for (const word of ['tokenbasic', 'tokenbearer']) {
            expect(redactText(`${coded(word)}\\tx=PRIVATE`)).not.toContain('PRIVATE');
        }
        for (const tail of ['\\'.repeat(512) + 'tx=PRIVATE', `\\t${'x'.repeat(20)}=PRIVATE`, `\\t${'x'.repeat(300)}=PRIVATE`]) {
            expect(redactText(`${coded('tokenbearer')}${tail}`)).not.toContain('PRIVATE');
        }
    });

    it('masks a header, a Basic credential and a two-label run whose final bytes are stripped (issue #63 cases 8 and 10)', () => {
        const coded = (word: string): string => word.split('').map(char => `\u001b(${char}`).join('');
        // Each leaked under a rule tried in #81 that kept only the bytes one label needs.
        // A credential header needs its whole name, not just a key inside it.
        expect(redactText('toke\u001b(n-cooki\u001b(e: "public"; session=PRIVATE')).not.toContain('PRIVATE');
        // A Basic credential keeps the characters that make it one.
        expect(redactText(`Basic ${coded('tokenxyz')}privatevalue`)).toBe('Basic ***');
        expect(redactText(`Basic "${coded('tokenxyz')}privatevalue"`)).not.toContain('privatevalue');
        // Including where no stripped byte is kept, a `pass` a tab may carry on, `=` padding, or a `:` after the value.
        expect(redactText(`Basic ${coded('toxken')}privatevalue`)).toBe('Basic ***');
        expect(redactText(`Basic "${coded('toxken')}privatevalue"`)).not.toContain('privatevalue');
        expect(redactText(`Basic ${coded('token')}pass\tok`)).toBe('Basic ***\tok');
        expect(redactText(`Basic ${coded('token')}pass\\tok`)).toBe('Basic ***\\tok');
        expect(redactText(`Basic ${coded('toxken')}private=`)).toBe('Basic ***');
        expect(redactText(`Basic "${coded('toxken')}private="`)).not.toContain('private');
        // Keeping every byte reads `tokenprivatevalue:public`, a key and its value, so `public` is hidden too (#82 S-d).
        expect(redactText(`Basic ${coded('toxken')}privatevalue:public`)).toBe('Basic ***:***');
        // A reading that holds both a key and a word stays whole.
        expect(redactText(`${coded('key')}.${coded('token')}bearer PRIVATE`)).not.toContain('PRIVATE');
        expect(redactText(`${coded('key')}.${coded('token')}basic dXNlcjpwYXNz`)).not.toContain('dXNlcjpwYXNz');
    });

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
        // The plain-text pass treats everything after `api_key=` to the end of the line as the value, so later
        // query params, words and pairs go too: it errs toward hiding, never toward showing.
        expect(redactText('GET https://api.example/v1?api_key=abc&page=2 with token=xyz')).toBe(
            'GET https://api.example/v1?api_key=***'
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

    it('masks the userinfo of a URL whose username holds whitespace', () => {
        expect(redactText('https://alice smith:PRIVATE_VALUE@host.example/x')).toBe('https://***@host.example/x');
        expect(redactText('https://alice\tsmith:PRIVATE_VALUE@host.example/x')).toBe('https://***@host.example/x');
        expect(formatNamedEntry({ name: 'gh', url: 'https://alice smith:PRIVATE_VALUE@host.example/x' })).not.toContain('PRIVATE');
        // Prose with no `:` after the space keeps its text.
        expect(redactText('see https://example.com and mail bob@example.org')).toBe('see https://example.com and mail bob@example.org');
    });

    it('masks a quoted query value after serialised whitespace', () => {
        const masked = redactText(JSON.stringify({ error: 'https://[bad/x?to%6ben=\t"PRIVATE_PREFIX PRIVATE_SUFFIX"', ok: 1 }));
        expect(masked).not.toContain('PRIVATE');
        expect(masked).toContain('"ok":1');
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

    it('strips serialised C1 OSC sequences before matching credentials', () => {
        expect(redactText('token\\u009d0;title\\u009c=PRIVATE_VALUE')).toBe('token=***');
        expect(redactText('token\\x9d0;title\\x9c=PRIVATE_VALUE')).toBe('token=***');
        expect(redactText(JSON.stringify({ error: 'token\\u009d0;title\\u009c=PRIVATE_VALUE' }))).not.toContain('PRIVATE');
    });

    it('strips DCS, SOS, PM and APC control strings whole, raw, C1 and serialised', () => {
        expect(redactText('to\u001bPq\u001b\\ken=PRIVATE')).toBe('token=***');
        expect(redactText('to\u001b_app\u0007ken=PRIVATE')).toBe('token=***');
        expect(redactText('to\u0090q\u009cken=PRIVATE')).toBe('token=***');
        expect(redactText(JSON.stringify({ e: 'to\u001bPq\u001b\\ken=PRIVATE' }))).not.toContain('PRIVATE');
        expect(redactText('{"e":"to\\u0090q\\u009cken=PRIVATE"}')).not.toContain('PRIVATE');
    });

    it('strips an escape sequence with intermediate bytes (ECMA-35 `ESC I+ F`) or a digit, raw and serialised', () => {
        expect(redactText('to\u001b(Bken=PRIVATE_VALUE')).toBe('token=***');
        expect(redactText('to\u001b#8ken=PRIVATE_VALUE')).toBe('token=***');
        expect(redactText('to\u001b7ken=PRIVATE_VALUE')).toBe('token=***');
        expect(redactText(JSON.stringify({ e: 'to\u001b(Bken=PRIVATE_VALUE' }))).not.toContain('PRIVATE');
        expect(redactText(JSON.stringify({ e: JSON.stringify({ e: 'to\u001b(Bken=PRIVATE_VALUE' }) }))).not.toContain('PRIVATE');
        // A delimiter or a letter after ESC stays, so the label still meets its value.
        expect(redactText('\u001btoken=PRIVATE_VALUE')).toBe('token=***');
        expect(redactText('token\u001b=PRIVATE_VALUE')).toBe('token=***');
        expect(redactText('token\u001b =PRIVATE_VALUE')).not.toContain('PRIVATE');
        expect(redactText(JSON.stringify({ e: 'token\u001b=PRIVATE_VALUE' }))).not.toContain('PRIVATE');
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

    it('masks an unquoted password holding spaces to the end of its line, words that look like pairs included', () => {
        expect(redactText('password=correct horse battery staple')).toBe('password=***');
        expect(redactText('login password=correct horse battery staple user=bob\nnext line')).toBe('login password=***\nnext line');
        // Free-form text cannot show that `page=` starts a field rather than continuing the password.
        expect(redactText('password=correct horse page=PRIVATE_SUFFIX')).toBe('password=***');
        expect(redactText('token: PRIVATE_PREFIX PRIVATE_SUFFIX')).toBe('token=***');
    });

    it('masks a quoted Bearer token across lines to its closing quote', () => {
        expect(redactText('sent Bearer "PRIVATE_PREFIX\nPRIVATE_SUFFIX" ok')).toBe('sent Bearer *** ok');
        expect(redactText("sent Bearer 'PRIVATE_PREFIX\r\nPRIVATE_SUFFIX' ok")).toBe('sent Bearer *** ok');
        // Unterminated, it runs to the end of the text, as a quoted value does.
        expect(redactText('sent Bearer "PRIVATE_PREFIX\nPRIVATE_SUFFIX')).toBe('sent Bearer ***');
    });

    it('masks a backtick-quoted Bearer token, raw, escaped and unterminated', () => {
        expect(redactText('sent Bearer `PRIVATE_VALUE` ok')).toBe('sent Bearer *** ok');
        expect(redactText('sent Bearer `a\\`PRIVATE b` ok')).toBe('sent Bearer *** ok');
        expect(redactText('sent Bearer `PRIVATE_PREFIX PRIVATE_SUFFIX')).toBe('sent Bearer ***');
        expect(redactText(JSON.stringify({ reason: 'sent Bearer `PRIVATE_PREFIX PRIVATE_SUFFIX`', ok: 1 }))).toBe('{"reason":"sent Bearer ***","ok":1}');
    });

    it('masks a quoted or escaped-quoted Basic credential, held to the base64 tests', () => {
        expect(redactText('sent Basic "dXNlcjpwYXNz" ok')).toBe('sent Basic *** ok');
        expect(redactText("sent Basic 'dXNlcjpwYXNz' ok")).toBe('sent Basic *** ok');
        expect(redactText(JSON.stringify({ reason: 'sent Basic "dXNlcjpwYXNz"', ok: 1 }))).toBe('{"reason":"sent Basic ***","ok":1}');
        // Prose in quotes is no credential.
        expect(redactText('uses "Basic" "authentication" here')).toBe('uses "Basic" "authentication" here');
        expect(redactText('Basic "Authentication" mode')).toBe('Basic "Authentication" mode');
    });

    it('masks an unpadded Basic credential that decodes to a user:password pair, bare and quoted', () => {
        expect(redactText('sent Basic ejpzcmtkcw ok')).toBe('sent Basic *** ok');
        expect(redactText('sent Basic "ejpzcmtkcw" ok')).toBe('sent Basic *** ok');
        expect(redactText(JSON.stringify({ reason: 'sent Basic ejpzcmtkcw' }))).not.toContain('ejpzcmtkcw');
        // Short and non-ASCII pairs: `OmE` is `:a`, `w6k6eA` is `é:x`.
        expect(redactText('sent Basic OmE ok')).toBe('sent Basic *** ok');
        expect(redactText('sent Basic "w6k6eA" ok')).toBe('sent Basic *** ok');
        // Prose decodes to no valid UTF-8 pair and is left alone.
        expect(redactText('basic usage, Basic Authentication, basic setup guide, Basic Output')).toBe('basic usage, Basic Authentication, basic setup guide, Basic Output');
    });

    it('masks a sensitive query value across the tabs and line breaks a URL parser drops', () => {
        for (const sep of ['\t', '\n', '\r\n']) {
            expect(redactText(`https://host.example/?token=PREFIX${sep}PRIVATE_SUFFIX`)).toBe('https://host.example/?token=***');
            expect(redactText(`see https://[bad/x?token=PREFIX${sep}PRIVATE_SUFFIX ok`)).not.toContain('PRIVATE');
        }
        // A break that ends the value is left in place.
        expect(redactText('https://[bad/x?token=abc\n')).toBe('https://[bad/x?token=***\n');
    });

    it('masks a query value whose name tabs or line breaks split, as a URL parser reads it', () => {
        for (const sep of ['\t', '\n', '\r\n']) {
            expect(redactText(`https://host.example/?to${sep}ken=PRIVATE_VALUE`)).not.toContain('PRIVATE');
            expect(redactText(`see https://[bad/x?pass${sep}word=PRIVATE_VALUE ok`)).not.toContain('PRIVATE');
            // Serialised, at one and two levels.
            const url = `https://host.example/?to${sep}ken=PRIVATE_VALUE`;
            expect(redactText(JSON.stringify({ reason: url }))).not.toContain('PRIVATE');
            expect(redactText(JSON.stringify(JSON.stringify({ reason: url })))).not.toContain('PRIVATE');
        }
    });

    it('masks a special-scheme URL whose separator or userinfo a tab or line break splits', () => {
        for (const sep of ['\t', '\n', '\r\n']) {
            expect(redactText(`https:${sep}alice:PRIVATE@host.example/x`)).toBe('https://***:***@host.example/x');
            expect(redactText(`https:/alice:PRIVATE${sep}SUFFIX@host.example/x`)).toBe('https://***@host.example/x');
        }
        // Prose keeps its spelling where no `@` follows the scheme within its authority.
        expect(redactText('the https: scheme\nmail bob@example.org')).toBe('the https: scheme\nmail bob@example.org');
        // A username alone split by a break is masked too: a token may sit there.
        for (const sep of ['\t', '\n', '\r\n']) {
            expect(redactText(`clone https:ghp_PRIVATE${sep}SUFFIX@github.com/repo`)).toBe('clone https://***@github.com/repo');
        }
    });

    it('masks a credential whose JSON key is spelled with escapes', () => {
        expect(redactText('{"to\\u006ben":"PRIVATE_VALUE","ok":1}')).toBe('{"token"=***,"ok":1}');
        expect(redactText(JSON.stringify({ detail: '{"to\\u006Ben":"PRIVATE_VALUE"}' }))).not.toContain('PRIVATE');
        expect(redactText('pass\\u0077ord=PRIVATE_VALUE')).toBe('password=***');
        // A backslash escape stays as it is; a quote escape becomes a backslash-escaped quote.
        expect(redactText('{"a":"\\u0022q\\u0022","b":"\\u005c"}')).toBe('{"a":"\\"q\\"","b":"\\u005c"}');
    });

    it('masks a credential quoted with Unicode-escaped quotes, at any depth', () => {
        const json = '{"reason":"\\u0022token\\u0022:\\u0022PRIVATE_VALUE\\u0022","ok":1}';
        expect(redactText(json)).toBe('{"reason":"\\"token\\"=***","ok":1}');
        expect(redactText(JSON.stringify({ detail: json }))).not.toContain('PRIVATE');
        expect(redactText('\\u0022password\\u0022: \\u0022PRIVATE_PREFIX PRIVATE_SUFFIX\\u0022 tail')).toBe('\\"password\\"=*** tail');
        expect(redactText("{\"r\":\"\\u0027token\\u0027: \\u0027PRIVATE_VALUE\\u0027\"}")).not.toContain('PRIVATE');
        expect(redactText('{"r":"token: \\u0060PRIVATE_PREFIX PRIVATE_SUFFIX\\u0060"}')).toBe('{"r":"token=***"}');
        // An escape after an even backslash run spells a quote one layer deeper, which stays escaped there.
        expect(JSON.parse(redactText(JSON.stringify({ a: '{"b":"\\u0022q\\u0022"}' })))).toEqual({ a: '{"b":"\\"q\\""}' });
    });

    it('masks a spaced password with a slash after a prefix that parses as a port', () => {
        expect(redactText('fetch https://alice:123 PRIVATE_SUFFIX/part@host.example/x failed')).toBe('fetch https://***@host.example/x failed');
        expect(redactText(JSON.stringify({ error: 'fetch https://alice:123 PRIVATE_SUFFIX/part@host.example/x failed' }))).not.toContain('PRIVATE');
        // Prose with a real port, or a bare `:`, keeps its text.
        expect(redactText('https://host:8080 see /docs and mail bob@example.org')).toBe('https://host:8080 see /docs and mail bob@example.org');
    });

    it('masks a credential whose name a serialised short escape splits', () => {
        expect(redactText(JSON.stringify({ error: 'to\bken=PRIVATE_VALUE' }))).not.toContain('PRIVATE');
        expect(redactText(JSON.stringify({ error: 'pass\fword: PRIVATE_VALUE' }))).not.toContain('PRIVATE');
        expect(redactText(JSON.stringify({ reason: JSON.stringify({ error: 'to\bken=PRIVATE_VALUE' }) }))).not.toContain('PRIVATE');
        // A Windows path keeps its text.
        expect(redactText('C:\\dir\\bin\\tool.exe ok')).toBe('C:\\dir\\bin\\tool.exe ok');
    });

    it('masks a credential that a JSON backspace or form-feed escape separates from its label', () => {
        expect(redactText(JSON.stringify({ error: 'token\b=PRIVATE_VALUE' }))).not.toContain('PRIVATE');
        expect(redactText(JSON.stringify({ error: 'token\f: PRIVATE_VALUE' }))).not.toContain('PRIVATE');
        expect(redactText(JSON.stringify(JSON.stringify({ error: 'token\b=PRIVATE_VALUE' })))).not.toContain('PRIVATE');
        expect(redactText(JSON.stringify({ error: 'failed\bpassword=PRIVATE_VALUE' }))).not.toContain('PRIVATE');
        // A Windows path keeps its `\b` segments.
        expect(redactText('C:\\bin\\tool.exe ok')).toBe('C:\\bin\\tool.exe ok');
    });

    it('masks a password run after a port-like prefix in every shape reviewed for issue #63 case 5', () => {
        // Case 5 itself stays open (design doc, open question 1): `https://host:8080 see bob@example.org` has the shape
        // of `https://alice:123 PRIVATE_PREFIX PRIVATE_SUFFIX@host`, and a password split between a label and its
        // details looks like it too. These shapes each leaked under a narrower rule tried in #80.
        for (const url of ['https://host:8080', '//host:8080']) {
            expect(redactText(`see ${url} see bob@example.org`)).not.toContain('bob');
        }
        for (const text of [
            'fetch https://alice:123 PRIVATE_PREFIX PRIVATE_SUFFIX@host.example/x',
            'fetch //alice:123 PRIVATE_PREFIX PRIVATE_SUFFIX@host.example/x',
            'fetch https://alice:123 PRIVATE_SUFFIX/part@host.example/x',
            'fetch //alice:99999 PRIVATE_PREFIX PRIVATE_SUFFIX@host.example/x',
            'fetch //alice:123\u00a0PRIVATE_SUFFIX@host.example/x',
            'fetch //alice:123\u2003PRIVATE_SUFFIX@host.example/x',
            'fetch //alice:123\tPRIVATE_PREFIX PRIVATE_SUFFIX@host.example/x',
            'fetch https://alice:123\tPRIVATE_PREFIX PRIVATE_SUFFIX@host.example/x',
            'fetch ssh://alice%20smith:123 PRIVATE_SUFFIX@host.example/x',
            'fetch ssh://alice%23:123 PRIVATE_SUFFIX@host.example/x',
            'https://alice:! PRIVATE_SUFFIX@host.example/x',
            'see //alice:! PRIVATE_SUFFIX@host.example/x',
            'https://alice:123? PRIVATE_SUFFIX@host.example/x',
            'https://alice:123?PRIVATE_PREFIX PRIVATE_SUFFIX@host.example/x',
            'https://alice:123#PRIVATE_PREFIX PRIVATE_SUFFIX@host.example/x',
            'https://alice:123\\PRIVATE_PREFIX PRIVATE_SUFFIX@host.example/x',
            'fetch //alice:?PRIVATE_PREFIX PRIVATE_SUFFIX@host.example/x',
            'fetch //alice:#PRIVATE_PREFIX PRIVATE_SUFFIX@host.example/x',
            'file://C: PRIVATE_SUFFIX@host.example/x',
        ]) {
            expect(redactText(text)).not.toContain('PRIVATE');
        }
        // A `:` with no port before the space stays prose punctuation, in both forms.
        for (const text of ['see //example.com: docs/a@b', 'see https://example.com: docs/a@b']) {
            expect(redactText(text)).toBe(text);
        }
    });

    it('masks a join after a port-like prefix whenever an `@` follows, as R76 requires (issue #63 case 5)', () => {
        // The join form of case 5 stays over-masked: a password's leading digits look like a port, and the right side
        // may put its `@` past other fields or lines, so the delimited probe applies to every left side.
        for (const url of ['https://host:8080', '//host:8080', 'https://[::1]:8080']) {
            expect(joinBoundary(url, 'contact bob@example.org').maskRight).toBe(true);
        }
        // A spaced password prefix on the left, completed past other words or lines on the right.
        for (const left of ['https://alice:123 PRIVATE_PREFIX', '//alice:123 PRIVATE_PREFIX']) {
            for (const right of ['reason PRIVATE_SUFFIX@host.example/x', JSON.stringify({ reason: 'PRIVATE_SUFFIX@host.example/x' }, null, 2)]) {
                expect(joinBoundary(left, right).maskRight).toBe(true);
                expect(formatNamedEntry({ name: left, url: right })).not.toContain('PRIVATE');
            }
        }
        // A split query credential whose prefix ends like a port is still masked.
        expect(joinBoundary('https://api.example?token=PREFIX:8080', 'PRIVATE_SUFFIX').maskRight).toBe(true);
        expect(formatNamedEntry({ name: 'https://api.example?token=PREFIX:8080', url: 'PRIVATE_SUFFIX' })).not.toContain('PRIVATE');
        // The password the next word holds, split across the join, is still masked.
        expect(joinBoundary('https://alice:123 PRIVATE_PREFIX', 'PRIVATE_SUFFIX@host.example/x').maskRight).toBe(true);
        expect(joinBoundary('//alice:123 PRIVATE_PREFIX', 'PRIVATE_SUFFIX@host.example/x').maskRight).toBe(true);
        expect(formatNamedEntry({ name: 'https://alice:123', url: 'PRIVATE_SUFFIX@host.example/x' })).toBe('https://*** (***)');
        // Structured details are no prose: the `@` may sit past other fields or lines, so R76's probe still applies,
        // for a valid port (a password's digits look like one), an invalid one, and the network-path form.
        const pretty = JSON.stringify({ reason: 'PRIVATE_SUFFIX@host.example/x' }, null, 2);
        const fields = '{"token": "OTHER", "reason": "PRIVATE_SUFFIX@host.example/x"}';
        // Details on several lines are no one line of prose either, structured or not.
        const lines = 'reason\n  PRIVATE_SUFFIX@host.example/x';
        for (const name of ['https://alice:123', 'https://alice:99999', '//alice:123', 'https://host:8080']) {
            for (const details of [pretty, fields, lines]) {
                expect(joinBoundary(name, details).maskRight).toBe(true);
                expect(formatNamedEntry({ name, url: details })).not.toContain('PRIVATE');
            }
        }
    });

    it('masks a network-path password holding spaces and a slash after a port-like prefix', () => {
        expect(redactText('fetch //alice:123 PRIVATE_SUFFIX/part@host.example/x failed')).toBe('fetch //***@host.example/x failed');
        // Prose with a real host and port keeps its text.
        expect(redactText('see //host:8080 then /docs and bob@example.org')).toBe('see //host:8080 then /docs and bob@example.org');
        // A port-like reference does not swallow the next reference, after a space or after `/docs,`.
        expect(redactText('see //public:8080 then fetch //alice:pass PRIVATE_SUFFIX/x@host.example/repo')).toBe(
            'see //public:8080 then fetch //***@host.example/repo'
        );
        expect(redactText('see //public:8080 /docs,//alice:pass PRIVATE_SUFFIX/x@host.example/repo')).toBe(
            'see //public:8080 /docs,//***@host.example/repo'
        );
    });

    it('masks an array or object query value whole', () => {
        expect(redactText('GET https://host.example/?tokens=[ "PRIVATE_A", "PRIVATE_B" ] failed')).toBe('GET https://host.example/?tokens=*** failed');
        expect(redactText('GET https://host.example/?token={ "v": "PRIVATE_A", "w": 1 } failed')).toBe('GET https://host.example/?token=*** failed');
        // An ordinary one keeps its value.
        expect(redactText('GET https://host.example/?q=[1, 2] ok')).toBe('GET https://host.example/?q=[1, 2] ok');
    });

    it('masks credentials around whitespace serialised as a Unicode escape', () => {
        for (const escape of ['\\u0009', '\\u000a', '\\u000D']) {
            expect(redactText(`{"e":"token${escape}=PRIVATE_VALUE"}`)).not.toContain('PRIVATE');
            expect(redactText(`{"u":"https://host.example/?to${escape}ken=PRIVATE_VALUE"}`)).not.toContain('PRIVATE');
            expect(redactText(`{"u":"https://host.example/?to\\${escape}ken=PRIVATE_VALUE"}`)).not.toContain('PRIVATE');
        }
    });

    it('masks a Bearer or Basic token holding a JSON-escaped slash whole', () => {
        expect(redactText('{"reason":"sent Bearer prefix\\/PRIVATE_SUFFIX","ok":1}')).toBe('{"reason":"sent Bearer ***","ok":1}');
        expect(redactText('sent Basic dXNlcjo\\/Pz8= ok')).toBe('sent Basic *** ok');
        expect(redactText('sent Basic "dXNlcjo\\/Pz8=" ok')).toBe('sent Basic *** ok');
        expect(redactText(JSON.stringify({ reason: 'sent Basic dXNlcjo\\/Pz8=', ok: 1 }))).not.toContain('Pz8');
    });

    it('masks a query value holding a space inside a quoted URL, to the string end', () => {
        expect(redactText('{"url":"https://host.example/?token=PREFIX PRIVATE_SUFFIX"}')).not.toContain('PRIVATE');
        expect(redactText(JSON.stringify({ d: JSON.stringify({ url: 'https://host.example/?token=PREFIX PRIVATE_SUFFIX' }) }))).not.toContain('PRIVATE');
        expect(redactText("{'u':'https://host.example/?token=PREFIX PRIVATE_SUFFIX'}")).not.toContain('PRIVATE');
        // In free text a space still ends the value.
        expect(redactText('see https://host.example/?token=abc and more')).toBe('see https://host.example/?token=*** and more');
        // A line break inside the quoted URL does not end it, as a URL parser drops it, closed or not; an unclosed
        // one ends the value as in free text, at a space.
        for (const eol of ['\n', '\r', '\r\n']) {
            expect(redactText(`fetch "https://host.example/?token=PREFIX${eol}PRIVATE_SUFFIX" failed`)).not.toContain('PRIVATE');
        }
        expect(redactText('fetch "https://host.example/?token=abc\nnext line')).toBe('fetch "https://host.example/?token=*** line');
    });

    it('masks a special-scheme URL whose scheme a tab or line break splits', () => {
        for (const sep of ['\t', '\n', '\r\n']) {
            expect(redactText(`ht${sep}tps:alice:PRIVATE_VALUE@host.example/x`)).toBe('https://***:***@host.example/x');
        }
        // Serialised, at any depth, as in JSON stderr or structured details.
        for (const sep of ['\t', '\n', '\r\n']) {
            const raw = `ht${sep}tps:alice:PRIVATE_VALUE@host.example/x`;
            expect(redactText(JSON.stringify({ reason: raw }))).toBe('{"reason":"https://***:***@host.example/x"}');
            expect(redactText(JSON.stringify({ d: JSON.stringify({ reason: raw }) }))).not.toContain('PRIVATE');
        }
        expect(redactText(JSON.stringify({ reason: 'see the http\\nmanual' }))).toBe('{"reason":"see the http\\\\nmanual"}');
        // Prose keeps its text and its line boundary.
        expect(redactText('the ht\ntp: thing, mail bob@example.org')).toBe('the ht\ntp: thing, mail bob@example.org');
    });

    it('masks a network-path userinfo spelled with JSON-escaped slashes, at any depth', () => {
        const json = '{"error":"fetch \\/\\/alice:PRIVATE_VALUE@host.example\\/x failed"}';
        expect(redactText(json)).toBe('{"error":"fetch //***@host.example/x failed"}');
        expect(redactText(JSON.stringify({ reason: json }))).not.toContain('PRIVATE');
        // A Windows path keeps its backslashes.
        expect(redactText('{"p":"C:\\\\Users\\\\x"}')).toBe('{"p":"C:\\\\Users\\\\x"}');
    });

    it('masks a URL whose delimiters are Unicode escapes, at any depth, keeping quotes escaped', () => {
        const json = '{"error":"https://alice:PRIVATE_VALUE\\u0040host.example/x"}';
        expect(redactText(json)).toBe('{"error":"https://***:***@host.example/x"}');
        expect(redactText(JSON.stringify({ reason: json }))).toBe('{"reason":"{\\"error\\":\\"https://***:***@host.example/x\\"}"}');
        // A backslash escape is left as it is; a quote escape stays an escaped quote.
        expect(redactText('{"a":"\\u0022q\\u0022","b":"\\u005c"}')).toBe('{"a":"\\"q\\"","b":"\\u005c"}');
    });

    it('masks URL userinfo that line breaks split anywhere in the authority', () => {
        expect(redactText('https://ali\nce:PRIVATE@host.example/x')).toBe('https://***@host.example/x');
        expect(redactText('https://alice:123\nmore\nPRIVATE@host.example/x')).toBe('https://***@host.example/x');
        expect(redactText('see https://alice:P\r\nQ\rR@host.example/x ok')).toBe('see https://***@host.example/x ok');
        // A username alone is masked too: a token may sit there, and a parser reads the break-split text as one URL.
        for (const sep of ['\t', '\n', '\r\n']) {
            expect(redactText(`clone failed: https://ghp_PRIVATE${sep}SUFFIX@github.com/repo`)).toBe('clone failed: https://***@github.com/repo');
        }
        expect(redactText('https://example.com\nbob@example.org')).toBe('https://***@example.org/');
        // A network-path reference too, and a `//` inside a word starts none.
        for (const sep of ['\t', '\n', '\r\n']) {
            expect(redactText(`fetch //ali${sep}ce:PRIVATE@host.example/x failed`)).toBe('fetch //***@host.example/x failed');
        }
        expect(redactText('see //example.com\nbob@example.org and a//b\nc:d@e')).toBe('see //***@example.org and a//b\nc:d@e');
    });

    it('masks URL userinfo split by a line break, as a URL parser reads it', () => {
        for (const eol of ['\n', '\r', '\r\n']) {
            expect(redactText(`https://alice:PRIVATE_PREFIX${eol}PRIVATE_SUFFIX@host.example/x`)).toBe('https://***@host.example/x');
            // A numeric prefix parses as a port, yet the whole is one password.
            expect(redactText(`https://alice:123${eol}PRIVATE_SUFFIX@host.example/x`)).toBe('https://***@host.example/x');
            expect(formatNamedEntry({ name: 'gh', url: `https://alice:PRIVATE_PREFIX${eol}PRIVATE_SUFFIX@host.example/x` })).toBe('gh (https://***@host.example/x)');
        }
        // Anywhere else a line break still ends the URL.
        expect(redactText('see https://example.com\nmail bob@example.org')).toBe('see https://example.com\nmail bob@example.org');
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
            'https://a:b/ x'.repeat(size / 14),
            'https://a:b/@\n'.repeat(size / 14),
            'https://a:b/ x://'.repeat(size / 17),
            'https://h.example/?' + Array.from({ length: size / 16 }, (_, i) => `token${i}=x`).join('&'),
            "password='" + '\\\\'.repeat(size / 2),
            "bearer '" + '\\\\'.repeat(size / 2) + '\n',
            'tokens=[\'' + '\\\\'.repeat(size / 2),
            '\\\\'.repeat(size / 2) + 'u001',
            'token' + '\\\\'.repeat(size / 2) + '=',
            'bearer' + '\\\\'.repeat(size / 2) + 'x',
            '\u009d'.repeat(size / 2),
            '\u001b['.repeat(size / 2),
            '\u001b[t'.repeat(size / 3) + 'oken=x',
            'a\u001b[b'.repeat(size / 4),
            'a\u001b[b\u0000'.repeat(size / 5),
            'x\u001b[0m'.repeat(size / 5) + '\u001b[t=',
            '\\u001b(t'.repeat(size / 8) + 'oken=x',
            '\u001b[1'.repeat(size / 6) + 'm'.repeat(size / 6),
            '\\u001b['.repeat(size / 7) + '0m',
            'a&password='.repeat(size / 11),
            // Each quoted URL opens at a new escape depth and has no close ahead.
            Array.from({ length: 2000 }, (_, depth) => '\\'.repeat(depth + 1) + '"https://x/?token=x').join('\n'),
            '\\\\n'.repeat(size / 3) + 'token',
            'a\\\\n'.repeat(size / 4) + '=',
            '\\a'.repeat(size / 2) + '=',
            '\\aaaa'.repeat(size / 5),
            'https://a ' + 'b:'.repeat(size / 2),
            'https://a b '.repeat(size / 12) + '@',
            'https://a:b\n'.repeat(size / 12) + '@',
            'https://a:1\n'.repeat(size / 12) + '@',
            'https://a\n'.repeat(size / 10) + ':@',
            'Basic ' + 'ejpz'.repeat(size / 4),
            '?token=a' + '\n'.repeat(size),
            '?a' + '\n'.repeat(size) + '=',
            ' //a' + '\n'.repeat(size / 2) + ':@',
            'https:/a:'.repeat(size / 9) + '\n@',
            'https:\n'.repeat(size / 7) + 'a',
            '\\u0061'.repeat(size / 6) + '=',
            'https://a:1 /'.repeat(size / 13) + '@',
            ' //a:1 '.repeat(size / 7) + '/@',
            '\\b'.repeat(size / 2) + '=',
            ' //a:1 /'.repeat(size / 8) + '@',
            '?token=['.repeat(size / 8),
            '"?token=a&token=b'.repeat(size / 17),
            'bearer ' + '\\'.repeat(size) + 'x',
            '\\u0009'.repeat(size / 6) + '=',
            '"?token=a\n'.repeat(size / 10),
            'bearer "a\n'.repeat(size / 10),
            '\\'.repeat(size) + '/',
            'https://a:' + '/'.repeat(size),
            '\u001bP'.repeat(size / 2),
            '?a' + '\\\\n'.repeat(size / 3) + '=',
            '\\u009d' + '\\'.repeat(size),
            'sent Bearer `' + '\\\\'.repeat(size / 2) + '\n',
            'Basic "' + 'A'.repeat(size),
            '?token=' + '\\\\t'.repeat(size / 3) + '"',
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
            // Runs of stripped final bytes, and separators after them, as tried in #81 (issue #63 cases 8 and 10).
            '\u001b(p'.repeat(size / 3) + '=x',
            'pa\u001b(s'.repeat(size / 4) + '=x',
            '\u001b(t\u001b(o\u001b(k\u001b(e'.repeat(size / 12) + ' x',
            'au' + '\u001b(t'.repeat(size / 3) + 'horization=x',
            'tokenbearer'.split('').map(char => `\u001b(${char}`).join('').concat(' x ').repeat(size / 36),
            '\u001b(p '.repeat(size / 4) + '=x',
            // Bare query parameters before a sensitive one that only redactUrl masks (#82, S6).
            'https://h.example/?' + 'a&'.repeat(size / 2) + 'token?q=PRIVATE',
            // Network-path authorities: a bracket that never closes, and one host-and-port or unparsable
            // `user:` authority per reference (issue #63 case 5).
            '//[:['.repeat(size / 5) + '/@',
            ' //[:1'.repeat(size / 6) + ' x@',
            ' //a:1 x'.repeat(size / 8) + '@',
            ' //a:b x'.repeat(size / 8) + '@',
            'ssh://a%20:1 '.repeat(size / 13) + 'x@',
        ];
        for (const input of inputs) {
            const started = performance.now();
            redactText(input);
            expect(performance.now() - started).toBeLessThan(3000);
        }
        // The per-input bound is the check; the test as a whole may run long under coverage and parallel load.
    }, 60_000);

    it('masks a known secret in time linear in the text and the secret, on a long near-match (redactTextAndSecret)', () => {
        // A 64 KiB message and an 8 KiB token: a matcher that restarts at every unit takes seconds here.
        const text = 'A'.repeat(64 * 1024);
        const started = performance.now();
        expect(redactTextAndSecret(text, 'A'.repeat(8 * 1024) + 'Z')).toBe(text);
        expect(performance.now() - started).toBeLessThan(500);
        expect(redactTextAndSecret(`boom ${'A'.repeat(1024)}Z!`, 'A'.repeat(1024) + 'Z')).toBe('boom ***!');
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
        expect(redactText('failed: key=abc signature=def page=2')).toBe('failed: key=***');
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
