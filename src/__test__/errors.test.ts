import { errorMessage } from '../core/errors';

describe('errorMessage', () => {
    it('returns an Error message and a string as is', () => {
        expect(errorMessage(new Error('boom'))).toBe('boom');
        expect(errorMessage('plain failure')).toBe('plain failure');
    });

    it('uses the message of a record that carries one', () => {
        expect(errorMessage({ message: 'socket hang up', code: 'ECONNRESET' })).toBe('socket hang up');
    });

    it('describes any other object by its keys, never its values', () => {
        const message = errorMessage({ code: 'EACCES', token: 'abc123' });
        expect(message).toBe('Non-Error value (keys: code, token)');
        expect(message).not.toContain('abc123');
    });

    it('caps the listed keys', () => {
        const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]));
        expect(errorMessage(many)).toBe('Non-Error value (keys: k0, k1, k2, k3, k4, k5, k6, k7, … 2 more)');
    });

    it('handles empty objects and primitives', () => {
        expect(errorMessage({})).toBe('Non-Error value');
        expect(errorMessage(undefined)).toBe('undefined');
        expect(errorMessage(42)).toBe('42');
    });
});
