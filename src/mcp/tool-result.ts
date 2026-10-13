/**
 * Convert an MCP `tools/call` result into the plain JSON object RevCode's
 * agent loop serializes into the model's conversation.
 *
 * Output shapes:
 *   success                  -> { text }
 *   success + structured     -> { text, structured }   (see dedupe note below)
 *   isError: true            -> { error }              (+ `structured` if present)
 *
 * `{ error: string }` is the shape the agent engine already treats as a failed
 * tool call, so MCP failures count toward its error accounting for free.
 *
 * Design notes:
 * - Only text can reach the model through a JSON tool result. Binary content
 *   (image/audio/blob resources) is replaced by a short placeholder that says
 *   what was dropped, so the model knows a result existed and can tell the
 *   user instead of hallucinating its content. Embedded TEXT resources are
 *   kept verbatim: dropping them would lose real information.
 * - Servers that return `structuredContent` are asked by the spec to also
 *   echo it as serialized JSON in a text block, for old clients. Sending both
 *   would double the tokens for every such call, so when the text is exactly
 *   that echo we keep only `structured`.
 */

import { isRecord } from "./types.js";

export type McpToolOutput =
  | { text?: string; structured?: unknown; error?: undefined }
  | { error: string; structured?: unknown; text?: undefined };

export function convertToolResult(raw: unknown): McpToolOutput {
  const result = isRecord(raw) ? raw : {};
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks.map(describeContentBlock).filter((part) => part !== "").join("\n");
  const structured = result.structuredContent;
  const hasStructured = structured !== undefined && structured !== null;

  if (result.isError === true) {
    const message = text !== "" ? text : "The MCP tool reported an error without a message.";
    return hasStructured ? { error: message, structured } : { error: message };
  }
  if (!hasStructured) {
    return { text };
  }
  if (text === "" || isJsonEcho(text, structured)) {
    return { structured };
  }
  return { text, structured };
}

/** Render one content block as text (or a placeholder for what cannot be shown). */
export function describeContentBlock(block: unknown): string {
  if (!isRecord(block)) {
    return "";
  }
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : "";
    case "image":
    case "audio":
      return binaryPlaceholder(String(block.type), block.mimeType, block.data);
    case "resource_link": {
      const uri = typeof block.uri === "string" ? block.uri : "unknown";
      const name = typeof block.name === "string" ? ` (${block.name})` : "";
      const description = typeof block.description === "string" ? ` - ${block.description}` : "";
      return `[resource_link: ${uri}${name}${description}]`;
    }
    case "resource": {
      const resource = isRecord(block.resource) ? block.resource : {};
      const uri = typeof resource.uri === "string" ? resource.uri : "unknown";
      const mime = typeof resource.mimeType === "string" ? resource.mimeType : undefined;
      if (typeof resource.text === "string") {
        return `[resource: ${uri}${mime ? ` (${mime})` : ""}]\n${resource.text}`;
      }
      if (typeof resource.blob === "string") {
        return binaryPlaceholder(`resource ${uri}`, mime, resource.blob);
      }
      return `[resource: ${uri}]`;
    }
    default:
      return `[unsupported content type: ${typeof block.type === "string" ? block.type : "unknown"}]`;
  }
}

function binaryPlaceholder(label: string, mimeType: unknown, data: unknown): string {
  const mime = typeof mimeType === "string" && mimeType !== "" ? mimeType : "unknown type";
  const size = typeof data === "string" ? data.length : 0;
  return `[${label}: ${mime}, ${size} bytes base64 omitted]`;
}

function isJsonEcho(text: string, structured: unknown): boolean {
  const trimmed = text.trim();
  if (trimmed === JSON.stringify(structured)) {
    return true;
  }
  if (trimmed[0] !== "{" && trimmed[0] !== "[") {
    return false;
  }
  try {
    return canonical(JSON.parse(trimmed)) === canonical(structured);
  } catch {
    return false;
  }
}

/** JSON with sorted object keys, so key order never defeats the comparison. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    isRecord(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}
