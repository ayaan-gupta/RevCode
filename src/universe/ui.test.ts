import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatCheckpoints, formatChangeSummary, formatUniverseList, landFlow } from "./ui.js";
import { Universe } from "./universe.js";

let previousHome: string | undefined;
let project: string;
beforeEach(() => {
  previousHome = process.env.REVCODE_HOME;
  process.env.REVCODE_HOME = mkdtempSync(path.join(os.tmpdir(), "revcode-home-"));
  project = mkdtempSync(path.join(os.tmpdir(), "revcode-proj-"));
  mkdirSync(path.join(project, "src"));
  writeFileSync(path.join(project, "src", "a.ts"), "a\nb\nc\n");
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.REVCODE_HOME;
  else process.env.REVCODE_HOME = previousHome;
});

describe("universe ui", () => {
  it("formats lists, checkpoints and change summaries", async () => {
    expect(formatUniverseList([])[0]).toContain("revcode --universe");
    const u = await Universe.create({ projectRoot: project });
    writeFileSync(path.join(u.workDir, "src", "a.ts"), "a\nB\nc\nd\n");
    await u.checkpoint({ kind: "tool", tool: "shell", summary: "python3 x.py", exitCode: 2 });
    expect(formatUniverseList([u.meta])[0]).toContain(u.id);
    const lines = formatCheckpoints(u.checkpoints());
    expect(lines.join("\n")).toContain("python3 x.py");
    expect(lines.join("\n")).toContain("(exit 2)");

    const head = await u.snapshotHead("x");
    const changes = await u.changesBetween(u.meta.baseSha, head);
    expect(formatChangeSummary(changes).join("\n")).toContain("M  src/a.ts");
  });

  it("landFlow shows the plan, honors cancel, and applies on confirm", async () => {
    const u = await Universe.create({ projectRoot: project });
    writeFileSync(path.join(u.workDir, "src", "a.ts"), "a\nB\nc\n");

    const cancelled = await landFlow(u, { confirm: async () => false });
    expect(cancelled.landed).toBe(false);
    expect(cancelled.lines.join("\n")).toContain("Cancelled.");

    const landed = await landFlow(u, { confirm: async () => true });
    expect(landed.landed).toBe(true);
    expect(landed.lines.join("\n")).toContain("Landed: 1 written");

    const again = await landFlow(u, { confirm: async () => true });
    expect(again.landed).toBe(false);
    expect(again.lines[0]).toContain("Nothing to land");
  });
});
