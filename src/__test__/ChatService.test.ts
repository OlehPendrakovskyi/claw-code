import * as vscode from 'vscode';
import { ChatService } from '../chat/ChatService';

const getConfigurationMock = vi.mocked(vscode.workspace.getConfiguration);

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
        it.each([
            ['approve-all', 'approve-reads'],
            ['approve-reads', 'approve-reads'],
            ['deny-all', 'deny-all'],
            ['unknown', 'approve-reads'],
        ])('gives chat mode the stricter of %s and read-only: %s', (configured, expected) => {
            expect(ChatService.getPermissionsForChatType('chat', configured)).toBe(expected);
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
});
