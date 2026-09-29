import * as vscode from 'vscode';
import {
  DEVICE_IDENTITY_SECRET_KEY,
  DEVICE_TOKENS_SECRET_KEY,
  SecretDeviceCredentialStore,
  deviceHostKind,
  getGatewaySettings,
  getGatewayToken,
  isLoopbackGatewayUrl,
  isValidGatewayUrl,
  migrateLegacyGatewayToken,
  promptForGatewayToken,
  resetDeviceIdentity,
  sendsTokenInCleartext,
  setGatewayToken,
} from '../core/gatewayConfig';
import { importDeviceIdentity } from '../core/gatewayProtocol/deviceIdentity';

type Level = 'global' | 'workspace' | 'folder';

/** In-memory model of every settings location the Configuration API exposes:
 *  plain and `[language]` values per level, folder values per folder URI. */
class SettingsModel {
    private readonly values = new Map<string, unknown>();

    /** Updates that "succeed" without removing anything, like a remote user
     *  settings value the Global target cannot reach. */
    readonly stuck = new Set<string>();

    failUpdates = false;

    readonly updates: { target: vscode.ConfigurationTarget; languageId?: string; folder?: string }[] = [];

    set(level: Level, value: unknown, options: { folder?: string; languageId?: string } = {}): this {
        this.values.set(SettingsModel.slot(level, options.folder, options.languageId), value);
        return this;
    }

    has(level: Level, options: { folder?: string; languageId?: string } = {}): boolean {
        return this.values.has(SettingsModel.slot(level, options.folder, options.languageId));
    }

    configuration(scope: vscode.ConfigurationScope | undefined): vscode.WorkspaceConfiguration {
        const { folder, languageId } = SettingsModel.readScope(scope);
        const get = (level: Level, lang?: string) =>
            level === 'folder' && folder === undefined
                ? undefined
                : this.values.get(SettingsModel.slot(level, folder, lang));
        const inspect = () => {
            if (languageId !== undefined) {
                return {
                    key: 'openclaw.gateway.token',
                    globalLanguageValue: get('global', languageId),
                    workspaceLanguageValue: get('workspace', languageId),
                    workspaceFolderLanguageValue: get('folder', languageId),
                };
            }
            const languageIds = [...this.values.keys()]
                .map((slot) => slot.split('|'))
                .filter(([level, slotFolder, lang]) => lang && (level !== 'folder' || slotFolder === folder))
                .map(([, , lang]) => lang);
            return {
                key: 'openclaw.gateway.token',
                globalValue: get('global'),
                workspaceValue: get('workspace'),
                workspaceFolderValue: get('folder'),
                languageIds: languageIds.length ? [...new Set(languageIds)] : undefined,
            };
        };
        const update = async (
            _key: string,
            _value: unknown,
            target: vscode.ConfigurationTarget,
            overrideInLanguage?: boolean
        ) => {
            const lang = overrideInLanguage ? languageId : undefined;
            this.updates.push({ target, languageId: lang, folder });
            if (this.failUpdates) {
                throw new Error('settings file is read-only');
            }
            const level: Level =
                target === vscode.ConfigurationTarget.Global
                    ? 'global'
                    : target === vscode.ConfigurationTarget.Workspace
                      ? 'workspace'
                      : 'folder';
            const slot = SettingsModel.slot(level, folder, lang);
            if (!this.stuck.has(slot)) {
                this.values.delete(slot);
            }
        };
        return { get: jest.fn(), has: jest.fn(), inspect, update } as unknown as vscode.WorkspaceConfiguration;
    }

    static slot(level: Level, folder: string | undefined, languageId: string | undefined): string {
        return `${level}|${level === 'folder' ? folder ?? '' : ''}|${languageId ?? ''}`;
    }

    private static readScope(scope: vscode.ConfigurationScope | undefined): { folder?: string; languageId?: string } {
        if (scope === undefined) {
            return {};
        }
        if (scope instanceof vscode.Uri) {
            return { folder: scope.toString() };
        }
        const scoped = scope as { languageId?: string; uri?: vscode.Uri };
        return { folder: scoped.uri?.toString(), languageId: scoped.languageId };
    }
}

/** SecretStorage that, like VS Code's, reports every change after it happened. */
class MemorySecrets implements vscode.SecretStorage {
    readonly values = new Map<string, string>();
    /** Calls that never answer, once each, like a keyring waiting on an unlock prompt. */
    readonly hangOnce = new Set<'get' | 'delete'>();
    private readonly listeners = new Set<(event: vscode.SecretStorageChangeEvent) => void>();

    readonly onDidChange: vscode.Event<vscode.SecretStorageChangeEvent> = (listener) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };

    async keys(): Promise<string[]> {
        return [...this.values.keys()];
    }

    get(key: string): Promise<string | undefined> {
        if (this.hangOnce.delete('get')) return new Promise(() => undefined);
        return Promise.resolve(this.values.get(key));
    }

    async store(key: string, value: string): Promise<void> {
        this.values.set(key, value);
        this.changed(key);
    }

    delete(key: string): Promise<void> {
        if (this.hangOnce.delete('delete')) return new Promise(() => undefined);
        this.values.delete(key);
        this.changed(key);
        return Promise.resolve();
    }

    private changed(key: string): void {
        setImmediate(() => {
            for (const listener of this.listeners) listener({ key });
        });
    }
}

/** Let change events and the reads they trigger settle. */
async function drain(): Promise<void> {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}

const folderA = vscode.Uri.file('/work/a');
const folderB = vscode.Uri.file('/work/b');

const secrets = (existing?: string) => ({
    get: jest.fn(async () => existing),
    store: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
});

const makeContext = (secretStore: Pick<vscode.SecretStorage, 'get' | 'store' | 'delete'>) =>
    ({ secrets: secretStore } as unknown as vscode.ExtensionContext);

const useSettings = (model: SettingsModel, folders: vscode.Uri[] = [], api: typeof vscode = vscode) => {
    (api.workspace.getConfiguration as unknown as jest.Mock).mockImplementation(
        (_section: string, scope?: vscode.ConfigurationScope) => model.configuration(scope)
    );
    (api.workspace as { workspaceFolders: unknown }).workspaceFolders = folders.map((uri, index) => ({
        uri,
        index,
        name: `f${index}`,
    }));
};

describe('GatewayConfigService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterEach(() => {
        (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
    });

    describe('migrateLegacyGatewayToken', () => {
        beforeEach(() => {
            (vscode.workspace as { isTrusted?: boolean }).isTrusted = true;
        });

        afterEach(() => {
            delete (vscode.workspace as { isTrusted?: boolean }).isTrusted;
        });

        it('returns noop and touches nothing when no legacy value exists', async () => {
            const model = new SettingsModel();
            useSettings(model, [folderA]);
            const store = secrets();

            await expect(migrateLegacyGatewayToken(makeContext(store))).resolves.toBe('noop');

            expect(store.store).not.toHaveBeenCalled();
            expect(model.updates).toEqual([]);
        });

        it('stores only a user-level value and clears every level that held one', async () => {
            const model = new SettingsModel()
                .set('global', 'global-token')
                .set('folder', 'folder-token', { folder: folderA.toString() });
            useSettings(model, [folderA]);
            const store = secrets();

            await expect(migrateLegacyGatewayToken(makeContext(store))).resolves.toBe('completed');

            expect(store.store).toHaveBeenCalledWith('openclaw.gateway.token', 'global-token');
            expect(model.has('global')).toBe(false);
            expect(model.has('folder', { folder: folderA.toString() })).toBe(false);
        });

        it('never adopts a workspace token, removes it once trusted and says how to set one', async () => {
            const model = new SettingsModel().set('workspace', 'repo-token');
            useSettings(model);
            const store = secrets();

            await expect(migrateLegacyGatewayToken(makeContext(store))).resolves.toBe('completed');

            expect(store.store).not.toHaveBeenCalled();
            expect(model.has('workspace')).toBe(false);
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('a workspace cannot supply the token'));
        });

        it('leaves workspace settings of an untrusted workspace untouched, and still migrates the user one', async () => {
            (vscode.workspace as { isTrusted?: boolean }).isTrusted = false;
            const model = new SettingsModel()
                .set('global', 'user-token')
                .set('workspace', 'repo-token')
                .set('folder', 'repo-folder-token', { folder: folderA.toString(), languageId: 'python' });
            useSettings(model, [folderA]);
            const store = secrets();

            await expect(migrateLegacyGatewayToken(makeContext(store))).resolves.toBe('completed');

            expect(store.store).toHaveBeenCalledWith('openclaw.gateway.token', 'user-token');
            expect(model.has('workspace')).toBe(true);
            expect(model.has('folder', { folder: folderA.toString(), languageId: 'python' })).toBe(true);
            expect(model.updates.map((update) => update.target)).toEqual([vscode.ConfigurationTarget.Global]);
        });

        it('is a no-op for an untrusted workspace whose settings alone hold a token', async () => {
            (vscode.workspace as { isTrusted?: boolean }).isTrusted = false;
            const model = new SettingsModel().set('workspace', 'repo-token');
            useSettings(model);
            const store = secrets();

            await expect(migrateLegacyGatewayToken(makeContext(store))).resolves.toBe('noop');

            expect(store.store).not.toHaveBeenCalled();
            expect(model.updates).toEqual([]);
        });

        it('discovers language overrides through inspect().languageIds and prefers them over plain values', async () => {
            // A profile's settings.json lives outside any fixed path; the
            // Configuration API is the only source that sees it.
            const model = new SettingsModel()
                .set('global', 'profile-token')
                .set('workspace', 'workspace-token')
                .set('global', 'profile-language-token', { languageId: 'typescript' });
            useSettings(model);
            const store = secrets();

            await expect(migrateLegacyGatewayToken(makeContext(store))).resolves.toBe('completed');

            expect(store.store).toHaveBeenCalledWith('openclaw.gateway.token', 'profile-language-token');
            expect(model.has('global', { languageId: 'typescript' })).toBe(false);
            expect(model.has('global')).toBe(false);
            expect(model.has('workspace')).toBe(false);
            expect(model.updates).toContainEqual({
                target: vscode.ConfigurationTarget.Global,
                languageId: 'typescript',
                folder: undefined,
            });
        });

        it('clears plain and language values held by a non-first folder of a multi-root workspace', async () => {
            const model = new SettingsModel()
                .set('folder', 'b-token', { folder: folderB.toString() })
                .set('folder', 'b-python-token', { folder: folderB.toString(), languageId: 'python' });
            useSettings(model, [folderA, folderB]);
            const store = secrets();

            await expect(migrateLegacyGatewayToken(makeContext(store))).resolves.toBe('completed');

            expect(store.store).not.toHaveBeenCalled();
            expect(model.has('folder', { folder: folderB.toString() })).toBe(false);
            expect(model.has('folder', { folder: folderB.toString(), languageId: 'python' })).toBe(false);
        });

        it('never overwrites an existing SecretStorage token but still clears the plaintext', async () => {
            const model = new SettingsModel().set('global', 'legacy-token');
            useSettings(model);
            const store = secrets('existing-secret-token');

            await expect(migrateLegacyGatewayToken(makeContext(store))).resolves.toBe('completed');

            expect(store.store).not.toHaveBeenCalled();
            expect(model.has('global')).toBe(false);
        });

        it('tells the user when a settings token differs from the saved one instead of dropping it silently', async () => {
            const model = new SettingsModel().set('global', 'rotated-token');
            useSettings(model);
            const store = secrets('existing-secret-token');

            await migrateLegacyGatewayToken(makeContext(store));

            expect(store.store).not.toHaveBeenCalled();
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
                expect.stringContaining('OpenClaw: Connect to Gateway')
            );
        });

        it('does not claim the settings token was removed when cleanup is incomplete', async () => {
            const model = new SettingsModel().set('global', 'rotated-token');
            model.stuck.add(SettingsModel.slot('global', undefined, undefined));
            useSettings(model);

            await expect(migrateLegacyGatewayToken(makeContext(secrets('existing-secret-token')))).resolves.toBe('incomplete');

            expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
        });

        it('does not notify when the settings token equals the saved one', async () => {
            const model = new SettingsModel().set('global', 'same-token');
            useSettings(model);

            await migrateLegacyGatewayToken(makeContext(secrets('same-token')));

            expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
        });

        it('clears a blank or non-string legacy value without storing it', async () => {
            const model = new SettingsModel().set('global', '   ').set('workspace', 42);
            useSettings(model);
            const store = secrets();

            await expect(migrateLegacyGatewayToken(makeContext(store))).resolves.toBe('completed');

            expect(store.store).not.toHaveBeenCalled();
            expect(model.has('global')).toBe(false);
            expect(model.has('workspace')).toBe(false);
        });

        it('trims the stored legacy value', async () => {
            const model = new SettingsModel().set('global', '  padded-token\n');
            useSettings(model);
            const store = secrets();

            await migrateLegacyGatewayToken(makeContext(store));

            expect(store.store).toHaveBeenCalledWith('openclaw.gateway.token', 'padded-token');
        });

        it('reports incomplete when an update silently leaves the value in place', async () => {
            const model = new SettingsModel().set('global', 'remote-token');
            model.stuck.add(SettingsModel.slot('global', undefined, undefined));
            useSettings(model);
            const store = secrets();

            await expect(migrateLegacyGatewayToken(makeContext(store))).resolves.toBe('incomplete');

            expect(store.store).toHaveBeenCalledWith('openclaw.gateway.token', 'remote-token');
        });

        it('keeps the plaintext and reports incomplete when SecretStorage fails', async () => {
            const model = new SettingsModel().set('global', 'legacy-token');
            useSettings(model);
            const store = secrets();
            store.store.mockRejectedValue(new Error('keyring unavailable'));

            await expect(migrateLegacyGatewayToken(makeContext(store))).resolves.toBe('incomplete');

            expect(model.has('global')).toBe(true);
            expect(model.updates).toEqual([]);
        });

        it('reports incomplete on a failed update and warns only once per session', async () => {
            const model = new SettingsModel().set('global', 'legacy-token');
            model.failUpdates = true;
            // A fresh module instance: the once-per-session flag must not
            // leak in from, or out to, other tests.
            let isolatedMigrate: typeof migrateLegacyGatewayToken = migrateLegacyGatewayToken;
            let isolatedVscode: typeof vscode = vscode;
            jest.isolateModules(() => {
                isolatedVscode = jest.requireActual('vscode');
                isolatedMigrate = jest.requireActual('../core/gatewayConfig').migrateLegacyGatewayToken;
            });
            useSettings(model, [], isolatedVscode);
            const store = secrets();

            await expect(isolatedMigrate(makeContext(store))).resolves.toBe('incomplete');
            await expect(isolatedMigrate(makeContext(store))).resolves.toBe('incomplete');

            expect(store.store).toHaveBeenCalledWith('openclaw.gateway.token', 'legacy-token');
            expect(isolatedVscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
        });

        it('serializes concurrent runs so the second one sees the finished cleanup', async () => {
            const model = new SettingsModel().set('global', 'legacy-token');
            useSettings(model);
            const store = secrets();

            const results = await Promise.all([
                migrateLegacyGatewayToken(makeContext(store)),
                migrateLegacyGatewayToken(makeContext(store)),
            ]);

            expect(results).toEqual(['completed', 'noop']);
            expect(store.store).toHaveBeenCalledTimes(1);
        });
    });

    describe('getGatewaySettings', () => {
        const useRawSettings = (values: Record<string, unknown>) => {
            jest.mocked(vscode.workspace.getConfiguration).mockReturnValue({
                get: (key: string) => values[key],
            } as Pick<vscode.WorkspaceConfiguration, 'get'> as vscode.WorkspaceConfiguration);
        };

        it('defaults to the local gateway in auto mode', () => {
            useRawSettings({});
            expect(getGatewaySettings()).toEqual({ url: 'ws://127.0.0.1:18789', transport: 'auto', protocolVersion: 'auto' });
        });

        it('trims the URL and keeps a known transport', () => {
            useRawSettings({ 'gateway.url': '  wss://gw.example  ', 'gateway.transport': 'acpx' });
            expect(getGatewaySettings()).toEqual({ url: 'wss://gw.example', transport: 'acpx', protocolVersion: 'auto' });
        });

        it.each([[42, 'gateway'], [{ url: 'x' }, 'bogus'], ['   ', 7]])(
            'falls back for a hand-edited url %p and transport %p', (url, transport) => {
                useRawSettings({ 'gateway.url': url, 'gateway.transport': transport });
                expect(getGatewaySettings()).toEqual({
                    url: 'ws://127.0.0.1:18789',
                    transport: transport === 'gateway' ? 'gateway' : 'auto',
                    protocolVersion: 'auto',
                });
            });

        it('keeps a supported protocol version', () => {
            useRawSettings({ 'gateway.protocolVersion': '4' });
            expect(getGatewaySettings().protocolVersion).toBe('4');
        });

        it.each([[5], ['5'], [null], [{}], [4]])('falls back to auto for a hand-edited protocol version %p', (protocolVersion) => {
            useRawSettings({ 'gateway.protocolVersion': protocolVersion });
            expect(getGatewaySettings().protocolVersion).toBe('auto');
        });
    });

    describe('gateway token storage', () => {
        it('reads a missing token as empty', async () => {
            await expect(getGatewayToken(makeContext(secrets()).secrets)).resolves.toBe('');
            await expect(getGatewayToken(makeContext(secrets('tok')).secrets)).resolves.toBe('tok');
        });

        it('stores a token and deletes on an empty one', async () => {
            const store = secrets();
            await setGatewayToken(makeContext(store).secrets, 'tok');
            await setGatewayToken(makeContext(store).secrets, '');
            expect(store.store).toHaveBeenCalledWith('openclaw.gateway.token', 'tok');
            expect(store.delete).toHaveBeenCalledWith('openclaw.gateway.token');
        });
    });

    describe('migrateLegacyGatewayToken without workspace folders', () => {
        it('migrates the user setting when no folder is open', async () => {
            const model = new SettingsModel().set('global', 'legacy-token');
            useSettings(model);
            (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
            const store = secrets();
            await expect(migrateLegacyGatewayToken(makeContext(store))).resolves.toBe('completed');
            expect(store.store).toHaveBeenCalledWith('openclaw.gateway.token', 'legacy-token');
        });

        it('logs a cleanup failure that is not an Error', async () => {
            const model = new SettingsModel().set('global', 'legacy-token');
            useSettings(model);
            const configuration = model.configuration(undefined);
            jest.mocked(vscode.workspace.getConfiguration).mockReturnValue({
                ...configuration,
                update: jest.fn(async () => { throw 'EACCES'; }),
            });
            await expect(migrateLegacyGatewayToken(makeContext(secrets()))).resolves.toBe('incomplete');
        });
    });

    describe('promptForGatewayToken', () => {
        it('keeps the stored token when the prompt is cancelled', async () => {
            const store = secrets('kept');
            (vscode.window.showInputBox as jest.Mock).mockResolvedValue(undefined);
            await expect(promptForGatewayToken(makeContext(store))).resolves.toBe(false);
            expect(store.store).not.toHaveBeenCalled();
            expect(store.delete).not.toHaveBeenCalled();
        });

        it('clears the token when a blank value is entered', async () => {
            const store = secrets('old');
            (vscode.window.showInputBox as jest.Mock).mockResolvedValue('   ');
            await expect(promptForGatewayToken(makeContext(store))).resolves.toBe(true);
            expect(store.delete).toHaveBeenCalled();
            expect(vscode.window.showInformationMessage).toHaveBeenCalledWith('Gateway token cleared.');
        });

        it('keeps serializing token writes after one of them fails', async () => {
            const failing = { ...secrets(), store: jest.fn(async () => { throw new Error('keyring locked'); }) };
            (vscode.window.showInputBox as jest.Mock).mockResolvedValue('tok');
            await expect(promptForGatewayToken(makeContext(failing))).rejects.toThrow('keyring locked');
            const store = secrets();
            await expect(promptForGatewayToken(makeContext(store))).resolves.toBe(true);
            expect(store.store).toHaveBeenCalledWith('openclaw.gateway.token', 'tok');
        });

        it('stores the typed token only after an in-flight migration finished', async () => {
            const model = new SettingsModel().set('global', 'legacy-token');
            useSettings(model);
            let stored: string | undefined;
            const store = {
                get: jest.fn(async () => stored),
                store: jest.fn(async (_key: string, value: string) => { stored = value; }),
                delete: jest.fn(async () => undefined),
            };
            (vscode.window.showInputBox as jest.Mock).mockResolvedValue('typed-token');

            await Promise.all([
                migrateLegacyGatewayToken(makeContext(store)),
                promptForGatewayToken(makeContext(store)),
            ]);

            expect(stored).toBe('typed-token');
        });
    });

    describe('gateway URL checks', () => {
        it.each(['ws://127.0.0.1:18789', 'wss://gateway.example/path', 'ws://[::1]:1', 'ws://localhost'])(
            'accepts %s',
            (url) => {
                expect(isValidGatewayUrl(url)).toBe(true);
            }
        );

        it.each(['127.0.0.1:18789', 'http://gateway.example', 'ftp://x', '', 'ws//broken', 'ws://host:1/#x', 'ws://host:1/#'])('rejects %s', (url) => {
            expect(isValidGatewayUrl(url)).toBe(false);
        });

        it('flags plain ws:// only for non-loopback hosts', () => {
            expect(sendsTokenInCleartext('ws://gateway.example')).toBe(true);
            expect(sendsTokenInCleartext('ws://10.0.0.5:18789')).toBe(true);
            expect(sendsTokenInCleartext('ws://127.0.0.1:18789')).toBe(false);
            expect(sendsTokenInCleartext('ws://localhost:18789')).toBe(false);
            expect(sendsTokenInCleartext('ws://[::1]:18789')).toBe(false);
            expect(sendsTokenInCleartext('wss://gateway.example')).toBe(false);
        });

        it('recognizes loopback forms WHATWG URL normalizes', () => {
            expect(sendsTokenInCleartext('ws://localhost.:1')).toBe(false);
            expect(sendsTokenInCleartext('ws://gw.localhost:1')).toBe(false);
            expect(sendsTokenInCleartext('ws://[::ffff:127.0.0.1]:1')).toBe(false);
            expect(sendsTokenInCleartext('ws://[0:0:0:0:0:0:0:1]:1')).toBe(false);
            expect(sendsTokenInCleartext('ws://127.1:1')).toBe(false);
            expect(sendsTokenInCleartext('WS://LOCALHOST:1')).toBe(false);
            expect(sendsTokenInCleartext('ws://[::ffff:10.0.0.1]:1')).toBe(true);
            expect(sendsTokenInCleartext('ws://localhostx.example:1')).toBe(true);
        });

        it('does not treat a lookalike host as loopback', () => {
            expect(sendsTokenInCleartext('ws://127.0.0.1.evil.example')).toBe(true);
            expect(sendsTokenInCleartext('ws://localhost.evil.example')).toBe(true);
        });
    });
    describe('device credentials', () => {
        const identityKey = (hostKind = deviceHostKind()) => `${DEVICE_IDENTITY_SECRET_KEY}.${hostKind}`;
        const tokensKey = (hostKind = deviceHostKind()) => `${DEVICE_TOKENS_SECRET_KEY}.${hostKind}`;
        const token = (deviceId: string, value = 'dtok') => ({ deviceId, role: 'operator', token: value, scopes: ['operator.read'] });

        afterEach(() => {
            jest.useRealTimers();
            (vscode.env as { remoteName?: string }).remoteName = undefined;
        });

        it('creates the identity once and persists only its private key', async () => {
            const vault = new MemorySecrets();
            const store = new SecretDeviceCredentialStore(vault);
            const [first, second] = await Promise.all([store.loadIdentity(), store.loadIdentity()]);
            expect(second).toBe(first);
            const persisted = vault.values.get(identityKey()) ?? '';
            expect(persisted).toMatch(/^-----BEGIN PRIVATE KEY-----/);
            expect(importDeviceIdentity(persisted)?.deviceId).toBe(first.deviceId);
            const reopened = await new SecretDeviceCredentialStore(vault).loadIdentity();
            expect(reopened.deviceId).toBe(first.deviceId);
        });

        it('keys the identity by host kind, since remote windows share the local keychain', async () => {
            expect(deviceHostKind()).toBe(`local-${process.platform}`);
            (vscode.env as { remoteName?: string }).remoteName = 'wsl';
            expect(deviceHostKind()).toBe(`wsl-${process.platform}`);
            const vault = new MemorySecrets();
            const windows = await new SecretDeviceCredentialStore(vault, 'local-win32').loadIdentity();
            const wsl = new SecretDeviceCredentialStore(vault, 'wsl-linux');
            const wslIdentity = await wsl.loadIdentity();
            expect(wslIdentity.deviceId).not.toBe(windows.deviceId);
            await wsl.storeToken('ws://a:1', token(wslIdentity.deviceId));
            expect(await new SecretDeviceCredentialStore(vault, 'local-win32').loadToken('ws://a:1', wslIdentity.deviceId)).toBeNull();
            await resetDeviceIdentity(vault, 'wsl-linux');
            expect(vault.values.has(identityKey('local-win32'))).toBe(true);
            expect(vault.values.has(identityKey('wsl-linux'))).toBe(false);
        });

        it('replaces a stored key it cannot read', async () => {
            const vault = new MemorySecrets();
            vault.values.set(identityKey(), 'garbage');
            const identity = await new SecretDeviceCredentialStore(vault).loadIdentity();
            expect(importDeviceIdentity(vault.values.get(identityKey()) ?? '')?.deviceId).toBe(identity.deviceId);
        });

        it('keeps one token per gateway origin and device, and clears only its own', async () => {
            const vault = new MemorySecrets();
            const store = new SecretDeviceCredentialStore(vault);
            const { deviceId } = await store.loadIdentity();
            await Promise.all([store.storeToken('ws://a:1', token(deviceId, 'ta')), store.storeToken('wss://b', token(deviceId, 'tb'))]);
            expect(await store.loadToken('ws://a:1', deviceId)).toEqual(token(deviceId, 'ta'));
            expect(await store.loadToken('ws://a:1', 'other')).toBeNull();
            expect(await store.loadToken('ws://other:1', deviceId)).toBeNull();
            await store.clearToken('wss://b', 'other');
            expect(await store.loadToken('wss://b', deviceId)).toEqual(token(deviceId, 'tb'));
            await store.clearToken('wss://b', deviceId);
            expect(await store.loadToken('wss://b', deviceId)).toBeNull();
            expect(await store.loadToken('ws://a:1', deviceId)).toEqual(token(deviceId, 'ta'));
        });

        it('ignores malformed token records', async () => {
            const vault = new MemorySecrets();
            vault.values.set(tokensKey(), JSON.stringify({ 'ws://a:1': { deviceId: 'd1', token: 7 }, 'ws://b:1': token('d1') }));
            const store = new SecretDeviceCredentialStore(vault);
            expect(await store.loadToken('ws://a:1', 'd1')).toBeNull();
            expect(await store.loadToken('ws://b:1', 'd1')).toEqual(token('d1'));
            vault.values.set(tokensKey(), '{not json');
            expect(await store.loadToken('ws://b:1', 'd1')).toBeNull();
        });

        it('drops a token issued to the device a reset just replaced', async () => {
            const vault = new MemorySecrets();
            const store = new SecretDeviceCredentialStore(vault);
            const old = await store.loadIdentity();
            const reset = resetDeviceIdentity(vault);
            await store.storeToken('wss://gw.example', token(old.deviceId, 'dtok-old-device'));
            await reset;
            expect(vault.values.get(tokensKey()) ?? '').not.toContain('dtok-old-device');
        });

        it('reports an identity reset made elsewhere, not its own writes, and then pairs a new identity', async () => {
            const vault = new MemorySecrets();
            const store = new SecretDeviceCredentialStore(vault);
            const changes = jest.fn();
            store.onDidChangeIdentity(changes);
            const original = await store.loadIdentity();
            await store.storeToken('ws://a:1', token(original.deviceId));
            await drain();
            expect(changes).not.toHaveBeenCalled();
            await resetDeviceIdentity(vault);
            await drain();
            expect(changes).toHaveBeenCalledTimes(1);
            expect(vault.values.size).toBe(0);
            const renewed = await store.loadIdentity();
            expect(renewed.deviceId).not.toBe(original.deviceId);
            await drain();
            expect(changes).toHaveBeenCalledTimes(1);
            store.dispose();
        });

        it('settles every window on one new identity after a reset', async () => {
            const vault = new MemorySecrets();
            const windows = [0, 1, 2].map(() => {
                let isolated: typeof import('../core/gatewayConfig') | undefined;
                jest.isolateModules(() => {
                    isolated = jest.requireActual('../core/gatewayConfig');
                });
                if (!isolated) throw new Error('module did not load');
                return { module: isolated, store: new isolated.SecretDeviceCredentialStore(vault) };
            });
            const proved: string[][] = windows.map(() => []);
            windows.forEach(({ store }, index) => {
                store.onDidChangeIdentity(() => void store.loadIdentity().then((identity) => proved[index].push(identity.deviceId)));
            });
            const before = await windows[0].store.loadIdentity();
            await Promise.all(windows.map(({ store }) => store.loadIdentity()));
            await windows[0].module.resetDeviceIdentity(vault);
            await new Promise((resolve) => setTimeout(resolve, 800));
            await drain();
            const current = importDeviceIdentity(vault.values.get(identityKey()) ?? '')?.deviceId;
            expect(current).toBeDefined();
            expect(current).not.toBe(before.deviceId);
            // No window proved a key of its own in between: that would leave an orphan pairing request.
            expect(new Set(proved.flat())).toEqual(new Set([current]));
            for (const { store } of windows) expect((await store.loadIdentity()).deviceId).toBe(current);
        });

        it('fails a SecretStorage call that never answers instead of wedging later ones', async () => {
            jest.useFakeTimers();
            const vault = new MemorySecrets();
            const store = new SecretDeviceCredentialStore(vault);
            vault.hangOnce.add('get');
            const hung = store.loadIdentity();
            const hungFailed = expect(hung).rejects.toThrow(/did not answer/);
            await jest.advanceTimersByTimeAsync(5000);
            await hungFailed;
            const loading = store.loadIdentity();
            await jest.advanceTimersByTimeAsync(300);
            const identity = await loading;
            await expect(store.loadToken('ws://a:1', identity.deviceId)).resolves.toBeNull();
            vault.hangOnce.add('delete');
            const reset = resetDeviceIdentity(vault);
            const resetFailed = expect(reset).rejects.toThrow(/did not answer/);
            await jest.advanceTimersByTimeAsync(5000);
            await resetFailed;
            const storing = store.storeToken('ws://a:1', token(identity.deviceId));
            await jest.advanceTimersByTimeAsync(0);
            await storing;
            expect(await store.loadToken('ws://a:1', identity.deviceId)).toEqual(token(identity.deviceId));
        });

        it('trusts only loopback endpoints with a stored device token', () => {
            expect(isLoopbackGatewayUrl('ws://127.0.0.1:18789')).toBe(true);
            expect(isLoopbackGatewayUrl('wss://localhost/x')).toBe(true);
            expect(isLoopbackGatewayUrl('ws://192.168.1.5:18789')).toBe(false);
            expect(isLoopbackGatewayUrl('wss://127.0.0.1.evil.example')).toBe(false);
            expect(isLoopbackGatewayUrl('not a url')).toBe(false);
        });
    });
});
