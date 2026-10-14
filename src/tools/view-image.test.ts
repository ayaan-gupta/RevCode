import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_BYTES } from "../llm/vision.js";
import { viewImage } from "./view-image.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("view_image", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "revcode-img-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("sends the file's real media type and base64 bytes with the question", async () => {
    writeFileSync(path.join(dir, "board.dat"), PNG); // extension lies; the bytes decide
    const describe = vi.fn().mockResolvedValue("a chess board");
    const out = await viewImage({ path: "board.dat", question: "FEN?" }, { cwd: dir, describe });
    expect(out).toEqual({ path: "board.dat", mediaType: "image/png", answer: "a chess board" });
    expect(describe).toHaveBeenCalledWith(
      { mediaType: "image/png", base64: PNG.toString("base64"), question: "FEN?" },
      undefined,
    );
  });

  it("asks for a detailed description when no question is given", async () => {
    writeFileSync(path.join(dir, "a.png"), PNG);
    const describe = vi.fn().mockResolvedValue("ok");
    await viewImage({ path: "a.png" }, { cwd: dir, describe });
    expect(describe.mock.calls[0][0].question).toMatch(/Describe this image/);
  });

  it("refuses files that are not images, without calling the model", async () => {
    writeFileSync(path.join(dir, "notes.png"), "just text");
    const describe = vi.fn();
    await expect(viewImage({ path: "notes.png" }, { cwd: dir, describe })).rejects.toThrow(/not a PNG, JPEG, GIF or WebP/);
    expect(describe).not.toHaveBeenCalled();
  });

  it("refuses oversized images and says how to shrink them", async () => {
    writeFileSync(path.join(dir, "big.png"), Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]));
    await expect(viewImage({ path: "big.png" }, { cwd: dir, describe: vi.fn() })).rejects.toThrow(/Downscale or crop/);
  });

  it("stays inside the working directory unless unrestricted", async () => {
    writeFileSync(path.join(dir, "a.png"), PNG);
    const describe = vi.fn().mockResolvedValue("ok");
    const outside = path.join(dir, "..", path.basename(dir), "a.png");
    await expect(viewImage({ path: path.join(os.tmpdir(), "x", "..", "..", "etc", "hosts") }, { cwd: dir, describe })).rejects.toThrow(/escapes the working directory/);
    await expect(viewImage({ path: outside }, { cwd: dir, unrestricted: true, describe })).resolves.toMatchObject({ answer: "ok" });
  });
});
