import { describe, expect, it } from "vitest";
import { PlanStore, updatePlan } from "./plan.js";

describe("updatePlan", () => {
  it("stores and returns normalized steps", () => {
    const store = new PlanStore();
    const out = updatePlan(
      {
        steps: [
          { step: "  install deps  ", status: "completed" },
          { step: "write server", status: "in_progress" },
        ],
      },
      store,
    );
    expect(out.ok).toBe(true);
    expect(store.get()).toEqual([
      { step: "install deps", status: "completed" },
      { step: "write server", status: "in_progress" },
    ]);
  });

  it("defaults a missing status to pending", () => {
    const store = new PlanStore();
    const out = updatePlan({ steps: [{ step: "x" } as never] }, store);
    expect(out.steps[0].status).toBe("pending");
  });

  it("rejects an invalid status", () => {
    const store = new PlanStore();
    expect(() => updatePlan({ steps: [{ step: "x", status: "doing" as never }] }, store)).toThrow(
      /invalid status/,
    );
  });

  it("rejects a non-array steps payload", () => {
    const store = new PlanStore();
    expect(() => updatePlan({ steps: "nope" as never }, store)).toThrow(/steps/);
  });
});
