/**
 * edit-big-file-constant — a one-line change inside a ~1,500-line module.
 *
 * Whole-file rewrites are the failure mode this probes: regenerating 1,500 lines
 * through a tool call truncates, drifts, or silently "improves" code. The target
 * name also appears in comments and a function body, so an exact-match edit has
 * to anchor on the assignment rather than on the bare identifier.
 */

import fs from "node:fs";
import path from "node:path";
import type { DynoTask } from "../../types.js";
import { clip, fail, makeRng, pass, pythonCode, readText, withScratchCopy, writeFiles } from "../helpers.js";

const ORIGINAL_CEILING = 4000;
const NEW_CEILING = 9000;
const RULE_COUNT = 178;
const RETRY_SECTION_AFTER = 88;
const CAPPED_AT_CEILING_ROW = 31;
const MODULE = "inventory/registry.py";

/** The generated module, parameterised on the one value the task changes. */
function renderRegistry(ceiling: number): string {
  const rng = makeRng(20240611);
  const out: string[] = [
    String.raw`"""Pricing-rule registry for the inventory service.

Each rule is registered under a key and maps (qty, unit_cents) to a total in
cents. The module is long because the rules are exported from the legacy pricing
spreadsheet, one function per row. See RETRY_CEILING_MS below for the supplier
sync back-off cap.
"""

HANDLERS = {}


def register(key):
    def decorator(fn):
        HANDLERS[key] = fn
        return fn

    return decorator

`,
  ];

  for (let n = 1; n <= RULE_COUNT; n++) {
    const key = `rule_${String(n).padStart(3, "0")}`;
    // Row 31 is always a capped rule: its cap deliberately equals the retry ceiling's old value.
    const drawn = rng.int(0, 4);
    const shape = n === CAPPED_AT_CEILING_ROW ? 2 : drawn;
    out.push("", `@register("${key}")`, `def ${key}(qty, unit_cents):`);
    if (shape === 0) {
      const pct = rng.int(2, 15);
      const from = rng.int(10, 60);
      const fee = rng.int(20, 400);
      out.push(
        `    """Row ${n}: ${pct}% bulk discount from ${from} units."""`,
        "    total = qty * unit_cents",
        `    if qty >= ${from}:`,
        `        total -= total * ${pct} // 100`,
        `    total += ${fee}`,
        "    return total",
      );
    } else if (shape === 1) {
      const full = rng.int(5, 40);
      const pct = rng.int(60, 95);
      const fee = rng.int(0, 250);
      out.push(
        `    """Row ${n}: first ${full} units at full price, the rest at ${pct}%."""`,
        `    full = min(qty, ${full}) * unit_cents`,
        `    rest = max(qty - ${full}, 0) * (unit_cents * ${pct} // 100)`,
        `    return full + rest + ${fee}`,
      );
    } else if (shape === 2) {
      // One rule deliberately caps at the same number as the retry ceiling.
      const cap = n === CAPPED_AT_CEILING_ROW ? ORIGINAL_CEILING : rng.int(1500, 9500);
      const fee = rng.int(50, 600);
      out.push(
        `    """Row ${n}: flat fee of ${fee} cents, capped at ${cap}."""`,
        `    total = qty * unit_cents + ${fee}`,
        `    return min(total, ${cap})`,
      );
    } else if (shape === 3) {
      const step = rng.pick([5, 10, 25, 50]);
      out.push(
        `    """Row ${n}: totals are rounded to the nearest ${step} cents."""`,
        "    total = qty * unit_cents",
        `    return (total + ${Math.floor(step / 2)}) // ${step} * ${step}`,
      );
    } else {
      const above = rng.int(100, 900);
      const surcharge = rng.int(1, 30);
      out.push(
        `    """Row ${n}: ${surcharge} cents per unit surcharge above ${above} cents."""`,
        "    total = qty * unit_cents",
        `    if unit_cents > ${above}:`,
        `        total += qty * ${surcharge}`,
        "    return total",
      );
    }
    out.push("");

    if (n === RETRY_SECTION_AFTER) {
      out.push(
        "",
        "# " + "-".repeat(75),
        "# Retry policy for the supplier sync (milliseconds)",
        "# " + "-".repeat(75),
        "RETRY_BASE_MS = 250",
        `RETRY_CEILING_MS = ${ceiling}`,
        "",
        "",
        "def next_delay(attempt):",
        '    """Exponential back-off for attempt (0-based), capped at RETRY_CEILING_MS."""',
        "    return min(RETRY_BASE_MS * (2**attempt), RETRY_CEILING_MS)",
        "",
      );
    }
  }

  out.push(
    "",
    "def describe_policy():",
    '    """One-line summary used by the admin page."""',
    '    return f"retry: base={RETRY_BASE_MS}ms ceiling={RETRY_CEILING_MS}ms"',
    "",
  );
  return out.join("\n");
}

/** Prints everything observable about the module so two versions can be compared. */
const PROBE = String.raw`
import hashlib, json
from inventory import registry as r
h = hashlib.sha256()
for key in sorted(r.HANDLERS):
    for args in ((1, 100), (7, 1999), (26, 250), (40, 975), (64, 12)):
        h.update(repr(r.HANDLERS[key](*args)).encode())
print(json.dumps({
    "ceiling": r.RETRY_CEILING_MS,
    "base": r.RETRY_BASE_MS,
    "delays": [r.next_delay(a) for a in range(9)],
    "policy": r.describe_policy(),
    "rules": len(r.HANDLERS),
    "digest": h.hexdigest(),
}))
`;

async function probe(dir: string): Promise<Record<string, unknown> | string> {
  const result = await pythonCode(PROBE, { cwd: dir, timeoutMs: 20_000 });
  if (result.code !== 0) return clip(result.stderr || "module failed to import");
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return `unparseable probe output: ${clip(result.stdout)}`;
  }
}

export const editBigFileConstant: DynoTask = {
  id: "edit-big-file-constant",
  title: "Change one constant in a 1,500-line module",
  category: "edit",
  difficulty: 1,
  instruction:
    "`inventory/registry.py` is a big module exported from a pricing spreadsheet. The supplier-sync retry back-off ceiling " +
    `\`RETRY_CEILING_MS\` is currently ${ORIGINAL_CEILING}; it should be ${NEW_CEILING}. Make just that change and leave ` +
    "everything else in the file exactly as it is, because other tooling diffs the file against the spreadsheet export.",
  maxIterations: 15,
  timeoutSec: 90,

  setup(dir) {
    writeFiles(dir, {
      "inventory/__init__.py": "",
      [MODULE]: renderRegistry(ORIGINAL_CEILING),
    });
  },

  async grade(dir) {
    const text = readText(dir, MODULE);
    if (text === undefined) return fail(`${MODULE} is missing`);

    const original = renderRegistry(ORIGINAL_CEILING).split("\n");
    const lines = text.split("\n");
    if (lines.length !== original.length) {
      return fail(`line count changed: ${original.length} -> ${lines.length}; the rest of the file must stay intact`);
    }
    const changed = lines.flatMap((line, i) => (line === original[i] ? [] : [i + 1]));
    if (changed.length > 1) return fail(`${changed.length} lines differ from the original (expected only the constant): lines ${changed.slice(0, 5).join(", ")}`);

    const actual = await probe(dir);
    if (typeof actual === "string") return fail(actual);

    const expected = await withScratchCopy(dir, async (scratch) => {
      fs.writeFileSync(path.join(scratch, MODULE), renderRegistry(NEW_CEILING));
      return probe(scratch);
    });
    if (typeof expected === "string") return fail(`reference module failed: ${expected}`);

    if (actual.ceiling !== NEW_CEILING) return fail(`RETRY_CEILING_MS is ${String(actual.ceiling)}, expected ${NEW_CEILING}`);
    for (const key of Object.keys(expected)) {
      if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key])) {
        return fail(`module behaviour differs from the expected result at "${key}"`);
      }
    }
    return pass(`RETRY_CEILING_MS=${NEW_CEILING}, ${lines.length} lines intact`);
  },

  oracle(dir) {
    const file = path.join(dir, MODULE);
    const text = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, text.replace(`RETRY_CEILING_MS = ${ORIGINAL_CEILING}`, `RETRY_CEILING_MS = ${NEW_CEILING}`));
  },
};
