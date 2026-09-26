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
  const legacy =
    inspection?.globalValue ?? inspection?.workspaceValue ?? inspection?.workspaceFolderValue;
  if (!legacy) {
    return false;
  }
  const existing = await getGatewayToken(context.secrets);
  if (!existing && legacy) {
    await setGatewayToken(context.secrets, legacy);
  }
  for (const target of [
    vscode.ConfigurationTarget.Global,
    vscode.ConfigurationTarget.Workspace,
    vscode.ConfigurationTarget.WorkspaceFolder,
  ]) {
    await config.update(LEGACY_GATEWAY_TOKEN_SETTING, undefined, target);
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
