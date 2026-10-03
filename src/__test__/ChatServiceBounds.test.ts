import type { MockInstance } from 'vitest';
import { EventEmitter } from 'events';
import { Writable } from 'stream';
import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import * as cliLauncher from '../core/cliLauncher';
import * as acpxProjectConfig from '../chat/acpxProjectConfig';
import { ChatService, ChatEvent, PROMPT_MAX_BYTES, STDERR_TAIL_MAX_CHARS, STDOUT_LINE_MAX_CHARS, ABORT_KILL_GRACE_MS } from '../chat/ChatService';
import { usePlatform } from './helpers/platform';

vi.mock('child_process', () => ({ spawn: vi.fn() }));

const spawnMock = vi.mocked(spawn);
const getConfigurationMock = vi.mocked(vscode.workspace.getConfiguration);

type FakeChild = ChildProcess & { stdin: Writable; stdout: EventEmitter; stderr: EventEmitter; stdinBytes: Buffer[] };

function fakeChild(): FakeChild {
    const stdinBytes: Buffer[] = [];
    const stdin = new Writable({
        write(chunk: Buffer, _encoding, callback) {
            stdinBytes.push(chunk);
            callback();
        },
    });
    return Object.assign(new EventEmitter() as ChildProcess, {
        pid: 4242,
        stdin,
        stdinBytes,
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
    }) as FakeChild;
}

function useSettings(settings: Record<string, unknown>): void {
    getConfigurationMock.mockReturnValue({
        get: (key: string, fallback?: unknown) => (key in settings ? settings[key] : fallback),
    } as vscode.WorkspaceConfiguration);
}

function send(prompt: string) {
    const events: ChatEvent[] = [];
    const onRunComplete = vi.fn();
    const service = new ChatService();
    service.sendMessage(prompt, '/tmp', 'codex', 'chat', e => events.push(e), undefined, onRunComplete);
    return { events, onRunComplete, service };
}

function start(prompt = 'hello') {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    return { child, ...send(prompt) };
}

const jsonLines = (...lines: object[]) => Buffer.from(lines.map(line => JSON.stringify(line)).join('\n') + '\n');
const acpUpdate = (update: object) => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update } });
const say = (text: string) => acpUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

/** A prompt whose encoded wire form measures exactly `bytes` bytes. */
function promptOfWireLength(bytes: number): string {
    // The prompt is one text block; probe the envelope with an empty text.
    const envelope = JSON.stringify([{ type: 'text', text: '' }]).length;
    return 'x'.repeat(bytes - envelope);
}

describe('ChatService buffer and abort bounds', () => {
    let killSpy: MockInstance;
    let launchSpy: MockInstance;
    let projectConfigSpy: MockInstance;

    beforeEach(() => {
        spawnMock.mockReset();
        useSettings({});
        killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
        launchSpy = vi.spyOn(cliLauncher, 'resolveCliLaunch').mockReturnValue({ command: 'acpx', args: [] });
        projectConfigSpy = vi.spyOn(acpxProjectConfig, 'checkProjectConfig').mockReturnValue({ status: 'trusted' });
    });

    afterEach(() => {
        killSpy.mockRestore();
        launchSpy.mockRestore();
        projectConfigSpy.mockRestore();
        getConfigurationMock.mockReset();
        vi.useRealTimers();
    });

    describe('PROMPT_MAX_BYTES', () => {
        it('sends a prompt whose encoded wire form measures exactly the cap', () => {
            const atLimit = promptOfWireLength(PROMPT_MAX_BYTES);
            const { events, child } = start(atLimit);
            expect(spawnMock).toHaveBeenCalledTimes(1);
            expect(child.stdinBytes[0].length).toBe(PROMPT_MAX_BYTES);
            child.emit('close', 0, null);
            expect(events).toEqual([{ type: 'done' }]);
        });

        it('refuses a prompt one byte over the cap without spawning, once', () => {
            const over = promptOfWireLength(PROMPT_MAX_BYTES) + 'x';
            const { events, onRunComplete } = send(over);
            expect(spawnMock).not.toHaveBeenCalled();
            expect(events).toEqual([
                { type: 'error', message: expect.stringContaining('too large') },
                { type: 'done' },
            ]);
            expect(onRunComplete).toHaveBeenCalledTimes(1);
        });

        it('reports the overage in whole MiB against the 30 MiB limit', () => {
            const { events } = send('x'.repeat(PROMPT_MAX_BYTES + 7 * 1024 * 1024));
            expect((events[0] as { message: string }).message).toContain('38 MiB, limit 30 MiB');
        });
    });

    describe('STDOUT_LINE_MAX_CHARS', () => {
        it('accepts a line that reaches exactly the cap and parses it', () => {
            const { child, events } = start();
            const envelope = JSON.stringify(say('')).length;
            const text = 'y'.repeat(STDOUT_LINE_MAX_CHARS - envelope);
            child.stdout.emit('data', Buffer.from(`${JSON.stringify(say(text))}\n`));
            expect(events).toEqual([{ type: 'text', text }]);
        });

        it('drops a line one character past the cap and resumes with the next line', () => {
            const { child, events } = start();
            child.stdout.emit('data', Buffer.from(`${'y'.repeat(STDOUT_LINE_MAX_CHARS + 1)}\n`));
            child.stdout.emit('data', jsonLines(say('next')));
            child.emit('close', 0, null);
            expect(events).toEqual([{ type: 'text', text: 'next' }, { type: 'done' }]);
        });

        it('drops a valid JSON-RPC line past the cap even though it parses on its own', () => {
            const { child, events } = start();
            const over = JSON.stringify(say('z'.repeat(STDOUT_LINE_MAX_CHARS)));
            expect(() => JSON.parse(over)).not.toThrow();
            child.stdout.emit('data', Buffer.from(`${over}\n`));
            child.emit('close', 0, null);
            expect(events).toEqual([{ type: 'done' }]);
        });
    });

    describe('STDERR_TAIL_MAX_CHARS', () => {
        it('keeps exactly the last chars of a flood and no more', () => {
            const { child, events } = start();
            child.stderr.emit('data', Buffer.from('a'.repeat(STDERR_TAIL_MAX_CHARS)));
            child.stderr.emit('data', Buffer.from('b'.repeat(STDERR_TAIL_MAX_CHARS)));
            child.emit('close', 1, null);
            const message = (events[0] as { message: string }).message;
            expect(message).toBe('b'.repeat(STDERR_TAIL_MAX_CHARS));
        });

        it('surfaces the tail as the failure message on a non-zero exit', () => {
            const { child, events } = start();
            const head = '\n  the real failure  \n';
            child.stderr.emit('data', Buffer.from(head + 'x'.repeat(STDERR_TAIL_MAX_CHARS - head.length - 1)));
            child.emit('close', 1, null);
            expect((events[0] as { message: string }).message).toBe(`the real failure  \n${'x'.repeat(STDERR_TAIL_MAX_CHARS - head.length - 1)}`);
        });

        it('prefers an agent failure message over the stderr tail', () => {
            const { child, events } = start();
            child.stderr.emit('data', Buffer.from('stderr noise'));
            child.stdout.emit('data', jsonLines({ jsonrpc: '2.0', id: 2, error: { message: 'agent said why', data: { failureMessage: 'agent said why' } } }));
            child.emit('close', 1, null);
            expect(events[0]).toEqual({ type: 'error', message: expect.stringContaining('agent said why') });
        });
    });

    describe('ABORT_KILL_GRACE_MS', () => {
        // The grace escalation signals the POSIX process group; Windows kills the tree once.
        usePlatform('linux');

        it('sends SIGTERM at once and SIGKILL to the process group exactly after the grace period', () => {
            vi.useFakeTimers();
            const { child, service } = start();
            service.abort();
            expect(killSpy).toHaveBeenCalledTimes(1);
            expect(killSpy).toHaveBeenLastCalledWith(-4242, 'SIGTERM');
            vi.advanceTimersByTime(ABORT_KILL_GRACE_MS - 1);
            expect(killSpy).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(1);
            expect(killSpy).toHaveBeenLastCalledWith(-4242, 'SIGKILL');
            child.emit('close', null, 'SIGKILL');
        });

        it('does not escalate to SIGKILL once the process exited within the grace', () => {
            vi.useFakeTimers();
            const { child, service } = start();
            service.abort();
            child.emit('close', null, 'SIGTERM');
            vi.advanceTimersByTime(ABORT_KILL_GRACE_MS * 2);
            expect(killSpy).toHaveBeenCalledTimes(1);
        });

        it('aborts a previous run when a new send starts, so at most one run holds the service', () => {
            const first = start('first');
            const secondChild = fakeChild();
            spawnMock.mockReturnValue(secondChild);
            first.service.sendMessage('second', '/tmp', 'codex', 'chat', () => undefined);
            expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
            expect(secondChild.stdin.writableEnded).toBe(true);
            first.child.emit('close', null, 'SIGTERM');
        });
    });

    describe('exit handling', () => {
        it('completes a run exactly once even when close arrives twice', () => {
            const { child, events, onRunComplete } = start();
            child.emit('close', 0, null);
            child.emit('close', 0, null);
            expect(events).toEqual([{ type: 'done' }]);
            expect(onRunComplete).toHaveBeenCalledTimes(1);
        });

        it('reports a non-zero exit through stderr when there is any', () => {
            const { child, events, onRunComplete } = start();
            child.stderr.emit('data', Buffer.from('boom'));
            child.emit('close', 3, null);
            expect(events).toEqual([{ type: 'error', message: 'boom' }, { type: 'done' }]);
            expect(onRunComplete).toHaveBeenCalledTimes(1);
        });

        it('names the exit code when a failing run wrote no stderr', () => {
            const { child, events } = start();
            child.emit('close', 7, null);
            expect(events[0]).toEqual({ type: 'error', message: 'acpx exited with code 7' });
        });

        it('reports a signal death as terminated, not as success', () => {
            const { child, events } = start();
            child.emit('close', null, 'SIGKILL');
            expect(events).toEqual([{ type: 'error', message: 'acpx was terminated by SIGKILL' }, { type: 'done' }]);
        });

        it('explains a binary spawn that failed with ENOENT and releases at once', () => {
            const child = fakeChild();
            Object.defineProperty(child, 'pid', { value: undefined });
            spawnMock.mockReturnValue(child);
            const { events, onRunComplete } = send('hi');
            child.emit('error', Object.assign(new Error('spawn acpx ENOENT'), { code: 'ENOENT' }));
            expect(onRunComplete).toHaveBeenCalledTimes(1);
            child.emit('close', -2, null);
            expect(events).toEqual([
                { type: 'error', message: expect.stringContaining('acpx not found') },
                { type: 'done' },
            ]);
            expect(onRunComplete).toHaveBeenCalledTimes(1);
        });
    });
});
