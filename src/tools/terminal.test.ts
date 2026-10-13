import { afterEach, describe, expect, it } from "vitest";
import { isTmuxAvailable, TerminalManager } from "./terminal.js";

const tmux = isTmuxAvailable();
const managers: TerminalManager[] = [];
afterEach(() => {
  while (managers.length) managers.pop()?.dispose();
});

function manager(): TerminalManager {
  const m = new TerminalManager(process.cwd());
  managers.push(m);
  return m;
}

describe.skipIf(!tmux)("terminal tool (tmux)", () => {
  it("drives a Python REPL: start, type, read the screen", async () => {
    const term = manager();
    const started = await term.execute({ action: "start", command: "python3 -q", session: "py" });
    expect(started.alive).toBe(true);

    const sent = await term.execute({ action: "send", session: "py", text: "print(6 * 7)", keys: ["Enter"] });
    expect(sent.screen).toContain("42");

    const second = await term.execute({ action: "send", session: "py", text: "x = 'hello'", keys: ["Enter"] });
    expect(second.alive).toBe(true);
    const third = await term.execute({ action: "send", session: "py", text: "x.upper()", keys: ["Enter"] });
    expect(third.screen).toContain("'HELLO'");
  });

  it("reports when the program exits, with its exit code", async () => {
    const term = manager();
    await term.execute({ action: "start", command: "python3 -q", session: "py" });
    const exited = await term.execute({ action: "send", session: "py", text: "import sys; sys.exit(3)", keys: ["Enter"], wait_ms: 3000 });
    expect(exited.alive).toBe(false);
    expect(exited.exitCode).toBe(3);
    expect(exited.note).toContain("exited");
  });

  it("answers interactive prompts (a program that reads stdin)", async () => {
    const term = manager();
    const started = await term.execute({ action: "start", command: 'read -p "Your name? " n; echo "Hello, $n!"; sleep 30', session: "ask" });
    expect(started.screen).toContain("Your name?");
    const answered = await term.execute({ action: "send", session: "ask", text: "Ada", keys: ["Enter"] });
    expect(answered.screen).toContain("Hello, Ada!");
  });

  it("supports special keys (Ctrl-C interrupts a running command)", async () => {
    const term = manager();
    await term.execute({ action: "start", session: "sh" });
    await term.execute({ action: "send", session: "sh", text: "sleep 100", keys: ["Enter"], wait_ms: 500 });
    const interrupted = await term.execute({ action: "send", session: "sh", keys: ["C-c"], wait_ms: 1500 });
    expect(interrupted.screen).toMatch(/\^C|\$/);
    const after = await term.execute({ action: "send", session: "sh", text: "echo back-again", keys: ["Enter"] });
    expect(after.screen).toContain("back-again");
  });

  it("manages several sessions and rejects bad usage", async () => {
    const term = manager();
    await term.execute({ action: "start", command: "cat", session: "one" });
    await term.execute({ action: "start", command: "cat", session: "two" });
    expect((await term.execute({ action: "list" })).sessions?.sort()).toEqual(["one", "two"]);
    await expect(term.execute({ action: "start", command: "cat", session: "one" })).rejects.toThrow(/already exists/);
    await expect(term.execute({ action: "send", session: "nope", text: "x" })).rejects.toThrow(/no terminal session/);
    await expect(term.execute({ action: "send", session: "one" })).rejects.toThrow(/text and\/or keys/);
    await expect(term.execute({ action: "start", session: "bad name!" })).rejects.toThrow(/invalid terminal session name/);
    expect((await term.execute({ action: "kill", session: "one" })).alive).toBe(false);
    expect((await term.execute({ action: "list" })).sessions).toEqual(["two"]);
  });

  it("types text literally (special characters are not interpreted as keys)", async () => {
    const term = manager();
    await term.execute({ action: "start", command: "cat", session: "lit" });
    const out = await term.execute({ action: "send", session: "lit", text: "a;b $HOME 'q' \"d\" Enter C-c", keys: ["Enter"] });
    expect(out.screen).toContain("a;b $HOME 'q' \"d\" Enter C-c");
  });

  it("cleans up its tmux server on dispose", async () => {
    const term = manager();
    await term.execute({ action: "start", command: "cat", session: "x" });
    term.dispose();
    await expect(term.execute({ action: "read", session: "x" })).rejects.toThrow(/no terminal session/);
  });
});

describe("terminal tool availability", () => {
  it("detects tmux without throwing", () => {
    expect(typeof isTmuxAvailable()).toBe("boolean");
  });
});
