/**
 * Minimal YAML-frontmatter parser for SKILL.md and command files.
 *
 * Deliberately a subset of YAML (no dependencies): block mappings, block and
 * inline lists, quoted and plain scalars (with line folding), `|` / `>` block
 * scalars, and `#` comments. It is more forgiving than a real YAML parser in
 * the places authors most often slip: a plain scalar may contain `: `
 * (`description: Fix: the build`), and a value that merely starts with `[`
 * (`[WIP] cleanup`) falls back to a string instead of failing the file.
 *
 * Plain scalars stay strings except `true`/`false`/`null`: numbers are NOT
 * coerced, so `version: 1.10` round-trips and `name: 123` can still be
 * validated as a string by the caller.
 */

export type YamlValue = string | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export interface ParsedFrontmatter {
  data: Record<string, YamlValue>;
  /** Everything after the closing delimiter (the whole input when there is no frontmatter). */
  body: string;
  /** True when the document opened with a `---` line. */
  present: boolean;
  /** Set when the block was malformed; `data` is then empty. */
  error?: string;
}

class YamlSyntaxError extends Error {}

const KEY_LINE = /^([A-Za-z0-9_$][\w$.-]*|"[^"]*"|'[^']*')[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/;
const BLOCK_SCALAR_HEADER = /^([|>])([+-]?)(\d?)[+-]?(?:\s+#.*)?$/;

export function parseFrontmatter(source: string): ParsedFrontmatter {
  const text = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (lines[0]?.trimEnd() !== "---") {
    return { data: {}, body: text, present: false };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trimEnd();
    if (line === "---" || line === "...") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { data: {}, body: text, present: true, error: "frontmatter is not closed with a --- line" };
  }

  const body = lines
    .slice(end + 1)
    .join("\n")
    .replace(/^\n+/, "");
  try {
    return { data: new YamlReader(lines.slice(1, end), 2).parseDocument(), body, present: true };
  } catch (error) {
    if (error instanceof YamlSyntaxError) {
      return { data: {}, body, present: true, error: error.message };
    }
    throw error;
  }
}

class YamlReader {
  private i = 0;

  /** `firstLine` is the 1-based file line of `lines[0]`, for error messages. */
  constructor(
    private readonly lines: string[],
    private readonly firstLine: number,
  ) {}

  parseDocument(): Record<string, YamlValue> {
    this.skipBlank();
    if (this.eof()) {
      return {};
    }
    const indent = indentOf(this.lines[this.i]);
    if (isListItem(this.lines[this.i].slice(indent))) {
      throw this.fail("frontmatter must be a key: value mapping, not a list");
    }
    const map = this.parseMap(indent);
    this.skipBlank();
    if (!this.eof()) {
      throw this.fail("unexpected indentation");
    }
    return map;
  }

  private parseMap(indent: number): Record<string, YamlValue> {
    const out: Record<string, YamlValue> = {};
    for (;;) {
      this.skipBlank();
      if (this.eof()) {
        break;
      }
      const line = this.lines[this.i];
      const lineIndent = indentOf(line);
      if (lineIndent < indent) {
        break;
      }
      if (lineIndent > indent) {
        throw this.fail("unexpected indentation");
      }
      const match = KEY_LINE.exec(line.slice(lineIndent));
      if (!match) {
        throw this.fail('expected "key: value"');
      }
      const key = match[1].replace(/^(["'])(.*)\1$/, "$2");
      this.i += 1;
      const value = this.parseValue((match[2] ?? "").trim(), indent);
      // A plain `out["__proto__"] = ...` would swap the prototype, not add a key.
      if (key !== "__proto__") {
        out[key] = value;
      }
    }
    return out;
  }

  private parseList(indent: number): YamlValue[] {
    const items: YamlValue[] = [];
    for (;;) {
      this.skipBlank();
      if (this.eof()) {
        break;
      }
      const line = this.lines[this.i];
      const lineIndent = indentOf(line);
      if (lineIndent < indent) {
        break;
      }
      if (lineIndent > indent) {
        throw this.fail("unexpected indentation");
      }
      const content = line.slice(lineIndent);
      if (!isListItem(content)) {
        break;
      }
      this.i += 1;
      const rest = content.slice(1).trim();
      items.push(rest === "" || rest.startsWith("#") ? this.parseNested(indent) : this.parseScalar(rest, indent));
    }
    return items;
  }

  /** Value after `key:` (or a bare `-`) that continues on the following lines. */
  private parseNested(parentIndent: number): YamlValue {
    this.skipBlank();
    if (this.eof()) {
      return null;
    }
    const line = this.lines[this.i];
    const indent = indentOf(line);
    const listItem = isListItem(line.slice(indent));
    if (indent > parentIndent) {
      return listItem ? this.parseList(indent) : this.parseMap(indent);
    }
    // YAML permits a list at the same indent as its parent key.
    if (indent === parentIndent && listItem) {
      return this.parseList(indent);
    }
    return null;
  }

  private parseValue(rest: string, parentIndent: number): YamlValue {
    if (rest === "" || rest.startsWith("#")) {
      return this.parseNested(parentIndent);
    }
    const header = BLOCK_SCALAR_HEADER.exec(rest);
    if (header) {
      return this.parseBlockScalar(header[1] as "|" | ">", rest, parentIndent);
    }
    return this.parseScalar(rest, parentIndent);
  }

  private parseScalar(rest: string, parentIndent: number): YamlValue {
    const first = rest[0];
    if (first === '"' || first === "'") {
      return this.parseQuoted(rest);
    }
    if (first === "[") {
      const list = this.parseFlowList(rest);
      if (list) {
        return list;
      }
    }
    return this.parsePlain(rest, parentIndent);
  }

  /** Quoted scalar; may continue on following lines until the closing quote. */
  private parseQuoted(rest: string): string {
    const startLine = this.i - 1;
    let text = rest;
    for (;;) {
      const scanned = scanQuoted(text);
      if (scanned) {
        const tail = text.slice(scanned.end).trim();
        if (tail !== "" && !tail.startsWith("#")) {
          throw this.fail("unexpected text after the closing quote", startLine);
        }
        return scanned.value;
      }
      if (this.eof()) {
        throw this.fail("unterminated quoted string", startLine);
      }
      text += `\n${this.lines[this.i]}`;
      this.i += 1;
    }
  }

  /** `[a, b]`, possibly spanning lines. Returns undefined when it is really a plain string. */
  private parseFlowList(rest: string): YamlValue[] | undefined {
    const start = this.i;
    let text = rest;
    for (;;) {
      const close = findFlowEnd(text);
      if (close !== undefined) {
        const tail = text.slice(close + 1).trim();
        if (tail !== "" && !tail.startsWith("#")) {
          this.i = start;
          return undefined;
        }
        return splitFlow(text.slice(1, close)).map(flowItem);
      }
      if (this.eof()) {
        this.i = start;
        return undefined;
      }
      text += ` ${this.lines[this.i].trim()}`;
      this.i += 1;
    }
  }

  /** Plain scalar; deeper-indented following lines fold into it. */
  private parsePlain(rest: string, parentIndent: number): YamlValue {
    let value = stripComment(rest);
    for (;;) {
      let probe = this.i;
      while (probe < this.lines.length && this.lines[probe].trim() === "") {
        probe += 1;
      }
      const next = this.lines[probe];
      if (next === undefined || indentOf(next) <= parentIndent || next.trim().startsWith("#")) {
        break;
      }
      const blanks = probe - this.i;
      value += (blanks > 0 ? "\n".repeat(blanks) : " ") + stripComment(next.trim());
      this.i = probe + 1;
    }
    return resolvePlain(value);
  }

  private parseBlockScalar(style: "|" | ">", header: string, parentIndent: number): string {
    const chomp = header.includes("-") ? "strip" : header.includes("+") ? "keep" : "clip";
    const raw: string[] = [];
    while (!this.eof()) {
      const line = this.lines[this.i];
      if (line.trim() === "" || indentOf(line) > parentIndent) {
        raw.push(line);
        this.i += 1;
        continue;
      }
      break;
    }

    const explicit = Number(BLOCK_SCALAR_HEADER.exec(header)?.[3] || 0);
    const firstText = raw.find((line) => line.trim() !== "");
    const blockIndent =
      explicit > 0 ? parentIndent + explicit : firstText === undefined ? 0 : indentOf(firstText);
    const stripped = raw.map((line) => (line.trim() === "" ? "" : line.slice(Math.min(blockIndent, indentOf(line)))));

    let trailing = 0;
    while (stripped.length > 0 && stripped[stripped.length - 1] === "") {
      stripped.pop();
      trailing += 1;
    }
    if (stripped.length === 0) {
      return chomp === "keep" ? "\n".repeat(trailing) : "";
    }

    const content = style === "|" ? stripped.join("\n") : foldLines(stripped);
    if (chomp === "strip") {
      return content;
    }
    return content + (chomp === "keep" ? "\n".repeat(trailing + 1) : "\n");
  }

  private skipBlank(): void {
    while (!this.eof()) {
      const trimmed = this.lines[this.i].trim();
      if (trimmed !== "" && !trimmed.startsWith("#")) {
        return;
      }
      this.i += 1;
    }
  }

  private eof(): boolean {
    return this.i >= this.lines.length;
  }

  /** `index` is the offending line's position in `lines` (default: the line being read). */
  private fail(message: string, index = this.i): YamlSyntaxError {
    const line = this.firstLine + Math.min(index, this.lines.length - 1);
    return new YamlSyntaxError(`${message} (line ${line})`);
  }
}

// --- scalar helpers -----------------------------------------------------------

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") {
    n += 1;
  }
  return n;
}

function isListItem(content: string): boolean {
  return content === "-" || content.startsWith("- ");
}

function stripComment(text: string): string {
  return text.replace(/\s+#.*$/, "").trim();
}

function resolvePlain(text: string): YamlValue {
  if (/^(true|True|TRUE)$/.test(text)) return true;
  if (/^(false|False|FALSE)$/.test(text)) return false;
  if (/^(null|Null|NULL|~)$/.test(text)) return null;
  return text;
}

/** Fold a `>` block scalar: single breaks become spaces, blank lines become newlines. */
function foldLines(lines: string[]): string {
  let out = "";
  let blanks = 0;
  let previous: string | undefined;
  for (const line of lines) {
    if (line === "") {
      blanks += 1;
      continue;
    }
    if (previous === undefined) {
      out += "\n".repeat(blanks) + line;
    } else if (/^\s/.test(line) || /^\s/.test(previous)) {
      // More-indented lines keep their line breaks.
      out += "\n".repeat(blanks + 1) + line;
    } else {
      out += (blanks === 0 ? " " : "\n".repeat(blanks)) + line;
    }
    blanks = 0;
    previous = line;
  }
  return out;
}

const DOUBLE_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "0": "\0",
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  e: "\u001b",
  " ": " ",
};

/**
 * Scan a quoted scalar starting at `text[0]`. Returns undefined when the
 * closing quote is not (yet) present. Line breaks fold the way YAML specifies.
 */
function scanQuoted(text: string): { value: string; end: number } | undefined {
  const quote = text[0];
  let value = "";
  let i = 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\n") {
      let breaks = 0;
      while (i < text.length && (text[i] === "\n" || text[i] === " " || text[i] === "\t")) {
        if (text[i] === "\n") breaks += 1;
        i += 1;
      }
      value = value.replace(/[ \t]+$/, "");
      value += breaks === 1 ? " " : "\n".repeat(breaks - 1);
      continue;
    }
    if (quote === "'") {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          value += "'";
          i += 2;
          continue;
        }
        return { value, end: i + 1 };
      }
      value += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      return { value, end: i + 1 };
    }
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === undefined) {
        return undefined;
      }
      if (next === "\n") {
        // Escaped line break: join without a space and skip the next line's indent.
        i += 2;
        while (text[i] === " " || text[i] === "\t") i += 1;
        continue;
      }
      const hex = next === "x" ? 2 : next === "u" ? 4 : next === "U" ? 8 : 0;
      if (hex > 0) {
        const digits = text.slice(i + 2, i + 2 + hex);
        if (digits.length === hex && /^[0-9a-fA-F]+$/.test(digits)) {
          value += String.fromCodePoint(parseInt(digits, 16));
          i += 2 + hex;
          continue;
        }
      }
      const mapped = DOUBLE_ESCAPES[next];
      // Unknown escapes (a regex like "\d+" in a description) are kept verbatim.
      value += mapped ?? `\\${next}`;
      i += 2;
      continue;
    }
    value += ch;
    i += 1;
  }
  return undefined;
}

/** Index of the `]` closing the flow list that starts at `text[0]`, ignoring quoted text. */
function findFlowEnd(text: string): number | undefined {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const scanned = scanQuoted(text.slice(i));
      if (!scanned) {
        return undefined;
      }
      i += scanned.end - 1;
    } else if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return undefined;
}

function splitFlow(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '"' || ch === "'") {
      const scanned = scanQuoted(inner.slice(i));
      const length = scanned ? scanned.end : inner.length - i;
      current += inner.slice(i, i + length);
      i += length - 1;
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    if (ch === "]" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  const trimmed = parts.map((part) => part.trim());
  // Tolerate a trailing comma.
  return trimmed[trimmed.length - 1] === "" ? trimmed.slice(0, -1) : trimmed;
}

function flowItem(text: string): YamlValue {
  if (text[0] === '"' || text[0] === "'") {
    const scanned = scanQuoted(text);
    if (scanned) {
      return scanned.value;
    }
  }
  return resolvePlain(text);
}

// --- typed accessors for consumers --------------------------------------------

/** A scalar as a string; undefined for missing, null, lists, and maps. */
export function asString(value: YamlValue | undefined): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "boolean" ? String(value) : undefined;
}

export function asBoolean(value: YamlValue | undefined): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true" || lower === "yes") return true;
    if (lower === "false" || lower === "no") return false;
  }
  return undefined;
}

/**
 * A list of strings from either a YAML list or a comma/space separated string.
 * Parentheses group, so `Bash(git add:*), Read` yields two entries.
 */
export function asStringList(value: YamlValue | undefined): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => asString(item)?.trim() ?? "").filter((item) => item !== "");
  }
  if (typeof value !== "string") {
    return [];
  }
  const items: string[] = [];
  let current = "";
  let depth = 0;
  for (const ch of value) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === "," || /\s/.test(ch))) {
      if (current !== "") items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current !== "") items.push(current);
  return items;
}
