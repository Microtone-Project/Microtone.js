// Row processing + cue advance — port of AudioAdapter.kt applyTrackerRow (2948),
// advanceTrackerCue (4101), resetPatternLoopState (4117), advanceRow (4343).

import { PATTERN_EMPTY, NUM_PATTERNS, NUM_CUES } from "./constants.js";
import { EffectOp, clamp } from "./tables.js";
import { TaudPlayData, INST_GOBACK, INST_SKIP, INST_JUMP } from "./state.js";
import {
  triggerMetaOrNote, applyDuplicateCheck, maybeSpawnBackgroundForNNA,
  cutLayerChildren, applyVolColumn, applyPanColumn, applyPanColumnWide,
  narrowVolAxis,
} from "./trigger.js";
import { applyKeyLift, envPresent, envCarry, seedPfRole, pfIdxBox, pfTimeBox } from "./envelope.js";
import { startFastFade, startCutRamp } from "./sampler.js";
import { applyEffectRow } from "./effects.js";

/**
 * The argument an Int0..IntF marker on this row carries (item 181): the `:`
 * sharing the row, or 0 when there is none — an interrupt with nothing to say
 * still fires, it just says 0.
 *
 * Which `:`, when a wide cell holds two, is the one rule the format needs
 * here: **the first slot wins**. A row carrying only one `:` means the same
 * thing in either slot, so a composer never has to think about column order;
 * a row carrying two has to resolve somehow, and "the left one" is the rule a
 * reader can apply at a glance (the editor paints the losing cell red —
 * src/ui/notenames.js fxColonWarns). Format 1/2 has no second slot, so the
 * question cannot arise there and the first slot is simply the only slot.
 *
 * This reads the `:` WITHOUT consuming it: the same colon still extends a
 * J / O / 2 / 3 sharing the row, exactly as it would on a row with no
 * interrupt marker on it.
 */
function interruptArgOf(ts, row) {
  if (row.effect === EffectOp.OP_COLON) return row.effectArg & 0xffff;
  if (ts.wideCells && row.effect2 === EffectOp.OP_COLON) return row.effectArg2 & 0xffff;
  return 0;
}

/** S $Dxny (item 94, extended item 97): schedule the $n follow-up action at
 *  absolute tick $x+$y within the row (independent of whichever note-event
 *  branch deferred the trigger by $x, or fired it immediately when $x is 0,
 *  or — on a note-less row — deferred nothing at all, see the `note === 0`
 *  caller). No-op unless $y is nonzero — a zero $y never carries an action
 *  (TAUD_NOTE_EFFECTS.md "S $Dxny" table: "If $y is zero" has no action row).
 *  A schedule past the row's tick count self-discards: tick.js only fires on
 *  an exact tickInRow match, and row entry unconditionally resets
 *  noteActionTick to -1 before the next row's ticks can reach it — the same
 *  trick sDelayTick relies on. */
function scheduleDxnyAction(voice, row, delayTick) {
  if (row.effect !== EffectOp.OP_S || ((row.effectArg >>> 12) & 0xf) !== 0xd) return;
  const y = row.effectArg & 0xf;
  if (y === 0) return;
  voice.noteActionTick = delayTick + y;
  voice.delayedAction = (row.effectArg >>> 4) & 0xf;
}

export function applyTrackerRow(eng, ts, playhead) {
  const cue = eng.cueSheet[ts.cuePos];
  // Reset row-scope state before scanning channels.
  if (!ts.patternDelayActive) ts.sexWinningChannel = -1;
  ts.finePatternDelayExtra = 0;

  const channels = eng.channelCount();
  for (let vi = 0; vi < channels; vi++) {
    const patNum = cue.pattern(vi);
    if (patNum === PATTERN_EMPTY) continue;
    const patIdx = clamp(patNum, 0, NUM_PATTERNS - 1);
    const rawRow = eng.patternRead(patIdx)[ts.rowIndex];
    const voice = ts.voices[vi];

    // ── Pattern Ditto (effect 7) row-time expansion ──
    const n = ts.rowIndex;
    const isArmer = rawRow.effect === EffectOp.OP_7 && rawRow.effectArg !== 0;
    if (isArmer) {
      const length = (rawRow.effectArg >>> 8) & 0xff;
      const repeats = rawRow.effectArg & 0xff;
      if (length > 0 && repeats > 0 && length <= n) {
        const patLen = cue.rowLimit();
        voice.dittoSourceStart = n - length;
        voice.dittoLength = length;
        voice.dittoEndRow = Math.min(n + length * repeats - 1, patLen - 1);
        voice.dittoActive = true;
      }
      // else: malformed — leave previously-armed ditto state alone.
    }

    const dittoArmRow = voice.dittoSourceStart + voice.dittoLength;
    let row;
    if (voice.dittoActive && n >= dittoArmRow && n <= voice.dittoEndRow) {
      const rel = (n - voice.dittoSourceStart) % voice.dittoLength;
      const srcRow = voice.dittoSourceStart + rel;
      const src = eng.patternRead(patIdx)[srcRow];

      // Vol-/pan-column "no-op" sentinel is SEL_FINE (3) with value 0 — in a
      // wide cell the pan column's "value" is the azimuth AND the elevation.
      const volIsSet = !(rawRow.volumeEff === 3 && rawRow.volume === 0);
      const panIsSet = ts.wideCells
        ? !(rawRow.panEff === 3 && rawRow.azimuth === 0 && rawRow.elevation === 0)
        : !(rawRow.panEff === 3 && rawRow.pan === 0);

      const destOp = isArmer ? 0 : rawRow.effect;
      const destArg = isArmer ? 0 : rawRow.effectArg;
      let effOp, effArg;
      if (destOp !== 0) { effOp = destOp; effArg = destArg; }
      else if (src.effect !== EffectOp.OP_7) { effOp = src.effect; effArg = src.effectArg; }
      else { effOp = 0; effArg = 0; }

      row = new TaudPlayData();
      row.note = rawRow.note !== 0x0000 ? rawRow.note : src.note;
      row.instrment = rawRow.instrment !== 0 ? rawRow.instrment : src.instrment;
      row.volume = volIsSet ? rawRow.volume : src.volume;
      row.volumeEff = volIsSet ? rawRow.volumeEff : src.volumeEff;
      row.pan = panIsSet ? rawRow.pan : src.pan;
      row.panEff = panIsSet ? rawRow.panEff : src.panEff;
      row.azimuth = panIsSet ? rawRow.azimuth : src.azimuth;
      row.elevation = panIsSet ? rawRow.elevation : src.elevation;
      row.effect = effOp;
      row.effectArg = effArg;
      // The second effect follows the first: a ditto that inherits one command
      // inherits the pair the source row actually carried.
      const dittoUsedSrc = destOp === 0 && effOp !== 0;
      row.effect2 = dittoUsedSrc ? src.effect2 : rawRow.effect2;
      row.effectArg2 = dittoUsedSrc ? src.effectArg2 : rawRow.effectArg2;
    } else {
      row = rawRow;
    }

    // Reset per-row transient state.
    voice.cutAtTick = -1;
    voice.noteDelayTick = -1;
    voice.noteActionTick = -1;
    voice.delayedAction = -1;
    voice.slideMode = 0;
    voice.slideArg = 0;
    voice.arpActive = false;
    voice.tremorOn = 0;
    voice.vibratoActive = false;
    voice.tremoloActive = false;
    voice.panbrelloActive = false; // the offset itself is the tick pass's (tick.js)
    voice.retrigActive = false;
    voice.tempoSlideDir = 0;
    voice.wSlideDir = 0;
    voice.volColSlideUp = 0; voice.volColSlideDown = 0;
    voice.panColSlideRight = 0; voice.panColSlideLeft = 0;
    voice.chanPanSlideRight = 0; voice.chanPanSlideLeft = 0;
    voice.spatialSlideActive = false; // Z re-arms per row, like every other slide
    voice.nSlideDir = 0;
    voice.rowEffect = row.effect;
    voice.rowEffectArg = row.effectArg;
    // Row boundary: rebase rowVolume to the persistent noteVolume.
    voice.rowVolume = voice.noteVolume;

    // ── Note ──
    // OP_L also takes a porta target without retriggering (continues a G porta).
    const toneG = row.effect === EffectOp.OP_G || row.effect === EffectOp.OP_L;
    const note = row.note;
    const sDelayTick = row.effect === EffectOp.OP_S && ((row.effectArg >>> 12) & 0xf) === 0xd
      ? (row.effectArg >>> 8) & 0xf : 0;

    if (note === 0x0000) {
      const pitchFx = row.effect === EffectOp.OP_E || row.effect === EffectOp.OP_F ||
        row.effect === EffectOp.OP_G;
      if (row.instrment !== 0 && pitchFx && voice.noteVal >= 0x20) {
        // Note 0 + instrument + a pitch effect (E porta-down / F porta-up /
        // G tone-porta) TRIGGERS the note at the voice's current pitch, so the
        // slide has a sounding note to move — previously this only latched the
        // instrument and stayed silent (item 43; needs the same TSVM fix).
        applyDuplicateCheck(eng, ts, vi, row.instrment, voice.noteVal);
        maybeSpawnBackgroundForNNA(eng, ts, voice, vi);
        const trigVol = row.volumeEff === 0 ? row.volume : -1;
        triggerMetaOrNote(eng, ts, voice, vi, voice.noteVal, row.instrment, trigVol);
      } else if (row.instrment !== 0 && !eng.instruments[row.instrment].isMeta) {
        // No note + instrument byte: latch instrument, re-seed from its DNV
        // (PT/FT2/IT/Schism all do this; see AudioAdapter.kt:3050-3061).
        voice.instrumentId = row.instrment;
        const newInst = eng.instruments[voice.instrumentId];
        const newPatch = newInst.resolvePatch(voice.noteVal,
          narrowVolAxis(ts, voice.noteVolume));
        // applyActiveSample without retrigger (Schism csf_instrument_change).
        applyInstrumentChange(eng, ts, voice, newInst, newPatch);
      }
      // A note-less row has nothing for S$D's $x to trigger, but the $n
      // follow-up action still applies to whatever voice is already sounding
      // (TAUD_NOTE_EFFECTS.md: FastTracker Kxx → S $D00xx, OpenMPT :xy →
      // S $Dx1y — both act on the current note without a note column entry).
      scheduleDxnyAction(voice, row, sDelayTick);
    } else if (note === 0x0001) {
      // Key-off (sub-row delay via S$Dx defers it).
      if (sDelayTick > 0) {
        voice.noteDelayTick = sDelayTick; voice.delayedNote = 0x0001;
        voice.delayedInst = 0; voice.delayedVol = -1;
      } else {
        voice.keyOff = true;
        applyKeyLift(voice, eng.instruments[voice.instrumentId]);
      }
      scheduleDxnyAction(voice, row, sDelayTick);
    } else if (note === 0x0002) {
      if (sDelayTick > 0) {
        voice.noteDelayTick = sDelayTick; voice.delayedNote = 0x0002;
        voice.delayedInst = 0; voice.delayedVol = -1;
      } else {
        startCutRamp(voice);
        cutLayerChildren(ts, vi);
      }
      scheduleDxnyAction(voice, row, sDelayTick);
    } else if (note === 0x0004) {
      // Fast note-fade (SF2 exclusiveClass choke).
      if (sDelayTick > 0) {
        voice.noteDelayTick = sDelayTick; voice.delayedNote = 0x0004;
        voice.delayedInst = 0; voice.delayedVol = -1;
      } else {
        startFastFade(voice, playhead);
      }
      scheduleDxnyAction(voice, row, sDelayTick);
    } else if (note === 0x0003) {
      // IT-style note fade: fadeout without sustain release.
      if (sDelayTick > 0) {
        voice.noteDelayTick = sDelayTick; voice.delayedNote = 0x0003;
        voice.delayedInst = 0; voice.delayedVol = -1;
      } else {
        voice.noteFading = true;
      }
      scheduleDxnyAction(voice, row, sDelayTick);
    } else if (note >= 0x0005 && note <= 0x000f) {
      // reserved sentinel range, no engine handler
    } else if (note >= 0x0010 && note <= 0x001f) {
      // Int0..IntF: latch the interrupt, and the argument a `:` on the same row
      // hands it (item 181), for the host to drain. The marker itself produces
      // no sound and touches no voice state; every other column on the row —
      // instrument, volume, panning, a second effect — is the interrupt's
      // business not at all, and still does whatever it would ordinarily do.
      ts.pendingInterrupts |= 1 << (note - 0x0010);
      ts.interruptArgs[note - 0x0010] = interruptArgOf(ts, row);
    } else {
      if (toneG && voice.active) {
        // Tone porta: target the note, do not retrigger sample.
        //
        // `note` is the pattern's raw note word, but a metainstrument's
        // foreground voice does not sound it directly — triggerMetaOrNote /
        // triggerFmRack seed voice.noteVal from `note + layer0's own detune`
        // (or, when layer 0 is fixed-pitch, from a pitch that ignores `note`
        // entirely), so the target has to cross into that same coordinate or
        // the glide chases a point that is a whole detune away from where it
        // actually needs to land — arriving late if at all, so the NEXT G row
        // retargets it before it gets there and the bend never seems to stop
        // (item 176). An ordinary instrument's foreground carries no such
        // offset (metaForegroundDetune stays 0), so this is a no-op for it.
        voice.tonePortaTarget = voice.metaForeground && voice.layerFixedNote >= 0
          ? -1 // layer 0 is fixed-pitch: its note never tracked the trigger, so there is nothing to glide to
          : clamp(note + voice.metaForegroundDetune, 0x20, 0xffff);
        // Inst byte on a porta row reloads the default volume + clears fade state
        // without retriggering (Schism csf_instrument_change semantics), and
        // RE-ATTACKS the envelopes: the instrument byte is what makes a porta
        // row after a key-off audible again (item 124). FT2 runs its whole
        // retrigEnvelopeVibrato here — envelope playheads back to node 0,
        // sustain re-armed, fadeout reset — and only the sample position stays
        // put. Without the playhead half, a release that had already decayed
        // stayed decayed and swallowed the note.
        if (row.instrment !== 0 && !eng.instruments[row.instrment].isMeta) {
          // Envelope carry (item 169.1) applies to THIS re-attack too, and this
          // is the row shape it was asked for: a chain of notes tied by G, each
          // naming its instrument. Same disqualifiers as a fresh trigger — a
          // released note, or an instrument change — read before either is
          // overwritten below.
          const mayCarry = !voice.keyOff && !voice.noteFading
            && row.instrment === voice.instrumentId;
          voice.instrumentId = row.instrment;
          const newInst = eng.instruments[voice.instrumentId];
          const newPatch = newInst.resolvePatch(voice.noteVal,
            narrowVolAxis(ts, voice.noteVolume));
          applyInstrumentChange(eng, ts, voice, newInst, newPatch, true, mayCarry);
        }
      } else if (row.effect === EffectOp.OP_S && ((row.effectArg >>> 12) & 0xf) === 0xd) {
        // Note delay: defer trigger; NNA fires when the deferred trigger executes.
        voice.noteDelayTick = (row.effectArg >>> 8) & 0xf;
        voice.delayedNote = note;
        voice.delayedInst = row.instrment;
        // Only a SEL_SET vol cell is an override on the deferred trigger.
        voice.delayedVol = row.volumeEff === 0 ? row.volume : -1;
        scheduleDxnyAction(voice, row, sDelayTick);
      } else {
        applyDuplicateCheck(eng, ts, vi, row.instrment, note);
        maybeSpawnBackgroundForNNA(eng, ts, voice, vi);
        const trigVol = row.volumeEff === 0 ? row.volume : -1;
        triggerMetaOrNote(eng, ts, voice, vi, note, row.instrment, trigVol);
        scheduleDxnyAction(voice, row, sDelayTick);
      }
    }

    // ── Volume / pan columns ──
    applyVolColumn(ts, voice, row.volume, row.volumeEff);
    if (ts.wideCells) applyPanColumnWide(ts, voice, row);
    else applyPanColumn(ts, voice, row.pan, row.panEff);

    // ── Effect columns ──
    // A wide cell carries two, applied in order, so the second lands last where
    // both write the same channel state.
    //
    // Argument extension (item 162): a `:` in either slot is a modifier, not a
    // command of its own — it hands its argument to whichever OTHER effect
    // shares the row, order-independent ("J : " reads the same as ": J").
    // Format 1/2 has no second slot, so pairing is structurally impossible
    // there — the no-op the TODO requires falls out for free rather than
    // needing a format-version check inside every consumer.
    let ext1 = null, ext2 = null;
    if (ts.wideCells) {
      if (row.effect === EffectOp.OP_COLON && row.effect2 !== EffectOp.OP_COLON) {
        ext2 = row.effectArg;
      } else if (row.effect2 === EffectOp.OP_COLON && row.effect !== EffectOp.OP_COLON) {
        ext1 = row.effectArg2;
      }
    }
    applyEffectRow(eng, ts, playhead, voice, vi, row.effect, row.effectArg, ext1);
    if (ts.wideCells && row.effect2 !== 0) {
      applyEffectRow(eng, ts, playhead, voice, vi, row.effect2, row.effectArg2, ext2);
    }
  }
}

// Shared "instrument byte without retrigger" path (no-note-inst and porta+inst rows).
// `reAttack` additionally rewinds the four envelope playheads the way a fresh
// trigger does (triggerNote), WITHOUT touching the sample position — the porta
// row's half of FT2 retrigEnvelopeVibrato. A note-less instrument byte does not
// re-attack: FT2 leaves such a row decaying, and re-arming its sustain would
// hold a released note up for ever.
import { applyActiveSample, rowVolumeFromDefault } from "./trigger.js";
function applyInstrumentChange(eng, ts, voice, newInst, newPatch,
                              reAttack = false, mayCarry = false) {
  applyActiveSample(voice, newInst, newPatch);
  const seedVol = rowVolumeFromDefault(newInst, newPatch, ts.volMax);
  voice.noteVolume = seedVol;
  voice.rowVolume = seedVol;
  voice.keyOff = false;
  voice.noteFading = false;
  voice.fadeoutVolume = 1.0;
  if (!reAttack) return;
  if (!(mayCarry && envCarry(voice.activeVolEnvLoop))) {
    voice.envIndex = 0;
    voice.envTimeSec = 0.0;
    voice.envVolume = clamp(voice.activeVolEnv[0].value / 63.0, 0.0, 1.0);
  }
  // envVolMix is deliberately NOT snapped here (item 142). This re-attack does
  // not restart the sample and arms no attack ramp, so snapping the smoothed
  // envelope steps the gain mid-waveform — a tone portamento onto a note whose
  // envelope starts below where the last one had got to clicks, every time. The
  // per-sample glide (envVolStep, re-armed each tick) walks it to node 0
  // instead. A FRESH trigger still snaps, in triggerNote, because there the
  // sample restarts from zero and the attack ramp covers the discontinuity.
  voice.hasPanEnv = envPresent(voice.activePanEnvLoop);
  if (!(mayCarry && envCarry(voice.activePanEnvLoop))) {
    voice.envPanIndex = 0;
    voice.envPanTimeSec = 0.0;
    voice.envPan = voice.activePanEnv[0].value / 255.0;
  }
  // Pitch / filter envelope seeds — settle past leading zero-duration nodes.
  if (!voice.hasPitchEnv) {
    voice.envPitchValue = 0.5; voice.envPitchIndex = 0; voice.envPitchTimeSec = 0.0;
  } else if (!(mayCarry && envCarry(voice.activePitchEnvLoop))) {
    voice.envPitchValue = seedPfRole(voice.activePitchEnv, voice.activePitchEnvLoop,
      voice.activePitchEnvSustain);
    voice.envPitchIndex = pfIdxBox[0];
    voice.envPitchTimeSec = pfTimeBox[0];
  }
  if (!voice.hasFilterEnv) {
    voice.envFilterValue = 0.5; voice.envFilterIndex = 0; voice.envFilterTimeSec = 0.0;
  } else if (!(mayCarry && envCarry(voice.activeFilterEnvLoop))) {
    voice.envFilterValue = seedPfRole(voice.activeFilterEnv, voice.activeFilterEnvLoop,
      voice.activeFilterEnvSustain);
    voice.envFilterIndex = pfIdxBox[0];
    voice.envFilterTimeSec = pfTimeBox[0];
  }
}

export function advanceTrackerCue(eng, ts, playhead) {
  const cue = eng.cueSheet[ts.cuePos];
  if (cue.isHalt()) { playhead.isPlaying = false; return; }
  const instr = cue.flowInstruction();
  switch (instr.type) {
    case INST_GOBACK: ts.cuePos = Math.max(ts.cuePos - instr.arg, 0); break;
    case INST_SKIP: ts.cuePos = Math.min(ts.cuePos + instr.arg, NUM_CUES - 1); break;
    case INST_JUMP: ts.cuePos = clamp(instr.arg, 0, NUM_CUES - 1); break;
    default: ts.cuePos = Math.min(ts.cuePos + 1, NUM_CUES - 1); break;
  }
  playhead.position = ts.cuePos;
}

/**
 * Rebuild each voice's Pattern-Ditto (effect 7) arm state as if the current
 * cue's pattern had been played from row 0 up to (but NOT including) startRow.
 * This lets playback that STARTS mid-pattern on a ghosted (repeated) row still
 * sound it — the ghost cells are painted from the same static expansion but the
 * engine only re-derives them at play time once dittoActive is set on the
 * arming row, so seeking past the arm left the ghosts silent (item 81).
 *
 * Faithful mirror of the arm branch in applyTrackerRow (reads RAW rows only, so
 * cascaded/re-armed regions resolve exactly like the running engine); call it
 * right after the play-time voice reset in setTrackerRow. [needs the same TSVM
 * + taut.js fix].
 */
export function reconstructDittoState(eng, ts, startRow) {
  const cue = eng.cueSheet[ts.cuePos];
  const patLen = cue.rowLimit();
  const limit = Math.min(startRow, patLen);
  const channels = eng.channelCount();
  for (let vi = 0; vi < channels; vi++) {
    const voice = ts.voices[vi];
    voice.dittoActive = false;
    voice.dittoSourceStart = 0;
    voice.dittoLength = 0;
    voice.dittoEndRow = 0;
    const patNum = cue.pattern(vi);
    if (patNum === PATTERN_EMPTY) continue;
    const patIdx = clamp(patNum, 0, NUM_PATTERNS - 1);
    const rows = eng.patternRead(patIdx);
    for (let n = 0; n < limit; n++) {
      const rawRow = rows[n];
      if (rawRow.effect !== EffectOp.OP_7 || rawRow.effectArg === 0) continue;
      const length = (rawRow.effectArg >>> 8) & 0xff;
      const repeats = rawRow.effectArg & 0xff;
      if (length > 0 && repeats > 0 && length <= n) {
        voice.dittoSourceStart = n - length;
        voice.dittoLength = length;
        voice.dittoEndRow = Math.min(n + length * repeats - 1, patLen - 1);
        voice.dittoActive = true;
      }
      // else: malformed — leave a previously-armed ditto alone.
    }
  }
}

/** Per-pattern voice state reset (S$Bx loop counters + ditto), on every cue advance. */
export function resetPatternLoopState(ts) {
  for (const voice of ts.voices) {
    voice.loopStartRow = 0;
    voice.loopCount = 0;
    voice.dittoActive = false;
    voice.dittoSourceStart = 0;
    voice.dittoLength = 0;
    voice.dittoEndRow = 0;
  }
}

/**
 * Advance to the next row: resolves pending B/C jumps and pattern-delay repeats.
 * Called once when tickInRow has just wrapped past tickRate.
 */
export function advanceRow(eng, ts, playhead) {
  // Pattern delay (S$Ex): replay the same row patternDelayRemaining more times.
  if (ts.patternDelayRemaining > 0) {
    ts.patternDelayRemaining--;
    ts.patternDelayActive = true;
    applyTrackerRow(eng, ts, playhead);
    return;
  }
  ts.patternDelayActive = false;

  const pendingB = ts.pendingOrderJump;
  const pendingC = ts.pendingRowJump;
  const pendingLocal = ts.pendingRowJumpLocal;
  ts.pendingOrderJump = -1;
  ts.pendingRowJump = -1;
  ts.pendingRowJumpLocal = false;

  if (pendingB >= 0) {
    ts.cuePos = Math.min(pendingB, NUM_CUES - 1);
    ts.rowIndex = pendingC >= 0 ? pendingC : 0;
    playhead.position = ts.cuePos;
    resetPatternLoopState(ts);
  } else if (pendingC >= 0 && pendingLocal) {
    // S$Bx pattern loop — stay in the current cue, rewind the row.
    ts.rowIndex = clamp(pendingC, 0, 63);
  } else if (pendingC >= 0) {
    // C$xx pattern break — advance cue then jump to row.
    advanceTrackerCue(eng, ts, playhead);
    ts.rowIndex = clamp(pendingC, 0, 63);
    resetPatternLoopState(ts);
  } else {
    ts.rowIndex++;
    // LEN / "halt at x" shorten the effective row count.
    const rowLimit = eng.cueSheet[ts.cuePos].rowLimit();
    if (ts.rowIndex >= rowLimit) {
      ts.rowIndex = 0;
      advanceTrackerCue(eng, ts, playhead);
      resetPatternLoopState(ts);
    }
  }
  applyTrackerRow(eng, ts, playhead);
}
