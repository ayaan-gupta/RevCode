import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clip,
  failingTests,
  httpGet,
  httpGetWithRetry,
  killListeners,
  listeningPids,
  makeRng,
  parseUnittest,
  run,
  sha256,
  sleep,
  stableStringify,
  treeDigest,
  withPortLock,
  withScratchCopy,
  writeFiles,
} from "./helpers.js";

/** Not used by any task, so these tests can never disturb the suite's own port. */
const TEST_PORT = 18418;

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dyno-helpers-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A killed process nobody has reaped yet (zombie) counts as dead. */
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^State:\s+Z/m.test(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
  } catch {
    return true;
  }
};

describe("run", () => {
  it("captures output and exit status", async () => {
    const result = await run("bash", ["-c", "echo out; echo err >&2; exit 3"], { cwd: tempDir() });
    expect(result).toMatchObject({ code: 3, stdout: "out\n", stderr: "err\n", timedOut: false });
  });

  it("feeds stdin", async () => {
    const result = await run("cat", [], { cwd: tempDir(), input: "hello" });
    expect(result.stdout).toBe("hello");
  });

  it("kills the whole process group when the timeout elapses", async () => {
    const started = Date.now();
    const result = await run("bash", ["-c", "sleep 30 & echo $!; wait"], { cwd: tempDir(), timeoutMs: 400 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    const pid = Number(result.stdout.trim());
    await sleep(100);
    expect(isAlive(pid)).toBe(false);
  });

  it("does not hang on a script that leaves a background job holding the pipes", async () => {
    const started = Date.now();
    const result = await run("bash", ["-c", "sleep 30 & echo $!"], { cwd: tempDir(), timeoutMs: 20_000 });
    expect(result.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
    await sleep(100);
    expect(isAlive(Number(result.stdout.trim()))).toBe(false);
  });

  it("reports a missing binary instead of throwing", async () => {
    const result = await run("definitely-not-a-real-binary", [], { cwd: tempDir() });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("ENOENT");
  });
});

describe("hashing and scratch copies", () => {
  it("digests content, ignoring VCS and bytecode directories", () => {
    const dir = tempDir();
    writeFiles(dir, { "a.txt": "one", "sub/b.txt": "two" });
    const base = treeDigest(dir);
    writeFiles(dir, { ".git/HEAD": "x", "__pycache__/m.pyc": "x" });
    expect(treeDigest(dir)).toBe(base);
    writeFiles(dir, { "a.txt": "changed" });
    expect(treeDigest(dir)).not.toBe(base);
  });

  it("notices the executable bit", () => {
    const dir = tempDir();
    writeFiles(dir, { "run.sh": "#!/bin/sh\n" });
    const before = treeDigest(dir);
    fs.chmodSync(path.join(dir, "run.sh"), 0o755);
    expect(treeDigest(dir)).not.toBe(before);
  });

  it("runs work in a throw-away copy and leaves the original alone", async () => {
    const dir = tempDir();
    writeFiles(dir, { "keep.txt": "original" });
    const before = treeDigest(dir);
    const seen = await withScratchCopy(dir, async (scratch) => {
      fs.writeFileSync(path.join(scratch, "keep.txt"), "scribbled");
      fs.writeFileSync(path.join(scratch, "new.txt"), "x");
      return scratch;
    });
    expect(treeDigest(dir)).toBe(before);
    expect(fs.existsSync(seen)).toBe(false);
  });

  it("hashes strings and buffers identically", () => {
    expect(sha256("abc")).toBe(sha256(Buffer.from("abc")));
  });
});

describe("pure helpers", () => {
  it("generates the same pseudo-random sequence for a seed", () => {
    const a = makeRng(42);
    const b = makeRng(42);
    const first = Array.from({ length: 20 }, () => a.next());
    expect(Array.from({ length: 20 }, () => b.next())).toEqual(first);
    expect(makeRng(43).next()).not.toBe(first[0]);
    expect(first.every((n) => n >= 0 && n < 1)).toBe(true);
  });

  it("keeps ints within bounds and picks from the list", () => {
    const rng = makeRng(7);
    for (let i = 0; i < 500; i++) {
      const n = rng.int(3, 5);
      expect(n >= 3 && n <= 5).toBe(true);
      expect(["x", "y"]).toContain(rng.pick(["x", "y"]));
    }
  });

  it("stringifies objects independently of key order", () => {
    expect(stableStringify({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 2 } })).toBe(
      stableStringify({ a: { c: 2, d: [1, { y: 2, z: 1 }] }, b: 1 }),
    );
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it("clips long details and hides scratch paths", () => {
    expect(clip("x".repeat(500), 20)).toHaveLength(21);
    expect(clip("File \"/tmp/dyno-grade-Ab12Cd/x.py\", line 1")).toBe('File "<scratch>/x.py", line 1');
  });

  it("parses unittest summaries", () => {
    const failed = "FAIL: test_a (tests.T.test_a)\nERROR: test_b (tests.T.test_b)\n\nRan 5 tests in 0.002s\n\nFAILED (failures=1, errors=1)\n";
    expect(parseUnittest(failed)).toEqual({ ran: 5, ok: false });
    expect(failingTests(failed)).toEqual(["test_a", "test_b"]);
    expect(parseUnittest("Ran 1 test in 0.000s\n\nOK\n")).toEqual({ ran: 1, ok: true });
    expect(parseUnittest("Traceback (most recent call last):")).toBeUndefined();
  });
});

describe("port handling", () => {
  it("finds and kills whatever listens on a port", async () => {
    await withPortLock(TEST_PORT, async () => {
      const child = spawn("node", ["-e", `require("http").createServer((_, r) => r.end("hi")).listen(${TEST_PORT}, "127.0.0.1")`], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      try {
        const response = await httpGetWithRetry(`http://127.0.0.1:${TEST_PORT}/`, 8_000);
        expect(response).toMatchObject({ status: 200, body: "hi" });
        expect(listeningPids(TEST_PORT)).toContain(child.pid);

        const killed = await killListeners(TEST_PORT);
        expect(killed).toContain(child.pid);
        expect(listeningPids(TEST_PORT)).toEqual([]);
        await expect(httpGet(`http://127.0.0.1:${TEST_PORT}/`, 500)).rejects.toThrow();
      } finally {
        if (child.pid) {
          try {
            process.kill(child.pid, "SIGKILL");
          } catch {
            // already gone
          }
        }
      }
    });
  });

  it("retries until a late server comes up", async () => {
    await withPortLock(TEST_PORT, async () => {
      const server = http.createServer((_, response) => response.end("late"));
      const timer = setTimeout(() => server.listen(TEST_PORT, "127.0.0.1"), 500);
      try {
        const response = await httpGetWithRetry(`http://127.0.0.1:${TEST_PORT}/`, 6_000);
        expect(response.body).toBe("late");
      } finally {
        clearTimeout(timer);
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  it("serialises holders of the same port lock", async () => {
    const order: string[] = [];
    const hold = (name: string, ms: number): Promise<void> =>
      withPortLock(TEST_PORT + 1, async () => {
        order.push(`${name}:start`);
        await sleep(ms);
        order.push(`${name}:end`);
      });
    await Promise.all([hold("a", 150), hold("b", 10)]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("reclaims a lock whose owner died", async () => {
    const lockDir = path.join(os.tmpdir(), `dyno-port-${TEST_PORT + 2}.lock`);
    fs.mkdirSync(lockDir, { recursive: true });
    const dead = spawn("true");
    await new Promise((resolve) => dead.on("exit", resolve));
    fs.writeFileSync(path.join(lockDir, "pid"), String(dead.pid));
    const ran = await withPortLock(TEST_PORT + 2, async () => true);
    expect(ran).toBe(true);
    expect(fs.existsSync(lockDir)).toBe(false);
  });
});
