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
                            backend.abort(thread.sessionKey);
                        } else {
                            backend.abort();
                        }
                        thread.isStreaming = false;
                        thread.status = 'cancelled';
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
                    if (msg.sessionKey) {
                        await this.handleSelectAgent(msg.sessionKey);
                    }
                    break;
                case 'openSession':
                    if (msg.sessionKey) {
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
            service: new ChatService()
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
            backend.abort(thread.sessionKey);
        } else {
            backend.abort();
        }
        thread.messages = [];
        thread.pendingAssistantText = '';
        thread.pendingAttachments = [];
        thread.isStreaming = false;
        thread.status = 'idle';
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

    private async addAttachments(thread: ChatThreadState, items: Array<string | FileMention>): Promise<void> {
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
        const augmented = buildSlashPrompt(commandName, userText, context);
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
                await this.addAttachments(thread, [autoAttachPath]);
                pushNew(thread.pendingAttachments.filter(a => a.path === autoAttachPath));
            }
        }

        const mentions = await this.resolveMentions(text);
        if (mentions.length > 0) {
            await this.addAttachments(thread, mentions);
            // Mention dedupe keys on (path + range); attach only pending
            // entries whose range matches an accepted mention, not every
            // attachment of the same file.
            const mentionKeys = new Set(mentions.map(mentionKey));
            pushNew(thread.pendingAttachments.filter(a => mentionKeys.has(attachmentKey(a))));
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
        thread.transportBackend = choice.service;
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
            choice.service.setActiveSession(thread.sessionKey);
        }
        choice.service.sendMessage(
            fullPrompt,
            cwd,
            thread.currentModel,
            thread.currentChatType,
            (event: ChatEvent) => {
                void this.handleChatEvent(thread.id, event);
            }
        );
    }

    /** Resolve the configured chat backend for one send, reusing the thread's
     *  legacy service so per-run lifecycle (abort/cancel) stays intact. */
    private resolveServiceForSend(existing?: ChatService | GatewayChatService): Promise<{ service: ChatService | GatewayChatService; transport: 'gateway' | 'acpx' }> {
        return this.chatServiceFactory.resolve(existing);
    }

    private async handleChatEvent(threadId: string, event: ChatEvent): Promise<void> {
        const thread = this.threads.get(threadId);
        if (!thread) {
            log.warn(`handleChatEvent: thread ${threadId} not found`);
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
                    details: event.details
                });
                this.emitState();
                break;
            case 'done':
                if (thread.pendingAssistantText) {
                    const raw = thread.pendingAssistantText;
                    thread.pendingAssistantText = '';
                    const html = await renderMarkdown(raw);
                    thread.messages.push({ role: 'assistant', content: raw, html });
                }
                thread.isStreaming = false;
                // A `done` emitted by abort() or a teardown path must not
                // upgrade a cancelled/idle thread to complete.
                if (thread.status !== 'error' && thread.status !== 'cancelled' && thread.status !== 'idle') {
                    thread.status = 'complete';
                }
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
            await this.handleSelectAgent(chosen.sessionKey);
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
        gateway.setActiveSession(sessionKey);
        await this.persistLastSessionKey(sessionKey);
        const activeThread = this.getActiveThread();
        if (activeThread) {
            // Selecting another agent rebinds the thread: retire any run on
            // the previous session first so its late events cannot leak into
            // the newly selected conversation and Cancel targets the new key.
            if (activeThread.sessionKey && activeThread.sessionKey !== sessionKey) {
                gateway.abort(activeThread.sessionKey);
                gateway.clearSessionSink(activeThread.sessionKey);
                activeThread.isStreaming = false;
            }
            activeThread.sessionKey = sessionKey;
        }
        postToAll([this.sidebarView?.webview, this.popOutPanel?.webview, this.debugPanel?.webview], {
            type: 'agentSelected',
            sessionKey,
        });
    }

    /** Open a session: restore its transcript into the active thread. */
    private async handleOpenSession(sessionKey: string): Promise<void> {
        const gateway = await this.resolveGateway();
        if (!gateway) {
            return;
        }
        const thread = this.getActiveThread();
        if (!thread) {
            return;
        }
        // Retire any run still active on the previous session before
        // rebinding: late events from the old run would otherwise be
        // appended to the newly opened transcript. The old transcript
        // sink is dropped too, so events for the previous key cannot
        // reach the rebound thread.
        if (thread.sessionKey && thread.sessionKey !== sessionKey) {
            const previousKey = thread.sessionKey;
            gateway.abort(previousKey);
            gateway.clearSessionSink(previousKey);
            thread.isStreaming = false;
        }
        gateway.setActiveSession(sessionKey);
        await this.persistLastSessionKey(sessionKey);
        thread.sessionKey = sessionKey;

        let label = sessionKey;
        try {
            const payload = await gateway.listSessions({});
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
                    gateway.resumeSession(sessionKey, (event) => { void this.handleChatEvent(thread.id, event); });
                    return;
                }
            }
        } catch (err) {
            log.warn('sessions.list during open failed', err);
        }

        const history = await gateway.getHistory(sessionKey);
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
        }
        gateway.resumeSession(sessionKey, (event) => { void this.handleChatEvent(thread.id, event); });
        this.emitState();
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
            // Restore the full transcript before subscribing, so the catch-up
            // delta callback does not replay the whole session into the live
            // stream (user messages would be dropped and assistant messages
            // would pile up as one pending response).
            try {
                const history = await gateway.getHistory(sessionKey);
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
            gateway.resumeSession(sessionKey, (event) => { void this.handleChatEvent(thread.id, event); });
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
        const accepted: FileMention[] = [];
        for (const mention of candidates) {
            const real = await fs.promises.realpath(mention.path).catch(() => null);
            if (!real) {
                continue;
            }
            const rel = path.relative(realCwd, real);
            if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
                accepted.push(mention);
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
