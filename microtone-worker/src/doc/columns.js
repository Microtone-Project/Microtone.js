// What a pattern cell's volume and panning columns do to a lane, and how a
// note's volume is seeded and gated — the rules the page restates in
// JavaScript where it has to compute with them (the pitch-bend ghosts,
// bendghosts.js; Clean Up's reachability walk, cleanup.js). The engine's own
// are C (core/engine/c/src/trigger.c te_apply_vol_column, te_apply_pan_column,
// te_apply_pan_column_wide, te_row_volume_from_default, te_narrow_vol_axis;
// effects.c resolve_arg); these are their twins, line for line, and a change
// to one is a change to both.
//
// `ts` is anything with the playhead's `wideCells`, `volMax` and
// `surroundModel`; `voice` anything with the lane fields they write.

import { EffectOp, clamp } from "../../core/engine/tables.js";
import {
  SURROUND_SPATIAL, applyNotePanSet, applyNotePanSlide, applyNoteElevation,
} from "../../core/engine/spatial.js";

/** Resolve a non-zero argument or recall from cohort memory. */
export function resolveArg(arg, mem) { return arg !== 0 ? arg : mem; }

/** Trigger-time noteVolume seed from Default Note Volume (byte 196; 0 = legacy
 *  full volume). The record's field is 8-bit: a 6-bit column narrows it, a wide
 *  cell's 8-bit volume state takes it as it stands. */
export function rowVolumeFromDefault(inst, patch = null, volMax = 0x3f) {
  const patchDnv = patch !== null && patch.defaultNoteVolume !== 0 ? patch.defaultNoteVolume : null;
  const dnv = patchDnv !== null ? patchDnv : inst.defaultNoteVolume;
  if (dnv === 0) return volMax;
  return volMax === 0xff ? dnv : Math.trunc((dnv * 63 + 127) / 255);
}

/**
 * Narrow a note volume onto the Ixmp/meta rectangle's velocity axis. That axis
 * is INSTRUMENT data and stays 6-bit in every format version (file format §5.5),
 * so a wide cell's 8-bit volume must be scaled down for it — 255 → 63. Every
 * resolvePatch/resolveMetaLayers call site goes through here; one that forgets
 * silently misses every patch in a v3 song (item 116).
 */
export function narrowVolAxis(ts, v) {
  return clamp(ts.wideCells ? v >> 2 : v, 0, 0x3f);
}

/** Volume column (value = 6-bit field, sel = 2-bit selector). */
export function applyVolColumn(ts, voice, value, sel) {
  // FINE packs its direction into the TOP bit of the column's value field, so
  // the flag and the magnitude mask move with the field's width (bit 5 of six,
  // bit 7 of eight). Everything else is the same in both formats — a wide
  // cell's numbers are simply four times as fine.
  const dirBit = ts.wideCells ? 0x80 : 0x20;
  switch (sel) {
    case 0:
      voice.noteVolume = clamp(value, 0, ts.volMax);
      voice.rowVolume = voice.noteVolume;
      break;
    case 1: voice.volColSlideUp = value; break;
    case 2: voice.volColSlideDown = value; break;
    case 3: {
      if (value === 0) return;
      const mag = value & (dirBit - 1);
      voice.noteVolume = (value & dirBit) !== 0
        ? Math.min(voice.noteVolume + mag, ts.volMax)
        : Math.max(voice.noteVolume - mag, 0);
      voice.rowVolume = voice.noteVolume;
      break;
    }
  }
}

/**
 * Pan column — the NOTE pan axis (item 117), the exact counterpart of the
 * volume column owning `note_vol` while M / N own `channel_vol`. All four
 * selectors write it, so a column SET places THIS note and leaves the lane's
 * own position (S $80xx, P, X, Z) standing underneath: on a zone-panned Ixmp
 * instrument the SET is what overrides the zone, and the lane commands are
 * what rotate it. There is consequently nothing left to arbitrate when a row
 * carries both a SET and an S $80xx — they address different registers, so both
 * apply.
 *
 * The 6-bit SET keeps its front-arc mapping in every surround model — the
 * column has no room for a 360° angle, and S $8xxx / X are the commands that
 * do. The slides, however, wrap with the rest of the pan machinery.
 */
export function applyPanColumn(ts, voice, value, sel) {
  switch (sel) {
    case 0:
      applyNotePanSet(ts, voice, (value << 2) | (value >>> 4));
      break;
    case 1: voice.panColSlideRight = value; break;
    case 2: voice.panColSlideLeft = value; break;
    case 3: {
      if (value === 0) return;
      const mag = value & 0x1f;
      applyNotePanSlide(ts, voice, (value & 0x20) !== 0 ? mag : -mag);
      break;
    }
  }
}

/**
 * A WIDE cell's panning column (format version 3): a 9-bit azimuth and a signed
 * elevation, so the column alone can place a source anywhere on the sphere —
 * the six bits of the narrow cell only ever reached the front arc.
 *
 * Like the narrow column it is the NOTE axis (item 117) — the wide cell is the
 * same two lanes at higher resolution, exactly as its volume column is still
 * `note_vol` with a whole byte instead of six bits — so its azimuth and
 * elevation are both offsets from wherever the lane is pointing.
 *
 * The one exception is a `Z` slide on the same row, which turns the SET into
 * that slide's TARGET rather than a jump (the column says what effect `4` would
 * have said, and outranks a `4` on the same row for being the more specific
 * statement). A Z target names an absolute direction for the LANE to travel
 * to, so on those rows — and only those — the column speaks for the lane.
 */
export function applyPanColumnWide(ts, voice, row) {
  switch (row.panEff) {
    case 0: {
      if (rowSlidesSpatially(row)) {
        voice.spatialTargetAz = row.azimuth;
        voice.spatialTargetEl = ts.surroundModel === SURROUND_SPATIAL ? row.elevation : 0;
      } else {
        applyNotePanSet(ts, voice, row.azimuth);
        applyNoteElevation(ts, voice, row.elevation);
      }
      break;
    }
    // Slides rotate the azimuth by the LOW byte per tick; the elevation byte is
    // reserved for these selectors.
    case 1: voice.panColSlideRight = row.azimuth & 0xff; break;
    case 2: voice.panColSlideLeft = row.azimuth & 0xff; break;
    case 3: {
      const mag = row.azimuth & 0xff;
      if (mag === 0) return;
      applyNotePanSlide(ts, voice, (row.azimuth & 0x100) !== 0 ? mag : -mag);
      break;
    }
  }
}

/** Does this row arm a Z slide (in either effect slot)? */
function rowSlidesSpatially(row) {
  return (row.effect === EffectOp.OP_Z && (row.effectArg & 0xfff) !== 0) ||
         (row.effect2 === EffectOp.OP_Z && (row.effectArg2 & 0xfff) !== 0);
}
