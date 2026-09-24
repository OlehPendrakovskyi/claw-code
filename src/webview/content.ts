import * as vscode from 'vscode';
import { CONTENT_CSS } from './content-css';
import { CONTENT_JS } from './content-js';

export interface SlashCommandEntry {
    name: string;
    description: string;
    icon: string;
    placeholder: string;
}

export function getWebviewContent(
    webview: vscode.Webview,
    _extensionUri: vscode.Uri,
    isSidebar: boolean
): string {
    const nonce = getNonce();
    const cspSource = webview.cspSource;

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; img-src ${cspSource}; font-src ${cspSource}; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <style nonce="${nonce}">${CONTENT_CSS}    </style>
</head>
<body>
    <div class="app">
        <div class="header">
            <div class="header-brand">
                <div class="header-title">OpenClaw</div>
                <div class="header-subtitle">Each panel keeps its own composer and completion state</div>
            </div>
            <div class="header-actions">
                <select class="dimension-select" id="dimensionSelect" title="Grid dimension">
                    <option value="1x1">1x1</option>
                </select>
                <button class="icon-btn" id="btn-flip" title="Flip layout orientation">&#x21C4;</button>
                <button class="icon-btn" id="btn-new" title="New thread">+</button>
                <button class="icon-btn" id="btn-split" title="Split from active thread">&#x2398;</button>
                ${isSidebar ? '<button class="icon-btn" id="btn-popout" title="Open in editor">&#x2197;</button>' : ''}
            </div>
        </div>

        <div class="workspace">
            <div class="pane-grid" id="paneGrid"></div>
        </div>
    </div>

    <script nonce="${nonce}">${CONTENT_JS}    </script>
</body>
</html>`;
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 32; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}
