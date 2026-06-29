export interface SlashCommand {
  command: string;
  description: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { command: "/help", description: "Show available commands" },
  { command: "/memory", description: "Show message history sent to the LLM" },
  { command: "/tools", description: "Show tool JSON schemas" },
  { command: "/clear", description: "Reset conversation to system prompt only" },
  { command: "/model", description: "Show or switch the active model" },
  { command: "/exit", description: "Quit" },
] as const;

/** Returns matching slash commands while the user is typing a command prefix. */
export function getSlashMenuCommands(buffer: string): SlashCommand[] | undefined {
  if (!buffer.startsWith("/")) {
    return undefined;
  }

  if (buffer.includes(" ")) {
    return undefined;
  }

  const matches = SLASH_COMMANDS.filter((entry) => entry.command.startsWith(buffer));
  return matches.length > 0 ? [...matches] : undefined;
}
