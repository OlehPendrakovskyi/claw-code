import * as vscode from 'vscode';
import { ChatViewProvider } from '../webview/ChatViewProvider';
import { useProjectConfigApprovalStore } from '../chat/acpxProjectConfig';
import { openDebugChatPanel } from '../webview/debugPanel';
import type { ToolEntry } from '../core/tools';
import { OverviewTreeProvider } from '../overview/OverviewTreeProvider';
import { initStatusBar, setStatus, disposeStatusBar } from './statusbar';
import { openOpenClawConfig } from './config';
import { detectLegacyExtensions, warnAboutLegacyExtensions } from './legacyExtension';
import { migrateLegacyGatewayToken, promptForGatewayToken, resetDeviceIdentity } from '../core/gatewayConfig';
import { errorMessage } from '../core/errors';
import { redactText } from '../core/accessInfo/redact';
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

    // A pre-rename build is a different extension that registers the same openclaw.* commands and views.
    // Detect it before we register ours: in a shared extension host it owns those ids and our registration
    // would otherwise throw and abort activation (roadmap REL-2).
    const legacyInstalled = detectLegacyExtensions();
    if (legacyInstalled.length) {
        void warnAboutLegacyExtensions(legacyInstalled);
    }

    // Every shared registration goes through this. A pre-rename build owning the same id makes VS Code
    // throw its duplicate-registration error; that is the state the warning asks the user to fix, so it must
    // not abort the rest of activation. Only that verified duplicate is swallowed — any other failure is a
    // real defect and propagates, so activation cannot report success with missing functionality.
    const registerOwn = (what: string, register: () => vscode.Disposable): vscode.Disposable => {
        try {
            return register();
        } catch (err) {
            if (legacyInstalled.length && isDuplicateRegistrationError(err)) {
                log.warn(`not registering ${what}: already owned (a pre-rename build likely registers it)`);
                return { dispose: () => undefined };
            }
            throw err;
        }
    };

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
        context.subscriptions.push(registerOwn(id, () => vscode.commands.registerCommand(id, handler)));
    }
    log.info('commands registered');

    const overviewProvider = new OverviewTreeProvider();
    setOverviewProvider(overviewProvider);
    const overviewView = registerOwn('openclaw.overview', () =>
        vscode.window.createTreeView('openclaw.overview', { treeDataProvider: overviewProvider })
    );
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
            log.warn(`legacy gateway token migration failed: ${errorMessage(err)}`);
        });
    void runTokenMigration();
    // A plaintext token written after activation (settings edit, settings
    // sync, a newly added workspace folder) must not linger until reload.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('openclaw.gateway.token')) {
                void runTokenMigration();
            }
        }),
        // Workspace plaintext is left alone until trust, then removed (never adopted).
        vscode.workspace.onDidGrantWorkspaceTrust(() => void runTokenMigration())
    );
    context.subscriptions.push(
        registerOwn(ChatViewProvider.viewType, () =>
            vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider)
        ),
        provider
    );
    log.info('chat view provider registered');

    context.subscriptions.push(
        registerOwn('openclaw.chat.connectGateway', () =>
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
                        const message = errorMessage(err);
                        log.error(`connectGateway failed: ${redactText(message)}`);
                        void vscode.window.showErrorMessage(
                            'OpenClaw: failed to save gateway token or connect. Check the logs for details.'
                        );
                    });
            })
        )
    );

    context.subscriptions.push(
        registerOwn('openclaw.gateway.resetDeviceIdentity', () =>
            vscode.commands.registerCommand('openclaw.gateway.resetDeviceIdentity', () => confirmDeviceIdentityReset(context))
        )
    );

    context.subscriptions.push(
        registerOwn('openclaw.chat.open', () =>
            vscode.commands.registerCommand('openclaw.chat.open', () => {
                vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
            })
        )
    );

    context.subscriptions.push(
        registerOwn('openclaw.chat.popOut', () =>
            vscode.commands.registerCommand('openclaw.chat.popOut', () => {
                chatViewProvider?.popOut();
            })
        )
    );

    context.subscriptions.push(
        registerOwn('openclaw.chat.newSession', () =>
            vscode.commands.registerCommand('openclaw.chat.newSession', () => {
                chatViewProvider?.newSession();
            })
        )
    );

    context.subscriptions.push(
        registerOwn('openclaw.chat.pickAgent', () =>
            vscode.commands.registerCommand('openclaw.chat.pickAgent', () => {
                void chatViewProvider?.showAgentPicker();
            })
        )
    );

    context.subscriptions.push(
        registerOwn('openclaw.chat.debug', () =>
            vscode.commands.registerCommand('openclaw.chat.debug', () => {
                if (chatViewProvider && !chatViewProvider.revealDebugPanel()) {
                    chatViewProvider.attachDebugPanel(openDebugChatPanel(context.extensionUri));
                }
            })
        )
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

/**
 * VS Code's own duplicate-registration errors, verbatim from its extension host: a command id
 * (`command '<id>' already exists`) and a webview view (`View provider for '<viewType>' already
 * registered`). Matching the message is the only discriminator VS Code offers — `registerCommand` and
 * `registerWebviewViewProvider` throw nothing typed — so it is confined to this one predicate and read
 * against the source it names.
 */
function isDuplicateRegistrationError(err: unknown): boolean {
    return err instanceof Error && /\balready (exists|registered)\b/.test(err.message);
}

/** The chat client notices the deleted identity and reconnects as a new device. */
async function confirmDeviceIdentityReset(context: vscode.ExtensionContext): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
        'Reset the gateway device identity of this window\'s host? VSClaw forgets that device key and its device tokens, and every gateway that requires pairing must approve it again.',
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
        log.error(`resetting the gateway device identity failed: ${errorMessage(err)}`);
        void vscode.window.showErrorMessage('OpenClaw: could not reset the gateway device identity. Check the logs for details.');
    }
}

export function deactivate() {
    log.info('deactivate()');
    disposeTerminals();
    disposeStatusBar();
}