import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type * as ProjectConfigModule from '../chat/acpxProjectConfig';

let showWarningMock = vi.mocked(vscode.window.showWarningMessage);
let showTextDocumentMock = vi.fn();

/** A fresh module with its own vscode mock, so session approvals never leak between tests. */
async function freshModule(): Promise<typeof ProjectConfigModule> {
    vi.resetModules();
    const isolatedVscode = await vi.importActual<typeof vscode>('vscode');
    showWarningMock = vi.mocked(isolatedVscode.window.showWarningMessage);
    showTextDocumentMock = vi.fn(async () => ({ document: { isDirty: false } }));
    Object.assign(isolatedVscode.window, { showTextDocument: showTextDocumentMock });
    return await vi.importActual<typeof import('../chat/acpxProjectConfig')>('../chat/acpxProjectConfig');
}

const posixOnly = process.platform === 'win32' ? it.skip : it;

function memoryStore() {
    const values = new Map<string, unknown>();
    return { values, get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, value); } };
}

describe('acpxProjectConfig', () => {
    let workspace: string;
    let configPath: string;
    let config: typeof ProjectConfigModule;

    beforeEach(async () => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-acpxrc-'));
        configPath = path.join(workspace, '.acpxrc.json');
        config = await freshModule();
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

        posixOnly('refuses a symlink to a device instead of reading it without end', () => {
            fs.symlinkSync('/dev/zero', configPath);
            expect(config.checkProjectConfig(workspace)).toEqual({ status: 'unreadable', configPath });
        });

        posixOnly('refuses a FIFO without waiting for a writer', () => {
            execFileSync('mkfifo', [configPath]);
            expect(config.checkProjectConfig(workspace)).toEqual({ status: 'unreadable', configPath });
        });

        it('refuses a config over 256 KiB', () => {
            fs.writeFileSync(configPath, `{"x":"${'y'.repeat(256 * 1024)}"}`);
            expect(config.checkProjectConfig(workspace)).toEqual({ status: 'unreadable', configPath });
        });

        posixOnly('follows a symlink to a regular file, as acpx does', () => {
            const target = path.join(workspace, 'real.json');
            fs.writeFileSync(target, '{}');
            fs.symlinkSync(target, configPath);
            expect(config.checkProjectConfig(workspace).status).toBe('unapproved');
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
            const reloaded = await freshModule();
            reloaded.useProjectConfigApprovalStore(store);
            expect(showWarningMock).not.toHaveBeenCalled();
            expect(reloaded.checkProjectConfig(workspace)).toEqual({ status: 'trusted' });
        });

        describe('for a config too long to preview', () => {
            beforeEach(() => {
                fs.writeFileSync(configPath, `{"x":"${'y'.repeat(10000)}"}`);
            });

            it('offers only to open the file, from a bounded preview', async () => {
                showWarningMock.mockResolvedValue(undefined);
                await expect(config.requestProjectConfigApproval(unapproved())).resolves.toBe(false);
                const [, options, ...actions] = showWarningMock.mock.calls[0];
                expect((options as vscode.MessageOptions).detail!.length).toBeLessThan(2300);
                expect(actions).toEqual(['Open File to Review']);
                expect(showTextDocumentMock).not.toHaveBeenCalled();
            });

            it('approves once the full file was opened and then allowed', async () => {
                showWarningMock.mockResolvedValueOnce('Open File to Review' as never).mockResolvedValueOnce('Allow and Run' as never);
                await expect(config.requestProjectConfigApproval(unapproved())).resolves.toBe(true);
                expect(showTextDocumentMock).toHaveBeenCalledWith(expect.objectContaining({ fsPath: configPath }), { preview: true });
                expect(config.checkProjectConfig(workspace)).toEqual({ status: 'trusted' });
            });

            it('refuses when the reviewed buffer has unsaved changes, as acpx reads the file', async () => {
                showTextDocumentMock.mockResolvedValueOnce({ document: { isDirty: true } });
                showWarningMock.mockResolvedValueOnce('Open File to Review' as never).mockResolvedValueOnce('Allow and Run' as never);
                await expect(config.requestProjectConfigApproval(unapproved())).resolves.toBe(false);
                expect(showWarningMock).toHaveBeenLastCalledWith(expect.stringContaining('unsaved changes'));
                expect(config.checkProjectConfig(workspace).status).toBe('unapproved');
            });

            it('refuses when the file changed while it was open for review', async () => {
                const check = unapproved();
                showWarningMock.mockResolvedValueOnce('Open File to Review' as never).mockImplementationOnce(async () => {
                    fs.writeFileSync(configPath, '{"agents":{"codex":{"argv":["sh"]}}}');
                    return 'Allow and Run' as never;
                });
                await expect(config.requestProjectConfigApproval(check)).resolves.toBe(false);
                expect(config.checkProjectConfig(workspace).status).toBe('unapproved');
            });
        });
    });
});
