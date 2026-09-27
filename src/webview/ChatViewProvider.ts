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
    /** Monotonic selection generation: bumped by every handleSelectAgent so
     *  an older selection's continuation (still inside its persist await)
     *  detects that a newer selection superseded it and aborts instead of
     *  rebinding the stale key or re-persisting an obsolete session key. */
    private selectGeneration = 0;
    /** Monotonic persist generation and write chain for the durable last-
     *  session-key commit: two selections can overlap inside their persist
     *  awaits, and whichever workspaceState.update resolves last would
     *  otherwise win — persisting a stale key that resumes after a restart
     *  even though the in-memory generation checks rejected that request.
     *  Writes are serialized and each commit re-verifies it is still the
     *  newest request before touching workspace state. */
    private persistGeneration = 0;
    private persistLastSessionKeyWrite: Promise<void> = Promise.resolve();
    /** Main-agent session keys reported by the most recent sessions.list:
     *  webview-supplied keys are only shape-checked at the message boundary,
     *  so selectAgent/openSession verify against this allowlist before
     *  rebinding or loading history (a crafted key for an unlisted agent
     *  must not activate that session or pull its transcript). */
    private knownMainSessionKeys = new Set<string>();
    /** Gateway identity the current allowlist was built from. A URL or
     *  token change invalidates the list: keys reported by the previous
     *  gateway must not pass the allowlist (or be auto-refreshed against)
     *  after switching to another gateway. */
    private allowlistGatewayId: string | null = null;
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

    /**
     *  Same shared-run guard as resetThread: aborting a
     *  shared session key would cancel another thread's
     *  live run on the shared gateway client.
     */
    /**
     *  Bump the epoch BEFORE abort: a disconnected
     *  gateway completes the old sink synchronously, so
     *  the incremented epoch must already be in place or
     *  the stale completion is treated as current.
     */
    /**
     *  Same ownership guard as resetThread/closeThread:
     *  cancelling an idle resumed thread must not send
     *  chat.abort for a run owned by the gateway or
     *  another client. A thread is marked running before
     *  sendPrompt resolves the backend and registers the
     *  run sink, so hasOwnedRun also gates the lifecycle
     *  abort during that await window.
     */
    /**
     *  Epoch bump before abort: the acpx close fires
     *  asynchronously and must not deliver late events
     *  into a thread that already cancelled.
     */
    /**
     *  The run sink's `done` is epoch-dropped above, so the
     *  suspended transcript callback would stay stranded
     *  and the thread would stop receiving transcript
     *  events until a later run restores it.
     */
    /**
     *  Webview-supplied keys are untrusted: enforce the same
     *  strict main-session filter as the picker for both actions.
     */
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
                            const shared = [...this.threads.values()].some(
                                t => t.id !== thread.id && t.sessionKey === thread.sessionKey && t.status === 'running'
                            );
                            thread.eventEpoch += 1;
                            if (thread.sessionKey && !shared && thread.status === 'running' && backend.hasOwnedRun(thread.sessionKey)) {
                                backend.abort(thread.sessionKey);
                            }
                        } else {
                            thread.eventEpoch += 1;
                            backend.abort();
                        }
                        thread.isStreaming = false;
                        thread.status = 'cancelled';
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

    /**
     *  Only abort the session when no other thread is still bound to
     *  it: that thread may own the active run, and resetting an idle
     *  thread must not cancel the other thread's run.
     *  Both generations bump before abort: a disconnected gateway
     *  completes the old sink synchronously, and its captured
     *  epochs must already be stale when the `done` fires.
     */
    /**
     *  An openSession rebinding already in flight passes its
     *  unchanged openGeneration after reset unless the counter is
     *  bumped here: the continuation would then assign the session
     *  and history, undoing this clear (and holding the thread
     *  hostage via openInFlightGen until then).
     */
    /**
     *  Only abort when this thread actually owns a run: an idle
     *  resumed thread holds no gateway run, and a chat.abort here
     *  would cancel a run owned by the gateway or another client.
     *  The hasOwnedRun gate also covers the pre-ack window before
     *  sendPrompt resolves the backend and registers the sink.
     */
    /**
     *  Abort's `done` is epoch-dropped above, so the suspended transcript
     *  callback would stay stranded: restore it explicitly so the thread
     *  keeps receiving transcript events after the reset. An idle resumed
     *  thread has no suspended sink, but its persistent callback was
     *  captured with the pre-bump bindingEpoch: rebind it too, or every
     *  future transcript event is epoch-dropped after Clear/Reset.
     */
    private resetThread(thread: ChatThreadState): void {
        const backend = this.backendFor(thread);
        if (backend instanceof GatewayChatService) {
            thread.eventEpoch += 1;
            thread.bindingEpoch += 1;
            thread.openGeneration += 1;
            thread.openInFlightGen = null;
            if (thread.sessionKey) {
                const shared = [...this.threads.values()].some(
                    t => t.id !== thread.id && t.sessionKey === thread.sessionKey && t.status === 'running'
                );
                if (!shared && thread.status === 'running' && backend.hasOwnedRun(thread.sessionKey)) {
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

    /**
     *  Invalidate pending send/attach continuations before teardown: unlike
     *  resetThread, this path had no epoch bump, so a pending continuation
     *  could pass its captured-epoch guard and mutate (or emit state for)
     *  a thread that is about to be deleted.
     */
    /**
     *  Retire this thread's persistent transcript callback before closing:
     *  the deleted thread's sink must not linger in the gateway's fan-out
     *  set (its events would be dropped by the epoch guard anyway, but the
     *  callback would still be retained by the shared service).
     */
    /**
     *  Same ownership guard as resetThread: abort only a run this
     *  thread actually owned; an idle resumed thread must not cancel
     *  a run owned by the gateway or another client. The hasOwnedRun
     *  gate also covers the pre-ack window before the run sink exists.
     *  A shared key needs the same live-run exclusion as resetThread:
     *  hasOwnedRun proves only that the gateway holds a local run
     *  sink for the key, not that this thread owns it — two threads
     *  can share a session key, and closing this one must not abort
     *  the other's run.
     */
    /**
     *  Drop the thread's transcript sink if no surviving thread still
     *  listens to this session, so the closed thread's callback is not
     *  retained by the shared gateway service.
     */
    /**
     *  An acpx run stores a dedicated backend on the thread; dispose it
     *  too unless it is the thread's legacy service or the shared gateway
     *  client (which other threads may still use).
     */
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
        thread.eventEpoch += 1;
        thread.bindingEpoch += 1;

        const backend = this.backendFor(thread);
        const ownCallback = this.transcriptCallbacks.get(threadId);
        if (ownCallback) {
            this.transcriptCallbacks.delete(threadId);
            if (thread.sessionKey === ownCallback.sessionKey && backend instanceof GatewayChatService) {
                backend.removeTranscriptSink(thread.sessionKey, ownCallback.cb);
            }
        }
        this.suspendedTranscriptSinks.delete(threadId);
        this.deferredResumes.delete(threadId);
        if (backend instanceof GatewayChatService) {
            const shared = [...this.threads.values()].some(
                t => t.id !== threadId && t.sessionKey === thread.sessionKey && t.status === 'running'
            );
            if (thread.sessionKey && !shared && thread.status === 'running' && backend.hasOwnedRun(thread.sessionKey)) {
                backend.abort(thread.sessionKey);
            }
            if (thread.sessionKey &&
                ![...this.threads.values()].some(t => t.id !== threadId && t.sessionKey === thread.sessionKey)) {
                backend.clearSessionSink(thread.sessionKey);
            }
        } else {
            backend.abort();
        }
        thread.service.dispose();
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

    /**
     *  The awaited stat must not commit into a thread whose epoch
     *  moved on (cancel/clear/close) while resolution was pending:
     *  the caller's guard re-checked here prevents repopulating a
     *  reset thread with stale attachments.
     */
    /**
     *  Canonicalize the stored path so the read-time realpath
     *  re-verification compares against the true spelling: a
     *  case-insensitive volume cannot smuggle a swap whose target
     *  is only case-different at read time.
     */
    /**
     *  The realpath await is another suspension point: a
     *  cancel/clear that lands during it bumps the epoch and
     *  clears the thread, so the caller's guard must be re-checked
     *  before mutating the thread again.
     */
    /**
     *  A mention path was validated against the workspace boundary
     *  before this realpath ran; a symlink swap in between could
     *  make the canonicalization jump outside the workspace, so
     *  the boundary check is re-applied to the canonical target
     *  before the attachment is accepted.
     */
    /**
     *  The workspace-scope await is a further suspension point: a
     *  cancel/clear landing during it must stop this continuation
     *  before the attachment is appended.
     */
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
                if (options?.guard?.() === false) {
                    return;
                }
                const canonical = await fs.promises.realpath(filePath).catch(() => filePath);
                if (options?.guard?.() === false) {
                    return;
                }
                if (isMention && !(await this.isWorkspaceScoped(canonical))) {
                    continue;
                }
                if (options?.guard?.() === false) {
                    return;
                }
                const ext = path.extname(canonical).toLowerCase();
                thread.pendingAttachments.push({
                    name: path.basename(canonical),
                    path: canonical,
                    type: ChatViewProvider.IMAGE_EXTENSIONS.has(ext) ? 'image' : 'file',
                    ...(typeof item !== 'string' && item.lineStart
                        ? { lineStart: item.lineStart, lineEnd: item.lineEnd ?? item.lineStart }
                        : {}),
                });
                changed = true;
            } catch {
            }
        }

        if (changed) {
            this.emitState();
        }
    }

    /**
     *  The same busy/rebind guard handleSend applies: a stale webview
     *  slash-command message must not start a second run while another
     *  send or a session rebind is in flight, because the command would
     *  target the previous gateway key and its continuation could
     *  overwrite the newly opened conversation.
     */
    /**
     *  Same run-state marking as handleSend: a rebind (selectAgent/
     *  openSession) during the async resolution below retires only a
     *  `running` thread, and the send-epoch guard needs the bumped epoch
     *  a rebind performs, so an idle-marked command could otherwise slip
     *  a stale prompt into the newly selected session.
     */
    /**
     *  Slash commands resolve @mentions too: without this, `/review @src/a.ts#L5`
     *  silently omits the requested file attachment.
     */
    /**
     *  /compact summarizes prior turns: include the thread transcript so the
     *  fresh per-send exec (both transports) has the conversation to compress.
     */
    /**
     *  Cancel/clear ran while editor context and mentions resolved: the
     *  command must not be committed after cancellation was honoured.
     */
    /**
     *  Early in-flight marking must not strand the thread in a
     *  streaming state when resolution or prompt assembly throws.
     */
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
        if (thread.isStreaming) {
            return;
        }
        if (thread.openInFlightGen !== null) {
            log.info('handleSlashCommand: openSession in flight, command rejected');
            thread.status = 'error';
            this.emitState();
            return;
        }
        const sendEpoch = thread.eventEpoch;
        thread.isStreaming = true;
        thread.status = 'running';

        try {
        const context = await gatherEditorContext(cmd.contextType, (args) => this.runGit(args));
        const mentions = await this.resolveMentions(userText);
        if (mentions.length > 0) {
            await this.addAttachments(thread, mentions, { guard: () => thread.eventEpoch === sendEpoch });
        }
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

        if (thread.eventEpoch !== sendEpoch) {
            log.info(`handleSlashCommand: superseded during resolution, thread=${thread.id}`);
            return;
        }

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

        await this.sendPrompt(thread, fullPrompt, sendEpoch);
        } catch (err) {
            thread.isStreaming = false;
            thread.status = 'error';
            this.emitState();
            throw err;
        }
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

    /**
     *  Clear/Cancel may run while the dialog or the stat/realpath awaits
     *  inside addAttachments are pending: without the epoch guard the
     *  continuation would repopulate the reset thread's attachments.
     */
    private async handleAttach(thread: ChatThreadState): Promise<void> {
        const sendEpoch = thread.eventEpoch;
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: 'Attach',
            filters: { 'All Files': ['*'] }
        });
        if (!uris || uris.length === 0) {
            return;
        }
        await this.addAttachments(thread, uris.map(uri => uri.fsPath), { guard: () => thread.eventEpoch === sendEpoch });
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

    /**
     *  Mark in-flight before async attachment resolution: while file
     *  resolution is in flight a second send must see the thread busy,
     *  and cancel/clear during the awaits must not be undone by the
     *  continuation below (guarded by the send epoch check).
     */
    /**
     *  An openSession is rebinding this thread: the shared gateway
     *  session is already switched while the binding awaits
     *  persistence, so a send here would target the previous key and
     *  its callback would later deliver into the newly opened
     *  conversation. Fail the send instead of racing the rebind.
     */
    /**
     *  addAttachments stores the canonical realpath; compare
     *  against the canonical editor spelling so a symlinked
     *  or case-differing auto-attachment is not dropped.
     */
    /**
     *  Canonicalize mention paths before dedupe and attachment:
     *  addAttachments stores canonical realpaths, and the dedupe
     *  and mention-key comparisons below must use the same
     *  spelling or a symlinked/case-differing mention is lost.
     */
    /**
     *  Mention dedupe keys on (path + range); attach only pending
     *  entries whose range matches an accepted mention, not every
     *  attachment of the same file.
     */
    /**
     *  Cancel/clear ran during attachment resolution: the message
     *  must not be committed after cancellation was honoured.
     */
    /**
     *  The early in-flight marking must never strand the thread in a
     *  streaming state if attachment resolution throws.
     */
    private async handleSend(thread: ChatThreadState, text: string): Promise<void> {
        log.info(`handleSend: thread=${thread.id}, text="${text.slice(0, 80)}"`);
        if (thread.isStreaming) {
            return;
        }
        if (thread.openInFlightGen !== null) {
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
                    const canonicalAutoAttach = await fs.promises.realpath(autoAttachPath).catch(() => autoAttachPath);
                    pushNew(thread.pendingAttachments.filter(a => a.path === canonicalAutoAttach));
                }
            }

            const mentions = await this.resolveMentions(text);
            if (mentions.length > 0) {
                const canonicalMentions = await Promise.all(
                    mentions.map(m =>
                        fs.promises.realpath(m.path).then(p => ({ ...m, path: p })).catch(() => m)
                    )
                );
                await this.addAttachments(thread, canonicalMentions, { guard: () => thread.eventEpoch === sendEpoch });
                const mentionKeys = new Set(canonicalMentions.map(mentionKey));
                pushNew(thread.pendingAttachments.filter(a => mentionKeys.has(attachmentKey(a))));
            }

            if (thread.eventEpoch !== sendEpoch) {
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

            await this.sendPrompt(thread, fullPrompt, sendEpoch);
        } catch (err) {
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

    /**
     *  Connect the chat gateway transport right away (e.g. after saving a
     *  token) instead of waiting for the next send: resolving through the
     *  factory establishes the WebSocket and drives the transport status
     *  badge. Falls back to acpx silently when the gateway is unreachable.
     */
    async connectGatewayTransport(): Promise<void> {
        await this.resolveGateway();
    }

    /**
     *  A cancel/clear during attachment resolution or a superseding send
     *  bumps the epoch: this continuation must not resurrect the thread
     *  or route the stale prompt into a newer run.
     */
    /**
     *  The await above may take seconds (token lookup, connect probe).
     *  Cancel/Clear/Close may have run meanwhile: a deleted thread or one
     *  no longer running must not be resurrected by the continuation.
     */
    /**
     *  The rebind marker set during the resolve await means a
     *  selectAgent/openSession rebind has already switched the
     *  gateway active session and owns the binding: routing this
     *  send now would target the previous key and its callback
     *  would deliver into the newly opened conversation. Bail out;
     *  the rebind continuation finalizes the streaming state.
     */
    /**
     *  Rebinding the transport retires the previous backend: an old acpx
     *  process (whose callback has no epoch) or a stale gateway sink must
     *  not keep appending events into the new run, and cancel/close must
     *  reach whichever backend is actually live for the thread.
     */
    /**
     *  The gateway client is cached and shared across threads:
     *  never dispose it; abort only this thread's session so its
     *  in-flight run ends cleanly, and bump the epoch so callbacks
     *  captured by earlier runs drop their late events.
     */
    /**
     *  Epoch bump precedes abort: a disconnected gateway
     *  completes the old sink synchronously, and the sink's
     *  captured epoch must already be stale when it fires.
     */
    /**
     *  Same shared-run guard as cancel/reset: this thread may
     *  be only an idle subscriber on the shared session while
     *  another thread owns the live run — the Gateway→acpx
     *  fallback must not cancel that run. Its own in-flight
     *  gateway run cannot coexist with another running thread
     *  on the key (pre-send busy check), so skipping the abort
     *  here never leaves this thread's own run dangling.
     */
    /**
     *  An idle resumed thread with an externally owned live
     *  run (gateway or another client) has no local run sink:
     *  hasOwnedRun skips the abort in that case, while an
     *  in-flight run this thread started keeps its sink and
     *  is still cancelled cleanly.
     */
    /**
     *  Gateway→acpx fallback retires this thread's own gateway
     *  bindings: the persistent callback was captured with the
     *  pre-bump bindingEpoch (its events are epoch-dropped
     *  anyway) and a suspended entry would linger with no owner
     *  to restore it, stranding the thread without a persistent
     *  sink when it later returns to Gateway. Only this
     *  thread's bindings are retired — other threads' sinks on
     *  the shared key stay registered.
     */
    /**
     *  Bind a session key to the thread before every gateway send: an
     *  unbound thread must never read the shared gateway's mutable
     *  active session (another thread may have selected it) — it gets
     *  its own default session, so cross-thread leakage is impossible.
     *  Deliberate selections always go through handleSelectAgent/
     *  handleOpenSession, which set thread.sessionKey explicitly.
     */
    /**
     *  Explicitly prevent concurrent runs on one gateway session: two
     *  unbound threads would otherwise both land on the shared default
     *  session, and the second send would replace the first thread's
     *  run sink, rendering its response in the wrong thread.
     */
    /**
     *  A new run invalidates every sink captured by an earlier run on
     *  this thread: a late `done` from an aborted/rebound run must
     *  never commit stale pending text into the current run.
     */
    /**
     *  Non-gateway (acpx) sends capture the bumped run epoch below:
     *  handleChatEvent then validates acpx events per run, so events
     *  from a superseded acpx run cannot outlive its replacement.
     */
    /**
     *  A resumed thread's persistent transcript callback is still in
     *  the gateway's fan-out set; the per-run sink would deliver every
     *  live event twice to the same thread. Suspend it for the run and
     *  restore it when the run ends.
     */
    /**
     *  Acpx runs get the same per-run generation guard: bumping the
     *  epoch before capture invalidates the previous run's callback,
     *  so its asynchronous close cannot deliver a late done/text
     *  event into the new run after a transport switch.
     */
    /**
     *  The gateway resolved the send to a different session than
     *  requested: rebind the thread (and any suspended transcript
     *  callback) to the resolved key so later cancel/reset/close
     *  target the session the run actually lives under. Only
     *  rebind while the thread is still bound to the requested
     *  key — a mid-run agent switch owns the binding by then.
     */
    /**
     *  Binding mismatch: the thread was switched to another
     *  session mid-run, so the resolved run no longer belongs
     *  to it. Retire the run instead of letting its events
     *  flow through this thread's callback — output from the
     *  old session would otherwise appear in the newly
     *  selected conversation, and Cancel would target the
     *  wrong key.
     */
    /**
     *  The resolved key may host a run owned by another
     *  client or another thread (its pre-ack window counts
     *  as owned) even though this service has no local
     *  sink for it: gate the abort on local run ownership
     *  plus no other live thread on the key, and keep the
     *  sink cleanup separate.
     */
    /**
     *  The retired run's `done` is epoch-dropped above, so
     *  nothing else finalizes this send: without an explicit
     *  cleanup the thread stays `isStreaming`/`running`
     *  forever and the UI cannot send normally. Drop the
     *  stale pending text, clear the streaming state, and
     *  discard the suspended transcript sink captured for
     *  the requested key (the run never lived there).
     */
    private async sendPrompt(thread: ChatThreadState, fullPrompt: string, sendEpoch: number): Promise<void> {
        if (thread.eventEpoch !== sendEpoch) {
            return;
        }
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
        if (!this.threads.has(thread.id) ||
            thread.status !== 'running' ||
            thread.eventEpoch !== sendEpoch ||
            thread.openInFlightGen !== null) {
            if (thread.openInFlightGen !== null) {
                log.info('sendPrompt: openSession in flight after backend resolve, send retired');
                thread.isStreaming = false;
                thread.status = 'error';
                this.emitState();
            }
            if (choice.service !== thread.service &&
                !(choice.service instanceof GatewayChatService) &&
                thread.transportBackend !== choice.service) {
                choice.service.dispose();
            }
            return;
        }
        const previousBackend = thread.transportBackend;
        if (previousBackend && previousBackend !== choice.service && previousBackend !== thread.service) {
            if (previousBackend instanceof GatewayChatService) {
                if (thread.sessionKey) {
                    thread.eventEpoch += 1;
                    thread.bindingEpoch += 1;
                    const sharedRun = [...this.threads.values()].some(
                        t => t.id !== thread.id && t.sessionKey === thread.sessionKey && t.status === 'running'
                    );
                    if (!sharedRun && previousBackend.hasOwnedRun(thread.sessionKey)) {
                        previousBackend.abort(thread.sessionKey);
                    }
                    const ownCallback = this.transcriptCallbacks.get(thread.id);
                    if (ownCallback && ownCallback.sessionKey === thread.sessionKey) {
                        this.transcriptCallbacks.delete(thread.id);
                        previousBackend.removeTranscriptSink(thread.sessionKey, ownCallback.cb);
                    }
                    const suspendedOwn = this.suspendedTranscriptSinks.get(thread.id);
                    if (suspendedOwn && suspendedOwn.sessionKey === thread.sessionKey) {
                        this.suspendedTranscriptSinks.delete(thread.id);
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
            if (!thread.sessionKey) {
                thread.sessionKey = DEFAULT_SESSION_KEY;
            }
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
            thread.eventEpoch += 1;
            runEpoch = thread.eventEpoch;
            this.suspendThreadTranscriptSink(choice.service, thread);
        } else {
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
                if (thread.sessionKey !== requestedKey) {
                    thread.eventEpoch += 1;
                    if (choice.service instanceof GatewayChatService) {
                        const resolvedLiveOther =
                            [...this.threads.values()].some(
                                t => t.id !== thread.id && t.sessionKey === resolvedKey &&
                                    (t.isStreaming || t.status === 'running')
                            ) ||
                            [...this.suspendedTranscriptSinks].some(
                                ([threadId, suspended]) => threadId !== thread.id &&
                                    suspended.sessionKey === resolvedKey
                            );
                        if (choice.service.hasOwnedRun(resolvedKey) && !resolvedLiveOther) {
                            choice.service.abort(resolvedKey);
                        }
                        if (![...this.threads.values()].some(t => t.id !== thread.id && t.sessionKey === resolvedKey)) {
                            choice.service.clearSessionSink(resolvedKey);
                        }
                    }
                    thread.pendingAssistantText = '';
                    thread.isStreaming = false;
                    if (thread.status === 'running') {
                        thread.status = 'idle';
                    }
                    const retiredSuspend = this.suspendedTranscriptSinks.get(thread.id);
                    if (retiredSuspend && retiredSuspend.sessionKey === requestedKey) {
                        this.suspendedTranscriptSinks.delete(thread.id);
                    }
                    this.emitState();
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

    /** Resume bindings deferred because a send started before the automatic
     *  resume finished: the persistent transcript sink is registered only
     *  after that run finalizes, so live delivery is never double-wired. */
    private deferredResumes = new Map<string, { sessionKey: string; historyRendered?: boolean }>();

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

    /** Register a resume binding deferred because a send was already in
     *  flight when the automatic resume reached its subscription step. */
    /**
     *  Transport temporarily unavailable: retain the deferred entry
     *  so a later flush (the next run's done) can still bind the
     *  resume sink; deleting it here would strand the thread without
     *  transcript events for the resumed session.
     */
    /**
     *  Re-check after the await: a send started while the gateway resolved
     *  owns the thread now, and registering the persistent transcript sink
     *  alongside that run sink would deliver every event twice (duplicated
     *  assistant text/tool rows). Retain the deferred entry so the run's
     *  `done` re-flushes the resume binding afterwards. (The status is
     *  re-read widened: the pre-await check narrowed the union for TS.)
     */
    /** Serialized chat-event processing per thread (see handleChatEvent). */
    private chatEventQueueByThread = new Map<string, Promise<void>>();

    private async flushDeferredResume(thread: ChatThreadState): Promise<void> {
        const deferred = this.deferredResumes.get(thread.id);
        if (!deferred || thread.isStreaming || thread.status === 'running') {
            return;
        }
        this.deferredResumes.delete(thread.id);
        if (thread.sessionKey !== deferred.sessionKey) {
            return;
        }
        const gateway = await this.resolveGateway();
        if (!gateway) {
            if (this.threads.has(thread.id) && thread.sessionKey === deferred.sessionKey) {
                this.deferredResumes.set(thread.id, deferred);
            }
            return;
        }
        const resumedStatus: string = thread.status;
        if (!this.threads.has(thread.id) || thread.isStreaming || resumedStatus === 'running') {
            this.deferredResumes.set(thread.id, deferred);
            return;
        }
        if (thread.sessionKey !== deferred.sessionKey) {
            return;
        }
        this.resumeSessionForThread(gateway, thread, deferred.sessionKey, deferred.historyRendered === true);
        this.emitState();
    }

    private resolveServiceForSend(existing?: ChatService | GatewayChatService): Promise<{ service: ChatService | GatewayChatService; transport: 'gateway' | 'acpx' }> {
        return this.chatServiceFactory.resolve(existing);
    }

    /**
     *  A sink captured by an earlier run (aborted then rebound) is stale:
     *  its late events belong to the previous session, not this thread.
     *  Persistent resume sinks validate against `bindingEpoch` (bumped only
     *  on rebind/reset/close), while per-run run-sinks use `eventEpoch`
     *  (bumped before every gateway send).
     */
    /**
     *  Re-check after the await: a new run started during
     *  markdown rendering bumps the epoch and owns the thread's
     *  pending text; this stale continuation must not commit.
     */
    /**
     *  A `done` emitted by abort() or a teardown path must not
     *  upgrade a cancelled/idle thread to complete.
     */
    private async handleChatEvent(threadId: string, event: ChatEvent, eventEpoch?: number, epochScope: 'run' | 'binding' = 'run'): Promise<void> {
        const thread = this.threads.get(threadId);
        if (!thread) {
            log.warn(`handleChatEvent: thread ${threadId} not found`);
            return;
        }
        // Serialize per thread: a `done` awaits markdown rendering, so a
        // synchronously following `text` (e.g. replayed history rows) would
        // otherwise be appended to the not-yet-committed pending text and
        // coalesce two assistant rows into one message — and a second `done`
        // could restore/retire a live sink before the first render commits.
        const prev = this.chatEventQueueByThread.get(threadId);
        const queued = (prev ?? Promise.resolve()).catch(() => undefined).then(() =>
            this.processChatEvent(threadId, event, eventEpoch, epochScope)
        );
        this.chatEventQueueByThread.set(threadId, queued);
        void queued.finally(() => {
            if (this.chatEventQueueByThread.get(threadId) === queued) {
                this.chatEventQueueByThread.delete(threadId);
            }
        });
        await queued;
    }

    private async processChatEvent(threadId: string, event: ChatEvent, eventEpoch?: number, epochScope: 'run' | 'binding' = 'run'): Promise<void> {
        const thread = this.threads.get(threadId);
        if (!thread) {
            return;
        }
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
                    if (thread.eventEpoch !== commitEpoch) {
                        log.info(`handleChatEvent: dropping stale done after render (epoch ${commitEpoch} -> ${thread.eventEpoch}), thread=${threadId}`);
                        return;
                    }
                    thread.messages.push({ role: 'assistant', content: raw, html });
                }
                thread.isStreaming = false;
                if (thread.status !== 'error' && thread.status !== 'cancelled' && thread.status !== 'idle') {
                    thread.status = 'complete';
                }
                this.restoreSuspendedTranscriptSink(thread);
                this.updateThreadSubjectFromContext(thread);
                this.emitState();
                void this.flushDeferredResume(thread);
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
                void this.flushDeferredResume(thread);
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

    /**
     *  Command-palette agent picker bound to the active chat.
     *  Route through the open flow, not just key binding: unlike the
     *  webview session flow, the palette selection must fetch history
     *  and register the transcript resume sink, or the thread keeps
     *  showing the previous conversation and receives no events.
     */
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
            this.allowlistGatewayId = gateway.getGatewayIdentity();
            this.knownMainSessionKeys = new Set(
                buildAgentSessionItems(payload).map(item => item.sessionKey)
            );
            postToAll([this.sidebarView?.webview, this.popOutPanel?.webview, this.debugPanel?.webview], {
                type: forPicker ? 'agentsList' : 'sessionsList',
                sessions: buildAgentSessionItems(payload),
            });
        } catch (err) {
            log.warn('sessions.list failed', err);
        }
    }

    /** Whether the webview-supplied main-session key is in the last
     *  sessions.list allowlist. A stale/empty allowlist refreshes once from
     *  the gateway first: the restart-resume path binds a key the webview
     *  has not listed yet, and a failed initial list must not permanently
     *  reject every later legitimate selection. Fail-closed on refresh
     *  errors: an unverifiable key is treated as unknown. A gateway
     *  identity (URL/token) change clears the list first: keys learned
     *  from the previous gateway are not valid for the new one, and the
     *  identity check runs before the size check so a stale non-empty
     *  list still triggers a fresh sessions.list. */
    private async isKnownMainSessionKey(gateway: GatewayChatService, sessionKey: string): Promise<boolean> {
        const gatewayId = gateway.getGatewayIdentity();
        if (this.allowlistGatewayId !== gatewayId) {
            this.allowlistGatewayId = null;
            this.knownMainSessionKeys = new Set<string>();
        }
        if (this.knownMainSessionKeys.has(sessionKey)) {
            return true;
        }
        if (this.knownMainSessionKeys.size === 0) {
            try {
                const payload = await gateway.listSessions({});
                this.allowlistGatewayId = gatewayId;
                this.knownMainSessionKeys = new Set(
                    buildAgentSessionItems(payload).map(item => item.sessionKey)
                );
            } catch (err) {
                log.warn('session allowlist refresh failed', err);
            }
        }
        return this.knownMainSessionKeys.has(sessionKey);
    }

    /**
     *  Bind the chosen agent session key to the active chat and persist it.
     *  Release the send-rejection marker only now that the full rebind
     *  (persist, retire/abort, key assignment, history, resume) has
     *  settled; any early return above leaves it owned, blocking sends
     *  that would otherwise race the rebind window.
     */
    private async handleSelectAgent(sessionKey: string): Promise<void> {
        const selectGen = ++this.selectGeneration;
        const pendingOpenThread = this.getActiveThread();
        if (pendingOpenThread) {
            pendingOpenThread.openGeneration += 1;
            pendingOpenThread.openInFlightGen = pendingOpenThread.openGeneration;
        }
        const selectionGen = pendingOpenThread ? pendingOpenThread.openGeneration : null;
        let gateway: GatewayChatService | null = null;
        try {
            gateway = await this.resolveGateway();
        } catch (err) {
            log.warn('selectAgent: gateway resolution failed', err);
            if (pendingOpenThread &&
                pendingOpenThread.openInFlightGen === selectionGen) {
                pendingOpenThread.openInFlightGen = null;
            }
            return;
        }
        if (!gateway) {
            if (pendingOpenThread &&
                pendingOpenThread.openInFlightGen === selectionGen) {
                pendingOpenThread.openInFlightGen = null;
            }
            return;
        }
        if (!(await this.isKnownMainSessionKey(gateway, sessionKey))) {
            log.warn('selectAgent: rejected unknown session key', sessionKey);
            if (pendingOpenThread &&
                pendingOpenThread.openInFlightGen === selectionGen) {
                pendingOpenThread.openInFlightGen = null;
            }
            return;
        }
        try {
            await this.persistLastSessionKey(sessionKey);
        if (this.selectGeneration !== selectGen) {
            return;
        }
        const activeThread = pendingOpenThread;
        if (!activeThread || this.getActiveThread()?.id !== activeThread.id) {
            return;
        }
        if (selectionGen !== null && activeThread.openGeneration !== selectionGen) {
            return;
        }
        // Switch the shared gateway session only after the ownership/generation
        // checks above: mutating `activeSessionKey` before them lets a stale
        // continuation overwrite the key a newer selection already installed
        // while this request was awaiting gateway resolution, so fallback
        // sends in that window would target a stale session. The in-flight
        // marker blocks sends during the rebind window, so this late switch
        // cannot strand a send on the previous key; the finally block below
        // releases the marker when this request still owns it.
        gateway.setActiveSession(sessionKey);
        const reboundFrom = activeThread.sessionKey && activeThread.sessionKey !== sessionKey
            ? activeThread.sessionKey
            : null;
        if (activeThread) {
            const previousBackend = this.backendFor(activeThread);
            if (activeThread.status === 'running' && !(previousBackend instanceof GatewayChatService)) {
                activeThread.eventEpoch += 1;
                activeThread.bindingEpoch += 1;
                previousBackend.abort();
                activeThread.pendingAssistantText = '';
                activeThread.isStreaming = false;
                activeThread.status = 'idle';
            }
            if (reboundFrom) {
                const previousKey = reboundFrom;
                const ownCallback = this.transcriptCallbacks.get(activeThread.id);
                if (ownCallback && ownCallback.sessionKey === previousKey) {
                    this.transcriptCallbacks.delete(activeThread.id);
                    gateway.removeTranscriptSink(previousKey, ownCallback.cb);
                }
                const suspendedSink = this.suspendedTranscriptSinks.get(activeThread.id);
                if (suspendedSink && suspendedSink.sessionKey === previousKey) {
                    this.suspendedTranscriptSinks.delete(activeThread.id);
                }
                const sharesLiveRun = [...this.threads.values()].some(
                    t => t.id !== activeThread.id && t.sessionKey === previousKey && t.status === 'running'
                );
                activeThread.eventEpoch += 1;
                activeThread.bindingEpoch += 1;
                if (!sharesLiveRun && previousBackend instanceof GatewayChatService) {
                    if (activeThread.status === 'running' && gateway.hasOwnedRun(previousKey)) {
                        gateway.abort(previousKey);
                    }
                    if (!this.otherThreadsOnKey(activeThread.id, previousKey)) {
                        gateway.clearSessionSink(previousKey);
                    }
                }
                activeThread.isStreaming = false;
                activeThread.pendingAssistantText = '';
                activeThread.status = 'idle';
            }
            activeThread.sessionKey = sessionKey;
            activeThread.transportBackend = gateway;
        }
        postToAll([this.sidebarView?.webview, this.popOutPanel?.webview, this.debugPanel?.webview], {
            type: 'agentSelected',
            sessionKey,
        });
        if (activeThread) {
            if (!(activeThread.isStreaming || activeThread.status === 'running')) {
                const historyEpoch = activeThread.eventEpoch;
                const history = await gateway.getHistory(sessionKey);
                if (this.getActiveThread()?.id === activeThread.id && activeThread.sessionKey === sessionKey &&
                    activeThread.eventEpoch === historyEpoch && !activeThread.isStreaming &&
                    (selectionGen === null || activeThread.openGeneration === selectionGen)) {
                    if (history !== null) {
                        gateway.seedHistory(sessionKey, history);
                        activeThread.messages = mapHistoryMessages(history)
                            .map(msg => ({ role: msg.role, content: msg.content }));
                        activeThread.status = 'idle';
                    } else {
                        activeThread.messages = [];
                        activeThread.messages.push({
                            role: 'assistant',
                            content: 'Failed to load session history. Reopen the session to retry.'
                        });
                        activeThread.status = 'error';
                    }
                    this.resumeSessionForThread(gateway, activeThread, sessionKey, history !== null);
                }
            } else if (reboundFrom) {
                this.resumeSessionForThread(gateway, activeThread, sessionKey, false);
            }
        }
        this.emitState();
        } finally {
            if (pendingOpenThread && pendingOpenThread.openInFlightGen === selectionGen) {
                pendingOpenThread.openInFlightGen = null;
            }
        }
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
    /**
     *  Open-generation marker for this request: a newer openSession on the
     *  same thread bumps the counter, so this continuation can detect it
     *  after every await (the session key alone cannot — it still holds
     *  the previous key until this request assigns the new one).
     *  Captured BEFORE the gateway resolve await: two open requests can
     *  resolve out of order, and a bump after the await lets the older
     *  request claim the newer generation and overwrite the newer
     *  session/history.
     */
    /**
     *  Send-rejection marker: the shared gateway session is switched below
     *  before the thread is rebound, and the rebinding awaits persistence,
     *  so a send accepted in that window would target the previous key and
     *  its callback would later deliver into the newly opened session.
     *  Cleared only while this open still owns the marker (a newer open
     *  supersedes it and owns the marker from then on).
     */
    /**
     *  Same rejection guard as handleSelectAgent: a failed gateway
     *  resolution here must release this open's marker via the
     *  ownership check, or later sends stay refused forever.
     */
    /**
     *  Same webview-origin allowlist as handleSelectAgent: a crafted key
     *  for an unlisted agent must not reach history loading or the rebind.
     */
    /**
     *  Re-check after the resolve await: a thread switch while the gateway
     *  resolved must not apply this open to the previously active thread.
     */
    private async handleOpenSession(sessionKey: string): Promise<void> {
        const thread = this.getActiveThread();
        if (!thread) {
            return;
        }
        const openGen = ++thread.openGeneration;
        thread.openInFlightGen = openGen;
        let gateway: GatewayChatService | null = null;
        try {
            gateway = await this.resolveGateway();
        } catch (err) {
            log.warn('openSession: gateway resolution failed', err);
            if (thread.openInFlightGen === openGen) {
                thread.openInFlightGen = null;
            }
            return;
        }
        if (!gateway) {
            if (thread.openInFlightGen === openGen) {
                thread.openInFlightGen = null;
            }
            return;
        }
        if (!(await this.isKnownMainSessionKey(gateway, sessionKey))) {
            log.warn('openSession: rejected unknown session key', sessionKey);
            if (thread.openInFlightGen === openGen) {
                thread.openInFlightGen = null;
            }
            return;
        }
        if (this.getActiveThread()?.id !== thread.id) {
            if (thread.openInFlightGen === openGen) {
                thread.openInFlightGen = null;
            }
            return;
        }
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
    /**
     *  reboundFrom keeps the previous gateway key when one existed; the
     *  history-failure branch below must treat ANY binding change as a
     *  rebind — including undefined → new key (an acpx thread opening a
     *  gateway session): a failed history fetch must not keep the old
     *  (acpx) transcript displayed under the newly bound session.
     */
    /**
     *  Same acpx guard as handleSelectAgent: a streaming run without a
     *  gateway session key (or on an acpx fallback backend) must be
     *  retired before rebinding, or its late output lands in the newly
     *  opened transcript.
     */
    /**
     *  Aborting an acpx-backed run leaves no `done` completion that
     *  clears streaming state, and the later history restore only
     *  sets `status` to idle: without clearing here, `isStreaming`
     *  stays true and every subsequent send is rejected at the busy
     *  check, permanently bricking the thread.
     */
    /**
     *  A null history response (e.g. gateway unavailable) leaves the
     *  `history !== null` branch unreached: the status must already
     *  be idle here, or a sessionless rebind strands the thread in
     *  `running` and future sends are rejected as busy.
     */
    /**
     *  Retire any run still active on the previous session before
     *  rebinding: late events from the old run would otherwise be
     *  appended to the newly opened transcript. The old transcript
     *  sink is dropped too, so events for the previous key cannot
     *  reach the rebound thread.
     *  Hoisted so the abandoned-rebind restore closure below can reach the
     *  previous binding even though the teardown block declares them inside
     *  its own scope.
     */
    /**
     *  Same shared-session guard as handleSelectAgent: only tear down
     *  the previous session when no other thread still *runs* on it;
     *  an idle resumed subscriber must not keep this thread's run
     *  alive, and a live run on the same key is not ours to cancel.
     *  The suspended entry (if the retired run had one) must go too:
     *  a later restore would otherwise rebind the old session's
     *  callback to this thread and deliver cross-session events.
     */
    /**
     *  Epoch bump precedes abort in both cases: the aborted run's
     *  async completion must not reach the rebound thread.
     */
    /**
     *  Same backend-type guard as handleSelectAgent: only a
     *  gateway-backed run may abort the previous gateway session; an
     *  acpx fallback run (retired above) must not cancel whatever
     *  other owner still runs on the stale binding key.
     */
    /**
     *  Abort only when this thread owns the live run on the
     *  previous key: an idle subscriber merely switching away
     *  must not cancel a run owned by another client. Late events
     *  from an unowned run cannot reach the rebound thread — the
     *  epoch bumped above and the sink is cleared below. The
     *  hasOwnedRun gate also covers the pre-ack window before
     *  the run sink exists.
     */
    /**
     *  Same guard as handleSelectAgent: idle resumed
     *  subscribers on the previous session keep their sink.
     */
    /**
     *  Restores the previous binding when this rebind is abandoned after
     *  the teardown above but before the commit: switching panes or a
     *  superseding open must not leave the thread bound to previousKey
     *  with its transcript sink cleared and its callback epoch stale.
     */
    /**
     *  A rejected persistence write (e.g. unavailable workspace state)
     *  must not skip the abandonment checks below: the teardown above
     *  already cleared the previous session's sinks, so leaving the thread
     *  keyed to the old session with a lost sink while the gateway points
     *  at the new one strands the conversation. Restore the previous
     *  binding, surface the failure, and keep the thread usable instead of
     *  propagating the rejection past the generation guards.
     */
    /**
     *  A newer openSession request superseded this one while the
     *  persist/await above was in flight: never clobber the newer
     *  selection. Do not persist anything here either — `thread.sessionKey`
     *  is still the previous binding (the newer request assigns its key
     *  only after its own generation check), so persisting it would
     *  overwrite the newer request's resume key. The current-generation
     *  request owns persistence.
     */
    /**
     *  Reopening the session this thread is already bound to while a run
     *  is in flight must not replace the transcript or reset status: the
     *  unconditional restore would drop the live response. This guard
     *  must run BEFORE the listSessions/cold-session branch below — that
     *  branch clears the transcript and marks the thread idle without
     *  aborting or retiring the run, and resumeSessionForThread would
     *  register a persistent sink alongside the live run sink, causing
     *  duplicate delivery and inconsistent lifecycle state. The thread
     *  keeps its registered transcript callback, so nothing to rebind.
     */
    /**
     *  A cold session has no transcript: drop any previous
     *  thread content and stale run state before showing
     *  its placeholder.
     */
    /**
     *  The cold branch returns before the final agentSelected
     *  post below; the webview only dismisses the sessions
     *  panel on that message, so it must fire here too.
     */
    /**
     *  A successful fetch replaces the transcript unconditionally (empty
     *  history clears the prior session's messages); a failed fetch keeps
     *  the current transcript rather than wiping it on transport errors.
     */
    /**
     *  Seed the gateway's delta cursor and messageId dedupe set from
     *  the restored transcript so resumeSession's catch-up does not
     *  replay the history we just rendered (or leave the thread
     *  streaming).
     */
    /**
     *  A failed fetch after a session switch must not keep the
     *  previous session's transcript under the new key: the resume
     *  sink below would show the old transcript as the new session
     *  and append new-session events to it. Clear it and surface an
     *  explicit load error instead (a same-key reopen keeps its
     *  transcript on transport errors by design).
     */
    /**
     *  Dismiss the sessions panel in every webview surface: opening a
     *  row is a selection, so the panel must close the same way it does
     *  for selectAgent.
     */
    private async openSessionRebinding(
        thread: ChatThreadState,
        sessionKey: string,
        gateway: GatewayChatService,
        openGen: number
    ): Promise<void> {
        const rebounded = thread.sessionKey !== sessionKey;
        const previousBackend = this.backendFor(thread);
        if (thread.status === 'running' && !(previousBackend instanceof GatewayChatService)) {
            thread.eventEpoch += 1;
            thread.bindingEpoch += 1;
            previousBackend.abort();
            thread.isStreaming = false;
            thread.pendingAssistantText = '';
            thread.status = 'idle';
        }
        let abandonedPreviousKey: string | null = null;
        let abandonedSuspendedSink: { gateway: GatewayChatService; sessionKey: string } | null = null;
        if (thread.sessionKey && thread.sessionKey !== sessionKey) {
            const previousKey = thread.sessionKey;
            abandonedPreviousKey = previousKey;
            const suspendedSink = this.suspendedTranscriptSinks.get(thread.id);
            abandonedSuspendedSink = suspendedSink ?? null;
            if (suspendedSink && suspendedSink.sessionKey === previousKey) {
                this.suspendedTranscriptSinks.delete(thread.id);
            }
            const sharesLiveRun = [...this.threads.values()].some(
                t => t.id !== thread.id && t.sessionKey === previousKey && t.status === 'running'
            );
            thread.eventEpoch += 1;
            thread.bindingEpoch += 1;
            if (previousBackend instanceof GatewayChatService) {
                if (thread.status === 'running' && !sharesLiveRun && gateway.hasOwnedRun(previousKey)) {
                    gateway.abort(previousKey);
                }
                if (!this.otherThreadsOnKey(thread.id, previousKey)) {
                    gateway.clearSessionSink(previousKey);
                }
            }
            thread.isStreaming = false;
            thread.pendingAssistantText = '';
            thread.status = 'idle';
        }
        const restoreAbandonedRebind = (): void => {
            if (!abandonedPreviousKey) {
                return;
            }
            if (abandonedSuspendedSink) {
                this.suspendedTranscriptSinks.set(thread.id, abandonedSuspendedSink);
                this.restoreSuspendedTranscriptSink(thread);
                return;
            }
            const persistent = this.transcriptCallbacks.get(thread.id);
            const gatewayBackend = this.backendFor(thread);
            if (!persistent || persistent.sessionKey !== abandonedPreviousKey ||
                !(gatewayBackend instanceof GatewayChatService)) {
                return;
            }
            this.transcriptCallbacks.delete(thread.id);
            gatewayBackend.removeTranscriptSink(persistent.sessionKey, persistent.cb);
            const rebindEpoch = thread.bindingEpoch;
            const cb = (event: ChatEvent): void => { void this.handleChatEvent(thread.id, event, rebindEpoch, 'binding'); };
            this.transcriptCallbacks.set(thread.id, { sessionKey: persistent.sessionKey, cb });
            gatewayBackend.rebindTranscriptSink(persistent.sessionKey, cb);
        };
        try {
            await this.persistLastSessionKey(sessionKey);
        } catch (err) {
            log.warn('openSessionRebinding: failed to persist last session key', err);
            restoreAbandonedRebind();
            if (this.getActiveThread()?.id === thread.id && thread.openGeneration === openGen) {
                thread.messages.push({
                    role: 'error',
                    content: 'Failed to persist the last session. Reopen the session to retry.'
                });
                this.emitState();
            }
            return;
        }
        if (this.getActiveThread()?.id !== thread.id) {
            restoreAbandonedRebind();
            return;
        }
        if (thread.openGeneration !== openGen) {
            restoreAbandonedRebind();
            return;
        }
        // Switch the shared gateway session only after the active-thread and
        // open-generation checks above: mutating `activeSessionKey` before
        // them lets a stale rebinding overwrite the key a newer open already
        // installed while this request was awaiting persistence, so fallback
        // sends between bindings would target the wrong conversation. The
        // in-flight marker blocks sends during the rebind window, so this
        // late switch cannot strand a send on the previous key; the stale
        // paths above never touched the shared key, so no restore is needed.
        gateway.setActiveSession(sessionKey);
        thread.sessionKey = sessionKey;

        if (thread.sessionKey === sessionKey && (thread.isStreaming || thread.status === 'running')) {
            return;
        }

        let label = sessionKey;
        try {
            const payload = await gateway.listSessions({});
            if (this.getActiveThread()?.id !== thread.id || thread.sessionKey !== sessionKey ||
                thread.openGeneration !== openGen) {
                return;
            }
            const rows = parseSessionRows(payload).rows as SessionRow[];
            const row = rows.find(r => r.key === sessionKey);
            if (row) {
                label = row.label || row.agentId || sessionKey;
                if (isColdSession(row)) {
                    thread.messages = [];
                    thread.status = 'idle';
                    thread.messages.push({ role: 'assistant', content: COLD_SESSION_PLACEHOLDER });
                    thread.title = label;
                    this.emitState();
                    postToAll([this.sidebarView?.webview, this.popOutPanel?.webview, this.debugPanel?.webview], {
                        type: 'agentSelected',
                        sessionKey,
                    });
                    this.bindGatewayTransportIfIdle(thread, gateway);
                    this.resumeSessionForThread(gateway, thread, sessionKey, false);
                    return;
                }
            }
        } catch (err) {
            log.warn('sessions.list during open failed', err);
        }

        const historyEpoch = thread.eventEpoch;
        const history = await gateway.getHistory(sessionKey);
        if (this.getActiveThread()?.id !== thread.id || thread.sessionKey !== sessionKey ||
            thread.eventEpoch !== historyEpoch || thread.openGeneration !== openGen) {
            return;
        }
        this.bindGatewayTransportIfIdle(thread, gateway);
        if (history !== null) {
            const restored = mapHistoryMessages(history);
            gateway.seedHistory(sessionKey, history);
            thread.title = label;
            thread.messages = [];
            for (const msg of restored) {
                thread.messages.push({ role: msg.role, content: msg.content });
            }
            thread.status = 'idle';
        } else if (rebounded) {
            thread.messages = [];
            thread.messages.push({
                role: 'assistant',
                content: 'Failed to load session history. Reopen the session to retry.'
            });
            thread.title = label;
            thread.status = 'error';
        }
        postToAll([this.sidebarView?.webview, this.popOutPanel?.webview, this.debugPanel?.webview], {
            type: 'agentSelected',
            sessionKey,
        });
        this.resumeSessionForThread(gateway, thread, sessionKey, history !== null);
        this.emitState();
    }

    /** Bind the gateway transport for a thread only when no send owns it:
     *  a send that started during the open's list/history awaits resolves
     *  and binds its own backend (the acpx fallback included), and
     *  overwriting it here would leave Cancel/Clear aborting the gateway
     *  reference while that acpx process keeps running. */
    private bindGatewayTransportIfIdle(thread: ChatThreadState, gateway: GatewayChatService): void {
        if (!thread.isStreaming && thread.status !== 'running') {
            thread.transportBackend = gateway;
        }
    }

    /** Resume a session for a thread, replacing any previous transcript
     *  callback for that session so reopen cannot deliver events twice.
     *  historyRendered marks a resume whose `chat.history` payload was
     *  rendered into the thread and seeded into the gateway: the unscoped
     *  tail catch-up must stay off there, or keyless assistant rows get
     *  appended a second time (null-history resumes keep it). */
    /**
     *  Track callbacks per thread: opening/resuming the same session in a
     *  second thread must not evict this thread's callback from the
     *  gateway's fan-out sink set.
     */
    private resumeSessionForThread(
        gateway: GatewayChatService,
        thread: ChatThreadState,
        sessionKey: string,
        historyRendered: boolean,
    ): void {
        const prior = this.transcriptCallbacks.get(thread.id);
        if (prior) {
            gateway.removeTranscriptSink(prior.sessionKey, prior.cb);
        }
        const resumeEpoch = thread.bindingEpoch;
        const cb = (event: ChatEvent): void => { void this.handleChatEvent(thread.id, event, resumeEpoch, 'binding'); };
        this.transcriptCallbacks.set(thread.id, { sessionKey, cb });
        gateway.resumeSession(sessionKey, cb, { historyRendered });
    }

    /** Persist the last selected session key for window-restart resume.
     *
     *  handleSelectAgent and handleOpenSession can overlap, so the durable
     *  write is serialized through a single chain and each write commits
     *  only if no newer persist was requested while it waited: an older
     *  selection's late write must not overwrite a newer selection's key,
     *  which the in-memory generation checks would then reject while the
     *  stale key still resumes after a restart. */
    private async persistLastSessionKey(sessionKey: string): Promise<void> {
        const gen = ++this.persistGeneration;
        this.lastSessionKey = sessionKey;
        const write = this.persistLastSessionKeyWrite.then(async () => {
            if (gen !== this.persistGeneration) {
                return;
            }
            await this.context.workspaceState.update(ChatViewProvider.LAST_SESSION_KEY, sessionKey);
        });
        this.persistLastSessionKeyWrite = write.catch(() => undefined);
        await write;
    }

    /**
     *  Resume the persisted session after a window restart (catch-up).
     *  Seed cursor/message dedupe from the restored transcript so
     *  the resume catch-up below does not replay this history.
     */
    private async resumeLastSession(): Promise<void> {
        const sessionKey = this.context.workspaceState.get<string>(ChatViewProvider.LAST_SESSION_KEY);
        if (!sessionKey) {
            return;
        }
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
        if (!(await this.isKnownMainSessionKey(gateway, sessionKey))) {
            log.warn(`resumeLastSession: rejected unknown persisted session key: ${sessionKey}`);
            this.lastSessionKey = null;
            await this.context.workspaceState.update(ChatViewProvider.LAST_SESSION_KEY, undefined);
            return;
        }
        gateway.setActiveSession(sessionKey);
        const thread = this.getActiveThread();
        if (thread) {
            thread.sessionKey = sessionKey;
            const resumeEventEpoch = thread.eventEpoch;
            const resumeBindingEpoch = thread.bindingEpoch;
            const resumeOpenGen = thread.openGeneration;
            thread.transportBackend = gateway;
            let history: unknown = null;
            try {
                history = await gateway.getHistory(sessionKey);
                if (this.getActiveThread()?.id !== thread.id || this.lastSessionKey !== sessionKey ||
                    thread.eventEpoch !== resumeEventEpoch || thread.bindingEpoch !== resumeBindingEpoch ||
                    thread.openGeneration !== resumeOpenGen || thread.sessionKey !== sessionKey ||
                    thread.isStreaming || thread.status === 'running') {
                    if (thread.isStreaming || thread.status === 'running') {
                        gateway.seedHistory(sessionKey, history);
                        this.deferredResumes.set(thread.id, { sessionKey, historyRendered: false });
                    }
                    return;
                }
                if (history !== null) {
                    thread.messages = mapHistoryMessages(history).map((msg) => ({ role: msg.role, content: msg.content }));
                }
                thread.status = 'idle';
                gateway.seedHistory(sessionKey, history);
            } catch (err) {
                log.warn('history restore during resume failed', err);
            }
            this.resumeSessionForThread(gateway, thread, sessionKey, history !== null);
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
    /**
     *  Resolve all mention targets concurrently; each is independent fs I/O
     *  and a slow disk should not multiply per-mention send latency.
     */
    /**
     *  Store the canonical path: a symlink could be swapped between
     *  this check and the later read, so reading the original path
     *  would bypass the workspace guard (TOCTOU).
     */
    private async resolveMentions(text: string): Promise<FileMention[]> {
        const cwd = this.getWorkspaceCwd();
        if (!cwd) {
            return [];
        }
        const realCwd = await fs.promises.realpath(cwd).catch(() => cwd);
        const candidates = parseFileMentions(text)
            .map(mention => ({ ...mention, path: path.isAbsolute(mention.path) ? mention.path : path.join(cwd, mention.path) }))
            .map(mention => ({ ...mention, path: path.resolve(mention.path) }));
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
                accepted.push({ ...candidates[i], path: real });
            }
        }
        return accepted;
    }

    /** Whether a canonical absolute path sits inside the workspace root.
     *  Callers must pass an already-canonical path: resolving symlinks is
     *  part of the boundary check, not left to the caller. */
    private async isWorkspaceScoped(canonical: string): Promise<boolean> {
        const cwd = this.getWorkspaceCwd();
        if (!cwd) {
            return false;
        }
        const realCwd = await fs.promises.realpath(cwd).catch(() => cwd);
        const rel = path.relative(realCwd, canonical);
        return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
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
