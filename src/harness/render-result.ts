/**
 * Render a tool result as the plain text a model reads.
 *
 * Internally results are structured objects (the harness, compaction and the TUI
 * all inspect them). Sending them to the model as `JSON.stringify` output is
 * harmful: every newline becomes `\n`, every quote `\"`, so a file the model just
 * read looks like one escaped line and its next `oldText` copy is subtly wrong.
 * Every reference harness shows tool output as plain text; this does the same.
 */

export function renderToolResult(name: string | undefined, result: unknown): string {
  if (typeof result === "string") {
    return result.length > 0 ? result : "(empty output)";
  }
  if (result === null || result === undefined) {
    return "(no result)";
  }
  if (typeof result !== "object") {
    return String(result);
  }
  if (Array.isArray(result)) {
    return JSON.stringify(result, null, 2);
  }

  const record = result as Record<string, unknown>;
  const notes = collectNotes(record);
  const body = renderBody(name, record);
  return notes.length > 0 ? `${body}\n${notes.map((n) => `[${n}]`).join("\n")}` : body;
}

function renderBody(name: string | undefined, r: Record<string, unknown>): string {
  if (typeof r.error === "string") {
    return `Error: ${r.error}`;
  }

  // Annotated results: { output, harnessNote }
  if ("output" in r && Object.keys(r).every((k) => k === "output" || k === "harnessNote" || k === "hookFeedback")) {
    return renderToolResult(name, r.output);
  }

  switch (name) {
    case "shell":
      return renderShell(r);
    case "read_file":
      return renderRead(r);
    case "list_directory":
      return typeof r.content === "string" ? withHeader(r.path, r.content) : renderEntries(r);
    case "glob":
      return textOr(r.content ?? r.matches, "(no matches)");
    case "grep":
      return textOr(r.matches, "(no matches)");
    case "write_file":
      return renderWrite(r);
    case "update_plan":
      return renderPlan(r);
    case "delete_file":
      return typeof r.path === "string" ? `Deleted ${r.path}` : fallback(r);
    default:
      return fallback(r);
  }
}

function renderShell(r: Record<string, unknown>): string {
  const lines: string[] = [];
  const stdout = typeof r.stdout === "string" ? r.stdout : "";
  lines.push(stdout.length > 0 ? stdout : "(no output)");
  if (typeof r.exitCode === "number") {
    lines.push(`[exit code: ${r.exitCode}${r.timedOut ? ", timed out" : ""}]`);
  }
  if (r.truncated) {
    lines.push(
      typeof r.fullOutputFile === "string"
        ? `[output truncated; complete output saved at ${r.fullOutputFile}]`
        : "[output truncated]",
    );
  }
  return lines.join("\n");
}

function renderRead(r: Record<string, unknown>): string {
  const content = typeof r.content === "string" ? r.content : "";
  const total = typeof r.totalLines === "number" ? ` (${r.totalLines} lines)` : "";
  const header = typeof r.path === "string" ? `${r.path}${total}\n` : "";
  const tail = typeof r.continuation === "string" ? `\n${r.continuation}` : "";
  return `${header}${content}${tail}`;
}

function renderWrite(r: Record<string, unknown>): string {
  const verb = r.created ? "Created" : "Updated";
  const head = `${verb} ${String(r.path)} (${String(r.bytesWritten)} bytes)`;
  return typeof r.diff === "string" && r.diff.length > 0 ? `${head}\n${r.diff}` : head;
}

function renderPlan(r: Record<string, unknown>): string {
  if (!Array.isArray(r.steps)) return fallback(r);
  return (r.steps as Array<{ step: string; status: string }>)
    .map((s) => `${s.status === "completed" ? "[x]" : s.status === "in_progress" ? "[~]" : "[ ]"} ${s.step}`)
    .join("\n");
}

function renderEntries(r: Record<string, unknown>): string {
  return Array.isArray(r.entries) ? withHeader(r.path, (r.entries as unknown[]).map(String).join("\n")) : fallback(r);
}

function withHeader(path: unknown, body: string): string {
  return typeof path === "string" ? `${path}\n${body}` : body;
}

function textOr(value: unknown, empty: string): string {
  if (typeof value === "string") return value.length > 0 ? value : empty;
  if (Array.isArray(value)) return value.length > 0 ? value.map(String).join("\n") : empty;
  return empty;
}

function collectNotes(r: Record<string, unknown>): string[] {
  const notes: string[] = [];
  for (const key of ["note", "harnessNote", "hookFeedback"] as const) {
    if (typeof r[key] === "string" && r[key] !== "") {
      notes.push(key === "note" ? String(r[key]) : `${key === "harnessNote" ? "harness" : "hook"}: ${String(r[key])}`);
    }
  }
  if (r.denied === true && typeof r.error !== "string") {
    notes.push("denied");
  }
  return notes;
}

/** Last resort: compact JSON without the bookkeeping fields we already rendered. */
function fallback(r: Record<string, unknown>): string {
  const rest = Object.fromEntries(
    Object.entries(r).filter(([k]) => !["note", "harnessNote", "hookFeedback", "denied"].includes(k)),
  );
  return Object.keys(rest).length === 0 ? "(ok)" : JSON.stringify(rest, null, 2);
}
