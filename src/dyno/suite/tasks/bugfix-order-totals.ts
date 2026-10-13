/**
 * bugfix-order-totals — three independent defects behind a failing test run.
 *
 * Reading the traceback matters here: a guest customer makes a report test die
 * with `KeyError: 'tier'` four frames away from the cause, while the other two
 * defects (a boundary comparison and floor-vs-half-up rounding) produce plain
 * assertion diffs that only make sense once the docstrings are read. Two of the
 * tests only pass when both numeric bugs are fixed together.
 */

import fs from "node:fs";
import path from "node:path";
import type { DynoTask } from "../../types.js";
import { writeFiles } from "../helpers.js";
import { gradeBugfix, type BugfixSpec } from "./bugfix-common.js";

const PRICING = "orders/pricing.py";

const PRICING_SOURCE = String.raw`"""Pricing rules for customer orders. All money is integer cents."""

TIER_DISCOUNT_PCT = {"bronze": 0, "silver": 5, "gold": 10}
FREE_SHIPPING_FROM_CENTS = 5000
SHIPPING_CENTS = 499


def discount_cents(subtotal, customer):
    """Loyalty discount for customer, rounded half up to whole cents.

    A customer without a tier (the key is missing or None, as for guests) gets no
    discount.
    """
    pct = TIER_DISCOUNT_PCT[customer["tier"]]
    return subtotal * pct // 100


def subtotal_cents(items):
    """Sum of qty * unit price over the line items."""
    return sum(item["qty"] * item["unit_cents"] for item in items)


def shipping_cents(amount):
    """Shipping for an order whose discounted amount is amount; 50.00 and up ships free."""
    if amount > FREE_SHIPPING_FROM_CENTS:
        return 0
    return SHIPPING_CENTS


def order_total_cents(order):
    """Discounted subtotal plus shipping."""
    subtotal = subtotal_cents(order["items"])
    discounted = subtotal - discount_cents(subtotal, order["customer"])
    return discounted + shipping_cents(discounted)
`;

const REPORT_SOURCE = String.raw`"""Plain-text order reports."""

from orders.pricing import order_total_cents


def money(cents):
    return f"{cents // 100}.{cents % 100:02d}"


def receipt_line(order):
    return f"{order['id']}: {money(order_total_cents(order))}"


def summarize(orders):
    lines = [receipt_line(order) for order in orders]
    grand_total = sum(order_total_cents(order) for order in orders)
    lines.append(f"TOTAL: {money(grand_total)}")
    return "\n".join(lines)
`;

const TEST_SOURCE = String.raw`import unittest

from orders.pricing import discount_cents, order_total_cents, shipping_cents, subtotal_cents
from orders.report import money, receipt_line, summarize

GOLD = {"name": "Ada", "tier": "gold"}
SILVER = {"name": "Bo", "tier": "silver"}
GUEST = {"name": "Guest"}


def make_order(order_id, customer, *items):
    return {
        "id": order_id,
        "customer": customer,
        "items": [{"qty": qty, "unit_cents": cents} for qty, cents in items],
    }


class PricingTests(unittest.TestCase):
    def test_subtotal_sums_line_items(self):
        self.assertEqual(subtotal_cents(make_order("x", GUEST, (2, 300), (1, 450))["items"]), 1050)

    def test_gold_discount_is_ten_percent(self):
        self.assertEqual(discount_cents(2000, GOLD), 200)

    def test_silver_discount_rounds_half_up(self):
        self.assertEqual(discount_cents(1030, SILVER), 52)

    def test_guest_gets_no_discount(self):
        self.assertEqual(discount_cents(2000, GUEST), 0)

    def test_free_shipping_at_exactly_fifty(self):
        self.assertEqual(shipping_cents(5000), 0)

    def test_shipping_below_threshold(self):
        self.assertEqual(shipping_cents(4999), 499)

    def test_free_shipping_looks_at_the_discounted_amount(self):
        # 55.55 less a 5.56 gold discount is 49.99: not enough for free shipping.
        order = make_order("A-2", GOLD, (1, 5555))
        self.assertEqual(order_total_cents(order), 5498)

    def test_empty_order_costs_only_shipping(self):
        self.assertEqual(order_total_cents(make_order("E-1", GUEST)), 499)


class ReportTests(unittest.TestCase):
    def test_money_formatting(self):
        self.assertEqual((money(5), money(123456)), ("0.05", "1234.56"))

    def test_receipt_line(self):
        self.assertEqual(receipt_line(make_order("A-1", GOLD, (2, 3000))), "A-1: 54.00")

    def test_summarize_mixed_customers(self):
        orders = [make_order("A-1", GOLD, (2, 3000)), make_order("B-2", GUEST, (1, 1000))]
        self.assertEqual(summarize(orders), "A-1: 54.00\nB-2: 14.99\nTOTAL: 68.99")


if __name__ == "__main__":
    unittest.main()
`;

const HIDDEN = String.raw`
from orders.pricing import discount_cents, order_total_cents, shipping_cents
from orders.report import summarize

GOLD = {"tier": "gold"}
SILVER = {"tier": "silver"}
BRONZE = {"tier": "bronze"}


def half_up(n, pct):
    return (n * pct + 50) // 100


for subtotal in list(range(0, 600, 7)) + [994, 995, 999, 1010, 5555, 5556, 123456]:
    assert discount_cents(subtotal, GOLD) == half_up(subtotal, 10), ("gold", subtotal)
    assert discount_cents(subtotal, SILVER) == half_up(subtotal, 5), ("silver", subtotal)
    assert discount_cents(subtotal, BRONZE) == 0, ("bronze", subtotal)
    assert discount_cents(subtotal, {"tier": None}) == 0, ("tier None", subtotal)
    assert discount_cents(subtotal, {}) == 0, ("no tier", subtotal)

for amount in (0, 1, 4999, 5000, 5001, 99999):
    assert shipping_cents(amount) == (0 if amount >= 5000 else 499), amount

for qty, cents, customer in [(3, 1700, GOLD), (1, 5000, {}), (7, 713, SILVER), (1, 5556, GOLD), (2, 2500, {"tier": None})]:
    subtotal = qty * cents
    discounted = subtotal - half_up(subtotal, {"gold": 10, "silver": 5}.get(customer.get("tier"), 0))
    expected = discounted + (0 if discounted >= 5000 else 499)
    order = {"id": "H", "customer": customer, "items": [{"qty": qty, "unit_cents": cents}]}
    assert order_total_cents(order) == expected, (qty, cents, customer)

assert summarize([]) == "TOTAL: 0.00"
print("HIDDEN-OK")
`;

const SPEC: BugfixSpec = {
  tests: { "tests/__init__.py": "", "tests/test_orders.py": TEST_SOURCE },
  modules: ["tests.test_orders"],
  expectedTests: 11,
  hiddenChecks: HIDDEN,
};

export const bugfixOrderTotals: DynoTask = {
  id: "bugfix-order-totals",
  title: "Fix order pricing bugs behind a failing test run",
  category: "bugfix",
  difficulty: 2,
  instruction:
    "`python3 -m unittest tests.test_orders` is failing in this project: some tests error out and others fail on wrong " +
    "numbers. Please find the bugs in the code under `orders/` and fix them. The tests describe the intended behaviour " +
    "(and the docstrings explain the rules), so don't change the tests — the code is what's wrong. When you're done " +
    "the whole test file should pass.",
  maxIterations: 25,
  timeoutSec: 150,

  setup(dir) {
    writeFiles(dir, {
      "orders/__init__.py": "",
      [PRICING]: PRICING_SOURCE,
      "orders/report.py": REPORT_SOURCE,
      ...SPEC.tests,
    });
  },

  grade: (dir) => gradeBugfix(dir, SPEC),

  oracle(dir) {
    const file = path.join(dir, PRICING);
    const text = fs
      .readFileSync(file, "utf8")
      .replace('pct = TIER_DISCOUNT_PCT[customer["tier"]]', 'pct = TIER_DISCOUNT_PCT[customer.get("tier") or "bronze"]')
      .replace("return subtotal * pct // 100", "return (subtotal * pct + 50) // 100")
      .replace("if amount > FREE_SHIPPING_FROM_CENTS:", "if amount >= FREE_SHIPPING_FROM_CENTS:");
    fs.writeFileSync(file, text);
  },
};
