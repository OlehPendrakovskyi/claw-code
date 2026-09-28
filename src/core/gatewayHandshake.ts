/**
 * Claw Code — gateway handshake outcomes.
 *
 * Classifies a rejected `connect` the way the official client's
 * shouldPauseGatewayReconnect does (packages/gateway-client), except that
 * failures it recovers with a stored device token are terminal here: this
 * client authenticates with the shared token only. Also parses the
 * transport limits a `hello-ok` advertises.
 */

import { ConnectErrorDetailCodes, ConnectRecoverySteps, GatewayErrorCodes, GatewayPolicyDefaults } from './contract';
import { asNonEmptyString, asString } from './typeGuards';

/**
 * - `permanent`: retrying with the same settings cannot succeed.
 * - `pause`: waiting for an approval in OpenClaw; no retry until the user reconnects.
 * - `backoff`: transient; reconnect no sooner than `retryAfterMs`.
 */
export type HandshakeRejectionKind = 'permanent' | 'pause' | 'backoff';

export type HandshakeRejection = {
  kind: HandshakeRejectionKind;
  /** `error.details.code`, else the top-level `error.code`. */
  code: string;
  /** The gateway's own message, as received (callers redact it). */
  message: string;
  /** Earliest reconnect delay the gateway asked for. */
  retryAfterMs?: number;
  /** What the user can do about it. */
  hint: string;
};

/** Limits a connected gateway enforces, from `hello-ok.policy`. */
export type GatewayTransportLimits = {
  maxPayloadBytes: number;
  maxBufferedBytes: number;
  attachmentMaxBytes: number;
  attachmentMaxImageBytes: number;
};

/** A rejected handshake, carrying its classification for callers of connect(). */
export class GatewayConnectError extends Error {
  constructor(
    message: string,
    readonly rejection: HandshakeRejection
  ) {
    super(message);
    this.name = 'GatewayConnectError';
  }
}

const Codes = ConnectErrorDetailCodes;

const CREDENTIAL_CODES: ReadonlySet<string> = new Set([
  Codes.AUTH_REQUIRED,
  Codes.AUTH_UNAUTHORIZED,
  Codes.AUTH_TOKEN_MISSING,
  Codes.AUTH_TOKEN_MISMATCH,
  Codes.AUTH_TOKEN_NOT_CONFIGURED,
  Codes.AUTH_PASSWORD_MISSING,
  Codes.AUTH_PASSWORD_MISMATCH,
  Codes.AUTH_PASSWORD_NOT_CONFIGURED,
  Codes.AUTH_BOOTSTRAP_TOKEN_INVALID,
  Codes.AUTH_DEVICE_TOKEN_MISMATCH,
]);

const AUTH_CONFIGURATION_CODES: ReadonlySet<string> = new Set([
  Codes.AUTH_IDENTITY_HEADER_REQUIRED,
  Codes.AUTH_VERIFIED_USER_REQUIRED,
  Codes.AUTH_TAILSCALE_IDENTITY_MISSING,
  Codes.AUTH_TAILSCALE_PROXY_MISSING,
  Codes.AUTH_TAILSCALE_WHOIS_FAILED,
  Codes.AUTH_TAILSCALE_IDENTITY_MISMATCH,
  Codes.CONTROL_UI_ORIGIN_NOT_ALLOWED,
]);

const DEVICE_IDENTITY_CODES: ReadonlySet<string> = new Set([
  Codes.DEVICE_IDENTITY_REQUIRED,
  Codes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
  Codes.DEVICE_AUTH_INVALID,
  Codes.DEVICE_AUTH_DEVICE_ID_MISMATCH,
  Codes.DEVICE_AUTH_SIGNATURE_EXPIRED,
  Codes.DEVICE_AUTH_NONCE_REQUIRED,
  Codes.DEVICE_AUTH_NONCE_MISMATCH,
  Codes.DEVICE_AUTH_SIGNATURE_INVALID,
  Codes.DEVICE_AUTH_PUBLIC_KEY_INVALID,
]);

const VERSION_CODES: ReadonlySet<string> = new Set([Codes.PROTOCOL_MISMATCH, Codes.CLIENT_VERSION_MISMATCH]);

/** Upper bound for a gateway-requested delay: Node timers overflow beyond it. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

const Hints = {
  credentials: 'Gateway rejected the token — run "OpenClaw: Connect to Gateway" to update it.',
  scopes: 'The gateway did not grant the requested scopes — re-pair this device or approve its scopes in OpenClaw.',
  pairing: 'Approve this device in OpenClaw (openclaw devices approve), then reconnect.',
  deviceIdentity:
    'The gateway requires a paired device identity for this connection — connect with the shared gateway token or approve this device in OpenClaw.',
  version: 'The gateway and the extension speak different protocol versions — update the extension or the gateway.',
  authConfiguration: "The gateway's authentication setup rejected this client — review gateway.auth in OpenClaw.",
  forbidden: 'The gateway refused this client — check its role and scope policy in OpenClaw.',
  invalidRequest: 'The gateway rejected the connect request — update the extension or the gateway.',
  rateLimited: 'Too many failed sign-ins — the gateway locked authentication for a while; retrying after the lockout.',
  transient: 'The gateway is temporarily unavailable; retrying.',
} as const;

type ErrorFields = { code?: unknown; message?: unknown; retryable?: unknown; retryAfterMs?: unknown; details?: unknown };
type DetailFields = { code?: unknown; recommendedNextStep?: unknown; pauseReconnect?: unknown; retryAfterMs?: unknown };

function fieldsOf<T>(value: unknown): T {
  return (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as T;
}

function readDelayMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, MAX_TIMER_DELAY_MS) : undefined;
}

/** Classify an untrusted handshake `res.error`. */
export function classifyHandshakeRejection(error: unknown): HandshakeRejection {
  const fields = fieldsOf<ErrorFields>(error);
  const details = fieldsOf<DetailFields>(fields.details);
  const topCode = asString(fields.code, 'unknown');
  const detailCode = asNonEmptyString(typeof details.code === 'string' ? details.code.trim() : null);
  const code = detailCode ?? topCode;
  const message = asString(fields.message, '');
  const retryAfterMs = readDelayMs(fields.retryAfterMs) ?? readDelayMs(details.retryAfterMs);
  const nextStep = details.recommendedNextStep;
  const reject = (kind: HandshakeRejectionKind, hint: string): HandshakeRejection => ({
    kind,
    code,
    message,
    hint,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
  if (code === Codes.PAIRING_REQUIRED || (!detailCode && topCode === GatewayErrorCodes.NOT_PAIRED)) {
    const waits = details.pauseReconnect === false || nextStep === ConnectRecoverySteps.WAIT_THEN_RETRY;
    return reject(waits ? 'backoff' : 'pause', Hints.pairing);
  }
  if (code === Codes.AUTH_RATE_LIMITED) return reject('backoff', Hints.rateLimited);
  if (code === Codes.AUTHENTICATED_PROFILE_UNAVAILABLE) return reject('backoff', Hints.transient);
  if (code === Codes.AUTH_SCOPE_MISMATCH) return reject('permanent', Hints.scopes);
  if (CREDENTIAL_CODES.has(code)) return reject('permanent', Hints.credentials);
  if (AUTH_CONFIGURATION_CODES.has(code)) return reject('permanent', Hints.authConfiguration);
  if (DEVICE_IDENTITY_CODES.has(code)) return reject('permanent', Hints.deviceIdentity);
  if (VERSION_CODES.has(code)) return reject('permanent', Hints.version);
  if (topCode === GatewayErrorCodes.FORBIDDEN) return reject('permanent', Hints.forbidden);
  if (!detailCode && topCode === GatewayErrorCodes.INVALID_REQUEST) return reject('permanent', Hints.invalidRequest);
  if (nextStep === ConnectRecoverySteps.UPDATE_AUTH_CREDENTIALS) return reject('permanent', Hints.credentials);
  if (nextStep === ConnectRecoverySteps.UPDATE_AUTH_CONFIGURATION || nextStep === ConnectRecoverySteps.REVIEW_AUTH_CONFIGURATION) {
    return reject('permanent', Hints.authConfiguration);
  }
  return reject('backoff', Hints.transient);
}

function readLimit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** Transport limits of an untrusted `hello-ok.policy`; each malformed field keeps its default. */
export function parseTransportLimits(policy: unknown): GatewayTransportLimits {
  const fields = fieldsOf<{ maxPayload?: unknown; maxBufferedBytes?: unknown; attachments?: unknown }>(policy);
  const attachments = fieldsOf<{ maxBytes?: unknown; maxImageBytes?: unknown }>(fields.attachments);
  const attachmentMaxBytes = readLimit(attachments.maxBytes, GatewayPolicyDefaults.attachmentMaxBytes);
  return {
    maxPayloadBytes: readLimit(fields.maxPayload, GatewayPolicyDefaults.maxPayloadBytes),
    maxBufferedBytes: readLimit(fields.maxBufferedBytes, GatewayPolicyDefaults.maxBufferedBytes),
    attachmentMaxBytes,
    // The gateway never advertises an image ceiling above the attachment ceiling.
    attachmentMaxImageBytes: Math.min(
      readLimit(attachments.maxImageBytes, GatewayPolicyDefaults.attachmentMaxImageBytes),
      attachmentMaxBytes
    ),
  };
}
