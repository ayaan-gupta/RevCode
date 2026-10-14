/**
 * Runtime assembly.
 *
 * Builds everything an agent session needs from CLI args: the harness profile,
 * tools (plus MCP tools and skills), permissions, hooks, the optional Parallel
 * Universe, verification/completion gates, receipts, the system prompt, and the
 * engine. The interactive TUI, headless runs, Dyno benchmarks and universe
 * replays all share this one path, so they cannot drift apart.
 */

import { readFileSync } from "node:fs";
import type { CliArgs } from "../cli.js";
import { loadInstructions } from "../config/instructions.js";
import { isProjectTrusted, projectExecutableConfigs, trustProject } from "../config/trust.js";
import { createCompletionGate, type CompletionGate } from "../harness/completion-gate.js";
import { collectEnvSnapshot } from "../harness/env-snapshot.js";
import {
  DEFAULT_PROFILE,
  loadStoredProfile,
  sanitizeProfile,
  type HarnessProfile,
} from "../harness/profile.js";
import { buildSystemPrompt } from "../harness/prompt.js";
import { TimeBudget } from "../harness/time-budget.js";
import { createVerifyGate, type VerifyGate } from "../harness/verify-gate.js";
import { HookRunner } from "../hooks/index.js";
import { createLlmClient, resolveProvider, type LlmClient, type LlmMessage } from "../llm/client.js";
import { loadMcpConfig, McpManager } from "../mcp/index.js";
import {
  createSkillTool,
  discoverCommands,
  discoverSkills,
  skillsPromptSection,
  skillToCommand,
  type CustomCommand,
  type Skill,
} from "../skills/index.js";
import { ToolRegistry } from "../tools/index.js";
import { viewImage, viewImageToolDefinition, type ViewImageInput } from "../tools/view-image.js";
import { createUniverseRecorder } from "../universe/recorder.js";
import { ReceiptCollector } from "../universe/receipts.js";
import { Universe } from "../universe/universe.js";
import { AgentEngine, type EngineObserver, type ToolMiddleware } from "./engine.js";
import { PermissionManager, type Approver, type PermissionMode } from "./permissions.js";
import { newSessionId } from "./session.js";
import { createTaskTool, TASK_TOOL_NAME } from "./subagent.js";

export interface RuntimeOptions {
  args: CliArgs;
  interactive: boolean;
  approver?: Approver;
  /** Ask the user a yes/no question (project trust). Absent = non-interactive. */
  confirm?: (question: string) => Promise<boolean>;
  observer?: EngineObserver;
  warn?: (message: string) => void;
  /** Inject a model client (tests, Dyno, replay). */
  llm?: LlmClient;
  /** Force a profile (Dyno). */
  profile?: HarnessProfile;
  sessionId?: string;
  initialMessages?: LlmMessage[];
  /** Reuse an existing universe instead of creating one. */
  universe?: Universe;
  /** Skip AGENTS.md / skills / hooks / MCP discovery (hermetic benchmark runs). */
  hermetic?: boolean;
  /** Task text for the completion audit (headless). */
  task?: string;
}

export interface Runtime {
  engine: AgentEngine;
  tools: ToolRegistry;
  permissions: PermissionManager;
  profile: HarnessProfile;
  profileSource: string;
  provider: string;
  universe?: Universe;
  collector: ReceiptCollector;
  hooks?: HookRunner;
  mcp?: McpManager;
  skills: Skill[];
  commands: CustomCommand[];
  completion?: CompletionGate;
  verify?: VerifyGate;
  /** Directory the agent works in (the universe copy, when there is one). */
  cwd: string;
  sessionId: string;
  turn: { value: number };
  /** Context returned by SessionStart hooks, to prepend to the first turn. */
  sessionStartContext?: string;
  getLlm(): LlmClient;
  setLlm(llm: LlmClient): void;
  /** Switch model mid-session: new client, and the tuned profile for that model if one exists. */
  switchModel(model: string): { provider: string; profile: HarnessProfile; profileSource: string };
  dispose(): Promise<void>;
}

export function resolveProfile(
  spec: string | undefined,
  provider: string,
  model: string,
): { profile: HarnessProfile; source: string } {
  const choice = spec ?? "auto";
  if (choice === "default") {
    return { profile: DEFAULT_PROFILE, source: "default" };
  }
  if (choice !== "auto") {
    try {
      const raw = JSON.parse(readFileSync(choice, "utf8")) as { profile?: unknown };
      return { profile: sanitizeProfile(raw.profile ?? raw), source: choice };
    } catch (error) {
      throw new Error(`Could not load profile ${choice}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const stored = loadStoredProfile(provider, model);
  return stored ? { profile: stored.profile, source: "tuned" } : { profile: DEFAULT_PROFILE, source: "default" };
}

export function defaultPermissionMode(args: CliArgs, inUniverse: boolean): PermissionMode {
  if (args.permissionMode) return args.permissionMode;
  if (args.headless || inUniverse) return "yolo";
  return "ask";
}

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const { args } = options;
  const warn = options.warn ?? (() => undefined);
  const hermetic = options.hermetic ?? false;
  const provider = resolveProvider(args.provider, args.model);
  const sessionId = options.sessionId ?? newSessionId();

  let llm = options.llm ?? createLlmClient({ model: args.model, provider: args.provider, baseUrl: args.baseUrl });
  let runtimeLlm = llm;

  const resolved = options.profile
    ? { profile: options.profile, source: "override" }
    : resolveProfile(args.profile, provider, args.model);
  const profile = resolved.profile;

  // --- universe -------------------------------------------------------------
  let universe = options.universe;
  if (!universe && args.universe) {
    universe = await Universe.create({ projectRoot: args.cwd, provider, model: args.model });
  }
  const cwd = universe ? universe.workDir : args.cwd;

  // --- permissions & tools --------------------------------------------------
  const mode = defaultPermissionMode(args, universe !== undefined);
  const unrestrictedPaths = !universe && (args.headless || mode === "yolo");
  const tools = new ToolRegistry({ cwd, profile, unrestrictedPaths });

  const trustNeeded = !hermetic ? projectExecutableConfigs(args.cwd) : [];
  let trusted = trustNeeded.length === 0 || isProjectTrusted(args.cwd);
  if (!trusted && options.confirm) {
    trusted = await options.confirm(
      `This project defines hooks or MCP servers that run commands on your machine:\n${trustNeeded.map((f) => `  ${f}`).join("\n")}\nTrust ${args.cwd}?`,
    );
    if (trusted) trustProject(args.cwd);
  }
  if (!trusted && trustNeeded.length > 0) {
    warn(`Skipping project hooks/MCP servers (project not trusted). Set REVCODE_TRUST_PROJECT=1 or run interactively to trust it.`);
  }

  // MCP
  let mcp: McpManager | undefined;
  if (args.mcp !== false && !hermetic) {
    const loaded = await loadMcpConfig(args.cwd);
    const servers = loaded.servers.filter((server) => trusted || !server.source.startsWith(args.cwd));
    if (servers.length > 0) {
      mcp = new McpManager({ servers, warnings: loaded.warnings }, { cwd, onWarning: warn });
      await mcp.start();
      for (const tool of mcp.tools()) {
        tools.register(tool);
      }
      tools.markReadOnly(mcp.readOnlyToolNames());
      const manager = mcp;
      manager.onToolsChanged(() => {
        for (const tool of manager.tools()) {
          tools.register(tool);
        }
        tools.markReadOnly(manager.readOnlyToolNames());
      });
    } else {
      for (const message of loaded.warnings) warn(message);
    }
  }

  // Skills & custom commands
  let skills: Skill[] = [];
  let commands: CustomCommand[] = [];
  if (!hermetic) {
    const found = discoverSkills(args.cwd);
    skills = found.skills;
    found.warnings.forEach(warn);
    const foundCommands = discoverCommands(args.cwd);
    foundCommands.warnings.forEach(warn);
    commands = [...foundCommands.commands, ...skills.map(skillToCommand)];
    if (skills.some((skill) => !skill.disableModelInvocation)) {
      tools.register(createSkillTool(skills));
    }
  }

  // Subagents
  tools.register(
    createTaskTool({
      cwd,
      llm: () => runtimeLlm,
      profile,
      unrestrictedPaths,
      notice: options.observer?.notice,
    }),
  );
  tools.markReadOnly([TASK_TOOL_NAME]);

  // Image understanding: only when the provider has a vision model to ask.
  if (runtimeLlm.describeImage) {
    tools.register({
      definition: viewImageToolDefinition,
      handler: (input) =>
        viewImage(
          input as ViewImageInput,
          {
            cwd,
            unrestricted: unrestrictedPaths,
            describe: (image, signal) => {
              if (!runtimeLlm.describeImage) {
                throw new Error("The current model has no vision model configured, so images cannot be viewed.");
              }
              return runtimeLlm.describeImage(image, { signal });
            },
          },
        ),
    });
    tools.markReadOnly([viewImageToolDefinition.name]);
  }

  const permissions = new PermissionManager({
    mode,
    allow: args.allow,
    deny: args.deny,
    approver: options.approver,
    isReadOnly: (name) => tools.isReadOnly(name),
    hookDecision: (callId) => hooks?.lastPermissionDecision(callId),
  });

  // Hooks
  let hooks: HookRunner | undefined;
  if (args.hooks !== false && !hermetic) {
    hooks = HookRunner.load(args.cwd, sessionId, { includeProject: trusted, onWarning: warn });
    if (!hooks.hasHooks("PreToolUse") && !hooks.hasHooks("PostToolUse") && !hooks.hasHooks("Stop") && !hooks.hasHooks("UserPromptSubmit") && !hooks.hasHooks("SessionStart")) {
      hooks = undefined;
    }
  }

  // --- prompt ---------------------------------------------------------------
  const instructions =
    hermetic || args.instructions === false ? { text: "", files: [] as string[] } : loadInstructions(args.cwd);
  const envSnapshot = args.snapshot === false ? "" : await collectEnvSnapshot(cwd);
  const extraSections: string[] = [];
  if (skills.length > 0) {
    extraSections.push(skillsPromptSection(skills.filter((skill) => !skill.disableModelInvocation)));
  }
  if (mcp) {
    const connected = mcp.statuses().filter((s) => s.state === "connected");
    if (connected.length > 0) {
      extraSections.push(`# MCP\nExternal tools from MCP servers (${connected.map((s) => s.name).join(", ")}) are available with names like mcp__<server>__<tool>.`);
    }
  }
  if (tools.hasTerminal()) {
    extraSections.push(
      "# Interactive programs\nUse the `terminal` tool (not shell) for programs that need keyboard input: REPLs, editors like vim, debuggers, installers that ask questions, text games. Start the program, type with send, read the returned screen, and kill the session when done.",
    );
  }
  if (universe) {
    extraSections.push(
      `# Universe\nYou are working inside an isolated copy of the user's project (original: ${universe.meta.projectRoot}). Every change you make is recorded and stays in this copy; nothing reaches the real project until the user lands it. Use paths relative to the working directory and never reference the original project path.`,
    );
  }
  const promptBase = {
    cwd,
    mode: (args.headless ? "headless" : "interactive") as "headless" | "interactive",
    instructions: instructions.text,
    envSnapshot,
    extraSections,
  };
  const systemPrompt = buildSystemPrompt({ ...promptBase, profile });

  // --- middleware & gates ---------------------------------------------------
  const collector = new ReceiptCollector();
  const verify = profile.verifyGate ? createVerifyGate() : undefined;
  const completion =
    args.headless && profile.completionGate ? createCompletionGate(options.task ?? "(see the conversation above)", 2, (name) => tools.isReadOnly(name)) : undefined;
  const turn = { value: 0 };

  const middleware: ToolMiddleware[] = [];
  if (hooks) middleware.push(hooks.toMiddleware());
  middleware.push(permissions.middleware());
  if (verify) middleware.push(verify.middleware);
  if (completion) middleware.push(completion.middleware);
  middleware.push(collector.middleware());

  const finalGates = [];
  if (hooks) finalGates.push(hooks.toFinalGate());
  if (verify) finalGates.push(verify.gate);
  if (completion) finalGates.push(completion.gate);

  const timeBudget = args.timeBudgetSec ? new TimeBudget(args.timeBudgetSec * 1000) : undefined;

  const engine = new AgentEngine({
    cwd,
    llm,
    profile,
    systemPrompt,
    tools,
    maxIterations: args.maxIterations,
    stream: options.interactive,
    observer: options.observer,
    middleware,
    finalGates,
    timeBudget,
    initialMessages: options.initialMessages,
  });

  if (options.initialMessages && options.initialMessages.length > 0) {
    // A resumed conversation keeps its history but gets today's prompt/instructions.
    engine.setSystemPrompt(systemPrompt, profile);
  }

  if (universe) {
    engine.addMiddleware(
      createUniverseRecorder(universe, {
        isReadOnly: (name) => tools.isReadOnly(name),
        context: () => ({ messageCount: engine.messages.length, turn: turn.value }),
        onError: (error) => warn(`universe checkpoint failed: ${error instanceof Error ? error.message : String(error)}`),
      }),
    );
  }

  const sessionStartContext = hooks ? await hooks.runSessionStart() : undefined;

  const runtime: Runtime = {
    engine,
    tools,
    permissions,
    profile,
    profileSource: resolved.source,
    provider,
    universe,
    collector,
    hooks,
    mcp,
    skills,
    commands,
    completion,
    verify,
    cwd,
    sessionId,
    turn,
    sessionStartContext,
    getLlm: () => runtimeLlm,
    setLlm(next) {
      llm = next;
      runtimeLlm = next;
      engine.setLlm(next);
    },
    switchModel(model) {
      const nextProvider = resolveProvider(args.provider, model);
      const nextLlm = createLlmClient({ model, provider: args.provider, baseUrl: args.baseUrl });
      const next = options.profile
        ? { profile: options.profile, source: "override" }
        : resolveProfile(args.profile, nextProvider, model);
      tools.setProfile(next.profile);
      engine.setSystemPrompt(buildSystemPrompt({ ...promptBase, profile: next.profile }), next.profile);
      runtime.setLlm(nextLlm);
      runtime.provider = nextProvider;
      runtime.profile = next.profile;
      runtime.profileSource = next.source;
      return { provider: nextProvider, profile: next.profile, profileSource: next.source };
    },
    async dispose() {
      tools.dispose();
      await mcp?.dispose();
    },
  };
  return runtime;
}
