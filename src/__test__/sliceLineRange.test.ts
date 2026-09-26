import { sliceLineRange } from '../webview/viewMessaging';

describe('sliceLineRange', () => {
    const body = 'one\ntwo\nthree\nfour';

    it('returns the whole body when no range is given', () => {
        expect(sliceLineRange(body)).toBe(body);
    });

    it('slices a single line', () => {
        expect(sliceLineRange(body, 2)).toBe('two');
    });

    it('slices an inclusive range', () => {
        expect(sliceLineRange(body, 2, 3)).toBe('two\nthree');
    });

    it('clamps a non-positive start to line 1', () => {
        expect(sliceLineRange(body, 0)).toBe('one');
        expect(sliceLineRange(body, -5, 2)).toBe('one\ntwo');
    });

    it('collapses reversed ranges to the start line', () => {
        expect(sliceLineRange(body, 3, 1)).toBe('three');
    });

    it('returns empty for a start beyond the file', () => {
        expect(sliceLineRange(body, 99)).toBe('');
    });

    it('handles CRLF line endings', () => {
        expect(sliceLineRange('one\r\ntwo\r\nthree', 2, 3)).toBe('two\r\nthree'.replace(/\r/g, ''));
        expect(sliceLineRange('a\r\nb', 2)).toBe('b');
    });
});
