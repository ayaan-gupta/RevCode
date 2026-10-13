/**
 * edit-tricky-characters — change string literals full of quotes, backslashes,
 * escape sequences, non-ASCII characters and literal TAB characters.
 *
 * Each of those is a classic way for a model to mis-copy `oldText` or to double
 * (or halve) escaping when it writes the replacement through a JSON tool call.
 * The grader never looks at the source text: it renders receipts through the
 * module and compares the exact output.
 */

import fs from "node:fs";
import path from "node:path";
import type { DynoTask } from "../../types.js";
import { clip, fail, pass, pythonCode, writeFiles } from "../helpers.js";

const TEMPLATES = "receipts/templates.py";
const TAB = "\t";

/** `<TAB>` markers keep the literal tabs visible in this file. */
const withTabs = (text: string): string => text.replaceAll("<TAB>", TAB);

const TEMPLATES_SOURCE = withTabs(String.raw`"""Text templates for the till-roll printer.

The printer firmware is picky: columns are aligned on literal TAB characters,
the banner uses box-drawing characters, and the footer carries a Windows path
that back-office staff paste into Explorer.
"""

SHOP_BANNER = "╔══ {shop} ══╗\n"

# Item rows: columns are separated by TAB characters (the printer aligns on them).
ITEM_ROW = "{qty}×<TAB>{name}<TAB>{price}\n"

SEPARATOR = "-" * 24 + "\n"

TOTAL_ROW = "TOTAL:<TAB>{total}\n"

FOOTER = "Paid via \"{method}\" → C:\\Receipts\\{id}.txt\n"

GREETING = 'Don\'t forget your receipt — it\'s "required" for returns.\n'

UNC_NOTE = "Network copies: \\\\files01\\receipts\\{id}\n"

# ESC + "m": the cutter command. Must reach the printer byte-for-byte.
CUT_COMMAND = "\x1bm\n"
`);

const RENDER_SOURCE = String.raw`"""Assemble a receipt from the templates."""

from receipts import templates as t


def render_receipt(shop, items, method, receipt_id):
    parts = [t.SHOP_BANNER.format(shop=shop)]
    total_cents = 0
    for item in items:
        parts.append(t.ITEM_ROW.format(**item))
        total_cents += item["qty"] * item["cents"]
    parts.append(t.SEPARATOR)
    parts.append(t.TOTAL_ROW.format(total=f"{total_cents // 100}.{total_cents % 100:02d}"))
    parts.append(t.FOOTER.format(method=method, id=receipt_id))
    return "".join(parts)
`;

const DEMO_SOURCE = String.raw`from receipts.render import render_receipt

ITEMS = [
    {"sku": "TEA-01", "qty": 2, "name": "Green tea", "price": "3.50", "cents": 350},
    {"sku": "MUG-9", "qty": 1, "name": 'Mug "Large"', "price": "12.00", "cents": 1200},
]

print(render_receipt("Café Ünal", ITEMS, "card", "R-1007"), end="")
`;

/** What the module must produce for the grader's two probe receipts. */
function expectedReceipt(shop: string, rows: string[], total: string, method: string, id: string): string {
  return (
    `╔══ ${shop} ══╗\n` +
    rows.map((row) => `${row}\n`).join("") +
    `${"-".repeat(24)}\n` +
    `TOTAL:${TAB}${total}\n` +
    `Paid via "${method}" → D:\\Archive\\${id}.pdf\n`
  );
}

const PROBE = String.raw`
import json
from receipts import templates as t
from receipts.render import render_receipt

items_a = [
    {"sku": "TEA-01", "qty": 2, "name": "Green tea", "price": "3.50", "cents": 350},
    {"sku": "MUG-9", "qty": 1, "name": 'Mug "Large"', "price": "12.00", "cents": 1200},
]
items_b = [{"sku": "X/7", "qty": 3, "name": "Back\\slash", "price": "0.99", "cents": 99}]
print(json.dumps({
    "a": render_receipt("Café Ünal", items_a, "card", "R-1007"),
    "b": render_receipt("Shop", items_b, "cash", "R-2"),
    "untouched": {name: getattr(t, name) for name in
                  ("SHOP_BANNER", "SEPARATOR", "TOTAL_ROW", "GREETING", "UNC_NOTE", "CUT_COMMAND")},
}))
`;

const EXPECTED_UNTOUCHED: Record<string, string> = {
  SHOP_BANNER: "╔══ {shop} ══╗\n",
  SEPARATOR: `${"-".repeat(24)}\n`,
  TOTAL_ROW: `TOTAL:${TAB}{total}\n`,
  GREETING: 'Don\'t forget your receipt — it\'s "required" for returns.\n',
  UNC_NOTE: "Network copies: \\\\files01\\receipts\\{id}\n",
  CUT_COMMAND: "\x1bm\n",
};

export const editTrickyCharacters: DynoTask = {
  id: "edit-tricky-characters",
  title: "Edit templates full of quotes, backslashes, unicode and tabs",
  category: "edit",
  difficulty: 3,
  instruction:
    "The till-roll printer templates live in `receipts/templates.py`. I need two changes. First, the footer should point " +
    "customers at the archived PDF instead of the old text file: for payment method `card` and receipt id `R-1007` the " +
    'footer line has to print exactly `Paid via "card" → D:\\Archive\\R-1007.pdf` (nothing else about it changes, including ' +
    "the trailing newline). Second, item rows need the item's SKU as a new first column, followed by a TAB character, and " +
    "then the columns they already have. Please don't touch any of the other templates; the printer firmware is fussy " +
    "about them. `python3 demo.py` prints a sample receipt if you want to look at the result.",
  maxIterations: 30,
  timeoutSec: 180,

  setup(dir) {
    writeFiles(dir, {
      "receipts/__init__.py": "",
      [TEMPLATES]: TEMPLATES_SOURCE,
      "receipts/render.py": RENDER_SOURCE,
      "demo.py": DEMO_SOURCE,
    });
  },

  async grade(dir) {
    const result = await pythonCode(PROBE, { cwd: dir, timeoutMs: 15_000 });
    if (result.code !== 0) return fail(`probe failed: ${clip(result.stderr)}`);

    let output: { a: string; b: string; untouched: Record<string, string> };
    try {
      output = JSON.parse(result.stdout) as typeof output;
    } catch {
      return fail(`unparseable probe output: ${clip(result.stdout)}`);
    }

    const wantA = expectedReceipt(
      "Café Ünal",
      [`TEA-01${TAB}2×${TAB}Green tea${TAB}3.50`, `MUG-9${TAB}1×${TAB}Mug "Large"${TAB}12.00`],
      "19.00",
      "card",
      "R-1007",
    );
    const wantB = expectedReceipt("Shop", [`X/7${TAB}3×${TAB}Back\\slash${TAB}0.99`], "2.97", "cash", "R-2");

    if (output.a !== wantA) return fail(`receipt A differs.\nexpected: ${JSON.stringify(wantA)}\nactual:   ${JSON.stringify(output.a)}`);
    if (output.b !== wantB) return fail(`receipt B differs.\nexpected: ${JSON.stringify(wantB)}\nactual:   ${JSON.stringify(output.b)}`);
    for (const [name, value] of Object.entries(EXPECTED_UNTOUCHED)) {
      if (output.untouched[name] !== value) {
        return fail(`template ${name} was altered: ${JSON.stringify(output.untouched[name])}`);
      }
    }
    return pass("footer and item rows updated, other templates intact");
  },

  oracle(dir) {
    const file = path.join(dir, TEMPLATES);
    let text = fs.readFileSync(file, "utf8");
    text = text.replace(String.raw`C:\\Receipts\\{id}.txt`, String.raw`D:\\Archive\\{id}.pdf`);
    text = text.replace(withTabs(`ITEM_ROW = "{qty}×<TAB>`), withTabs(`ITEM_ROW = "{sku}<TAB>{qty}×<TAB>`));
    fs.writeFileSync(file, text);
  },
};
