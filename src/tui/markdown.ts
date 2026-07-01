/**
 * Minimal, dependency-free Markdown → ANSI renderer.
 *
 * It renders one complete line at a time, tracking fenced-code-block state, so
 * the same code path works both for one-shot rendering and for streaming
 * (feed deltas, emit completed lines as they arrive).
 */

import { bold, dim, rgb } from "./ansi.js";
import { COLOR_CYAN, COLOR_MUTED, COLOR_PINK, COLOR_PURPLE, COLOR_WHITE } from "./theme.js";

export class MarkdownStream {
  private readonly rich: boolean;
  private buffer = "";
  private inFence = false;

  constructor(rich: boolean) {
    this.rich = rich;
  }

  /** Feed a chunk; returns any fully-completed, rendered lines (with trailing \n). */
  push(chunk: string): string {
    this.buffer += chunk;
    let out = "";
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      out += `${this.renderLine(line)}\n`;
      this.buffer = this.buffer.slice(newlineIndex + 1);
      newlineIndex = this.buffer.indexOf("\n");
    }
    return out;
  }

  /** Render any remaining buffered text (no trailing newline). */
  flush(): string {
    if (this.buffer.length === 0) {
      return "";
    }
    const rendered = this.renderLine(this.buffer);
    this.buffer = "";
    return rendered;
  }

  private renderLine(line: string): string {
    const fence = line.trimStart().startsWith("```");
    if (fence) {
      this.inFence = !this.inFence;
      return this.rich ? dim("─".repeat(Math.min(40, Math.max(3, line.length)))) : line;
    }
    if (this.inFence) {
      return this.rich ? rgb(COLOR_CYAN, line) : line;
    }
    return this.renderProse(line);
  }

  private renderProse(line: string): string {
    if (!this.rich) {
      return line;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      return bold(rgb(COLOR_PURPLE, heading[2]));
    }

    if (/^\s*>\s?/.test(line)) {
      return dim(line.replace(/^(\s*)>\s?/, "$1▏ "));
    }

    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      return `${bullet[1]}${rgb(COLOR_PINK, "•")} ${this.renderInline(bullet[2])}`;
    }

    return this.renderInline(line);
  }

  /** Inline spans: `code`, **bold**, *italic*. */
  private renderInline(text: string): string {
    let out = text;
    out = out.replace(/`([^`]+)`/g, (_, code: string) => rgb(COLOR_CYAN, code));
    out = out.replace(/\*\*([^*]+)\*\*/g, (_, b: string) => bold(b));
    out = out.replace(/(^|[^*])\*([^*]+)\*/g, (_, pre: string, i: string) => `${pre}${dim(i)}`);
    return rgb(COLOR_WHITE, out);
  }
}

/** One-shot convenience: render a whole markdown string to ANSI. */
export function renderMarkdown(text: string, rich: boolean): string {
  const stream = new MarkdownStream(rich);
  return stream.push(text) + stream.flush();
}

/** Exported for callers that want the muted color for secondary text. */
export const MUTED = COLOR_MUTED;
