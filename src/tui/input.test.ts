import { describe, expect, it } from "vitest";
import { deleteCharAt, deleteCharBefore, insertChar } from "./input.js";

describe("input buffer helpers", () => {
  it("inserts a character at the cursor", () => {
    expect(insertChar("hello", 2, "X")).toBe("heXllo");
  });

  it("deletes the character before the cursor", () => {
    expect(deleteCharBefore("hello", 3)).toEqual({ buffer: "helo", index: 2 });
  });

  it("does not delete before the start of the buffer", () => {
    expect(deleteCharBefore("hello", 0)).toEqual({ buffer: "hello", index: 0 });
  });

  it("deletes the character at the cursor", () => {
    expect(deleteCharAt("hello", 2)).toEqual({ buffer: "helo", index: 2 });
  });
});
