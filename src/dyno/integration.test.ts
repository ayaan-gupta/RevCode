/**
 * Pipeline sanity bounds for the built-in suite, run through the REAL runner,
 * runtime, engine and graders:
 *   - an "oracle" model that applies each task's reference solution must pass everything;
 *   - a "lazy" model that does nothing must fail everything.
 * If either bound breaks, a benchmark number from this harness cannot be trusted.
 */

import { describe, expect, it } from "vitest";
import type { CompleteOptions, LlmClient, LlmMessage, LlmResponse, ToolDefinition } from "../llm/client.js";
import { DEFAULT_PROFILE } from "../harness/profile.js";
import { runDynoTask } from "./runner.js";
import { withPortLock } from "./suite/helpers.js";
import { BUILTIN_SUITE } from "./suite/index.js";

// The serve task binds this fixed port, and other test files (running in parallel workers) use it too.
const SERVE_PORT = 18417;
import type { DynoTask } from "./types.js";

/** Applies the task's reference solution to the working directory named in the system prompt. */
class OracleModel implements LlmClient {
  constructor(private readonly task: DynoTask) {}
  async complete(messages: LlmMessage[], _tools?: ToolDefinition[], _options?: CompleteOptions): Promise<LlmResponse> {
    const dir = /Working directory: (.+)/.exec(messages[0].content)?.[1]?.trim();
    if (!dir) throw new Error("working directory not found in the system prompt");
    await this.task.oracle(dir);
    return { content: "Done.", toolCalls: [] };
  }
}

class LazyModel implements LlmClient {
  async complete(): Promise<LlmResponse> {
    return { content: "I looked at it and I think it is fine as it is.", toolCalls: [] };
  }
}

describe("built-in Dyno suite through the real runner", () => {
  it("passes every task when the model applies the reference solution", async () => {
    const failures: string[] = [];
    // Serial on purpose, and under the port lock: one task binds a fixed port.
    await withPortLock(SERVE_PORT, async () => {
      for (const task of BUILTIN_SUITE) {
        const result = await runDynoTask({ task, profile: DEFAULT_PROFILE, llm: new OracleModel(task), model: "oracle", provider: "local-test" });
        if (!result.passed) failures.push(`${task.id}: ${result.detail} ${result.error ?? ""}`);
      }
    });
    expect(failures).toEqual([]);
  }, 400_000);

  it("fails every task when the model does nothing", async () => {
    const passed: string[] = [];
    await withPortLock(SERVE_PORT, async () => {
      for (const task of BUILTIN_SUITE) {
        const result = await runDynoTask({ task, profile: DEFAULT_PROFILE, llm: new LazyModel(), model: "lazy", provider: "local-test" });
        if (result.passed) passed.push(task.id);
      }
    });
    expect(passed).toEqual([]);
  }, 400_000);
});
