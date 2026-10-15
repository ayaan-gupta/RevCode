/**
 * Terminal capabilities and styling.
 *
 * `detectCaps` decides what the terminal can do (color depth, unicode, hyperlinks,
 * light/dark background). `Style` paints text with semantic roles and downgrades
 * truecolor to 256/16 colors — or to nothing — so output is readable everywhere,
 * including macOS Terminal.app (no truecolor), `NO_COLOR`, and light themes.
 *
 * Styles close with targeted "off" codes (22/23/24/39/49) rather than a full reset,
 * so they nest: bold inside a colored span keeps the color.
 */

export type ColorDepth = 0 | 4 | 8 | 24;
export type ThemeName = "dark" | "light";
export type Rgb = readonly [number, number, number];

export interface TermCaps {
  colorDepth: ColorDepth;
  theme: ThemeName;
  unicode: boolean;
  hyperlinks: boolean;
}

export type Env = Readonly<Record<string, string | undefined>>;

export function detectColorDepth(env: Env, isTty: boolean): ColorDepth {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return 0;
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === "0" || force === "false") return 0;
    if (force === "2") return 8;
    if (force === "3") return 24;
    if (force === "1" || force === "true" || force === "") {
      // Honour the strongest signal we have, but never less than 16 colors.
      const detected = detectTerminalDepth(env);
      return detected === 0 ? 4 : detected;
    }
  }
  if (!isTty) return 0;
  return detectTerminalDepth(env);
}

function detectTerminalDepth(env: Env): ColorDepth {
  const term = env.TERM ?? "";
  if (term === "dumb") return 0;
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return 24;
  if (env.WT_SESSION || env.KITTY_WINDOW_ID || env.WEZTERM_EXECUTABLE) return 24;
  switch (env.TERM_PROGRAM) {
    case "iTerm.app":
    case "vscode":
    case "WezTerm":
    case "ghostty":
    case "Hyper":
      return 24;
    case "Apple_Terminal":
      return 8;
  }
  if (/^(xterm-kitty|xterm-ghostty|alacritty|foot|wezterm|contour)/.test(term)) return 24;
  if (/-256color$|256color/.test(term)) return 8;
  if (/xterm|screen|tmux|vt100|vt220|linux|ansi|cygwin|rxvt|color/.test(term)) return 4;
  return 4;
}

export function detectUnicode(env: Env): boolean {
  if (env.REVCODE_ASCII === "1") return false;
  const term = env.TERM ?? "";
  if (term === "linux" || term === "dumb") return false;
  return true;
}

export function detectTheme(env: Env, override?: string): ThemeName {
  const wanted = (env.REVCODE_THEME ?? override ?? "").toLowerCase();
  if (wanted === "light" || wanted === "dark") return wanted;
  // COLORFGBG is "fg;bg" (sometimes "fg;default;bg"); the last field is the background index.
  const fgbg = env.COLORFGBG;
  if (fgbg) {
    const bg = Number.parseInt(fgbg.split(";").at(-1) ?? "", 10);
    if (Number.isInteger(bg)) return bg === 7 || (bg >= 9 && bg <= 15) ? "light" : "dark";
  }
  return "dark";
}

export function detectHyperlinks(env: Env, isTty: boolean): boolean {
  if (env.REVCODE_HYPERLINKS === "0") return false;
  if (env.REVCODE_HYPERLINKS === "1") return true;
  if (!isTty || env.TERM === "dumb") return false;
  if (env.TERM_PROGRAM && ["iTerm.app", "WezTerm", "vscode", "ghostty", "Hyper"].includes(env.TERM_PROGRAM)) return true;
  if (env.WT_SESSION || env.KITTY_WINDOW_ID || env.WEZTERM_EXECUTABLE) return true;
  const vte = Number.parseInt(env.VTE_VERSION ?? "", 10);
  return Number.isFinite(vte) && vte >= 5000;
}

export function detectCaps(env: Env, isTty: boolean, themeOverride?: string): TermCaps {
  return {
    colorDepth: detectColorDepth(env, isTty),
    theme: detectTheme(env, themeOverride),
    unicode: detectUnicode(env),
    hyperlinks: detectHyperlinks(env, isTty),
  };
}

// --- color conversion ------------------------------------------------------------

const ANSI16: ReadonlyArray<Rgb> = [
  [0, 0, 0],
  [205, 49, 49],
  [13, 188, 121],
  [229, 229, 16],
  [36, 114, 200],
  [188, 63, 188],
  [17, 168, 205],
  [229, 229, 229],
  [102, 102, 102],
  [241, 76, 76],
  [35, 209, 139],
  [245, 245, 67],
  [59, 142, 234],
  [214, 112, 214],
  [41, 184, 219],
  [255, 255, 255],
];

function distance(a: Rgb, b: Rgb): number {
  // Weighted toward green, as the eye is; good enough for a palette downgrade.
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
}

export function rgbTo256(color: Rgb): number {
  const level = (v: number): number => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  const steps = [0, 95, 135, 175, 215, 255];
  const [r, g, b] = color;
  const cr = level(r);
  const cg = level(g);
  const cb = level(b);
  const cube: Rgb = [steps[cr], steps[cg], steps[cb]];
  const gray = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
  const grayValue = 8 + gray * 10;
  const grayRgb: Rgb = [grayValue, grayValue, grayValue];
  return distance(color, grayRgb) < distance(color, cube) ? 232 + gray : 16 + 36 * cr + 6 * cg + cb;
}

export function rgbTo16(color: Rgb): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  ANSI16.forEach((candidate, index) => {
    const d = distance(color, candidate);
    if (d < bestDistance) {
      bestDistance = d;
      best = index;
    }
  });
  return best;
}

function fgParams(color: Rgb, depth: ColorDepth): string {
  if (depth >= 24) return `38;2;${color[0]};${color[1]};${color[2]}`;
  if (depth >= 8) return `38;5;${rgbTo256(color)}`;
  const index = rgbTo16(color);
  return String(index < 8 ? 30 + index : 90 + (index - 8));
}

function bgParams(color: Rgb, depth: ColorDepth): string {
  if (depth >= 24) return `48;2;${color[0]};${color[1]};${color[2]}`;
  if (depth >= 8) return `48;5;${rgbTo256(color)}`;
  const index = rgbTo16(color);
  return String(index < 8 ? 40 + index : 100 + (index - 8));
}

// --- palette ---------------------------------------------------------------------

export type Role =
  | "accent"
  | "prompt"
  | "heading"
  | "ok"
  | "warn"
  | "error"
  | "code"
  | "link"
  | "muted"
  | "diffAdd"
  | "diffDel"
  | "user";

type Palette = Record<Role, Rgb> & { diffAddBg: Rgb; diffDelBg: Rgb; gradient: readonly [Rgb, Rgb, Rgb] };

const DARK: Palette = {
  accent: [56, 189, 248],
  prompt: [244, 114, 182],
  heading: [192, 132, 252],
  ok: [74, 222, 128],
  warn: [251, 191, 36],
  error: [248, 113, 113],
  code: [125, 211, 252],
  link: [96, 165, 250],
  muted: [148, 163, 184],
  diffAdd: [134, 239, 172],
  diffDel: [252, 165, 165],
  user: [226, 232, 240],
  diffAddBg: [22, 62, 38],
  diffDelBg: [78, 28, 38],
  gradient: [
    [103, 232, 249],
    [167, 139, 250],
    [244, 114, 182],
  ],
};

const LIGHT: Palette = {
  accent: [2, 132, 199],
  prompt: [219, 39, 119],
  heading: [126, 34, 206],
  ok: [22, 163, 74],
  warn: [180, 83, 9],
  error: [220, 38, 38],
  code: [3, 105, 161],
  link: [29, 78, 216],
  muted: [100, 116, 139],
  diffAdd: [21, 128, 61],
  diffDel: [185, 28, 28],
  user: [15, 23, 42],
  diffAddBg: [220, 252, 231],
  diffDelBg: [254, 226, 226],
  gradient: [
    [14, 165, 233],
    [124, 58, 237],
    [219, 39, 119],
  ],
};

export interface Glyphs {
  bullet: string;
  prompt: string;
  result: string;
  ellipsis: string;
  check: string;
  cross: string;
  warn: string;
  up: string;
  down: string;
  minus: string;
  dot: string;
  rule: string;
  list: string;
  quote: string;
  pointer: string;
  running: string;
  queued: string;
  spinner: readonly string[];
  corner: readonly [string, string, string, string];
  /** Table / box drawing: corners, edges and junctions. */
  box: { tl: string; tr: string; bl: string; br: string; h: string; v: string; top: string; bottom: string; left: string; right: string; cross: string };
  checkbox: { on: string; off: string };
  bulletLevels: readonly string[];
}

const UNICODE_GLYPHS: Glyphs = {
  bullet: "●",
  prompt: "❯",
  result: "⎿",
  ellipsis: "…",
  check: "✔",
  cross: "✘",
  warn: "⚠",
  up: "↑",
  down: "↓",
  minus: "−",
  dot: "·",
  rule: "─",
  list: "•",
  quote: "▎",
  pointer: "❯",
  running: "◐",
  queued: "⏎",
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  corner: ["╭", "╮", "╰", "╯"],
  box: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", top: "┬", bottom: "┴", left: "├", right: "┤", cross: "┼" },
  checkbox: { on: "☑", off: "☐" },
  bulletLevels: ["•", "◦", "▪"],
};

const ASCII_GLYPHS: Glyphs = {
  bullet: "*",
  prompt: ">",
  result: "`-",
  ellipsis: "...",
  check: "+",
  cross: "x",
  warn: "!",
  up: "^",
  down: "v",
  minus: "-",
  dot: "-",
  rule: "-",
  list: "-",
  quote: "|",
  pointer: ">",
  running: "~",
  queued: ">>",
  spinner: ["|", "/", "-", "\\"],
  corner: ["+", "+", "+", "+"],
  box: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", top: "+", bottom: "+", left: "+", right: "+", cross: "+" },
  checkbox: { on: "[x]", off: "[ ]" },
  bulletLevels: ["-", "*", "+"],
};

export class Style {
  readonly depth: ColorDepth;
  readonly unicode: boolean;
  readonly hyperlinks: boolean;
  readonly glyphs: Glyphs;
  private palette: Palette;
  private themeName: ThemeName;

  constructor(caps: TermCaps) {
    this.depth = caps.colorDepth;
    this.themeName = caps.theme;
    this.unicode = caps.unicode;
    this.hyperlinks = caps.hyperlinks;
    this.glyphs = caps.unicode ? UNICODE_GLYPHS : ASCII_GLYPHS;
    this.palette = caps.theme === "light" ? LIGHT : DARK;
  }

  get theme(): ThemeName {
    return this.themeName;
  }

  /** Switch palettes (the `/theme` command); everything painted afterwards uses the new one. */
  setTheme(theme: ThemeName): void {
    this.themeName = theme;
    this.palette = theme === "light" ? LIGHT : DARK;
  }

  /** True when any styling will be emitted. */
  get color(): boolean {
    return this.depth > 0;
  }

  private wrap(on: string, off: string, text: string): string {
    return this.depth === 0 || text.length === 0 ? text : `\u001b[${on}m${text}\u001b[${off}m`;
  }

  bold(text: string): string {
    return this.wrap("1", "22", text);
  }

  dim(text: string): string {
    return this.wrap("2", "22", text);
  }

  italic(text: string): string {
    return this.wrap("3", "23", text);
  }

  underline(text: string): string {
    return this.wrap("4", "24", text);
  }

  strike(text: string): string {
    return this.wrap("9", "29", text);
  }

  inverse(text: string): string {
    return this.wrap("7", "27", text);
  }

  rgb(color: Rgb, text: string): string {
    return this.depth === 0 ? text : this.wrap(fgParams(color, this.depth), "39", text);
  }

  /** Foreground color for a semantic role. */
  paint(role: Role, text: string): string {
    return this.rgb(this.palette[role], text);
  }

  /** Text on a role's background color (used for diff line shading). */
  onBg(kind: "add" | "del", text: string): string {
    const color = kind === "add" ? this.palette.diffAddBg : this.palette.diffDelBg;
    if (this.depth < 8) return text; // 16 colors cannot do subtle shading
    return this.wrap(bgParams(color, this.depth), "49", text);
  }

  /** `bold` + a role color. */
  strong(role: Role, text: string): string {
    return this.bold(this.paint(role, text));
  }

  link(url: string, text: string): string {
    if (!this.hyperlinks) return text;
    return `\u001b]8;;${url}\u001b\\${text}\u001b]8;;\u001b\\`;
  }

  /** Horizontal three-stop gradient over the non-space characters of one line. */
  gradient(line: string): string {
    if (this.depth === 0) return line;
    const [start, mid, end] = this.palette.gradient;
    const chars = Array.from(line);
    const visible = chars.filter((c) => c !== " ").length;
    if (visible === 0) return line;
    let seen = 0;
    return chars
      .map((char) => {
        if (char === " ") return char;
        const t = visible <= 1 ? 0 : seen / (visible - 1);
        seen += 1;
        const color = t <= 0.5 ? mix(start, mid, t / 0.5) : mix(mid, end, (t - 0.5) / 0.5);
        return this.rgb(color, char);
      })
      .join("");
  }

  /** A rule of `width` cells in the muted tone. */
  rule(width: number): string {
    return this.dim(this.glyphs.rule.repeat(Math.max(0, width)));
  }
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const clamp = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * clamp),
    Math.round(a[1] + (b[1] - a[1]) * clamp),
    Math.round(a[2] + (b[2] - a[2]) * clamp),
  ];
}

/** A Style that never emits escapes (tests, piped output). */
export function plainStyle(): Style {
  return new Style({ colorDepth: 0, theme: "dark", unicode: true, hyperlinks: false });
}
