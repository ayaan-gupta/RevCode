/**
 * Raw terminal input → key events.
 *
 * Parses what a terminal actually sends in raw mode: printable text (including fast
 * typing and un-bracketed pastes), control characters, CSI / SS3 sequences for cursor
 * and function keys with modifiers, xterm `modifyOtherKeys` and the kitty keyboard
 * protocol (`CSI u`, which is how terminals report Shift+Enter), bracketed paste, and
 * focus reports. Sequences split across reads are reassembled.
 */

export interface KeyEvent {
  /**
   * "text" (printable input, see `text`), "paste" (see `text`), "focus-in" / "focus-out",
   * "response" (a terminal reply we do not act on), or a key name: return, escape, tab,
   * backspace, delete, up, down, left, right, home, end, pageup, pagedown, insert, space,
   * f1..f12, or a lowercase letter / symbol for ctrl/alt combinations.
   */
  name: string;
  text?: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

function event(name: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}, text?: string): KeyEvent {
  return { name, text, ctrl: mods.ctrl ?? false, alt: mods.alt ?? false, shift: mods.shift ?? false };
}

function decodeModifiers(param: number | undefined): { ctrl: boolean; alt: boolean; shift: boolean } {
  const bits = Math.max(0, (param ?? 1) - 1);
  return { shift: (bits & 1) !== 0, alt: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 };
}

const CSI_LETTER_KEYS: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  E: "clear",
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
};

const CSI_TILDE_KEYS: Record<number, string> = {
  1: "home",
  2: "insert",
  3: "delete",
  4: "end",
  5: "pageup",
  6: "pagedown",
  7: "home",
  8: "end",
  11: "f1",
  12: "f2",
  13: "f3",
  14: "f4",
  15: "f5",
  17: "f6",
  18: "f7",
  19: "f8",
  20: "f9",
  21: "f10",
  23: "f11",
  24: "f12",
};

/** Map a Unicode code point from a `CSI u` / modifyOtherKeys report to a key name (undefined if invalid). */
function nameForCodePoint(code: number): string | undefined {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined;
  switch (code) {
    case 9:
      return "tab";
    case 13:
      return "return";
    case 27:
      return "escape";
    case 32:
      return "space";
    case 127:
    case 8:
      return "backspace";
    default:
      return String.fromCodePoint(code).toLowerCase();
  }
}

export class KeyParser {
  private pending = "";
  private paste: string | undefined;

  /** Parse a chunk of terminal input. Incomplete trailing sequences wait for the next chunk. */
  feed(chunk: string): KeyEvent[] {
    const events: KeyEvent[] = [];
    let data = this.pending + chunk;
    this.pending = "";

    while (data.length > 0) {
      if (this.paste !== undefined) {
        const end = data.indexOf(PASTE_END);
        if (end === -1) {
          // Keep a possible partial terminator for the next chunk.
          const keep = partialSuffix(data, PASTE_END);
          this.paste += data.slice(0, data.length - keep);
          this.pending = data.slice(data.length - keep);
          return events;
        }
        this.paste += data.slice(0, end);
        events.push(event("paste", {}, this.paste));
        this.paste = undefined;
        data = data.slice(end + PASTE_END.length);
        continue;
      }

      const ch = data[0];
      if (ch === "\u001b") {
        const consumed = this.parseEscape(data, events);
        if (consumed === 0) {
          this.pending = data; // incomplete sequence: wait for more input
          return events;
        }
        data = data.slice(consumed);
        continue;
      }

      const code = ch.charCodeAt(0);
      if (code < 0x20 || code === 0x7f) {
        events.push(this.control(code));
        data = data.slice(1);
        continue;
      }

      // A run of printable text.
      let end = 1;
      while (end < data.length) {
        const c = data.charCodeAt(end);
        if (c < 0x20 || c === 0x7f) break;
        end += 1;
      }
      const run = data.slice(0, end);
      data = data.slice(end);

      // Terminals without bracketed paste deliver a paste as text with embedded newlines.
      if ((data[0] === "\r" || data[0] === "\n") && data.length > 1 && data.charCodeAt(1) >= 0x20) {
        const pasted = collectUnbracketedPaste(run, data);
        events.push(event("paste", {}, pasted.text));
        data = pasted.rest;
        continue;
      }
      events.push(event("text", {}, run));
    }
    return events;
  }

  /** True while a bracketed paste is being collected (everything is paste content until it ends). */
  get inPaste(): boolean {
    return this.paste !== undefined;
  }

  /** True while an incomplete escape sequence is buffered (call `flush` after a short idle delay). */
  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** Emit a lone pending ESC (call after a short idle delay). Never interrupts a paste in progress. */
  flush(): KeyEvent[] {
    if (this.paste !== undefined) return [];
    const pending = this.pending;
    this.pending = "";
    if (pending === "\u001b") return [event("escape")];
    return pending ? [event("response", {}, pending)] : [];
  }

  private control(code: number): KeyEvent {
    switch (code) {
      case 0x0d:
        return event("return");
      case 0x0a:
        return event("j", { ctrl: true }); // Ctrl+J / Shift+Enter in some terminals: a newline, not a submit
      case 0x09:
        return event("tab");
      case 0x08:
      case 0x7f:
        return event("backspace");
      case 0x00:
        return event("space", { ctrl: true });
      case 0x1c:
        return event("\\", { ctrl: true });
      case 0x1d:
        return event("]", { ctrl: true });
      case 0x1e:
        return event("^", { ctrl: true });
      case 0x1f:
        return event("_", { ctrl: true });
      default:
        return event(String.fromCharCode(code + 0x60), { ctrl: true });
    }
  }

  /** Returns the number of chars consumed, or 0 when the sequence is incomplete. */
  private parseEscape(data: string, out: KeyEvent[]): number {
    // A lone ESC at the end of a read is either the Escape key or the start of a sequence split
    // across reads; wait for the idle flush to decide rather than guessing.
    if (data.length === 1) return 0;
    const next = data[1];

    if (next === "[") {
      if (data.startsWith(PASTE_START)) {
        this.paste = "";
        return PASTE_START.length;
      }
      // CSI: ESC [ params intermediates final
      let i = 2;
      while (i < data.length && data.charCodeAt(i) >= 0x30 && data.charCodeAt(i) <= 0x3f) i += 1;
      while (i < data.length && data.charCodeAt(i) >= 0x20 && data.charCodeAt(i) <= 0x2f) i += 1;
      if (i >= data.length) return 0;
      const final = data[i];
      const params = data.slice(2, i).replace(/[ -/]+$/, "");
      out.push(this.csi(params, final, data.slice(0, i + 1)));
      return i + 1;
    }

    if (next === "O") {
      if (data.length < 3) return 0;
      const name = CSI_LETTER_KEYS[data[2]];
      out.push(name ? event(name) : event("response", {}, data.slice(0, 3)));
      return 3;
    }

    if (next === "]" || next === "P" || next === "_" || next === "^") {
      // OSC / DCS / APC / PM string: terminated by BEL or ESC \ — a terminal reply, not a key.
      const bel = data.indexOf("\u0007", 2);
      const st = data.indexOf("\u001b\\", 2);
      const ends = [bel === -1 ? -1 : bel + 1, st === -1 ? -1 : st + 2].filter((n) => n > 0);
      if (ends.length === 0) return 0;
      const end = Math.min(...ends);
      out.push(event("response", {}, data.slice(0, end)));
      return end;
    }

    if (next === "\u001b") {
      // ESC ESC: Escape (or Alt+Escape); consume one ESC and let the rest parse normally.
      out.push(event("escape"));
      return 1;
    }

    // ESC <char>: Alt+char (including Alt+Enter and Alt+Backspace).
    const code = next.charCodeAt(0);
    if (code === 0x0d || code === 0x0a) {
      out.push(event("return", { alt: true }));
      return 2;
    }
    if (code === 0x7f || code === 0x08) {
      out.push(event("backspace", { alt: true }));
      return 2;
    }
    if (code < 0x20) {
      const key = this.control(code);
      out.push({ ...key, alt: true });
      return 2;
    }
    const cp = data.codePointAt(1) as number;
    const length = cp > 0xffff ? 2 : 1;
    const char = data.slice(1, 1 + length);
    out.push(event(char === " " ? "space" : char.toLowerCase(), { alt: true, shift: char !== char.toLowerCase() }, char));
    return 1 + length;
  }

  private csi(params: string, final: string, raw: string): KeyEvent {
    if (params.startsWith("?") || params.startsWith(">") || params.startsWith("<") || params.startsWith("=")) {
      return event("response", {}, raw); // DECRPM, kitty flag query reply, DA, ...
    }
    const numbers = params.split(";").map((p) => {
      const n = Number.parseInt(p.split(":")[0], 10);
      return Number.isFinite(n) ? n : undefined;
    });

    switch (final) {
      case "I":
        return event("focus-in");
      case "O":
        return event("focus-out");
      case "Z":
        return event("tab", { shift: true });
      case "u": {
        // kitty keyboard protocol: CSI codepoint ; modifiers u
        const code = numbers[0];
        const name = code === undefined ? undefined : nameForCodePoint(code);
        if (name === undefined) return event("response", {}, raw);
        const mods = decodeModifiers(numbers[1]);
        return event(name, mods, name.length === 1 && !mods.ctrl && !mods.alt ? name : undefined);
      }
      case "~": {
        if (numbers[0] === 27 && numbers[2] !== undefined) {
          // xterm modifyOtherKeys: CSI 27 ; modifiers ; codepoint ~
          const name = nameForCodePoint(numbers[2]);
          return name === undefined ? event("response", {}, raw) : event(name, decodeModifiers(numbers[1]));
        }
        const name = numbers[0] === undefined ? undefined : CSI_TILDE_KEYS[numbers[0]];
        return name ? event(name, decodeModifiers(numbers[1])) : event("response", {}, raw);
      }
      case "M":
      case "m":
        return event("response", {}, raw); // mouse report: we never enable it, ignore stray ones
      default: {
        const name = CSI_LETTER_KEYS[final];
        if (!name) return event("response", {}, raw);
        // Modified arrows arrive as CSI 1 ; mod X (a few terminals send CSI mod X)
        return event(name, decodeModifiers(numbers.length >= 2 ? numbers[1] : numbers[0]));
      }
    }
  }
}

/** Length of the longest suffix of `data` that is a proper prefix of `marker`. */
function partialSuffix(data: string, marker: string): number {
  for (let len = Math.min(marker.length - 1, data.length); len > 0; len -= 1) {
    if (data.endsWith(marker.slice(0, len))) return len;
  }
  return 0;
}

function collectUnbracketedPaste(first: string, rest: string): { text: string; rest: string } {
  let text = first;
  let index = 0;
  while (index < rest.length) {
    const code = rest.charCodeAt(index);
    if (code === 0x0d || code === 0x0a) {
      // CRLF counts as one newline.
      if (code === 0x0d && rest.charCodeAt(index + 1) === 0x0a) index += 1;
      text += "\n";
      index += 1;
      continue;
    }
    if (code === 0x09 || code >= 0x20) {
      text += rest[index];
      index += 1;
      continue;
    }
    break;
  }
  // A trailing newline is a real Enter keypress, not part of the pasted text.
  if (text.endsWith("\n") && index === rest.length) {
    return { text: text.slice(0, -1), rest: rest.slice(index - 1) };
  }
  return { text, rest: rest.slice(index) };
}
