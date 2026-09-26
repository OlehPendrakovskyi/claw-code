import * as vscode from 'vscode';
import { migrateLegacyGatewayToken } from '../core/gatewayConfig';

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

    it('returns false and touches nothing when no legacy value exists', async () => {
        const store = secrets();
        const { update } = configWith(undefined);
        await expect(migrateLegacyGatewayToken(makeContext(store))).resolves.toBe(false);
        expect(store.store).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
    });

    it('migrates a legacy value into an empty SecretStorage and cleans up scopes that held it', async () => {
        const store = secrets();
        const { update } = configWith({
            globalValue: 'legacy-token',
            workspaceFolderValue: 'folder-token',
        });
        await expect(migrateLegacyGatewayToken(makeContext(store))).resolves.toBe(true);
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
        await expect(migrateLegacyGatewayToken(makeContext(store))).resolves.toBe(true);
        expect(store.store).not.toHaveBeenCalled();
        expect(update).toHaveBeenCalledTimes(1);
    });

    it('tolerates a failing scope update and still returns true', async () => {
        const store = secrets();
        const { update } = configWith({ workspaceValue: 'legacy-token' }, () =>
            Promise.reject(new Error('no folder open')),
        );
        await expect(migrateLegacyGatewayToken(makeContext(store))).resolves.toBe(true);
        expect(store.store).toHaveBeenCalledWith('openclaw.gateway.token', 'legacy-token');
        expect(update).toHaveBeenCalledWith('gateway.token', undefined, vscode.ConfigurationTarget.Workspace);
    });
});