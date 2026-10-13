import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { expandEnv, loadMcpConfig, mcpConfigPaths, parseMcpConfig } from "./config.js";

let root: string;
let home: string;
let project: string;

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "revcode-mcp-config-"));
  home = path.join(root, "home");
  project = path.join(root, "project");
  await mkdir(project, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const baseEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ REVCODE_HOME: home, ...extra });

describe("expandEnv", () => {
  it("expands ${VAR} and ${VAR:-default}", () => {
    const env = { A: "1", EMPTY: "" };
    const missing = new Set<string>();
    expect(expandEnv("x-${A}-y", env, missing)).toBe("x-1-y");
    expect(expandEnv("${NOPE:-fallback}", env, missing)).toBe("fallback");
    expect(expandEnv("${EMPTY:-fallback}", env, missing)).toBe("fallback");
    expect(expandEnv("${A:-fallback}", env, missing)).toBe("1");
    expect(expandEnv("${NOPE:-}", env, missing)).toBe("");
    expect(missing.size).toBe(0);
  });

  it("records variables that are unset and have no default", () => {
    const missing = new Set<string>();
    expect(expandEnv("a${GONE}b", {}, missing)).toBe("ab");
    expect([...missing]).toEqual(["GONE"]);
  });

  it("leaves text without references and malformed references alone", () => {
    expect(expandEnv("plain $HOME ${1BAD} $", { HOME: "/h" })).toBe("plain $HOME ${1BAD} $");
  });
});

describe("mcpConfigPaths", () => {
  it("honours REVCODE_HOME and lists files lowest precedence first", () => {
    expect(mcpConfigPaths(project, { env: { REVCODE_HOME: home } })).toEqual([
      path.join(home, "mcp.json"),
      path.join(project, ".mcp.json"),
      path.join(project, ".revcode", "mcp.json"),
    ]);
  });

  it("falls back to ~/.revcode", () => {
    expect(mcpConfigPaths(project, { env: {}, homeDir: "/home/u" })[0]).toBe(path.join("/home/u", ".revcode", "mcp.json"));
  });
});

describe("loadMcpConfig", () => {
  it("parses stdio, http and sse servers", async () => {
    await writeJson(path.join(project, ".mcp.json"), {
      mcpServers: {
        fs: { command: "npx", args: ["-y", "server-fs", 8080, true], env: { TOKEN: "t", N: 5 }, cwd: "sub" },
        remote: { type: "http", url: "https://example.com/mcp", headers: { "X-Key": "k" } },
        legacy: { type: "sse", url: "https://example.com/sse" },
      },
    });
    const config = await loadMcpConfig(project, { env: baseEnv() });
    expect(config.warnings).toEqual([]);
    expect(config.servers).toEqual([
      {
        type: "stdio",
        name: "fs",
        command: "npx",
        args: ["-y", "server-fs", "8080", "true"],
        env: { TOKEN: "t", N: "5" },
        cwd: path.join(project, "sub"),
        disabled: false,
        source: path.join(project, ".mcp.json"),
      },
      {
        type: "http",
        name: "remote",
        url: "https://example.com/mcp",
        headers: { "X-Key": "k" },
        disabled: false,
        source: path.join(project, ".mcp.json"),
      },
      {
        type: "sse",
        name: "legacy",
        url: "https://example.com/sse",
        headers: {},
        disabled: false,
        source: path.join(project, ".mcp.json"),
      },
    ]);
  });

  it("infers the transport when `type` is omitted", async () => {
    await writeJson(path.join(project, ".mcp.json"), {
      mcpServers: {
        a: { command: "node" },
        b: { url: "https://example.com/mcp" },
        c: { url: "https://example.com/v1/sse" },
        d: { type: "streamable-http", url: "https://example.com/x" },
      },
    });
    const { servers } = await loadMcpConfig(project, { env: baseEnv() });
    expect(servers.map((s) => [s.name, s.type])).toEqual([
      ["a", "stdio"],
      ["b", "http"],
      ["c", "sse"],
      ["d", "http"],
    ]);
  });

  it("expands env vars in command, args, env, cwd, url and headers", async () => {
    await writeJson(path.join(project, ".mcp.json"), {
      mcpServers: {
        local: {
          command: "${BIN_DIR}/server",
          args: ["--token", "${TOKEN}", "--mode=${MODE:-fast}"],
          env: { API_KEY: "${TOKEN}", REGION: "${REGION:-us-east-1}" },
          cwd: "${WORK}",
        },
        remote: {
          type: "http",
          url: "https://${HOST}/mcp",
          headers: { Authorization: "Bearer ${TOKEN}", "X-Mode": "${MODE:-fast}" },
        },
      },
    });
    const env = baseEnv({ BIN_DIR: "/opt/bin", TOKEN: "s3cret", HOST: "api.example.com", WORK: "/work" });
    const { servers, warnings } = await loadMcpConfig(project, { env });
    expect(warnings).toEqual([]);
    expect(servers[0]).toMatchObject({
      command: "/opt/bin/server",
      args: ["--token", "s3cret", "--mode=fast"],
      env: { API_KEY: "s3cret", REGION: "us-east-1" },
      cwd: "/work",
    });
    expect(servers[1]).toMatchObject({
      url: "https://api.example.com/mcp",
      headers: { Authorization: "Bearer s3cret", "X-Mode": "fast" },
    });
  });

  it("flags servers with unresolved variables instead of dropping them", async () => {
    await writeJson(path.join(project, ".mcp.json"), {
      mcpServers: {
        needs: { command: "x", env: { KEY: "${MISSING_ONE}" }, args: ["${MISSING_TWO}"] },
        off: { command: "x", disabled: true, env: { KEY: "${MISSING_ONE}" } },
      },
    });
    const { servers, warnings } = await loadMcpConfig(project, { env: baseEnv() });
    expect(servers).toHaveLength(2);
    expect(servers[0].error).toContain("MISSING_ONE, MISSING_TWO");
    expect(servers[1].disabled).toBe(true);
    expect(servers[1].error).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it("merges with precedence user < .mcp.json < .revcode/mcp.json, replacing whole entries", async () => {
    await writeJson(path.join(home, "mcp.json"), {
      mcpServers: {
        shared: { command: "user-cmd", args: ["--user"] },
        onlyUser: { command: "u" },
        override: { command: "user-override", args: ["a", "b"] },
      },
    });
    await writeJson(path.join(project, ".mcp.json"), {
      mcpServers: {
        shared: { command: "project-cmd" },
        onlyProject: { command: "p" },
        override: { command: "project-override" },
      },
    });
    await writeJson(path.join(project, ".revcode", "mcp.json"), {
      mcpServers: { override: { type: "http", url: "https://example.com/final" } },
    });

    const config = await loadMcpConfig(project, { env: baseEnv() });
    const byName = Object.fromEntries(config.servers.map((s) => [s.name, s]));
    expect(Object.keys(byName).sort()).toEqual(["onlyProject", "onlyUser", "override", "shared"]);
    expect(byName.onlyUser).toMatchObject({ command: "u" });
    expect(byName.shared).toMatchObject({ command: "project-cmd", args: [] }); // no deep merge
    expect(byName.override).toMatchObject({ type: "http", url: "https://example.com/final" });
    expect(config.sources).toEqual([
      path.join(home, "mcp.json"),
      path.join(project, ".mcp.json"),
      path.join(project, ".revcode", "mcp.json"),
    ]);
  });

  it("lets a higher-precedence stub disable a lower-precedence server", async () => {
    await writeJson(path.join(home, "mcp.json"), { mcpServers: { noisy: { command: "x" }, keep: { command: "y" } } });
    await writeJson(path.join(project, ".mcp.json"), {
      mcpServers: { noisy: { disabled: true }, ghost: { disabled: true } },
    });
    const { servers, warnings } = await loadMcpConfig(project, { env: baseEnv() });
    expect(warnings).toEqual([]);
    expect(servers.map((s) => [s.name, s.disabled])).toEqual([
      ["noisy", true],
      ["keep", false],
    ]);
  });

  it("keeps disabled servers, marked as disabled", async () => {
    await writeJson(path.join(project, ".mcp.json"), { mcpServers: { s: { command: "x", disabled: true } } });
    const { servers } = await loadMcpConfig(project, { env: baseEnv() });
    expect(servers).toHaveLength(1);
    expect(servers[0].disabled).toBe(true);
  });

  it("never throws on invalid files and reports warnings", async () => {
    await writeJson(path.join(home, "mcp.json"), "{ not json");
    await writeJson(path.join(project, ".mcp.json"), JSON.stringify([1, 2, 3]));
    await writeJson(path.join(project, ".revcode", "mcp.json"), {
      mcpServers: {
        good: { command: "ok" },
        noCommand: { args: ["x"] },
        badArgs: { command: "x", args: "not-an-array" },
        badEnv: { command: "x", env: { A: { nested: true } } },
        badType: { type: "carrier-pigeon", url: "https://example.com" },
        badUrl: { type: "http", url: "not a url" },
        badScheme: { type: "http", url: "ftp://example.com/x" },
        notObject: 42,
        badTimeout: { command: "x", timeoutMs: -5 },
      },
    });
    const config = await loadMcpConfig(project, { env: baseEnv() });
    expect(config.servers.map((s) => s.name)).toEqual(["good", "badTimeout"]);
    const text = config.warnings.join("\n");
    expect(text).toContain("invalid JSON");
    expect(text).toContain("expected a JSON object");
    for (const name of ["noCommand", "badArgs", "badEnv", "badType", "badUrl", "badScheme", "notObject"]) {
      expect(text).toContain(`server "${name}" skipped`);
    }
    expect(text).toContain('"timeoutMs" must be a positive number');
    expect(config.servers[1].timeoutMs).toBeUndefined();
  });

  it("warns when mcpServers is missing or malformed", async () => {
    await writeJson(path.join(project, ".mcp.json"), { servers: {} });
    await writeJson(path.join(project, ".revcode", "mcp.json"), { mcpServers: [] });
    const { servers, warnings } = await loadMcpConfig(project, { env: baseEnv() });
    expect(servers).toEqual([]);
    expect(warnings).toHaveLength(2);
  });

  it("returns an empty config when no files exist", async () => {
    const config = await loadMcpConfig(project, { env: baseEnv() });
    expect(config).toEqual({ servers: [], warnings: [], sources: [] });
  });

  it("reads timeouts and strips a UTF-8 BOM", async () => {
    await writeJson(
      path.join(project, ".mcp.json"),
      `${String.fromCharCode(0xfeff)}${JSON.stringify({ mcpServers: { s: { command: "x", timeoutMs: 1234, startupTimeoutMs: 99 } } })}`,
    );
    const { servers, warnings } = await loadMcpConfig(project, { env: baseEnv() });
    expect(warnings).toEqual([]);
    expect(servers[0]).toMatchObject({ timeoutMs: 1234, startupTimeoutMs: 99 });
  });

  it("treats a server named __proto__ as an ordinary key", async () => {
    await writeJson(path.join(project, ".mcp.json"), `{"mcpServers": {"__proto__": {"command": "x"}}}`);
    const { servers } = await loadMcpConfig(project, { env: baseEnv() });
    expect(servers.map((s) => s.name)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).command).toBeUndefined();
  });

  it("defaults to process.env (REVCODE_HOME and ${VAR})", async () => {
    await writeJson(path.join(home, "mcp.json"), { mcpServers: { s: { command: "${REVCODE_TEST_BIN}" } } });
    const saved = { home: process.env.REVCODE_HOME, bin: process.env.REVCODE_TEST_BIN };
    process.env.REVCODE_HOME = home;
    process.env.REVCODE_TEST_BIN = "from-process-env";
    try {
      const { servers } = await loadMcpConfig(project);
      expect(servers[0]).toMatchObject({ name: "s", command: "from-process-env" });
    } finally {
      for (const [key, value] of [
        ["REVCODE_HOME", saved.home],
        ["REVCODE_TEST_BIN", saved.bin],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("parseMcpConfig", () => {
  it("rejects a non-object document", () => {
    const { entries, warnings } = parseMcpConfig("nope", { source: "f.json", cwd: "/", env: {} });
    expect(entries).toEqual([]);
    expect(warnings[0]).toContain("f.json");
  });
});
