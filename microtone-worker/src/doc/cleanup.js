// Project cleanup / renumber operations (items 60, 73, 74). Pure planners
// compute a new song or bank layout; the invertible ops that apply them live in
// ops.js (snapshot swaps, like importBankOp). Families:
//   patterns    — remove unreferenced / renumber, rewriting cue references + pNam
//   bank        — remove unused instruments and their now-orphaned samples
//   instrument  — renumber one instrument, following every reference to it (73)
//   ixmp        — drop unreachable instrument patches (74)
//
// Cue words: `cues[cue][ch]` low 15 bits = the lane's pattern index (0x7FFF =
// empty); bit 15 is one bit of the cue's packed instruction word, so a pattern
// remap must preserve it.

import { CUE_EMPTY, PATTERN_SIZE, SAMPLEBIN_SIZE } from "../format/taud-const.js";
import { writePatchesBlob, buildMetaRecord, layerNote } from "../engine/inst.js";
import { EffectOp } from "../engine/tables.js";
import { rowVolumeFromDefault, narrowVolAxis } from "../engine/trigger.js";
import { sampleSpans } from "./document.js";
import { regionSpans } from "./sampleregions.js";
import { emptyPatternBytes } from "./patterntools.js";

const PAT_MASK = 0x7fff;

/** Pattern indices referenced by any cue, in order of FIRST appearance
 *  (cue 0 ch 0, ch 1, …, cue 1, …). Excludes empty slots. */
export function referencedPatterns(song) {
  const seen = new Set();
  const order = [];
  for (const words of song.cues) {
    for (const w of words) {
      const pat = w & PAT_MASK;
      if (pat !== PAT_MASK && !seen.has(pat)) { seen.add(pat); order.push(pat); }
    }
  }
  return order;
}

/** Indices of materialised (non-null) patterns, ascending. */
function materialisedPatterns(song) {
  const out = [];
  for (let i = 0; i < song.patterns.length; i++) if (song.patterns[i]) out.push(i);
  return out;
}

/** New keep-order for "cleanup unused": only cue-referenced patterns, ascending
 *  by old index (stable, predictable numbering). */
export function planCleanupPatterns(song) {
  return [...new Set(referencedPatterns(song))].sort((a, b) => a - b);
}

/** Binary content key of a pattern (its 512 raw bytes as a string). A null/absent
 *  slot uses the empty-pattern content, so it keys the same as a materialised-blank
 *  pattern — the two merge. */
function patternContentKey(pattern) {
  if (!pattern) {
    const bytes = emptyPatternBytes();
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  let s = "";
  for (let r = 0; r < pattern.length; r++) {
    const cell = pattern[r];
    for (let b = 0; b < 8; b++) s += String.fromCharCode(cell.getByte(b));
  }
  return s;
}

/**
 * De-dupe a keep-order: collapse byte-identical patterns onto their FIRST copy
 * in `order` (so with an ascending `order` the survivor is the lowest index).
 * Returns { order, canon }: `order` is the deduped keep-order (survivors only, in
 * their original relative order); `canon` maps every input old index to the old
 * index it merges onto (== itself for a survivor). Feed `canon` to
 * applyPatternOrder so cue words pointing at a duplicate re-target the survivor.
 */
export function planMergeDuplicatePatterns(song, order) {
  const firstByKey = new Map();
  const canon = new Map();
  const merged = [];
  for (const idx of order) {
    const key = patternContentKey(song.patterns[idx]);
    if (firstByKey.has(key)) {
      canon.set(idx, firstByKey.get(key));
    } else {
      firstByKey.set(key, idx);
      canon.set(idx, idx);
      merged.push(idx);
    }
  }
  return { order: merged, canon };
}

/** New keep-order for "renumber": referenced patterns in play (first-appearance)
 *  order, then any materialised-but-unreferenced patterns (ascending) so nothing
 *  with content is lost — just compacted and reordered. */
export function planRenumberPatterns(song) {
  const ref = referencedPatterns(song);
  const refSet = new Set(ref);
  const extra = materialisedPatterns(song).filter((i) => !refSet.has(i));
  return [...ref, ...extra];
}

/**
 * Apply a keep-order (`order` = old indices in their new position) to a song:
 * returns { patterns, cues, pNam } — a fresh patterns array, cue words rewritten
 * to the new indices (empty slots and the instruction sign bit preserved; a
 * reference to a dropped pattern becomes empty), and a reordered pNam name list
 * (array of strings, aligned to the new indices). Pure — does not mutate `song`.
 * `canon` (optional, from planMergeDuplicatePatterns) re-targets each old index to
 * its merge survivor before the new-index lookup, so cues that played a duplicate
 * follow it onto the survivor.
 */
export function applyPatternOrder(song, order, patternNames, canon = null) {
  const oldToNew = new Map();
  order.forEach((oldIdx, newIdx) => oldToNew.set(oldIdx, newIdx));

  const patterns = order.map((oldIdx) => song.patterns[oldIdx] ?? null);

  const cues = song.cues.map((words) => {
    const out = words.slice();
    for (let ch = 0; ch < out.length; ch++) {
      const w = out[ch];
      const pat = w & PAT_MASK;
      if (pat === PAT_MASK) continue; // empty slot — leave as-is
      const canonPat = canon && canon.has(pat) ? canon.get(pat) : pat; // duplicate → survivor
      const nn = oldToNew.has(canonPat) ? oldToNew.get(canonPat) : PAT_MASK; // dropped → empty
      out[ch] = (w & 0x8000) | (nn & PAT_MASK);
    }
    return out;
  });

  const names = order.map((oldIdx) => patternNames[oldIdx] ?? "");
  // Trim trailing empty names (keep the table compact).
  while (names.length && names[names.length - 1] === "") names.pop();

  return { patterns, cues, pNam: names };
}

/** Encode a name-table string array to its 0x1E-separated payload, or null when
 *  empty (matches Document._nameTable's decode). */
export function encodeNameTable(names) {
  if (!names || names.length === 0) return null;
  const enc = new TextEncoder();
  const segs = names.map((n) => enc.encode(n ?? ""));
  const total = segs.reduce((n, s) => n + s.length, 0) + (segs.length - 1);
  const out = new Uint8Array(Math.max(0, total));
  let off = 0;
  segs.forEach((s, i) => { if (i > 0) out[off++] = 0x1e; out.set(s, off); off += s.length; });
  return out;
}

// ── bank cleanup (instruments + samples) ──

/** Instrument slots actually used: referenced by a pattern cell OR pulled in as
 *  a metainstrument layer child of a used top-level instrument. `instAt(slot)`
 *  returns the decoded TaudInst (for meta-layer closure). */
export function usedInstrumentSlots(song, allUsedSlots, instAt) {
  const used = new Set();
  for (const p of song.patterns) {
    if (!p) continue;
    for (const cell of p) if (cell.instrment !== 0) used.add(cell.instrment & 0xff);
  }
  // Meta-layer dependency closure (a used meta pulls in its children).
  const queue = [...used];
  while (queue.length) {
    const s = queue.pop();
    const layers = instAt(s)?.metaLayers;
    if (layers) for (const l of layers) {
      const c = l.instIdx & 0x3ff;
      if (allUsedSlots.has(c) && !used.has(c)) { used.add(c); queue.push(c); }
    }
  }
  return used;
}

/** Sample spans referenced by `slots` (deduped by ptr:len, ptr-sorted).
 *  instAt(slot) → decoded TaudInst. Returns [{ptr, len, key, chan}], where
 *  chan > 0 marks the EXTRA channels of a stereo/multi-channel patch (item 90):
 *  those bytes are live and must survive the pool sweep, but they are not
 *  separate samples — only chan 0 spans carry an SNam name. */
function censusForSlots(instAt, slots, patchOverrides = null) {
  const byKey = new Map();
  const add = (ptr, len, chan = 0) => {
    if (len <= 0) return;
    const key = ptr + ":" + len;
    if (!byKey.has(key)) byKey.set(key, { ptr, len, key, chan });
  };
  for (const s of slots) {
    const inst = instAt(s);
    if (!inst) continue;
    if (!inst.isMeta) add(inst.samplePtr, inst.sampleLength);
    const patches = patchOverrides?.has(s) ? patchOverrides.get(s) : inst.extraPatches;
    if (patches) {
      for (const p of patches) {
        add(p.samplePtr, p.sampleLength);
        if (p.hasChanBlock) {
          for (let k = 0; k < Math.min(p.chanPtrs.length, p.chanCount - 1); k++) {
            add(p.chanPtrs[k], p.sampleLength, k + 1);
          }
        }
      }
    }
  }
  return [...byKey.values()].sort((a, b) => a.ptr - b.ptr);
}

/**
 * Plan a bank cleanup (items 60 + 147): drop instruments no pattern cell
 * references (keeping meta-layer children of used metas), prune the SURVIVORS'
 * Ixmp patches down to the ones the document can still trigger, and free every
 * sample byte nothing points at any more.
 *
 * Item 147 is the second of those: a used instrument drags its whole patch set
 * in, and a General MIDI drum kit's patch set is most of a project's sample
 * budget. Pruning it here means one Housekeeping button reclaims the space
 * whether it was a whole instrument or one kit note that went unused. The pool
 * sweep already zeroes everything outside the surviving census, so freeing the
 * dropped patches' samples needs nothing beyond censusing the survivors with
 * their pruned patch lists.
 *
 * Returns the NEW bank state for cleanupBankOp:
 *   { image, inam, snam, ixmp, removedInstruments, removedPatches,
 *     removedBlobs, freedSampleBytes, report }
 * `inam`/`snam` are name-table payloads (or null). Pure w.r.t. the doc except a
 * _rebuildInstRegion() to make the image current first.
 */
export function planBankCleanup(doc) {
  if (!doc.sampleInstImage) return { noop: true, removedInstruments: 0, freedSampleBytes: 0 };
  doc._rebuildInstRegion(); // flush pending inst edits into the image
  const instAt = (s) => doc.instruments[s];
  const allUsed = new Set(doc.usedInstrumentSlots());

  // Slots referenced by a pattern cell (any song) + meta-layer dependency closure.
  const used = new Set();
  for (const song of doc.songs) for (const p of song.patterns) {
    if (!p) continue;
    for (const cell of p) if (cell.instrment !== 0) used.add(cell.instrment & 0xff);
  }
  const queue = [...used];
  while (queue.length) {
    const layers = instAt(queue.pop())?.metaLayers;
    if (layers) for (const l of layers) {
      const c = l.instIdx & 0x3ff;
      if (allUsed.has(c) && !used.has(c)) { used.add(c); queue.push(c); }
    }
  }
  const survivors = [...allUsed].filter((s) => used.has(s));
  const unused = [...allUsed].filter((s) => !used.has(s));

  // Cleaned image: zero the removed instrument records.
  const image = doc.sampleInstImage.slice();
  for (const s of unused) image.fill(0, SAMPLEBIN_SIZE + s * 256, SAMPLEBIN_SIZE + (s + 1) * 256);

  // Item 147: the survivors' unreachable patches go too, and their samples with
  // them. `used` is the keep-set, so the removed instruments' blobs drop here
  // rather than in a second filter.
  const prune = planPatchPrune(doc, used);

  // Free sample bytes nothing points at any more: zero the pool outside the
  // surviving census spans (shared samples are kept).
  // Pool REGIONS (item 175) are kept whole: their bytes are claimed by nothing
  // by definition, so a sweep that only spared the census would wipe every long
  // recording loaded into memory. They are the user's source material, not
  // garbage, and Housekeeping never drops one.
  const censusKeep = censusForSlots(instAt, survivors, prune.overrides);
  const keep = [
    ...censusKeep,
    ...doc.sampleRegions().flatMap(regionSpans)
      .map((sp) => ({ ptr: sp.ptr, len: sp.len, chan: sp.chan, key: sp.ptr + ":" + sp.len })),
  ].sort((a, b) => a.ptr - b.ptr);
  const pool = image.subarray(0, SAMPLEBIN_SIZE);
  let freedSampleBytes = 0;
  const zeroRange = (from, to) => {
    for (let i = from; i < to; i++) if (pool[i] !== 0) { pool[i] = 0; freedSampleBytes++; }
  };
  let cursor = 0;
  for (const sp of keep) {
    if (sp.ptr > cursor) zeroRange(cursor, sp.ptr);
    cursor = Math.max(cursor, sp.ptr + sp.len);
  }
  zeroRange(cursor, SAMPLEBIN_SIZE);

  // INam: blank removed slots' names.
  const inamArr = doc._nameTable("INam").slice();
  for (const s of unused) if (s < inamArr.length) inamArr[s] = "";
  while (inamArr.length && inamArr[inamArr.length - 1] === "") inamArr.pop();

  // SNam: realign to the surviving census (names keyed by ptr:len identity).
  // Extra stereo channels are live pool spans but not named samples.
  const oldNameByKey = new Map();
  for (const e of doc.sampleList()) oldNameByKey.set(e.ptr + ":" + e.len, e.name);
  // Regions are not named SAMPLES, so they contribute no SNam entry — the table
  // still lines up with sampleList(), which never sees them, so the CENSUS half
  // of the keep-set above is what the names realign to.
  const snamArr = censusKeep.filter((sp) => sp.chan === 0).map((sp) => oldNameByKey.get(sp.key) ?? "");
  while (snamArr.length && snamArr[snamArr.length - 1] === "") snamArr.pop();

  return {
    image, inam: encodeNameTable(inamArr), snam: encodeNameTable(snamArr),
    ixmp: prune.ixmp, report: prune.report,
    removedInstruments: unused.length, freedSampleBytes,
    removedPatches: prune.removedPatches, removedBlobs: prune.removedBlobs,
  };
}

// ── instrument renumber (item 73) ──

/** Pattern cells (any song) whose instrument byte is `slot`: [{song, pat, row}].
 *  The cell's instrument byte is 8-bit, so a sub-instrument ($100+, reachable
 *  through its metainstrument since item 71) can never be named by one — it must
 *  NOT be masked down to its low byte and match an unrelated $01–$FF slot. */
export function instrumentCellRefs(doc, slot) {
  const refs = [];
  if (slot > 0xff) return refs;
  doc.songs.forEach((song, si) => {
    song.patterns.forEach((p, pi) => {
      if (!p) return;
      p.forEach((cell, row) => {
        if ((cell.instrment & 0xff) === slot) refs.push({ song: si, pat: pi, row });
      });
    });
  });
  return refs;
}

/**
 * Plan an instrument renumber `from` → `to` (item 73). The target must be a FREE
 * note-addressable slot ($01–$FF): occupied targets are refused rather than
 * silently swapped, and $100+ targets aren't offered because a metainstrument's
 * layer copies (item 72) are the way to reach that range.
 *
 * References that are pure wiring always follow the move — the Ixmp blob's slot
 * id, the INam entry, and every metainstrument layer that points at `from`.
 * Pattern cells are a musical choice: they only follow when `remapPatterns` is
 * set, otherwise cells keep referencing the (now empty) old number.
 *
 * Returns {error} or a renumberInstrumentOp plan: {image, inam, ixmp, cells}.
 */
export function planRenumberInstrument(doc, from, to, { remapPatterns = false } = {}) {
  if (!doc.sampleInstImage) return { error: "This project has no sample+instrument image." };
  if (to < 1 || to > 255) return { error: "An instrument number must be $01–$FF." };
  if (from === to) return { error: "The instrument already has that number." };
  const used = new Set(doc.usedInstrumentSlots());
  if (!used.has(from)) return { error: "That instrument slot is empty." };
  if (used.has(to)) {
    return { error: `$${to.toString(16).toUpperCase().padStart(2, "0")} is already taken.` };
  }
  doc._rebuildInstRegion(); // flush pending inst edits into the image

  const image = doc.sampleInstImage.slice();
  const recOff = (slot) => SAMPLEBIN_SIZE + slot * 256;
  image.set(image.slice(recOff(from), recOff(from) + 256), recOff(to));
  image.fill(0, recOff(from), recOff(from) + 256);

  // Metainstrument layers are raw record bytes, so patch them in the image: the
  // layer's low 8 index bits live at its byte 0, bits 8..9 in the top two bits
  // of its vol-start byte (+8). A meta that moved is patched at its NEW record.
  for (const s of used) {
    const layers = doc.instruments[s].metaLayers;
    if (!layers) continue;
    const base = recOff(s === from ? to : s);
    for (const l of layers) {
      if ((l.instIdx & 0x3ff) !== from) continue;
      image[base + l.rawOffset] = to & 0xff;
      image[base + l.rawOffset + 8] = (l.volStart & 0x3f) | (((to >>> 8) & 0x3) << 6);
    }
  }

  const inamArr = doc._nameTable("INam").slice();
  while (inamArr.length <= Math.max(from, to)) inamArr.push("");
  inamArr[to] = inamArr[from];
  inamArr[from] = "";
  while (inamArr.length && inamArr[inamArr.length - 1] === "") inamArr.pop();

  const ixmp = doc.ixmp.map((e) =>
    (e.instId & 0x3ff) === from ? { instId: to, count: e.count, blob: e.blob } : e);

  const cells = remapPatterns
    ? instrumentCellRefs(doc, from).map((r) => ({ ...r, inst: to }))
    : [];

  return { image, inam: encodeNameTable(inamArr), ixmp, cells, from, to };
}

// ── Ixmp patch cleanup (item 74) ──

/** A patch that can never sound: an empty pitch/velocity range, or no sample. */
function patchIsDegenerate(p) {
  return p.sampleLength <= 0 || p.pitchEnd < p.pitchStart || p.volumeEnd < p.volumeStart;
}

/**
 * Is `p`'s rectangle fully covered by the union of `earlier`'s rectangles? Patch
 * order IS trigger-match priority (engine resolvePatch returns the first hit), so
 * a fully-covered patch is unreachable. Exact test: compress the coordinates of
 * every boundary inside p into a grid and check each cell has a coverer — pairwise
 * containment would miss rectangles that only cover p when combined.
 */
function patchIsShadowed(p, earlier) {
  const covers = earlier.filter((q) =>
    !patchIsDegenerate(q) &&
    q.pitchStart <= p.pitchEnd && q.pitchEnd >= p.pitchStart &&
    q.volumeStart <= p.volumeEnd && q.volumeEnd >= p.volumeStart);
  if (covers.length === 0) return false;
  const axis = (lo, hi, starts, ends) => {
    const cuts = new Set([lo]);
    for (const v of starts) if (v > lo && v <= hi) cuts.add(v);
    for (const v of ends) if (v >= lo && v < hi) cuts.add(v + 1);
    return [...cuts].sort((a, b) => a - b);
  };
  const xs = axis(p.pitchStart, p.pitchEnd, covers.map((q) => q.pitchStart), covers.map((q) => q.pitchEnd));
  const ys = axis(p.volumeStart, p.volumeEnd, covers.map((q) => q.volumeStart), covers.map((q) => q.volumeEnd));
  for (const x of xs) {
    for (const y of ys) {
      // (x, y) is the lowest corner of a compressed cell: if it is covered, the
      // whole cell is (no rectangle boundary runs through a cell's interior).
      const hit = covers.some((q) =>
        x >= q.pitchStart && x <= q.pitchEnd && y >= q.volumeStart && y <= q.volumeEnd);
      if (!hit) return false;
    }
  }
  return true;
}

/**
 * Usage reachability (item 74, widened by item 147).
 *
 * A patch is reachable when SOME trigger the document can perform resolves to
 * it. The engine truth is trigger.js (triggerMetaOrNote / triggerNote) and
 * inst.js TaudInst.resolvePatch — see TAUD_ENGINE_SPEC.md. Every trigger boils
 * down to a pair `(noteVal, seedVol)` handed to resolvePatch, so the analysis
 * collects the pairs the patterns can produce and resolves them.
 *
 * Some rows do not fix both coordinates: an instrument-byte-only row and a
 * tone-portamento continuation take the pitch (and sometimes the volume) from
 * the LANE'S prior state, and a note with no instrument byte sounds whatever
 * the lane had latched. Those coordinates become WILDCARDS rather than
 * making the whole slot unanalysable, which is what item 147 turns on: the
 * wildcard axis is swept over every value that can change the answer, so the
 * result is still a guaranteed SUPERSET of what can sound — a drum kit played
 * on one note keeps its patches for that note and loses the rest, even though
 * some other lane's porta row leaves a volume unknown.
 *
 * The sweep is exact rather than sampled: resolvePatch returns the FIRST patch
 * whose rectangle contains the pair, so the answer is constant inside every
 * cell of the grid the patch boundaries cut, and one probe per cell sees
 * everything. The volume axis is only 6 bits, so it is swept whole.
 */

/** Wildcard coordinate: "the lane decides, and we do not know what it had". */
const WILD = -2;
/** Every seed volume a wildcard volume can stand for: -1 is "no volume column",
 *  which resolves to the instrument's own Default Note Volume. */
const VOL_SWEEP = Array.from({ length: 65 }, (_, i) => i - 1);

const packPair = (note, vol) => note * 65 + (vol + 1);
const pairNote = (k) => Math.trunc(k / 65);
const pairVol = (k) => (k % 65) - 1;
const clampNote = (n) => Math.min(Math.max(n, 0x20), 0xffff);

function newDemand() {
  return { pairs: new Set(), wildVolNotes: new Set(), wildNoteVols: new Set(), wildBoth: false };
}

/** Record that `slot` can be triggered at (note, vol); either may be WILD. */
function addDemand(demands, slot, note, vol) {
  let d = demands.get(slot);
  if (d === undefined) { d = newDemand(); demands.set(slot, d); }
  if (note === WILD && vol === WILD) d.wildBoth = true;
  else if (note === WILD) d.wildNoteVols.add(vol);
  else if (vol === WILD) d.wildVolNotes.add(note);
  else d.pairs.add(packPair(note, vol));
}

/**
 * Every (slot, note, seedVol) trigger the document's pattern cells can produce.
 * Mirrors row.js's note branches one for one; anything the row leaves to the
 * lane becomes WILD.
 */
function collectCellDemands(doc) {
  const ts = { wideCells: doc.wideCells };
  const demands = new Map();
  // Which instrument a note-with-no-instrument-byte row sounds depends on what
  // the lane had latched, so every instrument the document names is a
  // candidate. (Scanning by lane would narrow it, but a cue can put any
  // pattern on any lane, so the narrowing would be worth little.)
  const latchable = new Set();
  for (const song of doc.songs) {
    for (const rows of song.patterns) {
      if (!rows) continue;
      for (const cell of rows) if (cell.instrment !== 0) latchable.add(cell.instrment & 0xff);
    }
  }

  for (const song of doc.songs) {
    for (const rows of song.patterns) {
      if (!rows) continue;
      // A pattern ditto (effect 7) replays earlier rows of the same pattern with
      // the destination row's explicit columns patched over them, so the triples
      // it can produce are not the ones written in any single cell. They are
      // still built from THIS pattern's notes and instruments, so pair those up
      // with an unknown volume and let the sweep cover the rest.
      if (rows.some((c) => c.effect === EffectOp.OP_7)) {
        const notes = [...new Set(rows.map((c) => c.note).filter((n) => n >= 0x20))];
        const slots = [...new Set(rows.map((c) => c.instrment).filter((i) => i !== 0))];
        for (const s of slots) for (const n of notes) addDemand(demands, s, n, WILD);
      }
      for (const cell of rows) {
        const note = cell.note;
        const slot = cell.instrment & 0xff;
        const vol = cell.volumeEff === 0 ? narrowVolAxis(ts, cell.volume) : -1;
        if (note === 0x0000) {
          // No note. An instrument byte either TRIGGERS at the lane's current
          // pitch (row.js's E/F/G branch) or swaps the instrument under the
          // sounding note, resolving at that pitch AND the lane's running
          // volume. Both read lane state; the second reads both axes.
          if (slot !== 0) {
            addDemand(demands, slot, WILD, vol);
            addDemand(demands, slot, WILD, WILD);
          }
          continue;
        }
        if (note < 0x0020) continue; // key-off / cut / fade / interrupt: no lookup
        if (slot === 0) {
          // The lane's latched instrument sounds it, seeded from the
          // lane's running volume unless the row SETS one (triggerNote's
          // `instId === 0` branch).
          for (const s of latchable) addDemand(demands, s, note, vol >= 0 ? vol : WILD);
          continue;
        }
        addDemand(demands, slot, note, vol);
        // applyDuplicateCheck runs on every fresh trigger and resolves its own
        // patch at full velocity to compare sample pointers.
        addDemand(demands, slot, note, 0x3f);
        if (cell.effect === EffectOp.OP_G || cell.effect === EffectOp.OP_L) {
          // Tone porta: on an ALREADY SOUNDING voice the row re-resolves the
          // lane's note and volume under the new instrument instead of
          // triggering (row.js); on a silent one it falls through to the plain
          // trigger recorded above, so both are kept.
          addDemand(demands, slot, WILD, WILD);
        }
      }
    }
  }
  return demands;
}

/**
 * Fan a metainstrument's demands out onto its layer children, exactly as
 * triggerMetaOrNote does: the gate is the meta's own rectangle at the row's
 * volume (0x3F when the row sets none), each surviving layer is triggered at
 * `note + detune`, and the child's own resolvePatch is seeded from the row
 * volume or — with no volume column — from the CHILD's Default Note Volume.
 *
 * A wildcard note propagates as a wildcard: the child's pitch tracks the
 * meta's, so pinning the layer set at sampled notes would not pin the child's.
 */
function expandMetaDemands(doc, demands) {
  for (const slot of [...demands.keys()]) {
    const inst = doc.instruments[slot];
    if (!inst?.isMeta || !inst.metaLayers) continue;
    const d = demands.get(slot);
    const emit = (note, vol) => {
      const seedVol = vol >= 0 ? vol : 0x3f;
      let layers = inst.resolveMetaLayers(note, seedVol);
      if (inst.metaStrict) {
        layers = layers.filter((l) => doc.instruments[l.instIdx & 0x3ff]
          ?.resolvePatch(clampNote(layerNote(l, note)), seedVol) != null);
      }
      // What the layer SOUNDS — a fixed-pitch layer (item 179) demands its own
      // note whatever key reached it, so pruning must keep the zone THAT lands
      // in rather than the one under the trigger.
      for (const l of layers) addDemand(demands, l.instIdx & 0x3ff, clampNote(layerNote(l, note)), vol);
    };
    for (const k of d.pairs) emit(pairNote(k), pairVol(k));
    for (const note of d.wildVolNotes) for (const v of VOL_SWEEP) emit(note, v);
    if (d.wildBoth || d.wildNoteVols.size > 0) {
      const vols = d.wildBoth ? [WILD] : [...d.wildNoteVols];
      for (const l of inst.metaLayers) {
        for (const v of vols) addDemand(demands, l.instIdx & 0x3ff, WILD, v);
      }
    }
  }
}

/** Note probes that see every distinct answer resolvePatch can give `patches`:
 *  one inside each band the patch pitch boundaries cut. */
function noteProbes(patches) {
  const cuts = new Set([0x20]);
  for (const p of patches) {
    if (p.pitchStart > 0x20) cuts.add(p.pitchStart);
    if (p.pitchEnd < 0xffff) cuts.add(p.pitchEnd + 1);
  }
  return [...cuts];
}

/** The patches `slot` can be triggered on, given everything demanded of it. */
function resolveDemand(doc, slot, demand) {
  const inst = doc.instruments[slot];
  const patches = inst?.extraPatches ?? [];
  const reachable = new Set();
  if (patches.length === 0 || demand === undefined) return reachable;
  const dnv = rowVolumeFromDefault(inst, null);
  const hit = (note, vol) => {
    const p = inst.resolvePatch(note, vol >= 0 ? vol : dnv);
    if (p !== null) reachable.add(p);
  };
  for (const k of demand.pairs) hit(pairNote(k), pairVol(k));
  if (demand.wildVolNotes.size > 0) {
    for (const note of demand.wildVolNotes) for (const v of VOL_SWEEP) hit(note, v);
  }
  if (demand.wildNoteVols.size > 0 || demand.wildBoth) {
    const probes = noteProbes(patches);
    const vols = demand.wildBoth ? VOL_SWEEP : [...demand.wildNoteVols];
    for (const note of probes) for (const v of vols) hit(note, v);
  }
  return reachable;
}

/**
 * Map slot → the Set of its Ixmp patches the document can actually trigger.
 * Every slot carrying patches gets an entry (an empty Set means nothing in the
 * document reaches it). See the block comment above for what makes this sound.
 */
export function reachablePatchSets(doc) {
  const demands = collectCellDemands(doc);
  expandMetaDemands(doc, demands);
  const out = new Map();
  for (const e of doc.ixmp) {
    const slot = e.instId & 0x3ff;
    if (!out.has(slot)) out.set(slot, resolveDemand(doc, slot, demands.get(slot)));
  }
  return out;
}

/**
 * Prune every Ixmp entry down to the patches that can still be triggered —
 * shared by the Ixmp cleanup (item 74) and the bank cleanup (item 147, which
 * runs it over the instruments it is keeping). `keepSlots` null means every
 * slot; otherwise entries for slots outside it are dropped whole (the caller is
 * deleting those instruments).
 *
 * Reasons a patch goes: `degenerate` (empty rectangle or no sample),
 * `shadowed` (fully covered by higher-priority patches) and `unused` (no
 * trigger in the document resolves to it). An entry whose slot holds no
 * instrument record at all is an `orphan` and goes whole.
 *
 * Returns {ixmp, report, overrides, removedPatches, removedBlobs}; `overrides`
 * maps each touched slot to its surviving patch list, which is what
 * doc.sampleList()/censusForSlots need to see the post-prune census.
 */
function planPatchPrune(doc, keepSlots = null) {
  const instRegion = doc.sampleInstImage.subarray(SAMPLEBIN_SIZE);
  const hasRecord = (slot) =>
    !instRegion.subarray(slot * 256, (slot + 1) * 256).every((b) => b === 0);
  const reachableBySlot = reachablePatchSets(doc);

  const ixmp = [];
  const report = [];
  const overrides = new Map();
  let removedPatches = 0;
  let removedBlobs = 0;
  for (const e of doc.ixmp) {
    const slot = e.instId & 0x3ff;
    const patches = doc.instruments[slot].extraPatches ?? [];
    if (keepSlots !== null && !keepSlots.has(slot)) continue; // the caller drops the slot
    if (!hasRecord(slot)) { // orphan blob: nothing to trigger it
      removedBlobs++;
      removedPatches += patches.length;
      overrides.set(slot, []);
      report.push({ slot, reason: "orphan", dropped: patches.length, kept: 0, keep: [] });
      continue;
    }
    const geomKeep = [];
    let geomDropped = 0;
    for (const p of patches) {
      if (patchIsDegenerate(p) || patchIsShadowed(p, geomKeep)) { geomDropped++; continue; }
      geomKeep.push(p);
    }
    // Usage pass: among the geometrically-reachable survivors, drop any patch no
    // trigger the document can perform actually resolves to.
    const reachable = reachableBySlot.get(slot);
    const keep = reachable ? geomKeep.filter((p) => reachable.has(p)) : geomKeep;
    const dropped = geomDropped + (geomKeep.length - keep.length);
    if (dropped === 0) { ixmp.push(e); continue; }
    removedPatches += dropped;
    overrides.set(slot, keep);
    report.push({ slot, reason: "unreachable", dropped, kept: keep.length, keep });
    if (keep.length === 0) { removedBlobs++; continue; }
    ixmp.push({ instId: e.instId, count: keep.length, blob: writePatchesBlob(keep) });
  }
  return { ixmp, report, overrides, removedPatches, removedBlobs };
}

/**
 * Plan an Ixmp cleanup (item 74): drop patch entries that can never be triggered.
 *   * orphan    — the blob's instrument slot holds no record at all
 *   * degenerate— empty pitch/velocity range, or a zero-length sample
 *   * shadowed  — fully covered by higher-priority (earlier) patches
 *   * unused    — geometrically reachable, but no trigger the document can
 *                 perform resolves to it (reachablePatchSets)
 * A slot whose patches all drop loses its Ixmp entry. Removing patches can change
 * the sample census, so SNam is realigned by (ptr:len) identity like planBankCleanup,
 * and any pool span that drops out of the census as a result (no surviving patch or
 * base sample anywhere in the document still uses it) is freed the same way a
 * deleted instrument's unique samples are — comparing the whole-document census
 * before vs. after, not just the touched slots, so a span shared with an
 * untouched instrument is correctly kept.
 * Returns {noop:true, …} when nothing is unreachable, else a cleanupBankOp plan
 * (INam passes through unchanged) with a per-slot report.
 */
export function planIxmpCleanup(doc) {
  if (!doc.sampleInstImage) return { noop: true, removedPatches: 0, removedBlobs: 0 };
  doc._rebuildInstRegion();
  const { ixmp, report, overrides, removedPatches, removedBlobs } = planPatchPrune(doc);
  if (removedPatches === 0) {
    return { noop: true, removedPatches: 0, removedBlobs: 0, report: [] };
  }

  // Preview the post-cleanup census: each touched slot re-evaluated with its
  // SURVIVING patches only. SNam realigns by (ptr:len) identity; any span present
  // before but absent after had every one of its users among the dropped patches,
  // so its pool bytes are freed too (a span still used by an untouched instrument,
  // or by another touched slot's surviving patch, stays in both censuses and is
  // therefore kept).
  const oldCensus = doc.sampleList();
  const oldNameByKey = new Map();
  for (const e of oldCensus) oldNameByKey.set(e.ptr + ":" + e.len, e.name);
  const newCensus = doc.sampleList(overrides);
  const newKeys = new Set(newCensus.map((e) => e.ptr + ":" + e.len));

  const image = doc.sampleInstImage.slice();
  const pool = image.subarray(0, SAMPLEBIN_SIZE);
  let freedSampleBytes = 0;
  for (const e of oldCensus) {
    if (newKeys.has(e.ptr + ":" + e.len)) continue;
    for (const sp of sampleSpans(e)) {
      for (let i = sp.ptr; i < sp.ptr + sp.len; i++) if (pool[i] !== 0) { pool[i] = 0; freedSampleBytes++; }
    }
  }

  const snamArr = newCensus.map((s) => oldNameByKey.get(s.ptr + ":" + s.len) ?? "");
  while (snamArr.length && snamArr[snamArr.length - 1] === "") snamArr.pop();

  return {
    image,
    inam: doc.projSections.find((s) => s.fourcc === "INam")?.payload ?? null,
    snam: encodeNameTable(snamArr),
    ixmp,
    report,
    removedPatches,
    removedBlobs,
    freedSampleBytes,
  };
}

// ── sample delete (item 151) ──

/** Merge [{ptr, len}] spans into sorted, non-overlapping [from, to) intervals. */
function mergedIntervals(spans) {
  const iv = spans.map((s) => [s.ptr, s.ptr + s.len]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of iv) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** [ptr, ptr+len) minus a sorted list of [a, b) intervals, as {ptr, len}. */
function rangeMinusIntervals(ptr, len, holes) {
  let parts = [{ ptr, len }];
  for (const [ha, hb] of holes) {
    const next = [];
    for (const p of parts) {
      const a = p.ptr, b = p.ptr + p.len;
      if (hb <= a || ha >= b) { next.push(p); continue; }
      if (ha > a) next.push({ ptr: a, len: ha - a });
      if (hb < b) next.push({ ptr: hb, len: b - hb });
    }
    parts = next;
  }
  return parts;
}

/**
 * Delete a pooled sample (item 151): free its bytes and cut every reference to
 * it loose. The census is derived from instruments, so a sample only stops
 * existing once nothing points at it any more:
 *   * a base record bound to it keeps its slot but loses its sample — bytes
 *     0..5 (pointer + length) and the loop markers go, which is the "dangling
 *     pointer" the confirm dialog warns about: the instrument survives, its
 *     notes survive, and it plays nothing until it is given a sample again;
 *   * an Ixmp patch bound to it is dropped, and a slot left with no patches
 *     loses its blob (the base record then answers for the whole range again).
 * Pool bytes are zeroed only where no SURVIVING census span covers them, so a
 * sample overlapping another one can never eat its neighbour's audio.
 *
 * Returns {error} or a cleanupBankOp plan (INam passes through unchanged) with
 * the report the dialog needs: `clearedInsts` (base records left dangling),
 * `patchedInsts` (slots that lost patches), `removedPatches`, `removedBlobs`,
 * `freedSampleBytes`.
 */
export function planDeleteSample(doc, sample) {
  if (!doc.sampleInstImage) return { error: "This project has no sample+instrument image." };
  if (!sample || !(sample.len > 0)) return { error: "The selected sample is empty." };
  doc._rebuildInstRegion(); // flush pending inst edits into the image

  const key = sample.ptr + ":" + sample.len;
  const image = doc.sampleInstImage.slice();
  const recOff = (s) => SAMPLEBIN_SIZE + s * 256;

  // Ixmp: drop every patch bound to this sample. A patch that carries it as an
  // EXTRA channel carries it as its first one too (a census entry is keyed by
  // channel 0), so matching ptr:len is the whole test.
  const ixmp = [];
  const patchedInsts = [];
  let removedPatches = 0;
  let removedBlobs = 0;
  for (const e of doc.ixmp) {
    const slot = e.instId & 0x3ff;
    const patches = doc.instruments[slot].extraPatches ?? [];
    const keep = patches.filter((p) => !(p.samplePtr === sample.ptr && p.sampleLength === sample.len));
    if (keep.length === patches.length) { ixmp.push(e); continue; }
    removedPatches += patches.length - keep.length;
    patchedInsts.push({ slot, dropped: patches.length - keep.length, kept: keep.length });
    if (keep.length === 0) { removedBlobs++; continue; }
    ixmp.push({ instId: e.instId, count: keep.length, blob: writePatchesBlob(keep) });
  }

  // Base records: null the pointer, the length and the loop markers. The rest of
  // the record (envelopes, filter, pan, NNA) is left alone — the instrument is
  // still the instrument, it just has nothing to play.
  const clearedInsts = [];
  for (const s of doc.usedInstrumentSlots()) {
    const inst = doc.instruments[s];
    if (inst.isMeta) continue;
    if (inst.samplePtr !== sample.ptr || inst.sampleLength !== sample.len) continue;
    const o = recOff(s);
    image.fill(0, o, o + 6);       // 0..3 samplePtr, 4..5 sampleLength
    image.fill(0, o + 10, o + 14); // 10..11 loop start, 12..13 loop end
    image[o + 14] &= ~0x07;        // loop mode + sustain
    clearedInsts.push(s);
  }
  if (clearedInsts.length === 0 && removedPatches === 0) {
    return { error: "Nothing in this project points at that sample." };
  }

  // Only this entry leaves the census: every other one keeps its own users,
  // and nothing else was repointed.
  const oldCensus = doc.sampleList();
  const oldNameByKey = new Map(oldCensus.map((e) => [e.ptr + ":" + e.len, e.name]));
  const newCensus = oldCensus.filter((e) => e.ptr + ":" + e.len !== key);

  const pool = image.subarray(0, SAMPLEBIN_SIZE);
  // Region bytes are kept alongside the surviving census (item 175): a window
  // cut out of a long recording can be deleted without taking the recording
  // with it.
  const keepIv = mergedIntervals([
    ...newCensus.flatMap(sampleSpans),
    ...doc.sampleRegions().flatMap(regionSpans),
  ]);
  let freedSampleBytes = 0;
  const zeroRange = (from, to) => {
    for (let i = from; i < to; i++) if (pool[i] !== 0) { pool[i] = 0; freedSampleBytes++; }
  };
  for (const sp of sampleSpans(sample)) {
    let cur = sp.ptr;
    const end = sp.ptr + sp.len;
    for (const [a, b] of keepIv) {
      if (b <= cur) continue;
      if (a >= end) break;
      if (a > cur) zeroRange(cur, Math.min(a, end));
      cur = Math.max(cur, b);
      if (cur >= end) break;
    }
    if (cur < end) zeroRange(cur, end);
  }

  const snamArr = newCensus.map((e) => oldNameByKey.get(e.ptr + ":" + e.len) ?? "");
  while (snamArr.length && snamArr[snamArr.length - 1] === "") snamArr.pop();

  return {
    image,
    inam: doc.projSections.find((s) => s.fourcc === "INam")?.payload ?? null,
    snam: encodeNameTable(snamArr),
    ixmp,
    clearedInsts, patchedInsts, removedPatches, removedBlobs, freedSampleBytes,
  };
}

// ── instrument delete ──

/** Metainstruments (used slots) that carry `slot` as one of their layers — the
 *  "parents" a delete has to rewire. Returns [{slot, layers}] (layers = how many
 *  of that meta's layers reference this sub-instrument). */
export function metainstrumentParents(doc, slot) {
  const s = slot & 0x3ff;
  const parents = [];
  for (const m of doc.usedInstrumentSlots()) {
    if (m === s) continue;
    const layers = doc.instruments[m].metaLayers;
    if (!layers) continue;
    const n = layers.filter((l) => (l.instIdx & 0x3ff) === s).length;
    if (n > 0) parents.push({ slot: m, layers: n });
  }
  return parents;
}

/** Sample spans (ptr:len) whose EVERY census user is in `slots` — the bytes a
 *  delete of that whole set can free without stealing a survivor's sample. Uses
 *  the deduped census (base insts + Ixmp patches); a shared span (a user outside
 *  the set) is never listed. A stereo sample frees BOTH of its channels.
 *  Returns [{ptr, len}]. */
export function uniqueSampleSpansForSet(doc, slots) {
  const set = slots instanceof Set ? slots : new Set(slots);
  return doc.sampleList()
    .filter((e) => e.users.every((u) => set.has(u)))
    .flatMap((e) => sampleSpans(e).map((sp) => ({ ptr: sp.ptr, len: sp.len })));
}

/** Sample spans only `slot` uses (the single-slot case of the above). */
export function uniqueSampleSpans(doc, slot) {
  return uniqueSampleSpansForSet(doc, [slot & 0x3ff]);
}

/**
 * Classify a metainstrument's layer children for a cascade delete. A child still
 * layered by some OTHER used metainstrument is kept (it is in use elsewhere). The
 * rest split by addressability:
 *   * $100+ children — outside the 8-bit note-addressable range, so nothing but a
 *     meta layer can reach them; once their meta goes they are orphans and are
 *     auto-deleted (no pattern probe needed).
 *   * $01–$FF children — can still be played by pattern cells, so they are only
 *     OFFERED (with their pattern-reference count) — the caller decides.
 * Returns {autoChildren:[slot…], lowChildren:[{slot, patternRefs}…]}; both empty
 * for a non-meta.
 */
export function classifyMetaChildren(doc, metaSlot) {
  const m = metaSlot & 0x3ff;
  const inst = doc.instruments[m];
  if (!inst?.isMeta || !inst.metaLayers) return { autoChildren: [], lowChildren: [] };
  const used = doc.usedInstrumentSlots();
  const kids = [...new Set(inst.metaLayers.map((l) => l.instIdx & 0x3ff))].filter((k) => k !== m);
  const autoChildren = [];
  const lowChildren = [];
  for (const kid of kids) {
    const referencedElsewhere = used.some((o) => {
      if (o === m || o === kid) return false;
      const ml = doc.instruments[o].metaLayers;
      return ml && ml.some((l) => (l.instIdx & 0x3ff) === kid);
    });
    if (referencedElsewhere) continue; // still a layer of another meta — keep it
    if (kid >= 0x100) autoChildren.push(kid);
    else lowChildren.push({ slot: kid, patternRefs: instrumentCellRefs(doc, kid).length });
  }
  return { autoChildren, lowChildren };
}

/**
 * Plan deleting instrument `slot` (this feature). Zeroes its record, blanks its
 * INam entry, drops its Ixmp patches, rewires every SURVIVING metainstrument that
 * layered a deleted slot (that layer is repacked out; a meta reduced to zero
 * layers is removed too, since a 0-layer record decodes as neither meta nor
 * sample), and — when `freeSamples` — frees the sample bytes only the deleted
 * instruments used.
 *
 * When `slot` is a metainstrument the delete CASCADES to its now-orphaned sub-
 * instruments (classifyMetaChildren): $100+ orphans always, and — only when
 * `deleteLowChildren` — its $01–$FF children too (those can be played by
 * patterns, hence the opt-in).
 *
 * Pattern cells are the note references. The PRIMARY slot's notes are LEFT
 * pointing at the now-empty number (a "dangling instrument") unless `reassignTo`
 * ($01–$FF) moves them onto another number first (the global Change-instrument
 * op, folded into the same undo step); any deleted $01–$FF sub-instrument's notes
 * are left to dangle. $100+ slots can't be note-referenced.
 *
 * Returns {error} or a deleteInstrumentOp plan {image, inam, snam, ixmp, cells,
 * …} plus a report the confirm dialog can show. SNam is realigned to the
 * surviving census (ptr:len identity), same as planBankCleanup — a removed
 * slot's samples drop out of the census whether or not `freeSamples` also
 * zeroed their pool bytes, and every later census entry shifts position. The op
 * rebuilds the Ixmp SECTION from `ixmp` (like the renumber/cleanup ops), so the
 * delete survives a save.
 */
export function planDeleteInstrument(doc, slot, { freeSamples = false, reassignTo = null, deleteLowChildren = false } = {}) {
  if (!doc.sampleInstImage) return { error: "This project has no sample+instrument image." };
  const s = slot & 0x3ff;
  if (!doc.usedInstrumentSlots().includes(s)) return { error: "That instrument slot is empty." };
  doc._rebuildInstRegion(); // flush pending inst edits into the image

  const { autoChildren, lowChildren } = classifyMetaChildren(doc, s);
  const deleteSet = new Set([s, ...autoChildren]);
  if (deleteLowChildren) for (const c of lowChildren) deleteSet.add(c.slot);

  const recOff = (x) => SAMPLEBIN_SIZE + x * 256;
  const image = doc.sampleInstImage.slice();
  for (const x of deleteSet) image.fill(0, recOff(x), recOff(x) + 256);

  // Rewire surviving metainstruments: repack any layer that pointed at a deleted
  // slot out of the table (a meta left with zero layers is removed too). Deleted
  // metas are skipped — their whole record is already zeroed.
  const rewiredMetas = [];
  const emptiedMetas = [];
  for (const o of doc.usedInstrumentSlots()) {
    if (deleteSet.has(o)) continue;
    const oi = doc.instruments[o];
    if (!oi.metaLayers || !oi.metaLayers.some((l) => deleteSet.has(l.instIdx & 0x3ff))) continue;
    // A type-4 rack is addressed BY POSITION, so a doomed operator is MUTED in
    // place rather than repacked out — compacting the table would slide every
    // operator after it under a word of the algorithm that meant another one.
    const fm = oi.isFm;
    const kept = fm
      ? oi.metaLayers.map((l) => (deleteSet.has(l.instIdx & 0x3ff) ? { ...l, instIdx: 0 } : l))
      : oi.metaLayers.filter((l) => !deleteSet.has(l.instIdx & 0x3ff));
    // A rack whose PRINCIPAL operator is gone sounds nothing at all (§5.5.1), so
    // it is emptied like a layer table with nothing left in it.
    const dead = fm ? kept[0].instIdx === 0 : kept.length === 0;
    if (dead) {
      image.fill(0, recOff(o), recOff(o) + 256);
      emptiedMetas.push(o);
    } else {
      image.set(buildMetaRecord(kept, {
        strict: oi.metaStrict,
        percussion: (oi.metaRaw[0] & 0x02) !== 0,
        type: oi.metaType,
        program: oi.fmProgram,
      }), recOff(o));
      rewiredMetas.push(o);
    }
  }

  const removedSet = new Set([...deleteSet, ...emptiedMetas]);

  // SNam: realign to the surviving census (names keyed by ptr:len identity), same
  // as planBankCleanup. A removed slot's census entries drop out regardless of
  // `freeSamples` — that flag only controls whether the pool bytes are ALSO
  // zeroed, not whether the sample stops being counted.
  const instAt = (x) => doc.instruments[x];
  const survivors = doc.usedInstrumentSlots().filter((x) => !removedSet.has(x));
  const keep = censusForSlots(instAt, survivors);
  const oldNameByKey = new Map();
  for (const e of doc.sampleList()) oldNameByKey.set(e.ptr + ":" + e.len, e.name);
  const snamArr = keep.filter((sp) => sp.chan === 0).map((sp) => oldNameByKey.get(sp.key) ?? "");
  while (snamArr.length && snamArr[snamArr.length - 1] === "") snamArr.pop();

  // Free sample bytes only the removed instruments used.
  let freedSampleBytes = 0, freedSamples = 0;
  if (freeSamples) {
    const pool = image.subarray(0, SAMPLEBIN_SIZE);
    // A window cut out of a pool region (item 175) is the RECORDING's audio,
    // not the instrument's: deleting the instrument must not take it with them.
    const reserved = mergedIntervals(doc.sampleRegions().flatMap(regionSpans));
    for (const sp of uniqueSampleSpansForSet(doc, removedSet)) {
      // Walk the span minus whatever a region reserves — with no regions (the
      // usual case) that is the span itself and nothing is tested per byte.
      for (const part of rangeMinusIntervals(sp.ptr, sp.len, reserved)) {
        for (let i = part.ptr; i < part.ptr + part.len; i++) {
          if (pool[i] !== 0) { pool[i] = 0; freedSampleBytes++; }
        }
      }
      freedSamples++;
    }
  }

  // INam: blank every removed slot.
  const inamArr = doc._nameTable("INam").slice();
  for (const x of removedSet) if (x < inamArr.length) inamArr[x] = "";
  while (inamArr.length && inamArr[inamArr.length - 1] === "") inamArr.pop();

  // Ixmp: drop every removed slot's patch entries.
  const ixmp = doc.ixmp.filter((e) => !removedSet.has(e.instId & 0x3ff));

  // Note references: reassign only the PRIMARY slot (a deleted low sub-instrument
  // dangles). $100+ can't be note-referenced.
  const refs = s <= 0xff ? instrumentCellRefs(doc, s) : [];
  const doReassign = reassignTo !== null && s <= 0xff;
  const cells = doReassign ? refs.map((r) => ({ ...r, inst: reassignTo & 0xff })) : [];

  return {
    image, inam: encodeNameTable(inamArr), snam: encodeNameTable(snamArr), ixmp, cells, from: s,
    freedSamples, freedSampleBytes, rewiredMetas, emptiedMetas,
    autoChildren, deletedLowChildren: deleteLowChildren ? lowChildren.map((c) => c.slot) : [],
    danglingRefs: doReassign ? 0 : refs.length,
  };
}
