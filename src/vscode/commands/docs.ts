import * as vscode from 'vscode';
import { getDashboardUrl } from '../config';
import { OPENCLAW_NPM_INSTALL } from '../../core/setupOptions';

const OPENCLAW_DOCS_URL = 'https://docs.openclaw.ai/';
const OPENCLAW_ONBOARD_DOCS_URL = 'https://docs.openclaw.ai/start/wizard';
const OPENCLAW_UPDATE_DOCS_URL = 'https://docs.openclaw.ai/install/updating';
const OPENCLAW_SECURITY_DOCS_URL = 'https://docs.openclaw.ai/gateway/security';

export async function copyInstallCommand() {
    await vscode.env.clipboard.writeText(OPENCLAW_NPM_INSTALL);
    vscode.window.showInformationMessage('Install command copied to clipboard.');
}

export async function openDocs() {
    await vscode.env.openExternal(vscode.Uri.parse(OPENCLAW_DOCS_URL));
}

export async function openOnboardDocs() {
    await vscode.env.openExternal(vscode.Uri.parse(OPENCLAW_ONBOARD_DOCS_URL));
}

/** Open the user-configured dashboard URL; http(s) schemes only. */
export async function openDashboard() {
    const url = getDashboardUrl();
    let uri: vscode.Uri;
    try {
        uri = vscode.Uri.parse(url);
    } catch {
        vscode.window.showErrorMessage(
            `Invalid OpenClaw dashboard URL. Use an http(s) URL (openclaw.dashboardUrl).`
        );
        return;
    }
    if (uri.scheme !== 'http' && uri.scheme !== 'https') {
        vscode.window.showErrorMessage(
            `Refused to open dashboard URL with scheme '${uri.scheme}': only http/https is allowed (openclaw.dashboardUrl).`
        );
        return;
    }
    await vscode.env.openExternal(uri);
}

export async function openUpdateDocs() {
    await vscode.env.openExternal(vscode.Uri.parse(OPENCLAW_UPDATE_DOCS_URL));
}

export async function openSecurityDocs() {
    await vscode.env.openExternal(vscode.Uri.parse(OPENCLAW_SECURITY_DOCS_URL));
}

export async function openNodeDocs() {
    await vscode.env.openExternal(vscode.Uri.parse('https://nodejs.org/en/download'));
}