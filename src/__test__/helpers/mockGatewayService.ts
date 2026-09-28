/**
 * A stand-in for GatewayChatService in provider specs, plus session and
 * history fixtures parsed from schema-validated v4 wire payloads, so they
 * carry exactly the shapes the real client hands the provider.
 *
 * Usage: jest.mock('../core/gatewayChatService', () => jest.requireActual('./helpers/mockGatewayService').mockGatewayModule());
 */

import type { ChatEvent } from '../../chat/ChatService';
import type { GatewaySend } from '../../core/gatewayChatService';
import type { HistorySnapshot, SessionSummary } from '../../core/gatewayProtocol/model';
import { v4Adapter } from '../../core/gatewayProtocol/v4/adapter';
import { assertValidResult, payloads } from './gatewayV4';

/** Keeps the real class's run ownership: a send owns its session until its sink hears `done` or it is aborted. */
class MockGatewayChatService {
    private readonly ownedSessions = new Set<string>();

    /** Identity by default; a spec teaches it an alias with mockImplementation. */
    canonicalSessionKey = jest.fn((sessionKey: string): string => sessionKey);
    hasOwnedRun = jest.fn((sessionKey: string): boolean => this.ownedSessions.has(this.canonicalSessionKey(sessionKey)));
    abort = jest.fn((sessionKey: string): void => {
        this.ownedSessions.delete(this.canonicalSessionKey(sessionKey));
    });
    /** Records the send; its onEvent is wrapped in place so the recorded call still delivers to the provider. */
    sendMessage = jest.fn((send: GatewaySend): void => {
        const sessionKey = this.canonicalSessionKey(send.sessionKey);
        const deliver = send.onEvent;
        this.ownedSessions.add(sessionKey);
        send.onEvent = (event: ChatEvent) => {
            if (event.type === 'done') this.ownedSessions.delete(sessionKey);
            deliver(event);
        };
    });
    removeTranscriptSink = jest.fn();
    rebindTranscriptSink = jest.fn();
    clearSessionSink = jest.fn();
    getGatewayIdentity = jest.fn(() => 'gateway-1');
    getProtocolVersion = jest.fn(() => 4);
    getTransportLimits = jest.fn(() => v4Adapter.defaultLimits());
    attachmentWireBytes = jest.fn((attachment: { name: string; mimeType: string; byteLength: number }) => v4Adapter.attachmentWireBytes(attachment));
    listSessions = jest.fn(async (): Promise<SessionSummary[]> => []);
    getHistory = jest.fn(async (_sessionKey: string): Promise<HistorySnapshot | null> => historySnapshot([]));
    seedHistory = jest.fn();
    resumeSession = jest.fn();
    captureSessionState = jest.fn(() => null);
    restoreSessionState = jest.fn();
    dispose = jest.fn();
}

export function mockGatewayModule(): { GatewayChatService: typeof MockGatewayChatService; DEFAULT_SESSION_KEY: string } {
    return { GatewayChatService: MockGatewayChatService, DEFAULT_SESSION_KEY: 'main' };
}

type SessionRow = { key: string; label?: string; agentId?: string; hasActiveRun?: boolean; lastActivityAt?: number; placement?: { state: string } };

/** Session summaries as the client parses them from a `sessions.list` result. */
export function sessionSummaries(rows: SessionRow[]): SessionSummary[] {
    const result = payloads.sessionsList(rows);
    assertValidResult('sessions.list', result);
    const sessions = v4Adapter.parseSessionList(result);
    if (!sessions) throw new Error('fixture rows did not parse as a session list');
    return sessions;
}

type HistoryRow = { role: string; text: string; id?: string; seq?: number; runId?: string };

/** A history snapshot as the client parses it from a `chat.history` tail. */
export function historySnapshot(messages: HistoryRow[], opts: { cursor?: string; activeRunIds?: string[] } = {}): HistorySnapshot {
    const result = payloads.historyTail(messages, opts);
    assertValidResult('chat.history', result);
    const read = v4Adapter.parseHistory(result);
    if (!read || 'reset' in read) throw new Error('fixture rows did not parse as a history tail');
    return read;
}
