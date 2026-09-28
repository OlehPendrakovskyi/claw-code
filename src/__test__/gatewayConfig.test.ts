import * as vscode from 'vscode';
import {
  getGatewaySettings,
  getGatewayToken,
  isValidGatewayUrl,
  migrateLegacyGatewayToken,
  promptForGatewayToken,
  sendsTokenInCleartext,
  setGatewayToken,
} from '../core/gatewayConfig';

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
        it('returns noop and touches nothing when no legacy value exists', async () => {
            const model = new SettingsModel();
            useSettings(model, [folderA]);
            const store = secrets();

            await expect(migrateLegacyGatewayToken(makeContext(store))).resolves.toBe('noop');

            expect(store.store).not.toHaveBeenCalled();
            expect(model.updates).toEqual([]);
        });

        it('stores the most specific plain value and clears every level that held one', async () => {
            const model = new SettingsModel()
                .set('global', 'global-token')
                .set('folder', 'folder-token', { folder: folderA.toString() });
            useSettings(model, [folderA]);
            const store = secrets();

            await expect(migrateLegacyGatewayToken(makeContext(store))).resolves.toBe('completed');

            expect(store.store).toHaveBeenCalledWith('openclaw.gateway.token', 'folder-token');
            expect(model.has('global')).toBe(false);
            expect(model.has('folder', { folder: folderA.toString() })).toBe(false);
        });

        it('discovers language overrides through inspect().languageIds and prefers them over plain values', async () => {
            // A profile's settings.json lives outside any fixed path; the
            // Configuration API is the only source that sees it.
            const model = new SettingsModel()
                .set('workspace', 'workspace-token')
                .set('global', 'profile-language-token', { languageId: 'typescript' });
            useSettings(model);
            const store = secrets();

            await expect(migrateLegacyGatewayToken(makeContext(store))).resolves.toBe('completed');

            expect(store.store).toHaveBeenCalledWith('openclaw.gateway.token', 'profile-language-token');
            expect(model.has('global', { languageId: 'typescript' })).toBe(false);
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

            expect(store.store).toHaveBeenCalledWith('openclaw.gateway.token', 'b-python-token');
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

        it('reports incomplete on a failed update and warns only once per session', async () => {
            const model = new SettingsModel().set('workspace', 'legacy-token');
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
            expect(getGatewaySettings()).toEqual({ url: 'ws://127.0.0.1:18789', transport: 'auto' });
        });

        it('trims the URL and keeps a known transport', () => {
            useRawSettings({ 'gateway.url': '  wss://gw.example  ', 'gateway.transport': 'acpx' });
            expect(getGatewaySettings()).toEqual({ url: 'wss://gw.example', transport: 'acpx' });
        });

        it.each([[42, 'gateway'], [{ url: 'x' }, 'bogus'], ['   ', 7]])(
            'falls back for a hand-edited url %p and transport %p', (url, transport) => {
                useRawSettings({ 'gateway.url': url, 'gateway.transport': transport });
                expect(getGatewaySettings()).toEqual({
                    url: 'ws://127.0.0.1:18789',
                    transport: transport === 'gateway' ? 'gateway' : 'auto',
                });
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

        it('does not treat a lookalike host as loopback', () => {
            expect(sendsTokenInCleartext('ws://127.0.0.1.evil.example')).toBe(true);
            expect(sendsTokenInCleartext('ws://localhost.evil.example')).toBe(true);
        });
    });
});
