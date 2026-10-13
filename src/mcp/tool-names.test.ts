import { describe, expect, it } from "vitest";

import { MAX_TOOL_NAME_LENGTH, assignToolNames, sanitizeNamePart } from "./tool-names.js";

const VALID = /^[a-zA-Z0-9_-]+$/;

describe("sanitizeNamePart", () => {
  it("replaces characters outside [a-zA-Z0-9_-]", () => {
    expect(sanitizeNamePart("my.server/v2 beta")).toBe("my_server_v2_beta");
    expect(sanitizeNamePart("ok_name-1")).toBe("ok_name-1");
    expect(sanitizeNamePart("héllo")).toBe("h_llo");
    expect(sanitizeNamePart("")).toBe("_");
  });
});

describe("assignToolNames", () => {
  it("uses mcp__<server>__<tool> for clean names", () => {
    expect(assignToolNames([{ server: "github", tool: "create_issue" }])).toEqual(["mcp__github__create_issue"]);
  });

  it("sanitizes both parts", () => {
    expect(assignToolNames([{ server: "my server", tool: "do.thing" }])).toEqual(["mcp__my_server__do_thing"]);
  });

  it("is deterministic", () => {
    const refs = [
      { server: "s", tool: "a.b" },
      { server: "s", tool: "a_b" },
      { server: "x".repeat(80), tool: "t" },
    ];
    expect(assignToolNames(refs)).toEqual(assignToolNames(refs));
  });

  it("appends a hash when sanitizing makes two tools collide, keeping the first clean", () => {
    const [first, second, third] = assignToolNames([
      { server: "s", tool: "a.b" },
      { server: "s", tool: "a_b" },
      { server: "s", tool: "a b" },
    ]);
    expect(first).toBe("mcp__s__a_b");
    expect(second).not.toBe(first);
    expect(second).toMatch(/^mcp__s__a_b_[0-9a-f]{8}$/);
    expect(third).toMatch(/^mcp__s__a_b_[0-9a-f]{8}$/);
    expect(new Set([first, second, third]).size).toBe(3);
  });

  it("truncates to 64 chars with a hash that keeps long names distinct", () => {
    const long = "a".repeat(100);
    const [one, two] = assignToolNames([
      { server: "srv", tool: `${long}1` },
      { server: "srv", tool: `${long}2` },
    ]);
    expect(one.length).toBe(MAX_TOOL_NAME_LENGTH);
    expect(two.length).toBe(MAX_TOOL_NAME_LENGTH);
    expect(one).not.toBe(two);
    expect(one).toMatch(VALID);
    expect(one.startsWith("mcp__srv__aaaa")).toBe(true);
  });

  it("never produces invalid or over-long names", () => {
    const refs = ["", "..", "a/b", "x".repeat(200), "ünï", "tool name!"].flatMap((tool) =>
      ["", "srv", "s.r.v", "y".repeat(70)].map((server) => ({ server, tool })),
    );
    const names = assignToolNames(refs);
    expect(new Set(names).size).toBe(refs.length);
    for (const name of names) {
      expect(name).toMatch(VALID);
      expect(name.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
      expect(name.startsWith("mcp__")).toBe(true);
    }
  });

  it("keeps names of exactly 64 characters unchanged", () => {
    const tool = "t".repeat(64 - "mcp__s__".length);
    expect(assignToolNames([{ server: "s", tool }])).toEqual([`mcp__s__${tool}`]);
  });
});
