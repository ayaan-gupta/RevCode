/**
 * Diff and text-similarity utilities.
 *
 * `generateDiff` produces standard unified diffs (3 lines of context) from a
 * Myers O(ND) line diff. Results go straight back to the model and the TUI, so
 * a one-line edit to a 2,000-line file must cost a handful of lines, not 4,000.
 * The similarity helpers back the "closest match" diagnostics that the edit
 * tools emit when a model's expected text is not in the file.
 */

export interface DiffOptions {
  /** Context lines around each change (default 3). */
  context?: number;
  /** Maximum diff body lines before the middle is elided (default 400). */
  maxLines?: number;
}

/** A maximal run of changed lines: `old[oldStart, oldEnd)` became `new[newStart, newEnd)`. */
export interface LineBlock {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_LINES = 400;
/**
 * Edit-distance ceiling for the exact algorithm. Trace memory grows as D^2, so
 * beyond this the changed middle is reported as one wholesale replacement
 * (which is also what a human wants to see for an unrelated rewrite).
 */
const MAX_EDIT_DISTANCE = 3_000;
const NO_EOL_MARKER = "\\ No newline at end of file";
/** Display width of one diff row; a minified file must not flood the context. */
const MAX_DIFF_LINE_CHARS = 500;

interface SplitText {
  /** Display lines: terminators removed, including a trailing `\r`. */
  lines: string[];
  /** False when the final line has no terminator. */
  trailingNewline: boolean;
}

/** Split into lines for diffing. CR is stripped so CRLF and LF files compare equal. */
export function splitDiffLines(text: string): SplitText {
  if (text.length === 0) {
    return { lines: [], trailingNewline: true };
  }
  const lines = text.split("\n");
  const trailingNewline = lines.at(-1) === "";
  if (trailingNewline) {
    lines.pop();
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].endsWith("\r")) {
      lines[i] = lines[i].slice(0, -1);
    }
  }
  return { lines, trailingNewline };
}

/**
 * Compute the changed blocks between two line arrays (Myers, with common
 * prefix/suffix trimmed first so typical small edits cost almost nothing).
 */
export function diffLineBlocks(oldLines: readonly string[], newLines: readonly string[]): LineBlock[] {
  let prefix = 0;
  const minLength = Math.min(oldLines.length, newLines.length);
  while (prefix < minLength && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < minLength - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldEnd = oldLines.length - suffix;
  const newEnd = newLines.length - suffix;
  if (prefix === oldEnd && prefix === newEnd) {
    return [];
  }
  if (prefix === oldEnd || prefix === newEnd) {
    return [{ oldStart: prefix, oldEnd, newStart: prefix, newEnd }];
  }

  const ids = new Map<string, number>();
  const toIds = (lines: readonly string[], from: number, to: number): Int32Array => {
    const out = new Int32Array(to - from);
    for (let i = from; i < to; i += 1) {
      let id = ids.get(lines[i]);
      if (id === undefined) {
        id = ids.size;
        ids.set(lines[i], id);
      }
      out[i - from] = id;
    }
    return out;
  };
  const a = toIds(oldLines, prefix, oldEnd);
  const b = toIds(newLines, prefix, newEnd);
  const script = myers(a, b);
  if (script === null) {
    return [{ oldStart: prefix, oldEnd, newStart: prefix, newEnd }];
  }

  // Walk the edit script and group consecutive non-equal steps into blocks.
  const blocks: LineBlock[] = [];
  let x = 0;
  let y = 0;
  let current: LineBlock | undefined;
  for (const step of script) {
    if (step === EQUAL) {
      current = undefined;
      x += 1;
      y += 1;
      continue;
    }
    if (current === undefined) {
      current = { oldStart: prefix + x, oldEnd: prefix + x, newStart: prefix + y, newEnd: prefix + y };
      blocks.push(current);
    }
    if (step === DELETE) {
      x += 1;
      current.oldEnd = prefix + x;
    } else {
      y += 1;
      current.newEnd = prefix + y;
    }
  }
  return blocks;
}

const EQUAL = 0;
const DELETE = 1;
const INSERT = 2;

/** Myers shortest edit script, or null when the edit distance exceeds the cap. */
function myers(a: Int32Array, b: Int32Array): Uint8Array | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];

  let found = -1;
  for (let d = 0; d <= max && found < 0; d += 1) {
    // State entering round d, covering diagonals -d..d (the edges are never read).
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) {
    return null;
  }

  const reversed: number[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const snapshot = trace[d];
    const k = x - y;
    const previousK =
      k === -d || (k !== d && snapshot[k - 1 + d] < snapshot[k + 1 + d]) ? k + 1 : k - 1;
    const previousX = snapshot[previousK + d];
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      reversed.push(EQUAL);
      x -= 1;
      y -= 1;
    }
    if (x === previousX) {
      reversed.push(INSERT);
      y -= 1;
    } else {
      reversed.push(DELETE);
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    reversed.push(EQUAL);
    x -= 1;
    y -= 1;
  }

  const script = new Uint8Array(reversed.length);
  for (let i = 0; i < reversed.length; i += 1) {
    script[i] = reversed[reversed.length - 1 - i];
  }
  return script;
}

/** Number of added and removed lines between two texts (CR-insensitive). */
export function diffStat(oldContent: string, newContent: string): { added: number; removed: number } {
  const blocks = diffLineBlocks(splitDiffLines(oldContent).lines, splitDiffLines(newContent).lines);
  let added = 0;
  let removed = 0;
  for (const block of blocks) {
    added += block.newEnd - block.newStart;
    removed += block.oldEnd - block.oldStart;
  }
  return { added, removed };
}

/**
 * Unified diff of two texts. Returns "" when they are identical. Headers use
 * `a/` and `b/` prefixes; hunks carry `context` lines (default 3). Large diffs
 * keep the first and last hunks and say how many lines were omitted.
 */
export function generateDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
  options: DiffOptions = {},
): string {
  if (oldContent === newContent) {
    return "";
  }

  const context = Math.max(0, options.context ?? DEFAULT_CONTEXT);
  const maxLines = Math.max(20, options.maxLines ?? DEFAULT_MAX_LINES);
  const oldText = splitDiffLines(oldContent);
  const newText = splitDiffLines(newContent);
  const header = [`--- a/${filePath}`, `+++ b/${filePath}`];

  // The final line is a different line when only its terminator changes.
  const oldKeys = comparisonKeys(oldText);
  const newKeys = comparisonKeys(newText);
  const blocks = diffLineBlocks(oldKeys, newKeys);
  if (blocks.length === 0) {
    return [...header, `(no textual changes; line endings ${describeEndingChange(oldContent, newContent)})`].join("\n");
  }

  const hunks = buildHunks(blocks, oldText, newText, context);
  return [...header, ...limitHunks(hunks, maxLines)].join("\n");
}

function comparisonKeys(text: SplitText): string[] {
  if (text.trailingNewline || text.lines.length === 0) {
    return text.lines;
  }
  const keys = text.lines.slice();
  keys[keys.length - 1] = `${keys[keys.length - 1]}\u0000no-eol`;
  return keys;
}

function describeEndingChange(before: string, after: string): string {
  const style = (text: string): string => {
    const crlf = (text.match(/\r\n/g) ?? []).length;
    const lf = (text.match(/\n/g) ?? []).length - crlf;
    if (crlf > 0 && lf > 0) return "mixed";
    return crlf > 0 ? "CRLF" : "LF";
  };
  const from = style(before);
  const to = style(after);
  return from === to ? "differ" : `changed from ${from} to ${to}`;
}

function buildHunks(blocks: LineBlock[], oldText: SplitText, newText: SplitText, context: number): string[][] {
  const hunks: string[][] = [];
  let index = 0;
  let previousOldEnd = 0;

  while (index < blocks.length) {
    // Merge blocks whose gap fits inside the combined context windows.
    let last = index;
    while (last + 1 < blocks.length && blocks[last + 1].oldStart - blocks[last].oldEnd <= 2 * context) {
      last += 1;
    }

    const first = blocks[index];
    const final = blocks[last];
    const leading = Math.min(context, first.oldStart - previousOldEnd);
    const trailing = Math.min(context, oldText.lines.length - final.oldEnd);
    const oldFrom = first.oldStart - leading;
    const newFrom = first.newStart - leading;
    const oldTo = final.oldEnd + trailing;
    const newTo = final.newEnd + trailing;

    const body: string[] = [];
    const contextLine = (oldIndex: number): void => {
      body.push(` ${clipRow(oldText.lines[oldIndex])}`);
      // Equal lines share their terminator status, so the old side decides.
      if (isUnterminated(oldText, oldIndex)) body.push(NO_EOL_MARKER);
    };
    for (let i = oldFrom; i < first.oldStart; i += 1) {
      contextLine(i);
    }
    for (let b = index; b <= last; b += 1) {
      const block = blocks[b];
      if (b > index) {
        for (let i = blocks[b - 1].oldEnd; i < block.oldStart; i += 1) {
          contextLine(i);
        }
      }
      for (let i = block.oldStart; i < block.oldEnd; i += 1) {
        body.push(`-${clipRow(oldText.lines[i])}`);
        if (isUnterminated(oldText, i)) body.push(NO_EOL_MARKER);
      }
      for (let i = block.newStart; i < block.newEnd; i += 1) {
        body.push(`+${clipRow(newText.lines[i])}`);
        if (isUnterminated(newText, i)) body.push(NO_EOL_MARKER);
      }
    }
    for (let i = final.oldEnd; i < oldTo; i += 1) {
      contextLine(i);
    }

    const oldCount = oldTo - oldFrom;
    const newCount = newTo - newFrom;
    // A zero-length range is addressed by the line before it.
    const oldStart = oldCount === 0 ? oldFrom : oldFrom + 1;
    const newStart = newCount === 0 ? newFrom : newFrom + 1;
    hunks.push([`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body]);

    previousOldEnd = oldTo;
    index = last + 1;
  }
  return hunks;
}

function clipRow(line: string): string {
  return line.length > MAX_DIFF_LINE_CHARS
    ? `${line.slice(0, MAX_DIFF_LINE_CHARS)}… [${line.length - MAX_DIFF_LINE_CHARS} more characters]`
    : line;
}

function isUnterminated(text: SplitText, index: number): boolean {
  return !text.trailingNewline && index === text.lines.length - 1;
}

/** Flatten hunks, eliding the middle when the diff exceeds `maxLines`. */
function limitHunks(hunks: string[][], maxLines: number): string[] {
  const total = hunks.reduce((sum, hunk) => sum + hunk.length, 0);
  if (total <= maxLines) {
    return hunks.flat();
  }

  const headBudget = Math.ceil(maxLines * 0.6);
  const tailBudget = maxLines - headBudget;
  const head: string[][] = [];
  const tail: string[][] = [];
  let used = 0;
  let from = 0;
  for (; from < hunks.length; from += 1) {
    if (used + hunks[from].length > headBudget) break;
    head.push(hunks[from]);
    used += hunks[from].length;
  }
  let usedTail = 0;
  let to = hunks.length;
  while (to - 1 > from && usedTail + hunks[to - 1].length <= tailBudget) {
    to -= 1;
    tail.unshift(hunks[to]);
    usedTail += hunks[to].length;
  }

  const out = head.flat();
  if (head.length === 0) {
    // The first hunk alone blows the budget: show its beginning.
    out.push(...hunks[0].slice(0, headBudget));
    from = 1;
  }
  const shownLines = out.length + tail.flat().length;
  const omittedHunks = to - from;
  const omittedLines = total - shownLines;
  const hunkNote = omittedHunks > 0 ? ` across ${omittedHunks} hunk${omittedHunks === 1 ? "" : "s"}` : "";
  out.push(`[... ${omittedLines} diff line${omittedLines === 1 ? "" : "s"} omitted${hunkNote} ...]`);
  out.push(...tail.flat());
  return out;
}

// --- similarity -------------------------------------------------------------

/** Levenshtein edit distance (two-row DP). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j += 1) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

const LONG_STRING = 400;

/** Similarity in [0, 1]. Long strings use a cheaper bigram measure to bound cost. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  if (longest > LONG_STRING) {
    return diceSimilarity(bigrams(a), bigrams(b));
  }
  return 1 - levenshtein(a, b) / longest;
}

/** Sorted bigram codes, for Dice-coefficient comparison. */
function bigrams(text: string): Int32Array {
  const clipped = text.length > 2_000 ? text.slice(0, 2_000) : text;
  if (clipped.length < 2) {
    return Int32Array.of(clipped.length === 1 ? clipped.charCodeAt(0) : 0);
  }
  const out = new Int32Array(clipped.length - 1);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (clipped.charCodeAt(i) << 16) | clipped.charCodeAt(i + 1);
  }
  return out.sort();
}

function diceSimilarity(a: Int32Array, b: Int32Array): number {
  if (a.length === 0 || b.length === 0) return 0;
  let i = 0;
  let j = 0;
  let shared = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      shared += 1;
      i += 1;
      j += 1;
    } else if (a[i] < b[j]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return (2 * shared) / (a.length + b.length);
}

export interface ClosestMatch {
  /** Similarity in [0, 1] averaged over the window. */
  score: number;
  /** 1-based line of the window's first line. */
  line: number;
  /** Index (within the needle) of the first line that differs exactly. */
  differingIndex: number;
  /** The needle line at `differingIndex`. */
  expected: string;
  /** The file line it was compared to. */
  actual: string;
}

const SCAN_LINES = 12;
const MAX_NEEDLE_LINES = 60;
const LINE_CLIP = 300;
const MAX_HAYSTACK_LINES = 150_000;

/**
 * Find the window of `haystack` lines most similar to `needle`, to explain why
 * an exact search failed. Scoring is whitespace-insensitive (trimmed lines) so
 * the answer points at real content differences; the reported differing line is
 * compared exactly so indentation mistakes are visible too.
 */
export function findClosestLines(haystack: readonly string[], needle: readonly string[]): ClosestMatch | null {
  let from = 0;
  let to = needle.length;
  while (from < to && needle[from].trim() === "") from += 1;
  while (to > from && needle[to - 1].trim() === "") to -= 1;
  const wanted = needle.slice(from, Math.min(to, from + MAX_NEEDLE_LINES));
  if (wanted.length === 0 || haystack.length === 0 || haystack.length > MAX_HAYSTACK_LINES) {
    return null;
  }

  const scan = wanted.slice(0, SCAN_LINES);
  const scanGrams = scan.map((line) => bigrams(line.trim().slice(0, LINE_CLIP)));
  const hayGrams = haystack.map((line) => bigrams(line.trim().slice(0, LINE_CLIP)));

  // Cheap pass: bigram overlap over the first few needle lines.
  const candidates: Array<{ at: number; score: number }> = [];
  for (let at = 0; at < haystack.length; at += 1) {
    let sum = 0;
    for (let j = 0; j < scan.length && at + j < haystack.length; j += 1) {
      sum += diceSimilarity(scanGrams[j], hayGrams[at + j]);
    }
    candidates.push({ at, score: sum / scan.length });
  }
  candidates.sort((x, y) => y.score - x.score || x.at - y.at);

  // Precise pass: Levenshtein over the whole needle for the best few windows.
  let best: { at: number; score: number } | undefined;
  for (const candidate of candidates.slice(0, 4)) {
    let sum = 0;
    for (let j = 0; j < wanted.length; j += 1) {
      const line = haystack[candidate.at + j];
      sum += line === undefined ? 0 : similarity(line.trim().slice(0, LINE_CLIP), wanted[j].trim().slice(0, LINE_CLIP));
    }
    const score = sum / wanted.length;
    if (best === undefined || score > best.score) {
      best = { at: candidate.at, score };
    }
  }
  if (best === undefined) {
    return null;
  }

  let differingIndex = wanted.findIndex((line, j) => line !== haystack[best.at + j]);
  if (differingIndex < 0) differingIndex = 0;
  return {
    score: best.score,
    line: best.at + 1,
    differingIndex: from + differingIndex,
    expected: wanted[differingIndex] ?? "",
    actual: haystack[best.at + differingIndex] ?? "",
  };
}
