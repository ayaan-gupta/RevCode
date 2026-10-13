import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyEdits, editFile, EditError } from "./edit.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "revcode-edit-"));
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

const get = (name: string): Promise<string> => fs.readFile(path.join(dir, name), "utf8");

const edit = (file: string, oldText: string, newText: string, replaceAll?: boolean) =>
  editFile({ path: file, edits: [{ oldText, newText, replaceAll }] }, { cwd: dir });

describe("editFile: exact edits", () => {
  it("replaces a unique snippet and returns a compact diff", async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `const v${i} = ${i};`);
    await put("a.ts", `${lines.join("\n")}\n`);
    const result = await edit("a.ts", "const v150 = 150;", "const v150 = 'x';");
    expect(await get("a.ts")).toContain("const v150 = 'x';");
    expect(result).toMatch(/^Edited a\.ts \(1 edit; \+1 -1\)\./);
    expect(result).toContain("--- a/a.ts\n+++ b/a.ts\n@@ -148,7 +148,7 @@");
    expect(result.split("\n").length).toBeLessThan(20);
    expect(result).not.toContain("did not match");
  });

  it("applies several edits in order, each seeing the previous result", async () => {
    await put("a.txt", "one\ntwo\nthree\n");
    await editFile(
      {
        path: "a.txt",
        edits: [
          { oldText: "one", newText: "uno" },
          { oldText: "uno\ntwo", newText: "uno\ndos" },
        ],
      },
      { cwd: dir },
    );
    expect(await get("a.txt")).toBe("uno\ndos\nthree\n");
  });

  it("is atomic: a failing later edit leaves the file untouched", async () => {
    await put("a.txt", "one\ntwo\n");
    await expect(
      editFile(
        { path: "a.txt", edits: [{ oldText: "one", newText: "1" }, { oldText: "missing", newText: "x" }] },
        { cwd: dir },
      ),
    ).rejects.toThrow(/Edit 2 of 2: Could not find oldText[\s\S]*No edits were applied/);
    expect(await get("a.txt")).toBe("one\ntwo\n");
  });

  it("supports deleting text with an empty newText", async () => {
    await put("a.txt", "keep\ndrop me\nkeep\n");
    await edit("a.txt", "drop me\n", "");
    expect(await get("a.txt")).toBe("keep\nkeep\n");
  });

  it("accepts a single edit object instead of an array", async () => {
    await put("a.txt", "x\n");
    await editFile({ path: "a.txt", edits: { oldText: "x", newText: "y" } } as never, { cwd: dir });
    expect(await get("a.txt")).toBe("y\n");
  });

  it("works on paths containing spaces", async () => {
    await put("my dir/the file.txt", "alpha\n");
    await edit("my dir/the file.txt", "alpha", "beta");
    expect(await get("my dir/the file.txt")).toBe("beta\n");
  });

  it("preserves a missing trailing newline", async () => {
    await put("a.txt", "first\nlast");
    await edit("a.txt", "last", "LAST");
    expect(await get("a.txt")).toBe("first\nLAST");
  });

  it("edits an empty file only through an existing anchor (nothing to match)", async () => {
    await put("empty.txt", "");
    await expect(edit("empty.txt", "x", "y")).rejects.toThrow(/Could not find oldText/);
  });

  it("preserves the file mode", async () => {
    const file = await put("run.sh", "#!/bin/sh\necho hi\n");
    await fs.chmod(file, 0o755);
    await edit("run.sh", "echo hi", "echo bye");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o755);
  });
});

describe("editFile: validation and errors", () => {
  it("rejects identical oldText and newText", async () => {
    await put("a.txt", "x\n");
    await expect(edit("a.txt", "x", "x")).rejects.toThrow("No changes to apply: oldText and newText are identical.");
  });

  it("rejects an empty oldText with guidance", async () => {
    await put("a.txt", "x\n");
    await expect(edit("a.txt", "", "y")).rejects.toThrow(/oldText must be a non-empty string.*write_file/s);
  });

  it("rejects missing edits", async () => {
    await put("a.txt", "x\n");
    await expect(editFile({ path: "a.txt", edits: [] }, { cwd: dir })).rejects.toThrow(/at least one/);
    await expect(editFile({ path: "", edits: [] }, { cwd: dir })).rejects.toThrow(/non-empty string path/);
  });

  it("explains a net no-op across edits", async () => {
    await put("a.txt", "x\n");
    await expect(
      editFile(
        { path: "a.txt", edits: [{ oldText: "x", newText: "y" }, { oldText: "y", newText: "x" }] },
        { cwd: dir },
      ),
    ).rejects.toThrow(/leave the file unchanged/);
  });

  it("suggests similarly named files when the path does not exist", async () => {
    await put("src/server.ts", "x\n");
    await expect(edit("src/Server.ts", "x", "y")).rejects.toThrow(/File not found: src\/Server\.ts\. Did you mean: src\/server\.ts\?/);
  });

  it("refuses directories, binary files, non-UTF-8 files and huge files", async () => {
    await fs.mkdir(path.join(dir, "sub"));
    await expect(edit("sub", "x", "y")).rejects.toThrow(/directory/);

    await put("blob.bin", Buffer.from([0, 1, 2, 3, 0, 0, 255, 254]));
    await expect(edit("blob.bin", "x", "y")).rejects.toThrow(/Refusing to edit binary file/);

    await put("latin1.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    await expect(edit("latin1.txt", "caf", "x")).rejects.toThrow(/not valid UTF-8/);

    const big = path.join(dir, "big.txt");
    await fs.writeFile(big, Buffer.alloc(17 * 1024 * 1024, 0x61));
    await expect(edit("big.txt", "a", "b")).rejects.toThrow(/too large to edit/);
  });

  it("enforces the path policy and honors unrestricted", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "revcode-outside-"));
    try {
      const target = path.join(outside, "x.txt");
      await fs.writeFile(target, "old\n");
      await expect(editFile({ path: target, edits: [{ oldText: "old", newText: "new" }] }, { cwd: dir })).rejects.toThrow(
        /escapes the working directory/,
      );
      const result = await editFile(
        { path: target, edits: [{ oldText: "old", newText: "new" }] },
        { cwd: dir, unrestricted: true },
      );
      expect(await fs.readFile(target, "utf8")).toBe("new\n");
      expect(result).toContain(`Edited ${target}`);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("edits through a symlink without replacing it", async () => {
    await put("real.txt", "alpha\n");
    await fs.symlink("real.txt", path.join(dir, "link.txt"));
    await edit("link.txt", "alpha", "beta");
    expect((await fs.lstat(path.join(dir, "link.txt"))).isSymbolicLink()).toBe(true);
    expect(await get("real.txt")).toBe("beta\n");
  });
});

describe("editFile: ambiguity", () => {
  const dup = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 1;\n}\n";

  it("rejects an ambiguous oldText and lists locations with context", async () => {
    await put("d.ts", dup);
    const error = await edit("d.ts", "  return 1;", "  return 2;").catch((e: Error) => e);
    expect(error).toBeInstanceOf(EditError);
    const message = (error as Error).message;
    expect(message).toContain("Found 2 matches for oldText in d.ts");
    expect(message).toContain("replaceAll");
    expect(message).toContain("Match 1 (line 2):");
    expect(message).toContain(">2|  return 1;");
    expect(message).toContain(" 1|function a() {");
    expect(message).toContain("Match 2 (line 6):");
    expect(await get("d.ts")).toBe(dup);
  });

  it("shows at most five matches", async () => {
    await put("many.txt", "x\n".repeat(9));
    const message = await edit("many.txt", "x", "y").catch((e: Error) => e.message);
    expect(message).toContain("Found 9 matches");
    expect(message).toContain("showing the first 5");
    expect(message).toContain("Match 5");
    expect(message).not.toContain("Match 6");
  });

  it("disambiguates with more context", async () => {
    await put("d.ts", dup);
    await edit("d.ts", "function b() {\n  return 1;", "function b() {\n  return 2;");
    expect(await get("d.ts")).toBe("function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n");
  });

  it("replaceAll changes every occurrence and reports the count", async () => {
    await put("d.ts", dup);
    const result = await edit("d.ts", "  return 1;", "  return 2;", true);
    expect(await get("d.ts")).toBe(dup.replaceAll("return 1", "return 2"));
    expect(result).toContain("1 edit, 2 replacements");
  });

  it("does not fall through to a fuzzier tier when the exact tier is ambiguous", async () => {
    await put("d.ts", "if (x) {\n  a();\n}\n\nif (x) {\n    b();\n}\n");
    await expect(edit("d.ts", "if (x) {", "if (y) {")).rejects.toThrow(/Found 2 matches/);
  });

  it("reports ambiguity found by a fuzzy tier", async () => {
    await put("d.ts", "  run();\n\n\trun();\n");
    await expect(edit("d.ts", "run();", "go();")).rejects.toThrow(/Found 2 matches/);
  });
});

describe("editFile: not-found diagnostics", () => {
  const source = "def compute_total(items):\n    total = 0\n    for item in items:\n        total += item.price\n    return total\n";

  it("names the closest match with the differing line", async () => {
    await put("m.py", source);
    const message = await edit("m.py", "    total = 1\n    for item in items:", "x").catch((e: Error) => e.message);
    expect(message).toMatch(/^Could not find oldText in m\.py\.\nClosest match \(\d+% similar\) at line 2:\n- {5}total = 1\n\+ {5}total = 0\n/);
    expect(message).toContain("Re-read the file");
  });

  it("says when nothing in the file resembles oldText", async () => {
    await put("m.py", source);
    const message = await edit("m.py", "qqqqqqqqqqqqqqqqqqqqqqqqqqqqq", "x").catch((e: Error) => e.message);
    expect(message).toMatch(/Nothing in the file is similar to oldText/);
  });

  it("flags line-number prefixes when the stripped text is not found either", async () => {
    await put("m.py", source);
    const message = await edit("m.py", "2|    total = 9\n3|    for item in items:", "x").catch((e: Error) => e.message);
    expect(message).toMatch(/line-number prefix/);
  });

  it("explains an empty file", async () => {
    await put("empty.py", "\n");
    await expect(edit("empty.py", "x", "y")).rejects.toThrow(/the file is empty\. Use write_file/);
  });
});

describe("editFile: copied line-number prefixes", () => {
  const source = "def f():\n    total = 0\n\n    return total\n";

  it("removes N| prefixes copied from read_file output", async () => {
    await put("m.py", source);
    const result = await edit("m.py", "2|    total = 0\n3|\n4|    return total", "2|    total = 1\n3|\n4|    return total");
    expect(await get("m.py")).toBe("def f():\n    total = 1\n\n    return total\n");
    expect(result).toContain("had line-number prefixes (`N|`) in oldText; they were removed");
  });

  it("removes prefixes from oldText only, leaving a clean newText alone", async () => {
    await put("m.py", source);
    await edit("m.py", "2|    total = 0", "    total = 5");
    expect(await get("m.py")).toBe("def f():\n    total = 5\n\n    return total\n");
  });

  it("does not strip when the file really contains such lines", async () => {
    await put("data.txt", "1|alpha\n2|beta\n");
    const result = await edit("data.txt", "1|alpha", "1|ALPHA");
    expect(await get("data.txt")).toBe("1|ALPHA\n2|beta\n");
    expect(result).not.toContain("line-number prefixes");
  });

  it("removes LINE#ID: prefixes too", async () => {
    await put("m.py", source);
    await edit("m.py", "2#ZP:    total = 0", "    total = 2");
    expect(await get("m.py")).toBe("def f():\n    total = 2\n\n    return total\n");
  });
});

describe("editFile: forgiving matches", () => {
  it("matches when the model dropped a uniform indent and re-indents the replacement", async () => {
    await put("a.ts", "function a() {\n  if (x) {\n    run();\n  }\n}\n");
    const result = await edit("a.ts", "  if (x) {\n    run();\n  }", "  if (x) {\n    go();\n    stop();\n  }");
    expect(await get("a.ts")).toBe("function a() {\n  if (x) {\n    go();\n    stop();\n  }\n}\n");
    expect(result).not.toContain("did not match");

    await put("b.ts", "class A {\n  method() {\n    if (x) {\n      run();\n    }\n  }\n}\n");
    const second = await edit("b.ts", "if (x) {\n  run();\n}", "if (x) {\n  go();\n  stop();\n}");
    expect(await get("b.ts")).toBe("class A {\n  method() {\n    if (x) {\n      go();\n      stop();\n    }\n  }\n}\n");
    expect(second).toContain("Note: The edit did not match oldText exactly; it matched line by line");
    expect(second).toContain("indentation was adjusted");
  });

  it("restores the indent of a first line the model started mid-line", async () => {
    await put("a.ts", "function a() {\n  if (x) {\n    run();\n  }\n}\n");
    await edit("a.ts", "if (x) {\n    run();\n  }", "if (x) {\n    go();\n  }");
    expect(await get("a.ts")).toBe("function a() {\n  if (x) {\n    go();\n  }\n}\n");
  });

  it("still matches when all indentation was dropped, keeping repeated lines anchored", async () => {
    await put("a.ts", "function a() {\n  if (x) {\n    run();\n  }\n}\n");
    await edit("a.ts", "if (x) {\nrun();\n}", "if (x) {\ngo();\n}");
    const text = await get("a.ts");
    expect(text.startsWith("function a() {\n  if (x) {\n")).toBe(true);
    expect(text).toContain("go();");
    expect(text).not.toContain("run();");
  });

  it("matches when the model over-indented", async () => {
    await put("a.ts", "x = 1\nif y:\n    z()\n");
    await edit("a.ts", "        if y:\n            z()", "        if y:\n            w()");
    expect(await get("a.ts")).toBe("x = 1\nif y:\n    w()\n");
  });

  it("handles tabs in the file when the model used spaces", async () => {
    await put("go.go", "func f() {\n\tif x {\n\t\trun()\n\t}\n}\n");
    await edit("go.go", "    if x {\n        run()\n    }", "    if x {\n        walk()\n        run()\n    }");
    expect(await get("go.go")).toBe("func f() {\n\tif x {\n\t\twalk()\n\t\trun()\n\t}\n}\n");
  });

  it("handles spaces in the file when the model used tabs", async () => {
    await put("a.py", "def f():\n    if x:\n        run()\n");
    await edit("a.py", "\tif x:\n\t\trun()", "\tif x:\n\t\tgo()");
    expect(await get("a.py")).toBe("def f():\n    if x:\n        go()\n");
  });

  it("ignores trailing whitespace drift", async () => {
    await put("a.txt", "alpha  \nbeta\t\ngamma\n");
    await edit("a.txt", "alpha\nbeta", "ALPHA\nBETA");
    expect(await get("a.txt")).toBe("ALPHA\nBETA\ngamma\n");
  });

  it("does not add a blank line when oldText ended with a newline the window excludes", async () => {
    await put("a.txt", "  one\n  two\nthree\n");
    await edit("a.txt", "one\ntwo\n", "uno\ndos\n");
    expect(await get("a.txt")).toBe("  uno\n  dos\nthree\n");
  });

  it("matches typographic quotes and dashes typed as ASCII", async () => {
    await put("a.md", "He said \u201Chello\u201D \u2014 then left. It\u2019s fine.\n");
    const result = await edit("a.md", "He said \"hello\" - then left. It's fine.", "He said goodbye.");
    expect(await get("a.md")).toBe("He said goodbye.\n");
    expect(result).toContain("typographic");
  });

  it("matches a fragment of a line with different spacing", async () => {
    await put("a.js", "const   total =   a+b ;\n");
    await edit("a.js", "const total = a+b ;", "const total = a + b;");
    expect(await get("a.js")).toBe("const total = a + b;\n");
  });

  it("interprets literal backslash escapes the model over-escaped", async () => {
    await put("a.txt", "first\n\tsecond\nthird\n");
    const result = await edit("a.txt", "first\\n\\tsecond", "FIRST\\n\\tSECOND");
    expect(await get("a.txt")).toBe("FIRST\n\tSECOND\nthird\n");
    expect(result).toContain("backslash escapes");
  });

  it("ignores whitespace around oldText", async () => {
    await put("a.txt", "keep\nneedle\nkeep\n");
    await edit("a.txt", "\n\nneedle\n\n", "pin");
    expect(await get("a.txt")).toBe("keep\npin\nkeep\n");
  });

  it("anchors on first and last lines when the middle has a typo", async () => {
    const source = "function a() {\n  if (x) {\n    run();\n  }\n}\n\nfunction b() {\n  if (x) {\n    stop();\n  }\n}\n";
    await put("a.ts", source);
    await edit("a.ts", "function b() {\n  if (x) {\n    stp();\n  }\n}", "function b() {}");
    expect(await get("a.ts")).toBe("function a() {\n  if (x) {\n    run();\n  }\n}\n\nfunction b() {}\n");
  });

  it("pairs a block's opener with the closer of matching length in nested braces", () => {
    const source = "fn outer() {\n  if (a) {\n    one();\n  }\n  two();\n}\nfn other() {\n  three();\n}\n";
    const result = applyEdits(
      source,
      [{ oldText: "fn outer() {\n  if (a) {\n    ONE();\n  }\n  two();\n}", newText: "fn outer() {}" }],
      "x",
    );
    expect(result.content).toBe("fn outer() {}\nfn other() {\n  three();\n}\n");
    expect(result.applied[0].strategy).toBe("block-anchor");
  });

  it("does not guess when block anchors match but the middle is unrelated", () => {
    const source = "start\nalpha\nbeta\ngamma\nend\n";
    expect(() => applyEdits(source, [{ oldText: "start\nxxxxxxxx\nyyyyyyyy\nzzzzzzzz\nend", newText: "n" }], "x")).toThrow(
      EditError,
    );
  });

  it("never edits inside an identifier through a loose match", () => {
    expect(() => applyEdits("max = 1;\n", [{ oldText: "\nx\n", newText: "y" }], "f")).toThrow(EditError);
    expect(() => applyEdits("xfoo  bar();\n", [{ oldText: "foo bar();", newText: "z" }], "f")).toThrow(EditError);
    // At a real boundary the same loose rules do apply.
    expect(applyEdits("call(foo  bar());\n", [{ oldText: "foo bar()", newText: "baz()" }], "f").content).toBe("call(baz());\n");
  });

  it("ignores block anchors that are only generic braces", () => {
    const source = "{\n  one();\n}\n{\n  two();\n}\n";
    expect(() => applyEdits(source, [{ oldText: "{\n  tw0();\n}", newText: "x" }], "f")).toThrow(EditError);
  });

  it("reports which tier matched in the result", () => {
    const result = applyEdits("  a\n  b\n", [{ oldText: "a\nb", newText: "c" }], "x");
    expect(result.applied).toEqual([{ index: 0, strategy: "line-trimmed", count: 1, reindented: true, strippedPrefixes: false }]);
  });
});

describe("editFile: line endings and BOM", () => {
  it("edits CRLF files with LF oldText and keeps every CRLF", async () => {
    await put("w.txt", "one\r\ntwo\r\nthree\r\n");
    await edit("w.txt", "two\nthree", "TWO\nTHREE\nFOUR");
    expect(await get("w.txt")).toBe("one\r\nTWO\r\nTHREE\r\nFOUR\r\n");
  });

  it("accepts oldText that already contains CRLF", async () => {
    await put("w.txt", "one\r\ntwo\r\n");
    await edit("w.txt", "one\r\ntwo", "1\r\n2");
    expect(await get("w.txt")).toBe("1\r\n2\r\n");
  });

  it("keeps untouched lines' own endings in mixed files", async () => {
    await put("mixed.txt", "a\r\nb\r\nc\nd\ne\r\n");
    await edit("mixed.txt", "d", "D");
    expect(await get("mixed.txt")).toBe("a\r\nb\r\nc\nD\ne\r\n");
  });

  it("keeps a lone CRLF line in an LF-dominant file", async () => {
    await put("mixed2.txt", "a\nb\nc\r\nd\n");
    await edit("mixed2.txt", "d", "D");
    expect(await get("mixed2.txt")).toBe("a\nb\nc\r\nD\n");
  });

  it("preserves a UTF-8 BOM", async () => {
    await put("bom.txt", "\uFEFFhello\nworld\n");
    await edit("bom.txt", "world", "there");
    expect(await get("bom.txt")).toBe("\uFEFFhello\nthere\n");
  });

  it("preserves BOM and CRLF together", async () => {
    await put("both.txt", "\uFEFFa\r\nb\r\n");
    await edit("both.txt", "b", "B");
    expect(await get("both.txt")).toBe("\uFEFFa\r\nB\r\n");
  });
});

describe("editFile: scale", () => {
  it("edits a 100,000-line file quickly", async () => {
    const body = Array.from({ length: 100_000 }, (_, i) => `row ${i}`).join("\n");
    await put("big.txt", `${body}\n`);
    const started = Date.now();
    const result = await edit("big.txt", "row 77777", "row seventy-seven thousand");
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.split("\n").length).toBeLessThan(20);
    expect((await get("big.txt")).includes("row seventy-seven thousand")).toBe(true);
  });

  it("diagnoses a miss in a 20,000-line file within a couple of seconds", async () => {
    const body = Array.from({ length: 20_000 }, (_, i) => `  value_${i} = compute(${i})`).join("\n");
    await put("big.py", `${body}\n`);
    const started = Date.now();
    const message = await edit("big.py", "  value_12345 = compute(12346)\n  value_12346 = compute(12346)", "x").catch(
      (e: Error) => e.message,
    );
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(message).toContain("Closest match");
    expect(message).toContain("at line 12346");
  });
});

describe("applyEdits: never edits the wrong place", () => {
  it("either produces the intended file or refuses, across random indentation drift", () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    let succeeded = 0;
    let refused = 0;
    for (let round = 0; round < 300; round += 1) {
      const size = 6 + Math.floor(random() * 30);
      const lines = Array.from({ length: size }, (_, i) => {
        const indent = " ".repeat(Math.floor(random() * 4) * 2);
        const body = random() < 0.2 ? "}" : `stmt_${Math.floor(random() * size)}(${i % 5});`;
        return indent + body;
      });
      const start = Math.floor(random() * (size - 3));
      const length = 1 + Math.floor(random() * 3);
      const window = lines.slice(start, start + length);
      const replacement = ["    replaced_a();", "    replaced_b();"];
      const drifted = window.map((line) => (random() < 0.5 ? line.trimStart() : line) + (random() < 0.3 ? "  " : ""));

      const source = `${lines.join("\n")}\n`;
      const intended = `${[...lines.slice(0, start), ...replacement, ...lines.slice(start + length)].join("\n")}\n`;
      try {
        const { content } = applyEdits(source, [{ oldText: drifted.join("\n"), newText: replacement.join("\n") }], "f");
        // A match is only acceptable if it replaced a window that equals the request ignoring whitespace.
        const normalize = (text: string): string => text.split("\n").map((l) => l.trim()).join("\n");
        if (content !== intended) {
          const rebuilt = content.split("\n");
          const at = rebuilt.findIndex((line) => line.trim() === "replaced_a();");
          const original = source.split("\n").slice(at, at + length);
          expect(normalize(original.join("\n"))).toBe(normalize(window.join("\n")));
        }
        succeeded += 1;
      } catch (error) {
        expect(error).toBeInstanceOf(EditError);
        refused += 1;
      }
    }
    expect(succeeded).toBeGreaterThan(100);
    expect(succeeded + refused).toBe(300);
  });
});
