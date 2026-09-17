// Metainstrument layer-table editing (item 113) — pure array surgery over the
// decoded layer list, re-packed through buildMetaRecord. A meta's whole
// structure lives in that table, so add / duplicate / remove / reorder are all
// "rebuild the 256-byte record from a new array"; the invertible wrapper is
// setMetaRecordOp (ops.js).
//
// DUPLICATE IS LINKED. A duplicated layer points at the SAME sub-instrument slot
// as the layer it came from — the format allows it (inst.js loadRecord rejects a
// layer only for a self-reference or an out-of-range index) and triggerMetaOrNote
// spawns one Voice per RESOLVED layer, keyed by nothing that could collide, so
// three layers on one child are three independently detuned voices of one
// editable instrument. applyDuplicateCheck never sees them either: row.js/tick.js
// call it with the pattern's instrument byte (the meta's own slot), never per
// layer. Splitting a shared child off into its own slot is a BANK edit, not a
// table edit — bankmerge.planUnlinkMetaLayer.

import {
  buildMetaRecord, makeMetaLayer, META_MAX_LAYERS, META_TYPE_LAYERED, META_TYPE_FM,
} from "../engine/inst.js";

export { META_MAX_LAYERS, META_TYPE_LAYERED, META_TYPE_FM };

/** Flag byte 0 of a meta record, preserved across every rebuild — the TYPE
 *  nibble included, so a table edit can never turn a rack back into a stack. */
export function metaFlags(inst) {
  const b0 = inst?.metaRaw ? inst.metaRaw[0] & 0xff : 0;
  return {
    strict: (b0 & 0x01) !== 0,
    percussion: (b0 & 0x02) !== 0,
    type: (b0 >>> 4) & 0x0f,
  };
}

/**
 * Editable copies of a meta's layers. `rawOffset` is dropped on purpose: it is
 * a byte position re-derived by loadRecord and would be stale the moment the
 * array is reordered — everything here addresses layers by ARRAY INDEX.
 */
export function metaLayers(inst) {
  return (inst?.metaLayers ?? []).map((l) => makeMetaLayer(
    l.instIdx, l.mixOctet, l.detune, l.pitchStart, l.pitchEnd, l.volStart, l.volEnd,
    l.fixedPitch === true));
}

/** Repack `layers` into a 256-byte record, keeping `inst`'s flag byte — and,
 *  for a type-4 rack, its algorithm: the table and the program are one record,
 *  so an edit to either has to hand the other back untouched. */
export function metaRecordOf(inst, layers, program = undefined) {
  return buildMetaRecord(layers, {
    ...metaFlags(inst),
    program: program === undefined ? (inst?.fmProgram ?? null) : program,
  });
}

/**
 * The record `inst` would have with some of its byte-0 FLAGS changed and
 * everything else — the whole entry table, and a rack's algorithm — kept.
 * `fields` is a metaFlags-shaped patch: {strict?, percussion?}.
 *
 * The type nibble is NOT patchable through here on purpose: turning a stack
 * into a rack is not a flag, it is a different record with a different meaning
 * for every entry in it.
 */
export function metaRecordWithFlags(inst, fields) {
  const { type } = metaFlags(inst);
  return buildMetaRecord(metaLayers(inst), {
    ...metaFlags(inst), ...fields, type,
    program: inst?.fmProgram ?? null,
  });
}

/** A full-range layer at unity mix — what a freshly added layer sounds like
 *  until the user narrows it. Matches planCreateMeta's own default. */
export function defaultLayer(instIdx, detune = 0) {
  return makeMetaLayer(instIdx, 159, detune, 0x0000, 0xffff, 0, 63);
}

/** How many layers share `layers[i]`'s sub-instrument slot (1 = not shared). */
export function linkCount(layers, i) {
  const idx = layers[i]?.instIdx;
  return idx === undefined ? 0 : layers.filter((l) => l.instIdx === idx).length;
}

/**
 * Copy layer `i`, inserting the copy directly after it so the stack reads in
 * the order it was built. `detune` overrides the copy's offset (a duplicate at
 * the same pitch is a phase-locked doubling, which is rarely what is wanted).
 * Returns the original array unchanged when the table is already full.
 */
export function duplicateLayer(layers, i, detune = null) {
  if (i < 0 || i >= layers.length || layers.length >= META_MAX_LAYERS) return layers;
  const src = layers[i];
  const copy = makeMetaLayer(src.instIdx, src.mixOctet, detune === null ? src.detune : detune,
    src.pitchStart, src.pitchEnd, src.volStart, src.volEnd, src.fixedPitch === true);
  return [...layers.slice(0, i + 1), copy, ...layers.slice(i + 1)];
}

/**
 * Drop layer `i`. The LAST layer can never be removed: a zero-layer record
 * decodes as neither a meta nor a sample instrument (loadRecord leaves the
 * decoded fields untouched), so the slot would be unreadable — deleting the
 * whole metainstrument is the cleanup.js path for that.
 */
export function removeLayer(layers, i) {
  if (i < 0 || i >= layers.length || layers.length <= 1) return layers;
  return layers.filter((_, n) => n !== i);
}

/** Move layer `i` by `delta` places. Record order is PRIORITY: the first layer
 *  that resolves for a trigger becomes the lane's foreground voice, the rest
 *  spawn as background children (trigger.js triggerMetaOrNote). */
export function moveLayer(layers, i, delta) {
  const to = i + delta;
  if (i < 0 || i >= layers.length || to < 0 || to >= layers.length) return layers;
  const out = layers.slice();
  const [moved] = out.splice(i, 1);
  out.splice(to, 0, moved);
  return out;
}

/** Overwrite fields of layer `i` (mixOctet / detune / pitchStart / pitchEnd /
 *  volStart / volEnd / instIdx). */
export function patchLayer(layers, i, fields) {
  if (i < 0 || i >= layers.length) return layers;
  return layers.map((l, n) => (n === i ? { ...l, ...fields } : l));
}

/** The layer detune field is a signed 16-bit 4096-TET offset. */
export const DETUNE_MIN = -0x8000;
export const DETUNE_MAX = 0x7fff;
export const clampDetune = (d) =>
  Math.min(Math.max(Math.round(d) || 0, DETUNE_MIN), DETUNE_MAX);

/** The lowest playable note word — below it lies the pattern cell's sentinel
 *  space, which is not a pitch a layer can sound. */
export const FIXED_PITCH_MIN = 0x0020;
export const FIXED_PITCH_MAX = 0xffff;

/** Middle C — the note an ordinary layer's zero detune sounds when the trigger
 *  is C4, and therefore the pitch the flag switch pivots on. Kept here rather
 *  than imported from the UI's pitch tables: this module is document-layer. */
export const FIXED_PITCH_ANCHOR = 0x5000;

/**
 * Fit a value to whichever thing layer `l`'s detune field IS: a signed offset
 * on an ordinary layer, an unsigned note word on a fixed-pitch one (item 179).
 * Every edit that writes the field goes through this, so "up a fifth" means the
 * same gesture on both kinds and neither can be clamped by the other's range.
 */
export function clampLayerPitch(l, v) {
  return l?.fixedPitch
    ? Math.min(Math.max(Math.round(v) || 0, FIXED_PITCH_MIN), FIXED_PITCH_MAX)
    : clampDetune(v);
}

/**
 * The field patch that turns layer `l` fixed-pitch on or off, carrying the
 * pitch it was SHOWING across the switch: an ordinary layer's detune is read
 * against middle C (which is what the Layers tab's glyph beside it has always
 * drawn), so the note under the cursor does not jump when the flag is flipped.
 * Feed it to patchLayer, like every other cell edit in the table.
 */
export function fixedPitchFields(l, fixed) {
  const detune = fixed
    ? Math.min(Math.max(FIXED_PITCH_ANCHOR + l.detune, FIXED_PITCH_MIN), FIXED_PITCH_MAX)
    : clampDetune((l.detune & 0xffff) - FIXED_PITCH_ANCHOR);
  return { fixedPitch: fixed, detune };
}

/**
 * Insert one copy of layer `i` after it per entry of `detunes` (absolute layer
 * detune values) — a chord or unison stack off a single layer. Copies are
 * LINKED like every other duplicate; only the detune differs, so the stack
 * stays one editable instrument played at several pitches.
 */
export function stackLayer(layers, i, detunes) {
  if (i < 0 || i >= layers.length) return layers;
  const src = layers[i];
  const room = Math.max(0, META_MAX_LAYERS - layers.length);
  const copies = detunes.slice(0, room).map((d) => makeMetaLayer(
    src.instIdx, src.mixOctet, clampLayerPitch(src, d),
    src.pitchStart, src.pitchEnd, src.volStart, src.volEnd, src.fixedPitch === true));
  return [...layers.slice(0, i + 1), ...copies, ...layers.slice(i + 1)];
}

/** Append `add` layers, clamped to the table's capacity. */
export function appendLayers(layers, add) {
  return [...layers, ...add].slice(0, META_MAX_LAYERS);
}

/**
 * Rewrite layer `i` and every layer sharing its sub-instrument to `newIdx`, or
 * only layer `i` when `onlyThis`. Used by the unlink plan, which clones a shared
 * child into a fresh slot for ONE layer.
 */
export function repointLayer(layers, i, newIdx, onlyThis = true) {
  const oldIdx = layers[i]?.instIdx;
  return layers.map((l, n) => {
    const hit = onlyThis ? n === i : l.instIdx === oldIdx;
    return hit ? { ...l, instIdx: newIdx } : l;
  });
}
