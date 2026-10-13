/**
 * Naming of MCP tools inside RevCode's flat tool namespace.
 *
 * Every MCP tool is exposed as `mcp__<server>__<tool>`:
 * - the `mcp__` prefix keeps them out of the way of built-in tool names and
 *   tells the model (and the user's transcript) where a tool comes from;
 * - LLM function-calling APIs restrict names to `[a-zA-Z0-9_-]` and cap them
 *   at 64 characters, while MCP server/tool names are free-form (dots,
 *   slashes, spaces and long names are all seen in the wild).
 *
 * Design notes:
 * - Sanitizing is lossy ("a.b" and "a_b" both become "a_b"), and truncation
 *   is lossy too. Whenever either could make two tools collide — or simply
 *   has happened — a short hash of the ORIGINAL (server, tool) pair is
 *   appended. The hash is a pure function of the originals, so the same
 *   server config always yields the same names across runs.
 * - A clean, short, unique name is never altered: the hash is only added when
 *   needed. Names are assigned in the given order, so the first of a set of
 *   colliding tools keeps the clean name.
 */

import { createHash } from "node:crypto";

export const MAX_TOOL_NAME_LENGTH = 64;
const HASH_LENGTH = 8;

/** Replace every character outside `[a-zA-Z0-9_-]` with `_`. Never returns "". */
export function sanitizeNamePart(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned === "" ? "_" : cleaned;
}

export interface McpToolRef {
  server: string;
  tool: string;
}

/**
 * Assign a unique, API-safe name to each tool. The result array is parallel
 * to `refs`.
 */
export function assignToolNames(refs: readonly McpToolRef[]): string[] {
  const used = new Set<string>();
  return refs.map((ref) => {
    const base = `mcp__${sanitizeNamePart(ref.server)}__${sanitizeNamePart(ref.tool)}`;
    let name = base;
    let attempt = 0;
    while (name.length > MAX_TOOL_NAME_LENGTH || used.has(name)) {
      name = withHash(base, ref, attempt);
      attempt += 1;
    }
    used.add(name);
    return name;
  });
}

function withHash(base: string, ref: McpToolRef, attempt: number): string {
  const digest = createHash("sha256")
    .update(`${ref.server}\0${ref.tool}\0${attempt}`)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  const room = MAX_TOOL_NAME_LENGTH - HASH_LENGTH - 1;
  return `${base.slice(0, room)}_${digest}`;
}
