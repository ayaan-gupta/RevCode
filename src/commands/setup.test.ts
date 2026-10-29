import { afterEach, describe, expect, it, vi } from "vitest";
import { missingCredentials } from "./setup.js";

afterEach(() => vi.unstubAllEnvs());

describe("missingCredentials", () => {
  it("is satisfied by a provider key in the environment", () => {
    vi.stubEnv("Z_AI_API_KEY", "k");
    expect(missingCredentials({ provider: "zai", model: "glm-5.2" })).toBeUndefined();
  });

  it("asks for setup when the key is missing", () => {
    vi.stubEnv("Z_AI_API_KEY", "");
    expect(missingCredentials({ provider: "zai", model: "glm-5.2" })).toMatchObject({ provider: "zai" });
  });

  it("treats --base-url as the server for openai-compat", () => {
    vi.stubEnv("REVCODE_BASE_URL", "");
    vi.stubEnv("REVCODE_API_KEY", "");
    expect(missingCredentials({ provider: "openai-compat", model: "m" })).toMatchObject({ message: expect.stringContaining("No server configured") });
    expect(missingCredentials({ provider: "openai-compat", model: "m", baseUrl: "http://localhost:8000/v1" })).toBeUndefined();
  });
});
