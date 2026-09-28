import * as vscode from 'vscode';
import { migrateLegacyGatewayToken } from '../core/gatewayConfig';

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

const makeContext = (secretStore: ReturnType<typeof secrets>) =>
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
});
