// Compressed-section codec. TSVM's CompressorDelegate sniffs the 4-byte magic
// on decompress (gzip 1F 8B 08 vs zstd 28 B5 2F FD, CompressorDelegate.kt:99-122)
// and — despite the "gzip" JS namespace — WRITES zstd (CompressorDelegate.kt:106).
// We decompress both and always emit real gzip, which the desktop auto-detects.

import { gzipSync, gunzipSync } from "../vendor/fflate.esm.js";
import { decompress as zstdDecompress } from "../vendor/fzstd.esm.js";

/** Decompress a gzip- or zstd-compressed section (auto-detected by magic). */
export function decomp(bytes, expectedSize) {
  if (bytes.length >= 3 && bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08) {
    return gunzipSync(bytes);
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd
  ) {
    return expectedSize
      ? zstdDecompress(bytes, new Uint8Array(expectedSize))
      : zstdDecompress(bytes);
  }
  throw new Error(
    `taud: unknown compression magic ${bytes[0]?.toString(16)} ${bytes[1]?.toString(16)}`
  );
}

/** Compress a section for writing (always gzip; TSVM sniffs the magic on load).
 *  mtime 0 like the *2taud converters — without it fflate stamps the current
 *  time into the gzip header and toBytes() stops being deterministic. */
export function comp(bytes) {
  return gzipSync(bytes, { mtime: 0 });
}
