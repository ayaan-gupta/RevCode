import { describe, expect, it } from "vitest";
import { parseArgs, parseCommandLine, resolveArgs, defaultArgs, type CliArgs } from "./cli.js";
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
    expect(tune).toMatchObject({ kind: "tune", options: { budget: 30, tasks: ["a", "b"], dryRun: true, trials: 1, yes: false } });
    expect(parseCommandLine(["tune", "-y"])).toMatchObject({ options: { yes: true } });

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

  it("implies a default model from the provider, and demands one where there is no sensible default", () => {
    const withProvider = (provider: CliArgs["provider"], model?: string) =>
      resolveArgs({ ...defaultArgs(), provider, ...(model ? { model, explicit: ["provider", "model"] } : { explicit: ["provider"] }) }, noConfig, {});
    expect(withProvider("anthropic").model).toBe("claude-sonnet-5-5");
    expect(withProvider("anthropic", "claude-opus-5-5").model).toBe("claude-opus-5-5");
    expect(() => withProvider("ollama")).toThrow(/needs a model/);
    expect(withProvider("ollama", "qwen2.5-coder").model).toBe("qwen2.5-coder");
  });
});

describe("terminal and prompt options", () => {
  it("parses --theme and --vim, and validates the theme", () => {
    expect(parseArgs(["--theme", "light", "--vim"])).toMatchObject({ theme: "light", vim: true });
    expect(() => parseArgs(["--theme", "neon"])).toThrow("Unknown theme");
    expect(parseArgs(["--no-vim"]).vim).toBe(false);
  });

  it("takes theme and vim from config unless the command line says otherwise", () => {
    const loaded: LoadedConfig = { config: { theme: "light", vim: true }, warnings: [], files: [] };
    expect(resolveArgs(parseArgs([]), loaded, {})).toMatchObject({ theme: "light", vim: true });
    expect(resolveArgs(parseArgs(["--theme", "dark", "--no-vim"]), loaded, {})).toMatchObject({ theme: "dark", vim: false });
  });

  it("treats a prompt as a request to run headlessly, unless --headless was spelled out", () => {
    expect(parseArgs(["-p", "do it"]).headless).toBe(true);
    expect(parseArgs(["--prompt-file", "task.txt"]).headless).toBe(true);
    expect(parseArgs([]).headless).toBe(false);
    expect(parseArgs(["-p", "x", "--no-headless"]).headless).toBe(false);
  });

  it("parses the setup and completion subcommands", () => {
    expect(parseCommandLine(["setup"]).kind).toBe("setup");
    expect(parseCommandLine(["login"]).kind).toBe("setup");
    expect(parseCommandLine(["completion", "zsh"])).toMatchObject({ kind: "completion", shell: "zsh" });
  });
});
