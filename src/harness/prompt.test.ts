import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./prompt.js";
import { DEFAULT_PROFILE, withProfile } from "./profile.js";

const base = { cwd: "/work", date: "2026-01-01", platform: "linux", arch: "x64" };

describe("buildSystemPrompt", () => {
  it("includes environment, tools, and the verify-then-stop guidance by default", () => {
    const prompt = buildSystemPrompt({ ...base, profile: DEFAULT_PROFILE });
    expect(prompt).toContain("Working directory: /work");
    expect(prompt).toContain("PERSISTENT bash session");
    expect(prompt).toContain("background:true");
    expect(prompt).toContain("ORIGINAL task text");
    expect(prompt).toContain("acceptance criteria");
  });

  it("describes the edit tool that matches the profile's edit mode", () => {
    expect(buildSystemPrompt({ ...base, profile: DEFAULT_PROFILE })).toContain("edit_file");
    expect(buildSystemPrompt({ ...base, profile: withProfile(DEFAULT_PROFILE, { editMode: "patch" }) })).toContain(
      "apply_patch",
    );
    expect(
      buildSystemPrompt({ ...base, profile: withProfile(DEFAULT_PROFILE, { editMode: "anchored" }) }),
    ).toContain("edit_anchored");
    expect(buildSystemPrompt({ ...base, profile: withProfile(DEFAULT_PROFILE, { editMode: "whole" }) })).toContain(
      "rewriting them with write_file",
    );
  });

  it("terse style is substantially shorter than standard", () => {
    const standard = buildSystemPrompt({ ...base, profile: DEFAULT_PROFILE });
    const terse = buildSystemPrompt({ ...base, profile: withProfile(DEFAULT_PROFILE, { promptStyle: "terse" }) });
    expect(terse.length).toBeLessThan(standard.length);
  });

  it("checklist style adds the completion checklist", () => {
    const prompt = buildSystemPrompt({ ...base, profile: withProfile(DEFAULT_PROFILE, { promptStyle: "checklist" }) });
    expect(prompt).toContain("Before you declare the task done");
  });

  it("injects project instructions, snapshot, and headless guidance", () => {
    const prompt = buildSystemPrompt({
      ...base,
      profile: DEFAULT_PROFILE,
      mode: "headless",
      instructions: "Use tabs.",
      envSnapshot: "os: Linux",
      extraSections: ["# Skills\n- foo"],
    });
    expect(prompt).toContain("# Project instructions");
    expect(prompt).toContain("Use tabs.");
    expect(prompt).toContain("Environment snapshot");
    expect(prompt).toContain("NON-INTERACTIVELY");
    expect(prompt).toContain("# Skills");
  });
});
