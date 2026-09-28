/**
 * Protocol v4 error codes and handshake rejection classification.
 *
 * Mirrors packages/gateway-protocol/src/{gateway-error-details,connect-error-details}.ts
 * and the official client's shouldPauseGatewayReconnect, except that failures
 * it recovers with a stored device token are terminal here: this client has no
 * device identity and authenticates with the shared token only.
 */

import type { HandshakeRejection, HandshakeRejectionKind, RpcFailure } from '../model';
import { PROTOCOL_MISMATCH_HINT } from '../model';
import { readDelayMs, readRecord, readTrimmedString, readString } from './readers';

/** Top-level `error.code` values. */
export const ErrorCodes = {
  NOT_PAIRED: 'NOT_PAIRED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  FORBIDDEN: 'FORBIDDEN',
  UNAVAILABLE: 'UNAVAILABLE',
} as const;

/** Handshake failure codes carried in `error.details.code`. */
export const ConnectErrorDetailCodes = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_UNAUTHORIZED: 'AUTH_UNAUTHORIZED',
  AUTH_TOKEN_MISSING: 'AUTH_TOKEN_MISSING',
  AUTH_TOKEN_MISMATCH: 'AUTH_TOKEN_MISMATCH',
  AUTH_TOKEN_NOT_CONFIGURED: 'AUTH_TOKEN_NOT_CONFIGURED',
  AUTH_PASSWORD_MISSING: 'AUTH_PASSWORD_MISSING',
  AUTH_PASSWORD_MISMATCH: 'AUTH_PASSWORD_MISMATCH',
  AUTH_PASSWORD_NOT_CONFIGURED: 'AUTH_PASSWORD_NOT_CONFIGURED',
  AUTH_BOOTSTRAP_TOKEN_INVALID: 'AUTH_BOOTSTRAP_TOKEN_INVALID',
  AUTH_DEVICE_TOKEN_MISMATCH: 'AUTH_DEVICE_TOKEN_MISMATCH',
  AUTH_SCOPE_MISMATCH: 'AUTH_SCOPE_MISMATCH',
  AUTH_RATE_LIMITED: 'AUTH_RATE_LIMITED',
  AUTH_TAILSCALE_IDENTITY_MISSING: 'AUTH_TAILSCALE_IDENTITY_MISSING',
  AUTH_TAILSCALE_PROXY_MISSING: 'AUTH_TAILSCALE_PROXY_MISSING',
  AUTH_TAILSCALE_WHOIS_FAILED: 'AUTH_TAILSCALE_WHOIS_FAILED',
  AUTH_TAILSCALE_IDENTITY_MISMATCH: 'AUTH_TAILSCALE_IDENTITY_MISMATCH',
  AUTH_IDENTITY_HEADER_REQUIRED: 'AUTH_IDENTITY_HEADER_REQUIRED',
  AUTH_VERIFIED_USER_REQUIRED: 'AUTH_VERIFIED_USER_REQUIRED',
  AUTHENTICATED_PROFILE_UNAVAILABLE: 'AUTHENTICATED_PROFILE_UNAVAILABLE',
  CONTROL_UI_BUILD_MISMATCH: 'CONTROL_UI_BUILD_MISMATCH',
  CONTROL_UI_ORIGIN_NOT_ALLOWED: 'CONTROL_UI_ORIGIN_NOT_ALLOWED',
  CONTROL_UI_DEVICE_IDENTITY_REQUIRED: 'CONTROL_UI_DEVICE_IDENTITY_REQUIRED',
  PROTOCOL_MISMATCH: 'PROTOCOL_MISMATCH',
  CLIENT_VERSION_MISMATCH: 'CLIENT_VERSION_MISMATCH',
  DEVICE_IDENTITY_REQUIRED: 'DEVICE_IDENTITY_REQUIRED',
  DEVICE_AUTH_INVALID: 'DEVICE_AUTH_INVALID',
  DEVICE_AUTH_DEVICE_ID_MISMATCH: 'DEVICE_AUTH_DEVICE_ID_MISMATCH',
  DEVICE_AUTH_SIGNATURE_EXPIRED: 'DEVICE_AUTH_SIGNATURE_EXPIRED',
  DEVICE_AUTH_NONCE_REQUIRED: 'DEVICE_AUTH_NONCE_REQUIRED',
  DEVICE_AUTH_NONCE_MISMATCH: 'DEVICE_AUTH_NONCE_MISMATCH',
  DEVICE_AUTH_SIGNATURE_INVALID: 'DEVICE_AUTH_SIGNATURE_INVALID',
  DEVICE_AUTH_PUBLIC_KEY_INVALID: 'DEVICE_AUTH_PUBLIC_KEY_INVALID',
  PAIRING_REQUIRED: 'PAIRING_REQUIRED',
} as const;

/** `error.details.recommendedNextStep` values a handshake failure may carry. */
export const ConnectRecoverySteps = {
  RETRY_WITH_DEVICE_TOKEN: 'retry_with_device_token',
  UPDATE_AUTH_CONFIGURATION: 'update_auth_configuration',
  UPDATE_AUTH_CREDENTIALS: 'update_auth_credentials',
  WAIT_THEN_RETRY: 'wait_then_retry',
  REVIEW_AUTH_CONFIGURATION: 'review_auth_configuration',
} as const;

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

const VERSION_CODES: ReadonlySet<string> = new Set([
  Codes.PROTOCOL_MISMATCH,
  Codes.CLIENT_VERSION_MISMATCH,
  Codes.CONTROL_UI_BUILD_MISMATCH,
]);

const NO_DEVICE_IDENTITY =
  'Claw Code authenticates with the shared gateway token only; it has no device identity to pair (not implemented).';

export const RejectionHints = {
  credentials: 'Gateway rejected the token — run "OpenClaw: Connect to Gateway" to update it.',
  scopes: 'The gateway did not grant the operator.read/operator.write scopes — review the token\'s scopes in OpenClaw.',
  pairing: `The gateway requires device pairing for this connection. ${NO_DEVICE_IDENTITY} Connect over loopback, e.g. through an SSH tunnel to the gateway host.`,
  deviceIdentity: `The gateway requires a paired device identity for this connection. ${NO_DEVICE_IDENTITY} Connect over loopback, e.g. through an SSH tunnel to the gateway host.`,
  version: PROTOCOL_MISMATCH_HINT,
  authConfiguration: "The gateway's authentication setup rejected this client — review gateway.auth in OpenClaw.",
  forbidden: 'The gateway refused this client — check its role and scope policy in OpenClaw.',
  invalidRequest: 'The gateway rejected the connect request — update the extension or the gateway.',
  rateLimited: 'Too many failed sign-ins — the gateway locked authentication for a while; retrying after the lockout.',
  transient: 'The gateway is temporarily unavailable; retrying.',
} as const;

type RejectionInput = {
  code: string;
  detailCode: string | null;
  topCode: string;
  nextStep: unknown;
  pauseReconnect: unknown;
};

/** Pairing, rate limits and startup: the conditions a later attempt can outlive. */
type Verdict = { kind: HandshakeRejectionKind; hint: string; throttled?: boolean };

function transientVerdict(input: RejectionInput): Verdict | null {
  const { code, detailCode, topCode } = input;
  if (code === Codes.PAIRING_REQUIRED || (!detailCode && topCode === ErrorCodes.NOT_PAIRED)) {
    const waits = input.pauseReconnect === false || input.nextStep === ConnectRecoverySteps.WAIT_THEN_RETRY;
    return { kind: waits ? 'backoff' : 'pause', hint: RejectionHints.pairing, throttled: true };
  }
  if (code === Codes.AUTH_RATE_LIMITED) return { kind: 'backoff', hint: RejectionHints.rateLimited, throttled: true };
  if (code === Codes.AUTHENTICATED_PROFILE_UNAVAILABLE) return { kind: 'backoff', hint: RejectionHints.transient };
  return null;
}

/** The hint of a rejection no retry with the same settings can fix, or null. */
function permanentHint(input: RejectionInput): string | null {
  const { code, detailCode, topCode, nextStep } = input;
  if (code === Codes.AUTH_SCOPE_MISMATCH) return RejectionHints.scopes;
  if (CREDENTIAL_CODES.has(code)) return RejectionHints.credentials;
  if (AUTH_CONFIGURATION_CODES.has(code)) return RejectionHints.authConfiguration;
  if (DEVICE_IDENTITY_CODES.has(code)) return RejectionHints.deviceIdentity;
  if (VERSION_CODES.has(code)) return RejectionHints.version;
  if (topCode === ErrorCodes.FORBIDDEN) return RejectionHints.forbidden;
  if (!detailCode && topCode === ErrorCodes.INVALID_REQUEST) return RejectionHints.invalidRequest;
  if (nextStep === ConnectRecoverySteps.UPDATE_AUTH_CREDENTIALS) return RejectionHints.credentials;
  const reviewsConfiguration =
    nextStep === ConnectRecoverySteps.UPDATE_AUTH_CONFIGURATION || nextStep === ConnectRecoverySteps.REVIEW_AUTH_CONFIGURATION;
  return reviewsConfiguration ? RejectionHints.authConfiguration : null;
}

/** Classify an untrusted handshake `res.error`. */
export function classifyHandshakeRejection(error: unknown): HandshakeRejection {
  const fields = readRecord(error);
  const details = readRecord(fields.details);
  const topCode = readString(fields.code) ?? 'unknown';
  const detailCode = readTrimmedString(details.code);
  const input: RejectionInput = {
    code: detailCode ?? topCode,
    detailCode,
    topCode,
    nextStep: details.recommendedNextStep,
    pauseReconnect: details.pauseReconnect,
  };
  const retryAfterMs = readDelayMs(fields.retryAfterMs) ?? readDelayMs(details.retryAfterMs);
  const permanent = permanentHint(input);
  const verdict: Verdict = transientVerdict(input) ??
    (permanent ? { kind: 'permanent', hint: permanent } : { kind: 'backoff', hint: RejectionHints.transient });
  return {
    kind: verdict.kind,
    code: input.code,
    message: readString(fields.message) ?? '',
    hint: verdict.hint,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(verdict.throttled ? { throttled: true } : {}),
  };
}

/** Longest gateway error message carried into errors shown to the user. */
const RPC_MESSAGE_LIMIT = 300;

/** An untrusted RPC `res.error` (ErrorShapeSchema). */
export function readRpcFailure(error: unknown): RpcFailure {
  const fields = readRecord(error);
  const message = readString(fields.message) ?? '';
  const retryAfterMs = readDelayMs(fields.retryAfterMs);
  return {
    code: readString(fields.code) ?? 'unknown',
    message: message.length > RPC_MESSAGE_LIMIT ? `${message.slice(0, RPC_MESSAGE_LIMIT)}…` : message,
    retryable: fields.retryable === true,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

/** The gateway accepted the shared token but granted none of the operator scopes it carries on
 *  loopback: remote connections need a paired device for them. */
export function missingScopesRejection(missing: readonly string[]): HandshakeRejection {
  return {
    kind: 'permanent',
    code: 'MISSING_SCOPE',
    message: `the gateway granted no ${missing.join(', ')}`,
    hint: RejectionHints.pairing,
  };
}
