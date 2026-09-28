/**
 * Unit tests for handshake rejection classification and hello-ok policy parsing.
 * Error payloads mirror what the 2026.9 gateway sends (src/gateway/server/ws-connection/*).
 */

import { classifyHandshakeRejection, GatewayConnectError, parseTransportLimits } from '../core/gatewayHandshake';

const authFailure = (code: string, message: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  code: 'INVALID_REQUEST',
  message,
  details: { code, authReason: 'x', canRetryWithDeviceToken: false, ...extra },
});

describe('gatewayHandshake', () => {
  describe('classifyHandshakeRejection', () => {
    it.each([
      'AUTH_TOKEN_MISSING',
      'AUTH_TOKEN_MISMATCH',
      'AUTH_TOKEN_NOT_CONFIGURED',
      'AUTH_PASSWORD_MISSING',
      'AUTH_PASSWORD_MISMATCH',
      'AUTH_PASSWORD_NOT_CONFIGURED',
      'AUTH_BOOTSTRAP_TOKEN_INVALID',
      'AUTH_DEVICE_TOKEN_MISMATCH',
      'AUTH_REQUIRED',
      'AUTH_UNAUTHORIZED',
    ])('treats the credential failure %s as permanent with a token hint', (code) => {
      const rejection = classifyHandshakeRejection(authFailure(code, 'unauthorized: gateway token mismatch'));
      expect(rejection).toMatchObject({ kind: 'permanent', code, message: 'unauthorized: gateway token mismatch' });
      expect(rejection.hint).toContain('OpenClaw: Connect to Gateway');
    });

    it('asks to approve scopes for a scope mismatch', () => {
      const rejection = classifyHandshakeRejection(
        authFailure('AUTH_SCOPE_MISMATCH', 'unauthorized: device token scope mismatch (re-pair or approve scope upgrade)')
      );
      expect(rejection.kind).toBe('permanent');
      expect(rejection.hint).toContain('approve its scopes');
    });

    it.each([
      'AUTH_IDENTITY_HEADER_REQUIRED',
      'AUTH_TAILSCALE_IDENTITY_MISSING',
      'AUTH_TAILSCALE_PROXY_MISSING',
      'AUTH_TAILSCALE_WHOIS_FAILED',
      'AUTH_TAILSCALE_IDENTITY_MISMATCH',
      'CONTROL_UI_ORIGIN_NOT_ALLOWED',
    ])('treats the auth configuration failure %s as permanent', (code) => {
      expect(classifyHandshakeRejection(authFailure(code, 'unauthorized')).kind).toBe('permanent');
    });

    it('reads the detail code under a NOT_PAIRED top-level code', () => {
      const rejection = classifyHandshakeRejection({
        code: 'NOT_PAIRED',
        message: 'operator role policies require a verified user identity for this authentication method',
        details: { code: 'AUTH_VERIFIED_USER_REQUIRED' },
      });
      expect(rejection).toMatchObject({ kind: 'permanent', code: 'AUTH_VERIFIED_USER_REQUIRED' });
      expect(rejection.hint).toContain('gateway.auth');
    });

    it.each([
      ['NOT_PAIRED', 'DEVICE_IDENTITY_REQUIRED', 'device identity required'],
      ['INVALID_REQUEST', 'CONTROL_UI_DEVICE_IDENTITY_REQUIRED', 'control ui requires device identity'],
      ['INVALID_REQUEST', 'DEVICE_AUTH_SIGNATURE_EXPIRED', 'device signature expired'],
      ['INVALID_REQUEST', 'DEVICE_AUTH_INVALID', 'device auth invalid'],
    ])('treats %s/%s as a permanent device identity failure', (top, code, message) => {
      const rejection = classifyHandshakeRejection({ code: top, message, details: { code, reason: 'x' } });
      expect(rejection.kind).toBe('permanent');
      expect(rejection.hint).toContain('device identity');
    });

    it('asks to update the extension or gateway on a protocol mismatch', () => {
      const rejection = classifyHandshakeRejection({
        code: 'INVALID_REQUEST',
        message: 'protocol mismatch',
        details: { code: 'PROTOCOL_MISMATCH', clientMinProtocol: 3, clientMaxProtocol: 3, expectedProtocol: 4, minimumProbeProtocol: 3 },
      });
      expect(rejection).toMatchObject({ kind: 'permanent', code: 'PROTOCOL_MISMATCH' });
      expect(rejection.hint).toContain('update the extension or the gateway');
      expect(classifyHandshakeRejection({ code: 'INVALID_REQUEST', details: { code: 'CLIENT_VERSION_MISMATCH' } }).kind).toBe('permanent');
    });

    it('treats a detail-less INVALID_REQUEST and a FORBIDDEN as permanent', () => {
      const invalid = classifyHandshakeRejection({ code: 'INVALID_REQUEST', message: 'invalid role' });
      expect(invalid).toMatchObject({ kind: 'permanent', code: 'INVALID_REQUEST' });
      expect(classifyHandshakeRejection({ code: 'FORBIDDEN', message: 'forbidden' })).toMatchObject({ kind: 'permanent' });
    });

    it('pauses on a pairing request and backs off when the gateway says to wait', () => {
      const pairing = {
        code: 'NOT_PAIRED',
        message: 'pairing required: device is not approved yet',
        details: { code: 'PAIRING_REQUIRED', reason: 'not-paired', requestId: 'req-1', remediationHint: 'Approve this device from the pending pairing requests.' },
      };
      expect(classifyHandshakeRejection(pairing)).toMatchObject({ kind: 'pause', code: 'PAIRING_REQUIRED' });
      expect(classifyHandshakeRejection(pairing).hint).toContain('Approve this device');
      const waiting = { ...pairing, details: { ...pairing.details, recommendedNextStep: 'wait_then_retry', retryable: true, pauseReconnect: false } };
      expect(classifyHandshakeRejection(waiting).kind).toBe('backoff');
      const unpaused = { ...pairing, details: { ...pairing.details, pauseReconnect: false } };
      expect(classifyHandshakeRejection(unpaused).kind).toBe('backoff');
      expect(classifyHandshakeRejection({ code: 'NOT_PAIRED', message: 'pairing required' }).kind).toBe('pause');
    });

    it('backs off a rate limit no sooner than the gateway asks', () => {
      const rejection = classifyHandshakeRejection({
        code: 'INVALID_REQUEST',
        message: 'unauthorized: too many failed authentication attempts (retry later)',
        retryable: true,
        retryAfterMs: 60_000,
        details: { code: 'AUTH_RATE_LIMITED', authReason: 'rate_limited' },
      });
      expect(rejection).toMatchObject({ kind: 'backoff', code: 'AUTH_RATE_LIMITED', retryAfterMs: 60_000 });
    });

    it('backs off transient unavailability and honours retryAfterMs', () => {
      const startup = classifyHandshakeRejection({
        code: 'UNAVAILABLE',
        message: 'gateway starting; retry shortly',
        retryable: true,
        retryAfterMs: 500,
        details: { reason: 'startup-sidecars' },
      });
      expect(startup).toMatchObject({ kind: 'backoff', code: 'UNAVAILABLE', retryAfterMs: 500 });
      const profile = classifyHandshakeRejection({
        code: 'UNAVAILABLE',
        message: 'profile unavailable',
        details: { code: 'AUTHENTICATED_PROFILE_UNAVAILABLE', retryAfterMs: 2000 },
      });
      expect(profile).toMatchObject({ kind: 'backoff', retryAfterMs: 2000 });
    });

    it('classifies recovery advice when the detail code is unknown', () => {
      expect(classifyHandshakeRejection({ code: 'X', details: { code: 'NEW_CODE', recommendedNextStep: 'update_auth_credentials' } }).kind).toBe('permanent');
      expect(classifyHandshakeRejection({ code: 'X', details: { code: 'NEW_CODE', recommendedNextStep: 'review_auth_configuration' } }).kind).toBe('permanent');
      expect(classifyHandshakeRejection({ code: 'X', details: { code: 'NEW_CODE', recommendedNextStep: 'update_auth_configuration' } }).kind).toBe('permanent');
      expect(classifyHandshakeRejection({ code: 'X', details: { code: 'NEW_CODE' } }).kind).toBe('backoff');
    });

    it('tolerates malformed payloads', () => {
      for (const error of [null, undefined, 'x', 7, [], { code: 5, details: [] }, { details: { code: '  ' } }]) {
        expect(classifyHandshakeRejection(error)).toMatchObject({ kind: 'backoff', message: '' });
      }
      const negative = classifyHandshakeRejection({ code: 'UNAVAILABLE', retryAfterMs: -1, details: { retryAfterMs: Number.NaN } });
      expect(negative.retryAfterMs).toBeUndefined();
      expect(classifyHandshakeRejection({ code: 'UNAVAILABLE', retryAfterMs: 1e20 }).retryAfterMs).toBe(2 ** 31 - 1);
      expect(classifyHandshakeRejection({ code: 'X', details: { code: ' AUTH_TOKEN_MISMATCH ' } }).code).toBe('AUTH_TOKEN_MISMATCH');
    });
  });

  describe('GatewayConnectError', () => {
    it('carries the classification', () => {
      const rejection = classifyHandshakeRejection({ code: 'FORBIDDEN' });
      const error = new GatewayConnectError('rejected', rejection);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('GatewayConnectError');
      expect(error.rejection).toBe(rejection);
    });
  });

  describe('parseTransportLimits', () => {
    it('reads the policy a 2026.9 hello-ok advertises', () => {
      expect(
        parseTransportLimits({
          maxPayload: 26214400,
          maxBufferedBytes: 52428800,
          tickIntervalMs: 30000,
          attachments: { maxBytes: 10485760, maxImageBytes: 6291456 },
        })
      ).toEqual({ maxPayloadBytes: 26214400, maxBufferedBytes: 52428800, attachmentMaxBytes: 10485760, attachmentMaxImageBytes: 6291456 });
    });

    it('falls back to the gateway defaults for absent or malformed fields', () => {
      const defaults = { maxPayloadBytes: 26214400, maxBufferedBytes: 52428800, attachmentMaxBytes: 20971520, attachmentMaxImageBytes: 6291456 };
      expect(parseTransportLimits(undefined)).toEqual(defaults);
      expect(parseTransportLimits({ maxPayload: -1, maxBufferedBytes: 1.5, attachments: [] })).toEqual(defaults);
      expect(parseTransportLimits({ maxPayload: '1', attachments: { maxBytes: Number.NaN, maxImageBytes: 0 } })).toEqual(defaults);
    });

    it('never reports an image ceiling above the attachment ceiling', () => {
      expect(parseTransportLimits({ attachments: { maxBytes: 1000 } }).attachmentMaxImageBytes).toBe(1000);
    });
  });
});
