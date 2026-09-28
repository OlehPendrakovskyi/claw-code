/**
 * Claw Code — gateway protocol adapter contract.
 *
 * One implementation per wire version (see ./v4/). The chat service speaks
 * only the neutral model of ./model.ts and asks the adapter for every wire
 * shape: frames, request params, and the parsing of responses and events.
 */

import type {
  AbortRequest,
  ConnectionAccepted,
  ConnectionFeatures,
  ConnectionLimits,
  GatewayOperation,
  HandshakeRejection,
  HistoryRead,
  HistoryRequest,
  InboundFrame,
  ListRequest,
  RpcFailure,
  SendAccepted,
  SendRequest,
  SessionListPage,
  SubscriptionAccepted,
  SubscriptionRequest,
} from './model';

/** A request ready to be framed. */
export type WireRequest = { method: string; params: object };

/** What the client tells the gateway about itself in the handshake. */
export type ClientHello = {
  token: string;
  minProtocol: number;
  maxProtocol: number;
  clientVersion: string;
  platform: string;
};

export interface GatewayProtocolAdapter {
  readonly version: number;
  /** Largest frame the gateway accepts before the handshake completes. */
  readonly preAuthPayloadLimitBytes: number;

  encodeRequest(id: string, request: WireRequest): string;
  /** Null for data that is not a frame of this protocol. */
  decodeFrame(data: string): InboundFrame | null;

  connectRequest(hello: ClientHello): WireRequest;
  /** The accepted handshake, or null when the payload is not a hello. */
  parseHello(payload: unknown): ConnectionAccepted | null;
  classifyRejection(error: unknown): HandshakeRejection;
  /** A handshake the gateway accepted without the grants this client needs, or null. */
  grantRejection(accepted: ConnectionAccepted): HandshakeRejection | null;
  parseRpcFailure(error: unknown): RpcFailure;
  defaultLimits(): ConnectionLimits;
  /** The operations a connection cannot serve; the chat service refuses to stream without them. */
  missingOperations(features: ConnectionFeatures): GatewayOperation[];
  /** Whether the connection advertises the wire method behind an operation. */
  supports(features: ConnectionFeatures, operation: GatewayOperation): boolean;

  sendRequest(request: SendRequest): WireRequest;
  /** Bytes one attachment adds to a serialized send request (encoding and field overhead included). */
  attachmentWireBytes(attachment: { name: string; mimeType: string; byteLength: number }): number;
  parseSendAccepted(payload: unknown): SendAccepted | null;
  abortRequest(request: AbortRequest): WireRequest;
  historyRequest(request: HistoryRequest): WireRequest;
  parseHistory(payload: unknown): HistoryRead | null;
  subscribeRequest(request: SubscriptionRequest): WireRequest;
  parseSubscription(payload: unknown): SubscriptionAccepted | null;
  unsubscribeRequest(request: SubscriptionRequest): WireRequest;
  listRequest(request: ListRequest): WireRequest;
  parseSessionList(payload: unknown): SessionListPage | null;
  /** Subscribe the connection to session index and tool events of the sessions it may read. */
  sessionEventsRequest(): WireRequest;
}
