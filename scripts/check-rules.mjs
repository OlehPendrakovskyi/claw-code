#!/usr/bin/env node
/**
 * Mechanical checks for rules in docs/development-rules.md that a pattern can
 * catch. Each check names the rule it enforces. These are line-based greps,
 * not a parser: a log call or hook split across lines is not seen, so the
 * review checklist still applies. A finding prints `file:line  [rule] message`
 * and the script exits non-zero.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const TEST_DIR = join(SRC, '__test__') + sep;
const TEMP_HELPER = join(SRC, '__test__', 'helpers', 'tempDir.ts');

/** Names whose raw value is prompt or payload text, and must not reach a log line. */
const TEXT_NAMES = 'text|prompt|content|body|msg|raw|payload|chunk|frame';
/** An optional property path ending in one of TEXT_NAMES: `text`, `request.text`, `turn?.prompt`. */
const TEXT_PATH = `(?:[\\w$]+\\??\\.)*(?:${TEXT_NAMES})`;
/** A template interpolation of such a value, raw or cut (`.slice(0, 80)`), but not `.length`. */
const TEXT_INTERPOLATION = new RegExp(`\\$\\{${TEXT_PATH}(?:\\.(?:slice|substring|substr|trim)\\([^)]*\\))?\\}`);
/** Such a value passed straight to the log call: `log.info(text)`, `log.info(msg.body, …)`. */
const TEXT_ARGUMENT = new RegExp(`\\blog\\.\\w+\\(\\s*${TEXT_PATH}\\s*[,)]`);

const CHECKS = [
    {
        rule: 'R10',
        scope: 'source',
        message: 'log call writes prompt or payload text; log ids, counts or lengths instead',
        test: line =>
            /\blog\.(?:info|warn|error|debug|trace|append|appendLine)\(/.test(line) &&
            (/JSON\.stringify\(/.test(line) || TEXT_INTERPOLATION.test(line) || TEXT_ARGUMENT.test(line)),
    },
    {
        rule: 'R36',
        scope: 'source',
        message: 'shell execution; use execFile/spawn with an argv vector and no shell',
        test: line =>
            /\bshell\s*:\s*true\b/.test(line) ||
            /import\s*\{[^}]*\b(?:exec|execSync)\b[^}]*\}\s*from\s*['"](?:node:)?child_process['"]/.test(line),
    },
    {
        rule: 'R43',
        scope: 'test',
        message: 'temp directory outside the canonical helper; use makeTempDir / TEMP_ROOT from helpers/tempDir',
        test: (line, file) => file !== TEMP_HELPER && (/\bos\.tmpdir\(\)/.test(line) || /mkdtemp(?:Sync)?\(\s*['"`]\/tmp/.test(line)),
    },
    {
        rule: 'R54',
        scope: 'test',
        message: 'expression-bodied test hook returns a value Vitest may run as teardown; use a block body',
        test: line => /\b(?:beforeEach|afterEach|beforeAll|afterAll)\(\s*(?:async\s*)?\(\)\s*=>\s*[^{\s]/.test(line),
    },
];

function* walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            yield* walk(full);
        } else if (entry.name.endsWith('.ts')) {
            yield full;
        }
    }
}

const findings = [];
for (const file of walk(SRC)) {
    const scope = file.startsWith(TEST_DIR) ? 'test' : 'source';
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (const check of CHECKS) {
        if (check.scope !== scope) {
            continue;
        }
        lines.forEach((line, index) => {
            if (check.test(line, file)) {
                const where = `${relative(ROOT, file).split(sep).join('/')}:${index + 1}`;
                findings.push(`${where}  [${check.rule}] ${check.message}`);
            }
        });
    }
}

if (findings.length > 0) {
    console.error(findings.join('\n'));
    console.error(`\n${findings.length} rule finding(s). See docs/development-rules.md.`);
    process.exit(1);
}
console.log(`check-rules: ${CHECKS.map(check => check.rule).join(', ')} clean`);
