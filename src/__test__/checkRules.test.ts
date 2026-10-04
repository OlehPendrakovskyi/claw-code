import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { makeTempDir } from './helpers/tempDir';

type Case = { name: string; file: string; line: string; expect: string | null };

const SCRIPT = path.resolve(process.cwd(), 'scripts/check-rules.mjs');
const { cases } = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/__test__/fixtures/check-rules-cases.json'), 'utf8')) as { cases: Case[] };

/** Runs the real script, by node's absolute path, on a tree holding only `files`. */
function runOn(files: Record<string, string>): { status: number; output: string } {
    const root = makeTempDir('claw-check-rules-');
    try {
        for (const [relative, content] of Object.entries(files)) {
            const full = path.join(root, relative);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, content);
        }
        try {
            const output = execFileSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            return { status: 0, output };
        } catch (err) {
            const failed = err as { status: number; stdout: string; stderr: string };
            return { status: failed.status, output: `${failed.stdout}${failed.stderr}` };
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

describe('scripts/check-rules.mjs', () => {
    it.each(cases)('$name', ({ file, line, expect: rule }) => {
        const result = runOn({ [file]: `${line}\n` });

        if (rule === null) {
            expect(result).toEqual({ status: 0, output: expect.stringContaining('clean') });
        } else {
            expect(result.status).toBe(1);
            expect(result.output).toContain(`${file}:1  [${rule}]`);
        }
    });

    it('reports every finding with its file and line, and the total', () => {
        const byName = (name: string): Case => cases.find(c => c.name === name)!;
        const logged = byName('R10: prompt text as a direct argument');
        const hook = byName('R54: expression-bodied hook');
        const result = runOn({
            [logged.file]: `const ok = 1;\n${logged.line}\n`,
            [hook.file]: `${hook.line}\n`,
        });

        expect(result.status).toBe(1);
        expect(result.output).toContain(`${logged.file}:2  [R10]`);
        expect(result.output).toContain(`${hook.file}:1  [R54]`);
        expect(result.output).toContain('2 rule finding(s)');
    });

    it('passes the repository itself', () => {
        const output = execFileSync(process.execPath, [SCRIPT], { cwd: process.cwd(), encoding: 'utf8' });
        expect(output).toContain('R10, R36, R43, R54 clean');
    });
});
