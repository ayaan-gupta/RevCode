import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHooksConfig, matcherMatches, mergeHooksConfigs, parseHooksFile } from "./config.js";

const cmd = (command: string, timeout?: number) => ({ type: "command" as const, command, ...(timeout ? { timeout } : {}) });

describe("parseHooksFile", () => {
  it("accepts the Claude Code shape for every event", () => {
    const { config, warnings } = parseHooksFile(
      {
        hooks: {
          PreToolUse: [{ matcher: "shell|edit_file", hooks: [{ type: "command", command: "echo pre", timeout: 5 }] }],
          PostToolUse: [{ hooks: [{ type: "command", command: "echo post" }] }],
          UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo ups" }] }],
          Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }],
          SessionStart: [{ hooks: [{ type: "command", command: "echo start" }] }],
        },
      },
      "cfg",
    );
    expect(warnings).toEqual([]);
    expect(Object.keys(config)).toEqual(["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SessionStart"]);
    expect(config.PreToolUse).toEqual([{ matcher: "shell|edit_file", hooks: [cmd("echo pre", 5)] }]);
  });

  it("treats a missing type as command and clamps huge timeouts", () => {
    const { config, warnings } = parseHooksFile(
      { hooks: { Stop: [{ hooks: [{ command: "echo x", timeout: 99999 }] }] } },
      "cfg",
    );
    expect(warnings).toEqual([]);
    expect(config.Stop?.[0].hooks[0]).toEqual({ type: "command", command: "echo x", timeout: 600 });
  });

  it("accepts an empty object and a missing hooks key without warnings", () => {
    expect(parseHooksFile({}, "cfg")).toEqual({ config: {}, warnings: [] });
    expect(parseHooksFile({ hooks: {} }, "cfg")).toEqual({ config: {}, warnings: [] });
  });

  it.each([
    ["a non-object file", [], /expected a JSON object/],
    ["hooks that is not an object", { hooks: [] }, /"hooks" must be an object/],
    ["an unknown event", { hooks: { OnSave: [{ hooks: [cmd("x")] }] } }, /unknown hook event "OnSave"/],
    ["a non-array event", { hooks: { Stop: {} } }, /hooks\.Stop must be an array/],
    ["a group that is not an object", { hooks: { Stop: ["echo"] } }, /expected an object/],
    ["a non-string matcher", { hooks: { PreToolUse: [{ matcher: 5, hooks: [cmd("x")] }] } }, /"matcher" must be a string/],
    ["an invalid matcher regex", { hooks: { PreToolUse: [{ matcher: "(", hooks: [cmd("x")] }] } }, /invalid matcher regex "\("/],
    ["a group without a hooks array", { hooks: { Stop: [{ matcher: "x" }] } }, /"hooks" must be an array/],
    ["an unsupported hook type", { hooks: { Stop: [{ hooks: [{ type: "http", command: "x" }] }] } }, /unsupported hook type "http"/],
    ["an empty command", { hooks: { Stop: [{ hooks: [{ type: "command", command: "  " }] }] } }, /"command" must be a non-empty string/],
  ])("drops %s with a warning", (_label, raw, pattern) => {
    const { config, warnings } = parseHooksFile(raw, "cfg");
    expect(config.Stop ?? config.PreToolUse ?? []).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(pattern);
    expect(warnings[0]).toContain("cfg");
  });

  it("keeps the valid hooks around an invalid one", () => {
    const { config, warnings } = parseHooksFile(
      { hooks: { Stop: [{ hooks: [{ command: 5 }, cmd("echo ok")] }, { hooks: [] }] } },
      "cfg",
    );
    expect(config.Stop).toEqual([{ hooks: [cmd("echo ok")] }]);
    expect(warnings).toHaveLength(1);
  });

  it("falls back to the default timeout for an invalid one, with a warning", () => {
    const { config, warnings } = parseHooksFile({ hooks: { Stop: [{ hooks: [{ command: "x", timeout: -3 }] }] } }, "cfg");
    expect(config.Stop?.[0].hooks[0].timeout).toBeUndefined();
    expect(warnings[0]).toMatch(/timeout/);
  });
});

describe("mergeHooksConfigs", () => {
  it("concatenates per event in argument order", () => {
    const merged = mergeHooksConfigs([
      { Stop: [{ hooks: [cmd("a")] }], PreToolUse: [{ matcher: "x", hooks: [cmd("p1")] }] },
      {},
      { Stop: [{ hooks: [cmd("b")] }] },
    ]);
    expect(merged.Stop?.map((g) => g.hooks[0].command)).toEqual(["a", "b"]);
    expect(merged.PreToolUse).toHaveLength(1);
    expect(merged.PostToolUse).toBeUndefined();
  });
});

describe("loadHooksConfig", () => {
  let tmp: string;
  let home: string;
  let project: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "revcode-hooks-cfg-"));
    home = path.join(tmp, "home");
    project = path.join(tmp, "project");
    mkdirSync(home, { recursive: true });
    mkdirSync(path.join(project, ".revcode"), { recursive: true });
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const hooksFile = (command: string) => JSON.stringify({ hooks: { Stop: [{ hooks: [cmd(command)] }] } });

  it("returns an empty config when no files exist", () => {
    expect(loadHooksConfig(project, { revcodeHome: home })).toEqual({ config: {}, warnings: [] });
  });

  it("merges global, project, then project-local files in that order", () => {
    writeFileSync(path.join(home, "hooks.json"), hooksFile("global"));
    writeFileSync(path.join(project, ".revcode", "hooks.json"), hooksFile("project"));
    writeFileSync(path.join(project, ".revcode", "hooks.local.json"), hooksFile("local"));

    const { config, warnings } = loadHooksConfig(project, { revcodeHome: home });
    expect(warnings).toEqual([]);
    expect(config.Stop?.map((g) => g.hooks[0].command)).toEqual(["global", "project", "local"]);
  });

  it("can skip project files for untrusted repositories", () => {
    writeFileSync(path.join(home, "hooks.json"), hooksFile("global"));
    writeFileSync(path.join(project, ".revcode", "hooks.json"), hooksFile("project"));

    const { config } = loadHooksConfig(project, { revcodeHome: home, includeProject: false });
    expect(config.Stop?.map((g) => g.hooks[0].command)).toEqual(["global"]);
  });

  it("warns about invalid JSON and unreadable paths but still loads the other files", () => {
    writeFileSync(path.join(home, "hooks.json"), "{ not json");
    writeFileSync(path.join(project, ".revcode", "hooks.json"), hooksFile("project"));
    mkdirSync(path.join(project, ".revcode", "hooks.local.json"));

    const { config, warnings } = loadHooksConfig(project, { revcodeHome: home });
    expect(config.Stop?.map((g) => g.hooks[0].command)).toEqual(["project"]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/hooks\.json: invalid JSON/);
    expect(warnings[1]).toMatch(/cannot read hooks file/);
  });

  it("honours REVCODE_HOME by default", () => {
    const previous = process.env.REVCODE_HOME;
    process.env.REVCODE_HOME = home;
    try {
      writeFileSync(path.join(home, "hooks.json"), hooksFile("from-env"));
      expect(loadHooksConfig(project).config.Stop?.[0].hooks[0].command).toBe("from-env");
    } finally {
      if (previous === undefined) delete process.env.REVCODE_HOME;
      else process.env.REVCODE_HOME = previous;
    }
  });
});

describe("matcherMatches", () => {
  it("matches everything for undefined, empty and *", () => {
    for (const matcher of [undefined, "", "*"]) {
      expect(matcherMatches(matcher, "anything")).toBe(true);
    }
  });

  it("tests the pattern as an unanchored, case-sensitive regex", () => {
    expect(matcherMatches("shell|edit_file", "shell")).toBe(true);
    expect(matcherMatches("shell|edit_file", "edit_file")).toBe(true);
    expect(matcherMatches("shell|edit_file", "read_file")).toBe(false);
    expect(matcherMatches("^edit_", "edit_file")).toBe(true);
    expect(matcherMatches("^file$", "edit_file")).toBe(false);
    expect(matcherMatches("mcp__.*__search", "mcp__github__search")).toBe(true);
    expect(matcherMatches("Shell", "shell")).toBe(false);
    expect(matcherMatches("write", "write_file")).toBe(true);
  });

  it("never matches an invalid pattern", () => {
    expect(matcherMatches("(", "anything")).toBe(false);
  });
});
