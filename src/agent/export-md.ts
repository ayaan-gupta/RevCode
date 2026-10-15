/** Render a conversation as Markdown for `/export`. */

import type { LlmMessage } from "../llm/client.js";

export interface ExportMeta {
  sessionId: string;
  model: string;
  provider: string;
  cwd: string;
  exportedAt: Date;
}

const MAX_TOOL_RESULT_CHARS = 1500;

function fenced(text: string, lang = ""): string {
  let fence = "```";
  while (text.includes(fence)) fence += "`";
  return `${fence}${lang}\n${text}\n${fence}`;
}

function summarizeResult(content: string): string {
  let text = content;
  try {
    const parsed = JSON.parse(content) as { result?: unknown };
    if (parsed && typeof parsed === "object" && "result" in parsed) {
      const result = parsed.result;
      text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    }
  } catch {
    // not JSON: use as-is
  }
  return text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n… (${text.length - MAX_TOOL_RESULT_CHARS} more characters)` : text;
}

export function conversationToMarkdown(messages: readonly LlmMessage[], meta: ExportMeta): string {
  const out: string[] = [
    `# RevCode session ${meta.sessionId}`,
    "",
    `- Exported: ${meta.exportedAt.toISOString()}`,
    `- Model: ${meta.model} (${meta.provider})`,
    `- Directory: ${meta.cwd}`,
    "",
  ];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      if (message.content.startsWith("[harness]")) {
        out.push(`> ${message.content.replace(/\n/g, "\n> ")}`, "");
        continue;
      }
      out.push("## You", "", message.content.trim(), "");
    } else if (message.role === "assistant") {
      if (message.content.trim()) out.push("## RevCode", "", message.content.trim(), "");
      for (const call of message.toolCalls ?? []) {
        out.push(`**Tool:** \`${call.name}\``, "", fenced(JSON.stringify(call.arguments, null, 2), "json"), "");
      }
    } else if (message.role === "tool") {
      out.push("<details><summary>Result</summary>", "", fenced(summarizeResult(message.content)), "", "</details>", "");
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}
