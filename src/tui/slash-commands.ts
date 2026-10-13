export interface SlashCommand {
  command: string;
  description: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { command: "/help", description: "Show available commands" },
  { command: "/model", description: "Show or switch the active model" },
  { command: "/mode", description: "Show or set permission mode (ask, accept-edits, plan, yolo)" },
  { command: "/plan", description: "Toggle read-only plan mode" },
  { command: "/tokens", description: "Show estimated context usage" },
  { command: "/compact", description: "Summarize old tool output to reclaim context" },
  { command: "/clear", description: "Reset conversation to system prompt only" },
  { command: "/sessions", description: "List saved sessions (resume with revcode -r <id>)" },
  { command: "/tools", description: "Show tool JSON schemas" },
  { command: "/memory", description: "Show message history sent to the LLM" },
  { command: "/profile", description: "Show the active harness profile" },
  { command: "/diff", description: "Universe: show the changeset vs. your project" },
  { command: "/land", description: "Universe: apply the changeset to your project" },
  { command: "/checkpoints", description: "Universe: list recorded checkpoints" },
  { command: "/rewind", description: "Universe: rewind files and conversation to a checkpoint" },
  { command: "/fork", description: "Universe: branch a sibling universe from here" },
  { command: "/universes", description: "Universe: list universes for this project" },
  { command: "/discard", description: "Universe: throw this universe away" },
  { command: "/receipt", description: "Show the receipt for the last turn" },
  { command: "/exit", description: "Quit" },
] as const;

/** Commands discovered at startup (custom commands, skills). */
let dynamicCommands: SlashCommand[] = [];

export function registerSlashCommands(commands: SlashCommand[]): void {
  dynamicCommands = commands;
}

/** Returns matching slash commands while the user is typing a command prefix. */
export function getSlashMenuCommands(buffer: string): SlashCommand[] | undefined {
  if (!buffer.startsWith("/")) {
    return undefined;
  }

  if (buffer.includes(" ")) {
    return undefined;
  }

  const all = [...SLASH_COMMANDS, ...dynamicCommands];
  const matches = all.filter((entry) => entry.command.startsWith(buffer));
  return matches.length > 0 ? matches.slice(0, 12) : undefined;
}
