import { describe, expect, it } from "vitest";

import { McpClient } from "./client.js";
import { StdioTransport } from "./transport-stdio.js";
import { isAlive, MOCK_SERVER_PATH, rejection, waitFor } from "./__fixtures__/helpers.js";

const nodeScript = (script: string, options: Partial<ConstructorParameters<typeof StdioTransport>[0]> = {}) =>
  new StdioTransport({ command: process.execPath, args: ["-e", script], label: "inline", ...options });

describe("StdioTransport", () => {
  it("keeps only the last N characters of stderr", async () => {
    const transport = nodeScript(
      `for (let i = 0; i < 400; i++) process.stderr.write("line " + i + " ".repeat(40) + "\\n"); process.stderr.write("END-OF-STDERR\\n", () => process.exit(2));`,
      { stderrBufferChars: 1024 },
    );
    const client = new McpClient(transport, { label: "chatty", requestTimeoutMs: 5_000 });
    const error = await rejection(client.connect());
    expect(error.message).toContain("exited unexpectedly with code 2");
    expect(error.message).toContain("END-OF-STDERR");
    expect(error.message).not.toContain("line 0 ");
    expect(transport.diagnostics().length).toBeLessThanOrEqual(1024);
    expect(transport.diagnostics().trimEnd().endsWith("END-OF-STDERR")).toBe(true);
  });

  it("rejects pending requests with the stderr tail when the process dies mid-request", async () => {
    const transport = nodeScript(
      `process.stdin.on("data", () => { process.stderr.write("fatal: out of cheese\\n", () => process.exit(9)); });`,
      { label: "dies" },
    );
    const client = new McpClient(transport, { label: "dies", requestTimeoutMs: 5_000 });
    await transport.start();
    const pending = client.request("anything");
    const error = await rejection(pending);
    expect(error.message).toContain('"dies"');
    expect(error.message).toContain("code 9");
    expect(error.message).toContain("fatal: out of cheese");
  });

  it("explains a missing command", async () => {
    const transport = new StdioTransport({ command: "definitely-not-installed-xyz", label: "ghost" });
    await expect(transport.start()).rejects.toThrow(/"ghost".*"definitely-not-installed-xyz" was not found/);
    await transport.close(); // must not hang or throw
  });

  it("reports signal deaths", async () => {
    const transport = nodeScript(`process.kill(process.pid, "SIGKILL");`);
    const client = new McpClient(transport, { label: "killed", requestTimeoutMs: 5_000 });
    await expect(client.connect()).rejects.toThrow(/killed by SIGKILL/);
  });

  it("terminates the child on close and is idempotent", async () => {
    const transport = new StdioTransport({ command: process.execPath, args: [MOCK_SERVER_PATH], label: "mock" });
    const client = new McpClient(transport);
    await client.connect();
    const pid = transport.pid!;
    expect(isAlive(pid)).toBe(true);
    await Promise.all([client.close(), client.close(), transport.close()]);
    await waitFor(() => !isAlive(pid));
  });

  it("send() after the process exited fails with the exit reason", async () => {
    const transport = nodeScript(`process.stderr.write("bye\\n", () => process.exit(4));`);
    const closed = new Promise<Error | undefined>((resolve) => {
      transport.onclose = resolve;
    });
    await transport.start();
    const error = await closed;
    expect(error?.message).toContain("code 4");
    await expect(transport.send({ jsonrpc: "2.0", method: "x" })).rejects.toThrow(/bye/);
  });

  it("handles a final message without a trailing newline and CRLF framing", async () => {
    const transport = nodeScript(
      `process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:1,result:{a:1}}) + "\\r\\n"); process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:2,result:{b:2}}));`,
    );
    const received: unknown[] = [];
    transport.onmessage = (m) => received.push(m);
    const closed = new Promise<void>((resolve) => {
      transport.onclose = () => resolve();
    });
    await transport.start();
    await closed;
    expect(received).toEqual([
      { jsonrpc: "2.0", id: 1, result: { a: 1 } },
      { jsonrpc: "2.0", id: 2, result: { b: 2 } },
    ]);
  });
});
