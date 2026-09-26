import * as vscode from 'vscode';
import type { OverviewTreeProvider } from '../../overview/OverviewTreeProvider';

let terminal: vscode.Terminal | undefined;
let setupTerminal: vscode.Terminal | undefined;
let hardeningTerminal: vscode.Terminal | undefined;
let overviewProvider: OverviewTreeProvider | undefined;

/** Register the overview tree provider used for refreshes. */
export function setOverviewProvider(provider: OverviewTreeProvider | undefined) {
    overviewProvider = provider;
}

/** Return the registered overview tree provider, if any. */
export function getOverviewProvider(): OverviewTreeProvider | undefined {
    return overviewProvider;
}

/** Dispose every managed terminal and clear its stored reference. */
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

/** Drop the stored reference to a closed terminal; reports whether it was the main terminal. */
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

/** Lazily create and return the setup terminal. */
export function getSetupTerminal() {
    if (!setupTerminal) {
        setupTerminal = vscode.window.createTerminal('OpenClaw Setup');
    }
    return setupTerminal;
}

/** Lazily create and return the main OpenClaw terminal. */
export function getOpenClawTerminal() {
    if (!terminal) {
        terminal = vscode.window.createTerminal('OpenClaw');
    }
    return terminal;
}

/** Lazily create and return the hardening terminal. */
export function getHardeningTerminal() {
    if (!hardeningTerminal) {
        hardeningTerminal = vscode.window.createTerminal('OpenClaw Hardening');
    }
    return hardeningTerminal;
}