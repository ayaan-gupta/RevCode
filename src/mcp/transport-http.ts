/**
 * MCP HTTP transports: Streamable HTTP (current spec) and legacy HTTP+SSE.
 *
 * Streamable HTTP (`"type": "http"`), one endpoint URL:
 * - every JSON-RPC message is a separate `POST` with
 *   `Content-Type: application/json` and
 *   `Accept: application/json, text/event-stream`;
 * - a POSTed request is answered with either `application/json` (one body) or
 *   `text/event-stream` (events, possibly interleaved with server-initiated
 *   requests/notifications, ending after the response); notifications and our
 *   replies to server requests are answered `202 Accepted` with no body;
 * - the server may assign a session in the `Mcp-Session-Id` response header
 *   of `initialize`; we echo it on every later request and `DELETE` the
 *   endpoint when closing. After the handshake we also send the negotiated
 *   `MCP-Protocol-Version` header;
 * - optionally the client may `GET` the endpoint for a standalone SSE stream
 *   of server-initiated messages (this is how `tools/list_changed` reaches us
 *   between calls). Servers without one answer 405, which we treat as "not
 *   supported" and silently stop trying.
 *
 * Legacy SSE (`"type": "sse"`, the 2024-11-05 transport): `GET` the SSE URL;
 * the first event is `endpoint` carrying the URL to `POST` messages to, and
 * every response arrives as a `message` event on the GET stream.
 *
 * Design notes:
 * - Both classes only move messages; correlation and timeouts belong to the
 *   client. The one thing a transport must do for the client is not leave a
 *   request hanging: if a POST's event stream dies before delivering the
 *   response, we synthesize a JSON-RPC error for that request id rather than
 *   letting it sit until the (long) request timeout.
 * - When the client cancels a request (`notifications/cancelled`), we abort
 *   that request's in-flight HTTP exchange so the connection is released.
 * - Auth: OAuth is NOT supported. A `401` is reported with a message telling
 *   the user to supply a static `Authorization` (or API-key) header via the
 *   server's `headers` config. Header values are never echoed in errors and
 *   URLs are shown without query string or credentials, since either may
 *   carry secrets.
 * - Cross-origin safety (legacy SSE): the `endpoint` event may only point at
 *   the same origin as the SSE URL, otherwise a hostile server could make us
 *   send the user's configured auth headers to a third party.
 * - Not handled: automatic re-initialization after the server drops a
 *   session (HTTP 404 on a session id), stream resumption for interrupted
 *   POST responses, and proxy variables (Node's `fetch` ignores them).
 */

import { iterateSse } from "./sse.js";
import {
  ErrorCode,
  McpError,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isRecord,
  parseJsonRpcMessage,
  type JsonRpcId,
  type JsonRpcMessage,
  type McpTransport,
} from "./types.js";

type FetchFn = typeof fetch;

export interface HttpTransportOptions {
  url: string;
  /** Extra headers (e.g. Authorization). Content-Type / Accept / session headers always win. */
  headers?: Record<string, string>;
  /** Server name for error messages. */
  label?: string;
  /** Override for tests. Defaults to the global `fetch`. */
  fetch?: FetchFn;
  /** Timeout for POSTs that expect no JSON-RPC response (notifications, replies). Default 30s. */
  postTimeoutMs?: number;
  /** Legacy SSE only: how long to wait for the `endpoint` event. Default 15s. */
  connectTimeoutMs?: number;
}

const DEFAULT_POST_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DELETE_TIMEOUT_MS = 2_000;
const MAX_LISTEN_FAILURES = 3;
const DIAGNOSTICS_CHARS = 4 * 1024;

abstract class HttpTransportBase implements McpTransport {
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: (error?: Error) => void;
  ondiagnostic?: (text: string) => void;

  protected readonly url: URL;
  protected readonly label: string;
  protected readonly fetchFn: FetchFn;
  protected readonly postTimeoutMs: number;
  protected readonly closeController = new AbortController();
  protected closed = false;
  protected protocolVersion: string | undefined;
  private readonly customHeaders: Record<string, string>;
  private recent = "";

  constructor(options: HttpTransportOptions) {
    this.url = new URL(options.url);
    this.label = options.label ?? this.url.host;
    this.fetchFn = options.fetch ?? fetch;
    this.postTimeoutMs = options.postTimeoutMs ?? DEFAULT_POST_TIMEOUT_MS;
    this.customHeaders = options.headers ?? {};
  }

  abstract start(): Promise<void>;
  abstract send(message: JsonRpcMessage): Promise<void>;
  abstract close(): Promise<void>;

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  diagnostics(): string {
    return this.recent;
  }

  /** The configured headers as a case-insensitive `Headers`, ready to be overridden. */
  protected baseHeaders(): Headers {
    const headers = new Headers();
    for (const [name, value] of Object.entries(this.customHeaders)) {
      headers.set(name, value);
    }
    return headers;
  }

  protected diagnose(text: string): void {
    const combined = `${this.recent}${text}\n`;
    this.recent = combined.length > DIAGNOSTICS_CHARS ? combined.slice(-DIAGNOSTICS_CHARS) : combined;
    this.ondiagnostic?.(text);
  }

  /**
   * Parse a JSON body / SSE `data` payload (one message or a batch) and hand
   * each valid message to the client. Returns how many were delivered.
   */
  protected deliverJson(text: string, observe?: (message: JsonRpcMessage) => void): number {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.diagnose(`invalid JSON from server: ${preview(text)}`);
      return 0;
    }
    let delivered = 0;
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      const message = parseJsonRpcMessage(item);
      if (message) {
        delivered += 1;
        observe?.(message);
        this.onmessage?.(message);
      } else {
        this.diagnose(`ignoring non-JSON-RPC payload: ${preview(text)}`);
      }
    }
    return delivered;
  }

  /** Display form of the URL: no credentials, no query string (either may hold secrets). */
  protected safeUrl(url: URL = this.url): string {
    return `${url.origin}${url.pathname}`;
  }

  protected closedError(): McpError {
    return new McpError(ErrorCode.ConnectionClosed, `MCP server "${this.label}" connection closed.`);
  }

  protected networkError(error: unknown, action: string): McpError {
    if (this.closed) {
      return this.closedError();
    }
    if (isRecord(error) && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return new McpError(ErrorCode.RequestTimeout, `${action} to MCP server "${this.label}" was aborted or timed out.`);
    }
    const cause = isRecord(error) && isRecord(error.cause) ? error.cause : undefined;
    const reason =
      (cause && (typeof cause.code === "string" ? cause.code : typeof cause.message === "string" ? cause.message : undefined)) ??
      (error instanceof Error ? error.message : String(error));
    return new McpError(
      ErrorCode.ConnectionClosed,
      `Could not reach MCP server "${this.label}" at ${this.safeUrl()} (${action}): ${reason}`,
    );
  }

  /** Build an actionable error for a non-2xx response. */
  protected async httpError(res: Response, action: string, hadSession = false): Promise<McpError> {
    const body = await readPreview(res, 500);
    const detail = extractRpcMessage(body) ?? body;
    const where = this.safeUrl();
    let message: string;
    switch (res.status) {
      case 401:
        message =
          `MCP server "${this.label}" requires authentication (HTTP 401 from ${where}). ` +
          `RevCode does not support OAuth for MCP servers; if the server accepts a static token or API key, ` +
          `add it under "headers" in the server config, e.g. {"Authorization": "Bearer \${MY_TOKEN}"}.`;
        break;
      case 403:
        message = `MCP server "${this.label}" refused access (HTTP 403 from ${where}). Check the credentials in the server's "headers".`;
        break;
      case 404:
        message = hadSession
          ? `MCP server "${this.label}" no longer recognizes this session (HTTP 404); it likely restarted. Restart RevCode to reconnect.`
          : `MCP server "${this.label}" returned HTTP 404 for ${where}. Check the "url" in the server config.`;
        break;
      default:
        message = `MCP server "${this.label}" returned HTTP ${res.status} ${res.statusText} to ${action} at ${where}.`;
    }
    if (detail !== "" && res.status !== 401) {
      message += ` Response: ${detail}`;
    }
    return new McpError(ErrorCode.InternalError, message, { httpStatus: res.status });
  }
}

/** Streamable HTTP client transport. */
export class StreamableHttpTransport extends HttpTransportBase {
  private sessionId: string | undefined;
  private readonly inflight = new Map<JsonRpcId, AbortController>();
  private listening = false;
  private closePromise: Promise<void> | undefined;

  async start(): Promise<void> {
    // Stateless until the first POST; nothing to connect.
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) {
      throw this.closedError();
    }
    const requestId = isJsonRpcRequest(message) ? message.id : undefined;
    const own = new AbortController();
    const signals = [this.closeController.signal, own.signal];
    if (requestId !== undefined) {
      this.inflight.set(requestId, own);
    } else {
      signals.push(AbortSignal.timeout(this.postTimeoutMs));
      if ("method" in message && message.method === "notifications/cancelled") {
        this.abortCancelled(message.params);
      }
    }
    const release = (): void => {
      if (requestId !== undefined) {
        this.inflight.delete(requestId);
      }
    };

    const hadSession = this.sessionId !== undefined;
    const headers = this.protocolHeaders();
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json, text/event-stream");

    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      release();
      throw this.networkError(error, "POST");
    }
    const session = res.headers.get("mcp-session-id");
    if (session) {
      this.sessionId = session;
    }

    if (res.status === 202 || res.status === 204) {
      await discard(res);
      release();
      return;
    }
    if (!res.ok) {
      const error = await this.httpError(res, `POST ${describeMessage(message)}`, hadSession);
      if (res.status === 404 && hadSession) {
        this.sessionId = undefined;
      }
      release();
      throw error;
    }

    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (type.includes("text/event-stream")) {
      if (!res.body) {
        release();
        return;
      }
      void this.pumpPostStream(res.body, requestId).finally(release);
      return;
    }

    let text: string;
    try {
      text = await res.text();
    } catch (error) {
      release();
      throw this.networkError(error, "reading the response of POST");
    }
    release();
    if (requestId === undefined) {
      if (type.includes("json") && text.trim() !== "") {
        this.deliverJson(text); // some servers answer notifications with a JSON body
      }
      return;
    }
    if (this.deliverJson(text) === 0) {
      throw new McpError(
        ErrorCode.ParseError,
        `MCP server "${this.label}" answered "${describeMessage(message)}" with an unusable ${type || "untyped"} response: ${preview(text)}`,
      );
    }
  }

  /** Called by the client once the handshake is done: open the optional server->client stream. */
  afterInitialized(): void {
    if (this.listening || this.closed) {
      return;
    }
    this.listening = true;
    this.listen().catch(() => undefined);
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      // Synchronous part first: abort every in-flight exchange.
      this.closed = true;
      this.closeController.abort();
      if (this.sessionId !== undefined) {
        await this.deleteSession();
      }
      this.onclose?.();
    })();
    return this.closePromise;
  }

  // --- internals -----------------------------------------------------------

  private protocolHeaders(): Headers {
    const headers = this.baseHeaders();
    if (this.sessionId !== undefined) {
      headers.set("Mcp-Session-Id", this.sessionId);
    }
    if (this.protocolVersion !== undefined) {
      headers.set("MCP-Protocol-Version", this.protocolVersion);
    }
    return headers;
  }

  private abortCancelled(params: unknown): void {
    if (isRecord(params) && (typeof params.requestId === "string" || typeof params.requestId === "number")) {
      this.inflight.get(params.requestId)?.abort();
    }
  }

  /**
   * Consume the SSE body of a POST. If it ends without the response to
   * `requestId`, synthesize an error response so the client fails fast.
   */
  private async pumpPostStream(body: ReadableStream<Uint8Array>, requestId: JsonRpcId | undefined): Promise<void> {
    let answered = false;
    let failure: string | undefined;
    try {
      for await (const event of iterateSse(body)) {
        if (event.event !== "message") {
          continue;
        }
        this.deliverJson(event.data, (message) => {
          if (requestId !== undefined && isJsonRpcResponse(message) && message.id === requestId) {
            answered = true;
          }
        });
      }
    } catch (error) {
      failure = this.networkError(error, "reading the event stream").message;
    }
    if (requestId !== undefined && !answered && !this.closed) {
      this.onmessage?.({
        jsonrpc: "2.0",
        id: requestId,
        error: {
          code: ErrorCode.ConnectionClosed,
          message: failure ?? `MCP server "${this.label}" closed the event stream before sending a response.`,
        },
      });
    }
  }

  /** Standalone `GET` stream for server-initiated messages, with bounded reconnects. */
  private async listen(): Promise<void> {
    let failures = 0;
    let lastEventId: string | undefined;
    let retryMs = 1_000;
    while (!this.closed && failures < MAX_LISTEN_FAILURES) {
      const startedAt = Date.now();
      try {
        const headers = this.protocolHeaders();
        headers.set("Accept", "text/event-stream");
        if (lastEventId !== undefined) {
          headers.set("Last-Event-ID", lastEventId);
        }
        const res = await this.fetchFn(this.url, { method: "GET", headers, signal: this.closeController.signal });
        const type = (res.headers.get("content-type") ?? "").toLowerCase();
        if (!res.ok || !res.body || !type.includes("text/event-stream")) {
          await discard(res);
          return; // 405 and friends: this server has no standalone stream
        }
        for await (const event of iterateSse(res.body)) {
          if (event.id !== undefined) lastEventId = event.id;
          if (event.retry !== undefined) retryMs = event.retry;
          if (event.event === "message") {
            this.deliverJson(event.data);
          }
        }
      } catch (error) {
        if (this.closed) {
          return;
        }
        this.diagnose(`server event stream error: ${error instanceof Error ? error.message : String(error)}`);
      }
      failures = Date.now() - startedAt < 1_000 ? failures + 1 : 0;
      await delay(retryMs, this.closeController.signal);
    }
  }

  private async deleteSession(): Promise<void> {
    try {
      const res = await this.fetchFn(this.url, {
        method: "DELETE",
        headers: this.protocolHeaders(),
        signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
      });
      await discard(res); // 405 = server does not allow client-side termination; fine
    } catch {
      // best effort
    }
  }
}

/** Legacy HTTP+SSE client transport (protocol 2024-11-05). */
export class LegacySseTransport extends HttpTransportBase {
  private readonly connectTimeoutMs: number;
  private endpoint: URL | undefined;
  private endpointWaiter: { resolve: (url: URL) => void; reject: (error: Error) => void } | undefined;
  private streamError: Error | undefined;

  constructor(options: HttpTransportOptions) {
    super(options);
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    const headers = this.baseHeaders();
    headers.set("Accept", "text/event-stream");
    let res: Response;
    try {
      res = await this.fetchFn(this.url, { method: "GET", headers, signal: this.closeController.signal });
    } catch (error) {
      throw this.networkError(error, "GET");
    }
    if (!res.ok) {
      throw await this.httpError(res, "GET (SSE stream)");
    }
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!res.body || !type.includes("text/event-stream")) {
      await discard(res);
      throw new McpError(
        ErrorCode.InvalidRequest,
        `MCP server "${this.label}" did not return an SSE stream at ${this.safeUrl()} (content-type: ${type || "none"}). ` +
          `If this is a Streamable HTTP endpoint, set "type": "http".`,
      );
    }

    const endpoint = new Promise<URL>((resolve, reject) => {
      this.endpointWaiter = { resolve, reject };
    });
    void this.pump(res.body);
    const timer = setTimeout(() => {
      this.endpointWaiter?.reject(
        new McpError(
          ErrorCode.RequestTimeout,
          `MCP server "${this.label}" did not send an "endpoint" event within ${this.connectTimeoutMs}ms.`,
        ),
      );
    }, this.connectTimeoutMs);
    try {
      this.endpoint = await endpoint;
    } catch (error) {
      this.closeController.abort();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) {
      throw this.closedError();
    }
    if (this.streamError) {
      throw this.streamError;
    }
    if (!this.endpoint) {
      throw new McpError(ErrorCode.ConnectionClosed, `MCP server "${this.label}" has not announced a POST endpoint yet.`);
    }
    const headers = this.baseHeaders();
    headers.set("Content-Type", "application/json");
    let res: Response;
    try {
      res = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.any([this.closeController.signal, AbortSignal.timeout(this.postTimeoutMs)]),
      });
    } catch (error) {
      throw this.networkError(error, "POST");
    }
    if (!res.ok) {
      throw await this.httpError(res, `POST ${describeMessage(message)}`);
    }
    await discard(res);
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.closeController.abort();
      this.endpointWaiter?.reject(this.closedError());
      this.onclose?.();
    }
    return Promise.resolve();
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    try {
      for await (const event of iterateSse(body)) {
        if (event.event === "endpoint") {
          this.acceptEndpoint(event.data);
        } else if (event.event === "message") {
          this.deliverJson(event.data);
        }
      }
      this.streamEnded(new McpError(ErrorCode.ConnectionClosed, `MCP server "${this.label}" closed its SSE stream.`));
    } catch (error) {
      this.streamEnded(this.networkError(error, "reading the SSE stream"));
    }
  }

  private acceptEndpoint(data: string): void {
    let target: URL;
    try {
      target = new URL(data.trim(), this.url);
    } catch {
      this.endpointWaiter?.reject(
        new McpError(ErrorCode.InvalidRequest, `MCP server "${this.label}" sent an invalid endpoint: ${preview(data)}`),
      );
      return;
    }
    if (target.origin !== this.url.origin) {
      this.endpointWaiter?.reject(
        new McpError(
          ErrorCode.InvalidRequest,
          `MCP server "${this.label}" announced an endpoint on a different origin (${target.origin}); refusing to send requests there.`,
        ),
      );
      return;
    }
    this.endpointWaiter?.resolve(target);
  }

  private streamEnded(error: Error): void {
    if (this.closed) {
      return;
    }
    if (!this.endpoint) {
      this.endpointWaiter?.reject(error); // still starting up
      return;
    }
    this.streamError = error;
    this.closed = true;
    this.closeController.abort();
    this.onclose?.(error);
  }
}

/** Pick the HTTP transport for a configured `type`. */
export function createHttpTransport(kind: "http" | "sse", options: HttpTransportOptions): McpTransport {
  return kind === "sse" ? new LegacySseTransport(options) : new StreamableHttpTransport(options);
}

// --- helpers ---------------------------------------------------------------

function describeMessage(message: JsonRpcMessage): string {
  return "method" in message ? message.method : "response";
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}...` : flat;
}

/** Read up to `max` chars of a body for error messages; never throws. */
async function readPreview(res: Response, max: number): Promise<string> {
  try {
    return preview((await res.text()).slice(0, max * 4)).slice(0, max);
  } catch {
    return "";
  }
}

/** Pull `error.message` out of a JSON-RPC error body, if that is what it is. */
function extractRpcMessage(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
  } catch {
    // not JSON
  }
  return undefined;
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // already consumed
  }
}

/** Sleep that ends early (without rejecting) when `signal` aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
