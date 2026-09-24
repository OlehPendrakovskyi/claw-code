import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { TextEncoder } from 'util';
import { getOpenClawConfigPath } from '../core/configIO';

export async function openOpenClawConfig(createIfMissing: boolean) {
    const configPath = getOpenClawConfigPath();
    await openFileInEditor(configPath, createIfMissing, '{\n  \n}\n');
}

export async function openAuthProfiles() {
    const agentId = await vscode.window.showInputBox({
        prompt: 'Enter the agent id (folder name under ~/.openclaw/agents)',
        placeHolder: 'main'
    });
    if (!agentId) {
        return;
    }
    const profilesPath = path.join(os.homedir(), '.openclaw', 'agents', agentId, 'agent', 'auth-profiles.json');
    await openFileInEditor(profilesPath, true, '{\n  \n}\n');
}

export async function openFileInEditor(filePath: string, createIfMissing: boolean, initialContents: string) {
    const uri = vscode.Uri.file(filePath);
    const exists = await fileExists(uri);
    if (!exists && createIfMissing) {
        await ensureParentDirectory(uri);
        const encoder = new TextEncoder();
        await vscode.workspace.fs.writeFile(uri, encoder.encode(initialContents));
    }
    try {
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
        vscode.window.showErrorMessage(`Unable to open file: ${filePath}`);
        console.error(error);
    }
}

export async function fileExists(uri: vscode.Uri) {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

export async function ensureParentDirectory(uri: vscode.Uri) {
    const directory = vscode.Uri.file(path.dirname(uri.fsPath));
    try {
        await vscode.workspace.fs.stat(directory);
    } catch {
        await vscode.workspace.fs.createDirectory(directory);
    }
}

export async function openSettings() {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'openclaw.command');
}

export async function openHardeningSettings() {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'openclaw.hardening');
}
