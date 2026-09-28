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
    ATTACHMENT_ARGV_FRAMING_RESERVE_BYTES,
    ATTACHMENT_PROMPT_FRAMING_RESERVE_BYTES,
    renderMarkdown,
    type Attachment,
    type ChatMessage,
    type ChatThreadState,
} from './viewMessaging';
import { buildRecommendations } from './recommendations';
import { parseFileMentions, buildMention, type FileMention } from './fileMentions';
import { ChatServiceFactory, type GatewayInvalidationReason } from './chatServiceFactory';
import { GatewayChatService, DEFAULT_SESSION_KEY } from '../core/gatewayChatService';
import {
    AgentPicker,
    COLD_SESSION_PLACEHOLDER,
    buildAgentSessionItems,
    isColdSession,
    isMainAgentSessionKey,
    mapHistoryMessages,
    parseSessionRows,
    type AgentSessionItem,
} from '../core/agentPicker';
import type { SessionRow } from '../core/contract';

export type { Recommendation } from './recommendations';

type InboundMessage = { type?: unknown; [field: string]: unknown };

const SESSIONS_GATEWAY_UNAVAILABLE = 'Gateway not connected';
const SESSIONS_LIST_FAILED = 'Could not load sessions';

const INTERRUPTED_RUN_MESSAGES: Record<GatewayInvalidationReason, string> = {
    identity: 'Gateway connection (URL or token) changed. The active run was interrupted; send the message again.',
    transport: 'The chat transport changed. The active run was interrupted; send the message again.',
};

const TERMINAL_TOOL_STATUSES = new Set(['done', 'error', 'failed', 'cancelled']);

const THINKING_LEVELS = new Set(['none', 'low', 'medium', 'high']);

/** The `openclaw.chat.dimension` enum from package.json. */
const GRID_DIMENSIONS = new Set(['1x1', '2x2', '2x3', '3x3', '4x4']);

const SETTING_VALIDATORS: Record<string, (value: unknown) => boolean> = {
    'chat.thinkingLevel': value => typeof value === 'string' && THINKING_LEVELS.has(value),
    'chat.temperature': value => typeof value === 'number' && value >= 0 && value <= 2,
    'chat.maxTokens': value => Number.isInteger(value) && (value as number) >= 0,
};

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
    return value === undefined || typeof value === 'string';
}

function isIndexInRange(value: unknown, length: number): value is number {
    return Number.isInteger(value) && (value as number) >= 0 && (value as number) < length;
}

function isGridDimension(value: unknown): value is string {
    return typeof value === 'string' && GRID_DIMENSIONS.has(value);
}

function isWritableSetting(key: unknown, value: unknown): key is string {
    return typeof key === 'string' && Object.prototype.hasOwnProperty.call(SETTING_VALIDATORS, key) && SETTING_VALIDATORS[key](value);
}

/** Restored history as transcript rows, assistant markdown rendered like live replies. */
async function toTranscriptMessages(history: unknown): Promise<ChatMessage[]> {
    return Promise.all(mapHistoryMessages(history).map(async ({ role, content }): Promise<ChatMessage> =>
        role === 'assistant' ? { role, content, html: await renderMarkdown(content) } : { role, content }
    ));
}

/** Mark the current run's still-open tool entries terminal: the run ended without reporting them. */
function settleRunToolEntries(thread: ChatThreadState, status: 'done' | 'cancelled'): void {
    for (let i = thread.messages.length - 1; i >= 0; i--) {
        const message = thread.messages[i];
        if (message.role === 'user') {
            return;
        }
        if (message.role !== 'tool') {
            continue;
        }
        for (const entry of message.entries) {
            if (!TERMINAL_TOOL_STATUSES.has(entry.status)) {
                entry.status = status;
            }
        }
    }
}

function resetUsage(thread: ChatThreadState): void {
    thread.contextTokens = 0;
    thread.lastUsage = null;
}

/** A prompt, or a builder that fits it to the acpx argument budget once the
 *  transport is resolved (undefined: no per-argument limit applies). */
type PromptSource = string | ((maxBytes: number | undefined) => string);

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
    /** Bumped by every handleSelectAgent so a superseded selection aborts after its awaits. */
    private selectGeneration = 0;
    /** Persist generation plus a serialized write chain: overlapping selections
     *  must not let a stale workspaceState write land last. */
    private persistGeneration = 0;
    private persistLastSessionKeyWrite: Promise<void> = Promise.resolve();
    /** Main-agent keys from the last sessions.list. Webview keys are only
     *  shape-checked at the boundary; this allowlist gates rebinding. */
    private knownMainSessionKeys = new Set<string>();
    /** Gateway identity the allowlist was built from; a URL/token change invalidates it. */
    private allowlistGatewayId: string | null = null;
    private resumeStarted = false;
    /** One ticket per in-flight sendPrompt backend resolution. A resolve (this
     *  thread's or another grid thread's) can invalidate the gateway mid-flight:
     *  invalidateGatewayRuns then advances a still-current ticket's expected
     *  epoch past its own bump instead of finalizing the send. */
    private readonly resolveTickets = new Set<{ threadId: string; expectedEpoch: number }>();
    private threadCounter = 0;
    private readonly threads = new Map<string, ChatThreadState>();
    /** Persistent transcript callback per thread; reopening replaces it instead of duplicating delivery. */
    private transcriptCallbacks = new Map<string, { sessionKey: string; cb: (event: ChatEvent) => void }>();
    /** Transcript callbacks suspended while a run on the same session delivers through its run sink. */
    private suspendedTranscriptSinks = new Map<string, { gateway: GatewayChatService; sessionKey: string }>();
    /** Resumes deferred until the send that was in flight at resume time finalizes. */
    private deferredResumes = new Map<string, { sessionKey: string; historyRendered?: boolean }>();
    private chatEventQueueByThread = new Map<string, Promise<void>>();
    /** Keyed by gateway identity so a URL/token change never joins the old gateway's refresh. */
    private allowlistRefreshInFlight: Map<string, Promise<unknown | null>> = new Map();
    /** Transient per-thread notice (e.g. cold session) shown in an empty pane, never part of the transcript. */
    private readonly threadNotices = new Map<string, string>();
    private lastTransportStatus: Record<string, unknown> | null = null;
    /** Mentions for a webview whose page is (re)loading, flushed when it requests state. */
    private readonly pendingMentions = new Map<vscode.Webview, string[]>();
    private visibleThreadIds: string[] = [];
    private activeThreadId = '';

    private readonly chatServiceFactory: ChatServiceFactory;

    constructor(private readonly extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this.context = context;
        this.globalState = context.globalState;
        this.chatServiceFactory = new ChatServiceFactory(
            context,
            (transport, connected) => this.publishTransportStatus(transport, connected),
            (reason) => this.invalidateGatewayRuns(reason)
        );
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
        this.bootstrapWebview(webviewView.webview);

        webviewView.onDidDispose(() => {
            this.pendingMentions.delete(webviewView.webview);
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
        this.bootstrapWebview(panel.webview);

        panel.onDidDispose(() => {
            this.popOutPanel = undefined;
        });
    }

    attachDebugPanel(panel: vscode.WebviewPanel): void {
        this.debugPanel = panel;
        this.setupWebviewListeners(panel.webview);
        this.bootstrapWebview(panel.webview);
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

    private allWebviews(): Array<vscode.Webview | undefined> {
        return [this.sidebarView?.webview, this.popOutPanel?.webview, this.debugPanel?.webview];
    }

    private publishTransportStatus(transport: 'gateway' | 'acpx', connected: boolean): void {
        this.lastTransportStatus = {
            type: 'transportStatus',
            transport,
            connected,
            label: connected ? `${transport} · connected` : `${transport} · offline`,
        };
        postToAll(this.allWebviews(), this.lastTransportStatus);
    }

    // Every field of an inbound message is untrusted webview input.
    private setupWebviewListeners(webview: vscode.Webview): void {
        webview.onDidReceiveMessage(async (msg: InboundMessage) => {
            if (!msg || typeof msg !== 'object') {
                return;
            }
            log.info(`webview msg: type=${String(msg.type)}, threadId=${typeof msg.threadId === 'string' ? msg.threadId : '(none)'}`);
            const thread = this.threadForMessage(msg.threadId);

            switch (msg.type) {
                case 'send':
                    if (thread && isNonEmptyString(msg.text)) {
                        await this.handleSend(thread, msg.text);
                    }
                    break;
                case 'setChatType':
                    if (thread && isNonEmptyString(msg.chatType)) {
                        thread.currentChatType = msg.chatType;
                        thread.permissionState = this.getPermissionState(msg.chatType);
                        this.emitState();
                    }
                    break;
                case 'setModel':
                    if (thread && isNonEmptyString(msg.model)) {
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
                    if (thread && isNonEmptyString(msg.command) && isOptionalString(msg.text)) {
                        await this.handleSlashCommand(thread, msg.command, msg.text ?? '');
                    }
                    break;
                case 'requestRecommendations':
                    this.pushRecommendations();
                    break;
                case 'requestState':
                    this.emitState();
                    this.flushPendingMentions(webview);
                    break;
                case 'cancel':
                    if (thread) {
                        this.cancelThread(thread);
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
                    await this.handleListSessions(webview, msg.type === 'requestAgents', thread?.id);
                    break;
                case 'selectAgent':
                    if (isMainAgentSessionKey(msg.sessionKey)) {
                        await this.handleSelectAgent(msg.sessionKey);
                    }
                    break;
                case 'openSession': {
                    // The requesting pane, not the thread active when the reply lands.
                    const target = typeof msg.threadId === 'string' ? this.threads.get(msg.threadId) : undefined;
                    if (!target) {
                        log.warn('openSession: rejected message without a known threadId');
                    } else if (isMainAgentSessionKey(msg.sessionKey)) {
                        await this.handleOpenSession(msg.sessionKey, target);
                    }
                    break;
                }
                case 'popOut':
                    this.popOut();
                    break;
                case 'setDimension':
                    if (isGridDimension(msg.dimension)) {
                        void vscode.workspace.getConfiguration('openclaw').update(
                            'chat.dimension',
                            msg.dimension,
                            vscode.ConfigurationTarget.Global
                        );
                    }
                    break;
                case 'setSetting':
                    if (isWritableSetting(msg.key, msg.value)) {
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
                    if (thread && isIndexInRange(msg.index, thread.pendingAttachments.length)) {
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
                    if (thread && isNonEmptyString(msg.filePath)) {
                        await this.addAttachments(thread, [msg.filePath]);
                    }
                    break;
                case 'attachFiles': {
                    const filePaths = Array.isArray(msg.filePaths) ? msg.filePaths.filter(isNonEmptyString) : [];
                    if (thread && filePaths.length > 0) {
                        await this.addAttachments(thread, filePaths);
                    }
                    break;
                }
                case 'insertMention':
                    await this.insertSelectionMention(webview);
                    break;
                case 'openFile':
                    if (isNonEmptyString(msg.filePath) && isOptionalString(msg.line)) {
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

    /** A message without a threadId targets the active thread; an unknown or malformed id targets none. */
    private threadForMessage(threadId: unknown): ChatThreadState | undefined {
        if (threadId === undefined) {
            return this.getActiveThread();
        }
        return typeof threadId === 'string' ? this.threads.get(threadId) : undefined;
    }

    private getActiveThread(): ChatThreadState | undefined {
        return this.threads.get(this.activeThreadId);
    }

    private cancelThread(thread: ChatThreadState): void {
        const backend = this.backendFor(thread);
        // Bump before abort: a disconnected gateway completes the old sink
        // synchronously and the acpx close fires late; both must be stale.
        thread.eventEpoch += 1;
        if (backend instanceof GatewayChatService) {
            // Abort only a run this thread owns: an idle resumed thread or a
            // shared key must not cancel a run owned by another thread or client.
            const shared = this.otherRunningGatewayThread(thread.id, thread.sessionKey);
            if (thread.sessionKey && !shared && thread.status === 'running' && backend.hasOwnedRun(thread.sessionKey)) {
                backend.abort(thread.sessionKey);
            }
        } else {
            backend.abort();
        }
        thread.isStreaming = false;
        thread.status = 'cancelled';
        settleRunToolEntries(thread, 'cancelled');
        // The epoch-dropped `done` will not restore the suspended transcript sink.
        this.restoreSuspendedTranscriptSink(thread);
        this.emitState();
    }

    private resetThread(thread: ChatThreadState): void {
        const backend = this.backendFor(thread);
        // Both generations bump before abort so a synchronous `done` from a
        // disconnected gateway is stale; the openGeneration bump stops an
        // in-flight openSession from reassigning the session after the clear.
        thread.eventEpoch += 1;
        thread.bindingEpoch += 1;
        thread.openGeneration += 1;
        thread.openInFlightGen = null;
        if (backend instanceof GatewayChatService) {
            // Abort only a run this thread owns; the session may be shared with a thread that runs on it.
            if (thread.sessionKey) {
                const shared = this.otherRunningGatewayThread(thread.id, thread.sessionKey);
                if (!shared && thread.status === 'running' && backend.hasOwnedRun(thread.sessionKey)) {
                    backend.abort(thread.sessionKey);
                }
            }
        } else {
            backend.abort();
        }
        thread.messages = [];
        thread.pendingAssistantText = '';
        thread.pendingAttachments = [];
        thread.isStreaming = false;
        thread.status = 'idle';
        this.threadNotices.delete(thread.id);
        const gatewayBackend = backend instanceof GatewayChatService ? backend : null;
        if (!this.suspendedTranscriptSinks.get(thread.id) && gatewayBackend) {
            // The persistent callback captured the pre-bump bindingEpoch: rebind
            // it, or every later transcript event is epoch-dropped.
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
        resetUsage(thread);
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
        // Invalidate pending send/attach continuations before teardown.
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
        this.threadNotices.delete(threadId);
        if (backend instanceof GatewayChatService) {
            // hasOwnedRun proves only that the service holds a run sink for the
            // key, not that this thread owns it: exclude other running threads.
            const shared = this.otherRunningGatewayThread(threadId, thread.sessionKey);
            if (thread.sessionKey && !shared && thread.status === 'running' && backend.hasOwnedRun(thread.sessionKey)) {
                backend.abort(thread.sessionKey);
            }
            if (thread.sessionKey &&
                ![...this.threads.values()].some(t => t.id !== threadId &&
                    t.sessionKey === thread.sessionKey && this.backendFor(t) instanceof GatewayChatService)) {
                backend.clearSessionSink(thread.sessionKey);
            }
        } else {
            backend.abort();
        }
        thread.service.dispose();
        // The shared gateway client stays alive for other threads.
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

    /** Each await re-checks the caller guard: a cancel/clear in between must not repopulate the reset thread. */
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
                // The canonical spelling is what the read-time realpath check compares against.
                const canonical = await fs.promises.realpath(filePath).catch(() => filePath);
                if (options?.guard?.() === false) {
                    return;
                }
                // Re-applied to the canonical target: a symlink swap since mention parsing could escape the workspace.
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
        // Same rebind guard as handleSend: the command would target the previous session key.
        if (thread.openInFlightGen !== null) {
            log.info('handleSlashCommand: openSession in flight, command rejected');
            thread.status = 'error';
            this.emitState();
            return;
        }
        // Marked running before the awaits so a rebind retires it and a second command sees it busy.
        const sendEpoch = thread.eventEpoch;
        thread.isStreaming = true;
        thread.status = 'running';

        try {
        const context = await gatherEditorContext(cmd.contextType, (args) => this.runGit(args));
        const mentions = await this.resolveMentions(userText);
        if (mentions.length > 0) {
            await this.addAttachments(thread, mentions, { guard: () => thread.eventEpoch === sendEpoch });
        }
        // /compact summarizes prior turns, so the fresh per-send exec needs the transcript.
        const transcript = commandName === 'compact' && thread.messages.length > 0
            ? thread.messages
                .filter(m => m.role !== 'tool')
                .map(m => {
                    const label = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'Error';
                    return `${label}: ${m.content}`;
                })
                .join('\n\n')
            : undefined;
        // Built once the transport is known, so it can fit the acpx argument budget.
        const augmented: PromptSource = (maxBytes) => buildSlashPrompt(commandName, userText, context, transcript, maxBytes);
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

        await this.sendPrompt(thread, augmented, attachments, sendEpoch);
        } catch (err) {
            this.failSend(thread, 'handleSlashCommand', err);
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
        postToAll(this.allWebviews(), {
            type: 'recommendations',
            items: buildRecommendations()
        });
    }

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
        // Clear/Cancel may land while the dialog is open.
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

    private async handleSend(thread: ChatThreadState, text: string): Promise<void> {
        log.info(`handleSend: thread=${thread.id}, text="${text.slice(0, 80)}"`);
        if (thread.isStreaming) {
            return;
        }
        // An openSession is rebinding this thread: the send would target the
        // previous key and deliver into the newly opened conversation.
        if (thread.openInFlightGen !== null) {
            log.info('handleSend: openSession in flight, send rejected');
            thread.status = 'error';
            this.emitState();
            return;
        }
        // Busy before attachment resolution; the epoch guard honours a cancel/clear during it.
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
                    // addAttachments stores the canonical realpath.
                    const canonicalAutoAttach = await fs.promises.realpath(autoAttachPath).catch(() => autoAttachPath);
                    pushNew(thread.pendingAttachments.filter(a => a.path === canonicalAutoAttach));
                }
            }

            const mentions = await this.resolveMentions(text);
            if (mentions.length > 0) {
                // Canonical spelling and (path + range) keys, matching what addAttachments stored.
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

            await this.sendPrompt(thread, text, attachments, sendEpoch);
        } catch (err) {
            this.failSend(thread, 'handleSend', err);
        }
    }

    /** Finalize a send that threw. Status, not the epoch, tells whether the send
     *  still owns the thread: sendPrompt bumps the epoch itself for each run. */
    private failSend(thread: ChatThreadState, origin: string, err: unknown): void {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`${origin} failed: ${message}`);
        if (!this.threads.has(thread.id) || thread.status !== 'running') {
            return;
        }
        thread.messages.push({ role: 'error', content: `Send failed: ${message}` });
        thread.isStreaming = false;
        thread.status = 'error';
        this.emitState();
    }

    /** Lifecycle backend for a thread: the transport of the last send, else the legacy service. */
    private backendFor(thread: ChatThreadState): ChatService | GatewayChatService {
        return thread.transportBackend ?? thread.service;
    }

    /** Connect now (e.g. after saving a token) rather than on the next send; resolving drives the status badge. */
    async connectGatewayTransport(): Promise<void> {
        await this.chatServiceFactory.resolve();
    }

    /** Send a queued user prompt through the resolved backend. */
    private async sendPrompt(
        thread: ChatThreadState,
        prompt: PromptSource,
        attachments: Attachment[],
        sendEpoch: number
    ): Promise<void> {
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

        const resolveTicket = { threadId: thread.id, expectedEpoch: sendEpoch };
        this.resolveTickets.add(resolveTicket);
        let choice;
        try {
            choice = await this.resolveServiceForSend(this.backendFor(thread));
        } finally {
            this.resolveTickets.delete(resolveTicket);
        }
        // The resolve can take seconds: a cancel/clear/close, a superseding
        // send or a rebind (openInFlightGen) during it owns the thread now.
        if (!this.threads.has(thread.id) ||
            thread.openInFlightGen !== null ||
            thread.status !== 'running' ||
            thread.eventEpoch !== resolveTicket.expectedEpoch) {
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
        // Retire the previous backend so its late events cannot reach the new run.
        const previousBackend = thread.transportBackend;
        if (previousBackend && previousBackend !== choice.service && previousBackend !== thread.service) {
            if (previousBackend instanceof GatewayChatService) {
                // The shared gateway client is never disposed; abort only a run
                // this thread owns, and never another thread's run on the key.
                if (thread.sessionKey) {
                    thread.eventEpoch += 1;
                    thread.bindingEpoch += 1;
                    const sharedRun = this.otherRunningGatewayThread(thread.id, thread.sessionKey);
                    if (!sharedRun && previousBackend.hasOwnedRun(thread.sessionKey)) {
                        previousBackend.abort(thread.sessionKey);
                    }
                    // Keep the thread's transcript callback across the fallback,
                    // rebound under the bumped epoch, so it still hears the session.
                    const suspendedOwn = this.suspendedTranscriptSinks.get(thread.id);
                    if (suspendedOwn && suspendedOwn.sessionKey === thread.sessionKey) {
                        this.restoreSuspendedTranscriptSink(thread);
                    } else {
                        const ownCallback = this.transcriptCallbacks.get(thread.id);
                        if (ownCallback && ownCallback.sessionKey === thread.sessionKey) {
                            const rebindEpoch = thread.bindingEpoch;
                            const cb = (event: ChatEvent): void => { void this.handleChatEvent(thread.id, event, rebindEpoch, 'binding'); };
                            this.transcriptCallbacks.set(thread.id, { sessionKey: thread.sessionKey, cb });
                            previousBackend.rebindTranscriptSink(thread.sessionKey, cb);
                        }
                    }
                }
            } else {
                previousBackend.dispose();
                thread.eventEpoch += 1;
                thread.bindingEpoch += 1;
            }
        }
        // Retiring the backend is internal invalidation, not a superseding send.
        sendEpoch = thread.eventEpoch;
        thread.transportBackend = choice.service;
        let runEpoch: number | undefined;
        if (choice.service instanceof GatewayChatService) {
            // Never the shared gateway's mutable active session, which another thread may have selected.
            if (!thread.sessionKey) {
                thread.sessionKey = DEFAULT_SESSION_KEY;
            }
            // A binding learned from a previous gateway identity must not be used on this one.
            const keyAllowed = await this.isKnownMainSessionKey(choice.service, thread.sessionKey);
            if (thread.status !== 'running' || thread.eventEpoch !== sendEpoch) {
                return;
            }
            if (!keyAllowed) {
                const staleKey = thread.sessionKey;
                thread.eventEpoch += 1;
                thread.bindingEpoch += 1;
                const ownCallback = this.transcriptCallbacks.get(thread.id);
                if (ownCallback && ownCallback.sessionKey === staleKey) {
                    this.transcriptCallbacks.delete(thread.id);
                    choice.service.removeTranscriptSink(staleKey, ownCallback.cb);
                }
                const suspendedOwn = this.suspendedTranscriptSinks.get(thread.id);
                if (suspendedOwn && suspendedOwn.sessionKey === staleKey) {
                    this.suspendedTranscriptSinks.delete(thread.id);
                }
                if (!this.otherThreadsOnKey(thread.id, staleKey)) {
                    choice.service.clearSessionSink(staleKey);
                }
                thread.sessionKey = DEFAULT_SESSION_KEY;
                thread.pendingAssistantText = '';
                thread.isStreaming = false;
                thread.status = 'error';
                thread.messages.push({
                    role: 'error',
                    content: `Session "${staleKey}" is not known to the current gateway. The thread was reset to the default session; reopen the session to retry.`
                });
                this.emitState();
                return;
            }
            // A second run on the session would replace the first thread's run sink.
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
            // The run sink delivers live events; the persistent callback would duplicate them.
            this.suspendThreadTranscriptSink(choice.service, thread);
        } else {
            thread.eventEpoch += 1;
            runEpoch = thread.eventEpoch;
        }
        // CLI transports carry the prompt as one command-line argument, so the
        // platform's argument budget bounds prompt and attachments together.
        const argvLimitBytes = choice.service instanceof GatewayChatService
            ? null
            : ChatService.promptArgBudgetBytes(thread.currentChatType);
        const basePrompt = typeof prompt === 'string'
            ? prompt
            : prompt(argvLimitBytes === null ? undefined : attachments.length > 0 ? Math.floor(argvLimitBytes / 2) : argvLimitBytes);
        // Transport-specific: the gateway takes images inline (it cannot read
        // this machine's disk), CLI transports take temp-file paths to fit argv.
        let promptToSend = basePrompt;
        let disposeAttachments: (() => Promise<void>) | undefined;
        if (attachments.length > 0) {
            const attachmentResult = await readAttachments(
                attachments,
                {
                    imageMode: choice.service instanceof GatewayChatService ? 'inline' : 'tempFile',
                    // The base prompt shares the gateway payload and the CLI argv budget.
                    reservedPromptBytes:
                        Buffer.byteLength(basePrompt, 'utf8') + ATTACHMENT_PROMPT_FRAMING_RESERVE_BYTES,
                    reservedArgvBytes:
                        Buffer.byteLength(basePrompt, 'utf8') + ATTACHMENT_ARGV_FRAMING_RESERVE_BYTES,
                    argvLimitBytes,
                }
            );
            disposeAttachments = attachmentResult.dispose;
            // Superseded during the read: the snapshots never reached a child, so remove them here.
            if (!this.threads.has(thread.id) ||
                thread.status !== 'running' ||
                thread.eventEpoch !== runEpoch) {
                void disposeAttachments?.();
                return;
            }
            promptToSend = `${attachmentResult.prompt}\n\n${basePrompt}`;
        }
        choice.service.sendMessage(
            promptToSend,
            cwd,
            thread.currentModel,
            thread.currentChatType,
            (event: ChatEvent) => {
                void this.handleChatEvent(thread.id, event, runEpoch);
            },
            (resolvedKey, requestedKey) => {
                // The thread was switched to another session mid-run: retire
                // the run instead of letting old-session output into it.
                if (thread.sessionKey !== requestedKey) {
                    thread.eventEpoch += 1;
                    if (choice.service instanceof GatewayChatService) {
                        // The resolved key may host another thread's or client's run.
                        const resolvedLiveOther =
                            [...this.threads.values()].some(
                                t => t.id !== thread.id && t.sessionKey === resolvedKey &&
                                    (t.isStreaming || t.status === 'running') &&
                                    this.backendFor(t) instanceof GatewayChatService
                            ) ||
                            [...this.suspendedTranscriptSinks].some(
                                ([threadId, suspended]) => threadId !== thread.id &&
                                    suspended.sessionKey === resolvedKey
                            );
                        if (choice.service.hasOwnedRun(resolvedKey) && !resolvedLiveOther) {
                            choice.service.abort(resolvedKey);
                        }
                        if (![...this.threads.values()].some(t => t.id !== thread.id &&
                            t.sessionKey === resolvedKey && this.backendFor(t) instanceof GatewayChatService)) {
                            choice.service.clearSessionSink(resolvedKey);
                        }
                    }
                    // The retired run's `done` is epoch-dropped, so finalize the send here.
                    thread.pendingAssistantText = '';
                    thread.isStreaming = false;
                    if (thread.status === 'running') {
                        thread.status = 'idle';
                    }
                    settleRunToolEntries(thread, 'cancelled');
                    const retiredSuspend = this.suspendedTranscriptSinks.get(thread.id);
                    if (retiredSuspend && retiredSuspend.sessionKey === requestedKey) {
                        this.suspendedTranscriptSinks.delete(thread.id);
                    }
                    this.emitState();
                    return;
                }
                // Rebind to the resolved key so cancel/reset/close target where the run lives.
                thread.sessionKey = resolvedKey;
                const suspended = this.suspendedTranscriptSinks.get(thread.id);
                if (suspended && suspended.sessionKey === requestedKey) {
                    suspended.sessionKey = resolvedKey;
                }
            },
            // Temp-file snapshots live until the child process exits.
            () => void disposeAttachments?.()
        );
    }

    private suspendThreadTranscriptSink(gateway: GatewayChatService, thread: ChatThreadState): void {
        const own = this.transcriptCallbacks.get(thread.id);
        if (!own || own.sessionKey !== thread.sessionKey) {
            return;
        }
        gateway.removeTranscriptSink(own.sessionKey, own.cb);
        this.suspendedTranscriptSinks.set(thread.id, { gateway, sessionKey: own.sessionKey });
    }

    /** A fresh callback: bindingEpoch may have changed mid-run. */
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
        // Unavailable for now: keep the entry so the next run's `done` retries.
        if (!gateway) {
            if (this.threads.has(thread.id) && thread.sessionKey === deferred.sessionKey) {
                this.deferredResumes.set(thread.id, deferred);
            }
            return;
        }
        // A send started during the await: binding now would double-deliver
        // alongside its run sink. Widened: the pre-await check narrowed the union.
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

    /** Runs before the shared gateway client retires every sink with a
     *  synthetic `done`: the epoch bumps make that `done` stale, and the sink
     *  bookkeeping goes so nothing is rebound before the allowlist re-check. */
    private invalidateGatewayRuns(reason: GatewayInvalidationReason): void {
        for (const thread of this.threads.values()) {
            const backend = this.backendFor(thread);
            if (!(backend instanceof GatewayChatService)) {
                continue;
            }
            // A ticket from a cancelled/superseded send is stale and never revived.
            const resolving = [...this.resolveTickets].filter(ticket =>
                ticket.threadId === thread.id && ticket.expectedEpoch === thread.eventEpoch);
            if (resolving.length > 0) {
                // The send is still resolving its backend: keep it alive,
                // sendPrompt rebases its epoch and switches backends.
                thread.eventEpoch += 1;
                thread.bindingEpoch += 1;
                const ownCallback = this.transcriptCallbacks.get(thread.id);
                if (ownCallback) {
                    backend.removeTranscriptSink(ownCallback.sessionKey, ownCallback.cb);
                }
                this.transcriptCallbacks.delete(thread.id);
                this.suspendedTranscriptSinks.delete(thread.id);
                resolving.forEach(ticket => { ticket.expectedEpoch = thread.eventEpoch; });
                continue;
            }
            if (!thread.isStreaming && thread.status !== 'running') {
                // Idle threads lose their gateway sinks too; drop the records of them.
                this.transcriptCallbacks.delete(thread.id);
                this.suspendedTranscriptSinks.delete(thread.id);
                continue;
            }
            thread.eventEpoch += 1;
            thread.bindingEpoch += 1;
            const ownCallback = this.transcriptCallbacks.get(thread.id);
            if (ownCallback) {
                backend.removeTranscriptSink(ownCallback.sessionKey, ownCallback.cb);
            }
            this.transcriptCallbacks.delete(thread.id);
            this.suspendedTranscriptSinks.delete(thread.id);
            thread.pendingAssistantText = '';
            thread.isStreaming = false;
            thread.status = 'error';
            settleRunToolEntries(thread, 'cancelled');
            thread.messages.push({ role: 'error', content: INTERRUPTED_RUN_MESSAGES[reason] });
        }
        this.emitState();
    }

    private async handleChatEvent(threadId: string, event: ChatEvent, eventEpoch?: number, epochScope: 'run' | 'binding' = 'run'): Promise<void> {
        const thread = this.threads.get(threadId);
        if (!thread) {
            log.warn(`handleChatEvent: thread ${threadId} not found`);
            return;
        }
        // Serialized per thread: a `done` awaits markdown rendering, and a
        // following `text` must not join its not-yet-committed pending text.
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
        // Persistent transcript sinks validate against bindingEpoch (bumped on
        // rebind/reset/close); run sinks against eventEpoch (bumped per send).
        const currentEpoch = epochScope === 'binding' ? thread.bindingEpoch : thread.eventEpoch;
        if (eventEpoch !== undefined && currentEpoch !== eventEpoch) {
            log.info(`handleChatEvent: dropping stale ${epochScope}-epoch-${eventEpoch} event (current ${currentEpoch}), thread=${threadId}`);
            return;
        }
        log.info(`handleChatEvent: type=${event.type}, thread=${threadId}`);
        this.threadNotices.delete(threadId);

        switch (event.type) {
            case 'text':
                thread.pendingAssistantText += event.text;
                thread.isStreaming = true;
                thread.status = 'running';
                postToAll(this.allWebviews(), {
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
                    // A run started during rendering owns the pending text now.
                    if (thread.eventEpoch !== commitEpoch) {
                        log.info(`handleChatEvent: dropping stale done after render (epoch ${commitEpoch} -> ${thread.eventEpoch}), thread=${threadId}`);
                        return;
                    }
                    thread.messages.push({ role: 'assistant', content: raw, html });
                }
                thread.isStreaming = false;
                // A `done` from abort() or teardown must not upgrade a stopped thread.
                if (thread.status !== 'error' && thread.status !== 'cancelled' && thread.status !== 'idle') {
                    thread.status = 'complete';
                }
                // Transcript replay emits `done` per final row while an external run may still use its tools.
                if (epochScope === 'run') {
                    settleRunToolEntries(thread, 'done');
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
                if (epochScope === 'run') {
                    settleRunToolEntries(thread, 'cancelled');
                }
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
            const threads = buildThreadSnapshots(this.threads, this.visibleThreadIds)
                .map(snapshot => ({ ...snapshot, notice: this.threadNotices.get(snapshot.id) }));
            const totalMessages = threads.reduce((sum, t) => sum + t.messages.length, 0);
            log.info(`emitState: ${threads.length} threads, ${totalMessages} msgs, active=${this.activeThreadId}, sidebar=${!!this.sidebarView}, popout=${!!this.popOutPanel}, debug=${!!this.debugPanel}`);

            for (const webview of [this.sidebarView?.webview, this.popOutPanel?.webview, this.debugPanel?.webview]) {
                if (!webview) { continue; }
                const enriched = enrichAttachmentsForWebview(threads, webview);
                webview.postMessage({ ...base, threads: enriched });
            }
        } catch (err) {
            log.error('emitState failed', err);
            postToAll(this.allWebviews(), { type: 'state', threads: [], activeThreadId: '', visibleThreadIds: [], models: [], dimension: '1x1', collapseCompleted: true });
        }
    }

    private bootstrapWebview(webview: vscode.Webview): void {
        setTimeout(() => {
            void webview.postMessage({
                type: 'slashCommands',
                commands: SLASH_COMMANDS.map(c => ({
                    name: c.name,
                    description: c.description,
                    icon: c.icon,
                    placeholder: c.placeholder,
                })),
            });
            if (this.lastTransportStatus) {
                void webview.postMessage(this.lastTransportStatus);
            }
            this.pushRecommendations();
            this.emitState();

            if (this.globalState.get<boolean>('openclaw.onboardingComplete')) {
                void webview.postMessage({ type: 'onboardingDone' });
            }
        }, 100);
        if (!this.resumeStarted) {
            this.resumeStarted = true;
            void this.resumeLastSession().catch(err => {
                log.warn('resumeLastSession: failed to resume last session', err);
            });
        }
    }

    /** Command-palette agent picker, opened into the thread active when invoked. */
    async showAgentPicker(): Promise<void> {
        const thread = this.getActiveThread();
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
        // Routed through the open flow: the palette selection must load history and resume.
        if (chosen && thread) {
            await this.handleOpenSession(chosen.sessionKey, thread);
        }
    }

    /** The gateway transport for session-list/history flows, or null when it cannot be resolved. */
    private async resolveGateway(): Promise<GatewayChatService | null> {
        try {
            return await this.resolveGatewayOrThrow();
        } catch (err) {
            log.warn('gateway resolution failed', err);
            return null;
        }
    }

    /** Throws when a configured gateway cannot be used (invalid URL, SecretStorage failure). */
    private async resolveGatewayOrThrow(): Promise<GatewayChatService | null> {
        const choice = await this.chatServiceFactory.resolve();
        return choice.transport === 'gateway' && choice.service instanceof GatewayChatService
            ? choice.service
            : null;
    }

    /** Answer a sessions request to the webview that asked, empty with an error when unavailable. */
    private async handleListSessions(webview: vscode.Webview, forPicker: boolean, threadId: string | undefined): Promise<void> {
        const reply = (sessions: AgentSessionItem[], error?: string): void => {
            void webview.postMessage({ type: forPicker ? 'agentsList' : 'sessionsList', sessions, error, threadId });
        };
        let gateway: GatewayChatService | null;
        try {
            gateway = await this.resolveGatewayOrThrow();
        } catch (err) {
            log.warn('sessions: gateway resolution failed', err);
            reply([], `Gateway error: ${err instanceof Error ? err.message : String(err)}`);
            return;
        }
        if (!gateway) {
            reply([], SESSIONS_GATEWAY_UNAVAILABLE);
            return;
        }
        const payload = await this.refreshSessionAllowlist(gateway);
        if (!payload) {
            reply([], SESSIONS_LIST_FAILED);
            return;
        }
        reply(buildAgentSessionItems(payload));
    }

    /** Concurrent callers share one in-flight refresh, so an older response cannot overwrite a newer allowlist. */
    private async refreshSessionAllowlist(gateway: GatewayChatService): Promise<unknown | null> {
        const identity = gateway.getGatewayIdentity();
        const existing = this.allowlistRefreshInFlight.get(identity);
        if (existing) {
            return existing;
        }
        const run = this.runAllowlistRefresh(gateway).finally(() => {
            if (this.allowlistRefreshInFlight.get(identity) === run) {
                this.allowlistRefreshInFlight.delete(identity);
            }
        });
        this.allowlistRefreshInFlight.set(identity, run);
        return run;
    }

    /** The fresh sessions.list payload, or null when none could be trusted: a
     *  response that raced a gateway identity change is discarded and retried once. */
    private async runAllowlistRefresh(gateway: GatewayChatService): Promise<unknown | null> {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const identityBefore = gateway.getGatewayIdentity();
            try {
                const payload = await gateway.listSessions({});
                if (gateway.getGatewayIdentity() !== identityBefore) {
                    continue;
                }
                this.allowlistGatewayId = identityBefore;
                this.knownMainSessionKeys = new Set(
                    buildAgentSessionItems(payload).map(item => item.sessionKey)
                );
                return payload;
            } catch (err) {
                log.warn('session allowlist refresh failed', err);
                return null;
            }
        }
        return null;
    }

    /** Whether the key is in the current gateway's allowlist. An empty list
     *  refreshes once (restart-resume binds keys never listed); an
     *  unverifiable key is unknown. */
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
            await this.refreshSessionAllowlist(gateway);
        }
        return this.knownMainSessionKeys.has(sessionKey);
    }

    /** Bind the chosen agent session key to the active chat and persist it.
     *  The open-in-flight marker blocks sends until the whole rebind settles. */
    private async handleSelectAgent(sessionKey: string): Promise<void> {
        const selectGen = ++this.selectGeneration;
        const pendingOpenThread = this.getActiveThread();
        if (pendingOpenThread) {
            pendingOpenThread.openGeneration += 1;
            pendingOpenThread.openInFlightGen = pendingOpenThread.openGeneration;
        }
        const selectionGen = pendingOpenThread ? pendingOpenThread.openGeneration : null;
        const gateway = await this.resolveGateway();
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
            await this.persistLastSessionKey(sessionKey, () =>
                this.selectGeneration === selectGen &&
                (selectionGen === null || pendingOpenThread?.openGeneration === selectionGen));
        } catch (err) {
            log.warn('selectAgent: failed to persist last session key', err);
            if (pendingOpenThread && pendingOpenThread.openInFlightGen === selectionGen) {
                pendingOpenThread.openInFlightGen = null;
            }
            if (this.getActiveThread()?.id === pendingOpenThread?.id) {
                const activeThread = this.getActiveThread();
                if (activeThread) {
                    activeThread.messages.push({
                        role: 'error',
                        content: 'Failed to persist the last session. Reopen the session to retry.'
                    });
                    this.emitState();
                }
            }
            return;
        }
        try {
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
        // The shared session switches only after the generation checks, so a
        // stale continuation cannot overwrite a newer selection's key; the
        // persist await may have outlived a gateway identity change.
        if (!(await this.isKnownMainSessionKey(gateway, sessionKey))) {
            log.warn('selectAgent: rejected session key after identity change', sessionKey);
            return;
        }
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
                const sharesLiveRun = this.otherRunningGatewayThread(activeThread.id, previousKey);
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
            if (activeThread.sessionKey !== sessionKey) {
                this.clearSessionBoundState(activeThread);
            }
            activeThread.sessionKey = sessionKey;
            activeThread.transportBackend = gateway;
        }
        this.postAgentSelected(sessionKey);
        if (activeThread) {
            if (!(activeThread.isStreaming || activeThread.status === 'running')) {
                const historyEpoch = activeThread.eventEpoch;
                const history = await gateway.getHistory(sessionKey);
                const restored = history === null ? null : await toTranscriptMessages(history);
                if (this.selectGeneration === selectGen &&
                    this.getActiveThread()?.id === activeThread.id && activeThread.sessionKey === sessionKey &&
                    activeThread.eventEpoch === historyEpoch && !activeThread.isStreaming &&
                    (selectionGen === null || activeThread.openGeneration === selectionGen)) {
                    if (restored !== null) {
                        gateway.seedHistory(sessionKey, history);
                        activeThread.messages = restored;
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
                } else if (this.selectGeneration === selectGen &&
                    this.getActiveThread()?.id === activeThread.id &&
                    (selectionGen === null || activeThread.openGeneration === selectionGen) &&
                    !this.transcriptCallbacks.has(activeThread.id) &&
                    !this.suspendedTranscriptSinks.has(activeThread.id) &&
                    activeThread.sessionKey) {
                    // Same selection, but epoch/streaming drifted: install the
                    // callback the skipped restore would have, if the key is still known.
                    if (await this.isKnownMainSessionKey(gateway, activeThread.sessionKey)) {
                        this.resumeSessionForThread(gateway, activeThread, activeThread.sessionKey, false);
                    }
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

    /** Whether another gateway-backed thread runs on the key; acpx threads own no gateway run. */
    private otherRunningGatewayThread(excludeThreadId: string, sessionKey: string | undefined): boolean {
        if (!sessionKey) {
            return false;
        }
        for (const t of this.threads.values()) {
            if (t.id !== excludeThreadId && t.sessionKey === sessionKey &&
                t.status === 'running' && this.backendFor(t) instanceof GatewayChatService) {
                return true;
            }
        }
        return false;
    }

    /** Whether another thread (or its suspended sink) is bound to the key, so its sink must survive. */
    private otherThreadsOnKey(excludeThreadId: string, sessionKey: string): boolean {
        for (const t of this.threads.values()) {
            if (t.id !== excludeThreadId && t.sessionKey === sessionKey &&
                this.backendFor(t) instanceof GatewayChatService) {
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

    /** Open a session into the given thread. After every await the thread is
     *  re-checked (still open, same open generation) so a newer open wins. */
    private async handleOpenSession(sessionKey: string, thread: ChatThreadState): Promise<void> {
        if (!this.threads.has(thread.id)) {
            return;
        }
        // Captured before the resolve await: out-of-order opens must not claim a newer generation.
        const openGen = ++thread.openGeneration;
        // Blocks sends until the rebind lands; released only while this open still owns it.
        thread.openInFlightGen = openGen;
        const releaseMarker = (): void => {
            if (thread.openInFlightGen === openGen) {
                thread.openInFlightGen = null;
            }
        };
        const gateway = await this.resolveGateway();
        if (!gateway) {
            releaseMarker();
            return;
        }
        if (!(await this.isKnownMainSessionKey(gateway, sessionKey))) {
            log.warn('openSession: rejected unknown session key', sessionKey);
            releaseMarker();
            return;
        }
        if (!this.isCurrentOpen(thread, openGen)) {
            releaseMarker();
            return;
        }
        try {
            await this.openSessionRebinding(thread, sessionKey, gateway, openGen);
        } finally {
            releaseMarker();
        }
    }

    private isCurrentOpen(thread: ChatThreadState, openGen: number): boolean {
        return this.threads.has(thread.id) && thread.openGeneration === openGen;
    }

    private async openSessionRebinding(
        thread: ChatThreadState,
        sessionKey: string,
        gateway: GatewayChatService,
        openGen: number
    ): Promise<void> {
        // Any binding change counts, including an unbound (acpx) thread opening a gateway session.
        const rebounded = thread.sessionKey !== sessionKey;
        const previousBackend = this.backendFor(thread);
        // A running acpx run leaves no `done` after abort: clear streaming
        // state here or every later send is rejected as busy.
        if (thread.status === 'running' && !(previousBackend instanceof GatewayChatService)) {
            thread.eventEpoch += 1;
            thread.bindingEpoch += 1;
            previousBackend.abort();
            thread.isStreaming = false;
            thread.pendingAssistantText = '';
            thread.status = 'idle';
        }
        // Hoisted so an abandoned rebind can restore the previous binding.
        let abandonedPreviousKey: string | null = null;
        let abandonedSuspendedSink: { gateway: GatewayChatService; sessionKey: string } | null = null;
        // Catch-up state captured before the sink is cleared, so a restore
        // rebuilds the same replay boundary instead of losing events.
        let abandonedStateSnapshot: ReturnType<GatewayChatService['captureSessionState']> = null;
        if (thread.sessionKey && thread.sessionKey !== sessionKey) {
            const previousKey = thread.sessionKey;
            abandonedPreviousKey = previousKey;
            const suspendedSink = this.suspendedTranscriptSinks.get(thread.id);
            abandonedSuspendedSink = suspendedSink ?? null;
            if (suspendedSink && suspendedSink.sessionKey === previousKey) {
                this.suspendedTranscriptSinks.delete(thread.id);
            }
            const sharesLiveRun = this.otherRunningGatewayThread(thread.id, previousKey);
            thread.eventEpoch += 1;
            thread.bindingEpoch += 1;
            // Only a gateway-backed thread may tear down the previous gateway
            // session, and only a run it owns; other subscribers keep their sink.
            if (previousBackend instanceof GatewayChatService) {
                if (thread.status === 'running' && !sharesLiveRun && gateway.hasOwnedRun(previousKey)) {
                    gateway.abort(previousKey);
                }
                if (!this.otherThreadsOnKey(thread.id, previousKey)) {
                    abandonedStateSnapshot = gateway.captureSessionState(previousKey);
                    gateway.clearSessionSink(previousKey);
                }
            }
            thread.isStreaming = false;
            thread.pendingAssistantText = '';
            thread.status = 'idle';
        }
        const restoreAbandonedRebind = (): void => {
            // closeThread is authoritative: never re-insert sinks for a removed thread.
            if (!abandonedPreviousKey || !this.threads.has(thread.id)) {
                return;
            }
            // A superseding open owns the binding now.
            if (thread.openGeneration !== openGen || thread.sessionKey !== abandonedPreviousKey) {
                return;
            }
            if (abandonedSuspendedSink) {
                abandonedSuspendedSink.gateway.restoreSessionState(abandonedSuspendedSink.sessionKey, abandonedStateSnapshot);
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
            gatewayBackend.restoreSessionState(persistent.sessionKey, abandonedStateSnapshot);
            this.transcriptCallbacks.delete(thread.id);
            gatewayBackend.removeTranscriptSink(persistent.sessionKey, persistent.cb);
            const rebindEpoch = thread.bindingEpoch;
            const cb = (event: ChatEvent): void => { void this.handleChatEvent(thread.id, event, rebindEpoch, 'binding'); };
            this.transcriptCallbacks.set(thread.id, { sessionKey: persistent.sessionKey, cb });
            gatewayBackend.rebindTranscriptSink(persistent.sessionKey, cb);
        };
        try {
            await this.persistLastSessionKey(sessionKey, () => this.isCurrentOpen(thread, openGen));
        } catch (err) {
            // The teardown already cleared the previous sinks: restore them and keep the thread usable.
            log.warn('openSessionRebinding: failed to persist last session key', err);
            restoreAbandonedRebind();
            if (this.isCurrentOpen(thread, openGen)) {
                thread.messages.push({
                    role: 'error',
                    content: 'Failed to persist the last session. Reopen the session to retry.'
                });
                this.emitState();
            }
            return;
        }
        // A superseded open persists nothing: the current generation owns persistence.
        if (!this.isCurrentOpen(thread, openGen)) {
            restoreAbandonedRebind();
            return;
        }
        // The shared session switches only after the generation checks, so a
        // stale rebinding cannot overwrite a newer open's key; the persist
        // await may have outlived a gateway identity change.
        if (!(await this.isKnownMainSessionKey(gateway, sessionKey))) {
            log.warn('openSession: rejected session key after identity change', sessionKey);
            restoreAbandonedRebind();
            return;
        }
        gateway.setActiveSession(sessionKey);
        if (rebounded) {
            this.clearSessionBoundState(thread);
        }
        thread.sessionKey = sessionKey;

        // Reopening the bound session mid-run keeps the live transcript and
        // callback; this must precede the cold branch, which clears the thread.
        if (thread.isStreaming || thread.status === 'running') {
            this.postAgentSelected(sessionKey);
            return;
        }

        let label = sessionKey;
        try {
            const payload = await gateway.listSessions({});
            if (!this.isCurrentOpen(thread, openGen) || thread.sessionKey !== sessionKey) {
                restoreAbandonedRebind();
                return;
            }
            const rows = parseSessionRows(payload).rows as SessionRow[];
            const row = rows.find(r => r.key === sessionKey);
            if (row) {
                label = row.label || row.agentId || sessionKey;
                if (isColdSession(row)) {
                    this.showColdSession(thread, gateway, sessionKey, label);
                    return;
                }
            }
        } catch (err) {
            log.warn('sessions.list during open failed', err);
        }

        const historyEpoch = thread.eventEpoch;
        const history = await gateway.getHistory(sessionKey);
        const restored = history === null ? null : await toTranscriptMessages(history);
        if (!this.isCurrentOpen(thread, openGen) || thread.sessionKey !== sessionKey ||
            thread.eventEpoch !== historyEpoch) {
            restoreAbandonedRebind();
            return;
        }
        this.bindGatewayTransportIfIdle(thread, gateway);
        if (restored !== null) {
            // Seeding makes the resume catch-up skip what was just restored.
            gateway.seedHistory(sessionKey, history);
            thread.title = label;
            thread.messages = restored;
            thread.status = 'idle';
        } else if (rebounded) {
            // Never show the previous session's transcript under the new key;
            // a same-key reopen keeps its transcript on transport errors.
            thread.messages = [];
            thread.messages.push({
                role: 'assistant',
                content: 'Failed to load session history. Reopen the session to retry.'
            });
            thread.title = label;
            thread.status = 'error';
        }
        this.postAgentSelected(sessionKey);
        this.resumeSessionForThread(gateway, thread, sessionKey, history !== null);
        this.emitState();
    }

    /** A cold session has no transcript yet: show a transient notice and wait for it to start. */
    private showColdSession(thread: ChatThreadState, gateway: GatewayChatService, sessionKey: string, label: string): void {
        thread.messages = [];
        thread.status = 'idle';
        thread.title = label;
        this.threadNotices.set(thread.id, COLD_SESSION_PLACEHOLDER);
        this.emitState();
        this.postAgentSelected(sessionKey);
        this.bindGatewayTransportIfIdle(thread, gateway);
        this.resumeSessionForThread(gateway, thread, sessionKey, false);
    }

    /** Tells every webview to dismiss its sessions panel. */
    private postAgentSelected(sessionKey: string): void {
        postToAll(this.allWebviews(), { type: 'agentSelected', sessionKey });
    }

    /** State that describes the previous session and must not survive a rebind. */
    private clearSessionBoundState(thread: ChatThreadState): void {
        resetUsage(thread);
        this.threadNotices.delete(thread.id);
    }

    /** A send started during the open binds its own backend (possibly acpx);
     *  overwriting it would leave Cancel aborting the wrong one. */
    private bindGatewayTransportIfIdle(thread: ChatThreadState, gateway: GatewayChatService): void {
        if (!thread.isStreaming && thread.status !== 'running') {
            thread.transportBackend = gateway;
        }
    }

    /** Resume a session for a thread, replacing only this thread's previous
     *  callback. historyRendered turns off the unscoped tail catch-up, which
     *  would append keyless rows of the rendered history a second time. */
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
     *  Writes are serialized and commit only while no newer persist was
     *  requested and the caller's isCurrent still holds: a stale request can
     *  call in after a newer one yet be rejected by its own checks later. */
    private async persistLastSessionKey(sessionKey: string, isCurrent?: () => boolean): Promise<void> {
        const gen = ++this.persistGeneration;
        const stale = (): boolean => gen !== this.persistGeneration || (isCurrent !== undefined && !isCurrent());
        if (stale()) {
            return;
        }
        this.lastSessionKey = sessionKey;
        const write = this.persistLastSessionKeyWrite.then(async () => {
            if (stale()) {
                return;
            }
            await this.context.workspaceState.update(ChatViewProvider.LAST_SESSION_KEY, sessionKey);
        });
        this.persistLastSessionKeyWrite = write.catch(() => undefined);
        await write;
    }

    /** Resume the persisted session after a window restart. */
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
        // Only a fresh successful sessions.list proves the key is gone; an
        // unreachable gateway must not erase the resume target for good.
        const payload = await this.refreshSessionAllowlist(gateway);
        if (payload === null) {
            log.warn('resumeLastSession: session list unavailable, keeping persisted key for the next activation');
            return;
        }
        if (!buildAgentSessionItems(payload).some(item => item.sessionKey === sessionKey)) {
            log.warn(`resumeLastSession: rejected unknown persisted session key: ${sessionKey}`);
            this.lastSessionKey = null;
            await this.context.workspaceState.update(ChatViewProvider.LAST_SESSION_KEY, undefined);
            return;
        }
        gateway.setActiveSession(sessionKey);
        const thread = this.getActiveThread();
        if (thread) {
            // Rebinding under a live send would make its resolved-key check
            // retire the run; the run's `done` flushes the deferred resume.
            if (thread.isStreaming || (thread.status as string) === 'running') {
                this.deferredResumes.set(thread.id, { sessionKey, historyRendered: false });
                return;
            }
            if (thread.sessionKey !== sessionKey) {
                this.clearSessionBoundState(thread);
            }
            thread.sessionKey = sessionKey;
            const resumeEventEpoch = thread.eventEpoch;
            const resumeBindingEpoch = thread.bindingEpoch;
            const resumeOpenGen = thread.openGeneration;
            this.bindGatewayTransportIfIdle(thread, gateway);
            let history: unknown = null;
            try {
                history = await gateway.getHistory(sessionKey);
                const restored = history === null ? null : await toTranscriptMessages(history);
                if (this.getActiveThread()?.id !== thread.id || this.lastSessionKey !== sessionKey ||
                    thread.eventEpoch !== resumeEventEpoch || thread.bindingEpoch !== resumeBindingEpoch ||
                    thread.openGeneration !== resumeOpenGen || thread.sessionKey !== sessionKey ||
                    thread.isStreaming || thread.status === 'running') {
                    if (thread.isStreaming || thread.status === 'running') {
                        // A send in flight seeds its own catch-up boundary; this
                        // older snapshot must not overwrite it.
                        if (!gateway.hasOwnedRun(sessionKey)) {
                            gateway.seedHistory(sessionKey, history);
                        }
                        this.deferredResumes.set(thread.id, { sessionKey, historyRendered: false });
                    }
                    return;
                }
                if (restored !== null) {
                    thread.messages = restored;
                }
                thread.status = 'idle';
                // Seeding makes the resume catch-up skip the restored history.
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
            // The canonical path, so a symlink swapped before the read cannot escape (TOCTOU).
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

    /** Insert an @file mention for the editor selection into the requesting
     *  webview, else the chat view the user is looking at. */
    async insertSelectionMention(requester?: vscode.Webview): Promise<void> {
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
        const target = requester ? { webview: requester, live: true } : this.revealMentionTarget();
        if (!target) {
            void vscode.window.showInformationMessage('Open the OpenClaw chat to insert the selection.');
            return;
        }
        if (target.live) {
            void target.webview.postMessage({ type: 'insertMention', mention });
            return;
        }
        this.pendingMentions.set(target.webview, [...(this.pendingMentions.get(target.webview) ?? []), mention]);
    }

    /** The focused or visible chat view, revealing a hidden one; the debug panel never takes mentions.
     *  A revealed sidebar reloads its page (no retainContextWhenHidden), so it is not live yet. */
    private revealMentionTarget(): { webview: vscode.Webview; live: boolean } | undefined {
        if (this.popOutPanel?.active) {
            return { webview: this.popOutPanel.webview, live: true };
        }
        if (this.sidebarView?.visible) {
            return { webview: this.sidebarView.webview, live: true };
        }
        if (this.popOutPanel?.visible) {
            return { webview: this.popOutPanel.webview, live: true };
        }
        if (this.sidebarView) {
            this.sidebarView.show(true);
            return { webview: this.sidebarView.webview, live: false };
        }
        if (this.popOutPanel) {
            this.popOutPanel.reveal(undefined, true);
            return { webview: this.popOutPanel.webview, live: true };
        }
        return undefined;
    }

    /** Deliver mentions queued while the webview's page was loading. */
    private flushPendingMentions(webview: vscode.Webview): void {
        const mentions = this.pendingMentions.get(webview);
        this.pendingMentions.delete(webview);
        mentions?.forEach(mention => void webview.postMessage({ type: 'insertMention', mention }));
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
