// Stem export (item 93) — offline-render the song once and drop each source's
// contribution into its own mono track, then pack the tracks into a ZIP.
//
// Signal definition: a stem holds the voice's PRE-PAN mono signal with every
// gain applied — note/lane volume, volume envelope + fadeout, instrument
// global volume, metainstrument mix gain, swing, fader, sample-end ramp and the
// song's global × mixing × master volume. The equal-energy pan law is the one
// thing left out (a mono file cannot carry it), so stems do NOT sum back to the
// stereo mix: you re-pan them in the DAW. The post-mix Amiga LPF/LED chain is
// likewise a MIX-stage filter and is not applied per stem.
//
// Output is 24-bit 48 kHz mono, taken from the float bus with NO dithering
// (24 bits covers 6-bit volume + 8-bit sample + 8-bit global volume = 22 bits,
// so quantisation lands below the engine's own noise floor). Export WAV keeps
// its 16-bit stereo format (item 93.1).
//
// Arrangement:
//   "instrument" — one track per pattern-visible instrument. A PERCUSSION
//                  instrument is split further: one track per sub-instrument
//                  (metainstrument layer) and per Ixmp patch PITCH RECT, so
//                  kick / snare / hats land on separate tracks while a drum's
//                  velocity layers stay together.
//   "voice"      — one track per lane; NNA ghosts and metainstrument layer
//                  children follow the lane that spawned them.

import { Zip, ZipPassThrough } from "../../vendor/fflate.esm.js";
import { TaudEngine } from "../engine/engine.js";
import { SAMPLING_RATE, TRACKER_CHUNK } from "../engine/constants.js";
import { loadIntoEngine } from "./offline-render.js";
import { resampleInterleaved } from "./resampler.js";
import { unescapeName } from "../ui/names.js";

/** First allocation per track — ~22 s at 48 kHz (4 MiB), doubling from there. */
const INITIAL_STEM_FRAMES = 1 << 20;

/**
 * The engine tap. Attaches itself as `eng.stemBus`; the mixer then hands every
 * voice's pre-pan mono sample to `add()` and does nothing else differently —
 * the main output stays bit-identical (pinned by test/node/stems.test.js).
 */
export class StemBus {
  /** @param frames total frames the buffers must hold (chunk-aligned). */
  constructor(eng, perVoice, frames) {
    this.eng = eng;
    this.perVoice = perVoice;
    this.frames = frames;
    this.base = 0;          // frame offset of the chunk being rendered
    this.stems = [];
    this.byId = new Map();

    // Per-render lookups — instruments are uploaded before playback starts and
    // never change mid-render, so these are constant for the whole export.
    const n = eng.instruments.length;
    this.isPerc = new Uint8Array(n);
    this.patchPitch = new Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      const inst = eng.instruments[i];
      this.isPerc[i] = inst.isPercussion ? 1 : 0;
      const ps = inst.extraPatches;
      if (ps !== null) {
        const arr = new Int32Array(ps.length * 2); // [pitchStart, pitchEnd] pairs
        for (let k = 0; k < ps.length; k++) {
          arr[k * 2] = ps[k].pitchStart;
          arr[k * 2 + 1] = ps[k].pitchEnd;
        }
        this.patchPitch[i] = arr;
      }
    }
  }

  attach() {
    for (const ph of this.eng.playheads) {
      const ts = ph.trackerState;
      if (ts === null) continue;
      for (const v of ts.voices) { v.stemKey = -1; v.stemIndex = -1; }
    }
    this.eng.stemBus = this;
  }

  detach() { this.eng.stemBus = null; }

  /**
   * Routing key for a voice, in three disjoint numeric ranges:
   *   melodic          → the pattern-visible slot; the whole instrument is one track.
   *   percussion       → the Ixmp patch's PITCH RECT: one track per drum. Keying on
   *     (with a patch)   the rect and not on the sounding sub-instrument is what keeps
   *                      a layered kick (two metainstrument layers, one hit) together
   *                      while kick / snare / hats stay apart.
   *   percussion       → the sub-instrument, the best "which drum" answer available.
   *     (no patch)
   * Recomputed per sample but memoised on the voice, so the Map lookup in
   * resolve() only runs when a voice changes what it is playing.
   */
  keyOf(voice) {
    const top = voice.displayInst !== 0 ? voice.displayInst : voice.instrumentId;
    if (this.isPerc[top] === 0) return top;
    const sub = voice.instrumentId;
    const pp = this.patchPitch[sub];
    const p = voice.activePatchIndex;
    if (pp === null || p < 0 || p * 2 >= pp.length) return 1024 + top * 1024 + sub;
    return 2e6 + (top * 65536 + pp[p * 2]) * 65536 + pp[p * 2 + 1];
  }

  resolve(key, voice, vi) {
    const id = this.perVoice ? "v" + vi : "k" + key;
    let stem = this.byId.get(id);
    if (stem === undefined) {
      stem = {
        index: this.stems.length,
        channel: vi,
        top: 0, sub: 0, patchIdx: -1, split: false,
        insts: new Set(),
        peak: 0,
        // Grows on demand: the cap is usually far longer than the song, and a
        // full-cap buffer per track would be tens of megabytes of nothing.
        buf: new Float32Array(Math.min(this.frames, INITIAL_STEM_FRAMES)),
      };
      this.byId.set(id, stem);
      this.stems.push(stem);
      // Naming comes from the FIRST voice to reach a track, so a drum layered
      // from two sub-instruments is labelled deterministically.
      if (!this.perVoice) {
        const top = voice.displayInst !== 0 ? voice.displayInst : voice.instrumentId;
        stem.top = top;
        stem.split = this.isPerc[top] !== 0; // percussion → this track is one drum
        stem.sub = voice.instrumentId;
        stem.patchIdx = stem.split ? voice.activePatchIndex : -1;
      }
    }
    stem.insts.add(voice.displayInst !== 0 ? voice.displayInst : voice.instrumentId);
    return stem.index;
  }

  /** Mixer callback: `s` is the voice's pre-pan mono sample for frame `n`. */
  add(voice, vi, n, s) {
    if (vi < 0) return; // a background voice with no source lane (never happens)
    const key = this.keyOf(voice);
    if (voice.stemKey !== key) {
      voice.stemKey = key;
      voice.stemIndex = this.resolve(key, voice, vi);
    }
    const stem = this.stems[voice.stemIndex];
    const i = this.base + n;
    if (i >= stem.buf.length) {
      if (i >= this.frames) return; // past the cap — the render is about to stop
      let len = stem.buf.length;
      while (len <= i) len *= 2;
      const grown = new Float32Array(Math.min(len, this.frames));
      grown.set(stem.buf);
      stem.buf = grown;
    }
    stem.buf[i] += s;
    const a = s < 0 ? -s : s;
    if (a > stem.peak) stem.peak = a;
  }

  /** Drop silent tracks, make every track exactly `frames` long, order stably. */
  finish(frames) {
    const out = this.stems.filter((s) => s.peak > 0);
    for (const s of out) {
      if (s.buf.length === frames) continue;
      // Tracks that fell silent early are zero-padded: a DAW needs them all
      // to start and end together.
      const exact = new Float32Array(frames);
      exact.set(s.buf.subarray(0, Math.min(s.buf.length, frames)));
      s.buf = exact;
    }
    const pitchOf = (s) => {
      const pp = this.patchPitch[s.sub];
      return pp !== null && s.patchIdx >= 0 && s.patchIdx * 2 < pp.length ? pp[s.patchIdx * 2] : -1;
    };
    if (this.perVoice) out.sort((a, b) => a.channel - b.channel);
    else out.sort((a, b) => a.top - b.top || pitchOf(a) - pitchOf(b) || a.sub - b.sub);
    return out;
  }
}

/**
 * Render `docLike` (a Document.toRenderable() shape) capturing per-stem mono
 * buses. Yields to the event loop like renderSongAsync so a progress UI paints.
 * Returns {stems, frames, seconds, halted, aborted}.
 */
export async function renderStemsAsync(docLike, songIndex, maxSeconds, {
  mode = "instrument", onProgress = null, signal = null, yieldMs = 60,
} = {}) {
  const eng = new TaudEngine();
  loadIntoEngine(eng, docLike, songIndex);

  const maxFrames = maxSeconds * SAMPLING_RATE;
  const nChunks = Math.ceil(maxFrames / TRACKER_CHUNK);
  const bus = new StemBus(eng, mode === "voice", nChunks * TRACKER_CHUNK);
  bus.attach();

  const chunk = new Uint8Array(TRACKER_CHUNK * 2);
  eng.setCuePosition(0, 0);
  eng.play(0);

  let frames = 0;
  let halted = false;
  let aborted = false;
  let lastYield = (typeof performance !== "undefined" ? performance.now() : Date.now());
  try {
    while (frames < maxFrames) {
      if (signal?.aborted) { aborted = true; break; }
      if (!eng.isPlaying(0)) { halted = true; break; }
      bus.base = frames;
      if (eng.renderChunk(0, chunk) === null) { halted = true; break; }
      frames += TRACKER_CHUNK;

      const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
      if (now - lastYield >= yieldMs) {
        lastYield = now;
        onProgress?.(Math.min(frames / maxFrames, 1));
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  } finally {
    bus.detach();
  }
  onProgress?.(1);

  return {
    stems: aborted ? [] : bus.finish(frames),
    frames,
    seconds: frames / SAMPLING_RATE,
    halted,
    aborted,
  };
}

/** Encode a mono float bus (engine rate) as a 24-bit mono WAV at `outRate`. */
export function encodeWav24Mono(f32, outRate = 48000, srcRate = SAMPLING_RATE) {
  const pcm = resampleInterleaved(f32, 1, srcRate, outRate);
  const n = pcm.length;
  const dataBytes = n * 3;
  const pad = dataBytes & 1; // RIFF chunks are word-aligned
  const buf = new ArrayBuffer(44 + dataBytes + pad);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, "RIFF");
  dv.setUint32(4, 36 + dataBytes + pad, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);           // PCM
  dv.setUint16(22, 1, true);           // mono
  dv.setUint32(24, outRate, true);
  dv.setUint32(28, outRate * 3, true); // byte rate
  dv.setUint16(32, 3, true);           // block align
  dv.setUint16(34, 24, true);          // bits
  wstr(36, "data");
  dv.setUint32(40, dataBytes, true);
  for (let i = 0; i < n; i++) {
    const v = pcm[i] < -1 ? -1 : pcm[i] > 1 ? 1 : pcm[i];
    const q = Math.round(v * 8388607);
    const u = q < 0 ? q + 0x1000000 : q;
    const o = 44 + i * 3;
    u8[o] = u & 0xff;
    u8[o + 1] = (u >>> 8) & 0xff;
    u8[o + 2] = (u >>> 16) & 0xff;
  }
  return u8;
}

/**
 * Streaming (STORE, no deflate) ZIP builder. Files are pushed one at a time so
 * the caller can free each encoded WAV immediately — PCM barely compresses, so
 * storing keeps a multi-hundred-megabyte export fast and memory-flat.
 */
export class StemZip {
  constructor() {
    this.chunks = [];
    this.error = null;
    this.zip = new Zip((err, dat) => {
      if (err) { this.error = err; return; }
      if (dat) this.chunks.push(dat);
    });
  }

  addFile(name, bytes) {
    const entry = new ZipPassThrough(name);
    this.zip.add(entry);
    entry.push(bytes, true);
    if (this.error) throw this.error;
  }

  /** @returns Uint8Array[] — the archive, in order. */
  finish() {
    this.zip.end();
    if (this.error) throw this.error;
    return this.chunks;
  }
}

/** One-shot convenience wrapper: [{name, bytes}] → Uint8Array[]. */
export function zipStems(files) {
  const z = new StemZip();
  for (const f of files) z.addFile(f.name, f.bytes);
  return z.finish();
}

/** Filename-safe (path/shell metacharacters and control codes out), length-capped.
 *  Non-ASCII survives — ZIP entry names carry a UTF-8 flag. Never empty. */
export function sanitiseName(s, fallback = "track") {
  const clean = unescapeName(String(s ?? ""))
    .replace(/\p{Cc}+/gu, " ")       // control characters
    .replace(/[\/\\:*?"<>|]+/g, " ") // path- and shell-unsafe
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")          // never a leading dot (hidden file)
    .trim()
    .slice(0, 48)
    .trim();
  return clean || fallback;
}

/**
 * Human label for each stem, using the document's INam / SNam tables.
 * `doc` needs instrumentName(slot), sampleName-by-pointer (via sampleList())
 * and instruments[] — i.e. a Document. Returns the stems with `.label` set.
 */
export function labelStems(stems, doc, mode) {
  const byPtr = new Map();
  for (const e of doc.sampleList()) if (!byPtr.has(e.ptr)) byPtr.set(e.ptr, e.name);
  const instName = (slot) => sanitiseName(doc.instrumentName(slot), "");
  const sampleName = (ptr) => sanitiseName(byPtr.get(ptr) ?? "", "");

  for (const s of stems) {
    if (mode === "voice") {
      const ch = String(s.channel + 1).padStart(2, "0");
      // A lane that only ever played one instrument gets named after it.
      const only = s.insts.size === 1 ? instName([...s.insts][0]) : "";
      s.label = only ? `Lane${ch} ${only}` : `Lane${ch}`;
      continue;
    }
    const inst = doc.instruments[s.sub];
    const patch = s.patchIdx >= 0 ? inst?.extraPatches?.[s.patchIdx] ?? null : null;
    const slotTag = s.top.toString(16).toUpperCase().padStart(2, "0");
    let name;
    if (s.split) {
      // Percussion split: prefer the sample's own name (kick / snare / …).
      name = (patch !== null ? sampleName(patch.samplePtr) : "") ||
             instName(s.sub) ||
             (inst ? sampleName(inst.samplePtr) : "") ||
             `Sub${s.sub.toString(16).toUpperCase().padStart(2, "0")}`;
    } else {
      name = instName(s.top) || (inst ? sampleName(inst.samplePtr) : "") || "Inst";
    }
    s.label = `I${slotTag} ${name}`;
  }
  // Two drums can legitimately share a sample name; keep the labels distinct so
  // the DAW's track list stays readable.
  const seen = new Map();
  for (const s of stems) {
    const n = (seen.get(s.label) ?? 0) + 1;
    seen.set(s.label, n);
    if (n > 1) s.label = `${s.label} (${n})`;
  }
  return stems;
}

/** `<prefix>_<NN>_<label>.wav`, both parts already sanitised. */
export function stemFileName(prefix, ordinal, label) {
  return `${prefix}_${String(ordinal).padStart(2, "0")}_${sanitiseName(label)}.wav`;
}
