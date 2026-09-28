import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import {
    ChatService,
    ChatEvent,
    describePromptArgOverflow,
    PROMPT_ARG_MAX_BYTES,
    PROMPT_ARG_MAX_WINDOWS_CHARS,
} from '../chat/ChatService';

jest.mock('child_process', () => ({ spawn: jest.fn() }));

const spawnMock = jest.mocked(spawn);

function fakeChild(): ChildProcess {
    return Object.assign(new EventEmitter() as ChildProcess, {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: jest.fn(),
    });
}

function send(prompt: string) {
    const events: ChatEvent[] = [];
    const onRunComplete = jest.fn();
    new ChatService().sendMessage(prompt, '/tmp', 'codex', 'chat', e => events.push(e), undefined, onRunComplete);
    return { events, onRunComplete };
}

describe('ChatService.sendMessage', () => {
    beforeEach(() => {
        spawnMock.mockReset();
    });

    describe('argv guards', () => {

        it('replaces NUL characters before they reach spawn', () => {
            spawnMock.mockReturnValue(fakeChild());
            send('before\0after');
            const args = spawnMock.mock.calls[0][1] as readonly string[];
            expect(args.some(arg => arg.includes('\0'))).toBe(false);
            expect(args[args.length - 1]).toContain('before�after');
        });

        const perArgumentLimited = process.platform === 'linux' || process.platform === 'win32' ? it : it.skip;

        perArgumentLimited('refuses a prompt over the argument limit without spawning, completing once', () => {
            const { events, onRunComplete } = send('x'.repeat(PROMPT_ARG_MAX_BYTES + 1));
            expect(spawnMock).not.toHaveBeenCalled();
            expect(events.map(e => e.type)).toEqual(['error', 'done']);
            expect((events[0] as { message: string }).message).toContain('too large');
            expect(onRunComplete).toHaveBeenCalledTimes(1);
        });

        it('completes the run with an error when spawn throws synchronously', () => {
            spawnMock.mockImplementation(() => {
                throw new Error('spawn E2BIG');
            });
            const { events, onRunComplete } = send('hello');
            expect(events).toEqual([{ type: 'error', message: 'spawn E2BIG' }, { type: 'done' }]);
            expect(onRunComplete).toHaveBeenCalledTimes(1);
        });
    });

    describe('acpx tool events', () => {
        const runWithStdout = (lines: object[]) => {
            const child = fakeChild();
            spawnMock.mockReturnValue(child);
            const { events } = send('hello');
            child.stdout!.emit('data', Buffer.from(lines.map(line => JSON.stringify(line)).join('\n') + '\n'));
            return events.filter(e => e.type === 'toolCall');
        };

        it('gives a tool result the id of its call so the running entry is updated in place', () => {
            const tools = runWithStdout([
                { type: 'tool_use', id: 'call-1', name: 'read_file' },
                { type: 'tool_result', tool_use_id: 'call-1', name: 'read_file' },
            ]);
            expect(tools).toEqual([
                expect.objectContaining({ id: 'call-1', status: 'running', title: 'read_file' }),
                expect.objectContaining({ id: 'call-1', status: 'done', title: 'read_file' }),
            ]);
        });

        it('marks a failed tool result as error', () => {
            const tools = runWithStdout([{ type: 'tool_result', tool_use_id: 'call-2', is_error: true }]);
            expect(tools).toEqual([expect.objectContaining({ id: 'call-2', status: 'error' })]);
        });

        it('ignores non-string titles, statuses and ids from the CLI', () => {
            const tools = runWithStdout([{ type: 'tool_call', id: 7, title: { x: 1 }, status: 3 }]);
            expect(tools).toEqual([{ type: 'toolCall', title: 'tool', status: 'running', details: expect.any(String) }]);
        });
    });

    describe('describePromptArgOverflow', () => {
        it('measures Linux prompts in UTF-8 bytes against MAX_ARG_STRLEN', () => {
            expect(describePromptArgOverflow('x'.repeat(PROMPT_ARG_MAX_BYTES), 'linux')).toBeNull();
            expect(describePromptArgOverflow('ж'.repeat(PROMPT_ARG_MAX_BYTES / 2 + 1), 'linux')).toContain('KiB');
        });

        it('measures Windows prompts in UTF-16 units against the command-line cap', () => {
            expect(describePromptArgOverflow('x'.repeat(PROMPT_ARG_MAX_WINDOWS_CHARS), 'win32')).toBeNull();
            expect(describePromptArgOverflow('x'.repeat(PROMPT_ARG_MAX_WINDOWS_CHARS + 1), 'win32')).toContain('characters');
        });

        it('leaves macOS prompts to the total argv limit that spawn reports itself', () => {
            expect(describePromptArgOverflow('x'.repeat(PROMPT_ARG_MAX_BYTES * 4), 'darwin')).toBeNull();
        });
    });

    describe('promptArgBudgetBytes', () => {
        afterEach(() => {
            jest.mocked(vscode.workspace.getConfiguration).mockReset();
        });

        it('subtracts the system prompt and chat-type prefix from the platform limit', () => {
            jest.mocked(vscode.workspace.getConfiguration).mockReturnValue({
                get: (key: string, fallback?: unknown) => (key === 'chat.systemPrompt' ? 'S'.repeat(1000) : fallback),
            } as vscode.WorkspaceConfiguration);
            const plain = ChatService.promptArgBudgetBytes('chat', 'linux')!;
            const coded = ChatService.promptArgBudgetBytes('code', 'linux')!;
            expect(plain).toBe(PROMPT_ARG_MAX_BYTES - 1002);
            expect(coded).toBeLessThan(plain);
            expect(ChatService.promptArgBudgetBytes('chat', 'win32')).toBe(PROMPT_ARG_MAX_WINDOWS_CHARS - 1002);
        });

        it('has no per-argument budget on macOS', () => {
            expect(ChatService.promptArgBudgetBytes('chat', 'darwin')).toBeNull();
        });
    });
});
