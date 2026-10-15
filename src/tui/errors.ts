/**
 * Turn raw model/API failures into something a person can act on: a one-line headline and,
 * when the cause is recognizable, the command or setting that fixes it.
 */

export interface ExplainedError {
  headline: string;
  hint?: string;
}

export function explainError(message: string, provider: string): ExplainedError {
  const text = message.trim();
  const lower = text.toLowerCase();
  const status = /\((\d{3})\)/.exec(text)?.[1];
  const detail = text.replace(/^.*?\(\d{3}\):\s*/s, "").replace(/\s+/g, " ").slice(0, 200);

  if (status === "401" || status === "403" || /invalid.{0,20}api.?key|unauthorized|authentication/.test(lower)) {
    return {
      headline: `The ${provider} API rejected the credentials${status ? ` (${status})` : ""}.`,
      hint: "Check your API key, or run `revcode setup` to enter a new one.",
    };
  }
  if (status === "429" || /rate.?limit|too many requests|quota|insufficient.{0,20}(balance|quota)/.test(lower)) {
    return {
      headline: `The ${provider} API is rate-limiting or out of quota${status ? ` (${status})` : ""}.`,
      hint: detail ? `The server said: ${detail}` : "Wait a moment and try again, or check your plan's limits.",
    };
  }
  if (status === "404" && /model/.test(lower)) {
    return { headline: "The server does not know that model.", hint: "Pick another with /model, or check --model and --base-url." };
  }
  if (/context.{0,30}(length|window)|maximum context|too many tokens|prompt is too long/.test(lower)) {
    return { headline: "The conversation no longer fits in the model's context window.", hint: "Run /compact to trim old tool output, or /clear to start fresh." };
  }
  if (status && Number(status) >= 500) {
    return { headline: `The ${provider} API had a server error (${status}).`, hint: "This is usually temporary — try again in a moment." };
  }
  if (/enotfound|econnrefused|econnreset|etimedout|fetch failed|network|socket hang up|timed out|timeout/.test(lower)) {
    return {
      headline: "Could not reach the model API.",
      hint: process.env.HTTPS_PROXY || process.env.https_proxy ? "Check your network and proxy settings (HTTPS_PROXY is set)." : "Check your network connection and --base-url.",
    };
  }
  if (/no llm client configured|api_key is required|set .*api_key/i.test(text)) {
    return { headline: `No credentials for ${provider}.`, hint: "Run `revcode setup`, or set the provider's API key environment variable." };
  }
  return { headline: text.length > 300 ? `${text.slice(0, 300)}…` : text };
}
