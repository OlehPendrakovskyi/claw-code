import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as ProjectConfigModule from '../chat/acpxProjectConfig';

let showWarningMock = jest.mocked(vscode.window.showWarningMessage);

/** A fresh module with its own vscode mock, so session approvals never leak between tests. */
function freshModule(): typeof ProjectConfigModule {
    let module: typeof ProjectConfigModule | undefined;
    jest.isolateModules(() => {
        showWarningMock = jest.mocked(jest.requireActual<typeof vscode>('vscode').window.showWarningMessage);
        module = jest.requireActual('../chat/acpxProjectConfig');
    });
    return module!;
}

function memoryStore() {
    const values = new Map<string, unknown>();
    return { values, get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, value); } };
}

describe('acpxProjectConfig', () => {
    let workspace: string;
    let configPath: string;
    let config: typeof ProjectConfigModule;

    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-acpxrc-'));
        configPath = path.join(workspace, '.acpxrc.json');
        config = freshModule();
    });

    afterEach(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    const unapproved = () => {
        const check = config.checkProjectConfig(workspace);
        if (check.status !== 'unapproved') {
            throw new Error(`expected an unapproved config, got ${check.status}`);
        }
        return check;
    };

    describe('checkProjectConfig', () => {
        it('trusts a workspace without an acpx config', () => {
            expect(config.checkProjectConfig(workspace)).toEqual({ status: 'trusted' });
        });

        it('holds back a workspace config nobody approved, with its content for review', () => {
            fs.writeFileSync(configPath, '{"agents":{"codex":{"argv":["sh","-c","id"]}}}');
            const check = unapproved();
            expect(check.configPath).toBe(configPath);
            expect(check.text).toContain('"sh","-c","id"');
        });

        it('reports a config path it cannot read as a file', () => {
            fs.mkdirSync(configPath);
            expect(config.checkProjectConfig(workspace)).toEqual({ status: 'unreadable', configPath });
        });
    });

    describe('requestProjectConfigApproval', () => {
        it('trusts exactly the approved bytes afterwards', async () => {
            fs.writeFileSync(configPath, '{"agents":{}}');
            showWarningMock.mockResolvedValue('Allow and Run' as never);
            await expect(config.requestProjectConfigApproval(unapproved())).resolves.toBe(true);
            expect(showWarningMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ modal: true }), 'Allow and Run');
            expect(config.checkProjectConfig(workspace)).toEqual({ status: 'trusted' });
            fs.writeFileSync(configPath, '{"agents":{"codex":{"argv":["sh"]}}}');
            expect(config.checkProjectConfig(workspace).status).toBe('unapproved');
        });

        it('remembers nothing when the modal is dismissed', async () => {
            fs.writeFileSync(configPath, '{}');
            showWarningMock.mockResolvedValue(undefined);
            await expect(config.requestProjectConfigApproval(unapproved())).resolves.toBe(false);
            expect(config.checkProjectConfig(workspace).status).toBe('unapproved');
        });

        it('keys an approval by folder, so the same file elsewhere asks again', async () => {
            fs.writeFileSync(configPath, '{}');
            showWarningMock.mockResolvedValue('Allow and Run' as never);
            await config.requestProjectConfigApproval(unapproved());
            const other = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-acpxrc-other-'));
            try {
                fs.writeFileSync(path.join(other, '.acpxrc.json'), '{}');
                expect(config.checkProjectConfig(other).status).toBe('unapproved');
            } finally {
                fs.rmSync(other, { recursive: true, force: true });
            }
        });

        it('persists approvals in the configured store', async () => {
            const store = memoryStore();
            config.useProjectConfigApprovalStore(store);
            fs.writeFileSync(configPath, '{}');
            showWarningMock.mockResolvedValue('Allow and Run' as never);
            await config.requestProjectConfigApproval(unapproved());
            expect([...store.values.values()]).toEqual([[expect.stringContaining(workspace)]]);
            const reloaded = freshModule();
            reloaded.useProjectConfigApprovalStore(store);
            expect(showWarningMock).not.toHaveBeenCalled();
            expect(reloaded.checkProjectConfig(workspace)).toEqual({ status: 'trusted' });
        });

        it('shows a bounded preview of a large config', async () => {
            fs.writeFileSync(configPath, `{"x":"${'y'.repeat(10000)}"}`);
            showWarningMock.mockResolvedValue(undefined);
            await config.requestProjectConfigApproval(unapproved());
            const options = showWarningMock.mock.calls[0][1] as vscode.MessageOptions;
            expect(options.detail!.length).toBeLessThan(2200);
        });
    });
});
