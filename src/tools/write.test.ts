import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderAnchoredLines } from "./anchored/hashline.js";
import { writeFile, writeTextFile, writeToolDefinition } from "./write.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "revcode-write-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const put = async (name: string, content: string | Buffer): Promise<void> => {
  const target = path.join(dir, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
};
const get = (name: string): Promise<string> => fs.readFile(path.join(dir, name), "utf8");
const write = (file: string, content: string, unrestricted = false) =>
  writeFile({ path: file, content }, { cwd: dir, unrestricted });

describe("writeFile", () => {
  it("creates a file and its parent directories", async () => {
    const result = await write("a/b/c.txt", "one\ntwo\n");
    expect(result).toEqual({
      path: "a/b/c.txt",
      bytesWritten: 8,
      created: true,
      diff: "--- a/a/b/c.txt\n+++ b/a/b/c.txt\n@@ -0,0 +1,2 @@\n+one\n+two",
    });
    expect(await get("a/b/c.txt")).toBe("one\ntwo\n");
  });

  it("returns a compact diff when overwriting", async () => {
    const before = Array.from({ length: 500 }, (_, i) => `row ${i}`).join("\n") + "\n";
    await put("big.txt", before);
    const result = await write("big.txt", before.replace("row 250\n", "ROW 250\n"));
    expect(result.created).toBe(false);
    expect(result.diff.split("\n").length).toBeLessThan(15);
    expect(result.diff).toContain("-row 250\n+ROW 250");
  });

  it("returns an empty diff when nothing changed", async () => {
    await put("same.txt", "x\n");
    expect((await write("same.txt", "x\n")).diff).toBe("");
  });

  it("writes empty content", async () => {
    await write("empty.txt", "");
    expect(await get("empty.txt")).toBe("");
  });

  it("preserves the mode of an existing file", async () => {
    await put("run.sh", "#!/bin/sh\n");
    await fs.chmod(path.join(dir, "run.sh"), 0o755);
    await write("run.sh", "#!/bin/sh\necho hi\n");
    expect((await fs.stat(path.join(dir, "run.sh"))).mode & 0o777).toBe(0o755);
  });

  it("refuses to overwrite a directory", async () => {
    await fs.mkdir(path.join(dir, "sub"));
    await expect(write("sub", "x")).rejects.toThrow("Path is a directory: sub. write_file needs a file path.");
  });

  it("fails clearly when a parent path component is a file", async () => {
    await put("plain.txt", "x\n");
    await expect(write("plain.txt/child.txt", "x")).rejects.toThrow(/a path component is an existing file|ENOTDIR/);
  });

  it("validates its input", async () => {
    await expect(writeFile(null as never, { cwd: dir })).rejects.toThrow(/must be an object/);
    await expect(write("", "x")).rejects.toThrow(/non-empty string path/);
    await expect(writeFile({ path: "a", content: 5 as never }, { cwd: dir })).rejects.toThrow(/string content/);
  });

  it("enforces the path policy and honors unrestricted absolute paths", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "revcode-write-out-"));
    try {
      const target = path.join(outside, "deep", "x.txt");
      await expect(write(target, "x")).rejects.toThrow(/escapes the working directory/);
      const result = await write(target, "x\n", true);
      expect(result.path).toBe(target);
      expect(await fs.readFile(target, "utf8")).toBe("x\n");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("writes through a symlink without replacing it", async () => {
    await put("real.txt", "old\n");
    await fs.symlink("real.txt", path.join(dir, "link.txt"));
    await write("link.txt", "new\n");
    expect((await fs.lstat(path.join(dir, "link.txt"))).isSymbolicLink()).toBe(true);
    expect(await get("real.txt")).toBe("new\n");
  });

  it("handles paths with spaces and non-ASCII content", async () => {
    const result = await write("my dir/файл ✓.txt", "héllo ✓\n");
    expect(result.bytesWritten).toBe(Buffer.byteLength("héllo ✓\n"));
    expect(await get("my dir/файл ✓.txt")).toBe("héllo ✓\n");
  });
});

describe("writeFile: keeping the file's framing", () => {
  it("keeps CRLF line endings when rewriting a CRLF file with LF text", async () => {
    await put("w.txt", "a\r\nb\r\n");
    const result = await write("w.txt", "a\nB\nc\n");
    expect(await get("w.txt")).toBe("a\r\nB\r\nc\r\n");
    expect(result.note).toContain("CRLF");
    expect(result.diff).toContain("-b\n+B\n+c");
    expect(result.diff).not.toContain("\r");
  });

  it("does not convert content that already has carriage returns, or mixed files", async () => {
    await put("w.txt", "a\r\nb\r\n");
    await write("w.txt", "x\r\ny\n");
    expect(await get("w.txt")).toBe("x\r\ny\n");
    await put("mixed.txt", "a\r\nb\nc\r\n");
    await write("mixed.txt", "p\nq\n");
    expect(await get("mixed.txt")).toBe("p\nq\n");
  });

  it("keeps a UTF-8 BOM", async () => {
    await put("b.txt", "﻿old\n");
    const result = await write("b.txt", "new\n");
    expect(await get("b.txt")).toBe("﻿new\n");
    expect(result.note).toContain("BOM");
    expect(result.diff).toContain("-old\n+new");
  });

  it("does not touch new files", async () => {
    const result = await write("fresh.txt", "a\nb\n");
    expect(result.note).toBeUndefined();
    expect(await get("fresh.txt")).toBe("a\nb\n");
  });

  it("strips LINE#ID: prefixes pasted from an anchored read", async () => {
    const view = renderAnchoredLines("const a = 1;\n\nexport { a };\n");
    const result = await write("pasted.ts", `${view}\n`);
    expect(await get("pasted.ts")).toBe("const a = 1;\n\nexport { a };\n");
    expect(result.note).toContain("LINE#ID");
  });

  it("leaves content alone when only some lines look like anchors", async () => {
    await write("mix.txt", "1#ZP:looks like one\nbut this does not\n");
    expect(await get("mix.txt")).toBe("1#ZP:looks like one\nbut this does not\n");
  });

  it("overwrites a binary file and says the diff was skipped", async () => {
    await put("blob.bin", Buffer.from([0, 1, 2, 0, 0]));
    const result = await write("blob.bin", "text now\n");
    expect(result.created).toBe(false);
    expect(result.diff).toBe("(previous content was binary or too large to diff)");
    expect(await get("blob.bin")).toBe("text now\n");
  });

  it("caps the returned diff for a big rewrite", async () => {
    const result = await write("big.txt", Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join("\n") + "\n");
    expect(result.diff.split("\n").length).toBeLessThanOrEqual(160);
    expect(result.diff).toMatch(/diff lines? omitted|^\+line 0$/m);
    expect(Buffer.byteLength(await get("big.txt"))).toBeGreaterThan(30_000);
  });
});

describe("writeTextFile / definition", () => {
  it("creates directories and writes in place", async () => {
    await writeTextFile(path.join(dir, "x/y/z.txt"), "ok");
    expect(await get("x/y/z.txt")).toBe("ok");
  });

  it("describes the tool", () => {
    expect(writeToolDefinition.name).toBe("write_file");
    expect(writeToolDefinition.parameters).toMatchObject({ required: ["path", "content"] });
  });
});
