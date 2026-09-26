import * as vscode from 'vscode';
import {
    extractAccessInfoFromCli,
    extractAccessInfoFromConfig,
    formatAccessSummaryMarkdown,
    formatAccessSummaryShort,
    isRecord,
    mergeAccessInfo,
    redactEndpoint,
    redactPlainSecrets,
    uniqSorted,
    type AccessSummary
} from '../../core/accessInfo';
import {
    getHardeningCommandPrefix,
    getHardeningMode,
    getOpenClawConfigPath,
    getParentAtPath,
    loadOpenClawConfigRecord,
    readOpenClawConfig,
    writeOpenClawConfigRecord,
    type HardeningMode
} from '../../core/configIO';
import { computeToolToggle, readEntryAtPath, type ToolEntry } from '../../core/tools';
import { splitHardeningCommand } from '../../core/hardeningCommand';
import { openHardeningSettings, getDashboardUrl } from '../config';
import { execFileAsync } from './shared';
import { getHardeningTerminal, getOverviewProvider } from './terminals';
import { isCommandAvailable, showMissingNodeMessage, runSetupFlow } from './setup';

/** Run the complete hardening flow (check readiness, then execute). */
export async function runHardeningFlow() {
    const readiness = await ensureHardeningCommandReady();
    if (!readiness) {
        return;
    }

    const { prefix, mode } = readiness;
    const commands: string[] = [];

    commands.push(`${prefix} security audit`);
    if (mode === 'auditFix' || mode === 'full') {
        commands.push(`${prefix} security audit --fix`);
    }
    if (mode === 'full') {
        commands.push(`${prefix} security audit --deep`);
    }

    const terminalInstance = getHardeningTerminal();
    terminalInstance.show(true);
    for (const command of commands) {
        terminalInstance.sendText(command);
    }

    getOverviewProvider()?.setLastRun(new Date());
    vscode.window.showInformationMessage('OpenClaw hardening commands sent. Review the terminal output.');
}

/** Run the hardening status check in a terminal. */
export async function runHardeningStatusCheck() {
    const readiness = await ensureHardeningCommandReady();
    if (!readiness) {
        return;
    }
    const terminalInstance = getHardeningTerminal();
    terminalInstance.show(true);
    terminalInstance.sendText(`${readiness.prefix} status --all`);
    vscode.window.showInformationMessage('Running OpenClaw status --all.');
}

/** Build and display the hardening access summary document. */
export async function showHardeningAccessSummary() {
    const readiness = await ensureHardeningCommandReady();
    if (!readiness) {
        return;
    }

    const summary = await buildHardeningAccessSummary(readiness.prefix);
    getOverviewProvider()?.setAccessSummary(summary);

    const document = await vscode.workspace.openTextDocument({
        content: summary.markdown,
        language: 'markdown'
    });
    await vscode.window.showTextDocument(document, { preview: true });
}

async function buildHardeningAccessSummary(prefix: string): Promise<AccessSummary> {
    const configPath = getOpenClawConfigPath();
    const configResult = await readOpenClawConfig(configPath);
    const configInfo = extractAccessInfoFromConfig(configResult.config, configPath);

    const cliResult = await runStatusAll(prefix);
    const cliInfo = extractAccessInfoFromCli(cliResult.output);

    const combined = mergeAccessInfo(configInfo, cliInfo);
    combined.networkEndpoints = uniqSorted([
        ...combined.networkEndpoints.map((e) => redactEndpoint(e)),
        redactEndpoint(getDashboardUrl())
    ]);

    const short = formatAccessSummaryShort(combined, configResult.error, cliResult.error);
    const markdown = formatAccessSummaryMarkdown(
        combined,
        configResult.error,
        cliResult.error,
        cliResult.output,
        configPath
    );

    return { short, markdown, generatedAt: new Date() };
}

/** Run the hardening command's `status --all` via execFile (no shell); returned error text is credential-redacted since execFile embeds child stderr. */
async function runStatusAll(prefix: string): Promise<{ output?: string; error?: string }> {
    try {
        const parsed = splitHardeningCommand(prefix);
        if (!parsed) {
            return { error: 'Hardening command is invalid (shell metacharacters or unbalanced quotes are not allowed).' };
        }
        const { stdout, stderr } = await execFileAsync(
            parsed.executable,
            [...parsed.args, 'status', '--all'],
            { maxBuffer: 1024 * 1024 }
        );
        const output = [stdout, stderr].filter(Boolean).join('\n').trim();
        return { output: output.length > 0 ? output : undefined };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { error: redactPlainSecrets(message.replace(/https?:\/\/\S+/g, (m) => redactEndpoint(m))) };
    }
}

/** Toggle a tool entry's enabled flag in the config. */
export async function toggleToolEntry(tool: ToolEntry) {
    const { config, error, path: configPath } = await loadOpenClawConfigRecord();
    if (!config) {
        vscode.window.showErrorMessage(error ?? 'OpenClaw config not found.');
        return;
    }
    const parentInfo = getParentAtPath(config, tool.path);
    if (!parentInfo) {
        vscode.window.showErrorMessage(`Unable to locate tool "${tool.label}" in config.`);
        return;
    }
    const { parent, key } = parentInfo;
    const toggle = computeToolToggle(readEntryAtPath(parent, key));
    if (!toggle.ok) {
        vscode.window.showErrorMessage(
            toggle.reason === 'missing'
                ? `Unable to locate tool "${tool.label}" in config.`
                : `Tool "${tool.label}" has an unsupported format.`
        );
        return;
    }

    if (Array.isArray(parent) && typeof key === 'number') {
        parent[key] = toggle.nextEntry;
    } else if (isRecord(parent) && typeof key === 'string') {
        parent[key] = toggle.nextEntry;
    }

    await writeOpenClawConfigRecord(configPath, config);
    getOverviewProvider()?.refreshTools();
    vscode.window.showInformationMessage(
        `${toggle.enabled ? 'Enabled' : 'Disabled'} tool "${tool.label}".`
    );
}

/** Uninstall a tool entry described in the config. */
export async function uninstallToolEntry(tool: ToolEntry) {
    const { config, error, path: configPath } = await loadOpenClawConfigRecord();
    if (!config) {
        vscode.window.showErrorMessage(error ?? 'OpenClaw config not found.');
        return;
    }
    const parentInfo = getParentAtPath(config, tool.path);
    if (!parentInfo) {
        vscode.window.showErrorMessage(`Unable to locate tool "${tool.label}" in config.`);
        return;
    }

    const action = await vscode.window.showWarningMessage(
        `Remove "${tool.label}" from OpenClaw tools?`,
        { modal: true },
        'Remove'
    );
    if (action !== 'Remove') {
        return;
    }

    const { parent, key } = parentInfo;
    if (Array.isArray(parent) && typeof key === 'number') {
        parent.splice(key, 1);
    } else if (isRecord(parent) && typeof key === 'string') {
        delete parent[key];
    }

    await writeOpenClawConfigRecord(configPath, config);
    getOverviewProvider()?.refreshTools();
    vscode.window.showInformationMessage(`Removed tool "${tool.label}".`);
}

/** Ensure the hardening command is usable, prompting for setup when missing. */
export async function ensureHardeningCommandReady(): Promise<{ prefix: string; mode: HardeningMode } | null> {
    const prefix = getHardeningCommandPrefix();
    if (!prefix) {
        vscode.window.showErrorMessage('OpenClaw hardening command is empty. Update OpenClaw: Hardening Command.');
        await openHardeningSettings();
        return null;
    }

    const parsed = splitHardeningCommand(prefix);
    if (!parsed) {
        vscode.window.showErrorMessage(
            'OpenClaw hardening command is invalid: use a single executable with plain arguments (shell metacharacters are not allowed). Update OpenClaw: Hardening Command.'
        );
        await openHardeningSettings();
        return null;
    }
    const executable = parsed.executable;
    if (!vscode.workspace.isTrusted) {
        vscode.window.showErrorMessage(
            'OpenClaw hardening commands are disabled in untrusted workspaces. Trust this workspace and retry.'
        );
        return null;
    }

    if (executable === 'openclaw' || executable === 'openclaw.exe') {
        const hasNode = await isCommandAvailable('node');
        if (!hasNode) {
            await showMissingNodeMessage();
            return null;
        }
    }

    const available = await isCommandAvailable(executable);
    if (!available) {
        const action = await vscode.window.showErrorMessage(
            `Command not found: ${executable}. Update OpenClaw: Hardening Command or install the OpenClaw CLI.`,
            'Install CLI',
            'Open settings'
        );
        if (action === 'Install CLI') {
            await runSetupFlow();
        } else if (action === 'Open settings') {
            await openHardeningSettings();
        }
        return null;
    }

    return { prefix, mode: getHardeningMode() };
}