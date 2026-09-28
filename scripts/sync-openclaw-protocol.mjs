#!/usr/bin/env node
/**
 * Regenerates src/__test__/fixtures/openclaw-protocol-v4/ from an extracted
 * `openclaw` npm package, so the gateway client's test fixtures are checked
 * against the gateway's own TypeBox schemas instead of an assumed contract.
 *
 * Usage:
 *   npm pack openclaw@<version> && tar -xzf openclaw-<version>.tgz
 *   node scripts/sync-openclaw-protocol.mjs ./package
 *
 * The script imports the package's dist bundles, serializes the named TypeBox
 * schemas as JSON Schema, and rewrites the VERSION file. Schemas the bundle
 * defines but does not export are reached through a temporary sibling module
 * that re-exports them; it is deleted again before the script exits.
 *
 * Some wire shapes have no TypeBox schema (RPC results the gateway builds ad
 * hoc, and event payloads it never validates). Those live in `handler-derived/`,
 * are written by hand from the gateway's handler sources, and are only merged
 * here, never regenerated. Review them when bumping the openclaw version.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../src/__test__/fixtures/openclaw-protocol-v4');
const HANDLER_DERIVED_DIR = path.join(FIXTURE_DIR, 'handler-derived');

/** Fixture file name → TypeBox schema constant in the openclaw dist bundles. */
const TYPEBOX_FIXTURES = {
  'frame.request.json': 'RequestFrameSchema',
  'frame.response.json': 'ResponseFrameSchema',
  'frame.event.json': 'EventFrameSchema',
  'error-shape.json': 'ErrorShapeSchema',
  'connect.params.json': 'ConnectParamsSchema',
  'hello-ok.json': 'HelloOkSchema',
  'chat.send.params.json': 'ChatSendParamsSchema',
  'chat.abort.params.json': 'ChatAbortParamsSchema',
  'chat.history.params.json': 'ChatHistoryParamsSchema',
  'sessions.messages.subscribe.params.json': 'SessionsMessagesSubscribeParamsSchema',
  'sessions.messages.unsubscribe.params.json': 'SessionsMessagesUnsubscribeParamsSchema',
  'sessions.list.params.json': 'SessionsListParamsSchema',
  'event.chat.json': 'ChatEventSchema',
  'event.tick.json': 'TickEventSchema',
  'event.shutdown.json': 'ShutdownEventSchema',
};

/** Schemas composed into fixtures below rather than written on their own. */
const COMPOSED_SCHEMAS = ['ChatHistoryDeltaResultSchema', 'ChatHistoryResetResultSchema', 'AgentEventSchema'];

function fail(message) {
  console.error(`sync-openclaw-protocol: ${message}`);
  process.exit(1);
}

function readPackage(packageDir) {
  const manifestPath = path.join(packageDir, 'package.json');
  if (!fs.existsSync(manifestPath)) fail(`no package.json in ${packageDir}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== 'openclaw') fail(`${packageDir} is ${manifest.name}, not openclaw`);
  return manifest;
}

/** The dist file declaring `const <name> = ` for every requested schema. */
function locateDefinitions(distDir, names) {
  const files = fs.readdirSync(distDir).filter((file) => file.endsWith('.mjs'));
  const byFile = new Map();
  for (const name of names) {
    const declaration = `const ${name} = `;
    const file = files.find((candidate) => fs.readFileSync(path.join(distDir, candidate), 'utf8').includes(declaration));
    if (!file) fail(`schema ${name} not found in ${distDir}`);
    byFile.set(file, [...(byFile.get(file) ?? []), name]);
  }
  return byFile;
}

/** Import a copy of the bundle that additionally exports the requested local constants. */
async function importLocals(distDir, file, names) {
  const source = fs.readFileSync(path.join(distDir, file), 'utf8');
  const probePath = path.join(distDir, `.claw-sync-${process.pid}-${file}`);
  const reExports = names.map((name) => `${name} as __claw_${name}`).join(', ');
  fs.writeFileSync(probePath, `${source}\nexport { ${reExports} };\n`);
  try {
    const module = await import(pathToFileURL(probePath).href);
    return Object.fromEntries(names.map((name) => [name, module[`__claw_${name}`]]));
  } finally {
    fs.rmSync(probePath, { force: true });
  }
}

async function loadSchemas(distDir, names) {
  const schemas = {};
  for (const [file, fileNames] of locateDefinitions(distDir, names)) {
    Object.assign(schemas, await importLocals(distDir, file, fileNames));
  }
  return schemas;
}

/** TypeBox keeps its metadata non-enumerable, so a JSON round trip yields plain JSON Schema. */
function toJsonSchema(schema, title) {
  return { $schema: 'http://json-schema.org/draft-07/schema#', title, ...JSON.parse(JSON.stringify(schema)) };
}

function readHandlerDerived(file) {
  return JSON.parse(fs.readFileSync(path.join(HANDLER_DERIVED_DIR, file), 'utf8'));
}

function writeFixture(file, schema) {
  fs.writeFileSync(path.join(FIXTURE_DIR, file), `${JSON.stringify(schema, null, 2)}\n`);
}

/** chat.history answers a tail read (no TypeBox schema) or a cursor read (delta or reset). */
function chatHistoryResult(schemas) {
  const strip = (schema) => Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$schema' && key !== 'title'));
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'chat.history result',
    anyOf: [
      strip(readHandlerDerived('chat.history.tail-result.json')),
      strip(toJsonSchema(schemas.ChatHistoryDeltaResultSchema, 'delta')),
      strip(toJsonSchema(schemas.ChatHistoryResetResultSchema, 'reset')),
    ],
  };
}

/** The gateway spreads a session snapshot (sessionKey, agentId, session, ...) into AgentEventSchema
 *  payloads before broadcasting them (src/gateway/server-chat.ts), so the closed object is opened. */
function agentEvent(schemas) {
  const schema = toJsonSchema(schemas.AgentEventSchema, 'agent event');
  return { ...schema, additionalProperties: true, 'x-claw-note': 'AgentEventSchema opened for the broadcast session snapshot' };
}

async function main() {
  const packageDir = process.argv[2];
  if (!packageDir) fail('usage: node scripts/sync-openclaw-protocol.mjs <extracted openclaw package dir>');
  const manifest = readPackage(path.resolve(packageDir));
  const distDir = path.join(path.resolve(packageDir), 'dist');
  const versionModule = await loadSchemas(distDir, ['PROTOCOL_VERSION']);
  const schemas = await loadSchemas(distDir, [...Object.values(TYPEBOX_FIXTURES), ...COMPOSED_SCHEMAS]);
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  for (const [file, name] of Object.entries(TYPEBOX_FIXTURES)) {
    writeFixture(file, toJsonSchema(schemas[name], name));
  }
  writeFixture('chat.history.result.json', chatHistoryResult(schemas));
  writeFixture('event.agent.json', agentEvent(schemas));
  fs.writeFileSync(
    path.join(FIXTURE_DIR, 'VERSION'),
    `openclaw ${manifest.version}\nprotocol ${versionModule.PROTOCOL_VERSION}\n`
  );
  console.log(`synced ${Object.keys(TYPEBOX_FIXTURES).length + 2} schemas from openclaw ${manifest.version} (protocol ${versionModule.PROTOCOL_VERSION})`);
}

await main();
