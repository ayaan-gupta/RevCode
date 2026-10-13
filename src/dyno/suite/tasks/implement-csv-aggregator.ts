/**
 * implement-csv-aggregator-cli — build a CLI from a written specification.
 *
 * The README states every edge case explicitly (quoted fields, skipped rows, the
 * `(none)` bucket, exit codes), so the graders are fair but unforgiving: they run
 * the CLI as a subprocess on inputs the agent never sees and compare parsed JSON.
 */

import fs from "node:fs";
import path from "node:path";
import type { DynoTask } from "../../types.js";
import { clip, fail, pass, python, withScratchCopy, writeFiles } from "../helpers.js";

const README = `# aggregate.py

Group a CSV file by one column and summarise the numbers in another.

    python3 aggregate.py FILE --by COLUMN --sum COLUMN [--delimiter CHAR]

## Input

* \`FILE\` is a UTF-8 CSV file whose first row is a header. Parse it as real CSV:
  fields may be quoted, and quoted fields may contain the delimiter, doubled quotes
  (\`""\`) and line breaks.
* \`--by\` names the column to group on and \`--sum\` the column that holds the numbers.
  Both are required. Header names are matched exactly (case-sensitive).
* \`--delimiter\` is a single character and defaults to \`,\`.
* Completely empty lines are ignored. A row shorter than the header is padded with
  empty cells; cells beyond the header are ignored.

## Output

One JSON document on stdout, followed by a newline:

    {"groups": {"east": {"rows": 2, "sum": 15.0, "avg": 7.5}}, "skipped": 1}

* \`groups\` has one entry per distinct group value. Keys are sorted in plain string
  order (\`sorted()\`: uppercase before lowercase). Group values are trimmed of
  surrounding whitespace; an empty group value is reported under the key \`(none)\`.
* A row is *counted* only if its whole trimmed value cell matches \`-?\\d+(\\.\\d+)?\`.
  Every other row (empty cell, \`N/A\`, \`1,234\`, \`.5\`, a missing cell, ...) is
  *skipped*: it contributes to no group and adds 1 to the top-level \`skipped\`.
  A group whose rows were all skipped does not appear at all.
* \`rows\` is the number of counted rows in the group, \`sum\` their total and
  \`avg\` = \`sum / rows\`, both rounded to 2 decimals with Python's \`round(x, 2)\`
  (compute the average from the unrounded sum).
* A file with a header but no data rows gives \`{"groups": {}, "skipped": 0}\`.

## Errors

On any error print \`error: <message>\` to stderr, print nothing to stdout, and exit
with status 2. Errors are: the file cannot be read, the file is empty (not even a
header), \`--by\` or \`--sum\` is not a column of the header, and a \`--delimiter\` that
is not exactly one character. Missing required options are a usage error and also
exit with status 2. Success exits 0.

## Example

    $ cat sales.csv
    region,amount
    east,10
    east,5
    west,oops
    $ python3 aggregate.py sales.csv --by region --sum amount
    {"groups": {"east": {"rows": 2, "sum": 15.0, "avg": 7.5}}, "skipped": 1}
`;

const STUB = `#!/usr/bin/env python3
"""CSV group-by aggregator. The specification is in README.md."""

import sys


def main(argv):
    raise NotImplementedError("see README.md")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
`;

const REFERENCE = String.raw`#!/usr/bin/env python3
"""CSV group-by aggregator. The specification is in README.md."""

import argparse
import csv
import json
import re
import sys

NUMBER = re.compile(r"-?\d+(\.\d+)?")


def error(message):
    print(f"error: {message}", file=sys.stderr)
    return 2


def main(argv):
    parser = argparse.ArgumentParser(description="Group a CSV file and summarise a numeric column.")
    parser.add_argument("file")
    parser.add_argument("--by", required=True)
    parser.add_argument("--sum", required=True, dest="value")
    parser.add_argument("--delimiter", default=",")
    args = parser.parse_args(argv)

    if len(args.delimiter) != 1:
        return error("--delimiter must be exactly one character")
    try:
        with open(args.file, newline="", encoding="utf-8") as handle:
            rows = [row for row in csv.reader(handle, delimiter=args.delimiter) if row]
    except (OSError, UnicodeDecodeError) as exc:
        return error(f"cannot read {args.file}: {exc}")
    if not rows:
        return error("empty file")

    header = rows[0]
    for column in (args.by, args.value):
        if column not in header:
            return error(f"column '{column}' not found")
    by_index, value_index = header.index(args.by), header.index(args.value)

    groups = {}
    skipped = 0
    for row in rows[1:]:
        row = row + [""] * (len(header) - len(row))
        cell = row[value_index].strip()
        if not NUMBER.fullmatch(cell):
            skipped += 1
            continue
        key = row[by_index].strip() or "(none)"
        groups.setdefault(key, []).append(float(cell))

    result = {}
    for key in sorted(groups):
        values = groups[key]
        total = sum(values)
        result[key] = {"rows": len(values), "sum": round(total, 2), "avg": round(total / len(values), 2)}
    print(json.dumps({"groups": result, "skipped": skipped}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
`;

interface Group {
  rows: number;
  sum: number;
  avg: number;
}

interface SuccessCase {
  name: string;
  csv: string;
  args: string[];
  groups: Record<string, Group>;
  skipped: number;
}

const g = (rows: number, sum: number, avg: number): Group => ({ rows, sum, avg });

const SUCCESS_CASES: SuccessCase[] = [
  {
    name: "basic grouping, case-sensitive keys sorted in string order",
    csv: "region,product,amount\neast,widget,10\nwest,widget,20.5\neast,gadget,5\nWest,widget,1\nwest,gadget,-4.5\n",
    args: ["--by", "region", "--sum", "amount"],
    groups: { West: g(1, 1, 1), east: g(2, 15, 7.5), west: g(2, 16, 8) },
    skipped: 0,
  },
  {
    name: "quoted fields with commas, doubled quotes and line breaks (group by name)",
    csv: 'name,team,score\n"Smith, Jo",red,10\n"O""Brien",red team,5\n"multi\nline",blue,2.5\n',
    args: ["--by", "name", "--sum", "score"],
    groups: { 'O"Brien': g(1, 5, 5), "Smith, Jo": g(1, 10, 10), "multi\nline": g(1, 2.5, 2.5) },
    skipped: 0,
  },
  {
    name: "group by a column that comes after the value column",
    csv: 'score,team\n1,"red"\n2,"red"\n4,blue\n',
    args: ["--by", "team", "--sum", "score"],
    groups: { blue: g(1, 4, 4), red: g(2, 3, 1.5) },
    skipped: 0,
  },
  {
    name: "skipped rows, (none) bucket, short and long rows, blank lines",
    csv: "group,value\na,1\na,\na,N/A\na, 7.5 \nb,1,234\n,3\n  ,4\n\nc,-2\nd,abc\ne,.5\nf\ng,12abc\nh,1.5.2\n",
    args: ["--by", "group", "--sum", "value"],
    groups: { "(none)": g(2, 7, 3.5), a: g(2, 8.5, 4.25), b: g(1, 1, 1), c: g(1, -2, -2) },
    skipped: 7,
  },
  {
    name: "semicolon delimiter",
    csv: "city;qty\noslo;3\noslo;4\nrome;10\n",
    args: ["--by", "city", "--sum", "qty", "--delimiter", ";"],
    groups: { oslo: g(2, 7, 3.5), rome: g(1, 10, 10) },
    skipped: 0,
  },
  {
    name: "rounding to two decimals",
    csv: "k,v\nx,1\nx,2\nx,2\ny,0.1\ny,0.2\n",
    args: ["--by", "k", "--sum", "v"],
    groups: { x: g(3, 5, 1.67), y: g(2, 0.3, 0.15) },
    skipped: 0,
  },
  {
    name: "header only",
    csv: "k,v\n",
    args: ["--by", "k", "--sum", "v"],
    groups: {},
    skipped: 0,
  },
  {
    name: "no trailing newline",
    csv: "k,v\na,2\na,4",
    args: ["--by", "k", "--sum", "v"],
    groups: { a: g(2, 6, 3) },
    skipped: 0,
  },
];

interface ErrorCase {
  name: string;
  csv: string | undefined;
  args: string[];
}

const ERROR_CASES: ErrorCase[] = [
  { name: "unknown --by column", csv: "k,v\na,1\n", args: ["--by", "nope", "--sum", "v"] },
  { name: "unknown --sum column", csv: "k,v\na,1\n", args: ["--by", "k", "--sum", "V"] },
  { name: "empty file", csv: "", args: ["--by", "k", "--sum", "v"] },
  { name: "multi-character delimiter", csv: "k,v\na,1\n", args: ["--by", "k", "--sum", "v", "--delimiter", "ab"] },
  { name: "missing file", csv: undefined, args: ["--by", "k", "--sum", "v"] },
  { name: "missing required option", csv: "k,v\na,1\n", args: ["--by", "k"] },
];

export const implementCsvAggregator: DynoTask = {
  id: "implement-csv-aggregator-cli",
  title: "Implement a CSV group-by aggregator CLI from a spec",
  category: "implement",
  difficulty: 2,
  instruction:
    "`README.md` specifies a small command line tool, `aggregate.py`, that groups a CSV file by one column and summarises " +
    "another as JSON. There's only a stub for it right now. Please implement it to match the spec, including the error " +
    "handling and the edge cases it lists, using only the Python standard library. I'll run it against CSV files of my " +
    "own, so don't just fit the example.",
  maxIterations: 30,
  timeoutSec: 180,

  setup(dir) {
    writeFiles(dir, { "README.md": README, "aggregate.py": STUB });
  },

  async grade(dir) {
    return withScratchCopy(dir, async (scratch) => {
      const script = path.join(scratch, "aggregate.py");
      if (!fs.existsSync(script)) return fail("aggregate.py is missing");

      for (const [index, testCase] of SUCCESS_CASES.entries()) {
        const input = `inputs/case${index}.csv`;
        writeFiles(scratch, { [input]: testCase.csv });
        const result = await python([script, input, ...testCase.args], { cwd: scratch, timeoutMs: 15_000 });
        if (result.timedOut) return fail(`${testCase.name}: timed out`);
        if (result.code !== 0) return fail(`${testCase.name}: exit ${String(result.code)}: ${clip(result.stderr, 200)}`);
        let parsed: { groups?: Record<string, Group>; skipped?: number };
        try {
          parsed = JSON.parse(result.stdout) as typeof parsed;
        } catch {
          return fail(`${testCase.name}: stdout is not JSON: ${clip(result.stdout, 200)}`);
        }
        const wantKeys = JSON.stringify(Object.keys(testCase.groups));
        const gotKeys = JSON.stringify(Object.keys(parsed.groups ?? {}));
        if (wantKeys !== gotKeys) return fail(`${testCase.name}: group keys ${gotKeys}, expected ${wantKeys}`);
        const same =
          JSON.stringify(parsed.groups) === JSON.stringify(testCase.groups) && parsed.skipped === testCase.skipped;
        if (!same) {
          return fail(
            `${testCase.name}: got ${clip(JSON.stringify(parsed), 250)}, expected ${JSON.stringify({ groups: testCase.groups, skipped: testCase.skipped })}`,
          );
        }
      }

      for (const [index, testCase] of ERROR_CASES.entries()) {
        const input = `inputs/error${index}.csv`;
        if (testCase.csv !== undefined) writeFiles(scratch, { [input]: testCase.csv });
        const result = await python([script, input, ...testCase.args], { cwd: scratch, timeoutMs: 15_000 });
        if (result.code !== 2) return fail(`${testCase.name}: exit status ${String(result.code)}, expected 2`);
        if (result.stdout.trim() !== "") return fail(`${testCase.name}: stdout must be empty on errors`);
        if (result.stderr.trim() === "") return fail(`${testCase.name}: expected a message on stderr`);
      }
      return pass(`${SUCCESS_CASES.length} output cases and ${ERROR_CASES.length} error cases match the spec`);
    });
  },

  oracle(dir) {
    fs.writeFileSync(path.join(dir, "aggregate.py"), REFERENCE);
  },
};
