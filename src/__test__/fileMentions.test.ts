import * as path from 'path';
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

    it('trims trailing punctuation from prose', () => {
        expect(parseFileMentions('see @src/a.ts, then continue')[0]).toEqual({ path: 'src/a.ts' });
    });

    it('clamps #L0 to line 1 instead of dropping the range', () => {
        expect(parseFileMentions('@a.ts#L0')[0]).toEqual({ path: 'a.ts', lineStart: 1, lineEnd: 1 });
    });

    it('normalizes reversed ranges to the start line', () => {
        expect(parseFileMentions('@a.ts#L10-5')[0]).toEqual({ path: 'a.ts', lineStart: 10, lineEnd: 10 });
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

describe('mention path scoping', () => {
    const cwd = '/workspace/project';

    it('resolves relative paths within the workspace', () => {
        const resolved = path.resolve(cwd, parseFileMentions('@src/a.ts')[0].path);
        expect(resolved.startsWith(cwd + path.sep)).toBe(true);
    });

    it('rejects traversal outside the workspace', () => {
        for (const raw of ['@../../etc/passwd', '@/etc/passwd', '@src/../../../etc/passwd']) {
            const mention = parseFileMentions(raw)[0];
            expect(mention).toBeDefined();
            const candidate = path.resolve(cwd, mention.path);
            const rel = path.relative(cwd, candidate);
            const inScope = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
            expect(inScope).toBe(false);
        }
    });
});

describe('parseFileMentions dedupe by path+range', () => {
    it('keeps same path with different ranges', () => {
        const mentions = parseFileMentions('@a.ts#L1-5 and @a.ts#L10-12');
        expect(mentions).toHaveLength(2);
        expect(mentions[1]).toEqual({ path: 'a.ts', lineStart: 10, lineEnd: 12 });
    });

    it('deduplicates identical path+range', () => {
        expect(parseFileMentions('@a.ts#L1-5 and @a.ts#L1-5')).toHaveLength(1);
    });
});
