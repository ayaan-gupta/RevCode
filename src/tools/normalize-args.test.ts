import { describe, expect, it } from "vitest";
import { normalizeToolArgs } from "./normalize-args.js";

const editSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: { oldText: { type: "string" }, newText: { type: "string" } },
        required: ["oldText", "newText"],
      },
    },
    limit: { type: "integer" },
    flag: { type: "boolean" },
  },
  required: ["path", "edits"],
  additionalProperties: false,
};

describe("normalizeToolArgs", () => {
  it("passes well-formed arguments through untouched", () => {
    const args = { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] };
    const { args: out, notes } = normalizeToolArgs(args, editSchema);
    expect(out).toEqual(args);
    expect(notes).toEqual([]);
  });

  it("repairs aliases, including inside nested objects", () => {
    const { args, notes } = normalizeToolArgs(
      { file_path: "a.ts", edits: [{ old_string: "a", new_string: "b" }] },
      editSchema,
    );
    expect(args).toEqual({ path: "a.ts", edits: [{ oldText: "a", newText: "b" }] });
    expect(notes.join(" ")).toContain("file_path → path");
    expect(notes.join(" ")).toContain("old_string → oldText");
  });

  it("parses JSON-encoded arrays and coerces numeric/boolean strings", () => {
    const { args } = normalizeToolArgs(
      { path: "a.ts", edits: '[{"oldText":"a","newText":"b"}]', limit: "25", flag: "true" },
      editSchema,
    );
    expect(args.edits).toEqual([{ oldText: "a", newText: "b" }]);
    expect(args.limit).toBe(25);
    expect(args.flag).toBe(true);
  });

  it("drops unknown keys with a note", () => {
    const { args, notes } = normalizeToolArgs({ path: "a", edits: [], bogus: 1 }, editSchema);
    expect(args).not.toHaveProperty("bogus");
    expect(notes.join(" ")).toContain("ignored unknown argument: bogus");
  });

  it("does not clobber a canonical key with an alias", () => {
    const { args } = normalizeToolArgs({ path: "real.ts", file_path: "alias.ts", edits: [] }, editSchema);
    expect(args.path).toBe("real.ts");
  });

  it("maps shell-style aliases", () => {
    const shell = { type: "object", properties: { command: { type: "string" }, timeout: { type: "integer" } } };
    const { args } = normalizeToolArgs({ cmd: "ls", timeout_sec: "30" }, shell);
    expect(args).toEqual({ command: "ls", timeout: 30 });
  });
});
