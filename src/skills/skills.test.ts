import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandCommand } from "./commands.js";
import {
  createSkillTool,
  discoverSkills,
  skillToCommand,
  skillsPromptSection,
  type Skill,
} from "./skills.js";

let tmp: string;
let home: string;
let revcode: string;
let repo: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "revcode-skills-"));
  home = path.join(tmp, "home");
  revcode = path.join(home, ".revcode");
  repo = path.join(tmp, "repo");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeSkill(root: string, dir: string, frontmatter: string[], body = "Do the thing.\n"): string {
  const directory = path.join(root, dir);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "SKILL.md"), `---\n${frontmatter.join("\n")}\n---\n${body}`);
  return directory;
}

const discover = (cwd = repo) => discoverSkills(cwd, { homeDir: home, revcodeHome: revcode });

describe("discoverSkills", () => {
  it("returns nothing, without warnings, when no skill directories exist", () => {
    expect(discover()).toEqual({ skills: [], warnings: [] });
  });

  it("loads a skill with all fields and records its location", () => {
    const dir = writeSkill(
      path.join(repo, ".revcode", "skills"),
      "pdf-tools",
      [
        "name: pdf-tools",
        "description: |",
        "  Extract text from PDFs.",
        "  Use when asked about PDF files.",
        "allowed-tools: Read, Bash(pdftotext:*)",
        "disable-model-invocation: true",
        "argument-hint: <file>",
      ],
      "# PDF\n\nRun pdftotext.\n",
    );

    const { skills, warnings } = discover();
    expect(warnings).toEqual([]);
    expect(skills).toEqual([
      {
        name: "pdf-tools",
        description: "Extract text from PDFs.\nUse when asked about PDF files.",
        body: "# PDF\n\nRun pdftotext.",
        directory: dir,
        file: path.join(dir, "SKILL.md"),
        allowedTools: ["Read", "Bash(pdftotext:*)"],
        disableModelInvocation: true,
        argumentHint: "<file>",
        scope: "project",
      },
    ]);
  });

  it("applies precedence lowest to highest across user and project roots", () => {
    // Same name everywhere; the description records which root won.
    const roots = [
      path.join(revcode, "skills"),
      path.join(home, ".claude", "skills"),
      path.join(home, ".agents", "skills"),
      path.join(repo, ".claude", "skills"),
      path.join(repo, ".agents", "skills"),
      path.join(repo, ".revcode", "skills"),
    ];
    const expected: string[] = [];
    roots.forEach((root, index) => {
      writeSkill(root, "shared", ["name: shared", `description: from root ${index}`]);
      expected.push(`from root ${index}`);
      expect(discover().skills.map((skill) => skill.description)).toEqual([expected[index]]);
    });
  });

  it("marks user-level skills as user scope", () => {
    writeSkill(path.join(home, ".claude", "skills"), "mine", ["name: mine", "description: personal"]);
    expect(discover().skills[0]).toMatchObject({ name: "mine", scope: "user" });
  });

  it("walks up to the git root, with nearer directories overriding outer ones", () => {
    const pkg = path.join(repo, "packages", "app");
    mkdirSync(pkg, { recursive: true });
    writeSkill(path.join(repo, ".revcode", "skills"), "root-only", ["description: from the repo root"]);
    writeSkill(path.join(repo, ".revcode", "skills"), "both", ["description: outer"]);
    writeSkill(path.join(pkg, ".claude", "skills"), "both", ["description: inner"]);

    const names = Object.fromEntries(discover(pkg).skills.map((skill) => [skill.name, skill.description]));
    expect(names).toEqual({ "root-only": "from the repo root", both: "inner" });
  });

  it("only looks at cwd outside a git repository", () => {
    const loose = path.join(tmp, "loose");
    mkdirSync(path.join(loose, "sub"), { recursive: true });
    writeSkill(path.join(loose, ".revcode", "skills"), "parent", ["description: parent dir"]);
    expect(discover(path.join(loose, "sub")).skills).toEqual([]);
    expect(discover(loose).skills.map((skill) => skill.name)).toEqual(["parent"]);
  });

  it("does not let a home-level git root promote user skills to project precedence", () => {
    mkdirSync(path.join(home, ".git"), { recursive: true });
    writeSkill(path.join(home, ".claude", "skills"), "dup", ["description: from claude"]);
    writeSkill(path.join(home, ".agents", "skills"), "dup", ["description: from agents"]);
    const cwd = path.join(home, "work");
    mkdirSync(cwd, { recursive: true });

    // ~/.agents outranks ~/.claude at user level; the repo walk must not reorder that.
    expect(discover(cwd).skills[0]).toMatchObject({ description: "from agents", scope: "user" });
  });

  it("falls back to the directory name and sorts results by name", () => {
    const root = path.join(repo, ".revcode", "skills");
    writeSkill(root, "zeta", ["description: last"]);
    writeSkill(root, "alpha", ["name: alpha", "description: first"]);
    expect(discover().skills.map((skill) => skill.name)).toEqual(["alpha", "zeta"]);
  });

  it("trims the description to 1024 characters", () => {
    writeSkill(path.join(repo, ".revcode", "skills"), "long", ["name: long", `description: ${"x".repeat(2000)}`]);
    expect(discover().skills[0].description).toHaveLength(1024);
  });

  it("follows symlinked skill directories", () => {
    const real = writeSkill(path.join(tmp, "elsewhere"), "linked", ["name: linked", "description: via symlink"]);
    const root = path.join(repo, ".revcode", "skills");
    mkdirSync(root, { recursive: true });
    symlinkSync(real, path.join(root, "linked"));
    expect(discover().skills.map((skill) => skill.name)).toEqual(["linked"]);
  });

  it("ignores directories without SKILL.md and hidden directories silently", () => {
    const root = path.join(repo, ".revcode", "skills");
    mkdirSync(path.join(root, "not-a-skill"), { recursive: true });
    writeSkill(root, ".hidden", ["description: hidden"]);
    expect(discover()).toEqual({ skills: [], warnings: [] });
  });

  describe("malformed skills are skipped with a warning", () => {
    const root = () => path.join(repo, ".revcode", "skills");

    it.each([
      ["an invalid name", ["name: Bad_Name", "description: x"], /name "Bad_Name" must match/],
      ["a name that is too long", [`name: ${"a".repeat(65)}`, "description: x"], /must match/],
      ["a missing description", ["name: ok"], /"description" is required/],
      ["a blank description", ["name: ok", "description: '   '"], /"description" is required/],
      ["broken YAML", ["name: ok", "this is not yaml"], /key: value/],
    ])("%s", (_label, frontmatter, pattern) => {
      writeSkill(root(), "broken", frontmatter);
      writeSkill(root(), "fine", ["name: fine", "description: still loads"]);

      const { skills, warnings } = discover();
      expect(skills.map((skill) => skill.name)).toEqual(["fine"]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(path.join(root(), "broken", "SKILL.md"));
      expect(warnings[0]).toMatch(pattern);
    });

    it("a SKILL.md without frontmatter", () => {
      mkdirSync(path.join(root(), "plain"), { recursive: true });
      writeFileSync(path.join(root(), "plain", "SKILL.md"), "# Just markdown\n");
      const { skills, warnings } = discover();
      expect(skills).toEqual([]);
      expect(warnings[0]).toMatch(/missing YAML frontmatter/);
    });

    it("an unterminated frontmatter block", () => {
      mkdirSync(path.join(root(), "open"), { recursive: true });
      writeFileSync(path.join(root(), "open", "SKILL.md"), "---\nname: open\ndescription: x\nbody\n");
      expect(discover().warnings[0]).toMatch(/not closed/);
    });

    it("an empty body", () => {
      writeSkill(root(), "empty", ["name: empty", "description: nothing inside"], "\n\n");
      const { skills, warnings } = discover();
      expect(skills).toEqual([]);
      expect(warnings[0]).toMatch(/no instructions/);
    });

    it("duplicate names within one root keep the first and warn", () => {
      writeSkill(root(), "a-dir", ["name: twin", "description: first"]);
      writeSkill(root(), "b-dir", ["name: twin", "description: second"]);
      const { skills, warnings } = discover();
      expect(skills.map((skill) => skill.description)).toEqual(["first"]);
      expect(warnings[0]).toMatch(/Duplicate skill "twin"/);
    });
  });

  it("honours REVCODE_HOME when no override is given", () => {
    const previous = process.env.REVCODE_HOME;
    process.env.REVCODE_HOME = revcode;
    try {
      writeSkill(path.join(revcode, "skills"), "global", ["name: global", "description: from REVCODE_HOME"]);
      expect(discoverSkills(repo, { homeDir: home }).skills.map((skill) => skill.name)).toEqual(["global"]);
    } finally {
      if (previous === undefined) delete process.env.REVCODE_HOME;
      else process.env.REVCODE_HOME = previous;
    }
  });
});

function skill(overrides: Partial<Skill> & { name: string }): Skill {
  return {
    description: `Does ${overrides.name}`,
    body: `Instructions for ${overrides.name}`,
    directory: `/skills/${overrides.name}`,
    file: `/skills/${overrides.name}/SKILL.md`,
    allowedTools: [],
    disableModelInvocation: false,
    scope: "project",
    ...overrides,
  };
}

describe("skillsPromptSection", () => {
  it("is empty when there is nothing to advertise", () => {
    expect(skillsPromptSection([])).toBe("");
    expect(skillsPromptSection([skill({ name: "hidden", disableModelInvocation: true })])).toBe("");
  });

  it("lists only name and one-line description, never the body", () => {
    const section = skillsPromptSection([
      skill({ name: "pdf", description: "Extract text\nfrom PDFs.", body: "SECRET BODY" }),
      skill({ name: "manual", disableModelInvocation: true }),
    ]);
    expect(section).toContain("- pdf: Extract text from PDFs.");
    expect(section).not.toContain("SECRET BODY");
    expect(section).not.toContain("manual");
    expect(section).toContain("`use_skill`");
  });

  it("shrinks descriptions evenly when the listing would blow the budget", () => {
    const many = Array.from({ length: 40 }, (_, i) => skill({ name: `skill-${i}`, description: "d".repeat(1000) }));
    const section = skillsPromptSection(many);
    expect(section.length).toBeLessThan(10_000);
    expect(section).toContain("skill-39: ddd");
    expect(section).toContain("…");
  });

  it("keeps full descriptions when they fit", () => {
    const section = skillsPromptSection([skill({ name: "a", description: "x".repeat(900) })]);
    expect(section).toContain("x".repeat(900));
    expect(section).not.toContain("…");
  });
});

describe("use_skill tool", () => {
  it("has a schema that requires a name and takes optional arguments", () => {
    const tool = createSkillTool([]);
    expect(tool.definition.name).toBe("use_skill");
    expect(tool.definition.parameters).toMatchObject({
      required: ["name"],
      properties: { name: { type: "string" }, arguments: { type: "string" } },
    });
  });

  it("returns the instructions, directory and sibling files", async () => {
    const dir = writeSkill(path.join(repo, ".revcode", "skills"), "pdf", ["name: pdf", "description: pdfs"], "Step 1\n");
    mkdirSync(path.join(dir, "scripts"));
    writeFileSync(path.join(dir, "scripts", "extract.py"), "print()");
    writeFileSync(path.join(dir, "REFERENCE.md"), "ref");
    mkdirSync(path.join(dir, ".git"));
    writeFileSync(path.join(dir, ".git", "config"), "x");

    const tool = createSkillTool(discover().skills);
    const result = await tool.handler({ name: "pdf" });
    expect(result).toEqual({
      name: "pdf",
      instructions: "Step 1",
      directory: dir,
      files: ["REFERENCE.md", "scripts/extract.py"],
    });
  });

  it("caps the file list at 50 and says so", async () => {
    const dir = writeSkill(path.join(repo, ".revcode", "skills"), "big", ["name: big", "description: lots of files"]);
    for (let i = 0; i < 60; i += 1) {
      writeFileSync(path.join(dir, `f${String(i).padStart(2, "0")}.txt`), "x");
    }
    const result = (await createSkillTool(discover().skills).handler({ name: "big" })) as {
      files: string[];
      filesTruncated?: boolean;
    };
    expect(result.files).toHaveLength(50);
    expect(result.filesTruncated).toBe(true);
  });

  it("substitutes $ARGUMENTS but leaves $1 alone, since skill bodies are full of shell", async () => {
    const tool = createSkillTool([skill({ name: "fmt", body: "Format $ARGUMENTS with awk '{print $1}'" })]);
    const result = (await tool.handler({ name: "fmt", arguments: "src/a.ts" })) as { instructions: string };
    expect(result.instructions).toBe("Format src/a.ts with awk '{print $1}'");
  });

  it("appends arguments when the body has no placeholder", async () => {
    const tool = createSkillTool([skill({ name: "plain", body: "Do it." })]);
    const result = (await tool.handler({ name: "plain", arguments: "carefully" })) as { instructions: string };
    expect(result.instructions).toBe("Do it.\n\nARGUMENTS: carefully");
  });

  it("returns an error listing valid names for unknown or missing names", async () => {
    const tool = createSkillTool([skill({ name: "beta" }), skill({ name: "alpha" }), skill({ name: "off", disableModelInvocation: true })]);

    const unknown = (await tool.handler({ name: "nope" })) as { error: string };
    expect(unknown.error).toContain('Unknown skill "nope"');
    expect(unknown.error).toContain("beta, alpha");
    expect(unknown.error).not.toContain("off");

    expect(((await tool.handler({})) as { error: string }).error).toContain("requires");
    expect(((await tool.handler("pdf")) as { error: string }).error).toContain("requires");
    expect(((await createSkillTool([]).handler({ name: "x" })) as { error: string }).error).toContain("No skills");
  });

  it("refuses skills that disable model invocation", async () => {
    const tool = createSkillTool([skill({ name: "manual", disableModelInvocation: true })]);
    expect(await tool.handler({ name: "manual" })).toMatchObject({ error: expect.stringContaining("Unknown skill") });
  });

  it("tolerates a leading slash and different casing in the requested name", async () => {
    const tool = createSkillTool([skill({ name: "pdf" })]);
    expect(await tool.handler({ name: "/PDF" })).toMatchObject({ name: "pdf" });
  });
});

describe("skillToCommand", () => {
  it("exposes a skill (even a model-disabled one) as a slash command", () => {
    const command = skillToCommand(
      skill({ name: "review", description: "Review\ncode", body: "Check $ARGUMENTS", argumentHint: "<path>", disableModelInvocation: true }),
    );
    expect(command).toMatchObject({
      name: "review",
      description: "Review code",
      argumentHint: "<path>",
      source: "skill",
      scope: "project",
    });
    expect(command.template).toContain("/skills/review");
    expect(expandCommand(command, "src/")).toContain("Check src/");
  });

  it("only expands $ARGUMENTS for skills, never positional placeholders", () => {
    const command = skillToCommand(skill({ name: "awk", body: "run awk '{print $1}'" }));
    expect(expandCommand(command, "first second")).toContain("awk '{print $1}'");
  });
});
