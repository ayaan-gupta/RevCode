/**
 * multi-step-git-feature-branch — a git workflow with an unrelated dirty tree.
 *
 * The working tree already holds an uncommitted edit to a tracked file and an
 * untracked scratch file. `git commit -a` or `git add .` sweeps those into the
 * commit, which is exactly what the grader looks for. Everything is judged from
 * the repository itself: branch, commit count, message, files in the commit, the
 * content at the branch tip, and what is still uncommitted.
 *
 * The repository's commits use fixed dates and identities so setup is
 * byte-for-byte reproducible.
 */

import fs from "node:fs";
import path from "node:path";
import type { DynoTask } from "../../types.js";
import { clip, fail, git, pass, python, readText, withScratchCopy, writeFiles } from "../helpers.js";

const BRANCH = "feature/rate-limit";
const MESSAGE = "Raise default rate limit to 250";
const BULLET = `- ${MESSAGE}`;

const SETTINGS_V1 = `"""Runtime settings for the API gateway."""

DEFAULT_RATE_LIMIT = 100  # requests per minute per client
`;
const SETTINGS_V2 = `${SETTINGS_V1}BURST_LIMIT = 20
`;
const SETTINGS_V3 = `${SETTINGS_V2}REQUEST_TIMEOUT_S = 30
`;

const CHANGELOG_V1 = `# Changelog

## Unreleased

## 1.2.0

- Initial public release
`;
const CHANGELOG_V2 = `# Changelog

## Unreleased

- Add burst limit setting

## 1.2.0

- Initial public release
`;
const CHANGELOG_V3 = `# Changelog

## Unreleased

- Add burst limit setting
- Add request timeout setting

## 1.2.0

- Initial public release
`;

const NOTES_COMMITTED = "# Notes\n\n- look into caching headers\n";
const NOTES_DIRTY = `${NOTES_COMMITTED}- draft: rollout plan for the new limits (not ready to share)\n`;
const SCRATCH = "tmp numbers: 250 / 100 / 20\n";

const COMMITS = [
  { subject: "Initial gateway settings", files: { "settings.py": SETTINGS_V1, "CHANGELOG.md": CHANGELOG_V1, "README.md": "# gateway\n\nAPI gateway configuration.\n", "notes.md": NOTES_COMMITTED } },
  { subject: "Add burst limit", files: { "settings.py": SETTINGS_V2, "CHANGELOG.md": CHANGELOG_V2 } },
  { subject: "Add request timeout setting", files: { "settings.py": SETTINGS_V3, "CHANGELOG.md": CHANGELOG_V3 } },
] as const;

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Dyno Fixture",
  GIT_AUTHOR_EMAIL: "dyno@example.invalid",
  GIT_COMMITTER_NAME: "Dyno Fixture",
  GIT_COMMITTER_EMAIL: "dyno@example.invalid",
};

async function mustGit(dir: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const result = await git(args, { cwd: dir, timeoutMs: 20_000, env: { ...GIT_IDENTITY, ...env } });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

/** Value of a git query, or undefined if it failed. */
async function query(dir: string, args: string[]): Promise<string | undefined> {
  const result = await git(args, { cwd: dir, timeoutMs: 20_000 });
  return result.code === 0 ? result.stdout : undefined;
}

export const multiStepGitFeatureBranch: DynoTask = {
  id: "multi-step-git-feature-branch",
  title: "Commit a two-file change on a new branch, leaving other edits alone",
  category: "multi-step",
  difficulty: 2,
  instruction:
    `This directory is a git repository on \`main\`. Create a branch called \`${BRANCH}\` from \`main\`, raise ` +
    "`DEFAULT_RATE_LIMIT` in `settings.py` from 100 to 250, and add the bullet " +
    `\`${BULLET}\` under the \`## Unreleased\` heading in \`CHANGELOG.md\`. Commit exactly those two files with the commit ` +
    `message \`${MESSAGE}\` and stay on the new branch afterwards. I have an unrelated uncommitted edit in \`notes.md\` ` +
    "and a scratch file in here; both must stay uncommitted and untouched. Don't merge anything into `main` or rewrite its history.",
  maxIterations: 20,
  timeoutSec: 120,

  async setup(dir) {
    await mustGit(dir, ["init", "--quiet", "-b", "main"]);
    for (const [key, value] of [
      ["user.name", GIT_IDENTITY.GIT_AUTHOR_NAME],
      ["user.email", GIT_IDENTITY.GIT_AUTHOR_EMAIL],
      ["commit.gpgsign", "false"],
      ["core.hooksPath", ".git/hooks"],
    ] as const) {
      await mustGit(dir, ["config", key, value]);
    }
    for (const [index, commit] of COMMITS.entries()) {
      writeFiles(dir, commit.files);
      await mustGit(dir, ["add", "--all"]);
      const when = `2024-01-0${index + 1}T10:00:00+00:00`;
      await mustGit(dir, ["commit", "--quiet", "-m", commit.subject], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
    }
    writeFiles(dir, { "notes.md": NOTES_DIRTY, "scratch.txt": SCRATCH });
  },

  async grade(dir) {
    const head = (await query(dir, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim();
    if (head === undefined) return fail("not a git repository any more");
    if (head !== BRANCH) return fail(`HEAD is on "${head}", expected to stay on ${BRANCH}`);

    const mainSubjects = (await query(dir, ["log", "main", "--format=%s"]))?.trim().split("\n");
    const originalSubjects = COMMITS.map((commit) => commit.subject).reverse();
    if (JSON.stringify(mainSubjects) !== JSON.stringify(originalSubjects)) return fail("main's history was changed");

    const ahead = Number((await query(dir, ["rev-list", "--count", `main..${BRANCH}`]))?.trim());
    if (ahead !== 1) return fail(`${BRANCH} should be exactly one commit ahead of main, found ${Number.isNaN(ahead) ? "no such branch" : ahead}`);
    const behind = Number((await query(dir, ["rev-list", "--count", `${BRANCH}..main`]))?.trim());
    if (behind !== 0) return fail(`${BRANCH} is not based on main's tip (main has ${behind} commits it lacks)`);

    const subject = (await query(dir, ["log", "-1", "--format=%s", BRANCH]))?.trim();
    if (subject !== MESSAGE) return fail(`commit subject is ${JSON.stringify(subject)}, expected ${JSON.stringify(MESSAGE)}`);

    const changed = (await query(dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", BRANCH]))?.trim().split("\n").sort();
    if (JSON.stringify(changed) !== JSON.stringify(["CHANGELOG.md", "settings.py"])) {
      return fail(`the commit touches ${JSON.stringify(changed)}; it must contain exactly CHANGELOG.md and settings.py`);
    }

    const settings = await query(dir, ["show", `${BRANCH}:settings.py`]);
    const changelog = await query(dir, ["show", `${BRANCH}:CHANGELOG.md`]);
    if (settings === undefined || changelog === undefined) return fail("could not read the committed files");

    const evaluated = await withScratchCopy(dir, async (scratch) => {
      fs.writeFileSync(path.join(scratch, "settings.py"), settings);
      return python(["-c", "import json, settings; print(json.dumps([settings.DEFAULT_RATE_LIMIT, settings.BURST_LIMIT, settings.REQUEST_TIMEOUT_S]))"], {
        cwd: scratch,
        timeoutMs: 15_000,
      });
    });
    if (evaluated.code !== 0) return fail(`committed settings.py does not import: ${clip(evaluated.stderr, 200)}`);
    if (evaluated.stdout.trim() !== "[250, 20, 30]") {
      return fail(`committed settings are ${evaluated.stdout.trim()}, expected [250, 20, 30]`);
    }

    const lines = changelog.split("\n");
    const unreleased = lines.indexOf("## Unreleased");
    const nextHeading = lines.findIndex((line, i) => i > unreleased && line.startsWith("## "));
    const bulletAt = lines.indexOf(BULLET);
    if (unreleased < 0 || bulletAt <= unreleased || (nextHeading >= 0 && bulletAt > nextHeading)) {
      return fail(`the bullet "${BULLET}" is not inside the "## Unreleased" section of the committed CHANGELOG.md`);
    }
    const withoutBullet = lines.filter((_, i) => i !== bulletAt).join("\n");
    if (withoutBullet !== CHANGELOG_V3) return fail("the committed CHANGELOG.md changed more than the one bullet");

    const status = await query(dir, ["status", "--porcelain"]);
    if (status === undefined) return fail("git status failed");
    if (status !== " M notes.md\n?? scratch.txt\n") {
      return fail(`working tree should still show only the unrelated edits, but \`git status --porcelain\` says ${JSON.stringify(status)}`);
    }
    if (readText(dir, "notes.md") !== NOTES_DIRTY || readText(dir, "scratch.txt") !== SCRATCH) {
      return fail("the unrelated notes.md edit or scratch.txt was altered");
    }
    return pass(`${BRANCH}: one commit "${MESSAGE}" touching settings.py and CHANGELOG.md; other edits untouched`);
  },

  async oracle(dir) {
    await mustGit(dir, ["checkout", "--quiet", "-b", BRANCH, "main"]);
    const settings = path.join(dir, "settings.py");
    fs.writeFileSync(settings, fs.readFileSync(settings, "utf8").replace("DEFAULT_RATE_LIMIT = 100", "DEFAULT_RATE_LIMIT = 250"));
    const changelog = path.join(dir, "CHANGELOG.md");
    fs.writeFileSync(
      changelog,
      fs.readFileSync(changelog, "utf8").replace("- Add request timeout setting\n", `- Add request timeout setting\n${BULLET}\n`),
    );
    await mustGit(dir, ["add", "settings.py", "CHANGELOG.md"]);
    await mustGit(dir, ["commit", "--quiet", "-m", MESSAGE]);
  },
};
