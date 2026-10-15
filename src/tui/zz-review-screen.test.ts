import { describe, expect, it } from "vitest";
import { MiniTerminal } from "../testing/mini-terminal.js";
import { LiveScreen } from "./screen.js";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("screen fuzz", () => {
  it("transcript equals printed + block", () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const r = rng(seed);
      const cols = 20 + Math.floor(r() * 30);
      const rows = 6 + Math.floor(r() * 10);
      const term = new MiniTerminal(cols, rows);
      const out = { write: (d: string) => term.write(d), get columns() { return term.cols; }, get rows() { return term.rows; } };
      const screen = new LiveScreen(out);
      const printed: string[] = [];
      let block: string[] = [];
      let mounted = false;
      for (let step = 0; step < 40; step += 1) {
        const op = r();
        if (op < 0.35) {
          const n = 1 + Math.floor(r() * 3);
          const lines = Array.from({ length: n }, (_, i) => `p${seed}.${step}.${i}`);
          screen.print(lines.join("\n"));
          printed.push(...lines);
        } else if (op < 0.9) {
          const n = Math.floor(r() * (rows - 1)) + 1;
          block = Array.from({ length: n }, (_, i) => `b${step}.${i}`);
          screen.draw({ lines: block, cursor: r() < 0.8 ? { row: Math.floor(r() * n), col: Math.floor(r() * 10) } : undefined });
          mounted = true;
        } else if (mounted) {
          screen.release();
          mounted = false;
          block = [];
        }
        const t = term.transcript();
        const expected = [...printed, ...block];
        if (JSON.stringify(t) !== JSON.stringify(expected)) {
          throw new Error(`seed ${seed} step ${step}\nexpected ${JSON.stringify(expected)}\ngot      ${JSON.stringify(t)}`);
        }
      }
    }
  });
});
