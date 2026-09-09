// Invertible document operations. Every mutation is an op object
// {type, ..., apply(doc) → inverseOp, dirty(doc) → [tags]}; undo.js stacks the
// inverses, sync.js consumes the dirty tags. Gesture coalescing is keyed by
// op.coalesceKey (same key + same gestureId collapse in the undo stack).
//
// Dirty tags: {kind:"pattern", song, pat} | {kind:"cue", song, cue}
//           | {kind:"scalar", song, key} | {kind:"inst", slot} | {kind:"bank"}
//           | {kind:"ixmp", slot} | {kind:"section", fourcc} | {kind:"resync", song}
//           | {kind:"mastering", song}

import { applyPlan, captureBankState, restoreBankState, buildIxmpSection } from "./bankmerge.js";
import {
  parsePatchesBlob, writePatchesBlob, makeInstPatch, baseStereoPatchIndex, BASE_TO_PATCH_FIELD,
} from "../engine/inst.js";
import { TaudPlayData } from "../engine/state.js";
import { CUE_EMPTY, MAX_VOICES, NUM_CUES, NUM_CUES_64 } from "../format/taud-const.js";

/**
 * Run several ops as ONE undo step — the combinator, not an op of its own.
 *
 * Each sub-op's `dirty` is collected DURING the pass, immediately after that
 * op's own apply, because some of them read the post-apply document (a pattern
 * append reports `length - 1`); collecting them all at the end would ask the
 * later ops' questions of an already-further-changed doc. The inverse is the
 * sub-inverses in reverse order, which is the only order that unwinds an op
 * whose target was created by an earlier one.
 *
 * `coalesceKey` is null and the gesture id defaults to null, so a composite
 * never merges into the step before it — the whole point is that it IS one step.
 */
export function compositeOp(ops, gestureId = null) {
  return {
    type: "composite",
    ops, gestureId,
    coalesceKey: null,
    apply(doc) {
      const inverses = [];
      const tags = [];
      for (const op of ops) {
        inverses.push(op.apply(doc));
        tags.push(...op.dirty(doc));
      }
      this._tags = tags;
      return compositeOp(inverses.reverse(), gestureId);
    },
    dirty() { return this._tags ?? []; },
  };
}

export function setCellOp(song, pat, row, fields, gestureId = null) {
  return {
    type: "setCell",
    song, pat, row, fields, gestureId,
    coalesceKey: `cell:${song}:${pat}:${row}`,
    apply(doc) {
      doc.ensurePattern(song, pat); // materialise an arbitrary-number pattern (item 48)
      const cell = doc.songs[song].patterns[pat][row];
      const prev = {};
      for (const k of Object.keys(fields)) {
        prev[k] = cell[k];
        cell[k] = fields[k];
      }
      doc.dirty = true;
      return setCellOp(song, pat, row, prev, gestureId);
    },
    dirty: () => [{ kind: "pattern", song, pat }],
  };
}

/** The same decoded fields written to MANY cells in one undo step — what a
 *  dialog that produces one answer (the panner's Place / Target / Slide /
 *  Column) does to a block selection. `cells` is [{pat, row}]; the inverse
 *  restores each cell's previous values of exactly the keys `fields` names. */
export function setCellsFieldsOp(song, cells, fields, gestureId = null) {
  return {
    type: "setCellsFields",
    song, cells, fields, gestureId,
    coalesceKey: `cellsfields:${song}:${Object.keys(fields).join(",")}`,
    apply(doc) {
      const inverse = new Array(cells.length);
      for (let i = 0; i < cells.length; i++) {
        const { pat, row } = cells[i];
        doc.ensurePattern(song, pat); // materialise an arbitrary-number pattern (item 48)
        const cell = doc.songs[song].patterns[pat][row];
        const prev = {};
        for (const k of Object.keys(fields)) {
          prev[k] = cell[k];
          cell[k] = fields[k];
        }
        inverse[i] = { pat, row, prev };
      }
      doc.dirty = true;
      return restoreCellsFieldsOp(song, inverse, gestureId);
    },
    dirty() {
      const pats = new Set(cells.map((c) => c.pat));
      return [...pats].map((pat) => ({ kind: "pattern", song, pat }));
    },
  };
}

/** Inverse of setCellsFieldsOp: put each cell's captured fields back. */
function restoreCellsFieldsOp(song, saved, gestureId = null) {
  return {
    type: "restoreCellsFields",
    song, saved, gestureId,
    coalesceKey: `cellsfields:${song}:restore`,
    apply(doc) {
      const forward = saved.map(({ pat, row, prev }) => {
        const cell = doc.songs[song].patterns[pat][row];
        const cur = {};
        for (const k of Object.keys(prev)) { cur[k] = cell[k]; cell[k] = prev[k]; }
        return { pat, row, prev: cur };
      });
      doc.dirty = true;
      return restoreCellsFieldsOp(song, forward, gestureId);
    },
    dirty() {
      const pats = new Set(saved.map((c) => c.pat));
      return [...pats].map((pat) => ({ kind: "pattern", song, pat }));
    },
  };
}

export function setCueWordOp(song, cue, ch, value, gestureId = null) {
  return {
    type: "setCueWord",
    song, cue, ch, value, gestureId,
    coalesceKey: `cue:${song}:${cue}:${ch}`,
    apply(doc) {
      const words = doc.songs[song].cues[cue];
      const prev = words[ch];
      words[ch] = value & 0xffff;
      doc.dirty = true;
      return setCueWordOp(song, cue, ch, prev, gestureId);
    },
    dirty: () => [{ kind: "cue", song, cue }],
  };
}

/** Replace a whole cue's words (used by the CueCmd popup / instruction edits). */
export function setCueOp(song, cue, words, gestureId = null) {
  return {
    type: "setCue",
    song, cue, words, gestureId,
    coalesceKey: `cueAll:${song}:${cue}`,
    apply(doc) {
      const target = doc.songs[song].cues[cue];
      const prev = Uint16Array.from(target);
      target.set(words);
      doc.dirty = true;
      return setCueOp(song, cue, prev, gestureId);
    },
    dirty: () => [{ kind: "cue", song, cue }],
  };
}

/** Highest cue index the doc's channel mode can address (format-limited). */
function cueLimit(doc) { return doc.is64Channel ? NUM_CUES_64 : NUM_CUES; }

/**
 * Bulk cue-word writer that GROWS the cue list (append-only at the tail) to
 * cover any cue index the writes reach — this is what lets the Cues view edit
 * or paste past the last stored cue (past a HALT, or a brand-new song's single
 * cue 0). `writes` is [{cue, ch, value}] with `value` a full 16-bit cue word
 * (pattern index | command sign bit). The inverse restores each cell's previous
 * word AND truncates any cues this op appended, so growth undoes cleanly.
 * Feature reference: taut.js editCuePtn + ordersMaxRow (one blank row past the
 * last active cue). Used by every Cues-view edit: pattern entry, delete, block
 * paste/cut/delete, and the command popup.
 */
export function setCuesOp(song, writes, gestureId = null) {
  return {
    type: "setCues",
    song, writes, gestureId,
    coalesceKey: `cues:${song}`,
    apply(doc) {
      const s = doc.songs[song];
      const oldLen = s.cues.length;
      const limit = cueLimit(doc);
      let maxCue = -1;
      for (const w of writes) if (w.cue > maxCue) maxCue = w.cue;
      const target = Math.min(maxCue + 1, limit);
      while (s.cues.length < target) {
        s.cues.push(new Uint16Array(MAX_VOICES).fill(CUE_EMPTY));
      }
      const inverse = [];
      for (const w of writes) {
        if (w.cue >= s.cues.length) continue; // past the format limit — dropped
        const words = s.cues[w.cue];
        inverse.push({ cue: w.cue, ch: w.ch, value: words[w.ch] });
        words[w.ch] = w.value & 0xffff;
      }
      doc.dirty = true;
      return restoreCuesOp(song, inverse, oldLen, gestureId);
    },
    // Post-apply: one tag per WRITTEN cue (auto-created gap-filler cues stay
    // empty and are never uploaded — the engine's cueSheet is blanked past the
    // song's length on load, so a fresh gap can't hold stale data). These same
    // tags drive the eager cue upload on undo too — a written index truncated
    // away then reads an all-empty image from cueBytes(), blanking the copy.
    dirty(doc) {
      const s = doc.songs[song];
      const cues = new Set();
      for (const w of writes) if (w.cue < s.cues.length) cues.add(w.cue);
      return [...cues].map((cue) => ({ kind: "cue", song, cue }));
    },
  };
}

/** Inverse of setCuesOp: restore previous words, then pop any appended cues. */
function restoreCuesOp(song, prevWrites, truncateTo, gestureId = null) {
  return {
    type: "restoreCues",
    song, prevWrites, truncateTo, gestureId,
    coalesceKey: `cues:${song}`,
    apply(doc) {
      const s = doc.songs[song];
      // Capture the current (forward-applied) values so redo reproduces the
      // original writes — including the ones in the cues we are about to pop.
      const forward = prevWrites.map((w) => ({
        cue: w.cue, ch: w.ch, value: s.cues[w.cue][w.ch],
      }));
      for (const w of prevWrites) s.cues[w.cue][w.ch] = w.value & 0xffff;
      while (s.cues.length > truncateTo) s.cues.pop();
      doc.dirty = true;
      return setCuesOp(song, forward, gestureId);
    },
    dirty() {
      const cues = new Set(prevWrites.map((w) => w.cue));
      return [...cues].map((cue) => ({ kind: "cue", song, cue }));
    },
  };
}

// ── channel insert/remove (Timeline channel context menu) ──
// A cue word is `pattern (15 bits) | command bit (bit 15)`, and the command
// bits of channels 0-31 together SPELL the cue's two instruction words
// (taud-parse cueInstructionWords). So shifting channels moves the PATTERN
// half only — bit 15 belongs to the channel POSITION, not to its contents, and
// carrying it along would rewrite the cue's LEN/HALT/jump instructions.
const PAT_MASK = 0x7fff;
const CMD_BIT = 0x8000;

/** True when channel `ch` plays anything anywhere in the song. Insert drops the
 *  LAST channel (the channel count is a fixed 32 or 64), so the caller uses this
 *  to warn before the drop. */
export function channelHasContent(songObj, ch) {
  return songObj.cues.some((w) => (w[ch] & PAT_MASK) !== CUE_EMPTY);
}

// A channel's MUTE rides along with the content, because that is what the mute
// is about — you silenced a part, not a position on screen. `mutes` is the live
// boolean[] (mutated in place; null skips the whole concern, which is what the
// Node tests and any non-UI caller do), and the mute pushed off the end travels
// in the inverse exactly like the patterns do, so undo puts it back. The
// {kind:"voices"} dirty tag tells the app to re-push the array to the engine —
// it is direction-free, which matters because UndoStack replays the FORWARD
// op's tags when it undoes.

/**
 * Insert an empty channel at index `at`: every channel from `at` on shifts one
 * to the right, and the last one falls off the end. `restore` (undo only) is
 * `{pats, mute}` — the per-cue pattern number and the mute to put back at `at`
 * instead of an empty, unmuted slot.
 * Dirty: one cue tag per cue the shift actually changed (+ voices).
 */
export function insertChannelOp(song, at, restore = null, mutes = null, gestureId = null) {
  return {
    type: "insertChannel",
    song, at, restore, mutes, gestureId,
    apply(doc) {
      const chans = doc.channelCount;
      const s = doc.songs[song];
      const dropped = new Array(s.cues.length);
      const touched = [];
      for (let c = 0; c < s.cues.length; c++) {
        const w = s.cues[c];
        dropped[c] = w[chans - 1] & PAT_MASK;
        let changed = false;
        for (let ch = chans - 1; ch > at; ch--) {
          const v = (w[ch] & CMD_BIT) | (w[ch - 1] & PAT_MASK);
          if (v !== w[ch]) { w[ch] = v; changed = true; }
        }
        const fill = restore?.pats ? restore.pats[c] & PAT_MASK : CUE_EMPTY;
        const v0 = (w[at] & CMD_BIT) | fill;
        if (v0 !== w[at]) { w[at] = v0; changed = true; }
        if (changed) touched.push(c);
      }
      let droppedMute = null;
      if (mutes) {
        droppedMute = mutes[chans - 1] === true;
        for (let ch = chans - 1; ch > at; ch--) mutes[ch] = mutes[ch - 1] === true;
        mutes[at] = restore?.mute === true;
      }
      this._touched = touched;
      doc.dirty = true;
      return removeChannelOp(song, at, { pats: dropped, mute: droppedMute }, mutes, gestureId);
    },
    dirty() {
      const tags = (this._touched ?? []).map((cue) => ({ kind: "cue", song, cue }));
      if (mutes) tags.push({ kind: "voices" });
      return tags;
    },
  };
}

/** Inverse of insertChannelOp: shift `at`+1… back left and put `restoreLast`
 *  (the patterns and mute the insert pushed off the end) back on the last
 *  channel. */
export function removeChannelOp(song, at, restoreLast = null, mutes = null, gestureId = null) {
  return {
    type: "removeChannel",
    song, at, restoreLast, mutes, gestureId,
    apply(doc) {
      const chans = doc.channelCount;
      const s = doc.songs[song];
      const removed = new Array(s.cues.length);
      const touched = [];
      for (let c = 0; c < s.cues.length; c++) {
        const w = s.cues[c];
        removed[c] = w[at] & PAT_MASK;
        let changed = false;
        for (let ch = at; ch < chans - 1; ch++) {
          const v = (w[ch] & CMD_BIT) | (w[ch + 1] & PAT_MASK);
          if (v !== w[ch]) { w[ch] = v; changed = true; }
        }
        const fill = restoreLast?.pats ? restoreLast.pats[c] & PAT_MASK : CUE_EMPTY;
        const vLast = (w[chans - 1] & CMD_BIT) | fill;
        if (vLast !== w[chans - 1]) { w[chans - 1] = vLast; changed = true; }
        if (changed) touched.push(c);
      }
      let removedMute = null;
      if (mutes) {
        removedMute = mutes[at] === true;
        for (let ch = at; ch < chans - 1; ch++) mutes[ch] = mutes[ch + 1] === true;
        mutes[chans - 1] = restoreLast?.mute === true;
      }
      this._touched = touched;
      doc.dirty = true;
      return insertChannelOp(song, at, { pats: removed, mute: removedMute }, mutes, gestureId);
    },
    dirty() {
      const tags = (this._touched ?? []).map((cue) => ({ kind: "cue", song, cue }));
      if (mutes) tags.push({ kind: "voices" });
      return tags;
    },
  };
}

/** Instrument-scope field (TaudInst property, e.g. instGlobalVolume, defaultPan,
 *  instrumentFlag, volumeFadeoutLow…). Dirty {kind:"inst", slot} → uploadInstrument. */
export function setInstFieldOp(slot, key, value, gestureId = null) {
  return {
    type: "setInstField",
    slot, key, value, gestureId,
    coalesceKey: `inst:${slot}:${key}`,
    apply(doc) {
      const inst = doc.instruments[slot & 0x3ff];
      const prev = inst[key];
      inst[key] = value;
      doc.markInstUsed(slot);
      doc.dirty = true;
      return setInstFieldOp(slot, key, prev, gestureId);
    },
    dirty: () => [{ kind: "inst", slot }],
  };
}

/** Write one or more raw record bytes atomically (for fields split across
 *  bytes that are not single decoded properties — e.g. the SoundFont filter
 *  cutoff/resonance whose low byte lives in the reserved region). `pairs` is
 *  [[offset, byte], …]; the inverse restores all touched bytes in one step, so
 *  a slider drag coalesces cleanly. */
export function setInstBytesOp(slot, pairs, gestureId = null) {
  return {
    type: "setInstBytes",
    slot, pairs, gestureId,
    coalesceKey: `instbytes:${slot}:${pairs.map((p) => p[0]).join(",")}`,
    apply(doc) {
      const inst = doc.instruments[slot & 0x3ff];
      const prev = pairs.map(([o]) => [o, inst.getByteNormal(o)]);
      for (const [o, b] of pairs) inst.setByte(o, b & 0xff);
      doc.markInstUsed(slot);
      doc.dirty = true;
      return setInstBytesOp(slot, prev, gestureId);
    },
    dirty: () => [{ kind: "inst", slot }],
  };
}

/** Write raw metaRaw bytes of a Metainstrument (its layer table), re-deriving
 *  metaLayers via loadRecord. setInstBytesOp/setByte can't be used for metas —
 *  their setByte writes the DECODED sample fields, which a meta ignores (getByte
 *  serves metaRaw verbatim). `pairs` is [[offset, byte], …]; inverse restores. */
export function setMetaBytesOp(slot, pairs, gestureId = null) {
  return {
    type: "setMetaBytes",
    slot, pairs, gestureId,
    coalesceKey: `metabytes:${slot}:${pairs.map((p) => p[0]).join(",")}`,
    apply(doc) {
      const inst = doc.instruments[slot & 0x3ff];
      const prev = pairs.map(([o]) => [o, inst.metaRaw[o]]);
      const raw = Uint8Array.from(inst.metaRaw);
      for (const [o, b] of pairs) raw[o] = b & 0xff;
      inst.loadRecord(raw); // re-derive metaLayers (+ a fresh metaRaw copy)
      doc.markInstUsed(slot);
      doc.dirty = true;
      return setMetaBytesOp(slot, prev, gestureId);
    },
    dirty: () => [{ kind: "inst", slot }],
  };
}

/**
 * Replace a Metainstrument's WHOLE 256-byte record (doc/metaedit.js builds it).
 * setMetaBytesOp can only patch bytes in place, which is fine for mix/detune but
 * not for add / duplicate / remove / reorder — those change the layer COUNT in
 * byte 1 and shift every 10-byte entry after the edit.
 *
 * The inverse captures instRecordBytes() rather than metaRaw, so it still works
 * on a slot that stopped being a meta (a 0-layer record decodes as neither meta
 * nor sample — metaedit.removeLayer refuses to create one, and this keeps the op
 * honest if some other caller ever does).
 */
export function setMetaRecordOp(slot, record, gestureId = null) {
  return {
    type: "setMetaRecord",
    slot, record, gestureId,
    coalesceKey: `metarecord:${slot}`,
    apply(doc) {
      const s = slot & 0x3ff;
      const prev = doc.instRecordBytes(s);
      doc.instruments[s].loadRecord(record);
      doc.markInstUsed(s);
      doc.dirty = true;
      return setMetaRecordOp(slot, prev, gestureId);
    },
    dirty: () => [{ kind: "inst", slot }],
  };
}

/** One envelope node on an instrument envelope array (volEnvelopes /
 *  panEnvelopes / pfEnvelopes / pf2Envelopes): sets value and/or offset
 *  (ThreeFiveMiniUfloat LUT index). */
export function setEnvPointOp(slot, envKey, idx, point, gestureId = null) {
  return {
    type: "setEnvPoint",
    slot, envKey, idx, point, gestureId,
    coalesceKey: `env:${slot}:${envKey}:${idx}`,
    apply(doc) {
      const node = doc.instruments[slot & 0x3ff][envKey][idx];
      const prev = { value: node.value, offset: node.offset };
      if (point.value !== undefined) node.value = point.value;
      if (point.offset !== undefined) node.offset = point.offset;
      doc.markInstUsed(slot);
      doc.dirty = true;
      return setEnvPointOp(slot, envKey, idx, prev, gestureId);
    },
    dirty: () => [{ kind: "inst", slot }],
  };
}

/** Envelope-node DRAG: one op for the 2D gesture — value of node idx plus the
 *  duration of the preceding segment (env[idx-1].offset, minifloat index).
 *  Single coalesce key so a drag is one undo step. */
export function setEnvDragOp(slot, envKey, idx, change, gestureId = null) {
  return {
    type: "setEnvDrag",
    slot, envKey, idx, change, gestureId,
    coalesceKey: `envdrag:${slot}:${envKey}:${idx}`,
    apply(doc) {
      const env = doc.instruments[slot & 0x3ff][envKey];
      const prev = {};
      if (change.value !== undefined) {
        prev.value = env[idx].value;
        env[idx].value = change.value;
      }
      if (change.prevOffset !== undefined && idx > 0) {
        prev.prevOffset = env[idx - 1].offset;
        env[idx - 1].offset = change.prevOffset;
      }
      doc.markInstUsed(slot);
      doc.dirty = true;
      return setEnvDragOp(slot, envKey, idx, prev, gestureId);
    },
    dirty: () => [{ kind: "inst", slot }],
  };
}

/** Replace an entire 25-node envelope array (add/remove node structural edit).
 *  newNodes is [{value, offset}]×25; inverse restores the previous array. */
export function setEnvArrayOp(slot, envKey, newNodes, gestureId = null) {
  return {
    type: "setEnvArray",
    slot, envKey, newNodes, gestureId,
    coalesceKey: `envarray:${slot}:${envKey}`,
    apply(doc) {
      const env = doc.instruments[slot & 0x3ff][envKey];
      const prev = env.map((n) => ({ value: n.value, offset: n.offset }));
      for (let i = 0; i < env.length; i++) {
        env[i].value = newNodes[i].value;
        env[i].offset = newNodes[i].offset;
      }
      doc.markInstUsed(slot);
      doc.dirty = true;
      return setEnvArrayOp(slot, envKey, prev, gestureId);
    },
    dirty: () => [{ kind: "inst", slot }],
  };
}

/** Replace a whole pattern's 512-byte image (lengthen/shorten-style edits). */
export function setPatternBytesOp(song, pat, bytes, gestureId = null) {
  return {
    type: "setPatternBytes",
    song, pat, bytes, gestureId,
    coalesceKey: `patbytes:${song}:${pat}`,
    apply(doc) {
      doc.ensurePattern(song, pat); // materialise an arbitrary-number pattern (item 48)
      const rows = doc.songs[song].patterns[pat];
      // Cell width follows the file's format version (§5.5).
      const wide = doc.wideCells === true;
      const n = wide ? 16 : 8;
      const prev = new Uint8Array(64 * n);
      for (let r = 0; r < 64; r++) {
        for (let b = 0; b < n; b++) {
          prev[r * n + b] = wide ? rows[r].getByteWide(b) : rows[r].getByte(b);
          if (wide) rows[r].setByteWide(b, bytes[r * n + b]);
          else rows[r].setByte(b, bytes[r * n + b]);
        }
      }
      doc.dirty = true;
      return setPatternBytesOp(song, pat, prev, gestureId);
    },
    dirty: () => [{ kind: "pattern", song, pat }],
  };
}

/** Write raw 8-byte images to a set of cells across (possibly several)
 *  patterns in one undo step — block paste / cut / delete-selection. `writes`
 *  is [{pat, row, bytes: Uint8Array(8)}]; the inverse restores each cell's
 *  previous bytes. Dirty tags cover every touched pattern. */
export function setCellsBytesOp(song, writes, gestureId = null) {
  return {
    type: "setCellsBytes",
    song, writes, gestureId,
    coalesceKey: `cellsbytes:${song}`,
    apply(doc) {
      const s = doc.songs[song];
      const inverse = new Array(writes.length);
      for (let i = 0; i < writes.length; i++) {
        const { pat, row, bytes } = writes[i];
        doc.ensurePattern(song, pat); // materialise an arbitrary-number pattern (item 48)
        const cell = s.patterns[pat][row];
        const wide = doc.wideCells === true;
        const n = wide ? 16 : 8;
        const prev = new Uint8Array(n);
        for (let b = 0; b < n; b++) {
          prev[b] = wide ? cell.getByteWide(b) : cell.getByte(b);
          if (wide) cell.setByteWide(b, bytes[b]);
          else cell.setByte(b, bytes[b]);
        }
        inverse[i] = { pat, row, bytes: prev };
      }
      doc.dirty = true;
      return setCellsBytesOp(song, inverse, gestureId);
    },
    dirty() {
      const pats = new Set(writes.map((w) => w.pat));
      return [...pats].map((pat) => ({ kind: "pattern", song, pat }));
    },
  };
}

/** Append a new pattern (512-byte image) at the end of the song's list —
 *  the Pattern view's Duplicate. Inverse pops it again; that is safe in the
 *  LIFO undo order because any later op that references the new index (a cue
 *  edit, say) is necessarily undone first. */
export function appendPatternOp(song, bytes, gestureId = null) {
  return {
    type: "appendPattern",
    song, bytes, gestureId,
    coalesceKey: `addpat:${song}`,
    apply(doc) {
      doc.songs[song].patterns.push(decodePatternImage(doc, bytes));
      doc.dirty = true;
      return removeLastPatternOp(song, gestureId);
    },
    // called post-apply: length-1 IS the new pattern's index
    dirty: (doc) => [{ kind: "pattern", song, pat: doc.songs[song].patterns.length - 1 }],
  };
}

function removeLastPatternOp(song, gestureId = null) {
  return {
    type: "removeLastPattern",
    song, gestureId,
    coalesceKey: `addpat:${song}`,
    apply(doc) {
      const removed = doc.songs[song].patterns.pop();
      // The image has to be captured in the document's OWN cell layout (§5.5),
      // or redo would feed appendPatternOp half an image and read past its end.
      const wide = doc.wideCells === true;
      const n = wide ? 16 : 8;
      const bytes = new Uint8Array(64 * n);
      for (let r = 0; r < 64; r++) {
        for (let b = 0; b < n; b++) {
          bytes[r * n + b] = wide ? removed[r].getByteWide(b) : removed[r].getByte(b);
        }
      }
      doc.dirty = true;
      return appendPatternOp(song, bytes, gestureId);
    },
    // post-apply: the removed index (patternBytes serves an empty image for
    // it, so the sync flush blanks the worklet's copy)
    dirty: (doc) => [{ kind: "pattern", song, pat: doc.songs[song].patterns.length }],
  };
}

/** Decode a whole-pattern image into 64 cells, in the doc's own layout (§5.5). */
function decodePatternImage(doc, bytes) {
  const wide = doc.wideCells === true;
  const n = wide ? 16 : 8;
  const rows = new Array(64);
  for (let r = 0; r < 64; r++) {
    const cell = new TaudPlayData();
    for (let b = 0; b < n; b++) {
      if (wide) cell.setByteWide(b, bytes[r * n + b]);
      else cell.setByte(b, bytes[r * n + b]);
    }
    rows[r] = cell;
  }
  return rows;
}

/**
 * Materialise pattern `pat` — any number, not just the next one — with a whole
 * 64-cell image. This is the grid's Duplicate: it hands a cue slot its own copy
 * of a shared pattern, and the copy's number comes from freePatternNumbers(),
 * which with item 48's null gaps is generally NOT `patterns.length`.
 *
 * Create/destroy, not overwrite, which is what sets it apart from
 * setPatternBytesOp: the inverse takes the pattern back OUT of the array and
 * pops the null padding this added, so undoing a duplicate leaves the document
 * byte-identical instead of leaving an empty pattern behind for the serialiser
 * to write out.
 */
export function createPatternOp(song, pat, bytes, gestureId = null) {
  return {
    type: "createPattern",
    song, pat, bytes, gestureId,
    coalesceKey: `mkpat:${song}:${pat}`,
    apply(doc) {
      const pats = doc.songs[song].patterns;
      const oldLen = pats.length;
      const prev = pats[pat] ?? null;
      for (let i = pats.length; i < pat; i++) pats[i] = null;
      pats[pat] = decodePatternImage(doc, bytes);
      doc.dirty = true;
      return dropPatternOp(song, pat, prev, oldLen, gestureId);
    },
    dirty: () => [{ kind: "pattern", song, pat }],
  };
}

/** Inverse of createPatternOp: put back whatever index `pat` held (a pattern,
 *  or the null gap it was), then shrink the array to the length it had. */
function dropPatternOp(song, pat, prev, oldLen, gestureId = null) {
  return {
    type: "dropPattern",
    song, pat, oldLen, gestureId,
    coalesceKey: `mkpat:${song}:${pat}`,
    apply(doc) {
      const pats = doc.songs[song].patterns;
      const bytes = doc.patternBytes(song, pat); // capture for redo
      pats[pat] = prev;
      while (pats.length > oldLen) pats.pop();
      doc.dirty = true;
      return createPatternOp(song, pat, bytes, gestureId);
    },
    // post-apply: patternBytes now serves the empty image for `pat`, so the
    // sync flush blanks the worklet's copy of it
    dirty: () => [{ kind: "pattern", song, pat }],
  };
}

/** Bulk note edit driven by a mutator: `fn(songObj)` changes cell notes and
 *  returns [{pat, row, prev}] (the retuneAllPatterns contract). Transpose
 *  uses this; the inverse is a plain note restore. */
export function bulkNotesOp(song, fn, gestureId = null) {
  return {
    type: "bulkNotes",
    song, gestureId,
    coalesceKey: `bulknotes:${song}`,
    apply(doc) {
      this._changes = fn(doc.songs[song]);
      doc.dirty = true;
      return restoreNotesOp(song, this._changes, gestureId);
    },
    dirty(doc) {
      const pats = new Set((this._changes ?? []).map((c) => c.pat));
      return [...pats].map((pat) => ({ kind: "pattern", song, pat }));
    },
  };
}

/** Bulk note restore (the inverse of a retune): sets each {pat,row} note back. */
export function restoreNotesOp(song, changes, gestureId = null) {
  return {
    type: "restoreNotes",
    song, changes, gestureId,
    coalesceKey: `retune:${song}`,
    apply(doc) {
      const s = doc.songs[song];
      const inverse = [];
      for (const c of changes) {
        const cell = s.patterns[c.pat][c.row];
        inverse.push({ pat: c.pat, row: c.row, prev: cell.note });
        cell.note = c.prev;
      }
      doc.dirty = true;
      return restoreNotesOp(song, inverse, gestureId);
    },
    dirty(doc) {
      const pats = new Set(changes.map((c) => c.pat));
      return [...pats].map((pat) => ({ kind: "pattern", song, pat }));
    },
  };
}

/** Retune every pattern note to a new pitch table (nearest-pitch snap). */
export function retuneOp(song, newPreset, percSlots, retuneFn, gestureId = null) {
  return {
    type: "retune",
    song, gestureId,
    coalesceKey: `retune:${song}`,
    apply(doc) {
      const changes = retuneFn(doc.songs[song], newPreset, percSlots);
      this._changes = changes;
      doc.dirty = true;
      return restoreNotesOp(song, changes, gestureId);
    },
    dirty(doc) {
      const pats = new Set((this._changes ?? []).map((c) => c.pat));
      return [...pats].map((pat) => ({ kind: "pattern", song, pat }));
    },
  };
}

/** Import instruments from another bank (bankmerge.planImport plan). The
 *  inverse is a full snapshot swap of everything the plan touches (pool
 *  spans, inst records, ixmp list, INam/SNam/Ixmp sections) — capture is
 *  cheap because only the touched spans/slots are stored. Dirty {kind:"bank"}
 *  → DocSync re-uploads the whole image + patch blobs. */
export function importBankOp(plan, gestureId = null) {
  return {
    type: "importBank",
    plan, gestureId,
    coalesceKey: "importBank",
    apply(doc) {
      const prev = captureBankState(doc, plan);
      applyPlan(doc, plan);
      return restoreBankSnapshotOp(plan, prev, gestureId);
    },
    dirty: () => [{ kind: "bank" }],
  };
}

function restoreBankSnapshotOp(plan, state, gestureId) {
  return {
    type: "restoreBankSnapshot",
    plan, state, gestureId,
    coalesceKey: "importBank",
    apply(doc) {
      const prev = captureBankState(doc, plan);
      restoreBankState(doc, state);
      return restoreBankSnapshotOp(plan, prev, gestureId);
    },
    dirty: () => [{ kind: "bank" }],
  };
}

/** Overwrite a sample-pool span (sample editor DSP ops). The inverse restores
 *  the previous bytes; dirty {kind:"bank"} re-uploads the image, so playback
 *  hears the edit immediately. */
export function setSampleBytesOp(ptr, bytes, gestureId = null) {
  return {
    type: "setSampleBytes",
    ptr, bytes, gestureId,
    coalesceKey: `smpbytes:${ptr}:${bytes.length}`,
    apply(doc) {
      const prev = Uint8Array.from(doc.sampleBin.subarray(ptr, ptr + bytes.length));
      doc.sampleBin.set(bytes, ptr);
      doc.dirty = true;
      return setSampleBytesOp(ptr, prev, gestureId);
    },
    dirty: () => [{ kind: "bank" }],
  };
}

/** Pool bytes across SEVERAL spans in one undo step — a stereo sample (item 90)
 *  is two spans that must always move together, so every DSP edit on one is an
 *  edit on the other. `writes` = [{ptr, bytes}]. */
export function multiSampleBytesOp(writes, gestureId = null) {
  return {
    type: "multiSampleBytes",
    writes, gestureId,
    coalesceKey: `msmpbytes:${writes.map((w) => `${w.ptr}:${w.bytes.length}`).join(",")}`,
    apply(doc) {
      const inverse = writes.map(({ ptr, bytes }) => {
        const prev = Uint8Array.from(doc.sampleBin.subarray(ptr, ptr + bytes.length));
        doc.sampleBin.set(bytes, ptr);
        return { ptr, bytes: prev };
      });
      doc.dirty = true;
      return multiSampleBytesOp(inverse, gestureId);
    },
    dirty: () => [{ kind: "bank" }],
  };
}

/** Raw record bytes across SEVERAL instruments in one undo step — the sample
 *  editor writes shared loop/play fields to every base-instrument user of a
 *  sample at once. edits = [{slot, pairs: [[offset, byte], …]}]. */
export function multiInstBytesOp(edits, gestureId = null) {
  return {
    type: "multiInstBytes",
    edits, gestureId,
    coalesceKey: `minst:${edits.map((e) => e.slot).join(",")}:${edits[0]?.pairs.map((p) => p[0]).join(",") ?? ""}`,
    apply(doc) {
      const inverse = edits.map(({ slot, pairs }) => {
        const inst = doc.instruments[slot & 0x3ff];
        const prev = pairs.map(([o]) => [o, inst.getByteNormal(o)]);
        for (const [o, b] of pairs) inst.setByte(o, b & 0xff);
        doc.markInstUsed(slot);
        return { slot, pairs: prev };
      });
      doc.dirty = true;
      return multiInstBytesOp(inverse, gestureId);
    },
    dirty: () => edits.map(({ slot }) => ({ kind: "inst", slot })),
  };
}

/** Replace a Project-Data section payload (name tables: SNam/INam/PNam) as one
 *  invertible step. `payload` null removes the section; the inverse restores
 *  the exact previous payload (or removes it if there was none). Dirty
 *  {kind:"section"} has no device effect (names are cosmetic) — DocSync
 *  ignores it, but the edit/undo/dirty flow still fires. */
export function setSectionOp(fourcc, payload, gestureId = null) {
  return {
    type: "setSection",
    fourcc, payload, gestureId,
    coalesceKey: `section:${fourcc}`,
    apply(doc) {
      const i = doc.projSections.findIndex((s) => s.fourcc === fourcc);
      const prev = i >= 0 ? doc.projSections[i].payload : null;
      doc.setSection(fourcc, payload);
      doc.dirty = true;
      return setSectionOp(fourcc, prev, gestureId);
    },
    dirty: () => [{ kind: "section", fourcc }],
  };
}

/** Replace one of the four project strings (§9.2 — PNam / PCom / PCpr / PMsg)
 *  as one invertible step. Identical to setSectionOp apart from keeping the
 *  cached doc.meta.projectName in step with the PNam section, which undo and
 *  redo must both see: the topbar and the Project view read the cache, not the
 *  payload. `payload` null removes the section. */
export function setProjectStringOp(fourcc, payload, gestureId = null) {
  return {
    type: "setProjectString",
    fourcc, payload, gestureId,
    coalesceKey: `section:${fourcc}`,
    apply(doc) {
      const i = doc.projSections.findIndex((s) => s.fourcc === fourcc);
      const prev = i >= 0 ? doc.projSections[i].payload : null;
      doc.setSection(fourcc, payload);
      if (fourcc === "PNam") doc.meta.projectName = doc.projectString("PNam");
      doc.dirty = true;
      return setProjectStringOp(fourcc, prev, gestureId);
    },
    dirty: () => [{ kind: "section", fourcc }],
  };
}

/**
 * Replace one song's mastering chain (item 178, §9.12) as one invertible step.
 *
 * It goes through the SECTION rather than through a per-song field because that
 * is where the chain lives: `sMst` holds every song's, so an edit rebuilds the
 * whole payload and the inverse restores the exact previous bytes (or removes
 * the section, which is what resetting the last non-neutral chain does).
 *
 * `coalesceKey` is per song AND per control, so dragging one knob is one undo
 * step while moving two different ones is two — the same bargain the project
 * strings and the song scalars strike. `control` is any stable name the caller
 * picks for the gesture; null never coalesces.
 */
export function setMasteringOp(song, payload, control = null, gestureId = null) {
  return {
    type: "setMastering",
    song, payload, control, gestureId,
    coalesceKey: control === null ? null : `mastering:${song}:${control}`,
    apply(doc) {
      const i = doc.projSections.findIndex((s) => s.fourcc === "sMst");
      const prev = i >= 0 ? doc.projSections[i].payload : null;
      doc.setSection("sMst", payload);
      doc.dirty = true;
      return setMasteringOp(song, prev, control, gestureId);
    },
    dirty: () => [{ kind: "mastering", song }],
  };
}

/** Refresh the live decoded TaudInst's patches from the (possibly just
 *  swapped) doc.ixmp list — last entry for the slot wins, mirroring the
 *  device upload order. */
function refreshLivePatches(doc, slot) {
  const s = slot & 0x3ff;
  const entry = [...doc.ixmp].reverse().find((e) => (e.instId & 0x3ff) === s);
  const patches = entry ? parsePatchesBlob(entry.blob) : [];
  doc.instruments[s].extraPatches = patches.length > 0 ? patches : null;
  if (patches.length > 0) doc._usedSlots.add(s);
}

/**
 * Replace instrument `slot`'s Ixmp patch list with the wire blob `blob`
 * (null / < 31 bytes = remove all patches). Updates the decoded doc.ixmp
 * entry, rebuilds the "Ixmp" section, and refreshes the live TaudInst's
 * extraPatches so census/zones/jam see the edit immediately. `snam`
 * (undefined = untouched) atomically swaps the SNam payload in the same
 * step — a sample-binding change can reorder the census, whose pool order
 * IS the SNam name mapping. The inverse is a snapshot swap of the ixmp
 * list + the whole projSections list (payload refs are stable; keeps the
 * section ORDER byte-exact, like captureBankState). Dirty {kind:"ixmp"} →
 * DocSync re-uploads the slot's patch blob.
 */
export function setInstPatchesOp(slot, blob, snam = undefined, gestureId = null) {
  return {
    type: "setInstPatches",
    slot, blob, snam, gestureId,
    coalesceKey: `ixmp:${slot & 0x3ff}`,
    apply(doc) {
      const s = slot & 0x3ff;
      const prev = captureIxmpState(doc);
      const patches = blob !== null && blob.length >= 31 ? parsePatchesBlob(blob) : [];
      doc.ixmp = doc.ixmp.filter((e) => (e.instId & 0x3ff) !== s);
      if (patches.length > 0) doc.ixmp.push({ instId: s, count: patches.length, blob });
      doc.setSection("Ixmp", doc.ixmp.length > 0 ? buildIxmpSection(doc.ixmp) : null);
      if (snam !== undefined) doc.setSection("SNam", snam);
      refreshLivePatches(doc, s);
      doc.dirty = true;
      return swapIxmpStateOp(slot, prev, gestureId);
    },
    dirty: () => [{ kind: "ixmp", slot: slot & 0x3ff }],
  };
}

/**
 * When an edit changes one of an instrument's OWN base sample-geometry
 * fields, mirror the same fields into its base stereo patch (item 180,
 * `baseStereoPatchIndex`) if it has one — that patch's rectangle always wins
 * over the base record, so its own duplicate copy of these fields is what
 * actually plays, and leaving it stale (or, after a re-bind, pointing at a
 * different sample entirely) is the "invalid state" this closes.
 *
 * `changes` is {instFieldName: newValue} using TaudInst property names (see
 * `BASE_TO_PATCH_FIELD`). Returns a setInstPatchesOp mirroring the matching
 * subset into the patch, or null when the instrument has no base stereo patch
 * or none of `changes` touches a mirrored field.
 *
 * Mirroring these scalar fields never changes the sample census's (ptr,len)
 * key set — the base record's own ptr/len is already in the census
 * unconditionally (`Document.sampleList()`) — so `snam` is left untouched.
 */
export function syncBaseStereoPatchOp(doc, slot, changes, gestureId = null) {
  const inst = doc.instruments[slot & 0x3ff];
  const idx = baseStereoPatchIndex(inst);
  if (idx < 0) return null;
  let touched = false;
  const patches = inst.extraPatches.map((p, i) => {
    if (i !== idx) return p;
    const q = { ...p };
    for (const [instKey, patchKey] of Object.entries(BASE_TO_PATCH_FIELD)) {
      if (instKey in changes) { q[patchKey] = changes[instKey]; touched = true; }
    }
    return q;
  });
  return touched ? setInstPatchesOp(slot, writePatchesBlob(patches), undefined, gestureId) : null;
}

/**
 * Rebind an instrument's base stereo patch (item 180, `baseStereoPatchIndex`)
 * after re-pointing its base record at a DIFFERENT sample (e.g. the
 * Instruments view's Sample picker, `adoptSample`): upserts a full-range patch
 * mirroring `fields` plus the new channel pointers when the newly-adopted
 * sample is itself stereo, or drops the existing one when it is not — an
 * instrument re-bound to a mono sample has nothing left for a patch to add.
 *
 * Without this, re-binding away from a stereo sample left the OLD full-range
 * patch pointing at the OLD sample, which keeps winning every trigger (its
 * rectangle covers everything), so the instrument kept silently playing the
 * sample it was just switched away from.
 *
 * `fields` is the full mirrored geometry for the newly-adopted sample, using
 * PATCH field names (samplePtr, sampleLength, playStart, loopStart, loopEnd,
 * samplingRate, sampleDetune, loopMode — see `BASE_TO_PATCH_FIELD`).
 * `chanPtrs`/`chanMode` come straight from the census entry
 * (`Document.sampleList()`); an empty `chanPtrs` means the adopted sample is
 * mono. Returns a setInstPatchesOp, or null when there is nothing to do
 * (adopted a mono sample and the instrument had no shadow patch already).
 */
export function rebindBaseStereoPatchOp(doc, slot, fields, chanPtrs, chanMode = 0) {
  const inst = doc.instruments[slot & 0x3ff];
  const idx = baseStereoPatchIndex(inst);
  if (chanPtrs.length > 0) {
    const mirrored = {
      ...fields, hasChanBlock: true, chanCount: 1 + chanPtrs.length,
      chanMode, chanPtrs: [...chanPtrs],
    };
    const patches = idx >= 0
      ? inst.extraPatches.map((p, i) => (i === idx ? { ...p, ...mirrored } : p))
      : [...(inst.extraPatches ?? []), makeInstPatch({
          pitchStart: 0, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63, ...mirrored,
        })];
    return setInstPatchesOp(slot, writePatchesBlob(patches), undefined);
  }
  if (idx < 0) return null;
  const patches = inst.extraPatches.filter((_, i) => i !== idx);
  return setInstPatchesOp(slot, patches.length ? writePatchesBlob(patches) : null, undefined);
}

function captureIxmpState(doc) {
  return {
    ixmp: doc.ixmp.slice(),
    sections: doc.projSections.map((x) => ({ fourcc: x.fourcc, payload: x.payload })),
  };
}

/** Inverse of setInstPatchesOp: restore the captured ixmp list + section list
 *  verbatim; its own inverse is the symmetric swap back (redo). */
function swapIxmpStateOp(slot, state, gestureId = null) {
  return {
    type: "swapIxmpState",
    slot, state, gestureId,
    coalesceKey: `ixmp:${slot & 0x3ff}`,
    apply(doc) {
      const cur = captureIxmpState(doc);
      doc.ixmp = state.ixmp.slice();
      doc.projSections = state.sections.map((x) => ({ fourcc: x.fourcc, payload: x.payload }));
      refreshLivePatches(doc, slot);
      doc.dirty = true;
      return swapIxmpStateOp(slot, cur, gestureId);
    },
    dirty: () => [{ kind: "ixmp", slot: slot & 0x3ff }],
  };
}

/** Song-scope scalar (bpm, tickRate, globalVolume, mixingVolume, globalFlags, …). */
export function setSongScalarOp(song, key, value, gestureId = null) {
  return {
    type: "setSongScalar",
    song, key, value, gestureId,
    coalesceKey: `scalar:${song}:${key}`,
    apply(doc) {
      const s = doc.songs[song];
      const prev = s[key];
      s[key] = value;
      doc.dirty = true;
      return setSongScalarOp(song, key, prev, gestureId);
    },
    dirty: () => [{ kind: "scalar", song, key }],
  };
}

/**
 * Song tuning pair (item 77) — "note `baseNote` sounds at `freq` Hz".
 *
 * Its own op rather than two setSongScalarOps because the two fields describe
 * ONE quantity: picking a preset moves both, and coalescing can't merge them
 * (it keys on coalesceKey, which differs per field), so scalars would leave a
 * half-applied tuning one Ctrl+Z away. One op = one undo step.
 */
export function setTuningOp(song, baseNote, freq, gestureId = null) {
  return {
    type: "setTuning",
    song, baseNote, freq, gestureId,
    coalesceKey: `tuning:${song}`,
    apply(doc) {
      const s = doc.songs[song];
      const prevNote = s.tuningBaseNote;
      const prevFreq = s.tuningFreq;
      s.tuningBaseNote = baseNote;
      s.tuningFreq = freq;
      doc.dirty = true;
      return setTuningOp(song, prevNote, prevFreq, gestureId);
    },
    // Either key re-pushes the whole pair (sync.pushScalar), so one tag does.
    dirty: () => [{ kind: "scalar", song, key: "tuningFreq" }],
  };
}

/** Structural pattern remap (item 60 cleanup / renumber): swap in a new
 *  patterns array + rewritten cue words + reordered pNam, all in one invertible
 *  step (snapshot swap, like importBankOp). `newPNam` is a payload or null.
 *  The dirty tag triggers a full song re-sync (every pattern + cue changed). */
export function remapPatternsOp(song, newPatterns, newCues, newPNam, gestureId = null) {
  return {
    type: "remapPatterns",
    song, gestureId,
    apply(doc) {
      const s = doc.songs[song];
      const oldPatterns = s.patterns;
      const oldCues = s.cues;
      const sec = doc.projSections.find((x) => x.fourcc === "pNam");
      const oldPNam = sec ? sec.payload : null;
      s.patterns = newPatterns;
      s.cues = newCues;
      doc.setSection("pNam", newPNam);
      doc.dirty = true;
      return remapPatternsOp(song, oldPatterns, oldCues, oldPNam, gestureId);
    },
    dirty: () => [{ kind: "resync", song }],
  };
}

/**
 * Renumber one instrument (item 73): swap in the image with the record moved +
 * the INam entry moved + the Ixmp slot id remapped, and rewrite the pattern
 * cells the plan lists (empty when the user kept patterns pointing at the old
 * number). `plan` is planRenumberInstrument()'s result; the inverse has the same
 * shape (previous image/INam/Ixmp + the cells' previous instrument bytes), so
 * this op is its own undo/redo. Dirty: the bank plus every touched pattern.
 */
export function renumberInstrumentOp(plan, gestureId = null) {
  return {
    type: "renumberInstrument",
    plan, gestureId,
    apply(doc) {
      const secOf = (fourcc) => {
        const s = doc.projSections.find((x) => x.fourcc === fourcc);
        return s ? s.payload : null;
      };
      const old = {
        image: doc.sampleInstImage,
        inam: secOf("INam"),
        ixmp: doc.ixmp,
        ixmpSection: secOf("Ixmp"),
        cells: [],
      };
      doc.sampleInstImage = plan.image;
      doc.setSection("INam", plan.inam);
      doc.ixmp = plan.ixmp;
      // The file carries the SECTION, not doc.ixmp — without this the saved file
      // would still bind the patches to the OLD slot number (an orphan blob on
      // reload). The inverse restores the captured payload verbatim.
      doc.setSection("Ixmp", "ixmpSection" in plan
        ? plan.ixmpSection
        : (plan.ixmp.length > 0 ? buildIxmpSection(plan.ixmp) : null));
      doc._resetInstrumentCache();
      for (const w of plan.cells) {
        const cell = doc.songs[w.song].patterns[w.pat]?.[w.row];
        if (!cell) continue;
        old.cells.push({ song: w.song, pat: w.pat, row: w.row, inst: cell.instrment });
        cell.instrment = w.inst;
      }
      doc.dirty = true;
      return renumberInstrumentOp(old, gestureId);
    },
    dirty: () => {
      const tags = [{ kind: "bank" }];
      const seen = new Set();
      for (const w of plan.cells) {
        const key = `${w.song}:${w.pat}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tags.push({ kind: "pattern", song: w.song, pat: w.pat });
      }
      return tags;
    },
  };
}

/**
 * Delete one instrument (this feature): swap in the image with its record zeroed
 * (its parent metainstruments already rewired + any uniquely-owned samples freed
 * by the planner), the INam entry blanked, the SNam table realigned to the
 * surviving sample census (a removed slot's samples drop out of the census
 * whether or not their pool bytes were also freed), and the Ixmp slot id
 * dropped, then rewrite the pattern cells the plan lists (the reassign writes;
 * empty when the user left the notes dangling). `plan` is
 * planDeleteInstrument()'s result; the inverse has the same shape (previous
 * image/INam/SNam/Ixmp + the cells' previous instrument bytes), so this op is
 * its own undo/redo — structurally identical to renumberInstrumentOp (which
 * doesn't touch SNam, since a renumber never changes the sample census). Dirty:
 * the bank plus every touched pattern.
 */
export function deleteInstrumentOp(plan, gestureId = null) {
  return {
    type: "deleteInstrument",
    plan, gestureId,
    apply(doc) {
      const secOf = (fourcc) => {
        const s = doc.projSections.find((x) => x.fourcc === fourcc);
        return s ? s.payload : null;
      };
      const old = {
        image: doc.sampleInstImage,
        inam: secOf("INam"),
        snam: secOf("SNam"),
        ixmp: doc.ixmp,
        ixmpSection: secOf("Ixmp"),
        cells: [],
      };
      doc.sampleInstImage = plan.image;
      doc.setSection("INam", plan.inam);
      doc.setSection("SNam", plan.snam);
      doc.ixmp = plan.ixmp;
      // toBytes()/reload read the SECTION, not doc.ixmp — rebuild it so the
      // dropped patches don't come back on reload (buildIxmpSection is the
      // proven byte-exact inverse of parseIxmpSection). The inverse restores
      // the captured payload verbatim.
      doc.setSection("Ixmp", "ixmpSection" in plan
        ? plan.ixmpSection
        : (plan.ixmp.length > 0 ? buildIxmpSection(plan.ixmp) : null));
      doc._resetInstrumentCache();
      for (const w of plan.cells) {
        const cell = doc.songs[w.song].patterns[w.pat]?.[w.row];
        if (!cell) continue;
        old.cells.push({ song: w.song, pat: w.pat, row: w.row, inst: cell.instrment });
        cell.instrment = w.inst;
      }
      doc.dirty = true;
      return deleteInstrumentOp(old, gestureId);
    },
    dirty: () => {
      const tags = [{ kind: "bank" }];
      const seen = new Set();
      for (const w of plan.cells) {
        const key = `${w.song}:${w.pat}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tags.push({ kind: "pattern", song: w.song, pat: w.pat });
      }
      return tags;
    },
  };
}

/**
 * Change every note's instrument number `from` → `to` across whole patterns
 * (the Patterns-tab "Change instrument" made global). `from` is $00–$FF or null
 * (null = every non-empty instrument becomes `to`); `to` is $00–$FF. `songs` is a
 * list of song indices, or null for all songs. One undo step; the inverse
 * restores every touched cell's previous instrument byte. Dirty: one pattern tag
 * per touched pattern (non-current-song tags are ignored by DocSync — the
 * worklet only holds the current song, re-pushed on switch).
 */
export function changeInstrumentOp(from, to, songs = null, gestureId = null) {
  return {
    type: "changeInstrument",
    from, to, songs, gestureId,
    coalesceKey: `changeInst:${from}:${to}`,
    apply(doc) {
      const idxs = songs ?? doc.songs.map((_, i) => i);
      const inverse = [];
      for (const si of idxs) {
        const pats = doc.songs[si].patterns;
        for (let pi = 0; pi < pats.length; pi++) {
          const p = pats[pi];
          if (!p) continue;
          for (let r = 0; r < p.length; r++) {
            const cell = p[r];
            const cur = cell.instrment & 0xff;
            const match = from === null ? cur !== 0 : cur === (from & 0xff);
            if (!match) continue;
            inverse.push({ song: si, pat: pi, row: r, inst: cell.instrment });
            cell.instrment = to & 0xff;
          }
        }
      }
      this._touched = inverse;
      doc.dirty = true;
      return restoreCellInstsOp(inverse, gestureId);
    },
    dirty() {
      const seen = new Set();
      const tags = [];
      for (const w of this._touched ?? []) {
        const key = `${w.song}:${w.pat}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tags.push({ kind: "pattern", song: w.song, pat: w.pat });
      }
      return tags;
    },
  };
}

/** Inverse of changeInstrumentOp: restore each listed cell's instrument byte. */
function restoreCellInstsOp(cells, gestureId = null) {
  return {
    type: "restoreCellInsts",
    cells, gestureId,
    coalesceKey: `changeInst:restore`,
    apply(doc) {
      const inverse = [];
      for (const w of cells) {
        const cell = doc.songs[w.song].patterns[w.pat]?.[w.row];
        if (!cell) continue;
        inverse.push({ song: w.song, pat: w.pat, row: w.row, inst: cell.instrment });
        cell.instrment = w.inst;
      }
      this._touched = inverse;
      doc.dirty = true;
      return restoreCellInstsOp(inverse, gestureId);
    },
    dirty() {
      const seen = new Set();
      const tags = [];
      for (const w of this._touched ?? cells) {
        const key = `${w.song}:${w.pat}`;
        if (seen.has(key)) continue;
        seen.add(key);
        tags.push({ kind: "pattern", song: w.song, pat: w.pat });
      }
      return tags;
    },
  };
}

/** Bank cleanup (items 60, 74): swap in the cleaned image + INam/SNam + Ixmp
 *  (unused instruments removed, orphaned samples freed, unreachable patches
 *  dropped) in one invertible step. `plan` is planBankCleanup()'s or
 *  planIxmpCleanup()'s result; the inverse restores the pre-cleanup bank. */
export function cleanupBankOp(plan, gestureId = null) {
  return {
    type: "cleanupBank",
    gestureId,
    apply(doc) {
      const secOf = (fourcc) => {
        const s = doc.projSections.find((x) => x.fourcc === fourcc);
        return s ? s.payload : null;
      };
      const old = {
        image: doc.sampleInstImage, inam: secOf("INam"), snam: secOf("SNam"),
        ixmp: doc.ixmp, ixmpSection: secOf("Ixmp"),
      };
      doc.sampleInstImage = plan.image;
      doc.setSection("INam", plan.inam);
      doc.setSection("SNam", plan.snam);
      doc.ixmp = plan.ixmp;
      // toBytes() writes the SECTION list, not doc.ixmp — without this the
      // dropped patches would survive in the saved file and come back on reload.
      // The inverse carries the exact previous payload; a forward plan rebuilds
      // (buildIxmpSection is parseIxmpSection's proven byte-exact inverse).
      doc.setSection("Ixmp", "ixmpSection" in plan
        ? plan.ixmpSection
        : (plan.ixmp.length > 0 ? buildIxmpSection(plan.ixmp) : null));
      doc._resetInstrumentCache();
      doc.dirty = true;
      return cleanupBankOp(old, gestureId);
    },
    dirty: () => [{ kind: "bank" }],
  };
}

/**
 * Widen the whole project's pattern cells to format version 3 (§5.5) AND set
 * the song's surround model — what a project does the first time it declares
 * one.
 *
 * The two belong in ONE op because they are one user action: the format change
 * exists to serve the model, and a half-undone pair (wide cells, stereo song,
 * or worse the reverse) is not a state the user ever asked for. It covers every
 * song in the file because the version byte is one byte for the file — half a
 * project cannot be wide.
 *
 * The inverse restores the exact pattern images it replaced, so the switch is
 * undoable IN THE SESSION even though the FORMAT has no defined downgrade:
 * nothing has had a chance to use the wider range yet, and the bytes are simply
 * kept.
 */
export function upgradeCellFormatOp(song = 0, surroundModel = 0, gestureId = null) {
  return {
    type: "upgradeCellFormat",
    song, surroundModel, gestureId,
    apply(doc) {
      const before = {
        fmtVer: doc.fmtVer,
        surroundModel: doc.songs[song].surroundModel,
        patterns: doc.songs.map((s) => s.patterns.map((p) => (p ? p.slice() : null))),
      };
      doc.upgradeToWideCells();
      doc.songs[song].surroundModel = surroundModel;
      doc.dirty = true;
      return restoreCellFormatOp(song, surroundModel, before, gestureId);
    },
    dirty: () => [{ kind: "format" }],
  };
}

/** Inverse of upgradeCellFormatOp: narrow the patterns and restore the flag. */
function restoreCellFormatOp(song, surroundModel, before, gestureId = null) {
  return {
    type: "restoreCellFormat",
    song, surroundModel, gestureId,
    apply(doc) {
      doc.fmtVer = before.fmtVer;
      doc.wideCells = false;
      doc.songs.forEach((s, i) => { s.patterns = before.patterns[i]; });
      doc.songs[song].surroundModel = before.surroundModel;
      doc._emptyPattern = null;
      doc.dirty = true;
      return upgradeCellFormatOp(song, surroundModel, gestureId);
    },
    dirty: () => [{ kind: "format" }],
  };
}
