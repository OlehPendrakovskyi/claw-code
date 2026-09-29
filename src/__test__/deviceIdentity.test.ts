/**
 * The device identity and its connect proof, checked the way the gateway checks them:
 * connect-device-proof.ts derives the id from the public key and rebuilds the signed payload
 * from the connect params it received (node-connect-reconcile.ts resolveDeviceSignaturePayloadVersion).
 */

import { createHash, createPublicKey, generateKeyPairSync, verify } from 'crypto';
import { exportDeviceIdentity, generateDeviceIdentity, importDeviceIdentity, proveDevice } from '../core/gatewayProtocol/deviceIdentity';
import { v4Adapter } from '../core/gatewayProtocol/v4/adapter';
import { assertValidRequest } from './helpers/gatewayV4';

/** A fixed key whose id and public key openclaw 2026.9.6's deriveDeviceIdFromPublicKey and
 *  normalizeDevicePublicKeyBase64Url reproduced, and whose proof its verifier accepted as v3. */
const KNOWN_KEY = '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIF9cO3QSM/aqeyrgJPpWznK2jp/P+bJeOldm86gw0hkh\n-----END PRIVATE KEY-----\n';
const KNOWN_DEVICE_ID = 'dc6ba159fbbaa3549c8eb997b6ac1062ef433c8fc233b1ac17ea3cf0aa96b8ad';
const KNOWN_PUBLIC_KEY = 'kNeQYMUWDXzuYR3hVvnYwIHRQqsxxefxmqEZEyZupB0';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const DEVICE_SIGNATURE_SKEW_MS = 120_000;

const hello = { token: 'shared-token', minProtocol: 4, maxProtocol: 4, clientVersion: '0.2.1', platform: 'Linux ' };
const challenge = { nonce: '7f7c6b0e-0d8e-4f56-9d1a-2c1d0f1b9e21', issuedAtMs: 1790605209429 };

type SentConnect = {
    client: { id: string; mode: string; platform: string; deviceFamily?: string };
    role: string;
    scopes: string[];
    auth?: { token?: string; deviceToken?: string };
    device: { id: string; publicKey: string; signature: string; signedAt: number; nonce: string };
};

/** normalizeDeviceMetadataForAuth. */
function normalizeMetadata(value: string | undefined): string {
    return (value ?? '').trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** The gateway's check of a received connect, reproduced from connect-device-proof.ts. */
function gatewayAccepts(params: SentConnect, expectedNonce: string, nowMs: number): boolean {
    const { device, client, auth } = params;
    const raw = Buffer.from(device.publicKey, 'base64url');
    const derivedId = createHash('sha256').update(raw).digest('hex');
    const fresh = Math.abs(nowMs - device.signedAt) <= DEVICE_SIGNATURE_SKEW_MS;
    const token = auth?.token ?? auth?.deviceToken ?? '';
    const payload = ['v3', device.id, client.id, client.mode, params.role, params.scopes.join(','), String(device.signedAt), token, device.nonce, normalizeMetadata(client.platform), normalizeMetadata(client.deviceFamily)].join('|');
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), type: 'spki', format: 'der' });
    const signed = verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(device.signature, 'base64url'));
    return derivedId === device.id && fresh && device.nonce === expectedNonce && signed;
}

function sentConnect(deviceToken?: string): SentConnect {
    const identity = importDeviceIdentity(KNOWN_KEY);
    if (!identity) throw new Error('known key did not import');
    const sent = { ...hello, ...(deviceToken ? { deviceToken } : {}) };
    const proof = proveDevice(identity, v4Adapter, sent, challenge);
    const frame = v4Adapter.encodeRequest('cc-1', v4Adapter.connectRequest(sent, proof));
    assertValidRequest(frame);
    return (JSON.parse(frame) as { params: SentConnect }).params;
}

describe('deviceIdentity', () => {
    describe('identity', () => {
        it('derives the id and public key exactly as the gateway does', () => {
            expect(importDeviceIdentity(KNOWN_KEY)).toMatchObject({ deviceId: KNOWN_DEVICE_ID, publicKey: KNOWN_PUBLIC_KEY });
        });

        it('generates a new Ed25519 key that survives its PEM round trip', () => {
            const generated = generateDeviceIdentity();
            const restored = importDeviceIdentity(exportDeviceIdentity(generated));
            expect(restored).toMatchObject({ deviceId: generated.deviceId, publicKey: generated.publicKey });
            expect(generated.deviceId).toMatch(/^[0-9a-f]{64}$/);
            expect(Buffer.from(generated.publicKey, 'base64url')).toHaveLength(32);
            expect(generated.publicKey).not.toMatch(/[=+/]/);
            expect(generateDeviceIdentity().deviceId).not.toBe(generated.deviceId);
        });

        it('refuses keys that are not Ed25519, and junk', () => {
            const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
            expect(importDeviceIdentity(rsa)).toBeNull();
            expect(importDeviceIdentity('not a key')).toBeNull();
            expect(importDeviceIdentity('')).toBeNull();
        });
    });

    describe('proveDevice', () => {
        it('answers the challenge with a proof the gateway verifies against the frame it receives', () => {
            const params = sentConnect();
            expect(params.device).toMatchObject({ id: KNOWN_DEVICE_ID, publicKey: KNOWN_PUBLIC_KEY, signedAt: challenge.issuedAtMs, nonce: challenge.nonce });
            expect(gatewayAccepts(params, challenge.nonce, challenge.issuedAtMs + 1000)).toBe(true);
        });

        it('binds the shared token, not a device token sent beside it', () => {
            const params = sentConnect('device-token');
            expect(params.auth).toEqual({ token: 'shared-token', deviceToken: 'device-token' });
            expect(gatewayAccepts(params, challenge.nonce, challenge.issuedAtMs)).toBe(true);
        });

        it('fails verification once any bound field differs from what was signed', () => {
            const params = sentConnect();
            const later = challenge.issuedAtMs;
            expect(gatewayAccepts({ ...params, scopes: [...params.scopes, 'operator.admin'] }, challenge.nonce, later)).toBe(false);
            expect(gatewayAccepts({ ...params, auth: { token: 'other' } }, challenge.nonce, later)).toBe(false);
            expect(gatewayAccepts({ ...params, client: { ...params.client, platform: 'darwin' } }, challenge.nonce, later)).toBe(false);
            expect(gatewayAccepts(params, 'another-nonce', later)).toBe(false);
            expect(gatewayAccepts(params, challenge.nonce, later + DEVICE_SIGNATURE_SKEW_MS + 1)).toBe(false);
        });
    });
});
