// A WOFF2 reader for the font tests: enough for cmap, hmtx, OS/2 and fvar.
// WOFF2 is brotli, which node:zlib speaks; glyf/loca come back still
// transformed (unread), every other table as it is in the font.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";

const KNOWN_TAGS = ("cmap head hhea hmtx maxp name OS/2 post cvt  fpgm glyf loca prep CFF  VORG EBDT " +
  "EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR " +
  "CPAL SVG  sbix acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx " +
  "opbd prop trak Zapf Silf Glat Gloc Feat Sill").match(/.{4}\s?/g).map((t) => t.slice(0, 4));

/** The tables of the WOFF2 file at `url` (a URL or a path), by tag. */
export function readWoff2(url) {
  const buf = readFileSync(url);
  const name = String(url).split("/").pop();
  assert.equal(buf.toString("latin1", 0, 4), "wOF2", `${name} is WOFF2`);
  const numTables = buf.readUInt16BE(12);
  let p = 48;
  const base128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const b = buf[p++];
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return v;
    }
    throw new Error("bad UIntBase128");
  };
  const dir = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[p++];
    let tag = KNOWN_TAGS[flags & 0x3f];
    if ((flags & 0x3f) === 63) { tag = buf.toString("latin1", p, p + 4); p += 4; }
    const version = flags >> 6;
    const orig = base128();
    const transformed = (tag === "glyf" || tag === "loca") ? version !== 3 : version !== 0;
    dir.push({ tag, length: transformed ? base128() : orig });
  }
  const data = brotliDecompressSync(buf.subarray(p, p + buf.readUInt32BE(20)));
  const tables = {};
  let off = 0;
  for (const t of dir) {
    tables[t.tag] = data.subarray(off, off + t.length);
    off += t.length;
  }
  return tables;
}

/** Code point → glyph id, from the Windows Unicode cmap. */
export function cmapOf(t) {
  const c = t.cmap;
  const n = c.readUInt16BE(2);
  const subs = [];
  for (let i = 0; i < n; i++) {
    subs.push({ pid: c.readUInt16BE(4 + i * 8), eid: c.readUInt16BE(6 + i * 8), off: c.readUInt32BE(8 + i * 8) });
  }
  const map = new Map();
  const pick = subs.find((s) => s.pid === 3 && s.eid === 10) ?? subs.find((s) => s.pid === 3 && s.eid === 1);
  const o = pick.off;
  const format = c.readUInt16BE(o);
  if (format === 12) {
    const groups = c.readUInt32BE(o + 12);
    for (let g = 0; g < groups; g++) {
      const q = o + 16 + g * 12;
      const start = c.readUInt32BE(q), end = c.readUInt32BE(q + 4), gid = c.readUInt32BE(q + 8);
      for (let cp = start; cp <= end; cp++) map.set(cp, gid + cp - start);
    }
  } else {
    assert.equal(format, 4);
    const segX2 = c.readUInt16BE(o + 6);
    const ends = o + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
    for (let s = 0; s < segX2 / 2; s++) {
      const end = c.readUInt16BE(ends + s * 2), start = c.readUInt16BE(starts + s * 2);
      const delta = c.readInt16BE(deltas + s * 2), ro = c.readUInt16BE(ranges + s * 2);
      for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
        let gid;
        if (ro === 0) gid = (cp + delta) & 0xffff;
        else {
          gid = c.readUInt16BE(ranges + s * 2 + ro + (cp - start) * 2);
          if (gid) gid = (gid + delta) & 0xffff;
        }
        if (gid) map.set(cp, gid);
      }
    }
  }
  return map;
}

/** Every glyph's advance width, by glyph id. */
export function advancesOf(t) {
  const nh = t.hhea.readUInt16BE(34);
  const numGlyphs = t.maxp.readUInt16BE(4);
  const adv = [];
  for (let g = 0; g < numGlyphs; g++) adv.push(t.hmtx.readUInt16BE(Math.min(g, nh - 1) * 4));
  return adv;
}
