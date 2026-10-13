/**
 * bugfix-interval-scheduler — logic bugs with no stack trace at all.
 *
 * Every failure is an assertion diff, so the agent has to compare the docstring's
 * rules against the code: unsorted input, touching intervals, containment, the
 * missing trailing gap and an off-by-one in the fit check. The private checks
 * compare 400 randomised inputs against a reference implementation.
 */

import fs from "node:fs";
import path from "node:path";
import type { DynoTask } from "../../types.js";
import { writeFiles } from "../helpers.js";
import { gradeBugfix, type BugfixSpec } from "./bugfix-common.js";

const MODULE = "scheduler/intervals.py";

const SOURCE = String.raw`"""Interval helpers for the room-booking calendar. Times are minutes since midnight."""


def overlaps(a, b):
    """True if the half-open intervals a and b share any time.

    Intervals are [start, end): (60, 90) and (90, 120) touch but do not overlap.
    """
    return a[0] <= b[1] and b[0] <= a[1]


def merge_intervals(intervals):
    """Merge overlapping or touching intervals into a sorted list of tuples.

    The input may be unsorted and is not modified. (60, 90) and (90, 120) merge
    into (60, 120), and an interval lying inside another one disappears.
    """
    merged = []
    for start, end in intervals:
        if merged and start < merged[-1][1]:
            merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))
    return merged


def free_slots(busy, day_start, day_end):
    """Free gaps inside [day_start, day_end] given the busy intervals.

    Busy intervals may be unsorted, overlap each other, or stick out of the day;
    they are clipped to it. Gaps are returned in order and zero-length gaps are
    not reported.
    """
    slots = []
    cursor = day_start
    for start, end in merge_intervals(busy):
        if start > cursor:
            slots.append((cursor, min(start, day_end)))
        cursor = end
    return slots


def first_fit(slots, minutes):
    """Start of the earliest slot that can hold a meeting of minutes.

    A slot exactly minutes long fits. Returns None when nothing fits.
    """
    for start, end in sorted(slots):
        if end - start > minutes:
            return start
    return None
`;

const TEST_SOURCE = String.raw`import unittest

from scheduler.intervals import first_fit, free_slots, merge_intervals, overlaps


class OverlapTests(unittest.TestCase):
    def test_overlapping(self):
        self.assertTrue(overlaps((60, 100), (90, 120)))

    def test_touching_intervals_do_not_overlap(self):
        self.assertFalse(overlaps((60, 90), (90, 120)))
        self.assertFalse(overlaps((90, 120), (60, 90)))


class MergeTests(unittest.TestCase):
    def test_merges_unsorted_input(self):
        self.assertEqual(merge_intervals([(300, 360), (60, 120), (100, 150)]), [(60, 150), (300, 360)])

    def test_merges_touching_intervals(self):
        self.assertEqual(merge_intervals([(60, 90), (90, 120)]), [(60, 120)])

    def test_contained_interval_does_not_shrink_the_outer_one(self):
        self.assertEqual(merge_intervals([(60, 200), (90, 100)]), [(60, 200)])

    def test_empty_and_input_untouched(self):
        original = [(5, 6), (1, 2)]
        self.assertEqual(merge_intervals([]), [])
        merge_intervals(original)
        self.assertEqual(original, [(5, 6), (1, 2)])


class FreeSlotTests(unittest.TestCase):
    def test_empty_day(self):
        self.assertEqual(free_slots([], 480, 1020), [(480, 1020)])

    def test_gap_between_meetings_and_after_the_last(self):
        self.assertEqual(free_slots([(540, 600), (720, 780)], 480, 1020), [(480, 540), (600, 720), (780, 1020)])

    def test_unsorted_overlapping_busy_blocks(self):
        self.assertEqual(free_slots([(700, 800), (480, 600), (560, 720)], 480, 1020), [(800, 1020)])

    def test_busy_blocks_sticking_out_of_the_day(self):
        self.assertEqual(free_slots([(0, 500), (1000, 1300)], 480, 1020), [(500, 1000)])

    def test_fully_booked_day(self):
        self.assertEqual(free_slots([(400, 1100)], 480, 1020), [])


class FirstFitTests(unittest.TestCase):
    def test_exact_fit_counts(self):
        self.assertEqual(first_fit([(600, 660)], 60), 600)

    def test_returns_none_when_nothing_fits(self):
        self.assertIsNone(first_fit([(600, 630), (700, 720)], 45))

    def test_earliest_slot_wins_even_if_input_is_unsorted(self):
        self.assertEqual(first_fit([(900, 1000), (500, 560)], 30), 500)


if __name__ == "__main__":
    unittest.main()
`;

const HIDDEN = String.raw`
import random

from scheduler.intervals import first_fit, free_slots, merge_intervals, overlaps


def ref_merge(intervals):
    out = []
    for start, end in sorted((tuple(i) for i in intervals)):
        if out and start <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], end))
        else:
            out.append((start, end))
    return out


def ref_free(busy, lo, hi):
    out, cursor = [], lo
    for start, end in ref_merge(busy):
        if end <= lo or start >= hi:
            continue
        if start > cursor:
            out.append((cursor, start))
        cursor = max(cursor, end)
    if cursor < hi:
        out.append((cursor, hi))
    return out


def ref_fit(slots, minutes):
    for start, end in sorted(slots):
        if end - start >= minutes:
            return start
    return None


rng = random.Random(7)
for _ in range(400):
    n = rng.randint(0, 7)
    busy = []
    for _ in range(n):
        a = rng.randint(0, 120)
        busy.append((a, a + rng.randint(1, 40)))
    lo = rng.randint(10, 50)
    hi = lo + rng.randint(20, 80)
    snapshot = list(busy)
    assert merge_intervals(busy) == ref_merge(busy), ("merge", busy)
    assert busy == snapshot, "merge_intervals mutated its input"
    assert free_slots(busy, lo, hi) == ref_free(busy, lo, hi), ("free", busy, lo, hi)
    slots = ref_free(busy, lo, hi)
    minutes = rng.randint(1, 30)
    assert first_fit(slots, minutes) == ref_fit(slots, minutes), ("fit", slots, minutes)
    a, b = busy[0] if busy else (0, 1), (rng.randint(0, 100), rng.randint(101, 140))
    assert overlaps(a, b) == (a[0] < b[1] and b[0] < a[1]), ("overlaps", a, b)
print("HIDDEN-OK")
`;

const SPEC: BugfixSpec = {
  tests: { "tests/__init__.py": "", "tests/test_intervals.py": TEST_SOURCE },
  modules: ["tests.test_intervals"],
  expectedTests: 14,
  hiddenChecks: HIDDEN,
};

export const bugfixIntervalScheduler: DynoTask = {
  id: "bugfix-interval-scheduler",
  title: "Fix interval merging and free-slot bugs",
  category: "bugfix",
  difficulty: 2,
  instruction:
    "Our room-booking calendar helpers in `scheduler/intervals.py` give wrong answers and the tests in " +
    "`tests/test_intervals.py` (run with `python3 -m unittest tests.test_intervals`) show it. Track down the bugs and fix " +
    "the code. The docstrings spell out the rules each function is supposed to follow. Please leave the test file alone, " +
    "since it's the spec we agreed on with the product team.",
  maxIterations: 25,
  timeoutSec: 150,

  setup(dir) {
    writeFiles(dir, { "scheduler/__init__.py": "", [MODULE]: SOURCE, ...SPEC.tests });
  },

  grade: (dir) => gradeBugfix(dir, SPEC),

  oracle(dir) {
    const file = path.join(dir, MODULE);
    const text = fs
      .readFileSync(file, "utf8")
      .replace("return a[0] <= b[1] and b[0] <= a[1]", "return a[0] < b[1] and b[0] < a[1]")
      .replace(
        `    for start, end in intervals:
        if merged and start < merged[-1][1]:
            merged[-1] = (merged[-1][0], end)`,
        `    for start, end in sorted(tuple(i) for i in intervals):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))`,
      )
      .replace(
        `    for start, end in merge_intervals(busy):
        if start > cursor:
            slots.append((cursor, min(start, day_end)))
        cursor = end
    return slots`,
        `    for start, end in merge_intervals(busy):
        if end <= day_start or start >= day_end:
            continue
        if start > cursor:
            slots.append((cursor, start))
        cursor = max(cursor, end)
    if cursor < day_end:
        slots.append((cursor, day_end))
    return slots`,
      )
      .replace("if end - start > minutes:", "if end - start >= minutes:");
    fs.writeFileSync(file, text);
  },
};
