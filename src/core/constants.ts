/**
 * Shared constants for Claw Code.
 *
 * The `openclaw.*` command ids and settings keys mirror `package.json`
 * `contributes`, which is the source of truth; keep both in sync.
 */

export const OPENCLAW_DASHBOARD_URL = 'http://127.0.0.1:18789/';

/** Extension version reported in the gateway handshake; injected at build time from package.json via esbuild `define`. */
export const CLIENT_VERSION: string = typeof __CLIENT_VERSION__ === 'string' ? __CLIENT_VERSION__ : '0.2.1';

/** Command ids declared in package.json `contributes.commands`. */
export const COMMANDS = {
  CONNECT: 'openclaw.connect',
  SETUP: 'openclaw.setup',
  MODEL_SETUP: 'openclaw.modelSetup',
  HARDEN: 'openclaw.harden',
  HARDENING_SHOW_ACCESS_SUMMARY: 'openclaw.hardening.showAccessSummary',
  CHAT_OPEN: 'openclaw.chat.open',
  CHAT_POP_OUT: 'openclaw.chat.popOut',
  CHAT_NEW_SESSION: 'openclaw.chat.newSession',
  CHAT_PICK_AGENT: 'openclaw.chat.pickAgent',
  CHAT_INSERT_SELECTION: 'openclaw.chat.insertSelection',
  CHAT_DEBUG: 'openclaw.chat.debug',
  CHAT_CONNECT_GATEWAY: 'openclaw.chat.connectGateway',
  GATEWAY_RESET_DEVICE_IDENTITY: 'openclaw.gateway.resetDeviceIdentity',
} as const;

/** Command ids used by the host but not declared in package.json `contributes`. */
export const INTERNAL_COMMANDS = {
  DOCTOR: 'openclaw.doctor',
  UPDATE: 'openclaw.update',
  CONFIGURE: 'openclaw.configure',
  TOOLS_TOGGLE: 'openclaw.tools.toggle',
  TOOLS_SHOW: 'openclaw.tools.show',
  HARDENING_RUN: 'openclaw.hardening.run',
  HARDENING_DEEP: 'openclaw.hardening.deep',
  OPEN_DOCS: 'openclaw.openDocs',
  OVERVIEW_REFRESH: 'openclaw.overview.refresh',
} as const;

/** Settings keys declared in package.json `contributes.configuration`. */
export const SETTINGS = {
  AUTO_CONNECT: 'openclaw.autoConnect',
  COMMAND: 'openclaw.command',
  HARDENING_MODE: 'openclaw.hardening.mode',
  HARDENING_COMMAND: 'openclaw.hardening.command',
  CHAT_AGENT: 'openclaw.chat.agent',
  CHAT_PERMISSIONS: 'openclaw.chat.permissions',
  CHAT_MODELS: 'openclaw.chat.models',
  CHAT_SYSTEM_PROMPT: 'openclaw.chat.systemPrompt',
  CHAT_CONTEXT_MAX: 'openclaw.chat.contextMax',
  CHAT_SOURCE: 'openclaw.chat.source',
  CHAT_DYNAMIC_SUBJECT: 'openclaw.chat.dynamicSubject',
  CHAT_COLLAPSE_COMPLETED: 'openclaw.chat.collapseCompleted',
  CHAT_ATTACH_OPEN_FILE: 'openclaw.chat.attachOpenFile',
  CHAT_HIDE_TOOL_ACTIVITY: 'openclaw.chat.hideToolActivity',
  CHAT_DIMENSION: 'openclaw.chat.dimension',
  DASHBOARD_URL: 'openclaw.dashboardUrl',
  GATEWAY_TOKEN: 'openclaw.gateway.token',
  GATEWAY_URL: 'openclaw.gateway.url',
  GATEWAY_TRANSPORT: 'openclaw.gateway.transport',
  GATEWAY_PROTOCOL_VERSION: 'openclaw.gateway.protocolVersion',
} as const;

/** Placeholder value reported when a gateway field is missing. */
export const UNKNOWN = 'unknown';

/** Longest gateway-supplied message kept in errors shown to the user. */
export const GATEWAY_MESSAGE_LIMIT = 300;

/** Longest a history read waits before the caller falls back (settle-to-null) or gives up. */
export const HISTORY_READ_TIMEOUT_MS = 10_000;

/** Largest delay usable in `setTimeout`; Node clamps longer timers to this. */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** Chat thread grid layouts, mirroring the `openclaw.chat.dimension` enum in package.json. */
export const GRID_DIMENSIONS = ['1x1', '2x2', '2x3', '3x3', '4x4'];
