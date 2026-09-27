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

/**
 * Read gateway settings from workspace configuration with defaults
 * (`ws://127.0.0.1:18789` and transport `auto`).
 */
export function getGatewaySettings(): GatewaySettings {
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
export async function getGatewayToken(secrets: vscode.SecretStorage): Promise<string> {
  const token = await secrets.get(GATEWAY_TOKEN_SECRET_KEY);
  return typeof token === 'string' ? token : '';
}

/**
 * Store the gateway token in SecretStorage.
 * An empty value clears the stored token.
 */
export async function setGatewayToken(secrets: vscode.SecretStorage, token: string): Promise<void> {
  if (token) {
    await secrets.store(GATEWAY_TOKEN_SECRET_KEY, token);
  } else {
    await secrets.delete(GATEWAY_TOKEN_SECRET_KEY);
  }
}

/** Strip JSONC comments and trailing commas from a settings.json payload so
 *  the result parses with JSON.parse: line and block comments outside
 *  strings are removed, and a comma directly before a closing brace or
 *  bracket is dropped. */
function stripJsonc(text: string): string {
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
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

/** A language override discovered on disk, with a scoped configuration for
 *  inspecting and clearing that language's settings. */
type LanguageOverride = {
  languageId: string;
  config: vscode.WorkspaceConfiguration;
  inspection:
    | {
        globalLanguageValue?: string;
        workspaceLanguageValue?: string;
        workspaceFolderLanguageValue?: string;
      }
    | undefined;
};

/** List language overrides configured via `[language]` sections in the raw
 *  settings.json files of the workspace folders and workspace file.
 *
 *  VS Code's `inspect()` exposes language-scoped fields only for the
 *  language of the inspected context, so a plaintext token hidden under
 *  another language's override stays invisible to the normal inspection.
 *  The configured languages must be discovered from disk and inspected per
 *  language ({@link vscode.ConfigurationScope} supports a bare `languageId`)
 *  so migration covers every override. */
async function discoverLanguageOverrides(): Promise<LanguageOverride[]> {
  const uris: vscode.Uri[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    uris.push(vscode.Uri.joinPath(folder.uri, '.vscode', 'settings.json'));
  }
  if (vscode.workspace.workspaceFile) {
    uris.push(vscode.workspace.workspaceFile);
  }
  const languageIds = new Set<string>();
  for (const uri of uris) {
    try {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      const parsed = JSON.parse(stripJsonc(text)) as Record<string, unknown>;
      for (const key of Object.keys(parsed)) {
        const match = /^\[(.+)\]$/.exec(key.trim());
        if (match && typeof parsed[key] === 'object' && parsed[key] !== null) {
          languageIds.add(match[1]);
        }
      }
    } catch {
      // Missing or unreadable settings files hold no discoverable overrides.
    }
  }
  return [...languageIds].map((languageId) => {
    const config = vscode.workspace.getConfiguration('openclaw', {
      languageId,
    } as vscode.ConfigurationScope);
    return { languageId, config, inspection: config.inspect<string>(LEGACY_GATEWAY_TOKEN_SETTING) };
  });
}

/**
 * One-time migration: if a legacy plaintext `openclaw.gateway.token`
 * setting exists, move it into SecretStorage and clear the plaintext
 * setting. Never overwrites an existing SecretStorage token with an empty
 * legacy value; a non-empty legacy value wins only when no secret exists.
 */
export async function migrateLegacyGatewayToken(
  context: vscode.ExtensionContext
): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('openclaw');
  const inspection = config.inspect<string>(LEGACY_GATEWAY_TOKEN_SETTING);
  // VS Code stores language-scoped values (`[lang]` overrides), and `inspect`
  // only exposes the language fields for the inspected context's language:
  // a legacy token hidden under another language's override stays plaintext
  // forever unless every configured language is inspected and cleared too.
  const languageOverrides = await discoverLanguageOverrides();
  // An explicitly empty value in one scope must not shadow a non-empty
  // token in another: pick the first non-empty scoped value, falling back
  // to any defined value only for cleanup bookkeeping.
  const nonEmptyScopes = [
    inspection?.workspaceFolderValue,
    inspection?.workspaceValue,
    inspection?.globalValue,
    inspection?.workspaceFolderLanguageValue,
    inspection?.workspaceLanguageValue,
    inspection?.globalLanguageValue,
    ...languageOverrides.flatMap((entry) => [
      entry.inspection?.workspaceFolderLanguageValue,
      entry.inspection?.workspaceLanguageValue,
      entry.inspection?.globalLanguageValue,
    ]),
  ] as (string | undefined)[];
  const nonEmpty = nonEmptyScopes.find((v) => typeof v === 'string' && v) ?? '';
  const legacyDefined = nonEmptyScopes.some((v) => v !== undefined);
  if (!legacyDefined) {
    return false;
  }
  const existing = await getGatewayToken(context.secrets);
  if (!existing && nonEmpty) {
    await setGatewayToken(context.secrets, nonEmpty);
  }
  let cleanupFailed = false;
  for (const target of [
    vscode.ConfigurationTarget.Global,
    vscode.ConfigurationTarget.Workspace,
    vscode.ConfigurationTarget.WorkspaceFolder,
  ]) {
    // Skip scopes that never held the legacy value, and never let a
    // failing scope write break activation (WorkspaceFolder throws when
    // no folder is open).
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
      // Normal and language-scoped values in the same target are cleaned
      // independently: a single update call removes only one of the two
      // stored forms, leaving the other plaintext token behind.
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
  // Clean every configured language override as well: the loop above covers
  // only the inspected context's language fields, while the discovered
  // overrides may hold the legacy token in any target.
  for (const entry of languageOverrides) {
    const hadLanguageValue =
      entry.inspection?.globalLanguageValue !== undefined ||
      entry.inspection?.workspaceLanguageValue !== undefined ||
      entry.inspection?.workspaceFolderLanguageValue !== undefined;
    if (!hadLanguageValue) {
      continue;
    }
    for (const target of [
      vscode.ConfigurationTarget.Global,
      vscode.ConfigurationTarget.Workspace,
      vscode.ConfigurationTarget.WorkspaceFolder,
    ]) {
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
  // A failed scope write leaves the plaintext token on disk while the
  // caller proceeds as if migration succeeded — the SecretStorage-only
  // guarantee would be silently violated. Report the incomplete state so
  // callers can warn and retry on the next activation.
  if (cleanupFailed) {
    void vscode.window.showWarningMessage(
      'Legacy plaintext gateway token could not be removed from settings. ' +
      'Delete `openclaw.gateway.token` from settings.json manually.'
    );
    return false;
  }
  return true;
}

/**
 * Interactive command handler: prompt for the gateway token (masked input)
 * and store it in SecretStorage. Cancel keeps any previously stored token.
 */
export async function promptForGatewayToken(context: vscode.ExtensionContext): Promise<void> {
  const value = await vscode.window.showInputBox({
    prompt: 'OpenClaw gateway auth token (stored in SecretStorage)',
    password: true,
    placeHolder: 'paste token',
  });
  if (value === undefined) {
    return;
  }
  await setGatewayToken(context.secrets, value.trim());
  void vscode.window.showInformationMessage(
    value.trim() ? 'Gateway token saved to SecretStorage.' : 'Gateway token cleared.'
  );
}
