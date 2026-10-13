/**
 * Line-sequence search with progressively looser equality.
 *
 * Adapted from openai/codex (codex-rs/apply-patch/src/seek_sequence.rs),
 * Apache-2.0, Copyright 2025 OpenAI. See THIRD_PARTY_NOTICES.md.
 *
 * Modified for RevCode: TypeScript port; a fifth pass that also collapses runs
 * of whitespace inside lines; an end-of-file hint falls back to searching from
 * `start` (as can1357/oh-my-pi does, MIT); and `seekAll` reports every match so
 * the caller can warn about ambiguous hunks.
 */

/** Typographic punctuation models normalize to ASCII (same set as Codex). */
function normalizePunctuation(text: string): string {
  return text
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018-\u201B]/g, "'")
    .replace(/[\u201C-\u201F]/g, '"')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

/** Comparison keys, strictest first: two lines match in a pass if their keys are equal. */
const PASS_KEYS: ReadonlyArray<(line: string) => string> = [
  (line) => line,
  (line) => line.trimEnd(),
  (line) => line.trim(),
  normalizePunctuation,
  (line) => normalizePunctuation(line).replace(/\s+/g, " "),
];

function matchesAt(lines: readonly string[], pattern: readonly string[], at: number): boolean {
  for (let j = 0; j < pattern.length; j += 1) {
    if (lines[at + j] !== pattern[j]) return false;
  }
  return true;
}

/** Search ranges: an end-of-file hunk tries the very end first, then everywhere after `start`. */
function searchRanges(lines: readonly string[], pattern: readonly string[], start: number, eof: boolean): Array<[number, number]> {
  const last = lines.length - pattern.length;
  if (last < start) return [];
  return eof && last > start ? [[last, last], [start, last]] : [[start, last]];
}

/**
 * Index of the first place `pattern` occurs in `lines` at or after `start`, or
 * -1. The strictest pass that finds anything wins.
 */
export function seekSequence(lines: readonly string[], pattern: readonly string[], start: number, eof: boolean): number {
  return seekAll(lines, pattern, start, eof)[0] ?? -1;
}

/** Every start index at which `pattern` occurs, using the strictest pass that matches at all. */
export function seekAll(lines: readonly string[], pattern: readonly string[], start: number, eof: boolean): number[] {
  if (pattern.length === 0) return [start];
  if (pattern.length > lines.length) return [];

  // Ranges are tried in order; within one, the strictest pass that matches at all wins.
  const keyedLines: Array<readonly string[] | undefined> = [];
  for (const [from, to] of searchRanges(lines, pattern, start, eof)) {
    for (let pass = 0; pass < PASS_KEYS.length; pass += 1) {
      const key = PASS_KEYS[pass];
      const keyed = (keyedLines[pass] ??= pass === 0 ? lines : lines.map(key));
      const wanted = pass === 0 ? pattern : pattern.map(key);
      const found: number[] = [];
      for (let at = from; at <= to; at += 1) {
        if (matchesAt(keyed, wanted, at)) found.push(at);
      }
      if (found.length > 0) return found;
    }
  }
  return [];
}
