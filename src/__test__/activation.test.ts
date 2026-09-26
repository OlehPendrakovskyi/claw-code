
import * as vscode from 'vscode';
import { activate, deactivate } from '../extension';

function makeContext(): { context: vscode.ExtensionContext; subscriptions: vscode.Disposable[] } {
    const subscriptions: vscode.Disposable[] = [];
    // activate() awaits migrateLegacyGatewayToken(context): a mocked
    // SecretStorage keeps that call safe even if the config mock ever
    // reports a legacy value.
    const secrets = {
        get: jest.fn(async () => undefined as string | undefined),
        store: jest.fn(async () => undefined),
        delete: jest.fn(async () => undefined),
    };
    const workspaceState = {
        get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
        update: jest.fn(async () => undefined),
    };
    const context = {
        extensionUri: vscode.Uri.file('/tmp/test-ext'),
        globalState: { get: jest.fn(), update: jest.fn() },
        workspaceState,
        secrets,
        subscriptions,
    } as unknown as vscode.ExtensionContext;
    return { context, subscriptions };
}

describe('extension activation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('exports activate and deactivate', () => {
        expect(typeof activate).toBe('function');
        expect(typeof deactivate).toBe('function');
    });

    it('activate registers commands and views without throwing', async () => {
        const { context, subscriptions } = makeContext();
        await activate(context);
        expect(subscriptions.length).toBeGreaterThan(0);
    });

    it('creates a status bar item', async () => {
        const { context } = makeContext();
        await activate(context);
        expect(vscode.window.createStatusBarItem).toHaveBeenCalledWith(
            vscode.StatusBarAlignment.Right,
            100,
        );
    });

    it('registers the expected commands', async () => {
        const { context } = makeContext();
        await activate(context);
        const registered = (vscode.commands.registerCommand as ReturnType<typeof jest.fn>).mock.calls.map(
            (c: unknown[]) => c[0],
        );
        expect(registered).toContain('openclaw.connect');
        expect(registered).toContain('openclaw.setup');
        expect(registered).toContain('openclaw.harden');
        expect(registered).toContain('openclaw.chat.open');
        expect(registered).toContain('openclaw.chat.popOut');
        expect(registered).toContain('openclaw.chat.newSession');
    });

    it('registers the overview tree view', async () => {
        const { context } = makeContext();
        await activate(context);
        expect(vscode.window.createTreeView).toHaveBeenCalledWith(
            'openclaw.overview',
            expect.objectContaining({ treeDataProvider: expect.anything() }),
        );
    });

    it('registers the chat webview view provider', async () => {
        const { context } = makeContext();
        await activate(context);
        expect(vscode.window.registerWebviewViewProvider).toHaveBeenCalledWith(
            'openclaw.chat',
            expect.anything(),
        );
    });

    it('deactivate does not throw', () => {
        expect(() => deactivate()).not.toThrow();
    });

    it('does not auto-connect when autoConnect is false', async () => {
        const { context } = makeContext();
        await activate(context);
        expect(vscode.window.createTerminal).not.toHaveBeenCalled();
    });
});
