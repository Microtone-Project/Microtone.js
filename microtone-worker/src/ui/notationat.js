// Which notation a cell's note is spelled and typed in (item 374).
//
// A song has a notation; a lane may have its own, and so may an instrument
// (store.notationFor: instrument, else lane, else song). A note cell that
// names no instrument is played by the last one named above it in its
// pattern — a Taud pattern is one lane's sixty-four rows, so that walk never
// leaves the lane — which is the rule pitchtables.js surveyTuning already
// uses for percussion. Above the pattern's first named instrument the note
// takes the lane's notation (or the song's).

/** rows → {gen, insts}: the instrument playing each row, per announcement. */
const running = new WeakMap();

/** The instrument playing row `row` of `rows` (one pattern), 0 when none is
 *  named at or above it. Cached until the next store announcement. */
export function runningInst(store, rows, row) {
  if (!rows) return 0;
  let c = running.get(rows);
  if (!c || c.gen !== store.gen) {
    const insts = new Uint16Array(rows.length);
    let cur = 0;
    for (let r = 0; r < rows.length; r++) {
      const i = rows[r]?.instrment ?? 0;
      if (i !== 0) cur = i;
      insts[r] = cur;
    }
    c = { gen: store.gen, insts };
    running.set(rows, c);
  }
  return c.insts[row] ?? 0;
}

/** The preset row `row` of `rows`, on lane `ch` (−1: no lane), is spelled
 *  in. `lead()`, when given, answers the instrument the lane came into the
 *  pattern with, for a row above the pattern's first; asked only then. */
export function cellNotation(store, ch, rows, row, lead = null) {
  if (!store.anyInstNotation()) return store.notationFor(ch, 0);
  let inst = runningInst(store, rows, row);
  if (inst === 0 && lead !== null) inst = lead();
  return store.notationFor(ch, inst);
}

/** The preset a note TYPED into row `row` is entered in: the current
 *  instrument's when the entry stamps it (edit.js does, unless a lyric goes
 *  on), else the instrument already playing there. */
export function entryNotation(store, ch, rows, row, currentInst, stamps = true) {
  const inst = currentInst > 0 && stamps ? currentInst : runningInst(store, rows, row);
  return store.notationFor(ch, inst);
}

/** song → {gen, lanes: Map(pattern → lane)}. */
const laneOfPat = new WeakMap();

/**
 * The lane pattern `pat` plays on in the open song — the first the cue sheet
 * puts it on — or −1 when no cue uses it. The Patterns view shows a pattern
 * with no lane around it, and spells it in that lane's notation.
 */
export function patternLane(store, pat) {
  const song = store.song;
  if (!song) return -1;
  let c = laneOfPat.get(song);
  if (!c || c.gen !== store.gen) {
    const lanes = new Map();
    const chans = store.doc?.channelCount ?? 0;
    for (const words of song.cues ?? []) {
      if (!words) continue;
      for (let ch = 0; ch < chans; ch++) {
        const p = (words[ch] ?? 0x7fff) & 0x7fff;
        if (p !== 0x7fff && !lanes.has(p)) lanes.set(p, ch);
      }
    }
    c = { gen: store.gen, lanes };
    laneOfPat.set(song, c);
  }
  return c.lanes.get(pat) ?? -1;
}

/**
 * What a transpose of pattern `pat` computes against: the notation of the lane
 * it plays on (or the song's), and each instrument's own where it has one —
 * so a 12-TET part in a 19-TET song moves by semitones. `raw` (the dialog's
 * Raw switch) is a plain shift in steps, whatever anything's notation.
 */
export function transposeNotations(store, pat, rawPreset = null) {
  if (rawPreset) return { preset: rawPreset, presetFor: null };
  const lane = patternLane(store, pat);
  const own = lane >= 0 ? store.laneNotationIndex(lane) : null;
  return {
    preset: own !== null ? store.presetOf(own) : store.pitchPreset,
    presetFor: (inst) => {
      const v = store.instNotationIndex(inst);
      return v !== null ? store.presetOf(v) : null;
    },
  };
}

/**
 * Retuning the song moves the notes written in the SONG's notation: every
 * slot an instrument with a notation of its own plays (`perc` gains them, as
 * a drum kit's are already there), and a predicate for the patterns only
 * lanes with their own notation play.
 */
export function retuneExclusions(store, perc) {
  const doc = store.doc;
  for (const s of doc.usedInstrumentSlots()) if (store.instNotationIndex(s) !== null) perc[s] = 1;
  const song = store.song;
  const chans = doc.channelCount ?? 0;
  const own = new Set(), songs = new Set();
  for (const words of song?.cues ?? []) {
    if (!words) continue;
    for (let ch = 0; ch < chans; ch++) {
      const p = (words[ch] ?? 0x7fff) & 0x7fff;
      if (p === 0x7fff) continue;
      (store.laneNotationIndex(ch) !== null ? own : songs).add(p);
    }
  }
  return own.size === 0 ? null : (p) => own.has(p) && !songs.has(p);
}
