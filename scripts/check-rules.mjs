#!/usr/bin/env node
/**
 * Mechanical checks for rules in docs/development-rules.md. Each check names
 * the rule it enforces. Files are parsed with the TypeScript compiler (syntax
 * only, no type information), so a call or import split across lines is seen
 * like any other; what a check cannot know is a value's meaning, so R10 judges
 * by name (`text`, `prompt`, …) and the review checklist still applies. A
 * finding prints `file:line  [rule] message` and the script exits non-zero.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');
const TEST_DIR = join(SRC, '__test__') + sep;
const TEMP_HELPER = join(SRC, '__test__', 'helpers', 'tempDir.ts');

/** Names whose value is prompt or payload text, and must not reach a log call. */
const TEXT_NAMES = new Set(['text', 'prompt', 'content', 'body', 'msg', 'raw', 'payload', 'chunk', 'frame']);
/** Methods that return a piece of their receiver's text: `text.slice(0, 80)` is still text. */
const TEXT_PRESERVING = new Set(['slice', 'substring', 'substr', 'trim', 'trimStart', 'trimEnd', 'toString', 'toLowerCase', 'toUpperCase']);
/** Logging methods, on a receiver that is a logger (`log`, `logger`, `this.logger`, `console`, …). */
const LOG_METHODS = new Set(['info', 'warn', 'error', 'debug', 'trace', 'append', 'appendLine', 'log']);
const LOGGER_NAME = /^(?:log|logger|console|\w*Log|\w*Logger)$/;
const HOOKS = new Set(['beforeEach', 'afterEach', 'beforeAll', 'afterAll']);

/** The last name of `a`, `a.b` or `a?.b`; undefined for anything else. */
function lastName(node) {
    if (ts.isIdentifier(node)) {
        return node.text;
    }
    if (ts.isPropertyAccessExpression(node)) {
        return node.name.text;
    }
    return undefined;
}

/** Whether an expression inside a log call's arguments carries prompt or payload text. */
function carriesText(node) {
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
        return TEXT_NAMES.has(lastName(node) ?? '');
    }
    if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isPropertyAccessExpression(callee)) {
            if (callee.name.text === 'stringify' && lastName(callee.expression) === 'JSON') {
                return true;
            }
            if (TEXT_PRESERVING.has(callee.name.text) && carriesText(callee.expression)) {
                return true;
            }
        }
        return node.arguments.some(carriesText);
    }
    let found = false;
    ts.forEachChild(node, child => {
        found ||= carriesText(child);
    });
    return found;
}

function isLogCall(node) {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
        return false;
    }
    const { name, expression: receiver } = node.expression;
    return LOG_METHODS.has(name.text) && LOGGER_NAME.test(lastName(receiver) ?? '');
}

const CHECKS = [
    {
        rule: 'R10',
        scope: 'source',
        message: 'log call writes prompt or payload text; log ids, counts or lengths instead',
        test: node => isLogCall(node) && node.arguments.some(carriesText),
    },
    {
        rule: 'R36',
        scope: 'source',
        message: 'shell execution; use execFile/spawn with an argv vector and no shell',
        test: node =>
            (ts.isPropertyAssignment(node) && lastName(node.name) === 'shell' && node.initializer.kind === ts.SyntaxKind.TrueKeyword) ||
            (ts.isImportDeclaration(node) &&
                ts.isStringLiteral(node.moduleSpecifier) &&
                /^(?:node:)?child_process$/.test(node.moduleSpecifier.text) &&
                node.importClause?.namedBindings !== undefined &&
                ts.isNamedImports(node.importClause.namedBindings) &&
                node.importClause.namedBindings.elements.some(element => ['exec', 'execSync'].includes((element.propertyName ?? element.name).text))),
    },
    {
        rule: 'R43',
        scope: 'test',
        message: 'temp directory outside the canonical helper; use makeTempDir / TEMP_ROOT from helpers/tempDir',
        test: (node, file) => {
            if (file === TEMP_HELPER || !ts.isCallExpression(node)) {
                return false;
            }
            const callee = lastName(node.expression);
            if (callee === 'tmpdir') {
                return true;
            }
            const first = node.arguments[0];
            return (callee === 'mkdtemp' || callee === 'mkdtempSync') && first !== undefined &&
                (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) && first.text.startsWith('/tmp');
        },
    },
    {
        rule: 'R54',
        scope: 'test',
        message: 'expression-bodied test hook returns a value Vitest may run as teardown; use a block body',
        test: node => {
            if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || !HOOKS.has(node.expression.text)) {
                return false;
            }
            const callback = node.arguments[0];
            return callback !== undefined && ts.isArrowFunction(callback) && !ts.isBlock(callback.body);
        },
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
    const checks = CHECKS.filter(check => check.scope === scope);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const where = node => `${relative(ROOT, file).split(sep).join('/')}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
    const visit = node => {
        for (const check of checks) {
            if (check.test(node, file)) {
                findings.push(`${where(node)}  [${check.rule}] ${check.message}`);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
}

if (findings.length > 0) {
    console.error(findings.join('\n'));
    console.error(`\n${findings.length} rule finding(s). See docs/development-rules.md.`);
    process.exit(1);
}
console.log(`check-rules: ${CHECKS.map(check => check.rule).join(', ')} clean`);
