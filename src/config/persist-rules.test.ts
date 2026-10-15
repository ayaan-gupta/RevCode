import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { persistAllowRule } from "./persist-rules.js";

const project = (): string => mkdtempSync(path.join(os.tmpdir(), "revcode-rules-"));

describe("persistAllowRule", () => {
  it("creates the local config with the rule and does not duplicate it", () => {
    const dir = project();
    expect(persistAllowRule(dir, "shell(git status*)").added).toBe(true);
    expect(persistAllowRule(dir, "shell(git status*)").added).toBe(false);
    persistAllowRule(dir, "shell(npm test*)");
    const saved = JSON.parse(readFileSync(path.join(dir, ".revcode", "config.local.json"), "utf8"));
    expect(saved.permissions.allow).toEqual(["shell(git status*)", "shell(npm test*)"]);
  });

  it("keeps everything else in the file", () => {
    const dir = project();
    mkdirSync(path.join(dir, ".revcode"));
    writeFileSync(path.join(dir, ".revcode", "config.local.json"), JSON.stringify({ model: "glm-4.7", permissions: { mode: "plan", deny: ["shell(rm *)"] } }));
    persistAllowRule(dir, "edit_file");
    const saved = JSON.parse(readFileSync(path.join(dir, ".revcode", "config.local.json"), "utf8"));
    expect(saved).toEqual({ model: "glm-4.7", permissions: { mode: "plan", deny: ["shell(rm *)"], allow: ["edit_file"] } });
  });

  it("replaces a damaged file instead of failing", () => {
    const dir = project();
    mkdirSync(path.join(dir, ".revcode"));
    writeFileSync(path.join(dir, ".revcode", "config.local.json"), "{ not json");
    expect(persistAllowRule(dir, "x").added).toBe(true);
  });

  it("excludes the file from git without touching a tracked .gitignore", () => {
    const dir = project();
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");
    persistAllowRule(dir, "a");
    persistAllowRule(dir, "b");
    expect(readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8")).toBe("/.revcode/config.local.json\n");
    expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("node_modules\n");
  });

  it("works outside a git repository", () => {
    expect(persistAllowRule(project(), "a").added).toBe(true);
  });
});
