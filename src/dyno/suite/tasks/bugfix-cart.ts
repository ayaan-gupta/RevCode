/**
 * bugfix-shared-state-cart — aliasing bugs that only show up across objects.
 *
 * Each test passes or fails depending on what an earlier test or another cart
 * did: a mutable default argument shares one list between carts, and the cart
 * stores references to the catalogue's own dicts, so a sale coupon rewrites the
 * catalogue for everyone. These are the bugs a model "fixes" locally without
 * noticing the shared object, which is why the private checks create several
 * carts and compare every cart and the catalogue afterwards.
 */

import fs from "node:fs";
import path from "node:path";
import type { DynoTask } from "../../types.js";
import { writeFiles } from "../helpers.js";
import { gradeBugfix, type BugfixSpec } from "./bugfix-common.js";

const CART = "shop/cart.py";

const CATALOG_SOURCE = String.raw`"""The product catalogue. Prices are integer cents."""

CATALOG = {
    "apple": {"sku": "apple", "name": "Apple", "price": 120},
    "bread": {"sku": "bread", "name": "Sourdough", "price": 450},
    "cheese": {"sku": "cheese", "name": "Cheddar", "price": 780},
}
`;

const CART_SOURCE = String.raw`"""Shopping cart with coupons."""

from shop.catalog import CATALOG


class Cart:
    def __init__(self, items=[]):
        """items seeds the cart with product dicts; the cart keeps its own copy."""
        self.items = items
        self.coupons = []

    def add(self, sku, qty=1):
        """Put qty units of catalogue product sku into the cart."""
        product = CATALOG[sku]
        for _ in range(qty):
            self.items.append(product)
        return self

    def apply_coupon(self, coupon):
        """Register a coupon.

        * {"type": "sale", "sku": s, "price": p} reprices the units of s that are in
          this cart right now; it affects this cart only.
        * {"type": "percent", "value": v} takes v% off the running total (half up).
        * {"type": "fixed", "value": c} takes c cents off the running total.
        """
        if coupon["type"] == "sale":
            for item in self.items:
                if item["sku"] == coupon["sku"]:
                    item["price"] = coupon["price"]
        else:
            self.coupons.append(coupon)
        return self

    def total(self):
        """Cart total in cents. Percent coupons apply first (in the order added), then fixed ones."""
        total = sum(item["price"] for item in self.items)
        for coupon in self.coupons:
            if coupon["type"] == "percent":
                total -= (total * coupon["value"] + 50) // 100
            elif coupon["type"] == "fixed":
                total -= coupon["value"]
        return total
`;

const TEST_SOURCE = String.raw`import unittest

from shop.cart import Cart
from shop.catalog import CATALOG


class CartTests(unittest.TestCase):
    def test_empty_cart_is_free(self):
        self.assertEqual(Cart().total(), 0)

    def test_add_and_total(self):
        self.assertEqual(Cart().add("apple", 3).add("bread").total(), 3 * 120 + 450)

    def test_carts_do_not_share_their_items(self):
        first = Cart().add("apple")
        second = Cart()
        self.assertEqual(second.total(), 0)
        self.assertEqual(len(first.items), 1)

    def test_percent_coupon_rounds_half_up(self):
        self.assertEqual(Cart().add("bread").apply_coupon({"type": "percent", "value": 15}).total(), 450 - 68)

    def test_percent_applies_before_fixed_whatever_the_order_added(self):
        cart = Cart().add("cheese", 2).add("bread")
        cart.apply_coupon({"type": "fixed", "value": 200}).apply_coupon({"type": "percent", "value": 10})
        self.assertEqual(cart.total(), 2010 - 201 - 200)

    def test_sale_coupon_reprices_this_cart(self):
        cart = Cart().add("apple", 4).add("bread")
        cart.apply_coupon({"type": "sale", "sku": "apple", "price": 100})
        self.assertEqual(cart.total(), 4 * 100 + 450)

    def test_sale_coupon_leaves_the_catalogue_alone(self):
        Cart().add("apple").apply_coupon({"type": "sale", "sku": "apple", "price": 1})
        self.assertEqual(CATALOG["apple"]["price"], 120)

    def test_sale_in_one_cart_does_not_reprice_another_cart(self):
        mine = Cart().add("cheese")
        theirs = Cart().add("cheese")
        mine.apply_coupon({"type": "sale", "sku": "cheese", "price": 500})
        self.assertEqual((mine.total(), theirs.total()), (500, 780))


if __name__ == "__main__":
    unittest.main()
`;

const HIDDEN = String.raw`
import copy
import random

from shop.cart import Cart
from shop.catalog import CATALOG

pristine = copy.deepcopy(CATALOG)

# A caller's seed list is never modified by the cart.
seed = [dict(CATALOG["apple"])]
cart = Cart(items=seed)
cart.add("bread", 2)
assert len(seed) == 1, "Cart modified the list it was given"
assert cart.total() == 120 + 2 * 450

# Many carts built in a row stay independent.
carts = [Cart().add("apple", n) for n in range(1, 6)]
assert [len(c.items) for c in carts] == [1, 2, 3, 4, 5]
assert Cart().total() == 0

# Randomised comparison with a straightforward model, including sales on some carts.
rng = random.Random(11)
skus = sorted(pristine)
for _ in range(200):
    cart = Cart()
    model = []
    for _ in range(rng.randint(0, 6)):
        sku, qty = rng.choice(skus), rng.randint(1, 3)
        cart.add(sku, qty)
        model += [[sku, pristine[sku]["price"]]] * qty
    percents, fixeds = [], []
    sale = None
    for _ in range(rng.randint(0, 4)):
        kind = rng.choice(["percent", "fixed", "sale"])
        if kind == "percent":
            coupon = {"type": "percent", "value": rng.randint(1, 50)}
            percents.append(coupon["value"])
        elif kind == "fixed":
            coupon = {"type": "fixed", "value": rng.randint(1, 300)}
            fixeds.append(coupon["value"])
        else:
            sku = rng.choice(skus)
            coupon = {"type": "sale", "sku": sku, "price": rng.randint(1, 200)}
            model = [[s, coupon["price"] if s == sku else price] for s, price in model]
        cart.apply_coupon(coupon)
    total = sum(price for _, price in model)
    for value in percents:
        total -= (total * value + 50) // 100
    for value in fixeds:
        total -= value
    assert cart.total() == total, (cart.total(), total)
    assert CATALOG == pristine, "the catalogue was modified"
print("HIDDEN-OK")
`;

const SPEC: BugfixSpec = {
  tests: { "tests/__init__.py": "", "tests/test_cart.py": TEST_SOURCE },
  modules: ["tests.test_cart"],
  expectedTests: 8,
  hiddenChecks: HIDDEN,
};

export const bugfixSharedStateCart: DynoTask = {
  id: "bugfix-shared-state-cart",
  title: "Fix a shopping cart that leaks state between carts",
  category: "bugfix",
  difficulty: 3,
  instruction:
    "Customers are reporting odd things with the shop: a brand-new cart sometimes starts out with items in it, and after " +
    "someone uses a sale coupon other people's prices change too. The tests in `tests/test_cart.py` " +
    "(`python3 -m unittest tests.test_cart`) reproduce several symptoms and some of them fail depending on which other " +
    "tests ran first. Find the root causes in `shop/` and fix them; don't modify the tests or the catalogue data.",
  maxIterations: 30,
  timeoutSec: 180,

  setup(dir) {
    writeFiles(dir, {
      "shop/__init__.py": "",
      "shop/catalog.py": CATALOG_SOURCE,
      [CART]: CART_SOURCE,
      ...SPEC.tests,
    });
  },

  grade: (dir) => gradeBugfix(dir, SPEC),

  oracle(dir) {
    const file = path.join(dir, CART);
    const text = fs
      .readFileSync(file, "utf8")
      .replace(
        "    def __init__(self, items=[]):\n",
        "    def __init__(self, items=None):\n",
      )
      .replace("        self.items = items\n", "        self.items = [dict(item) for item in (items or [])]\n")
      .replace("        product = CATALOG[sku]\n        for _ in range(qty):\n            self.items.append(product)", "        product = CATALOG[sku]\n        for _ in range(qty):\n            self.items.append(dict(product))")
      .replace(
        `        total = sum(item["price"] for item in self.items)
        for coupon in self.coupons:
            if coupon["type"] == "percent":
                total -= (total * coupon["value"] + 50) // 100
            elif coupon["type"] == "fixed":
                total -= coupon["value"]
        return total`,
        `        total = sum(item["price"] for item in self.items)
        for coupon in self.coupons:
            if coupon["type"] == "percent":
                total -= (total * coupon["value"] + 50) // 100
        for coupon in self.coupons:
            if coupon["type"] == "fixed":
                total -= coupon["value"]
        return total`,
      );
    fs.writeFileSync(file, text);
  },
};
