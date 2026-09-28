/**
 * Claw Code — Gateway settings and token management.
 *
 * Reads the `openclaw.gateway.*` configuration block, manages the gateway
 * auth token in VS Code SecretStorage, and performs a one-time migration of
 * a legacy plaintext `openclaw.gateway.token` setting into SecretStorage.
 *
 * Tokens are never logged and never returned in error messages.
 */

import * as vscode from 'vscode';
import { log } from '../vscode/commands/shared';

/** SecretStorage key under which the gateway token is stored. */
export const GATEWAY_TOKEN_SECRET_KEY = 'openclaw.gateway.token';

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
   * (`ws://127.0.0.1:18789` and transport `auto`).
   */
  static getGatewaySettings(): GatewaySettings {
    const config = vscode.workspace.getConfiguration('openclaw');
    // settings.json is hand-editable, so either value may have any JSON type.
    const rawUrl: unknown = config.get('gateway.url');
    const url = (typeof rawUrl === 'string' ? rawUrl.trim() : '') || 'ws://127.0.0.1:18789';
    const rawTransport: unknown = config.get('gateway.transport');
    const transport: GatewayTransport =
      rawTransport === 'gateway' || rawTransport === 'acpx' ? rawTransport : 'auto';
    return { url, transport };
  }

  /** Whether `url` is a `ws:` or `wss:` URL, without fragment, that the gateway client can open. */
  static isValidGatewayUrl(url: string): boolean {
    return GatewayConfigService.parseUrl(url) !== null;
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
    const sites = GatewayConfigService.findLegacyTokenSites();
    if (sites.length === 0) {
      return 'noop';
    }
    const legacyToken = sites
      .map((site) => (typeof site.value === 'string' ? site.value.trim() : ''))
      .find((value) => value !== '');
    let storedToken: string;
    try {
      storedToken = await GatewayConfigService.getGatewayToken(context.secrets);
      if (legacyToken && !storedToken) {
        await GatewayConfigService.setGatewayToken(context.secrets, legacyToken);
      }
    } catch (err) {
      // The plaintext stays until SecretStorage holds the token: deleting it
      // now would lose the credential.
      log.warn(`legacy token migration could not use SecretStorage: ${err instanceof Error ? err.message : String(err)}`);
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
        log.warn(`legacy token cleanup failed for ${site.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Only a fresh inspection proves the plaintext is gone: a failed update,
    // or a location the Configuration API cannot write (remote user settings,
    // policy), leaves the value in place without throwing.
    if (GatewayConfigService.findLegacyTokenSites().length === 0) {
      if (ignoredDifferentToken) {
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
      config,
      target: SETTINGS_LEVEL_TARGET[level],
      overrideInLanguage: languageId !== undefined,
      value,
      precedence: (languageId !== undefined ? 0 : 3) + SETTINGS_LEVEL_SPECIFICITY[level],
    };
  }
}

type SettingsLevel = 'global' | 'workspace' | 'folder';

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
  config: vscode.WorkspaceConfiguration;
  target: vscode.ConfigurationTarget;
  overrideInLanguage: boolean;
  value: unknown;
  precedence: number;
};

/** Backward-compatible delegates over {@link GatewayConfigService}. */
export const getGatewaySettings = GatewayConfigService.getGatewaySettings;
export const isValidGatewayUrl = GatewayConfigService.isValidGatewayUrl;
export const sendsTokenInCleartext = GatewayConfigService.sendsTokenInCleartext;
export const getGatewayToken = GatewayConfigService.getGatewayToken;
export const setGatewayToken = GatewayConfigService.setGatewayToken;
export const migrateLegacyGatewayToken = GatewayConfigService.migrateLegacyGatewayToken;
export const promptForGatewayToken = GatewayConfigService.promptForGatewayToken;
