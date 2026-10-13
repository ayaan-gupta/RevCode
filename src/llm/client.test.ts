import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CreateLlmClientOptions,
  LLM_PROVIDERS,
  type LlmProvider,
  createLlmClient,
  isLlmProvider,
  resolveProvider,
} from "./client.js";
import { jsonResponse, stubFetch } from "./test-helpers.js";

const ENV_VARS = [
  "Z_AI_API_KEY",
  "ZAI_API_KEY",
  "Z_AI_BASE_URL",
  "ZAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENROUTER_API_KEY",
  "OLLAMA_HOST",
  "REVCODE_BASE_URL",
  "REVCODE_API_KEY",
  "REVCODE_LLM_TIMEOUT_MS",
  "REVCODE_NO_CACHE",
];

let workDir: string;

beforeEach(() => {
  // Empty values count as unset, which also neutralises the developer's real
  // environment; a scratch cwd keeps a real .env out of createLlmClient.
  for (const name of ENV_VARS) {
    vi.stubEnv(name, "");
  }
  workDir = mkdtempSync(path.join(tmpdir(), "revcode-llm-"));
  vi.spyOn(process, "cwd").mockReturnValue(workDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(workDir, { recursive: true, force: true });
});

/** Build a client, make one call, and return the HTTP request it sent. */
async function firstRequest(options: CreateLlmClientOptions) {
  const { requests } = stubFetch(() =>
    jsonResponse({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      content: [{ type: "text", text: "ok" }],
    }),
  );
  await createLlmClient(options).complete([{ role: "user", content: "hi" }]);
  return requests[0];
}

describe("LLM_PROVIDERS", () => {
  it("lists every provider the factory understands", () => {
    expect([...LLM_PROVIDERS]).toEqual([
      "zai",
      "anthropic",
      "openai",
      "openrouter",
      "ollama",
      "openai-compat",
      "local-test",
    ]);
  });

  it("narrows strings with isLlmProvider", () => {
    expect(isLlmProvider("ollama")).toBe(true);
    expect(isLlmProvider("gemini")).toBe(false);
  });
});

describe("resolveProvider", () => {
  const keys = {
    zai: { Z_AI_API_KEY: "z" },
    anthropic: { ANTHROPIC_API_KEY: "a" },
    openai: { OPENAI_API_KEY: "o" },
    openrouter: { OPENROUTER_API_KEY: "r" },
  };

  const cases: Array<{
    name: string;
    model: string;
    env: Record<string, string>;
    provider?: LlmProvider;
    expected: LlmProvider;
  }> = [
    { name: "an explicit provider always wins", model: "claude-x", env: keys.anthropic, provider: "ollama", expected: "ollama" },
    { name: "explicit provider needs no key", model: "whatever", env: {}, provider: "openai", expected: "openai" },
    { name: "model 'test' selects local-test", model: "test", env: keys.zai, expected: "local-test" },
    { name: "model 'local-test' selects local-test", model: "local-test", env: {}, expected: "local-test" },
    { name: "claude model + anthropic key", model: "claude-sonnet-5-5", env: keys.anthropic, expected: "anthropic" },
    { name: "claude model prefers anthropic over a z.ai key", model: "claude-opus-5-5", env: { ...keys.anthropic, ...keys.zai }, expected: "anthropic" },
    { name: "claude model without an anthropic key falls back to z.ai", model: "claude-sonnet-5-5", env: keys.zai, expected: "zai" },
    { name: "gpt- model + openai key", model: "gpt-4o", env: keys.openai, expected: "openai" },
    { name: "gpt-5 + openai key beats z.ai key", model: "gpt-5", env: { ...keys.openai, ...keys.zai }, expected: "openai" },
    { name: "o1 + openai key", model: "o1", env: keys.openai, expected: "openai" },
    { name: "o3-mini + openai key", model: "o3-mini", env: keys.openai, expected: "openai" },
    { name: "o4-mini + openai key", model: "o4-mini", env: keys.openai, expected: "openai" },
    { name: "gpt- model without an openai key falls back to z.ai", model: "gpt-4o", env: keys.zai, expected: "zai" },
    { name: "a model merely starting with 'o' is not an openai model", model: "olmo-2", env: keys.openai, expected: "zai" },
    { name: "vendor/model + openrouter key", model: "qwen/qwen3-coder", env: keys.openrouter, expected: "openrouter" },
    { name: "anthropic/claude on openrouter goes to openrouter", model: "anthropic/claude-sonnet-4", env: { ...keys.openrouter, ...keys.anthropic }, expected: "openrouter" },
    { name: "vendor/model without an openrouter key is not openrouter", model: "qwen/qwen3-coder", env: keys.zai, expected: "zai" },
    { name: "only an anthropic key", model: "glm-5.2", env: keys.anthropic, expected: "anthropic" },
    { name: "z.ai key present", model: "glm-5.2", env: keys.zai, expected: "zai" },
    { name: "both z.ai and anthropic keys, non-claude model", model: "glm-5.2", env: { ...keys.zai, ...keys.anthropic }, expected: "zai" },
    { name: "ZAI_API_KEY alias counts as a z.ai key", model: "glm-5.2", env: { ZAI_API_KEY: "z", ...keys.anthropic }, expected: "zai" },
    { name: "no keys at all defaults to z.ai", model: "glm-5.2", env: {}, expected: "zai" },
  ];

  it.each(cases)("$name", ({ model, env, provider, expected }) => {
    for (const [name, value] of Object.entries(env)) {
      vi.stubEnv(name, value);
    }
    expect(resolveProvider(provider, model)).toBe(expected);
  });
});

describe("createLlmClient: missing configuration", () => {
  it.each([
    ["zai", "Z_AI_API_KEY"],
    ["anthropic", "ANTHROPIC_API_KEY"],
    ["openai", "OPENAI_API_KEY"],
    ["openrouter", "OPENROUTER_API_KEY"],
    ["openai-compat", "REVCODE_BASE_URL"],
  ] as const)("provider %s names %s in its error", (provider, variable) => {
    expect(() => createLlmClient({ provider, model: "some-model" })).toThrow(variable);
  });

  it("keeps the documented z.ai error message", () => {
    expect(() => createLlmClient({ provider: "zai", model: "glm-5.2" })).toThrow(
      "No LLM client configured for model: glm-5.2. Set Z_AI_API_KEY",
    );
  });

  it("requires a model for providers without a default", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk");
    expect(() => createLlmClient({ provider: "openai", model: " " })).toThrow(/model name is required/);
  });

  it("does not need any key for ollama or local-test", () => {
    expect(() => createLlmClient({ provider: "ollama", model: "llama3.1" })).not.toThrow();
    expect(() => createLlmClient({ provider: "local-test", model: "x" })).not.toThrow();
  });
});

describe("createLlmClient: zai", () => {
  it("keeps the Z.ai defaults", async () => {
    vi.stubEnv("Z_AI_API_KEY", "zk");

    const request = await firstRequest({ model: "glm-5.2" });

    expect(request.url).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");
    expect(request.headers.authorization).toBe("Bearer zk");
    expect(request.headers["accept-language"]).toBe("en-US,en");
    expect(request.body).toMatchObject({ model: "glm-5.2", temperature: 0.2, max_tokens: 16_384 });
  });

  it("falls back to glm-5.2 for an empty model", async () => {
    vi.stubEnv("Z_AI_API_KEY", "zk");
    expect((await firstRequest({ provider: "zai", model: "" })).body.model).toBe("glm-5.2");
  });

  it("accepts ZAI_API_KEY and both base URL variables", async () => {
    vi.stubEnv("ZAI_API_KEY", "alias-key");
    vi.stubEnv("ZAI_BASE_URL", "https://zai-alias.test/v4/");

    const request = await firstRequest({ model: "glm-5.2" });
    expect(request.headers.authorization).toBe("Bearer alias-key");
    expect(request.url).toBe("https://zai-alias.test/v4/chat/completions");

    vi.stubEnv("Z_AI_BASE_URL", "https://primary.test/v4");
    expect((await firstRequest({ model: "glm-5.2" })).url).toBe("https://primary.test/v4/chat/completions");
  });

  it("lets baseUrl/apiKey options override the environment", async () => {
    vi.stubEnv("Z_AI_API_KEY", "env-key");
    vi.stubEnv("Z_AI_BASE_URL", "https://env.test/v4");

    const request = await firstRequest({
      model: "glm-5.2",
      baseUrl: "https://flag.test/v4",
      apiKey: "flag-key",
    });

    expect(request.url).toBe("https://flag.test/v4/chat/completions");
    expect(request.headers.authorization).toBe("Bearer flag-key");
  });

  it("works with only an apiKey option and no environment", async () => {
    expect((await firstRequest({ provider: "zai", model: "glm-5.2", apiKey: "k" })).headers.authorization).toBe(
      "Bearer k",
    );
  });
});

describe("createLlmClient: openai", () => {
  it("targets api.openai.com with max_completion_tokens", async () => {
    vi.stubEnv("OPENAI_API_KEY", "ok");

    const request = await firstRequest({ model: "gpt-4o" });

    expect(request.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(request.headers.authorization).toBe("Bearer ok");
    expect(request.body).toMatchObject({ model: "gpt-4o", max_completion_tokens: 16_384, temperature: 0.2 });
    expect(request.body).not.toHaveProperty("max_tokens");
  });

  it.each(["o3-mini", "o1", "gpt-5"])("does not send temperature to reasoning model %s", async (model) => {
    vi.stubEnv("OPENAI_API_KEY", "ok");

    const { requests } = stubFetch(() => jsonResponse({ choices: [{ message: { content: "" } }] }));
    await createLlmClient({ model }).complete([{ role: "user", content: "hi" }], [], { temperature: 0.5 });

    expect(requests[0].body).not.toHaveProperty("temperature");
  });

  it("honors OPENAI_BASE_URL and the baseUrl option, in that precedence", async () => {
    vi.stubEnv("OPENAI_API_KEY", "ok");
    vi.stubEnv("OPENAI_BASE_URL", "https://proxy.test/openai/v1");
    expect((await firstRequest({ provider: "openai", model: "gpt-4o" })).url).toBe(
      "https://proxy.test/openai/v1/chat/completions",
    );

    expect(
      (await firstRequest({ provider: "openai", model: "gpt-4o", baseUrl: "https://flag.test/v1" })).url,
    ).toBe("https://flag.test/v1/chat/completions");
  });
});

describe("createLlmClient: openrouter", () => {
  it("targets openrouter.ai and passes vendor/model ids through", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "rk");

    const request = await firstRequest({ model: "qwen/qwen3-coder" });

    expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(request.headers.authorization).toBe("Bearer rk");
    expect(request.headers["x-title"]).toBe("RevCode");
    expect(request.body).toMatchObject({ model: "qwen/qwen3-coder", max_tokens: 16_384 });
  });
});

describe("createLlmClient: ollama", () => {
  it("defaults to localhost:11434/v1 and sends no Authorization header", async () => {
    const request = await firstRequest({ provider: "ollama", model: "qwen2.5-coder:7b" });

    expect(request.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(request.headers).not.toHaveProperty("authorization");
    expect(request.body.model).toBe("qwen2.5-coder:7b");
  });

  it.each([
    ["http://gpu-box:11434", "http://gpu-box:11434/v1"],
    ["http://gpu-box:11434/", "http://gpu-box:11434/v1"],
    ["https://ollama.example.com", "https://ollama.example.com/v1"],
    ["gpu-box", "http://gpu-box:11434/v1"],
    ["127.0.0.1:8080", "http://127.0.0.1:8080/v1"],
    ["http://gpu-box:11434/v1", "http://gpu-box:11434/v1"],
  ])("OLLAMA_HOST=%s", async (host, expectedBase) => {
    vi.stubEnv("OLLAMA_HOST", host);
    expect((await firstRequest({ provider: "ollama", model: "m" })).url).toBe(
      `${expectedBase}/chat/completions`,
    );
  });

  it("sends a key when one is provided explicitly", async () => {
    const request = await firstRequest({ provider: "ollama", model: "m", apiKey: "cloud-key" });
    expect(request.headers.authorization).toBe("Bearer cloud-key");
  });
});

describe("createLlmClient: openai-compat", () => {
  it("uses REVCODE_BASE_URL without requiring a key", async () => {
    vi.stubEnv("REVCODE_BASE_URL", "http://localhost:8000/v1");

    const request = await firstRequest({ provider: "openai-compat", model: "my-model" });

    expect(request.url).toBe("http://localhost:8000/v1/chat/completions");
    expect(request.headers).not.toHaveProperty("authorization");
  });

  it("sends REVCODE_API_KEY when set", async () => {
    vi.stubEnv("REVCODE_BASE_URL", "http://localhost:1234/v1");
    vi.stubEnv("REVCODE_API_KEY", "local-key");

    const request = await firstRequest({ provider: "openai-compat", model: "my-model" });
    expect(request.headers.authorization).toBe("Bearer local-key");
  });

  it("prefers the baseUrl/apiKey options", async () => {
    vi.stubEnv("REVCODE_BASE_URL", "http://env.test/v1");
    vi.stubEnv("REVCODE_API_KEY", "env-key");

    const request = await firstRequest({
      provider: "openai-compat",
      model: "m",
      baseUrl: "http://flag.test/v1",
      apiKey: "flag-key",
    });

    expect(request.url).toBe("http://flag.test/v1/chat/completions");
    expect(request.headers.authorization).toBe("Bearer flag-key");
  });

  it("works with only the baseUrl option (CLI --base-url)", async () => {
    const request = await firstRequest({ provider: "openai-compat", model: "m", baseUrl: "http://x.test/v1" });
    expect(request.url).toBe("http://x.test/v1/chat/completions");
  });
});

describe("createLlmClient: anthropic", () => {
  it("targets api.anthropic.com with the default model when none is given", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "ak");

    const request = await firstRequest({ provider: "anthropic", model: "" });

    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers["x-api-key"]).toBe("ak");
    expect(request.body.model).toBe("claude-sonnet-5-5");
  });

  it.each([
    ["https://gateway.test", "https://gateway.test/v1/messages"],
    ["https://gateway.test/", "https://gateway.test/v1/messages"],
    ["https://gateway.test/v1", "https://gateway.test/v1/messages"],
    ["https://gateway.test/prefix/v1/", "https://gateway.test/prefix/v1/messages"],
  ])("ANTHROPIC_BASE_URL=%s", async (base, expected) => {
    vi.stubEnv("ANTHROPIC_API_KEY", "ak");
    vi.stubEnv("ANTHROPIC_BASE_URL", base);

    expect((await firstRequest({ model: "claude-sonnet-5-5" })).url).toBe(expected);
  });

  it("prefers the baseUrl and apiKey options", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "env-key");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://env.test");

    const request = await firstRequest({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      baseUrl: "https://flag.test/v1",
      apiKey: "flag-key",
    });

    expect(request.url).toBe("https://flag.test/v1/messages");
    expect(request.headers["x-api-key"]).toBe("flag-key");
  });
});

describe("createLlmClient: provider inference end to end", () => {
  it("routes a claude model to Anthropic and a vendor/model id to OpenRouter", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "ak");
    vi.stubEnv("OPENROUTER_API_KEY", "rk");
    vi.stubEnv("Z_AI_API_KEY", "zk");

    expect((await firstRequest({ model: "claude-sonnet-5-5" })).url).toContain("api.anthropic.com");
    expect((await firstRequest({ model: "qwen/qwen3-coder" })).url).toContain("openrouter.ai");
    expect((await firstRequest({ model: "glm-5.2" })).url).toContain("api.z.ai");
  });
});

describe("createLlmClient: local-test", () => {
  it("returns the offline client", async () => {
    const response = await createLlmClient("local-test").complete([{ role: "user", content: "hello" }]);
    expect(response.content).toContain("Local test client is active");
  });
});

describe("loadDotEnv via createLlmClient", () => {
  it("fills unset variables from .env but never overrides existing ones", async () => {
    writeFileSync(
      path.join(workDir, ".env"),
      [
        "# comment",
        'REVCODE_BASE_URL="http://from-dotenv.test/v1"',
        "REVCODE_API_KEY='dotenv-key'",
        "OLLAMA_HOST=http://ignored.test:1",
      ].join("\n"),
    );
    // Unset (not empty) so the .env value may apply; the other stays set.
    vi.stubEnv("REVCODE_BASE_URL", undefined);
    vi.stubEnv("REVCODE_API_KEY", "real-env-key");

    const request = await firstRequest({ provider: "openai-compat", model: "m" });

    expect(request.url).toBe("http://from-dotenv.test/v1/chat/completions");
    expect(request.headers.authorization).toBe("Bearer real-env-key");
  });
});
