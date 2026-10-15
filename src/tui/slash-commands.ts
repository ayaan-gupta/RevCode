/**
 * The built-in slash commands, with the metadata the prompt needs: what each takes and which
 * values to offer after it. Custom commands and skills are appended at runtime.
 */

import type { SlashCommandInfo } from "./completion.js";

export type SlashCommand = SlashCommandInfo;

export interface SlashCommandSources {
  /** Possible values for `/model`. */
  models: () => string[];
  /** Possible values for `/mode`. */
  modes: () => string[];
  /** Recent session ids for `/resume`. */
  sessions: () => string[];
}

export function builtinSlashCommands(sources: SlashCommandSources): SlashCommand[] {
  return [
    { command: "/help", description: "Show commands and keyboard shortcuts" },
    { command: "/status", description: "Show model, mode, session, and what is loaded" },
    { command: "/model", description: "Show or switch the model", args: "[name]", values: sources.models },
    { command: "/mode", description: "Show or set the permission mode", args: "[mode]", values: sources.modes },
    { command: "/plan", description: "Toggle read-only plan mode" },
    { command: "/clear", description: "Clear the conversation and the screen" },
    { command: "/compact", description: "Free up context by trimming old tool output" },
    { command: "/context", description: "Show how much context is in use" },
    { command: "/cost", description: "Show token usage for this session" },
    { command: "/resume", description: "Resume an earlier session", args: "[id]", values: sources.sessions },
    { command: "/sessions", description: "List saved sessions for this directory" },
    { command: "/init", description: "Create or improve AGENTS.md for this project" },
    { command: "/review", description: "Review the uncommitted changes" },
    { command: "/copy", description: "Copy the last response to the clipboard" },
    { command: "/export", description: "Save the conversation as Markdown", args: "[file]" },
    { command: "/verbose", description: "Toggle detailed tool output (Ctrl+O)" },
    { command: "/vim", description: "Toggle Vim-style editing in the prompt" },
    { command: "/theme", description: "Switch between dark and light colors", args: "[auto|dark|light]", values: () => ["auto", "dark", "light"] },
    { command: "/permissions", description: "Show or add permission rules", args: "[allow|deny <rule>]", values: () => ["allow", "deny"] },
    { command: "/mcp", description: "Show MCP servers and their tools" },
    { command: "/skills", description: "List available skills" },
    { command: "/hooks", description: "Show configured hooks" },
    { command: "/memory", description: "Show the project instructions that are loaded" },
    { command: "/tools", description: "List the tools the model can call", args: "[json]", values: () => ["json"] },
    { command: "/profile", description: "Show the active harness profile" },
    { command: "/doctor", description: "Check your setup and terminal" },
    { command: "/diff", description: "Universe: show the changeset vs. your project", args: "[full]", values: () => ["full"] },
    { command: "/land", description: "Universe: apply the changeset to your project", args: "[paths]" },
    { command: "/checkpoints", description: "Universe: list recorded checkpoints" },
    { command: "/rewind", description: "Universe: rewind files and conversation", args: "<number>" },
    { command: "/fork", description: "Universe: branch a sibling universe from here", args: "[number]" },
    { command: "/universes", description: "Universe: list universes for this project" },
    { command: "/discard", description: "Universe: throw this universe away" },
    { command: "/receipt", description: "Show the receipt for the last turn" },
    { command: "/messages", description: "Dump the raw message history (debugging)" },
    { command: "/exit", description: "Quit" },
  ];
}

/** Names handled by the app itself (so custom commands never shadow them). */
export function builtinNames(commands: readonly SlashCommand[]): Set<string> {
  return new Set([...commands.map((c) => c.command), "/quit"]);
}
