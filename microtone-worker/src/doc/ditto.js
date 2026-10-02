// Pattern-Ditto (effect 7) display expansion — a STATIC mirror of the engine's
// row-time expansion in core/engine/row.js applyTrackerRow, used only to paint
// the would-be-repeated cells in a ghost colour. Pure: no DOM, no engine state.
//
// The engine copies, per covered row, every sub-column the destination row
// leaves empty from the ditto's source row. This module reports exactly those
// inherited values so the grids can show what will actually sound.
//
// ONE DELIBERATE DIVERGENCE from the engine: on the ARMING row (the one
// carrying the 7$llrr command) the engine suppresses the ditto opcode and
// inherits the source's effect instead — but that cell is real content the
// user typed, so the fx ghost is only reported where the fx column DISPLAYS
// empty (effect 0 + arg 0). Everything visible stays truthful; the ghosts only
// ever fill blanks.

import { EffectOp } from "../../core/engine/tables.js";

export const OP_DITTO = EffectOp.OP_7;

/** True for the vol-/pan-column "no-op" sentinel (SEL_FINE with value 0). */
function isNoOp(value, eff) { return eff === 3 && value === 0; }

/**
 * Ghost map for one pattern.
 *
 * @param {Array|null} pattern  TaudPlayData rows (null = unmaterialised gap)
 * @param {number} rowLimit     rows the cue actually plays (engine clamp)
 * @returns {Array<null|{srcRow, note, inst, vol, pan, fx}>} one entry per row;
 *   null when the row is outside every ditto region. Within an entry each
 *   field is null unless that sub-column is inherited from `srcRow`
 *   (vol/pan/fx carry [value, eff] / [effect, arg] pairs).
 */
export function dittoGhosts(pattern, rowLimit = 64) {
  if (!pattern) return [];
  const out = new Array(pattern.length).fill(null);
  const n = Math.min(rowLimit, pattern.length);

  let active = false, srcStart = 0, len = 0, endRow = 0;
  for (let r = 0; r < n; r++) {
    const raw = pattern[r];
    // ── arm (row.js:31-43) ──
    const isArmer = raw.effect === OP_DITTO && raw.effectArg !== 0;
    if (isArmer) {
      const l = (raw.effectArg >>> 8) & 0xff;
      const repeats = raw.effectArg & 0xff;
      if (l > 0 && repeats > 0 && l <= r) {
        srcStart = r - l;
        len = l;
        endRow = Math.min(r + l * repeats - 1, n - 1);
        active = true;
      }
      // else: malformed — leave a previously-armed ditto alone.
    }
    if (!active) continue;
    // ── covered? (row.js:45-47) — the arming row is itself the first repeat ──
    if (r < srcStart + len || r > endRow) continue;

    const srcRow = srcStart + ((r - srcStart) % len);
    const src = pattern[srcRow];
    const g = { srcRow, note: null, inst: null, vol: null, pan: null, fx: null };
    if (raw.note === 0x0000 && src.note !== 0x0000) g.note = src.note;
    if (raw.instrment === 0 && src.instrment !== 0) g.inst = src.instrment;
    if (isNoOp(raw.volume, raw.volumeEff) && !isNoOp(src.volume, src.volumeEff)) {
      g.vol = [src.volume, src.volumeEff];
    }
    if (isNoOp(raw.pan, raw.panEff) && !isNoOp(src.pan, src.panEff)) {
      g.pan = [src.pan, src.panEff];
    }
    if (raw.effect === 0 && raw.effectArg === 0 &&
        src.effect !== 0 && src.effect !== OP_DITTO) {
      g.fx = [src.effect, src.effectArg];
    }
    out[r] = g;
  }
  return out;
}
