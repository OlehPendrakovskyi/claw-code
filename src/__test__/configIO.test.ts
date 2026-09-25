import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    getHardeningCommandPrefix,
    getHardeningMode,
    getOpenClawConfigPath,
    getParentAtPath,
    getValueAtPath,
    loadOpenClawConfigRecord,
    readOpenClawConfig,
    writeOpenClawConfigRecord
} from '../core/configIO';

const readFile = vscode.workspace.fs.readFile as unknown as jest.Mock;
const writeFile = vscode.workspace.fs.writeFile as unknown as jest.Mock;
const getConfiguration = vscode.workspace.getConfiguration as unknown as jest.Mock;

const encode = (text: string) => new TextEncoder().encode(text);

const mockConfigGet = (value: unknown) => {
    getConfiguration.mockReturnValue({
        get: jest.fn(() => value),
        update: jest.fn()
    });
};

describe('getOpenClawConfigPath', () => {
    it('points at ~/.openclaw/openclaw.json', () => {
        expect(getOpenClawConfigPath()).toBe(
            path.join(os.homedir(), '.openclaw', 'openclaw.json')
        );
    });
});

describe('getValueAtPath', () => {
    it('returns the root for an empty path', () => {
        const root = { a: 1 };
        expect(getValueAtPath(root, [])).toBe(root);
    });

    it('walks object properties', () => {
        expect(getValueAtPath({ a: { b: { c: 42 } } }, ['a', 'b', 'c'])).toBe(42);
    });

    it('walks array indices', () => {
        expect(getValueAtPath({ tools: ['read', 'bash'] }, ['tools', 1])).toBe('bash');
    });

    it('returns undefined for unknown keys and out-of-range indices', () => {
        expect(getValueAtPath({ a: 1 }, ['b'])).toBeUndefined();
        expect(getValueAtPath({ a: [1] }, ['a', 1])).toBeUndefined();
        expect(getValueAtPath({ a: [1] }, ['a', -1])).toBeUndefined();
    });

    it('returns undefined when segment type does not match the container', () => {
        expect(getValueAtPath({ a: [1] }, ['a', 'key'])).toBeUndefined();
        expect(getValueAtPath({ a: { b: 1 } }, ['a', 0])).toBeUndefined();
    });
});

describe('getParentAtPath', () => {
    it('returns null for an empty path', () => {
        expect(getParentAtPath({ a: 1 }, [])).toBeNull();
    });

    it('returns the object parent with its string key', () => {
        const parent = { read: { enabled: true } };
        expect(getParentAtPath({ tools: parent }, ['tools', 'read'])).toEqual({
            parent,
            key: 'read'
        });
    });

    it('returns the array parent with its numeric key', () => {
        const parent = ['read', 'bash'];
        expect(getParentAtPath({ tools: parent }, ['tools', 1])).toEqual({
            parent,
            key: 1
        });
    });

    it('returns null when the parent is not a container', () => {
        expect(getParentAtPath({ tools: 'nope' }, ['tools', 'x'])).toBeNull();
        expect(getParentAtPath({ tools: 42 }, ['tools', 'x'])).toBeNull();
    });

    it('returns null when the parent path cannot be resolved', () => {
        expect(getParentAtPath({ a: 1 }, ['missing', 'deeper'])).toBeNull();
    });
});

describe('getHardeningCommandPrefix', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    it('falls back to openclaw when unset', () => {
        mockConfigGet(undefined);
        expect(getHardeningCommandPrefix()).toBe('openclaw');
    });

    it('uses the configured prefix, trimmed', () => {
        mockConfigGet('  wsl openclaw  ');
        expect(getHardeningCommandPrefix()).toBe('wsl openclaw');
    });
});

describe('getHardeningMode', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    it('accepts the three known modes', () => {
        for (const mode of ['audit', 'auditFix', 'full'] as const) {
            mockConfigGet(mode);
            expect(getHardeningMode()).toBe(mode);
        }
    });

    it('falls back to full for unknown or missing values', () => {
        mockConfigGet('nope');
        expect(getHardeningMode()).toBe('full');
        mockConfigGet(undefined);
        expect(getHardeningMode()).toBe('full');
    });
});

describe('readOpenClawConfig', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('parses a JSON config file', async () => {
        readFile.mockResolvedValueOnce(encode('{"tools":["read"]}'));
        const result = await readOpenClawConfig('/tmp/openclaw.json');
        expect(result.error).toBeUndefined();
        expect(result.config).toEqual({ tools: ['read'] });
    });

    it('reports empty config files', async () => {
        readFile.mockResolvedValueOnce(encode('   \n  '));
        const result = await readOpenClawConfig('/tmp/openclaw.json');
        expect(result.config).toBeNull();
        expect(result.error).toBe('Config file is empty.');
    });

    it('reports missing config files', async () => {
        readFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        const result = await readOpenClawConfig('/tmp/openclaw.json');
        expect(result.config).toBeNull();
        expect(result.error).toBe('Config file not found.');
    });

    it('reports other read failures', async () => {
        readFile.mockRejectedValueOnce(new Error('boom'));
        const result = await readOpenClawConfig('/tmp/openclaw.json');
        expect(result.config).toBeNull();
        expect(result.error).toBe('Unable to read config file.');
    });
});

describe('writeOpenClawConfigRecord', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('writes pretty JSON with a trailing newline', async () => {
        await writeOpenClawConfigRecord('/tmp/openclaw.json', { tools: ['read'] });
        expect(writeFile).toHaveBeenCalledTimes(1);
        const [uri, bytes] = writeFile.mock.calls[0];
        expect(uri.fsPath).toBe('/tmp/openclaw.json');
        expect(Buffer.from(bytes).toString('utf8')).toBe(
            '{\n  "tools": [\n    "read"\n  ]\n}\n'
        );
    });
});

describe('loadOpenClawConfigRecord', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('returns the record together with its path', async () => {
        readFile.mockResolvedValueOnce(encode('{"tools":["read"]}'));
        const result = await loadOpenClawConfigRecord();
        expect(result.config).toEqual({ tools: ['read'] });
        expect(result.path).toBe(getOpenClawConfigPath());
        expect(result.error).toBeUndefined();
    });

    it('returns no config when the file is not a record', async () => {
        readFile.mockResolvedValueOnce(encode('42'));
        const result = await loadOpenClawConfigRecord();
        expect(result.config).toBeNull();
        expect(result.error).toBe('Invalid config: expected a JSON object at the root.');
    });

    it('rejects an array at the config root as invalid config', async () => {
        readFile.mockResolvedValueOnce(encode('[1,2,3]'));
        const result = await loadOpenClawConfigRecord();
        expect(result.config).toBeNull();
        expect(result.error).toBe('Invalid config: expected a JSON object at the root.');
    });

    it('propagates read errors', async () => {
        readFile.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        const result = await loadOpenClawConfigRecord();
        expect(result.config).toBeNull();
        expect(result.error).toBe('Config file not found.');
    });
});
