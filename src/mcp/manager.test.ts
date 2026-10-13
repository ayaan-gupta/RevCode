import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { McpServerConfig } from "./config.js";
import { McpManager, truncateMiddle, type McpManagerOptions } from "./manager.js";
import { StdioTransport } from "./transport-stdio.js";
import { MOCK_TOOL_COUNT, isAlive, mockStdioConfig, waitFor } from "./__fixtures__/helpers.js";

const managers: McpManager[] = [];

function makeManager(
  servers: McpServerConfig[],
  options: McpManagerOptions = {},
  warnings: string[] = [],
): McpManager {
  const manager = new McpManager({ servers, warnings }, options);
  managers.push(manager);
  return manager;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
});

type ToolMap = Map<string, (input: unknown) => Promise<unknown>>;

function toolMap(manager: McpManager): ToolMap {
  return new Map(manager.tools().map((tool) => [tool.definition.name, tool.handler]));
}

async function call(manager: McpManager, name: string, input: unknown = {}): Promise<unknown> {
  const handler = toolMap(manager).get(name);
  if (!handler) {
    throw new Error(`tool ${name} not registered; have ${[...toolMap(manager).keys()].join(", ")}`);
  }
  return handler(input);
}

describe("McpManager over stdio", () => {
  it("connects, paginates tools/list and exposes prefixed, sanitized tools", async () => {
    const manager = makeManager([mockStdioConfig("mock")]);
    await manager.start();

    expect(manager.statuses()).toMatchObject([
      { name: "mock", state: "connected", toolCount: MOCK_TOOL_COUNT, transport: "stdio", serverInfo: { name: "mock", version: "1.2.3" } },
    ]);

    const names = manager.tools().map((tool) => tool.definition.name);
    expect(names).toContain("mcp__mock__echo");
    expect(names).toContain("mcp__mock__dotted_name"); // "dotted.name" sanitized
    expect(names).toContain("mcp__mock__add_tool");
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }

    const echo = manager.tools().find((tool) => tool.definition.name === "mcp__mock__echo");
    expect(echo?.definition.description).toBe("[MCP:mock] Echo the text back.");
    expect(echo?.definition.parameters).toEqual({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    }); // $schema stripped
    expect(echo?.definition.parameters).not.toHaveProperty("$schema");

    const noSchema = manager.tools().find((tool) => tool.definition.name === "mcp__mock__no_schema");
    expect(noSchema?.definition.parameters).toEqual({ type: "object", properties: {} });
  });

  it("reports readOnlyHint tools only", async () => {
    const manager = makeManager([mockStdioConfig("mock")]);
    await manager.start();
    expect(manager.readOnlyToolNames()).toEqual(["mcp__mock__echo"]);
  });

  it("calls tools and converts results", async () => {
    const manager = makeManager([mockStdioConfig("mock")]);
    await manager.start();

    expect(await call(manager, "mcp__mock__echo", { text: "hi" })).toEqual({ text: "echo: hi" });
    expect(await call(manager, "mcp__mock__add", { a: 1, b: 2 })).toEqual({
      text: "The sum is 3",
      structured: { sum: 3 },
    });
    expect(await call(manager, "mcp__mock__fail")).toEqual({ error: "something went wrong" });
    expect(await call(manager, "mcp__mock__image")).toEqual({
      text: "here is an image\n[image: image/png, 20 bytes base64 omitted]",
    });
    expect(await call(manager, "mcp__mock__dotted_name")).toEqual({ text: "dotted ok" });
  });

  it("treats null/undefined/non-object input as no arguments", async () => {
    const manager = makeManager([mockStdioConfig("mock")]);
    await manager.start();
    expect(await call(manager, "mcp__mock__pid", undefined)).toMatchObject({ text: expect.stringMatching(/^\d+$/) });
    expect(await call(manager, "mcp__mock__pid", null)).toMatchObject({ text: expect.stringMatching(/^\d+$/) });
  });

  it("truncates oversized results keeping head and tail", async () => {
    const manager = makeManager([mockStdioConfig("mock")]);
    await manager.start();
    const result = (await call(manager, "mcp__mock__big", { chars: 100_000 })) as { text: string };
    expect(result.text.length).toBeLessThanOrEqual(30_000);
    expect(result.text).toContain("characters truncated by RevCode");
    expect(result.text.startsWith("abcdefghij")).toBe(true);
    expect(result.text.endsWith("abcdefghij")).toBe(true);

    const small = (await call(manager, "mcp__mock__big", { chars: 29_999 })) as { text: string };
    expect(small.text.length).toBe(29_999);
    expect(small.text).not.toContain("truncated");
  });

  it("returns { error } for server-side JSON-RPC errors instead of throwing", async () => {
    const manager = makeManager([mockStdioConfig("mock")]);
    await manager.start();
    const result = (await call(manager, "mcp__mock__ghost")) as { error: string };
    expect(result.error).toContain('MCP tool "ghost" on server "mock" failed');
    expect(result.error).toContain("-32602");
    expect(result.error).toContain("Unknown tool: ghost");
  });

  it("answers server->client requests (ping, roots/list, unknown methods)", async () => {
    const manager = makeManager([mockStdioConfig("mock")]);
    await manager.start();
    const result = (await call(manager, "mcp__mock__probe")) as { text: string };
    expect(JSON.parse(result.text)).toEqual({ ping: {}, roots: { roots: [] }, unknown: -32601 });
  });

  it("times out slow tool calls with the configured per-server timeout", async () => {
    const manager = makeManager([mockStdioConfig("mock", {}, { timeoutMs: 150 })]);
    await manager.start();
    const started = Date.now();
    const result = (await call(manager, "mcp__mock__slow", { ms: 5_000 })) as { error: string };
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.error).toContain("within 150ms");
    // The connection is still usable afterwards.
    expect(await call(manager, "mcp__mock__echo", { text: "still alive" })).toEqual({ text: "echo: still alive" });
  });

  it("tolerates older protocol versions", async () => {
    const manager = makeManager([mockStdioConfig("old", { MOCK_PROTOCOL_VERSION: "2024-11-05" })]);
    await manager.start();
    expect(manager.statuses()[0].state).toBe("connected");
    expect(await call(manager, "mcp__old__echo", { text: "v" })).toEqual({ text: "echo: v" });
  });

  it("tolerates non-JSON noise on stdout", async () => {
    const manager = makeManager([mockStdioConfig("noisy", { MOCK_STDOUT_NOISE: "1" })]);
    await manager.start();
    expect(manager.statuses()[0].state).toBe("connected");
    expect(manager.diagnostics("noisy")).toContain("non-JSON on stdout");
  });

  it("treats a server without tools support as connected with zero tools", async () => {
    const manager = makeManager([mockStdioConfig("empty", { MOCK_NO_TOOLS: "1" })]);
    await manager.start();
    expect(manager.statuses()[0]).toMatchObject({ state: "connected", toolCount: 0 });
    expect(manager.tools()).toEqual([]);
  });

  it("exposes server instructions", async () => {
    const manager = makeManager([mockStdioConfig("mock")]);
    await manager.start();
    expect(manager.instructions()).toEqual([{ server: "mock", instructions: "Use the mock tools wisely." }]);
  });

  it("refreshes tools on tools/list_changed and notifies listeners", async () => {
    const manager = makeManager([mockStdioConfig("mock")]);
    await manager.start();
    let notifications = 0;
    manager.onToolsChanged(() => {
      notifications += 1;
    });
    expect(toolMap(manager).has("mcp__mock__added_later")).toBe(false);

    await call(manager, "mcp__mock__add_tool");
    await waitFor(() => toolMap(manager).has("mcp__mock__added_later"));
    expect(notifications).toBeGreaterThanOrEqual(1);
    expect(manager.statuses()[0].toolCount).toBe(MOCK_TOOL_COUNT + 1);
    expect(await call(manager, "mcp__mock__added_later")).toEqual({ text: "added_later ok" });
  });
});

describe("McpManager startup and failures", () => {
  it("starts servers concurrently and isolates failures", async () => {
    const manager = makeManager(
      [
        mockStdioConfig("good"),
        mockStdioConfig("hangs", { MOCK_HANG_ON_INIT: "1" }, { startupTimeoutMs: 400 }),
        mockStdioConfig("missing", {}, { command: "/definitely/not/a/real/binary-xyz", args: [] }),
        mockStdioConfig("exits", { MOCK_EXIT_ON_START: "1" }),
        mockStdioConfig("off", {}, { disabled: true }),
        mockStdioConfig("badenv", {}, { error: "environment variable TOKEN not set" }),
      ],
      { startupTimeoutMs: 5_000 },
    );
    const started = Date.now();
    await manager.start();
    const elapsed = Date.now() - started;

    // Bounded by the slowest per-server timeout (400ms) plus spawn overhead, not their sum.
    expect(elapsed).toBeLessThan(3_000);

    const byName = Object.fromEntries(manager.statuses().map((s) => [s.name, s]));
    expect(byName.good).toMatchObject({ state: "connected", toolCount: MOCK_TOOL_COUNT });
    expect(byName.hangs.state).toBe("failed");
    expect(byName.hangs.error).toContain("Startup timed out after 400ms");
    expect(byName.missing.state).toBe("failed");
    expect(byName.missing.error).toContain("was not found");
    expect(byName.exits.state).toBe("failed");
    expect(byName.off).toMatchObject({ state: "disabled", toolCount: 0 });
    expect(byName.badenv).toMatchObject({ state: "failed", error: "environment variable TOKEN not set" });

    // Only the good server's tools are exposed.
    expect(manager.tools().every((tool) => tool.definition.name.startsWith("mcp__good__"))).toBe(true);
  });

  it("includes the stderr tail when a server exits during startup", async () => {
    const manager = makeManager([mockStdioConfig("exits", { MOCK_EXIT_ON_START: "1" })]);
    await manager.start();
    const [status] = manager.statuses();
    expect(status.state).toBe("failed");
    expect(status.error).toContain("exited unexpectedly with code 3");
    expect(status.error).toContain("boom: missing API key");
  });

  it("reports a crash mid-call with the stderr tail and marks the server failed", async () => {
    const manager = makeManager([mockStdioConfig("mock")]);
    await manager.start();
    let notified = false;
    manager.onToolsChanged(() => {
      notified = true;
    });
    const echo = toolMap(manager).get("mcp__mock__echo")!;

    const result = (await call(manager, "mcp__mock__crash")) as { error: string };
    expect(result.error).toContain("exited unexpectedly with code 7");
    expect(result.error).toContain("fatal: the crash tool was invoked");

    await waitFor(() => manager.statuses()[0].state === "failed");
    expect(manager.statuses()[0].error).toContain("code 7");
    expect(manager.statuses()[0].toolCount).toBe(0);
    expect(notified).toBe(true);
    expect(manager.tools()).toEqual([]);

    // A handler registered earlier now fails cleanly, with the reason.
    const stale = (await echo({ text: "x" })) as { error: string };
    expect(stale.error).toContain('MCP server "mock" is not connected');
    expect(stale.error).toContain("code 7");
  });

  it("surfaces config warnings", async () => {
    const manager = makeManager([mockStdioConfig("mock")], {}, ["config.json: something odd"]);
    await manager.start();
    expect(manager.warnings()).toEqual(["config.json: something odd"]);
  });

  it("runs stdio servers in the project cwd unless the server configures its own", async () => {
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "revcode-mcp-cwd-")));
    try {
      const own = path.join(base, "own");
      await import("node:fs/promises").then((fs) => fs.mkdir(own));
      const manager = makeManager(
        [mockStdioConfig("default"), mockStdioConfig("custom", {}, { cwd: own })],
        { cwd: base },
      );
      await manager.start();
      expect(await call(manager, "mcp__default__cwd")).toEqual({ text: base });
      expect(await call(manager, "mcp__custom__cwd")).toEqual({ text: own });
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("start() is idempotent", async () => {
    const manager = makeManager([mockStdioConfig("mock")]);
    const first = manager.start();
    const second = manager.start();
    expect(second).toBe(first);
    await first;
    expect(manager.tools().length).toBe(MOCK_TOOL_COUNT);
  });
});

describe("McpManager disposal", () => {
  it("kills child processes and tolerates a second dispose()", async () => {
    const manager = makeManager([mockStdioConfig("mock")]);
    await manager.start();
    const { text } = (await call(manager, "mcp__mock__pid")) as { text: string };
    const pid = Number(text);
    expect(isAlive(pid)).toBe(true);

    const first = manager.dispose();
    const second = manager.dispose();
    expect(second).toBe(first);
    await first;
    await manager.dispose();

    await waitFor(() => !isAlive(pid));
    expect(manager.tools()).toEqual([]);
  });

  it("is safe while startup is in flight", async () => {
    const manager = makeManager([
      mockStdioConfig("hangs", { MOCK_HANG_ON_INIT: "1" }),
      mockStdioConfig("ok"),
    ]);
    const starting = manager.start();
    const disposing = manager.dispose();
    await starting;
    await disposing;
    await manager.dispose();
    for (const status of manager.statuses()) {
      expect(status.state).toBe("failed");
      expect(status.error).toContain("disposed");
    }
    expect(manager.tools()).toEqual([]);
  });

  it("is safe before start() and makes a later start() a no-op failure", async () => {
    const manager = makeManager([mockStdioConfig("mock")]);
    await manager.dispose();
    await manager.start();
    expect(manager.statuses()[0].state).toBe("failed");
    expect(manager.tools()).toEqual([]);
  });

  it("returns errors from handlers invoked after dispose", async () => {
    const manager = makeManager([mockStdioConfig("mock")]);
    await manager.start();
    const handler = toolMap(manager).get("mcp__mock__echo")!;
    await manager.dispose();
    expect(await handler({ text: "x" })).toMatchObject({ error: expect.stringContaining("no longer available") });
  });

  it("SIGKILLs a server that ignores SIGTERM after the grace period", async () => {
    // Ignores SIGTERM and has a live timer, so neither EOF nor SIGTERM stops it.
    const script = `
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
      const out = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
      process.stdin.on("data", (d) => {
        for (const line of String(d).split("\\n")) {
          if (!line) continue;
          const m = JSON.parse(line);
          if (m.method === "initialize") out(m.id, { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "s", version: "1" } });
          if (m.method === "tools/list") out(m.id, { tools: [{ name: "pid" }] });
          if (m.method === "tools/call") out(m.id, { content: [{ type: "text", text: String(process.pid) }] });
        }
      });`;
    const manager = makeManager([mockStdioConfig("stubborn")], {
      transportFactory: () => new StdioTransport({ command: process.execPath, args: ["-e", script], killGraceMs: 300 }),
    });
    await manager.start();
    const { text } = (await call(manager, "mcp__stubborn__pid")) as { text: string };
    const pid = Number(text);
    expect(isAlive(pid)).toBe(true);

    const started = Date.now();
    await manager.dispose();
    expect(isAlive(pid)).toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250); // SIGTERM was ignored; waited for SIGKILL
  });
});

describe("truncateMiddle", () => {
  it("returns short text unchanged and respects the limit otherwise", () => {
    expect(truncateMiddle("short", 100)).toBe("short");
    const long = "x".repeat(50_000);
    const out = truncateMiddle(long, 30_000);
    expect(out.length).toBeLessThanOrEqual(30_000);
    expect(out).toContain("characters truncated");
  });
});
