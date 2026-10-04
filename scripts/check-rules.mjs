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
const SHELL_EXECUTORS = new Set(['exec', 'execSync']);

/** The names a file binds to a module and to its exports, whatever they are called locally:
 *  `import * as cp`, `import cp`, `const cp = require(…)` (namespaces) and `import { exec as run }`,
 *  `const { exec: run } = require(…)` (members, local name → exported name). */
function moduleBindings(source, moduleName) {
    const pattern = new RegExp(`^(?:node:)?${moduleName}$`);
    const namespaces = new Set();
    const members = new Map();
    const isModule = node => (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && pattern.test(node.text);
    const visit = node => {
        if (ts.isImportDeclaration(node) && isModule(node.moduleSpecifier) && node.importClause) {
            const { name, namedBindings } = node.importClause;
            if (name) {
                namespaces.add(name.text);
            }
            if (namedBindings && ts.isNamespaceImport(namedBindings)) {
                namespaces.add(namedBindings.name.text);
            } else if (namedBindings) {
                for (const element of namedBindings.elements) {
                    members.set(element.name.text, (element.propertyName ?? element.name).text);
                }
            }
        }
        if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) &&
            ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === 'require' &&
            node.initializer.arguments.length === 1 && isModule(node.initializer.arguments[0])) {
            if (ts.isIdentifier(node.name)) {
                namespaces.add(node.name.text);
            } else if (ts.isObjectBindingPattern(node.name)) {
                for (const element of node.name.elements) {
                    if (ts.isIdentifier(element.name)) {
                        members.set(element.name.text, lastName(element.propertyName ?? element.name));
                    }
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return { namespaces, members };
}

/** An import or `require` destructuring of `exec`/`execSync` from child_process, under any local name. */
function importsShellExecutor(node) {
    const isChildProcess = specifier => (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier)) &&
        /^(?:node:)?child_process$/.test(specifier.text);
    if (ts.isImportDeclaration(node) && isChildProcess(node.moduleSpecifier)) {
        const bindings = node.importClause?.namedBindings;
        return bindings !== undefined && ts.isNamedImports(bindings) &&
            bindings.elements.some(element => SHELL_EXECUTORS.has((element.propertyName ?? element.name).text));
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer &&
        ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === 'require' && node.initializer.arguments.length === 1 &&
        isChildProcess(node.initializer.arguments[0])) {
        return node.name.elements.some(element => SHELL_EXECUTORS.has(lastName(element.propertyName ?? element.name) ?? ''));
    }
    return false;
}

/** The export a call reaches through `bindings`: `run()` for `{ exec as run }`, `cp.exec()` for `* as cp`. */
function calledExport(node, bindings) {
    if (!ts.isCallExpression(node)) {
        return undefined;
    }
    const callee = node.expression;
    if (ts.isIdentifier(callee)) {
        return bindings.members.get(callee.text);
    }
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && bindings.namespaces.has(callee.expression.text)) {
        return callee.name.text;
    }
    return undefined;
}

/** The last name of `a`, `a.b`, `a?.b` or a quoted property name; undefined for anything else. */
function lastName(node) {
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
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
        test: (node, context) =>
            (ts.isPropertyAssignment(node) && lastName(node.name) === 'shell' && node.initializer.kind === ts.SyntaxKind.TrueKeyword) ||
            SHELL_EXECUTORS.has(calledExport(node, context.childProcess) ?? '') ||
            importsShellExecutor(node),
    },
    {
        rule: 'R43',
        scope: 'test',
        message: 'temp directory outside the canonical helper; use makeTempDir / TEMP_ROOT from helpers/tempDir',
        test: (node, context) => {
            if (context.file === TEMP_HELPER || !ts.isCallExpression(node)) {
                return false;
            }
            const callee = lastName(node.expression);
            if (callee === 'tmpdir' || calledExport(node, context.os) === 'tmpdir') {
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
    const context = { file, childProcess: moduleBindings(source, 'child_process'), os: moduleBindings(source, 'os') };
    const where = node => `${relative(ROOT, file).split(sep).join('/')}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
    const visit = node => {
        for (const check of checks) {
            if (check.test(node, context)) {
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
