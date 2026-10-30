/**
 * Copy by default: an interactive session works in a private copy of the
 * project (a universe) unless that would be slow, surprising or impossible.
 *
 * The copy is made when the directory is a git project of reasonable size.
 * Otherwise RevCode works in the project directly and asks before changes, and
 * the session says why in one line. `--universe` / `--no-universe` (or
 * `"universe"` in config) always win over this.
 */

import os from "node:os";
import path from "node:path";
import { UniverseTooLargeError, type CopyLimits } from "./copy.js";
import { runPlainGit } from "./git.js";
import { Universe } from "./universe.js";

/** Smaller than the explicit `--universe` limits: an automatic copy must be quick. */
export const AUTO_LIMITS: Partial<CopyLimits> = {
  maxFiles: 25_000,
  maxTotalBytes: 1024 * 1024 * 1024,
};

export interface AutoUniverseResult {
  universe?: Universe;
  /** Why the session works directly in the project instead (shown to the user). */
  skipped?: string;
}

export async function autoUniverse(
  projectRoot: string,
  info: { provider?: string; model?: string; limits?: Partial<CopyLimits> } = {},
): Promise<AutoUniverseResult> {
  const root = path.resolve(projectRoot);
  const home = process.env.HOME ? path.resolve(process.env.HOME) : os.homedir();
  if (root === path.parse(root).root || root === home) {
    return { skipped: "this is your home folder, not a project" };
  }
  const inside = await runPlainGit(["rev-parse", "--is-inside-work-tree"], { cwd: root, allowFailure: true }).catch(() => undefined);
  if (!inside || inside.stdout.toString("utf8").trim() !== "true") {
    return { skipped: "it isn't a git repository" };
  }
  // A copy of a project with submodules would be missing their contents.
  const staged = await runPlainGit(["ls-files", "--stage", "-z", "--", "."], { cwd: root, allowFailure: true }).catch(() => undefined);
  if (staged && staged.stdout.toString("utf8").split("\0").some((entry) => entry.startsWith("160000 "))) {
    return { skipped: "it uses git submodules" };
  }
  try {
    const universe = await Universe.create({ projectRoot: root, provider: info.provider, model: info.model, limits: info.limits ?? AUTO_LIMITS });
    return { universe };
  } catch (error) {
    if (error instanceof UniverseTooLargeError) {
      return { skipped: "it's too big to copy quickly" };
    }
    return { skipped: `it couldn't be copied (${error instanceof Error ? error.message : String(error)})` };
  }
}
