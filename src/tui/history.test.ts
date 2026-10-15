import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HistoryStore } from "./history.js";

const tempFile = (): string => path.join(mkdtempSync(path.join(os.tmpdir(), "revcode-hist-")), "h.jsonl");

describe("HistoryStore", () => {
  it("persists entries across instances, oldest first", () => {
    const file = tempFile();
    const a = new HistoryStore(file);
    a.add("first");
    a.add("second\nline two");
    expect(new HistoryStore(file).entries()).toEqual(["first", "second\nline two"]);
  });

  it("skips blanks and consecutive duplicates", () => {
    const store = new HistoryStore(tempFile());
    store.add("  ");
    store.add("a");
    store.add("a");
    store.add("b");
    store.add("a");
    expect(store.entries()).toEqual(["a", "b", "a"]);
  });

  it("caps the history and compacts the file", () => {
    const file = tempFile();
    const store = new HistoryStore(file, 5);
    for (let i = 0; i < 20; i += 1) store.add(`entry ${i}`);
    expect(store.entries()).toEqual(["entry 15", "entry 16", "entry 17", "entry 18", "entry 19"]);
    expect(readFileSync(file, "utf8").split("\n").filter(Boolean).length).toBeLessThanOrEqual(11);
    expect(new HistoryStore(file, 5).entries()).toEqual(store.entries());
  });

  it("ignores damaged lines and a missing file", () => {
    const file = tempFile();
    writeFileSync(file, '"ok"\nnot json\n"also ok"\n');
    expect(new HistoryStore(file).entries()).toEqual(["ok", "also ok"]);
    expect(new HistoryStore(path.join(os.tmpdir(), "nope-does-not-exist.jsonl")).entries()).toEqual([]);
  });

  it("works without a file", () => {
    const store = new HistoryStore(undefined);
    store.add("x");
    expect(store.entries()).toEqual(["x"]);
  });
});
