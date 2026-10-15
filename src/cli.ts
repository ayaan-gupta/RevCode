/**
 * Command-line parsing.
 *
 * `revcode [flags]`                interactive session
 * `revcode run <prompt> [flags]`   one headless task (same as --headless --prompt)
 * `revcode tune [flags]`           Dyno: tune the harness for a model
 * `revcode universes <action>`     list / show / diff / land / discard / share / replay / compare
 * `revcode sessions`               list saved sessions
 * `revcode profile <show|reset>`   inspect or clear the tuned profile for the model
 *
 * Flags the user passes explicitly are remembered in `explicit` so config files
 * (which are lower precedence than the command line) never override them.
 */

import { readFileSync } from "node:fs";
import { isLlmProvider, LLM_PROVIDERS, type LlmProvider } from "./llm/client.js";
import type { LoadedConfig } from "./config/config.js";
import { PERMISSION_MODES, type PermissionMode } from "./agent/permissions.js";

export const DEFAULT_MODEL = "glm-5.2";

/**
 * Model to use when the user picked a provider but not a model. Only providers with a
 * sensible fixed default are listed; for the rest (openai, openrouter, ollama,
 * openai-compat) the right model depends on what the user has, so we ask for one.
 */
export const PROVIDER_DEFAULT_MODELS: Partial<Record<LlmProvider, string>> = {
  zai: "glm-5.2",
  anthropic: "claude-sonnet-5-5",
  "local-test": "test",
};

export type OutputFormat = "text" | "json" | "stream-json";

export interface CliArgs {
  /** Working directory for the agent. Defaults to cwd. */
  cwd: string;
  /** Model identifier (e.g. "glm-5.2", "claude-sonnet-5-5"). */
  model: string;
  /** LLM provider to use. */
  provider?: LlmProvider;
  /** Override the provider's API base URL (OpenAI-compatible servers, proxies). */
  baseUrl?: string;
  /** Run in non-interactive / headless mode. */
  headless: boolean;
  /** Task instruction for headless mode. */
  prompt?: string;
  /**
   * Read the task instruction from this file instead. Keeps the (possibly long) task text out of
   * the process command line, where a model's `pkill -f <word>` could match the agent itself.
   */
  promptFile?: string;
  /** Output path for JSONL trajectory logs. */
  trajectoryOut?: string;
  /** Maximum tool loop iterations per user turn. */
  maxIterations: number;
  permissionMode?: PermissionMode;
  allow?: string[];
  deny?: string[];
  /** Resume a saved session by id ("" = the most recent for this directory). */
  resume?: string;
  /** Alias for `--resume` with no id. */
  continueLast?: boolean;
  /** Run inside a Parallel Universe (isolated, recorded copy of the project). */
  universe?: boolean;
  /** "auto" | "default" | path to a profile JSON. */
  profile?: string;
  timeBudgetSec?: number;
  outputFormat?: OutputFormat;
  snapshot?: boolean;
  mcp?: boolean;
  hooks?: boolean;
  /** Load AGENTS.md / CLAUDE.md project instructions (default true). */
  instructions?: boolean;
  verbose?: boolean;
  /** "auto" | "dark" | "light" — terminal color theme. */
  theme?: string;
  /** Flag keys set explicitly on the command line. */
  explicit?: string[];
}

export interface TuneOptions {
  /** Max number of task runs to spend. */
  budget: number;
  trials: number;
  tasks?: string[];
  categories?: string[];
  /** Print the plan without calling the model. */
  dryRun: boolean;
  /** Write the lift card (markdown) to this path. */
  cardOut?: string;
  /** Don't save the winning profile. */
  noSave: boolean;
  /** Edit modes to consider (default: all implemented). */
  editModes?: string[];
  /** Skip the confirmation about running the model with an unrestricted shell. */
  yes: boolean;
}

export type Command =
  | { kind: "run"; args: CliArgs }
  | { kind: "tune"; args: CliArgs; options: TuneOptions }
  | { kind: "universes"; args: CliArgs; action: string; rest: string[] }
  | { kind: "sessions"; args: CliArgs }
  | { kind: "profile"; args: CliArgs; action: string }
  | { kind: "setup"; args: CliArgs }
  | { kind: "help" }
  | { kind: "version" };

type FlagKind = "string" | "boolean" | "int" | "float" | "list" | "optional-string";

interface FlagSpec {
  key: string;
  kind: FlagKind;
  aliases?: string[];
}

const FLAGS: Record<string, FlagSpec> = {
  "--cwd": { key: "cwd", kind: "string" },
  "--model": { key: "model", kind: "string", aliases: ["-m"] },
  "--provider": { key: "provider", kind: "string" },
  "--base-url": { key: "baseUrl", kind: "string" },
  "--headless": { key: "headless", kind: "boolean" },
  "--prompt": { key: "prompt", kind: "string", aliases: ["-p"] },
  "--prompt-file": { key: "promptFile", kind: "string" },
  "--trajectory-out": { key: "trajectoryOut", kind: "string" },
  "--max-iterations": { key: "maxIterations", kind: "int" },
  "--mode": { key: "permissionMode", kind: "string" },
  "--allow": { key: "allow", kind: "list" },
  "--deny": { key: "deny", kind: "list" },
  "--resume": { key: "resume", kind: "optional-string", aliases: ["-r"] },
  "--continue": { key: "continueLast", kind: "boolean", aliases: ["-c"] },
  "--universe": { key: "universe", kind: "boolean", aliases: ["-u"] },
  "--profile": { key: "profile", kind: "string" },
  "--time-budget": { key: "timeBudgetSec", kind: "float" },
  "--output-format": { key: "outputFormat", kind: "string" },
  "--snapshot": { key: "snapshot", kind: "boolean" },
  "--mcp": { key: "mcp", kind: "boolean" },
  "--hooks": { key: "hooks", kind: "boolean" },
  "--instructions": { key: "instructions", kind: "boolean" },
  "--verbose": { key: "verbose", kind: "boolean" },
  "--theme": { key: "theme", kind: "string" },
};

const SHORT_ALIASES = new Map<string, string>();
for (const [flag, spec] of Object.entries(FLAGS)) {
  for (const alias of spec.aliases ?? []) {
    SHORT_ALIASES.set(alias, flag);
  }
}

const TUNE_FLAGS: Record<string, { key: keyof TuneOptions; kind: FlagKind }> = {
  "--budget": { key: "budget", kind: "int" },
  "--trials": { key: "trials", kind: "int" },
  "--tasks": { key: "tasks", kind: "list" },
  "--categories": { key: "categories", kind: "list" },
  "--dry-run": { key: "dryRun", kind: "boolean" },
  "--card": { key: "cardOut", kind: "string" },
  "--no-save": { key: "noSave", kind: "boolean" },
  "--edit-modes": { key: "editModes", kind: "list" },
  "--yes": { key: "yes", kind: "boolean" },
};

export function defaultArgs(): CliArgs {
  return {
    cwd: process.cwd(),
    model: DEFAULT_MODEL,
    headless: false,
    maxIterations: 50,
  };
}

export function parseCommandLine(argv: string[]): Command {
  const [first, ...rest] = argv;
  switch (first) {
    case "help":
    case "--help":
    case "-h":
      return { kind: "help" };
    case "version":
    case "--version":
    case "-v":
      return { kind: "version" };
    case "run": {
      const { args, positional } = parseFlags(rest, { allowPositional: true });
      const prompt = positional.join(" ").trim();
      if (prompt) {
        args.prompt = prompt;
      }
      args.headless = true;
      return { kind: "run", args };
    }
    case "tune": {
      const { args, tune } = parseFlags(rest, { tune: true });
      return { kind: "tune", args, options: finishTune(tune) };
    }
    case "universes":
    case "universe": {
      const action = rest[0] && !rest[0].startsWith("-") ? rest[0] : "list";
      const remaining = rest[0] && !rest[0].startsWith("-") ? rest.slice(1) : rest;
      const { args, positional } = parseFlags(remaining, { allowPositional: true, passthroughUnknown: true });
      return { kind: "universes", args, action, rest: positional };
    }
    case "sessions": {
      const { args } = parseFlags(rest, {});
      return { kind: "sessions", args };
    }
    case "setup":
    case "login": {
      const { args } = parseFlags(rest, {});
      return { kind: "setup", args };
    }
    case "profile": {
      const action = rest[0] && !rest[0].startsWith("-") ? rest[0] : "show";
      const { args } = parseFlags(rest[0] && !rest[0].startsWith("-") ? rest.slice(1) : rest, {});
      return { kind: "profile", args, action };
    }
    default:
      return { kind: "run", args: parseArgs(argv) };
  }
}

/** Parse flags for the default (interactive / --headless) mode. */
export function parseArgs(argv: string[]): CliArgs {
  return parseFlags(argv, {}).args;
}

interface ParseOptions {
  allowPositional?: boolean;
  tune?: boolean;
  /** Collect unknown --flags into `positional` (universes subcommands take their own flags). */
  passthroughUnknown?: boolean;
}

function parseFlags(
  argv: string[],
  options: ParseOptions,
): { args: CliArgs; positional: string[]; tune: Partial<TuneOptions> } {
  const args = defaultArgs();
  const explicit = new Set<string>();
  const positional: string[] = [];
  const tune: Record<string, unknown> = {};
  const record = args as unknown as Record<string, unknown>;

  for (let index = 0; index < argv.length; index += 1) {
    let arg = argv[index];
    let inline: string | undefined;

    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    if (eq !== -1) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    arg = SHORT_ALIASES.get(arg) ?? arg;
    if (options.tune && arg === "-y") arg = "--yes";

    // Boolean negation: --no-snapshot, --no-mcp, --no-hooks, --no-universe
    if (arg.startsWith("--no-") && FLAGS[`--${arg.slice(5)}`]?.kind === "boolean") {
      const spec = FLAGS[`--${arg.slice(5)}`];
      record[spec.key] = false;
      explicit.add(spec.key);
      continue;
    }

    const tuneSpec = options.tune ? TUNE_FLAGS[arg] : undefined;
    const spec = tuneSpec ?? FLAGS[arg];
    if (!spec) {
      if (arg.startsWith("-") && !(options.passthroughUnknown && arg.startsWith("--"))) {
        throw new Error(`Unknown argument: ${argv[index]}`);
      }
      if (arg.startsWith("--")) {
        positional.push(argv[index]);
        continue;
      }
      if (options.allowPositional || options.passthroughUnknown) {
        positional.push(argv[index]);
        continue;
      }
      throw new Error(`Unknown argument: ${argv[index]}`);
    }

    const target = tuneSpec ? tune : record;
    const key = tuneSpec ? tuneSpec.key : (spec as FlagSpec).key;
    let value: unknown;

    switch (spec.kind) {
      case "boolean":
        value = inline === undefined ? true : inline !== "false";
        break;
      case "optional-string": {
        const next = argv[index + 1];
        if (inline !== undefined) {
          value = inline;
        } else if (next !== undefined && !next.startsWith("-")) {
          value = next;
          index += 1;
        } else {
          value = "";
        }
        break;
      }
      default: {
        const raw = inline ?? readFlagValue(argv, index, arg);
        if (inline === undefined) index += 1;
        value = convert(raw, spec.kind, arg);
      }
    }

    if (spec.kind === "list") {
      const existing = (target[key] as string[] | undefined) ?? [];
      target[key] = [...existing, ...(value as string[])];
    } else {
      target[key] = value;
    }
    if (!tuneSpec) {
      explicit.add(key);
    }
  }

  if (args.provider !== undefined && !isLlmProvider(args.provider)) {
    throw new Error(`Unknown provider: ${args.provider}. Expected one of: ${LLM_PROVIDERS.join(", ")}.`);
  }
  if (args.permissionMode !== undefined && !PERMISSION_MODES.includes(args.permissionMode)) {
    throw new Error(`Unknown mode: ${args.permissionMode}. Expected one of: ${PERMISSION_MODES.join(", ")}.`);
  }
  if (args.theme !== undefined && !["auto", "dark", "light"].includes(args.theme)) {
    throw new Error(`Unknown theme: ${args.theme}. Expected auto, dark, or light.`);
  }
  if (args.outputFormat !== undefined && !["text", "json", "stream-json"].includes(args.outputFormat)) {
    throw new Error(`Unknown output format: ${args.outputFormat}. Expected text, json, or stream-json.`);
  }
  if (args.continueLast) {
    args.resume = args.resume ?? "";
    explicit.add("resume");
  }
  // `-p "task"` / `--prompt-file f` mean "run this and exit", as in other agent CLIs.
  if ((args.prompt !== undefined || args.promptFile !== undefined) && !explicit.has("headless")) {
    args.headless = true;
  }
  args.explicit = [...explicit];
  return { args, positional, tune: tune as Partial<TuneOptions> };
}

function finishTune(raw: Partial<TuneOptions>): TuneOptions {
  return {
    budget: raw.budget ?? 200,
    trials: raw.trials ?? 1,
    tasks: raw.tasks,
    categories: raw.categories,
    dryRun: raw.dryRun ?? false,
    cardOut: raw.cardOut,
    noSave: raw.noSave ?? false,
    editModes: raw.editModes,
    yes: raw.yes ?? false,
  };
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || (value.startsWith("--") && value.length > 2)) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function convert(raw: string, kind: FlagKind, flag: string): unknown {
  switch (kind) {
    case "int": {
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${flag}: expected a positive integer, got: ${raw}`);
      }
      return parsed;
    }
    case "float": {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`${flag}: expected a positive number, got: ${raw}`);
      }
      return parsed;
    }
    case "list":
      return raw.split(",").map((item) => item.trim()).filter(Boolean);
    default:
      return raw;
  }
}

/**
 * Apply config-file defaults beneath the command line: anything the user typed
 * wins, then config, then built-in defaults.
 */
export function resolveArgs(args: CliArgs, loaded: LoadedConfig, env: NodeJS.ProcessEnv = process.env): CliArgs {
  const { config } = loaded;
  const explicit = new Set(args.explicit ?? []);
  const out: CliArgs = { ...args };

  if (out.promptFile) {
    try {
      out.prompt = readFileSync(out.promptFile, "utf8").replace(/\r?\n$/, "");
    } catch (error) {
      throw new Error(`--prompt-file could not be read: ${out.promptFile} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  if (!explicit.has("model") && config.model) out.model = config.model;
  if (!explicit.has("provider") && config.provider && isLlmProvider(config.provider)) out.provider = config.provider;
  if (!explicit.has("model") && !config.model && out.provider) {
    const implied = PROVIDER_DEFAULT_MODELS[out.provider];
    if (implied) {
      out.model = implied;
    } else if (!out.headless || !out.prompt) {
      // Interactive start with e.g. --provider ollama and no model: fail early with a useful message.
      throw new Error(`--provider ${out.provider} needs a model: pass --model <name> (or set "model" in .revcode/config.json).`);
    }
  }
  if (!explicit.has("baseUrl") && config.baseUrl) out.baseUrl = config.baseUrl;
  if (!explicit.has("maxIterations")) {
    out.maxIterations = config.maxIterations ?? (out.headless ? 300 : 100);
  }
  if (!explicit.has("permissionMode") && config.permissions?.mode) out.permissionMode = config.permissions.mode;
  out.allow = [...(config.permissions?.allow ?? []), ...(args.allow ?? [])];
  out.deny = [...(config.permissions?.deny ?? []), ...(args.deny ?? [])];
  if (!explicit.has("universe") && config.universe !== undefined) out.universe = config.universe;
  if (!explicit.has("profile")) out.profile = config.profile ?? "auto";
  if (!explicit.has("timeBudgetSec")) {
    const fromEnv = env.REVCODE_TIME_BUDGET_SEC ? Number(env.REVCODE_TIME_BUDGET_SEC) : undefined;
    out.timeBudgetSec = config.timeBudgetSec ?? (fromEnv && Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : undefined);
  }
  if (!explicit.has("snapshot")) out.snapshot = config.snapshot ?? true;
  if (!explicit.has("mcp")) out.mcp = config.mcp ?? true;
  if (!explicit.has("hooks")) out.hooks = config.hooks ?? true;
  if (!explicit.has("instructions")) out.instructions = true;
  if (!explicit.has("theme") && config.theme) out.theme = config.theme;
  out.outputFormat = out.outputFormat ?? "text";
  return out;
}

export const HELP_TEXT = `RevCode — an AI coding agent for the terminal

Usage:
  revcode [flags]                 interactive session
  revcode run "<task>" [flags]    run one task headlessly
  revcode tune [flags]            Dyno: benchmark & tune the harness for --model
  revcode universes <action>      list | show | diff | land | discard | share | replay | compare | purge
  revcode sessions                list saved sessions
  revcode profile <show|reset>    inspect or clear the tuned profile for --model
  revcode setup                   choose a provider and save your API key

Common flags:
  -m, --model <name>        model id (default ${DEFAULT_MODEL})
      --provider <name>     ${LLM_PROVIDERS.join(" | ")}
      --base-url <url>      API base URL (OpenAI-compatible servers, proxies)
      --cwd <path>          working directory
  -p, --prompt <text>       task for --headless
      --prompt-file <path>  read the task for --headless from a file
      --headless            run one task and exit
      --output-format <f>   text | json | stream-json (headless)
      --mode <mode>         ask | accept-edits | plan | yolo   (default: ask; yolo when headless)
      --allow <rule,...>    permission allow rules, e.g. "shell(git status*)"
      --deny <rule,...>     permission deny rules
  -u, --universe            run inside an isolated, recorded Parallel Universe; land changes when happy
  -c, --continue            resume the latest session in this directory
  -r, --resume [id]         resume a session
      --profile <p>         auto | default | path to a profile JSON
      --time-budget <sec>   wall-clock budget (nudges the model, stops cleanly near the limit)
      --max-iterations <n>  tool-loop limit per turn
      --trajectory-out <f>  write a JSONL trajectory
      --theme <t>           auto | dark | light   terminal colors (default auto)
      --verbose             show longer tool output
      --no-snapshot --no-mcp --no-hooks --no-instructions   disable the startup environment snapshot / MCP servers / hooks / AGENTS.md

Environment: Z_AI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, OLLAMA_HOST,
REVCODE_BASE_URL / REVCODE_API_KEY (generic OpenAI-compatible), REVCODE_HOME, REVCODE_TIME_BUDGET_SEC.
`;
