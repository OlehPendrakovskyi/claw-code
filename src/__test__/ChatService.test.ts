import * as vscode from 'vscode';
import { ChatService } from '../chat/ChatService';

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
});
