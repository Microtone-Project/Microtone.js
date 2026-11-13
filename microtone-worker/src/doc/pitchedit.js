// An instrument's pitch fields at 65536-TET (file format §9.18, item 319).
//
// A record's pitch fields are sixteen bits — 4096 steps to the octave, sixteen
// octaves — and the `IPit` section gives each one more byte: four bits of
// fraction below it, four of octave above it. The decoded instruments hold the
// sixteen bits where the record has them and the extension beside them as a
// DELTA (inst.js applyPitchExt): dDetune / dLo / dHi on a layer, an operator
// or an Ixmp patch; dSampleDetune and dPitchPanCentre on an instrument; the
// kind's own field (an OPL partner's pitch, a formant reference note) on its
// block.
//
// The editor works in VALUES: the field and its delta added up, in 4096-TET
// units carrying sixteenths — the units a format-3 pattern cell's note is in.
// These helpers are the two ways between a value and a (field, delta) pair,
// and the groups an op hands Document.pitchExtPayloadWith (withPitchExtOp).
//
// A range's HIGH bound is a value too: the last pitch INSIDE the range. Its
// unextended form covers the whole of the unit its field names, so a field
// $4FFF with no extension is the value $4FFF + 15/16 — the editor shows that
// as plain `$4FFF` (spinmaps.js).

import { quantiseNote } from "../../core/tuning/pitchtables.js";
import {
  splitPitchDelta, pitchTableOf, pitchPatchesOf, extOfDelta,
} from "../../core/format/pitch-ext-section.js";

export { pitchTableOf, pitchPatchesOf };

/** A note word's whole reach with its extension byte: −128 … +128 octaves. */
export const NOTE_EXT_MIN = -8 * 65536;
export const NOTE_EXT_MAX = 8 * 65536 - 1 / 16;
/** …and a signed offset's (a detune, an operator's ratio). */
export const OFFSET_EXT_MIN = -8 * 65536 - 32768;
export const OFFSET_EXT_MAX = 7 * 65536 + 32767 + 15 / 16;

/** The last sixteenth of a unit: what a high bound's field means unextended. */
export const HIGH_FRACTION = 15 / 16;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** A value quantised to sixteenths and kept within what a field + byte hold. */
export function fitNote(v) { return clamp(quantiseNote(Number(v) || 0), NOTE_EXT_MIN, NOTE_EXT_MAX); }
export function fitOffset(v) { return clamp(quantiseNote(Number(v) || 0), OFFSET_EXT_MIN, OFFSET_EXT_MAX); }

// ── layers and operators (a type-0 or type-4 record's table) ───────────────

/** Layer `l`'s detune as a value: an offset, or — fixed pitch — the note. */
export function layerDetune(l) {
  return (l.fixedPitch ? l.detune & 0xffff : l.detune) + (l.dDetune || 0);
}
/** Layer `l`'s range low bound as a value (the first pitch inside it). */
export function layerLow(l) { return l.pitchStart + (l.dLo || 0); }
/** Layer `l`'s range high bound as a value (the last pitch inside it). */
export function layerHigh(l) { return l.pitchEnd + HIGH_FRACTION + (l.dHi || 0); }

/** The field patch (patchLayer) that gives layer `l` the detune `value` —
 *  a note when the layer is fixed-pitch, an offset otherwise. */
export function layerDetuneFields(l, value) {
  const fixed = l.fixedPitch === true;
  const { field, delta } = splitPitchDelta(fixed ? fitNote(value) : fitOffset(value), { signed: !fixed });
  return { detune: field, dDetune: delta };
}
/** …the range low bound `value`. */
export function layerLowFields(value) {
  const { field, delta } = splitPitchDelta(fitNote(value));
  return { pitchStart: field, dLo: delta };
}
/** …the range high bound `value` (the last pitch inside the range). */
export function layerHighFields(value) {
  const { field, delta } = splitPitchDelta(fitNote(value), { high: true });
  return { pitchEnd: field, dHi: delta };
}

/** An editable copy of a decoded layer, its extension included. */
export function copyLayerPitch(dst, src) {
  dst.dDetune = src.dDetune || 0;
  dst.dLo = src.dLo || 0;
  dst.dHi = src.dHi || 0;
  return dst;
}

/** Does any of `layers` reach past what its sixteen bits hold? */
export function layersExtended(layers) {
  return layers.some((l) => (l.dDetune || 0) !== 0 || (l.dLo || 0) !== 0 || (l.dHi || 0) !== 0);
}

/**
 * A range's two ends as a readout names them: the first pitch, and the last —
 * as the unit it falls in when the range runs through the whole of that unit
 * (which is what an unextended bound does, so `$FFFF` still reads as the open
 * top and a zone still reads `C-4‥B-4`), otherwise to the sixteenth.
 */
export function rangeEnds(lo, hi) {
  const f = ((Math.round(hi * 16) % 16) + 16) % 16;
  return [lo, f === 15 ? Math.floor(hi) : hi];
}

/** Where a range ends, exclusive: one sixteenth past its last pitch — what a
 *  map draws a zone up to. */
export const rangeTop = (hi) => hi + 1 / 16;

// ── Ixmp patches ────────────────────────────────────────────────────────────

export const patchLow = (p) => p.pitchStart + (p.dLo || 0);
export const patchHigh = (p) => p.pitchEnd + HIGH_FRACTION + (p.dHi || 0);
export const patchDetune = (p) => signed16(p.sampleDetune) + (p.dDetune || 0);

export function patchLowFields(value) {
  const { field, delta } = splitPitchDelta(fitNote(value));
  return { pitchStart: field, dLo: delta };
}
export function patchHighFields(value) {
  const { field, delta } = splitPitchDelta(fitNote(value), { high: true });
  return { pitchEnd: field, dHi: delta };
}
export function patchDetuneFields(value) {
  const { field, delta } = splitPitchDelta(fitOffset(value), { signed: true });
  return { sampleDetune: field, dDetune: delta };
}

// ── an instrument's own fields (the base group) ─────────────────────────────

const signed16 = (v) => { const w = v & 0xffff; return w >= 0x8000 ? w - 0x10000 : w; };

/** The instrument's sample detune as a value. */
export const instDetune = (inst) => signed16(inst.sampleDetune) + (inst.dSampleDetune || 0);
/** The instrument's pitch-pan centre as a value. */
export const instPanCentre = (inst) => (inst.pitchPanCentre & 0xffff) + (inst.dPitchPanCentre || 0);

/** A value as the signed sixteen-bit field and its extension byte. */
export function splitOffset(value) {
  const { field, delta } = splitPitchDelta(fitOffset(value), { signed: true });
  return { field, ext: extOfDelta(delta) };
}
/** A value as the unsigned note word and its extension byte. */
export function splitNote(value) {
  const { field, delta } = splitPitchDelta(fitNote(value));
  return { field, ext: extOfDelta(delta) };
}

/** The base group (sample detune, pitch-pan centre, the kind's own field) as
 *  the instrument carries it now — what an edit of ONE of the three keeps of
 *  the other two. */
export function baseExtOf(inst) {
  const kind = inst.opl ? inst.opl.dPartnerDetune : inst.formant ? inst.formant.dRefNote : 0;
  return [extOfDelta(inst.dSampleDetune), extOfDelta(inst.dPitchPanCentre), extOfDelta(kind || 0)];
}

/** The base group with entry `i` (0 sample detune, 1 pitch-pan centre, 2 the
 *  kind's own field) replaced by `ext`; null when every byte is zero. */
export function baseExtWith(inst, i, ext) {
  const b = baseExtOf(inst);
  b[i] = ext & 0xff;
  return b.some((x) => x !== 0) ? b : null;
}

/** The patch group (§9.18) as the instrument's patches carry it now, with
 *  patch `index`'s entry `which` (0 range start, 1 range end, 2 detune)
 *  replaced by `ext` when given; null when every byte is zero. */
export function patchExtWith(inst, index = -1, which = 0, ext = 0) {
  const ps = inst.extraPatches ?? [];
  const t = ps.flatMap((p) => [extOfDelta(p.dLo), extOfDelta(p.dHi, true), extOfDelta(p.dDetune)]);
  if (index >= 0 && index < ps.length) t[index * 3 + which] = ext & 0xff;
  return t.some((b) => b !== 0) ? Uint8Array.from(t) : null;
}
