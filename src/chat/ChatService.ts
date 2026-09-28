import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { childEnv, resolveAcpxLaunch, AcpxLaunch } from './acpxLauncher';
import { checkProjectConfig, ProjectConfigCheck, requestProjectConfigApproval } from './acpxProjectConfig';
import { PROMPT_IMAGE_MARKER, PromptImage, stagedPromptImage } from './promptImages';
import { ConversationTurn, escapeXmlAttr, formatConversation, frameConversation } from '../webview/slashCommands';

const log = vscode.window.createOutputChannel('OpenClaw Agent', { log: true });

/** Largest encoded prompt (the ACP content-block JSON) acpx is sent on
 *  stdin: acpx forwards it inside one JSON-RPC line, and the ACP SDK drops any
 *  message over 32 MiB, so the rest is headroom for the envelope. */
export const PROMPT_MAX_BYTES = 30 * 1024 * 1024;

/** Longest start of a dropped oversized line kept to learn its request id and method. */
const DROPPED_LINE_PREFIX_CHARS = 256;

/** A stdout line still missing its newline past this size is dropped
 *  instead of growing the buffer without bound. */
export const STDOUT_LINE_MAX_CHARS = 16 * 1024 * 1024;

/** Stderr only surfaces as a failure message, so only its tail is kept. */
export const STDERR_TAIL_MAX_CHARS = 16 * 1024;

/** How long an aborted acpx gets after SIGTERM before it is SIGKILLed. */
export const ABORT_KILL_GRACE_MS = 3000;

/** acpx top-level verbs: an agent positional spelled like one would run that command instead. */
const ACPX_VERBS = new Set(['prompt', 'exec', 'cancel', 'compare', 'flow', 'set-mode', 'set', 'sessions', 'status', 'config', 'help']);

/** The `openclaw.chat.agent` default, used when no agent is chosen. */
const DEFAULT_AGENT = 'codex';

/** An agent name cannot start with `-`, so it never parses as an acpx flag. */
const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const ACPX_NOT_FOUND_MESSAGE = 'acpx not found. Install it with: npm i -g acpx';
const NODE_NOT_FOUND_MESSAGE = 'Node.js not found on PATH; acpx needs it to run. Install Node.js from https://nodejs.org.';

/** acpx's exit code when it denied or cancelled every permission the agent asked for. */
const ACPX_PERMISSION_DENIED_EXIT = 5;
const PERMISSIONS_DENIED_NOTICE = 'Some tool permissions were denied.';
const IMAGES_NOT_SENT_NOTICE = 'This agent does not accept images, so they were sent as notes instead.';
const PROJECT_CONFIG_CHANGED_MESSAGE = 'Chat did not start: this workspace\'s .acpxrc.json changed after it was approved. Send again to review it.';
const PROJECT_CONFIG_REFUSED_MESSAGE = 'Chat did not start: this workspace\'s .acpxrc.json was not approved. It can change the commands acpx runs for agents and MCP servers.';

/** Permission modes from least to most restrictive. */
const PERMISSION_STRICTNESS = ['approve-all', 'approve-reads', 'deny-all'];

/** Longest ACP error detail kept in a failure message. */
const ERROR_DETAILS_MAX_CHARS = 1000;

/** acpx's detail code for a prompt block the agent's capabilities rule out. */
const UNSUPPORTED_PROMPT_CONTENT = 'UNSUPPORTED_PROMPT_CONTENT';

/** A request line's opening as acpx prints it, enough to recover a dropped line's id and method. */
const REQUEST_PREFIX_PATTERN = /^\s*\{"jsonrpc":"2\.0","id":(-?\d+|"(?:[^"\\]|\\.)*"),"method":"([^"\\]+)"/;

/** Whether `method` is one the agent calls on acpx; acpx prints both
 *  directions without saying which, and ids restart from 0 in each. */
function isAgentMethod(method: string): boolean {
    return method.startsWith('fs/') || method.startsWith('terminal/')
        || method === 'session/request_permission' || method === 'session/update';
}

/** A JSON-RPC id as a map key, or undefined for null and malformed ids. */
function requestKey(id: unknown): string | undefined {
    if (typeof id === 'string') {
        return `s:${id}`;
    }
    return typeof id === 'number' && Number.isFinite(id) ? `n:${id}` : undefined;
}

export type UsageInfo = {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
};

export type ChatEvent =
    | { type: 'text'; text: string }
    | { type: 'toolCall'; title: string; status: string; details: string; id?: string }
    /** One turn's token counts, for the per-turn usage readout. */
    | { type: 'usage'; usage: UsageInfo }
    /** How full the agent's context window is now; `windowTokens` is its size when known. */
    | { type: 'contextUsage'; usedTokens: number; windowTokens?: number }
    /** A status line for the user, never part of the assistant's answer. */
    | { type: 'notice'; text: string }
    | { type: 'done' }
    | { type: 'error'; message: string };

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A positive token count, or undefined for anything else. */
function tokenCount(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseJsonRecord(text: string): JsonRecord | undefined {
    try {
        return asRecord(JSON.parse(text));
    } catch {
        return undefined;
    }
}

function stringifyToolEvent(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return '[unserializable tool event]';
    }
}

/** What the user is told when a turn stops short of `end_turn`; `cancelled` is our own abort. */
const STOP_REASON_NOTICES: Record<string, string> = {
    refusal: 'The agent refused to answer this request.',
    max_tokens: 'Stopped: output limit reached.',
    max_turn_requests: 'Stopped: turn request limit reached.',
};

/** The prompt turn's usage (ACP `Usage`) and a notice for a short stop. */
function promptResultEvents(stopReason: string, usage: JsonRecord | undefined): ChatEvent[] {
    const events: ChatEvent[] = [];
    const inputTokens = tokenCount(usage?.inputTokens) ?? 0;
    const outputTokens = tokenCount(usage?.outputTokens) ?? 0;
    // ACP's total also counts cached and thought tokens, which the two parts leave out.
    const totalTokens = tokenCount(usage?.totalTokens) ?? inputTokens + outputTokens;
    if (totalTokens > 0) {
        events.push({ type: 'usage', usage: { promptTokens: inputTokens, completionTokens: outputTokens, totalTokens } });
    }
    const notice = Object.prototype.hasOwnProperty.call(STOP_REASON_NOTICES, stopReason) ? STOP_REASON_NOTICES[stopReason] : undefined;
    if (notice !== undefined) {
        events.push({ type: 'notice', text: notice });
    }
    return events;
}

/** ACP `usage_update`: `used` tokens are in a context window of `size`. */
function contextUsage(update: JsonRecord): ChatEvent | null {
    const usedTokens = tokenCount(update.used);
    if (usedTokens === undefined) {
        return null;
    }
    const windowTokens = tokenCount(update.size);
    return windowTokens === undefined ? { type: 'contextUsage', usedTokens } : { type: 'contextUsage', usedTokens, windowTokens };
}

/** ACP tool-call statuses in the webview's vocabulary. */
const ACP_TOOL_STATUS: Record<string, string> = {
    pending: 'running',
    in_progress: 'running',
    completed: 'done',
    failed: 'error',
};

/** Maps acpx `--format json` lines onto chat events. acpx prints raw ACP
 *  JSON-RPC traffic (both directions). Every field is untrusted. */
class AcpxEventParser {
    /** Each ACP tool call merged with its updates, which carry only what changed. */
    private readonly toolCalls = new Map<string, JsonRecord>();
    /** Methods of acpx's pending requests to the agent, by id. */
    private readonly acpxRequests = new Map<string, string>();
    /** Ids of the agent's pending requests to acpx. */
    private readonly agentRequests = new Set<string>();
    private promptError: string | undefined;
    private acpxError: string | undefined;
    private lastError: string | undefined;
    /** Whether the prompt turn returned its stop reason: the answer is complete. */
    promptCompleted = false;
    /** Whether acpx refused a prompt block (an image) the agent cannot take. */
    rejectedPromptContent = false;

    /** Why the run failed by the JSON-RPC traffic, for a non-zero exit to report:
     *  the prompt turn's error, else acpx's own (null id), else the last one. */
    get failureMessage(): string | undefined {
        return this.promptError ?? this.acpxError ?? this.lastError;
    }

    /** The chat events one stdout line carries; anything but JSON-RPC is logged and dropped. */
    parseLine(line: string): ChatEvent[] {
        const trimmed = line.trim();
        if (!trimmed) {
            return [];
        }
        const record = parseJsonRecord(trimmed);
        if (record?.jsonrpc !== '2.0') {
            log.warn(`ignoring a non-JSON-RPC acpx output line (${trimmed.length} chars)`);
            return [];
        }
        return this.mapJsonRpc(record);
    }

    /** Records the request an oversized, dropped line opened, so its reply still matches. */
    noteDroppedLine(prefix: string): void {
        const match = REQUEST_PREFIX_PATTERN.exec(prefix);
        if (match) {
            this.trackRequest(JSON.parse(match[1]) as unknown, match[2]);
        }
    }

    private mapJsonRpc(message: JsonRecord): ChatEvent[] {
        if (typeof message.method !== 'string') {
            return this.mapResponse(message);
        }
        this.trackRequest(message.id, message.method);
        const event = message.method === 'session/update'
            ? this.mapSessionUpdate(asRecord(asRecord(message.params)?.update))
            : null;
        return event === null ? [] : [event];
    }

    private trackRequest(id: unknown, method: string): void {
        const key = requestKey(id);
        if (key === undefined) {
            return;
        }
        if (isAgentMethod(method)) {
            this.agentRequests.add(key);
        } else {
            this.acpxRequests.set(key, method);
        }
    }

    private mapResponse(message: JsonRecord): ChatEvent[] {
        const key = requestKey(message.id);
        const result = asRecord(message.result);
        // Only the prompt turn's result carries a stop reason.
        if (result && typeof result.stopReason === 'string') {
            this.promptCompleted = true;
            this.forgetRequest(key);
            return promptResultEvents(result.stopReason, asRecord(result.usage));
        }
        // acpx answering the agent: a failed file read is the agent's to recover from.
        if (key !== undefined && this.agentRequests.delete(key)) {
            return [];
        }
        const method = this.forgetRequest(key);
        const error = asRecord(message.error);
        if (error) {
            // Surfaced only if acpx then exits non-zero.
            this.recordError(message.id, method, error);
        }
        return [];
    }

    private forgetRequest(key: string | undefined): string | undefined {
        if (key === undefined) {
            return undefined;
        }
        const method = this.acpxRequests.get(key);
        this.acpxRequests.delete(key);
        return method;
    }

    private mapSessionUpdate(update: JsonRecord | undefined): ChatEvent | null {
        switch (update?.sessionUpdate) {
            case 'agent_message_chunk': {
                const content = asRecord(update.content);
                const text = content?.type === 'text' ? nonEmptyString(content.text) : undefined;
                return text === undefined ? null : { type: 'text', text };
            }
            case 'tool_call':
            case 'tool_call_update':
                return this.mapAcpToolCall(update);
            case 'usage_update':
                return contextUsage(update);
            default:
                return null;
        }
    }

    private recordError(id: unknown, method: string | undefined, error: JsonRecord): void {
        if (asRecord(error.data)?.detailCode === UNSUPPORTED_PROMPT_CONTENT) {
            this.rejectedPromptContent = true;
        }
        const message = withErrorDetails(nonEmptyString(error.message), asRecord(error.data)?.details);
        if (message === undefined) {
            return;
        }
        if (id === null) {
            this.acpxError = message;
        } else if (method === 'session/prompt') {
            this.promptError = message;
        }
        this.lastError = message;
    }

    private mapAcpToolCall(update: JsonRecord): ChatEvent {
        const id = nonEmptyString(update.toolCallId);
        const call = this.mergeToolCall(id, update);
        const status = typeof call.status === 'string' ? ACP_TOOL_STATUS[call.status] : undefined;
        return {
            type: 'toolCall',
            title: nonEmptyString(call.title) ?? 'tool',
            status: status ?? 'running',
            details: stringifyToolEvent(call),
            ...(id === undefined ? {} : { id }),
        };
    }

    private mergeToolCall(id: string | undefined, update: JsonRecord): JsonRecord {
        const previous = id === undefined ? undefined : this.toolCalls.get(id);
        const call = { ...previous, ...update };
        if (id !== undefined) {
            this.toolCalls.set(id, call);
        }
        return call;
    }

}

/** One acpx process: it reports `done` exactly once (on exit, spawn error or
 *  abort) and calls `onRunComplete` exactly once, after the process is gone,
 *  so staged images outlive it; a run handed to its image-less retry does
 *  neither and leaves both to the retry. */
class AcpxRun {
    private finished = false;
    private released = false;
    private readonly parser = new AcpxEventParser();
    private readonly stdoutDecoder = new StringDecoder('utf8');
    private readonly stderrDecoder = new StringDecoder('utf8');
    /** The current line's text so far, as received, so a long line costs linear time. */
    private readonly pendingLine: string[] = [];
    private pendingLineLength = 0;
    private droppingOversizedLine = false;
    private stderrTail = '';
    private killTimer: NodeJS.Timeout | undefined;

    constructor(
        private readonly child: ChildProcess,
        private readonly onEvent: (event: ChatEvent) => void,
        private readonly onRunComplete: (() => void) | undefined,
        private readonly onExit: (run: AcpxRun) => void,
        /** Restarts the send without image blocks, handing it this run's listener. */
        private readonly retryWithoutImages?: () => void
    ) {
        child.stdout?.on('data', (chunk: Buffer) => this.onStdout(this.stdoutDecoder.write(chunk)));
        child.stderr?.on('data', (chunk: Buffer) => this.onStderr(this.stderrDecoder.write(chunk)));
        child.on('close', (code: number | null, signal: NodeJS.Signals | null) => this.onClose(code, signal));
        child.on('error', (err: NodeJS.ErrnoException) => this.onError(err));
        // EPIPE: acpx exited before reading its prompt, which its exit reports.
        child.stdin?.on('error', (err: Error) => log.warn(`acpx stdin: ${err.message}`));
    }

    /** acpx reads stdin to EOF before it starts the agent. */
    writePrompt(payload: Buffer): void {
        this.child.stdin?.end(payload);
    }

    /** Ends the run for its listener now and stops the process tree; the
     *  late exit only releases the run. */
    abort(): void {
        this.finish(null);
        this.signalTree('SIGTERM');
        this.killTimer = setTimeout(() => this.signalTree('SIGKILL'), ABORT_KILL_GRACE_MS);
        this.killTimer.unref?.();
    }

    private onStdout(text: string): void {
        if (this.finished) {
            return;
        }
        let start = 0;
        for (let newline = text.indexOf('\n'); newline >= 0; newline = text.indexOf('\n', start)) {
            this.completeLine(text.slice(start, newline));
            start = newline + 1;
        }
        this.appendToLine(text.slice(start));
    }

    private appendToLine(piece: string): void {
        if (this.droppingOversizedLine || piece === '') {
            return;
        }
        this.pendingLine.push(piece);
        this.pendingLineLength += piece.length;
        if (this.pendingLineLength > STDOUT_LINE_MAX_CHARS) {
            log.warn(`dropping an acpx output line over ${STDOUT_LINE_MAX_CHARS} characters`);
            this.parser.noteDroppedLine(this.takePendingLine().slice(0, DROPPED_LINE_PREFIX_CHARS));
            this.droppingOversizedLine = true;
        }
    }

    private completeLine(lastPiece: string): void {
        this.appendToLine(lastPiece);
        const dropped = this.droppingOversizedLine;
        this.droppingOversizedLine = false;
        const line = this.takePendingLine();
        if (!dropped) {
            this.emitLine(line);
        }
    }

    private takePendingLine(): string {
        const line = this.pendingLine.join('');
        this.pendingLine.length = 0;
        this.pendingLineLength = 0;
        return line;
    }

    private onStderr(text: string): void {
        this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_MAX_CHARS);
    }

    private emitLine(line: string): void {
        this.parser.parseLine(line.replace(/\r$/, '')).forEach(event => this.onEvent(event));
    }

    private onClose(code: number | null, signal: NodeJS.Signals | null): void {
        log.info(`acpx exited code=${code} signal=${signal}`);
        clearTimeout(this.killTimer);
        this.onStdout(this.stdoutDecoder.end());
        this.onStderr(this.stderrDecoder.end());
        if (this.stderrTail.trim()) {
            log.info(`acpx stderr: ${this.stderrTail.trim()}`);
        }
        if (!this.finished && !this.droppingOversizedLine) {
            this.emitLine(this.takePendingLine());
        }
        if (!this.finished && this.retryWithoutImages && this.parser.rejectedPromptContent) {
            this.handOverToRetry();
            return;
        }
        if (!this.finished && this.deniedAfterAnswer(code)) {
            this.onEvent({ type: 'notice', text: PERMISSIONS_DENIED_NOTICE });
        }
        this.finish(this.exitFailure(code, signal));
        this.release();
    }

    private handOverToRetry(): void {
        this.finished = true;
        this.released = true;
        clearTimeout(this.killTimer);
        this.onExit(this);
        this.retryWithoutImages?.();
    }

    /** acpx exits 5 when it denied permissions, even though the turn went on to answer. */
    private deniedAfterAnswer(code: number | null): boolean {
        return code === ACPX_PERMISSION_DENIED_EXIT && this.parser.promptCompleted;
    }

    private exitFailure(code: number | null, signal: NodeJS.Signals | null): ChatEvent | null {
        if (code === 0 || this.deniedAfterAnswer(code)) {
            return null;
        }
        const message = this.parser.failureMessage ?? (this.stderrTail.trim() || exitReason(code, signal));
        log.error(`acpx error: ${message}`);
        return { type: 'error', message };
    }

    private onError(err: NodeJS.ErrnoException): void {
        log.error('acpx spawn error', err);
        const message = err.code === 'ENOENT' || err.message.includes('ENOENT')
            ? ACPX_NOT_FOUND_MESSAGE
            : err.message;
        this.finish({ type: 'error', message });
        // A child that never started emits no reliable 'close'.
        if (this.child.pid === undefined) {
            this.release();
        }
    }

    private finish(failure: ChatEvent | null): void {
        if (this.finished) {
            return;
        }
        this.finished = true;
        if (failure !== null) {
            this.onEvent(failure);
        }
        this.onEvent({ type: 'done' });
    }

    private release(): void {
        if (this.released) {
            return;
        }
        this.released = true;
        clearTimeout(this.killTimer);
        this.onExit(this);
        this.onRunComplete?.();
    }

    /** acpx runs the agent as its own child, so the whole process group is
     *  signalled (POSIX) or the tree is killed (Windows). */
    private signalTree(signal: NodeJS.Signals): void {
        const pid = this.child.pid;
        if (pid === undefined) {
            return;
        }
        try {
            if (process.platform === 'win32') {
                spawn(taskkillPath(), ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => undefined);
            } else {
                process.kill(-pid, signal);
            }
        } catch {
            this.child.kill(signal);
        }
    }
}

/** By absolute path, so a taskkill planted in the workspace is never the one run. */
function taskkillPath(): string {
    return path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
}

function exitReason(code: number | null, signal: NodeJS.Signals | null): string {
    if (code === null) {
        return `acpx was terminated by ${signal}`;
    }
    return code === ACPX_PERMISSION_DENIED_EXIT
        ? 'acpx denied a tool permission the agent needed'
        : `acpx exited with code ${code}`;
}

type PromptBlock = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string };

/** Everything one acpx launch needs besides its prompt. */
type RunRequest = {
    launch: AcpxLaunch;
    args: string[];
    cwd: string;
    onEvent: (event: ChatEvent) => void;
    onRunComplete: (() => void) | undefined;
};

const imageBlock = (image: PromptImage): PromptBlock => ({ type: 'image', mimeType: image.mimeType, data: image.data });
const imageNote = (image: PromptImage): PromptBlock => ({
    type: 'text',
    text: `<image-omitted name="${escapeXmlAttr(image.name)}" reason="this agent does not accept images" />`,
});

/** The prompt as ACP content blocks, each staged image marker replaced by `render(image)`. */
function promptBlocks(fullPrompt: string, render: (image: PromptImage) => PromptBlock): PromptBlock[] {
    const blocks: PromptBlock[] = [];
    const pushText = (text: string) => {
        if (text === '') {
            return;
        }
        const last = blocks[blocks.length - 1];
        if (last?.type === 'text') {
            last.text += text;
        } else {
            blocks.push({ type: 'text', text });
        }
    };
    let textStart = 0;
    for (const match of fullPrompt.matchAll(PROMPT_IMAGE_MARKER)) {
        const image = stagedPromptImage(match[1]);
        if (image === undefined) {
            continue;
        }
        pushText(fullPrompt.slice(textStart, match.index));
        const block = render(image);
        if (block.type === 'text') {
            pushText(block.text);
        } else {
            blocks.push(block);
        }
        textStart = match.index + match[0].length;
    }
    pushText(fullPrompt.slice(textStart));
    // acpx rejects an empty prompt array.
    return blocks.length > 0 ? blocks : [{ type: 'text', text: '' }];
}

/** acpx trims stdin text and parses one starting with `[` as content blocks,
 *  so the prompt always goes as blocks to arrive verbatim. */
function encodePrompt(blocks: PromptBlock[]): Buffer {
    return Buffer.from(JSON.stringify(blocks), 'utf8');
}

/** An ACP error message with its `data.details`, flattened to one bounded line. */
function withErrorDetails(message: string | undefined, details: unknown): string | undefined {
    const raw = typeof details === 'string' ? details : details === undefined || details === null ? '' : stringifyToolEvent(details);
    // Terminal colour codes first, then every other control run becomes one space.
    // eslint-disable-next-line no-control-regex
    const flat = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    if (flat === '' || flat === message) {
        return message;
    }
    const bounded = flat.length > ERROR_DETAILS_MAX_CHARS ? `${flat.slice(0, ERROR_DETAILS_MAX_CHARS)}…` : flat;
    return message === undefined ? bounded : `${message}: ${bounded}`;
}

/** Completes a send aborted before it had a process. */
function completeAborted(run: RunRequest): void {
    run.onEvent({ type: 'done' });
    run.onRunComplete?.();
}

/** Completes a run that never got a process. */
function completeWithoutProcess(onEvent: (event: ChatEvent) => void, onRunComplete: (() => void) | undefined, message: string): void {
    onEvent({ type: 'error', message });
    onEvent({ type: 'done' });
    onRunComplete?.();
}

export class ChatService {
    private activeRun: AcpxRun | null = null;
    /** A send waiting on the user's approval of the workspace's acpx config. */
    private pendingApproval: { abort: () => void } | null = null;

    private static readonly MODEL_SOURCE_MAP: Record<string, string> = {
        codex: 'API',
        claude: 'API',
        'gpt-4o': 'API',
        gemini: 'API',
        ollama: 'Local',
        opencode: 'Gateway',
    };

    static getSourceForModel(model: string): string {
        const override = vscode.workspace.getConfiguration('openclaw').get<string>('chat.source');
        if (override) {
            return override;
        }
        const lower = model.toLowerCase();
        const match = Object.entries(ChatService.MODEL_SOURCE_MAP).find(([key]) => lower.includes(key));
        return match?.[1] ?? 'API';
    }

    private static readonly CHAT_TYPE_PREFIXES: Record<string, string> = {
        code: 'You are a coding assistant. Focus on writing and explaining code.\n\n',
        review: 'You are a code reviewer. Analyze the provided code for bugs, improvements, and best practices.\n\n',
        plan: 'You are a planning assistant. Create structured plans and break down tasks. Do not write code unless asked.\n\n',
    };

    /** The prompt as acpx receives it: system prompt, chat-type prefix, the
     *  conversation so far (each exec starts a fresh agent), prompt. */
    private static composeFullPrompt(prompt: string, chatType: string, history: readonly ConversationTurn[]): string {
        const systemPrompt = vscode.workspace.getConfiguration('openclaw').get<string>('chat.systemPrompt', '');
        const conversation = history.length > 0 ? `${frameConversation(formatConversation(history))}\n\n` : '';
        const prefixed = (ChatService.CHAT_TYPE_PREFIXES[chatType] ?? '') + conversation + prompt;
        return systemPrompt ? `${systemPrompt}\n\n${prefixed}` : prefixed;
    }

    sendMessage(
        prompt: string,
        cwd: string,
        model: string,
        chatType: string,
        onEvent: (event: ChatEvent) => void,
        _onSessionResolved?: (resolvedKey: string, requestedKey: string) => void,
        onRunComplete?: () => void,
        /** The thread's earlier turns, since the last /compact summary. */
        history: readonly ConversationTurn[] = []
    ): void {
        this.abort();

        const agent = model || DEFAULT_AGENT;
        if (!ChatService.isValidAgentName(agent)) {
            completeWithoutProcess(onEvent, onRunComplete, `"${agent}" is not a valid acpx agent name.`);
            return;
        }
        const configuredPermissions = vscode.workspace.getConfiguration('openclaw').get<string>('chat.permissions', 'approve-reads');
        const permissions = ChatService.getPermissionsForChatType(chatType, configuredPermissions);
        const fullPrompt = ChatService.composeFullPrompt(prompt, chatType, history);
        const blocks = promptBlocks(fullPrompt, imageBlock);
        const payload = encodePrompt(blocks);
        if (payload.length > PROMPT_MAX_BYTES) {
            const size = `${Math.ceil(payload.length / 1024 / 1024)} MiB, limit ${PROMPT_MAX_BYTES / 1024 / 1024} MiB`;
            log.error(`acpx prompt too large (${size})`);
            completeWithoutProcess(onEvent, onRunComplete,
                `Prompt is too large for acpx (${size}). Remove attachments or shorten the message.`);
            return;
        }
        const launch = resolveAcpxLaunch();
        if ('missing' in launch) {
            completeWithoutProcess(onEvent, onRunComplete, launch.missing === 'node' ? NODE_NOT_FOUND_MESSAGE : ACPX_NOT_FOUND_MESSAGE);
            return;
        }
        const fallback = blocks.some(block => block.type === 'image') ? encodePrompt(promptBlocks(fullPrompt, imageNote)) : undefined;
        const run: RunRequest = { launch, args: [...launch.args, ...ChatService.buildArgs(agent, permissions)], cwd, onEvent, onRunComplete };
        const projectConfig = checkProjectConfig(cwd);
        switch (projectConfig.status) {
            case 'trusted':
                this.startRun(run, payload, fallback);
                return;
            case 'unreadable':
                completeWithoutProcess(onEvent, onRunComplete, `Chat did not start: ${projectConfig.configPath} exists but cannot be read.`);
                return;
            case 'unapproved':
                this.startAfterApproval(projectConfig, run, payload, fallback);
                return;
        }
    }

    /** Starts the run once the user approves the workspace's acpx config; an
     *  abort while the modal is open completes the send at once. */
    private startAfterApproval(
        projectConfig: Extract<ProjectConfigCheck, { status: 'unapproved' }>,
        run: RunRequest,
        payload: Buffer,
        fallback: Buffer | undefined
    ): void {
        const pending = { abort: () => completeAborted(run) };
        this.pendingApproval = pending;
        const settle = (approved: boolean) => {
            if (this.pendingApproval !== pending) {
                return;
            }
            this.pendingApproval = null;
            if (!approved) {
                completeWithoutProcess(run.onEvent, run.onRunComplete, PROJECT_CONFIG_REFUSED_MESSAGE);
                return;
            }
            // Re-checked at the last moment; acpx still reads the file again itself right after.
            if (checkProjectConfig(run.cwd).status !== 'trusted') {
                completeWithoutProcess(run.onEvent, run.onRunComplete, PROJECT_CONFIG_CHANGED_MESSAGE);
                return;
            }
            this.startRun(run, payload, fallback);
        };
        requestProjectConfigApproval(projectConfig).then(settle, (err: unknown) => {
            log.error('acpx project config approval failed', err);
            settle(false);
        });
    }

    /** Starts acpx on `payload`; with a `fallback`, an agent that refuses its
     *  images gets the send again with the images as notes. */
    private startRun(run: RunRequest, payload: Buffer, fallback: Buffer | undefined): void {
        log.info(`spawn ${run.launch.command} (args=${run.args.length}, cwd=${run.cwd})`);
        let child: ChildProcess;
        try {
            child = spawn(run.launch.command, run.args, {
                cwd: run.cwd,
                env: childEnv(),
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: false,
                windowsHide: true,
                // Its own process group, so abort can signal the agent acpx starts too.
                detached: process.platform !== 'win32',
            });
        } catch (err) {
            log.error('acpx spawn threw', err);
            completeWithoutProcess(run.onEvent, run.onRunComplete, err instanceof Error ? err.message : String(err));
            return;
        }
        const retry = fallback === undefined ? undefined : () => {
            run.onEvent({ type: 'notice', text: IMAGES_NOT_SENT_NOTICE });
            this.startRun(run, fallback, undefined);
        };
        this.activeRun = new AcpxRun(child, run.onEvent, run.onRunComplete, (exited) => {
            if (this.activeRun === exited) {
                this.activeRun = null;
            }
        }, retry);
        this.activeRun.writePrompt(payload);
    }

    abort(): void {
        const run = this.activeRun;
        const pending = this.pendingApproval;
        this.activeRun = null;
        this.pendingApproval = null;
        run?.abort();
        pending?.abort();
    }

    /** Plain chat mode is at most read-only, and stricter when so configured. */
    static getPermissionsForChatType(chatType: string, configuredPermissions: string): string {
        if (chatType !== 'chat') {
            return configuredPermissions;
        }
        const configured = PERMISSION_STRICTNESS.indexOf(configuredPermissions);
        return PERMISSION_STRICTNESS[Math.max(configured, PERMISSION_STRICTNESS.indexOf('approve-reads'))];
    }

    private static isValidAgentName(agent: string): boolean {
        return AGENT_NAME_PATTERN.test(agent) && !ACPX_VERBS.has(agent);
    }

    private static buildArgs(agent: string, permissions: string): string[] {
        // The agent is always named: omitted, acpx would run the user's own
        // configured defaultAgent instead.
        return ['--format', 'json', ChatService.permissionFlag(permissions), agent, 'exec', '--file', '-'];
    }

    private static permissionFlag(permissions: string): string {
        switch (permissions) {
            case 'approve-all':
                return '--approve-all';
            case 'deny-all':
                return '--deny-all';
            default:
                return '--approve-reads';
        }
    }

    dispose(): void {
        this.abort();
    }
}
