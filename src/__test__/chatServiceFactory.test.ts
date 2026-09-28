import type * as GatewayConfig from '../core/gatewayConfig';

const mockConnect = jest.fn();
// Declare before the hoisted jest.mock factories: they reference these
// spies, and the factory can run before later const initializers.
const mockUpdateConnection = jest.fn();
const mockSuspend = jest.fn();

jest.mock('../core/gatewayConfig', () => ({
    isValidGatewayUrl: jest.requireActual('../core/gatewayConfig').isValidGatewayUrl,
    sendsTokenInCleartext: jest.requireActual('../core/gatewayConfig').sendsTokenInCleartext,
    getGatewaySettings: jest.fn(),
    getGatewayToken: jest.fn(),
    migrateLegacyGatewayToken: jest.fn(async () => undefined),
}));

jest.mock('../core/gatewayChatService', () => ({
    GatewayChatService: jest.fn().mockImplementation(() => ({
        connect: mockConnect,
        dispose: jest.fn(),
        updateConnection: mockUpdateConnection,
        suspend: mockSuspend,
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
import { getGatewaySettings, getGatewayToken, migrateLegacyGatewayToken } from '../core/gatewayConfig';
import { GatewayChatService } from '../core/gatewayChatService';
import { ChatService } from '../chat/ChatService';

const mockSettings = getGatewaySettings as jest.MockedFunction<typeof GatewayConfig.getGatewaySettings>;
const mockToken = getGatewayToken as jest.MockedFunction<typeof GatewayConfig.getGatewayToken>;

import * as vscode from 'vscode';

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

    describe('gateway URL validation', () => {
        it('falls back to acpx in auto mode when the URL is not ws:// or wss://', async () => {
            mockSettings.mockReturnValue({ url: '127.0.0.1:18789', transport: 'auto' });
            const factory = new ChatServiceFactory(contextStub());

            const choice = await factory.resolve();

            expect(choice.transport).toBe('acpx');
            expect(GatewayChatService).not.toHaveBeenCalled();
        });

        it('rejects the send in forced gateway mode when the URL is invalid', async () => {
            mockSettings.mockReturnValue({ url: 'https://gateway.example', transport: 'gateway' });
            const factory = new ChatServiceFactory(contextStub());

            await expect(factory.resolve()).rejects.toThrow('ws:// or wss://');
            expect(GatewayChatService).not.toHaveBeenCalled();
        });

        it('warns once when the token would travel over plain ws:// to a remote host', async () => {
            mockSettings.mockReturnValue({ url: 'ws://gateway.example:18789', transport: 'gateway' });
            mockConnect.mockResolvedValue(undefined);
            const factory = new ChatServiceFactory(contextStub());

            await factory.resolve();
            await factory.resolve();

            expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('gateway.example:18789'));
        });

        it('does not warn for a loopback ws:// gateway', async () => {
            mockConnect.mockResolvedValue(undefined);
            const factory = new ChatServiceFactory(contextStub());

            await factory.resolve();

            expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
        });
    });

    describe('SecretStorage failures', () => {
        it('falls back to acpx in auto mode when the token cannot be read', async () => {
            mockToken.mockRejectedValue(new Error('keyring locked'));
            const factory = new ChatServiceFactory(contextStub());

            const choice = await factory.resolve();

            expect(choice.transport).toBe('acpx');
        });

        it('rejects the send in forced gateway mode when the token cannot be read', async () => {
            mockSettings.mockReturnValue({ url: 'ws://127.0.0.1:18789', transport: 'gateway' });
            mockToken.mockRejectedValue(new Error('keyring locked'));
            const factory = new ChatServiceFactory(contextStub());

            await expect(factory.resolve()).rejects.toThrow('SecretStorage');
        });
    });

    describe('transport switch to acpx', () => {
        it('invalidates gateway runs and suspends the client once, not on every acpx send', async () => {
            mockConnect.mockResolvedValue(undefined);
            const onInvalidated = jest.fn();
            const factory = new ChatServiceFactory(contextStub(), undefined, onInvalidated);
            await factory.resolve();

            mockSettings.mockReturnValue({ url: 'ws://127.0.0.1:18789', transport: 'acpx' });
            await factory.resolve();
            await factory.resolve();

            expect(onInvalidated).toHaveBeenCalledTimes(1);
            expect(onInvalidated).toHaveBeenCalledWith('transport');
            expect(mockSuspend).toHaveBeenCalledTimes(1);
        });

        it('does not invalidate anything when no gateway client was ever created', async () => {
            mockSettings.mockReturnValue({ url: 'ws://127.0.0.1:18789', transport: 'acpx' });
            const onInvalidated = jest.fn();
            const factory = new ChatServiceFactory(contextStub(), undefined, onInvalidated);

            await factory.resolve();

            expect(onInvalidated).not.toHaveBeenCalled();
        });
    });

    describe('token revocation', () => {
        it('reports a token that disappeared as an identity change, not a transport switch', async () => {
            mockConnect.mockResolvedValue(undefined);
            const onInvalidated = jest.fn();
            const factory = new ChatServiceFactory(contextStub(), undefined, onInvalidated);
            await factory.resolve();

            mockToken.mockResolvedValue('');
            const choice = await factory.resolve();

            expect(choice.transport).toBe('acpx');
            expect(onInvalidated).toHaveBeenCalledWith('identity');
            expect(onInvalidated).not.toHaveBeenCalledWith('transport');
            expect(mockSuspend).toHaveBeenCalledTimes(1);
        });
    });

    describe('legacy token migration wait', () => {
        afterEach(() => {
            jest.useRealTimers();
        });

        it('resolves without the migration when it hangs past the wait limit', async () => {
            jest.useFakeTimers();
            jest.mocked(migrateLegacyGatewayToken).mockReturnValueOnce(new Promise(() => undefined));
            mockSettings.mockReturnValue({ url: 'ws://127.0.0.1:18789', transport: 'acpx' });
            const factory = new ChatServiceFactory(contextStub());

            const pending = factory.resolve();
            await jest.advanceTimersByTimeAsync(5000);

            await expect(pending).resolves.toMatchObject({ transport: 'acpx' });
        });
    });
});
