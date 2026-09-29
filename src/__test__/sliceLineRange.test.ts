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

    it('marks a start beyond the file instead of returning an empty body', () => {
        expect(sliceLineRange('only line', 50)).toBe('[Lines 50-50 are beyond the end of the file (1 lines)]');
        expect(sliceLineRange(body, 99, 120)).toBe('[Lines 99-120 are beyond the end of the file (4 lines)]');
    });

    it('does not count the empty piece after a trailing newline as a line', () => {
        expect(sliceLineRange('a\nb\n', 3)).toBe('[Lines 3-3 are beyond the end of the file (2 lines)]');
        expect(sliceLineRange('a\nb\n', 2)).toBe('b');
    });

    it('handles CRLF line endings', () => {
        expect(sliceLineRange('one\r\ntwo\r\nthree', 2, 3)).toBe('two\r\nthree'.replace(/\r/g, ''));
        expect(sliceLineRange('a\r\nb', 2)).toBe('b');
    });
});
