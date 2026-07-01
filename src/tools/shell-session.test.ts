import { afterEach, describe, expect, it } from "vitest";
import { ShellSession } from "./shell-session.js";

function makeSession(): ShellSession {
  return new ShellSession({ cwd: "/tmp" });
}

describe("ShellSession", () => {
  let session: ShellSession | undefined;

  afterEach(() => {
    session?.dispose();
    session = undefined;
  });

  it("persists cwd across calls", async () => {
    session = makeSession();
    await session.run("mkdir -p /tmp/revcode-test-state && cd /tmp/revcode-test-state");
    const result = await session.run("pwd");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("/tmp/revcode-test-state");
  });

  it("persists exported environment across calls", async () => {
    session = makeSession();
    await session.run("export REVCODE_X=hello");
    const result = await session.run('echo "$REVCODE_X"');
    expect(result.stdout.trim()).toBe("hello");
  });

  it("captures non-zero exit codes", async () => {
    session = makeSession();
    const result = await session.run("false");
    expect(result.exitCode).toBe(1);
  });

  it("merges stderr into stdout", async () => {
    session = makeSession();
    const result = await session.run('echo "to-stderr" >&2');
    expect(result.stdout).toContain("to-stderr");
  });

  it("does not echo the completion sentinel in output", async () => {
    session = makeSession();
    const result = await session.run("echo plain");
    expect(result.stdout.trim()).toBe("plain");
    expect(result.stdout).not.toContain("REVCODE_DONE");
  });

  it("serializes overlapping commands without corrupting output", async () => {
    session = makeSession();
    const [a, b, c] = await Promise.all([
      session.run("echo AAA"),
      session.run("echo BBB"),
      session.run("echo CCC"),
    ]);
    expect(a.stdout.trim()).toBe("AAA");
    expect(b.stdout.trim()).toBe("BBB");
    expect(c.stdout.trim()).toBe("CCC");
  });

  it("runs background processes and returns immediately", async () => {
    session = makeSession();
    const start = Date.now();
    const result = await session.run("sleep 2", { background: true });
    expect(Date.now() - start).toBeLessThan(15_000);
    expect(result.background?.logFile).toMatch(/revcode-bg-/);
    expect(result.background?.pid).toBeGreaterThan(0);
  });

  it("auto-backgrounds a trailing single & without blocking", async () => {
    session = makeSession();
    const start = Date.now();
    const result = await session.run("sleep 2 &");
    expect(Date.now() - start).toBeLessThan(15_000);
    expect(result.background).toBeDefined();
  });

  it("times out a hung foreground command and stays usable", async () => {
    session = makeSession();
    const result = await session.run("sleep 30", { timeoutMs: 800 });
    expect(result.timedOut).toBe(true);
    // Session must still answer afterwards (interrupted or hard-reset).
    const after = await session.run("echo recovered");
    expect(after.stdout.trim()).toBe("recovered");
  }, 20_000);
});
