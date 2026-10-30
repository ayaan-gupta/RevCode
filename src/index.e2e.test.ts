/**
 * Spawns the real entry point so wiring regressions (subcommand dispatch, dynamic
 * imports, flag parsing, config layering) are caught — unit tests alone can't.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const entry = path.resolve(__dirname, "index.ts");
// Absolute path: the child runs in a temp directory, where `--import tsx` would not resolve.
const tsxCli = path.resolve(__dirname, "..", "node_modules", "tsx", "dist", "cli.mjs");

function revcode(args: string[], cwd: string, home: string) {
  return spawnSync(process.execPath, [tsxCli, entry, ...args], {
    cwd,
    env: { ...process.env, REVCODE_HOME: home, NO_COLOR: "1" },
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("revcode CLI (end to end)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "revcode-e2e-"));
  const home = path.join(dir, "home");
  writeFileSync(path.join(dir, "note.txt"), "hello e2e\n");

  it("prints help and version", () => {
    expect(revcode(["--version"], dir, home).stdout).toMatch(/^revcode \d+\.\d+\.\d+/);
    const help = revcode(["--help"], dir, home).stdout;
    expect(help).toContain("revcode tune");
    expect(help).toContain("--universe");
  });

  it("runs a headless task through the whole stack with the local test provider", () => {
    const result = revcode(
      ["run", "--provider", "local-test", "--model", "test", "--no-snapshot", "--no-instructions", '/tool read_file {"path":"note.txt"}'],
      dir,
      home,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[read_file(");
    expect(result.stdout).toContain("hello e2e");
  });

  it("emits a machine-readable summary with --output-format json", () => {
    const result = revcode(
      ["run", "--provider", "local-test", "--model", "test", "--no-snapshot", "--output-format", "json", '/tool list_directory {"path":"."}'],
      dir,
      home,
    );
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout.trim().split("\n").at(-1) as string) as Record<string, unknown>;
    expect(summary).toMatchObject({ stopReason: "complete", toolCalls: 1, model: "test" });
  });

  it("reads the task from --prompt-file, keeping it out of the process command line", () => {
    const promptFile = path.join(dir, "task.txt");
    writeFileSync(promptFile, '/tool read_file {"path":"note.txt"}\n');
    const result = revcode(
      ["--headless", "--provider", "local-test", "--model", "test", "--no-snapshot", "--no-instructions", "--prompt-file", promptFile],
      dir,
      home,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("hello e2e");

    const missing = revcode(["--headless", "--provider", "local-test", "--model", "test", "--prompt-file", path.join(dir, "nope.txt")], dir, home);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr + missing.stdout).toContain("--prompt-file could not be read");
  });

  it("refuses a working directory that does not exist", () => {
    const result = revcode(
      ["run", "--provider", "local-test", "--model", "test", "--cwd", "/definitely/not/a/real/dir", "hi"],
      dir,
      home,
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--cwd does not exist");
  });

  it("rejects bad flags with a clear error and non-zero exit", () => {
    const result = revcode(["--bogus"], dir, home);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown argument: --bogus");
  });

  it("lists sessions/universes/profile on a clean home without crashing", () => {
    expect(revcode(["sessions"], dir, home).stdout).toContain("No saved sessions");
    expect(revcode(["universes"], dir, home).stdout).toContain("revcode --universe");
    expect(revcode(["profile", "show", "--provider", "local-test", "--model", "test"], dir, home).stdout).toContain("Profile source: default");
  });

  it("plans a Dyno run without calling any model", () => {
    const result = revcode(["tune", "--dry-run", "--provider", "local-test", "--model", "test"], dir, home);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No model calls were made");
    expect(result.stdout).toContain("Edit modes in play");
  });

  it("runs a task inside a Parallel Universe, then lands it into the project", () => {
    const project = mkdtempSync(path.join(os.tmpdir(), "revcode-e2e-proj-"));
    writeFileSync(path.join(project, "a.txt"), "before\n");
    const run = revcode(
      ["run", "--universe", "--provider", "local-test", "--model", "test", "--no-snapshot", "--no-instructions", '/tool write_file {"path":"a.txt","content":"after\\n"}'],
      project,
      home,
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/Universe u\d+-[0-9a-f]+: 1 file\(s\) changed/);
    expect(execFileSync("cat", [path.join(project, "a.txt")], { encoding: "utf8" })).toBe("before\n"); // untouched until landed

    const landed = revcode(["universes", "land", "--yes"], project, home);
    expect(landed.status).toBe(0);
    expect(landed.stdout).toContain("Landed: 1 written");
    expect(execFileSync("cat", [path.join(project, "a.txt")], { encoding: "utf8" })).toBe("after\n");
  });

  it("--land-if applies the changes only when the check passes", () => {
    const project = mkdtempSync(path.join(os.tmpdir(), "revcode-e2e-landif-"));
    writeFileSync(path.join(project, "a.txt"), "before\n");
    const task = (content: string) => `/tool write_file {"path":"a.txt","content":"${content}\\n"}`;
    const base = ["run", "--provider", "local-test", "--model", "test", "--no-snapshot", "--no-instructions"];

    const failed = revcode([...base, "--land-if", "grep -q good a.txt", task("bad")], project, home);
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain("✘ grep -q good a.txt failed (exit 1");
    expect(failed.stdout).toContain("Nothing was applied");
    expect(failed.stdout).toMatch(/revcode universes land u\d+/);
    expect(execFileSync("cat", [path.join(project, "a.txt")], { encoding: "utf8" })).toBe("before\n");

    const passed = revcode([...base, "--land-if", "grep -q good a.txt", "--output-format", "json", task("good")], project, home);
    expect(passed.status).toBe(0);
    const summary = JSON.parse(passed.stdout.trim().split("\n").at(-1) as string) as { landIf: Record<string, unknown> };
    expect(summary.landIf).toMatchObject({ status: "landed", landed: true, files: ["a.txt"], check: { passed: true, exitCode: 0 } });
    expect(execFileSync("cat", [path.join(project, "a.txt")], { encoding: "utf8" })).toBe("good\n");

    const misuse = revcode(["--land-if", "true", "--provider", "local-test", "--model", "test"], project, home);
    expect(misuse.status).toBe(1);
    expect(misuse.stderr).toContain('revcode run "<task>" --land-if "<check>"');
  });
});

describe("interactive session without a terminal (piped stdin)", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "revcode-e2e-pipe-"));
  const home = path.join(dir, "home");

  function session(input: string, extra: string[] = []) {
    return spawnSync(process.execPath, [tsxCli, entry, "--provider", "local-test", "--model", "test", "--no-snapshot", "--no-instructions", ...extra], {
      cwd: dir,
      env: { ...process.env, REVCODE_HOME: home, NO_COLOR: "1", TERM: "dumb" },
      input,
      encoding: "utf8",
      timeout: 60_000,
    });
  }

  it("answers slash commands and exits at end of input", () => {
    const result = session("/status\n/help\n/exit\n");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Status");
    expect(result.stdout).toContain("Version");
    expect(result.stdout).toContain("Keyboard");
    expect(result.stdout).not.toContain("\u001b");
  });

  it("treats a slash path as a message, not a command, and reports unknown commands helpfully", () => {
    const result = session("/usr/bin/env is missing\n/hlp\n");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Local test client is active"); // the path went to the model
    expect(result.stdout).toContain("Unknown command: /hlp. Did you mean /help?");
  });

  it("runs a user shell command with ! and tells the model about it", () => {
    const result = session("!echo from-the-user\n");
    expect(result.stdout).toContain("exit 0");
    expect(result.stdout).toContain("from-the-user");
  });

  it("prints the shell completion script", () => {
    const result = revcode(["completion", "bash"], dir, home);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("complete -o default -F _revcode revcode");
  });

  it("treats -p as headless: runs the task and exits", () => {
    const result = revcode(["--provider", "local-test", "--model", "test", "--no-snapshot", "--no-instructions", "-p", '/tool list_directory {"path":"."}'], dir, home);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[list_directory(");
  });
});
