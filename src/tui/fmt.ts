/** Small formatting helpers shared by the UI and the renderers. */

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 1 && ms >= 0) return ms < 100 ? "<0.1s" : `${(ms / 1000).toFixed(1)}s`;
  if (s < 10) return `${(ms / 1000).toFixed(1)}s`;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Make untrusted text (command output, file content, model text) safe to print inside the
 * live UI: drop escape sequences and control characters that could move the cursor or
 * rewrite the screen, keep newlines and tabs, and collapse carriage-return progress output
 * to its final state.
 */
export function sanitizeForDisplay(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "") // OSC (titles, hyperlinks, clipboard)
    .replace(/\u001b[PX^_][\s\S]*?(?:\u001b\\|$)/g, "") // DCS / SOS / PM / APC strings
    .replace(/\u001b\[[0-9;:?<=>]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\u001b[@-Z\\-_]/g, "") // two-byte escapes
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const parts = line.split("\r");
      return parts[parts.length - 1] === "" && parts.length > 1 ? (parts.at(-2) as string) : (parts.at(-1) as string);
    })
    .join("\n")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}
