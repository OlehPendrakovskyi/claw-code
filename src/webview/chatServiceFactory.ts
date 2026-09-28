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

/** Resolved backend for one send. */
export type TransportChoice = {
  service: ChatService | GatewayChatService;
  transport: 'gateway' | 'acpx';
};

/** Connection probe timeout for `auto` fallback decisions. */
const CONNECT_TIMEOUT_MS = 4000;

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

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onStatus?: (transport: 'gateway' | 'acpx', connected: boolean) => void,
    private readonly onGatewayInvalidated?: (reason: GatewayInvalidationReason) => void
  ) {}

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
   * A per-send fallback for a token that never existed leaves the client
   * alone: other threads' gateway runs keep streaming.
   */
  async resolve(existing?: ChatService | GatewayChatService): Promise<TransportChoice> {
    await this.waitForMigration();
    const settings = getGatewaySettings();
    if (settings.transport === 'acpx') {
      this.suspendGateway('transport');
      this.onStatus?.('acpx', true);
      return { service: this.reuseOrCreateAcpx(existing), transport: 'acpx' };
    }
    if (!isValidGatewayUrl(settings.url)) {
      if (settings.transport === 'gateway') {
        this.onStatus?.('gateway', false);
        throw new Error('openclaw.gateway.url must be a ws:// or wss:// URL.');
      }
      log.warn('openclaw.gateway.url is not a ws:// or wss:// URL; using acpx');
      this.onStatus?.('acpx', true);
      return { service: this.reuseOrCreateAcpx(existing), transport: 'acpx' };
    }
    const token = await this.readToken(settings.transport);
    if (!token) {
      if (settings.transport === 'gateway') {
        this.onStatus?.('gateway', false);
        // Cached via the shared gateway slot: a later token updates this
        // tokenless client in place (credential comparison in
        // getOrCreateGateway), so no per-call instances leak.
        return { service: this.getOrCreateGateway(settings.url, ''), transport: 'gateway' };
      }
      // Missing token in `auto` mode is a per-send fallback that must not
      // retire other threads' live gateway runs. A previously used token
      // that is now gone is a deliberate revocation, though: the cached
      // client may still hold an authenticated socket, so it is suspended.
      if (this.cachedToken) {
        this.suspendGateway('identity');
        this.cachedToken = '';
      }
      this.onStatus?.('acpx', true);
      return { service: this.reuseOrCreateAcpx(existing), transport: 'acpx' };
    }
    this.warnIfCleartext(settings.url);
    const gateway = this.getOrCreateGateway(settings.url, token);
    // connect() lifts the client's suspension, even when it then fails.
    this.gatewaySuspended = false;
    try {
      await this.withTimeout(gateway.connect(), CONNECT_TIMEOUT_MS);
      this.onStatus?.('gateway', true);
      return { service: gateway, transport: 'gateway' };
    } catch {
      log.warn(`gateway connect failed; ${settings.transport === 'auto' ? 'falling back to acpx' : 'continuing without gateway'}`);
      if (settings.transport === 'auto') {
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

  /** Reuse the thread's live acpx service when present so the legacy
   *  single-run lifecycle (abort/cancel reaching the original process)
   *  survives multiple sends; otherwise create a fresh one. */
  private reuseOrCreateAcpx(existing?: ChatService | GatewayChatService): ChatService {
    return existing instanceof ChatService ? existing : new ChatService();
  }

  /** Park the shared gateway client when the resolved transport is no longer
   *  gateway (see resolve()): suspend keeps the instance — and every thread
   *  lifecycle reference to it — valid while making sure the authenticated
   *  socket stops receiving transcript events. */
  private suspendGateway(reason: GatewayInvalidationReason): void {
    if (!this.gatewayService || this.gatewaySuspended) {
      return;
    }
    this.onGatewayInvalidated?.(reason);
    this.gatewayService.suspend();
    this.gatewaySuspended = true;
  }

  /** SecretStorage can fail (locked or missing keyring): `auto` then
   *  degrades to acpx like a missing token, `gateway` reports the cause. */
  private async readToken(transport: 'gateway' | 'auto'): Promise<string> {
    try {
      return await getGatewayToken(this.context.secrets);
    } catch {
      log.warn('reading the gateway token from SecretStorage failed');
      if (transport === 'gateway') {
        this.onStatus?.('gateway', false);
        throw new Error('Could not read the gateway token from SecretStorage.');
      }
      return '';
    }
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

  /** Dispose the cached gateway client (provider teardown). */
  dispose(): void {
    this.gatewayService?.dispose();
    this.gatewayService = null;
    this.cachedUrl = '';
    this.cachedToken = '';
  }

  private getOrCreateGateway(url: string, token: string): GatewayChatService {
    if (!this.gatewayService) {
      this.gatewayService = new GatewayChatService({ url, token });
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

  private withTimeout(promise: Promise<void>, ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('gateway connect timeout')), ms);
      promise.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (err: Error) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }
}
