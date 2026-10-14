/**
 * Tool: look at an image file through a vision model.
 *
 * The main model may be text-only. This tool reads the file, checks it really is
 * an image, and asks the provider's vision model a question about it, so the
 * agent can use screenshots, diagrams, charts and photographed boards.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { MAX_IMAGE_BYTES, sniffImageType, type ImageQuestion } from "../llm/vision.js";
import type { ToolDefinition } from "./index.js";
import { formatRelativePath, resolvePathInsideCwd } from "./path.js";

export interface ViewImageInput {
  path: string;
  question?: string;
}

export interface ViewImageOutput {
  path: string;
  mediaType: string;
  answer: string;
}

export interface ViewImageOptions {
  cwd?: string;
  unrestricted?: boolean;
  /** Ask the vision model; rejects when the current provider has none. */
  describe: (image: ImageQuestion, signal?: AbortSignal) => Promise<string>;
}

const DEFAULT_QUESTION =
  "Describe this image in detail. Transcribe any text exactly, and for anything laid out on a grid or in a diagram list each item with its position.";

export const viewImageToolDefinition: ToolDefinition = {
  name: "view_image",
  description:
    "Look at an image file (PNG, JPEG, GIF or WebP) and answer a question about it. Your own model cannot see images; a separate vision model looks at the file and replies in text. " +
    "Ask specific questions (\"list every piece and the square it stands on\", \"transcribe all text\") rather than \"what is this\", crop or enlarge small details first (e.g. with Pillow), and double-check anything that matters with code, because a vision model can misread fine detail.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the image file." },
      question: { type: "string", description: "What to find out about the image. Defaults to a detailed description with transcribed text." },
    },
    required: ["path"],
  },
};

export async function viewImage(input: ViewImageInput, options: ViewImageOptions, signal?: AbortSignal): Promise<ViewImageOutput> {
  if (typeof input !== "object" || input === null || typeof input.path !== "string" || input.path.length === 0) {
    throw new Error("view_image requires a non-empty string path");
  }
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const filePath = resolvePathInsideCwd(input.path, cwd, options.unrestricted);
  const relativePath = formatRelativePath(filePath, cwd);

  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${relativePath}`);
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(
      `${relativePath} is ${(stat.size / 1024 / 1024).toFixed(1)} MB; the vision model accepts at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB. Downscale or crop it first (e.g. Pillow: Image.open(p).resize(...).save(out)).`,
    );
  }

  const bytes = await fs.readFile(filePath);
  const mediaType = sniffImageType(bytes);
  if (!mediaType) {
    throw new Error(`${relativePath} is not a PNG, JPEG, GIF or WebP image. Convert it first (e.g. with ImageMagick or Pillow).`);
  }

  const question = typeof input.question === "string" && input.question.trim() ? input.question.trim() : DEFAULT_QUESTION;
  const answer = await options.describe({ mediaType, base64: bytes.toString("base64"), question }, signal);
  return { path: relativePath, mediaType, answer };
}
