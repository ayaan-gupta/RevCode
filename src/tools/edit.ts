/**
 * Tool: apply targeted text replacements to an existing file.
 *
 * The matcher is a cascade of locators, strictest first: exact text, then
 * progressively more forgiving line/whitespace/escape comparisons. The first
 * tier that finds the text decides; a tier that finds it in more than one place
 * is reported as ambiguous instead of guessing. Weak models mostly fail edits
 * through indentation, whitespace and escaping drift, which the forgiving tiers
 * absorb, and the not-found diagnostic names the closest text in the file so
 * the model can fix the remainder in one retry.
 *
 * The cascade idea (and the ordering of the tiers) follows sst/opencode's edit
 * tool (MIT, Copyright (c) 2025 opencode), whose approaches it credits to Cline
 * and Gemini CLI (Apache-2.0); the closest-match diagnostic follows
 * can1357/oh-my-pi (MIT). This is an independent TypeScript implementation.
 * See THIRD_PARTY_NOTICES.md.
 *
 * Differences from the upstream cascade: matches are located by position, so a
 * fuzzy tier that finds two distinct places is an error rather than "pick the
 * first"; block-anchor pairs each opener with the closer whose block length is
 * closest to the request (nested braces) and demands 50% middle similarity; the
 * replacement is re-indented when the match differed only by a uniform indent.
 */

import path from "node:path";
import { diffStat, findClosestLines, generateDiff, similarity } from "../utils/diff.js";
import { resolvePathInsideCwd } from "./path.js";
import { encodeText, loadTextFile, toLf } from "./read.js";
import { writeTextFile } from "./write.js";

export interface EditRequest {
  oldText: string;
  newText: string;
  /** Replace every occurrence instead of requiring exactly one. */
  replaceAll?: boolean;
}

export interface EditToolInput {
  path: string;
  edits: EditRequest[];
}

export interface EditToolOptions {
  cwd?: string;
  /** Allow paths outside the working directory. */
  unrestricted?: boolean;
}

/** A recoverable edit problem; the message is written for the model. */
export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditError";
  }
}

export interface AppliedEdit {
  /** Position in the request (0-based). */
  index: number;
  /** Tier that located the text. "exact" means oldText matched verbatim. */
  strategy: string;
  /** Replacements made (more than 1 only with replaceAll). */
  count: number;
  /** The replacement's indentation was shifted to fit the file. */
  reindented: boolean;
  /** oldText carried `N|` line-number prefixes from a read_file view, which were removed. */
  strippedPrefixes: boolean;
}

export async function editFile(
  input: EditToolInput,
  options: EditToolOptions = {},
): Promise<string> {
  const normalizedInput = normalizeInput(input);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const editPath = resolvePathInsideCwd(normalizedInput.path, cwd, options.unrestricted);
  const file = await loadTextFile(editPath, cwd);

  let applied: { content: string; applied: AppliedEdit[] };
  try {
    applied = applyEdits(file.text, normalizedInput.edits, file.displayPath);
  } catch (error) {
    if (error instanceof EditError && normalizedInput.edits.length > 1) {
      throw new EditError(`${error.message}\nNo edits were applied; ${file.displayPath} is unchanged.`);
    }
    throw error;
  }

  await writeTextFile(editPath, encodeText(file, applied.content));
  return describeResult(file.displayPath, file.text, applied.content, applied.applied, normalizedInput.edits.length);
}

/**
 * Apply `edits` in order to LF text. Each edit sees the result of the previous
 * one. Throws EditError (applying nothing) if any edit cannot be placed.
 */
export function applyEdits(
  original: string,
  edits: readonly EditRequest[],
  filePath: string,
): { content: string; applied: AppliedEdit[] } {
  let content = original;
  const applied: AppliedEdit[] = [];

  edits.forEach((edit, index) => {
    const label = edits.length > 1 ? `Edit ${index + 1} of ${edits.length}: ` : "";
    if (edit.oldText === edit.newText) {
      throw new EditError(`${label}No changes to apply: oldText and newText are identical.`);
    }

    // A model that copies rows of a read_file view includes the `N|` prefixes.
    let request = edit;
    const unprefixed = content.includes(edit.oldText) ? undefined : stripLinePrefixes(edit.oldText);
    if (unprefixed !== undefined) {
      request = { ...edit, oldText: unprefixed, newText: stripLinePrefixes(edit.newText) ?? edit.newText };
    }

    const found = locate(content, request.oldText);
    if (found === undefined) {
      throw new EditError(`${label}${describeNotFound(filePath, content, request.oldText, unprefixed !== undefined)}`);
    }
    if (found.spans.length > 1 && edit.replaceAll !== true) {
      throw new EditError(`${label}${describeAmbiguous(filePath, content, found.spans, found.tier)}`);
    }

    let reindented = false;
    // Replace from the end so earlier offsets stay valid.
    for (const span of [...found.spans].reverse()) {
      const replacement = prepareReplacement(found.tier, content.slice(span.start, span.end), request);
      reindented ||= replacement.reindented;
      content = content.slice(0, span.start) + replacement.text + content.slice(span.end);
    }
    applied.push({
      index,
      strategy: found.tier.name,
      count: found.spans.length,
      reindented,
      strippedPrefixes: unprefixed !== undefined,
    });
  });

  if (content === original) {
    throw new EditError("No changes to apply: the edits leave the file unchanged.");
  }
  return { content, applied };
}

function normalizeInput(input: EditToolInput): EditToolInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("edit_file input must be an object");
  }

  const rawInput = input as unknown as Record<string, unknown>;
  const { path: inputPath } = rawInput;
  // Some models send a single edit object instead of a one-element array.
  const edits = Array.isArray(rawInput.edits)
    ? rawInput.edits
    : rawInput.edits && typeof rawInput.edits === "object"
      ? [rawInput.edits]
      : undefined;

  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw new Error("edit_file requires a non-empty string path");
  }

  if (edits === undefined || edits.length === 0) {
    throw new Error(
      "edit_file requires an edits array with at least one {oldText, newText} entry. Example: {\"path\": \"a.ts\", \"edits\": [{\"oldText\": \"old line\", \"newText\": \"new line\"}]}",
    );
  }

  return {
    path: inputPath,
    edits: edits.map((edit, index) => normalizeEdit(edit, index, edits.length)),
  };
}

function normalizeEdit(edit: unknown, index: number, total: number): EditRequest {
  const label = total > 1 ? `edit ${index + 1}` : "edit";
  if (typeof edit !== "object" || edit === null) {
    throw new Error(`edit_file ${label} must be an object with oldText and newText`);
  }

  const rawEdit = edit as Record<string, unknown>;
  const { oldText, newText, replaceAll } = rawEdit;

  if (typeof oldText !== "string" || oldText.length === 0) {
    throw new Error(
      `edit_file ${label}: oldText must be a non-empty string. To create a file or replace its whole content use write_file; to insert text, set oldText to the existing line you want to insert next to and repeat it in newText with your addition.`,
    );
  }

  if (typeof newText !== "string") {
    throw new Error(`edit_file ${label}: newText must be a string (use "" to delete oldText)`);
  }

  if (replaceAll !== undefined && replaceAll !== null && typeof replaceAll !== "boolean") {
    throw new Error(`edit_file ${label}: replaceAll must be a boolean when provided`);
  }

  // The file is matched as LF text, so the request is too.
  return { oldText: toLf(oldText), newText: toLf(newText), replaceAll: replaceAll === true };
}

function describeResult(
  displayName: string,
  before: string,
  after: string,
  applied: readonly AppliedEdit[],
  requested: number,
): string {
  const { added, removed } = diffStat(before, after);
  const replacements = applied.reduce((sum, edit) => sum + edit.count, 0);
  const lines = [
    `Edited ${displayName} (${requested} edit${requested === 1 ? "" : "s"}${replacements > requested ? `, ${replacements} replacements` : ""}; +${added} -${removed}).`,
  ];

  for (const edit of applied) {
    const which = applied.length > 1 ? `Edit ${edit.index + 1}` : "The edit";
    if (edit.strippedPrefixes) {
      lines.push(`Note: ${which} had line-number prefixes (\`N|\`) in oldText; they were removed. Never include them.`);
    }
    if (edit.strategy === "exact") continue;
    const tier = TIERS.find((candidate) => candidate.name === edit.strategy);
    lines.push(
      `Note: ${which} did not match oldText exactly; it matched ${tier?.explanation ?? edit.strategy}${edit.reindented ? " and the replacement's indentation was adjusted to fit" : ""}. Check the diff.`,
    );
  }
  return [...lines, generateDiff(before, after, displayName)].join("\n");
}

const LINE_PREFIX = /^\s*\d+(?:\||#[A-Z]{2}:)/;

/** Remove `N|` / `N#ID:` prefixes if every non-empty line has one; otherwise undefined. */
function stripLinePrefixes(text: string): string | undefined {
  const lines = text.split("\n");
  const filled = lines.filter((line) => line.length > 0);
  if (filled.length === 0 || !filled.every((line) => LINE_PREFIX.test(line))) return undefined;
  return lines.map((line) => line.replace(LINE_PREFIX, "")).join("\n");
}

// --- locating text ------------------------------------------------------------

interface Span {
  start: number;
  end: number;
}

interface Tier {
  name: string;
  /** Completes "it matched ..." in the result note. */
  explanation: string;
  /** Matches are whole-line windows, so indentation can be reconciled. */
  lineWindows: boolean;
  spans(ctx: MatchContext, find: string): Iterable<Span>;
}

/** Lazily split view of the content shared by all tiers during one edit. */
class MatchContext {
  private cachedLines: string[] | undefined;
  private cachedStarts: number[] | undefined;
  private cachedTrimmed: string[] | undefined;
  private cachedNormalized: string[] | undefined;

  constructor(readonly content: string) {}

  get lines(): string[] {
    this.cachedLines ??= this.content.split("\n");
    return this.cachedLines;
  }

  get trimmed(): string[] {
    this.cachedTrimmed ??= this.lines.map((line) => line.trim());
    return this.cachedTrimmed;
  }

  get normalized(): string[] {
    this.cachedNormalized ??= this.lines.map(collapseWhitespace);
    return this.cachedNormalized;
  }

  /** Span covering whole lines [from, to), excluding the final line break. */
  window(from: number, to: number): Span {
    if (this.cachedStarts === undefined) {
      const starts: number[] = [];
      let offset = 0;
      for (const line of this.lines) {
        starts.push(offset);
        offset += line.length + 1;
      }
      this.cachedStarts = starts;
    }
    return { start: this.cachedStarts[from], end: this.cachedStarts[to - 1] + this.lines[to - 1].length };
  }

  /** Offset of the first character of line `index`. */
  lineStart(index: number): number {
    return this.window(index, index + 1).start;
  }
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `find` as lines, without the empty element a trailing newline leaves behind. */
function searchLines(find: string): string[] {
  const lines = find.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function* occurrences(content: string, text: string): Generator<Span> {
  if (text.length === 0) return;
  let from = 0;
  for (;;) {
    const at = content.indexOf(text, from);
    if (at === -1) return;
    yield { start: at, end: at + text.length };
    from = at + text.length;
  }
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** A loose substring match must not start or end in the middle of an identifier. */
function atWordBoundaries(content: string, start: number, end: number): boolean {
  const insideWord = (inner: string | undefined, outer: string | undefined): boolean =>
    inner !== undefined && outer !== undefined && WORD_CHAR.test(inner) && WORD_CHAR.test(outer);
  return !insideWord(content[start], content[start - 1]) && !insideWord(content[end - 1], content[end]);
}

const exactTier: Tier = {
  name: "exact",
  explanation: "exactly",
  lineWindows: false,
  spans: (ctx, find) => occurrences(ctx.content, find),
};

/** Typographic characters models normalize to ASCII; each maps to one character, so offsets are unchanged. */
function normalizeTypography(text: string): string {
  return text
    .replace(/[\u2018-\u201B\u2032]/g, "'")
    .replace(/[\u201C-\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

const unicodeNormalizedTier: Tier = {
  name: "unicode-normalized",
  explanation: "ignoring typographic quote, dash and space variants",
  lineWindows: false,
  spans(ctx, find) {
    const wanted = normalizeTypography(find);
    const haystack = normalizeTypography(ctx.content);
    if (wanted === find && haystack === ctx.content) return [];
    return occurrences(haystack, wanted);
  },
};

const lineTrimmedTier: Tier = {
  name: "line-trimmed",
  explanation: "line by line, ignoring leading and trailing whitespace",
  lineWindows: true,
  *spans(ctx, find) {
    const search = searchLines(find).map((line) => line.trim());
    const trimmed = ctx.trimmed;
    for (let i = 0; i + search.length <= trimmed.length; i += 1) {
      if (search.every((line, j) => trimmed[i + j] === line)) {
        yield ctx.window(i, i + search.length);
      }
    }
  },
};

/** Opening and closing lines must carry enough text that matching them means something (not just `{` and `}`). */
function usableAnchors(first: string, last: string): boolean {
  return first !== "" && last !== "" && first.length + last.length >= 6;
}

/** Opening and closing lines match; the lines between may differ (a typo, a stale detail). */
const blockAnchorTier: Tier = {
  name: "block-anchor",
  explanation: "by its first and last lines (the lines between differed slightly)",
  lineWindows: true,
  *spans(ctx, find) {
    const search = searchLines(find);
    if (search.length < 3) return;
    const first = search[0].trim();
    const last = search[search.length - 1].trim();
    if (!usableAnchors(first, last)) return;

    const trimmed = ctx.trimmed;
    const tolerance = Math.max(3, Math.ceil(search.length * 0.5));
    const candidates: Array<{ from: number; to: number; score: number }> = [];
    for (let i = 0; i < trimmed.length; i += 1) {
      if (trimmed[i] !== first) continue;
      // Among later closers pick the one giving the block length nearest to the
      // request, so an inner "}" of a nested block does not close the outer one.
      let closer = -1;
      const limit = Math.min(trimmed.length - 1, i + search.length + tolerance);
      for (let j = i + 2; j <= limit; j += 1) {
        if (trimmed[j] === last && (closer < 0 || Math.abs(j - i + 1 - search.length) < Math.abs(closer - i + 1 - search.length))) {
          closer = j;
        }
      }
      if (closer < 0) continue;

      const compared = Math.min(search.length - 2, closer - i - 1);
      let total = 0;
      let counted = 0;
      for (let k = 1; k <= compared; k += 1) {
        const mine = trimmed[i + k];
        const theirs = search[k].trim();
        if (mine === "" && theirs === "") continue;
        total += similarity(mine, theirs);
        counted += 1;
      }
      const score = counted === 0 ? 1 : total / counted;
      if (score >= 0.5) {
        candidates.push({ from: i, to: closer + 1, score });
      }
    }

    // Only runners-up that are nearly as good count as competing matches.
    const best = candidates.reduce((top, candidate) => Math.max(top, candidate.score), 0);
    for (const candidate of candidates.filter((c) => c.score >= best - 0.1)) {
      yield ctx.window(candidate.from, candidate.to);
    }
  },
};

const whitespaceNormalizedTier: Tier = {
  name: "whitespace-normalized",
  explanation: "ignoring differences in spacing and line breaks",
  lineWindows: false,
  *spans(ctx, find) {
    const wanted = collapseWhitespace(find);
    if (wanted === "") return;
    const normalized = ctx.normalized;
    const lines = ctx.lines;

    for (let i = 0; i < lines.length; i += 1) {
      if (normalized[i] === wanted) {
        yield ctx.window(i, i + 1);
      } else if (normalized[i].includes(wanted) && wanted.includes(" ")) {
        // oldText is a fragment of one line: locate it with flexible spacing.
        const words = find.trim().split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        const match = new RegExp(words.join("\\s+")).exec(lines[i]);
        if (match) {
          const start = ctx.lineStart(i) + match.index;
          const end = start + match[0].length;
          if (atWordBoundaries(ctx.content, start, end)) yield { start, end };
        }
      }
    }

    const size = searchLines(find).length;
    if (size > 1) {
      for (let i = 0; i + size <= lines.length; i += 1) {
        // The window's first line must open the wanted text (cheap pre-filter).
        if (normalized[i] !== "" && !wanted.startsWith(normalized[i])) continue;
        if (collapseWhitespace(lines.slice(i, i + size).join("\n")) === wanted) {
          yield ctx.window(i, i + size);
        }
      }
    }
  },
};

const indentationFlexibleTier: Tier = {
  name: "indentation-flexible",
  explanation: "ignoring indentation",
  lineWindows: true,
  *spans(ctx, find) {
    const wanted = dedent(searchLines(find));
    const lines = ctx.lines;
    for (let i = 0; i + wanted.length <= lines.length; i += 1) {
      if (!lines[i].trim()) continue;
      const window = dedent(lines.slice(i, i + wanted.length));
      if (window.every((line, j) => line === wanted[j])) {
        yield ctx.window(i, i + wanted.length);
      }
    }
  },
};

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "'": "'", '"': '"', "`": "`", "\\": "\\", "\n": "\n", $: "$" };

function unescapeText(text: string): string {
  return text.replace(/\\([ntr'"`\\$\n])/g, (_match, char: string) => ESCAPES[char]);
}

/** The model wrote `\n`, `\t` or `\"` as literal characters. */
const escapeNormalizedTier: Tier = {
  name: "escape-normalized",
  explanation: "after interpreting backslash escapes (\\n, \\t, \\\") in oldText",
  lineWindows: false,
  *spans(ctx, find) {
    const unescaped = unescapeText(find);
    if (unescaped === find) return;
    yield* occurrences(ctx.content, unescaped);

    const wanted = unescaped.split("\n");
    const lines = ctx.lines;
    for (let i = 0; i + wanted.length <= lines.length; i += 1) {
      if (unescapeText(lines.slice(i, i + wanted.length).join("\n")) === unescaped) {
        yield ctx.window(i, i + wanted.length);
      }
    }
  },
};

const trimmedBoundaryTier: Tier = {
  name: "trimmed-boundary",
  explanation: "ignoring whitespace around oldText",
  lineWindows: false,
  *spans(ctx, find) {
    const core = find.trim();
    if (core === find || core === "") return;
    for (const span of occurrences(ctx.content, core)) {
      if (atWordBoundaries(ctx.content, span.start, span.end)) yield span;
    }

    const size = find.split("\n").length;
    const lines = ctx.lines;
    for (let i = 0; i + size <= lines.length; i += 1) {
      if (lines.slice(i, i + size).join("\n").trim() === core) {
        yield ctx.window(i, i + size);
      }
    }
  },
};

/** Same line count, matching first and last lines, and at least half of the middle lines equal. */
const contextAwareTier: Tier = {
  name: "context-aware",
  explanation: "by its first and last lines plus at least half of the lines between",
  lineWindows: true,
  *spans(ctx, find) {
    const search = searchLines(find);
    if (search.length < 3) return;
    const trimmed = ctx.trimmed;
    const first = search[0].trim();
    const last = search[search.length - 1].trim();
    if (!usableAnchors(first, last)) return;

    for (let i = 0; i + search.length <= trimmed.length; i += 1) {
      const end = i + search.length - 1;
      if (trimmed[i] !== first || trimmed[end] !== last) continue;
      let matched = 0;
      let counted = 0;
      for (let k = 1; k < search.length - 1; k += 1) {
        const mine = trimmed[i + k];
        const theirs = search[k].trim();
        if (mine === "" && theirs === "") continue;
        counted += 1;
        if (mine === theirs) matched += 1;
      }
      if (counted === 0 || matched / counted >= 0.5) {
        yield ctx.window(i, end + 1);
      }
    }
  },
};

const TIERS: readonly Tier[] = [
  exactTier,
  unicodeNormalizedTier,
  lineTrimmedTier,
  blockAnchorTier,
  whitespaceNormalizedTier,
  indentationFlexibleTier,
  escapeNormalizedTier,
  trimmedBoundaryTier,
  contextAwareTier,
];

/** Remove the smallest common indent (blank lines are left alone). */
function dedent(lines: readonly string[]): string[] {
  const filled = lines.filter((line) => line.trim() !== "");
  if (filled.length === 0) return [...lines];
  const indent = Math.min(...filled.map((line) => /^\s*/.exec(line)![0].length));
  return lines.map((line) => (line.trim() === "" ? line : line.slice(indent)));
}

interface Located {
  tier: Tier;
  /** Distinct, non-overlapping matches in file order. */
  spans: Span[];
}

function locate(content: string, find: string): Located | undefined {
  const ctx = new MatchContext(content);
  // Whitespace-only text can only be matched literally; fuzzy tiers would match every blank line.
  const tiers = find.trim() === "" ? [exactTier] : TIERS;
  for (const tier of tiers) {
    const spans = distinctSpans([...tier.spans(ctx, find)]);
    if (spans.length > 0) {
      return { tier, spans };
    }
  }
  return undefined;
}

function distinctSpans(spans: Span[]): Span[] {
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  for (const span of spans) {
    const last = out.at(-1);
    if (last === undefined || span.start >= last.end) {
      out.push(span);
    }
  }
  return out;
}

// --- building the replacement -------------------------------------------------

function prepareReplacement(tier: Tier, matched: string, edit: EditRequest): { text: string; reindented: boolean } {
  let text = edit.newText;
  if (tier.name === "exact") {
    return { text, reindented: false };
  }
  if (tier.name === "escape-normalized") {
    // A model that escaped oldText almost always escaped newText the same way.
    text = unescapeText(text);
  }
  // Line windows exclude their final line break; keep the file's line structure.
  if (edit.oldText.endsWith("\n") && !matched.endsWith("\n") && text.endsWith("\n")) {
    text = text.slice(0, -1);
  }
  if (tier.lineWindows) {
    const shifted = reindent(matched, edit.oldText, text);
    if (shifted !== undefined) {
      return { text: shifted, reindented: true };
    }
  }
  return { text, reindented: false };
}

function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)![0];
}

/**
 * If the file's lines differ from the model's oldText only by a uniform indent
 * (or tabs vs spaces), apply the same shift to newText. Returns undefined when
 * there is no consistent shift, in which case newText is used verbatim.
 */
function reindent(matched: string, oldText: string, newText: string): string | undefined {
  const fileLines = matched.split("\n");
  const askedLines = searchLines(oldText);
  if (fileLines.length !== askedLines.length) return undefined;

  const pairs: Array<[file: string, asked: string]> = [];
  for (let i = 0; i < fileLines.length; i += 1) {
    if (fileLines[i].trim() !== "" && fileLines[i].trim() === askedLines[i].trim()) {
      pairs.push([leadingWhitespace(fileLines[i]), leadingWhitespace(askedLines[i])]);
    }
  }
  if (pairs.length === 0 || pairs.every(([file, asked]) => file === asked)) return undefined;

  const mapLines = (transform: (line: string) => string): string =>
    newText.split("\n").map((line) => (line.trim() === "" ? line : transform(line))).join("\n");

  // File has an extra, uniform prefix: add it everywhere.
  const [firstFile, firstAsked] = pairs[0];
  if (firstFile.length > firstAsked.length && firstFile.endsWith(firstAsked)) {
    const prefix = firstFile.slice(0, firstFile.length - firstAsked.length);
    if (pairs.every(([file, asked]) => file === prefix + asked)) {
      return mapLines((line) => prefix + line);
    }
  }
  // Model over-indented: remove the surplus where present.
  if (firstAsked.length > firstFile.length && firstAsked.endsWith(firstFile)) {
    const surplus = firstAsked.slice(0, firstAsked.length - firstFile.length);
    if (pairs.every(([file, asked]) => asked === surplus + file)) {
      return mapLines((line) => (line.startsWith(surplus) ? line.slice(surplus.length) : line));
    }
  }
  // Tabs in the file, spaces from the model (or the reverse), at a constant width.
  const width = tabWidth(pairs);
  if (width !== undefined) {
    return mapLines((line) => convertIndent(line, width.fileUsesTabs, width.size));
  }
  return transferIndent(fileLines, askedLines, newText);
}

/**
 * No uniform shift (e.g. the model dropped only the first line's indent): give
 * each newText line the file's indentation of the oldText line it repeats, and
 * position new lines relative to the nearest repeated line before them.
 */
function transferIndent(fileLines: string[], askedLines: string[], newText: string): string | undefined {
  let cursor = 0;
  let anchor: { file: string; asked: string } | undefined;
  const out = newText.split("\n").map((line) => {
    if (line.trim() === "") return line;
    const text = line.trim();
    const indent = leadingWhitespace(line);
    for (let j = cursor; j < askedLines.length; j += 1) {
      if (askedLines[j].trim() === text && fileLines[j].trim() === text) {
        anchor = { file: leadingWhitespace(fileLines[j]), asked: leadingWhitespace(askedLines[j]) };
        cursor = j + 1;
        break;
      }
    }
    return anchor === undefined ? line : shiftIndent(anchor.file, anchor.asked, indent) + text;
  });
  const result = out.join("\n");
  return result === newText ? undefined : result;
}

/** Express `target` (relative to the model's `askedBase`) relative to the file's `fileBase`. */
function shiftIndent(fileBase: string, askedBase: string, target: string): string {
  if (target.startsWith(askedBase)) return fileBase + target.slice(askedBase.length);
  if (askedBase.startsWith(target)) {
    const surplus = askedBase.slice(target.length);
    return fileBase.endsWith(surplus) ? fileBase.slice(0, fileBase.length - surplus.length) : target;
  }
  return target;
}

function tabWidth(
  pairs: ReadonlyArray<readonly [file: string, asked: string]>,
): { fileUsesTabs: boolean; size: number } | undefined {
  const tabsToSpaces = pairs.every(([file, asked]) => file !== "" && /^\t+$/.test(file) && /^ +$/.test(asked));
  const spacesToTabs = pairs.every(([file, asked]) => asked !== "" && /^ +$/.test(file) && /^\t+$/.test(asked));
  if (!tabsToSpaces && !spacesToTabs) return undefined;

  const ratios = pairs
    .filter(([file, asked]) => file !== "" && asked !== "")
    .map(([file, asked]) => (tabsToSpaces ? asked.length / file.length : file.length / asked.length));
  const size = ratios[0];
  if (!Number.isInteger(size) || size < 1 || !ratios.every((ratio) => ratio === size)) return undefined;
  return { fileUsesTabs: tabsToSpaces, size };
}

function convertIndent(line: string, fileUsesTabs: boolean, size: number): string {
  const indent = leadingWhitespace(line);
  const rest = line.slice(indent.length);
  if (fileUsesTabs) {
    // Model wrote spaces; the file wants tabs.
    return /^ +$/.test(indent) && indent.length % size === 0 ? "\t".repeat(indent.length / size) + rest : line;
  }
  return /^\t+$/.test(indent) ? " ".repeat(indent.length * size) + rest : line;
}

// --- diagnostics --------------------------------------------------------------

const PREVIEW_COLUMNS = 120;
const MAX_LISTED_MATCHES = 5;

function describeNotFound(filePath: string, content: string, oldText: string, hadPrefixes: boolean): string {
  if (content.trim() === "") {
    return `Could not find oldText in ${filePath}: the file is empty. Use write_file to put content in it.`;
  }
  const lines = [`Could not find oldText in ${filePath}.`];
  const closest = findClosestLines(content.split("\n"), oldText.split("\n"));
  const percent = closest === null ? 0 : Math.round(closest.score * 100);

  if (closest !== null && closest.score >= 0.5) {
    lines.push(
      `Closest match (${percent}% similar) at line ${closest.line}:`,
      `- ${clip(closest.expected)}`,
      `+ ${clip(closest.actual)}`,
    );
  } else if (closest !== null) {
    lines.push(`Nothing in the file is similar to oldText (closest is ${percent}% similar, at line ${closest.line}); the file may not contain what you expect.`);
  }

  if (hadPrefixes) {
    lines.push("oldText started each line with a line-number prefix such as `12|` or `12#AB:` copied from read_file output. Those prefixes are not part of the file; they were ignored here, and the text without them was not found either.");
  }
  lines.push("Re-read the file with read_file and copy the text exactly (whitespace and indentation included). Prefer a shorter oldText that is still unique.");
  return lines.join("\n");
}

function clip(line: string): string {
  return line.length > PREVIEW_COLUMNS ? `${line.slice(0, PREVIEW_COLUMNS)}…` : line;
}

function describeAmbiguous(filePath: string, content: string, spans: readonly Span[], tier: Tier): string {
  const lines = content.split("\n");
  const lineOf = (offset: number): number => content.slice(0, offset).split("\n").length;
  const shown = spans.slice(0, MAX_LISTED_MATCHES);
  const loose = tier.name === "exact" ? "" : ` (oldText does not occur verbatim; these matched ${tier.explanation})`;
  const header =
    `Found ${spans.length} matches for oldText in ${filePath}${loose}` +
    `${spans.length > shown.length ? `, showing the first ${shown.length}` : ""}. ` +
    "Include more surrounding lines in oldText so it identifies exactly one location, or set replaceAll to true to change every occurrence.";

  const previews = shown.map((span, index) => {
    const first = lineOf(span.start);
    const last = lineOf(Math.max(span.start, span.end - 1));
    const from = Math.max(1, first - 2);
    const to = Math.min(lines.length, last + 2);
    const rows: string[] = [];
    for (let n = from; n <= to; n += 1) {
      const inMatch = n >= first && n <= last;
      if (inMatch && last - first > 6 && n > first + 3 && n < last - 1) {
        if (n === first + 4) rows.push("  ...");
        continue;
      }
      rows.push(`${inMatch ? ">" : " "}${n}|${clip(lines[n - 1])}`);
    }
    return `Match ${index + 1} (line ${first}${last > first ? `-${last}` : ""}):\n${rows.join("\n")}`;
  });
  return [header, "", ...previews.flatMap((preview) => [preview, ""])].join("\n").trimEnd();
}
