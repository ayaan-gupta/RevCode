import { describe, expect, it } from "vitest";
import { parseArgs, parseCommandLine, resolveArgs, defaultArgs } from "./cli.js";
import type { LoadedConfig } from "./config/config.js";

const noConfig: LoadedConfig = { config: {}, warnings: [], files: [] };

describe("parseArgs", () => {
  it("parses long flags in both spaced and = forms", () => {
    const args = parseArgs(["--model", "glm-4.7", "--cwd=/tmp/x", "--max-iterations", "7", "--provider=openai"]);
    expect(args).toMatchObject({ model: "glm-4.7", cwd: "/tmp/x", maxIterations: 7, provider: "openai" });
    expect(args.explicit).toEqual(expect.arrayContaining(["model", "cwd", "maxIterations", "provider"]));
  });

  it("supports short aliases, negation, lists, and optional values", () => {
    const args = parseArgs(["-m", "x", "-u", "--no-snapshot", "--allow", "a,b", "--allow", "c", "-r"]);
    expect(args).toMatchObject({ model: "x", universe: true, snapshot: false, allow: ["a", "b", "c"], resume: "" });
    expect(parseArgs(["--resume", "abc123"]).resume).toBe("abc123");
    expect(parseArgs(["-c"]).resume).toBe("");
  });

  it("rejects unknown flags, bad providers, bad numbers, and bad modes", () => {
    expect(() => parseArgs(["--bogus"])).toThrow("Unknown argument");
    expect(() => parseArgs(["--provider", "nope"])).toThrow("Unknown provider");
    expect(() => parseArgs(["--max-iterations", "0"])).toThrow("positive integer");
    expect(() => parseArgs(["--mode", "reckless"])).toThrow("Unknown mode");
    expect(() => parseArgs(["--model"])).toThrow("requires a value");
  });
});

describe("parseCommandLine", () => {
  it("dispatches subcommands", () => {
    expect(parseCommandLine(["--help"]).kind).toBe("help");
    expect(parseCommandLine(["-v"]).kind).toBe("version");
    expect(parseCommandLine([]).kind).toBe("run");

    const run = parseCommandLine(["run", "fix", "the", "bug", "--model", "m"]);
    expect(run).toMatchObject({ kind: "run", args: { headless: true, prompt: "fix the bug", model: "m" } });

    const tune = parseCommandLine(["tune", "--model", "glm-5.2", "--budget", "30", "--tasks", "a,b", "--dry-run"]);
    expect(tune).toMatchObject({ kind: "tune", options: { budget: 30, tasks: ["a", "b"], dryRun: true, trials: 1 } });

    const uni = parseCommandLine(["universes", "land", "u123", "--markers"]);
    expect(uni).toMatchObject({ kind: "universes", action: "land", rest: ["u123", "--markers"] });
    expect(parseCommandLine(["universes"])).toMatchObject({ action: "list" });
    expect(parseCommandLine(["profile", "reset"])).toMatchObject({ kind: "profile", action: "reset" });
  });
});

describe("resolveArgs", () => {
  it("lets explicit flags beat config, and config beat defaults", () => {
    const args = { ...defaultArgs(), model: "cli-model", explicit: ["model"] };
    const resolved = resolveArgs(
      args,
      { ...noConfig, config: { model: "cfg-model", maxIterations: 33, universe: true, permissions: { mode: "plan", allow: ["x"], deny: ["y"] } } },
      {},
    );
    expect(resolved.model).toBe("cli-model");
    expect(resolved.maxIterations).toBe(33);
    expect(resolved.universe).toBe(true);
    expect(resolved.permissionMode).toBe("plan");
    expect(resolved.allow).toEqual(["x"]);
    expect(resolved.profile).toBe("auto");
  });

  it("uses a larger default iteration cap for headless runs and reads the time budget env", () => {
    const interactive = resolveArgs({ ...defaultArgs() }, noConfig, {});
    const headless = resolveArgs({ ...defaultArgs(), headless: true }, noConfig, { REVCODE_TIME_BUDGET_SEC: "900" });
    expect(interactive.maxIterations).toBe(100);
    expect(headless.maxIterations).toBe(300);
    expect(headless.timeBudgetSec).toBe(900);
    expect(headless.snapshot).toBe(true);
  });
});
