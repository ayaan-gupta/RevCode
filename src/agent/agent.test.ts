import { describe, expect, it } from "vitest";
import { Agent, SUGGESTED_GLM_MODELS } from "./agent.js";

describe("Agent model switching", () => {
  it("updates the current model and renderer state", () => {
    const agent = new Agent({
      cwd: process.cwd(),
      model: "glm-4.7",
      provider: "local-test",
      headless: false,
      maxIterations: 5,
    });

    expect(agent.getCurrentModel()).toBe("glm-4.7");
    agent.setModel("glm-5.2");
    expect(agent.getCurrentModel()).toBe("glm-5.2");
  });

  it("rejects empty model names", () => {
    const agent = new Agent({
      cwd: process.cwd(),
      model: "glm-4.7",
      provider: "local-test",
      headless: false,
      maxIterations: 5,
    });

    expect(() => agent.setModel("   ")).toThrow("Model name cannot be empty");
  });

  it("exposes suggested GLM models", () => {
    expect(SUGGESTED_GLM_MODELS).toContain("glm-4.7");
    expect(SUGGESTED_GLM_MODELS).toContain("glm-5.2");
  });
});
