/**
 * MCP client: JSON-RPC request/response correlation, the initialize
 * handshake, tool discovery and tool calls, over any `McpTransport`.
 *
 * Design notes:
 * - One client per server connection, single-use: `connect()` once, `close()`
 *   once. A dead connection stays dead (the manager reports it as failed)
 *   rather than silently reconnecting under the model's feet.
 * - Every request has a timeout. A hung server must cost the agent one tool
 *   call, never the whole turn; on timeout we also send the spec's
 *   `notifications/cancelled` so a well-behaved server stops working.
 * - Protocol versions: we offer the newest we know ("2025-06-18") and accept
 *   whatever the server answers. The `tools/*` surface we use is identical
 *   across 2024-11-05, 2025-03-26 and 2025-06-18, so strict version gating
 *   would only reject servers that would have worked. The negotiated version
 *   is handed to the transport (HTTP must echo it in a header).
 * - We advertise NO client capabilities (no roots, sampling or elicitation).
 *   A misbehaving server that sends those requests anyway gets a proper
 *   JSON-RPC error instead of silence, and `ping` / `roots/list` are
 *   answered because they are harmless and some servers call them regardless.
 * - Server-initiated work never throws into the caller: unknown methods are
 *   answered with -32601, and a failed `tools/list` refresh after
 *   `notifications/tools/list_changed` is reported on the `log` event while
 *   the previous tool list stays in effect.
 */

import { EventEmitter } from "node:events";

import { convertToolResult, type McpToolOutput } from "./tool-result.js";
import {
  ErrorCode,
  McpError,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isRecord,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpTransport,
} from "./types.js";

export const LATEST_PROTOCOL_VERSION = "2025-06-18";
/** Versions whose tools/list + tools/call behaviour we have verified. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** Upper bound on tools/list pages, so a server with a cursor cycle cannot loop forever. */
const MAX_LIST_PAGES = 100;

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

export interface McpServerInfo {
  name: string;
  version: string;
  title?: string;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: McpServerInfo;
  instructions?: string;
}

export interface McpClientOptions {
  clientInfo?: { name: string; version: string };
  /** Default per-request timeout. */
  requestTimeoutMs?: number;
  /** Server name used in error messages. */
  label?: string;
}

export interface McpRequestOptions {
  timeoutMs?: number;
}

export interface McpClientEvents {
  /** The server announced `notifications/tools/list_changed`; carries the refreshed list. */
  toolsChanged: [tools: McpToolInfo[]];
  /** The connection ended. `error` is set when it was not requested via `close()`. */
  closed: [error: Error | undefined];
  /** Diagnostics: non-fatal oddities worth showing in a debug log. */
  log: [message: string];
}

interface PendingRequest {
  method: string;
  timeoutMs: number;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class McpClient extends EventEmitter<McpClientEvents> {
  private readonly transport: McpTransport;
  private readonly label: string;
  private readonly clientInfo: { name: string; version: string };
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private nextId = 1;
  private closed = false;
  private closeError: Error | undefined;
  private closePromise: Promise<void> | undefined;
  private connectPromise: Promise<McpInitializeResult> | undefined;
  private refreshing: Promise<void> | undefined;
  private refreshAgain = false;
  private currentTools: McpToolInfo[] = [];
  private initResult: McpInitializeResult | undefined;

  constructor(transport: McpTransport, options: McpClientOptions = {}) {
    super();
    this.transport = transport;
    this.label = options.label ?? "server";
    this.clientInfo = options.clientInfo ?? { name: "revcode", version: "0.0.1" };
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    transport.onmessage = (message) => this.handleMessage(message);
    transport.onclose = (error) => this.handleClose(error);
    transport.ondiagnostic = (text) => this.emit("log", text);
  }

  /** Tools as of the last successful `listTools()` / refresh. */
  get tools(): readonly McpToolInfo[] {
    return this.currentTools;
  }

  get serverInfo(): McpServerInfo | undefined {
    return this.initResult?.serverInfo;
  }

  get serverCapabilities(): Record<string, unknown> | undefined {
    return this.initResult?.capabilities;
  }

  get instructions(): string | undefined {
    return this.initResult?.instructions;
  }

  get protocolVersion(): string | undefined {
    return this.initResult?.protocolVersion;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Recent server stderr / transport diagnostics, if the transport keeps any. */
  diagnostics(): string {
    return this.transport.diagnostics?.() ?? "";
  }

  /** Start the transport and run the initialize handshake. Closes the client on failure. */
  connect(): Promise<McpInitializeResult> {
    this.connectPromise ??= this.doConnect().catch((error: unknown) => {
      // Do not wait for a stuck child to die before reporting the failure;
      // `close()` signals it synchronously and is memoized for later awaits.
      this.close().catch(() => undefined);
      throw error;
    });
    return this.connectPromise;
  }

  /** Fetch the full tool list, following pagination cursors. */
  async listTools(options: McpRequestOptions = {}): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    const names = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const result = await this.request("tools/list", cursor === undefined ? {} : { cursor }, options);
      const record = isRecord(result) ? result : {};
      for (const raw of Array.isArray(record.tools) ? record.tools : []) {
        const tool = parseToolInfo(raw);
        if (tool && !names.has(tool.name)) {
          names.add(tool.name);
          tools.push(tool);
        }
      }
      const next = record.nextCursor;
      if (typeof next !== "string" || next === "" || seenCursors.has(next)) {
        break;
      }
      seenCursors.add(next);
      cursor = next;
    }
    this.currentTools = tools;
    return tools;
  }

  /** Call a tool and convert the result to RevCode's JSON output shape. */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    options: McpRequestOptions = {},
  ): Promise<McpToolOutput> {
    const result = await this.request("tools/call", { name, arguments: args }, options);
    return convertToolResult(result);
  }

  /** Send a request and await its result. Rejects with `McpError`. */
  request(method: string, params?: unknown, options: McpRequestOptions = {}): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(this.closeError ?? this.closedError());
    }
    const id = this.nextId;
    this.nextId += 1;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) {
          return;
        }
        reject(
          new McpError(
            ErrorCode.RequestTimeout,
            `MCP server "${this.label}" did not answer "${method}" within ${timeoutMs}ms.`,
          ),
        );
        if (method !== "initialize") {
          void this.notify("notifications/cancelled", { requestId: id, reason: "timeout" }).catch(
            () => undefined,
          );
        }
      }, timeoutMs);
      this.pending.set(id, { method, timeoutMs, timer, resolve, reject });

      const message: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      };
      this.transport.send(message).catch((error: unknown) => {
        const entry = this.pending.get(id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(id);
          entry.reject(toMcpError(error));
        }
      });
    });
  }

  /** Send a notification (no response expected). */
  notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) {
      return Promise.reject(this.closeError ?? this.closedError());
    }
    const message: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    };
    return this.transport.send(message);
  }

  /** Reject everything in flight and shut the transport down. Idempotent. */
  close(): Promise<void> {
    this.closePromise ??= this.doClose();
    return this.closePromise;
  }

  // --- internals -----------------------------------------------------------

  private async doConnect(): Promise<McpInitializeResult> {
    await this.transport.start();
    const raw = await this.request("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.clientInfo,
    });
    const result = parseInitializeResult(raw);
    if (!result) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `MCP server "${this.label}" sent an invalid initialize response.`,
      );
    }
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion)) {
      this.emit(
        "log",
        `server speaks protocol ${result.protocolVersion}, which this client has not been verified against; continuing`,
      );
    }
    this.initResult = result;
    this.transport.setProtocolVersion?.(result.protocolVersion);
    await this.notify("notifications/initialized");
    this.transport.afterInitialized?.();
    return result;
  }

  private async doClose(): Promise<void> {
    this.markClosed(undefined);
    await this.transport.close();
  }

  private closedError(): McpError {
    return new McpError(ErrorCode.ConnectionClosed, `MCP server "${this.label}" connection closed.`);
  }

  /**
   * Record that the connection is over (once), reject every pending request
   * and emit `closed`. `error` is undefined when we asked for the close.
   */
  private markClosed(error: Error | undefined): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const failure = error ? toMcpError(error) : this.closedError();
    this.closeError = failure;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(failure);
    }
    this.emit("closed", error);
  }

  private handleClose(error: Error | undefined): void {
    this.markClosed(error);
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (isJsonRpcResponse(message)) {
      this.handleResponse(message);
    } else if (isJsonRpcRequest(message)) {
      void this.handleServerRequest(message);
    } else {
      this.handleNotification(message);
    }
  }

  private handleResponse(message: JsonRpcResponse): void {
    if (message.id === null) {
      this.emit("log", `server sent a response without a request id${"error" in message ? `: ${message.error.message}` : ""}`);
      return;
    }
    // Tolerate servers that echo our numeric ids back as strings.
    const key =
      !this.pending.has(message.id) && typeof message.id === "string" && /^\d+$/.test(message.id)
        ? Number(message.id)
        : message.id;
    const entry = this.pending.get(key);
    if (!entry) {
      return; // late answer to a request that already timed out
    }
    clearTimeout(entry.timer);
    this.pending.delete(key);
    this.settle(entry, message);
  }

  private settle(entry: PendingRequest, message: JsonRpcResponse): void {
    if ("error" in message) {
      entry.reject(
        new McpError(message.error.code, `MCP error ${message.error.code}: ${message.error.message}`, message.error.data),
      );
    } else {
      entry.resolve(message.result);
    }
  }

  /** Answer requests the server sends us. We advertise no capabilities, so this is deliberately small. */
  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    let response: JsonRpcResponse;
    switch (request.method) {
      case "ping":
        response = { jsonrpc: "2.0", id: request.id, result: {} };
        break;
      case "roots/list":
        response = { jsonrpc: "2.0", id: request.id, result: { roots: [] } };
        break;
      default:
        response = {
          jsonrpc: "2.0",
          id: request.id,
          error: { code: ErrorCode.MethodNotFound, message: `Method not found: ${request.method}` },
        };
    }
    try {
      await this.transport.send(response);
    } catch (error) {
      this.emit("log", `could not answer server request "${request.method}": ${toMcpError(error).message}`);
    }
  }

  private handleNotification(message: JsonRpcNotification): void {
    if (message.method === "notifications/tools/list_changed") {
      this.scheduleToolRefresh();
    }
    // progress / logging / cancelled / resources notifications are not used.
  }

  /**
   * Refresh the tool list. Bursts of list_changed notifications are coalesced:
   * at most one refresh runs at a time, and one more runs afterwards if
   * further notifications arrived meanwhile, so we always end on fresh data.
   */
  private scheduleToolRefresh(): void {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false;
        try {
          const tools = await this.listTools();
          this.emit("toolsChanged", tools);
        } catch (error) {
          this.emit("log", `tools/list refresh failed: ${toMcpError(error).message}`);
        }
      } while (this.refreshAgain && !this.closed);
    })().finally(() => {
      this.refreshing = undefined;
    });
  }
}

function toMcpError(error: unknown): McpError {
  if (error instanceof McpError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new McpError(ErrorCode.ConnectionClosed, message);
}

function parseInitializeResult(raw: unknown): McpInitializeResult | undefined {
  if (!isRecord(raw) || typeof raw.protocolVersion !== "string" || raw.protocolVersion === "") {
    return undefined;
  }
  const info = isRecord(raw.serverInfo) ? raw.serverInfo : {};
  return {
    protocolVersion: raw.protocolVersion,
    capabilities: isRecord(raw.capabilities) ? raw.capabilities : {},
    serverInfo: {
      name: typeof info.name === "string" ? info.name : "unknown",
      version: typeof info.version === "string" ? info.version : "unknown",
      ...(typeof info.title === "string" ? { title: info.title } : {}),
    },
    ...(typeof raw.instructions === "string" ? { instructions: raw.instructions } : {}),
  };
}

function parseToolInfo(raw: unknown): McpToolInfo | undefined {
  if (!isRecord(raw) || typeof raw.name !== "string" || raw.name === "") {
    return undefined;
  }
  const annotations = isRecord(raw.annotations) ? parseAnnotations(raw.annotations) : undefined;
  return {
    name: raw.name,
    ...(typeof raw.title === "string" ? { title: raw.title } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(isRecord(raw.inputSchema) ? { inputSchema: raw.inputSchema } : {}),
    ...(annotations ? { annotations } : {}),
  };
}

function parseAnnotations(raw: Record<string, unknown>): McpToolAnnotations {
  const out: McpToolAnnotations = {};
  if (typeof raw.title === "string") out.title = raw.title;
  if (typeof raw.readOnlyHint === "boolean") out.readOnlyHint = raw.readOnlyHint;
  if (typeof raw.destructiveHint === "boolean") out.destructiveHint = raw.destructiveHint;
  if (typeof raw.idempotentHint === "boolean") out.idempotentHint = raw.idempotentHint;
  if (typeof raw.openWorldHint === "boolean") out.openWorldHint = raw.openWorldHint;
  return out;
}
