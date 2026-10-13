import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeText,
  DEFAULT_READ_LIMIT,
  describeMissingFile,
  encodeText,
  loadTextFile,
  MAX_LINE_CHARS,
  MAX_READ_BYTES,
  readFile,
  readToolDefinition,
  readToolDefinitionFor,
  suggestSimilarPaths,
} from "./read.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "revcode-read-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function put(name: string, content: string | Buffer): Promise<string> {
  const target = path.join(dir, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}

const numbered = (count: number): string => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const read = (input: Parameters<typeof readFile>[0], options: Parameters<typeof readFile>[1] = {}) =>
  readFile(input, { cwd: dir, ...options });

describe("readFile: basics", () => {
  it("returns N|text rows with the total line count", async () => {
    await put("a.txt", "alpha\nbeta\n");
    expect(await read({ path: "a.txt" })).toEqual({ content: "1|alpha\n2|beta", path: "a.txt", totalLines: 2 });
  });

  it("treats CRLF files like LF files and hides the BOM", async () => {
    await put("w.txt", "﻿one\r\ntwo\r\n");
    const result = await read({ path: "w.txt" });
    expect(result.content).toBe("1|one\n2|two");
  });

  it("reports empty files", async () => {
    await put("e.txt", "");
    expect(await read({ path: "e.txt" })).toMatchObject({ content: "File is empty.", totalLines: 0 });
  });

  it("keeps a file without a trailing newline intact", async () => {
    await put("n.txt", "a\nb");
    expect((await read({ path: "n.txt" })).content).toBe("1|a\n2|b");
  });

  it("omits binary content", async () => {
    await put("blob.bin", Buffer.from([0, 1, 2, 3, 0, 0]));
    const result = await read({ path: "blob.bin" });
    expect(result.content).toBe("[binary file omitted]");
    expect(result.totalLines).toBe(0);
    expect(result.note).toMatch(/binary data/);
  });

  it("handles paths with spaces and symlinks", async () => {
    await put("my dir/a file.txt", "hi\n");
    expect((await read({ path: "my dir/a file.txt" })).content).toBe("1|hi");
    await fs.symlink("my dir/a file.txt", path.join(dir, "link.txt"));
    expect((await read({ path: "link.txt" })).content).toBe("1|hi");
  });

  it("validates its input", async () => {
    await expect(readFile(null as never, { cwd: dir })).rejects.toThrow(/must be an object/);
    await expect(read({ path: "" })).rejects.toThrow(/non-empty string path/);
    await put("a.txt", "x\n");
    await expect(read({ path: "a.txt", offset: 1.5 })).rejects.toThrow(/offset must be an integer/);
    await expect(read({ path: "a.txt", limit: "3" as never })).rejects.toThrow(/limit must be an integer/);
    await expect(read({ path: "a.txt", offset: 0 })).rejects.toThrow(/non-zero integer/);
    await expect(read({ path: "a.txt", limit: -1 })).rejects.toThrow(/non-negative/);
    expect((await read({ path: "a.txt", offset: null as never, limit: null as never })).content).toBe("1|x");
  });
});

describe("readFile: offset, limit and continuation", () => {
  beforeEach(async () => {
    await put("n.txt", numbered(10));
  });

  it("reads a window and says how to continue", async () => {
    const result = await read({ path: "n.txt", offset: 3, limit: 2 });
    expect(result.content).toBe("3|line 3\n4|line 4");
    expect(result.continuation).toBe("[Showing lines 3-4 of 10. Continue with offset: 5]");
  });

  it("gives no continuation when the window reaches the end of the file", async () => {
    const result = await read({ path: "n.txt", offset: 9 });
    expect(result.content).toBe("9|line 9\n10|line 10");
    expect(result.continuation).toBeUndefined();
  });

  it("supports negative offsets counting back from the end", async () => {
    expect((await read({ path: "n.txt", offset: -2 })).content).toBe("9|line 9\n10|line 10");
    expect((await read({ path: "n.txt", offset: -50 })).content.startsWith("1|line 1\n")).toBe(true);
  });

  it("returns nothing for limit 0 and explains an offset past the end", async () => {
    expect((await read({ path: "n.txt", limit: 0 })).content).toBe("");
    const past = await read({ path: "n.txt", offset: 99 });
    expect(past.content).toBe("");
    expect(past.continuation).toMatch(/Offset 99 is past the end of the file \(10 lines\)/);
  });

  it("caps a default read at 2000 lines and offers the next page", async () => {
    await put("big.txt", numbered(2_500));
    const first = await read({ path: "big.txt" });
    expect(first.content.split("\n")).toHaveLength(DEFAULT_READ_LIMIT);
    expect(first.totalLines).toBe(2_500);
    expect(first.continuation).toBe("[Showing lines 1-2000 of 2500. Continue with offset: 2001]");

    const second = await read({ path: "big.txt", offset: 2_001 });
    expect(second.content.split("\n")).toHaveLength(500);
    expect(second.content.startsWith("2001|line 2001")).toBe(true);
    expect(second.continuation).toBeUndefined();
  });

  it("caps output at about 50 KB, always shows at least one line, and resumes correctly", async () => {
    const row = "x".repeat(100);
    await put("wide.txt", `${Array.from({ length: 1_000 }, () => row).join("\n")}\n`);
    const first = await read({ path: "wide.txt" });
    expect(Buffer.byteLength(first.content)).toBeLessThanOrEqual(MAX_READ_BYTES);
    const shown = first.content.split("\n").length;
    expect(shown).toBeGreaterThan(300);
    expect(shown).toBeLessThan(600);
    expect(first.continuation).toBe(`[Showing lines 1-${shown} of 1000 (50 KB output limit). Continue with offset: ${shown + 1}]`);

    const next = await read({ path: "wide.txt", offset: shown + 1 });
    expect(next.content.startsWith(`${shown + 1}|`)).toBe(true);
  });

  it("cuts very long lines with a marker and a note", async () => {
    await put("long.txt", `${"a".repeat(5_000)}\nshort\n${"b".repeat(MAX_LINE_CHARS + 1)}\n`);
    const result = await read({ path: "long.txt" });
    const rows = result.content.split("\n");
    expect(rows[0]).toBe(`1|${"a".repeat(MAX_LINE_CHARS)}… [3000 more characters]`);
    expect(rows[1]).toBe("2|short");
    expect(rows[2]).toContain("… [1 more characters]");
    expect(result.note).toMatch(/Lines 1, 3 exceeded 2000 characters and were cut/);
  });

  it("returns a 3 MB, 200,000-line file page quickly", async () => {
    await put("huge.txt", numbered(200_000));
    const started = Date.now();
    const result = await read({ path: "huge.txt", offset: 150_000, limit: 5 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.content.startsWith("150000|line 150000")).toBe(true);
    expect(result.continuation).toBe("[Showing lines 150000-150004 of 200000. Continue with offset: 150005]");
  });
});

describe("readFile: anchors", () => {
  it("renders LINE#ID:text rows when anchors are requested", async () => {
    await put("a.ts", "const a = 1;\n\nexport { a };\n");
    const { content } = await read({ path: "a.ts" }, { anchors: true });
    expect(content.split("\n").map((row) => row.replace(/#[A-Z]{2}:/, "#XX:"))).toEqual([
      "1#XX:const a = 1;",
      "2#XX:",
      "3#XX:export { a };",
    ]);
  });

  it("uses the same row format in the paged continuation", async () => {
    await put("n.txt", numbered(5));
    const result = await read({ path: "n.txt", limit: 2 }, { anchors: true });
    expect(result.content.split("\n")[1]).toMatch(/^2#[A-Z]{2}:line 2$/);
    expect(result.continuation).toContain("Continue with offset: 3");
  });
});

describe("readFile: failures", () => {
  it("rejects directories with guidance", async () => {
    await fs.mkdir(path.join(dir, "sub"));
    await expect(read({ path: "sub" })).rejects.toThrow("Path is a directory: sub. Use list_directory to see its contents.");
  });

  it("suggests similarly named files for a missing path", async () => {
    await put("src/Server.ts", "x\n");
    await put("src/server.test.ts", "x\n");
    await put("src/other.ts", "x\n");
    await expect(read({ path: "src/server.ts" })).rejects.toThrow("File not found: src/server.ts. Did you mean: src/Server.ts, src/server.test.ts?");
    await expect(read({ path: "src/Servr.ts" })).rejects.toThrow(/Did you mean: src\/Server\.ts/);
    await expect(read({ path: "src/Server" })).rejects.toThrow(/Did you mean: src\/Server\.ts/);
    await expect(read({ path: "src/zzzzzzzz.ts" })).rejects.toThrow(/^File not found: src\/zzzzzzzz\.ts$/);
  });

  it("suggests a corrected directory name", async () => {
    await put("src/tools/read.ts", "x\n");
    await expect(read({ path: "src/tool/read.ts" })).rejects.toThrow(/Did you mean: src\/tools\/read\.ts/);
  });

  it("refuses paths outside the working directory unless unrestricted", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "revcode-read-out-"));
    try {
      const target = path.join(outside, "x.txt");
      await fs.writeFile(target, "outside\n");
      await expect(read({ path: target })).rejects.toThrow(/escapes the working directory/);
      const result = await read({ path: target }, { unrestricted: true });
      expect(result.content).toBe("1|outside");
      expect(result.path).toBe(target);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses git-ignored files unless unrestricted", async () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    await put(".gitignore", "secret.txt\n");
    await put("secret.txt", "s3cret\n");
    await expect(read({ path: "secret.txt" })).rejects.toThrow("Refusing to read ignored file: secret.txt");
    expect((await read({ path: "secret.txt" }, { unrestricted: true })).content).toBe("1|s3cret");
  });
});

describe("text codec", () => {
  it("detects BOM and dominant line endings", () => {
    expect(decodeText("a\nb\n")).toMatchObject({ bom: false, eol: "\n", mixed: false, text: "a\nb\n" });
    expect(decodeText("﻿a\r\nb\r\n")).toMatchObject({ bom: true, eol: "\r\n", mixed: false, text: "a\nb\n" });
    expect(decodeText("a\r\nb\r\nc\n")).toMatchObject({ eol: "\r\n", mixed: true });
    expect(decodeText("a\nb\nc\r\n")).toMatchObject({ eol: "\n", mixed: true });
    expect(decodeText("")).toMatchObject({ eol: "\n", mixed: false });
  });

  it("round-trips untouched text exactly", () => {
    for (const raw of ["a\nb\n", "﻿a\r\nb\r\n", "a\r\nb\nc\r\n", "no newline", "", "x\r\n\r\ny"]) {
      const decoded = decodeText(raw);
      expect(encodeText(decoded, decoded.text)).toBe(raw);
    }
  });

  it("restores mixed endings per line after an edit", () => {
    const decoded = decodeText("a\r\nb\nc\r\nd\r\n");
    expect(encodeText(decoded, "a\nB\nc\nd\n")).toBe("a\r\nB\nc\r\nd\r\n");
    expect(encodeText(decoded, "a\nb\nNEW\nc\nd\n")).toBe("a\r\nb\nNEW\nc\r\nd\r\n");
  });

  it("restores mixed endings when LF dominates", () => {
    const decoded = decodeText("a\nb\nc\r\nd\n");
    expect(decoded.eol).toBe("\n");
    expect(encodeText(decoded, "a\nB\nc\nd\ne\n")).toBe("a\nB\nc\r\nd\ne\n");
  });

  it("loads files for editing and refuses the unsafe ones", async () => {
    const file = await put("a.txt", "﻿hi\r\n");
    const loaded = await loadTextFile(file, dir);
    expect(loaded).toMatchObject({ text: "hi\n", bom: true, eol: "\r\n", displayPath: "a.txt" });
    await put("bin.dat", Buffer.from([0, 0, 0, 1]));
    await expect(loadTextFile(path.join(dir, "bin.dat"), dir)).rejects.toThrow(/Refusing to edit binary file: bin\.dat/);
    await expect(loadTextFile(path.join(dir, "bin.dat"), dir, { verb: "patch" })).rejects.toThrow(/Refusing to patch binary/);
    await put("latin.txt", Buffer.from([0x61, 0xe9, 0x62]));
    await expect(loadTextFile(path.join(dir, "latin.txt"), dir)).rejects.toThrow(/not valid UTF-8/);
    await expect(loadTextFile(path.join(dir, "missing.txt"), dir)).rejects.toThrow(/File not found/);
  });

  it("describes missing files and suggests siblings", async () => {
    await put("README.md", "x\n");
    expect(await describeMissingFile(path.join(dir, "readme.md"), dir)).toBe("File not found: readme.md. Did you mean: README.md?");
    expect(await suggestSimilarPaths(path.join(dir, "nothing-like-it.xyz"), dir)).toEqual([]);
  });
});

describe("readToolDefinition", () => {
  it("documents paging and the row format", () => {
    expect(readToolDefinition.name).toBe("read_file");
    expect(readToolDefinition.description).toContain("N|text");
    expect(readToolDefinition.description).toContain("Continue with offset");
    expect(readToolDefinitionFor(true).description).toContain("LINE#ID:text");
    expect(readToolDefinitionFor(true).parameters).toEqual(readToolDefinition.parameters);
  });
});
