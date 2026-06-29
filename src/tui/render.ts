import type { CliArgs } from "../cli.js";
import { dim, rgb, supportsColor } from "./ansi.js";
import { getBannerWidth, renderBanner } from "./banner.js";
import type { SlashCommand } from "./slash-commands.js";
import { ThinkingSpinner, type SpinnerHandle } from "./spinner.js";
import {
  COLOR_CYAN,
  COLOR_PINK,
  COLOR_PURPLE,
} from "./theme.js";

export interface RenderContext {
  args: CliArgs;
  rich: boolean;
}

const TIPS = [
  "Ask questions, edit files, or run commands.",
  "Be specific for the best results.",
  "Type /help for commands.",
] as const;

const INPUT_HINT = "Type your message or @path/to/file";
const CHEVRON = ">";

export class TerminalRenderer {
  private args: CliArgs;
  private readonly rich: boolean;
  private inputFrameLines = 3;
  private slashMenuLineCount = 0;
  private hasInputFrame = false;
  private hasStatusBar = false;
  private lastInputCursorColumn = 1;

  constructor(args: CliArgs, isTty: boolean) {
    this.args = args;
    this.rich = supportsColor(isTty);
  }

  getContext(): RenderContext {
    return { args: this.args, rich: this.rich };
  }

  isRich(): boolean {
    return this.rich;
  }

  updateModel(model: string): void {
    this.args = { ...this.args, model };
  }

  welcome(): void {
    console.log("");

    for (const line of renderBanner(this.rich)) {
      console.log(line);
    }

    console.log("");
    console.log(this.rich ? dim("Tips for getting started:") : "Tips for getting started:");

    TIPS.forEach((tip, index) => {
      const label = `${index + 1}. ${tip}`;
      console.log(this.rich ? dim(label) : label);
    });

    console.log("");
    console.log(this.formatContextLine());
    console.log("");
  }

  drawInputBox(
    text: string,
    cursor: number,
    placeholder = INPUT_HINT,
    slashMenu?: SlashCommand[],
  ): void {
    const width = this.frameWidth();
    const menuLines =
      slashMenu && slashMenu.length > 0 ? this.formatSlashMenu(slashMenu, width) : [];
    const top = this.horizontalRule(width);
    const { line: content, cursorColumn } = this.formatInputLine(text, cursor, placeholder, width);
    const bottom = this.horizontalRule(width);

    if (this.rich && this.hasInputFrame) {
      hideCursor();
      this.moveCursorBelowInputArea();
      const linesToClear = this.getTotalInputAreaLines();
      readlineMoveUp(linesToClear);
      clearLines(linesToClear);
    }

    for (const menuLine of menuLines) {
      process.stdout.write(`${menuLine}\n`);
    }

    process.stdout.write(`${top}\n${content}\n${bottom}\n`);
    this.inputFrameLines = 3;
    this.slashMenuLineCount = menuLines.length;
    this.hasInputFrame = true;
    this.lastInputCursorColumn = cursorColumn;
  }

  clearInputArea(): void {
    if (!this.rich || !this.hasInputFrame) {
      return;
    }

    hideCursor();
    this.moveCursorBelowInputArea();
    const linesToClear = this.getTotalInputAreaLines();
    readlineMoveUp(linesToClear);
    clearLines(linesToClear);
    showCursor();
    this.inputFrameLines = 0;
    this.slashMenuLineCount = 0;
    this.hasInputFrame = false;
    this.hasStatusBar = false;
  }

  renderStatusBar(): void {
    const cwd = shortenPath(this.args.cwd);
    const provider = this.args.provider ?? "auto";
    const modelLabel = `${this.args.model} (${provider})`;

    if (!this.rich) {
      process.stdout.write(`${cwd}  interactive  ${modelLabel}\n`);
      this.hasStatusBar = true;
      return;
    }

    const columns = process.stdout.columns ?? 80;
    const left = rgb(COLOR_CYAN, cwd);
    const center = rgb(COLOR_PINK, "interactive");
    const right = rgb(COLOR_PURPLE, modelLabel);
    const gap = "  ";
    const content = `${left}${gap}${center}${gap}${right}`;
    const padding = Math.max(0, columns - stripVisibleLength(content));
    process.stdout.write(`${content}${" ".repeat(padding)}\n`);
    this.hasStatusBar = true;
    this.positionInputCursor();
  }

  beginTurn(userMessage: string): void {
    console.log(this.rich ? dim(`You: ${userMessage}`) : `You: ${userMessage}`);
  }

  startThinking(): SpinnerHandle {
    const spinner = new ThinkingSpinner(this.rich);
    console.log("");
    return spinner.start();
  }

  toolCall(name: string, args: Record<string, unknown>): void {
    const line = `  ${name}(${JSON.stringify(args)})`;
    console.log(this.rich ? dim(line) : line);
  }

  assistant(text: string): void {
    console.log(`\n${text}\n`);
  }

  info(text: string): void {
    console.log(text);
  }

  error(text: string): void {
    console.log(this.rich ? dim(text) : text);
  }

  goodbye(): void {
    console.log(this.rich ? `\n${dim("Bye!")}` : "\nBye!");
  }

  private formatContextLine(): string {
    const provider = this.args.provider ?? "auto";
    const line = `Using: ${provider} · ${this.args.model} · ${this.args.cwd}`;
    return this.rich ? dim(line) : line;
  }

  private formatSlashMenu(commands: SlashCommand[], width: number): string[] {
    return commands.map(({ command, description }) => {
      const commandText = this.rich ? rgb(COLOR_CYAN, command) : command;
      const descriptionText = this.rich ? dim(description) : description;
      const line = `  ${commandText}  ${descriptionText}`;
      const padding = Math.max(0, width - stripVisibleLength(line));
      return `${line}${" ".repeat(padding)}`;
    });
  }

  private formatInputLine(
    text: string,
    cursor: number,
    placeholder: string,
    width: number,
  ): { line: string; cursorColumn: number } {
    const chevron = this.rich ? rgb(COLOR_PINK, CHEVRON) : CHEVRON;
    const prefix = `${chevron} `;
    const prefixVisible = 2;
    const maxTextWidth = Math.max(10, width - prefixVisible - 1);

    let displayText = text;
    let displayCursor = cursor;

    if (displayText.length > maxTextWidth) {
      const start = Math.max(
        0,
        Math.min(displayCursor - maxTextWidth + 1, displayText.length - maxTextWidth),
      );
      displayText = displayText.slice(start, start + maxTextWidth);
      displayCursor = cursor - start;
    }

    let content: string;
    if (displayText.length === 0 && text.length === 0) {
      content = this.rich ? dim(placeholder) : placeholder;
    } else {
      content = displayText;
    }

    const cursorColumn = prefixVisible + displayCursor + 1;
    return { line: `${prefix}${content}`, cursorColumn };
  }

  private horizontalRule(width?: number): string {
    const ruleWidth = width ?? this.frameWidth();
    const rule = "─".repeat(Math.max(ruleWidth, 40));
    return this.rich ? rgb(COLOR_CYAN, rule) : rule;
  }

  private frameWidth(): number {
    const columns = process.stdout.columns ?? 80;
    return Math.min(columns, Math.max(getBannerWidth() + 8, 40));
  }

  private getTotalInputAreaLines(): number {
    return this.inputFrameLines + this.slashMenuLineCount + (this.hasStatusBar ? 1 : 0);
  }

  /** Move from the input content row to the line below the status bar before redraw/clear. */
  private moveCursorBelowInputArea(): void {
    const linesDown = this.hasStatusBar ? 3 : 2;
    process.stdout.write(`\x1b[${linesDown}B`);
  }

  private positionInputCursor(): void {
    if (!this.rich || !this.hasInputFrame) {
      return;
    }

    const linesUp = 3;
    process.stdout.write(`\x1b[${linesUp}A\x1b[${this.lastInputCursorColumn}G`);
    showCursor();
  }
}

function shortenPath(cwd: string): string {
  const home = process.env.HOME;
  if (home && cwd.startsWith(home)) {
    return `~${cwd.slice(home.length)}`;
  }

  return cwd;
}

function stripVisibleLength(text: string): number {
  let length = 0;
  let index = 0;

  while (index < text.length) {
    if (text[index] === "\u001b") {
      const end = text.indexOf("m", index);
      index = end === -1 ? text.length : end + 1;
      continue;
    }

    length += 1;
    index += 1;
  }

  return length;
}

function hideCursor(): void {
  process.stdout.write("\x1b[?25l");
}

function showCursor(): void {
  process.stdout.write("\x1b[?25h");
}

function readlineMoveUp(lines: number): void {
  if (lines <= 0) {
    return;
  }

  process.stdout.write(`\x1b[${lines}A`);
}

function clearLines(lines: number): void {
  for (let index = 0; index < lines; index += 1) {
    process.stdout.write("\x1b[2K\r");
    if (index < lines - 1) {
      process.stdout.write("\x1b[1B");
    }
  }

  readlineMoveUp(lines - 1);
}
