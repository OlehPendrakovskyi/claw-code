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
/** Methods whose result is a boolean or a number, not text. Any other method called on a text value
 *  (`slice`, `replace`, `split`, `padEnd`, …) is treated as still carrying text. */
const NON_TEXT_RESULT = new Set(['includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'search', 'charCodeAt', 'codePointAt', 'localeCompare', 'test']);
/** Logging methods, on a receiver that is a logger (`log`, `logger`, `this.logger`, `console`, …). */
const LOG_METHODS = new Set(['info', 'warn', 'error', 'debug', 'trace', 'append', 'appendLine', 'log']);
const LOGGER_NAME = /^(?:log|logger|console|channel|\w*Log|\w*Logger|\w*Channel)$/;
const HOOKS = new Set(['beforeEach', 'afterEach', 'beforeAll', 'afterAll']);
const SHELL_EXECUTORS = new Set(['exec', 'execSync']);
/** child_process functions that take an options object, where `shell` would apply. */
const PROCESS_SPAWNERS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync']);
/** `shell` values that do not turn a shell on. */
const SHELL_OFF = new Set([ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword]);

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
        const loaded = node.initializer ? unwrap(node.initializer) : undefined;
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
    const loaded = ts.isVariableDeclaration(node) && node.initializer ? loadedModule(node.initializer) : undefined;
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && loaded !== undefined &&
        /^(?:node:)?child_process$/.test(loaded)) {
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

/** The expression under wrappers that do not change the value: parentheses, `await`, and
 *  TypeScript's `as`, `satisfies`, `<T>` and `!`. */
function unwrap(node) {
    while (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isAsExpression(node) ||
        ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
        node = node.expression;
    }
    return node;
}

/** The module a `require('m')` or `import('m')` expression loads, through any unwrap()-able wrapper. */
function loadedModule(node) {
    node = unwrap(node);
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
            if (method !== undefined && !NON_TEXT_RESULT.has(method) && carriesText(object)) {
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
    // A template such as /tmp/x-${id}: its literal prefix is the template's head.
    if (ts.isTemplateExpression(node) && /^\/tmp(?:\/|$)/.test(node.head.text)) {
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

function isShellOption(node) {
    if (ts.isShorthandPropertyAssignment(node)) {
        return node.name.text === 'shell';
    }
    if (!ts.isPropertyAssignment(node) || lastName(node.name) !== 'shell') {
        return false;
    }
    const value = unwrap(node.initializer);
    return !SHELL_OFF.has(value.kind) && !(ts.isIdentifier(value) && value.text === 'undefined');
}

/** Whether a call starts a process: a child_process spawner by any binding, or a function of that name. */
function isSpawnCall(node, context) {
    return ts.isCallExpression(node) &&
        (PROCESS_SPAWNERS.has(calledExport(node, context.childProcess) ?? '') || PROCESS_SPAWNERS.has(lastName(node.expression) ?? ''));
}

/** Whether an object literal is the options of a spawn call: passed inline, or held in a variable that
 *  the same file passes to one (`const opts = { … }; spawn(cmd, args, opts)`). */
function isSpawnOptions(object, context) {
    if (!ts.isObjectLiteralExpression(object)) {
        return false;
    }
    let node = object;
    while (ts.isParenthesizedExpression(node.parent) || ts.isAsExpression(node.parent) || ts.isSatisfiesExpression(node.parent)) {
        node = node.parent;
    }
    if (ts.isCallExpression(node.parent) && node.parent.arguments.includes(node)) {
        return isSpawnCall(node.parent, context);
    }
    return ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) && context.spawnOptionNames.has(node.parent.name.text);
}

/** Identifiers a file passes to spawn calls (candidate option variables). */
function spawnArgumentNames(source, context) {
    const names = new Set();
    const visit = node => {
        if (isSpawnCall(node, context)) {
            for (const argument of node.arguments) {
                if (ts.isIdentifier(argument)) {
                    names.add(argument.text);
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return names;
}

/** Local names of imported loggers: `import { log as out } from './shared'` makes `out` a logger. */
function importedLoggers(source) {
    const names = new Set();
    for (const statement of source.statements) {
        const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
        if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
                if (LOGGER_NAME.test((element.propertyName ?? element.name).text)) {
                    names.add(element.name.text);
                }
            }
        }
    }
    return names;
}

function isLogCall(node, context) {
    if (!ts.isCallExpression(node)) {
        return false;
    }
    const receiver = memberObject(node.expression);
    const receiverName = receiver === undefined ? undefined : lastName(receiver);
    return receiverName !== undefined && LOG_METHODS.has(lastName(node.expression) ?? '') &&
        (LOGGER_NAME.test(receiverName) || context.outputChannels.has(receiverName) || context.loggers.has(receiverName));
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
            // A `shell` option on an object given to a process spawner, set to anything but false, null or
            // undefined: `true`, a shell path such as '/bin/bash', or a variable.
            (isShellOption(node) && isSpawnOptions(node.parent, context)) ||
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
        loggers: importedLoggers(source),
    };
    context.spawnOptionNames = spawnArgumentNames(source, context);
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
