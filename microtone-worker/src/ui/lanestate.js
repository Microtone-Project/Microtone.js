// The LANE axis as a pair of effect cells (item 198.3).
//
// A lane's volume and its position are set once and then persist — `M $xx00`
// twenty rows up is still in force here — so the Timeline's lane headers show
// them the way the grid shows everything else: as the command that would put
// the lane where it already is. Retyping what a header reads is a no-op, which
// is the property that makes the reading unambiguous.
//
// Which command that is follows the song's surround model, because the three
// of them address the same register at different widths: a stereo song's lane
// pan is a byte (`S $80xx`), a planar song's is the 9-bit azimuth `S $8aaa`
// covers, and a spatial song's is an azimuth AND an elevation, which only
// `X $eeaa` states in one cell. Showing `S` to a spatial song would silently
// drop the height; showing `X` to a stereo one would name a command that song
// is required to ignore.
//
// Pure — no DOM, no canvas — so the shape of every reading is testable.

import { EffectOp } from "../engine/tables.js";
import { SURROUND_SPATIAL } from "../engine/spatial.js";

/** `M $xx00` for a lane volume of `vol` (0..volMax). */
export function laneVolumeCell(vol) {
  return { effect: EffectOp.OP_M, arg: (Math.round(vol) & 0xff) << 8 };
}

/**
 * The lane-position cell for `surroundModel`.
 *
 * @param az  `S $8aaa`'s `aaa` — the pan byte in a stereo song, the 512-unit
 *            azimuth in a planar or spatial one.
 * @param el  signed lane elevation, 128 units = 90° (ignored unless spatial).
 */
export function lanePanCell(surroundModel, az, el) {
  if (surroundModel === SURROUND_SPATIAL) {
    // X's azimuth field is 8-bit — half the resolution of the register it
    // writes — so a lane sitting on an odd 512-unit angle reads to the nearest
    // one it can express. A readout rounds; it does not round-trip.
    const aa = Math.round(az / 2) & 0xff;
    const ee = Math.max(-128, Math.min(127, Math.round(el))) & 0xff;
    return { effect: EffectOp.OP_X, arg: (ee << 8) | aa };
  }
  // S's sub-command nibble is the 8 of `S $8aaa`; a stereo song only ever
  // fills the low byte, which is exactly what `S $80xx` means.
  return { effect: EffectOp.OP_S, arg: 0x8000 | (Math.round(az) & 0x1ff) };
}

// Whether either axis is still where a song that never touched it would leave
// it. A header paints a resting axis quietly: what it is FOR is the lanes that
// have been moved, and eight identical `M3F00`s shouting across the top of the
// screen would bury the one lane that says something else.

/** Full volume — `M`'s own reset value, and the one a cue start restores. */
export function laneVolumeAtRest(vol, volMax) {
  return Math.round(vol) === Math.round(volMax);
}

/** Dead centre and ear level. Pan byte $80 and azimuth 128 are the same number
 *  by construction — 128 is the front of the 512-unit turn — so one test
 *  serves every surround model. */
export function lanePanAtRest(az, el) {
  return Math.round(az) === 128 && Math.round(el) === 0;
}
