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
import * as os from 'os';
import * as path from 'path';
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
    const url = config.get<string>('gateway.url')?.trim() || 'ws://127.0.0.1:18789';
    const rawTransport = config.get<string>('gateway.transport') ?? 'auto';
    const transport: GatewayTransport =
      rawTransport === 'gateway' || rawTransport === 'acpx' ? rawTransport : 'auto';
    return { url, transport };
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
   * One-time migration: if a legacy plaintext `openclaw.gateway.token`
   * setting exists, move it into SecretStorage and clear the plaintext
   * setting. Never overwrites an existing SecretStorage token with an empty
   * legacy value; a non-empty legacy value wins only when no secret exists.
   * Returns `completed` after a successful migration, `noop` when no legacy
   * value exists anywhere (a finished no-op that callers may cache), and
   * `incomplete` when a scope cleanup failed so callers can retry later.
   */
  static async migrateLegacyGatewayToken(
    context: vscode.ExtensionContext
  ): Promise<LegacyTokenMigrationResult> {
    const config = vscode.workspace.getConfiguration('openclaw');
    const inspection = config.inspect<string>(LEGACY_GATEWAY_TOKEN_SETTING);
    const languageOverrides = await GatewayConfigService.discoverLanguageOverrides();
    // Selection must follow VS Code's effective precedence (most specific
    // first): language-scoped values override plain values at the same
    // level, and narrower scopes win. Otherwise a `[typescript]` override
    // holding token B could be ignored in favor of an unrelated global
    // token A, storing the wrong credential before cleanup removes both.
    const nonEmptyScopes = [
      inspection?.workspaceFolderLanguageValue,
      inspection?.workspaceFolderValue,
      inspection?.workspaceLanguageValue,
      inspection?.workspaceValue,
      inspection?.globalLanguageValue,
      inspection?.globalValue,
      ...languageOverrides.flatMap((entry) =>
        entry.folderUri !== undefined
          ? [
              entry.inspection?.workspaceFolderLanguageValue,
              entry.inspection?.workspaceFolderValue,
              entry.inspection?.workspaceLanguageValue,
              entry.inspection?.globalLanguageValue,
            ]
          : [
              entry.inspection?.workspaceLanguageValue,
              entry.inspection?.globalLanguageValue,
            ]
      ),
    ] as (string | undefined)[];
    const nonEmpty = nonEmptyScopes.find((v) => typeof v === 'string' && v) ?? '';
    const legacyDefined = nonEmptyScopes.some((v) => v !== undefined);
    if (!legacyDefined) {
      return 'noop';
    }
    const existing = await GatewayConfigService.getGatewayToken(context.secrets);
    if (!existing && nonEmpty) {
      await GatewayConfigService.setGatewayToken(context.secrets, nonEmpty);
    }
    let cleanupFailed = false;
    for (const target of [
      vscode.ConfigurationTarget.Global,
      vscode.ConfigurationTarget.Workspace,
      vscode.ConfigurationTarget.WorkspaceFolder,
    ]) {
      const hadValue =
        inspection != null &&
        ((target === vscode.ConfigurationTarget.Global &&
          (inspection.globalValue !== undefined || inspection.globalLanguageValue !== undefined)) ||
          (target === vscode.ConfigurationTarget.Workspace &&
            (inspection.workspaceValue !== undefined || inspection.workspaceLanguageValue !== undefined)) ||
          (target === vscode.ConfigurationTarget.WorkspaceFolder &&
            (inspection.workspaceFolderValue !== undefined ||
              inspection.workspaceFolderLanguageValue !== undefined)));
      if (!hadValue) {
        continue;
      }
      try {
        const hasNormal =
          inspection != null &&
          ((target === vscode.ConfigurationTarget.Global && inspection.globalValue !== undefined) ||
            (target === vscode.ConfigurationTarget.Workspace && inspection.workspaceValue !== undefined) ||
            (target === vscode.ConfigurationTarget.WorkspaceFolder &&
              inspection.workspaceFolderValue !== undefined));
        const hasLanguage =
          inspection != null &&
          ((target === vscode.ConfigurationTarget.Global && inspection.globalLanguageValue !== undefined) ||
            (target === vscode.ConfigurationTarget.Workspace && inspection.workspaceLanguageValue !== undefined) ||
            (target === vscode.ConfigurationTarget.WorkspaceFolder &&
              inspection.workspaceFolderLanguageValue !== undefined));
        if (hasNormal) {
          await config.update(LEGACY_GATEWAY_TOKEN_SETTING, undefined, target);
        }
        if (hasLanguage) {
          await config.update(LEGACY_GATEWAY_TOKEN_SETTING, undefined, target, true);
        }
      } catch (err) {
        cleanupFailed = true;
        log.warn(
          `legacy token cleanup failed for target ${target}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
    const cleanedFolderNormals = new Set<string>();
    for (const entry of languageOverrides) {
      if (
        entry.folderUri !== undefined &&
        entry.inspection?.workspaceFolderValue !== undefined &&
        !cleanedFolderNormals.has(entry.folderUri.toString())
      ) {
        cleanedFolderNormals.add(entry.folderUri.toString());
        try {
          await entry.config.update(
            LEGACY_GATEWAY_TOKEN_SETTING,
            undefined,
            vscode.ConfigurationTarget.WorkspaceFolder
          );
        } catch (err) {
          cleanupFailed = true;
          log.warn(
            `legacy token cleanup failed for folder target: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
      const hadLanguageValue =
        entry.inspection?.globalLanguageValue !== undefined ||
        entry.inspection?.workspaceLanguageValue !== undefined ||
        (entry.folderUri !== undefined &&
          entry.inspection?.workspaceFolderLanguageValue !== undefined);
      if (!hadLanguageValue) {
        continue;
      }
      for (const target of [
        vscode.ConfigurationTarget.Global,
        vscode.ConfigurationTarget.Workspace,
        vscode.ConfigurationTarget.WorkspaceFolder,
      ]) {
        if (target === vscode.ConfigurationTarget.WorkspaceFolder && entry.folderUri === undefined) {
          continue;
        }
        try {
          await entry.config.update(LEGACY_GATEWAY_TOKEN_SETTING, undefined, target, true);
        } catch (err) {
          cleanupFailed = true;
          log.warn(
            `legacy token cleanup failed for language "${entry.languageId}" target ${target}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    }
    if (cleanupFailed) {
      void vscode.window.showWarningMessage(
        'Legacy plaintext gateway token could not be removed from settings. ' +
        'Delete `openclaw.gateway.token` from settings.json manually.'
      );
      return 'incomplete';
    }
    return 'completed';
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
    await GatewayConfigService.setGatewayToken(context.secrets, value.trim());
    void vscode.window.showInformationMessage(
      value.trim() ? 'Gateway token saved to SecretStorage.' : 'Gateway token cleared.'
    );
    return true;
  }

/** List language overrides configured via `[language]` sections in the raw
 *  settings.json files of the workspace folders and workspace file.
 *
 *  VS Code's `inspect()` exposes language-scoped fields only for the
 *  language of the inspected context, so a plaintext token hidden under
 *  another language's override stays invisible to the normal inspection.
 *  The configured languages must be discovered from disk and inspected per
 *  language ({@link vscode.ConfigurationScope} supports a bare `languageId`)
 *  so migration covers every override. */
/** User-level settings.json locations across VS Code distributions: a
 *  plaintext token hidden under a `[language]` override in the global
 *  settings file must be discovered too, not only workspace-level ones.
 *  Insiders and VSCodium ship separate `User` directories from stable, but
 *  only the running distribution's settings file is probed: cleanup writes
 *  through the Configuration API, which cannot touch other products' files. */
private static userSettingsUris(): vscode.Uri[] {
  const roots: string[] = [];
  if (process.platform === 'win32') {
    if (process.env.APPDATA) {
      roots.push(path.join(process.env.APPDATA));
    }
  } else if (process.platform === 'darwin') {
    // VS Code on macOS reads the user settings from the Application
    // Support root only; XDG paths are never consulted, so probing them
    // would find plaintext tokens the Configuration API can never clean up
    // (Global writes affect only the running product's actual root).
    roots.push(path.join(os.homedir(), 'Library', 'Application Support'));
  } else {
    roots.push(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  }
  const distros = [GatewayConfigService.currentDistroDir()];
  return roots.flatMap((root) =>
    distros
      .filter((d): d is string => d !== null)
      .map((d) => vscode.Uri.file(path.join(root, d, 'User', 'settings.json')))
  );
}

/** Resolve the settings directory of the distribution this extension runs
 *  in. `config.update` with a Global target writes only the running
 *  product's user settings, so discovering overrides from other
 *  distributions' files (Insiders, OSS, VSCodium) would find plaintext
 *  tokens the Configuration API can never clean up — migration must probe
 *  only settings the current product can actually update. */
private static currentDistroDir(): string | null {
  const scheme = vscode.env.uriScheme ?? 'vscode';
  if (scheme === 'vscode-insiders') {
    return 'Code - Insiders';
  }
  if (scheme === 'vscode-vscodium') {
    return 'VSCodium';
  }
  // The 'vscode' scheme covers both stable VS Code and Code - OSS builds.
  return /\boss\b/i.test(vscode.env.appName ?? '') ? 'Code - OSS' : 'Code';
}

/** Collect the language ids addressed by `[language]` override keys.
 *  Chained keys such as `[typescript][javascript]` must be split into
 *  their individual bracket groups: VS Code indexes a chained override
 *  under each of its identifiers (`overrideIdentifiersFromKey`), so a
 *  configuration scope built from the raw inner text would match no
 *  override at all and a legacy token stored under the chained key would
 *  stay invisible to inspection and cleanup. */
private static collectLanguageIds(parsed: Record<string, unknown>, into: Set<string>): void {
  for (const key of Object.keys(parsed)) {
    const match = key.trim().match(/\[([^\]]+)\]/g);
    if (match && typeof parsed[key] === 'object' && parsed[key] !== null) {
      for (const group of match) {
        const languageId = group.slice(1, -1).trim();
        if (languageId) {
          into.add(languageId);
        }
      }
    }
  }
}

private static async discoverLanguageOverrides(): Promise<LanguageOverride[]> {
  const sources: { uri: vscode.Uri; folderUri: vscode.Uri | undefined }[] = [];
  for (const uri of GatewayConfigService.userSettingsUris()) {
    sources.push({ uri, folderUri: undefined });
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    sources.push({
      uri: vscode.Uri.joinPath(folder.uri, '.vscode', 'settings.json'),
      folderUri: folder.uri,
    });
  }
  if (vscode.workspace.workspaceFile) {
    sources.push({ uri: vscode.workspace.workspaceFile, folderUri: undefined });
  }
  // The same language may be overridden in several files and folders; each
  // (language, source file, folder) triple gets its own entry so cleanup
  // reaches every distribution's user settings and every folder.
  const seen = new Set<string>();
  const overrides: LanguageOverride[] = [];
  for (const source of sources) {
    const languageIds = new Set<string>();
    try {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(source.uri));
      const parsed = JSON.parse(GatewayConfigService.stripJsonc(text)) as Record<string, unknown>;
      GatewayConfigService.collectLanguageIds(parsed, languageIds);
      // .code-workspace files store their settings under a nested
      // `settings` object; overrides there must be discovered as well.
      if (typeof parsed.settings === 'object' && parsed.settings !== null) {
        GatewayConfigService.collectLanguageIds(parsed.settings as Record<string, unknown>, languageIds);
      }
    } catch {
      // Missing or unreadable settings files hold no discoverable overrides.
    }
    for (const languageId of languageIds) {
      const key = `${languageId}|${source.uri.toString()}|${
        source.folderUri ? source.folderUri.toString() : ''
      }`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      // vscode.ConfigurationScope for a language-plus-resource scope uses
      // a `uri` field, not `folderUri`: the uri must point into the owning
      // folder so inspect/update reach that folder's language values. The
      // `{ uri, languageId }` object is a valid ConfigurationScope in the
      // declared typings, so no cast is needed.
      const scope: vscode.ConfigurationScope = source.folderUri
        ? { languageId, uri: source.folderUri }
        : { languageId };
      const config = vscode.workspace.getConfiguration('openclaw', scope);
      overrides.push({
        languageId,
        folderUri: source.folderUri,
        config,
        inspection: config.inspect<string>(LEGACY_GATEWAY_TOKEN_SETTING),
      });
    }
  }
  return overrides;
}

  /**
   * Strip JSONC comments and trailing commas from a settings.json payload so
   * the result parses with JSON.parse: line and block comments outside
   * strings are removed, and a comma directly before a closing brace or
   * bracket is dropped.
   */
  private static stripJsonc(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length) {
        if (/\s/.test(text[j])) {
          j++;
        } else if (text[j] === '/' && text[j + 1] === '/') {
          while (j < text.length && text[j] !== '\n') j++;
        } else if (text[j] === '/' && text[j + 1] === '*') {
          j += 2;
          while (j < text.length && !(text[j] === '*' && text[j + 1] === '/')) j++;
          j += 2;
        } else {
          break;
        }
      }
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += ch;
  }
  return out;
  }
}

/** A language override discovered on disk, with a scoped configuration for
 *  inspecting and clearing that language's settings. Folder-level sources
 *  keep the owning folder's URI so `WorkspaceFolder` updates clear the
 *  folder that actually holds the value — a multi-root workspace must not
 *  write an unscoped update that only touches the first folder. */
type LanguageOverride = {
  languageId: string;
  config: vscode.WorkspaceConfiguration;
  /** Owning workspace folder for folder-level sources; undefined for user
   *  settings and the workspace file, which have no folder scope. */
  folderUri: vscode.Uri | undefined;
  inspection:
    | {
        globalLanguageValue?: string;
        workspaceLanguageValue?: string;
        workspaceFolderLanguageValue?: string;
        /** Normal (non-language) folder value, present only for folder-
         *  scoped entries; the unscoped inspection covers just the first
         *  folder of a multi-root workspace. */
        workspaceFolderValue?: string;
      }
    | undefined;
};

/** Backward-compatible delegates over {@link GatewayConfigService}. */
export const getGatewaySettings = GatewayConfigService.getGatewaySettings;
export const getGatewayToken = GatewayConfigService.getGatewayToken;
export const setGatewayToken = GatewayConfigService.setGatewayToken;
export const migrateLegacyGatewayToken = GatewayConfigService.migrateLegacyGatewayToken;
export const promptForGatewayToken = GatewayConfigService.promptForGatewayToken;
