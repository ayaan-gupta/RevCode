import { describe, expect, it } from "vitest";
import type { LlmToolCall } from "../llm/client.js";
import { segmentToolCalls } from "./agent.js";

const READ_ONLY = new Set(["read_file", "grep", "glob", "list_directory"]);
const isReadOnly = (name: string) => READ_ONLY.has(name);

function call(name: string, id = name): LlmToolCall {
  return { id, name, arguments: {} };
}

describe("segmentToolCalls", () => {
  it("batches contiguous read-only calls into one segment", () => {
    const segments = segmentToolCalls(
      [call("read_file", "1"), call("grep", "2"), call("glob", "3")],
      isReadOnly,
    );
    expect(segments).toHaveLength(1);
    expect(segments[0].map((c) => c.id)).toEqual(["1", "2", "3"]);
  });

  it("isolates each mutating call into its own segment", () => {
    const segments = segmentToolCalls(
      [call("write_file", "1"), call("edit_file", "2")],
      isReadOnly,
    );
    expect(segments).toHaveLength(2);
    expect(segments.every((s) => s.length === 1)).toBe(true);
  });

  it("never lets a read overlap a mutating call (read, write, read)", () => {
    const segments = segmentToolCalls(
      [call("read_file", "r1"), call("write_file", "w"), call("read_file", "r2")],
      isReadOnly,
    );
    // read batch | write alone | read batch
    expect(segments.map((s) => s.map((c) => c.id))).toEqual([["r1"], ["w"], ["r2"]]);
  });

  it("preserves original order across mixed segments", () => {
    const segments = segmentToolCalls(
      [
        call("read_file", "1"),
        call("grep", "2"),
        call("shell", "3"),
        call("read_file", "4"),
        call("delete_file", "5"),
      ],
      isReadOnly,
    );
    expect(segments.map((s) => s.map((c) => c.id))).toEqual([
      ["1", "2"],
      ["3"],
      ["4"],
      ["5"],
    ]);
  });

  it("treats shell as mutating (stateful session)", () => {
    const segments = segmentToolCalls([call("shell", "1"), call("shell", "2")], isReadOnly);
    expect(segments).toHaveLength(2);
  });
});
