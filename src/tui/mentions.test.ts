import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { expandMentions } from "./mentions.js";
import { interpretApprovalKey } from "./approval.js";

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

describe("interpretApprovalKey", () => {
  it("maps keys to answers", () => {
    expect(interpretApprovalKey("y", {})).toBe("allow");
    expect(interpretApprovalKey("Y", {})).toBe("allow");
    expect(interpretApprovalKey("n", {})).toBe("deny");
    expect(interpretApprovalKey("a", {})).toBe("always");
    expect(interpretApprovalKey("\r", { name: "return" })).toBe("allow");
    expect(interpretApprovalKey(undefined, { name: "escape" })).toBe("deny");
    expect(interpretApprovalKey("c", { name: "c", ctrl: true })).toBe("deny");
    expect(interpretApprovalKey("x", {})).toBeUndefined();
  });
});
