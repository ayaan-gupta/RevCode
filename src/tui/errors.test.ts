import { describe, expect, it } from "vitest";
import { explainError } from "./errors.js";

describe("explainError", () => {
  it("recognizes bad credentials", () => {
    const e = explainError("zai API request failed (401): invalid api key", "zai");
    expect(e.headline).toContain("rejected the credentials");
    expect(e.hint).toContain("revcode setup");
  });

  it("recognizes rate limits and quota", () => {
    expect(explainError("openai API request failed (429): Rate limit reached", "openai").headline).toContain("rate-limiting");
    expect(explainError("x failed (400): insufficient balance", "zai").headline).toContain("out of quota");
  });

  it("recognizes context overflow", () => {
    const e = explainError("API request failed (400): This model's maximum context length is 8192 tokens", "openai");
    expect(e.hint).toContain("/compact");
  });

  it("recognizes server errors and network failures", () => {
    expect(explainError("API request failed (503): overloaded", "zai").headline).toContain("server error");
    expect(explainError("fetch failed (ECONNREFUSED)", "ollama").headline).toContain("Could not reach");
  });

  it("recognizes missing credentials", () => {
    expect(explainError("No LLM client configured for model: glm. Set Z_AI_API_KEY", "zai").headline).toContain("No credentials");
  });

  it("falls back to the raw message, trimmed", () => {
    expect(explainError("something odd", "zai")).toEqual({ headline: "something odd" });
    expect(explainError("x".repeat(500), "zai").headline.length).toBeLessThan(310);
  });
});
