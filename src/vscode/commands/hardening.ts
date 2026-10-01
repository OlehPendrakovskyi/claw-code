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
import { resolveCommandLaunch } from '../../core/cliLauncher';
import { envWithAbsolutePath } from '../../core/searchPath';
import { openHardeningSettings, getDashboardUrl } from '../config';
import { execFileAsync, isOpenClawExecutable } from './shared';
import { errorMessage } from '../../core/errors';
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

/** Run the hardening command's `status --all` via execFile (no shell); returned error text is credential-redacted since execFile embeds child stderr.
 *  The extension runs it itself, so it is spawned by an absolute path, and it and what it starts see only absolute PATH entries. */
async function runStatusAll(prefix: string): Promise<{ output?: string; error?: string }> {
    try {
        const parsed = splitHardeningCommand(prefix);
        if (!parsed) {
            return { error: 'Hardening command is invalid (shell metacharacters or unbalanced quotes are not allowed).' };
        }
        // An npm `openclaw.cmd` runs as its JS entry under Node, as a .cmd cannot be spawned without a shell.
        const launch = resolveCommandLaunch(parsed.executable);
        if ('missing' in launch) {
            return { error: launch.missing === 'node'
                ? `Hardening command ${parsed.executable} needs Node.js, found on no absolute PATH entry.`
                : `Hardening command not found: ${parsed.executable} is on no absolute PATH entry.` };
        }
        const { stdout, stderr } = await execFileAsync(
            launch.command,
            [...launch.args, ...parsed.args, 'status', '--all'],
            { maxBuffer: 1024 * 1024, env: envWithAbsolutePath() }
        );
        const output = [stdout, stderr].filter(Boolean).join('\n').trim();
        return { output: output.length > 0 ? output : undefined };
    } catch (error) {
        const message = errorMessage(error);
        return { error: redactPlainSecrets(message.replace(/https?:\/\/\S+/g, (m) => redactEndpoint(m))) };
    }
}

/** Toggle a tool entry's enabled flag in the config. */
export async function toggleToolEntry(tool: ToolEntry) {
    await withToolEntry(tool, (parent, key) => {
        const toggle = computeToolToggle(readEntryAtPath(parent, key));
        if (!toggle.ok) {
            return {
                error:
                    toggle.reason === 'missing'
                        ? `Unable to locate tool "${tool.label}" in config.`
                        : `Tool "${tool.label}" has an unsupported format.`
            };
        }

        if (Array.isArray(parent) && typeof key === 'number') {
            parent[key] = toggle.nextEntry;
        } else if (isRecord(parent) && typeof key === 'string') {
            parent[key] = toggle.nextEntry;
        }

        return { write: true, message: `${toggle.enabled ? 'Enabled' : 'Disabled'} tool "${tool.label}".` };
    });
}

/** Uninstall a tool entry described in the config. */
export async function uninstallToolEntry(tool: ToolEntry) {
    await withToolEntry(tool, async (parent, key) => {
        const action = await vscode.window.showWarningMessage(
            `Remove "${tool.label}" from OpenClaw tools?`,
            { modal: true },
            'Remove'
        );
        if (action !== 'Remove') {
            return { write: false };
        }

        if (Array.isArray(parent) && typeof key === 'number') {
            parent.splice(key, 1);
        } else if (isRecord(parent) && typeof key === 'string') {
            delete parent[key];
        }

        return { write: true, message: `Removed tool "${tool.label}".` };
    });
}

type ToolEntryMutation =
    | { write: false }
    | { write: true; message: string }
    | { error: string };

/** Resolve a tool entry in the config, run `mutate`, then persist and refresh on a successful write. */
async function withToolEntry(
    tool: ToolEntry,
    mutate: (
        parent: Record<string, unknown> | unknown[],
        key: string | number
    ) => ToolEntryMutation | Promise<ToolEntryMutation>
) {
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

    const result = await mutate(parentInfo.parent, parentInfo.key);
    if ('error' in result) {
        vscode.window.showErrorMessage(result.error);
        return;
    }
    if (!result.write) {
        return;
    }

    await writeOpenClawConfigRecord(configPath, config);
    getOverviewProvider()?.refreshTools();
    vscode.window.showInformationMessage(result.message);
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

    if (isOpenClawExecutable(executable)) {
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