/**
 * Image understanding for text-only models.
 *
 * A coding model that cannot see (GLM, most open-weight models) still meets
 * screenshots, diagrams and photographed boards. Providers that know a vision
 * model implement `LlmClient.describeImage`; the `view_image` tool calls it and
 * hands the answer back as text.
 */

export interface ImageQuestion {
  mediaType: string;
  /** Raw base64, no `data:` prefix. */
  base64: string;
  question: string;
}

/** Providers cap request images at roughly this size. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Completion budget for an image answer (a description, not a conversation). */
export const IMAGE_ANSWER_TOKENS = 4_096;

export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/** The media type from the file's magic bytes (extensions lie), or undefined if it is not a supported image. */
export function sniffImageType(bytes: Uint8Array): string | undefined {
  const startsWith = (...signature: number[]): boolean => signature.every((byte, i) => bytes[i] === byte);
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (startsWith(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (startsWith(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  return undefined;
}
