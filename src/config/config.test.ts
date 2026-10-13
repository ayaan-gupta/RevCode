import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, mergeConfig, validateConfig } from "./config.js";

describe("config", () => {
  let previousHome: string | undefined;
  let project: string;
  beforeEach(() => {
    previousHome = process.env.REVCODE_HOME;
    process.env.REVCODE_HOME = mkdtempSync(path.join(os.tmpdir(), "revcode-home-"));
    project = mkdtempSync(path.join(os.tmpdir(), "revcode-cfg-"));
    mkdirSync(path.join(project, ".revcode"));
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.REVCODE_HOME;
    else process.env.REVCODE_HOME = previousHome;
  });

  it("layers user < project < local, concatenating permission rules", () => {
    writeFileSync(
      path.join(process.env.REVCODE_HOME as string, "config.json"),
      JSON.stringify({ model: "glm-4.7", permissions: { allow: ["shell(git status*)"], deny: ["shell(rm*)"] } }),
    );
    writeFileSync(
      path.join(project, ".revcode", "config.json"),
      JSON.stringify({ model: "glm-5.2", universe: true, permissions: { mode: "accept-edits", allow: ["edit_file"] } }),
    );
    writeFileSync(path.join(project, ".revcode", "config.local.json"), JSON.stringify({ maxIterations: 80 }));

    const { config, files, warnings } = loadConfig(project);
    expect(files).toHaveLength(3);
    expect(warnings).toEqual([]);
    expect(config.model).toBe("glm-5.2");
    expect(config.universe).toBe(true);
    expect(config.maxIterations).toBe(80);
    expect(config.permissions).toEqual({
      mode: "accept-edits",
      allow: ["shell(git status*)", "edit_file"],
      deny: ["shell(rm*)"],
    });
  });

  it("skips broken files with a warning instead of throwing", () => {
    writeFileSync(path.join(project, ".revcode", "config.json"), "{ not json");
    const { config, warnings } = loadConfig(project);
    expect(config).toEqual({});
    expect(warnings[0]).toContain("config.json");
  });

  it("reports invalid fields and keeps valid ones", () => {
    const { config, problems } = validateConfig({
      model: "x",
      maxIterations: -1,
      universe: "yes",
      permissions: { mode: "reckless", allow: ["a"] },
    });
    expect(config.model).toBe("x");
    expect(config.maxIterations).toBeUndefined();
    expect(problems).toHaveLength(3);
    expect(config.permissions?.allow).toEqual(["a"]);
  });

  it("merge never drops deny rules", () => {
    const merged = mergeConfig({ permissions: { deny: ["a"] } }, { permissions: { mode: "yolo" } });
    expect(merged.permissions?.deny).toEqual(["a"]);
    expect(merged.permissions?.mode).toBe("yolo");
  });
});
