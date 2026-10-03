/**
 * A stand-in for GatewayChatService in provider specs, plus session and
 * history fixtures parsed from schema-validated v4 wire payloads, so they
 * carry exactly the shapes the real client hands the provider.
 *
 * Usage: vi.mock('../core/gatewayChatService', async () => (await vi.importActual<typeof import('./helpers/mockGatewayService')>('./helpers/mockGatewayService')).mockGatewayModule());
 */

import type { ChatEvent } from '../../chat/ChatService';
import type { GatewaySend } from '../../core/gatewayChatService';
import type { ApprovalDecision, HistorySnapshot, QuestionAnswers, SessionSummary } from '../../core/gatewayProtocol/model';
import type { PromptChange, PromptListener } from '../../core/operatorPrompts';
import { v4Adapter } from '../../core/gatewayProtocol/v4/adapter';
import { assertValidResult, payloads } from './gatewayV4';

/** Keeps the real class's run ownership: a send owns its session until its sink hears `done` or it is aborted. */
class MockGatewayChatService {
    private readonly ownedSessions = new Set<string>();

    /** Identity by default; a spec teaches it an alias with mockImplementation. */
    canonicalSessionKey = vi.fn((sessionKey: string): string => sessionKey);
    hasOwnedRun = vi.fn((sessionKey: string): boolean => this.ownedSessions.has(this.canonicalSessionKey(sessionKey)));
    abort = vi.fn((sessionKey: string): void => {
        this.ownedSessions.delete(this.canonicalSessionKey(sessionKey));
    });
    /** Records the send; its onEvent is wrapped in place so the recorded call still delivers to the provider. */
    sendMessage = vi.fn((send: GatewaySend): void => {
        const sessionKey = this.canonicalSessionKey(send.sessionKey);
        const deliver = send.onEvent;
        this.ownedSessions.add(sessionKey);
        send.onEvent = (event: ChatEvent) => {
            if (event.type === 'done') this.ownedSessions.delete(sessionKey);
            deliver(event);
        };
    });
    removeTranscriptSink = vi.fn();
    rebindTranscriptSink = vi.fn();
    clearSessionSink = vi.fn();
    getGatewayIdentity = vi.fn(() => 'gateway-1');
    getProtocolVersion = vi.fn(() => 4);
    getTransportLimits = vi.fn(() => v4Adapter.defaultLimits());
    attachmentWireBytes = vi.fn((attachment: { name: string; mimeType: string; byteLength: number }) => v4Adapter.attachmentWireBytes(attachment));
    listSessions = vi.fn(async (): Promise<SessionSummary[]> => []);
    getHistory = vi.fn(async (_sessionKey: string): Promise<HistorySnapshot | null> => historySnapshot([]));
    seedHistory = vi.fn();
    resumeSession = vi.fn();
    captureSessionState = vi.fn(() => null);
    restoreSessionState = vi.fn();
    dispose = vi.fn();
    private readonly promptListeners: PromptListener[] = [];
    private readonly sessionsChangedListeners: Array<(sessionKey: string | null) => void> = [];
    onApprovalRequest = vi.fn((listener: PromptListener): (() => void) => {
        this.promptListeners.push(listener);
        return () => undefined;
    });
    onSessionsChanged = vi.fn((listener: (sessionKey: string | null) => void): (() => void) => {
        this.sessionsChangedListeners.push(listener);
        return () => undefined;
    });
    resolveApproval = vi.fn(async (_id: string, _decision: ApprovalDecision): Promise<void> => undefined);
    answerQuestion = vi.fn(async (_id: string, _answers: QuestionAnswers | null): Promise<void> => undefined);

    /** Deliver a prompt change to the provider, as the real client's board would. */
    emitPrompt(change: PromptChange): void {
        for (const listener of this.promptListeners) listener(change);
    }

    emitSessionsChanged(sessionKey: string | null = null): void {
        for (const listener of this.sessionsChangedListeners) listener(sessionKey);
    }
}

class MockPromptAnswerUnconfirmedError extends Error {}

export function mockGatewayModule(): {
    GatewayChatService: typeof MockGatewayChatService;
    DEFAULT_SESSION_KEY: string;
    PromptAnswerUnconfirmedError: typeof MockPromptAnswerUnconfirmedError;
} {
    return { GatewayChatService: MockGatewayChatService, DEFAULT_SESSION_KEY: 'main', PromptAnswerUnconfirmedError: MockPromptAnswerUnconfirmedError };
}

type SessionRow = { key: string; label?: string; agentId?: string; hasActiveRun?: boolean; lastActivityAt?: number; placement?: { state: string } };

/** Session summaries as the client parses them from a `sessions.list` result. */
export function sessionSummaries(rows: SessionRow[]): SessionSummary[] {
    const result = payloads.sessionsList(rows);
    assertValidResult('sessions.list', result);
    const sessions = v4Adapter.parseSessionList(result);
    if (!sessions) throw new Error('fixture rows did not parse as a session list');
    return sessions.sessions;
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
