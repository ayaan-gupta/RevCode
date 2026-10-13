import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectEnvSnapshot } from "./env-snapshot.js";

describe("collectEnvSnapshot", () => {
  it("reports the directory contents and project markers", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "revcode-snap-"));
    writeFileSync(path.join(dir, "package.json"), "{}");
    writeFileSync(path.join(dir, "notes.txt"), "hi");

    const snapshot = await collectEnvSnapshot(dir);

    expect(snapshot).toContain("os:");
    expect(snapshot).toContain("top-level:");
    expect(snapshot).toContain("notes.txt");
    expect(snapshot).toMatch(/project-files:.*package\.json/);
    expect(snapshot).toContain("available:");
  });

  it("never throws for a missing directory", async () => {
    const snapshot = await collectEnvSnapshot("/definitely/not/a/dir");
    expect(typeof snapshot).toBe("string");
  });
});
