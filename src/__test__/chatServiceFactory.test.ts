import type * as GatewayConfig from '../core/gatewayConfig';
import type { PairingState } from '../core/gatewayChatService';

const mockConnect = jest.fn();
// Declare before the hoisted jest.mock factories: they reference these
// spies, and the factory can run before later const initializers.
const mockUpdateConnection = jest.fn();
const mockSuspend = jest.fn();
const mockGetProtocolVersion = jest.fn((): number | null => 4);
const mockResetDeviceIdentity = jest.fn();
const mockIdentityListeners: Array<() => void> = [];
const mockDeviceStore = {
    onDidChangeIdentity: (listener: () => void) => {
        mockIdentityListeners.push(listener);
        return { dispose: () => undefined };
    },
    dispose: jest.fn(),
};

jest.mock('../core/gatewayConfig', () => ({
    isValidGatewayUrl: jest.requireActual('../core/gatewayConfig').isValidGatewayUrl,
    sendsTokenInCleartext: jest.requireActual('../core/gatewayConfig').sendsTokenInCleartext,
    getGatewaySettings: jest.fn(),
    getGatewayToken: jest.fn(),
    migrateLegacyGatewayToken: jest.fn(async () => undefined),
    isLoopbackGatewayUrl: jest.requireActual('../core/gatewayConfig').isLoopbackGatewayUrl,
    SecretDeviceCredentialStore: jest.fn(() => mockDeviceStore),
}));

const mockConnectionListeners: Array<(connected: boolean) => void> = [];
const mockPairingListeners: Array<(state: PairingState) => void> = [];

jest.mock('../core/gatewayChatService', () => ({
    GatewayChatService: jest.fn().mockImplementation(() => ({
        connect: mockConnect,
        dispose: jest.fn(),
        updateConnection: mockUpdateConnection,
        suspend: mockSuspend,
        getProtocolVersion: mockGetProtocolVersion,
        onConnectionStateChange: (listener: (connected: boolean) => void) => {
            mockConnectionListeners.push(listener);
            return () => undefined;
        },
        onPairingChange: (listener: (state: PairingState) => void) => {
            mockPairingListeners.push(listener);
            return () => undefined;
        },
        resetDeviceIdentity: mockResetDeviceIdentity,
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
import { GatewayConnectError } from '../core/gatewayProtocol/model';
import type { HandshakeRejection } from '../core/gatewayProtocol/model';

const mockSettings = getGatewaySettings as jest.MockedFunction<typeof GatewayConfig.getGatewaySettings>;
const mockToken = getGatewayToken as jest.MockedFunction<typeof GatewayConfig.getGatewayToken>;

import * as vscode from 'vscode';

let secretListeners: Array<() => void> = [];

function contextStub(): vscode.ExtensionContext {
    const secrets: Partial<vscode.SecretStorage> = {
        get: async () => 'unused-stub',
        onDidChange: ((listener: () => void) => {
            secretListeners.push(listener);
            return { dispose: () => undefined };
        }) as vscode.SecretStorage['onDidChange'],
    };
    return { secrets } as Partial<vscode.ExtensionContext> as vscode.ExtensionContext;
}

/** Fire the listeners the factory registered, then let reconcile() settle. */
async function changeSecrets(): Promise<void> {
    for (const listener of secretListeners) listener();
    await new Promise((resolve) => setImmediate(resolve));
}

async function changeConfiguration(section: string): Promise<void> {
    for (const [listener] of jest.mocked(vscode.workspace.onDidChangeConfiguration).mock.calls) {
        (listener as (event: { affectsConfiguration: (name: string) => boolean }) => void)({
            affectsConfiguration: (name) => section.startsWith(name),
        });
    }
    await new Promise((resolve) => setImmediate(resolve));
}

function statusSpy() {
    const calls: Array<[string, boolean]> = [];
    const versions: Array<number | null> = [];
    return {
        calls,
        versions,
        onStatus: (t: string, ok: boolean, protocolVersion: number | null) => {
            calls.push([t, ok]);
            versions.push(protocolVersion);
        },
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    secretListeners = [];
    mockConnectionListeners.length = 0;
    mockPairingListeners.length = 0;
    mockIdentityListeners.length = 0;
    mockSettings.mockReturnValue({ url: 'ws://127.0.0.1:18789', transport: 'auto', protocolVersion: 'auto' });
    mockToken.mockResolvedValue('secret-token');
});

describe('ChatServiceFactory', () => {
    it('uses acpx without probing when transport is forced to acpx', async () => {
        mockSettings.mockReturnValue({ url: 'ws://x', transport: 'acpx', protocolVersion: 'auto' });
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
        mockSettings.mockReturnValue({ url: 'ws://x', transport: 'acpx', protocolVersion: 'auto' });
        const factory = new ChatServiceFactory(contextStub());
        const existing = new ChatService();

        const first = await factory.resolve(existing as never);
        const second = await factory.resolve(first.service as never);

        expect(second.service).toBe(first.service);
        expect(first.service).toBe(existing as never);
        expect(ChatService).toHaveBeenCalledTimes(1);
    });

    it('keeps a tokenless gateway client (with status false) when transport is forced to gateway', async () => {
        mockSettings.mockReturnValue({ url: 'ws://x', transport: 'gateway', protocolVersion: 'auto' });
        mockToken.mockResolvedValue('');
        const spy = statusSpy();
        const factory = new ChatServiceFactory(contextStub(), spy.onStatus);

        const choice = await factory.resolve();

        expect(choice.transport).toBe('gateway');
        expect(GatewayChatService).toHaveBeenCalledWith(expect.objectContaining({ url: 'ws://x', token: '', protocol: 'auto' }));
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
        mockSettings.mockReturnValue({ url: 'ws://x', transport: 'gateway', protocolVersion: 'auto' });
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
        expect(mockUpdateConnection).toHaveBeenCalledWith('ws://127.0.0.1:18789', 'rotated-token', 'auto');
    });

    describe('gateway URL validation', () => {
        it('suspends a previously connected client when the URL turns invalid', async () => {
            mockConnect.mockResolvedValue(undefined);
            const onInvalidated = jest.fn();
            const factory = new ChatServiceFactory(contextStub(), undefined, onInvalidated);
            await factory.resolve();

            mockSettings.mockReturnValue({ url: 'not a url', transport: 'auto', protocolVersion: 'auto' });
            await expect(factory.resolve()).resolves.toMatchObject({ transport: 'acpx' });
            mockSettings.mockReturnValue({ url: 'not a url', transport: 'gateway', protocolVersion: 'auto' });
            await expect(factory.resolve()).rejects.toThrow('ws:// or wss://');

            expect(mockSuspend).toHaveBeenCalledTimes(1);
            expect(onInvalidated).toHaveBeenCalledWith('identity');
        });

        it('falls back to acpx in auto mode when the URL is not ws:// or wss://', async () => {
            mockSettings.mockReturnValue({ url: '127.0.0.1:18789', transport: 'auto', protocolVersion: 'auto' });
            const factory = new ChatServiceFactory(contextStub());

            const choice = await factory.resolve();

            expect(choice.transport).toBe('acpx');
            expect(GatewayChatService).not.toHaveBeenCalled();
        });

        it('rejects the send in forced gateway mode when the URL is invalid', async () => {
            mockSettings.mockReturnValue({ url: 'https://gateway.example', transport: 'gateway', protocolVersion: 'auto' });
            const factory = new ChatServiceFactory(contextStub());

            await expect(factory.resolve()).rejects.toThrow('ws:// or wss://');
            expect(GatewayChatService).not.toHaveBeenCalled();
        });

        it('warns once when the token would travel over plain ws:// to a remote host', async () => {
            mockSettings.mockReturnValue({ url: 'ws://gateway.example:18789', transport: 'gateway', protocolVersion: 'auto' });
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
            mockSettings.mockReturnValue({ url: 'ws://127.0.0.1:18789', transport: 'gateway', protocolVersion: 'auto' });
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

            mockSettings.mockReturnValue({ url: 'ws://127.0.0.1:18789', transport: 'acpx', protocolVersion: 'auto' });
            await factory.resolve();
            await factory.resolve();

            expect(onInvalidated).toHaveBeenCalledTimes(1);
            expect(onInvalidated).toHaveBeenCalledWith('transport');
            expect(mockSuspend).toHaveBeenCalledTimes(1);
        });

        it('does not invalidate anything when no gateway client was ever created', async () => {
            mockSettings.mockReturnValue({ url: 'ws://127.0.0.1:18789', transport: 'acpx', protocolVersion: 'auto' });
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
            mockSettings.mockReturnValue({ url: 'ws://127.0.0.1:18789', transport: 'acpx', protocolVersion: 'auto' });
            const factory = new ChatServiceFactory(contextStub());

            const pending = factory.resolve();
            await jest.advanceTimersByTimeAsync(5000);

            await expect(pending).resolves.toMatchObject({ transport: 'acpx' });
        });

        it('does not make every later send wait again for the same hung migration', async () => {
            jest.useFakeTimers();
            jest.mocked(migrateLegacyGatewayToken).mockReturnValueOnce(new Promise(() => undefined));
            mockSettings.mockReturnValue({ url: 'ws://127.0.0.1:18789', transport: 'acpx', protocolVersion: 'auto' });
            const factory = new ChatServiceFactory(contextStub());
            const first = factory.resolve();
            await jest.advanceTimersByTimeAsync(5000);
            await first;

            const settled = jest.fn();
            void factory.resolve().then(settled);
            await jest.advanceTimersByTimeAsync(0);

            expect(settled).toHaveBeenCalledWith(expect.objectContaining({ transport: 'acpx' }));
            expect(migrateLegacyGatewayToken).toHaveBeenCalledTimes(1);
        });

        it('retries an incomplete migration on the next send', async () => {
            jest.mocked(migrateLegacyGatewayToken).mockResolvedValueOnce('incomplete').mockResolvedValueOnce('completed');
            mockSettings.mockReturnValue({ url: 'ws://127.0.0.1:18789', transport: 'acpx', protocolVersion: 'auto' });
            const factory = new ChatServiceFactory(contextStub());
            await factory.resolve();
            await factory.resolve();
            await factory.resolve();
            expect(migrateLegacyGatewayToken).toHaveBeenCalledTimes(2);
        });

        it('retries a migration that failed, and still resolves the send', async () => {
            jest.mocked(migrateLegacyGatewayToken).mockRejectedValueOnce(new Error('keyring locked'));
            mockSettings.mockReturnValue({ url: 'ws://127.0.0.1:18789', transport: 'acpx', protocolVersion: 'auto' });
            const factory = new ChatServiceFactory(contextStub());
            await expect(factory.resolve()).resolves.toMatchObject({ transport: 'acpx' });
            await factory.resolve();
            expect(migrateLegacyGatewayToken).toHaveBeenCalledTimes(2);
        });
    });

    describe('dispose', () => {
        it('disposes the cached gateway client and builds a fresh one on the next gateway send', async () => {
            mockConnect.mockResolvedValue(undefined);
            const factory = new ChatServiceFactory(contextStub());
            const first = await factory.resolve();
            factory.dispose();
            const second = await factory.resolve();

            expect(jest.mocked(first.service as GatewayChatService).dispose).toHaveBeenCalledTimes(1);
            expect(second.service).not.toBe(first.service);
            expect(GatewayChatService).toHaveBeenCalledTimes(2);
            expect(mockUpdateConnection).not.toHaveBeenCalled();
        });

        it('is safe without a gateway client', () => {
            expect(() => new ChatServiceFactory(contextStub()).dispose()).not.toThrow();
        });
    });

    describe('SecretStorage read failures after a connect', () => {
        it('falls back to acpx without suspending the client, and resumes it without re-authenticating', async () => {
            mockConnect.mockResolvedValue(undefined);
            const onInvalidated = jest.fn();
            const factory = new ChatServiceFactory(contextStub(), undefined, onInvalidated);
            await factory.resolve();

            mockToken.mockRejectedValueOnce(new Error('keyring locked'));
            await expect(factory.resolve()).resolves.toMatchObject({ transport: 'acpx' });
            await expect(factory.resolve()).resolves.toMatchObject({ transport: 'gateway' });

            expect(mockSuspend).not.toHaveBeenCalled();
            expect(onInvalidated).not.toHaveBeenCalled();
            expect(mockUpdateConnection).not.toHaveBeenCalled();
        });

        it('treats a hung keyring as a failed read', async () => {
            jest.useFakeTimers();
            try {
                mockToken.mockReturnValue(new Promise(() => undefined));
                const factory = new ChatServiceFactory(contextStub());
                const auto = factory.resolve();
                await jest.advanceTimersByTimeAsync(5000);
                await expect(auto).resolves.toMatchObject({ transport: 'acpx' });

                mockSettings.mockReturnValue({ url: 'ws://127.0.0.1:18789', transport: 'gateway', protocolVersion: 'auto' });
                const forced = factory.resolve();
                const failure = expect(forced).rejects.toThrow('SecretStorage');
                await jest.advanceTimersByTimeAsync(5000);
                await failure;
            } finally {
                jest.useRealTimers();
            }
        });
    });

    describe('forced gateway mode without a token', () => {
        it('parks a previously connected client instead of reconnecting it tokenless', async () => {
            mockConnect.mockResolvedValue(undefined);
            const spy = statusSpy();
            const onInvalidated = jest.fn();
            const factory = new ChatServiceFactory(contextStub(), spy.onStatus, onInvalidated);
            await factory.resolve();

            mockSettings.mockReturnValue({ url: 'ws://127.0.0.1:18789', transport: 'gateway', protocolVersion: 'auto' });
            mockToken.mockResolvedValue('');
            const choice = await factory.resolve();

            expect(choice.transport).toBe('gateway');
            expect(mockSuspend).toHaveBeenCalledTimes(1);
            expect(onInvalidated).toHaveBeenCalledWith('identity');
            expect(mockUpdateConnection).not.toHaveBeenCalled();
            expect(spy.calls[spy.calls.length - 1]).toEqual(['gateway', false]);
        });

        it('does not re-authenticate when the same token comes back after a suspension', async () => {
            mockConnect.mockResolvedValue(undefined);
            const onInvalidated = jest.fn();
            const factory = new ChatServiceFactory(contextStub(), undefined, onInvalidated);
            await factory.resolve();
            mockSettings.mockReturnValue({ url: 'ws://127.0.0.1:18789', transport: 'acpx', protocolVersion: 'auto' });
            await factory.resolve();
            mockSettings.mockReturnValue({ url: 'ws://127.0.0.1:18789', transport: 'auto', protocolVersion: 'auto' });
            mockToken.mockResolvedValue('');
            await factory.resolve();
            mockToken.mockResolvedValue('secret-token');
            await expect(factory.resolve()).resolves.toMatchObject({ transport: 'gateway' });

            expect(onInvalidated.mock.calls).toEqual([['transport']]);
            expect(mockUpdateConnection).not.toHaveBeenCalled();
        });
    });

    describe('reconcile on settings changes', () => {
        it('does nothing before a gateway client exists', async () => {
            const factory = new ChatServiceFactory(contextStub());
            mockSettings.mockReturnValue({ url: 'ws://127.0.0.1:18789', transport: 'acpx', protocolVersion: 'auto' });
            await changeConfiguration('openclaw.gateway.transport');
            await changeSecrets();
            expect(mockSuspend).not.toHaveBeenCalled();
            factory.dispose();
        });

        it('parks the client as soon as the transport switches to acpx', async () => {
            mockConnect.mockResolvedValue(undefined);
            const onInvalidated = jest.fn();
            const factory = new ChatServiceFactory(contextStub(), undefined, onInvalidated);
            await factory.resolve();

            mockSettings.mockReturnValue({ url: 'ws://127.0.0.1:18789', transport: 'acpx', protocolVersion: 'auto' });
            await changeConfiguration('openclaw.chat.model');
            expect(mockSuspend).not.toHaveBeenCalled();
            await changeConfiguration('openclaw.gateway.transport');

            expect(mockSuspend).toHaveBeenCalledTimes(1);
            expect(onInvalidated).toHaveBeenCalledWith('transport');
            expect(mockConnect).toHaveBeenCalledTimes(1);
        });

        it('parks the client when its token is deleted and swaps in a new token without connecting', async () => {
            mockConnect.mockResolvedValue(undefined);
            const factory = new ChatServiceFactory(contextStub());
            await factory.resolve();

            mockToken.mockResolvedValue('rotated-token');
            await changeSecrets();
            expect(mockUpdateConnection).toHaveBeenCalledWith('ws://127.0.0.1:18789', 'rotated-token', 'auto');

            mockToken.mockResolvedValue('');
            await changeSecrets();
            expect(mockSuspend).toHaveBeenCalledTimes(1);
            expect(mockConnect).toHaveBeenCalledTimes(1);
        });

        it('reconnects a live client with the new hello when the protocol version setting changes', async () => {
            mockConnect.mockResolvedValue(undefined);
            const onInvalidated = jest.fn();
            const factory = new ChatServiceFactory(contextStub(), undefined, onInvalidated);
            await factory.resolve();
            expect(GatewayChatService).toHaveBeenCalledWith(expect.objectContaining({ url: 'ws://127.0.0.1:18789', token: 'secret-token', protocol: 'auto' }));

            mockSettings.mockReturnValue({ url: 'ws://127.0.0.1:18789', transport: 'auto', protocolVersion: '4' });
            await changeConfiguration('openclaw.gateway.protocolVersion');

            expect(onInvalidated.mock.calls).toEqual([['identity']]);
            expect(mockUpdateConnection).toHaveBeenCalledWith('ws://127.0.0.1:18789', 'secret-token', '4');
            expect(GatewayChatService).toHaveBeenCalledTimes(1);
        });

        it('leaves the client alone when the protocol version setting is unchanged', async () => {
            mockConnect.mockResolvedValue(undefined);
            const onInvalidated = jest.fn();
            const factory = new ChatServiceFactory(contextStub(), undefined, onInvalidated);
            await factory.resolve();

            await changeConfiguration('openclaw.gateway.protocolVersion');

            expect(onInvalidated).not.toHaveBeenCalled();
            expect(mockUpdateConnection).not.toHaveBeenCalled();
        });

        it('logs instead of throwing when forced gateway mode cannot read the token', async () => {
            mockConnect.mockResolvedValue(undefined);
            const factory = new ChatServiceFactory(contextStub());
            await factory.resolve();
            mockSettings.mockReturnValue({ url: 'ws://127.0.0.1:18789', transport: 'gateway', protocolVersion: 'auto' });
            mockToken.mockRejectedValue(new Error('keyring locked'));

            await expect(factory.reconcile()).resolves.toBeUndefined();
            expect(mockSuspend).not.toHaveBeenCalled();
        });

        it('stops listening once disposed', async () => {
            mockConnect.mockResolvedValue(undefined);
            const disposals: jest.Mock[] = [];
            jest.mocked(vscode.workspace.onDidChangeConfiguration).mockImplementationOnce(() => {
                const dispose = jest.fn();
                disposals.push(dispose);
                return { dispose };
            });
            const factory = new ChatServiceFactory(contextStub());
            factory.dispose();
            expect(disposals[0]).toHaveBeenCalledTimes(1);
        });
    });

    describe('connection status', () => {
        it('follows the client connection state while it is active, not while it is parked', async () => {
            mockConnect.mockResolvedValue(undefined);
            const spy = statusSpy();
            const factory = new ChatServiceFactory(contextStub(), spy.onStatus);
            await factory.resolve();
            const [announce] = mockConnectionListeners;

            spy.calls.length = 0;
            announce(false);
            announce(true);
            expect(spy.calls).toEqual([['gateway', false], ['gateway', true]]);

            mockSettings.mockReturnValue({ url: 'ws://127.0.0.1:18789', transport: 'acpx', protocolVersion: 'auto' });
            await factory.resolve();
            spy.calls.length = 0;
            announce(false);
            expect(spy.calls).toEqual([]);
        });
    });

    describe('protocol version in the status', () => {
        it('reports the negotiated version on connect and on later state changes, none for acpx', async () => {
            mockConnect.mockResolvedValue(undefined);
            const spy = statusSpy();
            const factory = new ChatServiceFactory(contextStub(), spy.onStatus);

            await factory.resolve();
            expect(spy.calls[spy.calls.length - 1]).toEqual(['gateway', true]);
            expect(spy.versions[spy.versions.length - 1]).toBe(4);

            mockGetProtocolVersion.mockReturnValueOnce(null);
            mockConnectionListeners[0](false);
            expect(spy.versions[spy.versions.length - 1]).toBeNull();

            mockSettings.mockReturnValue({ url: 'ws://127.0.0.1:18789', transport: 'acpx', protocolVersion: 'auto' });
            await factory.resolve();
            expect(spy.calls[spy.calls.length - 1]).toEqual(['acpx', true]);
            expect(spy.versions[spy.versions.length - 1]).toBeNull();
        });
    });

    describe('handshake rejection warnings', () => {
        const tokenMismatch: HandshakeRejection = {
            kind: 'permanent',
            code: 'AUTH_TOKEN_MISMATCH',
            message: 'unauthorized: gateway token mismatch',
            hint: 'Gateway rejected the token — run "OpenClaw: Connect to Gateway" to update it.',
        };

        it.each(['auto', 'gateway'] as const)('warns once per code and endpoint in %s mode', async (transport) => {
            mockSettings.mockReturnValue({ url: 'ws://127.0.0.1:18789', transport, protocolVersion: 'auto' });
            mockConnect.mockRejectedValue(new GatewayConnectError('rejected', tokenMismatch));
            const factory = new ChatServiceFactory(contextStub());

            await factory.resolve();
            await factory.resolve();
            expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
                'OpenClaw: Gateway rejected the token — run "OpenClaw: Connect to Gateway" to update it. (AUTH_TOKEN_MISMATCH)'
            );

            mockSettings.mockReturnValue({ url: 'ws://localhost:18789', transport, protocolVersion: 'auto' });
            await factory.resolve();
            expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(2);
        });

        it('warns about a pending pairing but not about a transient rejection', async () => {
            const factory = new ChatServiceFactory(contextStub());
            mockConnect.mockRejectedValueOnce(
                new GatewayConnectError('rejected', { ...tokenMismatch, kind: 'backoff', code: 'AUTH_RATE_LIMITED' })
            );
            await expect(factory.resolve()).resolves.toMatchObject({ transport: 'acpx' });
            expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();

            mockConnect.mockRejectedValueOnce(
                new GatewayConnectError('rejected', { ...tokenMismatch, kind: 'pause', code: 'PAIRING_REQUIRED', hint: 'Approve this device.' })
            );
            await factory.resolve();
            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('OpenClaw: Approve this device. (PAIRING_REQUIRED)');
        });
    });
    describe('device identity and pairing', () => {
        const pending = (requestId: string, status: 'pending' | 'expired' = 'pending'): PairingState => ({
            status,
            request: { requestId, reason: 'not-paired' },
            hint: `The gateway waits for an operator to approve this device: run \`openclaw devices approve ${requestId}\` on the gateway host.`,
        });

        it('gives the gateway client the SecretStorage device store and trusts only loopback with a device token', async () => {
            const factory = new ChatServiceFactory(contextStub());
            mockConnect.mockResolvedValue(undefined);
            await factory.resolve();
            const options = jest.mocked(GatewayChatService).mock.calls[0][0];
            expect(options.deviceCredentials).toBe(mockDeviceStore);
            expect(options.trustsDeviceTokenRetry?.('ws://127.0.0.1:18789')).toBe(true);
            expect(options.trustsDeviceTokenRetry?.('wss://gateway.example')).toBe(false);
        });

        it('announces each pairing request once, with the approve command to copy, and then its approval', async () => {
            jest.mocked(vscode.window.showWarningMessage).mockResolvedValue('Copy Command' as never);
            const factory = new ChatServiceFactory(contextStub());
            mockConnect.mockResolvedValue(undefined);
            await factory.resolve();
            const announce = mockPairingListeners[0];
            announce(pending('req-1'));
            announce(pending('req-1'));
            await new Promise((resolve) => setImmediate(resolve));
            expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
                expect.stringMatching(/openclaw devices approve req-1.*connects as soon as it is approved/),
                'Copy Command'
            );
            expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('openclaw devices approve req-1');
            announce(pending('req-2'));
            expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(2);
            announce({ status: 'approved' });
            announce({ status: 'approved' });
            expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1);
        });

        it('says when it gave up waiting for an approval', async () => {
            jest.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined);
            const factory = new ChatServiceFactory(contextStub());
            mockConnect.mockResolvedValue(undefined);
            await factory.resolve();
            mockPairingListeners[0](pending('req-1', 'expired'));
            expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('not approved in time'), 'Copy Command');
            expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
        });

        it('leaves a pairing rejection to the pairing notification', async () => {
            const factory = new ChatServiceFactory(contextStub());
            const rejection = { kind: 'pause', code: 'PAIRING_REQUIRED', message: '', hint: 'Approve.', pairing: { requestId: 'req-1', reason: null } } as const;
            mockConnect.mockRejectedValueOnce(new GatewayConnectError('rejected', rejection));
            await factory.resolve();
            expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
        });

        it('makes the gateway client prove the new identity once the stored one changed', async () => {
            const factory = new ChatServiceFactory(contextStub());
            mockConnect.mockResolvedValue(undefined);
            for (const listener of mockIdentityListeners) listener();
            expect(mockResetDeviceIdentity).not.toHaveBeenCalled();
            await factory.resolve();
            for (const listener of mockIdentityListeners) listener();
            expect(mockResetDeviceIdentity).toHaveBeenCalledTimes(1);
        });
    });
});
