import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deriveTitle,
  latestSession,
  listSessions,
  loadSession,
  newSessionId,
  saveSession,
  type SessionMeta,
} from "./session.js";

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: newSessionId(),
    cwd: "/work/a",
    provider: "zai",
    model: "glm-5.2",
    title: "t",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    turns: 1,
    ...overrides,
  };
}

describe("sessions", () => {
  let previousHome: string | undefined;
  beforeEach(() => {
    previousHome = process.env.REVCODE_HOME;
    process.env.REVCODE_HOME = mkdtempSync(path.join(os.tmpdir(), "revcode-home-"));
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.REVCODE_HOME;
    else process.env.REVCODE_HOME = previousHome;
  });

  it("round-trips a snapshot", () => {
    const m = meta();
    saveSession({ meta: m, messages: [{ role: "system", content: "s" }, { role: "user", content: "hello" }] });
    const loaded = loadSession(m.id);
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.meta.model).toBe("glm-5.2");
  });

  it("lists newest first and filters by cwd", () => {
    const a = meta({ id: "a", cwd: "/work/a", updatedAt: "2026-01-02T00:00:00.000Z" });
    const b = meta({ id: "b", cwd: "/work/b", updatedAt: "2026-01-03T00:00:00.000Z" });
    const c = meta({ id: "c", cwd: "/work/a", updatedAt: "2026-01-04T00:00:00.000Z" });
    for (const m of [a, b, c]) saveSession({ meta: m, messages: [] });

    expect(listSessions().map((s) => s.id)).toEqual(["c", "b", "a"]);
    expect(listSessions({ cwd: "/work/a" }).map((s) => s.id)).toEqual(["c", "a"]);
    expect(latestSession("/work/b")?.id).toBe("b");
    expect(latestSession("/nowhere")).toBeUndefined();
  });

  it("ignores corrupt files and unknown ids", () => {
    expect(loadSession("missing")).toBeUndefined();
    saveSession({ meta: meta({ id: "ok" }), messages: [] });
    expect(listSessions()).toHaveLength(1);
  });

  it("derives a short title from the first real user message", () => {
    expect(
      deriveTitle([
        { role: "system", content: "s" },
        { role: "user", content: "[harness] nudge" },
        { role: "user", content: "Fix the login bug in auth.ts please" },
      ]),
    ).toBe("Fix the login bug in auth.ts please");
    expect(deriveTitle([{ role: "user", content: "x".repeat(200) }]).length).toBe(58);
  });
});
