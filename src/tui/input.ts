import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline";
import { createInterface as createPromiseInterface } from "node:readline/promises";
import type { TerminalRenderer } from "./render.js";
import { getSlashMenuCommands } from "./slash-commands.js";

export interface BoxedInputOptions {
  renderer: TerminalRenderer;
  placeholder?: string;
}

export function insertChar(buffer: string, index: number, char: string): string {
  return `${buffer.slice(0, index)}${char}${buffer.slice(index)}`;
}

export function deleteCharBefore(buffer: string, index: number): { buffer: string; index: number } {
  if (index <= 0) {
    return { buffer, index: 0 };
  }

  return {
    buffer: `${buffer.slice(0, index - 1)}${buffer.slice(index)}`,
    index: index - 1,
  };
}

export function deleteCharAt(buffer: string, index: number): { buffer: string; index: number } {
  if (index >= buffer.length) {
    return { buffer, index };
  }

  return {
    buffer: `${buffer.slice(0, index)}${buffer.slice(index + 1)}`,
    index,
  };
}

export async function readBoxedInput(options: BoxedInputOptions): Promise<string | null> {
  const { renderer, placeholder = "Type your message or @path/to/file" } = options;

  if (!input.isTTY || !renderer.isRich()) {
    return readPlainLine();
  }

  readline.emitKeypressEvents(input);

  const wasRaw = input.isRaw;
  input.setRawMode?.(true);
  input.resume();

  let buffer = "";
  let cursor = 0;
  let finished = false;

  const render = (): void => {
    renderer.drawInputBox(buffer, cursor, placeholder, getSlashMenuCommands(buffer));
    renderer.renderStatusBar();
  };

  render();

  return new Promise((resolve) => {
    const onResize = (): void => {
      if (!finished) {
        render();
      }
    };

    const cleanup = (): void => {
      input.removeListener("keypress", onKeypress);
      output.removeListener("resize", onResize);
      input.setRawMode?.(wasRaw ?? false);
    };

    const finish = (value: string | null): void => {
      if (finished) {
        return;
      }

      finished = true;
      cleanup();
      renderer.clearInputArea();
      resolve(value);
    };

    const onKeypress = (char: string | undefined, key: readline.Key): void => {
      if (key.ctrl && key.name === "c") {
        finish(null);
        return;
      }

      if (key.name === "return") {
        if (buffer.trim().length > 0) {
          finish(buffer);
        }
        return;
      }

      if (key.name === "escape") {
        buffer = "";
        cursor = 0;
        render();
        return;
      }

      // Clear the whole line (Ctrl+U).
      if (key.ctrl && key.name === "u") {
        buffer = "";
        cursor = 0;
        render();
        return;
      }

      // Jump to start / end of line (Home/End and Ctrl+A/Ctrl+E).
      if (key.name === "home" || (key.ctrl && key.name === "a")) {
        cursor = 0;
        render();
        return;
      }

      if (key.name === "end" || (key.ctrl && key.name === "e")) {
        cursor = buffer.length;
        render();
        return;
      }

      if (key.name === "backspace") {
        const next = deleteCharBefore(buffer, cursor);
        buffer = next.buffer;
        cursor = next.index;
        render();
        return;
      }

      if (key.name === "delete") {
        const next = deleteCharAt(buffer, cursor);
        buffer = next.buffer;
        cursor = next.index;
        render();
        return;
      }

      if (key.name === "left") {
        cursor = Math.max(0, cursor - 1);
        render();
        return;
      }

      if (key.name === "right") {
        cursor = Math.min(buffer.length, cursor + 1);
        render();
        return;
      }

      if (char && !key.ctrl && !key.meta) {
        buffer = insertChar(buffer, cursor, char);
        cursor += 1;
        render();
      }
    };

    input.on("keypress", onKeypress);
    output.on("resize", onResize);
  });
}

async function readPlainLine(): Promise<string | null> {
  const rl = createPromiseInterface({ input, output });
  try {
    return await rl.question("> ");
  } finally {
    rl.close();
  }
}
