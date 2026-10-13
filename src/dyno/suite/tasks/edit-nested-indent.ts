/**
 * edit-nested-indentation — add a branch eight indentation levels deep in Python.
 *
 * Python gives indentation meaning, so an edit that lands one level off does not
 * just look wrong: it changes which `if` an `else` belongs to or what the loop
 * body is. The function also wraps everything in `except KeyError` (counting the
 * entry as skipped), which turns the obvious `entry["waived"]` into a silent
 * miscount when the optional key is absent. The grader compares the function's
 * output with an independent flat reference on adversarial data.
 */

import fs from "node:fs";
import path from "node:path";
import type { DynoTask } from "../../types.js";
import { clip, fail, pass, pythonCode, writeFiles } from "../helpers.js";

const MODULE = "ledger/reconcile.py";

const ORIGINAL = String.raw`"""Nightly reconciliation of ledger entries against the policy rules."""


def reconcile(accounts, ledger, policy):
    """Compare every pending ledger entry with the policy rule for its kind.

    accounts is a list of dicts with id and (optionally) active;
    ledger maps an account id to its entries; policy["rules"] holds one
    rule per entry kind (the first rule for a kind wins). Returns the counters the
    dashboard displays.
    """
    stats = {"matched": 0, "unmatched": 0, "posted": 0, "skipped": 0}
    for account in accounts:
        if not account.get("active", True):
            stats["skipped"] += 1
            continue
        for entry in ledger.get(account["id"], []):
            try:
                if entry["status"] == "pending":
                    for rule in policy["rules"]:
                        if rule["kind"] == entry["kind"]:
                            if abs(entry["amount"] - rule["expected"]) <= rule["tolerance"]:
                                stats["matched"] += 1
                            else:
                                stats["unmatched"] += 1
                            break
                    else:
                        stats["unmatched"] += 1
                elif entry["status"] == "posted":
                    stats["posted"] += 1
                else:
                    stats["skipped"] += 1
            except KeyError:
                # Malformed entries are counted instead of crashing the nightly job.
                stats["skipped"] += 1
    return stats
`;

/** Flat, structure-independent statement of the required behaviour. */
const PROBE = String.raw`
import json
from ledger.reconcile import reconcile


def reference(accounts, ledger, policy):
    stats = {"matched": 0, "unmatched": 0, "posted": 0, "skipped": 0, "waived": 0}
    for account in accounts:
        if not account.get("active", True):
            stats["skipped"] += 1
            continue
        for entry in ledger.get(account["id"], []):
            try:
                status = entry["status"]
                if status == "pending":
                    rule = next((r for r in policy["rules"] if r["kind"] == entry["kind"]), None)
                    if rule is None:
                        stats["unmatched"] += 1
                    elif abs(entry["amount"] - rule["expected"]) <= rule["tolerance"]:
                        stats["matched"] += 1
                    elif entry.get("waived"):
                        stats["waived"] += 1
                    else:
                        stats["unmatched"] += 1
                elif status == "posted":
                    stats["posted"] += 1
                else:
                    stats["skipped"] += 1
            except KeyError:
                stats["skipped"] += 1
    return stats


POLICY = {"rules": [
    {"kind": "fee", "expected": 100, "tolerance": 5},
    {"kind": "refund", "expected": -250, "tolerance": 0},
    {"kind": "fee", "expected": 999, "tolerance": 0},
]}
ACCOUNTS = [{"id": "A1", "active": True}, {"id": "A2"}, {"id": "A3", "active": False}, {"id": "A4", "active": True}]
LEDGER = {
    "A1": [
        {"status": "pending", "kind": "fee", "amount": 103},
        {"status": "pending", "kind": "fee", "amount": 120, "waived": True},
        {"status": "pending", "kind": "fee", "amount": 120},
        {"status": "pending", "kind": "fee", "amount": 120, "waived": False},
        {"status": "pending", "kind": "refund", "amount": -250},
        {"status": "pending", "kind": "refund", "amount": -251, "waived": True},
        {"status": "pending", "kind": "mystery", "amount": 5, "waived": True},
        {"status": "posted", "kind": "fee", "amount": 1, "waived": True},
        {"status": "void"},
        {"kind": "fee", "amount": 100},
    ],
    "A2": [
        {"status": "pending", "amount": 100, "waived": True},
        {"status": "pending", "kind": "fee", "waived": True},
        {"status": "pending", "kind": "fee", "amount": 100, "waived": True},
        {"status": "pending", "kind": "fee", "amount": 94, "waived": 1},
    ],
    "A3": [{"status": "pending", "kind": "fee", "amount": 500, "waived": True}],
    "A4": [{"status": "pending", "kind": "refund", "amount": -300, "waived": True}],
}

cases = {
    "full": (ACCOUNTS, LEDGER, POLICY),
    "empty": ([], {}, POLICY),
    "no_rules": (ACCOUNTS, LEDGER, {"rules": []}),
    "only_waivable": (
        [{"id": "B"}],
        {"B": [{"status": "pending", "kind": "fee", "amount": 0, "waived": True}] * 3},
        POLICY,
    ),
}
out = {}
for name, (accounts, ledger, policy) in cases.items():
    out[name] = {"actual": reconcile(accounts, ledger, policy), "expected": reference(accounts, ledger, policy)}
print(json.dumps(out))
`;

export const editNestedIndentation: DynoTask = {
  id: "edit-nested-indentation",
  title: "Add a branch deep inside nested Python control flow",
  category: "edit",
  difficulty: 3,
  instruction:
    "In `ledger/reconcile.py`, `reconcile()` needs to understand waived entries. When a pending entry has a matching rule " +
    "but its amount is outside that rule's tolerance, and the entry has a truthy `waived` field, count it under a new " +
    "`waived` counter instead of `unmatched`. The `waived` field is optional and usually absent. Everything else counts " +
    "exactly as before: entries within tolerance are still `matched`, entries with no matching rule are still `unmatched`, " +
    "and the returned dict must always contain a `waived` key (0 when there are none). Please make the smallest change " +
    "that does this; reviewers read the diff line by line, so don't restructure the function.",
  maxIterations: 25,
  timeoutSec: 150,

  setup(dir) {
    writeFiles(dir, { "ledger/__init__.py": "", [MODULE]: ORIGINAL });
  },

  async grade(dir) {
    const result = await pythonCode(PROBE, { cwd: dir, timeoutMs: 15_000 });
    if (result.code !== 0) return fail(`probe failed: ${clip(result.stderr)}`);
    let cases: Record<string, { actual: Record<string, number>; expected: Record<string, number> }>;
    try {
      cases = JSON.parse(result.stdout) as typeof cases;
    } catch {
      return fail(`unparseable probe output: ${clip(result.stdout)}`);
    }
    for (const [name, { actual, expected }] of Object.entries(cases)) {
      if (JSON.stringify(Object.entries(actual).sort()) !== JSON.stringify(Object.entries(expected).sort())) {
        return fail(`case "${name}": got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
      }
    }
    return pass("waived entries counted correctly in every case");
  },

  oracle(dir) {
    const file = path.join(dir, MODULE);
    let text = fs.readFileSync(file, "utf8");
    text = text.replace(
      '{"matched": 0, "unmatched": 0, "posted": 0, "skipped": 0}',
      '{"matched": 0, "unmatched": 0, "posted": 0, "skipped": 0, "waived": 0}',
    );
    const inner = " ".repeat(28);
    text = text.replace(
      `${inner}else:\n${inner}    stats["unmatched"] += 1\n`,
      `${inner}elif entry.get("waived"):\n${inner}    stats["waived"] += 1\n${inner}else:\n${inner}    stats["unmatched"] += 1\n`,
    );
    fs.writeFileSync(file, text);
  },
};
