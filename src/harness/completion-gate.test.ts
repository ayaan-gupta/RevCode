import { describe, expect, it } from "vitest";
import type { LlmToolCall } from "../llm/client.js";
import { createCompletionGate, isMutatingCall } from "./completion-gate.js";

const call = (name: string, args: Record<string, unknown> = {}): LlmToolCall => ({ id: "1", name, arguments: args });

function run(gate: ReturnType<typeof createCompletionGate>, name: string, args: Record<string, unknown> = {}, result: unknown = {}): void {
  void gate.middleware.after?.({ call: call(name, args), iteration: 0, result, durationMs: 1 });
}

const final = { finalContent: "done", turnToolCalls: 1 };

describe("isMutatingCall", () => {
  it("separates changing the project from inspecting or running it", () => {
    expect(isMutatingCall("write_file", { path: "a" })).toBe(true);
    expect(isMutatingCall("edit_file", {})).toBe(true);
    expect(isMutatingCall("read_file", {})).toBe(false);
    expect(isMutatingCall("shell", { command: "wc -c hello.txt && od -c hello.txt" })).toBe(false);
    expect(isMutatingCall("shell", { command: "git status --porcelain && ls -la" })).toBe(false);
    expect(isMutatingCall("shell", { command: "python3 test_calc.py; echo exit=$?" })).toBe(false);
    expect(isMutatingCall("shell", { command: "pytest -q 2>&1 | tail -5" })).toBe(false);
    expect(isMutatingCall("shell", { command: "rm -f scratch.txt" })).toBe(true);
    expect(isMutatingCall("shell", { command: "sed -i 's/a/b/' f.py" })).toBe(true);
    expect(isMutatingCall("shell", { command: "echo hi > out.txt" })).toBe(true);
    expect(isMutatingCall("shell", { command: "cat a >> b" })).toBe(true);
    expect(isMutatingCall("shell", { command: "pip install requests" })).toBe(true);
    expect(isMutatingCall("shell", { command: "make test 2>&1 | tee log.txt" })).toBe(true);
    expect(isMutatingCall("shell", { command: "python3 t.py 2>&1" })).toBe(false);
    expect(isMutatingCall("shell", { command: "python3 t.py > /dev/null" })).toBe(false);
  });
});

describe("completion gate", () => {
  it("challenges once after real work, then accepts a re-check that changes nothing", () => {
    const gate = createCompletionGate("make hello.txt", 2, (name) => name === "read_file");
    run(gate, "write_file", { path: "hello.txt" });
    run(gate, "read_file");

    const challenge = gate.gate.check(final) as string;
    expect(challenge).toContain("make hello.txt");

    run(gate, "shell", { command: "wc -c hello.txt && od -c hello.txt" });
    run(gate, "shell", { command: "git status --porcelain" });
    expect(gate.gate.check(final)).toBeUndefined();
  });

  it("challenges again when the audit led to a fix", () => {
    const gate = createCompletionGate("task", 2);
    run(gate, "write_file");
    expect(gate.gate.check(final)).toBeDefined();

    run(gate, "edit_file");
    expect(gate.gate.check(final)).toBeDefined();

    run(gate, "edit_file");
    expect(gate.gate.check(final)).toBeUndefined(); // capped at two challenges
  });

  it("does not count a failed edit as a fix", () => {
    const gate = createCompletionGate("task", 2);
    run(gate, "write_file");
    expect(gate.gate.check(final)).toBeDefined();
    run(gate, "edit_file", {}, { error: "oldText not found" });
    expect(gate.gate.check(final)).toBeUndefined();
  });

  it("never challenges a turn that only read things", () => {
    const gate = createCompletionGate("what does this do?", 2, (name) => name === "read_file");
    run(gate, "read_file");
    expect(gate.gate.check(final)).toBeUndefined();
  });

  it("starts fresh for each interactive turn", () => {
    const gate = createCompletionGate("one", 2);
    run(gate, "write_file");
    gate.gate.check(final);
    gate.setTask("two");
    run(gate, "shell", { command: "make build" });
    expect(gate.gate.check(final)).toContain("two");
  });
});
