import http, { type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { McpClient } from "./client.js";
import type { McpServerConfig } from "./config.js";
import { McpManager } from "./manager.js";
import { LegacySseTransport, StreamableHttpTransport } from "./transport-http.js";
import { waitFor } from "./__fixtures__/helpers.js";

// --- a tiny in-process MCP server speaking Streamable HTTP --------------------

interface Recorded {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body?: Record<string, unknown>;
}

interface MockOptions {
  /** How POSTed requests are answered. */
  mode: "json" | "sse" | "sse-drop";
  /** Assign this session id on initialize and require it afterwards. */
  sessionId?: string;
  /** Require `Authorization: <value>`; otherwise answer 401. */
  authorization?: string;
  /** Serve a standalone GET event stream (otherwise 405). */
  getStream?: boolean;
}

interface MockServer {
  url: string;
  requests: Recorded[];
  tools: Array<Record<string, unknown>>;
  streams: ServerResponse[];
  /** Ids of requests whose HTTP connection was closed before the server answered. */
  abortedIds: unknown[];
  /** Make the server answer every later request with 404 (as if the session was dropped). */
  breakSession(): void;
  close(): Promise<void>;
}

const servers: Server[] = [];
const managers: McpManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const frame = (message: unknown, event = "message"): string =>
  `event: ${event}\ndata: ${JSON.stringify(message)}\n\n`;

function defaultTools(): Array<Record<string, unknown>> {
  return [
    {
      name: "echo",
      description: "Echo text.",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      annotations: { readOnlyHint: true },
    },
    { name: "fail", inputSchema: { type: "object", properties: {} } },
    { name: "probe", inputSchema: { type: "object", properties: {} } },
    { name: "boom", inputSchema: { type: "object", properties: {} } },
  ];
}

/** Compute the JSON-RPC result for one request (shared by the HTTP and legacy-SSE mocks). */
function handleRpc(
  message: Record<string, unknown>,
  tools: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const id = message.id;
  const params = (message.params ?? {}) as Record<string, unknown>;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  switch (message.method) {
    case "initialize":
      return ok({
        protocolVersion: params.protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "http-mock", version: "9.9.9" },
      });
    case "ping":
      return ok({});
    case "tools/list": {
      const start = params.cursor ? Number(params.cursor) : 0;
      const page = tools.slice(start, start + 3);
      return ok(start + 3 < tools.length ? { tools: page, nextCursor: String(start + 3) } : { tools: page });
    }
    case "tools/call": {
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (params.name === "echo") return ok({ content: [{ type: "text", text: `echo: ${String(args.text)}` }] });
      if (params.name === "fail") return ok({ isError: true, content: [{ type: "text", text: "nope" }] });
      return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${String(params.name)}` } };
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(message.method)}` } };
  }
}

async function startMockHttp(options: MockOptions): Promise<MockServer> {
  const requests: Recorded[] = [];
  const tools = defaultTools();
  const streams: ServerResponse[] = [];
  const awaitingReplies = new Map<string, () => void>();
  const abortedIds: unknown[] = [];
  let broken = false;

  const server = http.createServer(async (req, res) => {
    const text = await readBody(req);
    const record: Recorded = { method: req.method ?? "", path: req.url ?? "", headers: req.headers };
    if (text) record.body = JSON.parse(text) as Record<string, unknown>;
    requests.push(record);

    if (broken) {
      res.writeHead(404, { "Content-Type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } }),
      );
      return;
    }
    if (options.authorization !== undefined && req.headers.authorization !== options.authorization) {
      res.writeHead(401, { "WWW-Authenticate": 'Bearer realm="mock"' }).end("unauthorized");
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    if (req.method === "GET") {
      if (!options.getStream) {
        res.writeHead(405).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(": stream open\n\n");
      streams.push(res);
      return;
    }

    const message = record.body;
    if (!message) {
      res.writeHead(400).end();
      return;
    }
    if (options.sessionId && message.method !== "initialize" && req.headers["mcp-session-id"] !== options.sessionId) {
      res.writeHead(404, { "Content-Type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } }),
      );
      return;
    }

    // Client -> server notification or response: acknowledge.
    if (message.method === undefined || message.id === undefined) {
      if (message.method === undefined && typeof message.id === "string") awaitingReplies.get(message.id)?.();
      res.writeHead(202).end();
      return;
    }

    if (message.method === "slow/never") {
      // Never answered; note when the client gives up and drops the connection.
      res.on("close", () => {
        if (!res.writableEnded) abortedIds.push(message.id);
      });
      return;
    }

    const params = (message.params ?? {}) as Record<string, unknown>;
    const extraHeaders: Record<string, string> =
      options.sessionId && message.method === "initialize" ? { "Mcp-Session-Id": options.sessionId } : {};

    if (options.mode === "json") {
      const response = handleRpc(message, tools);
      res.writeHead(200, { "Content-Type": "application/json", ...extraHeaders }).end(JSON.stringify(response));
      return;
    }

    // SSE answer
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...extraHeaders });
    res.write(frame({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "working" } }));
    if (options.mode === "sse-drop" && params.name === "boom") {
      res.end(); // close the stream without ever answering
      return;
    }
    if (message.method === "tools/call" && params.name === "probe") {
      // Server-initiated request inside the response stream; wait for the client's reply POST.
      await new Promise<void>((resolve) => {
        awaitingReplies.set("srv-1", resolve);
        res.write(frame({ jsonrpc: "2.0", id: "srv-1", method: "ping" }));
      });
      res.write(frame({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "probe ok" }] } }));
      res.end();
      return;
    }
    const encoded = frame(handleRpc(message, tools));
    const cut = Math.floor(encoded.length / 2);
    res.write(encoded.slice(0, cut)); // split mid-event to exercise the parser
    setTimeout(() => res.end(encoded.slice(cut)), 5);
  });

  const url = await listen(server);
  return {
    url: `${url}/mcp`,
    requests,
    tools,
    streams,
    abortedIds,
    breakSession: () => {
      broken = true;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function httpConfig(name: string, url: string, headers: Record<string, string> = {}, type: "http" | "sse" = "http"): McpServerConfig {
  return { type, name, url, headers, disabled: false, source: "test" };
}

function makeManager(servers: McpServerConfig[]): McpManager {
  const manager = new McpManager({ servers }, { startupTimeoutMs: 3_000, requestTimeoutMs: 3_000 });
  managers.push(manager);
  return manager;
}

async function callTool(manager: McpManager, name: string, input: unknown = {}): Promise<unknown> {
  const tool = manager.tools().find((candidate) => candidate.definition.name === name);
  if (!tool) throw new Error(`no tool ${name}; have ${manager.tools().map((t) => t.definition.name).join(", ")}`);
  return tool.handler(input);
}

// --- tests ---------------------------------------------------------------------

describe("Streamable HTTP transport", () => {
  for (const mode of ["json", "sse"] as const) {
    it(`handshakes, lists (paginated) and calls tools with ${mode} responses`, async () => {
      const mock = await startMockHttp({ mode, sessionId: "sess-123" });
      const manager = makeManager([httpConfig("web", mock.url, { "X-Api-Key": "abc" })]);
      await manager.start();

      expect(manager.statuses()[0]).toMatchObject({
        name: "web",
        state: "connected",
        toolCount: 4,
        transport: "http",
        serverInfo: { name: "http-mock", version: "9.9.9" },
      });
      expect(manager.readOnlyToolNames()).toEqual(["mcp__web__echo"]);
      expect(await callTool(manager, "mcp__web__echo", { text: "hi" })).toEqual({ text: "echo: hi" });
      expect(await callTool(manager, "mcp__web__fail")).toEqual({ error: "nope" });

      const posts = mock.requests.filter((r) => r.method === "POST");
      const [init, initialized, ...rest] = posts;
      expect(init.body?.method).toBe("initialize");
      expect(init.headers["content-type"]).toContain("application/json");
      expect(init.headers.accept).toBe("application/json, text/event-stream");
      expect(init.headers["x-api-key"]).toBe("abc"); // custom headers are sent
      expect(init.headers["mcp-session-id"]).toBeUndefined();
      expect(init.headers["mcp-protocol-version"]).toBeUndefined();

      // After initialize every request carries the session and negotiated version.
      expect(initialized.body?.method).toBe("notifications/initialized");
      for (const post of [initialized, ...rest]) {
        expect(post.headers["mcp-session-id"]).toBe("sess-123");
        expect(post.headers["mcp-protocol-version"]).toBe("2025-06-18");
        expect(post.headers["x-api-key"]).toBe("abc");
      }
      // Pagination: two tools/list calls, the second with a cursor.
      const lists = posts.filter((r) => r.body?.method === "tools/list");
      expect(lists.map((r) => (r.body?.params as Record<string, unknown>).cursor)).toEqual([undefined, "3"]);

      // Disposing terminates the session.
      await manager.dispose();
      const del = mock.requests.find((r) => r.method === "DELETE");
      expect(del?.headers["mcp-session-id"]).toBe("sess-123");
    });
  }

  it("works against a server that does not use sessions and sends no DELETE", async () => {
    const mock = await startMockHttp({ mode: "json" });
    const manager = makeManager([httpConfig("web", mock.url)]);
    await manager.start();
    expect(manager.statuses()[0].state).toBe("connected");
    await manager.dispose();
    expect(mock.requests.some((r) => r.method === "DELETE")).toBe(false);
    expect(mock.requests.every((r) => r.headers["mcp-session-id"] === undefined)).toBe(true);
  });

  it("answers server requests that arrive inside an SSE response stream", async () => {
    const mock = await startMockHttp({ mode: "sse" });
    const manager = makeManager([httpConfig("web", mock.url)]);
    await manager.start();
    expect(await callTool(manager, "mcp__web__probe")).toEqual({ text: "probe ok" });
    const reply = mock.requests.find((r) => r.body?.id === "srv-1" && r.body?.method === undefined);
    expect(reply?.body).toEqual({ jsonrpc: "2.0", id: "srv-1", result: {} });
  });

  it("fails a request fast when its event stream ends without a response", async () => {
    const mock = await startMockHttp({ mode: "sse-drop" });
    const manager = makeManager([httpConfig("web", mock.url)]);
    await manager.start();
    const started = Date.now();
    const result = (await callTool(manager, "mcp__web__boom")) as { error: string };
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(result.error).toContain("closed the event stream before sending a response");
  });

  it("reports 401 with guidance and never leaks header values", async () => {
    const mock = await startMockHttp({ mode: "json", authorization: "Bearer right-token" });
    const manager = makeManager([httpConfig("secure", mock.url, { Authorization: "Bearer wrong-token-xyz" })]);
    await manager.start();
    const [status] = manager.statuses();
    expect(status.state).toBe("failed");
    expect(status.error).toContain("requires authentication (HTTP 401");
    expect(status.error).toContain("OAuth");
    expect(status.error).toContain('"headers"');
    expect(status.error).not.toContain("wrong-token-xyz");
  });

  it("connects when the right Authorization header is configured", async () => {
    const mock = await startMockHttp({ mode: "json", authorization: "Bearer right-token" });
    const manager = makeManager([httpConfig("secure", mock.url, { Authorization: "Bearer right-token" })]);
    await manager.start();
    expect(manager.statuses()[0].state).toBe("connected");
  });

  it("reports an unreachable server without exposing the query string", async () => {
    const mock = await startMockHttp({ mode: "json" });
    const dead = new URL(mock.url);
    await mock.close();
    const manager = makeManager([httpConfig("gone", `${dead.origin}/mcp?key=SECRET`)]);
    await manager.start();
    const [status] = manager.statuses();
    expect(status.state).toBe("failed");
    expect(status.error).toContain("Could not reach MCP server");
    expect(status.error).toContain("ECONNREFUSED");
    expect(status.error).not.toContain("SECRET");
  });

  it("turns tool-call HTTP errors into { error } results", async () => {
    const mock = await startMockHttp({ mode: "json", sessionId: "s1" });
    const manager = makeManager([httpConfig("web", mock.url)]);
    await manager.start();
    mock.breakSession(); // e.g. the server restarted and forgot the session
    const result = (await callTool(manager, "mcp__web__echo", { text: "x" })) as { error: string };
    expect(result.error).toContain("no longer recognizes this session");
  });

  it("receives tools/list_changed over the standalone GET stream", async () => {
    const mock = await startMockHttp({ mode: "json", getStream: true });
    const manager = makeManager([httpConfig("web", mock.url)]);
    await manager.start();
    await waitFor(() => mock.streams.length === 1);
    expect(mock.requests.find((r) => r.method === "GET")?.headers.accept).toBe("text/event-stream");

    let notified = 0;
    manager.onToolsChanged(() => {
      notified += 1;
    });
    mock.tools.push({ name: "late", description: "Added later", inputSchema: { type: "object", properties: {} } });
    mock.streams[0].write(frame({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }));

    await waitFor(() => manager.tools().some((tool) => tool.definition.name === "mcp__web__late"));
    expect(notified).toBeGreaterThanOrEqual(1);
    expect(manager.statuses()[0].toolCount).toBe(5);
  });

  it("on request timeout, sends notifications/cancelled and drops the HTTP exchange", async () => {
    const mock = await startMockHttp({ mode: "json" });
    const transport = new StreamableHttpTransport({ url: mock.url, label: "web" });
    const client = new McpClient(transport, { label: "web", requestTimeoutMs: 100 });
    await client.connect();
    await expect(client.request("slow/never")).rejects.toThrow(/did not answer "slow\/never" within 100ms/);

    await waitFor(() => mock.abortedIds.length === 1);
    const cancelled = mock.requests.find((r) => r.body?.method === "notifications/cancelled");
    expect(cancelled?.body?.params).toMatchObject({ reason: "timeout", requestId: mock.abortedIds[0] });
    await client.close();
  });
});

// --- legacy HTTP+SSE ---------------------------------------------------------------

interface LegacyMockOptions {
  endpoint?: (origin: string) => string | undefined;
  contentType?: string;
}

async function startLegacyMock(options: LegacyMockOptions = {}): Promise<{ url: string; requests: Recorded[]; close(): Promise<void> }> {
  const requests: Recorded[] = [];
  const tools = defaultTools();
  let stream: ServerResponse | undefined;
  let origin = "";

  const server = http.createServer(async (req, res) => {
    const text = await readBody(req);
    const record: Recorded = { method: req.method ?? "", path: req.url ?? "", headers: req.headers };
    if (text) record.body = JSON.parse(text) as Record<string, unknown>;
    requests.push(record);

    if (req.method === "GET" && req.url === "/sse") {
      res.writeHead(200, { "Content-Type": options.contentType ?? "text/event-stream", "Cache-Control": "no-cache" });
      stream = res;
      const endpoint = options.endpoint ? options.endpoint(origin) : "/messages?sessionId=abc";
      if (endpoint !== undefined) res.write(`event: endpoint\ndata: ${endpoint}\n\n`);
      else res.write(": no endpoint\n\n");
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/messages")) {
      res.writeHead(202).end("Accepted");
      const message = record.body;
      if (message && message.method !== undefined && message.id !== undefined) {
        stream?.write(frame(handleRpc(message, tools)));
      }
      return;
    }
    res.writeHead(404).end();
  });
  origin = await listen(server);
  return { url: `${origin}/sse`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("legacy SSE transport", () => {
  it("connects through the announced endpoint and exchanges messages", async () => {
    const mock = await startLegacyMock();
    const manager = makeManager([httpConfig("legacy", mock.url, { "X-Api-Key": "k" }, "sse")]);
    await manager.start();
    expect(manager.statuses()[0]).toMatchObject({ state: "connected", toolCount: 4, transport: "sse" });
    expect(await callTool(manager, "mcp__legacy__echo", { text: "legacy" })).toEqual({ text: "echo: legacy" });

    const get = mock.requests.find((r) => r.method === "GET");
    expect(get?.headers.accept).toBe("text/event-stream");
    expect(get?.headers["x-api-key"]).toBe("k");
    const posts = mock.requests.filter((r) => r.method === "POST");
    expect(posts.length).toBeGreaterThanOrEqual(4);
    for (const post of posts) {
      expect(post.path).toBe("/messages?sessionId=abc");
      expect(post.headers["content-type"]).toContain("application/json");
      expect(post.headers["x-api-key"]).toBe("k");
    }
  });

  it("accepts an absolute same-origin endpoint", async () => {
    const mock = await startLegacyMock({ endpoint: (origin) => `${origin}/messages?sessionId=abs` });
    const manager = makeManager([httpConfig("legacy", mock.url, {}, "sse")]);
    await manager.start();
    expect(manager.statuses()[0].state).toBe("connected");
    expect(mock.requests.some((r) => r.method === "POST" && r.path.endsWith("sessionId=abs"))).toBe(true);
  });

  it("refuses an endpoint on another origin", async () => {
    const mock = await startLegacyMock({ endpoint: () => "http://evil.example.com/collect" });
    const manager = makeManager([httpConfig("legacy", mock.url, { Authorization: "Bearer secret" }, "sse")]);
    await manager.start();
    const [status] = manager.statuses();
    expect(status.state).toBe("failed");
    expect(status.error).toContain("different origin");
    expect(mock.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("times out when the server never announces an endpoint", async () => {
    const mock = await startLegacyMock({ endpoint: () => undefined });
    const transport = new LegacySseTransport({ url: mock.url, label: "legacy", connectTimeoutMs: 100 });
    await expect(transport.start()).rejects.toThrow(/did not send an "endpoint" event within 100ms/);
    await transport.close();
  });

  it("explains when the URL is not an SSE endpoint", async () => {
    const mock = await startLegacyMock({ contentType: "application/json" });
    const transport = new LegacySseTransport({ url: mock.url, label: "legacy" });
    await expect(transport.start()).rejects.toThrow(/did not return an SSE stream.*"type": "http"/);
    await transport.close();
  });
});
