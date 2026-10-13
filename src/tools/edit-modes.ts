/**
 * Edit-tool sets, one per HarnessProfile.editMode.
 *
 * Different models are good at different edit formats (exact search/replace,
 * patch envelopes, anchored line edits, or whole-file rewrites). The registry
 * asks this module which tool(s) to expose for the active mode.
 */

import type { EditMode } from "../harness/profile.js";
import type { RegisteredTool, ToolDefinition } from "./index.js";
import { editFile, type EditToolInput } from "./edit.js";

export interface EditToolContext {
  cwd: string;
  unrestricted?: boolean;
}

/** Every tool name any edit mode may register (removed/re-added on mode change). */
export const EDIT_TOOL_NAMES = ["edit_file", "apply_patch", "edit_anchored"] as const;

/** Edit modes that are fully implemented (Dyno only explores these). */
export const AVAILABLE_EDIT_MODES: readonly EditMode[] = ["replace", "whole"];

export function editToolsForMode(mode: EditMode, ctx: EditToolContext): RegisteredTool[] {
  switch (mode) {
    case "whole":
      return [];
    case "replace":
    case "patch":
    case "anchored":
    default:
      return [
        {
          definition: editFileToolDefinition,
          handler: (input) => editFile(input as EditToolInput, { cwd: ctx.cwd }),
        },
      ];
  }
}

export const editFileToolDefinition: ToolDefinition = {
  name: "edit_file",
  description:
    "Apply one or more exact text replacements to an existing UTF-8 file inside the working directory. Each oldText must match exactly once. Returns a unified diff.",
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
        description: "Ordered exact text replacements to apply.",
        items: {
          type: "object",
          properties: {
            oldText: {
              type: "string",
              description: "Existing text to replace. Must occur exactly once at edit time.",
            },
            newText: {
              type: "string",
              description: "Replacement text.",
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

