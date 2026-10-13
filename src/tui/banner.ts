import figlet from "figlet";
import { applyHorizontalGradient } from "./ansi.js";
import { ANSI_SHADOW_FLF } from "./ansi-shadow-font.js";
import { GRADIENT_END, GRADIENT_MID, GRADIENT_START } from "./theme.js";

const BANNER_FONT = "ANSI Shadow";

// Registered from memory: figlet's own font loader reads files relative to its
// install directory, which does not exist inside the single-file bundle.
figlet.parseFont(BANNER_FONT, ANSI_SHADOW_FLF);

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

  return lines.map((line) =>
    applyHorizontalGradient(line, GRADIENT_START, GRADIENT_MID, GRADIENT_END, rich),
  );
}

export function getBannerWidth(): number {
  const lines = getBannerLines();
  return Math.max(...lines.map((line) => line.length));
}
