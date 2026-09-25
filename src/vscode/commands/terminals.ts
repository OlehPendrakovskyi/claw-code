import * as vscode from 'vscode';
import type { OverviewTreeProvider } from '../../overview/OverviewTreeProvider';

let terminal: vscode.Terminal | undefined;
let setupTerminal: vscode.Terminal | undefined;
let hardeningTerminal: vscode.Terminal | undefined;
let overviewProvider: OverviewTreeProvider | undefined;

export function setOverviewProvider(provider: OverviewTreeProvider | undefined) {
    overviewProvider = provider;
}

export function getOverviewProvider(): OverviewTreeProvider | undefined {
    return overviewProvider;
}

export function disposeTerminals() {
    if (terminal) {
        terminal.dispose();
        terminal = undefined;
    }
    if (setupTerminal) {
        setupTerminal.dispose();
        setupTerminal = undefined;
    }
    if (hardeningTerminal) {
        hardeningTerminal.dispose();
        hardeningTerminal = undefined;
    }
}

export function forgetTerminal(closedTerminal: vscode.Terminal): boolean {
    let forgotten = false;
    if (terminal && closedTerminal === terminal) {
        terminal = undefined;
        forgotten = true;
    }
    if (setupTerminal && closedTerminal === setupTerminal) {
        setupTerminal = undefined;
    }
    if (hardeningTerminal && closedTerminal === hardeningTerminal) {
        hardeningTerminal = undefined;
    }
    return forgotten;
}

export function getSetupTerminal() {
    if (!setupTerminal) {
        setupTerminal = vscode.window.createTerminal('OpenClaw Setup');
    }
    return setupTerminal;
}

export function getOpenClawTerminal() {
    if (!terminal) {
        terminal = vscode.window.createTerminal('OpenClaw');
    }
    return terminal;
}

export function getHardeningTerminal() {
    if (!hardeningTerminal) {
        hardeningTerminal = vscode.window.createTerminal('OpenClaw Hardening');
    }
    return hardeningTerminal;
}