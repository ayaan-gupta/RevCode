import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "../read.js";
import { editAnchored, editAnchoredToolDefinition, type AnchoredEditOperation } from "./index.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "revcode-anchored-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function put(name: string, content: string | Buffer): Promise<void> {
  const target = path.join(dir, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

const get = (name: string): Promise<string> => fs.readFile(path.join(dir, name), "utf8");

/** The anchor the model would copy for `line` after reading `file` in anchored mode. */
async function anchorOf(file: string, line: number): Promise<string> {
  const read = await readFile({ path: file }, { cwd: dir, anchors: true });
  const row = read.content.split("\n").find((entry) => entry.startsWith(`${line}#`));
  if (!row) throw new Error(`no anchor for line ${line}`);
  return row.slice(0, row.indexOf(":"));
}

const run = (file: string, edits: AnchoredEditOperation[], rename?: string) =>
  editAnchored({ path: file, edits, rename }, { cwd: dir });

const SOURCE = "import a from 'a';\n\nfunction f() {\n  return 1;\n}\n";

describe("read_file in anchored mode", () => {
  it("renders LINE#ID:content rows and keeps the continuation behavior", async () => {
    await put("a.ts", SOURCE);
    const read = await readFile({ path: "a.ts" }, { cwd: dir, anchors: true });
    const rows = read.content.split("\n");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatch(/^1#[ZPMQVRWSNKTXJBYH]{2}:import a from 'a';$/);
    expect(rows[3]).toMatch(/^4#[ZPMQVRWSNKTXJBYH]{2}: {2}return 1;$/);
    expect(read.totalLines).toBe(5);

    const paged = await readFile({ path: "a.ts", offset: 4, limit: 1 }, { cwd: dir, anchors: true });
    expect(paged.content).toBe(rows[3]);
    expect(paged.continuation).toBe("[Showing lines 4-4 of 5. Continue with offset: 5]");
  });

  it("hashes the full line even when the display is cut", async () => {
    await put("long.txt", `${"x".repeat(5_000)}\nshort\n`);
    const read = await readFile({ path: "long.txt" }, { cwd: dir, anchors: true });
    const tag = read.content.split("\n")[0].split(":")[0];
    const edited = await run("long.txt", [{ op: "replace", tag, content: ["replaced"] }]);
    expect(edited).toContain("Edited long.txt");
    expect(await get("long.txt")).toBe("replaced\nshort\n");
  });
});

describe("editAnchored", () => {
  it("edits a file using anchors from a read and returns a diff plus fresh anchors", async () => {
    await put("a.ts", SOURCE);
    const result = await run("a.ts", [{ op: "replace", tag: await anchorOf("a.ts", 4), content: ["  return 2;", "  // changed"] }]);
    expect(await get("a.ts")).toBe("import a from 'a';\n\nfunction f() {\n  return 2;\n  // changed\n}\n");
    expect(result).toMatch(/^Edited a\.ts \(1 edit; \+2 -1\)\./);
    expect(result).toContain("-  return 1;\n+  return 2;\n+  // changed");
    expect(result).toContain("Fresh anchors for the edited region (lines after it moved by +1; re-read before editing elsewhere):");
    const fresh = await readFile({ path: "a.ts" }, { cwd: dir, anchors: true });
    for (const row of fresh.content.split("\n").slice(1)) {
      expect(result).toContain(row);
    }
  });

  it("chains a second edit using only the anchors from the first result", async () => {
    await put("a.ts", SOURCE);
    const first = await run("a.ts", [{ op: "replace", tag: await anchorOf("a.ts", 4), content: ["  return 2;"] }]);
    const next = /^(\d+#[A-Z]{2}):\}$/m.exec(first.split("Fresh anchors")[1]);
    expect(next).not.toBeNull();
    await run("a.ts", [{ op: "append", after: next![1], content: ["export default f;"] }]);
    expect(await get("a.ts")).toBe("import a from 'a';\n\nfunction f() {\n  return 2;\n}\nexport default f;\n");
  });

  it("applies several operations atomically against one snapshot", async () => {
    await put("a.ts", SOURCE);
    const a1 = await anchorOf("a.ts", 1);
    const a3 = await anchorOf("a.ts", 3);
    const a5 = await anchorOf("a.ts", 5);
    await run("a.ts", [
      { op: "prepend", before: a1, content: ["// header"] },
      { op: "replace", first: a3, last: a5, content: ["const f = () => 3;"] },
      { op: "append", after: a5, content: ["export { f };"] },
    ]);
    expect(await get("a.ts")).toBe("// header\nimport a from 'a';\n\nconst f = () => 3;\nexport { f };\n");
  });

  it("rejects a stale anchor, writes nothing, and shows the current anchors", async () => {
    await put("a.ts", SOURCE);
    const stale = await anchorOf("a.ts", 4);
    await put("a.ts", SOURCE.replace("return 1", "return 7"));
    const error = await run("a.ts", [{ op: "replace", tag: stale, content: ["x"] }]).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/1 line has changed since last read/);
    expect((error as Error).message).toMatch(/^>>> 4#[A-Z]{2}: {2}return 7;$/m);
    expect(await get("a.ts")).toBe(SOURCE.replace("return 1", "return 7"));
  });

  it("fails with a clear message when every edit is a no-op", async () => {
    await put("a.ts", SOURCE);
    await expect(run("a.ts", [{ op: "replace", tag: await anchorOf("a.ts", 4), content: ["  return 1;"] }])).rejects.toThrow(
      /No changes made: the replacement content is identical[\s\S]*" {2}return 1;"/,
    );
  });

  it("mentions skipped no-ops when other edits succeed", async () => {
    await put("a.ts", SOURCE);
    const result = await run("a.ts", [
      { op: "replace", tag: await anchorOf("a.ts", 4), content: ["  return 1;"] },
      { op: "replace", tag: await anchorOf("a.ts", 1), content: ["import b from 'b';"] },
    ]);
    expect(result).toContain("Skipped 1 no-op edit");
    expect(await get("a.ts")).toBe(SOURCE.replace("import a from 'a'", "import b from 'b'"));
  });

  it("accepts op aliases and a content string", async () => {
    await put("a.ts", SOURCE);
    await run("a.ts", [{ op: "set" as "replace", tag: await anchorOf("a.ts", 4), content: "  return 3;" }]);
    expect(await get("a.ts")).toContain("  return 3;");
  });

  it("validates operation shapes with specific messages", async () => {
    await put("a.ts", SOURCE);
    const tag = await anchorOf("a.ts", 1);
    await expect(run("a.ts", [{ op: "zap" as "replace", tag }])).rejects.toThrow(/op must be one of/);
    await expect(run("a.ts", [{ op: "replace", content: ["x"] }])).rejects.toThrow(/replace needs either "tag"/);
    await expect(run("a.ts", [{ op: "append", after: tag }])).rejects.toThrow(/append needs "content"/);
    await expect(run("a.ts", [{ op: "insert", after: tag, content: ["x"] }])).rejects.toThrow(/insert needs both/);
    await expect(run("a.ts", [{ op: "replace", tag, content: [1] as unknown as string[] }])).rejects.toThrow(/array of strings/);
    await expect(run("a.ts", [])).rejects.toThrow(/at least one edit/);
    await expect(editAnchored({ path: "", edits: [] }, { cwd: dir })).rejects.toThrow(/non-empty string path/);
    await expect(run("a.ts", [{ op: "replace", tag: "nonsense", content: ["x"] }])).rejects.toThrow(/Invalid line reference/);
  });

  it("preserves CRLF line endings and a BOM", async () => {
    await put("w.txt", "\uFEFFone\r\ntwo\r\nthree\r\n");
    await run("w.txt", [{ op: "replace", tag: await anchorOf("w.txt", 2), content: ["TWO", "TWO-B"] }]);
    expect(await get("w.txt")).toBe("\uFEFFone\r\nTWO\r\nTWO-B\r\nthree\r\n");
  });

  it("handles a file without a trailing newline", async () => {
    await put("n.txt", "first\nlast");
    await run("n.txt", [{ op: "append", after: await anchorOf("n.txt", 2), content: ["more"] }]);
    expect(await get("n.txt")).toBe("first\nlast\nmore");
  });

  it("works on an empty file by appending", async () => {
    await put("e.txt", "");
    await run("e.txt", [{ op: "append", content: ["hello"] }]);
    expect(await get("e.txt")).toBe("hello\n");
  });

  it("refuses binary files, directories and missing files", async () => {
    await put("blob.bin", Buffer.from([0, 1, 2, 0, 0, 5]));
    await fs.mkdir(path.join(dir, "sub"));
    await expect(run("blob.bin", [{ op: "append", content: ["x"] }])).rejects.toThrow(/binary file/);
    await expect(run("sub", [{ op: "append", content: ["x"] }])).rejects.toThrow(/directory/);
    await put("real.ts", "x\n");
    await expect(run("rael.ts", [{ op: "append", content: ["x"] }])).rejects.toThrow(/Did you mean: real\.ts/);
  });

  it("keeps the file mode and follows symlinks", async () => {
    await put("tool.sh", "echo a\n");
    await fs.chmod(path.join(dir, "tool.sh"), 0o750);
    await fs.symlink("tool.sh", path.join(dir, "link.sh"));
    await run("link.sh", [{ op: "replace", tag: await anchorOf("link.sh", 1), content: ["echo b"] }]);
    expect(await get("tool.sh")).toBe("echo b\n");
    expect((await fs.stat(path.join(dir, "tool.sh"))).mode & 0o777).toBe(0o750);
  });

  it("works with paths containing spaces and honors the path policy", async () => {
    await put("my dir/a b.ts", SOURCE);
    await run("my dir/a b.ts", [{ op: "append", content: ["// end"] }]);
    expect(await get("my dir/a b.ts")).toBe(`${SOURCE}// end\n`);

    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "revcode-anchored-out-"));
    try {
      await fs.writeFile(path.join(outside, "x.ts"), "x\n");
      const edits: AnchoredEditOperation[] = [{ op: "append", content: ["y"] }];
      await expect(editAnchored({ path: path.join(outside, "x.ts"), edits }, { cwd: dir })).rejects.toThrow(/escapes the working directory/);
      await editAnchored({ path: path.join(outside, "x.ts"), edits }, { cwd: dir, unrestricted: true });
      expect(await fs.readFile(path.join(outside, "x.ts"), "utf8")).toBe("x\ny\n");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("renames after editing and refuses to overwrite", async () => {
    await put("old.ts", "a\nb\n");
    await put("taken.ts", "keep\n");
    await expect(run("old.ts", [{ op: "append", content: ["c"] }], "taken.ts")).rejects.toThrow(/already exists/);
    expect(await get("old.ts")).toBe("a\nb\n");

    const result = await run("old.ts", [{ op: "append", content: ["c"] }], "nested/new.ts");
    expect(result).toContain("old.ts -> nested/new.ts");
    expect(await get("nested/new.ts")).toBe("a\nb\nc\n");
    await expect(fs.access(path.join(dir, "old.ts"))).rejects.toThrow();

    await run("nested/new.ts", [], "moved.ts");
    expect(await get("moved.ts")).toBe("a\nb\nc\n");
  });

  it("edits a large file quickly", async () => {
    const body = Array.from({ length: 50_000 }, (_, i) => `row ${i}`).join("\n");
    await put("big.txt", `${body}\n`);
    const tag = await anchorOf("big.txt", 1);
    const started = Date.now();
    await run("big.txt", [{ op: "replace", tag, content: ["top"] }]);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("editAnchoredToolDefinition", () => {
  it("documents every operation and the stale-anchor recovery", () => {
    const { name, description, parameters } = editAnchoredToolDefinition;
    expect(name).toBe("edit_anchored");
    for (const needle of ["LINE#ID", "replace", "append", "prepend", "insert", ">>>", "bottom-up", "rename"]) {
      expect(description).toContain(needle);
    }
    const edits = (parameters.properties as Record<string, { items: { properties: Record<string, unknown> } }>).edits;
    expect(Object.keys(edits.items.properties)).toEqual(["op", "tag", "first", "last", "after", "before", "content"]);
  });
});
