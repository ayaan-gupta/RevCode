/**
 * Terminal UI rendering.
 *
 * TODO: implement using Ink (React for CLI) or blessed/tty primitives.
 *       Should support markdown rendering, streaming text, syntax highlighting,
 *       and an interactive input prompt.
 */

export class TerminalRenderer {
  welcome(): void {
    console.log("RevCode — AI coding agent for the terminal");
    console.log("Type your request or /help for commands.\n");
  }

  goodbye(): void {
    console.log("\nBye!");
  }
}
