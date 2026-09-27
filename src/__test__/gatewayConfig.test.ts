import * as vscode from 'vscode';
import { GatewayConfigService, migrateLegacyGatewayToken } from '../core/gatewayConfig';

type Inspection = {
    globalValue?: string;
    workspaceValue?: string;
    workspaceFolderValue?: string;
};

const secrets = () => ({
    get: jest.fn(async () => undefined as string | undefined),
    store: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
});

const configWith = (inspection: Inspection | undefined, updateImpl?: () => Promise<void>) => {
    const update = jest.fn(async () => {
        if (updateImpl) {
            await updateImpl();
        }
    });
    (vscode.workspace.getConfiguration as unknown as jest.Mock).mockReturnValue({
        get: jest.fn(),
        update,
        inspect: jest.fn(() => inspection),
    });
    return { update };
};

const makeContext = (secretStore: ReturnType<typeof secrets>) =>
    ({ secrets: secretStore } as unknown as vscode.ExtensionContext);

describe('migrateLegacyGatewayToken', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('returns noop and touches nothing when no legacy value exists', async () => {
        const store = secrets();
        const { update } = configWith(undefined);
        await expect(migrateLegacyGatewayToken(makeContext(store))).resolves.toBe('noop');
        expect(store.store).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
    });

    it('migrates a legacy value into an empty SecretStorage and cleans up scopes that held it', async () => {
        const store = secrets();
        const { update } = configWith({
            globalValue: 'legacy-token',
            workspaceFolderValue: 'folder-token',
        });
        await expect(migrateLegacyGatewayToken(makeContext(store))).resolves.toBe('completed');
        expect(store.store).toHaveBeenCalledWith('openclaw.gateway.token', 'folder-token');
        const targets = update.mock.calls.map((c: unknown[]) => c[2]);
        expect(targets).toEqual([
            vscode.ConfigurationTarget.Global,
            vscode.ConfigurationTarget.WorkspaceFolder,
        ]);
    });

    it('never overwrites an existing SecretStorage token with the legacy value', async () => {
        const store = secrets();
        store.get.mockResolvedValue('existing-secret-token');
        const { update } = configWith({ globalValue: 'legacy-token' });
        await expect(migrateLegacyGatewayToken(makeContext(store))).resolves.toBe('completed');
        expect(store.store).not.toHaveBeenCalled();
        expect(update).toHaveBeenCalledTimes(1);
    });

    it('stores the secret but reports an incomplete migration when a scope update fails', async () => {
        const store = secrets();
        const { update } = configWith({ workspaceValue: 'legacy-token' }, () =>
            Promise.reject(new Error('no folder open')),
        );
        await expect(migrateLegacyGatewayToken(makeContext(store))).resolves.toBe('incomplete');
        expect(store.store).toHaveBeenCalledWith('openclaw.gateway.token', 'legacy-token');
        expect(update).toHaveBeenCalledWith('gateway.token', undefined, vscode.ConfigurationTarget.Workspace);
        expect(vscode.window.showWarningMessage).toHaveBeenCalled();
    });
});

describe('collectLanguageIds (chained override keys)', () => {
    const collect = (parsed: Record<string, unknown>): string[] => {
        const into = new Set<string>();
        (GatewayConfigService as unknown as {
            collectLanguageIds: (parsed: Record<string, unknown>, into: Set<string>) => void;
        }).collectLanguageIds(parsed, into);
        return [...into];
    };

    it('splits chained bracket groups into individual language ids', () => {
        expect(collect({ '[typescript][javascript]': { 'openclaw.gateway.token': 'x' } })).toEqual([
            'typescript',
            'javascript',
        ]);
    });

    it('keeps single-language overrides and ignores non-object values', () => {
        expect(collect({ '[python]': {}, '[markdown]': 'not-an-object' })).toEqual(['python']);
    });
});