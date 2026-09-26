import { parseFileMentions, buildMention } from '../webview/fileMentions';

describe('parseFileMentions', () => {
    it('parses plain path mentions', () => {
        expect(parseFileMentions('check @src/app.ts please')).toEqual([
            { path: 'src/app.ts' }
        ]);
    });

    it('parses single-line range', () => {
        expect(parseFileMentions('@src/app.ts#L5')[0]).toEqual({
            path: 'src/app.ts',
            lineStart: 5,
            lineEnd: 5
        });
    });

    it('parses multi-line range', () => {
        expect(parseFileMentions('@a/b.ts#L5-10')[0]).toEqual({
            path: 'a/b.ts',
            lineStart: 5,
            lineEnd: 10
        });
    });

    it('deduplicates repeated paths', () => {
        const mentions = parseFileMentions('@a.ts and @a.ts');
        expect(mentions).toHaveLength(1);
    });

    it('returns nothing for empty text or bare @', () => {
        expect(parseFileMentions('')).toEqual([]);
        expect(parseFileMentions('hi @ there')).toEqual([]);
    });

    it('requires word boundary before @', () => {
        expect(parseFileMentions('email user@example.com')).toEqual([]);
    });
});

describe('buildMention', () => {
    it('appends range when both lines known', () => {
        expect(buildMention('a.ts', 5, 10)).toBe('@a.ts#L5-10');
    });

    it('appends single line', () => {
        expect(buildMention('a.ts', 7, 7)).toBe('@a.ts#L7');
    });

    it('falls back to single line for reversed range', () => {
        expect(buildMention('a.ts', 10, 5)).toBe('@a.ts#L10');
        expect(buildMention('a.ts')).toBe('@a.ts');
    });
});
