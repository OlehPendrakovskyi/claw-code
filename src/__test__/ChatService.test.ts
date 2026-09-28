import * as vscode from 'vscode';
import {
    ChatService,
    describePromptArgOverflow,
    PROMPT_ARG_MAX_BYTES,
    PROMPT_ARG_MAX_WINDOWS_CHARS,
} from '../chat/ChatService';

const getConfigurationMock = jest.mocked(vscode.workspace.getConfiguration);

function useSettings(settings: Record<string, unknown>): void {
    getConfigurationMock.mockReturnValue({
        get: (key: string, fallback?: unknown) => (key in settings ? settings[key] : fallback),
    } as vscode.WorkspaceConfiguration);
}

describe('ChatService', () => {
    afterEach(() => {
        getConfigurationMock.mockReset();
    });

    describe('getPermissionsForChatType', () => {
        it('forces chat mode to stay read-only', () => {
            expect(ChatService.getPermissionsForChatType('chat', 'approve-all')).toBe('approve-reads');
            expect(ChatService.getPermissionsForChatType('chat', 'deny-all')).toBe('approve-reads');
        });

        it.each(['code', 'review', 'plan'])('preserves configured permissions for %s mode', (chatType) => {
            expect(ChatService.getPermissionsForChatType(chatType, 'approve-all')).toBe('approve-all');
            expect(ChatService.getPermissionsForChatType(chatType, 'deny-all')).toBe('deny-all');
        });
    });

    describe('getSourceForModel', () => {
        it('prefers the configured source override', () => {
            useSettings({ 'chat.source': 'Custom' });
            expect(ChatService.getSourceForModel('ollama')).toBe('Custom');
        });

        it.each([
            ['Ollama-llama3', 'Local'],
            ['opencode', 'Gateway'],
            ['claude', 'API'],
            ['mystery', 'API'],
        ])('maps %s to %s', (model, source) => {
            useSettings({});
            expect(ChatService.getSourceForModel(model)).toBe(source);
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

        const LIMIT = PROMPT_ARG_MAX_WINDOWS_CHARS;

        it('counts the quotes Windows wraps around a prompt with spaces', () => {
            const spaced = 'a '.repeat((LIMIT - 3) / 2);
            expect(describePromptArgOverflow(spaced, 'win32')).toBeNull();
            expect(describePromptArgOverflow(`${spaced}ab`, 'win32')).toContain(`${LIMIT + 1} characters`);
        });

        it('counts the escaping Windows adds for embedded quotes and backslashes', () => {
            expect(describePromptArgOverflow('"'.repeat((LIMIT - 1) / 2), 'win32')).toContain(`${LIMIT + 1} characters`);
            // `\"` becomes `\\\"` (4) and the two trailing backslashes double (4), plus the wrapping quotes.
            expect(describePromptArgOverflow(`${'x'.repeat(LIMIT - 10)}\\" \\\\`, 'win32')).toContain(`${LIMIT + 1} characters`);
            expect(describePromptArgOverflow('\\\\no-quoting-needed', 'win32')).toBeNull();
        });

        it('leaves macOS prompts to the total argv limit that spawn reports itself', () => {
            expect(describePromptArgOverflow('x'.repeat(PROMPT_ARG_MAX_BYTES * 4), 'darwin')).toBeNull();
        });
    });

    describe('promptArgBudgetBytes', () => {
        it('subtracts the system prompt and chat-type prefix from the platform limit', () => {
            useSettings({ 'chat.systemPrompt': 'S'.repeat(1000) });
            const plain = ChatService.promptArgBudgetBytes('chat', 'linux')!;
            const coded = ChatService.promptArgBudgetBytes('code', 'linux')!;
            expect(plain).toBe(PROMPT_ARG_MAX_BYTES - 1002);
            expect(coded).toBeLessThan(plain);
            expect(ChatService.promptArgBudgetBytes('chat', 'win32')).toBe(Math.floor((PROMPT_ARG_MAX_WINDOWS_CHARS - 2) / 2) - 1002);
        });

        it.each(['x', '"', '\\"', ' \\', '😀'])('fits any Windows prompt of the budget built from %p', (unit) => {
            useSettings({ 'chat.systemPrompt': 'SYS "quoted"' });
            const budget = ChatService.promptArgBudgetBytes('code', 'win32')!;
            const prompt = unit.repeat(Math.floor(budget / Buffer.byteLength(unit, 'utf8')));
            const full = `SYS "quoted"\n\nYou are a coding assistant. Focus on writing and explaining code.\n\n${prompt}`;
            expect(describePromptArgOverflow(full, 'win32')).toBeNull();
        });

        it('is the whole limit without a system prompt in plain chat', () => {
            useSettings({});
            expect(ChatService.promptArgBudgetBytes('chat', 'linux')).toBe(PROMPT_ARG_MAX_BYTES);
        });

        it('never goes negative when the system prompt alone exceeds the limit', () => {
            useSettings({ 'chat.systemPrompt': 'S'.repeat(PROMPT_ARG_MAX_BYTES + 10) });
            expect(ChatService.promptArgBudgetBytes('chat', 'linux')).toBe(0);
        });

        it('uses the running platform by default', () => {
            useSettings({});
            expect(ChatService.promptArgBudgetBytes('chat')).toBe(ChatService.promptArgBudgetBytes('chat', process.platform));
        });

        it('has no per-argument budget on macOS', () => {
            expect(ChatService.promptArgBudgetBytes('chat', 'darwin')).toBeNull();
        });
    });
});
