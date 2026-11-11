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
// never move, and neither does a percussion instrument, whose pitch selects a
// drum. The instrument is the LANE's running one — the engine keeps it across
// pattern boundaries, so a pattern that sets none plays whatever came before.
//
// Tone portamento is read the way it sounds: a note on a G row is a glide
// target, and a note that glides into one within a beat is an ornament (a
// scoop or bend) — weak evidence of the key, and transposed with its target
// rather than as a scale degree of its own.
//
// Pure — no DOM. Mutates the song's cells; returns the [{pat, row, prev}] list
// restoreNotesOp inverts (via bulkNotesOp), so it is one undo step.

import { CUE_EMPTY, MAX_VOICES } from "../../core/format/taud-const.js";
import { harmoniseTranspose } from "../../core/tuning/harmonise.js";
import { quantiseNote } from "../../core/tuning/pitchtables.js";
import { cueInfo } from "./document.js";

const NOTE_FIRST_PITCH = 0x20;
const isNoteEnd = (n) => n >= 0x0001 && n <= 0x0004; // key-off, cut, fade, fast fade
/** The longest a note is assumed to ring with nothing to end it. */
const MAX_RING = 64;
/** Tone portamento (TAUD_NOTE_EFFECTS.md "G"): a note on a G row is a slide
 *  TARGET — the sounding note glides to it without being struck again. */
const FX_TONE_PORTA = 0x10;
/** How much an ornament (the start of a bend into the next note) counts as
 *  evidence of the key, relative to a note that is actually held. */
const ORNAMENT_WEIGHT = 0.25;

/** Metric weight of a row within its pattern: bar line, beat, off-beat — read
 *  off the song's own row highlights (beatPri / beatSec). */
export function beatWeight(row, rowsPerBeat = 4, barRows = rowsPerBeat * 4) {
  if (row % barRows === 0) return 1.5;
  if (row % rowsPerBeat === 0) return 1.2;
  return 1;
}

const isGlideTarget = (cell) => cell.effect === FX_TONE_PORTA || cell.effect2 === FX_TONE_PORTA;

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

/**
 * Collect the song's notes as the core wants them.
 * @param select `(pat, row) => boolean` — the cells to move
 * @returns { moving, fixed, cells: Map(id → {pat, row}) }
 */
export function collectHarmoniseInput(song, percSlots, select, { rowsPerBeat = 4, barRows = rowsPerBeat * 4 } = {}) {
  const movingById = new Map();
  const fixed = [];
  const cells = new Map();
  const placed = new Set();

  const entries = cueMap(song);
  const totalRows = entries.reduce((a, e) => Math.max(a, e.startRow + e.rowLimit), 0);

  /** Walk one lane's events in time order; `steps` yields {pat, row, t}.
   *  The engine keeps a lane's instrument across pattern boundaries, so the
   *  running instrument does too. */
  const walkLane = (lane, steps) => {
    let open = null; // the note currently ringing: {rec, owner, id}
    let inst = 0;
    const heardSeq = []; // pitched notes in order, for their melodic direction
    const close = (t) => {
      if (!open) return;
      open.rec.dur = Math.max(1, Math.min(MAX_RING, t - open.rec.t));
      open = null;
    };
    for (const { pat, row, t } of steps) {
      const cell = song.patterns[pat][row];
      if (cell.instrment !== 0) inst = cell.instrment;
      const note = cell.note;
      if (isNoteEnd(note)) { close(t); continue; }
      if (note < NOTE_FIRST_PITCH) continue;
      // A glide target that arrives within a beat of the note it slides from
      // makes that note an ORNAMENT — `[C#] [D G0080]` is a scoop into D, not a
      // C# — so the scoop counts for little and is later moved with its D.
      const prev = open;
      const glide = isGlideTarget(cell) && prev && t - prev.rec.t <= rowsPerBeat;
      close(t);
      const rec = { t, dur: MAX_RING, beat: beatWeight(row, rowsPerBeat, barRows) };
      const id = `${pat}:${row}`;
      if (glide) {
        prev.rec.w = ORNAMENT_WEIGHT;
        if (prev.owner) prev.owner.bendTo ??= id;
      }
      open = { rec, owner: null, id };
      if (percSlots && inst >= 1 && percSlots[inst]) continue; // a drum: its pitch picks the drum
      if (select(pat, row)) {
        let m = movingById.get(id);
        if (!m) {
          m = { id, pitch: note, lane, src: inst, occ: [] };
          movingById.set(id, m);
          cells.set(id, { pat, row });
        }
        m.occ.push(rec);
        open.owner = m;
        heardSeq.push({ pitch: note, rec: null, owner: m });
      } else {
        fixed.push(Object.assign(rec, { pitch: note, src: inst }));
        heardSeq.push({ pitch: note, rec, owner: null });
      }
    }
    if (open) open.rec.dur = Math.max(1, Math.min(MAX_RING, totalRows - open.rec.t));
    // A lane is one voice, so each note has a melodic direction: toward the next
    // note, or from the one before at the end of a line. Directional scales
    // (melodic minor, Rast) are read by it.
    for (let i = 0; i < heardSeq.length; i++) {
      const cur = heardSeq[i], next = heardSeq[i + 1], prev = heardSeq[i - 1];
      let dir = next ? Math.sign(next.pitch - cur.pitch) : 0;
      if (dir === 0 && prev) dir = Math.sign(cur.pitch - prev.pitch);
      if (cur.rec) cur.rec.dir = dir;
      else if (cur.owner.dir === undefined) cur.owner.dir = dir;
    }
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
    // To the nearest sixteenth (65536-TET): a format-3 cell holds it, and
    // a narrow one rounds it on the way out (TaudPlayData.getByte).
    const out = Math.min(Math.max(quantiseNote(note), NOTE_FIRST_PITCH), 0xffff);
    if (out !== cell.note) {
      changes.push({ pat, row, prev: cell.note });
      cell.note = out;
    }
  }
  return { changes, report };
}
