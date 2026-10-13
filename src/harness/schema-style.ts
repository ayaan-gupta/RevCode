/**
 * Tool-schema presentation styles.
 *
 * "full" sends schemas exactly as authored. "flat" is a compact variant for
 * models that get confused by long descriptions or deep schemas (a technique
 * ForgeCode credits for Terminal-Bench gains): required properties first,
 * descriptions trimmed to their first sentence(s), validation-only keywords
 * dropped. Semantics are unchanged.
 */

import type { ToolDefinition } from "../llm/client.js";
import type { ToolSchemaStyle } from "./profile.js";

const MAX_TOOL_DESCRIPTION = 260;
const MAX_PARAM_DESCRIPTION = 110;

export function applySchemaStyle(definitions: ToolDefinition[], style: ToolSchemaStyle): ToolDefinition[] {
  return style === "flat" ? definitions.map(flattenDefinition) : definitions;
}

export function flattenDefinition(definition: ToolDefinition): ToolDefinition {
  return {
    name: definition.name,
    description: trimSentences(definition.description, MAX_TOOL_DESCRIPTION),
    parameters: flattenSchema(definition.parameters) as Record<string, unknown>,
  };
}

function flattenSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(flattenSchema);
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }

  const record = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  // Keep structure; drop keywords that only add noise for the model.
  for (const [key, value] of Object.entries(record)) {
    if (key === "additionalProperties" || key === "minimum" || key === "maximum" || key === "minItems") {
      continue;
    }
    if (key === "description" && typeof value === "string") {
      out[key] = trimSentences(value, MAX_PARAM_DESCRIPTION);
      continue;
    }
    if (key === "properties" && value && typeof value === "object") {
      const required = new Set(Array.isArray(record.required) ? (record.required as string[]) : []);
      const entries = Object.entries(value as Record<string, unknown>);
      entries.sort(([a], [b]) => Number(required.has(b)) - Number(required.has(a)));
      out.properties = Object.fromEntries(entries.map(([name, prop]) => [name, flattenSchema(prop)]));
      continue;
    }
    out[key] = flattenSchema(value);
  }
  return out;
}

/** Keep whole sentences up to `max` chars (always at least the first sentence, hard-cut if huge). */
export function trimSentences(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) {
    return clean;
  }
  const sentences = clean.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [clean];
  let out = "";
  for (const sentence of sentences) {
    if (out.length > 0 && out.length + sentence.length > max) {
      break;
    }
    out += sentence;
  }
  out = out.trim();
  return out.length > max * 1.5 ? `${out.slice(0, max).trimEnd()}…` : out;
}
