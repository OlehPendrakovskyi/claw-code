import { EventEmitter } from 'events';
import { Writable } from 'stream';
import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as acpxLauncher from '../chat/acpxLauncher';
import {
    ABORT_KILL_GRACE_MS,
    ChatService,
    ChatEvent,
    PROMPT_MAX_BYTES,
    STDERR_TAIL_MAX_CHARS,
    STDOUT_LINE_MAX_CHARS,
} from '../chat/ChatService';

jest.mock('child_process', () => ({ spawn: jest.fn() }));

const spawnMock = jest.mocked(spawn);
const getConfigurationMock = jest.mocked(vscode.workspace.getConfiguration);

type FakeChild = ChildProcess & { stdin: Writable; stdout: EventEmitter; stderr: EventEmitter; stdinBytes: Buffer[] };

/** A child that `spawned: false` models as never started: Node leaves its pid unset. */
function fakeChild({ spawned = true } = {}): FakeChild {
    const stdinBytes: Buffer[] = [];
    const stdin = new Writable({
        write(chunk: Buffer, _encoding, callback) {
            stdinBytes.push(chunk);
            callback();
        },
    });
    return Object.assign(new EventEmitter() as ChildProcess, {
        pid: spawned ? 4242 : undefined,
        stdin,
        stdinBytes,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: jest.fn(),
    }) as FakeChild;
}

function useSettings(settings: Record<string, unknown>): void {
    getConfigurationMock.mockReturnValue({
        get: (key: string, fallback?: unknown) => (key in settings ? settings[key] : fallback),
    } as vscode.WorkspaceConfiguration);
}

type RunOptions = { model?: string; chatType?: string; service?: ChatService };

function send(prompt: string, options: RunOptions = {}) {
    const events: ChatEvent[] = [];
    const onRunComplete = jest.fn();
    const service = options.service ?? new ChatService();
    service.sendMessage(prompt, '/tmp', options.model ?? 'codex', options.chatType ?? 'chat',
        e => events.push(e), undefined, onRunComplete);
    return { events, onRunComplete, service };
}

function start(prompt = 'hello', options: RunOptions = {}) {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    return { child, ...send(prompt, options) };
}

/** The prompt text the child read from stdin, decoded from its ACP content block. */
function stdinPrompt(child: FakeChild): string {
    const blocks = JSON.parse(Buffer.concat(child.stdinBytes).toString('utf8')) as { type: string; text: string }[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    return blocks[0].text;
}

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...original, value: platform });
    try {
        return run();
    } finally {
        Object.defineProperty(process, 'platform', original);
    }
}

const jsonLines = (...lines: object[]) => Buffer.from(lines.map(line => JSON.stringify(line)).join('\n') + '\n');
const spawnedArgs = () => spawnMock.mock.calls[0][1] as string[];
const types = (events: ChatEvent[]) => events.map(e => e.type);
const PERMISSION_FLAGS = ['--approve-all', '--deny-all', '--approve-reads'];
const acpUpdate = (update: object) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update } });

describe('ChatService.sendMessage', () => {
    let killSpy: jest.SpyInstance;

    beforeEach(() => {
        spawnMock.mockReset();
        useSettings({});
        killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    });

    afterEach(() => {
        killSpy.mockRestore();
        getConfigurationMock.mockReset();
        jest.useRealTimers();
    });

    describe('launch', () => {
        it('sends the prompt on stdin, never on the command line', () => {
            const { child } = start('--agent=sh -c evil');
            expect(spawnedArgs()).toEqual(['--format', 'json', '--approve-reads', 'codex', 'exec', '--file', '-']);
            expect(stdinPrompt(child)).toBe('--agent=sh -c evil');
            expect(child.stdin.writableEnded).toBe(true);
        });

        it.each([
            ['NUL', 'before\0after'],
            ['quotes and newlines', ' "a" \'b\'\n\r\nc\t '],
            ['multibyte text', 'ж€😀'],
            ['a leading `[` acpx would parse as content blocks', '[1, 2]'],
        ])('keeps %s verbatim', (_label, prompt) => {
            const { child } = start(prompt);
            expect(stdinPrompt(child)).toBe(prompt);
        });

        it('always names the agent, so acpx never substitutes its own configured default', () => {
            start('hi', { model: 'claude' });
            expect(spawnedArgs().slice(0, 5)).toEqual(['--format', 'json', '--approve-reads', 'claude', 'exec']);
            spawnMock.mockReset();
            start('hi', { model: 'codex' });
            expect(spawnedArgs()[3]).toBe('codex');
        });

        it('names the extension\'s default agent when none is chosen', () => {
            start('hi', { model: '' });
            expect(spawnedArgs()[3]).toBe('codex');
        });

        it.each([
            ['approve-all', '--approve-all'],
            ['deny-all', '--deny-all'],
            ['approve-reads', '--approve-reads'],
            ['something-else', '--approve-reads'],
        ])('maps the %s permission setting to %s outside plain chat', (setting, flag) => {
            useSettings({ 'chat.permissions': setting });
            start('hi', { chatType: 'code' });
            expect(spawnedArgs()[2]).toBe(flag);
            expect(spawnedArgs().filter(arg => PERMISSION_FLAGS.includes(arg))).toHaveLength(1);
        });

        it('keeps plain chat read-only whatever permission is configured', () => {
            useSettings({ 'chat.permissions': 'approve-all' });
            start('hi', { chatType: 'chat' });
            expect(spawnedArgs()[2]).toBe('--approve-reads');
        });

        it('adds no flags for the thinking, temperature and max-token settings, which acpx does not take', () => {
            useSettings({ 'chat.thinkingLevel': 'high', 'chat.temperature': 1.5, 'chat.maxTokens': 100 });
            start('hi', { model: 'gemini', chatType: 'code' });
            expect(spawnedArgs()).toHaveLength(7);
        });

        it('prefixes the system prompt and the chat-type instruction to the prompt', () => {
            useSettings({ 'chat.systemPrompt': 'SYS' });
            const { child } = start('question', { chatType: 'review' });
            expect(stdinPrompt(child)).toMatch(/^SYS\n\nYou are a code reviewer\.[^\n]*\n\nquestion$/);
        });

        it('starts acpx without a shell in its own process group on POSIX so abort reaches the agent', () => {
            withPlatform('linux', () => start());
            expect(spawnMock.mock.calls[0][0]).toBe('acpx');
            expect(spawnMock.mock.calls[0][2]).toEqual(expect.objectContaining({
                detached: true,
                shell: false,
                stdio: ['pipe', 'pipe', 'pipe'],
            }));
        });

        it('runs the resolved Node launch on Windows, not the acpx shim', () => {
            const resolve = jest.spyOn(acpxLauncher, 'resolveAcpxLaunch').mockReturnValue({
                command: 'C:\\Code\\Code.exe',
                args: ['C:\\npm\\node_modules\\acpx\\dist\\cli.js'],
                env: { ELECTRON_RUN_AS_NODE: '1' },
            });
            try {
                const { child } = withPlatform('win32', () => start('hi'));
                expect(spawnMock).toHaveBeenCalledWith(
                    'C:\\Code\\Code.exe',
                    ['C:\\npm\\node_modules\\acpx\\dist\\cli.js', '--format', 'json', '--approve-reads', 'codex', 'exec', '--file', '-'],
                    expect.objectContaining({
                        detached: false,
                        shell: false,
                        windowsHide: true,
                        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
                    }));
                expect(stdinPrompt(child)).toBe('hi');
            } finally {
                resolve.mockRestore();
            }
        });

        it('explains a missing acpx without spawning when no launch resolves', () => {
            const resolve = jest.spyOn(acpxLauncher, 'resolveAcpxLaunch').mockReturnValue(null);
            try {
                const { events, onRunComplete } = send('hi');
                expect(spawnMock).not.toHaveBeenCalled();
                expect(events).toEqual([{ type: 'error', message: 'acpx not found. Install it with: npm i -g acpx' }, { type: 'done' }]);
                expect(onRunComplete).toHaveBeenCalledTimes(1);
            } finally {
                resolve.mockRestore();
            }
        });

        it.each(['--agent=sh', '-x', 'exec', 'sessions', 'a b', 'x;y'])('refuses the agent name %p without spawning', (model) => {
            const { events, onRunComplete } = send('hi', { model });
            expect(spawnMock).not.toHaveBeenCalled();
            expect(types(events)).toEqual(['error', 'done']);
            expect(onRunComplete).toHaveBeenCalledTimes(1);
        });

        it('refuses a prompt over the size cap without spawning, completing once', () => {
            const { events, onRunComplete } = send('x'.repeat(PROMPT_MAX_BYTES + 1));
            expect(spawnMock).not.toHaveBeenCalled();
            expect(types(events)).toEqual(['error', 'done']);
            expect((events[0] as { message: string }).message).toContain('too large');
            expect(onRunComplete).toHaveBeenCalledTimes(1);
        });

        it('survives acpx closing stdin early and still completes exactly once', () => {
            const { child, events, onRunComplete } = start();
            expect(() => child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
            child.stderr.emit('data', Buffer.from('bad flag'));
            child.emit('close', 2, null);
            expect(events).toEqual([{ type: 'error', message: 'bad flag' }, { type: 'done' }]);
            expect(onRunComplete).toHaveBeenCalledTimes(1);
        });

        it('reports a non-Error thrown by spawn', () => {
            spawnMock.mockImplementation(() => {
                throw 'EAGAIN';
            });
            expect(send('hello').events[0]).toEqual({ type: 'error', message: 'EAGAIN' });
        });

        it('completes the run with an error when spawn throws synchronously', () => {
            spawnMock.mockImplementation(() => {
                throw new Error('spawn EMFILE');
            });
            const { events, onRunComplete } = send('hello');
            expect(events).toEqual([{ type: 'error', message: 'spawn EMFILE' }, { type: 'done' }]);
            expect(onRunComplete).toHaveBeenCalledTimes(1);
        });
    });

    describe('completion', () => {
        it('completes a clean exit exactly once', () => {
            const { child, events, onRunComplete } = start();
            child.emit('close', 0, null);
            child.emit('close', 0, null);
            expect(events).toEqual([{ type: 'done' }]);
            expect(onRunComplete).toHaveBeenCalledTimes(1);
        });

        it('reports stderr on a non-zero exit', () => {
            const { child, events } = start();
            child.stderr.emit('data', Buffer.from('  auth failed \n'));
            child.emit('close', 3, null);
            expect(events).toEqual([{ type: 'error', message: 'auth failed' }, { type: 'done' }]);
        });

        it('names the exit code when a failing acpx wrote no stderr', () => {
            const { child, events } = start();
            child.emit('close', 2, null);
            expect(events[0]).toEqual({ type: 'error', message: 'acpx exited with code 2' });
        });

        it('treats an unrequested signal death as a failure, not a success', () => {
            const { child, events } = start();
            child.emit('close', null, 'SIGKILL');
            expect(events).toEqual([{ type: 'error', message: 'acpx was terminated by SIGKILL' }, { type: 'done' }]);
        });

        it('completes a clean exit with stderr-only output without an error', () => {
            const { child, events, onRunComplete } = start();
            child.stderr.emit('data', Buffer.from('warning: something'));
            child.emit('close', 0, null);
            expect(events).toEqual([{ type: 'done' }]);
            expect(onRunComplete).toHaveBeenCalledTimes(1);
        });

        it('keeps only the tail of a flood of stderr', () => {
            const { child, events } = start();
            child.stderr.emit('data', Buffer.from('a'.repeat(STDERR_TAIL_MAX_CHARS * 2)));
            child.stderr.emit('data', Buffer.from('the real error'));
            child.emit('close', 1, null);
            const message = (events[0] as { message: string }).message;
            expect(message.length).toBeLessThanOrEqual(STDERR_TAIL_MAX_CHARS);
            expect(message.endsWith('the real error')).toBe(true);
        });

        it('explains a missing acpx and releases a process that never started', () => {
            const child = fakeChild({ spawned: false });
            spawnMock.mockReturnValue(child);
            const { events, onRunComplete } = send('hello');
            child.emit('error', Object.assign(new Error('spawn acpx ENOENT'), { code: 'ENOENT' }));
            expect(onRunComplete).toHaveBeenCalledTimes(1);
            child.emit('close', -2, null);
            expect(events).toEqual([{ type: 'error', message: 'acpx not found. Install it with: npm i -g acpx' }, { type: 'done' }]);
            expect(onRunComplete).toHaveBeenCalledTimes(1);
        });

        it('keeps a running process\'s files until it exits after an error event', () => {
            const { child, events, onRunComplete } = start();
            child.emit('error', new Error('EPIPE'));
            expect(events).toEqual([{ type: 'error', message: 'EPIPE' }, { type: 'done' }]);
            expect(onRunComplete).not.toHaveBeenCalled();
            child.stdout.emit('data', jsonLines({ type: 'text', text: 'late' }));
            child.emit('close', 1, null);
            expect(events).toHaveLength(2);
            expect(onRunComplete).toHaveBeenCalledTimes(1);
        });

        it('reports a streamed error once, not again for the exit code', () => {
            const { child, events } = start();
            child.stdout.emit('data', jsonLines({ type: 'error', message: 'rate limited' }));
            child.stderr.emit('data', Buffer.from('rate limited'));
            child.emit('close', 1, null);
            expect(events).toEqual([{ type: 'error', message: 'rate limited' }, { type: 'done' }]);
        });

        it('ignores streamed end markers, completing only when acpx exits', () => {
            const { child, events } = start();
            child.stdout.emit('data', jsonLines({ type: 'done' }, { type: 'end' }, { type: 'complete' }));
            expect(events).toEqual([]);
            child.emit('close', 0, null);
            expect(events).toEqual([{ type: 'done' }]);
        });
    });

    describe('stdout framing', () => {
        it('parses a final line that has no trailing newline', () => {
            const { child, events } = start();
            child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'text', text: 'tail' })));
            child.emit('close', 0, null);
            expect(events).toEqual([{ type: 'text', text: 'tail' }, { type: 'done' }]);
        });

        it('reassembles a multibyte character split across chunks', () => {
            const { child, events } = start();
            const bytes = jsonLines({ type: 'text', text: 'ж€😀' });
            const cut = bytes.indexOf(Buffer.from('€')) + 1;
            child.stdout.emit('data', bytes.subarray(0, cut));
            child.stdout.emit('data', bytes.subarray(cut));
            expect(events).toEqual([{ type: 'text', text: 'ж€😀' }]);
        });

        it('reassembles a line split across chunks and handles CRLF', () => {
            const { child, events } = start();
            child.stdout.emit('data', Buffer.from('{"type":"te'));
            child.stdout.emit('data', Buffer.from('xt","text":"a"}\r\n'));
            expect(events).toEqual([{ type: 'text', text: 'a' }]);
        });

        it('shows non-JSON and non-object JSON lines as text, keeping indentation', () => {
            const { child, events } = start();
            child.stdout.emit('data', Buffer.from('  indented plain\n{broken json\n42\n[1]\n\n   \n'));
            expect(events).toEqual([
                { type: 'text', text: '  indented plain\n' },
                { type: 'text', text: '{broken json\n' },
                { type: 'text', text: '42\n' },
                { type: 'text', text: '[1]\n' },
            ]);
        });

        it('drops a line that outgrows the buffer cap and resumes at the next line', () => {
            const { child, events } = start();
            child.stdout.emit('data', Buffer.from('x'.repeat(STDOUT_LINE_MAX_CHARS + 1)));
            child.stdout.emit('data', Buffer.from('still the same line\n'));
            child.stdout.emit('data', jsonLines({ type: 'text', text: 'next' }));
            child.emit('close', 0, null);
            expect(events).toEqual([{ type: 'text', text: 'next' }, { type: 'done' }]);
        });

        it('assembles a line from many small chunks in linear time', () => {
            const { child, events } = start();
            const chunk = Buffer.from('x'.repeat(1024));
            const started = Date.now();
            child.stdout.emit('data', Buffer.from('{"type":"text","text":"'));
            for (let i = 0; i < 8 * 1024; i += 1) {
                child.stdout.emit('data', chunk);
            }
            child.stdout.emit('data', Buffer.from('"}\n'));
            // Re-joining the pending line per chunk took seconds here.
            expect(Date.now() - started).toBeLessThan(1000);
            expect((events[0] as { text: string }).text).toHaveLength(8 * 1024 * 1024);
        });

        it('drops a line whose final chunk carries it over the cap', () => {
            const { child, events } = start();
            child.stdout.emit('data', Buffer.from('x'.repeat(STDOUT_LINE_MAX_CHARS)));
            child.stdout.emit('data', Buffer.from('yy\n'));
            child.stdout.emit('data', jsonLines({ type: 'text', text: 'next' }));
            expect(events).toEqual([{ type: 'text', text: 'next' }]);
        });

        it('drops an oversized final line at exit instead of parsing a fragment', () => {
            const { child, events } = start();
            child.stdout.emit('data', Buffer.from('y'.repeat(STDOUT_LINE_MAX_CHARS + 1)));
            child.stdout.emit('data', Buffer.from('tail fragment'));
            child.emit('close', 0, null);
            expect(events).toEqual([{ type: 'done' }]);
        });
    });

    describe('abort', () => {
        it('completes at once, signals the process group and ignores the late exit', () => {
            const { child, events, onRunComplete, service } = start();
            service.abort();
            expect(events).toEqual([{ type: 'done' }]);
            expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
            expect(onRunComplete).not.toHaveBeenCalled();
            child.stdout.emit('data', jsonLines({ type: 'text', text: 'late' }));
            child.emit('close', null, 'SIGTERM');
            expect(events).toEqual([{ type: 'done' }]);
            expect(onRunComplete).toHaveBeenCalledTimes(1);
        });

        it('escalates to SIGKILL when the process outlives the grace period', () => {
            jest.useFakeTimers();
            const { service } = start();
            service.abort();
            jest.advanceTimersByTime(ABORT_KILL_GRACE_MS);
            expect(killSpy).toHaveBeenLastCalledWith(-4242, 'SIGKILL');
        });

        it('does not escalate once the process has exited', () => {
            jest.useFakeTimers();
            const { child, service } = start();
            service.abort();
            child.emit('close', null, 'SIGTERM');
            jest.advanceTimersByTime(ABORT_KILL_GRACE_MS);
            expect(killSpy).toHaveBeenCalledTimes(1);
        });

        it('kills the process tree with taskkill on Windows', () => {
            const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
            const { service } = start();
            const taskkill = fakeChild();
            spawnMock.mockReturnValueOnce(taskkill);
            Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
            try {
                service.abort();
            } finally {
                Object.defineProperty(process, 'platform', platform);
            }
            expect(spawnMock).toHaveBeenLastCalledWith('taskkill', ['/pid', '4242', '/T', '/F'], { stdio: 'ignore' });
            expect(killSpy).not.toHaveBeenCalled();
            expect(() => taskkill.emit('error', new Error('taskkill missing'))).not.toThrow();
        });

        it('signals nothing for a process that never started', () => {
            spawnMock.mockReturnValue(fakeChild({ spawned: false }));
            const { events, service } = send('hello');
            service.abort();
            expect(events).toEqual([{ type: 'done' }]);
            expect(killSpy).not.toHaveBeenCalled();
        });

        it('falls back to killing the child when the group cannot be signalled', () => {
            killSpy.mockImplementation(() => {
                throw new Error('ESRCH');
            });
            const { child, service } = start();
            service.abort();
            expect(child.kill).toHaveBeenCalledWith('SIGTERM');
        });

        it('aborts the previous run when a new message is sent', () => {
            const first = start('one');
            const second = start('two', { service: first.service });
            expect(first.events).toEqual([{ type: 'done' }]);
            first.child.emit('close', null, 'SIGTERM');
            expect(first.onRunComplete).toHaveBeenCalledTimes(1);
            second.child.emit('close', 0, null);
            expect(second.events).toEqual([{ type: 'done' }]);
        });

        it('keeps the replacement run abortable after the old process exits', () => {
            const first = start('one');
            const second = start('two', { service: first.service });
            first.child.emit('close', null, 'SIGTERM');
            killSpy.mockClear();
            first.service.dispose();
            expect(second.events).toEqual([{ type: 'done' }]);
            expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
        });

        it('is a no-op once the run has exited', () => {
            const { child, events, service } = start();
            child.emit('close', 0, null);
            service.abort();
            expect(events).toEqual([{ type: 'done' }]);
            expect(killSpy).not.toHaveBeenCalled();
        });
    });

    describe('ACP JSON-RPC output', () => {
        it('streams agent message chunks as text and ignores other updates and requests', () => {
            const { child, events } = start();
            child.stdout.emit('data', jsonLines(
                { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'my prompt' }] } },
                acpUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } }),
                acpUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } }),
                acpUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x' } }),
                acpUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 7 } }),
                { jsonrpc: '2.0', id: 0, result: { content: 'file contents answering the agent' } },
                { jsonrpc: '2.0', method: 'session/update', params: null },
            ));
            expect(events).toEqual([{ type: 'text', text: 'Hello' }]);
        });

        it('tracks a tool call through its updates, keeping the title an update omits', () => {
            const { child, events } = start();
            child.stdout.emit('data', jsonLines(
                acpUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file', status: 'pending' }),
                acpUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' }),
                acpUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }),
                acpUpdate({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Edit', status: 'failed' }),
                acpUpdate({ sessionUpdate: 'tool_call', toolCallId: 5, title: ['x'], status: 'weird' }),
                acpUpdate({ sessionUpdate: 'tool_call', title: 'Run', status: 3 }),
            ));
            expect(events).toEqual([
                expect.objectContaining({ type: 'toolCall', id: 't1', title: 'Read file', status: 'running' }),
                expect.objectContaining({ id: 't1', title: 'Read file', status: 'running' }),
                expect.objectContaining({ id: 't1', title: 'Read file', status: 'done' }),
                expect.objectContaining({ id: 't2', title: 'Edit', status: 'error' }),
                { type: 'toolCall', title: 'tool', status: 'running', details: expect.any(String) },
                { type: 'toolCall', title: 'Run', status: 'running', details: expect.any(String) },
            ]);
        });

        it('keeps the call\'s input, kind and last status across updates that omit them', () => {
            const { child, events } = start();
            child.stdout.emit('data', jsonLines(
                acpUpdate({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read x', kind: 'read', rawInput: { path: 'x' }, status: 'pending' }),
                acpUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: 'data' }),
                acpUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 't1', content: [] }),
            ));
            const last = events[2] as { status: string; details: string };
            expect(last.status).toBe('done');
            expect(JSON.parse(last.details)).toEqual(expect.objectContaining({
                title: 'Read x', kind: 'read', rawInput: { path: 'x' }, rawOutput: 'data', status: 'completed',
            }));
        });

        it('reports token usage from the prompt turn result', () => {
            const { child, events } = start();
            child.stdout.emit('data', jsonLines(
                { jsonrpc: '2.0', id: 2, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 4 } } },
                { jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } },
                { jsonrpc: '2.0', id: 4, result: { stopReason: 'end_turn', usage: { inputTokens: 'lots' } } },
            ));
            expect(events).toEqual([{ type: 'usage', usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 } }]);
        });

        it('surfaces acpx\'s own failure on exit and ignores errors answering agent requests', () => {
            const { child, events } = start();
            child.stdout.emit('data', jsonLines(
                { jsonrpc: '2.0', id: 7, error: { code: -32002, message: 'file not found' } },
                { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'agent crashed' } },
            ));
            expect(events).toEqual([]);
            child.stderr.emit('data', Buffer.from('noisy stack trace'));
            child.emit('close', 1, null);
            expect(events).toEqual([{ type: 'error', message: 'agent crashed' }, { type: 'done' }]);
        });

        it('falls back to stderr when acpx\'s failure carries no message', () => {
            const { child, events } = start();
            child.stdout.emit('data', jsonLines({ jsonrpc: '2.0', id: null, error: { code: -32603 } }));
            child.stderr.emit('data', Buffer.from('from stderr'));
            child.emit('close', 1, null);
            expect(events[0]).toEqual({ type: 'error', message: 'from stderr' });
        });

        it('reports the prompt turn\'s own error over later ones on a failing exit', () => {
            const { child, events } = start();
            child.stdout.emit('data', jsonLines(
                { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: {} },
                { jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'Internal error: boom from agent', data: {} } },
                { jsonrpc: '2.0', id: 9, error: { message: 'later unrelated failure' } },
            ));
            child.stderr.emit('data', Buffer.from('stack trace'));
            child.emit('close', 1, null);
            expect(events).toEqual([{ type: 'error', message: 'Internal error: boom from agent' }, { type: 'done' }]);
        });

        it('reports a setup request\'s error when the run dies before prompting', () => {
            const { child, events } = start();
            child.stdout.emit('data', jsonLines(
                { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} },
                { jsonrpc: '2.0', id: 0, error: { message: 'Authentication required' } },
            ));
            child.emit('close', 1, null);
            expect(events[0]).toEqual({ type: 'error', message: 'Authentication required' });
        });

        it('ignores an error on a clean exit', () => {
            const { child, events } = start();
            child.stdout.emit('data', jsonLines({ jsonrpc: '2.0', id: null, error: { message: 'transient' } }));
            child.emit('close', 0, null);
            expect(events).toEqual([{ type: 'done' }]);
        });
    });

    describe('legacy event output', () => {
        const eventsFor = (...lines: object[]) => {
            const { child, events } = start();
            child.stdout.emit('data', jsonLines(...lines));
            return events;
        };

        it('reads text from every legacy text shape', () => {
            expect(eventsFor(
                { type: 'message', content: 'a' },
                { type: 'content', text: 'b' },
                { type: 'text', data: 'c' },
                { type: 'content_block_delta', delta: { text: 'd' } },
                { type: 'delta', delta: { content: 'e' } },
                { type: 'delta', text: 'f' },
                { type: 'assistant', message: 'g' },
                { type: 'response', content: 'h' },
                { type: 'unknown', text: 'i' },
            ).map(e => (e as { text: string }).text)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
        });

        it('skips text fields of the wrong type instead of forwarding them', () => {
            expect(eventsFor(
                { type: 'message', content: { nested: true } },
                { type: 'text', text: 5 },
                { type: 'delta', delta: 'not an object' },
                { type: 'assistant', content: ['x'] },
                { type: 'unknown', text: '' },
            )).toEqual([]);
        });

        it('reads usage from every legacy usage shape and ignores non-numeric counts', () => {
            expect(eventsFor(
                { type: 'usage', input_tokens: 1, output_tokens: 2 },
                { type: 'message_stop', usage: { prompt_tokens: 3, completion_tokens: 4 } },
                { type: 'other', usage: { promptTokens: 5, completionTokens: 6 } },
                { type: 'assistant', usage: { input_tokens: 7 } },
                { type: 'usage', input_tokens: 'many', output_tokens: null },
                { type: 'usage', input_tokens: -3 },
            ).map(e => (e as { usage: { totalTokens: number } }).usage.totalTokens)).toEqual([3, 7, 11, 7]);
        });

        it('reads an error message from a string or an error object', () => {
            expect(eventsFor(
                { type: 'error', message: 'one' },
                { type: 'error', error: 'two' },
                { type: 'error', error: { message: 'three' } },
                { type: 'error', message: 42 },
            )).toEqual([
                { type: 'error', message: 'one' },
                { type: 'error', message: 'two' },
                { type: 'error', message: 'three' },
                { type: 'error', message: 'Unknown error' },
            ]);
        });

        it('gives a tool result the id of its call so the running entry is updated in place', () => {
            expect(eventsFor(
                { type: 'tool_use', id: 'call-1', name: 'read_file' },
                { type: 'tool_result', tool_use_id: 'call-1', name: 'read_file' },
                { type: 'tool_call', toolCallId: 'call-3', tool: 'grep', status: 'queued' },
            )).toEqual([
                expect.objectContaining({ id: 'call-1', status: 'running', title: 'read_file' }),
                expect.objectContaining({ id: 'call-1', status: 'done', title: 'read_file' }),
                expect.objectContaining({ id: 'call-3', status: 'queued', title: 'grep' }),
            ]);
        });

        it('marks a failed tool result as error', () => {
            expect(eventsFor(
                { type: 'tool_result', tool_use_id: 'call-2', is_error: true },
                { type: 'tool_result', id: 'call-4', status: 'error' },
            )).toEqual([
                expect.objectContaining({ id: 'call-2', status: 'error' }),
                expect.objectContaining({ id: 'call-4', status: 'error' }),
            ]);
        });

        it('ignores non-string titles, statuses and ids from the CLI', () => {
            expect(eventsFor({ type: 'tool_call', id: 7, title: { x: 1 }, status: 3 }))
                .toEqual([{ type: 'toolCall', title: 'tool', status: 'running', details: expect.any(String) }]);
        });
    });
});
