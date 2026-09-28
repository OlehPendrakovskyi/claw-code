import * as path from 'path';
import { parseFileMentions, buildMention } from '../webview/fileMentions';

describe('fileMentions', () => {
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

        it('parses a range followed by punctuation', () => {
            expect(parseFileMentions('look at @src/app.ts#L5,')).toEqual([
                { path: 'src/app.ts', lineStart: 5, lineEnd: 5 }
            ]);
            expect(parseFileMentions('see @src/app.ts#L5-10.')).toEqual([
                { path: 'src/app.ts', lineStart: 5, lineEnd: 10 }
            ]);
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

        it('quotes paths containing whitespace', () => {
            expect(buildMention('src/My File.ts')).toBe('@"src/My File.ts"');
            expect(buildMention('src/My File.ts', 3, 4)).toBe('@"src/My File.ts"#L3-4');
        });

        it('parses quoted mentions with spaces and ranges', () => {
            expect(parseFileMentions('see @"src/My File.ts" please')[0]).toEqual({ path: 'src/My File.ts' });
            expect(parseFileMentions('@"a b.ts"#L2-3')[0]).toEqual({ path: 'a b.ts', lineStart: 2, lineEnd: 3 });
        });

        it('quotes paths containing parser delimiters (# and @)', () => {
            expect(buildMention('foo#bar.ts')).toBe('@"foo#bar.ts"');
            expect(buildMention('a@b.ts')).toBe('@"a@b.ts"');
            expect(buildMention('a@b.ts', 1, 2)).toBe('@"a@b.ts"#L1-2');
        });

        it('quotes paths ending in parser punctuation', () => {
            expect(buildMention('foo.ts,')).toBe('@"foo.ts,"');
            expect(buildMention('foo.ts)')).toBe('@"foo.ts)"');
            expect(parseFileMentions(`see ${buildMention('foo.ts,')} ok`).map(m => m.path)).toEqual(['foo.ts,']);
        });

        it('quotes paths containing parser delimiters (# and @)', () => {
            expect(buildMention('foo#bar.ts')).toBe('@"foo#bar.ts"');
            expect(buildMention('a@b.ts')).toBe('@"a@b.ts"');
            expect(buildMention('a@b.ts', 1, 2)).toBe('@"a@b.ts"#L1-2');
        });

        it('round-trips a quoted path through build/parse', () => {
            const mention = buildMention('src/My File.ts');
            expect(parseFileMentions(`before ${mention} after`).map(m => m.path)).toEqual(['src/My File.ts']);
        });

        it('round-trips quoted paths containing delimiters through build/parse', () => {
            for (const p of ['foo#bar.ts', 'a@b.ts']) {
                const mention = buildMention(p, 2, 3);
                expect(parseFileMentions(`see ${mention} ok`).map(m => m)).toEqual([{ path: p, lineStart: 2, lineEnd: 3 }]);
            }
        });

        it('round-trips quoted paths containing delimiters through build/parse', () => {
            for (const p of ['foo#bar.ts', 'a@b.ts']) {
                const mention = buildMention(p, 2, 3);
                expect(parseFileMentions(`see ${mention} ok`).map(m => m)).toEqual([{ path: p, lineStart: 2, lineEnd: 3 }]);
            }
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

    describe('parseFileMentions backtracking', () => {
        // Linear parses take ~10 ms; quadratic backtracking on these inputs
        // takes many seconds, so the bound tolerates a loaded CI machine.
        const LINEAR_PARSE_MAX_MS = 1000;
        const parsesQuickly = (text: string) => {
            const started = Date.now();
            parseFileMentions(text);
            return Date.now() - started;
        };

        it('rejects a long punctuation run ending in a bare # in linear time', () => {
            expect(parsesQuickly('@' + '.'.repeat(100_000) + '#')).toBeLessThan(LINEAR_PARSE_MAX_MS);
        });

        it('rejects long punctuation after a #L range in linear time', () => {
            expect(parsesQuickly('@a.ts#L1' + ','.repeat(100_000) + '#')).toBeLessThan(LINEAR_PARSE_MAX_MS);
            expect(parsesQuickly('@a.ts#L' + '1'.repeat(100_000) + '#')).toBeLessThan(LINEAR_PARSE_MAX_MS);
        });

        it('parses many adjacent quoted mentions in linear time', () => {
            expect(parsesQuickly(' @"x""'.repeat(20_000))).toBeLessThan(LINEAR_PARSE_MAX_MS);
        });
    });

    describe('parseFileMentions edge cases', () => {
        it('keeps trailing punctuation off quoted paths', () => {
            expect(parseFileMentions('see @"My File.ts", ok')).toEqual([{ path: 'My File.ts' }]);
        });

        it('treats an unterminated quote as part of an unquoted path', () => {
            expect(parseFileMentions('@"abc')).toEqual([{ path: '"abc' }]);
        });

        it('rejects a # suffix that is not a line range', () => {
            expect(parseFileMentions('@foo#bar')).toEqual([]);
            expect(parseFileMentions('@a.ts#L5x')).toEqual([]);
        });

        it('strips punctuation between the path and its range', () => {
            expect(parseFileMentions('@a.ts,#L3')).toEqual([{ path: 'a.ts', lineStart: 3, lineEnd: 3 }]);
        });

        it('skips a mention whose path is empty or only punctuation', () => {
            expect(parseFileMentions('@"" and @... and @"",')).toEqual([]);
            expect(parseFileMentions('@"" then @b.ts')).toEqual([{ path: 'b.ts' }]);
        });

        it('keeps the same file once per distinct range', () => {
            expect(parseFileMentions('@a.ts#L1 @a.ts#L2 @a.ts#L1 @a.ts')).toEqual([
                { path: 'a.ts', lineStart: 1, lineEnd: 1 },
                { path: 'a.ts', lineStart: 2, lineEnd: 2 },
                { path: 'a.ts' },
            ]);
        });
    });

    describe('buildMention start-only ranges', () => {
        it('writes a start line without an end, clamping it to line 1', () => {
            expect(buildMention('a.ts', 4)).toBe('@a.ts#L4');
            expect(buildMention('a.ts', -3)).toBe('@a.ts#L1');
            expect(buildMention('a.ts', 0, 0)).toBe('@a.ts#L1');
        });

        it('round-trips paths the unquoted form cannot express', () => {
            for (const filePath of ['a#b.ts', 'we@ird.ts', 'say "hi".ts', 'ends.', 'tab\there.ts']) {
                expect(parseFileMentions(buildMention(filePath, 2, 3))).toEqual([{ path: filePath, lineStart: 2, lineEnd: 3 }]);
            }
        });
    });
});
