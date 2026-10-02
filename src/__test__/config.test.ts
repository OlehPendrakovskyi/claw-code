import type { Mock } from 'vitest';
vi.mock('os', () => ({ homedir: () => '/home/u' }));

import * as vscode from 'vscode';
import { fileExists, getDashboardUrl, openAuthProfiles, openFileInEditor } from '../vscode/config';

const showInputBox = vi.mocked(vscode.window.showInputBox);
const showErrorMessage = vi.mocked(vscode.window.showErrorMessage);
const openTextDocument = vi.mocked(vscode.workspace.openTextDocument);
const stat = vi.mocked(vscode.workspace.fs.stat);
const writeFile = vi.mocked(vscode.workspace.fs.writeFile);
const createDirectory = vi.mocked(vscode.workspace.fs.createDirectory);

function showTextDocument(): Mock {
    return (vscode.window as unknown as { showTextDocument: Mock }).showTextDocument;
}

function statError() {
    return Object.assign(new Error('not found'), { code: 'ENOENT' });
}

beforeEach(() => {
    Object.assign(vscode.window, { showTextDocument: vi.fn(() => Promise.resolve({})) });
    showInputBox.mockReset().mockResolvedValue(undefined as never);
    showErrorMessage.mockReset().mockResolvedValue(undefined as never);
    openTextDocument.mockReset().mockResolvedValue({} as never);
    stat.mockReset().mockRejectedValue(statError());
    writeFile.mockReset().mockResolvedValue(undefined);
    createDirectory.mockReset().mockResolvedValue(undefined);
});

describe('vscode config helpers', () => {
    describe('isValidPathSegment via openAuthProfiles', () => {
        it.each([
            '../evil',
            '..',
            '.',
            'a/b',
            'a\\b',
            '.hidden/../x',
        ])('refuses the unsafe agent id %p without opening anything', async (agentId) => {
            showInputBox.mockResolvedValue(agentId as never);
            await openAuthProfiles();
            expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Invalid agent id'));
            expect(openTextDocument).not.toHaveBeenCalled();
            expect(writeFile).not.toHaveBeenCalled();
        });

        it('treats an empty agent id as a cancelled input, not an error', async () => {
            showInputBox.mockResolvedValue('' as never);
            await openAuthProfiles();
            expect(showErrorMessage).not.toHaveBeenCalled();
            expect(openTextDocument).not.toHaveBeenCalled();
        });

        it.each(['main', 'my-agent_1', '.hidden'])('accepts the safe agent id %p and opens its auth profiles', async (agentId) => {
            showInputBox.mockResolvedValue(agentId as never);
            openTextDocument.mockResolvedValue({} as never);
            await openAuthProfiles();
            expect(showErrorMessage).not.toHaveBeenCalled();
            const uri = openTextDocument.mock.calls[0]?.[0] as vscode.Uri | undefined;
            expect(uri?.fsPath.replace(/\\/g, '/')).toBe(`/home/u/.openclaw/agents/${agentId}/agent/auth-profiles.json`);
        });

        it('does nothing when the operator cancels the input box', async () => {
            showInputBox.mockResolvedValue(undefined as never);
            await openAuthProfiles();
            expect(showErrorMessage).not.toHaveBeenCalled();
            expect(openTextDocument).not.toHaveBeenCalled();
        });
    });

    describe('openFileInEditor', () => {
        it('creates a missing file with the initial contents, then opens it', async () => {
            openTextDocument.mockResolvedValue({} as never);
            await openFileInEditor('/home/u/.openclaw/openclaw.json', true, '{\n  \n}\n');
            expect(writeFile).toHaveBeenCalledTimes(1);
            expect(Buffer.from(writeFile.mock.calls[0][1] as Uint8Array).toString('utf8')).toBe('{\n  \n}\n');
            expect(createDirectory).toHaveBeenCalledTimes(1);
            expect(showTextDocument()).toHaveBeenCalledTimes(1);
            expect(showErrorMessage).not.toHaveBeenCalled();
        });

        it('does not overwrite an existing file', async () => {
            stat.mockResolvedValue({ type: vscode.FileType.File, ctime: 0, mtime: 0, size: 1 });
            openTextDocument.mockResolvedValue({} as never);
            await openFileInEditor('/home/u/.openclaw/openclaw.json', true, 'seed');
            expect(writeFile).not.toHaveBeenCalled();
            expect(createDirectory).not.toHaveBeenCalled();
        });

        it('leaves a missing file missing when creation is not requested', async () => {
            const opened = showTextDocument();
            await openFileInEditor('/home/u/nowhere.json', false, 'seed');
            expect(writeFile).not.toHaveBeenCalled();
            // The open is still attempted and, since the mock resolves, shown; only the write is skipped.
            expect(opened).toHaveBeenCalledTimes(1);
            expect(showErrorMessage).not.toHaveBeenCalled();
        });

        it('reports an open failure without throwing', async () => {
            openTextDocument.mockRejectedValue(new Error('disk full'));
            await expect(openFileInEditor('/home/u/nowhere.json', false, 'seed')).resolves.toBeUndefined();
            expect(showErrorMessage).toHaveBeenCalledWith('Unable to open file: /home/u/nowhere.json');
        });

        it('creates the parent directory only when it does not exist yet', async () => {
            openTextDocument.mockResolvedValue({} as never);
            stat.mockRejectedValueOnce(statError()).mockResolvedValueOnce({ type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 });
            await openFileInEditor('/home/u/.openclaw/openclaw.json', true, '{}');
            expect(createDirectory).not.toHaveBeenCalled();
        });
    });

    describe('fileExists', () => {
        it('survives any stat error', async () => {
            stat.mockRejectedValue(new Error('no permissions'));
            await expect(fileExists(vscode.Uri.file('/x'))).resolves.toBe(false);
        });
    });

    describe('getDashboardUrl', () => {
        function configure(value: unknown): void {
            vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
                get: () => value,
            } as unknown as vscode.WorkspaceConfiguration);
        }

        it('returns the configured URL trimmed', () => {
            configure('  https://gw.example.net/  ');
            expect(getDashboardUrl()).toBe('https://gw.example.net/');
        });

        it('falls back to the local default on an empty, blank or absent setting', () => {
            for (const value of ['', '   ', undefined]) {
                configure(value);
                expect(getDashboardUrl()).toBe('http://127.0.0.1:18789/');
            }
        });
    });
});
