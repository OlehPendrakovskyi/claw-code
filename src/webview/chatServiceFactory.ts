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
import { getGatewaySettings, getGatewayToken } from '../core/gatewayConfig';
import { log } from './viewMessaging';

/** Resolved backend for one send. */
export type TransportChoice = {
  service: ChatService | GatewayChatService;
  transport: 'gateway' | 'acpx';
};

/** Connection probe timeout for `auto` fallback decisions. */
const CONNECT_TIMEOUT_MS = 4000;

/**
 * Factory that resolves the chat backend with an acpx fallback. Never logs
 * tokens; status updates go through the provided callback.
 */
export class ChatServiceFactory {
  private gatewayService: GatewayChatService | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onStatus?: (transport: 'gateway' | 'acpx', connected: boolean) => void
  ) {}

  /**
   * Resolve the backend for the current settings. In `auto` mode a failed
   * or missing-token gateway connect falls back to acpx transparently.
   */
  async resolve(): Promise<{ service: ChatService | GatewayChatService; transport: 'gateway' | 'acpx' }> {
    const settings = getGatewaySettings();
    if (settings.transport === 'acpx') {
      this.onStatus?.('acpx', true);
      return { service: new ChatService(), transport: 'acpx' };
    }
    const token = await getGatewayToken(this.context.secrets);
    if (!token) {
      if (settings.transport === 'gateway') {
        this.onStatus?.('gateway', false);
        return { service: this.getOrCreateGateway(settings.url, ''), transport: 'gateway' };
      }
      this.onStatus?.('acpx', true);
      return { service: new ChatService(), transport: 'acpx' };
    }
    const gateway = this.getOrCreateGateway(settings.url, token);
    try {
      await this.withTimeout(gateway.connect(), CONNECT_TIMEOUT_MS);
      this.onStatus?.('gateway', true);
      return { service: gateway, transport: 'gateway' };
    } catch {
      log.warn(`gateway connect failed; ${settings.transport === 'auto' ? 'falling back to acpx' : 'continuing without gateway'}`);
      if (settings.transport === 'auto') {
        this.onStatus?.('acpx', true);
        return { service: new ChatService(), transport: 'acpx' };
      }
      this.onStatus?.('gateway', false);
      return { service: gateway, transport: 'gateway' };
    }
  }

  /** Dispose the cached gateway client (provider teardown). */
  dispose(): void {
    this.gatewayService?.dispose();
    this.gatewayService = null;
  }

  private getOrCreateGateway(url: string, token: string): GatewayChatService {
    if (!this.gatewayService) {
      this.gatewayService = new GatewayChatService({ url, token });
    }
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
