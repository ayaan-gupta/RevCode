/**
 * apply_patch envelope parser.
 *
 * Adapted from openai/codex (codex-rs/apply-patch/src/{parser,streaming_parser}.rs),
 * Apache-2.0, Copyright 2025 OpenAI. See THIRD_PARTY_NOTICES.md.
 *
 * Modified for RevCode: TypeScript port of the non-streaming parser; error
 * strings follow Codex's. Additional leniency, because weak models drift:
 *  - a markdown code fence or a whole `apply_patch <<'EOF'` command line around
 *    the patch is stripped (Codex strips only a bare heredoc);
 *  - consecutive `@@` lines are accepted as nested contexts (Codex's own prompt
 *    tells models to use them, but its parser rejects them);
 *  - a blank line between `+` lines of an added file is an empty line.
 */

export interface Chunk {
  /** `@@ text` lines, applied in order: each is searched for after the previous one. */
  contexts: string[];
  oldLines: string[];
  newLines: string[];
  /** [oldIndex, newIndex] of ' ' context rows; they keep their original bytes on apply. */
  contextIndices: Array<[number, number]>;
  /** The chunk is anchored at the end of the file (`*** End of File`). */
  isEndOfFile: boolean;
}

export type Hunk =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; movePath?: string; chunks: Chunk[] };

/** A malformed patch or a patch that does not fit the files; the message is for the model. */
export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const END_OF_FILE = "*** End of File";

const HUNK_HELP = "Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'";

function badUpdateLine(line: string): string {
  return `Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`;
}

function invalidHunk(lineNumber: number, message: string): PatchError {
  return new PatchError(`invalid hunk at line ${lineNumber}, ${message}`);
}

/** Parse a patch. Marker lines are matched after trimming; the body is not. */
export function parsePatch(input: string): Hunk[] {
  const lines = unwrap(input.trim().split(/\r?\n/));
  if (lines[0]?.trim() !== BEGIN) {
    throw new PatchError("invalid patch: The first line of the patch must be '*** Begin Patch'");
  }
  if (lines.length < 2 || lines[lines.length - 1].trim() !== END) {
    throw new PatchError("invalid patch: The last line of the patch must be '*** End Patch'");
  }

  const hunks: Hunk[] = [];
  const end = lines.length - 1;
  let i = 1;
  while (i < end) {
    const header = lines[i].trim();
    const headerLine = i + 1;
    if (header.startsWith(ADD)) {
      const contents: string[] = [];
      i += 1;
      while (i < end) {
        if (lines[i].startsWith("+")) {
          contents.push(lines[i].slice(1));
        } else if (lines[i] === "" && followedByAddedLine(lines, i + 1, end)) {
          contents.push("");
        } else {
          break;
        }
        i += 1;
      }
      hunks.push({ type: "add", path: header.slice(ADD.length), contents: contents.map((line) => `${line}\n`).join("") });
    } else if (header.startsWith(DELETE)) {
      hunks.push({ type: "delete", path: header.slice(DELETE.length) });
      i += 1;
    } else if (header.startsWith(UPDATE)) {
      const parsed = parseUpdate(lines, i, end, header.slice(UPDATE.length), headerLine);
      hunks.push(parsed.hunk);
      i = parsed.next;
    } else {
      throw invalidHunk(headerLine, `'${header}' is not a valid hunk header. ${HUNK_HELP}`);
    }
  }
  return hunks;
}

/** Remove a code fence or heredoc the model wrapped around the envelope. */
function unwrap(lines: string[]): string[] {
  let current = lines;
  const first = () => current[0]?.trim() ?? "";
  const last = () => current[current.length - 1]?.trim() ?? "";

  if (current.length >= 2 && /^```[\w-]*$/.test(first()) && last() === "```") {
    current = current.slice(1, -1);
  }
  const heredoc = /^(?:cd\s+\S+\s*&&\s*)?(?:apply_patch\s*)?<<-?\s*['"]?(\w+)['"]?$/.exec(first());
  if (heredoc && current.length >= 4 && last().endsWith(heredoc[1])) {
    current = current.slice(1, -1);
  }
  return current;
}

function followedByAddedLine(lines: string[], from: number, end: number): boolean {
  for (let i = from; i < end; i += 1) {
    if (lines[i] === "") continue;
    return lines[i].startsWith("+");
  }
  return false;
}

function emptyChunk(): Chunk {
  return { contexts: [], oldLines: [], newLines: [], contextIndices: [], isEndOfFile: false };
}

function isEmpty(chunk: Chunk | undefined): boolean {
  return chunk !== undefined && chunk.oldLines.length === 0 && chunk.newLines.length === 0;
}

function parseUpdate(
  lines: string[],
  start: number,
  end: number,
  path: string,
  headerLine: number,
): { hunk: Hunk; next: number } {
  let i = start + 1;
  let movePath: string | undefined;
  if (i < end && lines[i].trimEnd().startsWith(MOVE)) {
    movePath = lines[i].trimEnd().slice(MOVE.length);
    i += 1;
  }

  const chunks: Chunk[] = [];
  while (i < end) {
    const raw = lines[i];
    const text = raw.trimEnd();
    const lineNumber = i + 1;

    // The next file section starts here.
    if (text.startsWith("*** ") && text !== END_OF_FILE) {
      break;
    }

    const current = chunks.at(-1);
    if (current?.isEndOfFile) {
      if (text === "") {
        i += 1;
        continue;
      }
      if (text !== "@@" && !text.startsWith("@@ ")) {
        throw invalidHunk(lineNumber, `Expected update hunk to start with a @@ context marker, got: '${raw}'`);
      }
    }

    if (text === "@@" || text.startsWith("@@ ")) {
      if (isEmpty(current)) {
        // Back-to-back @@ lines narrow the search: class, then method.
        if (text !== "@@") current!.contexts.push(text.slice(3));
      } else {
        const chunk = emptyChunk();
        if (text !== "@@") chunk.contexts.push(text.slice(3));
        chunks.push(chunk);
      }
    } else if (text === END_OF_FILE) {
      if (current === undefined || isEmpty(current)) {
        throw invalidHunk(lineNumber, "Update hunk does not contain any lines");
      }
      current.isEndOfFile = true;
    } else if (raw === "" || raw[0] === " " || raw[0] === "+" || raw[0] === "-") {
      // The first chunk may omit its @@ line.
      const chunk = current ?? chunks[chunks.push(emptyChunk()) - 1];
      if (raw === "") {
        addContext(chunk, "");
      } else if (raw[0] === " ") {
        addContext(chunk, raw.slice(1));
      } else if (raw[0] === "+") {
        chunk.newLines.push(raw.slice(1));
      } else {
        chunk.oldLines.push(raw.slice(1));
      }
    } else if (current !== undefined && !isEmpty(current)) {
      throw invalidHunk(lineNumber, `Expected update hunk to start with a @@ context marker, got: '${raw}'`);
    } else {
      throw invalidHunk(lineNumber, badUpdateLine(raw));
    }
    i += 1;
  }

  if (chunks.length === 0) {
    throw invalidHunk(headerLine, `Update file hunk for path '${path}' is empty`);
  }
  if (isEmpty(chunks.at(-1))) {
    throw invalidHunk(i + 1, i >= end ? "Update hunk does not contain any lines" : badUpdateLine(lines[i]));
  }
  return { hunk: { type: "update", path, movePath, chunks }, next: i };
}

function addContext(chunk: Chunk, text: string): void {
  chunk.contextIndices.push([chunk.oldLines.length, chunk.newLines.length]);
  chunk.oldLines.push(text);
  chunk.newLines.push(text);
}
