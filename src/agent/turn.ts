/**
 * One user turn, end to end, with Parallel-Universe bookkeeping.
 *
 * Shared by the interactive loop, headless runs, and universe replays so they
 * all produce the same timeline: a "turn start" checkpoint, the recorded prompt,
 * per-tool checkpoints (via the recorder middleware), a "turn end" checkpoint,
 * and an evidence-backed receipt.
 */

import { formatReceipt, type Receipt, type ReceiptFile } from "../universe/receipts.js";
import type { TurnResult } from "./engine.js";
import type { Runtime } from "./setup.js";

export interface TurnOutcome {
  result: TurnResult;
  receipt: Receipt;
  receiptLines: string[];
}

export async function runTrackedTurn(
  rt: Runtime,
  prompt: string,
  options: { signal?: AbortSignal; recordedPrompt?: string } = {},
): Promise<TurnOutcome> {
  rt.turn.value += 1;
  const turnNo = rt.turn.value;
  const universe = rt.universe;

  let startSha: string | undefined;
  if (universe) {
    startSha = (
      await universe.checkpoint({
        kind: "turn",
        summary: `turn ${turnNo} start`,
        messageCount: rt.engine.messages.length,
        turn: turnNo,
      })
    ).sha;
    universe.recordPrompt(turnNo, options.recordedPrompt ?? prompt);
  }

  const spentBefore = rt.costUsd();
  const result = await rt.engine.runTurn(prompt, options.signal);
  const costUsd = rt.price || rt.costUsd() > spentBefore ? rt.costUsd() - spentBefore : undefined;

  let files: ReceiptFile[] | undefined;
  let existedBefore: Set<string> | undefined;
  if (universe && startSha) {
    const end = await universe.checkpoint({
      kind: "turn",
      summary: `turn ${turnNo} end`,
      messageCount: rt.engine.messages.length,
      turn: turnNo,
    });
    files = await universe.changesBetween(startSha, end.sha);
    existedBefore = await universe.existedAtBase(files.map((f) => f.path));
  }

  const receipt = rt.collector.finalize({
    turn: turnNo,
    durationMs: result.durationMs,
    stopReason: result.stopReason,
    files,
    existedBefore,
    tokens: { input: result.usage.inputTokens, output: result.usage.outputTokens },
    costUsd,
  });
  universe?.appendTimeline({ type: "receipt", ...receipt });
  return { result, receipt, receiptLines: formatReceipt(receipt) };
}
