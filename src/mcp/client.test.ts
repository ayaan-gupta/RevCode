import { describe, expect, it } from "vitest";

import { McpClient, type McpToolInfo } from "./client.js";
import { ErrorCode, McpError, type JsonRpcMessage, type JsonRpcRequest, type McpTransport } from "./types.js";
import { waitFor } from "./__fixtures__/helpers.js";

/** In-memory transport: records what the client sends, lets the test script the server. */
class FakeTransport implements McpTransport {
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: (error?: Error) => void;
  ondiagnostic?: (text: string) => void;
  sent: JsonRpcMessage[] = [];
  protocolVersion?: string;
  initializedHook = false;
  closeCalls = 0;
  /** Return messages to deliver in response to each message the client sends. */
  script: (message: JsonRpcMessage) => JsonRpcMessage[] | undefined = () => undefined;

  async start(): Promise<void> {}
  async send(message: JsonRpcMessage): Promise<void> {
    this.sent.push(message);
    const replies = this.script(message);
    if (replies) {
      queueMicrotask(() => replies.forEach((reply) => this.onmessage?.(reply)));
    }
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
    this.onclose?.();
  }
  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }
  afterInitialized(): void {
    this.initializedHook = true;
  }
  push(message: JsonRpcMessage): void {
    this.onmessage?.(message);
  }
  requests(method?: string): JsonRpcRequest[] {
    return this.sent.filter(
      (m): m is JsonRpcRequest => "method" in m && "id" in m && (method === undefined || m.method === method),
    );
  }
}

const ok = (id: string | number, result: unknown): JsonRpcMessage => ({ jsonrpc: "2.0", id, result });

/** A server script that answers initialize and tools/list from `pages`. */
function serverScript(
  transport: FakeTransport,
  options: { version?: string; pages?: McpToolInfo[][]; initResult?: unknown } = {},
): void {
  const pages = options.pages ?? [[{ name: "t1" }]];
  transport.script = (message) => {
    if (!("method" in message) || !("id" in message)) return undefined;
    const params = (message.params ?? {}) as { cursor?: string };
    switch (message.method) {
      case "initialize":
        return [
          ok(
            message.id,
            options.initResult ?? {
              protocolVersion: options.version ?? "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "fake", version: "0.1" },
            },
          ),
        ];
      case "tools/list": {
        const index = params.cursor ? Number(params.cursor) : 0;
        const next = index + 1 < pages.length ? { nextCursor: String(index + 1) } : {};
        return [ok(message.id, { tools: pages[index] ?? [], ...next })];
      }
      default:
        return undefined;
    }
  };
}

describe("McpClient handshake", () => {
  it("offers 2025-06-18, sends notifications/initialized and tells the transport the version", async () => {
    const transport = new FakeTransport();
    serverScript(transport);
    const client = new McpClient(transport, { clientInfo: { name: "rc", version: "9" } });
    const result = await client.connect();

    expect(result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "fake", version: "0.1" } });
    const init = transport.requests("initialize")[0];
    expect(init.params).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "rc", version: "9" },
    });
    expect(transport.sent.some((m) => "method" in m && m.method === "notifications/initialized" && !("id" in m))).toBe(true);
    expect(transport.protocolVersion).toBe("2025-06-18");
    expect(transport.initializedHook).toBe(true);
    await client.close();
  });

  it.each(["2025-03-26", "2024-11-05"])("accepts the older version %s the server answers with", async (version) => {
    const transport = new FakeTransport();
    serverScript(transport, { version });
    const client = new McpClient(transport);
    await client.connect();
    expect(client.protocolVersion).toBe(version);
    expect(transport.protocolVersion).toBe(version);
    await client.close();
  });

  it("accepts an unknown future version but logs it", async () => {
    const transport = new FakeTransport();
    serverScript(transport, { version: "2099-01-01" });
    const client = new McpClient(transport);
    const logs: string[] = [];
    client.on("log", (m) => logs.push(m));
    await client.connect();
    expect(client.protocolVersion).toBe("2099-01-01");
    expect(logs.join("\n")).toContain("2099-01-01");
    await client.close();
  });

  it("rejects a malformed initialize result and closes the transport", async () => {
    const transport = new FakeTransport();
    serverScript(transport, { initResult: { nope: true } });
    const client = new McpClient(transport, { label: "bad" });
    await expect(client.connect()).rejects.toThrow(/invalid initialize response/);
    await waitFor(() => transport.closeCalls === 1);
  });

  it("exposes capabilities and instructions", async () => {
    const transport = new FakeTransport();
    serverScript(transport, {
      initResult: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "n", version: "v", title: "T" },
        instructions: "be nice",
      },
    });
    const client = new McpClient(transport);
    await client.connect();
    expect(client.serverCapabilities).toEqual({ tools: { listChanged: true } });
    expect(client.instructions).toBe("be nice");
    expect(client.serverInfo).toEqual({ name: "n", version: "v", title: "T" });
    await client.close();
  });
});

describe("McpClient requests", () => {
  it("correlates concurrent requests answered out of order", async () => {
    const transport = new FakeTransport();
    const client = new McpClient(transport);
    const a = client.request("a");
    const b = client.request("b");
    const c = client.request("c");
    const [ra, rb, rc] = transport.requests();
    transport.push(ok(rc.id, "C"));
    transport.push(ok(ra.id, "A"));
    transport.push(ok(rb.id, "B"));
    expect(await Promise.all([a, b, c])).toEqual(["A", "B", "C"]);
  });

  it("maps JSON-RPC errors to McpError with the server's code", async () => {
    const transport = new FakeTransport();
    const client = new McpClient(transport);
    const pending = client.request("x");
    transport.push({ jsonrpc: "2.0", id: transport.requests()[0].id, error: { code: -32602, message: "bad params", data: { f: 1 } } });
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({ code: -32602, data: { f: 1 } });
    expect((error as Error).message).toContain("bad params");
  });

  it("times out per request, ignores the late answer, and sends notifications/cancelled", async () => {
    const transport = new FakeTransport();
    const client = new McpClient(transport, { label: "slowpoke", requestTimeoutMs: 40 });
    const pending = client.request("tools/call", { name: "x" });
    const id = transport.requests()[0].id;
    const error = await pending.catch((e: unknown) => e);
    expect(error).toMatchObject({ code: ErrorCode.RequestTimeout });
    expect((error as Error).message).toContain('"slowpoke"');
    expect((error as Error).message).toContain("40ms");
    transport.push(ok(id, "too late")); // must not throw
    await waitFor(() => transport.sent.some((m) => "method" in m && m.method === "notifications/cancelled"));
    const cancelled = transport.sent.find((m) => "method" in m && m.method === "notifications/cancelled");
    expect(cancelled).toMatchObject({ params: { requestId: id, reason: "timeout" } });
  });

  it("honours a per-call timeout over the default", async () => {
    const transport = new FakeTransport();
    const client = new McpClient(transport, { requestTimeoutMs: 60_000 });
    const started = Date.now();
    await expect(client.request("x", {}, { timeoutMs: 30 })).rejects.toThrow(/30ms/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("rejects all pending requests when the transport closes with an error", async () => {
    const transport = new FakeTransport();
    const client = new McpClient(transport);
    const closed: Array<Error | undefined> = [];
    client.on("closed", (error) => closed.push(error));
    const first = client.request("a");
    const second = client.request("b");
    transport.onclose?.(new McpError(ErrorCode.ConnectionClosed, "server died: boom"));
    await expect(first).rejects.toThrow("server died: boom");
    await expect(second).rejects.toThrow("server died: boom");
    await expect(client.request("c")).rejects.toThrow("server died: boom");
    expect(closed).toHaveLength(1);
    expect(client.isClosed).toBe(true);
  });

  it("close() rejects pending requests, closes once and is idempotent", async () => {
    const transport = new FakeTransport();
    const client = new McpClient(transport);
    const pending = client.request("a");
    const first = client.close();
    const second = client.close();
    expect(second).toBe(first);
    await first;
    await expect(pending).rejects.toMatchObject({ code: ErrorCode.ConnectionClosed });
    expect(transport.closeCalls).toBe(1);
  });

  it("rejects the request when the transport cannot send", async () => {
    const transport = new FakeTransport();
    transport.send = () => Promise.reject(new Error("socket hang up"));
    const client = new McpClient(transport);
    await expect(client.request("a")).rejects.toThrow("socket hang up");
  });

  it("tolerates string ids that echo our numeric ids", async () => {
    const transport = new FakeTransport();
    const client = new McpClient(transport);
    const pending = client.request("a");
    transport.push(ok(String(transport.requests()[0].id), "fine"));
    expect(await pending).toBe("fine");
  });

  it("ignores unmatched responses and malformed noise", async () => {
    const transport = new FakeTransport();
    const client = new McpClient(transport);
    transport.push(ok(424242, "who asked?"));
    transport.push({ jsonrpc: "2.0", id: null, error: { code: -1, message: "orphan" } });
    await client.close();
  });
});

describe("McpClient tools", () => {
  it("follows pagination cursors and de-duplicates by name", async () => {
    const transport = new FakeTransport();
    serverScript(transport, {
      pages: [[{ name: "a" }, { name: "b" }], [{ name: "b", description: "dup" }, { name: "c" }], [{ name: "d" }]],
    });
    const client = new McpClient(transport);
    await client.connect();
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["a", "b", "c", "d"]);
    expect(client.tools).toBe(tools);
    expect(
      transport.requests("tools/list").map((r) => (r.params as { cursor?: string }).cursor),
    ).toEqual([undefined, "1", "2"]);
    await client.close();
  });

  it("stops on a cursor cycle instead of looping forever", async () => {
    const transport = new FakeTransport();
    transport.script = (message) =>
      "id" in message && "method" in message && message.method === "tools/list"
        ? [ok(message.id, { tools: [{ name: "loop" }], nextCursor: "same" })]
        : undefined;
    const client = new McpClient(transport);
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["loop"]);
    expect(transport.requests("tools/list")).toHaveLength(2);
  });

  it("parses annotations and drops invalid tools", async () => {
    const transport = new FakeTransport();
    transport.script = (message) =>
      "id" in message && "method" in message
        ? [
            ok(message.id, {
              tools: [
                { name: "ro", annotations: { readOnlyHint: true, destructiveHint: "yes" }, inputSchema: { type: "object" } },
                { description: "no name" },
                "garbage",
                { name: "" },
              ],
            }),
          ]
        : undefined;
    const client = new McpClient(transport);
    expect(await client.listTools()).toEqual([
      { name: "ro", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } },
    ]);
  });

  it("sends tools/call with name and arguments and converts the result", async () => {
    const transport = new FakeTransport();
    transport.script = (message) =>
      "id" in message && "method" in message && message.method === "tools/call"
        ? [ok(message.id, { content: [{ type: "text", text: "done" }] })]
        : undefined;
    const client = new McpClient(transport);
    expect(await client.callTool("run", { n: 1 })).toEqual({ text: "done" });
    expect(transport.requests("tools/call")[0].params).toEqual({ name: "run", arguments: { n: 1 } });
  });

  it("refreshes the tool list on list_changed, coalescing bursts, and emits toolsChanged", async () => {
    const transport = new FakeTransport();
    let version = 0;
    transport.script = (message) => {
      if (!("id" in message) || !("method" in message)) return undefined;
      if (message.method === "initialize") {
        return [ok(message.id, { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "s", version: "1" } })];
      }
      if (message.method === "tools/list") {
        version += 1;
        return [ok(message.id, { tools: [{ name: `tool_v${version}` }] })];
      }
      return undefined;
    };
    const client = new McpClient(transport);
    await client.connect();
    await client.listTools();
    const seen: string[][] = [];
    client.on("toolsChanged", (tools) => seen.push(tools.map((t) => t.name)));

    const listBefore = transport.requests("tools/list").length;
    for (let i = 0; i < 5; i += 1) {
      transport.push({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
    await waitFor(() => !client.tools.some((t) => t.name === "tool_v1"));
    await waitFor(() => transport.requests("tools/list").length >= listBefore + 1);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const refreshes = transport.requests("tools/list").length - listBefore;
    expect(refreshes).toBeGreaterThanOrEqual(1);
    expect(refreshes).toBeLessThanOrEqual(2); // burst of 5 -> at most one extra pass
    expect(seen.length).toBe(refreshes);
    expect(client.tools[0].name).toBe(`tool_v${version}`);
    await client.close();
  });

  it("keeps the old tool list and logs when a refresh fails", async () => {
    const transport = new FakeTransport();
    let fail = false;
    transport.script = (message) => {
      if (!("id" in message) || !("method" in message)) return undefined;
      if (message.method === "tools/list") {
        return fail
          ? [{ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "kaput" } }]
          : [ok(message.id, { tools: [{ name: "stable" }] })];
      }
      return undefined;
    };
    const client = new McpClient(transport);
    await client.listTools();
    const logs: string[] = [];
    client.on("log", (m) => logs.push(m));
    fail = true;
    transport.push({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    await waitFor(() => logs.length > 0);
    expect(logs[0]).toContain("kaput");
    expect(client.tools.map((t) => t.name)).toEqual(["stable"]);
  });
});

describe("McpClient server-initiated requests", () => {
  it("answers ping, roots/list and unknown methods", async () => {
    const transport = new FakeTransport();
    const client = new McpClient(transport);
    transport.push({ jsonrpc: "2.0", id: "p", method: "ping" });
    transport.push({ jsonrpc: "2.0", id: 7, method: "roots/list" });
    transport.push({ jsonrpc: "2.0", id: "s", method: "sampling/createMessage", params: {} });
    await waitFor(() => transport.sent.length === 3);
    expect(transport.sent).toEqual([
      { jsonrpc: "2.0", id: "p", result: {} },
      { jsonrpc: "2.0", id: 7, result: { roots: [] } },
      { jsonrpc: "2.0", id: "s", error: { code: -32601, message: "Method not found: sampling/createMessage" } },
    ]);
    await client.close();
  });
});
