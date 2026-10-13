/**
 * Tool-argument tolerance.
 *
 * Weaker models make small, systematic mistakes: `file_path` instead of `path`,
 * numbers or arrays sent as strings, stray extra keys. Bouncing each of those
 * back as an error burns a turn (and invites a doom loop), so we repair what is
 * unambiguous and note what we changed. Anything we cannot repair is left alone
 * for the tool's own validation to reject with a clear message.
 */

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  additionalProperties?: boolean;
};

const ALIASES: Record<string, string[]> = {
  path: ["file_path", "filepath", "filename", "file", "file_name", "filePath", "target_file", "dir", "directory"],
  command: ["cmd", "script", "bash", "shell_command", "commands"],
  content: ["file_text", "text", "contents", "file_content", "data"],
  pattern: ["query", "regex", "search", "glob_pattern"],
  timeout: ["timeout_sec", "timeout_seconds", "timeout_ms"],
  oldText: ["old_text", "old_string", "old_str", "oldString", "old"],
  newText: ["new_text", "new_string", "new_str", "newString", "new"],
  input: ["patch", "patch_text", "patchText", "diff"],
};

export interface NormalizeResult {
  args: Record<string, unknown>;
  notes: string[];
}

export function normalizeToolArgs(rawArgs: Record<string, unknown>, schema: unknown): NormalizeResult {
  const root = (schema ?? {}) as Schema;
  const notes: string[] = [];
  const args = normalizeObject(rawArgs, root, notes, "");
  return { args, notes };
}

function normalizeObject(
  input: Record<string, unknown>,
  schema: Schema,
  notes: string[],
  prefix: string,
): Record<string, unknown> {
  const props = schema.properties ?? {};
  const out: Record<string, unknown> = {};
  const remaining = { ...input };

  // Models often flatten a single edit: { path, oldText, newText } instead of
  // { path, edits: [{ oldText, newText }] }. Wrap it when the schema wants `edits`.
  if (props.edits?.type === "array" && !("edits" in remaining)) {
    const pick = (name: "oldText" | "newText"): string | undefined => [name, ...(ALIASES[name] ?? [])].find((key) => key in remaining);
    const oldKey = pick("oldText");
    const newKey = pick("newText");
    if (oldKey && newKey) {
      remaining.edits = [{ oldText: remaining[oldKey], newText: remaining[newKey] }];
      delete remaining[oldKey];
      delete remaining[newKey];
      notes.push(`${prefix}oldText/newText wrapped into edits[0]`);
    }
  }

  // 1. Canonical keys first, then repair aliases for any that are missing.
  for (const name of Object.keys(props)) {
    if (name in remaining) {
      out[name] = remaining[name];
      delete remaining[name];
      continue;
    }
    for (const alias of ALIASES[name] ?? []) {
      if (alias in remaining) {
        out[name] = remaining[alias];
        delete remaining[alias];
        notes.push(`${prefix}${alias} → ${name}`);
        break;
      }
    }
  }

  // 2. Coerce values to the declared types.
  for (const [name, value] of Object.entries(out)) {
    out[name] = coerce(value, props[name] ?? {}, notes, `${prefix}${name}`);
  }

  // 3. Unknown keys: JSON Schema permits extras unless the schema says otherwise, so
  //    only drop them when it explicitly forbids them (all built-in tools do; many MCP
  //    tools do not, and must keep their extra arguments).
  const leftover = Object.keys(remaining);
  if (leftover.length > 0) {
    if (schema.additionalProperties === false) {
      notes.push(`ignored unknown argument${leftover.length > 1 ? "s" : ""}: ${leftover.map((k) => prefix + k).join(", ")}`);
    } else {
      Object.assign(out, remaining);
    }
  }
  return out;
}

function coerce(value: unknown, schema: Schema, notes: string[], label: string): unknown {
  switch (schema.type) {
    case "integer":
    case "number": {
      if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
        notes.push(`${label}: "${value}" → number`);
        return schema.type === "integer" ? Math.trunc(Number(value)) : Number(value);
      }
      if (typeof value === "number" && schema.type === "integer" && !Number.isInteger(value)) {
        notes.push(`${label}: ${value} → integer`);
        return Math.trunc(value);
      }
      return value;
    }
    case "boolean": {
      if (value === "true" || value === "false") {
        notes.push(`${label}: "${value}" → boolean`);
        return value === "true";
      }
      return value;
    }
    case "array": {
      let list = value;
      if (typeof list === "string") {
        const parsed = tryParseJson(list);
        if (Array.isArray(parsed)) {
          notes.push(`${label}: parsed JSON string → array`);
          list = parsed;
        }
      }
      if (Array.isArray(list)) {
        return list.map((item, i) => coerce(item, schema.items ?? {}, notes, `${label}[${i}]`));
      }
      return list;
    }
    case "object": {
      let obj = value;
      if (typeof obj === "string") {
        const parsed = tryParseJson(obj);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          notes.push(`${label}: parsed JSON string → object`);
          obj = parsed;
        }
      }
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return normalizeObject(obj as Record<string, unknown>, schema, notes, `${label}.`);
      }
      return obj;
    }
    case "string":
      // Models sometimes pass a one-element array or a number where a string belongs.
      if (Array.isArray(value) && value.length === 1 && typeof value[0] === "string") {
        notes.push(`${label}: single-item array → string`);
        return value[0];
      }
      if (typeof value === "number") {
        return String(value);
      }
      return value;
    default:
      return value;
  }
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("[") || trimmed.startsWith("{"))) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}
