import { ConnectErrorDetailCodes, ErrorCodes, ConnectRecoverySteps, classifyHandshakeRejection, missingScopesRejection, pairingHint, readRpcFailure } from '../core/gatewayProtocol/v4/errors';

const Codes = ConnectErrorDetailCodes;

function classify(error: unknown) {
    return classifyHandshakeRejection(error);
}

describe('gateway protocol v4 error classification', () => {
    describe('readRpcFailure', () => {
        it('keeps the fields of a plain failure and defaults the code of a bare one', () => {
            expect(readRpcFailure({ code: 'UNAVAILABLE', message: 'busy', retryable: true, retryAfterMs: 1500, details: { reason: 'restarting' } })).toEqual({
                code: 'UNAVAILABLE',
                message: 'busy',
                retryable: true,
                retryAfterMs: 1500,
                reason: 'restarting',
            });
            expect(readRpcFailure({})).toEqual({ code: 'unknown', message: '', retryable: false });
        });

        it('marks a refusal retryable only on an explicit true', () => {
            expect(readRpcFailure({ code: 'X', message: 'm', retryable: true }).retryable).toBe(true);
            expect(readRpcFailure({ code: 'X', message: 'm', retryable: 'yes' }).retryable).toBe(false);
            expect(readRpcFailure({ code: 'X', message: 'm' }).retryable).toBe(false);
        });

        it('cuts an untrusted message to 300 characters plus an ellipsis', () => {
            const long = 'x'.repeat(500);
            const failure = readRpcFailure({ code: 'X', message: long });
            expect(failure.message).toHaveLength(301);
            expect(failure.message.startsWith('x'.repeat(300))).toBe(true);
            expect(failure.message.endsWith('…')).toBe(true);
            expect(readRpcFailure({ code: 'X', message: 'x'.repeat(300) }).message).toHaveLength(300);
        });

        it('keeps a retry wait only within the 60 s send-hold cap', () => {
            expect(readRpcFailure({ code: 'X', message: 'm', retryAfterMs: 86_400_000 }).retryAfterMs).toBe(60_000);
            expect(readRpcFailure({ code: 'X', message: 'm', retryAfterMs: -5 }).retryAfterMs).toBeUndefined();
            expect(readRpcFailure({ code: 'X', message: 'm', retryAfterMs: 'soon' }).retryAfterMs).toBeUndefined();
            expect(readRpcFailure({ code: 'X', message: 'm', retryAfterMs: 250 }).retryAfterMs).toBe(250);
        });

        it('carries a details.reason string and drops a malformed one', () => {
            expect(readRpcFailure({ code: 'X', message: 'm', details: { reason: 'approval-denied' } }).reason).toBe('approval-denied');
            expect(readRpcFailure({ code: 'X', message: 'm', details: { reason: 7 } }).reason).toBeUndefined();
            expect(readRpcFailure({ code: 'X', message: 'm', details: 'junk' }).reason).toBeUndefined();
        });
    });

    describe('pairingHint', () => {
        it('echoes a request id into the approve command', () => {
            const hint = pairingHint({ requestId: 'req-7', reason: 'scope-upgrade' });
            expect(hint).toContain("approve this device's scope upgrade: run `openclaw devices approve req-7`");
            expect(hint).toContain('Devices page of the OpenClaw Control UI');
        });

        it('points at the pending list when the request id is missing', () => {
            const hint = pairingHint({ requestId: null, reason: 'not-paired' });
            expect(hint).toContain('approve this device: run `openclaw devices list`, then `openclaw devices approve <requestId>`');
        });

        it('falls back to the device subject for an unknown reason', () => {
            expect(pairingHint({ requestId: null, reason: null })).toContain('approve this device');
            expect(pairingHint({ requestId: null, reason: 'role-upgrade' })).toContain("approve this device's role upgrade");
            expect(pairingHint({ requestId: null, reason: 'metadata-upgrade' })).toContain("approve this device's changed details");
        });
    });

    describe('classifyHandshakeRejection', () => {
        it('names the pairing flow with and without an echoable request id', () => {
            const withId = classify({ code: 'NOT_PAIRED', message: 'pairing required', details: { code: Codes.PAIRING_REQUIRED, requestId: 'req-7', reason: 'not-paired' } });
            expect(withId).toMatchObject({ kind: 'pause', code: Codes.PAIRING_REQUIRED, throttled: true, pairing: { requestId: 'req-7', reason: 'not-paired' } });
            expect(withId.hint).toContain('openclaw devices approve req-7');
            const withoutId = classify({ code: 'NOT_PAIRED', message: 'pairing required', details: { code: Codes.PAIRING_REQUIRED, requestId: 'bad id; rm -rf', reason: 'bogus' } });
            expect(withoutId.pairing).toEqual({ requestId: null, reason: null });
            expect(withoutId.hint).toContain('`openclaw devices list`');
        });

        it('backs off when pairing asks to wait and retry, or pauseReconnect is false', () => {
            expect(classify({ code: 'NOT_PAIRED', message: 'x', details: { code: Codes.PAIRING_REQUIRED, recommendedNextStep: ConnectRecoverySteps.WAIT_THEN_RETRY } }).kind).toBe('backoff');
            expect(classify({ code: 'NOT_PAIRED', message: 'x', details: { code: Codes.PAIRING_REQUIRED, pauseReconnect: false } }).kind).toBe('backoff');
            expect(classify({ code: 'NOT_PAIRED', message: 'x', details: { code: Codes.PAIRING_REQUIRED, pauseReconnect: true } }).kind).toBe('pause');
            expect(classify({ code: 'NOT_PAIRED', message: 'x', details: { code: Codes.PAIRING_REQUIRED } }).kind).toBe('pause');
        });

        it('treats a bare NOT_PAIRED without a detail code as pairing too', () => {
            const rejection = classify({ code: ErrorCodes.NOT_PAIRED, message: 'pairing required' });
            expect(rejection).toMatchObject({ kind: 'pause', throttled: true });
            expect(rejection.pairing).toEqual({ requestId: null, reason: null });
        });

        it('backs off throttled on rate limiting and plainly on a profile the gateway cannot load', () => {
            const limited = classify({ code: ErrorCodes.UNAVAILABLE, message: 'locked', details: { code: Codes.AUTH_RATE_LIMITED } });
            expect(limited).toMatchObject({ kind: 'backoff', throttled: true, hint: expect.stringContaining('locked authentication') });
            const unavailable = classify({ code: ErrorCodes.UNAVAILABLE, message: 'warming', details: { code: Codes.AUTHENTICATED_PROFILE_UNAVAILABLE } });
            expect(unavailable).toMatchObject({ kind: 'backoff', hint: expect.stringContaining('temporarily unavailable') });
            expect(unavailable.throttled).toBeUndefined();
        });

        it('maps every permanent code group to its hint and keeps the classification permanent', () => {
            const cases: ReadonlyArray<{ code: string; fragment: string }> = [
                { code: Codes.AUTH_SCOPE_MISMATCH, fragment: 'operator.read/operator.write scopes' },
                { code: Codes.AUTH_TOKEN_MISMATCH, fragment: 'rejected the token' },
                { code: Codes.AUTH_PASSWORD_MISMATCH, fragment: 'rejected the token' },
                { code: Codes.AUTH_IDENTITY_HEADER_REQUIRED, fragment: 'authentication setup' },
                { code: Codes.CONTROL_UI_ORIGIN_NOT_ALLOWED, fragment: 'authentication setup' },
                { code: Codes.DEVICE_IDENTITY_REQUIRED, fragment: 'device identity' },
                { code: Codes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED, fragment: 'device identity' },
                { code: Codes.DEVICE_AUTH_SIGNATURE_INVALID, fragment: 'Reset Gateway Device Identity' },
                { code: Codes.DEVICE_AUTH_PUBLIC_KEY_INVALID, fragment: 'Reset Gateway Device Identity' },
                { code: Codes.PROTOCOL_MISMATCH, fragment: 'protocolVersion' },
                { code: Codes.CLIENT_VERSION_MISMATCH, fragment: 'protocolVersion' },
            ];
            for (const { code, fragment } of cases) {
                const rejection = classify({ code: ErrorCodes.INVALID_REQUEST, message: 'refused', details: { code } });
                expect(rejection.kind).toBe('permanent');
                expect(rejection.hint).toContain(fragment);
            }
        });

        it('stops on a top-level FORBIDDEN and a bare INVALID_REQUEST, whatever the detail says', () => {
            expect(classify({ code: ErrorCodes.FORBIDDEN, message: 'no', details: { code: 'SOMETHING_NEW' } })).toMatchObject({ kind: 'permanent', hint: expect.stringContaining('role and scope policy') });
            expect(classify({ code: ErrorCodes.INVALID_REQUEST, message: 'bad connect' })).toMatchObject({ kind: 'permanent', hint: expect.stringContaining('update the extension') });
        });

        it('follows the recommended next step when the code is unknown', () => {
            expect(classify({ code: 'X', message: 'm', details: { code: 'SOMETHING_NEW', recommendedNextStep: ConnectRecoverySteps.UPDATE_AUTH_CREDENTIALS } })).toMatchObject({ kind: 'permanent', hint: expect.stringContaining('rejected the token') });
            expect(classify({ code: 'X', message: 'm', details: { code: 'SOMETHING_NEW', recommendedNextStep: ConnectRecoverySteps.UPDATE_AUTH_CONFIGURATION } })).toMatchObject({ kind: 'permanent', hint: expect.stringContaining('authentication setup') });
            expect(classify({ code: 'X', message: 'm', details: { code: 'SOMETHING_NEW', recommendedNextStep: ConnectRecoverySteps.REVIEW_AUTH_CONFIGURATION } }).kind).toBe('permanent');
            expect(classify({ code: 'X', message: 'm', details: { code: 'SOMETHING_NEW', recommendedNextStep: 'dunno' } }).kind).toBe('backoff');
        });

        it('flags the device token retry the gateway suggests and a stale device token', () => {
            expect(classify({ code: 'X', message: 'm', details: { code: 'SOMETHING_NEW', canRetryWithDeviceToken: true } })).toMatchObject({ kind: 'backoff', deviceTokenRetry: true });
            expect(classify({ code: 'X', message: 'm', details: { code: 'SOMETHING_NEW', recommendedNextStep: ConnectRecoverySteps.RETRY_WITH_DEVICE_TOKEN } }).deviceTokenRetry).toBe(true);
            expect(classify({ code: 'X', message: 'm', details: { code: Codes.AUTH_TOKEN_MISMATCH } })).toMatchObject({ kind: 'permanent', deviceTokenRetry: true });
            const stale = classify({ code: 'X', message: 'm', details: { code: Codes.AUTH_DEVICE_TOKEN_MISMATCH } });
            expect(stale).toMatchObject({ kind: 'permanent', staleDeviceToken: true });
            expect(stale.deviceTokenRetry).toBeUndefined();
        });

        it('passes a retry wait through with the 5 minute cap, from either level', () => {
            expect(classify({ code: 'X', message: 'm', retryAfterMs: 250 }).retryAfterMs).toBe(250);
            expect(classify({ code: 'X', message: 'm', details: { retryAfterMs: 86_400_000 } }).retryAfterMs).toBe(5 * 60_000);
            expect(classify({ code: 'X', message: 'm', retryAfterMs: 1e20, details: { retryAfterMs: 86_400_000 } }).retryAfterMs).toBe(5 * 60_000);
            expect(classify({ code: 'X', message: 'm' }).retryAfterMs).toBeUndefined();
        });

        it('keeps the gateway message and survives junk payloads as a backoff', () => {
            expect(classify({ code: 'X', message: 'the reason', details: { code: 'Y' } }).message).toBe('the reason');
            for (const junk of [undefined, null, 'x', 5, [], { code: 7, details: 'y' }]) {
                const rejection = classify(junk);
                expect(rejection.kind).toBe('backoff');
                expect(rejection.code).toBe('unknown');
                expect(rejection.hint).toContain('temporarily unavailable');
            }
        });
    });

    describe('missingScopesRejection', () => {
        it('stays permanent and names the scopes it did not get', () => {
            const rejection = missingScopesRejection(['operator.read', 'operator.write']);
            expect(rejection).toMatchObject({
                kind: 'permanent',
                code: 'MISSING_SCOPE',
                message: 'the gateway granted no operator.read, operator.write',
                hint: expect.stringContaining('granted this connection no operator.read/operator.write'),
            });
            expect(rejection.pairing).toBeUndefined();
            expect(rejection.deviceTokenRetry).toBeUndefined();
        });
    });
});
