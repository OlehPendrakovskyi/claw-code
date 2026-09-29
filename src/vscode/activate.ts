import * as vscode from 'vscode';
import { ChatViewProvider } from '../webview/ChatViewProvider';
import { useProjectConfigApprovalStore } from '../chat/acpxProjectConfig';
import { openDebugChatPanel } from '../webview/debugPanel';
import type { ToolEntry } from '../core/tools';
import { OverviewTreeProvider } from '../overview/OverviewTreeProvider';
import { initStatusBar, setStatus, disposeStatusBar } from './statusbar';
import { openOpenClawConfig } from './config';
import { migrateLegacyGatewayToken, promptForGatewayToken, resetDeviceIdentity } from '../core/gatewayConfig';
import { redactEndpoint, redactPlainSecrets } from '../core/accessInfo/redact';
import {
    log,
    connect,
    forgetTerminal,
    disposeTerminals,
    setOverviewProvider,
    runSetupFlow,
    runModelSetupWizard,
    runHardeningFlow,
    runHardeningStatusCheck,
    showHardeningAccessSummary,
    toggleToolEntry,
    uninstallToolEntry,
    runCliInTerminal,
    openDocs,
    openDashboard,
    openSecurityDocs,
    getOverviewProvider
} from './commands';

export async function activate(context: vscode.ExtensionContext) {
    log.info('activate() start');

    const statusBarItem = initStatusBar();
    setStatus('idle');
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    log.info('status bar created');

    let chatViewProvider: ChatViewProvider | undefined;

    const commandRegistrations: Array<[string, (...args: never[]) => unknown]> = [
        ['openclaw.connect', () => connect()],
        ['openclaw.setup', () => runSetupFlow()],
        ['openclaw.modelSetup', () => runModelSetupWizard()],
        ['openclaw.openDocs', () => openDocs()],
        ['openclaw.harden', () => runHardeningFlow()],
        ['openclaw.hardening.refresh', () => getOverviewProvider()?.refreshTools()],
        ['openclaw.hardening.openConfig', () => openOpenClawConfig(true)],
        ['openclaw.hardening.openDocs', () => openSecurityDocs()],
        ['openclaw.hardening.openDashboard', () => openDashboard()],
        ['openclaw.hardening.runStatus', () => runHardeningStatusCheck()],
        ['openclaw.hardening.showAccessSummary', () => showHardeningAccessSummary()],
        ['openclaw.doctor', () => runCliInTerminal('openclaw doctor', 'Running openclaw doctor.')],
        ['openclaw.update', () => runCliInTerminal('openclaw update', 'Running openclaw update.')],
        ['openclaw.configure', () => runCliInTerminal('openclaw configure', 'Running openclaw configure.')],
        ['openclaw.tools.refresh', () => getOverviewProvider()?.refreshTools()],
        ['openclaw.tools.toggle', async (tool: ToolEntry) => toggleToolEntry(tool)],
        ['openclaw.tools.uninstall', async (tool: ToolEntry) => uninstallToolEntry(tool)],
        ['openclaw.chat.insertSelection', () => chatViewProvider?.insertSelectionMention()]
    ];

    for (const [id, handler] of commandRegistrations) {
        context.subscriptions.push(vscode.commands.registerCommand(id, handler));
    }
    log.info('commands registered');

    const overviewProvider = new OverviewTreeProvider();
    setOverviewProvider(overviewProvider);
    const overviewView = vscode.window.createTreeView('openclaw.overview', {
        treeDataProvider: overviewProvider
    });
    context.subscriptions.push(overviewView);
    void overviewProvider.refreshTools();
    log.info('overview tree view created');

    // Workspace .acpxrc.json approvals must survive a restart.
    useProjectConfigApprovalStore(context.globalState);
    const provider = new ChatViewProvider(context.extensionUri, context);
    chatViewProvider = provider;
    // Not awaited: a locked keyring must not keep the chat view and commands
    // unregistered. Token consumers wait for the migration through
    // ChatServiceFactory.ensureMigrated, and runs are serialized.
    const runTokenMigration = () =>
        migrateLegacyGatewayToken(context).catch((err: unknown) => {
            log.warn(`legacy gateway token migration failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    void runTokenMigration();
    // A plaintext token written after activation (settings edit, settings
    // sync, a newly added workspace folder) must not linger until reload.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('openclaw.gateway.token')) {
                void runTokenMigration();
            }
        })
    );
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider),
        provider
    );
    log.info('chat view provider registered');

    context.subscriptions.push(
        vscode.commands.registerCommand('openclaw.chat.connectGateway', () => {
            // Saving the token must leave the extension connected, not just
            // configured: after a submitted token, resolve the chat gateway
            // transport (not the CLI connect flow) so the socket and the
            // transport badge reflect the new credentials immediately.
            void promptForGatewayToken(context)
                .then(async (saved) => {
                    if (saved) {
                        await chatViewProvider?.connectGatewayTransport();
                    }
                })
                .catch((err: unknown) => {
                    const message = err instanceof Error ? err.message : String(err);
                    log.error(`connectGateway failed: ${redactPlainSecrets(message.replace(/\S+:\/\/\S+/g, (url) => redactEndpoint(url)))}`);
                    void vscode.window.showErrorMessage(
                        'OpenClaw: failed to save gateway token or connect. Check the logs for details.'
                    );
                });
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('openclaw.gateway.resetDeviceIdentity', () => confirmDeviceIdentityReset(context))
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('openclaw.chat.open', () => {
            vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('openclaw.chat.popOut', () => {
            chatViewProvider?.popOut();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('openclaw.chat.newSession', () => {
            chatViewProvider?.newSession();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('openclaw.chat.pickAgent', () => {
            void chatViewProvider?.showAgentPicker();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('openclaw.chat.debug', () => {
            if (chatViewProvider && !chatViewProvider.revealDebugPanel()) {
                chatViewProvider.attachDebugPanel(openDebugChatPanel(context.extensionUri));
            }
        })
    );

    const config = vscode.workspace.getConfiguration('openclaw');
    const autoConnect = config.get<boolean>('autoConnect', false);

    if (autoConnect && vscode.workspace.isTrusted) {
        log.info('auto-connect enabled, scheduling connect');
        const autoConnectTimer = setTimeout(() => {
            void connect();
        }, 1000);
        // A deactivation inside the delay must not connect a disposed extension.
        context.subscriptions.push({ dispose: () => clearTimeout(autoConnectTimer) });
    } else if (autoConnect) {
        log.info('auto-connect enabled but workspace untrusted; waiting for trust');
        context.subscriptions.push(
            vscode.workspace.onDidGrantWorkspaceTrust(() => {
                log.info('workspace trusted, connecting (auto-connect)');
                void connect();
            })
        );
    }

    context.subscriptions.push(
        vscode.window.onDidCloseTerminal((closedTerminal) => {
            if (forgetTerminal(closedTerminal)) {
                setStatus('idle');
            }
        })
    );

    log.info(`activate() complete — ${context.subscriptions.length} subscriptions`);
}

const RESET_DEVICE_IDENTITY = 'Reset Identity';

/** The chat client notices the deleted identity and reconnects as a new device. */
async function confirmDeviceIdentityReset(context: vscode.ExtensionContext): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
        'Reset the gateway device identity? Claw Code forgets its device key and device tokens, and every gateway that requires pairing must approve it again.',
        { modal: true },
        RESET_DEVICE_IDENTITY
    );
    if (choice !== RESET_DEVICE_IDENTITY) {
        return;
    }
    try {
        await resetDeviceIdentity(context.secrets);
        void vscode.window.showInformationMessage('OpenClaw: gateway device identity reset. The next connection pairs a new device.');
    } catch (err) {
        log.error(`resetting the gateway device identity failed: ${err instanceof Error ? err.message : String(err)}`);
        void vscode.window.showErrorMessage('OpenClaw: could not reset the gateway device identity. Check the logs for details.');
    }
}

export function deactivate() {
    log.info('deactivate()');
    disposeTerminals();
    disposeStatusBar();
}