/**
 * Protocol v4 error codes and handshake rejection classification.
 *
 * Mirrors packages/gateway-protocol/src/{gateway-error-details,connect-error-details}.ts
 * and the official client's shouldPauseGatewayReconnect and
 * shouldRetryGatewayWithDeviceToken (packages/gateway-client/src/).
 */

import type { HandshakeRejection, HandshakeRejectionKind, PairingRequest, RpcFailure } from '../model';
import { PROTOCOL_MISMATCH_HINT } from '../model';
import { readDelayMs, readNestedString, readRecord, readTrimmedString, readString, readStringOr, capText } from './readers';
import { UNKNOWN, GATEWAY_MESSAGE_LIMIT } from '../../constants';

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

const DEVICE_IDENTITY_CODES: ReadonlySet<string> = new Set([Codes.DEVICE_IDENTITY_REQUIRED, Codes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED]);

const DEVICE_PROOF_CODES: ReadonlySet<string> = new Set([
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

const RESET_IDENTITY = 'run "OpenClaw: Reset Gateway Device Identity" and approve the new device';

export const RejectionHints = {
  credentials: 'Gateway rejected the token — run "OpenClaw: Connect to Gateway" to update it.',
  scopes: 'The gateway did not grant the operator.read/operator.write scopes — review the token\'s scopes in OpenClaw.',
  scopesNotGranted:
    'The gateway granted this connection no operator.read/operator.write — approve this device in OpenClaw (`openclaw devices list`), or connect over loopback.',
  deviceIdentity:
    'The gateway requires a device identity, but none could be read from SecretStorage — check the OS keyring, then run "OpenClaw: Connect to Gateway".',
  deviceProof: `The gateway rejected this device's signature — check the system clock, or ${RESET_IDENTITY}.`,
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
  details: Readonly<Record<string, unknown>>;
};

/** PAIRING_CONNECT_REQUEST_ID_PATTERN: ids outside it are not echoed into UI text. */
/** Longest a refused handshake's `retryAfterMs` may hold back reconnecting, as a restart announcement may. */
const MAX_HANDSHAKE_RETRY_WAIT_MS = 5 * 60_000;

/** Longest a retryable RPC refusal may hold a send back; the run shows no progress meanwhile. */
const MAX_RPC_RETRY_WAIT_MS = 60_000;

const PAIRING_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** ConnectPairingRequiredReasons and what each asks the operator to approve. */
const PAIRING_SUBJECTS: Readonly<Record<string, string>> = {
  'not-paired': 'this device',
  'role-upgrade': "this device's role upgrade",
  'scope-upgrade': "this device's scope upgrade",
  'metadata-upgrade': "this device's changed details",
};

function readPairingRequest(details: Readonly<Record<string, unknown>>): PairingRequest {
  const requestId = readTrimmedString(details.requestId);
  const reason = readTrimmedString(details.reason);
  return {
    requestId: requestId && PAIRING_REQUEST_ID.test(requestId) ? requestId : null,
    reason: reason && Object.prototype.hasOwnProperty.call(PAIRING_SUBJECTS, reason) ? reason : null,
  };
}

/** The approval steps of docs/cli/devices.md and the Control UI Devices page. */
export function pairingHint({ requestId, reason }: PairingRequest): string {
  const subject = PAIRING_SUBJECTS[reason ?? 'not-paired'];
  const command = requestId
    ? `run \`openclaw devices approve ${requestId}\` on the gateway host`
    : 'run `openclaw devices list`, then `openclaw devices approve <requestId>` on the gateway host';
  return `The gateway waits for an operator to approve ${subject}: ${command}, or approve it on the Devices page of the OpenClaw Control UI.`;
}

function isPairingRequired({ code, detailCode, topCode }: RejectionInput): boolean {
  return code === Codes.PAIRING_REQUIRED || (!detailCode && topCode === ErrorCodes.NOT_PAIRED);
}

/** shouldRetryGatewayWithDeviceToken: the gateway's own hints that a stored device token would do. */
function allowsDeviceTokenRetry({ code, details, nextStep }: RejectionInput): boolean {
  return code === Codes.AUTH_TOKEN_MISMATCH || details.canRetryWithDeviceToken === true || nextStep === ConnectRecoverySteps.RETRY_WITH_DEVICE_TOKEN;
}

/** Pairing, rate limits and startup: the conditions a later attempt can outlive. */
type Verdict = { kind: HandshakeRejectionKind; hint: string; throttled?: boolean };

function transientVerdict(input: RejectionInput): Verdict | null {
  const { code } = input;
  if (isPairingRequired(input)) {
    const waits = input.pauseReconnect === false || input.nextStep === ConnectRecoverySteps.WAIT_THEN_RETRY;
    return { kind: waits ? 'backoff' : 'pause', hint: pairingHint(readPairingRequest(input.details)), throttled: true };
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
  if (DEVICE_PROOF_CODES.has(code)) return RejectionHints.deviceProof;
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
  const topCode = readStringOr(readString(fields.code), UNKNOWN);
  const detailCode = readTrimmedString(details.code);
  const input: RejectionInput = {
    code: detailCode ?? topCode,
    detailCode,
    topCode,
    nextStep: details.recommendedNextStep,
    pauseReconnect: details.pauseReconnect,
    details,
  };
  const retryAfterMs = readDelayMs(fields.retryAfterMs, MAX_HANDSHAKE_RETRY_WAIT_MS) ?? readDelayMs(details.retryAfterMs, MAX_HANDSHAKE_RETRY_WAIT_MS);
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
    ...(isPairingRequired(input) ? { pairing: readPairingRequest(details) } : {}),
    ...(allowsDeviceTokenRetry(input) ? { deviceTokenRetry: true } : {}),
    ...(input.code === Codes.AUTH_DEVICE_TOKEN_MISMATCH ? { staleDeviceToken: true } : {}),
  };
}

/** Longest gateway error message carried into errors shown to the user. */
const RPC_MESSAGE_LIMIT = GATEWAY_MESSAGE_LIMIT;

/** An untrusted RPC `res.error` (ErrorShapeSchema). */
export function readRpcFailure(error: unknown): RpcFailure {
  const fields = readRecord(error);
  const message = readStringOr(readString(fields.message), '');
  const retryAfterMs = readDelayMs(fields.retryAfterMs, MAX_RPC_RETRY_WAIT_MS);
  const reason = readNestedString(fields, 'details', 'reason');
  return {
    code: readStringOr(readString(fields.code), UNKNOWN),
    message: capText(message, RPC_MESSAGE_LIMIT) ?? '',
    retryable: fields.retryable === true,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(reason ? { reason } : {}),
  };
}

/** The gateway accepted the shared token but granted none of the operator scopes it carries on
 *  loopback: remote connections need a paired device for them. */
export function missingScopesRejection(missing: readonly string[]): HandshakeRejection {
  return {
    kind: 'permanent',
    code: 'MISSING_SCOPE',
    message: `the gateway granted no ${missing.join(', ')}`,
    hint: RejectionHints.scopesNotGranted,
  };
}
