/**
 * The agent picker and its session-list and history helpers, fed with real
 * protocol v4 shapes parsed by the v4 adapter.
 */

import {
    AgentPicker,
    COLD_SESSION_PLACEHOLDER,
    buildAgentSessionItems,
    isMainAgentSessionKey,
    mapHistoryMessages,
} from '../core/agentPicker';
import type { AgentSessionItem } from '../core/agentPicker';
import type { HistorySnapshot, SessionSummary } from '../core/gatewayProtocol/model';
import { v4Adapter } from '../core/gatewayProtocol/v4/adapter';
import { assertValidResult, capturedPayload, payloads } from './helpers/gatewayV4';

/** Session rows as the gateway sends them, validated, then parsed like the client does. */
function sessionsFromWire(rows: Record<string, unknown>[]): SessionSummary[] {
    const payload = payloads.sessionsList(rows);
    assertValidResult('sessions.list', payload);
    const sessions = v4Adapter.parseSessionList(payload);
    if (!sessions) throw new Error('sessions.list payload did not parse');
    return sessions;
}

function historyFromWire(payload: Record<string, unknown>): HistorySnapshot {
    assertValidResult('chat.history', payload);
    const read = v4Adapter.parseHistory(payload);
    if (!read || 'reset' in read) throw new Error('chat.history payload is not a snapshot');
    return read;
}

const T0 = 1790605210000;

describe('agentPicker', () => {
    describe('isMainAgentSessionKey', () => {
        it('accepts agent main sessions and the bare default alias', () => {
            expect(isMainAgentSessionKey('agent:dev:main')).toBe(true);
            expect(isMainAgentSessionKey('main')).toBe(true);
        });

        it('rejects child, subagent and malformed keys', () => {
            for (const key of ['agent:dev:subagent:1', 'agent:dev:main:child', 'agent::main', 'agent:dev:other', 'global', '', 5, null]) {
                expect(isMainAgentSessionKey(key)).toBe(false);
            }
        });
    });

    describe('buildAgentSessionItems', () => {
        it('turns the real captured session row into a picker item', () => {
            const sessions = v4Adapter.parseSessionList(capturedPayload('sessionsListResult')) ?? [];
            expect(buildAgentSessionItems(sessions)).toEqual([
                {
                    sessionKey: 'agent:dev:main',
                    label: 'Hello from probe',
                    agentId: 'dev',
                    hasActiveRun: false,
                    updatedAt: expect.stringMatching(/^2026-09-\d\dT/),
                    cold: false,
                },
            ]);
        });

        it('keeps only main sessions', () => {
            const sessions = sessionsFromWire([
                { key: 'agent:dev:main', agentId: 'dev' },
                { key: 'main' },
                { key: 'agent:dev:subagent:abc', agentId: 'dev' },
                { key: 'agent:dev:cron:nightly', agentId: 'dev' },
            ]);
            expect(buildAgentSessionItems(sessions).map((item) => item.sessionKey)).toEqual(['agent:dev:main', 'main']);
        });

        it('lists running sessions first, then the most recently active by epoch milliseconds', () => {
            const sessions = sessionsFromWire([
                { key: 'agent:old:main', updatedAt: T0 },
                { key: 'agent:newest:main', updatedAt: T0, lastInteractionAt: T0 + 5000 },
                { key: 'agent:busy:main', updatedAt: T0 - 9000, hasActiveRun: true, activeRunIds: ['run-1'] },
                { key: 'agent:never:main', updatedAt: null },
                { key: 'agent:mid:main', lastActivityAt: T0 + 1000 },
            ]);
            expect(buildAgentSessionItems(sessions).map((item) => item.sessionKey)).toEqual([
                'agent:busy:main',
                'agent:newest:main',
                'agent:mid:main',
                'agent:old:main',
                'agent:never:main',
            ]);
        });

        it('reports the latest activity as an ISO timestamp, or null without one', () => {
            const items = buildAgentSessionItems(sessionsFromWire([
                { key: 'agent:a:main', updatedAt: T0, lastActivityAt: T0 + 60_000 },
                { key: 'agent:b:main', updatedAt: null },
            ]));
            expect(items.map((item) => item.updatedAt)).toEqual([new Date(T0 + 60_000).toISOString(), null]);
        });

        it('marks non-materialized placements cold', () => {
            const items = buildAgentSessionItems(sessionsFromWire([
                { key: 'agent:local:main', placement: { state: 'local' } },
                { key: 'agent:active:main', placement: { state: 'active' } },
                { key: 'agent:reclaimed:main', placement: { state: 'reclaimed' } },
                { key: 'agent:draining:main', placement: { state: 'draining' } },
            ]));
            expect(Object.fromEntries(items.map((item) => [item.sessionKey, item.cold]))).toEqual({
                'agent:local:main': false,
                'agent:active:main': false,
                'agent:reclaimed:main': true,
                'agent:draining:main': true,
            });
        });

        it('labels a session by label, display name, agent id, then key', () => {
            const items = buildAgentSessionItems(sessionsFromWire([
                { key: 'agent:a:main', label: 'Pinned', displayName: 'Shown', agentId: 'a', updatedAt: T0 + 4 },
                { key: 'agent:b:main', displayName: 'Shown', agentId: 'b', updatedAt: T0 + 3 },
                { key: 'agent:c:main', agentId: 'c', updatedAt: T0 + 2 },
                { key: 'agent:d:main', updatedAt: T0 + 1 },
            ]));
            expect(items.map((item) => item.label)).toEqual(['Pinned', 'Shown', 'c', 'agent:d:main']);
        });
    });

    describe('AgentPicker', () => {
        const pickFirst = { show: async (items: AgentSessionItem[]) => items[0] };

        it('lists main sessions over the transport', async () => {
            const sessions = sessionsFromWire([{ key: 'agent:dev:main', agentId: 'dev' }, { key: 'agent:dev:subagent:x' }]);
            const picker = new AgentPicker({ listSessions: async () => sessions }, pickFirst);
            expect((await picker.listMainSessions()).map((item) => item.sessionKey)).toEqual(['agent:dev:main']);
        });

        it('lists nothing without a transport or when the list fails', async () => {
            expect(await new AgentPicker(null, pickFirst).listMainSessions()).toEqual([]);
            const failing = new AgentPicker({ listSessions: async () => { throw new Error('not connected'); } }, pickFirst);
            expect(await failing.listMainSessions()).toEqual([]);
        });

        it('returns the chosen item, and shows nothing without sessions', async () => {
            const sessions = sessionsFromWire([{ key: 'agent:dev:main' }]);
            expect(await new AgentPicker({ listSessions: async () => sessions }, pickFirst).pick()).toMatchObject({ sessionKey: 'agent:dev:main' });
            const show = jest.fn();
            expect(await new AgentPicker({ listSessions: async () => [] }, { show }).pick()).toBeUndefined();
            expect(show).not.toHaveBeenCalled();
        });
    });

    describe('mapHistoryMessages', () => {
        it('maps the real captured tail, dropping the run-failure notice row', () => {
            const messages = mapHistoryMessages(historyFromWire(capturedPayload('historyTailResult')));
            expect(messages[0]).toEqual({ role: 'user', content: 'hello from probe', entryId: 'e5f1f654-4655-43f2-9051-1a26d778efcc' });
            expect(messages.some((message) => message.content.startsWith('This turn ended before a reply'))).toBe(false);
            expect(messages.map((message) => message.role)).toEqual(['user', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
        });

        it('skips rows without text and keeps the transcript order', () => {
            const snapshot = historyFromWire(payloads.historyTail([
                { role: 'user', text: 'question', seq: 1, id: 'e1' },
                { role: 'toolResult', text: 'tool output', seq: 2, id: 'e2' },
                { role: 'assistant', text: '', seq: 3, id: 'e3' },
                { role: 'assistant', text: 'answer', seq: 4, id: 'e4' },
            ]));
            expect(mapHistoryMessages(snapshot)).toEqual([
                { role: 'user', content: 'question', entryId: 'e1' },
                { role: 'assistant', content: 'answer', entryId: 'e4' },
            ]);
        });

        it('maps nothing for a missing snapshot', () => {
            expect(mapHistoryMessages(null)).toEqual([]);
        });
    });

    describe('COLD_SESSION_PLACEHOLDER', () => {
        it('tells the user the history loads once the session starts', () => {
            expect(COLD_SESSION_PLACEHOLDER).toMatch(/history will load once it starts/);
        });
    });
});
