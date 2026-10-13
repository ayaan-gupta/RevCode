import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "./version.js";

describe("version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
