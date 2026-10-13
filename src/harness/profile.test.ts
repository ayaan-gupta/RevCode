import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE,
  describeProfileDiff,
  loadStoredProfile,
  profileKey,
  sanitizeProfile,
  saveStoredProfile,
  withProfile,
} from "./profile.js";

describe("profile", () => {
  let previousHome: string | undefined;
  beforeEach(() => {
    previousHome = process.env.REVCODE_HOME;
    process.env.REVCODE_HOME = mkdtempSync(path.join(os.tmpdir(), "revcode-home-"));
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.REVCODE_HOME;
    else process.env.REVCODE_HOME = previousHome;
  });

  it("sanitizes garbage per-field and keeps valid values", () => {
    const profile = sanitizeProfile({ editMode: "nope", temperature: 9, promptStyle: "terse", maxTokens: "x" });
    expect(profile.editMode).toBe(DEFAULT_PROFILE.editMode);
    expect(profile.temperature).toBe(2);
    expect(profile.promptStyle).toBe("terse");
    expect(profile.maxTokens).toBe(DEFAULT_PROFILE.maxTokens);
  });

  it("round-trips a stored profile per provider/model", () => {
    const tuned = withProfile(DEFAULT_PROFILE, { editMode: "patch", verifyGate: false });
    const file = saveStoredProfile({
      profile: tuned,
      provider: "zai",
      model: "glm-5.2",
      tunedAt: "2026-01-01T00:00:00.000Z",
      evidence: { suite: "builtin", baselineScore: 0.3, tunedScore: 0.6, tasks: 10, trials: 1 },
    });
    expect(file).toContain("zai__glm-5.2.json");

    const loaded = loadStoredProfile("zai", "glm-5.2");
    expect(loaded?.profile.editMode).toBe("patch");
    expect(loaded?.profile.verifyGate).toBe(false);
    expect(loaded?.evidence?.tunedScore).toBe(0.6);
    expect(loadStoredProfile("zai", "other")).toBeUndefined();
  });

  it("describes diffs and builds distinct keys", () => {
    const tuned = withProfile(DEFAULT_PROFILE, { editMode: "anchored", temperature: 0 });
    expect(describeProfileDiff(DEFAULT_PROFILE, tuned)).toEqual([
      "editMode: replace → anchored",
      "temperature: 0.2 → 0",
    ]);
    expect(profileKey(tuned)).not.toBe(profileKey(DEFAULT_PROFILE));
  });
});
