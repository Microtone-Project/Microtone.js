// The chase (item 215, TAUD_ENGINE_SPEC.md §15.1) — how a play that starts at
// a row finds the song in the state a play from the start would have reached
// there: lane volume and panning, the colouring, the effect memory, the lane's
// instrument, the tempo, tick rate and global volume.
//
// It walks the song from its start and runs every row event and tick pass on
// the way, exactly as the mixer's clock runs them, and mixes nothing. That is
// the whole trick, and it is why nothing here knows any effect: whatever the
// row and tick passes write is chased, including what they will write later.
// Mixing nothing is also its one blind spot — a sample running out is the
// sampler's business, so a chased note sounds until the song ends it (a cut,
// a fade, a new note) and a slide the tick pass applies only to a sounding
// note can land on a lane whose sample had in fact run dry.
//
// The walk costs what the row and tick passes cost, about 10–15 µs a row on
// the demo songs: a few milliseconds to the middle of most songs, some tens
// to the end of a long one. test/node/chase.test.js holds the arrival state
// to a real render's.

import { NUM_CUES, PATTERN_EMPTY } from "./constants.js";
import { INST_NOP } from "./state.js";
import { applyTrackerRow, advanceRowPosition, resetPatternLoopState } from "./row.js";
import { applyTrackerTick, applyTickEvents, psgQuarterPass } from "./tick.js";

/**
 * How many rows chaseSongPath follows the song for before it gives up on it.
 * A song repeating itself through its cue order is caught long before this
 * (see the cue entries below); what is left is pattern loops (S $Bx) that
 * feed each other for ever, and those cost about a second to give up on.
 */
export const CHASE_ROW_BUDGET = 1 << 16;

/** One row: its event, then its tick passes and the events scheduled for each
 *  later tick — the mixer's clock, unmixed. */
function chaseRow(eng, ts, playhead) {
  applyTrackerRow(eng, ts, playhead);
  do {
    applyTrackerTick(eng, ts, playhead);
    // The tick's other three PSG quarters, which the mixer would have run.
    for (let q = 1; q <= 3; q++) psgQuarterPass(ts);
    ts.psgQuarter = 3;
    ts.tickInRow++;
    if (ts.tickInRow < playhead.tickRate + ts.finePatternDelayExtra) applyTickEvents(eng, ts, playhead);
  } while (ts.tickInRow < playhead.tickRate + ts.finePatternDelayExtra);
  ts.tickInRow = 0;
}

/** The last cue holding a pattern or an instruction, or -1. Past it every cue
 *  is silent and goes on to the next, so a path there never comes back. */
function lastUsedCue(eng) {
  const channels = eng.channelCount();
  for (let c = NUM_CUES - 1; c >= 0; c--) {
    const cue = eng.cueSheet[c];
    if (cue.inst0.type !== INST_NOP || cue.inst1.type !== INST_NOP) return c;
    for (let ch = 0; ch < channels; ch++) {
      if (cue.pattern(ch) !== PATTERN_EMPTY) return c;
    }
  }
  return -1;
}

/**
 * Follow the song's own path from cue 0 row 0 — jumps, pattern loops, pattern
 * delays and the cues' flow instructions all obeyed — and stop at the FIRST
 * arrival at (`cue`, `row`), before that row is applied. True when it got
 * there. False when the song never does: a halt cue ended it; it entered a
 * cue at a row it had entered it at before (nothing that decides the flow
 * outlives a cue change, so from there on it repeats for ever); it went past
 * the last cue holding anything while the target lies before it; or the
 * budget ran out. The playhead must be playing, so that a halt can say so.
 */
export function chaseSongPath(eng, ts, playhead, cue, row) {
  const last = lastUsedCue(eng);
  const entries = new Set([0]);
  for (let rows = 0; rows < CHASE_ROW_BUDGET; rows++) {
    if (ts.cuePos === cue && ts.rowIndex === row && !ts.patternDelayActive) return true;
    chaseRow(eng, ts, playhead);
    const fromCue = ts.cuePos;
    const jumps = ts.pendingOrderJump >= 0 ||
      (ts.pendingRowJump >= 0 && !ts.pendingRowJumpLocal);
    advanceRowPosition(eng, ts, playhead);
    if (!playhead.isPlaying) return false;
    if (ts.patternDelayActive || (!jumps && ts.cuePos === fromCue)) continue;
    if (ts.cuePos > last && cue <= last) return false;
    const entry = ts.cuePos * 64 + ts.rowIndex;
    if (entries.has(entry)) return false;
    entries.add(entry);
  }
  return false;
}

/**
 * The fallback, for a row the song's own path never reaches: the cues in
 * their order from the first, every row of each once. The cues' flow
 * instructions and halts and the B, C and S $Bx jumps are ignored; a pattern
 * delay still repeats its row, as it is not flow. Stops before (`cue`,
 * `row`), or at the end of `cue` when that row lies past it.
 */
export function chaseCueOrder(eng, ts, playhead, cue, row) {
  while (ts.cuePos < cue || ts.rowIndex < row) {
    chaseRow(eng, ts, playhead);
    ts.pendingOrderJump = -1;
    ts.pendingRowJump = -1;
    ts.pendingRowJumpLocal = false;
    if (ts.patternDelayRemaining > 0) {
      ts.patternDelayRemaining--;
      ts.patternDelayActive = true;
      continue;
    }
    ts.patternDelayActive = false;
    if (++ts.rowIndex < eng.cueSheet[ts.cuePos].rowLimit()) continue;
    if (ts.cuePos >= cue || ts.cuePos >= NUM_CUES - 1) return;
    ts.cuePos++;
    ts.rowIndex = 0;
    playhead.position = ts.cuePos;
    resetPatternLoopState(ts);
  }
}
