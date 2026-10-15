import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expandMentions, pastedPathToMention } from "./mentions.js";

describe("expandMentions", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "revcode-mention-"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(dir, "bin.dat"), Buffer.from([1, 2, 0, 3]));

  it("appends referenced files and keeps the original text", () => {
    const { text, files } = expandMentions("explain @src/a.ts please", dir);
    expect(files).toEqual(["src/a.ts"]);
    expect(text.startsWith("explain @src/a.ts please")).toBe(true);
    expect(text).toContain('<file path="src/a.ts">\nexport const a = 1;');
  });

  it("ignores missing files, binaries, emails, and paths outside cwd", () => {
    expect(expandMentions("see @nope.ts", dir).files).toEqual([]);
    expect(expandMentions("see @bin.dat", dir).files).toEqual([]);
    expect(expandMentions("mail me at x@src/a.ts", dir).files).toEqual([]);
    expect(expandMentions("see @../outside.txt", dir).files).toEqual([]);
  });

  it("handles trailing punctuation and de-duplicates", () => {
    const { files } = expandMentions("@src/a.ts. and again @src/a.ts", dir);
    expect(files).toEqual(["src/a.ts"]);
  });
});

describe("pastedPathToMention", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "revcode-paste-"));
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "a.ts"), "x");
  writeFileSync(path.join(dir, "my file.txt"), "x");
  const outside = mkdtempSync(path.join(os.tmpdir(), "revcode-outside-"));
  writeFileSync(path.join(outside, "pic.png"), "x");

  it("turns a pasted project file path into a mention", () => {
    expect(pastedPathToMention(path.join(dir, "src", "a.ts"), dir)).toBe("@src/a.ts ");
    expect(pastedPathToMention(`'${path.join(dir, "src", "a.ts")}'`, dir)).toBe("@src/a.ts ");
    expect(pastedPathToMention(`file://${path.join(dir, "src", "a.ts")}`, dir)).toBe("@src/a.ts ");
  });

  it("leaves paths outside the project as plain paths, quoting spaces", () => {
    expect(pastedPathToMention(path.join(outside, "pic.png"), dir)).toBe(`${path.join(outside, "pic.png")} `);
    expect(pastedPathToMention(path.join(dir, "my file.txt").replace(/ /g, "\\ "), dir)).toBe(`"${path.join(dir, "my file.txt")}" `);
  });

  it("ignores prose, missing files, directories and multi-line text", () => {
    expect(pastedPathToMention("hello world", dir)).toBeUndefined();
    expect(pastedPathToMention(path.join(dir, "nope.ts"), dir)).toBeUndefined();
    expect(pastedPathToMention(path.join(dir, "src"), dir)).toBeUndefined();
    expect(pastedPathToMention(`${path.join(dir, "src", "a.ts")}\nmore`, dir)).toBeUndefined();
  });
});
