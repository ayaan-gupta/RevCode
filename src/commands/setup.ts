/**
 * `revcode setup`: pick a provider, paste a key (masked), check it works, save it.
 *
 * The key goes to `~/.revcode/.env` (mode 0600) — never into a project directory, where it could
 * be committed — and the provider/model choice to `~/.revcode/config.json`.
 */

import type { CliArgs } from "../cli.js";
import { providerKeyVars } from "../agent/doctor.js";
import { saveUserConfig } from "../config/config.js";
import { saveUserEnv, userEnvFile } from "../config/env.js";
import { createLlmClient, resolveProvider, type LlmProvider } from "../llm/client.js";
import { LineEditor } from "../tui/editor.js";
import { explainError } from "../tui/errors.js";
import { detectCaps, Style } from "../tui/style.js";
import { TerminalUI } from "../tui/ui.js";

interface ProviderChoice {
  id: LlmProvider;
  label: string;
  hint: string;
  envKey?: string;
  site?: string;
  model?: string;
}

const CHOICES: ProviderChoice[] = [
  { id: "zai", label: "Z.ai (GLM)", hint: "default · glm-5.2", envKey: "Z_AI_API_KEY", site: "z.ai", model: "glm-5.2" },
  { id: "anthropic", label: "Anthropic (Claude)", hint: "claude-sonnet-5-5", envKey: "ANTHROPIC_API_KEY", site: "console.anthropic.com", model: "claude-sonnet-5-5" },
  { id: "openai", label: "OpenAI", hint: "gpt-5", envKey: "OPENAI_API_KEY", site: "platform.openai.com/api-keys", model: "gpt-5" },
  { id: "openrouter", label: "OpenRouter", hint: "many models, one key", envKey: "OPENROUTER_API_KEY", site: "openrouter.ai/keys" },
  { id: "ollama", label: "Ollama (local)", hint: "no key needed" },
  { id: "openai-compat", label: "Another OpenAI-compatible server", hint: "vLLM, LM Studio, llama.cpp, …" },
];

/** What is missing for the provider this run would use, or undefined when it is ready. */
export function missingCredentials(args: Pick<CliArgs, "provider" | "model" | "baseUrl">): { provider: string; message: string } | undefined {
  const provider = resolveProvider(args.provider, args.model);
  const vars = providerKeyVars(provider);
  if (!vars) return undefined;
  if (provider === "openai-compat" && args.baseUrl) return undefined; // `--base-url` is the server
  if (vars.some((name) => (process.env[name] ?? "").trim().length > 0)) return undefined;
  return { provider, message: provider === "openai-compat" ? "No server configured (REVCODE_BASE_URL)." : `No API key found for ${provider}.` };
}

async function verify(provider: LlmProvider, model: string, apiKey: string | undefined, baseUrl: string | undefined): Promise<string | undefined> {
  try {
    const client = createLlmClient({ provider, model, apiKey, baseUrl });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      await client.complete([{ role: "user", content: "Reply with the single word: ok" }], [], { signal: controller.signal, maxTokens: 16, thinking: "off" });
    } finally {
      clearTimeout(timer);
    }
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const explained = explainError(message, provider);
    return explained.headline;
  }
}

/** Run the interactive flow. Resolves true when something usable was saved. */
export async function runSetup(options: { reason?: string } = {}): Promise<boolean> {
  const isTty = Boolean(process.stdin.isTTY && process.stdout.isTTY) && process.env.TERM !== "dumb";
  if (!isTty) {
    process.stderr.write(
      "revcode setup needs an interactive terminal. Set the key yourself instead, for example:\n  export Z_AI_API_KEY=...   (or ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY)\n  or put it in ~/.revcode/.env\n",
    );
    return false;
  }
  const style = new Style(detectCaps(process.env, true));
  const ui = new TerminalUI({
    stdin: process.stdin,
    stdout: process.stdout,
    style,
    editor: new LineEditor(),
    status: () => ({ cwd: process.cwd(), mode: "ask", model: "", contextPercent: 0, extra: [] }),
    minimal: true,
  });
  ui.mount();
  const say = (text: string): void => ui.print(text);
  try {
    say("");
    say(`${style.gradient(`${style.glyphs.prompt} RevCode setup`)}`);
    if (options.reason) say(style.dim(`  ${options.reason}`));
    say("");

    const index = await ui.select({
      title: [style.bold("Which model provider do you want to use?")],
      options: CHOICES.map((c) => ({ label: c.label, hint: c.hint })),
      footer: "↑↓ to move · enter to select · esc to cancel",
    });
    if (index === undefined) {
      say(style.dim("  Setup cancelled."));
      return false;
    }
    const choice = CHOICES[index];
    const env: Record<string, string> = {};
    const config: Record<string, unknown> = { provider: choice.id };
    let model = choice.model;
    let baseUrl: string | undefined;
    let apiKey: string | undefined;

    if (choice.id === "openai-compat") {
      baseUrl = (await ui.prompt({ title: [style.bold("Server base URL"), style.dim("  e.g. http://localhost:8000/v1")] }))?.trim();
      if (!baseUrl) return cancelled(say, style);
      env.REVCODE_BASE_URL = baseUrl;
      config.baseUrl = baseUrl;
    }
    if (choice.envKey) {
      const key = await ui.prompt({
        title: [style.bold(`Paste your ${choice.label} API key`), style.dim(`  Get one at ${choice.site}. It is saved to ~/.revcode/.env (private to you).`)],
        secret: true,
        footer: "enter to continue · esc to cancel",
      });
      if (!key) return cancelled(say, style);
      apiKey = key.trim();
      env[choice.envKey] = apiKey;
    } else if (choice.id === "openai-compat") {
      const key = await ui.prompt({ title: [style.bold("API key (if the server needs one)"), style.dim("  Press Enter to skip.")], secret: true, optional: true });
      if (key?.trim()) {
        apiKey = key.trim();
        env.REVCODE_API_KEY = apiKey;
      }
    }
    if (!model) {
      const answer = await ui.prompt({
        title: [style.bold("Which model?"), style.dim(choice.id === "ollama" ? "  e.g. qwen2.5-coder, llama3.1" : choice.id === "openrouter" ? "  e.g. anthropic/claude-sonnet-4.5" : "  the model id your server exposes")],
      });
      model = answer?.trim();
      if (!model) return cancelled(say, style);
    }
    config.model = model;

    say(style.dim("  Checking that it works…"));
    const problem = await verify(choice.id, model, apiKey, baseUrl);
    if (problem) {
      say(`${style.paint("warn", style.glyphs.warn)} ${problem}`);
      const keep = await ui.select({
        title: [style.bold("The check failed. Save these settings anyway?")],
        options: [{ label: "Yes, save them" }, { label: "No, discard" }],
        cancelIndex: 1,
      });
      if (keep !== 0) return cancelled(say, style);
    } else {
      say(`${style.paint("ok", style.glyphs.check)} Connected to ${choice.label} (${model}).`);
    }

    if (Object.keys(env).length > 0) saveUserEnv(env);
    const configFile = saveUserConfig(config);
    say(`${style.paint("ok", style.glyphs.check)} Saved ${Object.keys(env).length > 0 ? `${userEnvFile()} and ` : ""}${configFile}`);
    say("");
    return true;
  } finally {
    ui.unmount();
  }
}

function cancelled(say: (text: string) => void, style: Style): false {
  say(style.dim("  Setup cancelled — nothing was saved."));
  return false;
}

export async function runSetupCommand(_args: CliArgs): Promise<number> {
  return (await runSetup()) ? 0 : 1;
}
