/**
 * Agent Skills (https://agentskills.io): a directory holding a `SKILL.md` whose
 * YAML frontmatter names and describes the skill and whose body is the
 * instructions. Discovery is progressive: only `name: description` goes into
 * the system prompt; the model pulls the body in with the `use_skill` tool when
 * a task matches, and can then read any sibling files the skill ships.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { RegisteredTool } from "../tools/index.js";
import { expandTemplate, type CustomCommand } from "./commands.js";
import { asBoolean, asString, asStringList, parseFrontmatter } from "./frontmatter.js";
import { searchRoots, type DiscoveryOptions } from "./roots.js";

export interface Skill {
  name: string;
  description: string;
  /** Markdown instructions: the SKILL.md body. */
  body: string;
  /** Absolute path of the skill directory. */
  directory: string;
  /** Absolute path of its SKILL.md. */
  file: string;
  allowedTools: string[];
  /** When true the model may not load it (and it is not advertised); the user still can via `/name`. */
  disableModelInvocation: boolean;
  argumentHint?: string;
  scope: "user" | "project";
}

export interface SkillDiscovery {
  skills: Skill[];
  warnings: string[];
}

export const SKILL_TOOL_NAME = "use_skill";

const SKILL_NAME = /^[a-z0-9-]{1,64}$/;
const MAX_DESCRIPTION = 1024;
const MAX_SKILL_BYTES = 512 * 1024;
const MAX_LISTED_FILES = 50;
const MAX_FILE_DEPTH = 4;
/** Total size budget for the prompt listing; descriptions shrink evenly past this. */
const PROMPT_BUDGET_CHARS = 8_000;
const MIN_PROMPT_DESCRIPTION = 80;
const SKIPPED_DIRS = new Set(["node_modules", ".git", "__pycache__"]);

/**
 * Load every skill visible from `cwd`. Later roots override earlier ones by
 * name (see `searchRoots`); malformed skills are skipped with a warning rather
 * than failing discovery. Output is sorted by name so the prompt section is
 * byte-stable across runs (it is part of the cacheable prefix).
 */
export function discoverSkills(cwd: string, options: DiscoveryOptions = {}): SkillDiscovery {
  const warnings: string[] = [];
  const byName = new Map<string, { skill: Skill; rootIndex: number }>();

  searchRoots(cwd, "skills", options).forEach((root, rootIndex) => {
    for (const entry of listSkillDirectories(root.dir, warnings)) {
      const skill = loadSkill(entry, root.scope, warnings);
      if (!skill) {
        continue;
      }
      const existing = byName.get(skill.name);
      if (existing && existing.rootIndex === rootIndex) {
        warnings.push(`Duplicate skill "${skill.name}" in ${root.dir}: ignoring ${skill.file}`);
        continue;
      }
      byName.set(skill.name, { skill, rootIndex });
    }
  });

  const skills = [...byName.values()].map((entry) => entry.skill);
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, warnings };
}

/**
 * System-prompt section advertising the model-invocable skills (metadata only).
 * Returns "" when there are none so callers can append it unconditionally.
 */
export function skillsPromptSection(skills: readonly Skill[]): string {
  const listed = skills.filter((skill) => !skill.disableModelInvocation);
  if (listed.length === 0) {
    return "";
  }

  const oneLine = (skill: Skill): string => skill.description.replace(/\s+/g, " ").trim();
  const overhead = listed.reduce((sum, skill) => sum + skill.name.length + 6, 0);
  const total = listed.reduce((sum, skill) => sum + oneLine(skill).length, 0);
  const cap =
    overhead + total <= PROMPT_BUDGET_CHARS
      ? MAX_DESCRIPTION
      : Math.max(MIN_PROMPT_DESCRIPTION, Math.floor((PROMPT_BUDGET_CHARS - overhead) / listed.length));

  const lines = listed.map((skill) => {
    const description = oneLine(skill);
    const shown = description.length > cap ? `${description.slice(0, cap - 1).trimEnd()}…` : description;
    return `- ${skill.name}: ${shown}`;
  });

  return [
    "# Skills",
    `Skills are reusable, task-specific instructions stored on disk. Only their names and descriptions are listed here. When the user's request matches a skill's description, or the user names a skill, call the \`${SKILL_TOOL_NAME}\` tool with its name BEFORE starting the work, then follow the instructions it returns. Do not guess at a skill's contents from its description, and do not call the tool for names that are not listed.`,
    "",
    "Available skills:",
    ...lines,
  ].join("\n");
}

/**
 * The `use_skill` tool. Serves only model-invocable skills; the list is fixed at
 * creation, so after re-running discovery register a fresh tool (the registry
 * replaces by name).
 */
export function createSkillTool(skills: readonly Skill[]): RegisteredTool {
  const available = new Map(skills.filter((skill) => !skill.disableModelInvocation).map((skill) => [skill.name, skill]));

  return {
    definition: {
      name: SKILL_TOOL_NAME,
      description:
        "Load the full instructions of a skill listed under \"Skills\" in the system prompt. Call it when the user's request matches a skill's description, then follow the returned instructions; files it lists live in its directory and can be read with read_file.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Skill name exactly as listed in the system prompt.",
          },
          arguments: {
            type: "string",
            description: "Optional free-form arguments or task details for the skill (substituted for $ARGUMENTS).",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    handler: async (input) => {
      const { name, args } = parseSkillInput(input);
      const skill = name === undefined ? undefined : available.get(name.trim().replace(/^\//, "").toLowerCase());
      if (!skill) {
        const valid = [...available.keys()];
        return {
          error:
            name === undefined
              ? `use_skill requires a "name". ${validNames(valid)}`
              : `Unknown skill "${name}". ${validNames(valid)}`,
        };
      }

      const { files, truncated } = listSkillFiles(skill.directory);
      return {
        name: skill.name,
        instructions: expandTemplate(skill.body, args, { positional: false }),
        directory: skill.directory,
        files,
        ...(truncated ? { filesTruncated: true } : {}),
      };
    },
  };
}

/** Expose a skill as a `/name` slash command so users can invoke it directly. */
export function skillToCommand(skill: Skill): CustomCommand {
  return {
    name: skill.name,
    description: skill.description.replace(/\s+/g, " ").trim(),
    ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
    template: `Use the "${skill.name}" skill (directory: ${skill.directory}). Follow these instructions:\n\n${skill.body}`,
    file: skill.file,
    source: "skill",
    scope: skill.scope,
  };
}

// --- loading --------------------------------------------------------------------

function listSkillDirectories(root: string, warnings: string[]): Array<{ directory: string; dirName: string }> {
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      warnings.push(`Cannot read skills directory ${root}: ${errorMessage(error)}`);
    }
    return [];
  }

  const entries: Array<{ directory: string; dirName: string }> = [];
  for (const dirName of names) {
    if (dirName.startsWith(".")) {
      continue;
    }
    const directory = path.join(root, dirName);
    try {
      // stat (not lstat) so symlinked skill directories work.
      if (statSync(directory).isDirectory()) {
        entries.push({ directory, dirName });
      }
    } catch {
      // Dangling symlink or permission problem: not a skill.
    }
  }
  return entries;
}

function loadSkill(
  entry: { directory: string; dirName: string },
  scope: "user" | "project",
  warnings: string[],
): Skill | undefined {
  const file = path.join(entry.directory, "SKILL.md");
  let source: string;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) {
      return undefined;
    }
    if (stat.size > MAX_SKILL_BYTES) {
      warnings.push(`Skipping skill ${file}: larger than ${MAX_SKILL_BYTES / 1024} KiB`);
      return undefined;
    }
    source = readFileSync(file, "utf8");
  } catch (error) {
    // A directory without SKILL.md is just a directory, not a broken skill.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`Cannot read skill ${file}: ${errorMessage(error)}`);
    }
    return undefined;
  }

  const parsed = parseFrontmatter(source);
  if (!parsed.present) {
    warnings.push(`Skipping skill ${file}: missing YAML frontmatter (name and description are required)`);
    return undefined;
  }
  if (parsed.error) {
    warnings.push(`Skipping skill ${file}: ${parsed.error}`);
    return undefined;
  }

  const name = asString(parsed.data.name)?.trim() || entry.dirName;
  if (!SKILL_NAME.test(name)) {
    warnings.push(`Skipping skill ${file}: name "${name}" must match [a-z0-9-]{1,64}`);
    return undefined;
  }
  const description = asString(parsed.data.description)?.trim().slice(0, MAX_DESCRIPTION).trimEnd();
  if (!description) {
    warnings.push(`Skipping skill ${file}: "description" is required`);
    return undefined;
  }
  const body = parsed.body.trim();
  if (body === "") {
    warnings.push(`Skipping skill ${file}: no instructions after the frontmatter`);
    return undefined;
  }

  const argumentHint = asString(parsed.data["argument-hint"])?.trim();
  return {
    name,
    description,
    body,
    directory: entry.directory,
    file,
    allowedTools: asStringList(parsed.data["allowed-tools"]),
    disableModelInvocation: asBoolean(parsed.data["disable-model-invocation"]) ?? false,
    ...(argumentHint ? { argumentHint } : {}),
    scope,
  };
}

// --- tool helpers -----------------------------------------------------------------

function parseSkillInput(input: unknown): { name: string | undefined; args: string } {
  const record = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const name = typeof record.name === "string" && record.name.trim() !== "" ? record.name : undefined;
  return { name, args: typeof record.arguments === "string" ? record.arguments : "" };
}

function validNames(names: string[]): string {
  return names.length > 0 ? `Valid skills: ${names.join(", ")}.` : "No skills are available.";
}

/** Relative paths of the files a skill ships next to SKILL.md, sorted, capped. */
function listSkillFiles(directory: string): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;

  const walk = (dir: string, prefix: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (truncated) {
        return;
      }
      if (name.startsWith(".") || SKIPPED_DIRS.has(name) || (depth === 0 && name === "SKILL.md")) {
        continue;
      }
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      try {
        const stat = statSync(path.join(dir, name));
        if (stat.isDirectory()) {
          if (depth < MAX_FILE_DEPTH) {
            walk(path.join(dir, name), relative, depth + 1);
          }
        } else if (stat.isFile()) {
          if (files.length >= MAX_LISTED_FILES) {
            truncated = true;
            return;
          }
          files.push(relative);
        }
      } catch {
        // Unreadable entry: leave it out.
      }
    }
  };

  walk(directory, "", 0);
  return { files, truncated };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
