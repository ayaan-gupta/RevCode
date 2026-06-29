import { createRequire } from "node:module";
import figlet from "figlet";
import { applyHorizontalGradient } from "./ansi.js";
import { GRADIENT_END, GRADIENT_MID, GRADIENT_START } from "./theme.js";

const BANNER_FONT = "ANSI Shadow";

const nodeRequire = createRequire(__filename);
const gradientModule = nodeRequire("gradient-string") as {
  default: (colors: readonly string[]) => { multiline(text: string): string };
};

const REVCODE_GRADIENT = gradientModule.default([
  rgbToHex(GRADIENT_START),
  rgbToHex(GRADIENT_MID),
  rgbToHex(GRADIENT_END),
]);

function rgbToHex([r, g, b]: readonly [number, number, number]): string {
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function normalizeBannerLines(lines: string[]): string[] {
  const trimmed = [...lines];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1]?.trim() === "") {
    trimmed.pop();
  }

  const width = Math.max(...trimmed.map((line) => line.length), 1);
  return trimmed.map((line) => line.padEnd(width, " "));
}

/** Raw banner lines without color. */
export function getBannerLines(): string[] {
  const raw = figlet.textSync("> REVCODE", { font: BANNER_FONT });
  return normalizeBannerLines(raw.split("\n"));
}

/** Banner lines with cyan → purple → pink gradient applied. */
export function renderBanner(rich: boolean): string[] {
  const lines = getBannerLines();
  if (!rich) {
    return lines;
  }

  const gradientLines = REVCODE_GRADIENT.multiline(lines.join("\n")).split("\n");
  if (gradientLines.length === lines.length) {
    return gradientLines;
  }

  return lines.map((line) =>
    applyHorizontalGradient(line, GRADIENT_START, GRADIENT_MID, GRADIENT_END, rich),
  );
}

export function getBannerWidth(): number {
  const lines = getBannerLines();
  return Math.max(...lines.map((line) => line.length));
}
