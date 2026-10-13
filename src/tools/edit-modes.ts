/**
 * Edit-tool sets, one per HarnessProfile.editMode.
 *
 * Different models are good at different edit formats (exact search/replace,
 * patch envelopes, anchored line edits, or whole-file rewrites). The registry
 * asks this module which tool(s) to expose for the active mode.
 */

import type { EditMode } from "../harness/profile.js";
import type { RegisteredTool, ToolDefinition } from "./index.js";
import { editAnchored, editAnchoredToolDefinition, type EditAnchoredInput } from "./anchored/index.js";
import { applyPatch, applyPatchToolDefinition, type ApplyPatchInput } from "./apply-patch/index.js";
import { editFile, type EditToolInput } from "./edit.js";

export interface EditToolContext {
  cwd: string;
  unrestricted?: boolean;
}

/** Every tool name any edit mode may register (removed/re-added on mode change). */
export const EDIT_TOOL_NAMES = ["edit_file", "apply_patch", "edit_anchored"] as const;

/** Edit modes that are fully implemented (Dyno only explores these). */
export const AVAILABLE_EDIT_MODES: readonly EditMode[] = ["replace", "patch", "anchored", "whole"];

export function editToolsForMode(mode: EditMode, ctx: EditToolContext): RegisteredTool[] {
  const options = { cwd: ctx.cwd, unrestricted: ctx.unrestricted };
  switch (mode) {
    case "whole":
      return [];
    case "patch":
      return [{ definition: applyPatchToolDefinition, handler: (input) => applyPatch(input as ApplyPatchInput, options) }];
    case "anchored":
      return [
        { definition: editAnchoredToolDefinition, handler: (input) => editAnchored(input as EditAnchoredInput, options) },
      ];
    case "replace":
    default:
      return [{ definition: editFileToolDefinition, handler: (input) => editFile(input as EditToolInput, options) }];
  }
}

export const editFileToolDefinition: ToolDefinition = {
  name: "edit_file",
  description: [
    "Edit an existing UTF-8 text file by replacing exact text. Each edit is {oldText, newText}: oldText is found in the file and replaced by newText. Returns a unified diff.",
    "Rules: (1) Read the file first and copy oldText exactly, indentation included, but WITHOUT the `N|` line-number prefix that read_file shows. (2) oldText must identify exactly ONE location: if it occurs more than once the edit is rejected and the matches are listed with line numbers, so include more surrounding lines to make it unique, or set replaceAll to true to change every occurrence (renaming a variable, say). Prefer the smallest snippet that is still unique; a few lines of context is plenty.",
    "(3) Several edits in one call are applied in order, each to the result of the previous one, and all-or-nothing: if any edit fails nothing is written. (4) To insert, include a neighbouring line in oldText and repeat it in newText with your addition; to delete, use newText \"\". (5) Matching is forgiving about indentation, trailing whitespace, typographic quotes and over-escaped \\n/\\t; when oldText did not match exactly the result says which looser rule matched and re-indents newText to fit, so check the diff. (6) If oldText is not found the error names the closest text in the file: fix oldText from that instead of guessing again.",
    "CRLF line endings, BOM and file mode are preserved. Use write_file to create a file or to rewrite one completely.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path to edit, relative to the agent working directory.",
      },
      edits: {
        type: "array",
        minItems: 1,
        description: "Ordered text replacements. Applied in sequence; all succeed or none are written.",
        items: {
          type: "object",
          properties: {
            oldText: {
              type: "string",
              description:
                "Existing text to replace, copied exactly from the file (no line-number prefixes). Must match exactly one location unless replaceAll is true. Must not be empty.",
            },
            newText: {
              type: "string",
              description: "Replacement text. Use an empty string to delete oldText.",
            },
            replaceAll: {
              type: "boolean",
              description: "Replace every occurrence of oldText instead of requiring a unique match (default false).",
            },
          },
          required: ["oldText", "newText"],
          additionalProperties: false,
        },
      },
    },
    required: ["path", "edits"],
    additionalProperties: false,
  },
};
