import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { TextEncoder } from 'util';
import { ChatEvent, ChatService } from '../chat/ChatService';
import { getWebviewContent } from './content';
import {
    SLASH_COMMANDS,
    buildSlashPrompt,
    findCommand,
} from './slashCommands';
import {
    log,
    appendToolMessage,
    enrichAttachmentsForWebview,
    gatherEditorContext,
    getThreadSnapshots as buildThreadSnapshots,
    handleFileSearch,
    postToAll,
    readAttachments,
    renderMarkdown,
    type ChatThreadState,
} from './viewMessaging';
import { buildRecommendations } from './recommendations';
import { parseFileMentions, buildMention, type FileMention } from './fileMentions';
import { ChatServiceFactory } from './chatServiceFactory';
import { GatewayChatService, DEFAULT_SESSION_KEY } from '../core/gatewayChatService';
import {
    AgentPicker,
    COLD_SESSION_PLACEHOLDER,
    buildAgentSessionItems,
    isColdSession,
    isMainAgentSessionKey,
    mapHistoryMessages,
    parseSessionRows,
} from '../core/agentPicker';
import type { SessionRow } from '../core/contract';

// Re-export the moved interface so existing imports from this module keep working.
export type { Recommendation } from './recommendations';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'openclaw.chat';

    private sidebarView: vscode.WebviewView | undefined;
    private popOutPanel: vscode.WebviewPanel | undefined;
    private debugPanel: vscode.WebviewPanel | undefined;
    private editorChangeDisposable: vscode.Disposable | undefined;
    private selectionChangeDisposable: vscode.Disposable | undefined;
    private diagnosticChangeDisposable: vscode.Disposable | undefined;
    private globalState: vscode.Memento;
    private readonly context: vscode.ExtensionContext;
    private lastSessionKey: string | null = null;
    /** Guards session-resume bootstrap so each webview does not re-subscribe. */
    private resumeStarted = false;
    private threadCounter = 0;
    private readonly threads = new Map<string, ChatThreadState>();
    /** Live transcript callback per resumed session, so reopening a session
     *  replaces the previous sink instead of duplicating event delivery. */
    private transcriptCallbacks = new Map<string, { sessionKey: string; cb: (event: ChatEvent) => void }>();
    private visibleThreadIds: string[] = [];
    private activeThreadId = '';

    private readonly chatServiceFactory: ChatServiceFactory;

    constructor(private readonly extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this.context = context;
        this.globalState = context.globalState;
        this.chatServiceFactory = new ChatServiceFactory(context, (transport, connected) => {
            const label = connected ? `${transport} · connected` : `${transport} · offline`;
            postToAll([this.sidebarView?.webview, this.popOutPanel?.webview, this.debugPanel?.webview], {
                type: 'transportStatus',
                transport,
                connected,
                label,
            });
        });
        const initialThread = this.createThreadState();
        this.threads.set(initialThread.id, initialThread);
        this.visibleThreadIds = [initialThread.id];
        this.activeThreadId = initialThread.id;

        this.editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
            this.pushRecommendations();
        });
        this.selectionChangeDisposable = vscode.window.onDidChangeTextEditorSelection(() => {
            this.pushRecommendations();
        });
        this.diagnosticChangeDisposable = vscode.languages.onDidChangeDiagnostics(() => {
            this.pushRecommendations();
        });
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        log.info('resolveWebviewView()');
        this.sidebarView = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this.extensionUri,
                ...(vscode.workspace.workspaceFolders?.map(f => f.uri) || [])
            ]
        };

        webviewView.webview.html = getWebviewContent(
            webviewView.webview,
            this.extensionUri,
            true
        );

        this.setupWebviewListeners(webviewView.webview);
        this.bootstrapWebview();

        webviewView.onDidDispose(() => {
            this.sidebarView = undefined;
        });
    }

    popOut(): void {
        if (this.popOutPanel) {
            this.popOutPanel.reveal();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'openclaw.chatPanel',
            'OpenClaw Chat',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                localResourceRoots: [
                    this.extensionUri,
                    ...(vscode.workspace.workspaceFolders?.map(f => f.uri) || [])
                ],
                retainContextWhenHidden: true
            }
        );

        this.popOutPanel = panel;
        panel.webview.html = getWebviewContent(panel.webview, this.extensionUri, false);
        this.setupWebviewListeners(panel.webview);
        this.bootstrapWebview();

        panel.onDidDispose(() => {
            this.popOutPanel = undefined;
        });
    }

    attachDebugPanel(panel: vscode.WebviewPanel): void {
        this.debugPanel = panel;
        this.setupWebviewListeners(panel.webview);
        this.bootstrapWebview();
        panel.onDidDispose(() => {
            this.debugPanel = undefined;
        });
    }

    newSession(): void {
        this.createThread({ inheritFromActive: true, activate: true, insertAfterActive: true });
        this.emitState();
    }

    dispose(): void {
        for (const thread of this.threads.values()) {
            thread.service.dispose();
            if (thread.transportBackend && thread.transportBackend !== thread.service &&
                !(thread.transportBackend instanceof GatewayChatService)) {
                thread.transportBackend.dispose();
            }
        }
        this.popOutPanel?.dispose();
        this.debugPanel?.dispose();
        this.editorChangeDisposable?.dispose();
        this.selectionChangeDisposable?.dispose();
        this.diagnosticChangeDisposable?.dispose();
        this.chatServiceFactory.dispose();
    }

    private setupWebviewListeners(webview: vscode.Webview): void {
        webview.onDidReceiveMessage(async (msg: {
            type: string;
            threadId?: string;
            text?: string;
            index?: number;
            command?: string;
            query?: string;
            filePath?: string;
            filePaths?: string[];
            line?: string;
            sessionKey?: string;
            chatType?: string;
            model?: string;
            dimension?: string;
            key?: string;
            value?: string | number;
        }) => {
            log.info(`webview msg: type=${msg.type}, threadId=${msg.threadId || '(none)'}`);
            const thread = this.getThread(msg.threadId);

            switch (msg.type) {
                case 'send':
                    if (thread && msg.text) {
                        await this.handleSend(thread, msg.text);
                    }
                    break;
                case 'setChatType':
                    if (thread && msg.chatType) {
                        thread.currentChatType = msg.chatType;
                        thread.permissionState = this.getPermissionState(msg.chatType);
                        this.emitState();
                    }
                    break;
                case 'setModel':
                    if (thread && msg.model) {
                        thread.currentModel = msg.model;
                        thread.source = ChatService.getSourceForModel(msg.model);
                        thread.contextMax = this.getContextMaxForModel(msg.model);
                        void vscode.workspace.getConfiguration('openclaw').update(
                            'chat.agent',
                            msg.model,
                            vscode.ConfigurationTarget.Global
                        );
                        this.emitState();
                    }
                    break;
                case 'slashCommand':
                    if (thread && msg.command) {
                        await this.handleSlashCommand(thread, msg.command, msg.text ?? '');
                    }
                    break;
                case 'requestRecommendations':
                    this.pushRecommendations();
                    break;
                case 'requestState':
                    this.emitState();
                    break;
                case 'cancel':
                    if (thread) {
                        const backend = this.backendFor(thread);
                        if (backend instanceof GatewayChatService) {
                            // Same shared-run guard as resetThread: aborting a
                            // shared session key would cancel another thread's
                            // live run on the shared gateway client.
                            const shared = [...this.threads.values()].some(
                                t => t.id !== thread.id && t.sessionKey === thread.sessionKey && t.status === 'running'
                            );
                            // Bump the epoch BEFORE abort: a disconnected
                            // gateway completes the old sink synchronously, so
                            // the incremented epoch must already be in place or
                            // the stale completion is treated as current.
                            thread.eventEpoch += 1;
                            if (thread.sessionKey && !shared) {
                                backend.abort(thread.sessionKey);
                            }
                        } else {
                            // Epoch bump before abort: the acpx close fires
                            // asynchronously and must not deliver late events
                            // into a thread that already cancelled.
                            thread.eventEpoch += 1;
                            backend.abort();
                        }
                        thread.isStreaming = false;
                        thread.status = 'cancelled';
                        // The run sink's `done` is epoch-dropped above, so the
                        // suspended transcript callback would stay stranded
                        // and the thread would stop receiving transcript
                        // events until a later run restores it.
                        this.restoreSuspendedTranscriptSink(thread);
                        this.emitState();
                    }
                    break;
                case 'newSession':
                case 'splitThread':
                    this.createThread({
                        inheritFromActive: true,
                        activate: true,
                        insertAfterActive: true
                    });
                    this.emitState();
                    break;
                case 'clearThread':
                    if (thread) {
                        this.resetThread(thread);
                        this.emitState();
                    }
                    break;
                case 'focusThread':
                    if (thread) {
                        this.activeThreadId = thread.id;
                        this.emitState();
                    }
                    break;
                case 'closeThread':
                    if (thread) {
                        this.closeThread(thread.id);
                    }
                    break;
                case 'requestAgents':
                case 'requestSessions':
                    await this.handleListSessions(msg.type === 'requestAgents');
                    break;
                case 'selectAgent':
                    // Webview-supplied keys are untrusted: enforce the same
                    // strict main-session filter as the picker for both actions.
                    if (msg.sessionKey && isMainAgentSessionKey(msg.sessionKey)) {
                        await this.handleSelectAgent(msg.sessionKey);
                    }
                    break;
                case 'openSession':
                    if (msg.sessionKey && isMainAgentSessionKey(msg.sessionKey)) {
                        await this.handleOpenSession(msg.sessionKey);
                    }
                    break;
                case 'popOut':
                    this.popOut();
                    break;
                case 'setDimension':
                    if (msg.dimension) {
                        void vscode.workspace.getConfiguration('openclaw').update(
                            'chat.dimension',
                            msg.dimension,
                            vscode.ConfigurationTarget.Global
                        );
                    }
                    break;
                case 'setSetting':
                    if (msg.key && msg.value !== undefined) {
                        void vscode.workspace.getConfiguration('openclaw').update(
                            msg.key,
                            msg.value,
                            vscode.ConfigurationTarget.Global
                        );
                    }
                    break;
                case 'attach':
                    if (thread) {
                        await this.handleAttach(thread);
                    }
                    break;
                case 'removeAttachment':
                    if (thread && typeof msg.index === 'number') {
                        thread.pendingAttachments.splice(msg.index, 1);
                        this.emitState();
                    }
                    break;
                case 'onboardingComplete':
                    void this.globalState.update('openclaw.onboardingComplete', true);
                    break;
                case 'exportThread':
                    if (thread) {
                        await this.handleExportThread(thread);
                    }
                    break;
                case 'fileSearch':
                    if (typeof msg.query === 'string') {
                        await handleFileSearch(msg.query, webview, this.getWorkspaceCwd() || '');
                    }
                    break;
                case 'attachFile':
                    if (thread && msg.filePath) {
                        await this.addAttachments(thread, [msg.filePath]);
                    }
                    break;
                case 'attachFiles':
                    if (thread && Array.isArray(msg.filePaths) && msg.filePaths.length > 0) {
                        await this.addAttachments(thread, msg.filePaths);
                    }
                    break;
                case 'insertMention':
                    await this.insertSelectionMention();
                    break;
                case 'openFile':
                    if (msg.filePath) {
                        await this.openFileInEditor(msg.filePath, msg.line);
                    }
                    break;
            }
        });
    }

    private createThread(options?: {
        inheritFromActive?: boolean;
        activate?: boolean;
        insertAfterActive?: boolean;
    }): ChatThreadState {
        const thread = this.createThreadState(options?.inheritFromActive ? this.getActiveThread() : undefined);
        this.threads.set(thread.id, thread);

        if (options?.insertAfterActive && this.activeThreadId) {
            const activeIndex = this.visibleThreadIds.indexOf(this.activeThreadId);
            if (activeIndex >= 0) {
                this.visibleThreadIds.splice(activeIndex + 1, 0, thread.id);
            } else {
                this.visibleThreadIds.push(thread.id);
            }
        } else {
            this.visibleThreadIds.push(thread.id);
        }

        if (options?.activate !== false) {
            this.activeThreadId = thread.id;
        }

        return thread;
    }

    private createThreadState(inheritFrom?: ChatThreadState): ChatThreadState {
        this.threadCounter += 1;
        const config = vscode.workspace.getConfiguration('openclaw');
        const baseModel = inheritFrom?.currentModel ?? config.get<string>('chat.agent', 'codex');
        const baseType = inheritFrom?.currentChatType ?? 'chat';
        const index = this.threadCounter;

        return {
            id: `thread-${index}`,
            index,
            title: `Thread ${index}`,
            messages: [],
            pendingAssistantText: '',
            pendingAttachments: [],
            currentChatType: baseType,
            currentModel: baseModel,
            permissionState: this.getPermissionState(baseType),
            isStreaming: false,
            status: 'idle',
            source: ChatService.getSourceForModel(baseModel),
            contextTokens: 0,
            contextMax: this.getContextMaxForModel(baseModel),
            lastUsage: null,
            service: new ChatService(),
            eventEpoch: 0,
            bindingEpoch: 0,
            openGeneration: 0,
            openInFlightGen: null
        };
    }

    private getContextMaxForModel(model: string): number {
        const defaults: Record<string, number> = {
            codex: 128_000,
            claude: 200_000,
            'gpt-4o': 128_000,
            gemini: 1_000_000,
            ollama: 32_000,
            opencode: 128_000,
        };
        const config = vscode.workspace.getConfiguration('openclaw');
        const override = config.get<number>('chat.contextMax');
        if (override && override > 0) {
            return override;
        }
        const lower = model.toLowerCase();
        for (const [key, max] of Object.entries(defaults)) {
            if (lower.includes(key)) {
                return max;
            }
        }
        return 128_000;
    }

    private getThread(threadId?: string): ChatThreadState | undefined {
        if (threadId && this.threads.has(threadId)) {
            return this.threads.get(threadId);
        }
        return this.getActiveThread();
    }

    private getActiveThread(): ChatThreadState | undefined {
        return this.threads.get(this.activeThreadId);
    }

    private resetThread(thread: ChatThreadState): void {
        const backend = this.backendFor(thread);
        if (backend instanceof GatewayChatService) {
            // Only abort the session when no other thread is still bound to
            // it: that thread may own the active run, and resetting an idle
            // thread must not cancel the other thread's run.
            // Both generations bump before abort: a disconnected gateway
            // completes the old sink synchronously, and its captured
            // epochs must already be stale when the `done` fires.
            thread.eventEpoch += 1;
            thread.bindingEpoch += 1;
            if (thread.sessionKey) {
                const shared = [...this.threads.values()].some(
                    t => t.id !== thread.id && t.sessionKey === thread.sessionKey && t.status === 'running'
                );
                if (!shared) {
                    backend.abort(thread.sessionKey);
                }
            }
        } else {
            thread.eventEpoch += 1;
            thread.bindingEpoch += 1;
            backend.abort();
        }
        thread.messages = [];
        thread.pendingAssistantText = '';
        thread.pendingAttachments = [];
        thread.isStreaming = false;
        thread.status = 'idle';
        // Abort's `done` is epoch-dropped above, so the suspended transcript
        // callback would stay stranded: restore it explicitly so the thread
        // keeps receiving transcript events after the reset. An idle resumed
        // thread has no suspended sink, but its persistent callback was
        // captured with the pre-bump bindingEpoch: rebind it too, or every
        // future transcript event is epoch-dropped after Clear/Reset.
        const gatewayBackend = backend instanceof GatewayChatService ? backend : null;
        if (!this.suspendedTranscriptSinks.get(thread.id) && gatewayBackend) {
            const persistent = this.transcriptCallbacks.get(thread.id);
            if (persistent) {
                this.transcriptCallbacks.delete(thread.id);
                gatewayBackend.removeTranscriptSink(persistent.sessionKey, persistent.cb);
                const rebindEpoch = thread.bindingEpoch;
                const cb = (event: ChatEvent): void => { void this.handleChatEvent(thread.id, event, rebindEpoch, 'binding'); };
                this.transcriptCallbacks.set(thread.id, { sessionKey: persistent.sessionKey, cb });
                gatewayBackend.rebindTranscriptSink(persistent.sessionKey, cb);
            }
        } else {
            this.restoreSuspendedTranscriptSink(thread);
        }
        thread.title = `Thread ${thread.index}`;
        thread.contextTokens = 0;
        thread.lastUsage = null;
    }

    private closeThread(threadId: string): void {
        if (this.threads.size === 1) {
            const thread = this.threads.get(threadId);
            if (thread) {
                this.resetThread(thread);
                this.activeThreadId = thread.id;
                this.visibleThreadIds = [thread.id];
                this.emitState();
            }
            return;
        }

        const thread = this.threads.get(threadId);
        if (!thread) {
            return;
        }

        const backend = this.backendFor(thread);
        // Retire this thread's persistent transcript callback before closing:
        // the deleted thread's sink must not linger in the gateway's fan-out
        // set (its events would be dropped by the epoch guard anyway, but the
        // callback would still be retained by the shared service).
        const ownCallback = this.transcriptCallbacks.get(threadId);
        if (ownCallback) {
            this.transcriptCallbacks.delete(threadId);
            if (thread.sessionKey === ownCallback.sessionKey && backend instanceof GatewayChatService) {
                backend.removeTranscriptSink(thread.sessionKey, ownCallback.cb);
            }
        }
        this.suspendedTranscriptSinks.delete(threadId);
        if (backend instanceof GatewayChatService) {
            backend.abort(thread.sessionKey);
            // Drop the thread's transcript sink if no surviving thread still
            // listens to this session, so the closed thread's callback is not
            // retained by the shared gateway service.
            if (thread.sessionKey &&
                ![...this.threads.values()].some(t => t.id !== threadId && t.sessionKey === thread.sessionKey)) {
                backend.clearSessionSink(thread.sessionKey);
            }
        } else {
            backend.abort();
        }
        thread.service.dispose();
        // An acpx run stores a dedicated backend on the thread; dispose it
        // too unless it is the thread's legacy service or the shared gateway
        // client (which other threads may still use).
        if (thread.transportBackend && thread.transportBackend !== thread.service &&
            !(thread.transportBackend instanceof GatewayChatService)) {
            thread.transportBackend.dispose();
        }
        this.threads.delete(threadId);
        this.visibleThreadIds = this.visibleThreadIds.filter(id => id !== threadId);

        if (this.visibleThreadIds.length === 0) {
            const fallback = this.createThread({ activate: true });
            this.visibleThreadIds = [fallback.id];
            this.activeThreadId = fallback.id;
        } else if (this.activeThreadId === threadId) {
            this.activeThreadId = this.visibleThreadIds[Math.max(0, this.visibleThreadIds.length - 1)];
        }

        this.emitState();
    }

    private static readonly LAST_SESSION_KEY = 'openclaw.lastSessionKey';

    private static readonly IMAGE_EXTENSIONS = new Set([
        '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tiff', '.tif',
    ]);

    private async addAttachments(thread: ChatThreadState, items: Array<string | FileMention>, options?: { guard?: () => boolean }): Promise<void> {
        let changed = false;

        for (const item of items) {
            const isMention = typeof item !== 'string';
            const filePath = isMention ? item.path : item;
            const rangeStart = isMention ? item.lineStart : undefined;
            const rangeEnd = rangeStart === undefined ? undefined : (isMention ? (item.lineEnd ?? item.lineStart) : undefined);
            const duplicate = thread.pendingAttachments.some(a =>
                a.path === filePath && a.lineStart === rangeStart && a.lineEnd === rangeEnd
            );
            if (!filePath || duplicate) {
                continue;
            }

            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
                // The awaited stat must not commit into a thread whose epoch
                // moved on (cancel/clear/close) while resolution was pending:
                // the caller's guard re-checked here prevents repopulating a
                // reset thread with stale attachments.
                if (options?.guard?.() === false) {
                    return;
                }
                const ext = path.extname(filePath).toLowerCase();
                thread.pendingAttachments.push({
                    name: path.basename(filePath),
                    path: filePath,
                    type: ChatViewProvider.IMAGE_EXTENSIONS.has(ext) ? 'image' : 'file',
                    ...(typeof item !== 'string' && item.lineStart
                        ? { lineStart: item.lineStart, lineEnd: item.lineEnd ?? item.lineStart }
                        : {}),
                });
                changed = true;
            } catch {
                // invalid or unreadable dropped path
            }
        }

        if (changed) {
            this.emitState();
        }
    }

    private async handleSlashCommand(
        thread: ChatThreadState,
        commandName: string,
        userText: string
    ): Promise<void> {
        const cmd = findCommand(commandName);
        if (!cmd) {
            await this.handleSend(thread, userText);
            return;
        }

        const context = await gatherEditorContext(cmd.contextType, (args) => this.runGit(args));
        // Slash commands resolve @mentions too: without this, `/review @src/a.ts#L5`
        // silently omits the requested file attachment.
        const mentions = await this.resolveMentions(userText);
        if (mentions.length > 0) {
            await this.addAttachments(thread, mentions);
        }
        // /compact summarizes prior turns: include the thread transcript so the
        // fresh per-send exec (both transports) has the conversation to compress.
        const transcript = commandName === 'compact' && thread.messages.length > 0
            ? thread.messages
                .filter(m => m.role !== 'tool')
                .map(m => {
                    const label = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'Error';
                    return `${label}: ${m.content}`;
                })
                .join('\n\n')
            : undefined;
        const augmented = buildSlashPrompt(commandName, userText, context, transcript);
        const displayText = `/${commandName}${userText.trim() ? ' ' + userText.trim() : ''}`;
        const attachments = [...thread.pendingAttachments];

        thread.messages.push({ role: 'user', content: displayText });
        thread.pendingAssistantText = '';
        thread.pendingAttachments = [];
        thread.isStreaming = true;
        thread.status = 'running';
        this.maybeRenameThread(thread, displayText);
        this.emitState();

        let fullPrompt = augmented;
        if (attachments.length > 0) {
            fullPrompt = `${await readAttachments(attachments)}\n\n${fullPrompt}`;
        }

        await this.sendPrompt(thread, fullPrompt);
    }

    private runGit(args: string): Promise<string> {
        const cwd = this.getWorkspaceCwd();
        if (!cwd) {
            return Promise.resolve('');
        }
        return new Promise(resolve => {
            exec(`git ${args}`, { cwd, maxBuffer: 1024 * 512 }, (err, stdout) => {
                resolve(err ? '' : stdout.trim());
            });
        });
    }

    private getAvailableModels(): string[] {
        const config = vscode.workspace.getConfiguration('openclaw');
        return config.get<string[]>('chat.models', [
            'codex', 'claude', 'opencode'
        ]);
    }

    private getPermissionState(chatType: string): string {
        const configuredPermissions = vscode.workspace
            .getConfiguration('openclaw')
            .get<string>('chat.permissions', 'approve-reads');
        return ChatService.getPermissionsForChatType(chatType, configuredPermissions);
    }

    private pushRecommendations(): void {
        postToAll([this.sidebarView?.webview, this.popOutPanel?.webview, this.debugPanel?.webview], {
            type: 'recommendations',
            items: buildRecommendations()
        });
    }

    private async handleAttach(thread: ChatThreadState): Promise<void> {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Attach',
            filters: { 'All Files': ['*'] }
        });
        if (!uris || uris.length === 0) {
            return;
        }
        await this.addAttachments(thread, uris.map(uri => uri.fsPath));
    }

    private async handleExportThread(thread: ChatThreadState): Promise<void> {
        if (thread.messages.length === 0) {
            void vscode.window.showInformationMessage('Nothing to export — thread is empty.');
            return;
        }

        const lines: string[] = [`# ${thread.title}`, ''];
        lines.push(`- **Model:** ${thread.currentModel}`);
        lines.push(`- **Mode:** ${thread.currentChatType}`);
        lines.push(`- **Source:** ${thread.source}`);
        lines.push('');

        for (const msg of thread.messages) {
            if (msg.role === 'tool') {
                lines.push('### Tool Calls');
                for (const entry of msg.entries) {
                    lines.push(`- **${entry.title}** (${entry.status})`);
                    if (entry.details) {
                        lines.push(`  \`\`\`\n  ${entry.details}\n  \`\`\``);
                    }
                }
                lines.push('');
            } else {
                const label = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'Error';
                lines.push(`### ${label}`);
                lines.push('');
                lines.push(msg.content);
                lines.push('');
            }
        }

        const markdown = lines.join('\n');
        const safeTitle = thread.title.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`${safeTitle}.md`),
            filters: { 'Markdown': ['md'], 'JSON': ['json'] },
        });

        if (!uri) {
            return;
        }

        let content: string;
        if (uri.fsPath.endsWith('.json')) {
            content = JSON.stringify({
                title: thread.title,
                model: thread.currentModel,
                chatType: thread.currentChatType,
                source: thread.source,
                messages: thread.messages.map(m => ({ ...m })),
            }, null, 2);
        } else {
            content = markdown;
        }

        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
        void vscode.window.showInformationMessage(`Thread exported to ${path.basename(uri.fsPath)}`);
    }

    private async handleSend(thread: ChatThreadState, text: string): Promise<void> {
        log.info(`handleSend: thread=${thread.id}, text="${text.slice(0, 80)}"`);
        // Mark in-flight before async attachment resolution: while file
        // resolution is in flight a second send must see the thread busy,
        // and cancel/clear during the awaits must not be undone by the
        // continuation below (guarded by the send epoch check).
        if (thread.isStreaming) {
            return;
        }
        if (thread.openInFlightGen !== null) {
            // An openSession is rebinding this thread: the shared gateway
            // session is already switched while the binding awaits
            // persistence, so a send here would target the previous key and
            // its callback would later deliver into the newly opened
            // conversation. Fail the send instead of racing the rebind.
            log.info('handleSend: openSession in flight, send rejected');
            thread.status = 'error';
            this.emitState();
            return;
        }
        const sendEpoch = thread.eventEpoch;
        thread.isStreaming = true;
        thread.status = 'running';
        this.emitState();
        try {
            const attachments = [...thread.pendingAttachments];
            const accepted = new Set(attachments.map(attachmentKey));
            const pushNew = (candidates: typeof attachments): void => {
                for (const a of candidates) {
                    const key = attachmentKey(a);
                    if (!accepted.has(key)) {
                        accepted.add(key);
                        attachments.push(a);
                    }
                }
            };

            const autoAttachPath = await this.getActiveEditorFilePath();
            if (autoAttachPath) {
                const autoAttach = vscode.workspace.getConfiguration('openclaw').get<boolean>('chat.attachOpenFile', false);
                if (autoAttach) {
                    await this.addAttachments(thread, [autoAttachPath], { guard: () => thread.eventEpoch === sendEpoch });
                    pushNew(thread.pendingAttachments.filter(a => a.path === autoAttachPath));
                }
            }

            const mentions = await this.resolveMentions(text);
            if (mentions.length > 0) {
                await this.addAttachments(thread, mentions, { guard: () => thread.eventEpoch === sendEpoch });
                // Mention dedupe keys on (path + range); attach only pending
                // entries whose range matches an accepted mention, not every
                // attachment of the same file.
                const mentionKeys = new Set(mentions.map(mentionKey));
                pushNew(thread.pendingAttachments.filter(a => mentionKeys.has(attachmentKey(a))));
            }

            if (thread.eventEpoch !== sendEpoch) {
                // Cancel/clear ran during attachment resolution: the message
                // must not be committed after cancellation was honoured.
                log.info(`handleSend: superseded during attachment resolution, thread=${thread.id}`);
                return;
            }
            thread.messages.push({ role: 'user', content: text });
            thread.pendingAssistantText = '';
            thread.pendingAttachments = [];
            thread.isStreaming = true;
            thread.status = 'running';
            this.maybeRenameThread(thread, text);
            log.info(`handleSend: pushed user msg, now ${thread.messages.length} msgs`);
            this.emitState();

            let fullPrompt = text;
            if (attachments.length > 0) {
                fullPrompt = `${await readAttachments(attachments)}\n\n${text}`;
            }

            await this.sendPrompt(thread, fullPrompt);
        } catch (err) {
            // The early in-flight marking must never strand the thread in a
            // streaming state if attachment resolution throws.
            thread.isStreaming = false;
            thread.status = 'error';
            this.emitState();
            log.error(`handleSend failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /** Lifecycle backend for a thread: the transport of the last send, else the legacy service. */
    private backendFor(thread: ChatThreadState): ChatService | GatewayChatService {
        return thread.transportBackend ?? thread.service;
    }

    private async sendPrompt(thread: ChatThreadState, fullPrompt: string): Promise<void> {
        const cwd = this.getWorkspaceCwd();
        if (!cwd) {
            const errMsg = 'No workspace folder open. Open a folder to use chat.';
            thread.messages.push({ role: 'error', content: errMsg });
            thread.isStreaming = false;
            thread.status = 'error';
            this.emitState();
            return;
        }

        const choice = await this.resolveServiceForSend(this.backendFor(thread));
        // The await above may take seconds (token lookup, connect probe).
        // Cancel/Clear/Close may have run meanwhile: a deleted thread or one
        // no longer running must not be resurrected by the continuation.
        if (!this.threads.has(thread.id) || thread.status !== 'running') {
            if (choice.service !== thread.service &&
                !(choice.service instanceof GatewayChatService) &&
                thread.transportBackend !== choice.service) {
                choice.service.dispose();
            }
            return;
        }
        // Rebinding the transport retires the previous backend: an old acpx
        // process (whose callback has no epoch) or a stale gateway sink must
        // not keep appending events into the new run, and cancel/close must
        // reach whichever backend is actually live for the thread.
        const previousBackend = thread.transportBackend;
        if (previousBackend && previousBackend !== choice.service && previousBackend !== thread.service) {
            if (previousBackend instanceof GatewayChatService) {
                // The gateway client is cached and shared across threads:
                // never dispose it; abort only this thread's session so its
                // in-flight run ends cleanly, and bump the epoch so callbacks
                // captured by earlier runs drop their late events.
                if (thread.sessionKey) {
                    // Epoch bump precedes abort: a disconnected gateway
                    // completes the old sink synchronously, and the sink's
                    // captured epoch must already be stale when it fires.
                    thread.eventEpoch += 1;
                    thread.bindingEpoch += 1;
                    // Same shared-run guard as cancel/reset: this thread may
                    // be only an idle subscriber on the shared session while
                    // another thread owns the live run — the Gateway→acpx
                    // fallback must not cancel that run. Its own in-flight
                    // gateway run cannot coexist with another running thread
                    // on the key (pre-send busy check), so skipping the abort
                    // here never leaves this thread's own run dangling.
                    const sharedRun = [...this.threads.values()].some(
                        t => t.id !== thread.id && t.sessionKey === thread.sessionKey && t.status === 'running'
                    );
                    if (!sharedRun) {
                        previousBackend.abort(thread.sessionKey);
                    }
                }
            } else {
                previousBackend.dispose();
                thread.eventEpoch += 1;
                thread.bindingEpoch += 1;
            }
        }
        thread.transportBackend = choice.service;
        let runEpoch: number | undefined;
        if (choice.service instanceof GatewayChatService) {
            // Bind a session key to the thread before every gateway send: an
            // unbound thread must never read the shared gateway's mutable
            // active session (another thread may have selected it) — it gets
            // its own default session, so cross-thread leakage is impossible.
            // Deliberate selections always go through handleSelectAgent/
            // handleOpenSession, which set thread.sessionKey explicitly.
            if (!thread.sessionKey) {
                thread.sessionKey = DEFAULT_SESSION_KEY;
            }
            // Explicitly prevent concurrent runs on one gateway session: two
            // unbound threads would otherwise both land on the shared default
            // session, and the second send would replace the first thread's
            // run sink, rendering its response in the wrong thread.
            const busyThread = [...this.threads.values()].some(
                t => t.id !== thread.id && t.sessionKey === thread.sessionKey && t.status === 'running'
            );
            if (busyThread) {
                thread.messages.push({
                    role: 'error',
                    content: `Session "${thread.sessionKey}" is already streaming in another chat thread. Wait for it to finish or open a different session.`
                });
                thread.isStreaming = false;
                thread.status = 'error';
                this.emitState();
                return;
            }
            choice.service.setActiveSession(thread.sessionKey);
            // A new run invalidates every sink captured by an earlier run on
            // this thread: a late `done` from an aborted/rebound run must
            // never commit stale pending text into the current run.
            thread.eventEpoch += 1;
            // Non-gateway (acpx) sends capture the bumped run epoch below:
            // handleChatEvent then validates acpx events per run, so events
            // from a superseded acpx run cannot outlive its replacement.
            runEpoch = thread.eventEpoch;
            // A resumed thread's persistent transcript callback is still in
            // the gateway's fan-out set; the per-run sink would deliver every
            // live event twice to the same thread. Suspend it for the run and
            // restore it when the run ends.
            this.suspendThreadTranscriptSink(choice.service, thread);
        } else {
            // Acpx runs get the same per-run generation guard: bumping the
            // epoch before capture invalidates the previous run's callback,
            // so its asynchronous close cannot deliver a late done/text
            // event into the new run after a transport switch.
            thread.eventEpoch += 1;
            runEpoch = thread.eventEpoch;
        }
        choice.service.sendMessage(
            fullPrompt,
            cwd,
            thread.currentModel,
            thread.currentChatType,
            (event: ChatEvent) => {
                void this.handleChatEvent(thread.id, event, runEpoch);
            },
            (resolvedKey, requestedKey) => {
                // The gateway resolved the send to a different session than
                // requested: rebind the thread (and any suspended transcript
                // callback) to the resolved key so later cancel/reset/close
                // target the session the run actually lives under. Only
                // rebind while the thread is still bound to the requested
                // key — a mid-run agent switch owns the binding by then.
                if (thread.sessionKey !== requestedKey) {
                    // Binding mismatch: the thread was switched to another
                    // session mid-run, so the resolved run no longer belongs
                    // to it. Retire the run instead of letting its events
                    // flow through this thread's callback — output from the
                    // old session would otherwise appear in the newly
                    // selected conversation, and Cancel would target the
                    // wrong key.
                    thread.eventEpoch += 1;
                    if (choice.service instanceof GatewayChatService) {
                        choice.service.abort(resolvedKey);
                        if (![...this.threads.values()].some(t => t.id !== thread.id && t.sessionKey === resolvedKey)) {
                            choice.service.clearSessionSink(resolvedKey);
                        }
                    }
                    return;
                }
                thread.sessionKey = resolvedKey;
                const suspended = this.suspendedTranscriptSinks.get(thread.id);
                if (suspended && suspended.sessionKey === requestedKey) {
                    suspended.sessionKey = resolvedKey;
                }
            }
        );
    }

    /** Resolve the configured chat backend for one send, reusing the thread's
     *  legacy service so per-run lifecycle (abort/cancel) stays intact. */
    /** Persistent transcript callbacks per thread, suspended for the duration
     *  of a run on the same session (the run sink covers live delivery). */
    private suspendedTranscriptSinks = new Map<string, { gateway: GatewayChatService; sessionKey: string }>();

    /** Suspend a thread's persistent transcript callback for an in-flight run
     *  on the same session; prevents duplicate fan-out to the run sink. */
    private suspendThreadTranscriptSink(gateway: GatewayChatService, thread: ChatThreadState): void {
        const own = this.transcriptCallbacks.get(thread.id);
        if (!own || own.sessionKey !== thread.sessionKey) {
            return;
        }
        gateway.removeTranscriptSink(own.sessionKey, own.cb);
        this.suspendedTranscriptSinks.set(thread.id, { gateway, sessionKey: own.sessionKey });
    }

    /** Restore a suspended transcript callback after a run ends: a fresh
     *  callback is created because bindingEpoch may have changed mid-run. */
    private restoreSuspendedTranscriptSink(thread: ChatThreadState): void {
        const suspended = this.suspendedTranscriptSinks.get(thread.id);
        if (!suspended) {
            return;
        }
        this.suspendedTranscriptSinks.delete(thread.id);
        const epoch = thread.bindingEpoch;
        const cb = (event: ChatEvent): void => { void this.handleChatEvent(thread.id, event, epoch, 'binding'); };
        this.transcriptCallbacks.set(thread.id, { sessionKey: suspended.sessionKey, cb });
        suspended.gateway.rebindTranscriptSink(suspended.sessionKey, cb);
    }

    private resolveServiceForSend(existing?: ChatService | GatewayChatService): Promise<{ service: ChatService | GatewayChatService; transport: 'gateway' | 'acpx' }> {
        return this.chatServiceFactory.resolve(existing);
    }

    private async handleChatEvent(threadId: string, event: ChatEvent, eventEpoch?: number, epochScope: 'run' | 'binding' = 'run'): Promise<void> {
        const thread = this.threads.get(threadId);
        if (!thread) {
            log.warn(`handleChatEvent: thread ${threadId} not found`);
            return;
        }
        // A sink captured by an earlier run (aborted then rebound) is stale:
        // its late events belong to the previous session, not this thread.
        // Persistent resume sinks validate against `bindingEpoch` (bumped only
        // on rebind/reset/close), while per-run run-sinks use `eventEpoch`
        // (bumped before every gateway send).
        const currentEpoch = epochScope === 'binding' ? thread.bindingEpoch : thread.eventEpoch;
        if (eventEpoch !== undefined && currentEpoch !== eventEpoch) {
            log.info(`handleChatEvent: dropping stale ${epochScope}-epoch-${eventEpoch} event (current ${currentEpoch}), thread=${threadId}`);
            return;
        }
        log.info(`handleChatEvent: type=${event.type}, thread=${threadId}`);

        switch (event.type) {
            case 'text':
                thread.pendingAssistantText += event.text;
                thread.isStreaming = true;
                thread.status = 'running';
                postToAll([this.sidebarView?.webview, this.popOutPanel?.webview, this.debugPanel?.webview], {
                    type: 'textUpdate',
                    threadId: thread.id,
                    text: thread.pendingAssistantText,
                });
                break;
            case 'toolCall':
                appendToolMessage(thread, {
                    title: event.title,
                    status: event.status,
                    details: event.details,
                    ...(event.id != null ? { id: event.id } : {})
                });
                this.emitState();
                break;
            case 'done':
                if (thread.pendingAssistantText) {
                    const raw = thread.pendingAssistantText;
                    const commitEpoch = thread.eventEpoch;
                    thread.pendingAssistantText = '';
                    const html = await renderMarkdown(raw);
                    // Re-check after the await: a new run started during
                    // markdown rendering bumps the epoch and owns the thread's
                    // pending text; this stale continuation must not commit.
                    if (thread.eventEpoch !== commitEpoch) {
                        log.info(`handleChatEvent: dropping stale done after render (epoch ${commitEpoch} -> ${thread.eventEpoch}), thread=${threadId}`);
                        return;
                    }
                    thread.messages.push({ role: 'assistant', content: raw, html });
                }
                thread.isStreaming = false;
                // A `done` emitted by abort() or a teardown path must not
                // upgrade a cancelled/idle thread to complete.
                if (thread.status !== 'error' && thread.status !== 'cancelled' && thread.status !== 'idle') {
                    thread.status = 'complete';
                }
                this.restoreSuspendedTranscriptSink(thread);
                this.updateThreadSubjectFromContext(thread);
                this.emitState();
                break;
            case 'usage':
                thread.lastUsage = event.usage;
                thread.contextTokens = event.usage.totalTokens;
                this.emitState();
                break;
            case 'error':
                thread.messages.push({ role: 'error', content: event.message });
                thread.isStreaming = false;
                thread.status = 'error';
                this.restoreSuspendedTranscriptSink(thread);
                this.emitState();
                break;
        }
    }

    private maybeRenameThread(thread: ChatThreadState, rawText: string): void {
        const trimmed = rawText.replace(/^\/[a-zA-Z]+\s*/, '').replace(/\s+/g, ' ').trim();
        if (!trimmed) {
            return;
        }

        const baseTitle = `Thread ${thread.index}`;
        if (thread.title !== baseTitle && thread.messages.length > 1) {
            return;
        }

        thread.title = trimmed.length > 42 ? `${trimmed.slice(0, 39)}...` : trimmed;
    }

    private updateThreadSubjectFromContext(thread: ChatThreadState): void {
        const config = vscode.workspace.getConfiguration('openclaw');
        if (!config.get<boolean>('chat.dynamicSubject', true)) {
            return;
        }

        const baseTitle = `Thread ${thread.index}`;
        if (thread.title !== baseTitle) {
            return;
        }

        const userMessages = thread.messages.filter(
            (m): m is { role: 'user' | 'assistant'; content: string } =>
                m.role === 'user' || m.role === 'assistant'
        );
        if (userMessages.length < 2) {
            return;
        }

        const commandUsed = thread.messages.find(
            (m): m is { role: 'user'; content: string } => m.role === 'user' && 'content' in m && m.content.startsWith('/')
        );
        const attachments = thread.pendingAttachments;
        const allText = thread.messages
            .filter((m): m is { role: 'user' | 'assistant'; content: string } =>
                m.role === 'user' || m.role === 'assistant'
            )
            .map(m => m.content)
            .join(' ');

        const fileNames = allText.match(/\/([^\/\s]+\.[a-zA-Z0-9]+)/g);
        const extractedFileName = fileNames?.[0]?.replace(/.*\//, '') || '';

        let subject = baseTitle;

        if (commandUsed) {
            const cmdName = commandUsed.content.match(/^\/(\w+)/)?.[1] || '';
            const commandLabel = cmdName.charAt(0).toUpperCase() + cmdName.slice(1);

            if (extractedFileName) {
                subject = `${commandLabel}: ${extractedFileName}`;
            } else {
                const contextSnippet = allText
                    .replace(/^\/[a-zA-Z]+\s*/, '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 30);
                subject = contextSnippet ? `${commandLabel}: ${contextSnippet}...` : commandLabel;
            }
        } else if (attachments.length > 0) {
            const fileName = path.basename(attachments[0].path);
            subject = `File: ${fileName}`;
        } else {
            const topicMatch = allText.match(/([A-Z][a-z]+(?:[A-Z][a-z]+)+)|(\b(?:API|UI|HTML|CSS|JSON|REST|CLI)\b)/);
            if (topicMatch) {
                subject = topicMatch[0].slice(0, 42);
            }
        }

        if (subject !== baseTitle) {
            thread.title = subject.length > 50 ? `${subject.slice(0, 47)}...` : subject;
        }
    }

    private emitState(): void {
        try {
            const config = vscode.workspace.getConfiguration('openclaw');
            const dimension = config.get<string>('chat.dimension', '1x1');
            const collapseCompleted = config.get<boolean>('chat.collapseCompleted', true);
            const hideToolActivity = config.get<boolean>('chat.hideToolActivity', false);
            const base = {
                type: 'state',
                activeThreadId: this.activeThreadId,
                visibleThreadIds: this.visibleThreadIds,
                models: this.getAvailableModels(),
                dimension,
                collapseCompleted,
                hideToolActivity
            };
            const threads = buildThreadSnapshots(this.threads, this.visibleThreadIds);
            const totalMessages = threads.reduce((sum, t) => sum + t.messages.length, 0);
            log.info(`emitState: ${threads.length} threads, ${totalMessages} msgs, active=${this.activeThreadId}, sidebar=${!!this.sidebarView}, popout=${!!this.popOutPanel}, debug=${!!this.debugPanel}`);

            for (const webview of [this.sidebarView?.webview, this.popOutPanel?.webview, this.debugPanel?.webview]) {
                if (!webview) { continue; }
                const enriched = enrichAttachmentsForWebview(threads, webview);
                webview.postMessage({ ...base, threads: enriched });
            }
        } catch (err) {
            log.error('emitState failed', err);
            postToAll([this.sidebarView?.webview, this.popOutPanel?.webview, this.debugPanel?.webview], { type: 'state', threads: [], activeThreadId: '', visibleThreadIds: [], models: [], dimension: '1x1', collapseCompleted: true });
        }
    }

    private bootstrapWebview(): void {
        setTimeout(() => {
            postToAll([this.sidebarView?.webview, this.popOutPanel?.webview, this.debugPanel?.webview], {
                type: 'slashCommands',
                commands: SLASH_COMMANDS.map(c => ({
                    name: c.name,
                    description: c.description,
                    icon: c.icon,
                    placeholder: c.placeholder,
                })),
            });
            this.pushRecommendations();
            this.emitState();

            if (this.globalState.get<boolean>('openclaw.onboardingComplete')) {
                postToAll([this.sidebarView?.webview, this.popOutPanel?.webview, this.debugPanel?.webview], { type: 'onboardingDone' });
            }
        }, 100);
        if (!this.resumeStarted) {
            this.resumeStarted = true;
            void this.resumeLastSession();
        }
    }

    /** Command-palette agent picker bound to the active chat. */
    async showAgentPicker(): Promise<void> {
        const gateway = await this.resolveGateway();
        const picker = new AgentPicker(gateway, {
            show: async (items) => {
                const chosen = await vscode.window.showQuickPick(
                    items.map(item => ({
                        label: item.hasActiveRun ? '$(sync~spin) ' + item.label : item.label,
                        description: item.hasActiveRun ? 'running' : item.updatedAt ?? '',
                        detail: item.sessionKey,
                        item,
                    })),
                    { placeHolder: 'Select an agent session for this chat' }
                );
                return chosen?.item;
            },
        });
        const chosen = await picker.pick();
        if (chosen) {
            // Route through the open flow, not just key binding: unlike the
            // webview session flow, the palette selection must fetch history
            // and register the transcript resume sink, or the thread keeps
            // showing the previous conversation and receives no events.
            await this.handleOpenSession(chosen.sessionKey);
        }
    }

    /** Resolve the gateway transport for session-list/ history flows. */
    private async resolveGateway(): Promise<GatewayChatService | null> {
        const choice = await this.chatServiceFactory.resolve();
        return choice.transport === 'gateway' && choice.service instanceof GatewayChatService
            ? choice.service
            : null;
    }

    /** List sessions for the webview picker (agents) or history list. */
    private async handleListSessions(forPicker: boolean): Promise<void> {
        const gateway = await this.resolveGateway();
        if (!gateway) {
            return;
        }
        try {
            const payload = await gateway.listSessions({});
            postToAll([this.sidebarView?.webview, this.popOutPanel?.webview, this.debugPanel?.webview], {
                type: forPicker ? 'agentsList' : 'sessionsList',
                sessions: buildAgentSessionItems(payload),
            });
        } catch (err) {
            log.warn('sessions.list failed', err);
        }
    }

    /** Bind the chosen agent session key to the active chat and persist it. */
    private async handleSelectAgent(sessionKey: string): Promise<void> {
        const gateway = await this.resolveGateway();
        if (!gateway) {
            return;
        }
        // Selecting an agent invalidates any pending openSession on the
        // active thread: its openGeneration-guarded continuation would
        // otherwise pass the stale-generation check after its history/list
        // await and clobber this binding (and persist the stale key again).
        const pendingOpenThread = this.getActiveThread();
        if (pendingOpenThread) {
            pendingOpenThread.openGeneration += 1;
            // Same send-rejection marker as handleOpenSession: the shared
            // session is switched before the rebind and the persist await
            // opens a window where a send would target the previous key.
            pendingOpenThread.openInFlightGen = pendingOpenThread.openGeneration;
        }
        gateway.setActiveSession(sessionKey);
        try {
            await this.persistLastSessionKey(sessionKey);
        } finally {
            if (pendingOpenThread && pendingOpenThread.openInFlightGen === pendingOpenThread.openGeneration) {
                pendingOpenThread.openInFlightGen = null;
            }
        }
        const activeThread = this.getActiveThread();
        if (activeThread) {
            // An acpx run has no session key (and a gateway-fallback run can
            // still use an acpx backend): selecting another agent while such
            // a run is streaming must retire its backend, or its late output
            // would bleed into the newly selected conversation. The gateway
            // branch below aborts the previous session key itself.
            const previousBackend = this.backendFor(activeThread);
            if (activeThread.status === 'running' && !(previousBackend instanceof GatewayChatService)) {
                activeThread.eventEpoch += 1;
                activeThread.bindingEpoch += 1;
                previousBackend.abort();
            }
            // Selecting another agent rebinds the thread: retire any run on
            // the previous session first so its late events cannot leak into
            // the newly selected conversation and Cancel targets the new key.
            if (activeThread.sessionKey && activeThread.sessionKey !== sessionKey) {
                const previousKey = activeThread.sessionKey;
                // Drop this thread's own callback (and any suspended one) for
                // the retired key before rebinding: closeThread matches the
                // callback against the thread's current key, so an orphaned
                // sink would linger in the shared gateway's fan-out set.
                const ownCallback = this.transcriptCallbacks.get(activeThread.id);
                if (ownCallback && ownCallback.sessionKey === previousKey) {
                    this.transcriptCallbacks.delete(activeThread.id);
                    gateway.removeTranscriptSink(previousKey, ownCallback.cb);
                }
                const suspendedSink = this.suspendedTranscriptSinks.get(activeThread.id);
                if (suspendedSink && suspendedSink.sessionKey === previousKey) {
                    this.suspendedTranscriptSinks.delete(activeThread.id);
                }
                // Abort/clear when no other thread still *runs* on the
                // previous session: an idle resumed thread is only a
                // transcript subscriber and must not keep this thread's own
                // run alive, while a live run on the same key is not ours to
                // cancel. Only the shared-live-run case skips the abort.
                const sharesLiveRun = [...this.threads.values()].some(
                    t => t.id !== activeThread.id && t.sessionKey === previousKey && t.status === 'running'
                );
                // Epoch bump precedes abort: a disconnected gateway
                // completes the old sink synchronously, and the sink's
                // captured epoch must already be stale when it fires.
                activeThread.eventEpoch += 1;
                activeThread.bindingEpoch += 1;
                // Only a gateway-backed run may abort the previous gateway
                // session: an acpx fallback run holds no gateway run (the
                // branch above already retired its backend), so an
                // unconditional abort here would cancel whatever other owner
                // still runs on the stale binding key.
                if (!sharesLiveRun && previousBackend instanceof GatewayChatService) {
                    gateway.abort(previousKey);
                    if (!this.otherThreadsOnKey(activeThread.id, previousKey)) {
                        // Only clear the shared session sink when this thread
                        // was its last subscriber: another thread that merely
                        // resumed the previous session (idle) still holds a
                        // valid transcript sink and must keep receiving.
                        gateway.clearSessionSink(previousKey);
                    }
                }
                activeThread.isStreaming = false;
                // The rebind retires the previous conversation's in-flight
                // response: stale pending text and a `running` status must
                // not bleed into the newly selected session.
                activeThread.pendingAssistantText = '';
                activeThread.status = 'idle';
            }
            activeThread.sessionKey = sessionKey;
        }
        postToAll([this.sidebarView?.webview, this.popOutPanel?.webview, this.debugPanel?.webview], {
            type: 'agentSelected',
            sessionKey,
        });
    }

    /** Whether any other thread (or its suspended sink) is still bound to
     *  the given session key: such threads keep valid transcript sinks that
     *  a clearSessionSink call must not wipe. */
    private otherThreadsOnKey(excludeThreadId: string, sessionKey: string): boolean {
        for (const t of this.threads.values()) {
            if (t.id !== excludeThreadId && t.sessionKey === sessionKey) {
                return true;
            }
        }
        for (const [threadId, suspended] of this.suspendedTranscriptSinks) {
            if (threadId !== excludeThreadId && suspended.sessionKey === sessionKey) {
                return true;
            }
        }
        return false;
    }

    /** Open a session: restore its transcript into the active thread.
     *  Session opening is async: after every await, the thread is re-checked
     *  (still the active thread, still bound to the requested key) so a
     *  newer open of another session cannot be overwritten by this call's
     *  late history/resume. */
    private async handleOpenSession(sessionKey: string): Promise<void> {
        const gateway = await this.resolveGateway();
        if (!gateway) {
            return;
        }
        const thread = this.getActiveThread();
        if (!thread) {
            return;
        }
        // Open-generation marker for this request: a newer openSession on the
        // same thread bumps the counter, so this continuation can detect it
        // after every await (the session key alone cannot — it still holds
        // the previous key until this request assigns the new one).
        const openGen = ++thread.openGeneration;
        // Send-rejection marker: the shared gateway session is switched below
        // before the thread is rebound, and the rebinding awaits persistence,
        // so a send accepted in that window would target the previous key and
        // its callback would later deliver into the newly opened session.
        // Cleared only while this open still owns the marker (a newer open
        // supersedes it and owns the marker from then on).
        thread.openInFlightGen = openGen;
        try {
            await this.openSessionRebinding(thread, sessionKey, gateway, openGen);
        } finally {
            if (thread.openInFlightGen === openGen) {
                thread.openInFlightGen = null;
            }
        }
    }

    /** Continuation of handleOpenSession with the in-flight marker set: every
     *  await below re-checks the active thread and the open generation so a
     *  newer open (or thread switch) cannot be overwritten by this late
     *  continuation. */
    private async openSessionRebinding(
        thread: ChatThreadState,
        sessionKey: string,
        gateway: GatewayChatService,
        openGen: number
    ): Promise<void> {
        const reboundFrom = thread.sessionKey && thread.sessionKey !== sessionKey ? thread.sessionKey : null;
        // Same acpx guard as handleSelectAgent: a streaming run without a
        // gateway session key (or on an acpx fallback backend) must be
        // retired before rebinding, or its late output lands in the newly
        // opened transcript.
        const previousBackend = this.backendFor(thread);
        if (thread.status === 'running' && !(previousBackend instanceof GatewayChatService)) {
            thread.eventEpoch += 1;
            thread.bindingEpoch += 1;
            previousBackend.abort();
        }
        // Retire any run still active on the previous session before
        // rebinding: late events from the old run would otherwise be
        // appended to the newly opened transcript. The old transcript
        // sink is dropped too, so events for the previous key cannot
        // reach the rebound thread.
        if (thread.sessionKey && thread.sessionKey !== sessionKey) {
            const previousKey = thread.sessionKey;
            // Same shared-session guard as handleSelectAgent: only tear down
            // the previous session when no other thread still *runs* on it;
            // an idle resumed subscriber must not keep this thread's run
            // alive, and a live run on the same key is not ours to cancel.
            // The suspended entry (if the retired run had one) must go too:
            // a later restore would otherwise rebind the old session's
            // callback to this thread and deliver cross-session events.
            const suspendedSink = this.suspendedTranscriptSinks.get(thread.id);
            if (suspendedSink && suspendedSink.sessionKey === previousKey) {
                this.suspendedTranscriptSinks.delete(thread.id);
            }
            const sharesLiveRun = [...this.threads.values()].some(
                t => t.id !== thread.id && t.sessionKey === previousKey && t.status === 'running'
            );
            // Epoch bump precedes abort in both cases: the aborted run's
            // async completion must not reach the rebound thread.
            thread.eventEpoch += 1;
            thread.bindingEpoch += 1;
            // Same backend-type guard as handleSelectAgent: only a
            // gateway-backed run may abort the previous gateway session; an
            // acpx fallback run (retired above) must not cancel whatever
            // other owner still runs on the stale binding key.
            if (!sharesLiveRun && previousBackend instanceof GatewayChatService) {
                gateway.abort(previousKey);
                if (!this.otherThreadsOnKey(thread.id, previousKey)) {
                    // Same guard as handleSelectAgent: idle resumed
                    // subscribers on the previous session keep their sink.
                    gateway.clearSessionSink(previousKey);
                }
            }
            thread.isStreaming = false;
            thread.pendingAssistantText = '';
            thread.status = 'idle';
        }
        gateway.setActiveSession(sessionKey);
        await this.persistLastSessionKey(sessionKey);
        if (this.getActiveThread()?.id !== thread.id) {
            return;
        }
        if (thread.openGeneration !== openGen) {
            // A newer openSession request superseded this one while the
            // persist/await above was in flight: never clobber the newer
            // selection with this stale key, and restore the newer key as
            // the persisted last-session since our persist overwrote it.
            await this.persistLastSessionKey(thread.sessionKey ?? sessionKey);
            return;
        }
        thread.sessionKey = sessionKey;
        // Bind the thread to the gateway transport right away: until the
        // next send, cancel/clear/close call backendFor(thread), which must
        // reach the gateway session actually opened here instead of the
        // unused legacy ChatService.
        thread.transportBackend = gateway;

        let label = sessionKey;
        try {
            const payload = await gateway.listSessions({});
            if (this.getActiveThread()?.id !== thread.id || thread.sessionKey !== sessionKey) {
                return;
            }
            const rows = parseSessionRows(payload).rows as SessionRow[];
            const row = rows.find(r => r.key === sessionKey);
            if (row) {
                label = row.label || row.agentId || sessionKey;
                if (isColdSession(row)) {
                    // A cold session has no transcript: drop any previous
                    // thread content and stale run state before showing
                    // its placeholder.
                    thread.messages = [];
                    thread.status = 'idle';
                    thread.messages.push({ role: 'assistant', content: COLD_SESSION_PLACEHOLDER });
                    thread.title = label;
                    this.emitState();
                    // The cold branch returns before the final agentSelected
                    // post below; the webview only dismisses the sessions
                    // panel on that message, so it must fire here too.
                    postToAll([this.sidebarView?.webview, this.popOutPanel?.webview, this.debugPanel?.webview], {
                        type: 'agentSelected',
                        sessionKey,
                    });
                    this.resumeSessionForThread(gateway, thread, sessionKey);
                    return;
                }
            }
        } catch (err) {
            log.warn('sessions.list during open failed', err);
        }

        const historyEpoch = thread.eventEpoch;
        // Reopening the session this thread is already bound to while a run
        // is in flight must not replace the transcript or reset status:
        // the unconditional restore would drop the live response. The thread
        // keeps its registered transcript callback, so nothing to rebind.
        if (thread.sessionKey === sessionKey && (thread.isStreaming || thread.status === 'running')) {
            return;
        }
        const history = await gateway.getHistory(sessionKey);
        if (this.getActiveThread()?.id !== thread.id || thread.sessionKey !== sessionKey || thread.eventEpoch !== historyEpoch) {
            return;
        }
        // A successful fetch replaces the transcript unconditionally (empty
        // history clears the prior session's messages); a failed fetch keeps
        // the current transcript rather than wiping it on transport errors.
        if (history !== null) {
            const restored = mapHistoryMessages(history);
            // Seed the gateway's delta cursor and messageId dedupe set from
            // the restored transcript so resumeSession's catch-up does not
            // replay the history we just rendered (or leave the thread
            // streaming).
            gateway.seedHistory(sessionKey, history);
            thread.title = label;
            thread.messages = [];
            for (const msg of restored) {
                thread.messages.push({ role: msg.role, content: msg.content });
            }
            thread.status = 'idle';
        } else if (reboundFrom) {
            // A failed fetch after a session switch must not keep the
            // previous session's transcript under the new key: the resume
            // sink below would show the old transcript as the new session
            // and append new-session events to it. Clear it and surface an
            // explicit load error instead (a same-key reopen keeps its
            // transcript on transport errors by design).
            thread.messages = [];
            thread.messages.push({
                role: 'assistant',
                content: 'Failed to load session history. Reopen the session to retry.'
            });
            thread.title = label;
            thread.status = 'error';
        }
        // Dismiss the sessions panel in every webview surface: opening a
        // row is a selection, so the panel must close the same way it does
        // for selectAgent.
        postToAll([this.sidebarView?.webview, this.popOutPanel?.webview, this.debugPanel?.webview], {
            type: 'agentSelected',
            sessionKey,
        });
        this.resumeSessionForThread(gateway, thread, sessionKey);
        this.emitState();
    }

    /** Resume a session for a thread, replacing any previous transcript
     *  callback for that session so reopen cannot deliver events twice. */
    private resumeSessionForThread(gateway: GatewayChatService, thread: ChatThreadState, sessionKey: string): void {
        // Track callbacks per thread: opening/resuming the same session in a
        // second thread must not evict this thread's callback from the
        // gateway's fan-out sink set.
        const prior = this.transcriptCallbacks.get(thread.id);
        if (prior) {
            gateway.removeTranscriptSink(prior.sessionKey, prior.cb);
        }
        const resumeEpoch = thread.bindingEpoch;
        const cb = (event: ChatEvent): void => { void this.handleChatEvent(thread.id, event, resumeEpoch, 'binding'); };
        this.transcriptCallbacks.set(thread.id, { sessionKey, cb });
        gateway.resumeSession(sessionKey, cb);
    }

    /** Persist the last selected session key for window-restart resume. */
    private async persistLastSessionKey(sessionKey: string): Promise<void> {
        this.lastSessionKey = sessionKey;
        await this.context.workspaceState.update(ChatViewProvider.LAST_SESSION_KEY, sessionKey);
    }

    /** Resume the persisted session after a window restart (catch-up). */
    private async resumeLastSession(): Promise<void> {
        const sessionKey = this.context.workspaceState.get<string>(ChatViewProvider.LAST_SESSION_KEY);
        if (!sessionKey) {
            return;
        }
        // The persisted key may come from an older version or stale workspace
        // state: validate its shape before binding, so a subagent/foreign
        // session key cannot bypass the main-session policy enforced by the
        // picker for webview selections.
        if (!isMainAgentSessionKey(sessionKey)) {
            log.warn(`resumeLastSession: persisted key failed main-agent validation, ignoring: ${sessionKey}`);
            this.lastSessionKey = null;
            await this.context.workspaceState.update(ChatViewProvider.LAST_SESSION_KEY, undefined);
            return;
        }
        this.lastSessionKey = sessionKey;
        const gateway = await this.resolveGateway();
        if (!gateway) {
            return;
        }
        gateway.setActiveSession(sessionKey);
        const thread = this.getActiveThread();
        if (thread) {
            // Carry the persisted key onto the thread so later cancel/reset
            // aborts target this resumed session, not the shared fallback.
            thread.sessionKey = sessionKey;
            // Bind the resumed thread to the gateway transport immediately:
            // until the next send, backendFor(thread) must return the gateway
            // service or Cancel/Clear/Close abort the wrong (legacy) backend.
            thread.transportBackend = gateway;
            // Restore the full transcript before subscribing, so the catch-up
            // delta callback does not replay the whole session into the live
            // stream (user messages would be dropped and assistant messages
            // would pile up as one pending response).
            try {
                const history = await gateway.getHistory(sessionKey);
                // Re-check after the await: opening another session meanwhile
                // must not let this late resume overwrite its transcript, and
                // a run the user started on this thread during the await (its
                // messages live in the thread) must not be dropped either.
                if (this.getActiveThread()?.id !== thread.id || this.lastSessionKey !== sessionKey ||
                    thread.isStreaming || thread.status === 'running') {
                    return;
                }
                // Replace the transcript instead of appending: on a
                // re-resume the thread may already hold in-memory
                // messages that would otherwise duplicate restored
                // history.
                if (history !== null) {
                    thread.messages = mapHistoryMessages(history).map((msg) => ({ role: msg.role, content: msg.content }));
                }
                thread.status = 'idle';
                // Seed cursor/message dedupe from the restored transcript so
                // the resume catch-up below does not replay this history.
                gateway.seedHistory(sessionKey, history);
            } catch (err) {
                log.warn('history restore during resume failed', err);
            }
            this.resumeSessionForThread(gateway, thread, sessionKey);
            this.emitState();
        }
    }

    /** Absolute fsPath of the active editor file, if any. */
    private async getActiveEditorFilePath(): Promise<string | undefined> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'file') {
            return undefined;
        }
        return editor.document.uri.fsPath;
    }

    /** Resolve @file mentions to workspace-scoped real paths; symlink escapes
     *  and unreadable targets are rejected before an attachment is accepted. */
    private async resolveMentions(text: string): Promise<FileMention[]> {
        const cwd = this.getWorkspaceCwd();
        if (!cwd) {
            return [];
        }
        const realCwd = await fs.promises.realpath(cwd).catch(() => cwd);
        const candidates = parseFileMentions(text)
            .map(mention => ({ ...mention, path: path.isAbsolute(mention.path) ? mention.path : path.join(cwd, mention.path) }))
            .map(mention => ({ ...mention, path: path.resolve(mention.path) }));
        // Resolve all mention targets concurrently; each is independent fs I/O
        // and a slow disk should not multiply per-mention send latency.
        const reals = await Promise.all(
            candidates.map(mention => fs.promises.realpath(mention.path).catch(() => null))
        );
        const accepted: FileMention[] = [];
        for (let i = 0; i < candidates.length; i++) {
            const real = reals[i];
            if (!real) {
                continue;
            }
            const rel = path.relative(realCwd, real);
            if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
                // Store the canonical path: a symlink could be swapped between
                // this check and the later read, so reading the original path
                // would bypass the workspace guard (TOCTOU).
                accepted.push({ ...candidates[i], path: real });
            }
        }
        return accepted;
    }

    /** Workspace-scoped paths only, for callers that ignore mention line ranges. */
    private async resolveMentionPaths(text: string): Promise<string[]> {
        return (await this.resolveMentions(text)).map(m => m.path);
    }

    /** Gather the current selection and insert an @file mention into the webview composer. */
    async insertSelectionMention(): Promise<void> {
        const context = await gatherEditorContext('selection', (args) => this.runGit(args));
        if (!context.filePath) {
            return;
        }
        const editor = vscode.window.activeTextEditor;
        const sel = editor && !editor.selection.isEmpty ? editor.selection : undefined;
        let mention: string;
        if (sel) {
            const endLine = sel.end.character === 0 ? sel.end.line : sel.end.line + 1;
            mention = buildMention(context.filePath, sel.start.line + 1, endLine);
        } else {
            mention = buildMention(context.filePath);
        }
        postToAll([this.sidebarView?.webview, this.popOutPanel?.webview, this.debugPanel?.webview], {
            type: 'insertMention',
            mention
        });
    }

    private async openFileInEditor(filePath: string, lineStr?: string): Promise<void> {
        const cwd = this.getWorkspaceCwd();
        const resolvedPath = path.isAbsolute(filePath) ? filePath : cwd ? path.join(cwd, filePath) : filePath;
        try {
            const uri = vscode.Uri.file(resolvedPath);
            const doc = await vscode.workspace.openTextDocument(uri);
            const lineNum = lineStr ? Math.max(0, parseInt(lineStr, 10) - 1) : 0;
            const selection = new vscode.Range(lineNum, 0, lineNum, 0);
            await vscode.window.showTextDocument(doc, { selection, preview: true });
        } catch (err) {
            log.warn('openFileInEditor failed', err);
            void vscode.window.showWarningMessage(`Could not open file: ${filePath}`);
        }
    }

    private getWorkspaceCwd(): string | undefined {
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            return folders[0].uri.fsPath;
        }
        return undefined;
    }
}

/** Stable dedupe key for an attachment or mention: path plus 1-based range. */
function attachmentKey(a: { path: string; lineStart?: number; lineEnd?: number }): string {
    return `${a.path}\u0000${a.lineStart ?? ''}\u0000${a.lineEnd ?? a.lineStart ?? ''}`;
}

const mentionKey = attachmentKey;
