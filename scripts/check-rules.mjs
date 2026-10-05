#!/usr/bin/env node
/**
 * Mechanical checks for rules in docs/development-rules.md. Each check names
 * the rule it enforces. Files are parsed by the TypeScript compiler, and module
 * bindings are resolved through its symbol table (lexical scope, aliases,
 * destructuring, every import form), so a call or import split across lines,
 * or a local that shadows an import, is seen as the compiler sees it. What a
 * check cannot know is a value's meaning, so R10 judges by name (`text`,
 * `prompt`, …) and the review checklist still applies.
 *
 * Scope: these checks catch the ordinary ways a rule is broken — under any
 * local name, import style, dot or literal-key access. They do not try to
 * defeat deliberate obfuscation (a method name held in a variable, a value
 * renamed before it is logged, code built at run time); that is review's job.
 * A finding prints `file:line  [rule] message` and the script exits non-zero.
 */
import { readdirSync } from 'node:fs';
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
/** Methods that write their arguments to a log or output surface, on a receiver that is a logger (`log`,
 *  `logger`, `this.logger`, `console`, …): the logger levels, VS Code's `OutputChannel` (`append`,
 *  `appendLine`, `replace`) and the rest of `console`'s writers. */
const LOG_METHODS = new Set([
    'info', 'warn', 'error', 'debug', 'trace', 'log', 'append', 'appendLine', 'replace',
    'dir', 'dirxml', 'table', 'assert', 'group', 'groupCollapsed', 'timeLog',
]);
const LOGGER_NAME = /^(?:log|logger|console|channel|\w*Log|\w*Logger|\w*Channel)$/;
/** Type names of loggers: VS Code's `OutputChannel` and `LogOutputChannel`, `Console`, any `…Logger`. */
const LOGGER_TYPE = /^(?:Console|\w*Log|\w*Logger|\w*Channel)$/;
const HOOKS = new Set(['beforeEach', 'afterEach', 'beforeAll', 'afterAll']);
/** Operators whose result is a boolean whatever their operands: comparisons, `instanceof`, `in`. */
const BOOLEAN_OPERATORS = new Set([
    ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.GreaterThanToken,
    ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanEqualsToken, ts.SyntaxKind.InstanceOfKeyword, ts.SyntaxKind.InKeyword,
]);
const SHELL_EXECUTORS = new Set(['exec', 'execSync']);
/** Function methods that invoke the function they are called on: `f.call(this, …)`, `f.apply(this, […])`. */
const INVOKERS = new Set(['call', 'apply']);
/** child_process functions that take an options object, where `shell` would apply. */
const PROCESS_SPAWNERS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync']);
/** `shell` values that do not turn a shell on. */
const SHELL_OFF = new Set([ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword]);

/** A module name without the `node:` prefix. */
function moduleName(text) {
    return text.replace(/^node:/, '');
}

/** What an expression denotes in module terms: `{ module }` for a module namespace, `{ module, member }`
 *  for one of its exports, or undefined. An identifier is followed through its TypeScript symbol to its
 *  declaration, so lexical scope decides: a parameter or local that shadows an import resolves to
 *  itself, not to the import. Aliases (`const run = cp.exec`), bound copies (`cp.exec.bind(cp)`),
 *  destructuring, `require`, `import()`, `import x = require()` and `fs.promises` resolve the same way. */
function resolveValue(node, checker, depth = 0) {
    if (depth > 8) {
        return undefined;
    }
    node = unwrap(node);
    const loaded = loadedModule(node, checker);
    if (loaded !== undefined) {
        return { module: moduleName(loaded) };
    }
    // `promisify(execFile)` runs execFile: the wrapper is the function it wraps.
    if (ts.isCallExpression(node) && node.arguments.length === 1) {
        const callee = resolveValue(node.expression, checker, depth + 1);
        if (callee?.module === 'util' && callee.member === 'promisify') {
            const target = resolveValue(node.arguments[0], checker, depth + 1);
            return target?.member !== undefined ? target : undefined;
        }
    }
    const bound = boundFunction(node);
    if (bound !== undefined) {
        const target = resolveValue(bound, checker, depth + 1);
        return target?.member !== undefined ? target : undefined;
    }
    if (ts.isIdentifier(node)) {
        const declaration = checker.getSymbolAtLocation(node)?.declarations?.[0];
        return declaration === undefined ? undefined : resolveDeclaration(declaration, checker, depth + 1);
    }
    const object = memberObject(node);
    if (object !== undefined) {
        const base = resolveValue(object, checker, depth + 1);
        const name = lastName(node);
        return base !== undefined && name !== undefined ? memberOf(base, name) : undefined;
    }
    return undefined;
}

/** The export `name` read from what `base` denotes; `fs.promises` is the `fs/promises` namespace. */
function memberOf(base, name) {
    if (base.member === undefined) {
        return { module: base.module, member: name };
    }
    if (base.module === 'fs' && base.member === 'promises') {
        return { module: 'fs/promises', member: name };
    }
    return undefined;
}

/** Whole-variable assignments in the program, by the assigned variable's symbol: `run = cp.exec` makes
 *  `cp.exec` one of the values `run` can hold. Filled once, before the checks run. */
const assignmentsBySymbol = new Map();

function collectAssignments(source, checker) {
    const visit = node => {
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(unwrap(node.left))) {
            const symbol = checker.getSymbolAtLocation(unwrap(node.left));
            if (symbol !== undefined) {
                assignmentsBySymbol.set(symbol, [...(assignmentsBySymbol.get(symbol) ?? []), node.right]);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
}

function resolveDeclaration(declaration, checker, depth) {
    // `let run; run = cp.exec`: a variable also holds whatever is assigned to it later.
    if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
        const symbol = checker.getSymbolAtLocation(declaration.name);
        for (const value of [declaration.initializer, ...(assignmentsBySymbol.get(symbol) ?? [])]) {
            const target = value === undefined ? undefined : resolveValue(value, checker, depth);
            if (target !== undefined) {
                return target;
            }
        }
        return undefined;
    }
    // An import from another file in the program is followed to that file's export: a re-export shim
    // (`export { exec as run } from 'child_process'`), an exported alias, or `export default`.
    if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration)) {
        const exported = exportedDeclaration(declaration, checker);
        if (exported !== undefined) {
            return resolveDeclaration(exported, checker, depth + 1);
        }
    }
    if (ts.isExportSpecifier(declaration)) {
        const from = declaration.parent.parent.moduleSpecifier;
        if (from !== undefined && ts.isStringLiteral(from)) {
            return { module: moduleName(from.text), member: lastName(declaration.propertyName ?? declaration.name) };
        }
        const local = checker.getExportSpecifierLocalTargetSymbol(declaration)?.declarations?.[0];
        return local === undefined ? undefined : resolveDeclaration(local, checker, depth + 1);
    }
    if (ts.isExportAssignment(declaration)) {
        return resolveValue(declaration.expression, checker, depth);
    }
    if (ts.isImportSpecifier(declaration)) {
        return {
            module: moduleName(declaration.parent.parent.parent.moduleSpecifier.text),
            member: (declaration.propertyName ?? declaration.name).text,
        };
    }
    if (ts.isNamespaceImport(declaration)) {
        return { module: moduleName(declaration.parent.parent.moduleSpecifier.text) };
    }
    if (ts.isImportClause(declaration)) {
        return { module: moduleName(declaration.parent.moduleSpecifier.text) };
    }
    if (ts.isImportEqualsDeclaration(declaration) && ts.isExternalModuleReference(declaration.moduleReference) &&
        ts.isStringLiteral(declaration.moduleReference.expression)) {
        return { module: moduleName(declaration.moduleReference.expression.text) };
    }
    if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent) &&
        ts.isVariableDeclaration(declaration.parent.parent) && declaration.parent.parent.initializer) {
        const base = resolveValue(declaration.parent.parent.initializer, checker, depth);
        const name = lastName(declaration.propertyName ?? declaration.name);
        return base !== undefined && name !== undefined ? memberOf(base, name) : undefined;
    }
    return undefined;
}

/** The declaration an import binding names in another file of the program, or undefined when its module
 *  is not part of the program (a package such as `child_process`). */
function exportedDeclaration(binding, checker) {
    const symbol = checker.getSymbolAtLocation(binding.name);
    const target = symbol === undefined ? undefined : checker.getImmediateAliasedSymbol(symbol);
    return target?.declarations?.[0];
}

/** The export of `module` a call reaches, under any binding: `run()` for `{ exec as run }`, `cp.exec()`. */
function calledExport(node, module, checker) {
    if (!ts.isCallExpression(node)) {
        return undefined;
    }
    const target = resolveValue(invokedFunction(node.expression), checker);
    return target?.module === module ? target.member : undefined;
}

/** The function a callee runs: `cp.exec` for `cp.exec.call(…)` and `cp.exec.apply(…)`, else the callee. */
function invokedFunction(callee) {
    const value = unwrap(callee);
    const object = memberObject(value);
    return object !== undefined && INVOKERS.has(lastName(value) ?? '') ? object : callee;
}

/** The function `f` of a `f.bind(…)` call, or undefined. */
function boundFunction(node) {
    return ts.isCallExpression(node) && lastName(node.expression) === 'bind' ? memberObject(unwrap(node.expression)) : undefined;
}

/** A declaration that binds `exec`/`execSync` from child_process, called or not: a named import,
 *  `const run = cp.exec`, `const { exec } = require(…)`. */
function bindsShellExecutor(node, checker) {
    const isShellExecutor = identifier => {
        const target = resolveValue(identifier, checker);
        return target?.module === 'child_process' && SHELL_EXECUTORS.has(target.member ?? '');
    };
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        return node.importClause.namedBindings.elements.some(element => isShellExecutor(element.name));
    }
    // `export { exec } from 'child_process'` and `export * from 'child_process'` hand an executor on.
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier) &&
        moduleName(node.moduleSpecifier.text) === 'child_process') {
        const exports = node.exportClause;
        return exports === undefined ||
            (ts.isNamedExports(exports) && exports.elements.some(element => SHELL_EXECUTORS.has(lastName(element.propertyName ?? element.name) ?? '')));
    }
    // `run = cp.exec`: an executor assigned after declaration.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const target = resolveValue(node.right, checker);
        return target?.module === 'child_process' && SHELL_EXECUTORS.has(target.member ?? '');
    }
    if (ts.isVariableDeclaration(node)) {
        if (ts.isIdentifier(node.name)) {
            return isShellExecutor(node.name);
        }
        if (ts.isObjectBindingPattern(node.name)) {
            return node.name.elements.some(element => ts.isIdentifier(element.name) && isShellExecutor(element.name));
        }
    }
    return false;
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
    // `a['b']` and `{ ['b']: … }` name `b`; `a[key]` names whatever `key` holds, which is out of scope.
    if (ts.isElementAccessExpression(node)) {
        return literalText(node.argumentExpression);
    }
    if (ts.isComputedPropertyName(node)) {
        return literalText(node.expression);
    }
    if (ts.isParenthesizedExpression(node)) {
        return lastName(node.expression);
    }
    return undefined;
}

/** The text of a string or plain template literal, through unwrap()-able wrappers; undefined otherwise. */
function literalText(node) {
    const value = unwrap(node);
    return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) ? value.text : undefined;
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

/** The module a `require('m')` or `import('m')` expression loads, through any unwrap()-able wrapper.
 *  `require` is the CommonJS loader only when nothing in scope declares it; a parameter or local of that
 *  name is some other function. */
function loadedModule(node, checker) {
    node = unwrap(node);
    if (!ts.isCallExpression(node) || node.arguments.length < 1) {
        return undefined;
    }
    const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require' &&
        checker.getSymbolAtLocation(node.expression)?.declarations === undefined;
    const isLoader = isRequire || node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const [specifier] = node.arguments;
    return isLoader && (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier)) ? specifier.text : undefined;
}

/** The object a member is read from: `a` in `a.b` and `a['b']`. */
function memberObject(node) {
    return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? node.expression : undefined;
}

/** Whether an expression inside a log call's arguments carries prompt or payload text. */
function carriesText(node) {
    if (ts.isElementAccessExpression(node)) {
        // `request['text']` names a field; `text[0]` or `text[i]` indexes into the text itself.
        const key = unwrap(node.argumentExpression);
        return ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)
            ? TEXT_NAMES.has(key.text)
            : carriesText(node.expression);
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
        return TEXT_NAMES.has(lastName(node) ?? '');
    }
    if (ts.isCallExpression(node)) {
        const method = lastName(node.expression);
        const object = memberObject(node.expression);
        // `text.includes(x)`, `/re/.test(text)`: the result is a boolean or number, whatever went in.
        if (object !== undefined && NON_TEXT_RESULT.has(method ?? '')) {
            return false;
        }
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
    // `text === ''`, `text.length > 0`, `!text`, `typeof text`: a boolean or a type name, not the text.
    if (ts.isBinaryExpression(node) && BOOLEAN_OPERATORS.has(node.operatorToken.kind)) {
        return false;
    }
    if ((ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) || ts.isTypeOfExpression(node)) {
        return false;
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
            ts.isCallExpression(unwrap(node.initializer)) && lastName(unwrap(node.initializer).expression) === 'createOutputChannel') {
            const name = lastName(node.name);
            if (name !== undefined) {
                names.add(name);
            }
        }
        // `this.output = vscode.window.createOutputChannel('x')` (a constructor assigning a field), `out = …`.
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isCallExpression(unwrap(node.right)) && lastName(unwrap(node.right).expression) === 'createOutputChannel') {
            const name = lastName(unwrap(node.left));
            if (name !== undefined) {
                names.add(name);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return names;
}

/** `options.shell = true` (or `options['shell'] = …`) on an object that reaches a spawn call. */
function isShellAssignment(node, context) {
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
        return false;
    }
    const target = node.left;
    const object = memberObject(target);
    if (object === undefined || lastName(target) !== 'shell' || !isOptionsVariable(object, context)) {
        return false;
    }
    const value = unwrap(node.right);
    return !SHELL_OFF.has(value.kind) && !(ts.isIdentifier(value) && value.text === 'undefined');
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

/** Whether a call starts a process, or binds the arguments of one that will: a child_process spawner by
 *  any binding, called or bound with `.bind`. */
function isSpawnCall(node, context) {
    if (!ts.isCallExpression(node)) {
        return false;
    }
    // `cp.spawn.bind(cp, cmd, args, { shell: true })` binds the options a later call uses.
    const target = boundFunction(node) !== undefined ? resolveValue(node, context.checker) : undefined;
    const spawner = target?.module === 'child_process' ? target.member : calledExport(node, 'child_process', context.checker);
    return PROCESS_SPAWNERS.has(spawner ?? '');
}

/** The arguments a spawn call passes to the spawner: its own, or for `f.apply(this, [a, b, c])` the
 *  elements of that array literal. Empty for a call that does not spawn. */
function spawnArguments(call, context) {
    if (!isSpawnCall(call, context)) {
        return [];
    }
    const callee = unwrap(call.expression);
    if (lastName(callee) === 'apply' && memberObject(callee) !== undefined) {
        const list = call.arguments[1] === undefined ? undefined : unwrap(call.arguments[1]);
        return list !== undefined && ts.isArrayLiteralExpression(list) ? [...list.elements] : [];
    }
    return [...call.arguments];
}

/** Whether an object literal is the options of a spawn call: passed inline, held in a variable passed to
 *  one (`const opts = { … }; spawn(cmd, args, opts)`), or default-exported to a file that passes it. */
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
    // `cp.spawn.apply(cp, [cmd, args, { shell: true }])`: the options sit in the argument array.
    if (ts.isArrayLiteralExpression(node.parent) && ts.isCallExpression(node.parent.parent)) {
        return spawnArguments(node.parent.parent, context).includes(node);
    }
    if (ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.parent.right === node) {
        // `options = { … }` for a variable that reaches a spawn call.
        return isOptionsVariable(node.parent.left, context);
    }
    if (ts.isExportAssignment(node.parent)) {
        return [...context.spawnOptions].some(symbol => symbol.declarations?.includes(node.parent));
    }
    return ts.isVariableDeclaration(node.parent) && isOptionsVariable(node.parent.name, context);
}

/** The symbol of the variable an identifier denotes, followed through imports to the exporting file's
 *  declaration (`import { options } from './spawnOptions'`, a renamed or `export default` binding). */
function valueSymbol(node, checker, depth = 0) {
    const value = unwrap(node);
    if (!ts.isIdentifier(value)) {
        return undefined;
    }
    let symbol = checker.getSymbolAtLocation(value);
    if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) {
        symbol = checker.getAliasedSymbol(symbol);
    }
    const declaration = symbol?.declarations?.[0];
    // `export default options`: the default export is that variable.
    if (declaration !== undefined && ts.isExportAssignment(declaration) && ts.isIdentifier(declaration.expression) && depth < 8) {
        return valueSymbol(declaration.expression, checker, depth + 1) ?? symbol;
    }
    return symbol;
}

/** The symbols of variables that hold spawn options, across the whole program and by TypeScript symbol
 *  rather than name, so two scopes' `options` never collide and options imported from another file are
 *  the exporting file's variable. Starts from identifiers passed to a spawn call (and spread into one's
 *  options), then closes over composition: a plain alias (`const alias = options`) links both ways,
 *  because either name can then mutate the same object; a spread (`{ ...base }`) links one way, from
 *  the options to their source. */
function spawnOptionSymbols(sources, context) {
    const symbolOf = node => valueSymbol(node, context.checker);
    const edges = new Map();
    const link = (from, to) => {
        if (from !== undefined && to !== undefined) {
            edges.set(from, [...(edges.get(from) ?? []), to]);
        }
    };
    const options = new Set();
    const visit = node => {
        // `const x = …` and a later `x = …` both say what x is built from.
        const assigned = ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(unwrap(node.left));
        if ((ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) || assigned) {
            const target = symbolOf(assigned ? node.left : node.name);
            const value = unwrap(assigned ? node.right : node.initializer);
            if (ts.isIdentifier(value)) {
                link(target, symbolOf(value));
                link(symbolOf(value), target);
            } else if (ts.isObjectLiteralExpression(value)) {
                for (const property of value.properties) {
                    if (ts.isSpreadAssignment(property)) {
                        link(target, symbolOf(property.expression));
                    }
                }
            }
        }
        if (isSpawnCall(node, context)) {
            for (const argument of spawnArguments(node, context)) {
                const value = unwrap(argument);
                const symbol = symbolOf(value);
                if (symbol !== undefined) {
                    options.add(symbol);
                } else if (ts.isObjectLiteralExpression(value)) {
                    for (const property of value.properties) {
                        const spread = ts.isSpreadAssignment(property) ? symbolOf(property.expression) : undefined;
                        if (spread !== undefined) {
                            options.add(spread);
                        }
                    }
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    sources.forEach(visit);
    const pending = [...options];
    while (pending.length > 0) {
        for (const next of edges.get(pending.pop()) ?? []) {
            if (!options.has(next)) {
                options.add(next);
                pending.push(next);
            }
        }
    }
    return options;
}

/** Whether an identifier is one of the program's spawn-options variables. */
function isOptionsVariable(node, context) {
    const symbol = valueSymbol(node, context.checker);
    return symbol !== undefined && context.spawnOptions.has(symbol);
}

/** Whether a value is an output channel created here: `….createOutputChannel(…)`. */
function isChannelCreation(node) {
    const value = unwrap(node);
    return ts.isCallExpression(value) && lastName(value.expression) === 'createOutputChannel';
}

/** Whether a receiver is a logger. An identifier is followed through its symbol, so lexical scope
 *  decides: a local alias of a logger (`const out = log`), a variable holding an output channel, or an
 *  imported logger under any name is one; a parameter or local that shadows one is judged by its own
 *  declaration. Where nothing declares it (a global such as `console`), or it is a parameter or field
 *  without a value to follow, the logger naming convention decides. */
function isLoggerReceiver(node, context, depth = 0) {
    const value = unwrap(node);
    if (isChannelCreation(value)) {
        return true;
    }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
        // `this.output`, `this['logger']`: fields assigned a channel anywhere in the file, named as loggers,
        // or declared with a logger type. A key held in a variable names nothing (see lastName).
        const name = lastName(value);
        const field = ts.isPropertyAccessExpression(value) ? value : value.argumentExpression;
        return name !== undefined && (LOGGER_NAME.test(name) || context.outputChannels.has(name) ||
            hasLoggerType(context.checker.getSymbolAtLocation(field)?.declarations?.[0]));
    }
    if (!ts.isIdentifier(value) || depth > 8) {
        return false;
    }
    const declaration = context.checker.getSymbolAtLocation(value)?.declarations?.[0];
    return declaration === undefined ? LOGGER_NAME.test(value.text) : isLoggerDeclaration(declaration, context, depth + 1);
}

/** Whether what a declaration binds is a logger: one declared with a logger type, a variable whose
 *  values (initializer and later assignments) are loggers or output channels, an export of one, or an
 *  import of one (see {@link isLoggerImport}). Anything else, such as a parameter with no type to read,
 *  is judged by the logger naming convention. */
function isLoggerDeclaration(declaration, context, depth) {
    if (depth > 8) {
        return false;
    }
    if (hasLoggerType(declaration)) {
        return true;
    }
    if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) {
        return isLoggerImport(declaration, context, depth);
    }
    if (ts.isExportAssignment(declaration)) {
        return isLoggerReceiver(declaration.expression, context, depth + 1);
    }
    if (ts.isExportSpecifier(declaration)) {
        const local = context.checker.getExportSpecifierLocalTargetSymbol(declaration)?.declarations?.[0];
        return local !== undefined
            ? isLoggerDeclaration(local, context, depth + 1)
            : LOGGER_NAME.test(lastName(declaration.propertyName ?? declaration.name) ?? '');
    }
    if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
        const symbol = context.checker.getSymbolAtLocation(declaration.name);
        const values = [declaration.initializer, ...(assignmentsBySymbol.get(symbol) ?? [])].filter(v => v !== undefined);
        if (values.some(v => isChannelCreation(v) || isLoggerReceiver(v, context, depth + 1))) {
            return true;
        }
        // A value the check cannot follow, such as a factory call (`const log = makeLogger()`), leaves the
        // decision to the naming convention below; a value it can follow, such as `const out = 1`, does not.
        if (values.length > 0 && !values.some(v => isOpaqueValue(v))) {
            return false;
        }
    }
    const name = declaration.name !== undefined ? lastName(declaration.name) : undefined;
    return LOGGER_NAME.test(name ?? '');
}

/** Whether a value comes out of a call or `new`, whose result the check cannot see. */
function isOpaqueValue(node) {
    const value = unwrap(node);
    return ts.isCallExpression(value) || ts.isNewExpression(value);
}

/** Whether an import binds a logger, under any local name. An import from another file of the program is
 *  judged by the declaration it names there. For a module outside the program, a named import is judged by
 *  its exported name (`{ log as out }`), and a default or namespace import by the module's file name
 *  (`import out from './logger'`, `import * as out from './log'`). */
function isLoggerImport(binding, context, depth) {
    const exported = ts.isNamespaceImport(binding) ? undefined : exportedDeclaration(binding, context.checker);
    if (exported !== undefined) {
        return isLoggerDeclaration(exported, context, depth + 1);
    }
    if (ts.isImportSpecifier(binding)) {
        return LOGGER_NAME.test(lastName(binding.propertyName ?? binding.name) ?? '');
    }
    const importDeclaration = ts.isNamespaceImport(binding) ? binding.parent.parent : binding.parent;
    const file = importDeclaration.moduleSpecifier.text.split('/').pop().replace(/\.[^.]*$/, '');
    return LOGGER_NAME.test(file);
}

/** Whether a declaration is annotated with a logger type: `out: vscode.LogOutputChannel`, `log: Logger`. */
function hasLoggerType(declaration) {
    const type = declaration?.type;
    if (type === undefined || !ts.isTypeReferenceNode(type)) {
        return false;
    }
    const name = ts.isQualifiedName(type.typeName) ? type.typeName.right : type.typeName;
    return LOGGER_TYPE.test(name.text);
}

/** The arguments a log call writes, or undefined when the call is not a log call: its own, after any
 *  bound in advance (`console.info.bind(console, prompt)`). */
function logCallArguments(node, context) {
    if (!ts.isCallExpression(node)) {
        return undefined;
    }
    const bound = loggerMethodBoundArguments(invokedFunction(node.expression), context);
    return bound === undefined ? undefined : [...bound, ...node.arguments];
}

/** The arguments bound in advance to a logging method of a logger, or undefined when the expression is
 *  not one. It may be the method itself (`log.info`), a bound copy (`console.info.bind(console, prefix)`,
 *  whose arguments after `this` are written first), or a variable holding either (`const info =
 *  console.info`, `const { info: write } = console`). A variable is followed through its symbol, so a
 *  local that shadows such an alias is judged by its own value. */
function loggerMethodBoundArguments(node, context, depth = 0) {
    const value = unwrap(node);
    if (depth > 8) {
        return undefined;
    }
    const bound = boundFunction(value);
    if (bound !== undefined) {
        const inner = loggerMethodBoundArguments(bound, context, depth + 1);
        return inner === undefined ? undefined : [...inner, ...value.arguments.slice(1)];
    }
    const receiver = memberObject(value);
    if (receiver !== undefined) {
        return LOG_METHODS.has(lastName(value) ?? '') && isLoggerReceiver(receiver, context) ? [] : undefined;
    }
    if (!ts.isIdentifier(value)) {
        return undefined;
    }
    const declaration = context.checker.getSymbolAtLocation(value)?.declarations?.[0];
    return declaration === undefined ? undefined : declarationBoundArguments(declaration, context, depth + 1);
}

/** {@link loggerMethodBoundArguments} for what a declaration binds: a variable's values, a destructured
 *  property (`const { info } = console`, `{ info: write }`), or an import, followed to the declaration it
 *  names in another file of the program, through re-exports and `export default`. */
function declarationBoundArguments(declaration, context, depth) {
    if (depth > 8) {
        return undefined;
    }
    if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration)) {
        const exported = exportedDeclaration(declaration, context.checker);
        return exported === undefined ? undefined : declarationBoundArguments(exported, context, depth + 1);
    }
    if (ts.isExportSpecifier(declaration)) {
        const local = context.checker.getExportSpecifierLocalTargetSymbol(declaration)?.declarations?.[0];
        return local === undefined ? undefined : declarationBoundArguments(local, context, depth + 1);
    }
    if (ts.isExportAssignment(declaration)) {
        return loggerMethodBoundArguments(declaration.expression, context, depth + 1);
    }
    if (ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent) &&
        ts.isVariableDeclaration(declaration.parent.parent) && declaration.parent.parent.initializer !== undefined) {
        const method = lastName(declaration.propertyName ?? declaration.name);
        return LOG_METHODS.has(method ?? '') && isLoggerReceiver(declaration.parent.parent.initializer, context) ? [] : undefined;
    }
    if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) {
        return undefined;
    }
    const symbol = context.checker.getSymbolAtLocation(declaration.name);
    for (const v of [declaration.initializer, ...(assignmentsBySymbol.get(symbol) ?? [])]) {
        const args = v === undefined ? undefined : loggerMethodBoundArguments(v, context, depth + 1);
        if (args !== undefined) {
            return args;
        }
    }
    return undefined;
}

const CHECKS = [
    {
        rule: 'R10',
        scope: 'source',
        message: 'log call writes prompt or payload text; log ids, counts or lengths instead',
        test: (node, context) => logCallArguments(node, context)?.some(carriesText) ?? false,
    },
    {
        rule: 'R36',
        scope: 'all',
        message: 'shell execution; use execFile/spawn with an argv vector and no shell',
        test: (node, context) =>
            // A `shell` option on an object given to a process spawner, set to anything but false, null or
            // undefined: `true`, a shell path such as '/bin/bash', or a variable.
            (isShellOption(node) && isSpawnOptions(node.parent, context)) ||
            isShellAssignment(node, context) ||
            SHELL_EXECUTORS.has(calledExport(node, 'child_process', context.checker) ?? '') ||
            bindsShellExecutor(node, context.checker),
    },
    {
        rule: 'R43',
        scope: 'test',
        message: 'temp directory outside the canonical helper; use makeTempDir / TEMP_ROOT from helpers/tempDir',
        test: (node, context) => {
            if (context.file === TEMP_HELPER || !ts.isCallExpression(node)) {
                return false;
            }
            if (calledExport(node, 'os', context.checker) === 'tmpdir') {
                return true;
            }
            const first = node.arguments[0];
            const makesTemp = name => name === 'mkdtemp' || name === 'mkdtempSync';
            return (makesTemp(calledExport(node, 'fs', context.checker)) || makesTemp(calledExport(node, 'fs/promises', context.checker))) &&
                first !== undefined && containsTmpLiteral(first);
        },
    },
    {
        rule: 'R54',
        scope: 'test',
        message: 'expression-bodied test hook returns a value Vitest may run as teardown; use a block body',
        test: (node, context) => {
            if (!ts.isCallExpression(node)) {
                return false;
            }
            // `setup(…)` for `{ beforeEach as setup }` and `vitest.beforeEach(…)` resolve to Vitest; a bare
            // `beforeEach(…)` with no declaration in scope is the Vitest global. A local of that name is not.
            const target = resolveValue(node.expression, context.checker);
            const isGlobal = ts.isIdentifier(node.expression) && context.checker.getSymbolAtLocation(node.expression)?.declarations === undefined;
            const hook = target?.module === 'vitest' ? target.member : isGlobal ? node.expression.text : undefined;
            if (!HOOKS.has(hook ?? '')) {
                return false;
            }
            const callback = node.arguments[0] === undefined ? undefined : unwrap(node.arguments[0]);
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
// One program over all files, for symbol resolution only: no module resolution and no lib, so it needs
// neither node_modules nor a tsconfig and works the same on a fixture tree.
const files = [...walk(SRC)];
const program = ts.createProgram(files, { noResolve: true, noLib: true, types: [], target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext });
const checker = program.getTypeChecker();
for (const file of files) {
    collectAssignments(program.getSourceFile(file), checker);
}
const spawnOptions = spawnOptionSymbols(files.map(file => program.getSourceFile(file)), { checker });
for (const file of files) {
    const scope = file.startsWith(TEST_DIR) ? 'test' : 'source';
    const checks = CHECKS.filter(check => check.scope === scope || check.scope === 'all');
    const source = program.getSourceFile(file);
    const context = {
        file,
        checker,
        outputChannels: outputChannelBindings(source),
        spawnOptions,
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
