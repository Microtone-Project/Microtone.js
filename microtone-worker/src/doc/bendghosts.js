// Bend ghosts — the pitch / volume / panning a BENDING effect leaves standing
// on a cell that displays nothing. A static mirror of the engine's row and
// tick arithmetic (src/engine/row.js applyTrackerRow, src/engine/effects.js
// applyEffectRow, src/engine/tick.js applyTrackerTick), in the same spirit as
// ditto.js: pure — no DOM, no engine instance, no audio.
//
// WHY. A slide's whole point is that the values it produces are never written
// down: `G $0080` under one note bends toward the next across rows that look
// empty, `D $0400` fades over rows that say nothing about volume, `P $0400`
// walks the pan away from wherever the channel was. This module reports, for
// every row a bend MOVED one of those three, the value in force at that row's
// TICK 0 — the number you would have to type into the cell to get the same
// sound there — so the grids can paint it in the ghost colour.
//
// WHERE THE ARITHMETIC COMES FROM. Everything that can be imported from the
// engine IS imported (the two slide integrators, the four pan writers, both
// column appliers, the DNV seed): a bend ghost that disagreed with the engine
// would be worse than no ghost at all, so the numbers are computed by the
// engine's own code wherever the engine's own code can be called with nothing
// but a voice-shaped object. What is left — the handful of `applyEffectRow`
// cases that arm a slide, and the slide half of `applyTrackerTick` — is
// translated case by case, each next to the line it mirrors.
//
// THREE DELIBERATE LIMITS, all of them the price of being static:
//
//  1. IT STARTS FROM A FRESH ENGINE, at whatever point it is started: the
//     state `TrackerState.reset` leaves behind — full note volume, centred
//     pan, no sounding note. Where it starts is the caller's to say.
//     `createBendSim` is a simulation that CARRIES across patterns, which is
//     what the Timeline runs: one per channel, down the cue list in order, so
//     a bend crossing a cue boundary goes on being reported. `bendGhosts` is
//     the one-shot — one pattern, from silence — which is all the Patterns
//     view can honestly do, since a pattern there belongs to no cue in
//     particular. Flow control (B / C / S $Bx) is followed by neither: the
//     cue list is read straight through, 0, 1, 2, …
//  2. THIS CHANNEL'S OWN COLUMN. Speed (A), pattern delay (S $Ex) and fine
//     pattern delay (S $6x) are read from the pattern being drawn, though the
//     engine resolves all three across every channel at once. A song that
//     drives its speed from another channel bends at a different rate than
//     the trail shows.
//  3. WHAT IS NOT MODELLED MAKES ITS AXIS UNKNOWN rather than wrong. `Q`'s
//     retrigger volume modifier and a metainstrument's per-layer volume and
//     placement are not simulated, so they switch that axis' ghosts off until
//     something states it outright again. Vibrato, tremolo, panbrello, tremor,
//     arpeggio and the envelopes are not "unknown" but genuinely absent: they
//     ride on top of a typed value exactly as they ride on top of a ghosted
//     one, so the cell's own number is the same either way.

import {
  EffectOp, clamp, FINETUNE_OFFSET,
  amigaSlideOnce, amigaSlideTick, linearFreqSlideOnce, linearFreqSlideTick,
  noteValToFreqHz, freqHzToNoteVal,
} from "../engine/tables.js";
import { resolveArg } from "../engine/effects.js";
import {
  applyVolColumn, applyPanColumn, applyPanColumnWide, rowVolumeFromDefault,
  narrowVolAxis,
} from "../engine/trigger.js";
import {
  SURROUND_STEREO, SURROUND_SPATIAL,
  applyPanSet, applyPanSlide, applyElevation, applyNotePanSet, applyNotePanSlide,
  applyNoteElevation, anglesFromSpatialArg, stepTowardTarget,
  wrapAzimuth, mirrorPanByte, voiceElevation,
} from "../engine/spatial.js";
import { VOLUME_MAX, VOLUME_MAX_WIDE, VOLUME_STEP_WIDE } from "../engine/constants.js";

/** Scratch [azimuth, elevation], the twin of effects.js's own `spatialArg`. */
const spatialArg = new Float64Array(2);
/** …and of tick.js's `spatialStep`. One row is simulated at a time. */
const spatialStep = new Float64Array(2);

// ── the shadow voice ─────────────────────────────────────────────────────────
// Every field carries its engine name, because the engine's own functions are
// handed this object: applyVolColumn / applyPanColumn / applyPanColumnWide and
// the whole spatial.js pan family write it in place, exactly as they write a
// real TrackerVoice. Nothing here is a copy of the engine's arithmetic; it is
// the state that arithmetic needs, and no more of it.
function shadowVoice(ts) {
  return {
    // pitch
    noteVal: 0x0000,
    amigaPeriod: -1.0,   // toneMode 1's integrator, seeded on first use
    linearFreq: -1.0,    // toneMode 2's, likewise
    slideMode: 0, slideArg: 0,
    tonePortaTarget: -1, tonePortaSpeed: 0,
    active: false,
    // volume — the NOTE axis only. `channel_vol` (M / N) is a second
    // multiplicative axis no column shows, so no cell could ghost it.
    noteVolume: ts.volMax, rowVolume: ts.volMax,
    volColSlideUp: 0, volColSlideDown: 0,
    // panning — both axes, since the mixer adds them and the position the
    // ghost reports is that sum (TAUD_NOTE_EFFECTS.md §4).
    channelPan: 0x80, rowPan: 32,
    panAzimuth: 128.0, panElevation: 0.0,
    notePan: 0, noteElevation: 0.0,
    panColSlideRight: 0, panColSlideLeft: 0,
    chanPanSlideRight: 0, chanPanSlideLeft: 0,
    spatialSlideActive: false, spatialTargetAz: 128.0, spatialTargetEl: 0.0,
    // effect memory, for the `$0000` recalls the slides live on
    mem: { d: 0, ef: 0, g: 0, k: 0, l: 0, p: 0, q: 0, z: 0 },
  };
}

/** The `ts`-shaped context the imported engine writers read. */
function shadowState(wide, surroundModel, toneMode) {
  return {
    wideCells: wide === true,
    surroundModel: surroundModel | 0,
    toneMode: toneMode & 3,
    volMax: wide ? VOLUME_MAX_WIDE : VOLUME_MAX,
    volStep: wide ? VOLUME_STEP_WIDE : 1,
  };
}

// ── blank-cell tests (the ghost rule: fill blanks, never overpaint) ──────────
const noteBlank = (row) => row.note === 0x0000;
const volBlank = (row) => row.volumeEff === 3 && row.volume === 0;
const panBlank = (ts, row) => (ts.wideCells
  ? row.panEff === 3 && row.azimuth === 0 && row.elevation === 0
  : row.panEff === 3 && row.pan === 0);

// ── what the grids paint ─────────────────────────────────────────────────────

/**
 * The panning ghost in the COLUMN's own units, so a view paints it as a plain
 * SET and reads back what it would mean typed there.
 *
 * The number is the position the note sounds at — `channel_pan + note_pan`,
 * the mixer's own sum (spatial.js voicePanByte / voiceAzimuth) minus the
 * per-tick modulators. A narrow column only reaches the front arc, so a
 * surround song's position folds onto it the way the stereo monitor folds it.
 */
function panGhostValue(ts, v) {
  if (ts.surroundModel === SURROUND_STEREO) {
    const pos = clamp(v.channelPan + v.notePan, 0, 0xff);
    return ts.wideCells ? pos : pos >> 2;
  }
  const az = wrapAzimuth(v.panAzimuth + v.notePan);
  return ts.wideCells ? Math.round(az) : mirrorPanByte(az) >> 2;
}

// ── the row pass ─────────────────────────────────────────────────────────────

/**
 * One effect slot, for the commands that move one of the three axes. Anything
 * absent from the switch cannot reach them: it either writes state no column
 * shows (M / N / V / W / T), modulates per tick around a value it leaves
 * standing (H / U / R / Y / I / J), or has nothing to do with them at all.
 *
 * Returns nothing; `st` and `v` carry everything out.
 */
function applyBendEffect(ts, st, v, op, rawArg) {
  switch (op) {
    case EffectOp.OP_A: {
      // effects.js OP_A — speed, which is how many ticks a slide gets per row.
      const tr = (rawArg >>> 8) & 0xff;
      if (tr !== 0) st.speed = tr;
      break;
    }
    case EffectOp.OP_D: {
      // effects.js OP_D — fine forms land at tick 0, coarse arms slideMode 5.
      const arg = resolveArg(rawArg, v.mem.d);
      if (rawArg !== 0) v.mem.d = arg;
      const hi = (arg >>> 8) & 0xff;
      const lo = hi & 0x0f;
      const hin = (hi >>> 4) & 0x0f;
      if (hi === 0xff || hi === 0xf0) {
        v.noteVolume = Math.min(v.noteVolume + 0xf * ts.volStep, ts.volMax); v.rowVolume = v.noteVolume;
      } else if (hin === 0xf && lo !== 0) {
        v.noteVolume = Math.max(v.noteVolume - lo * ts.volStep, 0); v.rowVolume = v.noteVolume;
      } else if (lo === 0xf && hin !== 0) {
        v.noteVolume = Math.min(v.noteVolume + hin * ts.volStep, ts.volMax); v.rowVolume = v.noteVolume;
      } else if (hin === 0 && lo !== 0) {
        v.slideMode = 5; v.slideArg = -lo;
      } else if (lo === 0 && hin !== 0) {
        v.slideMode = 5; v.slideArg = hin;
      }
      break;
    }
    case EffectOp.OP_E:
    case EffectOp.OP_F: {
      // effects.js OP_E / OP_F — the same command, mirrored. `$Fxxx` is a
      // one-shot at tick 0; anything else arms the per-tick integrator.
      const up = op === EffectOp.OP_F;
      const arg = resolveArg(rawArg, v.mem.ef);
      if (rawArg !== 0) v.mem.ef = arg;
      if ((arg & 0xf000) === 0xf000) {
        const mag = (arg & 0x0fff) * (up ? 1 : -1);
        let nv;
        if (ts.toneMode === 1) nv = amigaSlideOnce(v.noteVal, mag);
        else if (ts.toneMode === 2) nv = linearFreqSlideOnce(v.noteVal, mag);
        else nv = v.noteVal + mag;
        v.noteVal = clamp(nv, 0x20, 0xffff);
        v.amigaPeriod = -1.0;
        v.linearFreq = -1.0;
      } else {
        v.slideMode = up ? 2 : 1;
        v.slideArg = up ? arg : -arg;
        v.amigaPeriod = -1.0;
        v.linearFreq = -1.0;
      }
      break;
    }
    case EffectOp.OP_G: {
      // effects.js OP_G — the speed only; the TARGET is the note column's, set
      // in the row pass below.
      const arg = resolveArg(rawArg, v.mem.g);
      if (rawArg !== 0) v.mem.g = arg;
      v.tonePortaSpeed = arg;
      break;
    }
    case EffectOp.OP_K: {
      // effects.js OP_K — vibrato (no effect on noteVal) + volume slide.
      const raw = (rawArg >>> 8) & 0xff;
      const arg = raw !== 0 ? (v.mem.k = raw) : v.mem.k;
      const hi = (arg >>> 4) & 0xf;
      const lo = arg & 0xf;
      if (lo !== 0) v.volColSlideDown = lo;
      else if (hi !== 0) v.volColSlideUp = hi;
      break;
    }
    case EffectOp.OP_L: {
      // effects.js OP_L — porta continuation (speed out of G's memory) + slide.
      const raw = (rawArg >>> 8) & 0xff;
      const arg = raw !== 0 ? (v.mem.l = raw) : v.mem.l;
      const hi = (arg >>> 4) & 0xf;
      const lo = arg & 0xf;
      v.tonePortaSpeed = v.mem.g;
      if (lo !== 0) v.volColSlideDown = lo;
      else if (hi !== 0) v.volColSlideUp = hi;
      break;
    }
    case EffectOp.OP_P: {
      // effects.js OP_P — the CHANNEL pan axis, fine forms at tick 0.
      const arg = resolveArg(rawArg, v.mem.p);
      if (rawArg !== 0) v.mem.p = arg;
      const hi = (arg >>> 8) & 0xff;
      const lo = hi & 0x0f;
      const hin = (hi >>> 4) & 0x0f;
      if (hi === 0xff || hi === 0xf0) applyPanSlide(ts, v, -0xf);
      else if (hin === 0xf && lo !== 0) applyPanSlide(ts, v, lo);
      else if (lo === 0xf && hin !== 0) applyPanSlide(ts, v, -hin);
      else if (hin === 0 && lo !== 0) v.chanPanSlideRight = lo;
      else if (lo === 0 && hin !== 0) v.chanPanSlideLeft = hin;
      break;
    }
    case EffectOp.OP_Q: {
      // effects.js OP_Q — the retrigger's volume modifier walks noteVolume
      // across the row's ticks (applyRetrigVolMod). Not simulated: each
      // modifier is its own arithmetic and it runs off the retrigger's own
      // clock. The axis goes quiet rather than drifting wrong. `y === 0`
      // ignores the whole effect, memory included, exactly as the engine does.
      const arg = resolveArg(rawArg, v.mem.q);
      if (((arg >>> 8) & 0xf) !== 0) { v.mem.q = arg; st.volKnown = false; }
      break;
    }
    case EffectOp.OP_S: applyBendSEffect(ts, st, v, rawArg); break;
    case EffectOp.OP_X: {
      // effects.js OP_X — place the channel. An absolute statement, so it is
      // no bend: the row shows the position in its own argument.
      if (ts.surroundModel === SURROUND_STEREO) break;
      anglesFromSpatialArg(rawArg, spatialArg);
      applyPanSet(ts, v, spatialArg[0]);
      applyElevation(ts, v, spatialArg[1]);
      st.wrotePan = true;
      st.panKnown = true;
      break;
    }
    case EffectOp.OP_4:
      // effects.js OP_4 — where a Z slide is heading. Moves nothing by itself.
      if (ts.surroundModel === SURROUND_STEREO) break;
      anglesFromSpatialArg(rawArg, spatialArg);
      v.spatialTargetAz = spatialArg[0];
      v.spatialTargetEl = ts.surroundModel === SURROUND_SPATIAL ? spatialArg[1] : 0.0;
      break;
    case EffectOp.OP_Z: {
      // effects.js OP_Z — `$Ffxx` is the funk repeat (not spatial at all);
      // `$0xxx` arms the great-circle slide for this row.
      if ((rawArg & 0xf000) === 0xf000) break;
      if (ts.surroundModel === SURROUND_STEREO) break;
      const raw = rawArg & 0xfff;
      const arg = resolveArg(raw, v.mem.z);
      if (raw !== 0) v.mem.z = arg;
      if (arg !== 0) v.spatialSlideActive = true;
      break;
    }
  }
}

/** The `S` sub-commands that touch a ghosted axis or the row's tick count. */
function applyBendSEffect(ts, st, v, arg) {
  const sub = (arg >>> 12) & 0xf;
  const x = (arg >>> 8) & 0xf;
  switch (sub) {
    case 0x2:
      // effects.js applySEffect $2x — set finetune. A one-shot pitch delta
      // whose RESULT is nowhere on the row, so it ghosts like a fine slide.
      v.noteVal = clamp(v.noteVal + FINETUNE_OFFSET[x], 0x20, 0xffff);
      v.amigaPeriod = -1.0;
      v.linearFreq = -1.0;
      break;
    case 0x6: st.extraTicks += x; break;  // fine pattern delay — longer row
    case 0x8:
      // effects.js applySEffect $8 — S $80xx sets the channel pan outright.
      applyPanSet(ts, v, arg & (ts.surroundModel === SURROUND_STEREO ? 0xff : 0x1ff));
      st.wrotePan = true;
      st.panKnown = true;
      break;
    case 0xe:
      // Pattern delay: the row runs again, ticks and tick-0 events alike. The
      // engine gives it to the first channel that asks and does NOT let a
      // repetition re-arm it (effects.js sexWinningChannel, row.js advanceRow),
      // or the row would repeat for ever; `sexArmed` is that latch.
      if (!st.sexArmed) { st.sexArmed = true; st.delayRepeats = x; }
      break;
  }
}

/** The slide half of one tick > 0 (tick.js applyTrackerTick). */
function bendTick(ts, v) {
  if (!v.active) return; // tick.js skips an inactive voice before any of this

  // Pitch slides (E/F coarse).
  if (v.slideMode === 1 || v.slideMode === 2) {
    let nv;
    if (ts.toneMode === 1) nv = amigaSlideTick(v, v.slideArg);
    else if (ts.toneMode === 2) nv = linearFreqSlideTick(v, v.slideArg);
    else nv = v.noteVal + v.slideArg;
    v.noteVal = clamp(nv, 0x20, 0xffff);
  }

  // Tone portamento (G / L) — runs until it ARRIVES, command or no command.
  if (v.tonePortaTarget >= 0) {
    const target = v.tonePortaTarget;
    const sp = v.tonePortaSpeed;
    if (ts.toneMode === 2) {
      if (v.linearFreq < 0.0) v.linearFreq = noteValToFreqHz(v.noteVal);
      const targetFreq = noteValToFreqHz(target);
      const dir = targetFreq > v.linearFreq ? +1.0 : -1.0;
      v.linearFreq += dir * sp;
      if ((dir > 0 && v.linearFreq >= targetFreq) || (dir < 0 && v.linearFreq <= targetFreq)) {
        v.linearFreq = targetFreq;
        v.noteVal = target;
        v.tonePortaTarget = -1;
      } else {
        v.noteVal = clamp(freqHzToNoteVal(v.linearFreq), 0x20, 0xffff);
      }
      v.amigaPeriod = -1.0;
    } else {
      const delta = target > v.noteVal ? sp : -sp;
      v.noteVal += delta;
      if ((delta > 0 && v.noteVal >= target) || (delta < 0 && v.noteVal <= target)) {
        v.noteVal = target;
        v.tonePortaTarget = -1;
      }
      v.amigaPeriod = -1.0;  // porta works in linear noteVal space
      v.linearFreq = -1.0;
    }
  }

  // Volume slides (D coarse).
  if (v.slideMode === 5) {
    v.noteVolume = clamp(v.noteVolume + v.slideArg * ts.volStep, 0, ts.volMax);
    v.rowVolume = v.noteVolume;
  }
  // Vol-column slides (selectors 1/2, and K / L's nibbles).
  if (v.volColSlideUp !== 0) {
    v.noteVolume = Math.min(v.noteVolume + v.volColSlideUp, ts.volMax);
    v.rowVolume = v.noteVolume;
  }
  if (v.volColSlideDown !== 0) {
    v.noteVolume = Math.max(v.noteVolume - v.volColSlideDown, 0);
    v.rowVolume = v.noteVolume;
  }
  // The panning column slides the NOTE axis; P slides the CHANNEL axis.
  if (v.panColSlideRight !== 0) applyNotePanSlide(ts, v, v.panColSlideRight);
  if (v.panColSlideLeft !== 0) applyNotePanSlide(ts, v, -v.panColSlideLeft);
  if (v.chanPanSlideRight !== 0) applyPanSlide(ts, v, v.chanPanSlideRight);
  if (v.chanPanSlideLeft !== 0) applyPanSlide(ts, v, -v.chanPanSlideLeft);
  if (v.spatialSlideActive) {
    stepTowardTarget(v.panAzimuth, v.panElevation, v.spatialTargetAz, v.spatialTargetEl,
      v.mem.z / 8, spatialStep);
    applyPanSet(ts, v, spatialStep[0]);
    v.panElevation = spatialStep[1];
  }
}

/**
 * "Instrument byte without retrigger" (row.js applyInstrumentChange): the note
 * volume goes back to the new record's default. A metainstrument has one per
 * layer, so the axis goes unknown instead.
 */
function reseedNoteVolume(ts, st, v, inst) {
  st.wroteVol = true;
  if (inst === null) {
    v.noteVolume = ts.volMax;
  } else if (inst.isMeta) {
    st.volKnown = false;
    st.panKnown = false;
    return;
  } else {
    const patch = inst.resolvePatch(v.noteVal, narrowVolAxis(ts, v.noteVolume));
    v.noteVolume = rowVolumeFromDefault(inst, patch, ts.volMax);
  }
  v.rowVolume = v.noteVolume;
  st.volKnown = true;
}

/**
 * Seed the two instrument-owned axes on a trigger, the way triggerNote does
 * (trigger.js: the `noteVolume` seed, then the note-pan block gated on the row
 * carrying an instrument byte). `inst` is a decoded TaudInst, or null when the
 * caller has no instrument table to offer — a caller without one gets the
 * behaviour of a record that says nothing, which is also what a blank slot
 * does.
 */
function seedFromInstrument(ts, st, v, inst, instId, noteVal, volOverride) {
  // A metainstrument is several voices at once, each with its own default
  // volume and its own place: no single number describes the cell.
  if (instId !== 0 && inst !== null && inst.isMeta) {
    st.wroteVol = true;
    st.volKnown = false;
    st.panKnown = false;
    return;
  }
  // trigger.js's patch lookup takes the volume the trigger is ABOUT to have,
  // narrowed to the 6-bit axis an Ixmp zone is keyed on.
  const patch = instId !== 0 && inst !== null
    ? inst.resolvePatch(noteVal, volOverride >= 0
      ? narrowVolAxis(ts, volOverride)
      : rowVolumeFromDefault(inst, null))
    : null;

  if (volOverride >= 0) {
    v.noteVolume = clamp(volOverride, 0, ts.volMax);
    v.rowVolume = v.noteVolume;
    st.wroteVol = true;
    st.volKnown = true;
  } else if (instId !== 0) {
    // No instrument table to read: a record that says nothing means full
    // volume, which is the DNV sentinel's own meaning.
    v.noteVolume = inst === null ? ts.volMax : rowVolumeFromDefault(inst, patch, ts.volMax);
    v.rowVolume = v.noteVolume;
    st.wroteVol = true;
    st.volKnown = true;
  }
  // else: a note-only retrigger inherits the channel's note volume (trigger.js).

  if (instId === 0 || inst === null) return;
  // trigger.js's note-pan seed, verbatim in shape: a patch's per-zone pan wins,
  // else the pan envelope's 'p' bit gates the record's own, and pitch-pan
  // separation shifts whatever came out of that.
  const panEnvLoop = patch !== null && patch.panEnv !== null ? patch.panEnvLoop : inst.panEnvLoop;
  const patchPan = patch !== null && patch.defaultPan !== 0xff ? patch.defaultPan : null;
  if (patchPan !== null) {
    applyNotePanSet(ts, v, patchPan);
    st.wrotePan = true;
  } else if (((panEnvLoop >>> 7) & 1) !== 0) {
    if (ts.surroundModel === SURROUND_STEREO) {
      applyNotePanSet(ts, v, inst.defaultPan);
    } else {
      applyNotePanSet(ts, v, inst.defaultAzimuth);
      applyNoteElevation(ts, v, inst.defaultElevation);
    }
    st.wrotePan = true;
  }
  if (inst.pitchPanSeparation !== 0) {
    const noteDelta = (noteVal - inst.pitchPanCentre) / 4096.0;
    applyNotePanSlide(ts, v, Math.trunc(noteDelta * inst.pitchPanSeparation * 4.0));
    st.wrotePan = true;
  }
}

/**
 * Everything one row does at tick 0, in the engine's order: note, volume
 * column, panning column, first effect slot, second effect slot (row.js).
 */
function applyBendRow(ts, st, v, row, instruments) {
  // row.js "Reset per-row transient state" — every slide re-arms per row. The
  // portamento target does NOT: it is channel state that outlives the row,
  // which is why a G trail keeps going over rows carrying no command at all.
  v.slideMode = 0; v.slideArg = 0;
  v.volColSlideUp = 0; v.volColSlideDown = 0;
  v.panColSlideRight = 0; v.panColSlideLeft = 0;
  v.chanPanSlideRight = 0; v.chanPanSlideLeft = 0;
  v.spatialSlideActive = false;
  v.rowVolume = v.noteVolume;
  st.extraTicks = 0;
  if (!st.patternDelayActive) { st.sexArmed = false; st.delayRepeats = 0; }

  const instOf = (id) => (instruments !== null ? instruments[id] ?? null : null);
  const note = row.note;
  // row.js reads toneG off the FIRST slot only, and so does this.
  const toneG = row.effect === EffectOp.OP_G || row.effect === EffectOp.OP_L;
  const volOverride = row.volumeEff === 0 ? row.volume : -1;

  if (note === 0x0000) {
    const pitchFx = row.effect === EffectOp.OP_E || row.effect === EffectOp.OP_F ||
      row.effect === EffectOp.OP_G;
    if (row.instrment !== 0 && pitchFx && v.noteVal >= 0x20) {
      // Note 0 + instrument + a pitch effect triggers at the current pitch
      // (item 43), so the slide has something to move.
      v.active = true;
      v.tonePortaTarget = -1;
      seedFromInstrument(ts, st, v, instOf(row.instrment), row.instrment, v.noteVal, volOverride);
    } else if (row.instrment !== 0) {
      const inst = instOf(row.instrment);
      if (inst !== null && inst.isMeta) {
        // row.js latches nothing for a meta on a note-less row.
      } else {
        // Instrument byte alone: re-seed the note volume from the new record's
        // default without retriggering (row.js applyInstrumentChange).
        reseedNoteVolume(ts, st, v, inst);
      }
    }
  } else if (note === 0x0002) {
    // Note cut. The engine ramps the voice out; nothing it was bending is
    // audible afterwards, so the trail stops here rather than sliding on in
    // silence. (A key-off, 0x0001, keeps sounding through its release and
    // keeps its trail.)
    v.active = false;
  } else if (note >= 0x0020) {
    if (toneG && v.active) {
      // Tone porta: the note is the TARGET, and no sample retriggers.
      v.tonePortaTarget = clamp(note, 0x20, 0xffff);
      // An instrument byte on a porta row reloads the default volume without
      // retriggering, same call as the note-less row above (row.js).
      if (row.instrment !== 0) reseedNoteVolume(ts, st, v, instOf(row.instrment));
    } else {
      // A fresh trigger. Pitch is simulated in WRITTEN-note space: a
      // metainstrument's foreground sounds layer 0's detune above the written
      // note, and that offset is constant, so the trail reads as the notes a
      // composer would type — which is the space the note column is in.
      v.noteVal = note;
      v.amigaPeriod = -1.0;
      v.linearFreq = -1.0;
      v.tonePortaTarget = -1;
      v.active = true;
      st.wrotePitch = true;
      seedFromInstrument(ts, st, v, instOf(row.instrment), row.instrment, note, volOverride);
    }
  }
  // Sentinels 0x0001 / 0x0003 / 0x0004 and the Int markers move none of the
  // three axes; they are left to run their trails out.

  applyVolColumn(ts, v, row.volume, row.volumeEff);
  if (ts.wideCells) applyPanColumnWide(ts, v, row);
  else applyPanColumn(ts, v, row.pan, row.panEff);
  // A column SET states its axis outright, which is also how an axis that
  // something unsimulated had put out of reach comes back.
  if (row.volumeEff === 0) st.volKnown = true;
  if (row.panEff === 0) st.panKnown = true;

  applyBendEffect(ts, st, v, row.effect, row.effectArg);
  if (ts.wideCells && row.effect2 !== 0) {
    applyBendEffect(ts, st, v, row.effect2, row.effectArg2);
  }
}

/**
 * The row the ENGINE plays on a pattern-ditto-covered row — row.js's own
 * expansion, not ditto.js's display map. The two agree on every column but
 * one: on the ARMING row the engine suppresses the `7` and plays the source's
 * effect, where the display keeps showing the command the user typed. A trail
 * has to follow what SOUNDS, so it reads the engine's rule; blankness still
 * falls out the same way, because every OTHER column inherits exactly where
 * the display says it does.
 *
 * `ghost` is the dittoGhosts entry, used only for the source row it names.
 */
function effectiveRow(ts, pattern, r, ghost) {
  const raw = pattern[r];
  if (!ghost) return raw;
  const src = pattern[ghost.srcRow];
  const isArmer = raw.effect === EffectOp.OP_7 && raw.effectArg !== 0;
  const volIsSet = !(raw.volumeEff === 3 && raw.volume === 0);
  const panIsSet = ts.wideCells
    ? !(raw.panEff === 3 && raw.azimuth === 0 && raw.elevation === 0)
    : !(raw.panEff === 3 && raw.pan === 0);
  const destOp = isArmer ? 0 : raw.effect;
  const destArg = isArmer ? 0 : raw.effectArg;
  let effOp, effArg;
  if (destOp !== 0) { effOp = destOp; effArg = destArg; }
  else if (src.effect !== EffectOp.OP_7) { effOp = src.effect; effArg = src.effectArg; }
  else { effOp = 0; effArg = 0; }
  const usedSrc = destOp === 0 && effOp !== 0;
  return {
    note: raw.note !== 0x0000 ? raw.note : src.note,
    instrment: raw.instrment !== 0 ? raw.instrment : src.instrment,
    volume: volIsSet ? raw.volume : src.volume,
    volumeEff: volIsSet ? raw.volumeEff : src.volumeEff,
    pan: panIsSet ? raw.pan : src.pan,
    panEff: panIsSet ? raw.panEff : src.panEff,
    azimuth: panIsSet ? raw.azimuth : src.azimuth,
    elevation: panIsSet ? raw.elevation : src.elevation,
    effect: effOp,
    effectArg: effArg,
    effect2: usedSrc ? src.effect2 : raw.effect2,
    effectArg2: usedSrc ? src.effectArg2 : raw.effectArg2,
  };
}

/**
 * Bend-ghost map for one pattern.
 *
 * @param {Array|null} pattern  TaudPlayData rows (null = unmaterialised gap)
 * @param {object} opts
 *   - rowLimit    rows the cue actually plays (default: the pattern's length)
 *   - speed       ticks per row at the pattern's first row (song tickRate)
 *   - toneMode    the song's global flags & 3 (0 linear · 1 Amiga · 2 Hz)
 *   - wide        format-v3 cells (8-bit volume, 9-bit azimuth column)
 *   - surroundModel  0 stereo · 1 planar · 2 spatial
 *   - instruments decoded TaudInst[] (doc.instruments), or null
 *   - ditto       a dittoGhosts() map for the same pattern, or null
 * @returns {Array<null|{note, vol, pan, elev}>} one entry per row; null where
 *   no bend has moved anything into view. Within an entry each field is null
 *   unless a bend put a value on that blank sub-column: `note` is a Taud note
 *   word, `vol` and `pan` are already in the column's own units, and `elev`
 *   rides with `pan` for a wide cell's second number.
 */
export function bendGhosts(pattern, opts = {}) {
  if (!pattern) return [];
  return createBendSim(opts).run(pattern, opts);
}

/**
 * A simulation that can be CARRIED ACROSS PATTERNS — what the Timeline needs,
 * because the song does not start again at a pattern boundary. A slide, a
 * portamento still travelling, the channel's volume and its panning all cross
 * the join, so the trail has to as well: the view builds one sim per channel
 * and runs the cue chain through it in order, and each pattern picks up
 * exactly where the one before it left off.
 *
 * (The Patterns view has no chain to run — a pattern can sit in any number of
 * cues, and which one is showing is not a question the view can answer — so it
 * runs a one-shot `bendGhosts` and starts from silence. That difference is
 * inherent, and it is why the two views can disagree about the first rows of a
 * pattern.)
 *
 * @param {object} opts  the same options bendGhosts takes, minus the per-run
 *   `rowLimit` / `ditto`, which `run` takes instead.
 */
export function createBendSim(opts = {}) {
  const {
    speed = 6, toneMode = 0, wide = false,
    surroundModel = 0, instruments = null,
  } = opts;

  const ts = shadowState(wide, surroundModel, toneMode);
  const v = shadowVoice(ts);
  const st = {
    speed: speed > 0 ? speed : 6,
    extraTicks: 0, delayRepeats: 0, sexArmed: false, patternDelayActive: false,
    // Two axes can be put beyond reach by something this module does not
    // simulate; the third (pitch) simply has no value until a note sounds.
    volKnown: true, panKnown: true,
    wrotePitch: false, wroteVol: false, wrotePan: false,
  };
  // The previous row's tick-0 reading, which is what a ghost is measured
  // against. It crosses patterns with everything else — that is the whole
  // point of the sim outliving one call — so the first row of a pattern can
  // report a bend that started in the one before it.
  let prev = null;

  return {
    /**
     * Run one pattern through the sim and report its ghosts.
     *
     * @param {Array|null} pattern  TaudPlayData rows; null (an unmaterialised
     *   gap, or an empty cue slot) advances NOTHING — row.js skips a channel
     *   whose cue slot is empty before it resets any per-row state, so the
     *   voice simply rings on with everything it was holding.
     * @param {object} runOpts  `rowLimit` (rows the cue plays) and `ditto`
     *   (that pattern's dittoGhosts map, or null).
     */
    run(pattern, runOpts = {}) {
      if (!pattern) return [];
      const { rowLimit = pattern.length, ditto = null } = runOpts;
      const out = new Array(pattern.length).fill(null);
      const n = Math.min(rowLimit, pattern.length);

      for (let r = 0; r < n; r++) {
        const row = effectiveRow(ts, pattern, r, ditto?.[r] ?? null);
        st.wrotePitch = false; st.wroteVol = false; st.wrotePan = false;

        applyBendRow(ts, st, v, row, instruments);

        // Tick 0 is now in force: this is the state a cell on this row says.
        const cur = {
          pitch: v.noteVal,
          vol: v.noteVolume,
          pan: panGhostValue(ts, v),
          elev: Math.round(voiceElevation(v)),
        };
        if (prev !== null) {
          const g = { note: null, vol: null, pan: null, elev: 0 };
          if (noteBlank(row) && v.active && v.noteVal >= 0x20 &&
              !st.wrotePitch && cur.pitch !== prev.pitch) {
            g.note = cur.pitch;
          }
          if (volBlank(row) && st.volKnown && !st.wroteVol && cur.vol !== prev.vol) {
            g.vol = cur.vol;
          }
          if (panBlank(ts, row) && st.panKnown && !st.wrotePan &&
              (cur.pan !== prev.pan || cur.elev !== prev.elev)) {
            g.pan = cur.pan;
            g.elev = cur.elev;
          }
          if (g.note !== null || g.vol !== null || g.pan !== null) out[r] = g;
        }
        prev = cur;

        // …and the rest of the row's ticks, which is where a coarse slide
        // moves. A pattern delay replays the whole row, tick-0 events and all
        // (row.js advanceRow), so the trail sees every repetition.
        for (;;) {
          const ticks = Math.max(st.speed + st.extraTicks, 1);
          for (let t = 1; t < ticks; t++) bendTick(ts, v);
          if (st.delayRepeats <= 0) break;
          st.delayRepeats--;
          st.patternDelayActive = true;
          applyBendRow(ts, st, v, row, instruments);
        }
        st.patternDelayActive = false;
      }
      return out;
    },
  };
}

/**
 * The per-document half of `bendGhosts`' options — everything that is the same
 * for every pattern in a song, so a view builds it once per draw.
 */
export function bendContext(doc, song) {
  return {
    speed: song?.tickRate ?? 6,
    toneMode: (song?.globalFlags ?? 0) & 3,
    wide: doc?.wideCells === true,
    surroundModel: song?.surroundModel ?? 0,
    instruments: doc?.instruments ?? null,
  };
}
