import * as vscode from 'vscode';
import { ChatViewProvider } from '../webview/ChatViewProvider';
import { openDebugChatPanel } from '../webview/debugPanel';
import type { ToolEntry } from '../core/tools';
import { OverviewTreeProvider } from '../overview/OverviewTreeProvider';
import { initStatusBar, setStatus, disposeStatusBar } from './statusbar';
import { openOpenClawConfig } from './config';
import { migrateLegacyGatewayToken, promptForGatewayToken } from '../core/gatewayConfig';
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

export function activate(context: vscode.ExtensionContext) {
    log.info('activate() start');

    const statusBarItem = initStatusBar();
    setStatus('idle');
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    log.info('status bar created');

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
        ['openclaw.tools.uninstall', async (tool: ToolEntry) => uninstallToolEntry(tool)]
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

    const chatViewProvider = new ChatViewProvider(context.extensionUri, context);
    void migrateLegacyGatewayToken(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatViewProvider),
        chatViewProvider
    );
    log.info('chat view provider registered');

    context.subscriptions.push(
        vscode.commands.registerCommand('openclaw.chat.connectGateway', () => {
            void promptForGatewayToken(context);
        })
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
            if (chatViewProvider) {
                const panel = openDebugChatPanel(context.extensionUri);
                chatViewProvider.attachDebugPanel(panel);
            }
        })
    );

    const config = vscode.workspace.getConfiguration('openclaw');
    const autoConnect = config.get<boolean>('autoConnect', false);

    if (autoConnect && vscode.workspace.isTrusted) {
        log.info('auto-connect enabled, scheduling connect');
        setTimeout(() => {
            void connect();
        }, 1000);
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

export function deactivate() {
    log.info('deactivate()');
    disposeTerminals();
    disposeStatusBar();
}