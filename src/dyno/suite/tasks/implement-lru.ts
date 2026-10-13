/**
 * implement-lru-cache — a small stateful class where ordering rules are the
 * whole point: what counts as a "use", when the eviction callback fires, and what
 * `peek`/`in`/`delete`/`clear`/`resize` must not do. The README states each rule;
 * the grader runs many independent scenarios and reports which ones fail.
 */

import fs from "node:fs";
import path from "node:path";
import type { DynoTask } from "../../types.js";
import { clip, fail, pass, pythonCode, withScratchCopy, writeFiles } from "../helpers.js";

const README = `# lru_cache.py

A fixed-capacity least-recently-used cache.

    cache = LRUCache(capacity, on_evict=None)

| Member | Behaviour |
| --- | --- |
| \`get(key, default=None)\` | Returns the value and marks \`key\` as most recently used. On a miss returns \`default\` and changes nothing. A stored \`None\`, \`0\` or \`""\` is a hit and is returned as is. |
| \`put(key, value)\` | Inserts or replaces and marks \`key\` as most recently used. If the cache is now over capacity the least recently used entry is evicted. Replacing an existing key never evicts anything. |
| \`peek(key, default=None)\` | Like \`get\` but does **not** change the recency order. |
| \`key in cache\` | Membership test that does **not** change the recency order. |
| \`delete(key)\` | Removes the entry and returns \`True\`; returns \`False\` if the key is absent. |
| \`resize(new_capacity)\` | Changes the capacity. When shrinking, evicts least recently used entries until the cache fits. |
| \`clear()\` | Removes every entry. |
| \`keys()\` | A list of the keys ordered from least to most recently used. |
| \`len(cache)\` | Number of entries. |
| \`cache.capacity\` | The current capacity (read-only). |

## Rules

* \`capacity\` (in the constructor and in \`resize\`) must be an \`int\` of at least 1.
  A value below 1 raises \`ValueError\`; a value that is not an \`int\` (floats, strings,
  \`None\` and also \`bool\`) raises \`TypeError\`. A failed \`resize\` changes nothing.
* \`on_evict(key, value)\`, if given, is called exactly once for every entry removed
  to make room: by \`put\` and by a shrinking \`resize\`, oldest first. It is called after
  the entry has been removed from the cache. It is **not** called for \`delete\`,
  \`clear\`, or for a value that is replaced by \`put\`.
* The standard library is all you need; \`collections.OrderedDict\` is fine.
`;

const STUB = `"""Fixed-capacity LRU cache. The specification is in README.md."""


class LRUCache:
    def __init__(self, capacity, on_evict=None):
        raise NotImplementedError("see README.md")
`;

const REFERENCE = String.raw`"""Fixed-capacity LRU cache. The specification is in README.md."""

from collections import OrderedDict


def _check_capacity(value):
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError("capacity must be an int")
    if value < 1:
        raise ValueError("capacity must be at least 1")
    return value


class LRUCache:
    def __init__(self, capacity, on_evict=None):
        self._capacity = _check_capacity(capacity)
        self._on_evict = on_evict
        self._data = OrderedDict()

    @property
    def capacity(self):
        return self._capacity

    def get(self, key, default=None):
        if key not in self._data:
            return default
        self._data.move_to_end(key)
        return self._data[key]

    def peek(self, key, default=None):
        return self._data.get(key, default)

    def put(self, key, value):
        if key in self._data:
            self._data[key] = value
            self._data.move_to_end(key)
            return
        self._data[key] = value
        self._evict_to(self._capacity)

    def delete(self, key):
        if key in self._data:
            del self._data[key]
            return True
        return False

    def resize(self, new_capacity):
        self._capacity = _check_capacity(new_capacity)
        self._evict_to(self._capacity)

    def clear(self):
        self._data.clear()

    def keys(self):
        return list(self._data)

    def __len__(self):
        return len(self._data)

    def __contains__(self, key):
        return key in self._data

    def _evict_to(self, size):
        while len(self._data) > size:
            key, value = self._data.popitem(last=False)
            if self._on_evict is not None:
                self._on_evict(key, value)
`;

const PROBE = String.raw`
import json
from lru_cache import LRUCache

results = {}


def case(fn):
    try:
        fn()
        results[fn.__name__] = "ok"
    except BaseException as exc:
        results[fn.__name__] = f"{type(exc).__name__}: {exc}"
    return fn


def raises(kind, fn, *args):
    try:
        fn(*args)
    except kind:
        return True
    except BaseException as exc:
        raise AssertionError(f"expected {kind.__name__}, got {type(exc).__name__}")
    raise AssertionError(f"expected {kind.__name__}, nothing raised")


@case
def basic_put_get_and_len():
    c = LRUCache(2)
    c.put("a", 1)
    c.put("b", 2)
    assert c.get("a") == 1 and c.get("b") == 2 and len(c) == 2
    assert c.get("zzz") is None and c.get("zzz", "dflt") == "dflt"


@case
def evicts_least_recently_used():
    c = LRUCache(2)
    c.put("a", 1); c.put("b", 2); c.put("c", 3)
    assert "a" not in c and c.keys() == ["b", "c"]


@case
def get_refreshes_recency():
    c = LRUCache(2)
    c.put("a", 1); c.put("b", 2)
    c.get("a")
    c.put("c", 3)
    assert c.keys() == ["a", "c"], c.keys()


@case
def missing_get_changes_nothing():
    c = LRUCache(2)
    c.put("a", 1); c.put("b", 2)
    c.get("nope")
    assert c.keys() == ["a", "b"]


@case
def falsy_values_are_hits():
    c = LRUCache(3)
    c.put("n", None); c.put("z", 0); c.put("e", "")
    assert c.get("n", "dflt") is None
    assert c.get("z", "dflt") == 0
    assert c.get("e", "dflt") == ""
    assert c.peek("n", "dflt") is None


@case
def replacing_never_evicts_and_refreshes():
    seen = []
    c = LRUCache(2, on_evict=lambda k, v: seen.append((k, v)))
    c.put("a", 1); c.put("b", 2)
    c.put("a", 10)
    assert len(c) == 2 and seen == [] and c.keys() == ["b", "a"] and c.get("a") == 10
    c.put("c", 3)
    assert seen == [("b", 2)], seen


@case
def peek_does_not_refresh():
    c = LRUCache(2)
    c.put("a", 1); c.put("b", 2)
    assert c.peek("a") == 1 and c.peek("zzz", 7) == 7
    c.put("c", 3)
    assert c.keys() == ["b", "c"], c.keys()


@case
def membership_does_not_refresh():
    c = LRUCache(2)
    c.put("a", 1); c.put("b", 2)
    assert "a" in c and "x" not in c
    c.put("c", 3)
    assert c.keys() == ["b", "c"], c.keys()


@case
def delete_reports_and_skips_callback():
    seen = []
    c = LRUCache(3, on_evict=lambda k, v: seen.append(k))
    c.put("a", 1); c.put("b", 2)
    assert c.delete("a") is True and c.delete("a") is False and c.delete("never") is False
    assert c.keys() == ["b"] and seen == []


@case
def on_evict_receives_key_and_value_after_removal():
    events = []
    holder = {}
    c = LRUCache(1, on_evict=lambda k, v: events.append((k, v, k in holder["c"], len(holder["c"]))))
    holder["c"] = c
    c.put("a", "A")
    c.put("b", "B")
    assert events == [("a", "A", False, 1)], events


@case
def resize_shrink_evicts_oldest_first():
    seen = []
    c = LRUCache(4, on_evict=lambda k, v: seen.append(k))
    for i, k in enumerate("abcd"):
        c.put(k, i)
    c.get("a")
    c.resize(2)
    assert seen == ["b", "c"], seen
    assert c.keys() == ["d", "a"] and c.capacity == 2 and len(c) == 2


@case
def resize_grow_keeps_everything():
    c = LRUCache(1)
    c.put("a", 1)
    c.resize(3)
    c.put("b", 2); c.put("c", 3)
    assert c.keys() == ["a", "b", "c"] and c.capacity == 3


@case
def clear_empties_without_callbacks():
    seen = []
    c = LRUCache(3, on_evict=lambda k, v: seen.append(k))
    c.put("a", 1); c.put("b", 2)
    c.clear()
    assert len(c) == 0 and c.keys() == [] and seen == []
    c.put("x", 1)
    assert c.keys() == ["x"]


@case
def constructor_validates_capacity():
    raises(ValueError, LRUCache, 0)
    raises(ValueError, LRUCache, -3)
    raises(TypeError, LRUCache, 2.0)
    raises(TypeError, LRUCache, "2")
    raises(TypeError, LRUCache, None)
    raises(TypeError, LRUCache, True)


@case
def resize_validates_and_changes_nothing_on_failure():
    c = LRUCache(2)
    c.put("a", 1); c.put("b", 2)
    raises(ValueError, c.resize, 0)
    raises(TypeError, c.resize, 1.5)
    raises(TypeError, c.resize, False)
    assert c.capacity == 2 and c.keys() == ["a", "b"]


@case
def capacity_is_read_only():
    c = LRUCache(2)
    try:
        c.capacity = 5
    except AttributeError:
        pass
    assert c.capacity == 2


@case
def recency_order_after_mixed_operations():
    c = LRUCache(3)
    for k in "abc":
        c.put(k, k)
    c.get("a"); c.put("b", "B"); c.peek("c"); "c" in c
    assert c.keys() == ["c", "a", "b"], c.keys()
    c.put("d", "D")
    assert c.keys() == ["a", "b", "d"], c.keys()


@case
def heavy_use_stays_bounded_and_fast():
    c = LRUCache(100)
    for i in range(20000):
        c.put(i, i)
        c.get(i - 50)
    assert len(c) == 100 and 19999 in c


print(json.dumps(results))
`;

export const implementLruCache: DynoTask = {
  id: "implement-lru-cache",
  title: "Implement an LRU cache class from a spec",
  category: "implement",
  difficulty: 2,
  instruction:
    "Please implement the `LRUCache` class in `lru_cache.py` as described in `README.md` (there's only a stub there at the " +
    "moment). The README lists which operations count as a use, when the eviction callback fires and what the argument " +
    "validation should do; follow it to the letter, because I'll check each rule individually with my own tests.",
  maxIterations: 25,
  timeoutSec: 150,

  setup(dir) {
    writeFiles(dir, { "README.md": README, "lru_cache.py": STUB });
  },

  async grade(dir) {
    return withScratchCopy(dir, async (scratch) => {
      const result = await pythonCode(PROBE, { cwd: scratch, timeoutMs: 30_000 });
      if (result.timedOut) return fail("scenarios timed out (is an operation O(n^2)?)");
      if (result.code !== 0) return fail(`could not run the scenarios: ${clip(result.stderr, 300)}`);
      const results = JSON.parse(result.stdout) as Record<string, string>;
      const failed = Object.entries(results).filter(([, outcome]) => outcome !== "ok");
      if (failed.length > 0) {
        const shown = failed.slice(0, 3).map(([name, outcome]) => `${name} (${clip(outcome, 90)})`);
        return fail(`${failed.length}/${Object.keys(results).length} scenarios fail: ${shown.join("; ")}`);
      }
      return pass(`all ${Object.keys(results).length} scenarios pass`);
    });
  },

  oracle(dir) {
    fs.writeFileSync(path.join(dir, "lru_cache.py"), REFERENCE);
  },
};
