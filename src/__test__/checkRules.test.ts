import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { API } from 'typescript/unstable/sync';
import { checkRules } from '../../scripts/check-rules.mjs';
import { makeTempDir } from './helpers/tempDir';

/** `others` are further files in the same tree, for checks that follow imports across files. */
type Case = { name: string; file: string; line: string; expect: string | null; others?: Record<string, string> };

const SCRIPT = path.resolve(process.cwd(), 'scripts/check-rules.mjs');
const { cases } = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'src/__test__/fixtures/check-rules-cases.json'), 'utf8')) as { cases: Case[] };

/** Writes a tree holding only `files`, hands its root to `use`, and deletes it afterwards. */
function withTree<T>(files: Record<string, string>, use: (root: string) => T): T {
    const root = makeTempDir('claw-check-rules-');
    try {
        for (const [relative, content] of Object.entries(files)) {
            const full = path.join(root, relative);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, content);
        }
        return use(root);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

describe('scripts/check-rules.mjs', () => {
    // One TypeScript server for every fixture tree: a process per case took 40-77 s on CI (#61).
    let api: API;
    beforeAll(() => {
        api = new API({ cwd: process.cwd() });
    });
    afterAll(() => {
        api.close();
    });

    /** Runs the checks in-process, on the shared API, on a tree holding only `files`. */
    const findingsOn = (files: Record<string, string>): string[] => withTree(files, root => checkRules(root, api).findings);

    it.each(cases)('$name', ({ file, line, expect: rule, others }) => {
        const findings = findingsOn({ ...others, [file]: `${line}\n` });

        if (rule === null) {
            expect(findings).toEqual([]);
        } else {
            expect(findings.join('\n')).toContain(`${file}:1  [${rule}]`);
        }
    });

    // The API keeps a project open across snapshots until it is closed, and lists open projects sorted by path:
    // a run that took the first one, or left its own open, would check tree `a` again when asked for tree `b`.
    it('checks only the tree it is given when an earlier run used the same API (issue #61)', () => {
        const logged = cases.find(c => c.name === 'R10: prompt text as a direct argument')!;
        const parent = makeTempDir('claw-check-rules-');
        const write = (tree: string, content: string): string => {
            const full = path.join(parent, tree, logged.file);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, content);
            return path.join(parent, tree);
        };
        try {
            const first = checkRules(write('a', `${logged.line}\n`), api).findings;
            const second = checkRules(write('b', 'const ok = 1;\n'), api).findings;

            expect(first).toHaveLength(1);
            expect(second).toEqual([]);
            const snapshot = api.updateSnapshot();
            expect(snapshot.getProjects()).toEqual([]);
            snapshot.dispose();
        } finally {
            fs.rmSync(parent, { recursive: true, force: true });
        }
    });

    // The CLI end to end: exit code, every finding's file and line, the total, and the clean line.
    it('reports every finding with its file and line, and the total', () => {
        const byName = (name: string): Case => cases.find(c => c.name === name)!;
        const logged = byName('R10: prompt text as a direct argument');
        const hook = byName('R54: expression-bodied hook');
        const result = withTree({
            [logged.file]: `const ok = 1;\n${logged.line}\n`,
            [hook.file]: `${hook.line}\n`,
        }, root => spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' }));

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`${logged.file}:2  [R10]`);
        expect(result.stderr).toContain(`${hook.file}:1  [R54]`);
        expect(result.stderr).toContain('2 rule finding(s)');
    });

    // Parsing the whole of src/ takes seconds under coverage and parallel load.
    it('passes the repository itself', () => {
        const output = execFileSync(process.execPath, [SCRIPT], { cwd: process.cwd(), encoding: 'utf8' });
        expect(output).toContain('R10, R36, R43, R54 clean');
    }, 30_000);

    // Each checker query is a round trip to the TypeScript process; the checks repeat most of them (#58).
    it('answers repeated checker queries from the cache (issue #58)', () => {
        const result = spawnSync(process.execPath, [SCRIPT], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, CHECK_RULES_STATS: '1' } });
        const stats = /check-rules: (\d+) checker queries, (\d+) served from cache/.exec(result.stderr);

        expect(result.status).toBe(0);
        expect(stats).not.toBeNull();
        expect(Number(stats![2])).toBeGreaterThan(Number(stats![1]));
    }, 30_000);
});
