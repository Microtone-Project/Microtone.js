// The save worker: Zstandard-compresses a save's sections off the main thread.
// Started on the first save by zstd.js zstdCompressAll, which also stops it
// once saves stop coming.
//
// in:  { id, parts: Uint8Array[], level, progress: boolean }
// out: { id, done, total } after each step, when progress was asked for, then
//      { id, out: Uint8Array[] } (buffers transferred) | { id, error }

import { loadZstd, compressParts } from "./zstd.js";

self.onmessage = async (e) => {
  const { id, parts, level, progress } = e.data;
  try {
    const zstd = await loadZstd();
    const out = compressParts(zstd, parts, level,
      progress ? (done, total) => self.postMessage({ id, done, total }) : null);
    self.postMessage({ id, out }, out.map((o) => o.buffer));
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};
