// Harmonic transposition over a SONG — the walker that turns cues × lanes ×
// pattern rows into the timed notes core/tuning/harmonise.js reasons about.
//
// A Taud pattern belongs to one lane and can be placed by many cues, so one
// cell may sound several times against different accompaniment. The walker
// therefore collects, per cell to be moved, every OCCURRENCE (absolute song
// row, how long it rings, how strong the beat is) and hands them over as one
// note: the cell can only be written one way, so its choice is judged against
// all the places it is heard. Everything that is not being moved — other lanes,
// other rows of the same lanes — is the accompaniment: evidence for the key and
// what clashes are measured against.
//
// Skip rules are the ordinary transpose's: sentinels and interrupts (< 0x20)
// never move, and neither does a percussion instrument (running-instrument
// inheritance from row 0 of the pattern), whose pitch selects a drum.
//
// Pure — no DOM. Mutates the song's cells; returns the [{pat, row, prev}] list
// restoreNotesOp inverts (via bulkNotesOp), so it is one undo step.

import { CUE_EMPTY, MAX_VOICES } from "../../core/format/taud-const.js";
import { harmoniseTranspose } from "../../core/tuning/harmonise.js";
import { cueInfo } from "./document.js";

const NOTE_FIRST_PITCH = 0x20;
const isNoteEnd = (n) => n >= 0x0001 && n <= 0x0004; // key-off, cut, fade, fast fade
/** The longest a note is assumed to ring with nothing to end it. */
const MAX_RING = 64;

/** Metric weight of a row within its pattern: bar line, beat, off-beat. */
export function beatWeight(row, rowsPerBeat = 4) {
  if (row % (rowsPerBeat * 4) === 0) return 1.5;
  if (row % rowsPerBeat === 0) return 1.2;
  return 1;
}

/** The song's linear cue map: [{cue, startRow, rowLimit}] (Song.songMap when
 *  the object has one, so plain test fixtures can supply theirs). */
function cueMap(song) {
  if (typeof song.songMap === "function") return song.songMap().entries;
  const entries = [];
  let startRow = 0;
  for (let c = 0; c < (song.cues?.length ?? 0); c++) {
    const rowLimit = cueInfo(song.cues[c]).rowLimit;
    entries.push({ cue: c, startRow, rowLimit });
    startRow += rowLimit;
  }
  return entries;
}

/** Per-row percussion flags of a pattern (running instrument from row 0). */
function percussionRows(ptn, percSlots) {
  const out = new Uint8Array(ptn.length);
  if (!percSlots) return out;
  let running = 0;
  for (let r = 0; r < ptn.length; r++) {
    if (ptn[r].instrment !== 0) running = ptn[r].instrment;
    if (running >= 1 && percSlots[running]) out[r] = 1;
  }
  return out;
}

/**
 * Collect the song's notes as the core wants them.
 * @param select `(pat, row) => boolean` — the cells to move
 * @returns { moving, fixed, cells: Map(id → {pat, row}) }
 */
export function collectHarmoniseInput(song, percSlots, select, { rowsPerBeat = 4 } = {}) {
  const percCache = new Map();
  const percOf = (p) => {
    if (!percCache.has(p)) percCache.set(p, percussionRows(song.patterns[p], percSlots));
    return percCache.get(p);
  };
  const movingById = new Map();
  const fixed = [];
  const cells = new Map();
  const placed = new Set();

  const entries = cueMap(song);
  const totalRows = entries.reduce((a, e) => Math.max(a, e.startRow + e.rowLimit), 0);

  /** Walk one lane's events in time order; `steps` yields {pat, row, t}. */
  const walkLane = (lane, steps) => {
    let open = null; // the note currently ringing: {rec, t}
    const close = (t) => {
      if (!open) return;
      open.rec.dur = Math.max(1, Math.min(MAX_RING, t - open.rec.t));
      open = null;
    };
    for (const { pat, row, t } of steps) {
      const note = song.patterns[pat][row].note;
      if (isNoteEnd(note)) { close(t); continue; }
      if (note < NOTE_FIRST_PITCH) continue;
      close(t);
      const rec = { t, dur: MAX_RING, beat: beatWeight(row, rowsPerBeat) };
      open = { rec };
      if (percOf(pat)[row]) continue; // a drum: neither moved nor heard as pitch
      if (select(pat, row)) {
        const id = `${pat}:${row}`;
        let m = movingById.get(id);
        if (!m) {
          m = { id, pitch: note, lane, occ: [] };
          movingById.set(id, m);
          cells.set(id, { pat, row });
        }
        m.occ.push(rec);
      } else {
        fixed.push(Object.assign(rec, { pitch: note }));
      }
    }
    if (open) open.rec.dur = Math.max(1, Math.min(MAX_RING, totalRows - open.rec.t));
  };

  for (let ch = 0; ch < MAX_VOICES; ch++) {
    const steps = [];
    for (const e of entries) {
      const word = song.cues[e.cue]?.[ch];
      if (word === undefined || word === CUE_EMPTY) continue;
      const pat = word & 0x7fff;
      if (pat === CUE_EMPTY || !song.patterns[pat]) continue;
      placed.add(pat);
      for (let r = 0; r < e.rowLimit && r < song.patterns[pat].length; r++) {
        steps.push({ pat, row: r, t: e.startRow + r });
      }
    }
    if (steps.length) walkLane(ch, steps);
  }

  // A pattern no cue places (being written in the Patterns view before it is
  // arranged) still transposes: it is walked on its own, after the song ends,
  // where it overlaps nothing.
  let offset = totalRows + MAX_RING;
  for (let p = 0; p < song.patterns.length; p++) {
    const ptn = song.patterns[p];
    if (!ptn || placed.has(p)) continue;
    let any = false;
    for (let r = 0; r < ptn.length && !any; r++) any = select(p, r);
    if (!any) continue;
    walkLane(`pat${p}`, ptn.map((_, r) => ({ pat: p, row: r, t: offset + r })));
    offset += ptn.length + MAX_RING;
  }

  return { moving: [...movingById.values()], fixed, cells };
}

/**
 * Harmonically transpose the selected cells of `song` (mutating them).
 * `opts` carries {fine, coarse} plus any HARMONISE_DEFAULTS override.
 * Returns { changes: [{pat, row, prev}], report }.
 */
export function harmoniseSongNotes(song, preset, percSlots, select, opts = {}) {
  const input = collectHarmoniseInput(song, percSlots, select, opts);
  const { pitches, report } = harmoniseTranspose(preset, input, opts);
  const changes = [];
  for (const [id, note] of pitches) {
    const { pat, row } = input.cells.get(id);
    const cell = song.patterns[pat][row];
    const out = Math.min(Math.max(Math.round(note), NOTE_FIRST_PITCH), 0xffff);
    if (out !== cell.note) {
      changes.push({ pat, row, prev: cell.note });
      cell.note = out;
    }
  }
  return { changes, report };
}
