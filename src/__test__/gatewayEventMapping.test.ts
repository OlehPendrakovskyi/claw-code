/**
 * Unit tests for the gateway wire helpers: frame parsing, session-key
 * extraction and session.message mapping.
 */

import { extractSessionKey, isAssistantRole, mapSessionEventToChatEvent, parseFrame } from '../core/gatewayEventMapping';
import type { SessionEvent } from '../core/contract';

describe('gatewayEventMapping', () => {
  describe('parseFrame', () => {
    it('parses res and event frames from strings and buffers', () => {
      expect(parseFrame('{"type":"res","id":"1","ok":true}')).toEqual({ type: 'res', id: '1', ok: true });
      expect(parseFrame(Buffer.from('{"type":"event","event":"x","payload":{}}'))).toEqual({
        type: 'event',
        event: 'x',
        payload: {},
      });
      expect(parseFrame('not json')).toBeNull();
      expect(parseFrame('{"type":"bogus"}')).toBeNull();
      expect(parseFrame(42)).toBeNull();
    });

    it('rejects JSON that is not a frame object', () => {
      expect(parseFrame('null')).toBeNull();
      expect(parseFrame('"res"')).toBeNull();
      expect(parseFrame('[]')).toBeNull();
      expect(parseFrame('')).toBeNull();
    });
  });

  describe('mapSessionEventToChatEvent', () => {
    it('maps assistant session.message text to a text ChatEvent', () => {
      const evt: SessionEvent = { event: 'session.message', payload: { role: 'assistant', text: 'hi' } };
      expect(mapSessionEventToChatEvent(evt)).toEqual([{ type: 'text', text: 'hi' }]);
    });
    it('skips user-role messages and non-message events', () => {
      const user: SessionEvent = { event: 'session.message', payload: { role: 'user', text: 'yo' } };
      expect(mapSessionEventToChatEvent(user)).toEqual([]);
      const other: SessionEvent = { event: 'sessions.changed', payload: {} };
      expect(mapSessionEventToChatEvent(other)).toEqual([]);
    });
    it('maps usage payloads', () => {
      const evt: SessionEvent = {
        event: 'session.message',
        payload: { usage: { promptTokens: 5, completionTokens: 7 } },
      };
      expect(mapSessionEventToChatEvent(evt)).toEqual([
        { type: 'usage', usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 } },
      ]);
    });
    it('maps a mixed delta+text frame without a messageId to the full text only', () => {
      // Both fields describe the same content; without an id the per-message
      // dedupe cannot run, so the full text is canonical (delta would append
      // the same string twice).
      const evt: SessionEvent = {
        event: 'session.message',
        payload: { role: 'assistant', delta: 'hello', text: 'hello' },
      };
      expect(mapSessionEventToChatEvent(evt)).toEqual([{ type: 'text', text: 'hello' }]);
    });
    it('emits both delta and text for a messageId-carrying mixed frame', () => {
      const evt: SessionEvent = {
        event: 'session.message',
        payload: { role: 'assistant', messageId: 'm1', delta: 'hello', text: 'hello' },
      };
      expect(mapSessionEventToChatEvent(evt)).toEqual([
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'hello' },
      ]);
    });
    it('emits toolCall together with delta and usage in the same frame', () => {
      const evt: SessionEvent = {
        event: 'session.message',
        payload: {
          toolCall: { name: 'shell', status: 'running' },
          delta: 'partial',
          usage: { promptTokens: 2, completionTokens: 3 },
        },
      };
      expect(mapSessionEventToChatEvent(evt)).toEqual([
        { type: 'toolCall', title: 'shell', status: 'running', details: '' },
        { type: 'text', text: 'partial' },
        { type: 'usage', usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } },
      ]);
    });
    it('serializes tool arguments and results when no details string is given', () => {
      const evt: SessionEvent = {
        event: 'session.message',
        payload: { toolCall: { id: 't1', title: 'Read', status: 'done', arguments: { path: 'a' }, result: 'ok' } },
      };
      expect(mapSessionEventToChatEvent(evt)).toEqual([
        {
          type: 'toolCall',
          title: 'Read',
          status: 'done',
          details: 'arguments: {\n  "path": "a"\n}\nresult: "ok"',
          id: 't1',
        },
      ]);
    });

    it('keeps a tool call without a status visible as running', () => {
      const evt: SessionEvent = { event: 'session.message', payload: { toolCall: { name: 'shell', details: 'ls' } } };
      expect(mapSessionEventToChatEvent(evt)).toEqual([{ type: 'toolCall', title: 'shell', status: 'running', details: 'ls' }]);
    });

    it('coerces negative, non-numeric and snake_case token counts', () => {
      const evt: SessionEvent = {
        event: 'session.message',
        payload: { usage: { prompt_tokens: -4, completion_tokens: 'NaN', output_tokens: 9, total_tokens: 3 } },
      };
      expect(mapSessionEventToChatEvent(evt)).toEqual([
        { type: 'usage', usage: { promptTokens: 0, completionTokens: 9, totalTokens: 3 } },
      ]);
    });

    it('falls back to prompt plus completion when the total is junk, and ignores booleans and strings', () => {
      const junkTotal: SessionEvent = {
        event: 'session.message',
        payload: { usage: { promptTokens: 10, completionTokens: 5, totalTokens: 'n/a' } },
      };
      expect(mapSessionEventToChatEvent(junkTotal)).toEqual([
        { type: 'usage', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
      ]);
      const nonNumbers: SessionEvent = { event: 'session.message', payload: { usage: { promptTokens: true, completionTokens: '7' } } };
      expect(mapSessionEventToChatEvent(nonNumbers)).toEqual([]);
      expect(mapSessionEventToChatEvent({ event: 'session.message', payload: { usage: [3] } })).toEqual([]);
    });

    it('ignores a tool call that is an array', () => {
      expect(mapSessionEventToChatEvent({ event: 'session.message', payload: { toolCall: [] } })).toEqual([]);
    });

    it('keeps a total-only usage update and drops an all-zero one', () => {
      const totalOnly: SessionEvent = { event: 'session.message', payload: { usage: { totalTokens: 12 } } };
      expect(mapSessionEventToChatEvent(totalOnly)).toEqual([
        { type: 'usage', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 12 } },
      ]);
      const zero: SessionEvent = { event: 'session.message', payload: { usage: { input_tokens: 0, total_tokens: 0 } } };
      expect(mapSessionEventToChatEvent(zero)).toEqual([]);
    });

    it('tolerates payloads of the wrong type', () => {
      for (const payload of [null, 'text', 7, [], { toolCall: 'x', usage: 5, role: 3 }]) {
        expect(() => mapSessionEventToChatEvent({ event: 'session.message', payload })).not.toThrow();
      }
      expect(mapSessionEventToChatEvent({ event: 'session.message', payload: { role: 3, text: 'x' } })).toEqual([]);
    });
  });

  describe('extractSessionKey', () => {
    it('reads sessionKey or session.key and rejects anything else', () => {
      expect(extractSessionKey({ sessionKey: 'agent:a:main' })).toBe('agent:a:main');
      expect(extractSessionKey({ session: { key: 'agent:b:main' } })).toBe('agent:b:main');
      expect(extractSessionKey({ sessionKey: 5 })).toBeNull();
      expect(extractSessionKey({ sessionKey: '', session: { key: 'agent:c:main' } })).toBe('agent:c:main');
      expect(extractSessionKey({ sessionKey: 5, session: { key: 'agent:d:main' } })).toBe('agent:d:main');
      expect(extractSessionKey({ session: 'agent:e:main' })).toBeNull();
      expect(extractSessionKey({ sessionKey: '' })).toBeNull();
      expect(extractSessionKey(null)).toBeNull();
      expect(extractSessionKey('agent:a:main')).toBeNull();
    });
  });

  describe('isAssistantRole', () => {
    it('treats a missing role as assistant and any other role as not', () => {
      expect(isAssistantRole(undefined)).toBe(true);
      expect(isAssistantRole('assistant')).toBe(true);
      expect(isAssistantRole('user')).toBe(false);
      expect(isAssistantRole(3)).toBe(false);
    });

    it('treats null as omitted but never falsy junk as assistant', () => {
      expect(isAssistantRole(null)).toBe(true);
      for (const junk of [0, false, '', NaN]) {
        expect(isAssistantRole(junk)).toBe(false);
      }
    });
  });
});
