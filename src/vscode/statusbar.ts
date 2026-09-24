import * as vscode from 'vscode';

export const STATUS_LABEL = 'OpenClaw';

let statusBarItem: vscode.StatusBarItem | undefined;

export function initStatusBar(): vscode.StatusBarItem {
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'openclaw.connect';
    statusBarItem.name = STATUS_LABEL;
    statusBarItem.accessibilityInformation = {
        label: STATUS_LABEL,
        role: 'button'
    };
    return statusBarItem;
}

export function disposeStatusBar() {
    statusBarItem?.dispose();
    statusBarItem = undefined;
}

export function setStatus(state: 'idle' | 'connecting' | 'connected' | 'error') {
    if (!statusBarItem) {
        return;
    }
    switch (state) {
        case 'connecting':
            statusBarItem.text = formatStatusText('$(sync~spin)');
            statusBarItem.tooltip = 'Connection in progress';
            break;
        case 'connected':
            statusBarItem.text = formatStatusText('$(check)');
            statusBarItem.tooltip = 'OpenClaw command sent';
            break;
        case 'error':
            statusBarItem.text = formatStatusText('$(alert)');
            statusBarItem.tooltip = 'Connection failed. Click to retry.';
            break;
        case 'idle':
        default:
            statusBarItem.text = formatStatusText('$(plug)');
            statusBarItem.tooltip = 'Click to connect to OpenClaw';
            break;
    }
}

export function formatStatusText(icon: string) {
    return `${icon} ${STATUS_LABEL}`;
}
