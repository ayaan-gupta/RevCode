import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { workingDirectoryProblem } from "./cwd.js";

describe("workingDirectoryProblem", () => {
  it("accepts a directory and explains anything else", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "revcode-cwd-"));
    const file = path.join(dir, "f.txt");
    writeFileSync(file, "x");
    expect(workingDirectoryProblem(dir)).toBeUndefined();
    expect(workingDirectoryProblem(file)).toContain("not a directory");
    expect(workingDirectoryProblem(path.join(dir, "missing"))).toContain("does not exist");
  });
});
