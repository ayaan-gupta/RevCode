/**
 * xxHash32, implemented from the public XXH32 specification (no dependencies).
 *
 * Hashline tags must be bit-compatible with the reference hash so that line IDs
 * stay stable across tools and runs; the reference vectors are pinned in the
 * tests. Only the 32-bit variant is needed.
 */

const PRIME1 = 2654435761;
const PRIME2 = 2246822519;
const PRIME3 = 3266489917;
const PRIME4 = 668265263;
const PRIME5 = 374761393;

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function round(accumulator: number, input: number): number {
  return Math.imul(rotl((accumulator + Math.imul(input, PRIME2)) >>> 0, 13), PRIME1) >>> 0;
}

export function xxh32(input: string | Uint8Array, seed = 0): number {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  const length = bytes.length;
  const read32 = (offset: number): number =>
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;

  let offset = 0;
  let hash: number;
  if (length >= 16) {
    let v1 = (seed + PRIME1 + PRIME2) >>> 0;
    let v2 = (seed + PRIME2) >>> 0;
    let v3 = seed >>> 0;
    let v4 = (seed - PRIME1) >>> 0;
    for (; offset <= length - 16; offset += 16) {
      v1 = round(v1, read32(offset));
      v2 = round(v2, read32(offset + 4));
      v3 = round(v3, read32(offset + 8));
      v4 = round(v4, read32(offset + 12));
    }
    hash = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) >>> 0;
  } else {
    hash = (seed + PRIME5) >>> 0;
  }

  hash = (hash + length) >>> 0;
  for (; offset <= length - 4; offset += 4) {
    hash = Math.imul(rotl((hash + Math.imul(read32(offset), PRIME3)) >>> 0, 17), PRIME4) >>> 0;
  }
  for (; offset < length; offset += 1) {
    hash = Math.imul(rotl((hash + Math.imul(bytes[offset], PRIME5)) >>> 0, 11), PRIME1) >>> 0;
  }

  hash ^= hash >>> 15;
  hash = Math.imul(hash, PRIME2) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, PRIME3) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}
