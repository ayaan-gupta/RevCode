import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnvFiles, parseEnvText, saveUserEnv, userEnvFile } from "./env.js";

describe("env files", () => {
  const saved = { ...process.env };
  let home: string;
  let cwd: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "revcode-env-home-"));
    cwd = mkdtempSync(path.join(os.tmpdir(), "revcode-env-cwd-"));
    process.env.REVCODE_HOME = home;
    for (const key of ["REVCODE_T_A", "REVCODE_T_B", "REVCODE_T_C"]) delete process.env[key];
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("parses comments, quotes and export prefixes", () => {
    expect(parseEnvText('# c\nA=1\nexport B="two words"\nC=\'x\'\n\nbad line')).toEqual({ A: "1", B: "two words", C: "x" });
  });

  it("layers real env > ./.env > ~/.revcode/.env", () => {
    writeFileSync(path.join(home, ".env"), "REVCODE_T_A=home\nREVCODE_T_B=home\nREVCODE_T_C=home\n");
    writeFileSync(path.join(cwd, ".env"), "REVCODE_T_B=cwd\nREVCODE_T_C=cwd\n");
    process.env.REVCODE_T_C = "real";
    loadEnvFiles(cwd);
    expect(process.env.REVCODE_T_A).toBe("home");
    expect(process.env.REVCODE_T_B).toBe("cwd");
    expect(process.env.REVCODE_T_C).toBe("real");
  });

  it("saves keys to a private file, updating existing lines and keeping others", () => {
    writeFileSync(path.join(home, ".env"), "# mine\nKEEP=1\nREVCODE_T_A=old\n");
    saveUserEnv({ REVCODE_T_A: "new", REVCODE_T_B: "added" });
    const text = readFileSync(userEnvFile(), "utf8");
    expect(text).toBe("# mine\nKEEP=1\nREVCODE_T_A=new\nREVCODE_T_B=added\n");
    expect(statSync(userEnvFile()).mode & 0o777).toBe(0o600);
    expect(process.env.REVCODE_T_B).toBe("added");
  });
});
