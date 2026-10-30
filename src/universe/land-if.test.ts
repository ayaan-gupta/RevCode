import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeCheck, runCheck } from "./check.js";
import { formatLandIf, landIfPasses } from "./land-if.js";
import { Universe } from "./universe.js";

let previousHome: string | undefined;
let project: string;

beforeEach(() => {
  previousHome = process.env.REVCODE_HOME;
  process.env.REVCODE_HOME = mkdtempSync(path.join(os.tmpdir(), "revcode-home-"));
  project = mkdtempSync(path.join(os.tmpdir(), "revcode-landif-"));
  writeFileSync(path.join(project, "a.txt"), "one\ntwo\nthree\n");
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.REVCODE_HOME;
  else process.env.REVCODE_HOME = previousHome;
});

describe("landIfPasses", () => {
  it("applies nothing when the project changed underneath in a conflicting way", async () => {
    const u = await Universe.create({ projectRoot: project });
    writeFileSync(path.join(u.workDir, "a.txt"), "one\nTWO (copy)\nthree\n");
    writeFileSync(path.join(u.workDir, "b.txt"), "new\n");
    writeFileSync(path.join(project, "a.txt"), "one\nTWO (you)\nthree\n");

    const outcome = await landIfPasses(u, "true", { stopReason: "complete" });
    expect(outcome.status).toBe("conflict");
    expect(outcome.conflicts).toEqual(["a.txt"]);
    expect(readFileSync(path.join(project, "a.txt"), "utf8")).toBe("one\nTWO (you)\nthree\n");
    expect(() => readFileSync(path.join(project, "b.txt"))).toThrow(); // all or nothing
    expect(formatLandIf(outcome, u, project).join("\n")).toContain("these files conflict: a.txt");
  });

  it("skips the check after a failed or interrupted run", async () => {
    const u = await Universe.create({ projectRoot: project });
    writeFileSync(path.join(u.workDir, "a.txt"), "changed\n");
    const outcome = await landIfPasses(u, "touch ran", { stopReason: "aborted" });
    expect(outcome).toMatchObject({ status: "not-run", reason: "the run was interrupted", files: ["a.txt"] });
    expect(readFileSync(path.join(project, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n");
  });

  it("cleans up the copy once the changes are applied", async () => {
    const u = await Universe.create({ projectRoot: project });
    writeFileSync(path.join(u.workDir, "a.txt"), "changed\n");
    const outcome = await landIfPasses(u, "grep -q changed a.txt", { stopReason: "max_iterations" });
    expect(outcome.status).toBe("landed");
    expect(readFileSync(path.join(project, "a.txt"), "utf8")).toBe("changed\n");
    expect(Universe.open(u.id).meta.status).toBe("discarded");
  });
});

describe("runCheck", () => {
  it("reports exit codes, output and timeouts", async () => {
    const ok = await runCheck(project, "echo fine");
    expect(ok).toMatchObject({ passed: true, exitCode: 0, timedOut: false, tail: "fine" });
    expect(describeCheck(ok)).toMatch(/^echo fine passed \(\d+\.\ds\)$/);

    const bad = await runCheck(project, "echo broken >&2; exit 3");
    expect(bad).toMatchObject({ passed: false, exitCode: 3, tail: "broken" });

    const slow = await runCheck(project, "sleep 5 & sleep 5; wait", { timeoutMs: 200 });
    expect(slow).toMatchObject({ passed: false, timedOut: true });
    expect(slow.durationMs).toBeLessThan(3000);
    expect(describeCheck(slow)).toContain("timed out");
  });
});
