/**
 * Tool: update_plan — a lightweight, ordered checklist the agent maintains to
 * structure multi-step work. Keeping an explicit plan helps the model stay on
 * track across long TerminalBench tasks and gives the user visibility.
 */

export type PlanStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
  step: string;
  status: PlanStatus;
}

export interface UpdatePlanInput {
  steps: PlanStep[];
}

export interface UpdatePlanOutput {
  ok: true;
  steps: PlanStep[];
}

const STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

/** Holds the agent's current plan so the renderer can display it. */
export class PlanStore {
  private steps: PlanStep[] = [];

  set(steps: PlanStep[]): void {
    this.steps = steps;
  }

  get(): PlanStep[] {
    return this.steps;
  }
}

export function updatePlan(input: UpdatePlanInput, store: PlanStore): UpdatePlanOutput {
  const steps = normalizeSteps(input);
  store.set(steps);
  return { ok: true, steps };
}

function normalizeSteps(input: UpdatePlanInput): PlanStep[] {
  if (typeof input !== "object" || input === null || !Array.isArray(input.steps)) {
    throw new Error("update_plan requires a `steps` array");
  }

  return input.steps.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`Plan step ${index} must be an object with 'step' and 'status'`);
    }
    const step = (raw as unknown as Record<string, unknown>).step;
    const status = (raw as unknown as Record<string, unknown>).status;
    if (typeof step !== "string" || step.trim().length === 0) {
      throw new Error(`Plan step ${index} must have a non-empty 'step' string`);
    }
    const normalizedStatus = typeof status === "string" ? status : "pending";
    if (!STATUSES.has(normalizedStatus)) {
      throw new Error(
        `Plan step ${index} has invalid status "${normalizedStatus}" (expected pending|in_progress|completed)`,
      );
    }
    return { step: step.trim(), status: normalizedStatus as PlanStatus };
  });
}
