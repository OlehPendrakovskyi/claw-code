/**
 * Protocol v4 adapter: builds v4 frames and request params from the neutral
 * model and parses v4 responses and events back into it.
 */

import type { ClientHello, GatewayProtocolAdapter, WireRequest } from '../adapter';
import type {
  ConnectionAccepted,
  ConnectionFeatures,
  ConnectionLimits,
  GatewayOperation,
  HistoryRead,
  InboundFrame,
  SendAccepted,
  SendAttachment,
  SessionSummary,
  SubscriptionAccepted,
} from '../model';
import { classifyHandshakeRejection, rpcErrorCode } from './errors';
import { readEvent } from './events';
import { readSessionList, readSessionMessage, readTranscript, toTranscriptMessage } from './messages';
import { readNonNegativeInteger, readPositiveInteger, readRecord, readString, readStrings } from './readers';
import type {
  ChatAbortParams,
  ChatAttachment,
  ChatHistoryParams,
  ChatSendParams,
  ConnectParams,
  RequestFrame,
  SessionsMessagesSubscribeParams,
} from './schema';
import {
  ClientCaps,
  ClientIdentity,
  MAX_PREAUTH_PAYLOAD_BYTES,
  Methods,
  OperatorScopes,
  PolicyDefaults,
  PROTOCOL_VERSION,
} from './schema';

const CLIENT_DISPLAY_NAME = 'Claw Code';

const METHOD_BY_OPERATION: Record<GatewayOperation, string> = {
  send: Methods.chatSend,
  abort: Methods.chatAbort,
  history: Methods.chatHistory,
  subscribe: Methods.sessionsMessagesSubscribe,
  unsubscribe: Methods.sessionsMessagesUnsubscribe,
  list: Methods.sessionsList,
};

/** Without these the service can neither start a run nor observe its output. */
const REQUIRED_OPERATIONS: readonly GatewayOperation[] = ['send', 'subscribe', 'history'];

function request(method: string, params: object): WireRequest {
  return { method, params };
}

function readLimit(value: unknown, fallback: number): number {
  return readPositiveInteger(value) ?? fallback;
}

/** Limits of an untrusted `hello-ok.policy`; each malformed field keeps its default. */
export function readLimits(policy: unknown): ConnectionLimits {
  const fields = readRecord(policy);
  const attachments = readRecord(fields.attachments);
  const attachmentMaxBytes = readLimit(attachments.maxBytes, PolicyDefaults.attachmentMaxBytes);
  return {
    maxPayloadBytes: readLimit(fields.maxPayload, PolicyDefaults.maxPayload),
    maxBufferedBytes: readLimit(fields.maxBufferedBytes, PolicyDefaults.maxBufferedBytes),
    attachmentMaxBytes,
    // The gateway never accepts an image above the attachment ceiling.
    attachmentMaxImageBytes: Math.min(readLimit(attachments.maxImageBytes, PolicyDefaults.attachmentMaxImageBytes), attachmentMaxBytes),
    tickIntervalMs: readLimit(fields.tickIntervalMs, PolicyDefaults.tickIntervalMs),
  };
}

function readFeatures(features: unknown): ConnectionFeatures {
  const fields = readRecord(features);
  return {
    methods: new Set(readStrings(fields.methods)),
    events: new Set(readStrings(fields.events)),
    capabilities: new Set(readStrings(fields.capabilities)),
  };
}

/** The alias the gateway resolves to its default agent's main session (hello-ok.snapshot.sessionDefaults). */
function readSessionAliases(snapshot: unknown): ReadonlyMap<string, string> {
  const defaults = readRecord(readRecord(snapshot).sessionDefaults);
  const alias = readString(defaults.mainKey);
  const canonical = readString(defaults.mainSessionKey);
  return new Map(alias && canonical && alias !== canonical ? [[alias, canonical]] : []);
}

function toChatAttachment({ name, mimeType, data }: SendAttachment): ChatAttachment {
  return {
    type: mimeType.startsWith('image/') ? 'image' : 'file',
    mimeType,
    fileName: name,
    content: data.toString('base64'),
    sizeBytes: data.byteLength,
    origin: 'file',
  };
}

function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

function decodeResponse(frame: Readonly<Record<string, unknown>>): InboundFrame | null {
  const id = readString(frame.id);
  if (!id || typeof frame.ok !== 'boolean') {
    return null;
  }
  return frame.ok ? { type: 'response', id, ok: true, payload: frame.payload } : { type: 'response', id, ok: false, error: frame.error };
}

function decodeEvent(frame: Readonly<Record<string, unknown>>): InboundFrame | null {
  const event = readString(frame.event);
  if (!event) {
    return null;
  }
  return { type: 'event', connectionSeq: readNonNegativeInteger(frame.seq), event: readEvent(event, frame.payload) };
}

function readTailHistory(fields: Readonly<Record<string, unknown>>): HistoryRead | null {
  if (!Array.isArray(fields.messages)) {
    return null;
  }
  const sessionInfo = readRecord(fields.sessionInfo);
  return {
    messages: readTranscript(fields.messages, (row) => toTranscriptMessage(row)),
    cursor: readString(fields.deltaCursor),
    inFlightRunId: readString(readRecord(fields.inFlightRun).runId),
    activeRunIds: Array.isArray(sessionInfo.activeRunIds) ? readStrings(sessionInfo.activeRunIds) : null,
  };
}

function readDeltaHistory(fields: Readonly<Record<string, unknown>>): HistoryRead | null {
  const cursor = readString(fields.deltaCursor);
  if (!cursor || !Array.isArray(fields.messages)) {
    return null;
  }
  const sessionInfo = readRecord(fields.sessionInfo);
  return {
    messages: readTranscript(fields.messages, (row) => readSessionMessage(row)?.message ?? null),
    cursor,
    inFlightRunId: readString(readRecord(fields.inFlightRun).runId),
    activeRunIds: Array.isArray(sessionInfo.activeRunIds) ? readStrings(sessionInfo.activeRunIds) : null,
  };
}

export const v4Adapter: GatewayProtocolAdapter = {
  version: PROTOCOL_VERSION,
  preAuthPayloadLimitBytes: MAX_PREAUTH_PAYLOAD_BYTES,

  encodeRequest(id: string, wire: WireRequest): string {
    const frame: RequestFrame = { type: 'req', id, method: wire.method, params: wire.params };
    return JSON.stringify(frame);
  },

  decodeFrame(data: string): InboundFrame | null {
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return null;
    }
    const fields = readRecord(frame);
    if (fields.type === 'res') return decodeResponse(fields);
    if (fields.type === 'event') return decodeEvent(fields);
    return null;
  },

  connectRequest(hello: ClientHello): WireRequest {
    const params: ConnectParams = {
      minProtocol: hello.minProtocol,
      maxProtocol: hello.maxProtocol,
      client: {
        id: ClientIdentity.id,
        displayName: CLIENT_DISPLAY_NAME,
        version: hello.clientVersion,
        platform: hello.platform,
        mode: ClientIdentity.mode,
      },
      caps: [ClientCaps.toolEvents],
      role: 'operator',
      scopes: [OperatorScopes.read, OperatorScopes.write],
      auth: { token: hello.token },
      userAgent: `claw-code/${hello.clientVersion}`,
    };
    return request(Methods.connect, params);
  },

  parseHello(payload: unknown): ConnectionAccepted | null {
    const hello = readRecord(payload);
    const protocolVersion = readPositiveInteger(hello.protocol);
    if (hello.type !== 'hello-ok' || protocolVersion === null) {
      return null;
    }
    const auth = readRecord(hello.auth);
    return {
      protocolVersion,
      serverVersion: readString(readRecord(hello.server).version) ?? 'unknown',
      limits: readLimits(hello.policy),
      features: readFeatures(hello.features),
      role: readString(auth.role) ?? 'unknown',
      scopes: readStrings(auth.scopes),
      sessionAliases: readSessionAliases(hello.snapshot),
    };
  },

  classifyRejection: classifyHandshakeRejection,
  errorCode: rpcErrorCode,

  defaultLimits(): ConnectionLimits {
    return readLimits(undefined);
  },

  supports(features: ConnectionFeatures, operation: GatewayOperation): boolean {
    return features.methods.has(METHOD_BY_OPERATION[operation]);
  },

  missingOperations(features: ConnectionFeatures): GatewayOperation[] {
    return REQUIRED_OPERATIONS.filter((operation) => !this.supports(features, operation));
  },

  sendRequest({ sessionKey, text, runId, attachments = [] }): WireRequest {
    const params: ChatSendParams = { sessionKey, message: text, idempotencyKey: runId };
    return request(Methods.chatSend, attachments.length > 0 ? { ...params, attachments: attachments.map(toChatAttachment) } : params);
  },

  attachmentWireBytes({ name, mimeType, byteLength }): number {
    const placeholder = { ...toChatAttachment({ name, mimeType, data: Buffer.alloc(0) }), sizeBytes: byteLength };
    // The empty attachment's JSON, its separator, plus the base64 of the real content.
    return Buffer.byteLength(JSON.stringify(placeholder)) + 1 + base64Length(byteLength);
  },

  parseSendAccepted(payload: unknown): SendAccepted | null {
    const runId = readString(readRecord(payload).runId);
    return runId ? { runId } : null;
  },

  abortRequest({ sessionKey, runId }): WireRequest {
    const params: ChatAbortParams = runId ? { sessionKey, runId } : { sessionKey };
    return request(Methods.chatAbort, params);
  },

  historyRequest({ sessionKey, cursor }): WireRequest {
    const params: ChatHistoryParams = cursor ? { sessionKey, cursor } : { sessionKey };
    return request(Methods.chatHistory, params);
  },

  parseHistory(payload: unknown): HistoryRead | null {
    const fields = readRecord(payload);
    if (fields.kind === 'reset') return { reset: true };
    if (fields.kind === 'delta') return readDeltaHistory(fields);
    return readTailHistory(fields);
  },

  subscribeRequest({ sessionKey }): WireRequest {
    const params: SessionsMessagesSubscribeParams = { key: sessionKey };
    return request(Methods.sessionsMessagesSubscribe, params);
  },

  parseSubscription(payload: unknown): SubscriptionAccepted | null {
    const fields = readRecord(payload);
    const canonicalKey = readString(fields.key);
    return fields.subscribed === true && canonicalKey ? { canonicalKey } : null;
  },

  unsubscribeRequest({ sessionKey }): WireRequest {
    return request(Methods.sessionsMessagesUnsubscribe, { key: sessionKey });
  },

  listRequest(): WireRequest {
    return request(Methods.sessionsList, {});
  },

  parseSessionList(payload: unknown): SessionSummary[] | null {
    return readSessionList(payload);
  },
};
