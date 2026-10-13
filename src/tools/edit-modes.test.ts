import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AVAILABLE_EDIT_MODES, EDIT_TOOL_NAMES, editFileToolDefinition, editToolsForMode } from "./edit-modes.js";
import { readFile } from "./read.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "revcode-modes-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const toolNames = (mode: Parameters<typeof editToolsForMode>[0]): string[] =>
  editToolsForMode(mode, { cwd: dir }).map((tool) => tool.definition.name);

describe("editToolsForMode", () => {
  it("exposes one tool per mode and none for whole-file rewrites", () => {
    expect(toolNames("replace")).toEqual(["edit_file"]);
    expect(toolNames("patch")).toEqual(["apply_patch"]);
    expect(toolNames("anchored")).toEqual(["edit_anchored"]);
    expect(toolNames("whole")).toEqual([]);
  });

  it("only registers names listed in EDIT_TOOL_NAMES so a mode switch can clean up", () => {
    for (const mode of AVAILABLE_EDIT_MODES) {
      for (const name of toolNames(mode)) {
        expect(EDIT_TOOL_NAMES).toContain(name);
      }
    }
  });

  it("marks every edit mode as available", () => {
    expect([...AVAILABLE_EDIT_MODES].sort()).toEqual(["anchored", "patch", "replace", "whole"]);
  });

  it("falls back to edit_file for an unknown mode", () => {
    expect(toolNames("mystery" as never)).toEqual(["edit_file"]);
  });

  it("gives every tool an object schema with a description", () => {
    for (const mode of ["replace", "patch", "anchored"] as const) {
      for (const { definition } of editToolsForMode(mode, { cwd: dir })) {
        expect(definition.description.length).toBeGreaterThan(200);
        expect(definition.parameters).toMatchObject({ type: "object", additionalProperties: false });
      }
    }
  });

  it("describes edit_file's optional replaceAll", () => {
    const edits = (editFileToolDefinition.parameters.properties as Record<string, { items: { properties: Record<string, unknown>; required: string[] } }>).edits;
    expect(Object.keys(edits.items.properties)).toEqual(["oldText", "newText", "replaceAll"]);
    expect(edits.items.required).toEqual(["oldText", "newText"]);
  });
});

describe("handlers", () => {
  it("edit_file edits within cwd and respects unrestricted", async () => {
    await fs.writeFile(path.join(dir, "a.txt"), "hello\n");
    const [tool] = editToolsForMode("replace", { cwd: dir });
    const result = await tool.handler({ path: "a.txt", edits: [{ oldText: "hello", newText: "bye" }] });
    expect(result).toEqual(expect.stringContaining("Edited a.txt"));
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("bye\n");

    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "revcode-modes-out-"));
    try {
      const target = path.join(outside, "x.txt");
      await fs.writeFile(target, "old\n");
      const edit = { path: target, edits: [{ oldText: "old", newText: "new" }] };
      await expect(tool.handler(edit)).rejects.toThrow(/escapes the working directory/);
      const [open] = editToolsForMode("replace", { cwd: dir, unrestricted: true });
      await open.handler(edit);
      expect(await fs.readFile(target, "utf8")).toBe("new\n");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("apply_patch applies a patch passed as `input`", async () => {
    await fs.writeFile(path.join(dir, "a.txt"), "one\n");
    const [tool] = editToolsForMode("patch", { cwd: dir });
    const result = await tool.handler({ input: "*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+two\n*** End Patch" });
    expect(String(result)).toMatch(/^Success\. Updated the following files:\nM a\.txt/);
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("two\n");
  });

  it("edit_anchored works with the anchors read_file renders in anchored mode", async () => {
    await fs.writeFile(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
    const view = await readFile({ path: "a.txt" }, { cwd: dir, anchors: true });
    const tag = view.content.split("\n")[1].split(":")[0];
    const [tool] = editToolsForMode("anchored", { cwd: dir });
    const result = await tool.handler({ path: "a.txt", edits: [{ op: "replace", tag, content: ["TWO"] }] });
    expect(String(result)).toContain("Edited a.txt");
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf8")).toBe("one\nTWO\nthree\n");
  });
});
