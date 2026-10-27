// `IMix` — the Project-Data section that carries the instruments' mixing
// chains (item 217, TAUD_FILE_FORMAT.md §9.15).
//
// Instrument-scoped (the `I` prefix): it travels with the instruments, so a
// .tsii bank carries its chains. An instrument names its block in byte 255 of
// its record; 0 there means it has none. A block is
//
//   U8 id (1…255) · U8 reserved · U8 status (0b nnnn 00be) · U8 n
//   FourCC × n            the equipment it holds
//   n × { FourCC · U32 size · payload[size] }
//
// and the section is its blocks, back to back. Every payload starts with four
// common bytes — bypass, folded + version, the dry amount, two reserved — and then the
// equipment's own parameters, every float a binary32, every quantity that
// ACCUMULATES (a rate, a delay time) a U32 in 16.16 fixed point.
//
// Like `sMst`, this is not decoration: §9.8 lists it among the sections a
// conforming player must honour.
//
// Reading is strict about CONTRADICTIONS and lenient about RANGE. A block that
// contradicts itself — an equipment list that does not match its records, a
// wet/dry amount on a piece that has none, crossovers out of order — is INVALID
// and dropped whole (its instruments then sound dry); a value outside its range
// is clamped, as sMst's are. Equipment this reader does not know (an unknown
// FourCC, or a payload version above 0) is kept verbatim, skipped by playback,
// written back unchanged, and reported so the host can say so once.

import {
  IMX_EQUIPMENT, IMX_WET_APPLICABLE, IMX_KNOWN_VERSION, IMX_MAX_ID,
  IMX_ITRM, IMX_EQU1, IMX_EQU2, IMX_COMP, IMX_DEQ1, IMX_DEQ2, IMX_SATU,
  IMX_UNIS, IMX_VERB, IMX_DLAY, IMX_LIMI, IMX_MXTL,
  IMX_EQ_MAX_BANDS, IMX_EQ_SHAPES, IMX_SLOPES, IMX_COMP_MAX_BANDS, IMX_DEQ_BANDS,
  IMX_SAT_CURVES, IMX_UNIS_MIN_VOICES, IMX_UNIS_MAX_VOICES, IMX_LFO_WAVES,
  isCutShape, normaliseImixBlock, normaliseEquipment,
} from "../engine/imix.js";

export const IMIX_FOURCC = "IMix";
/** The chains' names (item 247, §9.16): a name table like `pNam`, entry n
 *  naming block n (entry 0 is id 0, "no chain", and stays empty). */
export const IMCN_FOURCC = "IMcn";

const KNOWN = new Set(IMX_EQUIPMENT);
const LFO_BYTES = 12;
const EQ_BAND = 16;
const COMP_BAND = 28;
const DEQ_BAND = 48;

/** The size of a known version-0 payload, or null when it depends on a count
 *  that has to be read first (equ, comp). */
const FIXED_SIZE = {
  [IMX_ITRM]: 8, [IMX_DEQ1]: 8 + IMX_DEQ_BANDS * DEQ_BAND, [IMX_DEQ2]: 8 + IMX_DEQ_BANDS * DEQ_BAND,
  [IMX_SATU]: 24, [IMX_UNIS]: 20 + 2 * LFO_BYTES, [IMX_VERB]: 24, [IMX_DLAY]: 32,
  [IMX_LIMI]: 20, [IMX_MXTL]: 16,
};

const fourccAt = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const u32At = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;

class Invalid extends Error {}
const fail = (why) => { throw new Invalid(why); };

// ── decoding ────────────────────────────────────────────────────────────────

function readLfo(dv, o) {
  const b = new Uint8Array(dv.buffer, dv.byteOffset + o, LFO_BYTES);
  if (b[0] >= IMX_LFO_WAVES) fail(`LFO waveform ${b[0]} is undefined`);
  return {
    wave: b[0],
    retrigger: (b[1] & 1) !== 0,
    sync: (b[1] & 2) !== 0,
    rate: dv.getUint32(o + 4, true),
    depth: dv.getFloat32(o + 8, true),
  };
}

/** Decode one known, version-0 payload into a parameter record (not yet
 *  clamped). Throws Invalid on a contradiction. */
function decodeEquipment(id, p) {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const f32 = (o) => dv.getFloat32(o, true);
  const fixed = FIXED_SIZE[id];
  if (fixed !== undefined && p.length !== fixed) fail(`${id} payload is ${p.length} bytes, not ${fixed}`);
  const common = { bypass: (p[0] & 0x80) !== 0, folded: (p[0] & 0x40) !== 0, dry: p[1] };
  if (!IMX_WET_APPLICABLE.has(id) && p[1] !== 0) fail(`${id} has no wet/dry, yet carries ${p[1]}`);
  switch (id) {
    case IMX_ITRM: return { ...common, gainDb: f32(4) };
    case IMX_EQU1:
    case IMX_EQU2: {
      if (p.length < 8) fail(`${id} payload is too short`);
      const n = p[4];
      if (n > IMX_EQ_MAX_BANDS) fail(`${id} declares ${n} bands; at most ${IMX_EQ_MAX_BANDS}`);
      if (p.length !== 8 + n * EQ_BAND) fail(`${id} payload size disagrees with its ${n} bands`);
      const bands = [];
      for (let i = 0; i < n; i++) {
        const o = 8 + i * EQ_BAND;
        const shape = p[o + 1];
        if (shape >= IMX_EQ_SHAPES) fail(`${id} band ${i} has undefined shape ${shape}`);
        if (p[o + 2] >= IMX_SLOPES) fail(`${id} band ${i} has undefined slope ${p[o + 2]}`);
        if (!isCutShape(shape) && p[o + 2] !== 0) fail(`${id} band ${i} gives a slope to a shape that has none`);
        bands.push({ on: (p[o] & 1) !== 0, shape, slope: p[o + 2], freq: f32(o + 4), gainDb: f32(o + 8), q: f32(o + 12) });
      }
      return { ...common, bands };
    }
    case IMX_COMP: {
      if (p.length < 8) fail("comp payload is too short");
      const n = p[4];
      if (n < 1 || n > IMX_COMP_MAX_BANDS) fail(`comp declares ${n} bands; 1…${IMX_COMP_MAX_BANDS}`);
      if (p[5] > 1) fail(`comp detector ${p[5]} is undefined`);
      if (p.length !== 8 + 4 * (n - 1) + COMP_BAND * n) fail(`comp payload size disagrees with its ${n} bands`);
      const crossovers = [];
      for (let i = 0; i < n - 1; i++) {
        const x = f32(8 + 4 * i);
        if (i > 0 && !(x > crossovers[i - 1])) fail("comp crossovers are not strictly ascending");
        crossovers.push(x);
      }
      const base = 8 + 4 * (n - 1);
      const bands = [];
      for (let i = 0; i < n; i++) {
        const o = base + i * COMP_BAND;
        bands.push({
          on: (p[o] & 1) !== 0, threshDb: f32(o + 4), ratio: f32(o + 8), attackMs: f32(o + 12),
          releaseMs: f32(o + 16), kneeDb: f32(o + 20), makeupDb: f32(o + 24),
        });
      }
      return { ...common, detector: p[5], crossovers, bands };
    }
    case IMX_DEQ1:
    case IMX_DEQ2: {
      const bands = [];
      for (let i = 0; i < IMX_DEQ_BANDS; i++) {
        const o = 8 + i * DEQ_BAND;
        const unlinked = (p[o] & 2) !== 0;
        const b = {
          on: (p[o] & 1) !== 0, unlinked, boost: (p[o] & 4) !== 0,
          freq: f32(o + 4), q: f32(o + 8), gainDb: f32(o + 12),
          senseFreq: f32(o + 16), senseQ: f32(o + 20),
          threshDb: f32(o + 24), ratio: f32(o + 28), attackMs: f32(o + 32),
          releaseMs: f32(o + 36), rangeDb: f32(o + 40), actorDb: f32(o + 44),
        };
        // A linked band senses where it acts, and its file says so.
        if (!unlinked && (b.senseFreq !== b.freq || b.senseQ !== b.q)) {
          fail(`${id} band ${i} is linked but senses elsewhere than it acts`);
        }
        bands.push(b);
      }
      return { ...common, bands };
    }
    case IMX_SATU:
      if (p[4] >= IMX_SAT_CURVES) fail(`satu curve ${p[4]} is undefined`);
      return { ...common, curve: p[4], driveDb: f32(8), inDb: f32(12), outDb: f32(16), bias: f32(20) };
    case IMX_UNIS:
      if (p[4] < IMX_UNIS_MIN_VOICES || p[4] > IMX_UNIS_MAX_VOICES) {
        fail(`unis declares ${p[4]} voices; ${IMX_UNIS_MIN_VOICES}…${IMX_UNIS_MAX_VOICES}`);
      }
      return {
        ...common, voices: p[4], detune: f32(8), width: f32(12), spacing: f32(16),
        detuneLfo: readLfo(dv, 20), widthLfo: readLfo(dv, 20 + LFO_BYTES),
      };
    case IMX_VERB:
      return { ...common, size: f32(8), decay: f32(12), damping: f32(16), preDelay: dv.getUint32(20, true) };
    case IMX_DLAY:
      return {
        ...common, sync: (p[4] & 1) !== 0, pingPong: (p[4] & 2) !== 0, time: dv.getUint32(8, true),
        feedback: f32(12), highCut: f32(16), lowCut: f32(20), wow: f32(24), driveDb: f32(28),
      };
    case IMX_LIMI:
      return { ...common, truePeak: (p[4] & 1) !== 0, ceilingDb: f32(8), releaseMs: f32(12), gainDb: f32(16) };
    case IMX_MXTL:
      return {
        ...common, swap: (p[4] & 1) !== 0, invL: (p[4] & 2) !== 0, invR: (p[4] & 4) !== 0,
        removeDc: (p[4] & 8) !== 0, gainDb: f32(8), width: f32(12),
      };
    default:
      fail(`no decoder for ${id}`);
  }
  return null;
}

/**
 * Decode one block starting at `o`. Returns {block, next, unknown} — `unknown`
 * listing the equipment kept verbatim — or throws Invalid. A block that runs
 * past the payload's end throws too.
 */
function decodeBlock(b, o) {
  if (o + 4 > b.length) fail("block header runs past the section");
  const id = b[o];
  if (id === 0) fail("block id 0 is reserved for \"no chain\"");
  const status = b[o + 2];
  const order = status >>> 4;
  if (order > 1) fail(`pipeline order ${order} is undefined`);
  const n = b[o + 3];
  let p = o + 4;
  if (p + 4 * n > b.length) fail("equipment list runs past the section");
  const listed = [];
  for (let i = 0; i < n; i++) listed.push(fourccAt(b, p + 4 * i));
  if (new Set(listed).size !== listed.length) fail("equipment list names a piece twice");
  p += 4 * n;
  const block = { id, enabled: (status & 1) !== 0, bus: (status & 2) !== 0, order, equipment: {}, unknown: [] };
  const seen = [];
  const unknownIds = [];
  for (let i = 0; i < n; i++) {
    if (p + 8 > b.length) fail("equipment record runs past the section");
    const fc = fourccAt(b, p);
    const size = u32At(b, p + 4);
    p += 8;
    if (p + size > b.length) fail(`${fc} payload runs past the section`);
    if (size < 4) fail(`${fc} payload is shorter than its common bytes`);
    const payload = b.subarray(p, p + size);
    p += size;
    if (seen.includes(fc)) fail(`${fc} appears twice`);
    seen.push(fc);
    const version = payload[0] & 0x0f;
    if (!KNOWN.has(fc) || version > IMX_KNOWN_VERSION) {
      block.unknown.push({ fourcc: fc, bytes: Uint8Array.from(payload) });
      unknownIds.push(KNOWN.has(fc) ? `${fc} v${version}` : fc);
      continue;
    }
    block.equipment[fc] = decodeEquipment(fc, payload);
  }
  // The list and the records must be the same set: a list is a table of
  // contents, and one that disagrees with the contents is a contradiction.
  const a = [...listed].sort().join(), c = [...seen].sort().join();
  if (a !== c) fail("equipment list disagrees with the records that follow it");
  return { block, next: p, unknown: unknownIds };
}

/**
 * Whole-section payload → {blocks: Map<id, block>, problems: [...]}. Every
 * block is normalised (clamped, narrowed to binary32). `problems` holds one
 * entry per INVALID block ({kind: "invalid", id, detail}) and per block with
 * equipment this reader does not know ({kind: "unknown", id, detail: [ids]}).
 * A block that cannot be delimited ends the walk: what follows it has no
 * framing to be read by.
 */
export function parseImixSection(payload) {
  const blocks = new Map();
  const problems = [];
  let o = 0;
  while (o < payload.length) {
    const id = payload[o];
    let res;
    try {
      res = decodeBlock(payload, o);
    } catch (err) {
      if (!(err instanceof Invalid)) throw err;
      problems.push({ kind: "invalid", id, detail: err.message });
      const next = skipBlock(payload, o);
      if (next === null) break;
      o = next;
      continue;
    }
    o = res.next;
    if (blocks.has(id)) {
      // Two blocks under one id: neither can be said to be the one the
      // instruments mean.
      problems.push({ kind: "invalid", id, detail: `two blocks share id ${id}` });
      blocks.delete(id);
      continue;
    }
    blocks.set(id, normaliseImixBlock(res.block));
    if (res.unknown.length > 0) problems.push({ kind: "unknown", id, detail: res.unknown });
  }
  // A duplicate id is invalid however many copies there are.
  for (const pr of problems) if (pr.detail?.startsWith?.("two blocks")) blocks.delete(pr.id);
  return { blocks, problems };
}

/** Where the block at `o` ends, from its framing alone — or null when even
 *  that cannot be read. */
function skipBlock(b, o) {
  if (o + 4 > b.length) return null;
  const n = b[o + 3];
  let p = o + 4 + 4 * n;
  for (let i = 0; i < n; i++) {
    if (p + 8 > b.length) return null;
    const size = u32At(b, p + 4);
    p += 8 + size;
    if (p > b.length) return null;
  }
  return p;
}

// ── encoding ────────────────────────────────────────────────────────────────

class Out {
  constructor() { this.a = []; }
  u8(v) { this.a.push(v & 0xff); }
  u32(v) { this.u8(v); this.u8(v >>> 8); this.u8(v >>> 16); this.u8(v >>> 24); }
  f32(v) {
    const t = new DataView(new ArrayBuffer(4));
    t.setFloat32(0, v, true);
    for (let i = 0; i < 4; i++) this.a.push(t.getUint8(i));
  }
  fourcc(s) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i)); }
  zeros(n) { for (let i = 0; i < n; i++) this.a.push(0); }
  lfo(l) { this.u8(l.wave); this.u8((l.retrigger ? 1 : 0) | (l.sync ? 2 : 0)); this.zeros(2); this.u32(l.rate); this.f32(l.depth); }
  bytes() { return Uint8Array.from(this.a); }
}

/** Encode one normalised piece as its version-0 payload. */
export function encodeEquipment(id, eIn) {
  const e = normaliseEquipment(id, eIn);
  const w = new Out();
  w.u8((e.bypass ? 0x80 : 0) | (e.folded ? 0x40 : 0));
  w.u8(IMX_WET_APPLICABLE.has(id) ? e.dry : 0);
  w.zeros(2);
  switch (id) {
    case IMX_ITRM: w.f32(e.gainDb); break;
    case IMX_EQU1:
    case IMX_EQU2:
      w.u8(e.bands.length); w.zeros(3);
      for (const b of e.bands) {
        w.u8(b.on ? 1 : 0); w.u8(b.shape); w.u8(b.slope); w.u8(0);
        w.f32(b.freq); w.f32(b.gainDb); w.f32(b.q);
      }
      break;
    case IMX_COMP:
      w.u8(e.bands.length); w.u8(e.detector); w.zeros(2);
      for (const x of e.crossovers) w.f32(x);
      for (const b of e.bands) {
        w.u8(b.on ? 1 : 0); w.zeros(3);
        w.f32(b.threshDb); w.f32(b.ratio); w.f32(b.attackMs); w.f32(b.releaseMs);
        w.f32(b.kneeDb); w.f32(b.makeupDb);
      }
      break;
    case IMX_DEQ1:
    case IMX_DEQ2:
      w.zeros(4);
      for (const b of e.bands) {
        w.u8((b.on ? 1 : 0) | (b.unlinked ? 2 : 0) | (b.boost ? 4 : 0)); w.zeros(3);
        w.f32(b.freq); w.f32(b.q); w.f32(b.gainDb); w.f32(b.senseFreq); w.f32(b.senseQ);
        w.f32(b.threshDb); w.f32(b.ratio); w.f32(b.attackMs); w.f32(b.releaseMs); w.f32(b.rangeDb);
        w.f32(b.actorDb);
      }
      break;
    case IMX_SATU:
      w.u8(e.curve); w.zeros(3);
      w.f32(e.driveDb); w.f32(e.inDb); w.f32(e.outDb); w.f32(e.bias);
      break;
    case IMX_UNIS:
      w.u8(e.voices); w.zeros(3);
      w.f32(e.detune); w.f32(e.width); w.f32(e.spacing);
      w.lfo(e.detuneLfo); w.lfo(e.widthLfo);
      break;
    case IMX_VERB:
      w.zeros(4); w.f32(e.size); w.f32(e.decay); w.f32(e.damping); w.u32(e.preDelay);
      break;
    case IMX_DLAY:
      w.u8((e.sync ? 1 : 0) | (e.pingPong ? 2 : 0)); w.zeros(3);
      w.u32(e.time); w.f32(e.feedback); w.f32(e.highCut); w.f32(e.lowCut); w.f32(e.wow); w.f32(e.driveDb);
      break;
    case IMX_LIMI:
      w.u8(e.truePeak ? 1 : 0); w.zeros(3); w.f32(e.ceilingDb); w.f32(e.releaseMs); w.f32(e.gainDb);
      break;
    case IMX_MXTL:
      w.u8((e.swap ? 1 : 0) | (e.invL ? 2 : 0) | (e.invR ? 4 : 0) | (e.removeDc ? 8 : 0)); w.zeros(3);
      w.f32(e.gainDb); w.f32(e.width);
      break;
    default: throw new Error(`imix: no encoder for ${id}`);
  }
  return w.bytes();
}

/** Encode one block. Known equipment is written in pipeline-0 order, then the
 *  equipment this writer does not know, verbatim and in the order it came. */
export function buildImixBlock(blockIn) {
  const b = normaliseImixBlock(blockIn);
  const recs = [];
  for (const id of IMX_EQUIPMENT) if (b.equipment[id]) recs.push([id, encodeEquipment(id, b.equipment[id])]);
  for (const u of b.unknown) recs.push([u.fourcc, u.bytes]);
  if (recs.length > 255) throw new Error("imix: more than 255 records in one block");
  const w = new Out();
  w.u8(b.id); w.u8(0); w.u8((b.order << 4) | (b.bus ? 2 : 0) | (b.enabled ? 1 : 0)); w.u8(recs.length);
  for (const [fc] of recs) w.fourcc(fc);
  for (const [fc, bytes] of recs) {
    w.fourcc(fc); w.u32(bytes.length);
    for (const x of bytes) w.u8(x);
  }
  return w.bytes();
}

/**
 * Blocks → section payload, ascending by id; null when there is nothing to
 * write. `keep` (a Set of ids), when given, RETIRES every other block — a
 * block no instrument names is dropped at save time and never sooner, so an
 * instrument taken off a chain and put back within a session finds it intact.
 */
export function buildImixSection(blocks, keep = null) {
  const list = [...blocks].filter((b) => keep === null || keep.has(b.id)).sort((a, b) => a.id - b.id);
  if (list.length === 0) return null;
  const parts = list.map(buildImixBlock);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ── the folded flags, in place ──────────────────────────────────────────────
// Folding is the editor's view of a chain, kept in the file but out of the undo
// history (§9.15). So it is set in the BYTES — no decode, no re-encode, nothing
// else in the section touched — and a whole-section replacement (an edit, an
// undo) carries the folds standing at that moment over to what it installs.

const FOLDED = 0x40;

/** Call fn(blockId, fourcc, offsetOfFlagsByte) for every record the framing
 *  delimits. Stops at the first block that cannot be delimited. */
function eachRecord(b, fn) {
  let o = 0;
  while (o + 4 <= b.length) {
    const id = b[o];
    const n = b[o + 3];
    let p = o + 4 + 4 * n;
    for (let i = 0; i < n; i++) {
      if (p + 8 > b.length) return;
      const size = u32At(b, p + 4);
      if (p + 8 + size > b.length) return;
      if (size >= 4) fn(id, fourccAt(b, p), p + 8);
      p += 8 + size;
    }
    o = p;
  }
}

/** A copy of the section `payload` with the piece `fourcc` of block `blockId`
 *  folded or not — or `payload` itself when it holds no such piece. */
export function imixWithFolded(payload, blockId, fourcc, folded) {
  if (!payload) return payload;
  let at = -1;
  eachRecord(payload, (id, fc, o) => { if (id === blockId && fc === fourcc) at = o; });
  if (at < 0) return payload;
  const want = folded ? payload[at] | FOLDED : payload[at] & ~FOLDED;
  if (want === payload[at]) return payload;
  const out = Uint8Array.from(payload);
  out[at] = want;
  return out;
}

/** `target` with the folded flag of every piece that `source` also holds
 *  taken from `source` (a piece only `target` holds keeps its own). */
export function imixCarryFolds(target, source) {
  if (!target || !source) return target;
  const folds = new Map();
  eachRecord(source, (id, fc, o) => folds.set(`${id}:${fc}`, (source[o] & FOLDED) !== 0));
  let out = target;
  eachRecord(target, (id, fc, o) => {
    const f = folds.get(`${id}:${fc}`);
    if (f === undefined || f === ((out[o] & FOLDED) !== 0)) return;
    if (out === target) out = Uint8Array.from(target);
    out[o] = f ? out[o] | FOLDED : out[o] & ~FOLDED;
  });
  return out;
}

/** The lowest id 1…255 that `taken` does not hold, or 0 when all are. */
export function freeImixId(taken) {
  for (let id = 1; id <= IMX_MAX_ID; id++) if (!taken.has(id)) return id;
  return 0;
}
