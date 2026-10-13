/**
 * Tool: edit_anchored. Edits an existing file by citing the `LINE#ID` tags that
 * read_file shows in anchored mode, instead of retyping the old text.
 *
 * Adapted from can1357/oh-my-pi (MIT), packages/coding-agent/src/patch/hashline.ts
 * and prompts/tools/hashline.md at tag v13.0.0. Copyright (c) 2025 Mario Zechner,
 * (c) 2025-2026 Can Bölük, (c) 2026 Stencil Labs, Inc. See THIRD_PARTY_NOTICES.md.
 * Modified for RevCode: the result carries a unified diff and fresh anchors for
 * the edited region, and the schema is a single flat object per operation.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { diffLineBlocks, diffStat, generateDiff } from "../../utils/diff.js";
import type { ToolDefinition } from "../index.js";
import { resolvePathInsideCwd } from "../path.js";
import { displayPath, encodeText, loadTextFile } from "../read.js";
import { writeTextFile } from "../write.js";
import {
  applyHashlineEdits,
  renderAnchoredRegions,
  splitAnchoredLines,
  type HashlineEdit,
  type NoopEdit,
} from "./hashline.js";

export interface AnchoredEditOperation {
  op: "replace" | "append" | "prepend" | "insert";
  tag?: string;
  first?: string;
  last?: string;
  after?: string;
  before?: string;
  content?: string[] | string | null;
}

export interface EditAnchoredInput {
  path: string;
  edits: AnchoredEditOperation[];
  /** Move the edited file to this path (fails if it already exists). */
  rename?: string;
}

export interface EditAnchoredOptions {
  cwd?: string;
  /** Allow paths outside the working directory. */
  unrestricted?: boolean;
}

export async function editAnchored(input: EditAnchoredInput, options: EditAnchoredOptions = {}): Promise<string> {
  const { path: inputPath, edits, rename } = normalizeInput(input);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const filePath = resolvePathInsideCwd(inputPath, cwd, options.unrestricted);
  const renamePath = rename === undefined ? undefined : resolvePathInsideCwd(rename, cwd, options.unrestricted);
  const file = await loadTextFile(filePath, cwd);

  const applied = applyHashlineEdits(file.text, edits);
  const changed = applied.content !== file.text;
  if (!changed && renamePath === undefined) {
    throw new Error(describeNoChange(applied.noops));
  }

  if (renamePath !== undefined) {
    await assertCanRename(filePath, renamePath, cwd);
  }
  if (changed) {
    await writeTextFile(filePath, encodeText(file, applied.content));
  }
  let shownPath = file.displayPath;
  if (renamePath !== undefined) {
    await fs.mkdir(path.dirname(renamePath), { recursive: true });
    await fs.rename(filePath, renamePath);
    shownPath = `${file.displayPath} -> ${displayPath(renamePath, cwd)}`;
  }

  return describeResult(shownPath, file.displayPath, file.text, applied.content, edits.length, applied.noops);
}

function normalizeInput(input: EditAnchoredInput): { path: string; edits: HashlineEdit[]; rename?: string } {
  if (typeof input !== "object" || input === null) {
    throw new Error("edit_anchored input must be an object");
  }
  const raw = input as unknown as Record<string, unknown>;
  const { path: inputPath, rename } = raw;
  const rawEdits = Array.isArray(raw.edits) ? raw.edits : raw.edits && typeof raw.edits === "object" ? [raw.edits] : [];

  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw new Error("edit_anchored requires a non-empty string path");
  }
  if (rename !== undefined && rename !== null && (typeof rename !== "string" || rename.length === 0)) {
    throw new Error("edit_anchored rename must be a non-empty string when provided");
  }
  if (rawEdits.length === 0 && !rename) {
    throw new Error(
      'edit_anchored requires at least one edit, e.g. {"path": "a.ts", "edits": [{"op": "replace", "tag": "23#PM", "content": ["new line"]}]}',
    );
  }
  return {
    path: inputPath,
    edits: rawEdits.map((edit, index) => parseOperation(edit, index)),
    rename: typeof rename === "string" ? rename : undefined,
  };
}

const OP_ALIASES: Record<string, AnchoredEditOperation["op"]> = {
  replace: "replace",
  set: "replace",
  set_line: "replace",
  replace_lines: "replace",
  delete: "replace",
  append: "append",
  insert_after: "append",
  prepend: "prepend",
  insert_before: "prepend",
  insert: "insert",
  insert_between: "insert",
};

function parseOperation(raw: unknown, index: number): HashlineEdit {
  const label = `edit_anchored edit ${index + 1}`;
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${label} must be an object like {"op": "replace", "tag": "12#PM", "content": ["..."]}`);
  }
  const edit = raw as Record<string, unknown>;
  const op = typeof edit.op === "string" ? OP_ALIASES[edit.op.toLowerCase()] : undefined;
  if (op === undefined) {
    throw new Error(`${label}: op must be one of replace, append, prepend, insert (got ${JSON.stringify(edit.op)})`);
  }

  const ref = (name: string): string | undefined => {
    const value = edit[name];
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string") {
      throw new Error(`${label}: ${name} must be a "LINE#ID" string copied from read_file output`);
    }
    return value;
  };
  const content = parseContent(edit.content, label);

  switch (op) {
    case "replace": {
      const tag = ref("tag");
      const first = ref("first");
      const last = ref("last");
      if (tag !== undefined && first === undefined && last === undefined) {
        return { op, tag, content };
      }
      if (tag === undefined && first !== undefined) {
        return { op, first, last: last ?? first, content };
      }
      throw new Error(`${label}: replace needs either "tag" (one line) or both "first" and "last" (a range)`);
    }
    case "append":
      if (content === undefined || content === null) throw new Error(`${label}: append needs "content" (an array of lines)`);
      return { op, after: ref("after"), content };
    case "prepend":
      if (content === undefined || content === null) throw new Error(`${label}: prepend needs "content" (an array of lines)`);
      return { op, before: ref("before"), content };
    case "insert": {
      const after = ref("after");
      const before = ref("before");
      if (after === undefined || before === undefined) {
        throw new Error(`${label}: insert needs both "after" and "before" tags (adjacent lines). Use append or prepend for a single anchor.`);
      }
      if (content === undefined || content === null) throw new Error(`${label}: insert needs "content" (an array of lines)`);
      return { op, after, before, content };
    }
  }
}

function parseContent(value: unknown, label: string): string[] | null | undefined {
  if (value === undefined || value === null) return value;
  // A single string is tolerated: it is the text of the lines joined by newlines.
  if (typeof value === "string") return value === "" ? [""] : [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value as string[];
  throw new Error(`${label}: content must be an array of strings (one per line, no LINE#ID prefix, no trailing newline)`);
}

function describeNoChange(noops: readonly NoopEdit[]): string {
  const lines = ["No changes made: the replacement content is identical to what the file already contains."];
  for (const noop of noops.slice(0, 5)) {
    const shown = noop.currentContent.length > 100 ? `${noop.currentContent.slice(0, 100)}…` : noop.currentContent;
    lines.push(`  ${noop.location}: ${JSON.stringify(shown)}`);
  }
  lines.push("Check the current content with read_file and send the change you actually intend.");
  return lines.join("\n");
}

async function assertCanRename(from: string, to: string, cwd: string): Promise<void> {
  if (from === to) {
    throw new Error("edit_anchored rename must differ from the file's current path");
  }
  try {
    await fs.access(to);
  } catch {
    return;
  }
  throw new Error(`Cannot rename to ${path.relative(cwd, to) || to}: a file already exists there.`);
}

function describeResult(
  shownPath: string,
  diffPath: string,
  before: string,
  after: string,
  requested: number,
  noops: readonly NoopEdit[],
): string {
  const { added, removed } = diffStat(before, after);
  const head =
    before === after
      ? `Moved ${shownPath}.`
      : `Edited ${shownPath} (${requested} edit${requested === 1 ? "" : "s"}; +${added} -${removed}).`;
  const lines = [head];
  if (noops.length > 0) {
    lines.push(
      `Skipped ${noops.length} no-op edit${noops.length === 1 ? "" : "s"} (content already identical at ${noops.map((n) => n.location).join(", ")}).`,
    );
  }

  const diff = generateDiff(before, after, diffPath, { maxLines: 120 });
  if (diff !== "") lines.push(diff);

  const oldLines = splitAnchoredLines(before).lines;
  const newLines = splitAnchoredLines(after).lines;
  const blocks = diffLineBlocks(oldLines, newLines);
  if (blocks.length > 0) {
    const region = renderAnchoredRegions(
      newLines,
      blocks.map((block) => [block.newStart, block.newEnd] as const),
      { context: 2, maxLines: 60 },
    );
    const shifted = newLines.length - oldLines.length;
    lines.push(
      "",
      `Fresh anchors for the edited region${shifted !== 0 ? ` (lines after it moved by ${shifted > 0 ? "+" : ""}${shifted}; re-read before editing elsewhere)` : ""}:`,
      region,
    );
  }
  return lines.join("\n");
}

export const editAnchoredToolDefinition: ToolDefinition = {
  name: "edit_anchored",
  description: [
    "Edit an existing file by citing `LINE#ID` anchors instead of retyping old text; in this mode read_file shows every line as `LINE#ID:content`. Send one call per file with all its operations (replace, append, prepend, insert).",
    "An anchor is the line number plus a two-letter content ID, for example `23#PM` for the row `23#PM:  const t = 5;`. Copy anchors exactly from read_file output or from an error message; never guess them.",
    "Every anchor is checked against the same snapshot before anything is written. A stale anchor rejects the whole call and the error shows the current anchors, with >>> marking the changed lines: retry with those. Operations are applied bottom-up, so always use the anchors from your last read, not adjusted line numbers.",
    "Operations (field `op`):",
    "- replace one line: {op:\"replace\", tag:\"23#PM\", content:[\"  const t = 30;\"]}.",
    "- replace a range: {op:\"replace\", first:\"60#BB\", last:\"63#PN\", content:[...]}. Omit content (or pass []) to delete the line or range; content:[\"\"] keeps one blank line.",
    "- append after a line: {op:\"append\", after:\"260#QX\", content:[...]}; omit `after` to append at the end of the file.",
    "- prepend before a line: {op:\"prepend\", before:\"1#QX\", content:[...]}; omit `before` to insert at the start of the file.",
    "- insert between two adjacent lines: {op:\"insert\", after:\"44#ZR\", before:\"45#BB\", content:[...]} (safest for adding a block).",
    "`content` is an array of lines WITHOUT the `LINE#ID:` prefix and without trailing newlines; keep the file's indentation and formatting. Pick the smallest operation per change, anchor inserts on structural lines (a closing brace, a function header) rather than blank lines, do not touch unrelated lines, and do not send replacements identical to the current text.",
    "The result shows a unified diff and fresh anchors for the edited region so you can chain a follow-up edit there. If lines were added or removed, line numbers below the edit shift: re-read before editing elsewhere. `rename` moves the file to a new path (fails if it exists).",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path to edit, relative to the agent working directory.",
      },
      edits: {
        type: "array",
        description: "Operations for this file, all validated against the same snapshot.",
        items: {
          type: "object",
          properties: {
            op: {
              type: "string",
              enum: ["replace", "append", "prepend", "insert"],
              description: "Operation kind.",
            },
            tag: { type: "string", description: "replace (single line): the line's anchor, e.g. \"23#PM\"." },
            first: { type: "string", description: "replace (range): anchor of the first line." },
            last: { type: "string", description: "replace (range): anchor of the last line." },
            after: { type: "string", description: "append/insert: anchor of the line to insert after (append: omit for end of file)." },
            before: { type: "string", description: "prepend/insert: anchor of the line to insert before (prepend: omit for start of file)." },
            content: {
              type: "array",
              items: { type: "string" },
              description: "New lines, without LINE#ID prefixes. Omit or [] with replace to delete.",
            },
          },
          required: ["op"],
          additionalProperties: false,
        },
      },
      rename: {
        type: "string",
        description: "Optional new path to move the file to after editing.",
      },
    },
    required: ["path", "edits"],
    additionalProperties: false,
  },
};
