import type { Rgb } from "./theme.js";

const ESC = "\u001b";

export function reset(): string {
  return `${ESC}[0m`;
}

export function bold(text: string): string {
  return `${ESC}[1m${text}${reset()}`;
}

export function dim(text: string): string {
  return `${ESC}[2m${text}${reset()}`;
}

export function rgb([r, g, b]: Rgb, text: string): string {
  return `${ESC}[38;2;${r};${g};${b}m${text}${reset()}`;
}

export function supportsColor(isTty: boolean): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
    return false;
  }

  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0") {
    return true;
  }

  return isTty;
}

function lerpChannel(start: number, end: number, t: number): number {
  return Math.round(start + (end - start) * t);
}

function interpolateRgb(start: Rgb, end: Rgb, t: number): Rgb {
  return [
    lerpChannel(start[0], end[0], t),
    lerpChannel(start[1], end[1], t),
    lerpChannel(start[2], end[2], t),
  ];
}

function colorAtPosition(position: number, width: number, start: Rgb, mid: Rgb, end: Rgb): Rgb {
  if (width <= 1) {
    return start;
  }

  const t = position / (width - 1);
  if (t <= 0.5) {
    return interpolateRgb(start, mid, t / 0.5);
  }

  return interpolateRgb(mid, end, (t - 0.5) / 0.5);
}

/**
 * Apply a horizontal three-stop gradient across visible (non-space) characters.
 * Spaces are left uncolored to preserve letter spacing.
 */
export function applyHorizontalGradient(
  line: string,
  start: Rgb,
  mid: Rgb,
  end: Rgb,
  rich: boolean,
): string {
  if (!rich) {
    return line;
  }

  const visibleIndices: number[] = [];
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== " ") {
      visibleIndices.push(index);
    }
  }

  if (visibleIndices.length === 0) {
    return line;
  }

  const width = visibleIndices.length;
  const parts: string[] = [];
  let cursor = 0;

  for (let visibleIndex = 0; visibleIndex < visibleIndices.length; visibleIndex += 1) {
    const charIndex = visibleIndices[visibleIndex];
    if (charIndex > cursor) {
      parts.push(line.slice(cursor, charIndex));
    }

    const color = colorAtPosition(visibleIndex, width, start, mid, end);
    parts.push(rgb(color, line[charIndex]));
    cursor = charIndex + 1;
  }

  if (cursor < line.length) {
    parts.push(line.slice(cursor));
  }

  return parts.join("");
}

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}
