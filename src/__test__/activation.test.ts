import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { activate, deactivate } from '../extension';
import { connect, log } from '../vscode/commands';
import { migrateLegacyGatewayToken, promptForGatewayToken } from '../core/gatewayConfig';

jest.mock('../core/gatewayConfig', () => ({
    ...jest.requireActual('../core/gatewayConfig'),
    migrateLegacyGatewayToken: jest.fn(async () => undefined),
    promptForGatewayToken: jest.fn(async () => false),
}));

jest.mock('../vscode/commands', () => ({
    ...jest.requireActual('../vscode/commands'),
    connect: jest.fn(async () => undefined),
}));

type ConfigurationListener = (event: { affectsConfiguration(section: string): boolean }) => void;

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
const contributedCommands: string[] = manifest.contributes.commands.map((c: { command: string }) => c.command);
const settings: Record<string, { type: string | string[]; default?: unknown; enum?: unknown[] }> =
    manifest.contributes.configuration.properties;

function makeContext(): { context: vscode.ExtensionContext; subscriptions: vscode.Disposable[] } {
    const subscriptions: vscode.Disposable[] = [];
    const memento: vscode.Memento = {
        keys: () => [],
        get: ((_key: string, defaultValue?: unknown) => defaultValue) as vscode.Memento['get'],
        update: async () => undefined,
    };
    const secrets: vscode.SecretStorage = {
        keys: async () => [],
        get: async () => undefined,
        store: async () => undefined,
        delete: async () => undefined,
        onDidChange: () => ({ dispose: () => undefined }),
    };
    const context: Partial<vscode.ExtensionContext> = {
        extensionUri: vscode.Uri.file('/tmp/test-ext'),
        globalState: { ...memento, setKeysForSync: () => undefined },
        workspaceState: memento,
        secrets,
        subscriptions,
    };
    return { context: context as vscode.ExtensionContext, subscriptions };
}

function registeredCommands(): string[] {
    return jest.mocked(vscode.commands.registerCommand).mock.calls.map(call => call[0]);
}

function runCommand(id: string): unknown {
    const call = jest.mocked(vscode.commands.registerCommand).mock.calls.find(c => c[0] === id);
    if (!call) {
        throw new Error(`${id} not registered`);
    }
    return call[1]();
}

/** Fans a change out to every registered listener: the chat view registers its own beside activate's. */
function configurationListener(): ConfigurationListener {
    const listeners = jest.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls.map(call => call[0] as ConfigurationListener);
    if (!listeners.length) {
        throw new Error('no configuration listener registered');
    }
    return event => listeners.forEach(listener => listener(event));
}

function withSettings(values: Record<string, unknown>): void {
    const get = (key: string, defaultValue?: unknown): unknown => (key in values ? values[key] : defaultValue);
    const configuration: vscode.WorkspaceConfiguration = {
        get: get as vscode.WorkspaceConfiguration['get'],
        has: key => key in values,
        inspect: () => undefined,
        update: async () => undefined,
    };
    jest.mocked(vscode.workspace.getConfiguration).mockImplementation(() => configuration);
}

/** Every `openclaw` key the extension reads or writes, found in source so a new read cannot skip package.json. */
function settingKeysUsedInSource(): string[] {
    const sourceRoot = path.join(__dirname, '..');
    const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return full === __dirname ? [] : files(full);
        }
        return entry.name.endsWith('.ts') ? [full] : [];
    });
    const access = /(?:\bconfig|getConfiguration\('openclaw'\))\s*\.(?:get|update|inspect)(?:<[^>]*>)?\(\s*'([^']+)'/g;
    const keys = files(sourceRoot).flatMap(file => Array.from(fs.readFileSync(file, 'utf8').matchAll(access), m => m[1]));
    return [...new Set(keys)].sort();
}

describe('extension activation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        withSettings({});
    });

    it('exports activate and deactivate', () => {
        expect(typeof activate).toBe('function');
        expect(typeof deactivate).toBe('function');
    });

    it('creates a status bar item', async () => {
        const { context } = makeContext();
        await activate(context);
        expect(vscode.window.createStatusBarItem).toHaveBeenCalledWith(vscode.StatusBarAlignment.Right, 100);
    });

    it('registers the overview tree view and the chat webview view', async () => {
        const { context } = makeContext();
        await activate(context);
        expect(vscode.window.createTreeView).toHaveBeenCalledWith(
            'openclaw.overview',
            expect.objectContaining({ treeDataProvider: expect.anything() }),
        );
        expect(vscode.window.registerWebviewViewProvider).toHaveBeenCalledWith('openclaw.chat', expect.anything());
    });

    it('hands every registration to the context for disposal', async () => {
        const { context, subscriptions } = makeContext();
        await activate(context);
        expect(subscriptions.length).toBeGreaterThanOrEqual(registeredCommands().length);
        subscriptions.forEach(subscription => expect(typeof subscription.dispose).toBe('function'));
    });

    it('deactivate does not throw', () => {
        expect(() => deactivate()).not.toThrow();
    });

    describe('commands', () => {
        it('registers every command package.json contributes, each once', async () => {
            const { context } = makeContext();
            await activate(context);
            const registered = registeredCommands();
            expect(contributedCommands.filter(command => !registered.includes(command))).toEqual([]);
            expect(new Set(registered).size).toBe(registered.length);
        });

        it('reveals the open debug panel on a repeated debug command', async () => {
            const { context } = makeContext();
            await activate(context);
            runCommand('openclaw.chat.debug');
            runCommand('openclaw.chat.debug');
            expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
            const panel = jest.mocked(vscode.window.createWebviewPanel).mock.results[0].value;
            expect(panel.reveal).toHaveBeenCalledTimes(1);
        });

        it('logs a failed gateway connect with its secrets redacted before telling the user to check the logs', async () => {
            jest.mocked(promptForGatewayToken).mockRejectedValueOnce(new Error('store failed for token=abc123 at wss://u:pw@host/x'));
            const { context } = makeContext();
            await activate(context);
            runCommand('openclaw.chat.connectGateway');
            await new Promise(resolve => setImmediate(resolve));
            const logged = jest.mocked(log.error).mock.calls.map(call => String(call[0])).join('\n');
            expect(logged).toContain('connectGateway failed');
            expect(logged).not.toContain('abc123');
            expect(logged).not.toContain('pw@');
            expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Check the logs'));
        });

        it('binds keys only to contributed commands', () => {
            const bound: string[] = manifest.contributes.keybindings.map((k: { command: string }) => k.command);
            expect(bound.filter(command => !contributedCommands.includes(command))).toEqual([]);
        });
    });

    describe('legacy token migration', () => {
        it('runs at activation and again only when the token setting changes', async () => {
            const { context } = makeContext();
            await activate(context);
            expect(migrateLegacyGatewayToken).toHaveBeenCalledTimes(1);
            configurationListener()({ affectsConfiguration: section => section === 'openclaw.chat.models' });
            expect(migrateLegacyGatewayToken).toHaveBeenCalledTimes(1);
            configurationListener()({ affectsConfiguration: section => section === 'openclaw.gateway.token' });
            expect(migrateLegacyGatewayToken).toHaveBeenCalledTimes(2);
        });

        it('keeps activating when the migration rejects', async () => {
            jest.mocked(migrateLegacyGatewayToken).mockRejectedValueOnce(new Error('keyring locked'));
            const { context } = makeContext();
            await expect(activate(context)).resolves.toBeUndefined();
            expect(vscode.window.registerWebviewViewProvider).toHaveBeenCalled();
        });
    });

    describe('auto-connect', () => {
        afterEach(() => {
            jest.useRealTimers();
            Object.assign(vscode.workspace, { isTrusted: undefined });
        });

        it('does not connect when autoConnect is off', async () => {
            jest.useFakeTimers();
            const { context } = makeContext();
            await activate(context);
            jest.advanceTimersByTime(5000);
            expect(connect).not.toHaveBeenCalled();
        });

        it('connects after the startup delay in a trusted workspace', async () => {
            jest.useFakeTimers();
            withSettings({ autoConnect: true });
            Object.assign(vscode.workspace, { isTrusted: true });
            const { context } = makeContext();
            await activate(context);
            jest.advanceTimersByTime(1000);
            expect(connect).toHaveBeenCalledTimes(1);
        });

        it('does not connect once the extension is disposed inside the delay', async () => {
            jest.useFakeTimers();
            withSettings({ autoConnect: true });
            Object.assign(vscode.workspace, { isTrusted: true });
            const { context, subscriptions } = makeContext();
            await activate(context);
            subscriptions.forEach(subscription => subscription.dispose());
            jest.advanceTimersByTime(1000);
            expect(connect).not.toHaveBeenCalled();
        });
    });

    describe('package.json settings', () => {
        it('declares every setting the extension reads or writes', () => {
            const undeclared = settingKeysUsedInSource().filter(key => !(`openclaw.${key}` in settings));
            expect(undeclared).toEqual([]);
        });

        it('declares no setting the extension never touches', () => {
            const used = new Set([...settingKeysUsedInSource(), 'gateway.token'].map(key => `openclaw.${key}`));
            expect(Object.keys(settings).filter(key => !used.has(key))).toEqual([]);
        });

        it('gives every enum setting a default from its own enum', () => {
            Object.entries(settings)
                .filter(([, schema]) => schema.enum)
                .forEach(([key, schema]) => expect([key, schema.enum]).toEqual([key, expect.arrayContaining([schema.default])]));
        });

        it('types every default like its schema', () => {
            const typeOf = (value: unknown): string => {
                if (Array.isArray(value)) {
                    return 'array';
                }
                return Number.isInteger(value) ? 'integer' : typeof value;
            };
            Object.entries(settings)
                .filter(([, schema]) => schema.default !== undefined)
                .forEach(([key, schema]) => {
                    const allowed = [schema.type].flat().flatMap(type => (type === 'number' ? ['number', 'integer'] : [type]));
                    expect([key, allowed]).toEqual([key, expect.arrayContaining([typeOf(schema.default)])]);
                });
        });
    });
});
