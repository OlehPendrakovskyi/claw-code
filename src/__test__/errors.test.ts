import { errorMessage } from '../core/errors';

describe('errorMessage', () => {
    it('returns an Error message and a string as is', () => {
        expect(errorMessage(new Error('boom'))).toBe('boom');
        expect(errorMessage('plain failure')).toBe('plain failure');
    });

    it('takes nothing from a non-Error object: no values, no message field, no key names', () => {
        for (const thrown of [{ token: 'abc123' }, { message: 'token=secret' }, { 'token=sk-secret': 1 }, { ['x'.repeat(10_000)]: 1 }]) {
            expect(errorMessage(thrown)).toBe('Non-Error value (object)');
        }
    });

    it('says when the thrown value is an array', () => {
        expect(errorMessage(['token=secret'])).toBe('Non-Error value (array)');
    });

    it('uses String() for other values', () => {
        expect(errorMessage(undefined)).toBe('undefined');
        expect(errorMessage(42)).toBe('42');
    });
});
