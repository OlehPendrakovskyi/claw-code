import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';

const log = vscode.window.createOutputChannel('OpenClaw Agent', { log: true });

/** Linux MAX_ARG_STRLEN: the prompt travels as ONE execve argument, and the
 *  limit includes that argument's terminating NUL. */
export const PROMPT_ARG_MAX_BYTES = 128 * 1024 - 1;

/** Windows caps the whole command line at 32767 UTF-16 units; the rest is
 *  headroom for the executable, the other flags and argument quoting. */
export const PROMPT_ARG_MAX_WINDOWS_CHARS = 32767 - 2048;

/** How far `prompt` is over the platform's command-line limit for one
 *  argument, as a user-facing size, or null when it fits. macOS and the
 *  BSDs only cap the total argv+env size, which spawn reports as an error. */
export function describePromptArgOverflow(prompt: string, platform: NodeJS.Platform = process.platform): string | null {
    if (platform === 'linux') {
        const bytes = Buffer.byteLength(prompt, 'utf8');
        return bytes > PROMPT_ARG_MAX_BYTES
            ? `${Math.ceil(bytes / 1024)} KiB, limit ${Math.floor(PROMPT_ARG_MAX_BYTES / 1024)} KiB`
            : null;
    }
    if (platform === 'win32') {
        return prompt.length > PROMPT_ARG_MAX_WINDOWS_CHARS
            ? `${prompt.length} characters, limit ${PROMPT_ARG_MAX_WINDOWS_CHARS}`
            : null;
    }
    return null;
}

export type UsageInfo = {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
};

export type ChatEvent =
    | { type: 'text'; text: string }
    | { type: 'toolCall'; title: string; status: string; details: string; id?: string }
    | { type: 'usage'; usage: UsageInfo }
    | { type: 'done' }
    | { type: 'error'; message: string };

export class ChatService {
    private activeProcess: ChildProcess | null = null;

    private static readonly MODEL_SOURCE_MAP: Record<string, string> = {
        codex: 'API',
        claude: 'API',
        'gpt-4o': 'API',
        gemini: 'API',
        ollama: 'Local',
        opencode: 'Gateway',
    };

    static getSourceForModel(model: string): string {
        const config = vscode.workspace.getConfiguration('openclaw');
        const override = config.get<string>('chat.source');
        if (override) {
            return override;
        }
        const lower = model.toLowerCase();
        for (const [key, source] of Object.entries(ChatService.MODEL_SOURCE_MAP)) {
            if (lower.includes(key)) {
                return source;
            }
        }
        return 'API';
    }

    private static readonly CHAT_TYPE_PREFIXES: Record<string, string> = {
        code: 'You are a coding assistant. Focus on writing and explaining code.\n\n',
        review: 'You are a code reviewer. Analyze the provided code for bugs, improvements, and best practices.\n\n',
        plan: 'You are a planning assistant. Create structured plans and break down tasks. Do not write code unless asked.\n\n',
    };

    sendMessage(
        prompt: string,
        cwd: string,
        model: string,
        chatType: string,
        onEvent: (event: ChatEvent) => void,
        _onSessionResolved?: (resolvedKey: string, requestedKey: string) => void,
        onRunComplete?: () => void
    ): void {
        this.abort();

        const config = vscode.workspace.getConfiguration('openclaw');
        const configuredPermissions = config.get<string>('chat.permissions', 'approve-reads');
        const permissions = ChatService.getPermissionsForChatType(chatType, configuredPermissions);

        const thinkingLevel = config.get<string>('chat.thinkingLevel', 'medium');
        const temperature = config.get<number>('chat.temperature', 0.7);
        const maxTokens = config.get<number>('chat.maxTokens', 0);
        const systemPrompt = config.get<string>('chat.systemPrompt', '');

        const prefix = ChatService.CHAT_TYPE_PREFIXES[chatType] ?? '';
        let fullPrompt = prefix + prompt;
        if (systemPrompt) {
            fullPrompt = systemPrompt + '\n\n' + fullPrompt;
        }
        // spawn() throws on NUL in any argument.
        fullPrompt = fullPrompt.replace(/\0/g, '\uFFFD');

        // A spawn can fail with 'error' and still fire 'close' (or emit both
        // after a kill), so the run must complete exactly once: the first
        // terminal event owns completion and later ones are ignored.
        let settled = false;
        const completeRun = (event: ChatEvent | null) => {
            if (settled) {
                return;
            }
            settled = true;
            if (event !== null) {
                onEvent(event);
            }
            onEvent({ type: 'done' });
            onRunComplete?.();
        };

        const overflow = describePromptArgOverflow(fullPrompt);
        if (overflow !== null) {
            log.error(`acpx prompt too large (${overflow})`);
            completeRun({
                type: 'error',
                message: `Prompt is too large for the acpx command line (${overflow}). Remove attachments or shorten the message.`
            });
            return;
        }

        const args = this.buildArgs(model, permissions, fullPrompt, {
            thinkingLevel,
            temperature,
            maxTokens,
        });

        log.info(`spawn acpx (args=${args.length}, cwd=${cwd})`);
        let child: ChildProcess;
        try {
            child = spawn('acpx', args, {
                cwd,
                env: { ...process.env },
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } catch (err) {
            log.error('acpx spawn threw', err);
            completeRun({ type: 'error', message: err instanceof Error ? err.message : String(err) });
            return;
        }

        this.activeProcess = child;

        let stderrBuffer = '';
        let stdoutLineBuffer = '';

        child.stdout!.on('data', (chunk: Buffer) => {
            stdoutLineBuffer += chunk.toString();
            const lines = stdoutLineBuffer.split('\n');
            stdoutLineBuffer = lines.pop() ?? '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) {
                    continue;
                }
                const event = this.parseLine(trimmed);
                if (event) {
                    onEvent(event);
                }
            }
        });

        child.stderr!.on('data', (chunk: Buffer) => {
            stderrBuffer += chunk.toString();
        });

        child.on('close', (code) => {
            log.info(`acpx exited code=${code}`);
            // If a spawn error already settled this run, any buffered stdout
            // is stale: delivering it after 'done' can re-open a thread as
            // running or pollute a replacement run, so post-terminal output
            // is a no-op.
            if (settled) {
                return;
            }
            if (stdoutLineBuffer.trim()) {
                const event = this.parseLine(stdoutLineBuffer.trim());
                if (event) {
                    onEvent(event);
                }
            }

            if (this.activeProcess === child) {
                this.activeProcess = null;
            }

            if (code !== 0 && code !== null) {
                const errMsg = stderrBuffer.trim() || `acpx exited with code ${code}`;
                log.error(`acpx error: ${errMsg}`);
                completeRun({ type: 'error', message: errMsg });
                return;
            }

            completeRun(null);
        });

        child.on('error', (err) => {
            log.error('acpx spawn error', err);
            if (this.activeProcess === child) {
                this.activeProcess = null;
            }
            const errMsg = err.message.includes('ENOENT')
                ? 'acpx not found. Install it with: npm i -g acpx'
                : err.message;
            // Spawn failure never started the child, so the snapshot paths are
            // never consumed — remove them here to avoid leaking temp disk.
            completeRun({ type: 'error', message: errMsg });
        });
    }

    abort(): void {
        if (this.activeProcess) {
            this.activeProcess.kill('SIGTERM');
            this.activeProcess = null;
        }
    }

    get isRunning(): boolean {
        return this.activeProcess !== null;
    }

    /** Plain chat mode is read-only regardless of the global permission setting. */
    static getPermissionsForChatType(chatType: string, configuredPermissions: string): string {
        if (chatType === 'chat') {
            return 'approve-reads';
        }
        return configuredPermissions;
    }

    private buildArgs(
        agent: string,
        permissions: string,
        prompt: string,
        _options?: { thinkingLevel?: string; temperature?: number; maxTokens?: number }
    ): string[] {
        const args: string[] = [];

        args.push('--format', 'json');

        const permFlag = this.permissionFlag(permissions);
        if (permFlag) {
            args.push(permFlag);
        }

        if (agent && agent !== 'codex') {
            args.push(agent);
        }

        args.push('exec', prompt);
        return args;
    }

    private permissionFlag(permissions: string): string | null {
        switch (permissions) {
            case 'approve-all':
                return '--approve-all';
            case 'deny-all':
                return '--deny-all';
            case 'approve-reads':
            default:
                return '--approve-reads';
        }
    }

    private parseLine(line: string): ChatEvent | null {
        try {
            const obj = JSON.parse(line);
            return this.mapJsonEvent(obj);
        } catch {
            if (line.length > 0) {
                return { type: 'text', text: line + '\n' };
            }
            return null;
        }
    }

    private static nonEmptyString(value: unknown): string | undefined {
        return typeof value === 'string' && value !== '' ? value : undefined;
    }

    private static toolTitle(obj: Record<string, unknown>): string {
        return ChatService.nonEmptyString(obj.title) ?? ChatService.nonEmptyString(obj.name) ??
            ChatService.nonEmptyString(obj.tool) ?? 'tool';
    }

    private static toolIdField(value: unknown): { id?: string } {
        const id = ChatService.nonEmptyString(value);
        return id === undefined ? {} : { id };
    }

    private mapJsonEvent(obj: Record<string, unknown>): ChatEvent | null {
        const eventType = obj.type as string | undefined;

        if (eventType === 'message' || eventType === 'content' || eventType === 'text') {
            const text = (obj.content ?? obj.text ?? obj.data ?? '') as string;
            if (text) {
                return { type: 'text', text };
            }
            return null;
        }

        if (eventType === 'content_block_delta' || eventType === 'delta') {
            const delta = obj.delta as Record<string, unknown> | undefined;
            const text = (delta?.text ?? delta?.content ?? obj.text ?? '') as string;
            if (text) {
                return { type: 'text', text };
            }
            return null;
        }

        if (eventType === 'tool_call' || eventType === 'tool_use') {
            return {
                type: 'toolCall',
                title: ChatService.toolTitle(obj),
                status: ChatService.nonEmptyString(obj.status) ?? 'running',
                details: this.stringifyToolEvent(obj),
                ...ChatService.toolIdField(obj.id ?? obj.tool_call_id ?? obj.toolCallId),
            };
        }

        if (eventType === 'tool_result') {
            // The result carries its call's id, so the webview updates the
            // running entry in place instead of appending a second one.
            const failed = obj.is_error === true || obj.status === 'error';
            return {
                type: 'toolCall',
                title: ChatService.toolTitle(obj),
                status: failed ? 'error' : 'done',
                details: this.stringifyToolEvent(obj),
                ...ChatService.toolIdField(obj.tool_use_id ?? obj.tool_call_id ?? obj.toolCallId ?? obj.id),
            };
        }

        if (eventType === 'error') {
            return { type: 'error', message: (obj.message ?? obj.error ?? 'Unknown error') as string };
        }

        if (eventType === 'done' || eventType === 'end' || eventType === 'complete') {
            return { type: 'done' };
        }

        if (eventType === 'assistant' || eventType === 'response') {
            const text = (obj.content ?? obj.text ?? obj.message ?? '') as string;
            if (text) {
                return { type: 'text', text };
            }
        }

        if (eventType === 'usage' || eventType === 'message_stop' || obj.usage) {
            const usage = (obj.usage ?? obj) as Record<string, unknown>;
            const promptTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokens ?? 0);
            const completionTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? usage.completionTokens ?? 0);
            if (promptTokens > 0 || completionTokens > 0) {
                return {
                    type: 'usage',
                    usage: {
                        promptTokens,
                        completionTokens,
                        totalTokens: promptTokens + completionTokens
                    }
                };
            }
        }

        if (typeof obj.text === 'string' && obj.text) {
            return { type: 'text', text: obj.text };
        }

        return null;
    }

    private stringifyToolEvent(obj: Record<string, unknown>): string {
        try {
            return JSON.stringify(obj, null, 2);
        } catch {
            return '[unserializable tool event]';
        }
    }

    dispose(): void {
        this.abort();
    }
}
