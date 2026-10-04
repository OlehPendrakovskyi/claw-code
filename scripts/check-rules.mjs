#!/usr/bin/env node
/**
 * Mechanical checks for rules in docs/development-rules.md. Each check names
 * the rule it enforces. Files are parsed with the TypeScript compiler (syntax
 * only, no type information), so a call or import split across lines is seen
 * like any other; what a check cannot know is a value's meaning, so R10 judges
 * by name (`text`, `prompt`, …) and the review checklist still applies.
 *
 * Scope: these checks catch the ordinary ways a rule is broken — under any
 * local name, import style, dot or literal-key access. They do not try to
 * defeat deliberate obfuscation (a method name held in a variable, a value
 * renamed before it is logged, code built at run time); that is review's job.
 * A finding prints `file:line  [rule] message` and the script exits non-zero.
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
const LOGGER_NAME = /^(?:log|logger|console|channel|\w*Log|\w*Logger|\w*Channel)$/;
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
        const loaded = node.initializer && ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer;
        if (ts.isVariableDeclaration(node) && loaded && ts.isCallExpression(loaded) &&
            ((ts.isIdentifier(loaded.expression) && loaded.expression.text === 'require') || loaded.expression.kind === ts.SyntaxKind.ImportKeyword) &&
            loaded.arguments.length >= 1 && isModule(loaded.arguments[0])) {
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
    return { pattern, namespaces, members };
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
    const object = memberObject(callee);
    if (object !== undefined && ts.isIdentifier(object) && bindings.namespaces.has(object.text)) {
        return lastName(callee);
    }
    // `require('child_process').exec(…)`, `(await import('node:child_process')).execSync(…)`.
    const loaded = object === undefined ? undefined : loadedModule(object);
    if (loaded !== undefined && bindings.pattern.test(loaded)) {
        return lastName(callee);
    }
    return undefined;
}

/** The last name of `a`, `a.b`, `a?.b`, `a['b']` or a quoted property name; undefined for anything
 *  else, such as a computed key held in a variable (out of scope: see the header). */
function lastName(node) {
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return node.text;
    }
    if (ts.isPropertyAccessExpression(node)) {
        return node.name.text;
    }
    if (ts.isElementAccessExpression(node)) {
        return lastName(node.argumentExpression);
    }
    if (ts.isComputedPropertyName(node) || ts.isParenthesizedExpression(node)) {
        return lastName(node.expression);
    }
    return undefined;
}

/** The module a `require('m')` or `import('m')` expression loads, through `await` and parentheses. */
function loadedModule(node) {
    while (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node)) {
        node = node.expression;
    }
    if (!ts.isCallExpression(node) || node.arguments.length < 1) {
        return undefined;
    }
    const isLoader = (ts.isIdentifier(node.expression) && node.expression.text === 'require') || node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const [specifier] = node.arguments;
    return isLoader && (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier)) ? specifier.text : undefined;
}

/** The object a member is read from: `a` in `a.b` and `a['b']`. */
function memberObject(node) {
    return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? node.expression : undefined;
}

/** Whether an expression inside a log call's arguments carries prompt or payload text. */
function carriesText(node) {
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        return TEXT_NAMES.has(lastName(node) ?? '');
    }
    if (ts.isCallExpression(node)) {
        const method = lastName(node.expression);
        const object = memberObject(node.expression);
        if (object !== undefined) {
            if (method === 'stringify' && lastName(object) === 'JSON') {
                return true;
            }
            if (TEXT_PRESERVING.has(method ?? '') && carriesText(object)) {
                return true;
            }
        }
        return node.arguments.some(carriesText);
    }
    if (ts.isPropertyAssignment(node)) {
        // `{ text: text.length }`: a plain key is a label, not a value; a computed key is a value.
        return carriesText(node.initializer) || (ts.isComputedPropertyName(node.name) && carriesText(node.name.expression));
    }
    if (ts.isShorthandPropertyAssignment(node)) {
        return TEXT_NAMES.has(node.name.text);
    }
    let found = false;
    ts.forEachChild(node, child => {
        found ||= carriesText(child);
    });
    return found;
}

/** Whether a `/tmp…` string literal appears anywhere in an expression: `'/tmp/x'`, `path.join('/tmp', …)`. */
function containsTmpLiteral(node) {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /^\/tmp(?:\/|$)/.test(node.text)) {
        return true;
    }
    let found = false;
    ts.forEachChild(node, child => {
        found ||= containsTmpLiteral(child);
    });
    return found;
}

/** Names bound to `….createOutputChannel(…)` in a file, whatever they are called (`const out = …`). */
function outputChannelBindings(source) {
    const names = new Set();
    const visit = node => {
        if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) && node.initializer &&
            ts.isCallExpression(node.initializer) && lastName(node.initializer.expression) === 'createOutputChannel') {
            const name = lastName(node.name);
            if (name !== undefined) {
                names.add(name);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return names;
}

function isLogCall(node, context) {
    if (!ts.isCallExpression(node)) {
        return false;
    }
    const receiver = memberObject(node.expression);
    const receiverName = receiver === undefined ? undefined : lastName(receiver);
    return receiverName !== undefined && LOG_METHODS.has(lastName(node.expression) ?? '') &&
        (LOGGER_NAME.test(receiverName) || context.outputChannels.has(receiverName));
}

const CHECKS = [
    {
        rule: 'R10',
        scope: 'source',
        message: 'log call writes prompt or payload text; log ids, counts or lengths instead',
        test: (node, context) => isLogCall(node, context) && node.arguments.some(carriesText),
    },
    {
        rule: 'R36',
        scope: 'source',
        message: 'shell execution; use execFile/spawn with an argv vector and no shell',
        test: (node, context) =>
            // Any `shell` option but a literal false runs a shell: `true`, a path such as '/bin/bash', a variable.
            (ts.isPropertyAssignment(node) && lastName(node.name) === 'shell' && node.initializer.kind !== ts.SyntaxKind.FalseKeyword) ||
            (ts.isShorthandPropertyAssignment(node) && node.name.text === 'shell') ||
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
            const makesTemp = name => name === 'mkdtemp' || name === 'mkdtempSync';
            return (makesTemp(callee) || makesTemp(calledExport(node, context.fs)) || makesTemp(calledExport(node, context.fsPromises))) &&
                first !== undefined && containsTmpLiteral(first);
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
    const context = {
        file,
        childProcess: moduleBindings(source, 'child_process'),
        os: moduleBindings(source, 'os'),
        fs: moduleBindings(source, 'fs'),
        fsPromises: moduleBindings(source, 'fs/promises'),
        outputChannels: outputChannelBindings(source),
    };
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
