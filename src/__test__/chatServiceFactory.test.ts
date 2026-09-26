import type * as GatewayConfig from '../core/gatewayConfig';

const mockConnect = jest.fn();

jest.mock('../core/gatewayConfig', () => ({
    getGatewaySettings: jest.fn(),
    getGatewayToken: jest.fn(),
}));

jest.mock('../core/gatewayChatService', () => ({
    GatewayChatService: jest.fn().mockImplementation(() => ({
        connect: mockConnect,
        dispose: jest.fn(),
        updateConnection: mockUpdateConnection,
    })),
}));

jest.mock('../webview/viewMessaging', () => ({
    log: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../chat/ChatService', () => ({
    // Use `this`-based construction (no returned object literal) so
    // `existing instanceof ChatService` in the factory stays true.
    ChatService: jest.fn(function (this: { kind: string }) {
        this.kind = 'acpx-mock';
    }),
}));

import { ChatServiceFactory } from '../webview/chatServiceFactory';
import { getGatewaySettings, getGatewayToken } from '../core/gatewayConfig';
import { GatewayChatService } from '../core/gatewayChatService';
import { ChatService } from '../chat/ChatService';

const mockSettings = getGatewaySettings as jest.MockedFunction<typeof GatewayConfig.getGatewaySettings>;
const mockToken = getGatewayToken as jest.MockedFunction<typeof GatewayConfig.getGatewayToken>;
const mockUpdateConnection = jest.fn();

import type * as vscode from 'vscode';

function contextStub(): vscode.ExtensionContext {
    return { secrets: { get: async () => 'unused-stub' } } as unknown as vscode.ExtensionContext;
}

function statusSpy() {
    const calls: Array<[string, boolean]> = [];
    return { calls, onStatus: (t: string, ok: boolean) => calls.push([t, ok]) };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockSettings.mockReturnValue({ url: 'ws://127.0.0.1:18789', transport: 'auto' });
    mockToken.mockResolvedValue('secret-token');
});

describe('ChatServiceFactory.resolve', () => {
    it('uses acpx without probing when transport is forced to acpx', async () => {
        mockSettings.mockReturnValue({ url: 'ws://x', transport: 'acpx' });
        const spy = statusSpy();
        const factory = new ChatServiceFactory(contextStub(), spy.onStatus);

        const choice = await factory.resolve();

        expect(choice.transport).toBe('acpx');
        expect(choice.service).toEqual({ kind: 'acpx-mock' });
        expect(mockToken).not.toHaveBeenCalled();
        expect(mockConnect).not.toHaveBeenCalled();
        expect(spy.calls).toContainEqual(['acpx', true]);
    });

    it('reuses the existing acpx service across sends', async () => {
        mockSettings.mockReturnValue({ url: 'ws://x', transport: 'acpx' });
        const factory = new ChatServiceFactory(contextStub());
        const existing = new ChatService();

        const first = await factory.resolve(existing as never);
        const second = await factory.resolve(first.service as never);

        expect(second.service).toBe(first.service);
        expect(first.service).toBe(existing as never);
        expect(ChatService).toHaveBeenCalledTimes(1);
    });

    it('keeps a tokenless gateway client (with status false) when transport is forced to gateway', async () => {
        mockSettings.mockReturnValue({ url: 'ws://x', transport: 'gateway' });
        mockToken.mockResolvedValue('');
        const spy = statusSpy();
        const factory = new ChatServiceFactory(contextStub(), spy.onStatus);

        const choice = await factory.resolve();

        expect(choice.transport).toBe('gateway');
        expect(GatewayChatService).toHaveBeenCalledWith({ url: 'ws://x', token: '' });
        expect(spy.calls).toContainEqual(['gateway', false]);
    });

    it('falls back to acpx in auto mode when gateway is tokenless', async () => {
        mockToken.mockResolvedValue('');
        const spy = statusSpy();
        const factory = new ChatServiceFactory(contextStub(), spy.onStatus);

        const choice = await factory.resolve();

        expect(choice.transport).toBe('acpx');
        expect(spy.calls).toContainEqual(['acpx', true]);
    });

    it('selects gateway on successful connect', async () => {
        mockConnect.mockResolvedValue(undefined);
        const spy = statusSpy();
        const factory = new ChatServiceFactory(contextStub(), spy.onStatus);

        const choice = await factory.resolve();

        expect(choice.transport).toBe('gateway');
        expect(GatewayChatService).toHaveBeenCalled();
        expect(typeof (choice.service as { connect: unknown }).connect).toBe('function');
        expect(spy.calls).toContainEqual(['gateway', true]);
    });

    it('falls back to acpx in auto mode when connect throws', async () => {
        mockConnect.mockRejectedValue(new Error('boom'));
        const spy = statusSpy();
        const factory = new ChatServiceFactory(contextStub(), spy.onStatus);

        const choice = await factory.resolve();

        expect(choice.transport).toBe('acpx');
        expect(spy.calls).toContainEqual(['acpx', true]);
    });

    it('stays on gateway with status false in forced gateway mode when connect times out', async () => {
        mockConnect.mockReturnValue(new Promise(() => { /* hangs -> factory timeout */ }));
        mockSettings.mockReturnValue({ url: 'ws://x', transport: 'gateway' });
        const spy = statusSpy();
        const factory = new ChatServiceFactory(contextStub(), spy.onStatus);

        const choice = await factory.resolve();

        expect(choice.transport).toBe('gateway');
        expect(spy.calls).toContainEqual(['gateway', false]);
    });

    it('caches the gateway client and updates its credentials in place when the token changes', async () => {
        mockConnect.mockResolvedValue(undefined);
        const factory = new ChatServiceFactory(contextStub());

        await factory.resolve();
        await factory.resolve();

        expect(GatewayChatService).toHaveBeenCalledTimes(1);

        mockToken.mockResolvedValue('rotated-token');
        await factory.resolve();

        // Same instance is kept (threads hold it for lifecycle actions);
        // credentials are refreshed in place instead of dispose-and-recreate.
        expect(GatewayChatService).toHaveBeenCalledTimes(1);
        expect(mockUpdateConnection).toHaveBeenCalledWith('ws://127.0.0.1:18789', 'rotated-token');
    });
});
