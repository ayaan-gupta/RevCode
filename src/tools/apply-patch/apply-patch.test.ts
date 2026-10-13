import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveNewContents } from "./derive.js";
import { applyPatch, applyPatchToolDefinition } from "./index.js";
import { parsePatch, PatchError, type Hunk } from "./parse.js";
import { seekAll, seekSequence } from "./seek.js";

const envelope = (...body: string[]): string => ["*** Begin Patch", ...body, "*** End Patch"].join("\n");

function updateChunks(patch: string): Extract<Hunk, { type: "update" }>["chunks"] {
  const [hunk] = parsePatch(patch);
  if (hunk.type !== "update") throw new Error("expected an update hunk");
  return hunk.chunks;
}

describe("parsePatch", () => {
  it("parses add, delete, update and move sections", () => {
    const hunks = parsePatch(
      envelope(
        "*** Add File: n.txt",
        "+hello",
        "+",
        "+world",
        "*** Delete File: o.txt",
        "*** Update File: p.py",
        "*** Move to: q.py",
        "@@",
        "-a",
        "+b",
      ),
    );
    expect(hunks.map((h) => h.type)).toEqual(["add", "delete", "update"]);
    expect(hunks[0]).toEqual({ type: "add", path: "n.txt", contents: "hello\n\nworld\n" });
    expect(hunks[1]).toEqual({ type: "delete", path: "o.txt" });
    expect(hunks[2]).toMatchObject({ type: "update", path: "p.py", movePath: "q.py" });
  });

  it("records context rows so they keep their original bytes", () => {
    const [chunk] = updateChunks(envelope("*** Update File: a.txt", "@@ def f():", " keep", "-old", "+new", " tail"));
    expect(chunk.contexts).toEqual(["def f():"]);
    expect(chunk.oldLines).toEqual(["keep", "old", "tail"]);
    expect(chunk.newLines).toEqual(["keep", "new", "tail"]);
    expect(chunk.contextIndices).toEqual([[0, 0], [2, 2]]);
  });

  it("lets the first chunk omit @@ and treats bare blank lines as empty context", () => {
    const [chunk] = updateChunks(envelope("*** Update File: a.txt", " one", "", "-two", "+TWO"));
    expect(chunk.oldLines).toEqual(["one", "", "two"]);
    expect(chunk.contexts).toEqual([]);
  });

  it("accepts nested @@ contexts and the End of File marker", () => {
    const [first, second] = updateChunks(
      envelope("*** Update File: a.py", "@@ class A", "@@ def m():", "-x", "+y", "@@", "+tail", "*** End of File"),
    );
    expect(first.contexts).toEqual(["class A", "def m():"]);
    expect(second.isEndOfFile).toBe(true);
    expect(second.oldLines).toEqual([]);
  });

  it("strips a bare heredoc, a heredoc command line and a markdown fence", () => {
    const inner = envelope("*** Add File: a.txt", "+x");
    expect(parsePatch(`<<'EOF'\n${inner}\nEOF`)).toHaveLength(1);
    expect(parsePatch(`<<EOF\n${inner}\nEOF`)).toHaveLength(1);
    expect(parsePatch(`<<"EOF"\n${inner}\nEOF`)).toHaveLength(1);
    expect(parsePatch(`cd sub && apply_patch <<'PATCH'\n${inner}\nPATCH`)).toHaveLength(1);
    expect(parsePatch(`\`\`\`diff\n${inner}\n\`\`\``)).toHaveLength(1);
  });

  it("tolerates whitespace around markers and CRLF patches", () => {
    expect(parsePatch(`  *** Begin Patch  \r\n *** Add File: a.txt\r\n+x\r\n*** End Patch  \r\n`)).toEqual([
      { type: "add", path: "a.txt", contents: "x\n" },
    ]);
  });

  it("treats a blank line inside an added file as an empty line", () => {
    const [hunk] = parsePatch(envelope("*** Add File: a.txt", "+one", "", "+three"));
    expect(hunk).toEqual({ type: "add", path: "a.txt", contents: "one\n\nthree\n" });
  });

  it("uses Codex's error strings", () => {
    expect(() => parsePatch("bad")).toThrow("invalid patch: The first line of the patch must be '*** Begin Patch'");
    expect(() => parsePatch("*** Begin Patch\nbad")).toThrow("invalid patch: The last line of the patch must be '*** End Patch'");
    expect(() => parsePatch("*** Begin Patch\n*** Frobnicate: x\n*** End Patch")).toThrow(
      "invalid hunk at line 2, '*** Frobnicate: x' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'",
    );
    expect(() => parsePatch(envelope("*** Update File: t.py"))).toThrow(
      "invalid hunk at line 2, Update file hunk for path 't.py' is empty",
    );
    expect(() => parsePatch(envelope("*** Update File: t.py", "@@"))).toThrow(
      "invalid hunk at line 4, Update hunk does not contain any lines",
    );
    expect(() => parsePatch(envelope("*** Update File: t.py", "@@", "oops"))).toThrow(
      "invalid hunk at line 4, Unexpected line found in update hunk: 'oops'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)",
    );
    expect(() => parsePatch(envelope("*** Update File: t.py", "@@", "-a", "oops"))).toThrow(
      "Expected update hunk to start with a @@ context marker, got: 'oops'",
    );
    expect(() => parsePatch(envelope("*** Update File: t.py", "*** End of File"))).toThrow(PatchError);
  });
});

describe("seekSequence", () => {
  const lines = ["alpha", "  beta  ", "gamma", "beta", "\u201Cquoted\u201D \u2013 dash"];

  it("finds exact matches first, then looser ones", () => {
    expect(seekSequence(lines, ["beta"], 0, false)).toBe(3);
    expect(seekSequence(lines, ["beta"], 4, false)).toBe(-1);
    expect(seekSequence(["x  ", "y"], ["x", "y"], 0, false)).toBe(0);
    expect(seekSequence(["  x", "  y"], ["x", "y"], 0, false)).toBe(0);
    expect(seekSequence(lines, ['"quoted" - dash'], 0, false)).toBe(4);
    expect(seekSequence(["a  \t b"], ["a b"], 0, false)).toBe(0);
  });

  it("honors start and handles degenerate patterns", () => {
    expect(seekSequence(lines, [], 2, false)).toBe(2);
    expect(seekSequence(["a"], ["a", "b"], 0, false)).toBe(-1);
    expect(seekSequence(lines, ["alpha"], 1, false)).toBe(-1);
  });

  it("prefers the end of the file for end-anchored hunks and falls back to a full search", () => {
    expect(seekSequence(["end", "mid", "end"], ["end"], 0, true)).toBe(2);
    expect(seekSequence(["end", "mid", "tail"], ["end"], 0, true)).toBe(0);
  });

  it("lists every match for ambiguity warnings", () => {
    expect(seekAll(["a", "b", "a", "b", "a"], ["a"], 0, false)).toEqual([0, 2, 4]);
  });
});

describe("deriveNewContents", () => {
  const apply = (original: string, patch: string): string => deriveNewContents(original, updateChunks(patch), "f").content;

  it("locates hunks by an @@ context line", () => {
    const src = "import foo\n\ndef f():\n    pass\n\ndef g():\n    pass\n";
    expect(apply(src, envelope("*** Update File: f", "@@ def g():", "-    pass", "+    return 1"))).toBe(
      "import foo\n\ndef f():\n    pass\n\ndef g():\n    return 1\n",
    );
  });

  it("walks nested contexts in order", () => {
    const src = "class A:\n    def m(self):\n        pass\nclass B:\n    def m(self):\n        pass\n";
    expect(apply(src, envelope("*** Update File: f", "@@ class B:", "@@     def m(self):", "-        pass", "+        return 2"))).toBe(
      "class A:\n    def m(self):\n        pass\nclass B:\n    def m(self):\n        return 2\n",
    );
  });

  it("keeps context lines byte-identical and matches through whitespace and punctuation drift", () => {
    const src = "x = 1  \ny = \u201Ca\u201D \u2013 b\nz = 3\n";
    expect(apply(src, envelope("*** Update File: f", "@@", " x = 1", '-y = "a" - b', "+y = 2"))).toBe("x = 1  \ny = 2\nz = 3\n");
  });

  it("preserves CRLF for untouched lines and uses the file's ending for new lines", () => {
    expect(apply("a\r\nb\r\nc\r\n", envelope("*** Update File: f", "@@", " a", "-b", "+B", "+B2", " c"))).toBe("a\r\nB\r\nB2\r\nc\r\n");
  });

  it("anchors End of File hunks at the end even when the pattern occurs earlier", () => {
    expect(apply("end\nmid\nend\n", envelope("*** Update File: f", "@@", "-end", "+END", "*** End of File"))).toBe("end\nmid\nEND\n");
  });

  it("appends a pure insertion at the end of the file", () => {
    expect(apply("a\nb\n", envelope("*** Update File: f", "@@", "+c"))).toBe("a\nb\nc\n");
  });

  it("inserts right after a named context when the hunk only adds lines", () => {
    expect(apply("import a\nimport b\n\ncode()\n", envelope("*** Update File: f", "@@ import a", "+import a2"))).toBe(
      "import a\nimport a2\nimport b\n\ncode()\n",
    );
  });

  it("applies several hunks in order and handles insertions that move later lines", () => {
    const src = "1\n2\n3\n4\n5\n6\n";
    expect(
      apply(src, envelope("*** Update File: f", "@@", " 1", "+1.5", " 2", "@@", " 5", "-6", "+six")),
    ).toBe("1\n1.5\n2\n3\n4\n5\nsix\n");
  });

  it("keeps a missing final newline missing, and tolerates a trailing blank context row", () => {
    expect(apply("a\nb", envelope("*** Update File: f", "@@", " a", "-b", "+B"))).toBe("a\nB");
    expect(apply("a\nb\n", envelope("*** Update File: f", "@@", "-b", "+B", " "))).toBe("a\nB\n");
    expect(apply("a\nb", envelope("*** Update File: f", "@@", " b", "+c"))).toBe("a\nb\nc");
  });

  it("can empty a file and fill an empty one", () => {
    expect(apply("only\n", envelope("*** Update File: f", "@@", "-only"))).toBe("");
    expect(apply("", envelope("*** Update File: f", "@@", "+first"))).toBe("first\n");
  });

  it("warns when a hunk without an @@ context matches several places", () => {
    const derived = deriveNewContents(
      "if x:\n    run()\nif y:\n    run()\n",
      updateChunks(envelope("*** Update File: f", "@@", "-    run()", "+    go()")),
      "f",
    );
    expect(derived.content).toBe("if x:\n    go()\nif y:\n    run()\n");
    expect(derived.warnings).toHaveLength(1);
    expect(derived.warnings[0]).toMatch(/matched 2 places \(lines 2, 4\); applied at line 2/);
  });

  it("warns when an @@ context line is itself ambiguous", () => {
    const derived = deriveNewContents(
      "def f():\n    a\ndef f():\n    a\n",
      updateChunks(envelope("*** Update File: f", "@@ def f():", "-    a", "+    b")),
      "f",
    );
    expect(derived.warnings[0]).toMatch(/context 'def f\(\):' appears at lines 1, 3; used line 1/);
  });

  it("fails with Codex's messages plus the closest match", () => {
    const chunks = updateChunks(envelope("*** Update File: t.py", "@@", "-    total = 1", "+    total = 2"));
    expect(() => deriveNewContents("def f():\n    total = 0\n", chunks, "t.py")).toThrow(
      /Failed to find expected lines in t\.py:\n {4}total = 1\nClosest match in the file \(\d+% similar\) at line 2:/,
    );
    expect(() =>
      deriveNewContents("zzz\n", updateChunks(envelope("*** Update File: t.py", "@@ nope", "-a", "+b")), "t.py"),
    ).toThrow("Failed to find context 'nope' in t.py");
  });
});

describe("applyPatch tool", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "revcode-patch-"));
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
  const exists = (name: string): Promise<boolean> => fs.access(path.join(dir, name)).then(() => true, () => false);
  const run = (patch: string, unrestricted = false): Promise<string> => applyPatch({ input: patch }, { cwd: dir, unrestricted });

  it("applies add, update and delete together and reports them Codex-style", async () => {
    await put("src/app.py", "def greet():\n    print('Hi')\n");
    await put("obsolete.txt", "old\n");
    const result = await run(
      envelope(
        "*** Add File: hello.txt",
        "+Hello world",
        "*** Update File: src/app.py",
        "@@ def greet():",
        "-    print('Hi')",
        "+    print('Hello')",
        "*** Delete File: obsolete.txt",
      ),
    );
    expect(result.startsWith("Success. Updated the following files:\nA hello.txt\nM src/app.py\nD obsolete.txt")).toBe(true);
    expect(result).toContain("-    print('Hi')\n+    print('Hello')");
    expect(await get("hello.txt")).toBe("Hello world\n");
    expect(await get("src/app.py")).toBe("def greet():\n    print('Hello')\n");
    expect(await exists("obsolete.txt")).toBe(false);
  });

  it("accepts the patch under the `patch` alias", async () => {
    await put("a.txt", "x\n");
    await applyPatch({ patch: envelope("*** Update File: a.txt", "@@", "-x", "+y") }, { cwd: dir });
    expect(await get("a.txt")).toBe("y\n");
  });

  it("is atomic across files: a failing hunk leaves everything untouched", async () => {
    await put("a.txt", "one\n");
    await put("b.txt", "two\n");
    const patch = envelope(
      "*** Update File: a.txt",
      "@@",
      "-one",
      "+ONE",
      "*** Update File: b.txt",
      "@@",
      "-missing",
      "+x",
      "*** Add File: c.txt",
      "+new",
    );
    await expect(run(patch)).rejects.toThrow(/apply_patch verification failed: Failed to find expected lines in b\.txt:[\s\S]*No files were changed\./);
    expect(await get("a.txt")).toBe("one\n");
    expect(await exists("c.txt")).toBe(false);
  });

  it("lets later hunks see earlier ones, including add-then-update of the same path", async () => {
    await run(
      envelope("*** Add File: n.txt", "+one", "+two", "*** Update File: n.txt", "@@", " one", "-two", "+TWO", "*** Add File: z.txt", "+z"),
    );
    expect(await get("n.txt")).toBe("one\nTWO\n");
  });

  it("moves a file, rewrites it, and keeps its mode", async () => {
    await put("tools/run.sh", "echo a\n");
    await fs.chmod(path.join(dir, "tools/run.sh"), 0o755);
    const result = await run(envelope("*** Update File: tools/run.sh", "*** Move to: bin/start.sh", "@@", "-echo a", "+echo b"));
    expect(result).toContain("A bin/start.sh");
    expect(result).toContain("D tools/run.sh");
    expect(await get("bin/start.sh")).toBe("echo b\n");
    expect(await exists("tools/run.sh")).toBe(false);
    expect((await fs.stat(path.join(dir, "bin/start.sh"))).mode & 0o777).toBe(0o755);
  });

  it("preserves the mode, CRLF endings and BOM of an updated file", async () => {
    await put("w.txt", "\uFEFFa\r\nb\r\nc\r\n");
    await fs.chmod(path.join(dir, "w.txt"), 0o640);
    await run(envelope("*** Update File: w.txt", "@@", " a", "-b", "+B", " c"));
    expect(await get("w.txt")).toBe("\uFEFFa\r\nB\r\nc\r\n");
    expect((await fs.stat(path.join(dir, "w.txt"))).mode & 0o777).toBe(0o640);
  });

  it("warns when it overwrites a file via Add File or finds an ambiguous hunk", async () => {
    await put("a.txt", "keep me\n");
    await put("d.txt", "x\ny\nx\n");
    const result = await run(
      envelope("*** Add File: a.txt", "+replaced", "*** Update File: d.txt", "@@", "-x", "+X"),
    );
    expect(result).toContain("Warnings:");
    expect(result).toContain("Add File a.txt: the file already existed and was overwritten.");
    expect(result).toMatch(/matched 2 places \(lines 1, 3\)/);
    expect(await get("a.txt")).toBe("replaced\n");
    expect(await get("d.txt")).toBe("X\ny\nx\n");
  });

  it("reports an update that changes nothing", async () => {
    await put("a.txt", "x\n");
    const result = await run(envelope("*** Update File: a.txt", "@@", "-x", "+x"));
    expect(result).toContain("the patch leaves the file unchanged");
  });

  it("fails clearly for missing files, directories and binary files", async () => {
    await put("blob.bin", Buffer.from([0, 1, 2, 3, 0]));
    await fs.mkdir(path.join(dir, "sub"));
    await expect(run(envelope("*** Update File: nope.txt", "@@", "-a", "+b"))).rejects.toThrow(
      /Failed to read file to update nope\.txt: the file does not exist\. Use '\*\*\* Add File: nope\.txt'/,
    );
    await expect(run(envelope("*** Delete File: nope.txt"))).rejects.toThrow(/Failed to delete file nope\.txt: the file does not exist/);
    await expect(run(envelope("*** Delete File: sub"))).rejects.toThrow(/it is a directory/);
    await expect(run(envelope("*** Add File: sub", "+x"))).rejects.toThrow(/it is a directory/);
    await expect(run(envelope("*** Update File: blob.bin", "@@", "-a", "+b"))).rejects.toThrow(/binary file/);
  });

  it("reports parse errors with the verification prefix", async () => {
    await expect(run("not a patch")).rejects.toThrow(
      "apply_patch verification failed: invalid patch: The first line of the patch must be '*** Begin Patch'",
    );
    await expect(run(envelope())).rejects.toThrow(/No files were modified/);
    await expect(applyPatch({} as never, { cwd: dir })).rejects.toThrow(/requires the patch text/);
  });

  it("enforces the path policy and honors unrestricted absolute paths", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "revcode-patch-out-"));
    try {
      const target = path.join(outside, "x.txt");
      await fs.writeFile(target, "old\n");
      const patch = envelope(`*** Update File: ${target}`, "@@", "-old", "+new");
      await expect(run(patch)).rejects.toThrow(/escapes the working directory/);
      expect(await fs.readFile(target, "utf8")).toBe("old\n");
      const result = await run(patch, true);
      expect(result).toContain(`M ${target}`);
      expect(await fs.readFile(target, "utf8")).toBe("new\n");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("handles paths with spaces and creates parent directories", async () => {
    await run(envelope("*** Add File: my dir/new file.txt", "+hi"));
    expect(await get("my dir/new file.txt")).toBe("hi\n");
  });

  it("refuses to create a file under a path component that is a file", async () => {
    await put("plain.txt", "x\n");
    await expect(run(envelope("*** Add File: plain.txt/child.txt", "+x"))).rejects.toThrow(/is a file, not a directory/);
  });

  it("patches through a symlink without replacing it", async () => {
    await put("real.txt", "a\n");
    await fs.symlink("real.txt", path.join(dir, "link.txt"));
    await run(envelope("*** Update File: link.txt", "@@", "-a", "+b"));
    expect((await fs.lstat(path.join(dir, "link.txt"))).isSymbolicLink()).toBe(true);
    expect(await get("real.txt")).toBe("b\n");
  });

  it("reports what was already applied when a write fails midway", async () => {
    await put("a.txt", "a\n");
    await put("b.txt", "b\n");
    const realWrite = fs.writeFile.bind(fs);
    let calls = 0;
    const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
      calls += 1;
      if (calls === 2) throw new Error("ENOSPC: no space left on device");
      return realWrite(...args);
    });
    try {
      const patch = envelope(
        "*** Update File: a.txt",
        "@@",
        "-a",
        "+A",
        "*** Update File: b.txt",
        "@@",
        "-b",
        "+B",
        "*** Add File: c.txt",
        "+c",
      );
      const error = await run(patch).catch((e: Error) => e);
      expect((error as Error).message).toMatch(/^apply_patch failed while applying b\.txt: ENOSPC/);
      expect((error as Error).message).toContain("Completed before failure:\nM a.txt");
      expect((error as Error).message).toContain("Not applied: A c.txt");
    } finally {
      spy.mockRestore();
    }
    expect(await get("a.txt")).toBe("A\n");
    expect(await get("b.txt")).toBe("b\n");
  });

  it("handles a large file patch quickly", async () => {
    const body = Array.from({ length: 100_000 }, (_, i) => `line ${i}`).join("\n");
    await put("big.txt", `${body}\n`);
    const started = Date.now();
    await run(envelope("*** Update File: big.txt", "@@", " line 70000", "-line 70001", "+LINE 70001", " line 70002"));
    expect(Date.now() - started).toBeLessThan(3_000);
    expect((await get("big.txt")).split("\n")[70_001]).toBe("LINE 70001");
  });
});

describe("applyPatchToolDefinition", () => {
  it("exposes a single required `input` string and documents the format", () => {
    const { name, description, parameters } = applyPatchToolDefinition;
    expect(name).toBe("apply_patch");
    expect(parameters).toMatchObject({ required: ["input"], additionalProperties: false });
    for (const needle of ["*** Begin Patch", "*** Add File", "*** Delete File", "*** Update File", "*** Move to", "@@", "*** End of File"]) {
      expect(description).toContain(needle);
    }
  });
});
