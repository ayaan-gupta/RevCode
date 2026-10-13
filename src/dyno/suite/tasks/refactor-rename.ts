/**
 * refactor-rename-function — rename `fetch_data` to `load_records` everywhere.
 *
 * The old name shows up as an import, a module-attribute call, a string handed to
 * `mock.patch`, a string handed to `getattr`, a docstring and the README. Misses
 * in the string references only surface at runtime, so the grader both greps the
 * whole tree and runs the program and its tests.
 */

import fs from "node:fs";
import path from "node:path";
import type { DynoTask } from "../../types.js";
import { clip, fail, listFiles, pass, python, pythonCode, withScratchCopy, writeFiles } from "../helpers.js";

const OLD_NAME = "fetch_data";
const NEW_NAME = "load_records";
const MIN_TESTS = 6;

const FILES: Record<string, string> = {
  "store/__init__.py": "",

  "store/db.py": String.raw`"""A tiny in-memory 'database' that the reports read from."""

_TABLES = {
    "users": [
        {"id": 1, "name": "ada", "plan": "pro"},
        {"id": 2, "name": "grace", "plan": "free"},
        {"id": 3, "name": "linus", "plan": "pro"},
    ],
    "orders": [
        {"id": 10, "user_id": 1, "cents": 1250, "state": "paid"},
        {"id": 11, "user_id": 1, "cents": 400, "state": "refunded"},
        {"id": 12, "user_id": 2, "cents": 999, "state": "paid"},
        {"id": 13, "user_id": 3, "cents": 20000, "state": "paid"},
        {"id": 14, "user_id": 3, "cents": 150, "state": "pending"},
    ],
}


def fetch_data(table, where=None):
    """Return copies of the rows in table, optionally filtered by where.

    where is a dict of column -> required value. Unknown tables raise KeyError.
    """
    rows = _TABLES[table]
    if where:
        rows = [row for row in rows if all(row.get(k) == v for k, v in where.items())]
    return [dict(row) for row in rows]


def table_names():
    return sorted(_TABLES)
`,

  "store/report.py": String.raw`"""Reports built on top of the database helpers."""

from store.db import fetch_data


def revenue_by_user():
    """Paid revenue per user name, in cents, highest first."""
    names = {user["id"]: user["name"] for user in fetch_data("users")}
    totals = {}
    for order in fetch_data("orders", where={"state": "paid"}):
        name = names[order["user_id"]]
        totals[name] = totals.get(name, 0) + order["cents"]
    return sorted(totals.items(), key=lambda item: (-item[1], item[0]))


def pro_users():
    return [user["name"] for user in fetch_data("users", where={"plan": "pro"})]
`,

  "store/sync.py": String.raw`"""Export job: pushes pending orders to the (pretend) billing service."""

import store.db as db

# The loader is looked up by name so tests can swap it for a fake.
LOADER_NAME = "fetch_data"


def pending_export():
    loader = getattr(db, LOADER_NAME)
    orders = loader("orders", where={"state": "pending"})
    return [f"order {o['id']} user {o['user_id']} {o['cents']}c" for o in orders]


def refunds_total():
    return sum(order["cents"] for order in db.fetch_data("orders", where={"state": "refunded"}))
`,

  "cli.py": String.raw`"""Command line entry point: report | sync | tables."""

import sys

from store import report, sync
from store.db import fetch_data, table_names


def main(argv):
    command = argv[0] if argv else "report"
    if command == "report":
        for name, cents in report.revenue_by_user():
            print(f"{name}: {cents / 100:.2f}")
    elif command == "sync":
        for line in sync.pending_export():
            print(line)
        print(f"refunds: {sync.refunds_total()}")
    elif command == "tables":
        for name in table_names():
            print(f"{name}: {len(fetch_data(name))} rows")
    else:
        print(f"unknown command: {command}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
`,

  "tests/__init__.py": "",

  "tests/test_db.py": String.raw`import unittest

from store.db import fetch_data


class DbTests(unittest.TestCase):
    def test_returns_all_rows(self):
        self.assertEqual(len(fetch_data("users")), 3)

    def test_filters_with_where(self):
        rows = fetch_data("orders", where={"user_id": 3, "state": "paid"})
        self.assertEqual([row["id"] for row in rows], [13])

    def test_returns_copies(self):
        fetch_data("users")[0]["name"] = "mutated"
        self.assertEqual(fetch_data("users")[0]["name"], "ada")


if __name__ == "__main__":
    unittest.main()
`,

  "tests/test_report.py": String.raw`import unittest
from unittest import mock

from store import report, sync


class ReportTests(unittest.TestCase):
    def test_revenue_by_user(self):
        self.assertEqual(
            report.revenue_by_user(), [("linus", 20000), ("ada", 1250), ("grace", 999)]
        )

    def test_report_reads_through_the_database_helper(self):
        fake_rows = {"users": [{"id": 1, "name": "zed"}], "orders": [{"user_id": 1, "cents": 5}]}
        with mock.patch("store.report.fetch_data", side_effect=lambda table, where=None: fake_rows[table]):
            self.assertEqual(report.revenue_by_user(), [("zed", 5)])

    def test_sync_uses_the_named_loader(self):
        with mock.patch.object(sync, "LOADER_NAME", "fetch_data"):
            self.assertEqual(sync.pending_export(), ["order 14 user 3 150c"])


if __name__ == "__main__":
    unittest.main()
`,

  "README.md": `# store

Small reporting helpers over an in-memory database.

## Reading data

Everything goes through \`fetch_data(table, where=None)\` in \`store/db.py\`. It
returns a list of row dicts; pass \`where={"plan": "pro"}\` to filter. Call
\`fetch_data\` rather than touching \`_TABLES\` directly.

## Commands

    python3 cli.py report
    python3 cli.py sync
    python3 cli.py tables
`,
};

const EXPECTED_CLI: Record<string, string> = {
  report: "linus: 200.00\nada: 12.50\ngrace: 9.99\n",
  sync: "order 14 user 3 150c\nrefunds: 400\n",
  tables: "orders: 5 rows\nusers: 3 rows\n",
};

const OLD_NAME_PATTERN = new RegExp(`\\b${OLD_NAME}\\b`);

/** Plain text search over every file in the tree (docs and tests included). */
function filesMentioningOldName(dir: string): string[] {
  return listFiles(dir).filter((relative) => {
    const text = fs.readFileSync(path.join(dir, relative), "utf8");
    return OLD_NAME_PATTERN.test(text);
  });
}

export const refactorRenameFunction: DynoTask = {
  id: "refactor-rename-function",
  title: "Rename a function across code, tests and docs",
  category: "refactor",
  difficulty: 2,
  instruction:
    `Please rename the function \`${OLD_NAME}\` in \`store/db.py\` to \`${NEW_NAME}\`. It is used from several modules, the ` +
    "tests and the README, and I want the old name gone from the whole project — no leftover references and no alias or " +
    "wrapper under the old name. Behaviour must not change: `python3 cli.py report` and the tests " +
    "(`python3 -m unittest discover -s tests -t .`) should work exactly as before.",
  maxIterations: 30,
  timeoutSec: 180,

  setup(dir) {
    writeFiles(dir, FILES);
  },

  async grade(dir) {
    const leftovers = filesMentioningOldName(dir);
    if (leftovers.length > 0) return fail(`old name "${OLD_NAME}" still appears in: ${leftovers.join(", ")}`);

    const probe = await pythonCode(
      `import json\nfrom store.db import ${NEW_NAME}\nprint(json.dumps([${NEW_NAME}("users", where={"plan": "pro"}), ${NEW_NAME}("orders", {"state": "refunded"})]))`,
      { cwd: dir, timeoutMs: 15_000 },
    );
    if (probe.code !== 0) return fail(`store.db.${NEW_NAME} is not importable: ${clip(probe.stderr)}`);
    const rows = JSON.parse(probe.stdout) as unknown;
    const wantRows = [
      [
        { id: 1, name: "ada", plan: "pro" },
        { id: 3, name: "linus", plan: "pro" },
      ],
      [{ id: 11, user_id: 1, cents: 400, state: "refunded" }],
    ];
    if (JSON.stringify(rows) !== JSON.stringify(wantRows)) return fail(`${NEW_NAME} returns the wrong rows: ${clip(probe.stdout)}`);

    for (const [command, wanted] of Object.entries(EXPECTED_CLI)) {
      const result = await python(["cli.py", command], { cwd: dir, timeoutMs: 15_000 });
      if (result.code !== 0) return fail(`cli.py ${command} exited ${String(result.code)}: ${clip(result.stderr)}`);
      if (result.stdout !== wanted) return fail(`cli.py ${command} printed ${JSON.stringify(clip(result.stdout))}`);
    }

    return withScratchCopy(dir, async (scratch) => {
      const tests = await python(["-m", "unittest", "discover", "-s", "tests", "-t", "."], { cwd: scratch, timeoutMs: 30_000 });
      const ran = /^Ran (\d+) tests?/m.exec(tests.stderr);
      if (tests.code !== 0 || !/^OK\b/m.test(tests.stderr)) return fail(`tests fail: ${clip(tests.stderr.split("\n").slice(-12).join("\n"))}`);
      if (!ran || Number(ran[1]) < MIN_TESTS) return fail(`only ${ran?.[1] ?? "0"} tests ran; the original ${MIN_TESTS} must still run`);
      return pass(`no "${OLD_NAME}" left, CLI output unchanged, ${ran[1]} tests pass`);
    });
  },

  oracle(dir) {
    for (const relative of filesMentioningOldName(dir)) {
      const file = path.join(dir, relative);
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll(OLD_NAME, NEW_NAME));
    }
  },
};
