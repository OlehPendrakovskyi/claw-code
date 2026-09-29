/**
 * Claw Code — supported gateway protocol versions and their negotiation.
 *
 * `openclaw.gateway.protocolVersion` selects the range the handshake offers:
 * `auto` offers every supported version, a number exactly that one. The
 * gateway picks one and names it in its hello; that version's adapter then
 * speaks for the connection.
 */

import type { GatewayProtocolAdapter } from './adapter';
import type { HandshakeRejection } from './model';
import { PROTOCOL_MISMATCH_HINT } from './model';
import { v4Adapter } from './v4/adapter';

/** Values of `openclaw.gateway.protocolVersion`, kept in sync with package.json. */
export const PROTOCOL_SETTINGS = ['auto', '4'] as const;

export type ProtocolSetting = (typeof PROTOCOL_SETTINGS)[number];

export type ProtocolRange = { min: number; max: number };

const ADAPTERS: ReadonlyMap<number, GatewayProtocolAdapter> = new Map([[v4Adapter.version, v4Adapter]]);

const SUPPORTED_VERSIONS = [...ADAPTERS.keys()].sort((a, b) => a - b);

export function isProtocolSetting(value: unknown): value is ProtocolSetting {
  return typeof value === 'string' && (PROTOCOL_SETTINGS as readonly string[]).includes(value);
}

/** The versions the handshake offers for a setting. */
export function resolveProtocolSetting(setting: ProtocolSetting): ProtocolRange {
  if (setting === 'auto') {
    return { min: SUPPORTED_VERSIONS[0], max: SUPPORTED_VERSIONS[SUPPORTED_VERSIONS.length - 1] };
  }
  const version = Number(setting);
  return { min: version, max: version };
}

/** The adapter that frames the handshake: the newest version the range offers. */
export function handshakeAdapter(range: ProtocolRange): GatewayProtocolAdapter {
  const adapter = ADAPTERS.get(range.max);
  if (!adapter) {
    throw new Error(`gateway protocol ${range.max} is not supported by this extension`);
  }
  return adapter;
}

/** The adapter for the version the gateway chose, or a permanent rejection when it chose outside the range. */
export function negotiatedAdapter(range: ProtocolRange, protocolVersion: number): GatewayProtocolAdapter | HandshakeRejection {
  const adapter = ADAPTERS.get(protocolVersion);
  if (adapter && protocolVersion >= range.min && protocolVersion <= range.max) {
    return adapter;
  }
  return {
    kind: 'permanent',
    code: 'PROTOCOL_MISMATCH',
    message: `gateway negotiated protocol ${protocolVersion}; this client offered ${range.min}..${range.max}`,
    hint: PROTOCOL_MISMATCH_HINT,
  };
}

export function isAdapter(value: GatewayProtocolAdapter | HandshakeRejection): value is GatewayProtocolAdapter {
  return 'version' in value;
}
