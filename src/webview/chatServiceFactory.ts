/**
 * Claw Code — chat transport factory (DI seam).
 *
 * Resolves the chat backend per `openclaw.gateway.transport`:
 * - `acpx`: local CLI transport (legacy ChatService).
 * - `gateway`: GatewayChatService over the WS RPC.
 * - `auto`: gateway when reachable within a short timeout, else acpx.
 *
 * The gateway client is cached and shared across threads; the acpx service
 * is created per thread by the provider as before.
 */

import * as vscode from 'vscode';
import { ChatService } from '../chat/ChatService';
import { GatewayChatService } from '../core/gatewayChatService';
import { GatewayConnectError } from '../core/gatewayHandshake';
import {
  getGatewaySettings,
  getGatewayToken,
  isValidGatewayUrl,
  migrateLegacyGatewayToken,
  sendsTokenInCleartext,
  LegacyTokenMigrationResult,
} from '../core/gatewayConfig';
import { log } from './viewMessaging';

/** Why the shared gateway client is about to drop its runs. */
export type GatewayInvalidationReason = 'identity' | 'transport';

/** What the current settings ask for, before any connect. */
type TransportPlan =
  | { kind: 'acpx' }
  | { kind: 'offline'; url: string }
  | { kind: 'connect'; url: string; token: string; transport: 'gateway' | 'auto' };

/** Resolved backend for one send. */
export type TransportChoice = {
  service: ChatService | GatewayChatService;
  transport: 'gateway' | 'acpx';
};

/** Connection probe timeout for `auto` fallback decisions. */
const CONNECT_TIMEOUT_MS = 4000;

/** Longest a send waits for SecretStorage: a hung keyring counts as a failed read. */
const TOKEN_READ_TIMEOUT_MS = 5000;

/** Longest a send waits for the legacy-token migration: a keyring that hangs
 *  (e.g. waiting on an unlock prompt) must not stall every send. */
const MIGRATION_WAIT_MS = 5000;

/**
 * Factory that resolves the chat backend with an acpx fallback. Never logs
 * tokens; status updates go through the provided callback.
 */
export class ChatServiceFactory {
  private gatewayService: GatewayChatService | null = null;
  private cachedUrl = '';
  private cachedToken = '';
  /** Completes once legacy-token migration has finished: gateway resolution
   *  waits for it so a valid legacy token is never mistaken for a missing one. */
  private migrationDone: Promise<void> | null = null;
  /** A migration one send already gave up waiting for: later sends skip the wait. */
  private abandonedMigration: Promise<void> | null = null;
  /** Suspended clients hold no runs, so switching away again must not
   *  re-invalidate threads on every acpx send. */
  private gatewaySuspended = false;
  private readonly cleartextWarnedUrls = new Set<string>();

  private readonly rejectionWarnings = new Set<string>();
  private readonly listeners: vscode.Disposable[];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onStatus?: (transport: 'gateway' | 'acpx', connected: boolean) => void,
    private readonly onGatewayInvalidated?: (reason: GatewayInvalidationReason) => void
  ) {
    this.listeners = [
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('openclaw.gateway')) void this.reconcile();
      }),
      context.secrets.onDidChange(() => void this.reconcile()),
    ];
  }

  /** Await one-shot legacy-token migration before any token-dependent
   *  resolution. An incomplete migration (plaintext token still on disk)
   *  is not cached: the next resolve() retries it, so the SecretStorage-only
   *  state is eventually restored without blocking the current call. */
  private async waitForMigration(): Promise<void> {
    const migration = this.ensureMigrated();
    if (migration === this.abandonedMigration) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), MIGRATION_WAIT_MS);
    });
    const outcome = await Promise.race([migration, timedOut]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      this.abandonedMigration = migration;
      log.warn('legacy gateway token migration is still running; resolving without waiting for it');
    }
  }

  private ensureMigrated(): Promise<void> {
    if (!this.migrationDone) {
      this.migrationDone = migrateLegacyGatewayToken(this.context)
        .then((result: LegacyTokenMigrationResult) => {
          if (result === 'incomplete') {
            this.migrationDone = null;
          }
          return undefined;
        })
        .catch((err: Error) => {
          log.warn(`legacy gateway token migration failed ${err.message}`);
          this.migrationDone = null;
        });
    }
    return this.migrationDone!;
  }

  /**
   * Resolve the backend for the current settings. `auto` falls back to acpx
   * on an invalid URL, a missing or unreadable token, or a failed connect;
   * forced `gateway` mode throws for an invalid URL or unreadable token.
   *
   * Switching to acpx, or a token that was used and is now gone, suspends
   * the shared gateway client so an authenticated socket stops receiving
   * transcript events. The instance stays cached, so a later gateway
   * resolution resumes it without severing threads' lifecycle references.
   * A per-send fallback for a token that never existed, or that could not be
   * read, leaves the client alone: other threads' gateway runs keep streaming.
   */
  async resolve(existing?: ChatService | GatewayChatService): Promise<TransportChoice> {
    await this.waitForMigration();
    const plan = await this.planTransport();
    if (plan.kind === 'acpx') {
      this.onStatus?.('acpx', true);
      return { service: this.reuseOrCreateAcpx(existing), transport: 'acpx' };
    }
    if (plan.kind === 'offline') {
      this.onStatus?.('gateway', false);
      return { service: this.parkedGateway(plan.url), transport: 'gateway' };
    }
    this.warnIfCleartext(plan.url);
    const gateway = this.getOrCreateGateway(plan.url, plan.token);
    // connect() lifts the client's suspension, even when it then fails.
    this.gatewaySuspended = false;
    try {
      await this.withTimeout(gateway.connect(), CONNECT_TIMEOUT_MS);
      this.onStatus?.('gateway', true);
      return { service: gateway, transport: 'gateway' };
    } catch (err) {
      this.warnIfRejected(err, plan.url);
      log.warn(`gateway connect failed; ${plan.transport === 'auto' ? 'falling back to acpx' : 'continuing without gateway'}`);
      if (plan.transport === 'auto') {
        // Keep the shared client cached instead of disposing it: this client
        // is shared by every thread, so closing it here would sever other
        // chats' connections and retire their session sinks on a transient
        // per-send probe failure. It retries via its own reconnect path, so
        // a later thread can still reach the gateway.
        this.onStatus?.('acpx', true);
        return { service: this.reuseOrCreateAcpx(existing), transport: 'acpx' };
      }
      this.onStatus?.('gateway', false);
      return { service: gateway, transport: 'gateway' };
    }
  }

  /**
   * Apply a settings or SecretStorage change to the cached gateway client
   * without connecting: a switched-away or revoked client must drop its
   * socket now, not at the next send, and new credentials replace the old
   * ones in place. Connecting stays with resolve().
   */
  async reconcile(): Promise<void> {
    if (!this.gatewayService) {
      return;
    }
    await this.waitForMigration();
    try {
      const plan = await this.planTransport();
      if (plan.kind === 'connect') {
        this.getOrCreateGateway(plan.url, plan.token);
      }
    } catch (err) {
      log.warn(`gateway settings change could not be applied: ${(err as Error).message}`);
    }
  }

  /**
   * The decision resolve() and reconcile() share, with its suspensions
   * applied: acpx, an offline gateway (forced mode without a token), or a
   * gateway to connect. Throws where forced gateway mode cannot proceed.
   */
  private async planTransport(): Promise<TransportPlan> {
    const settings = getGatewaySettings();
    if (settings.transport === 'acpx') {
      this.suspendGateway('transport');
      return { kind: 'acpx' };
    }
    if (!isValidGatewayUrl(settings.url)) {
      // The cached client still holds the previous, valid endpoint's socket.
      this.suspendGateway('identity');
      return this.gatewayUnavailable(settings.transport, 'openclaw.gateway.url must be a ws:// or wss:// URL.');
    }
    const token = await this.readToken();
    if (token === null) {
      // A failed read says nothing about the token: live runs keep their client.
      return this.gatewayUnavailable(settings.transport, 'Could not read the gateway token from SecretStorage.');
    }
    if (!token) {
      // A token that was used and is now gone is a deliberate revocation: the
      // client may still hold an authenticated socket.
      if (this.cachedToken) {
        this.suspendGateway('identity');
      }
      return settings.transport === 'gateway' ? { kind: 'offline', url: settings.url } : { kind: 'acpx' };
    }
    return { kind: 'connect', url: settings.url, token, transport: settings.transport };
  }

  private gatewayUnavailable(transport: 'gateway' | 'auto', message: string): TransportPlan {
    if (transport === 'gateway') {
      this.onStatus?.('gateway', false);
      throw new Error(message);
    }
    return { kind: 'acpx' };
  }

  /** The client for forced gateway mode without a token: parked, never reconnecting tokenless. */
  private parkedGateway(url: string): GatewayChatService {
    if (!this.gatewayService) {
      this.gatewayService = this.createGateway(url, '');
      this.cachedUrl = url;
      this.gatewaySuspended = true;
    }
    return this.gatewayService;
  }

  /** Suspended clients hold no runs, so switching away again must not re-invalidate threads. */
  private suspendGateway(reason: GatewayInvalidationReason): void {
    if (!this.gatewayService || this.gatewaySuspended) {
      return;
    }
    this.onGatewayInvalidated?.(reason);
    this.gatewayService.suspend();
    this.gatewaySuspended = true;
  }

  /** The stored token, '' when none is set, or null when SecretStorage failed or hung. */
  private async readToken(): Promise<string | null> {
    try {
      const token = await this.withTimeout(getGatewayToken(this.context.secrets), TOKEN_READ_TIMEOUT_MS, 'token read timeout');
      return token;
    } catch (err) {
      log.warn(`reading the gateway token from SecretStorage failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Reuse the thread's live acpx service when present so the legacy
   *  single-run lifecycle (abort/cancel reaching the original process)
   *  survives multiple sends; otherwise create a fresh one. */
  private reuseOrCreateAcpx(existing?: ChatService | GatewayChatService): ChatService {
    return existing instanceof ChatService ? existing : new ChatService();
  }

  /** A rejection that retrying cannot fix is shown once per code and endpoint. */
  private warnIfRejected(err: unknown, url: string): void {
    if (!(err instanceof GatewayConnectError) || err.rejection.kind === 'backoff') {
      return;
    }
    const key = `${err.rejection.code}|${url}`;
    if (this.rejectionWarnings.has(key)) {
      return;
    }
    this.rejectionWarnings.add(key);
    void vscode.window.showWarningMessage(`OpenClaw: ${err.rejection.hint} (${err.rejection.code})`);
  }

  private warnIfCleartext(url: string): void {
    if (!sendsTokenInCleartext(url) || this.cleartextWarnedUrls.has(url)) {
      return;
    }
    this.cleartextWarnedUrls.add(url);
    void vscode.window.showWarningMessage(
      `OpenClaw: the gateway token is sent unencrypted to ${new URL(url).host}. Use wss:// for a remote gateway.`
    );
  }

  /** Dispose the cached gateway client and the settings listeners (provider teardown). */
  dispose(): void {
    for (const listener of this.listeners) listener.dispose();
    this.gatewayService?.dispose();
    this.gatewayService = null;
    this.cachedUrl = '';
    this.cachedToken = '';
  }

  private createGateway(url: string, token: string): GatewayChatService {
    const gateway = new GatewayChatService({ url, token });
    gateway.onConnectionStateChange((connected) => {
      // A parked client's socket drop is expected; the badge follows the active transport.
      if (!this.gatewaySuspended) {
        this.onStatus?.('gateway', connected);
      }
    });
    return gateway;
  }

  private getOrCreateGateway(url: string, token: string): GatewayChatService {
    if (!this.gatewayService) {
      this.gatewayService = this.createGateway(url, token);
      this.gatewaySuspended = false;
    } else if (this.cachedUrl !== url || this.cachedToken !== token) {
      // Update credentials in place: threads keep a reference to this
      // instance for lifecycle actions, so dispose-and-recreate would sever
      // in-flight runs on url/token change.
      // The provider must invalidate its gateway runs BEFORE the swap:
      // updateConnection retires every transcript/run sink synchronously with
      // a synthetic `done`, and without a prior epoch bump that done would be
      // accepted as the real completion — the thread would finalize as
      // `complete` and the pending send would be silently abandoned instead
      // of being reported as interrupted.
      this.onGatewayInvalidated?.('identity');
      // A suspended client stays parked (no socket, no reconnect) until resolve() calls connect().
      this.gatewayService.updateConnection(url, token);
    }
    this.cachedUrl = url;
    this.cachedToken = token;
    return this.gatewayService;
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage = 'gateway connect timeout'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: Error) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }
}
