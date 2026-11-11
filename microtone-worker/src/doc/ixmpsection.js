// The Ixmp section's payload (file format §9.10), built from the document's
// decoded entries — its own module so that document.js and bankmerge.js can
// both use it without importing each other.

/** Ixmp section payload from decoded entries (inverse of parseIxmpSection). */
export function buildIxmpSection(entries) {
  const total = entries.reduce((n, e) => n + 4 + e.blob.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const e of entries) {
    out[o] = e.instId & 0xff;
    out[o + 1] = e.count & 0xff;
    out[o + 2] = (e.count >>> 8) & 0xff;
    out[o + 3] = (e.instId >>> 8) & 0x03;
    out.set(e.blob, o + 4);
    o += 4 + e.blob.length;
  }
  return out;
}
