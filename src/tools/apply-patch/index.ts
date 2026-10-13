/**
 * Tool: apply_patch. Applies a multi-file patch in the Codex envelope format.
 *
 * Adapted from openai/codex (codex-rs/apply-patch), Apache-2.0, Copyright 2025
 * OpenAI; the tool description is adapted from Codex's prompt and from
 * can1357/oh-my-pi's apply_patch prompt (MIT). See THIRD_PARTY_NOTICES.md.
 *
 * Modified for RevCode: exposed as a JSON function tool with a single `input`
 * string; atomic across files (everything is computed in memory first, then
 * written, and a mid-write failure reports what was already applied); relative
 * and absolute paths follow the shared path policy; file modes, BOMs and line
 * endings are preserved; the result carries warnings and a compact diff.
 */

import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { generateDiff } from "../../utils/diff.js";
import type { ToolDefinition } from "../index.js";
import { resolvePathInsideCwd } from "../path.js";
import { displayPath, loadTextFile } from "../read.js";
import { writeTextFile } from "../write.js";
import { deriveNewContents } from "./derive.js";
import { parsePatch, PatchError } from "./parse.js";

export interface ApplyPatchInput {
  input?: string;
  /** Alias for `input`. */
  patch?: string;
}

export interface ApplyPatchOptions {
  cwd?: string;
  /** Allow paths outside the working directory. */
  unrestricted?: boolean;
}

interface FileState {
  /** Contents without BOM, line endings as on disk. */
  text: string;
  bom: boolean;
  /** Mode to apply when the file is first created at a new path (moves keep the source's mode). */
  mode?: number;
}

type Code = "A" | "M" | "D";

const MAX_DIFF_LINES = 400;

export async function applyPatch(input: ApplyPatchInput, options: ApplyPatchOptions = {}): Promise<string> {
  const patchText = readPatchText(input);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const workspace = new Workspace(cwd);

  let plan: Plan;
  try {
    plan = await prepare(patchText, cwd, options.unrestricted ?? false, workspace);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`apply_patch verification failed: ${message}\nNo files were changed.`);
  }

  const done: string[] = [];
  for (const step of plan.steps) {
    try {
      await execute(step);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const pending = plan.steps.slice(done.length + 1).map((s) => `${s.code} ${s.display}`);
      throw new Error(
        `apply_patch failed while applying ${step.display}: ${message}\nCompleted before failure:${done.length > 0 ? `\n${done.join("\n")}` : " (nothing)"}${pending.length > 0 ? `\nNot applied: ${pending.join(", ")}` : ""}`,
      );
    }
    done.push(`${step.code} ${step.display}`);
  }

  return renderResult(plan, done);
}

function readPatchText(input: ApplyPatchInput): string {
  if (typeof input !== "object" || input === null) {
    throw new Error("apply_patch input must be an object with the patch in the `input` string");
  }
  const raw = input as Record<string, unknown>;
  const text = [raw.input, raw.patch, raw.patchText, raw.patch_text].find((value) => typeof value === "string");
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error(
      "apply_patch requires the patch text in the `input` string, starting with '*** Begin Patch' and ending with '*** End Patch'.",
    );
  }
  return text;
}

// --- preparing ---------------------------------------------------------------

interface Step {
  code: Code;
  absolutePath: string;
  display: string;
  /** Undefined for a deletion. */
  state?: FileState;
  /** The path did not exist when the patch started. */
  isNew: boolean;
}

interface Plan {
  steps: Step[];
  warnings: string[];
  diffs: string[];
}

/** In-memory view of the files a patch touches, so later hunks see earlier ones. */
class Workspace {
  private readonly overlay = new Map<string, FileState | null>();

  constructor(readonly cwd: string) {}

  /** Current state of a file, or null if it does not exist. */
  async load(absolutePath: string): Promise<FileState | null> {
    const pending = this.overlay.get(absolutePath);
    if (pending !== undefined) return pending;
    if (!(await existsOnDisk(absolutePath))) return null;
    const file = await loadTextFile(absolutePath, this.cwd, { verb: "patch" });
    return { text: file.original, bom: file.bom, mode: file.mode };
  }

  async exists(absolutePath: string): Promise<boolean> {
    const pending = this.overlay.get(absolutePath);
    return pending !== undefined ? pending !== null : existsOnDisk(absolutePath);
  }

  set(absolutePath: string, state: FileState | null): void {
    this.overlay.set(absolutePath, state);
  }

  entries(): IterableIterator<[string, FileState | null]> {
    return this.overlay.entries();
  }
}

async function existsOnDisk(absolutePath: string): Promise<boolean> {
  try {
    await fs.stat(absolutePath);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function assertNotDirectory(absolutePath: string, action: string, display: string): Promise<void> {
  try {
    if ((await fs.stat(absolutePath)).isDirectory()) {
      throw new PatchError(`Failed to ${action} ${display}: it is a directory`);
    }
  } catch (error) {
    if (error instanceof PatchError) throw error;
  }
}

async function prepare(patchText: string, cwd: string, unrestricted: boolean, workspace: Workspace): Promise<Plan> {
  const hunks = parsePatch(patchText);
  if (hunks.length === 0) {
    throw new PatchError("No files were modified. The patch contains no Add File, Update File or Delete File sections.");
  }

  const warnings: string[] = [];
  const diffs: string[] = [];
  const resolve = (hunkPath: string): { absolutePath: string; display: string } => {
    const absolutePath = resolvePathInsideCwd(hunkPath, cwd, unrestricted);
    return { absolutePath, display: displayPath(absolutePath, cwd) };
  };

  for (const hunk of hunks) {
    const { absolutePath, display } = resolve(hunk.path);
    if (hunk.type === "add") {
      await assertNotDirectory(absolutePath, "add file", display);
      if (await workspace.exists(absolutePath)) {
        warnings.push(`Add File ${display}: the file already existed and was overwritten.`);
      }
      workspace.set(absolutePath, { text: hunk.contents, bom: false });
      diffs.push(generateDiff("", hunk.contents, display, { maxLines: 40 }));
      continue;
    }

    if (hunk.type === "delete") {
      await assertNotDirectory(absolutePath, "delete file", display);
      if (!(await workspace.exists(absolutePath))) {
        throw new PatchError(`Failed to delete file ${display}: the file does not exist`);
      }
      workspace.set(absolutePath, null);
      continue;
    }

    let current: FileState | null;
    try {
      current = await workspace.load(absolutePath);
    } catch (error) {
      throw new PatchError(`Failed to read file to update ${display}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (current === null) {
      throw new PatchError(
        `Failed to read file to update ${display}: the file does not exist. Use '*** Add File: ${hunk.path}' to create a new file.`,
      );
    }

    const derived = deriveNewContents(current.text, hunk.chunks, display);
    warnings.push(...derived.warnings);
    if (derived.content === current.text && hunk.movePath === undefined) {
      warnings.push(`Update File ${display}: the patch leaves the file unchanged.`);
    }

    const target = hunk.movePath === undefined ? { absolutePath, display } : resolve(hunk.movePath);
    const next: FileState = { text: derived.content, bom: current.bom, mode: current.mode };
    if (target.absolutePath !== absolutePath) {
      await assertNotDirectory(target.absolutePath, "move file to", target.display);
      if (await workspace.exists(target.absolutePath)) {
        warnings.push(`Move to ${target.display}: a file already existed there and was overwritten.`);
      }
      workspace.set(absolutePath, null);
    }
    workspace.set(target.absolutePath, next);
    diffs.push(generateDiff(current.text, derived.content, target.display, { maxLines: 120 }));
  }

  const steps: Step[] = [];
  for (const [absolutePath, state] of workspace.entries()) {
    const existed = await existsOnDisk(absolutePath);
    const display = displayPath(absolutePath, cwd);
    if (state === null) {
      if (existed) steps.push({ code: "D", absolutePath, display, isNew: false });
    } else {
      steps.push({ code: existed ? "M" : "A", absolutePath, display, state, isNew: !existed });
    }
  }
  // Write before deleting: a failed write then never loses the original of a moved file.
  steps.sort((a, b) => Number(a.code === "D") - Number(b.code === "D"));
  for (const step of steps) {
    await preflight(step);
  }
  return { steps, warnings, diffs };
}

/** Catch the failures we can predict before touching any file. */
async function preflight(step: Step): Promise<void> {
  if (step.code === "D") {
    await assertAccess(path.dirname(step.absolutePath), step);
    return;
  }
  if (!step.isNew) {
    await assertAccess(step.absolutePath, step);
    return;
  }
  // A new file needs a writable existing ancestor directory and no file in the way.
  let ancestor = path.dirname(step.absolutePath);
  for (;;) {
    try {
      const stat = await fs.stat(ancestor);
      if (!stat.isDirectory()) {
        throw new PatchError(`Cannot create ${step.display}: ${ancestor} is a file, not a directory`);
      }
      await assertAccess(ancestor, step);
      return;
    } catch (error) {
      if (error instanceof PatchError) throw error;
      if (!isMissing(error)) throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return;
      ancestor = parent;
    }
  }
}

async function assertAccess(target: string, step: Step): Promise<void> {
  try {
    await fs.access(target, (await fs.stat(target)).isDirectory() ? fsConstants.W_OK | fsConstants.X_OK : fsConstants.W_OK);
  } catch (error) {
    if (isMissing(error)) return;
    throw new PatchError(`Cannot write ${step.display}: permission denied for ${target}`);
  }
}

// --- writing -----------------------------------------------------------------

async function execute(step: Step): Promise<void> {
  if (step.state === undefined) {
    await fs.unlink(step.absolutePath);
    return;
  }
  await writeTextFile(step.absolutePath, (step.state.bom ? "\uFEFF" : "") + step.state.text);
  if (step.isNew && step.state.mode !== undefined) {
    await fs.chmod(step.absolutePath, step.state.mode & 0o7777);
  }
}

function renderResult(plan: Plan, done: readonly string[]): string {
  const lines = ["Success. Updated the following files:", ...done];
  if (plan.warnings.length > 0) {
    lines.push("", "Warnings:", ...plan.warnings.map((warning) => `- ${warning}`));
  }
  const diff = plan.diffs.filter((entry) => entry !== "").join("\n");
  if (diff !== "") {
    const diffLines = diff.split("\n");
    lines.push("", ...(diffLines.length > MAX_DIFF_LINES
      ? [...diffLines.slice(0, MAX_DIFF_LINES), `[... ${diffLines.length - MAX_DIFF_LINES} more diff lines omitted ...]`]
      : diffLines));
  }
  return lines.join("\n");
}

function isMissing(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

// --- tool definition -----------------------------------------------------------

export const APPLY_PATCH_DESCRIPTION = `Edit files with a patch. Your patch language is a stripped-down, file-oriented diff format designed to be easy to parse and safe to apply. Pass the whole patch as the \`input\` string (no JSON wrapping inside it). It is a high-level envelope:

*** Begin Patch
[ one or more file sections ]
*** End Patch

Within that envelope, you get a sequence of file operations. You MUST include a header to specify the action you are taking. Each operation starts with one of three headers:

*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).
*** Delete File: <path> - remove an existing file. Nothing follows.
*** Update File: <path> - patch an existing file in place (optionally with a rename).

An Update File section may start with \`*** Move to: <new path>\` to rename the file. Then come one or more hunks, each introduced by \`@@\` (optionally followed by a line from the file naming the class or function). Within a hunk each line starts with a space (unchanged context), \`-\` (remove) or \`+\` (add). There are no line numbers: the old lines (context plus \`-\` lines) are located by content.

Context rules:
- By default show 3 lines of code immediately above and 3 immediately below each change. If two changes are within 3 lines of each other, do not repeat the shared lines in both hunks.
- If 3 lines do not uniquely identify the place, add an \`@@\` line with the class or function the snippet belongs to, e.g. \`@@ class BaseClass\`. If that is still ambiguous, use several \`@@\` lines in a row (\`@@ class BaseClass\` then \`@@     def method():\`) to narrow the search.
- A snippet that appears more than once is applied at the first match; the result warns you when that happens.
- Use \`*** End of File\` after the last hunk line to anchor a hunk at the end of the file.
- Whitespace and typographic quotes in context are matched leniently, but copy lines exactly from read_file output (without the \`N|\` prefix).

Example:
*** Begin Patch
*** Add File: hello.txt
+Hello world
*** Update File: src/app.py
*** Move to: src/main.py
@@ def greet():
-print("Hi")
+print("Hello, world!")
*** Delete File: obsolete.txt
*** End Patch

It is important to remember:
- You must include a header with your intended action (Add/Delete/Update).
- You must prefix new lines with \`+\` even when creating a new file.
- File paths may be relative to the working directory or absolute.
- The whole patch is checked before anything is written: if any hunk fails, no file is changed. The result lists the files written (A added, M modified, D deleted) plus warnings and a diff, so there is no need to re-read the files afterwards.`;

export const applyPatchToolDefinition: ToolDefinition = {
  name: "apply_patch",
  description: APPLY_PATCH_DESCRIPTION,
  parameters: {
    type: "object",
    properties: {
      input: {
        type: "string",
        description: "The entire patch text, from '*** Begin Patch' to '*** End Patch'.",
      },
    },
    required: ["input"],
    additionalProperties: false,
  },
};
