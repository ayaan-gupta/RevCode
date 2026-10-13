/**
 * Shared wire types for the MCP client: JSON-RPC 2.0 envelopes, the error
 * type used for every failure surfaced to callers, and the `McpTransport`
 * contract that the stdio and HTTP transports implement.
 *
 * Design notes:
 * - The transport contract is deliberately tiny and message-oriented
 *   (`send` + `onmessage`). Everything protocol-shaped — request/response
 *   correlation, timeouts, the initialize handshake — lives in the client, so
 *   a transport only has to move JSON objects. That is what lets one client
 *   serve a child process, a Streamable HTTP endpoint, and a legacy SSE
 *   endpoint without branching on transport kind.
 * - Everything arriving from a server is untrusted. `parseJsonRpcMessage`
 *   validates the envelope shape once, at the transport boundary, so the
 *   client can work with precise types afterwards.
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** JSON-RPC / MCP error codes the client produces or inspects. */
export const ErrorCode = {
  ConnectionClosed: -32000,
  RequestTimeout: -32001,
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/**
 * Every MCP failure — a JSON-RPC error from the server, a request timeout, a
 * dead connection, an HTTP status — is an `McpError`, so callers have one type
 * to catch and one `code` to switch on.
 */
export class McpError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.data = data;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when the message is a response (success or error) rather than a request/notification. */
export function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return !("method" in message);
}

export function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "method" in message && "id" in message;
}

/**
 * Validate an untrusted value as a JSON-RPC 2.0 envelope. Returns `undefined`
 * for anything that is not one (the caller decides whether to log it).
 */
export function parseJsonRpcMessage(value: unknown): JsonRpcMessage | undefined {
  if (!isRecord(value) || value.jsonrpc !== "2.0") {
    return undefined;
  }
  const id = value.id;
  const hasId = typeof id === "string" || typeof id === "number";
  if (typeof value.method === "string") {
    if (hasId) {
      return { jsonrpc: "2.0", id, method: value.method, params: value.params };
    }
    if (id === undefined) {
      return { jsonrpc: "2.0", method: value.method, params: value.params };
    }
    return undefined;
  }
  if (isRecord(value.error) && typeof value.error.message === "string") {
    const code = typeof value.error.code === "number" ? value.error.code : ErrorCode.InternalError;
    return {
      jsonrpc: "2.0",
      id: hasId ? id : null,
      error: { code, message: value.error.message, data: value.error.data },
    };
  }
  if (hasId && "result" in value) {
    return { jsonrpc: "2.0", id, result: value.result };
  }
  return undefined;
}

/**
 * What the client needs from a transport. Implementations are single-use:
 * `start()` once, `close()` once (idempotent), never restart.
 */
export interface McpTransport {
  /** Every well-formed JSON-RPC message received from the server. */
  onmessage?: (message: JsonRpcMessage) => void;
  /**
   * Fired once when the connection is gone. `error` is set when it was
   * unexpected (process crash, dropped stream) and carries a human-readable
   * explanation; it is undefined for a close we initiated.
   */
  onclose?: (error?: Error) => void;
  /** Non-fatal oddities (non-JSON on stdout, malformed SSE data) for logs. */
  ondiagnostic?: (text: string) => void;

  /** Spawn the process / open the stream. Rejects with an actionable error. */
  start(): Promise<void>;
  /** Deliver one message to the server. Rejects if it could not be delivered. */
  send(message: JsonRpcMessage): Promise<void>;
  /** Stop everything and release resources. Safe to call repeatedly. */
  close(): Promise<void>;

  /** Negotiated protocol version, for transports that must echo it (HTTP). */
  setProtocolVersion?(version: string): void;
  /** Called once the initialize handshake has completed. */
  afterInitialized?(): void;
  /** Recent server stderr / diagnostics, for error messages and `/mcp` output. */
  diagnostics?(): string;
}
