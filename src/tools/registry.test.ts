import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PROFILE, withProfile } from "../harness/profile.js";
import { ToolRegistry } from "./index.js";

const registries: ToolRegistry[] = [];
afterEach(() => {
  while (registries.length) registries.pop()?.dispose();
});

function registry(options: ConstructorParameters<typeof ToolRegistry>[0] = {}) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "revcode-reg-"));
  writeFileSync(path.join(cwd, "a.txt"), "alpha\nbeta\n");
  const r = new ToolRegistry({ cwd, interactiveTerminal: false, ...options });
  registries.push(r);
  return { r, cwd };
}

describe("ToolRegistry", () => {
  it("repairs argument mistakes before dispatch and tells the model what it changed", async () => {
    const { r } = registry();
    const result = (await r.execute("read_file", { file_path: "a.txt", limit: "1" })) as { content: string; harnessNote?: string };
    expect(result.content).toContain("alpha");
    expect(result.content).not.toContain("beta");
    expect(result.harnessNote).toContain("file_path → path");
  });

  it("wraps a flattened single edit for edit_file", async () => {
    const { r, cwd } = registry();
    const out = (await r.execute("edit_file", { path: "a.txt", old_string: "beta", new_string: "gamma" })) as unknown;
    const text = typeof out === "string" ? out : JSON.stringify(out);
    expect(text).toContain("gamma");
    expect(readFileSync(path.join(cwd, "a.txt"), "utf8")).toBe("alpha\ngamma\n");
  });

  it("keeps extra arguments for tools whose schema allows them (MCP-style)", async () => {
    const { r } = registry();
    let received: unknown;
    r.register({
      definition: { name: "mcp__x__y", description: "", parameters: { type: "object", properties: { q: { type: "string" } } } },
      handler: async (input) => {
        received = input;
        return { text: "ok" };
      },
    });
    await r.execute("mcp__x__y", { q: "1", extra: { deep: true } });
    expect(received).toEqual({ q: "1", extra: { deep: true } });
  });

  it("switches the edit tool and read_file description with the profile", () => {
    const { r } = registry();
    const names = () => r.definitions().map((d) => d.name);
    expect(names()).toContain("edit_file");
    expect(names()).not.toContain("apply_patch");

    r.setProfile(withProfile(DEFAULT_PROFILE, { editMode: "patch" }));
    expect(names()).toContain("apply_patch");
    expect(names()).not.toContain("edit_file");

    r.setProfile(withProfile(DEFAULT_PROFILE, { editMode: "anchored" }));
    expect(names()).toContain("edit_anchored");
    const read = r.definitions().find((d) => d.name === "read_file");
    expect(read?.description).toMatch(/LINE#|anchor/i);

    r.setProfile(withProfile(DEFAULT_PROFILE, { editMode: "whole" }));
    expect(names()).not.toContain("edit_file");
    expect(names()).toContain("write_file");
  });

  it("applies the flat schema style to what the model sees", () => {
    const { r } = registry({ profile: withProfile(DEFAULT_PROFILE, { toolSchema: "flat" }) });
    const json = JSON.stringify(r.definitions());
    expect(json).not.toContain("additionalProperties");
  });

  it("restricts to an allowlist and tracks extra read-only tools", () => {
    const { r } = registry();
    r.markReadOnly(["mcp__a__b"]);
    expect(r.isReadOnly("mcp__a__b")).toBe(true);
    expect(r.isReadOnly("shell")).toBe(false);
    expect(r.isReadOnly("read_file")).toBe(true);
    r.restrictTo(["read_file", "grep"]);
    expect(r.definitions().map((d) => d.name).sort()).toEqual(["grep", "read_file"]);
  });

  it("honors the path policy: confined by default, free when unrestricted", async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), "revcode-outside-"));
    writeFileSync(path.join(outside, "x.txt"), "outside\n");
    const confined = registry().r;
    await expect(confined.execute("read_file", { path: path.join(outside, "x.txt") })).rejects.toThrow(/escapes the working directory/);
    const free = registry({ unrestrictedPaths: true }).r;
    expect(((await free.execute("read_file", { path: path.join(outside, "x.txt") })) as { content: string }).content).toContain("outside");
  });
});

