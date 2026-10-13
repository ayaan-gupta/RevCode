import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverCommands,
  expandCommand,
  findCommand,
  parseSlashInput,
  splitArgs,
  type CustomCommand,
} from "./commands.js";

let tmp: string;
let home: string;
let revcode: string;
let repo: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "revcode-commands-"));
  home = path.join(tmp, "home");
  revcode = path.join(home, ".revcode");
  repo = path.join(tmp, "repo");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeCommand(root: string, relative: string, content: string): string {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

const discover = (cwd = repo) => discoverCommands(cwd, { homeDir: home, revcodeHome: revcode });

function command(template: string, source: CustomCommand["source"] = "command"): CustomCommand {
  return { name: "t", description: "t", template, file: "/t.md", source, scope: "project" };
}

describe("discoverCommands", () => {
  it("names commands after files and nests directories with a colon", () => {
    const root = path.join(repo, ".revcode", "commands");
    writeCommand(root, "review.md", "Review the diff.\n");
    writeCommand(root, "git/pr.md", "Open a PR.\n");
    writeCommand(root, "git/deep/rebase.md", "Rebase.\n");
    writeCommand(root, "notes.txt", "ignored");

    const { commands, warnings } = discover();
    expect(warnings).toEqual([]);
    expect(commands.map((c) => c.name)).toEqual(["git:deep:rebase", "git:pr", "review"]);
    expect(commands[2]).toMatchObject({ template: "Review the diff.", source: "command", scope: "project" });
  });

  it("reads description and argument-hint from frontmatter", () => {
    writeCommand(
      path.join(repo, ".claude", "commands"),
      "fix.md",
      "---\ndescription: Fix an issue\nargument-hint: <issue-number>\n---\nFix issue $1.\n",
    );
    expect(discover().commands[0]).toMatchObject({
      name: "fix",
      description: "Fix an issue",
      argumentHint: "<issue-number>",
      template: "Fix issue $1.",
    });
  });

  it("falls back to the first prompt line for the description", () => {
    writeCommand(path.join(repo, ".revcode", "commands"), "plain.md", "\n## Summarize the changes\nthen more\n");
    expect(discover().commands[0].description).toBe("Summarize the changes");
  });

  it("applies project over user and RevCode over Claude directories", () => {
    const sources: Array<[string, string]> = [
      [path.join(home, ".claude", "commands"), "user claude"],
      [path.join(revcode, "commands"), "user revcode"],
      [path.join(repo, ".claude", "commands"), "project claude"],
      [path.join(repo, ".revcode", "commands"), "project revcode"],
    ];
    const seen: string[] = [];
    for (const [root, text] of sources) {
      writeCommand(root, "shared.md", `${text}\n`);
      seen.push(text);
      expect(discover().commands.map((c) => c.template)).toEqual([text]);
    }
    expect(seen).toHaveLength(4);
  });

  it("collects commands from every directory between cwd and the git root", () => {
    const pkg = path.join(repo, "packages", "app");
    mkdirSync(pkg, { recursive: true });
    writeCommand(path.join(repo, ".revcode", "commands"), "outer.md", "outer\n");
    writeCommand(path.join(repo, ".revcode", "commands"), "both.md", "outer both\n");
    writeCommand(path.join(pkg, ".revcode", "commands"), "both.md", "inner both\n");

    const byName = Object.fromEntries(discover(pkg).commands.map((c) => [c.name, c.template]));
    expect(byName).toEqual({ outer: "outer", both: "inner both" });
  });

  it("marks home-directory commands as user scope", () => {
    writeCommand(path.join(home, ".claude", "commands"), "mine.md", "mine\n");
    expect(discover().commands[0]).toMatchObject({ name: "mine", scope: "user" });
  });

  it("skips bad files with a warning and keeps the rest", () => {
    const root = path.join(repo, ".revcode", "commands");
    writeCommand(root, "good.md", "fine\n");
    writeCommand(root, "bad name.md", "has a space\n");
    writeCommand(root, "empty.md", "---\ndescription: nothing\n---\n\n");
    writeCommand(root, "broken.md", "---\ndescription: x\nnot yaml\n---\nbody\n");
    writeCommand(root, ".hidden.md", "hidden\n");

    const { commands, warnings } = discover();
    expect(commands.map((c) => c.name)).toEqual(["good"]);
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toMatch(/not a valid command name/);
    expect(warnings.join("\n")).toMatch(/empty prompt/);
    expect(warnings.join("\n")).toMatch(/key: value/);
  });
});

describe("expandCommand", () => {
  it("replaces $ARGUMENTS with the raw argument string", () => {
    expect(expandCommand(command("Fix: $ARGUMENTS now"), "  the flaky test ")).toBe("Fix: the flaky test now");
    expect(expandCommand(command("$ARGUMENTS and $ARGUMENTS"), "x")).toBe("x and x");
  });

  it("replaces $1..$9 with shell-split arguments and blanks missing ones", () => {
    const template = "a=$1 b=$2 c=$3";
    expect(expandCommand(command(template), 'one "two words"')).toBe("a=one b=two words c=");
    expect(expandCommand(command("$9"), "1 2 3 4 5 6 7 8 nine")).toBe("nine");
  });

  it("does not rescan substituted text", () => {
    expect(expandCommand(command("$ARGUMENTS | $1"), "$1 $ARGUMENTS")).toBe("$1 $ARGUMENTS | $1");
  });

  it("leaves $10, $0 and lookalikes alone", () => {
    expect(expandCommand(command("$10 $0 $ARGUMENTSX $"), "a")).toBe("$10 $0 $ARGUMENTSX $\n\nARGUMENTS: a");
  });

  it("appends arguments when the template has no placeholder", () => {
    expect(expandCommand(command("Run the tests."), "in watch mode")).toBe("Run the tests.\n\nARGUMENTS: in watch mode");
  });

  it("does not append anything when there are no arguments", () => {
    expect(expandCommand(command("Run the tests."), "   ")).toBe("Run the tests.");
    expect(expandCommand(command("Hi $ARGUMENTS."), "")).toBe("Hi .");
  });

  it("treats a used placeholder as consumption, so nothing is appended", () => {
    expect(expandCommand(command("Look at $1"), "a.ts b.ts")).toBe("Look at a.ts");
  });

  it("only expands $ARGUMENTS for skill-sourced commands", () => {
    expect(expandCommand(command("echo $1 $ARGUMENTS", "skill"), "x y")).toBe("echo $1 x y");
  });
});

describe("splitArgs", () => {
  it.each([
    ["", []],
    ["  a   b ", ["a", "b"]],
    ['say "hello world" now', ["say", "hello world", "now"]],
    ["'single quoted' x", ["single quoted", "x"]],
    ["don't touch it", ["don't", "touch", "it"]],
    ['--name="a b" c', ["--name=a b", "c"]],
    ['"say \\"hi\\""', ['say "hi"']],
    ["C:\\temp\\file.txt", ["C:\\temp\\file.txt"]],
    ['""', [""]],
    ['unterminated "quote here', ["unterminated", "quote here"]],
  ])("splits %j", (input, expected) => {
    expect(splitArgs(input)).toEqual(expected);
  });
});

describe("parseSlashInput", () => {
  it("splits the name from the argument string", () => {
    expect(parseSlashInput("/review src/a.ts --strict")).toEqual({ name: "review", args: "src/a.ts --strict" });
    expect(parseSlashInput("  /fix   the bug  ")).toEqual({ name: "fix", args: "the bug" });
    expect(parseSlashInput("/help")).toEqual({ name: "help", args: "" });
    expect(parseSlashInput("/git:pr 12")).toEqual({ name: "git:pr", args: "12" });
    expect(parseSlashInput("/v1.2-test x")).toEqual({ name: "v1.2-test", args: "x" });
  });

  it("keeps multi-line arguments intact", () => {
    expect(parseSlashInput("/ask first line\nsecond line")).toEqual({ name: "ask", args: "first line\nsecond line" });
  });

  it.each(["", "hello", "/", "/ review", "//comment", "/usr/bin/env node", "/path/to/file", "please /review"])(
    "rejects %j",
    (line) => {
      expect(parseSlashInput(line)).toBeUndefined();
    },
  );
});

describe("findCommand", () => {
  const commands = [command("a"), { ...command("b"), name: "Deploy" }];

  it("matches exactly first, then case-insensitively, ignoring a leading slash", () => {
    expect(findCommand(commands, "t")?.template).toBe("a");
    expect(findCommand(commands, "/deploy")?.name).toBe("Deploy");
    expect(findCommand(commands, "nope")).toBeUndefined();
  });
});
