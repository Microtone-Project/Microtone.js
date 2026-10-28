// Pattern to sample (item 242) — ProTracker's PAT2SMP, the other Amiga trick:
// play a stretch of the song into a sample, so music that took several lanes
// takes one trigger on one lane. Pure (no DOM): the render, the chord-stack
// test and the two rewrites the UI applies (popups/… via ui/pattosample.js).
//
// WHAT IS RENDERED is what the grid shows, read top to bottom. The Timeline
// lays the cues out in order and only SHOWS their flow, so the render does the
// same: B, C and S $Bx are taken out, as are the cues' own jumps and halts. The
// song is first CHASED to the block's first row (engine chaseTrackerRow, item
// 215), so every lane arrives with the instrument, volume and effect memory a
// play from the start would give it. A Patterns-view block is played the way
// that view's Preview plays it — on a clean slate at the song's tempo.
//
// Every lane outside the block keeps only its TIMING (A, T, S $6x, S $Ex):
// the music speeds up and slows down as it does in the song, and nothing else
// of those lanes sounds. The global volume (V, W) is left out everywhere,
// because it is still in the song when the sample replays — rendered as well,
// it would be applied twice.
//
// THE LEVEL. The sample replays through the gains the block's own notes went
// through — the song's global × mixing volume, the lane's volume and the pan
// law — so the render is divided by them, as they stand at the trigger, and a
// trigger at full volume on a centred lane sounds as loud as the block did. The
// mastering chain is off for the render for the same reason (the replay goes
// through it again); an instrument's own mixing chain (IMix) is not, since the
// new instrument has none. The 8-bit sample is kept near full scale for its
// resolution, and the instrument's initial attenuation (byte 251, the decibel
// octet) carries the rest of the gain. A song tuned away from concert pitch is
// cancelled by the sample's detune, so C-4 plays it at the rate it was made.
//
// THE REWRITE (one undo step, after the instrument's own): every cell of the
// block keeps only what belongs to the SONG — tempo, tick rate, global volume,
// flow, pattern delays and interrupt notes — and the trigger goes where the
// block's first note was. A lane whose running instrument the rewrite changed
// gets it written back on its next note that names none.

import { TaudEngine } from "../../core/engine/engine.js";
import {
  TRACKER_CHUNK, SAMPLING_RATE, MIDDLE_C, NUM_CUES, PATTERN_EMPTY,
  NOTE_INT_FIRST, NOTE_INT_LAST,
} from "../../core/engine/constants.js";
import { EffectOp, META_MIX_GAIN, attenGainOf } from "../../core/engine/tables.js";
import { META_MAX_LAYERS } from "../../core/engine/inst.js";
import { loadIntoEngine } from "../../core/audio/offline-render.js";
import { emptyCellBytes, cellToBytes } from "./clipboard.js";
import { cellStride } from "./patterntools.js";
import { encLen } from "./songrows.js";

/** The longest block a render will follow before giving up on it. The Sample
 *  Lab squeezes whatever comes out into one sample's 65535 frames, and 30 s
 *  there is already a 2 kHz sample. */
export const RENDER_MAX_SECONDS = 30;
/** How long the last notes may ring past the block's end — a release, not a
 *  sustain: a note that holds for ever is cut here, and faded over FADE_SECONDS
 *  so the cut does not click. */
export const TAIL_MAX_SECONDS = 2;
const FADE_SECONDS = 0.05;
/** Quiet this long after the block's end ends the render. */
const SILENCE_SECONDS = 0.1;
/** "Quiet" = below this fraction of the render's peak: half an 8-bit step of a
 *  sample normalised to that peak, which quantises to nothing anyway. */
const QUIET_FRACTION = 1 / 256;
/** Left between the sample's peak and full scale, so the Lab's resampling
 *  (whose sinc overshoots a little) does not clip it. */
const HEADROOM = 0.97;
/** A pool byte plays back as (b − 127.5) / 127.5 while the Lab writes
 *  128 + v × 127 — this is the gain between the two. */
const DECODE_GAIN = 127 / 127.5;
/** The equal-energy pan law at the centre: cos(π/4). */
const CENTRE_PAN_GAIN = Math.SQRT1_2;

// ── what belongs to the song ────────────────────────────────────────────────

/**
 * Whether an effect belongs to the SONG rather than to the lane's sound, and
 * how: "timing" (A, T, S $6x, S $Ex) plays in the render, "gain" (V, W) and
 * "flow" (B, C, S $Bx) do not. Null for every lane effect.
 */
export function songEffectKind(op, arg) {
  switch (op) {
    case EffectOp.OP_A: case EffectOp.OP_T: return "timing";
    case EffectOp.OP_V: case EffectOp.OP_W: return "gain";
    case EffectOp.OP_B: case EffectOp.OP_C: return "flow";
    case EffectOp.OP_S: {
      const x = (arg >>> 12) & 0xf;
      if (x === 0x6 || x === 0xe) return "timing";
      if (x === 0xb) return "flow";
      return null;
    }
    default: return null;
  }
}

const fxSlots = (wide) => (wide ? [5, 10] : [5]);
const fxKind = (b, s) => songEffectKind(b[s], b[s + 1] | (b[s + 2] << 8));
const noteOf = (b) => b[0] | (b[1] << 8);
const isPitch = (note) => note > NOTE_INT_LAST;
const isInterrupt = (note) => note >= NOTE_INT_FIRST && note <= NOTE_INT_LAST;

/** A blank cell holding only `b`'s song effects for which `keep(kind)` — and
 *  its interrupt note, when `interrupts`. */
function keepSongParts(b, wide, keep = () => true, interrupts = true) {
  const out = emptyCellBytes(wide);
  for (const s of fxSlots(wide)) {
    const kind = fxKind(b, s);
    if (kind !== null && keep(kind)) { out[s] = b[s]; out[s + 1] = b[s + 1]; out[s + 2] = b[s + 2]; }
  }
  if (interrupts && isInterrupt(noteOf(b))) { out[0] = b[0]; out[1] = b[1]; }
  return out;
}

/** `b` with the song effects `drop(kind)` names taken out. */
function dropSongEffects(b, wide, drop) {
  const out = b.slice();
  for (const s of fxSlots(wide)) {
    const kind = fxKind(b, s);
    if (kind !== null && drop(kind)) { out[s] = 0; out[s + 1] = 0; out[s + 2] = 0; }
  }
  return out;
}

/** `b` with every song part taken out — what the lane itself plays. */
function musicOf(b, wide) {
  const out = dropSongEffects(b, wide, () => true);
  if (isInterrupt(noteOf(out))) { out[0] = 0; out[1] = 0; }
  return out;
}

const bytesEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// ── the block ───────────────────────────────────────────────────────────────

/**
 * A Timeline block — song rows `r0…r1` of lanes `c0…c1` — as the render and the
 * rewrites read it: the cues it crosses, in order, each with the rows of it the
 * block covers (`lo…hi`), its row limit and its lane words.
 */
export function timelineRegion(song, r0, r1, c0, c1) {
  const cues = [];
  for (const e of song.songMap().entries) {
    const a = Math.max(r0, e.startRow);
    const b = Math.min(r1, e.startRow + e.rowLimit - 1);
    if (a > b) continue;
    cues.push({ cue: e.cue, lo: a - e.startRow, hi: b - e.startRow, limit: e.rowLimit,
      words: song.cues[e.cue] });
  }
  const lanes = [];
  for (let c = c0; c <= c1; c++) lanes.push(c);
  return { lanes, cues, chase: true, pattern: -1 };
}

/** Rows `r0…r1` of pattern `pat` on their own, as the Patterns view's Preview
 *  plays them: on lane 0 of cue 0, from a clean slate. */
export function patternRegion(pat, r0, r1, channels) {
  const words = new Uint16Array(channels).fill(PATTERN_EMPTY);
  words[0] = pat;
  return { lanes: [0], cues: [{ cue: 0, lo: r0, hi: r1, limit: 64, words }], chase: false, pattern: pat };
}

/** Every cell of the block in reading order — rows outer, lanes inner — as
 *  {i, cue, row, ch, pat}; `i` counts the block's rows, `pat` is -1 where the
 *  cue leaves the lane empty. */
function blockCells(region) {
  const out = [];
  let i = 0;
  for (const e of region.cues) {
    for (let row = e.lo; row <= e.hi; row++, i++) {
      for (const ch of region.lanes) {
        const pat = e.words[ch] & 0x7fff;
        out.push({ i, cue: e.cue, row, ch, pat: pat === PATTERN_EMPTY ? -1 : pat });
      }
    }
  }
  return out;
}

function readBytes(doc, songIndex, pat, row) {
  const wide = doc.wideCells === true;
  const cell = pat < 0 ? null : doc.patternAt(songIndex, pat)?.[row];
  return cell ? cellToBytes(cell, wide) : emptyCellBytes(wide);
}

/** The block's first note in reading order — where the trigger goes and where
 *  the sample starts — or null when it holds none. */
export function findTrigger(doc, songIndex, region) {
  for (const c of blockCells(region)) {
    if (c.pat >= 0 && isPitch(doc.patternAt(songIndex, c.pat)?.[c.row]?.note ?? 0)) return c;
  }
  return null;
}

/** The pattern image a lane plays in the render: rows past `cut` blank; a lane
 *  of the block without its gain and flow effects, any other lane with nothing
 *  but its timing. Null for an outside lane with no timing to keep. */
function renderPatternBytes(src, wide, inBlock, cut) {
  const w = cellStride(wide);
  const out = new Uint8Array(src.length);
  let any = inBlock;
  for (let r = 0; r < 64; r++) {
    const b = src.subarray(r * w, r * w + w);
    let cell;
    if (r > cut) cell = emptyCellBytes(wide);
    else if (inBlock) cell = dropSongEffects(b, wide, (k) => k !== "timing");
    else {
      cell = keepSongParts(b, wide, (k) => k === "timing", false);
      if (!any && fxSlots(wide).some((s) => cell[s] !== 0)) any = true;
    }
    out.set(cell, r * w);
  }
  return any ? out : null;
}

// ── the render ──────────────────────────────────────────────────────────────

/** The octet whose gain is the smallest at or above `g` — so a sample divided
 *  by it never exceeds what was asked for. */
function attenOctetFor(g) {
  for (let o = 1; o < 256; o++) if (META_MIX_GAIN[o] >= g) return o;
  return 255;
}

/**
 * Render the block. Resolves {channels, rate, attenOctet, detune, trigger,
 * seconds, blockSeconds} — `channels` one Float32Array (mono) or two, at the
 * engine's rate, already divided by the replay's gain and the attenuation
 * octet — or {error: "empty" | "tooLong" | "silent"}, or {aborted: true}.
 *
 * The sample starts at the row of the block's first note and runs to the end of
 * the block and on, while the last notes ring, until it has been quiet for a
 * moment or TAIL_MAX_SECONDS have passed; its trailing quiet is trimmed.
 */
export async function renderRegion(doc, songIndex, region,
                                   { signal = null, onProgress = null, yieldMs = 60 } = {}) {
  const trig = findTrigger(doc, songIndex, region);
  if (!trig) return { error: "empty" };
  const wide = doc.wideCells === true;
  const song = doc.songs[songIndex];
  const chans = doc.channelCount;
  const eng = new TaudEngine();
  loadIntoEngine(eng, doc.toRenderable(songIndex), songIndex);
  eng.setMastering(0, null);

  const first = region.cues[0];
  const last = region.cues[region.cues.length - 1];
  if (region.chase) eng.chaseTrackerRow(0, first.cue, first.lo);
  else { eng.setCuePosition(0, first.cue); eng.setTrackerRow(0, first.lo); }

  const p = eng.playheads[0];
  const ts = p.trackerState;
  const comp = (p.globalVolume / 255) * (p.mixingVolume / 255) * (p.masterVolume / 255) *
    (ts.voices[trig.ch].channelVolume / ts.volDiv) * CENTRE_PAN_GAIN;
  const tuning = eng.getTuningRatio(0);

  // The chase is done: from here the engine plays scratch patterns. Every cue
  // the render passes through is re-uploaded, so their numbers can start at 0
  // — the song's own patterns are never read again.
  const inBlock = new Set(region.lanes);
  const scratch = new Map();
  let nextScratch = 0;
  const scratchFor = (pat, lane, cut) => {
    const key = `${pat}:${lane ? 1 : 0}:${cut}`;
    let n = scratch.get(key);
    if (n !== undefined) return n;
    const bytes = renderPatternBytes(doc.patternBytes(songIndex, pat), wide, lane, cut);
    n = bytes ? nextScratch++ : PATTERN_EMPTY;
    if (bytes) eng.uploadPattern(n, bytes);
    scratch.set(key, n);
    return n;
  };
  region.cues.forEach((e, k) => {
    const cut = k === region.cues.length - 1 ? e.hi : 63;
    const w0 = e.limit < 64 ? encLen(e.limit) : 0; // the length, and no flow
    const bytes = new Uint8Array(chans * 2);
    for (let ch = 0; ch < chans; ch++) {
      const src = e.words[ch] & 0x7fff;
      let w = src === PATTERN_EMPTY ? PATTERN_EMPTY : scratchFor(src, inBlock.has(ch), cut);
      if (ch < 16 && ((w0 >> ch) & 1)) w |= 0x8000;
      bytes[ch * 2] = w & 0xff;
      bytes[ch * 2 + 1] = w >>> 8;
    }
    eng.uploadCue(e.cue, bytes);
  });
  const blank = new Uint8Array(chans * 2);
  for (let i = 0; i < blank.length; i += 2) { blank[i] = 0xff; blank[i + 1] = 0x7f; }
  for (let c = last.cue + 1; c < Math.min(song.cues.length, NUM_CUES); c++) eng.uploadCue(c, blank);

  // Positions in display order: the cues are consecutive and none jumps now.
  const posOf = (cue, row) => (cue - first.cue) * 64 + row;
  const trigPos = posOf(trig.cue, trig.row);
  const endPos = posOf(last.cue, last.hi);
  const rate = SAMPLING_RATE;
  /** Where the row the playhead is on began, within the chunk just mixed. */
  const rowStart = (from, to) => {
    const into = ts.tickInRow * ((rate * 2.5) / p.bpm) + ts.samplesIntoTick;
    return Math.min(to, Math.max(from, Math.round(to - into)));
  };

  const maxFrames = Math.ceil(RENDER_MAX_SECONDS * rate);
  const tailFrames = Math.ceil(TAIL_MAX_SECONDS * rate);
  const quietFrames = Math.ceil(SILENCE_SECONDS * rate);
  let L = new Float32Array(rate * 4);
  let R = new Float32Array(rate * 4);
  const chunk = new Uint8Array(TRACKER_CHUNK * 2);
  let frames = 0, startFrame = -1, endFrame = -1, quiet = 0, peak = 0, capped = false;
  let lastYield = Date.now();
  eng.play(0);
  for (;;) {
    if (signal?.aborted) return { aborted: true };
    if (!eng.isPlaying(0) || eng.renderChunk(0, chunk) === null) break;
    if (frames + TRACKER_CHUNK > L.length) {
      const grow = (a) => { const b = new Float32Array(a.length * 2); b.set(a); return b; };
      L = grow(L); R = grow(R);
    }
    const from = frames;
    L.set(ts.mixLeft.subarray(0, TRACKER_CHUNK), from);
    R.set(ts.mixRight.subarray(0, TRACKER_CHUNK), from);
    frames += TRACKER_CHUNK;
    const pos = posOf(ts.cuePos, ts.rowIndex);
    if (startFrame < 0 && pos >= trigPos) startFrame = rowStart(from, frames);
    if (endFrame < 0 && pos > endPos) endFrame = rowStart(from, frames);
    for (let n = Math.max(from, startFrame < 0 ? frames : startFrame); n < frames; n++) {
      const a = Math.max(Math.abs(L[n]), Math.abs(R[n]));
      if (a > peak) peak = a;
      if (endFrame >= 0 && n >= endFrame) quiet = a < peak * QUIET_FRACTION ? quiet + 1 : 0;
    }
    if (endFrame < 0 && frames >= maxFrames) return { error: "tooLong" };
    if (endFrame >= 0 && quiet >= quietFrames) break;
    if (endFrame >= 0 && frames - endFrame >= tailFrames) { capped = true; break; }
    if (Date.now() - lastYield >= yieldMs) {
      lastYield = Date.now();
      onProgress?.(Math.min(frames / maxFrames, 1));
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  if (startFrame < 0) startFrame = 0;
  if (endFrame < 0) endFrame = frames;
  onProgress?.(1);

  // Trim the trailing quiet, and refuse a block that made no sound at all —
  // or that the lane it would replay on could never make loud again.
  let stop = frames;
  const floor = peak * QUIET_FRACTION;
  while (stop > startFrame && Math.abs(L[stop - 1]) < floor && Math.abs(R[stop - 1]) < floor) stop--;
  if (stop <= startFrame || peak === 0 || comp === 0) return { error: "silent" };
  const octet = attenOctetFor(peak / comp / (DECODE_GAIN * HEADROOM));
  const g = 1 / (comp * attenGainOf(octet) * DECODE_GAIN);
  const left = L.slice(startFrame, stop);
  const right = R.slice(startFrame, stop);
  const fade = capped ? Math.min(left.length, Math.ceil(FADE_SECONDS * rate)) : 0;
  let stereo = false;
  for (let n = 0; n < left.length; n++) {
    if (left[n] !== right[n]) stereo = true;
    const k = n >= left.length - fade ? g * (left.length - n) / (fade + 1) : g;
    left[n] *= k;
    right[n] *= k;
  }
  const detune = Math.max(-32768, Math.min(32767, Math.round(-4096 * Math.log2(tuning)))) || 0;
  return {
    channels: stereo ? [left, right] : [left],
    rate,
    attenOctet: octet,
    detune,
    trigger: trig,
    seconds: left.length / rate,
    blockSeconds: Math.max(0, endFrame - startFrame) / rate,
  };
}

// ── running instruments ─────────────────────────────────────────────────────

/** Lane `ch`'s cells from the block's last row BACK to the song's start (a
 *  Patterns-view block: to its pattern's first row), as {pat, row}. */
function laneBefore(doc, songIndex, region, ch, inclusiveEnd) {
  const out = [];
  const at = inclusiveEnd ? region.cues[region.cues.length - 1] : region.cues[0];
  const top = inclusiveEnd ? at.hi : at.lo - 1;
  if (!region.chase) {
    for (let row = top; row >= 0; row--) out.push({ pat: region.pattern, row });
    return out;
  }
  const song = doc.songs[songIndex];
  const entries = song.songMap().entries;
  for (let k = entries.length - 1; k >= 0; k--) {
    const e = entries[k];
    if (e.cue > at.cue) continue;
    const pat = song.cues[e.cue][ch] & 0x7fff;
    if (pat === PATTERN_EMPTY) continue;
    for (let row = e.cue === at.cue ? top : e.rowLimit - 1; row >= 0; row--) out.push({ pat, row });
  }
  return out;
}

/** Lane `ch`'s cells after the block, in order, as {pat, row}. */
function laneAfter(doc, songIndex, region, ch) {
  const out = [];
  const last = region.cues[region.cues.length - 1];
  if (!region.chase) {
    for (let row = last.hi + 1; row < 64; row++) out.push({ pat: region.pattern, row });
    return out;
  }
  const song = doc.songs[songIndex];
  for (const e of song.songMap().entries) {
    if (e.cue < last.cue) continue;
    const pat = song.cues[e.cue][ch] & 0x7fff;
    if (pat === PATTERN_EMPTY) continue;
    for (let row = e.cue === last.cue ? last.hi + 1 : 0; row < e.rowLimit; row++) out.push({ pat, row });
  }
  return out;
}

/** The instrument lane `ch` is playing at the block's end (inclusive) or just
 *  before its start — the last cell naming one — or 0. */
function runningInstrument(doc, songIndex, region, ch, atEnd) {
  for (const { pat, row } of laneBefore(doc, songIndex, region, ch, atEnd)) {
    const inst = doc.patternAt(songIndex, pat)?.[row]?.instrment ?? 0;
    if (inst !== 0) return inst;
  }
  return 0;
}

/**
 * Hand each lane of the block back the instrument it was playing at the block's
 * end, where the rewrite changed it: `after(ch)` is the instrument the lane is
 * left on now. The lane's next note that names none gets it written in.
 */
function restoreRunning(doc, songIndex, region, writes, lanes, after) {
  for (const ch of lanes) {
    const orig = runningInstrument(doc, songIndex, region, ch, true);
    if (orig === 0 || orig === after(ch)) continue;
    for (const { pat, row } of laneAfter(doc, songIndex, region, ch)) {
      const key = `${pat}:${row}`;
      const b = writes.get(key)?.bytes ?? readBytes(doc, songIndex, pat, row);
      if (b[2] !== 0) break;
      if (!isPitch(noteOf(b))) continue;
      const out = b.slice();
      out[2] = orig;
      writes.set(key, { pat, row, bytes: out });
      break;
    }
  }
}

/** Every cell of the block cleared down to its song parts, keyed `pat:row`
 *  (two lanes or two cues playing one pattern write it once). */
function clearedBlock(doc, songIndex, region, lanes = null) {
  const wide = doc.wideCells === true;
  const writes = new Map();
  for (const c of blockCells(region)) {
    if (c.pat < 0 || (lanes && !lanes.has(c.ch))) continue;
    const b = readBytes(doc, songIndex, c.pat, c.row);
    const out = keepSongParts(b, wide);
    if (!bytesEqual(b, out)) writes.set(`${c.pat}:${c.row}`, { pat: c.pat, row: c.row, bytes: out });
  }
  return writes;
}

/**
 * The writes (setCellsBytesOp's shape) that replace the block with ONE trigger
 * of instrument `slot` at C-4, where the block's first note was (`trigger`, a
 * findTrigger result).
 */
export function planSampleReplacement(doc, songIndex, region, trigger, slot) {
  const wide = doc.wideCells === true;
  const writes = clearedBlock(doc, songIndex, region);
  const key = `${trigger.pat}:${trigger.row}`;
  const b = writes.get(key)?.bytes ?? keepSongParts(readBytes(doc, songIndex, trigger.pat, trigger.row), wide);
  const out = b.slice();
  out[0] = MIDDLE_C & 0xff;
  out[1] = MIDDLE_C >>> 8;
  out[2] = slot & 0xff;
  writes.set(key, { pat: trigger.pat, row: trigger.row, bytes: out });
  const before = new Map(region.lanes.map((ch) => [ch, runningInstrument(doc, songIndex, region, ch, false)]));
  restoreRunning(doc, songIndex, region, writes, region.lanes,
    (ch) => (ch === trigger.ch ? slot : before.get(ch)));
  return [...writes.values()];
}

// ── chord stacks ────────────────────────────────────────────────────────────

/**
 * Is the block a CHORD STACK — several lanes striking together, always the
 * same chord, with nothing on one lane that the others do not also do? Then it
 * needs no sample at all: it is one layered metainstrument, each lane's
 * instrument a layer detuned by its interval, played on one lane.
 *
 * The lanes counted are those with anything of their own in the block (song
 * effects stay where they are and do not count). Each row must be the same on
 * all of them: every lane strikes a note or none does; struck, their volume,
 * panning and effects agree and only the note and instrument differ; not
 * struck, the cells are identical (a shared key-off is fine) and name no
 * instrument. Each lane keeps one instrument and one interval to the lowest
 * note throughout, and none is a metainstrument (a layer cannot be one).
 *
 * Returns {ref, lanes, layers: [{ch, slot, detune}]} — the reference lane (the
 * lowest note, its layer first and at detune 0) — or null.
 */
export function detectChordStack(doc, songIndex, region) {
  if (!region.chase || region.lanes.length < 2) return null;
  const wide = doc.wideCells === true;
  const cells = blockCells(region);
  const music = new Map(region.lanes.map((ch) => [ch, []]));
  for (const c of cells) music.get(c.ch).push(musicOf(readBytes(doc, songIndex, c.pat, c.row), wide));
  const empty = emptyCellBytes(wide);
  const lanes = region.lanes.filter((ch) => music.get(ch).some((b) => !bytesEqual(b, empty)));
  if (lanes.length < 2 || lanes.length > META_MAX_LAYERS) return null;

  const rows = music.get(lanes[0]).length;
  const running = new Map(lanes.map((ch) => [ch, runningInstrument(doc, songIndex, region, ch, false)]));
  const slotOf = new Map();
  let ref = -1;
  let intervals = null;
  for (let i = 0; i < rows; i++) {
    const bs = lanes.map((ch) => music.get(ch)[i]);
    const struck = bs.map((b) => isPitch(noteOf(b)));
    if (struck.some((s) => s !== struck[0])) return null;
    if (!struck[0]) {
      if (bs.some((b) => b[2] !== 0 || !bytesEqual(b, bs[0]))) return null;
      continue;
    }
    const rest = (b) => { const o = b.slice(); o[0] = 0; o[1] = 0; o[2] = 0; return o; };
    if (bs.some((b) => !bytesEqual(rest(b), rest(bs[0])))) return null;
    if (ref < 0) {
      let lo = 0;
      bs.forEach((b, k) => { if (noteOf(b) < noteOf(bs[lo])) lo = k; });
      ref = lo;
    }
    const d = bs.map((b) => noteOf(b) - noteOf(bs[ref]));
    if (intervals === null) intervals = d;
    else if (d.some((v, k) => v !== intervals[k])) return null;
    for (let k = 0; k < lanes.length; k++) {
      const ch = lanes[k];
      if (bs[k][2] !== 0) running.set(ch, bs[k][2]);
      const slot = running.get(ch);
      if (slot === 0 || (slotOf.has(ch) && slotOf.get(ch) !== slot)) return null;
      slotOf.set(ch, slot);
    }
  }
  if (ref < 0) return null;
  if (intervals.some((d) => d < -32768 || d > 32767)) return null;
  const used = new Set(doc.usedInstrumentSlots());
  for (const slot of slotOf.values()) {
    if (!used.has(slot) || doc.instruments[slot].isMeta) return null;
  }
  const order = [ref, ...lanes.keys()].filter((k, n, a) => a.indexOf(k) === n);
  return {
    ref: lanes[ref],
    lanes,
    layers: order.map((k) => ({ ch: lanes[k], slot: slotOf.get(lanes[k]), detune: intervals[k] })),
  };
}

/**
 * The writes that replace a chord stack with its metainstrument `metaSlot`: the
 * reference lane keeps its own cells — the stack's rows ARE its rows — with the
 * meta named on every note, and the other lanes of the stack keep only their
 * song parts.
 */
export function planStackReplacement(doc, songIndex, region, stack, metaSlot) {
  const others = new Set(stack.lanes.filter((ch) => ch !== stack.ref));
  const writes = clearedBlock(doc, songIndex, region, others);
  for (const c of blockCells(region)) {
    if (c.ch !== stack.ref || c.pat < 0) continue;
    const b = readBytes(doc, songIndex, c.pat, c.row);
    if (!isPitch(noteOf(b))) continue;
    const out = b.slice();
    out[2] = metaSlot & 0xff;
    writes.set(`${c.pat}:${c.row}`, { pat: c.pat, row: c.row, bytes: out });
  }
  const before = new Map(stack.lanes.map((ch) => [ch, runningInstrument(doc, songIndex, region, ch, false)]));
  restoreRunning(doc, songIndex, region, writes, stack.lanes,
    (ch) => (ch === stack.ref ? metaSlot : before.get(ch)));
  return [...writes.values()];
}
