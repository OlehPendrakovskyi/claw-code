/**
 * Claw Code — device identity for the gateway handshake.
 *
 * One Ed25519 keypair identifies this client to gateways that pair devices.
 * As the gateway derives and verifies it (infra/device-identity.ts,
 * infra/ed25519-signature.ts): the device id is the hex SHA-256 of the raw
 * 32-byte public key, the public key travels as unpadded base64url of those
 * bytes, and the signature is base64url Ed25519 over the UTF-8 payload. The
 * payload text belongs to the protocol version, so the adapter formats it.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'crypto';
import type { KeyObject } from 'crypto';
import type { ClientHello, GatewayProtocolAdapter } from './adapter';
import type { DeviceProof } from './model';

/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw key follows it. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_RAW_KEY_BYTES = 32;

export type DeviceIdentity = {
  deviceId: string;
  /** Raw public key, unpadded base64url. */
  publicKey: string;
  /** Never logged, never persisted outside SecretStorage. */
  privateKey: KeyObject;
};

/** A token a gateway issued this device, with the grant it came with. */
export type StoredDeviceToken = { deviceId: string; role: string; token: string; scopes: readonly string[] };

/** Narrow an untrusted value (a parsed SecretStorage map entry) to a `StoredDeviceToken`. */
export function isStoredDeviceToken(value: unknown): value is StoredDeviceToken {
  if (typeof value !== 'object' || value === null) return false;
  const { deviceId, role, token, scopes } = value as Record<string, unknown>;
  const hasStrings = typeof deviceId === 'string' && typeof role === 'string' && typeof token === 'string' && token !== '';
  return hasStrings && Array.isArray(scopes) && scopes.every((scope) => typeof scope === 'string');
}

/** Where the identity and the tokens gateways issued it are kept. `gateway` names one gateway (its URL origin). */
export interface DeviceCredentialStore {
  /** This client's identity, created and persisted on first use. */
  loadIdentity(): Promise<DeviceIdentity>;
  /** The token `gateway` issued `deviceId`, or null. */
  loadToken(gateway: string, deviceId: string): Promise<StoredDeviceToken | null>;
  storeToken(gateway: string, token: StoredDeviceToken): Promise<void>;
  clearToken(gateway: string, deviceId: string): Promise<void>;
}

/** The challenge a proof answers: its nonce and the gateway's timestamp, which becomes `signedAt`. */
export type DeviceChallenge = { nonce: string; issuedAtMs: number };

function rawPublicKey(privateKey: KeyObject): Buffer {
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return spki.subarray(ED25519_SPKI_PREFIX.length);
}

function identityOf(privateKey: KeyObject): DeviceIdentity {
  const raw = rawPublicKey(privateKey);
  return {
    deviceId: createHash('sha256').update(raw).digest('hex'),
    publicKey: raw.toString('base64url'),
    privateKey,
  };
}

export function generateDeviceIdentity(): DeviceIdentity {
  return identityOf(generateKeyPairSync('ed25519').privateKey);
}

/** The private key as PKCS#8 PEM, the only form that is persisted. */
export function exportDeviceIdentity(identity: DeviceIdentity): string {
  return identity.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

/** The identity of a persisted private key, or null when it is not an Ed25519 key. */
export function importDeviceIdentity(privateKeyPem: string): DeviceIdentity | null {
  try {
    const privateKey = createPrivateKey(privateKeyPem);
    if (privateKey.asymmetricKeyType !== 'ed25519') return null;
    const identity = identityOf(privateKey);
    return Buffer.from(identity.publicKey, 'base64url').length === ED25519_RAW_KEY_BYTES ? identity : null;
  } catch {
    return null;
  }
}

/** Sign `hello` for `challenge` in the payload format of the adapter that frames it. */
export function proveDevice(
  identity: DeviceIdentity,
  adapter: GatewayProtocolAdapter,
  hello: ClientHello,
  challenge: DeviceChallenge
): DeviceProof {
  const claim = { deviceId: identity.deviceId, nonce: challenge.nonce, signedAtMs: challenge.issuedAtMs };
  const payload = adapter.deviceAuthPayload(hello, claim);
  return {
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    signature: sign(null, Buffer.from(payload, 'utf8'), identity.privateKey).toString('base64url'),
    signedAtMs: challenge.issuedAtMs,
    nonce: challenge.nonce,
  };
}
