import { describe, expect, it } from "vitest";
import { forChildShell, nodeSupportsEnvProxy, shouldReexecForProxy } from "./env-proxy.js";

describe("nodeSupportsEnvProxy", () => {
  it("knows which Node releases have NODE_USE_ENV_PROXY", () => {
    expect(nodeSupportsEnvProxy("22.20.0")).toBe(false);
    expect(nodeSupportsEnvProxy("22.21.0")).toBe(true);
    expect(nodeSupportsEnvProxy("22.22.0")).toBe(true);
    expect(nodeSupportsEnvProxy("23.9.0")).toBe(false);
    expect(nodeSupportsEnvProxy("24.0.0")).toBe(true);
    expect(nodeSupportsEnvProxy("20.18.0")).toBe(false);
  });
});

describe("shouldReexecForProxy", () => {
  const proxied = { HTTPS_PROXY: "http://127.0.0.1:3128" };

  it("re-launches when a proxy is configured and Node can use it", () => {
    expect(shouldReexecForProxy(proxied, "22.22.0")).toBe(true);
    expect(shouldReexecForProxy({ http_proxy: "http://p:1" }, "24.1.0")).toBe(true);
  });

  it("does nothing without a proxy, on old Node, or when already enabled/opted out", () => {
    expect(shouldReexecForProxy({}, "22.22.0")).toBe(false);
    expect(shouldReexecForProxy(proxied, "20.18.0")).toBe(false);
    expect(shouldReexecForProxy({ ...proxied, NODE_USE_ENV_PROXY: "1" }, "22.22.0")).toBe(false);
    expect(shouldReexecForProxy({ ...proxied, REVCODE_NO_PROXY_REEXEC: "1" }, "22.22.0")).toBe(false);
  });
});

describe("forChildShell", () => {
  it("drops the flag RevCode added when it re-launched itself", () => {
    const env = { PATH: "/bin", NODE_USE_ENV_PROXY: "1", REVCODE_PROXY_REEXEC: "1" };
    expect(forChildShell(env)).toEqual({ PATH: "/bin" });
  });

  it("keeps a flag the user set themselves", () => {
    const env = { PATH: "/bin", NODE_USE_ENV_PROXY: "1" };
    expect(forChildShell(env)).toBe(env);
  });
});
