import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

/** Shared output channel for extension logging. */
export const log = vscode.window.createOutputChannel('OpenClaw', { log: true });

/** Promisified `execFile` used for shell-free command execution. */
export const execFileAsync = promisify(execFile);

/** Quick pick item that carries a typed `value` payload. */
export type QuickPickOption<T extends string> = vscode.QuickPickItem & { value: T };