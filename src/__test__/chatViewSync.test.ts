import type { Mock } from 'vitest';
import * as vscode from 'vscode';

vi.mock('../webview/chatServiceFactory', () => ({
    ChatServiceFactory: vi.fn().mockImplementation(function () { return { resolve: vi.fn(), dispose: vi.fn() }; }),
}));

import { ChatViewProvider } from '../webview/ChatViewProvider';

type Posted = Record<string, unknown>;
type ConfigurationListener = (event: vscode.ConfigurationChangeEvent) => void;

function makeWebview(): { posted: Posted[]; webview: vscode.Webview; send(message: Posted): Promise<void> } {
    let handler: (message: Posted) => Promise<void> = async () => undefined;
    const posted: Posted[] = [];
    const webview: vscode.Webview = {
        options: {},
        html: '',
        cspSource: 'vscode-webview:',
        postMessage: async (message: Posted) => { posted.push(message); return true; },
        onDidReceiveMessage: (cb: (message: Posted) => Promise<void>) => { handler = cb; return { dispose() {} }; },
        asWebviewUri: (uri: vscode.Uri) => uri,
    };
    return { posted, webview, send: message => handler(message) };
}

function makeContext(): vscode.ExtensionContext {
    const memento: vscode.Memento = { keys: () => [], get: vi.fn(), update: vi.fn(async () => undefined) };
    const context: Pick<vscode.ExtensionContext, 'globalState' | 'workspaceState'> = {
        globalState: { ...memento, setKeysForSync: vi.fn() },
        workspaceState: memento,
    };
    return context as vscode.ExtensionContext;
}

function makeProvider(): { provider: ChatViewProvider; sidebar: ReturnType<typeof makeWebview> } {
    const provider = new ChatViewProvider(vscode.Uri.file('/ext'), makeContext());
    const sidebar = makeWebview();
    const view = { webview: sidebar.webview, visible: true, show: vi.fn(), onDidDispose: vi.fn() };
    provider.resolveWebviewView(view as Partial<vscode.WebviewView> as vscode.WebviewView,
        {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);
    return { provider, sidebar };
}

function withSettings(values: Record<string, unknown>): void {
    const get = (key: string, defaultValue?: unknown): unknown => (key in values ? values[key] : defaultValue);
    const configuration: vscode.WorkspaceConfiguration = {
        get: get as vscode.WorkspaceConfiguration['get'],
        has: key => key in values,
        inspect: () => undefined,
        update: async (key: string, value: unknown) => { values[key] = value; },
    };
    vi.mocked(vscode.workspace.getConfiguration).mockImplementation(() => configuration);
}

function configurationListener(): ConfigurationListener {
    const calls = vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls;
    return calls[calls.length - 1][0] as ConfigurationListener;
}

function changeOf(section: string): vscode.ConfigurationChangeEvent {
    return { affectsConfiguration: (candidate: string) => section === candidate || section.startsWith(`${candidate}.`) };
}

function statesOf(posted: Posted[]): Posted[] {
    return posted.filter(message => message.type === 'state');
}

function makePanel(): vscode.WebviewPanel & { fireDispose(): void; reveal: Mock } {
    let onDispose = (): void => undefined;
    const webview = makeWebview().webview;
    const panel: Partial<vscode.WebviewPanel> & { fireDispose(): void; reveal: Mock } = {
        webview,
        reveal: vi.fn(),
        onDidDispose: (listener: () => void) => { onDispose = listener; return { dispose() {} }; },
        fireDispose: () => onDispose(),
    };
    return panel as vscode.WebviewPanel & { fireDispose(): void; reveal: Mock };
}

async function flush(): Promise<void> {
    await new Promise(resolve => setImmediate(resolve));
}

describe('ChatViewProvider view sync', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        withSettings({});
    });

    describe('configuration changes', () => {
        it('re-emits state when an openclaw.chat setting changes, and only then', () => {
            const settings: Record<string, unknown> = {};
            withSettings(settings);
            const { sidebar } = makeProvider();
            sidebar.posted.splice(0);
            configurationListener()(changeOf('openclaw.autoConnect'));
            expect(statesOf(sidebar.posted)).toEqual([]);
            settings['chat.hideToolActivity'] = true;
            configurationListener()(changeOf('openclaw.chat.hideToolActivity'));
            expect(statesOf(sidebar.posted)).toEqual([expect.objectContaining({ hideToolActivity: true })]);
        });

        it('stops listening once disposed', () => {
            const { provider } = makeProvider();
            const results = vi.mocked(vscode.workspace.onDidChangeConfiguration).mock.results;
            const subscription = results[results.length - 1].value;
            provider.dispose();
            expect(subscription.dispose).toHaveBeenCalled();
        });

        it('pushes a new layout to every view once the dimension is written', async () => {
            const { sidebar } = makeProvider();
            sidebar.posted.splice(0);
            await sidebar.send({ type: 'setDimension', dimension: '2x2' });
            await flush();
            // VS Code reports the written setting; that change alone re-emits the state.
            expect(statesOf(sidebar.posted)).toEqual([]);
            configurationListener()(changeOf('openclaw.chat.dimension'));
            expect(statesOf(sidebar.posted)).toEqual([expect.objectContaining({ dimension: '2x2' })]);
        });
    });

    describe('debug panel', () => {
        it('reveals the open panel instead of opening another', () => {
            const { provider } = makeProvider();
            expect(provider.revealDebugPanel()).toBe(false);
            const panel = makePanel();
            provider.attachDebugPanel(panel);
            expect(provider.revealDebugPanel()).toBe(true);
            expect(panel.reveal).toHaveBeenCalled();
        });

        it('keeps a newer panel when an older one closes', () => {
            const { provider } = makeProvider();
            const older = makePanel();
            const newer = makePanel();
            provider.attachDebugPanel(older);
            provider.attachDebugPanel(newer);
            older.fireDispose();
            expect(provider.revealDebugPanel()).toBe(true);
            expect(newer.reveal).toHaveBeenCalled();
            newer.fireDispose();
            expect(provider.revealDebugPanel()).toBe(false);
        });
    });
});
