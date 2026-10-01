import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

/** Shared output channel for extension logging. */
export const log = vscode.window.createOutputChannel('OpenClaw', { log: true });

/** Promisified `execFile` used for shell-free command execution. */
export const execFileAsync = promisify(execFile);

/** Quick pick item that carries a typed `value` payload. */
export type QuickPickOption<T extends string> = vscode.QuickPickItem & { value: T };

/** Copy text to the clipboard and confirm with an information toast. */
export async function copyToClipboard(text: string, message: string) {
    await vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(message);
}

/** Whether an executable name is the OpenClaw CLI, with or without the Windows extension. */
export function isOpenClawExecutable(executable: string) {
    return executable === 'openclaw' || executable === 'openclaw.exe';
}
