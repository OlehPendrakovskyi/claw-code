import * as vscode from 'vscode';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
    extractAccessInfoFromCli,
    extractAccessInfoFromConfig,
    formatAccessSummaryMarkdown,
    formatAccessSummaryShort,
    isRecord,
    mergeAccessInfo,
    uniqueList,
    type AccessSummary
} from '../core/accessInfo';
import {
    getHardeningCommandPrefix,
    getHardeningMode,
    getOpenClawConfigPath,
    getParentAtPath,
    loadOpenClawConfigRecord,
    readOpenClawConfig,
    writeOpenClawConfigRecord,
    type HardeningMode
} from '../core/configIO';
import { computeToolToggle, readEntryAtPath, type ToolEntry } from '../core/tools';
import { OPENCLAW_DASHBOARD_URL } from '../core/constants';
import type { OverviewTreeProvider } from '../overview/OverviewTreeProvider';
import {
    LEGACY_CLI_ALIASES,
    OPENCLAW_INSTALL_SCRIPT,
    OPENCLAW_NPM_INSTALL,
    getInstallOptions,
    getLegacyExecutable,
    getNodeInstallCommandForPlatform,
    getNodeInstallOptions,
    replaceExecutable
} from '../core/setupOptions';
import { setStatus } from './statusbar';
import { openOpenClawConfig, openAuthProfiles, openSettings, openHardeningSettings } from './config';

export const log = vscode.window.createOutputChannel('OpenClaw', { log: true });

const execAsync = promisify(exec);
const OPENCLAW_DOCS_URL = 'https://docs.openclaw.ai/';
const OPENCLAW_ONBOARD_DOCS_URL = 'https://docs.openclaw.ai/start/wizard';
const OPENCLAW_UPDATE_DOCS_URL = 'https://docs.openclaw.ai/install/updating';
const OPENCLAW_SECURITY_DOCS_URL = 'https://docs.openclaw.ai/gateway/security';
const OPENCLAW_PROVIDERS_DOCS_URL = 'https://docs.openclaw.ai/providers';
const PROVIDER_DOCS: Record<string, string> = {
    openai: 'https://docs.openclaw.ai/providers/openai',
    anthropic: 'https://docs.openclaw.ai/providers/anthropic',
    google: 'https://docs.openclaw.ai/providers/google',
    ollama: 'https://docs.openclaw.ai/providers/ollama',
    local: 'https://docs.openclaw.ai/pi'
};
type QuickPickOption<T extends string> = vscode.QuickPickItem & { value: T };

let terminal: vscode.Terminal | undefined;
let setupTerminal: vscode.Terminal | undefined;
let hardeningTerminal: vscode.Terminal | undefined;
let isConnecting = false;
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
    }
    if (setupTerminal) {
        setupTerminal.dispose();
    }
    if (hardeningTerminal) {
        hardeningTerminal.dispose();
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

export async function connect() {
    if (isConnecting) {
        vscode.window.showInformationMessage('OpenClaw connection is already in progress.');
        return;
    }

    isConnecting = true;
    log.info('connect() start');
    try {
        setStatus('connecting');

        const platform = os.platform();
        const isWindows = platform === 'win32';

        const config = vscode.workspace.getConfiguration('openclaw');
        const configuredCommand = (config.get<string>('command') ?? '').trim();
        const defaultCommand = isWindows ? 'openclaw status' : 'openclaw status';
        let command = configuredCommand.length > 0 ? configuredCommand : defaultCommand;

        if (!command) {
            setStatus('idle');
            vscode.window.showErrorMessage('OpenClaw command is empty. Update OpenClaw: Command in settings.');
            return;
        }

        let executable = command.split(/\s+/)[0];
        const legacyExecutable = getLegacyExecutable(executable);
        if (legacyExecutable) {
            const updatedCommand = await handleLegacyMigration(command, legacyExecutable);
            if (!updatedCommand) {
                setStatus('idle');
                return;
            }
            command = updatedCommand;
            executable = command.split(/\s+/)[0];
        }
        const needsNode = executable === 'openclaw' || executable === 'openclaw.exe';
        if (needsNode) {
            const hasNode = await isCommandAvailable('node');
            if (!hasNode) {
                setStatus('idle');
                await showMissingNodeMessage();
                return;
            }
        }

        const available = await isCommandAvailable(executable);
        if (!available) {
            setStatus('idle');
            const legacyAvailable = await findAvailableLegacyCli();
            if (legacyAvailable) {
                await showLegacyMissingOpenClawMessage(legacyAvailable);
                return;
            }
            const action = await vscode.window.showErrorMessage(
                `Command not found: ${executable}. Install OpenClaw or update OpenClaw: Command in settings.`,
                'Install CLI',
                'More options...'
            );

            if (action === 'Install CLI') {
                await runSetupFlow();
            } else if (action === 'More options...') {
                const pick = await showInstallMoreOptions();
                if (pick === 'copy') {
                    await copyInstallCommand();
                } else if (pick === 'docs') {
                    await openDocs();
                } else if (pick === 'settings') {
                    await openSettings();
                }
            }
            return;
        }

        // Create or reuse terminal
        if (!terminal) {
            terminal = vscode.window.createTerminal('OpenClaw');
        }

        // Show terminal and send command
        terminal.show(true); // true = preserve focus
        terminal.sendText(command);

        // Update status to connected
        setStatus('connected');

        vscode.window.showInformationMessage('OpenClaw command sent.');
    } catch (error) {
        setStatus('error');
        log.error('connect() failed', error);
        vscode.window.showErrorMessage(`Failed to connect: ${error}`);
    } finally {
        isConnecting = false;
    }
}

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

    overviewProvider?.setLastRun(new Date());
    vscode.window.showInformationMessage('OpenClaw hardening commands sent. Review the terminal output.');
}

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

export async function showHardeningAccessSummary() {
    const readiness = await ensureHardeningCommandReady();
    if (!readiness) {
        return;
    }

    const summary = await buildHardeningAccessSummary(readiness.prefix);
    overviewProvider?.setAccessSummary(summary);

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
    combined.networkEndpoints = uniqueList([...combined.networkEndpoints, OPENCLAW_DASHBOARD_URL]);

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

async function runStatusAll(prefix: string): Promise<{ output?: string; error?: string }> {
    try {
        const { stdout, stderr } = await execAsync(`${prefix} status --all`, {
            maxBuffer: 1024 * 1024
        });
        const output = [stdout, stderr].filter(Boolean).join('\n').trim();
        return { output: output.length > 0 ? output : undefined };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { error: message };
    }
}

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
    overviewProvider?.refreshTools();
    vscode.window.showInformationMessage(
        `${toggle.enabled ? 'Enabled' : 'Disabled'} tool "${tool.label}".`
    );
}

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
    overviewProvider?.refreshTools();
    vscode.window.showInformationMessage(`Removed tool "${tool.label}".`);
}

export async function ensureHardeningCommandReady(): Promise<{ prefix: string; mode: HardeningMode } | null> {
    const prefix = getHardeningCommandPrefix();
    if (!prefix) {
        vscode.window.showErrorMessage('OpenClaw hardening command is empty. Update OpenClaw: Hardening Command.');
        await openHardeningSettings();
        return null;
    }

    const executable = prefix.split(/\s+/)[0];
    if (!executable) {
        vscode.window.showErrorMessage('OpenClaw hardening command is invalid. Update OpenClaw: Hardening Command.');
        await openHardeningSettings();
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

export async function isCommandAvailable(command: string) {
    const probe = process.platform === 'win32' ? `where ${command}` : `command -v ${command}`;
    try {
        await execAsync(probe);
        return true;
    } catch {
        return false;
    }
}

export async function runSetupFlow() {
    const options = getInstallOptions();
    const pick = await vscode.window.showQuickPick(options, {
        placeHolder: 'Select an install method for the OpenClaw CLI'
    });

    if (!pick) {
        return;
    }

    if (pick.action === 'docs') {
        await openDocs();
        return;
    }

    if (pick.action === 'node') {
        await runNodeSetupFlow();
        return;
    }

    if (!pick.command) {
        return;
    }

    if (pick.command.includes('npm') && !(await isCommandAvailable('node'))) {
        await showMissingNodeMessage();
        return;
    }

    await runInstallCommand(pick.command);
}

export async function runModelSetupWizard() {
    const hasOpenClaw = await isCommandAvailable('openclaw');
    if (!hasOpenClaw) {
        const action = await vscode.window.showErrorMessage(
            'OpenClaw CLI not found. Install it to run the Model Setup Wizard.',
            'Install CLI',
            'More options...',
            'Cancel'
        );

        if (action === 'Install CLI') {
            await runSetupFlow();
        } else if (action === 'More options...') {
            const pick = await showInstallMoreOptions();
            if (pick === 'copy') {
                await copyInstallCommand();
            } else if (pick === 'docs') {
                await openDocs();
            } else if (pick === 'settings') {
                await openSettings();
            }
        }
        return;
    }

    const hasNode = await isCommandAvailable('node');
    if (!hasNode) {
        await showMissingNodeMessage();
        return;
    }

    const onboardingPick = await showOnboardingOptions();
    if (!onboardingPick) {
        return;
    }
    if (onboardingPick === 'docs') {
        await openOnboardDocs();
        return;
    }
    if (onboardingPick === 'run' || onboardingPick === 'runNoDaemon') {
        const command = onboardingPick === 'run' ? 'openclaw onboard --install-daemon' : 'openclaw onboard';
        await runSetupCommand(command);
        const continueAction = await vscode.window.showInformationMessage(
            'Complete the OpenClaw onboarding in the terminal, then continue.',
            'Continue'
        );
        if (continueAction !== 'Continue') {
            return;
        }
    }

    const providerPick = await showProviderOptions();
    if (!providerPick) {
        return;
    }

    await handleProviderSelection(providerPick);
    await runPostSetupChecks();
}


export async function runNodeSetupFlow() {
    const options = getNodeInstallOptions();
    const pick = await vscode.window.showQuickPick(options, {
        placeHolder: 'Install Node.js (Node 24 recommended, 22.16+ supported)'
    });

    if (!pick) {
        return;
    }

    if (pick.action === 'nodeDocs') {
        await openNodeDocs();
        return;
    }

    if (!pick.command) {
        return;
    }

    await runInstallCommand(pick.command);
}


async function runInstallCommand(command: string) {
    const decision = await vscode.window.showWarningMessage(
        `Run this command in a terminal?\n${command}`,
        { modal: true },
        'Run install',
        'Copy command',
        'Cancel'
    );

    if (decision === 'Copy command') {
        await vscode.env.clipboard.writeText(command);
        vscode.window.showInformationMessage('Install command copied to clipboard.');
        return;
    }

    if (decision !== 'Run install') {
        return;
    }

    if (!setupTerminal) {
        setupTerminal = vscode.window.createTerminal('OpenClaw Setup');
    }

    setupTerminal.show(true);
    setupTerminal.sendText(command);
}

async function runSetupCommand(command: string) {
    const terminalInstance = getSetupTerminal();
    terminalInstance.show(true);
    terminalInstance.sendText(command);
}

export async function runCliInTerminal(command: string, message: string) {
    const executable = command.split(/\s+/)[0];
    if (executable === 'openclaw' || executable === 'openclaw.exe') {
        const hasNode = await isCommandAvailable('node');
        if (!hasNode) {
            await showMissingNodeMessage();
            return;
        }
        const available = await isCommandAvailable(executable);
        if (!available) {
            const action = await vscode.window.showErrorMessage(
                `Command not found: ${executable}. Install OpenClaw first.`,
                'Install CLI'
            );
            if (action === 'Install CLI') {
                await runSetupFlow();
            }
            return;
        }
    }
    const terminalInstance = getOpenClawTerminal();
    terminalInstance.show(true);
    terminalInstance.sendText(command);
    vscode.window.showInformationMessage(message);
}

async function showOnboardingOptions(): Promise<'run' | 'runNoDaemon' | 'docs' | 'skip' | undefined> {
    const items: QuickPickOption<'run' | 'runNoDaemon' | 'docs' | 'skip'>[] = [
        {
            label: 'Run onboarding wizard (recommended)',
            description: 'Installs service and sets up auth, channels, and defaults',
            detail: 'openclaw onboard --install-daemon',
            value: 'run'
        },
        {
            label: 'Run onboarding without daemon',
            description: 'Skip background service install',
            detail: 'openclaw onboard',
            value: 'runNoDaemon'
        },
        {
            label: 'Open onboarding docs',
            value: 'docs'
        },
        {
            label: 'Skip onboarding for now',
            value: 'skip'
        }
    ];
    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Start with onboarding (recommended)'
    });
    return pick?.value;
}

type ProviderKey = 'openai' | 'anthropic' | 'google' | 'ollama' | 'local' | 'other';

async function showProviderOptions(): Promise<ProviderKey | undefined> {
    const items: QuickPickOption<ProviderKey>[] = [
        {
            label: 'OpenAI',
            description: 'API key or OAuth-based setup',
            value: 'openai'
        },
        {
            label: 'Anthropic',
            description: 'API key or Claude token setup',
            value: 'anthropic'
        },
        {
            label: 'Google (Gemini)',
            description: 'API key or OAuth-based setup',
            value: 'google'
        },
        {
            label: 'Ollama (local models)',
            description: 'Run models locally with Ollama',
            value: 'ollama'
        },
        {
            label: 'Local Pi RPC (default)',
            description: 'Use bundled Pi binary in RPC mode',
            value: 'local'
        },
        {
            label: 'Other / Custom provider',
            description: 'OpenAI-compatible, Anthropic-compatible, or 30+ more',
            value: 'other'
        }
    ];
    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select your model provider'
    });
    return pick?.value;
}

async function handleProviderSelection(provider: ProviderKey) {
    if (provider === 'other') {
        await vscode.env.openExternal(vscode.Uri.parse(OPENCLAW_PROVIDERS_DOCS_URL));
        return;
    }

    const labels: Record<string, string> = {
        openai: 'OpenAI',
        anthropic: 'Anthropic',
        google: 'Google (Gemini)',
        ollama: 'Ollama',
        local: 'Local Pi RPC'
    };
    const label = labels[provider] ?? provider;
    const action = await vscode.window.showQuickPick(
        [
            { label: `Open ${label} setup docs`, value: 'docs' },
            { label: 'Open OpenClaw config file', value: 'config' },
            { label: 'Open auth profiles', value: 'auth' },
            { label: 'Skip provider setup', value: 'skip' }
        ] as QuickPickOption<'docs' | 'config' | 'auth' | 'skip'>[],
        { placeHolder: `Finish ${label} setup` }
    );

    if (!action) {
        return;
    }

    if (action.value === 'docs') {
        const url = PROVIDER_DOCS[provider] ?? OPENCLAW_PROVIDERS_DOCS_URL;
        await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
    }

    if (action.value === 'config') {
        await openOpenClawConfig(true);
        return;
    }

    if (action.value === 'auth') {
        await openAuthProfiles();
    }
}

async function runPostSetupChecks() {
    const pick = await vscode.window.showQuickPick(
        [
            { label: 'Run doctor + status checks', value: 'run' },
            { label: 'Open dashboard', value: 'dashboard' },
            { label: 'Skip checks for now', value: 'skip' }
        ] as QuickPickOption<'run' | 'dashboard' | 'skip'>[],
        { placeHolder: 'Verify your OpenClaw setup' }
    );

    if (!pick || pick.value === 'skip') {
        return;
    }

    if (pick.value === 'dashboard') {
        await openDashboard();
        return;
    }

    const terminalInstance = getOpenClawTerminal();
    terminalInstance.show(true);
    terminalInstance.sendText('openclaw doctor');
    terminalInstance.sendText('openclaw gateway status');
    vscode.window.showInformationMessage('Running OpenClaw doctor and gateway status checks.');
}

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

export async function openDashboard() {
    await vscode.env.openExternal(vscode.Uri.parse(OPENCLAW_DASHBOARD_URL));
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

export async function showMissingNodeMessage() {
    const installCommand = getNodeInstallCommandForPlatform();
    const action = await vscode.window.showErrorMessage(
        'Node.js is required to run the OpenClaw CLI. Node 24 recommended (Node 22.16+ also supported).',
        'Install Node.js',
        'More options...'
    );

    if (action === 'Install Node.js') {
        await runNodeSetupFlow();
        return;
    }

    if (action === 'More options...') {
        const pick = await showNodeMoreOptions(installCommand);
        if (pick === 'copy' && installCommand) {
            await vscode.env.clipboard.writeText(installCommand);
            vscode.window.showInformationMessage('Node.js install command copied to clipboard.');
        } else if (pick === 'docs') {
            await openNodeDocs();
        }
    }
}


export async function updateOpenClawCommandSetting(command: string) {
    const config = vscode.workspace.getConfiguration('openclaw');
    await config.update('command', command, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage('Updated OpenClaw: Command setting.');
}

async function handleLegacyMigration(command: string, legacyExecutable: string): Promise<string | null> {
    const hasOpenClaw = await isCommandAvailable('openclaw');
    const newCommand = replaceExecutable(command, 'openclaw');
    const action = await vscode.window.showWarningMessage(
        `This command uses legacy "${legacyExecutable}". OpenClaw is the new name. Update to OpenClaw for safe migrations.`,
        hasOpenClaw ? 'Use openclaw' : 'Install OpenClaw',
        'More options...'
    );

    if (action === 'Use openclaw') {
        await updateOpenClawCommandSetting(newCommand);
        return newCommand;
    }

    if (action === 'Install OpenClaw') {
        await runSetupFlow();
        return null;
    }

    if (action === 'More options...') {
        const pick = await showLegacyMoreOptions();
        if (pick === 'updateDocs') {
            await openUpdateDocs();
        } else if (pick === 'copyInstall') {
            await vscode.env.clipboard.writeText(OPENCLAW_INSTALL_SCRIPT);
            vscode.window.showInformationMessage('Installer command copied to clipboard.');
        } else if (pick === 'copyNpm') {
            await vscode.env.clipboard.writeText(OPENCLAW_NPM_INSTALL);
            vscode.window.showInformationMessage('npm update command copied to clipboard.');
        } else if (pick === 'settings') {
            await openSettings();
        }
        return null;
    }

    return null;
}

async function findAvailableLegacyCli(): Promise<string | undefined> {
    for (const legacy of LEGACY_CLI_ALIASES) {
        if (await isCommandAvailable(legacy)) {
            return legacy;
        }
    }
    return undefined;
}

async function showLegacyMissingOpenClawMessage(legacyExecutable: string) {
    const action = await vscode.window.showErrorMessage(
        `Found legacy CLI "${legacyExecutable}". OpenClaw is the new name. Update to OpenClaw to continue.`,
        'Install OpenClaw',
        'More options...'
    );

    if (action === 'Install OpenClaw') {
        await runSetupFlow();
        return;
    }

    if (action === 'More options...') {
        const pick = await showLegacyMoreOptions();
        if (pick === 'updateDocs') {
            await openUpdateDocs();
        } else if (pick === 'copyInstall') {
            await vscode.env.clipboard.writeText(OPENCLAW_INSTALL_SCRIPT);
            vscode.window.showInformationMessage('Installer command copied to clipboard.');
        } else if (pick === 'copyNpm') {
            await vscode.env.clipboard.writeText(OPENCLAW_NPM_INSTALL);
            vscode.window.showInformationMessage('npm update command copied to clipboard.');
        } else if (pick === 'settings') {
            await openSettings();
        }
    }
}


async function showInstallMoreOptions(): Promise<'copy' | 'docs' | 'settings' | undefined> {
    const items: QuickPickOption<'copy' | 'docs' | 'settings'>[] = [
        { label: 'Copy install command', value: 'copy' },
        { label: 'Open docs', value: 'docs' },
        { label: 'Open settings', value: 'settings' }
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'More OpenClaw options' });
    return pick?.value;
}

async function showNodeMoreOptions(
    installCommand: string | undefined
): Promise<'copy' | 'docs' | undefined> {
    const items: QuickPickOption<'copy' | 'docs'>[] = [{ label: 'Open Node.js download page', value: 'docs' }];
    if (installCommand) {
        items.unshift({ label: 'Copy Node.js install command', value: 'copy' });
    }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'More Node.js options' });
    return pick?.value;
}

async function showLegacyMoreOptions(): Promise<
    'updateDocs' | 'copyInstall' | 'copyNpm' | 'settings' | undefined
> {
    const items: QuickPickOption<'updateDocs' | 'copyInstall' | 'copyNpm' | 'settings'>[] = [
        { label: 'Open update docs', value: 'updateDocs' },
        { label: 'Copy installer command', value: 'copyInstall' },
        { label: 'Copy npm update command', value: 'copyNpm' },
        { label: 'Open settings', value: 'settings' }
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'More OpenClaw options' });
    return pick?.value;
}
