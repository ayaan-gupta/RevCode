/**
 * Wall-clock budget for a run.
 *
 * Benchmark and CI runs have a hard time limit, and a timed-out agent is graded
 * on whatever happens to be on disk. The budget makes the model aware of the
 * clock: it nudges at 50% / 80% / 92% (leave a valid artifact, stop exploring,
 * wrap up) and tells the engine to stop cleanly just before the limit.
 */

export interface BudgetCheck {
  fraction: number;
  /** Message to inject for the model (once per threshold). */
  nudge?: string;
  /** The run should end now. */
  expired: boolean;
}

interface Threshold {
  at: number;
  text: (remaining: string) => string;
}

const THRESHOLDS: Threshold[] = [
  {
    at: 0.5,
    text: (left) =>
      `Time check: about half of your time budget is used (~${left} left). Make sure a valid, working version of the deliverable already exists on disk, then refine it. Prefer a complete simple solution over an unfinished ambitious one.`,
  },
  {
    at: 0.8,
    text: (left) =>
      `Time is running low (~${left} left). Stop exploring and finish the deliverable now, then verify it once.`,
  },
  {
    at: 0.92,
    text: (left) =>
      `Almost out of time (~${left} left). Leave the best complete state you have on disk and give your final answer now.`,
  },
];

export class TimeBudget {
  private readonly startedAt: number;
  private fired = 0;

  constructor(
    readonly totalMs: number,
    private readonly now: () => number = Date.now,
    /** Fraction at which the engine stops the run. */
    private readonly stopAt = 0.97,
  ) {
    this.startedAt = now();
  }

  elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  /** Milliseconds until the engine must stop the run (never negative). */
  msUntilStop(): number {
    return Math.max(0, this.totalMs * this.stopAt - this.elapsedMs());
  }

  check(): BudgetCheck {
    const fraction = this.elapsedMs() / this.totalMs;
    let nudge: string | undefined;
    while (this.fired < THRESHOLDS.length && fraction >= THRESHOLDS[this.fired].at) {
      // If we skipped several thresholds at once, only the latest message matters.
      nudge = THRESHOLDS[this.fired].text(formatRemaining(this.totalMs - this.elapsedMs()));
      this.fired += 1;
    }
    return { fraction, nudge, expired: fraction >= this.stopAt };
  }
}

function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  return `${Math.round(seconds / 60)} min`;
}

/** Read a budget (seconds) from REVCODE_TIME_BUDGET_SEC, if set. */
export function timeBudgetFromEnv(env: NodeJS.ProcessEnv = process.env): TimeBudget | undefined {
  const raw = env.REVCODE_TIME_BUDGET_SEC;
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? new TimeBudget(seconds * 1000) : undefined;
}
