// `sMst` — the Project-Data section that carries a song's mastering chain
// (item 178, TAUD_FILE_FORMAT.md §9.12).
//
// Song-scoped, like `sMet`: a .taud may hold several songs and each is its own
// delivery, so each carries its own chain. The section's shape mirrors sMet's
// too — an index, a length, then a block — which is what lets a reader skip an
// entry for a song it does not have and a later format version make the block
// longer without breaking anything that reads this one.
//
// Unlike the rest of Project Data this is NOT decoration: §9.8 lists it beside
// `xHDR` and `Ixmp` as a section a conforming player must honour, because a
// song mastered to sit at −14 LUFS with a −1 dBTP ceiling does not sound like
// the same song without it.
//
// Every parameter is an IEEE binary32 in the file and is clamped to the range
// mastering.js declares on the way in, so a hand-written or corrupted section
// can produce a chain that sounds wrong but never one that misbehaves.

import {
  EQ_BANDS, EQ_LOW_SHELF, EQ_PEAKING, EQ_HIGH_SHELF,
  COMP_PEAK, COMP_RMS, HP_SLOPE_12, HP_SLOPE_24,
  defaultMastering, normaliseMastering,
} from "../engine/mastering.js";

export const MASTERING_FOURCC = "sMst";
/** Record version this writer emits, and the highest one this reader knows. */
export const MASTERING_VERSION = 1;
/** Size of the version-1 parameter block. A longer one is read up to here and
 *  the tail skipped; a shorter one is rejected. */
export const MASTERING_BLOCK_SIZE = 160;

const EQ_BASE = 20;
const EQ_STRIDE = 16;
const COMP_BASE = 84;
const WIDTH_BASE = 112;
const LIM_BASE = 120;
const OUT_GAIN = 132;

/** Decode one parameter block. Returns null when it is too short to be one. */
export function parseMasteringBlock(b) {
  if (b.length < MASTERING_BLOCK_SIZE) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const f32 = (o) => dv.getFloat32(o, true);
  // Version 0 has never existed and a future version is not this layout; both
  // are read as "a chain I cannot honour", which is safer than guessing.
  if (b[0] !== MASTERING_VERSION) return null;

  const eq = [];
  for (let i = 0; i < EQ_BANDS; i++) {
    const o = EQ_BASE + i * EQ_STRIDE;
    const type = b[o + 1];
    eq.push({
      on: (b[o] & 1) !== 0,
      type: type === EQ_LOW_SHELF || type === EQ_HIGH_SHELF ? type : EQ_PEAKING,
      freq: f32(o + 4),
      gainDb: f32(o + 8),
      q: f32(o + 12),
    });
  }
  return normaliseMastering({
    on: (b[1] & 1) !== 0,
    trimDb: f32(4),
    hpOn: (b[8] & 1) !== 0,
    hpSlope: (b[8] & 2) !== 0 ? HP_SLOPE_24 : HP_SLOPE_12,
    hpFreq: f32(12),
    eqOn: (b[16] & 1) !== 0,
    eq,
    compOn: (b[COMP_BASE] & 1) !== 0,
    compDetector: (b[COMP_BASE] & 2) !== 0 ? COMP_RMS : COMP_PEAK,
    compThreshDb: f32(COMP_BASE + 4),
    compRatio: f32(COMP_BASE + 8),
    compAttackMs: f32(COMP_BASE + 12),
    compReleaseMs: f32(COMP_BASE + 16),
    compKneeDb: f32(COMP_BASE + 20),
    compMakeupDb: f32(COMP_BASE + 24),
    widthOn: (b[WIDTH_BASE] & 1) !== 0,
    width: f32(WIDTH_BASE + 4),
    limOn: (b[LIM_BASE] & 1) !== 0,
    limTruePeak: (b[LIM_BASE] & 2) !== 0,
    limCeilingDb: f32(LIM_BASE + 4),
    limReleaseMs: f32(LIM_BASE + 8),
    outGainDb: f32(OUT_GAIN),
  });
}

/** Encode one parameter set as a version-1 block. */
export function buildMasteringBlock(params) {
  const p = normaliseMastering(params);
  const b = new Uint8Array(MASTERING_BLOCK_SIZE);
  const dv = new DataView(b.buffer);
  const f32 = (o, v) => dv.setFloat32(o, v, true);

  b[0] = MASTERING_VERSION;
  b[1] = p.on ? 1 : 0;
  f32(4, p.trimDb);
  b[8] = (p.hpOn ? 1 : 0) | (p.hpSlope === HP_SLOPE_24 ? 2 : 0);
  f32(12, p.hpFreq);
  b[16] = p.eqOn ? 1 : 0;
  for (let i = 0; i < EQ_BANDS; i++) {
    const o = EQ_BASE + i * EQ_STRIDE;
    const band = p.eq[i];
    b[o] = band.on ? 1 : 0;
    b[o + 1] = band.type;
    f32(o + 4, band.freq);
    f32(o + 8, band.gainDb);
    f32(o + 12, band.q);
  }
  b[COMP_BASE] = (p.compOn ? 1 : 0) | (p.compDetector === COMP_RMS ? 2 : 0);
  f32(COMP_BASE + 4, p.compThreshDb);
  f32(COMP_BASE + 8, p.compRatio);
  f32(COMP_BASE + 12, p.compAttackMs);
  f32(COMP_BASE + 16, p.compReleaseMs);
  f32(COMP_BASE + 20, p.compKneeDb);
  f32(COMP_BASE + 24, p.compMakeupDb);
  b[WIDTH_BASE] = p.widthOn ? 1 : 0;
  f32(WIDTH_BASE + 4, p.width);
  b[LIM_BASE] = (p.limOn ? 1 : 0) | (p.limTruePeak ? 2 : 0);
  f32(LIM_BASE + 4, p.limCeilingDb);
  f32(LIM_BASE + 8, p.limReleaseMs);
  f32(OUT_GAIN, p.outGainDb);
  return b;
}

/**
 * Whole-section payload → `{songIndex: params}`. An entry whose block this
 * reader does not understand is DROPPED rather than repaired: a chain read
 * half-right is worse than no chain at all, and the neutral default is a
 * defined thing to fall back to.
 */
export function parseMasteringSection(payload) {
  const out = {};
  let p = 0;
  while (p + 5 <= payload.length) {
    const songIndex = payload[p];
    const subLen = (payload[p + 1] | (payload[p + 2] << 8) | (payload[p + 3] << 16)) +
      payload[p + 4] * 0x1000000;
    const sub = p + 5;
    if (sub + subLen > payload.length) break;
    const params = parseMasteringBlock(payload.subarray(sub, sub + subLen));
    if (params !== null) out[songIndex] = params;
    p = sub + subLen;
  }
  return out;
}

/**
 * `{songIndex: params}` → a section payload, ascending by song index. A song
 * whose chain is the untouched default contributes no entry — an absent
 * section and a section full of defaults mean the same thing, and the shorter
 * one is what a project that has never opened the tab should carry.
 * Returns null when nothing is worth writing.
 */
export function buildMasteringSection(map) {
  const indices = Object.keys(map)
    .map((k) => +k)
    .filter((i) => Number.isInteger(i) && i >= 0 && i < 256 && !isDefaultMastering(map[i]))
    .sort((a, b) => a - b);
  if (indices.length === 0) return null;
  const out = new Uint8Array(indices.length * (5 + MASTERING_BLOCK_SIZE));
  let o = 0;
  for (const i of indices) {
    out[o] = i;
    out[o + 1] = MASTERING_BLOCK_SIZE & 0xff;
    out[o + 2] = (MASTERING_BLOCK_SIZE >>> 8) & 0xff;
    out[o + 3] = (MASTERING_BLOCK_SIZE >>> 16) & 0xff;
    out[o + 4] = (MASTERING_BLOCK_SIZE >>> 24) & 0xff;
    out.set(buildMasteringBlock(map[i]), o + 5);
    o += 5 + MASTERING_BLOCK_SIZE;
  }
  return out;
}

/** Is this the untouched neutral chain? (Written-out defaults included.) */
export function isDefaultMastering(params) {
  const p = normaliseMastering(params);
  const d = defaultMastering();
  for (const k of Object.keys(d)) {
    if (k === "eq") continue;
    if (p[k] !== d[k]) return false;
  }
  for (let i = 0; i < EQ_BANDS; i++) {
    for (const k of ["on", "type", "freq", "gainDb", "q"]) {
      if (p.eq[i][k] !== d.eq[i][k]) return false;
    }
  }
  return true;
}
