// Chip instruments as samples (item 219). A ProTracker module has nothing but
// samples, so an OPL or PSG instrument is BOUNCED for the .mod export: one
// note of it is played through the engine, alone, and what comes out is the
// sample — looped where it sustains, trimmed where it dies away.
//
// The level is the engine's own: the same render also plays a reference
// instrument (a full-scale square sample, no envelope) under the same song
// settings, and the bounce is scaled by what that reference came out at. So a
// bounced chip instrument sits against the song's sampled instruments where it
// sat in the mix, rather than wherever a normaliser would have put it.

import { TaudEngine } from "../../core/engine/engine.js";
import { loadIntoEngine, renderSong } from "../../core/audio/offline-render.js";
import { SAMPLING_RATE, MIDDLE_C } from "../../core/engine/constants.js";
import { tuningRatioOf } from "../../core/engine/tables.js";
import {
  SAMPLEBIN_SIZE, INST_RECORD_SIZE, PATTERN_SIZE, CUE_EMPTY, MAX_VOICES,
} from "../../core/format/taud-const.js";

/** How long a note is held for its bounce. */
export const BOUNCE_SECONDS = 2;

const REF_LEN = 256;                       // the reference square: 128 high, 128 low
const REF_PTR = SAMPLEBIN_SIZE - REF_LEN;  // parked at the very top of the pool copy
const REF_PEAK = 127 / 128;                // a u8 $FF / $01 sample point
const NO_INTERP = 1 << 2;                  // song flags `rrr` = 1: no interpolation

/**
 * A fresh image for bouncing: the project's own, with the reference
 * instrument written into slot `refSlot` and its square at the top of the
 * pool. One copy serves every chip instrument of an export.
 */
export function bounceImage(image, refSlot) {
  const out = image.slice();
  for (let i = 0; i < REF_LEN; i++) out[REF_PTR + i] = i < REF_LEN / 2 ? 0xff : 0x01;
  const rec = new Uint8Array(INST_RECORD_SIZE);
  const dv = new DataView(rec.buffer);
  dv.setUint32(0, REF_PTR, true);
  dv.setUint16(4, REF_LEN, true);
  dv.setUint16(6, 8363, true);
  dv.setUint16(12, REF_LEN, true);         // loop end: the whole square, forward
  rec[14] = 1;
  dv.setUint16(15, 0x2020, true);          // a present, flat volume envelope (mod2taud's)
  rec[21] = 63;
  rec[171] = 0xff;                         // instrument global volume: unity
  rec[177] = 0x80;
  rec[182] = 0xff;                         // filter off
  rec[183] = 0xff;
  rec[186] = 1;                            // NNA: note cut
  rec[196] = 0xff;                         // default note volume: full
  out.set(rec, SAMPLEBIN_SIZE + refSlot * INST_RECORD_SIZE);
  return out;
}

/** The slot the reference instrument borrows: any cell-addressable slot that
 *  is not the one being bounced. */
export function referenceSlot(slot) {
  return slot === 255 ? 254 : 255;
}

function oneNoteSong(song, image, slot, note) {
  const pat = new Uint8Array(PATTERN_SIZE);
  for (let r = 0; r < 64; r++) {
    pat[r * 8 + 3] = 0xc0; // volume column: the no-op (selector 3, value 0)
    pat[r * 8 + 4] = 0xc0; // panning column: likewise
  }
  pat[0] = note & 0xff;
  pat[1] = (note >>> 8) & 0xff;
  pat[2] = slot;
  pat[3] = 63;             // volume SET 63: the bounce is taken at full note volume
  const words = new Uint16Array(MAX_VOICES).fill(CUE_EMPTY);
  words[0] = 0;
  return {
    is64Channel: false, fmtVer: 2, wideCells: false, sampleInstImage: image,
    ixmp: [], imix: [], meta: {},
    songs: [{
      bpm: 125, tickRate: 6,
      globalFlags: (song.globalFlags & 3) | NO_INTERP,
      globalVolume: 255, mixingVolume: song.mixingVolume, surroundModel: 0,
      tuningBaseNote: song.tuningBaseNote, tuningFreq: song.tuningFreq, mastering: null,
      patterns: [pat], cues: [words],
    }],
  };
}

/** Mono (L+R)/2 of one held note, BOUNCE_SECONDS long, at the engine rate. */
function renderNote(song, image, slot, note) {
  const eng = new TaudEngine();
  loadIntoEngine(eng, oneNoteSong(song, image, slot, note), 0);
  const r = renderSong(eng, BOUNCE_SECONDS);
  const n = r.f32.length >>> 1;
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (r.f32[2 * i] + r.f32[2 * i + 1]) * 0.5;
  return mono;
}

function rms(buf, from, to) {
  let acc = 0;
  for (let i = from; i < to; i++) acc += buf[i] * buf[i];
  return to > from ? Math.sqrt(acc / (to - from)) : 0;
}

/** The level a full-scale sample comes out of the engine at, under `song`'s
 *  settings: the yardstick every bounce is measured against. */
export function referenceLevel(song, image, refSlot) {
  const mono = renderNote(song, image, refSlot, MIDDLE_C);
  const rate = SAMPLING_RATE;
  return rms(mono, Math.round(rate * 0.25), Math.round(rate * 1.0)) / REF_PEAK;
}

/**
 * Where a held, sustaining bounce repeats: the loop length (in frames, at
 * least `minLen`) whose end best continues into its start, judged over the
 * last `win` frames. Returns the loop START; the loop always ends at the end
 * of the buffer, so whatever was settling before it plays once.
 */
function findLoopStart(buf, minLen, maxLen, win) {
  const end = buf.length;
  let best = -1, bestScore = -Infinity;
  for (let len = minLen; len <= maxLen && end - len - win >= 0; len++) {
    let dot = 0, ea = 0, eb = 0;
    for (let i = end - win; i < end; i++) {
      const a = buf[i], b = buf[i - len];
      dot += a * b; ea += a * a; eb += b * b;
    }
    const score = ea > 0 && eb > 0 ? dot / Math.sqrt(ea * eb) : 0;
    if (score > bestScore) { bestScore = score; best = len; }
  }
  return best < 0 ? -1 : end - best;
}

/**
 * Bounce one chip instrument. `note` is the pitch it is played at (the export
 * takes the middle of the notes the song plays it with, so the timbre is the
 * one heard most); `level` comes from referenceLevel.
 *
 * Returns {pcm: Float32Array in [-1, 1], rate, loopStart, loopEnd} — `rate` is
 * the sampling rate at C4 that plays the bounce back at the pitch it was
 * rendered at, and the loop is -1/-1 for a sound that dies away.
 */
export function bounceChipInstrument(song, image, slot, note, level) {
  const rate = SAMPLING_RATE;
  const mono = renderNote(song, image, slot, note);
  const scale = level > 0 ? 1 / level : 1;
  let peak = 0;
  for (let i = 0; i < mono.length; i++) {
    mono[i] *= scale;
    peak = Math.max(peak, Math.abs(mono[i]));
  }
  // Louder than a full-scale sample can hold: the shape survives, the level
  // gives way.
  if (peak > 1) for (let i = 0; i < mono.length; i++) mono[i] /= peak;

  const tr = tuningRatioOf(song.tuningBaseNote, song.tuningFreq);
  const c4Rate = (rate * 2 ** (-(note - MIDDLE_C) / 4096)) / tr;

  // A sound still going at the end of the hold sustains: loop its tail. One
  // that has died away is a one-shot, trimmed to where it falls under -60 dB.
  const tail = Math.round(rate * 0.2);
  const quiet = 1e-3;
  if (rms(mono, mono.length - tail, mono.length) < quiet) {
    let last = mono.length - 1;
    while (last > 0 && Math.abs(mono[last]) < quiet) last--;
    return { pcm: mono.subarray(0, last + 1), rate: c4Rate, loopStart: -1, loopEnd: -1 };
  }
  const loopStart = findLoopStart(mono, Math.round(rate * 0.02), Math.round(rate * 0.1),
    Math.round(rate * 0.02));
  return {
    pcm: mono,
    rate: c4Rate,
    loopStart: loopStart < 0 ? -1 : loopStart,
    loopEnd: loopStart < 0 ? -1 : mono.length,
  };
}
