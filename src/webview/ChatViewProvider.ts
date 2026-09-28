import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { TextEncoder } from 'util';
import { ChatEvent, ChatService } from '../chat/ChatService';
import { getWebviewContent } from './content';
import { GRID_DIMENSIONS } from './content-js';
import { envWithAbsolutePath, resolveGitExecutable } from './gitExecutable';
import {
    CONTEXT_CODE_MAX_BYTES,
    SLASH_COMMANDS,
    buildSlashPrompt,
    findCommand,
    formatConversation,
    type ConversationTurn,
} from './slashCommands';
import {
    log,
    appendToolMessage,
    conversationHistory,
    enrichAttachmentsForWebview,
    gatherEditorContext,
    getThreadSnapshots as buildThreadSnapshots,
    handleFileSearch,
    openEditorFiles,
    postToAll,
    readAttachments,
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
    isMainAgentSessionKey,
    mapHistoryMessages,
    type AgentSessionItem,
} from '../core/agentPicker';
import type { HistorySnapshot, SendAttachment, SessionSummary } from '../core/gatewayProtocol/model';

export type { Recommendation } from './recommendations';

type InboundMessage = { type?: unknown; [field: string]: unknown };

const SESSIONS_GATEWAY_UNAVAILABLE = 'Gateway not connected';
const SESSIONS_LIST_FAILED = 'Could not load sessions';

function unknownSessionMessage(sessionKey: string): string {
    return `Session "${sessionKey}" is not known to the current gateway. Refresh the sessions list and reopen it.`;
}

const INTERRUPTED_RUN_MESSAGES: Record<GatewayInvalidationReason, string> = {
    identity: 'Gateway connection (URL or token) changed. The active run was interrupted; send the message again.',
    transport: 'The chat transport changed. The active run was interrupted; send the message again.',
};

const TERMINAL_TOOL_STATUSES = new Set(['done', 'error', 'failed', 'cancelled']);

/** The settings emitState reads; a change to one re-emits the state. */
const STATE_SETTINGS = ['chat.dimension', 'chat.collapseCompleted', 'chat.hideToolActivity', 'chat.models'];

/** The chat types the webview composer offers. */
const CHAT_TYPES = new Set(['chat', 'code', 'review', 'plan']);

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
    return typeof value === 'string' && GRID_DIMENSIONS.includes(value);
}

/** Restored history as transcript rows, assistant markdown rendered like live replies. */
async function toTranscriptMessages(history: HistorySnapshot): Promise<ChatMessage[]> {
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

/** A send's claim on its thread: the epoch it owns, advanced by the send's
 *  own rebases and by a gateway invalidation during its backend resolve. */
type SendTicket = {
    threadId: string;
    expectedEpoch: number;
    /** Set when Clear wiped the thread: an undispatched send then gives nothing back to it. */
    cleared: boolean;
    /** Settles once the send knows its transport: a later send on its session waits to learn whether it is gateway. */
    transportKnown: Promise<void>;
    settleTransport: () => void;
    transportSettled: boolean;
    /** Order of the send's start: of two claims on one session the earlier holds it. */
    order: number;
    /** The working folder, resolved once at the send's start: its git context, mentions and run all use it. */
    cwd: string | undefined;
};

const ATTACH_OUTSIDE_WORKSPACE = 'Attach';

/** Appended to a partial reply the user stopped. */
const CANCELLED_REPLY_MARKER = '\n\n*Stopped.*';

type SessionKeyStatus = 'known' | 'unknown' | 'unverifiable';

/** A key missing from an allowlist younger than this is unknown without refetching the list. */
const ALLOWLIST_RECHECK_MS = 3000;

const SESSION_UNVERIFIABLE_MESSAGE = 'Could not check this session with the gateway. Send the message again in a moment.';

const SEND_DURING_OPEN_MESSAGE = 'A session is being opened in this thread. Send the message again once it has loaded.';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'openclaw.chat';

    private sidebarView: vscode.WebviewView | undefined;
    private popOutPanel: vscode.WebviewPanel | undefined;
    private debugPanel: vscode.WebviewPanel | undefined;
    private editorChangeDisposable: vscode.Disposable | undefined;
    private selectionChangeDisposable: vscode.Disposable | undefined;
    private diagnosticChangeDisposable: vscode.Disposable | undefined;
    private chatConfigChangeDisposable: vscode.Disposable | undefined;
    private readonly context: vscode.ExtensionContext;
    private lastSessionKey: string | null = null;
    /** Persist generation plus a serialized write chain: overlapping selections
     *  must not let a stale workspaceState write land last. */
    private persistGeneration = 0;
    private persistLastSessionKeyWrite: Promise<void> = Promise.resolve();
    /** Main-agent keys from the last sessions.list. Webview keys are only
     *  shape-checked at the boundary; this allowlist gates rebinding. */
    private knownMainSessionKeys = new Set<string>();
    /** Gateway identity the allowlist was built from; a URL/token change invalidates it. */
    private allowlistGatewayId: string | null = null;
    /** The file of the last active text editor, kept while a chat panel has focus. */
    private lastActiveFileUri: vscode.Uri | undefined;
    /** When the allowlist was last fetched, to rate-limit refetches for a key it lacks. */
    private allowlistFetchedAt = 0;
    private resumeStarted = false;
    /** One ticket per in-flight sendPrompt backend resolution. A resolve (this
     *  thread's or another grid thread's) can invalidate the gateway mid-flight:
     *  invalidateGatewayRuns then advances a still-current ticket's expected
     *  epoch past its own bump instead of finalizing the send. */
    private readonly resolveTickets = new Set<SendTicket>();
    /** Sends between their busy mark and dispatch: a transcript `done` must not finish them. */
    private readonly preparingSends = new Set<SendTicket>();
    /** Run epoch of each thread's dispatched run until its own sink ends it. */
    private readonly dispatchedRunEpochs = new Map<string, number>();
    /** The preparing send that claimed each session key first; a later send on the key is rejected. */
    private readonly sessionClaims = new Map<string, SendTicket>();
    private sendOrder = 0;
    /** Rows of sends rejected while an open was in flight, kept until the open settles. */
    private readonly sendsRejectedDuringOpen = new Map<string, ChatMessage[]>();
    private threadCounter = 0;
    private readonly threads = new Map<string, ChatThreadState>();
    /** Persistent transcript callback per thread; reopening replaces it instead of duplicating delivery. */
    private transcriptCallbacks = new Map<string, { gateway: GatewayChatService; sessionKey: string; cb: (event: ChatEvent) => void }>();
    /** Transcript callbacks suspended while a run on the same session delivers through its run sink. */
    private suspendedTranscriptSinks = new Map<string, { gateway: GatewayChatService; sessionKey: string }>();
    /** Session key per thread whose resume waits for the send in flight at resume time to finalize. */
    private deferredResumes = new Map<string, string>();
    private chatEventQueueByThread = new Map<string, Promise<void>>();
    /** Keyed by gateway identity so a URL/token change never joins the old gateway's refresh. */
    private allowlistRefreshInFlight: Map<string, Promise<SessionSummary[] | null>> = new Map();
    /** Transient per-thread notice (e.g. cold session) shown in an empty pane, never part of the transcript. */
    private readonly threadNotices = new Map<string, string>();
    /** Status lines of a thread's latest run (a denied permission, a refusal), shown
     *  below its messages until the next turn; never part of the transcript. */
    private readonly runNotices = new Map<string, string[]>();
    private lastTransportStatus: Record<string, unknown> | null = null;
    /** Mentions for a webview whose page is (re)loading, flushed when it requests state. */
    private readonly pendingMentions = new Map<vscode.Webview, string[]>();
    /** The delayed first push to each webview; cleared when the webview or the provider goes away. */
    private readonly bootstrapTimers = new Map<vscode.Webview, ReturnType<typeof setTimeout>>();
    private visibleThreadIds: string[] = [];
    private activeThreadId = '';

    private readonly chatServiceFactory: ChatServiceFactory;

    constructor(private readonly extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
        this.context = context;
        this.chatServiceFactory = new ChatServiceFactory(
            context,
            (transport, connected, protocolVersion) => this.publishTransportStatus(transport, connected, protocolVersion),
            (reason) => this.invalidateGatewayRuns(reason)
        );
        const initialThread = this.createThreadState();
        this.threads.set(initialThread.id, initialThread);
        this.visibleThreadIds = [initialThread.id];
        this.activeThreadId = initialThread.id;

        this.editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(editor => {
            // Focusing a chat panel clears the active editor; the last file stays the working folder's hint.
            if (editor?.document.uri.scheme === 'file') {
                this.lastActiveFileUri = editor.document.uri;
            }
            this.pushRecommendations();
        });
        this.selectionChangeDisposable = vscode.window.onDidChangeTextEditorSelection(() => {
            this.pushRecommendations();
        });
        this.diagnosticChangeDisposable = vscode.languages.onDidChangeDiagnostics(() => {
            this.pushRecommendations();
        });
        // Snapshots carry models, layout and tool-activity settings: every webview must see an edit at once.
        this.chatConfigChangeDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
            if (STATE_SETTINGS.some(key => event.affectsConfiguration(`openclaw.${key}`))) {
                this.emitState();
            }
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
            this.cancelBootstrap(webviewView.webview);
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
            this.cancelBootstrap(panel.webview);
            this.popOutPanel = undefined;
        });
    }

    /** Reveals the open debug panel instead of orphaning it; true when one was already open. */
    revealDebugPanel(): boolean {
        this.debugPanel?.reveal();
        return Boolean(this.debugPanel);
    }

    attachDebugPanel(panel: vscode.WebviewPanel): void {
        this.debugPanel = panel;
        this.setupWebviewListeners(panel.webview);
        this.bootstrapWebview(panel.webview);
        panel.onDidDispose(() => {
            this.cancelBootstrap(panel.webview);
            // A newer panel may have replaced this one; its field must survive the old one's disposal.
            if (this.debugPanel === panel) {
                this.debugPanel = undefined;
            }
        });
    }

    /** A fresh thread with default settings, appended after the others. */
    newSession(): void {
        this.createThread({ activate: true });
        this.emitState();
    }

    dispose(): void {
        for (const timer of this.bootstrapTimers.values()) {
            clearTimeout(timer);
        }
        this.bootstrapTimers.clear();
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
        this.chatConfigChangeDisposable?.dispose();
        this.chatServiceFactory.dispose();
    }

    private allWebviews(): Array<vscode.Webview | undefined> {
        return [this.sidebarView?.webview, this.popOutPanel?.webview, this.debugPanel?.webview];
    }

    private publishTransportStatus(transport: 'gateway' | 'acpx', connected: boolean, protocolVersion: number | null): void {
        const name = transport === 'gateway' && protocolVersion !== null ? `gateway v${protocolVersion}` : transport;
        this.lastTransportStatus = {
            type: 'transportStatus',
            transport,
            connected,
            protocolVersion,
            label: connected ? `${name} · connected` : `${name} · offline`,
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
                case 'send': {
                    const dispatched = thread !== undefined && isNonEmptyString(msg.text) && await this.handleSend(thread, msg.text);
                    this.postSendOutcome(webview, msg, dispatched);
                    break;
                }
                case 'setChatType':
                    if (thread && typeof msg.chatType === 'string' && CHAT_TYPES.has(msg.chatType)) {
                        thread.currentChatType = msg.chatType;
                        thread.permissionState = this.getPermissionState(msg.chatType);
                        this.emitState();
                    }
                    break;
                case 'setModel':
                    // The model becomes a CLI argument: only a configured model is accepted.
                    if (thread && typeof msg.model === 'string' && this.getAvailableModels().includes(msg.model)) {
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
                case 'slashCommand': {
                    const dispatched = thread !== undefined && isNonEmptyString(msg.command) && isOptionalString(msg.text) &&
                        await this.handleSlashCommand(thread, msg.command, msg.text ?? '');
                    this.postSendOutcome(webview, msg, dispatched);
                    break;
                }
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
                    this.newSession();
                    break;
                case 'splitThread':
                    this.createThread({ inheritFromActive: true, activate: true, insertAfterActive: true });
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
                case 'requestSessions':
                    await this.handleListSessions(webview, thread?.id);
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
                        // The settings listener re-emits the state so every chat view follows the layout.
                        void Promise.resolve(vscode.workspace.getConfiguration('openclaw').update(
                            'chat.dimension',
                            msg.dimension,
                            vscode.ConfigurationTarget.Global
                        )).catch((err: unknown) => log.warn('setDimension: settings write failed', err));
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
                case 'exportThread':
                    if (thread) {
                        await this.handleExportThread(thread);
                    }
                    break;
                case 'fileSearch':
                    if (typeof msg.query === 'string') {
                        // Echoed so the webview can drop a reply for another pane or an older query.
                        await handleFileSearch(msg.query, webview, this.getWorkspaceCwd() || '', {
                            query: msg.query,
                            threadId: typeof msg.threadId === 'string' ? msg.threadId : undefined,
                        });
                    }
                    break;
                case 'attachFile':
                    // Only the file-search dropdown sends it, and it offers workspace files and open editors only.
                    if (thread && isNonEmptyString(msg.filePath) && await this.isSearchablePath(msg.filePath)) {
                        await this.addAttachments(thread, [msg.filePath]);
                    }
                    break;
                // An OS drag-and-drop may bring files from anywhere; outside the workspace the user confirms.
                case 'attachFiles': {
                    const filePaths = Array.isArray(msg.filePaths) ? msg.filePaths.filter(isNonEmptyString) : [];
                    if (thread && filePaths.length > 0) {
                        await this.addAttachments(thread, await this.confirmDroppedFiles(filePaths));
                    }
                    break;
                }
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

    /** The user's `chat.contextMax`, which beats both the model default and the agent's reported window. */
    private contextMaxOverride(): number | undefined {
        const override = vscode.workspace.getConfiguration('openclaw').get<number>('chat.contextMax');
        return override && override > 0 ? override : undefined;
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
        const override = this.contextMaxOverride();
        if (override) {
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
        // The epoch-dropped `done` would never commit the partial reply.
        this.commitPendingAssistantText(thread, { suffix: CANCELLED_REPLY_MARKER });
        settleRunToolEntries(thread, 'cancelled');
        // The epoch-dropped `done` will not restore the suspended transcript sink.
        this.restoreSuspendedTranscriptSink(thread);
        this.emitState();
    }

    private resetThread(thread: ChatThreadState): void {
        const backend = this.backendFor(thread);
        this.preparingSendsOf(thread).forEach(ticket => { ticket.cleared = true; });
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
        this.sendsRejectedDuringOpen.delete(thread.id);
        // The cleared thread must not later replay the session it had.
        this.deferredResumes.delete(thread.id);
        thread.pendingAssistantText = '';
        thread.pendingAttachments = [];
        thread.isStreaming = false;
        thread.status = 'idle';
        this.threadNotices.delete(thread.id);
        this.runNotices.delete(thread.id);
        if (!this.suspendedTranscriptSinks.get(thread.id)) {
            // The persistent callback captured the pre-bump bindingEpoch: rebind
            // it, or every later transcript event is epoch-dropped.
            const persistent = this.transcriptCallbacks.get(thread.id);
            if (persistent) {
                persistent.gateway.removeTranscriptSink(persistent.sessionKey, persistent.cb);
                const rebindEpoch = thread.bindingEpoch;
                const cb = (event: ChatEvent): void => { void this.handleChatEvent(thread.id, event, rebindEpoch, 'binding'); };
                this.transcriptCallbacks.set(thread.id, { gateway: persistent.gateway, sessionKey: persistent.sessionKey, cb });
                persistent.gateway.rebindTranscriptSink(persistent.sessionKey, cb);
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
        this.dropTranscriptCallback(thread);
        this.suspendedTranscriptSinks.delete(threadId);
        this.dispatchedRunEpochs.delete(threadId);
        this.sendsRejectedDuringOpen.delete(threadId);
        this.deferredResumes.delete(threadId);
        this.threadNotices.delete(threadId);
        this.runNotices.delete(threadId);
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
        const notAttached: string[] = [];

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
                const stat = await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
                if (options?.guard?.() === false) {
                    return;
                }
                if (stat && (stat.type & vscode.FileType.Directory)) {
                    notAttached.push(`${path.basename(filePath)} (a folder)`);
                    continue;
                }
                // The canonical spelling is what the read-time realpath check compares against.
                const canonical = await fs.promises.realpath(filePath).catch(() => filePath);
                if (options?.guard?.() === false) {
                    return;
                }
                // Re-applied to the canonical target: a symlink swap since mention parsing could escape the workspace.
                if (isMention && !(await this.isWorkspaceScoped(canonical))) {
                    notAttached.push(`${path.basename(filePath)} (outside the workspace)`);
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
                notAttached.push(`${path.basename(filePath)} (not found)`);
            }
        }

        this.reportNotAttached(notAttached);
        if (changed) {
            this.emitState();
        }
    }

    private async handleSlashCommand(
        thread: ChatThreadState,
        commandName: string,
        userText: string
    ): Promise<boolean> {
        const cmd = findCommand(commandName);
        if (!cmd) {
            // Not a command after all: send it as the text the user typed.
            return this.handleSend(thread, `/${commandName} ${userText}`.trim());
        }
        if (thread.isStreaming) {
            return false;
        }
        const displayText = `/${commandName}${userText.trim() ? ' ' + userText.trim() : ''}`;
        // Same rebind guard as handleSend: the command would target the previous session key.
        if (thread.openInFlightGen !== null) {
            log.info('handleSlashCommand: openSession in flight, command rejected');
            this.rejectSendDuringOpen(thread);
            return false;
        }
        // Marked running before the awaits so a rebind retires it and a second command sees it busy.
        const ticket = this.beginSend(thread);
        const pendingBefore = [...thread.pendingAttachments];
        this.emitState();
        try {
            const context = await gatherEditorContext(cmd.contextType, (args) => this.runGit(args, ticket.cwd));
            const mentions = await this.resolveMentions(userText, ticket.cwd);
            this.reportNotAttached(mentions.rejected);
            if (mentions.accepted.length > 0) {
                await this.addAttachments(thread, mentions.accepted, { guard: () => this.sendOwnsThread(thread, ticket) });
            }
            // /compact embeds the conversation itself, so it carries no separate history.
            const isCompact = commandName === 'compact';
            const history = isCompact ? conversationHistory(thread.messages) : [];
            const transcript = history.length > 0 ? formatConversation(history) : undefined;
            const augmented = buildSlashPrompt(commandName, userText, context, transcript);
            const attachments = [...thread.pendingAttachments];

            if (!this.sendOwnsThread(thread, ticket)) {
                log.info(`handleSlashCommand: superseded during resolution, thread=${thread.id}`);
                return false;
            }

            return await this.dispatchUserTurn(thread, ticket, displayText, augmented, attachments, pendingBefore, !isCompact);
        } catch (err) {
            this.failSend(thread, ticket, 'handleSlashCommand', err);
            return false;
        } finally {
            this.endSend(ticket);
        }
    }

    /** Git output for slash-command context, read to one byte past the context cap and then
     *  stopped: a longer diff reaches the prompt marked truncated, never as "no diff". */
    private async runGit(args: string, cwd: string | undefined): Promise<string> {
        const git = cwd ? await resolveGitExecutable() : undefined;
        if (!cwd || !git) {
            return '';
        }
        return new Promise(resolve => {
            const limit = CONTEXT_CODE_MAX_BYTES + 1;
            const chunks: Buffer[] = [];
            let size = 0;
            let settled = false;
            const finish = (output: string): void => {
                if (!settled) {
                    settled = true;
                    resolve(output);
                }
            };
            const child = spawn(git, args.split(' '), { cwd, env: envWithAbsolutePath(), stdio: ['ignore', 'pipe', 'ignore'] });
            child.stdout.on('data', (chunk: Buffer) => {
                chunks.push(chunk);
                size += chunk.length;
                if (size >= limit) {
                    child.kill();
                    finish(Buffer.concat(chunks).subarray(0, limit).toString('utf8'));
                }
            });
            child.on('error', () => finish(''));
            child.on('close', code => finish(code === 0 ? Buffer.concat(chunks).toString('utf8').trim() : ''));
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

    /** Whether the prompt was dispatched to a backend. */
    private async handleSend(thread: ChatThreadState, text: string): Promise<boolean> {
        log.info(`handleSend: thread=${thread.id}, text="${text.slice(0, 80)}"`);
        if (thread.isStreaming) {
            return false;
        }
        // An openSession is rebinding this thread: the send would target the
        // previous key and deliver into the newly opened conversation.
        if (thread.openInFlightGen !== null) {
            log.info('handleSend: openSession in flight, send rejected');
            this.rejectSendDuringOpen(thread);
            return false;
        }
        // Busy before attachment resolution; the epoch guard honours a cancel/clear during it.
        const ticket = this.beginSend(thread);
        const pendingBefore = [...thread.pendingAttachments];
        this.emitState();
        try {
            const attachments = [...pendingBefore];
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
                    await this.addAttachments(thread, [autoAttachPath], { guard: () => this.sendOwnsThread(thread, ticket) });
                    // addAttachments stores the canonical realpath.
                    const canonicalAutoAttach = await fs.promises.realpath(autoAttachPath).catch(() => autoAttachPath);
                    pushNew(thread.pendingAttachments.filter(a => a.path === canonicalAutoAttach));
                }
            }

            const mentions = await this.resolveMentions(text, ticket.cwd);
            this.reportNotAttached(mentions.rejected);
            if (mentions.accepted.length > 0) {
                // Canonical spelling and (path + range) keys, matching what addAttachments stored.
                const canonicalMentions = await Promise.all(
                    mentions.accepted.map(m =>
                        fs.promises.realpath(m.path).then(p => ({ ...m, path: p })).catch(() => m)
                    )
                );
                await this.addAttachments(thread, canonicalMentions, { guard: () => this.sendOwnsThread(thread, ticket) });
                const mentionKeys = new Set(canonicalMentions.map(mentionKey));
                pushNew(thread.pendingAttachments.filter(a => mentionKeys.has(attachmentKey(a))));
            }

            if (!this.sendOwnsThread(thread, ticket)) {
                log.info(`handleSend: superseded during attachment resolution, thread=${thread.id}`);
                return false;
            }
            return await this.dispatchUserTurn(thread, ticket, text, text, attachments, pendingBefore, true);
        } catch (err) {
            this.failSend(thread, ticket, 'handleSend', err);
            return false;
        } finally {
            this.endSend(ticket);
        }
    }

    /** Show the user row and take the attachments; a send that then does not dispatch
     *  withdraws the row and gives back the attachments that were pending before it,
     *  so the webview's restored draft resends cleanly. */
    private async dispatchUserTurn(
        thread: ChatThreadState,
        ticket: SendTicket,
        displayText: string,
        prompt: string,
        attachments: Attachment[],
        pendingBefore: Attachment[],
        /** Whether the send carries the turns before it, for transports without their own memory. */
        withHistory: boolean
    ): Promise<boolean> {
        this.commitPendingAssistantText(thread);
        this.runNotices.delete(thread.id);
        const history = withHistory ? conversationHistory(thread.messages) : [];
        const userRow: ChatMessage = { role: 'user', content: displayText };
        thread.messages.push(userRow);
        // A file attached while the send prepared stays pending for the next one.
        thread.pendingAttachments = thread.pendingAttachments.filter(a => !attachments.includes(a));
        this.maybeRenameThread(thread, displayText);
        this.emitState();
        let dispatched = false;
        try {
            dispatched = await this.sendPrompt(thread, prompt, attachments, ticket, history);
            return dispatched;
        } finally {
            if (!dispatched) {
                this.withdrawUserTurn(thread, ticket, userRow, pendingBefore);
            }
        }
    }

    private withdrawUserTurn(thread: ChatThreadState, ticket: SendTicket, userRow: ChatMessage, pendingBefore: Attachment[]): void {
        if (!this.threads.has(thread.id) || ticket.cleared) {
            return;
        }
        const index = thread.messages.lastIndexOf(userRow);
        if (index >= 0) {
            thread.messages.splice(index, 1);
        }
        const restored = pendingBefore.filter(a => !thread.pendingAttachments.includes(a));
        thread.pendingAttachments = [...restored, ...thread.pendingAttachments];
        this.emitState();
    }

    /** Commit the streamed text as its own assistant row now, in order; its markdown renders into the row.
     *  Only a run's normal `done` marks it completed: a stopped or failed partial is no /compact summary. */
    private commitPendingAssistantText(thread: ChatThreadState, options: { suffix?: string; completed?: boolean } = {}): void {
        if (!thread.pendingAssistantText) {
            return;
        }
        const row: { role: 'assistant'; content: string; html?: string; completed?: boolean } = {
            role: 'assistant',
            content: thread.pendingAssistantText + (options.suffix ?? ''),
            ...(options.completed ? { completed: true } : {}),
        };
        thread.pendingAssistantText = '';
        thread.messages.push(row);
        void renderMarkdown(row.content).then(
            html => { row.html = html; this.emitState(); },
            (err: unknown) => log.warn('rendering a reply failed', err)
        );
    }

    /** Settles the webview's pending send by its clientId: accepted once dispatched, else rejected so the draft comes back. */
    private postSendOutcome(webview: vscode.Webview, msg: InboundMessage, dispatched: boolean): void {
        void webview.postMessage({
            type: dispatched ? 'sendAccepted' : 'sendRejected',
            threadId: typeof msg.threadId === 'string' ? msg.threadId : this.activeThreadId,
            clientId: typeof msg.clientId === 'string' ? msg.clientId : undefined,
        });
    }

    /** Mark the thread busy and claim it and its session key for a send until the send dispatches. */
    private beginSend(thread: ChatThreadState): SendTicket {
        thread.isStreaming = true;
        thread.status = 'running';
        let settleTransport = (): void => undefined;
        const transportKnown = new Promise<void>(resolve => { settleTransport = resolve; });
        const ticket: SendTicket = {
            threadId: thread.id,
            expectedEpoch: thread.eventEpoch,
            cleared: false,
            cwd: this.getWorkspaceCwd(),
            transportKnown,
            settleTransport: () => {
                ticket.transportSettled = true;
                settleTransport();
            },
            transportSettled: false,
            order: ++this.sendOrder,
        };
        this.preparingSends.add(ticket);
        const sessionKey = thread.sessionKey ?? DEFAULT_SESSION_KEY;
        const holder = this.sessionClaims.get(sessionKey);
        if (!holder || !this.ticketIsLive(holder)) {
            this.sessionClaims.set(sessionKey, ticket);
        }
        return ticket;
    }

    private endSend(ticket: SendTicket): void {
        this.preparingSends.delete(ticket);
        this.releaseSessionClaim(ticket);
    }

    private releaseSessionClaim(ticket: SendTicket): void {
        for (const [sessionKey, holder] of this.sessionClaims) {
            if (holder === ticket) {
                this.sessionClaims.delete(sessionKey);
            }
        }
        ticket.settleTransport();
    }

    /** Another thread's claim holding the session. Sends claim before the gateway resolved the key,
     *  so `main` and its canonical key may carry separate claims; the earliest live one holds it. */
    private claimOnSession(gateway: GatewayChatService, sessionKey: string, threadId: string): SendTicket | undefined {
        const canonicalKey = gateway.canonicalSessionKey(sessionKey);
        const holder = [...this.sessionClaims]
            .filter(([claimedKey, claim]) => this.ticketIsLive(claim) && gateway.canonicalSessionKey(claimedKey) === canonicalKey)
            .map(([, claim]) => claim)
            .sort((a, b) => a.order - b.order)[0];
        return holder && holder.threadId !== threadId ? holder : undefined;
    }

    /** An earlier send claiming the session may still turn out to be acpx, which holds no gateway run: wait until it knows. */
    private async awaitEarlierSessionClaim(gateway: GatewayChatService, thread: ChatThreadState, sessionKey: string): Promise<void> {
        for (;;) {
            const claim = this.claimOnSession(gateway, sessionKey, thread.id);
            if (!claim || claim.transportSettled) {
                return;
            }
            await claim.transportKnown;
        }
    }

    /** An open tearing the thread down retires its preparing sends: say why they were not sent. */
    private retireSendsForOpen(thread: ChatThreadState, retired: SendTicket[]): void {
        if (retired.length > 0) {
            this.rejectSendDuringOpen(thread);
        }
    }

    private preparingSendsOf(thread: ChatThreadState): SendTicket[] {
        return [...this.preparingSends].filter(ticket => ticket.threadId === thread.id && this.sendOwnsThread(thread, ticket));
    }

    /** Cancel, clear, close, a rebind and a superseding run all bump the epoch. */
    private sendOwnsThread(thread: ChatThreadState, ticket: SendTicket): boolean {
        return this.threads.has(thread.id) && thread.eventEpoch === ticket.expectedEpoch;
    }

    private ticketIsLive(ticket: SendTicket): boolean {
        const thread = this.threads.get(ticket.threadId);
        return thread !== undefined && this.sendOwnsThread(thread, ticket);
    }

    /** Whether another thread's run, or its earlier send still preparing, holds the session. */
    private sessionBusyForOtherThread(gateway: GatewayChatService, thread: ChatThreadState, sessionKey: string): boolean {
        const claimedByOther = this.claimOnSession(gateway, sessionKey, thread.id) !== undefined;
        return claimedByOther || [...this.threads.values()].some(t =>
            t.id !== thread.id && t.status === 'running' && !this.hasPreparingSend(t) && this.boundToGatewaySession(t, sessionKey));
    }

    /** Whether a send the thread still owns has not dispatched yet. */
    private hasPreparingSend(thread: ChatThreadState): boolean {
        return this.preparingSendsOf(thread).length > 0;
    }

    /** The reason outlives the open's history restore; the text itself goes back to the draft. */
    private rejectSendDuringOpen(thread: ChatThreadState): void {
        const errorRow: ChatMessage = { role: 'error', content: SEND_DURING_OPEN_MESSAGE };
        thread.messages.push(errorRow);
        this.sendsRejectedDuringOpen.set(thread.id, [...(this.sendsRejectedDuringOpen.get(thread.id) ?? []), errorRow]);
        thread.isStreaming = false;
        thread.status = 'error';
        this.emitState();
    }

    /** Re-append sends rejected during an open after the open replaced the transcript. */
    private keepSendsRejectedDuringOpen(thread: ChatThreadState): void {
        thread.messages.push(...(this.sendsRejectedDuringOpen.get(thread.id) ?? []));
    }

    /** Finalize a send that threw, unless something else took the thread over meanwhile. */
    private failSend(thread: ChatThreadState, ticket: SendTicket, origin: string, err: unknown): void {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`${origin} failed: ${message}`);
        if (!this.sendOwnsThread(thread, ticket)) {
            return;
        }
        thread.messages.push({ role: 'error', content: `Send failed: ${message}` });
        thread.isStreaming = false;
        thread.status = 'error';
        // The send may have suspended the transcript sink, or recorded its run, before it threw.
        this.dispatchedRunEpochs.delete(thread.id);
        this.restoreSuspendedTranscriptSink(thread);
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
        prompt: string,
        attachments: Attachment[],
        ticket: SendTicket,
        history: ConversationTurn[]
    ): Promise<boolean> {
        const cwd = ticket.cwd;
        if (!cwd) {
            const errMsg = 'No workspace folder open. Open a folder to use chat.';
            thread.messages.push({ role: 'error', content: errMsg });
            thread.isStreaming = false;
            thread.status = 'error';
            this.emitState();
            return false;
        }

        this.resolveTickets.add(ticket);
        let choice;
        try {
            choice = await this.resolveServiceForSend(this.backendFor(thread));
        } finally {
            this.resolveTickets.delete(ticket);
        }
        // The resolve can take seconds: a cancel/clear/close, a superseding
        // send or a rebind (openInFlightGen) during it owns the thread now.
        const ownsThread = this.sendOwnsThread(thread, ticket);
        if (!ownsThread || thread.openInFlightGen !== null) {
            if (ownsThread) {
                log.info('sendPrompt: openSession in flight after backend resolve, send retired');
                this.rejectSendDuringOpen(thread);
            }
            if (choice.service !== thread.service &&
                !(choice.service instanceof GatewayChatService) &&
                thread.transportBackend !== choice.service) {
                choice.service.dispose();
            }
            return false;
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
                            this.transcriptCallbacks.set(thread.id, { gateway: previousBackend, sessionKey: thread.sessionKey, cb });
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
        ticket.expectedEpoch = thread.eventEpoch;
        thread.transportBackend = choice.service;
        if (!(choice.service instanceof GatewayChatService)) {
            // An acpx run holds no gateway run, so it must not keep the session from another thread's gateway send.
            this.releaseSessionClaim(ticket);
        }
        ticket.settleTransport();
        let gatewaySessionKey = DEFAULT_SESSION_KEY;
        if (choice.service instanceof GatewayChatService) {
            if (!thread.sessionKey) {
                thread.sessionKey = DEFAULT_SESSION_KEY;
            }
            // A binding learned from a previous gateway identity must not be used on this one.
            const keyStatus = await this.sessionKeyStatus(choice.service, thread.sessionKey);
            if (!this.sendOwnsThread(thread, ticket)) {
                return false;
            }
            if (keyStatus === 'unverifiable') {
                // Keep the binding: the list may be back on the next try.
                thread.isStreaming = false;
                thread.status = 'error';
                thread.messages.push({ role: 'error', content: SESSION_UNVERIFIABLE_MESSAGE });
                this.emitState();
                return false;
            }
            if (keyStatus === 'unknown') {
                const staleKey = thread.sessionKey;
                thread.eventEpoch += 1;
                thread.bindingEpoch += 1;
                this.dropTranscriptCallback(thread);
                this.suspendedTranscriptSinks.delete(thread.id);
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
                return false;
            }
            await this.awaitEarlierSessionClaim(choice.service, thread, thread.sessionKey);
            if (!this.sendOwnsThread(thread, ticket)) {
                return false;
            }
            // A second run on the session would replace the first thread's run sink.
            if (this.sessionBusyForOtherThread(choice.service, thread, thread.sessionKey)) {
                thread.messages.push({
                    role: 'error',
                    content: `Session "${thread.sessionKey}" is already streaming in another chat thread. Wait for it to finish or open a different session.`
                });
                thread.isStreaming = false;
                thread.status = 'error';
                this.emitState();
                return false;
            }
            gatewaySessionKey = thread.sessionKey;
            // The run sink delivers live events; the persistent callback would duplicate them.
            this.suspendThreadTranscriptSink(choice.service, thread);
        }
        thread.eventEpoch += 1;
        const runEpoch = thread.eventEpoch;
        ticket.expectedEpoch = runEpoch;
        // Transport-specific: the gateway takes images as send attachments, acpx
        // as ACP image blocks; the gateway's limits come from its handshake.
        let promptToSend = prompt;
        let gatewayAttachments: SendAttachment[] = [];
        let disposeAttachments: (() => Promise<void>) | undefined;
        if (attachments.length > 0) {
            const service = choice.service;
            const attachmentResult = await readAttachments(
                attachments,
                service instanceof GatewayChatService
                    ? {
                        imageMode: 'attachment',
                        basePrompt: prompt,
                        limits: service.getTransportLimits(),
                        attachmentWireBytes: (attachment) => service.attachmentWireBytes(attachment),
                    }
                    : { imageMode: 'contentBlock', basePrompt: prompt }
            );
            disposeAttachments = attachmentResult.dispose;
            // Superseded during the read: the staged images never reached a child, so release them here.
            if (!this.sendOwnsThread(thread, ticket)) {
                void disposeAttachments?.();
                return false;
            }
            promptToSend = attachmentResult.prompt ? `${attachmentResult.prompt}\n\n${prompt}` : prompt;
            gatewayAttachments = attachmentResult.attachments;
        }
        this.dispatchedRunEpochs.set(thread.id, runEpoch);
        const onEvent = (event: ChatEvent): void => {
            void this.handleChatEvent(thread.id, event, runEpoch);
        };
        if (choice.service instanceof GatewayChatService) {
            const gateway = choice.service;
            // Images travel in the send itself: nothing is staged for the gateway.
            void disposeAttachments?.();
            gateway.sendMessage({
                sessionKey: gatewaySessionKey,
                prompt: promptToSend,
                attachments: gatewayAttachments,
                onEvent,
                onSessionResolved: (resolvedKey, requestedKey) =>
                    this.applyResolvedSessionKey(thread, gateway, resolvedKey, requestedKey),
            });
            return true;
        }
        choice.service.sendMessage(
            promptToSend,
            cwd,
            thread.currentModel,
            thread.currentChatType,
            onEvent,
            undefined,
            // Staged images live until the run, and any image-less retry, completes.
            () => void disposeAttachments?.(),
            // Each acpx exec starts a fresh agent; the gateway keeps its own history.
            history
        );
        return true;
    }

    /** The gateway resolved the send's session key to its canonical form before the send went out. */
    private applyResolvedSessionKey(
        thread: ChatThreadState,
        gateway: GatewayChatService,
        resolvedKey: string,
        requestedKey: string,
    ): void {
        if (thread.sessionKey !== requestedKey) {
            this.retireSendOfSwitchedThread(thread, gateway, resolvedKey, requestedKey);
            return;
        }
        // Rebind to the resolved key so cancel/reset/close target where the run lives.
        thread.sessionKey = resolvedKey;
        const ownCallback = this.transcriptCallbacks.get(thread.id);
        if (ownCallback && ownCallback.sessionKey !== resolvedKey) {
            this.dropTranscriptCallback(thread);
        }
        const suspended = this.suspendedTranscriptSinks.get(thread.id);
        if (suspended && suspended.sessionKey === requestedKey) {
            suspended.sessionKey = resolvedKey;
        }
    }

    /** The thread was switched to another session meanwhile: retire the send instead of
     *  letting old-session output into it. */
    private retireSendOfSwitchedThread(
        thread: ChatThreadState,
        gateway: GatewayChatService,
        resolvedKey: string,
        requestedKey: string,
    ): void {
        thread.eventEpoch += 1;
        // The resolved key may host another thread's or client's run.
        const resolvedLiveOther =
            [...this.threads.values()].some(
                t => t.id !== thread.id && t.sessionKey === resolvedKey &&
                    (t.isStreaming || t.status === 'running') &&
                    this.backendFor(t) instanceof GatewayChatService
            ) ||
            [...this.suspendedTranscriptSinks].some(
                ([threadId, suspended]) => threadId !== thread.id && suspended.sessionKey === resolvedKey
            );
        if (gateway.hasOwnedRun(resolvedKey) && !resolvedLiveOther) {
            gateway.abort(resolvedKey);
        }
        if (![...this.threads.values()].some(t => t.id !== thread.id &&
            t.sessionKey === resolvedKey && this.backendFor(t) instanceof GatewayChatService)) {
            gateway.clearSessionSink(resolvedKey);
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
    }

    /** Unregister the thread's persistent transcript callback, whatever key it was bound to. */
    private dropTranscriptCallback(thread: ChatThreadState): void {
        const own = this.transcriptCallbacks.get(thread.id);
        if (!own) {
            return;
        }
        this.transcriptCallbacks.delete(thread.id);
        own.gateway.removeTranscriptSink(own.sessionKey, own.cb);
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
        this.transcriptCallbacks.set(thread.id, { gateway: suspended.gateway, sessionKey: suspended.sessionKey, cb });
        suspended.gateway.rebindTranscriptSink(suspended.sessionKey, cb);
    }

    private async flushDeferredResume(thread: ChatThreadState): Promise<void> {
        const sessionKey = this.deferredResumes.get(thread.id);
        if (!sessionKey || !this.canTakeDeferredResume(thread, sessionKey)) {
            return;
        }
        this.deferredResumes.delete(thread.id);
        const gateway = await this.resolveGateway();
        // Unavailable or unverifiable for now: keep the entry so a later run end or allowlist refresh retries.
        const status = gateway ? await this.sessionKeyStatus(gateway, sessionKey) : 'unverifiable';
        if (!this.threads.has(thread.id) || status === 'unknown') {
            return;
        }
        if (!gateway || status === 'unverifiable' || !this.canTakeDeferredResume(thread, sessionKey)) {
            if (this.deferredResumes.get(thread.id) === undefined && (thread.sessionKey ?? sessionKey) === sessionKey) {
                this.deferredResumes.set(thread.id, sessionKey);
            }
            return;
        }
        // A thread still unbound after its run (an acpx send) takes the deferred session.
        if (thread.sessionKey === undefined) {
            thread.sessionKey = sessionKey;
            this.clearSessionBoundState(thread);
            this.bindGatewayTransportIfIdle(thread, gateway);
        }
        // A deferred resume never rendered its history, so the unscoped catch-up must replay it.
        this.resumeSessionForThread(gateway, thread, sessionKey, false);
        this.emitState();
    }

    /** Idle, and bound to the deferred session or to none: binding under a live send would double-deliver alongside its run sink. */
    private canTakeDeferredResume(thread: ChatThreadState, sessionKey: string): boolean {
        return !thread.isStreaming && thread.status !== 'running' &&
            (thread.sessionKey === undefined || thread.sessionKey === sessionKey);
    }

    /** A successful allowlist refresh may clear the keys that deferred resumes wait on. */
    private flushDeferredResumes(): void {
        for (const threadId of this.deferredResumes.keys()) {
            const thread = this.threads.get(threadId);
            if (thread) {
                void this.flushDeferredResume(thread);
            }
        }
    }

    private resolveServiceForSend(existing?: ChatService | GatewayChatService): Promise<{ service: ChatService | GatewayChatService; transport: 'gateway' | 'acpx' }> {
        return this.chatServiceFactory.resolve(existing);
    }

    /** Runs before the shared gateway client retires every sink with a
     *  synthetic `done`: the epoch bumps make that `done` stale, and the sink
     *  bookkeeping goes so nothing is rebound before the allowlist re-check. */
    private invalidateGatewayRuns(reason: GatewayInvalidationReason): void {
        // A deferral checked against the previous identity must not bind on the new one.
        if (reason === 'identity') {
            this.deferredResumes.clear();
        }
        for (const thread of this.threads.values()) {
            // Every transcript callback goes with the old client: resume it once the key passes the allowlist again.
            const droppedKey = this.transcriptCallbacks.get(thread.id)?.sessionKey ?? this.suspendedTranscriptSinks.get(thread.id)?.sessionKey;
            if (droppedKey !== undefined) {
                this.deferredResumes.set(thread.id, droppedKey);
            }
            const backend = this.backendFor(thread);
            if (!(backend instanceof GatewayChatService)) {
                // A session callback kept across an acpx fallback is retired too; a later
                // clear must not rebind it on the new identity without the allowlist check.
                thread.bindingEpoch += 1;
                this.transcriptCallbacks.delete(thread.id);
                this.suspendedTranscriptSinks.delete(thread.id);
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
        // The thread's own run owns the transcript until it ends, as a suspended gateway sink would.
        if (epochScope === 'binding' && this.dispatchedRunEpochs.get(threadId) === thread.eventEpoch) {
            log.info(`handleChatEvent: dropping transcript ${event.type} during the thread's own run, thread=${threadId}`);
            return;
        }
        log.info(`handleChatEvent: type=${event.type}, thread=${threadId}`);
        this.threadNotices.delete(threadId);

        switch (event.type) {
            case 'text':
                thread.pendingAssistantText += event.text;
                // The webview queues a send only for a thread it knows is streaming.
                if (!thread.isStreaming) {
                    thread.isStreaming = true;
                    thread.status = 'running';
                    this.emitState();
                    break;
                }
                thread.status = 'running';
                postToAll(this.allWebviews(), {
                    type: 'textUpdate',
                    threadId: thread.id,
                    text: thread.pendingAssistantText,
                });
                break;
            case 'toolCall':
                // Text before a tool call stays its own row above the tool group.
                this.commitPendingAssistantText(thread);
                appendToolMessage(thread, {
                    title: event.title,
                    status: event.status,
                    details: event.details,
                    ...(event.id != null ? { id: event.id } : {})
                });
                this.emitState();
                break;
            case 'done':
                this.commitPendingAssistantText(thread, { completed: true });
                if (this.isTranscriptEventDuringSend(thread, epochScope)) {
                    this.emitState();
                    break;
                }
                thread.isStreaming = false;
                // A `done` from abort() or teardown must not upgrade a stopped thread.
                if (thread.status !== 'error' && thread.status !== 'cancelled' && thread.status !== 'idle') {
                    thread.status = 'complete';
                }
                // Transcript replay emits `done` per final row while an external run may still use its tools.
                if (epochScope === 'run') {
                    settleRunToolEntries(thread, 'done');
                    this.dispatchedRunEpochs.delete(thread.id);
                }
                this.restoreSuspendedTranscriptSink(thread);
                this.updateThreadSubjectFromContext(thread);
                this.emitState();
                void this.flushDeferredResume(thread);
                break;
            case 'notice':
                this.addRunNotice(thread.id, event.text);
                this.emitState();
                break;
            case 'usage':
                thread.lastUsage = event.usage;
                // The gateway reports no context size of its own; acpx fills the meter from `contextUsage`.
                if (epochScope === 'binding' || this.backendFor(thread) instanceof GatewayChatService) {
                    thread.contextTokens = event.usage.totalTokens;
                }
                this.emitState();
                break;
            case 'contextUsage':
                thread.contextTokens = event.usedTokens;
                if (event.windowTokens !== undefined && !this.contextMaxOverride()) {
                    thread.contextMax = event.windowTokens;
                }
                this.emitState();
                break;
            case 'error':
                if (epochScope === 'run') {
                    settleRunToolEntries(thread, 'cancelled');
                    this.dispatchedRunEpochs.delete(thread.id);
                }
                // The partial answer stays above the error that cut it off.
                this.commitPendingAssistantText(thread);
                thread.messages.push({ role: 'error', content: event.message });
                if (this.isTranscriptEventDuringSend(thread, epochScope)) {
                    this.emitState();
                    break;
                }
                thread.isStreaming = false;
                thread.status = 'error';
                this.restoreSuspendedTranscriptSink(thread);
                this.emitState();
                void this.flushDeferredResume(thread);
                break;
        }
    }

    /** A transcript `done`/`error` belongs to the session, not to the thread's own
     *  send still being prepared: it shows, but must not end that send. */
    private isTranscriptEventDuringSend(thread: ChatThreadState, epochScope: 'run' | 'binding'): boolean {
        return epochScope === 'binding' && this.hasPreparingSend(thread);
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
                .map(snapshot => ({
                    ...snapshot,
                    notice: this.threadNotices.get(snapshot.id),
                    runNotices: this.runNotices.get(snapshot.id) ?? [],
                }));
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
        this.cancelBootstrap(webview);
        this.bootstrapTimers.set(webview, setTimeout(() => {
            this.bootstrapTimers.delete(webview);
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
        }, 100));
        if (!this.resumeStarted) {
            this.resumeStarted = true;
            void this.resumeLastSession().catch(err => {
                log.warn('resumeLastSession: failed to resume last session', err);
            });
        }
    }

    private cancelBootstrap(webview: vscode.Webview): void {
        clearTimeout(this.bootstrapTimers.get(webview));
        this.bootstrapTimers.delete(webview);
    }

    /** Command-palette agent picker, opened into the thread active when invoked. */
    async showAgentPicker(): Promise<void> {
        const thread = this.getActiveThread();
        const gateway = await this.resolveGateway();
        if (!gateway) {
            void vscode.window.showWarningMessage(SESSIONS_GATEWAY_UNAVAILABLE);
            return;
        }
        // Listed through the allowlist refresh, so a session newer than the last list passes the open's key check.
        const picker = new AgentPicker({ listSessions: async () => (await this.refreshSessionAllowlist(gateway)) ?? [] }, {
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
    private async handleListSessions(webview: vscode.Webview, threadId: string | undefined): Promise<void> {
        const reply = (sessions: AgentSessionItem[], error?: string): void => {
            void webview.postMessage({ type: 'sessionsList', sessions, error, threadId });
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
    private async refreshSessionAllowlist(gateway: GatewayChatService): Promise<SessionSummary[] | null> {
        const identity = gateway.getGatewayIdentity();
        const existing = this.allowlistRefreshInFlight.get(identity);
        if (existing) {
            return existing;
        }
        // Only this run is stored under the identity until it settles.
        const run = this.runAllowlistRefresh(gateway).finally(() => this.allowlistRefreshInFlight.delete(identity));
        this.allowlistRefreshInFlight.set(identity, run);
        return run;
    }

    /** The fresh session list, or null when none could be trusted: a
     *  response that raced a gateway identity change is discarded and retried once. */
    private async runAllowlistRefresh(gateway: GatewayChatService): Promise<SessionSummary[] | null> {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const identityBefore = gateway.getGatewayIdentity();
            try {
                const payload = await gateway.listSessions();
                if (gateway.getGatewayIdentity() !== identityBefore) {
                    continue;
                }
                this.allowlistGatewayId = identityBefore;
                this.allowlistFetchedAt = Date.now();
                this.knownMainSessionKeys = new Set(
                    buildAgentSessionItems(payload).map(item => item.sessionKey)
                );
                this.flushDeferredResumes();
                return payload;
            } catch (err) {
                log.warn('session allowlist refresh failed', err);
                return null;
            }
        }
        return null;
    }

    private async isKnownMainSessionKey(gateway: GatewayChatService, sessionKey: string): Promise<boolean> {
        return (await this.sessionKeyStatus(gateway, sessionKey)) === 'known';
    }

    /** The key against the current gateway's allowlist, refetched (at most every
     *  few seconds) for a key it lacks. The default alias needs no
     *  listing: the gateway resolves it and the send ack names the canonical key.
     *  A list that cannot be fetched leaves the key unverifiable, not unknown. */
    private async sessionKeyStatus(gateway: GatewayChatService, sessionKey: string): Promise<SessionKeyStatus> {
        if (sessionKey === DEFAULT_SESSION_KEY) {
            return 'known';
        }
        const gatewayId = gateway.getGatewayIdentity();
        if (this.allowlistGatewayId !== gatewayId) {
            this.allowlistGatewayId = null;
            this.knownMainSessionKeys = new Set<string>();
        }
        if (this.knownMainSessionKeys.has(sessionKey)) {
            return 'known';
        }
        // The key may name a session created since the last list: refetch before calling it unknown.
        const listIsFresh = this.allowlistGatewayId !== null && Date.now() - this.allowlistFetchedAt < ALLOWLIST_RECHECK_MS;
        if (!listIsFresh && (await this.refreshSessionAllowlist(gateway)) === null) {
            return 'unverifiable';
        }
        return this.knownMainSessionKeys.has(sessionKey) ? 'known' : 'unknown';
    }

    /** Whether another gateway-backed thread runs on the key; acpx threads own no gateway run. */
    private otherRunningGatewayThread(excludeThreadId: string, sessionKey: string | undefined): boolean {
        if (!sessionKey) {
            return false;
        }
        for (const t of this.threads.values()) {
            if (t.id !== excludeThreadId && t.status === 'running' && this.boundToGatewaySession(t, sessionKey)) {
                return true;
            }
        }
        return false;
    }

    /** Whether the thread runs on the gateway bound to the key's session; `main` and its canonical key are one session. */
    private boundToGatewaySession(thread: ChatThreadState, sessionKey: string): boolean {
        const backend = this.backendFor(thread);
        return thread.sessionKey !== undefined && backend instanceof GatewayChatService &&
            backend.canonicalSessionKey(thread.sessionKey) === backend.canonicalSessionKey(sessionKey);
    }

    /** Whether another thread (or its suspended sink) is bound to the key, so its sink must survive. */
    private otherThreadsOnKey(excludeThreadId: string, sessionKey: string): boolean {
        for (const t of this.threads.values()) {
            if (t.id !== excludeThreadId && this.boundToGatewaySession(t, sessionKey)) {
                return true;
            }
        }
        for (const [threadId, suspended] of this.suspendedTranscriptSinks) {
            const { gateway } = suspended;
            if (threadId !== excludeThreadId && gateway.canonicalSessionKey(suspended.sessionKey) === gateway.canonicalSessionKey(sessionKey)) {
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
        try {
            const gateway = await this.resolveGateway();
            if (!gateway) {
                this.reportOpenFailure(thread, openGen, `Could not open session "${sessionKey}": ${SESSIONS_GATEWAY_UNAVAILABLE}.`);
                return;
            }
            if (!(await this.isKnownMainSessionKey(gateway, sessionKey))) {
                log.warn('openSession: rejected unknown session key', sessionKey);
                this.reportOpenFailure(thread, openGen, unknownSessionMessage(sessionKey));
                return;
            }
            if (!this.isCurrentOpen(thread, openGen)) {
                return;
            }
            await this.openSessionRebinding(thread, sessionKey, gateway, openGen);
        } finally {
            if (thread.openInFlightGen === openGen) {
                thread.openInFlightGen = null;
                this.sendsRejectedDuringOpen.delete(thread.id);
            }
        }
    }

    private isCurrentOpen(thread: ChatThreadState, openGen: number): boolean {
        return this.threads.has(thread.id) && thread.openGeneration === openGen;
    }

    /** A rejected open still owning the thread says why, instead of leaving the click unanswered. */
    private reportOpenFailure(thread: ChatThreadState, openGen: number, content: string): void {
        if (!this.isCurrentOpen(thread, openGen)) {
            return;
        }
        thread.messages.push({ role: 'error', content });
        this.emitState();
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
        const preparingSends = this.preparingSendsOf(thread);
        // A running acpx run leaves no `done` after abort: clear streaming
        // state here or every later send is rejected as busy.
        if (thread.status === 'running' && !(previousBackend instanceof GatewayChatService)) {
            thread.eventEpoch += 1;
            thread.bindingEpoch += 1;
            previousBackend.abort();
            thread.isStreaming = false;
            thread.pendingAssistantText = '';
            thread.status = 'idle';
            settleRunToolEntries(thread, 'cancelled');
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
            settleRunToolEntries(thread, 'cancelled');
        }
        // The teardown above bumped the epoch those sends owned.
        this.retireSendsForOpen(thread, preparingSends.filter(ticket => !this.sendOwnsThread(thread, ticket)));
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
            this.transcriptCallbacks.set(thread.id, { gateway: gatewayBackend, sessionKey: persistent.sessionKey, cb });
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
            this.reportOpenFailure(thread, openGen, unknownSessionMessage(sessionKey));
            return;
        }
        if (rebounded) {
            this.clearSessionBoundState(thread);
        }
        thread.sessionKey = sessionKey;
        // From here the previous binding is never restored: a later reset or
        // close must not resubscribe or leak the previous session's callback.
        const previousCallback = this.transcriptCallbacks.get(thread.id);
        if (previousCallback && previousCallback.sessionKey !== sessionKey) {
            this.transcriptCallbacks.delete(thread.id);
            gateway.removeTranscriptSink(previousCallback.sessionKey, previousCallback.cb);
        }

        // Reopening the bound session mid-run keeps the live transcript and
        // callback; this must precede the cold branch, which clears the thread.
        if (thread.isStreaming || thread.status === 'running') {
            this.postAgentSelected(sessionKey);
            return;
        }

        let label = sessionKey;
        try {
            const sessions: SessionSummary[] = await gateway.listSessions();
            if (!this.isCurrentOpen(thread, openGen) || thread.sessionKey !== sessionKey) {
                return;
            }
            const row = sessions.find(r => r.key === sessionKey);
            if (row) {
                label = row.label ?? row.agentId ?? sessionKey;
                if (row.cold) {
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
            return;
        }
        this.bindGatewayTransportIfIdle(thread, gateway);
        if (restored !== null) {
            // Seeding makes the resume catch-up skip what was just restored.
            gateway.seedHistory(sessionKey, history);
            thread.title = label;
            thread.messages = restored;
            this.keepSendsRejectedDuringOpen(thread);
            thread.status = 'idle';
        } else if (rebounded) {
            // Never show the previous session's transcript under the new key;
            // a same-key reopen keeps its transcript on transport errors.
            thread.messages = [];
            thread.messages.push({
                role: 'assistant',
                content: 'Failed to load session history. Reopen the session to retry.'
            });
            this.keepSendsRejectedDuringOpen(thread);
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
        this.keepSendsRejectedDuringOpen(thread);
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
        this.runNotices.delete(thread.id);
    }

    /** Adds a run notice, once: a retried run may report the same status again. */
    private addRunNotice(threadId: string, text: string): void {
        const notices = this.runNotices.get(threadId) ?? [];
        if (!notices.includes(text)) {
            this.runNotices.set(threadId, [...notices, text]);
        }
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
        this.transcriptCallbacks.set(thread.id, { gateway, sessionKey, cb });
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
        const write = this.persistLastSessionKeyWrite.then(async () => {
            if (stale()) {
                return;
            }
            await this.context.workspaceState.update(ChatViewProvider.LAST_SESSION_KEY, sessionKey);
            // Only a committed write names the last session; a skipped one leaves the previous choice.
            this.lastSessionKey = sessionKey;
        });
        this.persistLastSessionKeyWrite = write.catch(() => undefined);
        await write;
    }

    /** Erase a persisted key proven stale, unless a newer selection was persisted meanwhile. */
    private async erasePersistedSessionKey(staleKey: string): Promise<void> {
        const write = this.persistLastSessionKeyWrite.then(async () => {
            if (this.lastSessionKey !== null && this.lastSessionKey !== staleKey) {
                return;
            }
            this.lastSessionKey = null;
            await this.context.workspaceState.update(ChatViewProvider.LAST_SESSION_KEY, undefined);
        });
        this.persistLastSessionKeyWrite = write.catch(() => undefined);
        await write;
    }

    /** Resume the persisted session after a window restart, unless the user
     *  chose a session or bound the thread while the gateway resolved. */
    private async resumeLastSession(): Promise<void> {
        const sessionKey = this.context.workspaceState.get<string>(ChatViewProvider.LAST_SESSION_KEY);
        if (!sessionKey) {
            return;
        }
        if (!isMainAgentSessionKey(sessionKey)) {
            log.warn(`resumeLastSession: persisted key failed main-agent validation, ignoring: ${sessionKey}`);
            await this.erasePersistedSessionKey(sessionKey);
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
            await this.erasePersistedSessionKey(sessionKey);
            return;
        }
        const thread = this.getActiveThread();
        const boundElsewhere = thread?.sessionKey !== undefined && thread.sessionKey !== sessionKey;
        if (!thread || this.lastSessionKey !== sessionKey || thread.openInFlightGen !== null || boundElsewhere) {
            log.info('resumeLastSession: superseded by a newer session choice');
            return;
        }
        // Rebinding under a live send would make its resolved-key check
        // retire the run; the run's `done` flushes the deferred resume.
        if (thread.isStreaming || thread.status === 'running') {
            this.deferredResumes.set(thread.id, sessionKey);
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
        const history = await gateway.getHistory(sessionKey);
        const restored = history === null ? null : await toTranscriptMessages(history);
        if (!this.threads.has(thread.id)) {
            return;
        }
        // Widened: the pre-await check narrowed the union.
        const resumedStatus: string = thread.status;
        if (thread.isStreaming || resumedStatus === 'running') {
            // A send in flight seeds its own catch-up boundary; this
            // older snapshot must not overwrite it.
            if (!gateway.hasOwnedRun(sessionKey)) {
                gateway.seedHistory(sessionKey, history);
            }
            this.deferredResumes.set(thread.id, sessionKey);
            return;
        }
        // A cancel, clear or open since the fetch owns the thread now.
        if (thread.eventEpoch !== resumeEventEpoch || thread.bindingEpoch !== resumeBindingEpoch ||
            thread.openGeneration !== resumeOpenGen || thread.sessionKey !== sessionKey) {
            return;
        }
        if (restored !== null) {
            thread.messages = restored;
        }
        thread.status = 'idle';
        // Seeding makes the resume catch-up skip the restored history.
        gateway.seedHistory(sessionKey, history);
        this.resumeSessionForThread(gateway, thread, sessionKey, history !== null);
        this.emitState();
    }

    /** Absolute fsPath of the active editor file, if any. */
    private async getActiveEditorFilePath(): Promise<string | undefined> {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== 'file') {
            return undefined;
        }
        return editor.document.uri.fsPath;
    }

    /** Resolve @file mentions to workspace-scoped real paths; symlink escapes and
     *  missing targets are rejected, with the reason, before an attachment is accepted. */
    private async resolveMentions(text: string, cwd: string | undefined): Promise<{ accepted: FileMention[]; rejected: string[] }> {
        const accepted: FileMention[] = [];
        const rejected: string[] = [];
        for (const mention of parseFileMentions(text)) {
            const real = await this.firstExistingRealpath(this.mentionCandidates(mention.path, cwd));
            if (!real) {
                rejected.push(`${mention.path} (not found)`);
            } else if (await this.isWorkspaceScoped(real)) {
                // The canonical path, so a symlink swapped before the read cannot escape (TOCTOU).
                accepted.push({ ...mention, path: real });
            } else {
                rejected.push(`${mention.path} (outside the workspace)`);
            }
        }
        return { accepted, rejected };
    }

    /** Where a mentioned path may live: as given when absolute, else under the working folder,
     *  then (multi-root only, as asRelativePath writes it) under the root its folder-name prefix
     *  names, then under the other roots. */
    private mentionCandidates(mentionPath: string, cwd: string | undefined): string[] {
        if (path.isAbsolute(mentionPath)) {
            return [path.resolve(mentionPath)];
        }
        const folders = vscode.workspace.workspaceFolders ?? [];
        const [head, ...rest] = mentionPath.split(/[\\/]/);
        const prefixed = folders.length > 1 && rest.length > 0
            ? folders.filter(folder => folder.name === head).map(folder => path.resolve(folder.uri.fsPath, ...rest))
            : [];
        const roots = [cwd, ...folders.map(folder => folder.uri.fsPath).filter(root => root !== cwd)]
            .filter((root): root is string => root !== undefined);
        const [cwdCandidate, ...otherRoots] = roots.map(root => path.resolve(root, mentionPath));
        return [cwdCandidate, ...prefixed, ...otherRoots].filter((candidate): candidate is string => candidate !== undefined);
    }

    private async firstExistingRealpath(candidates: string[]): Promise<string | null> {
        for (const candidate of candidates) {
            const real = await fs.promises.realpath(candidate).catch(() => null);
            if (real) {
                return real;
            }
        }
        return null;
    }

    /** Whether a canonical absolute path sits inside a workspace folder.
     *  Callers must pass an already-canonical path: resolving symlinks is
     *  part of the boundary check, not left to the caller. */
    private async isWorkspaceScoped(canonical: string): Promise<boolean> {
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const root = await fs.promises.realpath(folder.uri.fsPath).catch(() => folder.uri.fsPath);
            const rel = path.relative(root, canonical);
            if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
                return true;
            }
        }
        return false;
    }

    /** The dropped paths to attach: a compromised webview could name any file (say ~/.ssh), so
     *  paths outside every workspace folder need the user's approval, asked once per drop. */
    private async confirmDroppedFiles(filePaths: string[]): Promise<string[]> {
        const outside: string[] = [];
        for (const filePath of filePaths) {
            const canonical = await fs.promises.realpath(filePath).catch(() => filePath);
            if (!(await this.isWorkspaceScoped(canonical))) {
                outside.push(filePath);
            }
        }
        if (outside.length === 0) {
            return filePaths;
        }
        const choice = await vscode.window.showWarningMessage(
            'Attach files from outside the workspace?',
            { modal: true, detail: outside.join('\n') },
            { title: ATTACH_OUTSIDE_WORKSPACE }
        );
        return choice?.title === ATTACH_OUTSIDE_WORKSPACE ? filePaths : filePaths.filter(filePath => !outside.includes(filePath));
    }

    /** Shown, never put in the prompt: why a mentioned, picked or dropped file was left out. */
    private reportNotAttached(notes: string[]): void {
        if (notes.length > 0) {
            void vscode.window.showWarningMessage(`Not attached: ${notes.join(', ')}`);
        }
    }

    /** Whether the file-search dropdown could have offered the path: a workspace file or an open editor document. */
    private async isSearchablePath(filePath: string): Promise<boolean> {
        const canonical = await fs.promises.realpath(filePath).catch(() => null);
        if (canonical === null) {
            return false;
        }
        const openInEditor = openEditorFiles('').some(file => file.path === filePath);
        return openInEditor || this.isWorkspaceScoped(canonical);
    }

    /** Insert an @file mention for the editor selection into the chat view the user is looking at. */
    async insertSelectionMention(): Promise<void> {
        const context = await gatherEditorContext('selection', (args) => this.runGit(args, this.getWorkspaceCwd()));
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
        const target = this.revealMentionTarget();
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

    /** The working folder for runs, git and file search: the innermost workspace folder holding
     *  the active editor's file, or the last one active while a chat panel has focus, else the first folder. */
    private getWorkspaceCwd(): string | undefined {
        const activeFile = this.activeFileUri();
        const activeFolder = activeFile ? vscode.workspace.getWorkspaceFolder(activeFile) : undefined;
        return (activeFolder ?? vscode.workspace.workspaceFolders?.[0])?.uri.fsPath;
    }

    private activeFileUri(): vscode.Uri | undefined {
        const active = vscode.window.activeTextEditor?.document.uri;
        return active?.scheme === 'file' ? active : this.lastActiveFileUri;
    }
}

/** Stable dedupe key for an attachment or mention: path plus 1-based range. */
function attachmentKey(a: { path: string; lineStart?: number; lineEnd?: number }): string {
    return `${a.path}\u0000${a.lineStart ?? ''}\u0000${a.lineEnd ?? a.lineStart ?? ''}`;
}

const mentionKey = attachmentKey;
