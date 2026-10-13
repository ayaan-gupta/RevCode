/**
 * Self-contained HTML report of a universe run: prompts, every checkpoint with
 * its diff, receipts, and the final changeset. No external requests — the file
 * can be attached to a PR, a chat message, or opened offline.
 */

import { existsSync } from "node:fs";
import { runShadowGit } from "./git.js";
import type { Receipt } from "./receipts.js";
import { formatReceipt } from "./receipts.js";
import type { Checkpoint, Universe } from "./universe.js";

const MAX_DIFF_LINES = 220;
const MAX_TOTAL_DIFF_BYTES = 600_000;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function renderUniverseHtml(universe: Universe): Promise<string> {
  const meta = universe.meta;
  const timeline = universe.timeline();
  const hasRepo = existsSync(universe.shadow().gitDir);

  let stat = { files: 0, insertions: 0, deletions: 0 };
  let finalDiff = "";
  if (hasRepo) {
    stat = await universe.diffStat();
    finalDiff = clipDiff(await universe.diff(), 900);
  }

  const checkpoints = timeline.filter((e): e is Checkpoint => e.type === "checkpoint");
  const receipts = timeline.filter((e) => e.type === "receipt") as unknown as Receipt[];
  const totalTokens = receipts.reduce(
    (acc, r) => ({ input: acc.input + (r.tokens?.input ?? 0), output: acc.output + (r.tokens?.output ?? 0) }),
    { input: 0, output: 0 },
  );
  const totalMs = receipts.reduce((n, r) => n + r.durationMs, 0);
  const commandCount = receipts.reduce((n, r) => n + r.commands.length, 0);

  let budget = MAX_TOTAL_DIFF_BYTES;
  const rows: string[] = [];
  let previousSha = checkpoints[0]?.sha;
  for (const entry of timeline) {
    if (entry.type === "prompt") {
      rows.push(`<section class="prompt"><div class="label">Prompt · turn ${entry.turn}</div><pre>${escapeHtml(entry.text)}</pre></section>`);
    } else if (entry.type === "receipt") {
      const receipt = entry as unknown as Receipt;
      const lines = formatReceipt(receipt);
      const bad = lines.some((l) => l.startsWith("⚠") || l.startsWith("✘"));
      rows.push(
        `<section class="receipt${bad ? " warn" : ""}"><div class="label">Receipt · turn ${receipt.turn}</div>${lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}${
          receipt.commands.length > 0
            ? `<details><summary>${receipt.commands.length} command${receipt.commands.length === 1 ? "" : "s"}</summary><ul>${receipt.commands
                .map((c) => `<li><code>${escapeHtml(c.command)}</code> → exit ${c.exitCode ?? "?"}${c.timedOut ? " (timed out)" : ""}</li>`)
                .join("")}</ul></details>`
            : ""
        }</section>`,
      );
    } else if (entry.type === "checkpoint") {
      let diffHtml = "";
      if (hasRepo && entry.changed && previousSha && entry.kind !== "base" && budget > 0) {
        try {
          const diff = clipDiff(
            (await runShadowGit(universe.shadow(), ["diff", "--no-color", "--no-renames", previousSha, entry.sha])).stdout.toString("utf8"),
            MAX_DIFF_LINES,
          );
          budget -= diff.length;
          if (diff.trim()) diffHtml = `<details><summary>diff</summary>${renderDiffHtml(diff)}</details>`;
        } catch {
          // object pruned or unreadable: show the checkpoint without a diff
        }
      }
      previousSha = entry.sha;
      const exit = entry.exitCode !== undefined && entry.exitCode !== null && entry.exitCode !== 0 ? ` <span class="bad">exit ${entry.exitCode}</span>` : "";
      rows.push(
        `<div class="cp ${entry.kind}${entry.changed ? " changed" : ""}"><span class="n">#${entry.n}</span><span class="kind">${entry.kind}</span><span class="sum">${escapeHtml(entry.summary)}${exit}</span>${diffHtml}</div>`,
      );
    }
  }

  const title = meta.name ?? `RevCode run ${meta.id}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{--bg:#fff;--fg:#1b1f24;--muted:#6b7480;--card:#f5f7fa;--line:#e1e5ea;--add:#1a7f37;--del:#cf222e;--warn:#9a6700;--accent:#6639ba}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--fg:#e6edf3;--muted:#8b949e;--card:#161b22;--line:#30363d;--add:#3fb950;--del:#f85149;--warn:#d29922;--accent:#bc8cff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:920px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--muted);margin-bottom:20px;word-break:break-all}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px}
.stat b{display:block;font-size:18px}.stat span{color:var(--muted);font-size:12px}
section{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:10px 0;background:var(--card)}
.label{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--accent);margin-bottom:4px}
.receipt.warn{border-color:var(--warn)}.receipt div{font-family:ui-monospace,Menlo,monospace;font-size:13px}
pre{white-space:pre-wrap;word-break:break-word;margin:0;font-family:ui-monospace,Menlo,monospace;font-size:13px}
.cp{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;padding:4px 2px;border-bottom:1px dashed var(--line);font-size:14px}
.cp .n{color:var(--muted);font-family:ui-monospace,monospace;width:42px}.cp .kind{color:var(--muted);width:52px;font-size:12px}
.cp.changed .sum::before{content:"● ";color:var(--add)}.bad{color:var(--del)}
details{width:100%;margin:4px 0}summary{cursor:pointer;color:var(--muted);font-size:13px}
.diff{margin:6px 0;border:1px solid var(--line);border-radius:6px;overflow:auto;background:var(--bg)}
.diff div{font-family:ui-monospace,Menlo,monospace;font-size:12px;white-space:pre;padding:0 8px}
.diff .a{color:var(--add);background:color-mix(in srgb,var(--add) 12%,transparent)}.diff .d{color:var(--del);background:color-mix(in srgb,var(--del) 12%,transparent)}.diff .h{color:var(--accent)}
h2{font-size:16px;margin:28px 0 8px}footer{color:var(--muted);font-size:12px;margin-top:32px}
</style>
</head>
<body><main>
<h1>${escapeHtml(title)}</h1>
<div class="sub">${escapeHtml(meta.projectRoot)}${meta.model ? ` · ${escapeHtml(meta.provider ?? "")}/${escapeHtml(meta.model)}` : ""} · ${escapeHtml(meta.createdAt.slice(0, 16).replace("T", " "))}</div>
<div class="stats">
<div class="stat"><b>${stat.files}</b><span>files changed</span></div>
<div class="stat"><b style="color:var(--add)">+${stat.insertions}</b><span>added</span></div>
<div class="stat"><b style="color:var(--del)">−${stat.deletions}</b><span>removed</span></div>
<div class="stat"><b>${commandCount}</b><span>commands run</span></div>
<div class="stat"><b>${checkpoints.filter((c) => c.kind === "tool").length}</b><span>checkpoints</span></div>
<div class="stat"><b>${(totalMs / 1000).toFixed(0)}s</b><span>agent time</span></div>
${totalTokens.input + totalTokens.output > 0 ? `<div class="stat"><b>${formatTokens(totalTokens.input + totalTokens.output)}</b><span>tokens</span></div>` : ""}
</div>
<h2>Timeline</h2>
${rows.join("\n")}
${finalDiff ? `<h2>Final changeset</h2>${renderDiffHtml(finalDiff)}` : ""}
<footer>Recorded by RevCode — Parallel Universes. Every checkpoint above can be rewound to, forked, or replayed on another model.</footer>
</main></body></html>
`;
}

function renderDiffHtml(diff: string): string {
  const lines = diff.split("\n").map((line) => {
    const cls = line.startsWith("+") && !line.startsWith("+++") ? "a" : line.startsWith("-") && !line.startsWith("---") ? "d" : line.startsWith("@@") || line.startsWith("diff ") ? "h" : "";
    return `<div${cls ? ` class="${cls}"` : ""}>${escapeHtml(line) || " "}</div>`;
  });
  return `<div class="diff">${lines.join("")}</div>`;
}

function clipDiff(diff: string, maxLines: number): string {
  const lines = diff.split("\n");
  if (lines.length <= maxLines) return diff;
  return `${lines.slice(0, maxLines).join("\n")}\n… ${lines.length - maxLines} more lines omitted`;
}

function formatTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
