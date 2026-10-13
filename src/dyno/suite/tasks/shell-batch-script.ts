/**
 * shell-batch-csv-script — write a bash script for a file-processing job, run it.
 *
 * The visible data already contains the usual bash traps: file names with
 * spaces, a last line without a newline (which `while read` silently drops),
 * `inactive` rows that a loose `grep active` would keep, mixed-case names that
 * plain `sort` orders differently, and ids that only sort right numerically.
 * The grader checks the outputs the agent produced AND re-runs the script on
 * different input in a scratch copy, so a one-off pipeline pasted into a shell
 * does not count.
 */

import fs from "node:fs";
import path from "node:path";
import type { DynoTask } from "../../types.js";
import { bash, clip, fail, pass, withScratchCopy, writeFiles } from "../helpers.js";

const HEADER = "id,name,status,amount";

type Dataset = Record<string, string>;

const VISIBLE: Dataset = {
  "Q1 sales.csv": [
    HEADER,
    "101,zed corp,active,250",
    "102,Alice Ltd,active,75",
    "103,bob & sons,inactive,40",
    "104,alice ltd,active,12",
    "105,Carol,pending,9",
    "106,Bob,active,300",
    "",
  ].join("\n"),
  "east_region.csv": [HEADER, "9,Dan,active,5", "10,Dan,active,6", "11,eve,inactive,1", ""].join("\n"),
  "west-region.csv": [HEADER, "31,Mia,active,8", "32,Noa,active,9"].join("\n"),
  "empty_batch.csv": `${HEADER}\n`,
  "all inactive.csv": [HEADER, "1,x,inactive,1", "2,y,Inactive,2", ""].join("\n"),
  "notes.txt": "not a csv export; leave it alone\n",
};

const HIDDEN: Dataset = {
  "Jan report.csv": [HEADER, "7,omega,active,1", "12,Omega,active,2", "3,alpha,active,3", "4,Beta,inactive,4", "5,beta,active,5", ""].join("\n"),
  "b.csv": [HEADER, "1,solo,active,10"].join("\n"),
  "Zeta  double  space.csv": [HEADER, "20,Kim Lee,active,1", "19,kim lee,active,2", "21,Kim,active,3", ""].join("\n"),
  "no rows.csv": `${HEADER}\n`,
  "README.txt": "ignore me\n",
};

/** Reference implementation of the job, used to compute what the script must write. */
function expectedOutputs(input: Dataset): Record<string, string> {
  const out: Record<string, string> = {};
  const manifest: string[] = [];
  for (const file of Object.keys(input).filter((name) => name.endsWith(".csv")).sort()) {
    const lines = (input[file] ?? "").split("\n").filter((line) => line !== "");
    const rows = lines
      .slice(1)
      .map((line) => line.split(","))
      .filter((cells) => cells[2] === "active")
      .sort((a, b) => {
        const nameA = (a[1] ?? "").toLowerCase();
        const nameB = (b[1] ?? "").toLowerCase();
        if (nameA !== nameB) return nameA < nameB ? -1 : 1;
        return Number(a[0]) - Number(b[0]);
      });
    out[file] = ["id,name,amount", ...rows.map((cells) => `${cells[0]},${cells[1]},${cells[3]}`)].join("\n") + "\n";
    manifest.push(`${file},${rows.length}`);
  }
  out["MANIFEST.txt"] = manifest.length > 0 ? `${manifest.join("\n")}\n` : "";
  return out;
}

/** Read `outgoing/` as a name -> content map, or an explanation of what is wrong. */
function readOutgoing(root: string): Record<string, string> | string {
  const dir = path.join(root, "outgoing");
  if (!fs.existsSync(dir)) return "outgoing/ does not exist";
  const found: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) return `unexpected directory outgoing/${entry.name}`;
    found[entry.name] = fs.readFileSync(path.join(dir, entry.name), "utf8");
  }
  return found;
}

function compare(actual: Record<string, string>, expected: Record<string, string>): string | undefined {
  const missing = Object.keys(expected).filter((name) => !(name in actual));
  if (missing.length > 0) return `missing from outgoing/: ${missing.join(", ")}`;
  const extra = Object.keys(actual).filter((name) => !(name in expected));
  if (extra.length > 0) return `unexpected files in outgoing/: ${extra.join(", ")}`;
  for (const [name, content] of Object.entries(expected)) {
    // A missing final newline is not what this task is about.
    if ((actual[name] ?? "").replace(/\n$/, "") !== content.replace(/\n$/, "")) {
      return `outgoing/${name} is wrong.\nexpected: ${JSON.stringify(clip(content, 200))}\nactual:   ${JSON.stringify(clip(actual[name] ?? "", 200))}`;
    }
  }
  return undefined;
}

const REFERENCE_SCRIPT = String.raw`#!/usr/bin/env bash
# Filter active rows out of every incoming CSV, drop the status column and sort.
set -euo pipefail
export LC_ALL=C
cd "$(dirname "$0")"

rm -rf outgoing
mkdir -p outgoing
: > outgoing/MANIFEST.txt

shopt -s nullglob
for file in incoming/*.csv; do
  name=$(basename "$file")
  {
    echo "id,name,amount"
    awk -F, 'NR > 1 && $3 == "active" { print $1 "," $2 "," $4 }' "$file" | sort -t, -k2,2f -k1,1n
  } > "outgoing/$name"
  rows=$(( $(wc -l < "outgoing/$name") - 1 ))
  printf '%s,%s\n' "$name" "$rows" >> outgoing/MANIFEST.txt
done
`;

export const shellBatchCsvScript: DynoTask = {
  id: "shell-batch-csv-script",
  title: "Write and run a bash script that filters and sorts CSV exports",
  category: "shell",
  difficulty: 2,
  instruction:
    "The `incoming/` directory holds CSV exports with the header `id,name,status,amount` (plain comma-separated, no " +
    "quoting). Write a bash script `process.sh` in this directory that, for every `*.csv` file in `incoming/`, keeps only " +
    "the rows whose `status` is exactly `active`, drops the `status` column (the output header is `id,name,amount`), sorts " +
    "the kept rows by `name` case-insensitively and then by `id` numerically, and writes the result to `outgoing/` under the " +
    "same file name. It also has to write `outgoing/MANIFEST.txt` with one line `<file name>,<rows kept>` per processed " +
    "file, sorted by file name in plain byte order. The script must work for whatever files are in `incoming/` next time " +
    "(names can contain spaces, and the last line of a file may have no newline) and must rebuild `outgoing/` from scratch " +
    "on every run so nothing stale is left behind. Run it from this directory (`bash process.sh`) so `outgoing/` is populated.",
  maxIterations: 25,
  timeoutSec: 150,

  setup(dir) {
    writeFiles(dir, Object.fromEntries(Object.entries(VISIBLE).map(([name, content]) => [`incoming/${name}`, content])));
  },

  async grade(dir) {
    const script = path.join(dir, "process.sh");
    if (!fs.existsSync(script)) return fail("process.sh is missing");

    const produced = readOutgoing(dir);
    if (typeof produced === "string") return fail(`${produced}; run the script so it is populated`);
    const problem = compare(produced, expectedOutputs(VISIBLE));
    if (problem) return fail(problem);

    return withScratchCopy(dir, async (scratch) => {
      fs.rmSync(path.join(scratch, "incoming"), { recursive: true, force: true });
      fs.rmSync(path.join(scratch, "outgoing"), { recursive: true, force: true });
      writeFiles(scratch, {
        ...Object.fromEntries(Object.entries(HIDDEN).map(([name, content]) => [`incoming/${name}`, content])),
        "outgoing/stale.csv": "left over from an earlier run\n",
        "outgoing/MANIFEST.txt": "stale.csv,99\n",
      });
      const result = await bash(["process.sh"], { cwd: scratch, timeoutMs: 20_000 });
      if (result.timedOut) return fail("process.sh did not finish on fresh input (it timed out)");
      if (result.code !== 0) return fail(`process.sh exited ${String(result.code)} on fresh input: ${clip(result.stderr, 300)}`);
      const rerun = readOutgoing(scratch);
      if (typeof rerun === "string") return fail(`on fresh input: ${rerun}`);
      const rerunProblem = compare(rerun, expectedOutputs(HIDDEN));
      return rerunProblem ? fail(`on fresh input: ${rerunProblem}`) : pass("outputs correct and the script works on new input");
    });
  },

  async oracle(dir) {
    fs.writeFileSync(path.join(dir, "process.sh"), REFERENCE_SCRIPT);
    const result = await bash(["process.sh"], { cwd: dir, timeoutMs: 20_000 });
    if (result.code !== 0) throw new Error(`oracle script failed: ${result.stderr}`);
  },
};
