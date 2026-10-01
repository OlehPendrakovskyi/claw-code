/**
 * Claw Code — Gateway settings and token management.
 *
 * Reads the `openclaw.gateway.*` configuration block, manages the gateway
 * auth token in VS Code SecretStorage, and performs a one-time migration of
 * a legacy plaintext `openclaw.gateway.token` setting into SecretStorage, and
 * keeps the device identity and the device tokens gateways issued it there too.
 *
 * Tokens and keys are never logged and never returned in error messages.
 */

import * as vscode from 'vscode';
import { log } from '../vscode/commands/shared';
import type { DeviceCredentialStore, DeviceIdentity, StoredDeviceToken } from './gatewayProtocol/deviceIdentity';
import { errorMessage } from './errors';
import { withTimeout } from './async';
import { exportDeviceIdentity, generateDeviceIdentity, importDeviceIdentity, isStoredDeviceToken } from './gatewayProtocol/deviceIdentity';
import type { ProtocolSetting } from './gatewayProtocol/registry';
import { isProtocolSetting } from './gatewayProtocol/registry';

/** SecretStorage key under which the gateway token is stored. */
export const GATEWAY_TOKEN_SECRET_KEY = 'openclaw.gateway.token';

/** SecretStorage key prefix of the device's Ed25519 private key (PKCS#8 PEM), one per host kind. */
export const DEVICE_IDENTITY_SECRET_KEY = 'openclaw.gateway.deviceIdentity';

/** SecretStorage key prefix of the device tokens gateways issued, as JSON keyed by gateway origin. */
export const DEVICE_TOKENS_SECRET_KEY = 'openclaw.gateway.deviceTokens';

/** Longest one SecretStorage call may take before it counts as failed: a hung keyring must not wedge the queue. */
const SECRET_CALL_TIMEOUT_MS = 5000;

/** Before minting a key into an empty slot, wait up to this long: another window reacting to the same reset may mint first. */
const IDENTITY_CREATE_JITTER_MS = 250;

/** Legacy plaintext configuration key migrated into SecretStorage once.
 *  Relative to the `openclaw` configuration section (full setting id is
 *  `openclaw.gateway.token`); sectioned config lookups need the relative key. */
export const LEGACY_GATEWAY_TOKEN_SETTING = 'gateway.token';

/** Transport selection for the chat backend. */
export type GatewayTransport = 'gateway' | 'acpx' | 'auto';

/** Resolved gateway settings. */
export type GatewaySettings = {
  /** Gateway WebSocket URL, e.g. `ws://127.0.0.1:18789`. */
  url: string;
  /** Transport: force gateway, force acpx, or auto (gateway when reachable). */
  transport: GatewayTransport;
  /** Gateway protocol versions the handshake offers: every supported one, or exactly one. */
  protocolVersion: ProtocolSetting;
};

export type LegacyTokenMigrationResult = 'completed' | 'noop' | 'incomplete';

/**
 * Gateway settings and token management facade.
 *
 * Static operations over the `openclaw.gateway.*` configuration block, the
 * gateway auth token in VS Code SecretStorage, and the one-time migration of
 * a legacy plaintext `openclaw.gateway.token` setting. Tokens are never
 * logged and never returned in error messages.
 */
export class GatewayConfigService {
  /**
   * Read gateway settings from workspace configuration with defaults
   * (`ws://127.0.0.1:18789`, transport `auto`, protocol `auto`).
   */
  static getGatewaySettings(): GatewaySettings {
    const config = vscode.workspace.getConfiguration('openclaw');
    // settings.json is hand-editable, so either value may have any JSON type.
    const rawUrl: unknown = config.get('gateway.url');
    const url = (typeof rawUrl === 'string' ? rawUrl.trim() : '') || 'ws://127.0.0.1:18789';
    const rawTransport: unknown = config.get('gateway.transport');
    const transport: GatewayTransport =
      rawTransport === 'gateway' || rawTransport === 'acpx' ? rawTransport : 'auto';
    const rawProtocol: unknown = config.get('gateway.protocolVersion');
    const protocolVersion: ProtocolSetting = isProtocolSetting(rawProtocol) ? rawProtocol : 'auto';
    return { url, transport, protocolVersion };
  }

  /** Whether `url` is a `ws:` or `wss:` URL, without fragment, that the gateway client can open. */
  static isValidGatewayUrl(url: string): boolean {
    return GatewayConfigService.parseUrl(url) !== null;
  }

  /** Whether `url` names this machine: only there may a stored device token back a refused shared token. */
  static isLoopbackGatewayUrl(url: string): boolean {
    const parsed = GatewayConfigService.parseUrl(url);
    return parsed !== null && GatewayConfigService.isLoopbackHost(parsed.hostname);
  }

  /** Whether a token sent to `url` would cross the network unencrypted:
   *  plain `ws:` to anything but a loopback host. */
  static sendsTokenInCleartext(url: string): boolean {
    const parsed = GatewayConfigService.parseUrl(url);
    return parsed !== null && parsed.protocol === 'ws:' && !GatewayConfigService.isLoopbackHost(parsed.hostname);
  }

  private static parseUrl(url: string): URL | null {
    try {
      const parsed = new URL(url);
      // The ws client throws synchronously on a fragment, so it is invalid here.
      const isWebSocket = parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
      return isWebSocket && parsed.hash === '' && !url.includes('#') ? parsed : null;
    } catch {
      return null;
    }
  }

  /** `hostname` as WHATWG URL normalizes it (lowercase, IPv6 bracketed and
   *  compressed, IPv4-mapped IPv6 in hex). */
  private static isLoopbackHost(hostname: string): boolean {
    const host = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
    if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]') {
      return true;
    }
    const mappedV4 = /^\[::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}\]$/.exec(host);
    if (mappedV4) {
      return parseInt(mappedV4[1], 16) >> 8 === 127;
    }
    return /^127(?:\.\d{1,3}){3}$/.test(host);
  }

  /**
   * Read the gateway token from SecretStorage.
   * Returns an empty string when no token is stored.
   */
  static async getGatewayToken(secrets: vscode.SecretStorage): Promise<string> {
    const token = await secrets.get(GATEWAY_TOKEN_SECRET_KEY);
    return typeof token === 'string' ? token : '';
  }

  /**
   * Store the gateway token in SecretStorage.
   * An empty value clears the stored token.
   */
  static async setGatewayToken(secrets: vscode.SecretStorage, token: string): Promise<void> {
    if (token) {
      await secrets.store(GATEWAY_TOKEN_SECRET_KEY, token);
    } else {
      await secrets.delete(GATEWAY_TOKEN_SECRET_KEY);
    }
  }

  /**
   * One-time migration: move a legacy plaintext `openclaw.gateway.token`
   * setting into SecretStorage and clear it from every settings location.
   * Never overwrites an existing SecretStorage token; a non-empty legacy
   * value is stored only when no secret exists. Returns `completed` after a
   * successful migration, `noop` when no legacy value exists anywhere (a
   * finished no-op that callers may cache), and `incomplete` when plaintext
   * is still present afterwards so callers can retry later.
   *
   * Runs are serialized with each other and with token saves: activation,
   * the chat factory and the settings listener may trigger it concurrently,
   * and a run that read SecretStorage as empty would overwrite a token saved
   * meanwhile.
   */
  static migrateLegacyGatewayToken(
    context: vscode.ExtensionContext
  ): Promise<LegacyTokenMigrationResult> {
    return GatewayConfigService.serialized(() => GatewayConfigService.runLegacyTokenMigration(context));
  }

  /**
   * Interactive command handler: prompt for the gateway token (masked input)
   * and store it in SecretStorage. Cancel keeps any previously stored token.
   */
  static async promptForGatewayToken(context: vscode.ExtensionContext): Promise<boolean> {
    const value = await vscode.window.showInputBox({
      prompt: 'OpenClaw gateway auth token (stored in SecretStorage)',
      password: true,
      placeHolder: 'paste token',
    });
    if (value === undefined) {
      return false;
    }
    await GatewayConfigService.serialized(() =>
      GatewayConfigService.setGatewayToken(context.secrets, value.trim())
    );
    void vscode.window.showInformationMessage(
      value.trim() ? 'Gateway token saved to SecretStorage.' : 'Gateway token cleared.'
    );
    return true;
  }

  /**
   * Remote extension hosts keep secrets in the local window's keychain (the extension host proxies
   * SecretStorage to MainThreadSecretState), so a local Windows window and a WSL window share one
   * store. Each claims its own `client.platform`, which the gateway pins per device, so each host
   * kind gets its own identity.
   */
  static deviceHostKind(): string {
    return `${vscode.env.remoteName ?? 'local'}-${process.platform}`;
  }

  /** Forget this host kind's device identity and tokens, so its next connect pairs a new device. */
  static resetDeviceIdentity(secrets: vscode.SecretStorage, hostKind = GatewayConfigService.deviceHostKind()): Promise<void> {
    const keys = deviceSecretKeys(hostKind);
    return serializeDeviceSecrets(async () => {
      await secretCall(secrets.delete(keys.tokens));
      await secretCall(secrets.delete(keys.identity));
    });
  }

  private static secretWriteQueue: Promise<unknown> = Promise.resolve();

  private static serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = GatewayConfigService.secretWriteQueue.then(task);
    GatewayConfigService.secretWriteQueue = run.catch(() => undefined);
    return run;
  }

  private static cleanupWarningShown = false;

  private static async runLegacyTokenMigration(
    context: vscode.ExtensionContext
  ): Promise<LegacyTokenMigrationResult> {
    const sites = GatewayConfigService.managedLegacyTokenSites();
    if (sites.length === 0) {
      return 'noop';
    }
    // Workspace settings arrive with the repository, so only a user-level value is ever adopted.
    const legacyToken = sites
      .filter((site) => site.level === 'global')
      .map((site) => legacyTokenValue(site.value))
      .find((value) => value !== '');
    const ignoredWorkspaceToken = sites.some((site) => site.level !== 'global' && legacyTokenValue(site.value) !== '');
    let storedToken: string;
    try {
      storedToken = await GatewayConfigService.getGatewayToken(context.secrets);
      if (legacyToken && !storedToken) {
        await GatewayConfigService.setGatewayToken(context.secrets, legacyToken);
      }
    } catch (err) {
      // The plaintext stays until SecretStorage holds the token: deleting it
      // now would lose the credential.
      log.warn(`legacy token migration could not use SecretStorage: ${errorMessage(err)}`);
      GatewayConfigService.warnMigrationIncomplete(
        'Legacy plaintext gateway token could not be saved to SecretStorage and was left in settings. ' +
        'Check the OS keyring, then reload the window.'
      );
      return 'incomplete';
    }
    // Most likely a rotation typed into settings.json, which never replaces
    // the saved token.
    const ignoredDifferentToken = legacyToken !== undefined && storedToken !== '' && legacyToken !== storedToken;
    for (const site of sites) {
      try {
        await site.config.update(LEGACY_GATEWAY_TOKEN_SETTING, undefined, site.target, site.overrideInLanguage);
      } catch (err) {
        log.warn(`legacy token cleanup failed for ${site.id}: ${errorMessage(err)}`);
      }
    }
    // Only a fresh inspection proves the plaintext is gone: a failed update,
    // or a location the Configuration API cannot write (remote user settings,
    // policy), leaves the value in place without throwing.
    if (GatewayConfigService.managedLegacyTokenSites().length === 0) {
      if (ignoredWorkspaceToken) {
        void vscode.window.showInformationMessage(
          'A gateway token found in workspace settings was removed and not used: a workspace cannot supply the token. ' +
          'Run "OpenClaw: Connect to Gateway" to set it.'
        );
      } else if (ignoredDifferentToken) {
        void vscode.window.showInformationMessage(
          'A gateway token found in settings was removed without replacing the saved one. ' +
          'Run "OpenClaw: Connect to Gateway" to change the token.'
        );
      }
      return 'completed';
    }
    GatewayConfigService.warnMigrationIncomplete(
      'Legacy plaintext gateway token could not be removed from settings. ' +
      'Delete `openclaw.gateway.token` from settings.json manually.'
    );
    return 'incomplete';
  }

  private static warnMigrationIncomplete(message: string): void {
    if (GatewayConfigService.cleanupWarningShown) {
      return;
    }
    GatewayConfigService.cleanupWarningShown = true;
    void vscode.window.showWarningMessage(message);
  }

  /** The locations migration may touch: user settings always, workspace ones only once the
   *  workspace is trusted, as writing them edits the repository's files. */
  private static managedLegacyTokenSites(): LegacyTokenSite[] {
    return GatewayConfigService.findLegacyTokenSites().filter((site) => site.level === 'global' || vscode.workspace.isTrusted);
  }

  /**
   * Every settings location that currently defines the legacy token, most
   * specific first, so the first non-empty value is the one the user meant.
   *
   * `inspect().languageIds` lists every `[language]` override of the key in
   * the active profile's user settings, the workspace and the inspected
   * folder, so no settings file is read from disk. The unscoped inspection
   * sees no folder settings, which is why every workspace folder is
   * inspected too.
   */
  private static findLegacyTokenSites(): LegacyTokenSite[] {
    const sites = new Map<string, LegacyTokenSite>();
    const addSite = (site: LegacyTokenSite): void => {
      if (site.value !== undefined && !sites.has(site.id)) {
        sites.set(site.id, site);
      }
    };
    const folderUris = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri);
    for (const folderUri of [undefined, ...folderUris]) {
      const config = vscode.workspace.getConfiguration('openclaw', folderUri);
      const inspection = config.inspect<unknown>(LEGACY_GATEWAY_TOKEN_SETTING);
      addSite(GatewayConfigService.site(config, 'global', inspection?.globalValue, folderUri));
      addSite(GatewayConfigService.site(config, 'workspace', inspection?.workspaceValue, folderUri));
      if (folderUri) {
        addSite(GatewayConfigService.site(config, 'folder', inspection?.workspaceFolderValue, folderUri));
      }
      for (const languageId of inspection?.languageIds ?? []) {
        const languageConfig = vscode.workspace.getConfiguration(
          'openclaw',
          folderUri ? { languageId, uri: folderUri } : { languageId }
        );
        const languageInspection = languageConfig.inspect<unknown>(LEGACY_GATEWAY_TOKEN_SETTING);
        addSite(GatewayConfigService.site(languageConfig, 'global', languageInspection?.globalLanguageValue, folderUri, languageId));
        addSite(GatewayConfigService.site(languageConfig, 'workspace', languageInspection?.workspaceLanguageValue, folderUri, languageId));
        if (folderUri) {
          addSite(GatewayConfigService.site(languageConfig, 'folder', languageInspection?.workspaceFolderLanguageValue, folderUri, languageId));
        }
      }
    }
    // Stable sort: within one level, folders keep workspace order.
    return [...sites.values()].sort((a, b) => a.precedence - b.precedence);
  }

  private static site(
    config: vscode.WorkspaceConfiguration,
    level: SettingsLevel,
    value: unknown,
    folderUri: vscode.Uri | undefined,
    languageId?: string
  ): LegacyTokenSite {
    const folderPart = level === 'folder' && folderUri ? ` ${folderUri.toString()}` : '';
    const languagePart = languageId ? ` [${languageId}]` : '';
    return {
      id: `${level}${folderPart}${languagePart}`,
      level,
      config,
      target: SETTINGS_LEVEL_TARGET[level],
      overrideInLanguage: languageId !== undefined,
      value,
      precedence: (languageId !== undefined ? 0 : 3) + SETTINGS_LEVEL_SPECIFICITY[level],
    };
  }
}

type SettingsLevel = 'global' | 'workspace' | 'folder';

function legacyTokenValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const SETTINGS_LEVEL_TARGET: Record<SettingsLevel, vscode.ConfigurationTarget> = {
  global: vscode.ConfigurationTarget.Global,
  workspace: vscode.ConfigurationTarget.Workspace,
  folder: vscode.ConfigurationTarget.WorkspaceFolder,
};

/** Lower is more specific. Language overrides rank above every plain value:
 *  the token is used without an editor context, and a `[language]` value is
 *  the most deliberate place a user could have put it. */
const SETTINGS_LEVEL_SPECIFICITY: Record<SettingsLevel, number> = {
  folder: 0,
  workspace: 1,
  global: 2,
};

/** One settings location holding the legacy token, with a configuration
 *  scoped so that `update(key, undefined, target, overrideInLanguage)`
 *  clears exactly that location. */
type LegacyTokenSite = {
  /** Location label, unique per location; safe to log (never the value). */
  id: string;
  level: SettingsLevel;
  config: vscode.WorkspaceConfiguration;
  target: vscode.ConfigurationTarget;
  overrideInLanguage: boolean;
  value: unknown;
  precedence: number;
};

let deviceSecretQueue: Promise<unknown> = Promise.resolve();

function deviceSecretKeys(hostKind: string): { identity: string; tokens: string } {
  return { identity: `${DEVICE_IDENTITY_SECRET_KEY}.${hostKind}`, tokens: `${DEVICE_TOKENS_SECRET_KEY}.${hostKind}` };
}

function secretCall<T>(call: Thenable<T>): Promise<T> {
  return withTimeout(Promise.resolve(call), SECRET_CALL_TIMEOUT_MS, 'SecretStorage did not answer');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type PersistedIdentity = { pem: string; identity: DeviceIdentity };

/** Device secrets are read-modify-written by every connect; one queue keeps the writes whole. */
function serializeDeviceSecrets<T>(task: () => Promise<T>): Promise<T> {
  const run = deviceSecretQueue.then(task);
  deviceSecretQueue = run.catch(() => undefined);
  return run;
}

type DeviceTokenMap = Record<string, StoredDeviceToken>;

function parseDeviceTokens(json: string | undefined): DeviceTokenMap {
  try {
    const parsed: unknown = JSON.parse(json ?? '{}');
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, token]) => isStoredDeviceToken(token))) as DeviceTokenMap;
  } catch {
    return {};
  }
}

/**
 * One host kind's device identity and its tokens in SecretStorage. The
 * identity is created on first use and cached; a change made elsewhere (the
 * reset command, another window) is reported to `onDidChangeIdentity`
 * listeners, a write made here is not. Every call is time-bounded, and only
 * writes are queued.
 */
export class SecretDeviceCredentialStore implements DeviceCredentialStore, vscode.Disposable {
  private identity: Promise<DeviceIdentity> | null = null;
  /** The persisted key as last read or written here. */
  private knownIdentity: string | undefined;
  private readonly identityListeners = new Set<() => void>();
  private readonly subscription: vscode.Disposable;
  private readonly keys: { identity: string; tokens: string };

  constructor(
    private readonly secrets: vscode.SecretStorage,
    hostKind = GatewayConfigService.deviceHostKind()
  ) {
    this.keys = deviceSecretKeys(hostKind);
    this.subscription = secrets.onDidChange((event) => {
      if (event.key !== this.keys.identity) return;
      this.noticeIdentityChange().catch((err: unknown) => {
        log.warn(`reading the gateway device identity failed: ${errorMessage(err)}`);
      });
    });
  }

  loadIdentity(): Promise<DeviceIdentity> {
    if (!this.identity) {
      const loading = this.readOrCreateIdentity();
      // A failed or timed-out read is retried by the next connect.
      loading.catch(() => {
        if (this.identity === loading) this.identity = null;
      });
      this.identity = loading;
    }
    return this.identity;
  }

  onDidChangeIdentity(listener: () => void): vscode.Disposable {
    this.identityListeners.add(listener);
    return { dispose: () => this.identityListeners.delete(listener) };
  }

  async loadToken(gateway: string, deviceId: string): Promise<StoredDeviceToken | null> {
    const token = parseDeviceTokens(await secretCall(this.secrets.get(this.keys.tokens)))[gateway];
    return token?.deviceId === deviceId ? token : null;
  }

  /** A token issued to a device that is no longer the stored one (reset meanwhile) is dropped. */
  storeToken(gateway: string, token: StoredDeviceToken): Promise<void> {
    return serializeDeviceSecrets(async () => {
      const current = await this.readIdentity();
      if (current?.identity.deviceId !== token.deviceId) {
        log.info('dropping a gateway device token issued to a device identity that was replaced');
        return;
      }
      await this.writeTokens((tokens) => ({ ...tokens, [gateway]: token }));
    });
  }

  clearToken(gateway: string, deviceId: string): Promise<void> {
    return serializeDeviceSecrets(() =>
      this.writeTokens((tokens) =>
        tokens[gateway]?.deviceId === deviceId ? Object.fromEntries(Object.entries(tokens).filter(([key]) => key !== gateway)) : tokens
      )
    );
  }

  dispose(): void {
    this.subscription.dispose();
    this.identityListeners.clear();
  }

  private async readIdentity(): Promise<PersistedIdentity | null> {
    const pem = await secretCall(this.secrets.get(this.keys.identity));
    const identity = pem ? importDeviceIdentity(pem) : null;
    return pem && identity ? { pem, identity } : null;
  }

  private async readOrCreateIdentity(): Promise<DeviceIdentity> {
    const stored = await this.readIdentity();
    if (stored) {
      return this.adopt(stored);
    }
    return serializeDeviceSecrets(() => this.createIdentity());
  }

  /** Mint a key only if the slot is still empty after a short random wait, then adopt whatever is
   *  stored: of windows racing to fill the slot, the last write wins for all of them. */
  private async createIdentity(): Promise<DeviceIdentity> {
    await delay(Math.random() * IDENTITY_CREATE_JITTER_MS);
    const raced = await this.readIdentity();
    if (raced) {
      return this.adopt(raced);
    }
    const created = generateDeviceIdentity();
    const pem = exportDeviceIdentity(created);
    this.knownIdentity = pem;
    await secretCall(this.secrets.store(this.keys.identity, pem));
    return this.adopt((await this.readIdentity()) ?? { pem, identity: created });
  }

  private adopt({ pem, identity }: PersistedIdentity): DeviceIdentity {
    this.knownIdentity = pem;
    return identity;
  }

  /** Reads the slot as it is now, so windows hearing a burst of changes all settle on the last write. */
  private async noticeIdentityChange(): Promise<void> {
    const current = await secretCall(this.secrets.get(this.keys.identity));
    if (current === this.knownIdentity) {
      return;
    }
    this.knownIdentity = current;
    this.identity = null;
    for (const listener of [...this.identityListeners]) listener();
  }

  private async writeTokens(update: (tokens: DeviceTokenMap) => DeviceTokenMap): Promise<void> {
    const tokens = update(parseDeviceTokens(await secretCall(this.secrets.get(this.keys.tokens))));
    await secretCall(this.secrets.store(this.keys.tokens, JSON.stringify(tokens)));
  }
}

/** Backward-compatible delegates over {@link GatewayConfigService}. */
export const getGatewaySettings = GatewayConfigService.getGatewaySettings;
export const isValidGatewayUrl = GatewayConfigService.isValidGatewayUrl;
export const sendsTokenInCleartext = GatewayConfigService.sendsTokenInCleartext;
export const isLoopbackGatewayUrl = GatewayConfigService.isLoopbackGatewayUrl;
export const resetDeviceIdentity = GatewayConfigService.resetDeviceIdentity;
export const deviceHostKind = GatewayConfigService.deviceHostKind;
export const getGatewayToken = GatewayConfigService.getGatewayToken;
export const setGatewayToken = GatewayConfigService.setGatewayToken;
export const migrateLegacyGatewayToken = GatewayConfigService.migrateLegacyGatewayToken;
export const promptForGatewayToken = GatewayConfigService.promptForGatewayToken;
