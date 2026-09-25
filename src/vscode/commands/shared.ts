import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

export const log = vscode.window.createOutputChannel('OpenClaw', { log: true });

export const execFileAsync = promisify(execFile);

export type QuickPickOption<T extends string> = vscode.QuickPickItem & { value: T };