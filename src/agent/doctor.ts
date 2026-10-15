/** `/doctor`: quick checks of everything RevCode depends on, with a fix hint for each problem. */

import { execFile } from "node:child_process";
import { accessSync, constants, mkdirSync } from "node:fs";
import type { LlmProvider } from "../llm/client.js";
import { revcodeHome, sessionsDir } from "../config/paths.js";
import type { TermCaps } from "../tui/style.js";

export interface DoctorCheck {
  status: "ok" | "warn" | "fail";
  label: string;
  detail?: string;
  hint?: string;
}

export interface DoctorInput {
  provider: LlmProvider | string;
  model: string;
  caps: TermCaps;
  columns: number;
  rows: number;
  configFiles: string[];
  configWarnings: string[];
  mcp: Array<{ name: string; state: string; error?: string }>;
  hookCount: number;
  instructionFiles: string[];
  env?: NodeJS.ProcessEnv;
}

const KEY_ENV: Record<string, { vars: string[]; hint: string }> = {
  zai: { vars: ["Z_AI_API_KEY", "ZAI_API_KEY"], hint: "Set Z_AI_API_KEY (https://z.ai) or run `revcode setup`." },
  anthropic: { vars: ["ANTHROPIC_API_KEY"], hint: "Set ANTHROPIC_API_KEY or run `revcode setup`." },
  openai: { vars: ["OPENAI_API_KEY"], hint: "Set OPENAI_API_KEY or run `revcode setup`." },
  openrouter: { vars: ["OPENROUTER_API_KEY"], hint: "Set OPENROUTER_API_KEY or run `revcode setup`." },
  "openai-compat": { vars: ["REVCODE_BASE_URL"], hint: "Set REVCODE_BASE_URL (and REVCODE_API_KEY if the server needs one)." },
};

function version(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 4000 }, (error, stdout) => {
      if (error) resolve(undefined);
      else resolve(String(stdout).split("\n")[0].trim());
    });
  });
}

export function providerKeyVars(provider: string): string[] | undefined {
  return KEY_ENV[provider]?.vars;
}

export async function runDoctor(input: DoctorInput): Promise<DoctorCheck[]> {
  const env = input.env ?? process.env;
  const checks: DoctorCheck[] = [];

  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  checks.push(major >= 20 ? { status: "ok", label: "Node.js", detail: process.versions.node } : { status: "fail", label: "Node.js", detail: process.versions.node, hint: "RevCode needs Node 20 or newer." });

  const [git, rg, bash, tmux] = await Promise.all([version("git", ["--version"]), version("rg", ["--version"]), version("bash", ["--version"]), version("tmux", ["-V"])]);
  checks.push(git ? { status: "ok", label: "git", detail: git.replace(/^git version /, "") } : { status: "warn", label: "git", detail: "not found", hint: "Parallel Universes and the project snapshot need git." });
  checks.push(rg ? { status: "ok", label: "ripgrep", detail: rg.replace(/^ripgrep /, "") } : { status: "fail", label: "ripgrep (rg)", detail: "not found", hint: "The grep tool needs it: install ripgrep (brew/apt install ripgrep)." });
  checks.push(bash ? { status: "ok", label: "bash" } : { status: "fail", label: "bash", detail: "not found", hint: "The shell tool needs bash on PATH." });
  checks.push(tmux ? { status: "ok", label: "tmux", detail: tmux.replace(/^tmux /, "") } : { status: "warn", label: "tmux", detail: "not installed", hint: "Optional: enables the `terminal` tool for REPLs, editors and debuggers." });

  const keyInfo = KEY_ENV[input.provider];
  if (keyInfo) {
    const present = keyInfo.vars.some((name) => (env[name] ?? "").trim().length > 0);
    checks.push(present ? { status: "ok", label: `${input.provider} credentials`, detail: "found" } : { status: "fail", label: `${input.provider} credentials`, detail: "missing", hint: keyInfo.hint });
  } else if (input.provider === "ollama") {
    checks.push({ status: "ok", label: "ollama", detail: env.OLLAMA_HOST ?? "http://localhost:11434" });
  }
  checks.push({ status: "ok", label: "model", detail: `${input.model} (${input.provider})` });

  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  if (proxy) checks.push({ status: "ok", label: "proxy", detail: proxy.replace(/\/\/[^@/]*@/, "//***@") });

  for (const dir of [revcodeHome(), sessionsDir()]) {
    try {
      mkdirSync(dir, { recursive: true });
      accessSync(dir, constants.W_OK);
      checks.push({ status: "ok", label: "writable", detail: dir });
    } catch {
      checks.push({ status: "fail", label: "not writable", detail: dir, hint: "Sessions and history cannot be saved. Check permissions or set REVCODE_HOME." });
    }
  }

  checks.push({ status: input.configFiles.length > 0 ? "ok" : "ok", label: "config", detail: input.configFiles.length > 0 ? input.configFiles.join(", ") : "none (defaults)" });
  for (const warning of input.configWarnings) checks.push({ status: "warn", label: "config", detail: warning });
  checks.push({ status: "ok", label: "instructions", detail: input.instructionFiles.length > 0 ? input.instructionFiles.join(", ") : "no AGENTS.md found", ...(input.instructionFiles.length === 0 ? { hint: "Run /init to create one." } : {}) });

  for (const server of input.mcp) {
    checks.push(server.state === "connected" ? { status: "ok", label: `mcp: ${server.name}`, detail: "connected" } : { status: "warn", label: `mcp: ${server.name}`, detail: server.state, ...(server.error ? { hint: server.error.split("\n")[0] } : {}) });
  }
  if (input.hookCount > 0) checks.push({ status: "ok", label: "hooks", detail: `${input.hookCount} configured` });

  const depth = input.caps.colorDepth;
  checks.push({
    status: depth === 0 ? "warn" : "ok",
    label: "terminal",
    detail: `${input.columns}×${input.rows} · ${depth === 24 ? "truecolor" : depth === 8 ? "256 colors" : depth === 4 ? "16 colors" : "no color"} · ${input.caps.theme} theme${input.caps.unicode ? "" : " · ASCII glyphs"}${input.caps.hyperlinks ? " · hyperlinks" : ""}`,
    ...(depth === 0 ? { hint: "Color is off (NO_COLOR, a pipe, or TERM=dumb)." } : {}),
  });
  if (env.TMUX && depth < 24) checks.push({ status: "warn", label: "tmux colors", detail: "truecolor not passed through", hint: "Add `set -ga terminal-overrides \",*256col*:Tc\"` to ~/.tmux.conf for full color." });
  if (env.TERM_PROGRAM === "Apple_Terminal") checks.push({ status: "warn", label: "Terminal.app", detail: "no Shift+Enter or truecolor", hint: "Use Ctrl+J or `\\` + Enter for a new line; iTerm2, Ghostty, WezTerm or kitty give the full experience." });
  return checks;
}
