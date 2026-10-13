import { describe, expect, it, vi } from "vitest";
import { PermissionManager, ruleMatches, type Approver } from "./permissions.js";

const readOnly = (name: string) => ["read_file", "grep", "glob", "list_directory"].includes(name);
const make = (mode: Parameters<typeof PermissionManager.prototype.setMode>[0], extra: Partial<ConstructorParameters<typeof PermissionManager>[0]> = {}) =>
  new PermissionManager({ mode, isReadOnly: readOnly, ...extra });

describe("PermissionManager.evaluate", () => {
  it("always allows read-only tools", () => {
    expect(make("ask").evaluate("read_file", { path: "a" }).action).toBe("allow");
  });

  it("ask mode: edits and unknown shell ask; safe shell allowed", () => {
    const pm = make("ask");
    expect(pm.evaluate("edit_file", { path: "a.ts" }).action).toBe("ask");
    expect(pm.evaluate("shell", { command: "npm test" }).action).toBe("ask");
    expect(pm.evaluate("shell", { command: "git status" }).action).toBe("allow");
  });

  it("accept-edits mode auto-allows edits but still asks for shell", () => {
    const pm = make("accept-edits");
    expect(pm.evaluate("write_file", { path: "a" }).action).toBe("allow");
    expect(pm.evaluate("shell", { command: "make" }).action).toBe("ask");
  });

  it("plan mode denies mutations, allows reads and safe shell", () => {
    const pm = make("plan");
    expect(pm.evaluate("write_file", { path: "a" }).action).toBe("deny");
    expect(pm.evaluate("shell", { command: "touch x" }).action).toBe("deny");
    expect(pm.evaluate("shell", { command: "ls" }).action).toBe("allow");
    expect(pm.evaluate("grep", { pattern: "x" }).action).toBe("allow");
  });

  it("yolo allows everything except catastrophic commands and deny rules", () => {
    const pm = make("yolo", { deny: ["shell(git push*)"] });
    expect(pm.evaluate("shell", { command: "npm install" }).action).toBe("allow");
    expect(pm.evaluate("shell", { command: "rm -rf /" }).action).toBe("deny");
    expect(pm.evaluate("shell", { command: "git push origin main" }).action).toBe("deny");
  });

  it("allow rules skip prompts; deny beats allow", () => {
    const pm = make("ask", { allow: ["shell(npm test*)", "edit_file(src/**)", "mcp__*"], deny: ["edit_file(src/secret*)"] });
    expect(pm.evaluate("shell", { command: "npm test -- --run" }).action).toBe("allow");
    expect(pm.evaluate("edit_file", { path: "src/a/b.ts" }).action).toBe("allow");
    expect(pm.evaluate("edit_file", { path: "src/secret.ts" }).action).toBe("deny");
    expect(pm.evaluate("mcp__gh__list", {}).action).toBe("allow");
    expect(pm.evaluate("edit_file", { path: "lib/a.ts" }).action).toBe("ask");
  });
});

describe("PermissionManager middleware", () => {
  const call = (name: string, args: Record<string, unknown>) => ({
    call: { id: "1", name, arguments: args },
    iteration: 0,
  });

  it("denies when approval is required but no approver exists", async () => {
    const decision = await make("ask").middleware().before!(call("shell", { command: "npm i" }));
    expect(decision).toMatchObject({ allow: false });
    expect((decision as { reason: string }).reason).toContain("non-interactive");
  });

  it("honors approver answers and learns from 'always'", async () => {
    const approver: Approver = vi.fn(async () => "always" as const);
    const pm = make("ask", { approver });
    const mw = pm.middleware();

    expect(await mw.before!(call("shell", { command: "git commit -m x" }))).toEqual({ allow: true });
    expect(approver).toHaveBeenCalledTimes(1);

    // Same command prefix is now pre-approved.
    expect(await mw.before!(call("shell", { command: "git commit -m y" }))).toEqual({ allow: true });
    expect(approver).toHaveBeenCalledTimes(1);
    expect(pm.rules().allow).toContain("shell(git commit*)");
  });

  it("tells the model not to retry a declined action", async () => {
    const pm = make("ask", { approver: async () => "deny" });
    const decision = await pm.middleware().before!(call("write_file", { path: "a" }));
    expect(decision).toMatchObject({ allow: false });
    expect((decision as { reason: string }).reason).toContain("declined");
  });
});

describe("ruleMatches", () => {
  it("matches tool globs and subject patterns", () => {
    expect(ruleMatches("shell", "shell", "ls")).toBe(true);
    expect(ruleMatches("shell(git *)", "shell", "git status")).toBe(true);
    expect(ruleMatches("shell(git *)", "shell", "ls")).toBe(false);
    expect(ruleMatches("mcp__*", "mcp__a__b", undefined)).toBe(true);
    // The file-editing tools are one family, so a rule for one covers them all.
    expect(ruleMatches("edit_file(src/**)", "write_file", "src/a")).toBe(true);
    expect(ruleMatches("edit_file(src/**)", "shell", "src/a")).toBe(false);
    expect(ruleMatches("shell(git *)", "write_file", "git x")).toBe(false);
  });

  it("covers apply_patch (several files) and the whole edit-tool family in rules", () => {
    const patch = (files: string[]) => ({ input: `*** Begin Patch\n${files.map((f) => `*** Update File: ${f}\n@@\n-a\n+b`).join("\n")}\n*** End Patch` });
    const deny = make("yolo", { deny: ["edit_file(src/secret*)"] });
    expect(deny.evaluate("apply_patch", patch(["src/ok.ts", "src/secret.ts"])).action).toBe("deny");
    expect(deny.evaluate("write_file", { path: "src/secret.txt" }).action).toBe("deny");
    expect(deny.evaluate("apply_patch", patch(["src/ok.ts"])).action).toBe("allow");

    // An allow rule needs EVERY touched file to match.
    const allow = make("ask", { allow: ["edit_file(src/**)"] });
    expect(allow.evaluate("apply_patch", patch(["src/a.ts", "src/b.ts"])).action).toBe("allow");
    expect(allow.evaluate("apply_patch", patch(["src/a.ts", "lib/b.ts"])).action).toBe("ask");
  });
});
