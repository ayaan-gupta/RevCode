import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isProjectTrusted, projectExecutableConfigs, trustProject } from "./trust.js";

describe("project trust", () => {
  let previousHome: string | undefined;
  beforeEach(() => {
    previousHome = process.env.REVCODE_HOME;
    process.env.REVCODE_HOME = mkdtempSync(path.join(os.tmpdir(), "revcode-home-"));
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.REVCODE_HOME;
    else process.env.REVCODE_HOME = previousHome;
  });

  it("is untrusted by default, trusted after trustProject, and covers subdirectories", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "revcode-trust-"));
    expect(isProjectTrusted(dir, {})).toBe(false);
    trustProject(dir);
    expect(isProjectTrusted(dir, {})).toBe(true);
    expect(isProjectTrusted(path.join(dir, "sub"), {})).toBe(true);
    expect(isProjectTrusted(dir + "-sibling", {})).toBe(false);
  });

  it("honors the environment override", () => {
    expect(isProjectTrusted("/anywhere", { REVCODE_TRUST_PROJECT: "1" })).toBe(true);
  });

  it("finds project files that execute commands", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "revcode-trust-"));
    expect(projectExecutableConfigs(dir)).toEqual([]);
    mkdirSync(path.join(dir, ".revcode"));
    writeFileSync(path.join(dir, ".revcode", "hooks.json"), "{}");
    writeFileSync(path.join(dir, ".mcp.json"), "{}");
    expect(projectExecutableConfigs(dir).map((f) => path.basename(f)).sort()).toEqual([".mcp.json", "hooks.json"]);
  });
});
