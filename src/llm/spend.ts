/**
 * Spending: count what model calls cost, and stop before a cap is crossed.
 *
 * A `SpendMeter` is the running total (shared by every attempt of a race, so
 * `--max-cost` caps the whole run). `MeteredLlm` wraps one client: it prices each
 * call, records it on the meter, and refuses a call that would likely cross the
 * cap, estimating the next call from the previous one. Calls in flight reserve
 * their estimate, so parallel attempts can't all slip past the cap together.
 *
 * Every model call goes through the wrapper (subagents, compaction summaries,
 * completion audits too), so nothing escapes the count.
 */

import type { CompleteOptions, LlmClient, LlmMessage, LlmResponse, ToolDefinition } from "./client.js";
import { costOf, formatUsd, type ModelPrice } from "./pricing.js";
import type { ImageQuestion } from "./vision.js";

export class SpendMeter {
  private spent = 0;
  private reserved = 0;
  private cap: number | undefined;
  /** Calls whose cost could not be worked out (no known price, none reported). */
  unpricedCalls = 0;

  constructor(capUsd?: number) {
    this.cap = capUsd;
  }

  get capUsd(): number | undefined {
    return this.cap;
  }

  /** Change or remove the cap mid-session (`/cost 5`, `/cost off`). */
  setCap(capUsd: number | undefined): void {
    this.cap = capUsd;
  }

  get spentUsd(): number {
    return this.spent;
  }

  record(costUsd: number): void {
    this.spent += Math.max(0, costUsd);
  }

  reserve(amount: number): void {
    this.reserved += amount;
  }

  release(amount: number): void {
    this.reserved = Math.max(0, this.reserved - amount);
  }

  /** True when one more call, estimated at `estimate`, should not be made. */
  wouldExceed(estimate: number): boolean {
    if (this.cap === undefined) return false;
    return this.spent >= this.cap || this.spent + this.reserved + estimate > this.cap;
  }
}

export class SpendCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpendCapError";
  }
}

export function isSpendCapError(error: unknown): boolean {
  return error instanceof Error && error.name === "SpendCapError";
}

export interface SpendCheck {
  /** End the run now. */
  stop: boolean;
  /** Why (shown to the user). */
  reason?: string;
  /** A one-time heads-up for the model that the budget is nearly used. */
  nudge?: string;
}

const NUDGE_AT = 0.8;

export class MeteredLlm implements LlmClient {
  /** Cost of the most recent call: the estimate for the next one. */
  private lastCallUsd = 0;
  private nudged = false;
  describeImage?: (image: ImageQuestion, options?: { signal?: AbortSignal }) => Promise<string>;

  constructor(
    readonly inner: LlmClient,
    readonly meter: SpendMeter,
    readonly price: ModelPrice | undefined,
    private readonly model: string,
  ) {
    if (inner.describeImage) {
      // Image questions go to a separate (cheap) vision model; they are not priced.
      this.describeImage = (image, options) => inner.describeImage!(image, options);
    }
  }

  async complete(messages: LlmMessage[], tools?: ToolDefinition[], options?: CompleteOptions): Promise<LlmResponse> {
    const blocked = this.blockReason();
    if (blocked) throw new SpendCapError(blocked);
    const estimate = this.lastCallUsd;
    this.meter.reserve(estimate);
    let response: LlmResponse;
    try {
      response = await this.inner.complete(messages, tools, options);
    } finally {
      this.meter.release(estimate);
    }
    const usage = response.usage;
    const cost = usage?.costUsd ?? (usage && this.price ? costOf(usage, this.price) : undefined);
    if (cost === undefined) {
      if (usage) this.meter.unpricedCalls += 1;
    } else {
      this.meter.record(cost);
      this.lastCallUsd = cost;
    }
    return response;
  }

  /** Called by the engine before each step. */
  check(): SpendCheck {
    const blocked = this.blockReason();
    if (blocked) return { stop: true, reason: blocked };
    const cap = this.meter.capUsd;
    if (cap !== undefined && !this.nudged && this.meter.spentUsd >= cap * NUDGE_AT) {
      this.nudged = true;
      return {
        stop: false,
        nudge: `Budget check: about ${Math.round((this.meter.spentUsd / cap) * 100)}% of the spending cap is used. Finish the task now with the fewest steps: make sure the work on disk is complete and correct, verify it once, and give your final answer.`,
      };
    }
    return { stop: false };
  }

  private blockReason(): string | undefined {
    const cap = this.meter.capUsd;
    if (cap === undefined) return undefined;
    if (this.meter.unpricedCalls > 0 && !this.price) {
      return `Stopped: the provider did not say what ${this.model} costs, so the ${formatUsd(cap)} spending cap can't be enforced. Add a price for it under "pricing" in .revcode/config.json.`;
    }
    if (this.meter.wouldExceed(this.lastCallUsd)) {
      return `Spending cap reached: ${formatUsd(this.meter.spentUsd)} of ${formatUsd(cap)} used.`;
    }
    return undefined;
  }
}
