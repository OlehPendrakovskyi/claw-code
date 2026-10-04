import { errorMessage } from '../core/errors';

describe('errorMessage', () => {
    it('returns an Error message and a string as is', () => {
        expect(errorMessage(new Error('boom'))).toBe('boom');
        expect(errorMessage('plain failure')).toBe('plain failure');
    });

    it('uses the message of a record that carries one', () => {
        expect(errorMessage({ message: 'socket hang up', code: 'ECONNRESET' })).toBe('socket hang up');
    });

    it('serialises any other object instead of rendering [object Object]', () => {
        expect(errorMessage({ code: 'EACCES', path: '/x' })).toBe('{"code":"EACCES","path":"/x"}');
    });

    it('caps a large serialised value', () => {
        const message = errorMessage({ data: 'x'.repeat(1000) });
        expect(message.length).toBe(301);
        expect(message.endsWith('…')).toBe(true);
    });

    it('falls back to String() for values JSON cannot represent', () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(errorMessage(cyclic)).toBe('[object Object]');
        expect(errorMessage(undefined)).toBe('undefined');
        expect(errorMessage(42)).toBe('42');
    });
});
