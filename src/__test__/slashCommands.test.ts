
import {
    SLASH_COMMANDS,
    findCommand,
    filterCommands,
    buildSlashPrompt,
    keepUtf8Tail,
    COMPACT_TRANSCRIPT_MAX_BYTES,
} from '../webview/slashCommands';

describe('SLASH_COMMANDS', () => {
    it('has at least 5 commands', () => {
        expect(SLASH_COMMANDS.length).toBeGreaterThanOrEqual(5);
    });

    it('every command has required fields', () => {
        for (const cmd of SLASH_COMMANDS) {
            expect(cmd.name).toBeTruthy();
            expect(cmd.description).toBeTruthy();
            expect(cmd.icon).toBeTruthy();
            expect(cmd.contextType).toBeTruthy();
            expect(cmd.placeholder).toBeTruthy();
        }
    });

    it('command names are unique', () => {
        const names = SLASH_COMMANDS.map(c => c.name);
        expect(new Set(names).size).toBe(names.length);
    });
});

describe('plan and compact templates', () => {
    it('includes plan and compact prompt templates', () => {
        const plan = buildSlashPrompt('plan', 'add dark mode', {});
        const compact = buildSlashPrompt('compact', '', {});
        expect(plan).toContain('implementation plan');
        expect(plan).toContain('add dark mode');
        expect(compact).toContain('Summarize');
    });
});

describe('findCommand', () => {
    it('returns matching command', () => {
        const cmd = findCommand('explain');
        expect(cmd).toBeDefined();
        expect(cmd!.name).toBe('explain');
    });

    it('returns undefined for unknown command', () => {
        expect(findCommand('nonexistent')).toBeUndefined();
    });
});

describe('filterCommands', () => {
    it('returns all commands for empty query', () => {
        expect(filterCommands('').length).toBe(SLASH_COMMANDS.length);
    });

    it('filters by prefix', () => {
        const results = filterCommands('ex');
        expect(results.length).toBe(1);
        expect(results[0].name).toBe('explain');
    });

    it('returns empty for no match', () => {
        expect(filterCommands('zzz')).toEqual([]);
    });
});

describe('buildSlashPrompt', () => {
    it('returns userText for unknown command', () => {
        expect(buildSlashPrompt('unknown', 'hello', {})).toBe('hello');
    });

    it('includes instruction for known command', () => {
        const prompt = buildSlashPrompt('explain', '', {});
        expect(prompt).toContain('Explain');
    });

    it('includes file context when provided', () => {
        const prompt = buildSlashPrompt('explain', '', {
            filePath: 'src/foo.ts',
            languageId: 'typescript',
            selection: 'const x = 1;',
        });
        expect(prompt).toContain('src/foo.ts');
        expect(prompt).toContain('const x = 1;');
    });

    it('includes user text when provided', () => {
        const prompt = buildSlashPrompt('fix', 'fix the null check', {});
        expect(prompt).toContain('fix the null check');
    });

    it('includes diagnostics for /fix context', () => {
        const prompt = buildSlashPrompt('fix', '', {
            filePath: 'app.ts',
            diagnostics: '[Error] Line 5: missing semicolon',
        });
        expect(prompt).toContain('missing semicolon');
    });

    it('includes git diff for /review context', () => {
        const prompt = buildSlashPrompt('review', '', {
            gitDiff: '+const a = 1;\n-const b = 2;',
        });
        expect(prompt).toContain('+const a = 1;');
    });
});

describe('keepUtf8Tail', () => {
    it('returns the input unchanged when it fits', () => {
        expect(keepUtf8Tail('héllo', 6)).toBe('héllo');
    });

    it('bounds multibyte text by encoded bytes, not UTF-16 units', () => {
        const emoji = '😀'.repeat(40_000);
        const kept = keepUtf8Tail(emoji, 65_536);
        expect(Buffer.byteLength(kept, 'utf8')).toBe(65_536);
        expect(kept).toBe('😀'.repeat(16_384));
    });

    it('drops a code point split by the cut instead of emitting a partial sequence', () => {
        // 'aé€😀' = 1 + 2 + 3 + 4 bytes; a 5-byte tail would start inside '€'.
        const kept = keepUtf8Tail('aé€😀', 5);
        expect(kept).toBe('😀');
        expect(kept).not.toContain('\uFFFD');
    });

    it('keeps the most recent text', () => {
        expect(keepUtf8Tail('old turn\nnew turn', 8)).toBe('new turn');
    });

    it('returns an empty string for a zero or negative budget', () => {
        expect(keepUtf8Tail('abc', 0)).toBe('');
        expect(keepUtf8Tail('abc', -1)).toBe('');
    });
});

describe('buildSlashPrompt transcript cap', () => {
    it('embeds a short transcript verbatim', () => {
        const prompt = buildSlashPrompt('compact', '', {}, 'user: hi');
        expect(prompt).toContain('--- Conversation So Far ---\nuser: hi\n---');
    });

    it('keeps the latest turns of an oversized transcript within the byte cap and says so', () => {
        const transcript = `FIRST-TURN ${'ж'.repeat(COMPACT_TRANSCRIPT_MAX_BYTES)} LAST-TURN`;
        const prompt = buildSlashPrompt('compact', '', {}, transcript);
        const body = prompt.split(/--- Conversation So Far[^\n]*\n/)[1].split('\n---')[0];
        expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(COMPACT_TRANSCRIPT_MAX_BYTES);
        expect(body.endsWith('LAST-TURN')).toBe(true);
        expect(body).not.toContain('FIRST-TURN');
        expect(prompt).toContain('earliest turns omitted');
    });
});
