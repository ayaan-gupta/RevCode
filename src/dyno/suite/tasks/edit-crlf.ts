/**
 * edit-crlf-preserve — edit a file that uses Windows line endings.
 *
 * read_file hides the CR, a multi-line oldText never matches the CRLF bytes, and
 * a whole-file rewrite quietly converts everything to LF. The grader works on
 * the raw bytes: every line break must still be CRLF, and the only differences
 * from the original may be the requested ones.
 */

import fs from "node:fs";
import path from "node:path";
import type { DynoTask } from "../../types.js";
import { clip, fail, pass, python, writeFiles } from "../helpers.js";

const CONFIG = "deploy/service.ini";

const ORIGINAL_LINES = [
  "; Service configuration, consumed by the Windows deploy tool",
  "[service]",
  "name = inventory-sync",
  "workers = 4",
  "",
  "[database]",
  "host = db01.internal",
  "port = 5432",
  "max_connections = 20",
  "statement_timeout = 15",
  "",
  "[cache]",
  "host = cache01.internal",
  "max_connections = 20",
  "ttl = 300",
  "",
  "[logging]",
  "level = INFO",
  "file = C:\\ProgramData\\inventory\\sync.log",
];

const EXPECTED_LINES = ORIGINAL_LINES.flatMap((line, index) => {
  if (line === "level = INFO" && ORIGINAL_LINES[index - 1] === "[logging]") return ["level = WARNING"];
  if (line === "max_connections = 20" && ORIGINAL_LINES[index - 3] === "[database]") {
    return ["max_connections = 50", "pool_timeout = 30"];
  }
  return [line];
});

const CHECK_SCRIPT = String.raw`"""Print the parsed service configuration as JSON (what the deploy tool will see)."""
import configparser
import json
import sys

parser = configparser.ConfigParser(interpolation=None)
with open(sys.argv[1] if len(sys.argv) > 1 else "deploy/service.ini", newline="") as handle:
    parser.read_file(handle)
print(json.dumps({s: dict(parser[s]) for s in parser.sections()}, indent=2))
`;

/** `key = value` spacing is not what this task is about, so normalise it away. */
const canonical = (line: string): string => line.replace(/^([A-Za-z_]+)\s*=\s*/, "$1 = ");

export const editCrlfPreserve: DynoTask = {
  id: "edit-crlf-preserve",
  title: "Edit a CRLF config file without converting its line endings",
  category: "edit",
  difficulty: 2,
  instruction:
    "Please update `deploy/service.ini`. In the `[database]` section raise `max_connections` from 20 to 50 and add a new " +
    "line `pool_timeout = 30` directly after it; in `[logging]` change `level` to `WARNING`. The `[cache]` section also " +
    "has a `max_connections`, and that one stays as it is. The Windows deploy tool that reads this file is very picky about " +
    "its format, so change nothing beyond what I listed. `python3 deploy/check_config.py` prints how the file parses.",
  maxIterations: 20,
  timeoutSec: 120,

  setup(dir) {
    writeFiles(dir, {
      [CONFIG]: Buffer.from(`${ORIGINAL_LINES.join("\r\n")}\r\n`, "utf8"),
      "deploy/check_config.py": CHECK_SCRIPT,
    });
  },

  async grade(dir) {
    let raw: Buffer;
    try {
      raw = fs.readFileSync(path.join(dir, CONFIG));
    } catch {
      return fail(`${CONFIG} is missing`);
    }
    const text = raw.toString("utf8");

    const bareLf = (text.match(/(?<!\r)\n/g) ?? []).length;
    const bareCr = (text.match(/\r(?!\n)/g) ?? []).length;
    const crlf = (text.match(/\r\n/g) ?? []).length;
    if (bareLf > 0 || bareCr > 0) {
      return fail(`line endings are no longer uniformly CRLF (${crlf} CRLF, ${bareLf} bare LF, ${bareCr} bare CR)`);
    }
    if (!text.endsWith("\r\n")) return fail("the file must still end with a CRLF line break");

    const lines = text.slice(0, -2).split("\r\n").map(canonical);
    const expected = EXPECTED_LINES.map(canonical);
    if (lines.length !== expected.length || lines.some((line, i) => line !== expected[i])) {
      const at = lines.findIndex((line, i) => line !== expected[i]);
      return fail(
        `content differs from the requested result (${lines.length} lines, expected ${expected.length}); ` +
          `first difference at line ${at + 1}: got ${JSON.stringify(lines[at])}, expected ${JSON.stringify(expected[at])}`,
      );
    }

    const parsed = await python(["deploy/check_config.py"], { cwd: dir, timeoutMs: 15_000 });
    if (parsed.code !== 0) return fail(`file no longer parses: ${clip(parsed.stderr)}`);
    const config = JSON.parse(parsed.stdout) as Record<string, Record<string, string>>;
    if (config.database?.max_connections !== "50" || config.database?.pool_timeout !== "30") {
      return fail("[database] values wrong after parsing");
    }
    if (config.cache?.max_connections !== "20") return fail("[cache] max_connections must stay 20");
    if (config.logging?.level !== "WARNING") return fail("[logging] level must be WARNING");
    return pass("values updated, CRLF line endings preserved");
  },

  oracle(dir) {
    const file = path.join(dir, CONFIG);
    const raw = fs.readFileSync(file, "utf8");
    const edited = raw
      .replace("[database]\r\nhost = db01.internal\r\nport = 5432\r\nmax_connections = 20\r\n", "[database]\r\nhost = db01.internal\r\nport = 5432\r\nmax_connections = 50\r\npool_timeout = 30\r\n")
      .replace("level = INFO", "level = WARNING");
    fs.writeFileSync(file, edited);
  },
};
