/**
 * Terminal mode management: raw input, bracketed paste, focus reporting and the kitty
 * keyboard protocol (which is what lets Shift+Enter insert a newline). Everything is undone
 * on exit — including from a synchronous `exit` handler — so a crash never leaves the user's
 * shell in raw mode.
 */

const ENABLE = "\u001b[?2004h\u001b[?1004h\u001b[>1u";
const DISABLE = "\u001b[<u\u001b[?1004l\u001b[?2004l\u001b[?25h";

export interface TermStreams {
  stdin: NodeJS.ReadStream;
  stdout: { write(data: string): unknown };
}

export class TerminalModes {
  private active = false;
  private wasRaw = false;
  private readonly onExit = (): void => this.leave();

  constructor(private readonly io: TermStreams) {}

  get entered(): boolean {
    return this.active;
  }

  enter(): void {
    if (this.active) return;
    this.active = true;
    const { stdin } = this.io;
    this.wasRaw = Boolean(stdin.isRaw);
    stdin.setRawMode?.(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    this.io.stdout.write(ENABLE);
    process.once("exit", this.onExit);
  }

  leave(): void {
    if (!this.active) return;
    this.active = false;
    process.removeListener("exit", this.onExit);
    try {
      this.io.stdout.write(DISABLE);
    } catch {
      // the terminal may already be gone
    }
    const { stdin } = this.io;
    try {
      stdin.setRawMode?.(this.wasRaw);
      stdin.pause();
    } catch {
      // ignore
    }
  }
}

/** Set the window/tab title (no-op when the terminal cannot show one). */
export function titleSequence(title: string): string {
  // Strip control characters so a hostile path or model name cannot inject escape sequences.
  const safe = title.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 120);
  return `\u001b]0;${safe}\u0007`;
}
