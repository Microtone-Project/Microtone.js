// Offline mastering analysis (item 178.4) — the whole song, measured, with a
// time axis, on both sides of the mastering chain.
//
// The live meters tell you what is happening NOW; this tells you where the
// problem is. A song whose loudness sags for thirty seconds in the middle, or
// whose limiter is working three times as hard in the last chorus, or that
// clips exactly twice in five minutes, does not show any of that on a meter you
// have to watch in real time. So this renders the song as fast as the machine
// can, keeps a measurement every 100 ms, and hands back arrays to plot.
//
// It renders ONCE. Both the pre-chain and the post-chain figures come out of
// the same pass, because the engine's metering tap measures the mix buffer
// twice — before the chain runs over it and after — which also means the two
// series describe the same performance rather than two renders of it.
//
// Nothing here interprets anything. It reports LUFS, peaks, crest and the code
// histogram; whether a dip is a mistake or the quiet bit is not its business.

import { TaudEngine } from "../engine/engine.js";
import { TRACKER_CHUNK, SAMPLING_RATE } from "../engine/constants.js";
import {
  LoudnessIntegrator, FRAME_SEC, TAP_PRE, TAP_POST, SPEC_FRAMES,
  makeMasterMeterReadout, bitUsage, crestDb, dbfs,
  DEFAULT_BIT_DEPTH, HIST_BUCKETS,
} from "../engine/loudness.js";
import {
  BandAnalyser, SPECTRUM_NBANDS, SPECTRUM_TILT_DB_PER_OCT,
} from "../engine/fft.js";
import { loadIntoEngine } from "./offline-render.js";

/** One stage's growing series, in 100 ms frames. */
class StageSeries {
  constructor(rate) {
    this.loud = new LoudnessIntegrator(rate);
    // Where the energy is sitting, in the same five bands — and therefore the
    // same five colours — the radiation surface and the soundfield cloud use.
    // The analyser runs on its own audio-time hop; whatever windows land inside
    // a 100 ms frame are averaged into that frame's column.
    //
    // TILTED, and therefore a PICTURE rather than a figure: without the pink
    // slope every mix is a wall of bass with three slivers on top, and the
    // octaves a master is actually shaped in never get to say anything. Nothing
    // else in this file reads these numbers.
    this.bandAn = new BandAnalyser(rate, { tiltDbPerOct: SPECTRUM_TILT_DB_PER_OCT });
    this.bandRows = [];        // one Float32Array(SPECTRUM_NBANDS) per frame
    this._bandAcc = new Float64Array(SPECTRUM_NBANDS);
    this._bandN = 0;
    this._onBands = (b) => {
      for (let i = 0; i < SPECTRUM_NBANDS; i++) this._bandAcc[i] += b[i];
      this._bandN++;
    };
    this.peakDb = [];
    this.truePeakDb = [];
    this.rmsDb = [];
    this.crest = [];
    this.apCrest = [];
    this.clips = [];
    // Frame accumulators.
    this._n = 0;
    this._peak = 0; this._tp = 0; this._sq = 0; this._clip = 0;
    this._apPeak = 0; this._apSq = 0;
    this.frameSamples = Math.max(1, Math.round(FRAME_SEC * rate));
    this.clipCount = 0;
  }

  /** Fold one drained chunk in. `spec`/`specWrite`/`specCount` are the tap's
   *  mono ring for this stage and the slice of it this chunk just wrote. */
  add(r, stage, spec = null, specWrite = 0, specCount = 0) {
    if (spec !== null && specCount > 0) {
      // The ring is written continuously; the frames this chunk added end at
      // specWrite. Feed them in order, wrapping once at most (a chunk is far
      // shorter than the ring).
      const start = (specWrite - specCount + SPEC_FRAMES) % SPEC_FRAMES;
      const first = Math.min(specCount, SPEC_FRAMES - start);
      this.bandAn.push(spec, start, first, this._onBands);
      if (first < specCount) this.bandAn.push(spec, 0, specCount - first, this._onBands);
    }
    this._add(r, stage);
  }

  _add(r, stage) {
    const i = stage * 2;
    const peak = Math.max(r.peak[i], r.peak[i + 1]);
    const tp = Math.max(r.truePeak[i], r.truePeak[i + 1]);
    const n = r.frames;
    // meanSquare is per channel over the interval; the pair's mean square is
    // their mean, which is what an RMS reading of a stereo programme means.
    const sq = (r.meanSquare[i] + r.meanSquare[i + 1]) * 0.5 * n;
    const clip = r.clip[i] + r.clip[i + 1];
    this.loud.push(r.sumZ[stage], sq * 2, peak, tp, n);
    this.clipCount += clip;

    if (peak > this._peak) this._peak = peak;
    if (tp > this._tp) this._tp = tp;
    this._sq += sq;
    this._clip += clip;
    if (r.apPeak[stage] > this._apPeak) this._apPeak = r.apPeak[stage];
    this._apSq += r.apSumSq[stage] * 0.5;
    this._n += n;
    while (this._n >= this.frameSamples) {
      const share = this.frameSamples / this._n;
      const sqFrame = this._sq * share;
      const apFrame = this._apSq * share;
      this._flush(sqFrame / this.frameSamples, apFrame / this.frameSamples);
      this._sq -= sqFrame;
      this._apSq -= apFrame;
      this._n -= this.frameSamples;
      this._peak = 0; this._tp = 0; this._apPeak = 0; this._clip = 0;
    }
  }

  _flush(ms, apMs) {
    this.peakDb.push(dbfs(this._peak));
    this.truePeakDb.push(dbfs(this._tp));
    this.rmsDb.push(ms > 0 ? 10 * Math.log10(ms) : -144);
    this.crest.push(crestDb(this._peak, ms));
    this.apCrest.push(crestDb(this._apPeak, apMs));
    this.clips.push(this._clip);
    // The frame's spectral column: the mean of whatever analysis windows landed
    // in it. A frame that caught none (the hop is 512 samples, a 100 ms frame is
    // 4800) repeats the last one rather than reading as silence.
    const row = new Float32Array(SPECTRUM_NBANDS);
    if (this._bandN > 0) {
      for (let i = 0; i < SPECTRUM_NBANDS; i++) row[i] = this._bandAcc[i] / this._bandN;
    } else if (this.bandRows.length > 0) {
      row.set(this.bandRows[this.bandRows.length - 1]);
    }
    this.bandRows.push(row);
    this._bandAcc.fill(0);
    this._bandN = 0;
  }

  /** The finished, plottable result for this stage. */
  finish() {
    const l = this.loud;
    return {
      integratedLufs: l.integrated,
      rangeLu: l.range,
      truePeakDb: dbfs(l.truePeak),
      samplePeakDb: dbfs(l.samplePeak),
      plr: l.plr,
      clipCount: this.clipCount,
      // Momentary loudness on the 100 ms grid, which is what the plot draws.
      lufs: Float32Array.from(l.blocks(0.4)),
      shortTermLufs: Float32Array.from(l.blocks(3)),
      peakSeriesDb: Float32Array.from(this.peakDb),
      truePeakSeriesDb: Float32Array.from(this.truePeakDb),
      rmsSeriesDb: Float32Array.from(this.rmsDb),
      crestSeriesDb: Float32Array.from(this.crest),
      apCrestSeriesDb: Float32Array.from(this.apCrest),
      clipSeries: Float32Array.from(this.clips),
      // Band energies, frame-major: bandSeries[frame * SPECTRUM_NBANDS + band].
      // DISPLAY values — tilted by `bandTiltDbPerOct` (see above).
      bandSeries: flattenBands(this.bandRows),
      bandCount: SPECTRUM_NBANDS,
      bandTiltDbPerOct: SPECTRUM_TILT_DB_PER_OCT,
      // The crest GAP: how much peak the chain (and everything before it) has
      // eaten. A wide gap means flat tops — clipping or hard limiting.
      crestGapDb: meanOf(this.apCrest) - meanOf(this.crest),
    };
  }
}

/** [Float32Array(5)] → one flat Float32Array, frame-major. */
function flattenBands(rows) {
  const out = new Float32Array(rows.length * SPECTRUM_NBANDS);
  for (let i = 0; i < rows.length; i++) out.set(rows[i], i * SPECTRUM_NBANDS);
  return out;
}

function meanOf(a) {
  if (a.length === 0) return 0;
  let s = 0, n = 0;
  for (const v of a) if (Number.isFinite(v)) { s += v; n++; }
  return n > 0 ? s / n : 0;
}

/**
 * Analyse one song offline.
 *
 * @param docLike   a Document.toRenderable() view, or a parsed .taud
 * @param songIndex which song
 * @param maxSeconds hard cap, as every other render path takes
 * @returns {{seconds, halted, aborted, hopSec, pre, post, histogram, bits}}
 *   where `pre` and `post` are StageSeries.finish() results and `histogram` is
 *   the delivered 8-bit code census of the whole render.
 */
export async function analyseSongAsync(docLike, songIndex, maxSeconds, {
  onProgress = null, signal = null, yieldMs = 60, bitDepth = DEFAULT_BIT_DEPTH,
} = {}) {
  const eng = new TaudEngine();
  loadIntoEngine(eng, docLike, songIndex);
  // The phase-scrambled crest is what makes this worth an offline pass at all.
  eng.setMasterMeter(0, true, true, bitDepth);
  const tap = eng.playheads[0].trackerState.masterMeter;
  const readout = makeMasterMeterReadout();

  const pre = new StageSeries(SAMPLING_RATE);
  const post = new StageSeries(SAMPLING_RATE);
  const device = new Uint8Array(TRACKER_CHUNK * 2);
  const maxFrames = maxSeconds * SAMPLING_RATE;

  eng.setCuePosition(0, 0);
  eng.play(0);

  let frames = 0;
  let halted = false;
  let aborted = false;
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  let lastYield = now();
  while (frames < maxFrames) {
    if (signal?.aborted) { aborted = true; break; }
    if (!eng.isPlaying(0)) { halted = true; break; }
    if (eng.renderChunk(0, device) === null) { halted = true; break; }
    const r = tap.drain(readout);
    pre.add(r, TAP_PRE, r.spec[TAP_PRE], r.specWrite, TRACKER_CHUNK);
    post.add(r, TAP_POST, r.spec[TAP_POST], r.specWrite, TRACKER_CHUNK);
    frames += TRACKER_CHUNK;
    if (now() - lastYield >= yieldMs) {
      lastYield = now();
      onProgress?.(Math.min(frames / maxFrames, 1));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  onProgress?.(1);

  // The census is cumulative in the tap and survives every drain. The FIGURES
  // are taken at full resolution; only the picture is downsampled, so a
  // 16-bit pass reports an exact `used` over 65536 codes and still hands back
  // 256 buckets to draw.
  const bits = bitUsage(tap.hist, tap.bitDepth);
  const shift = tap.bitDepth - 8;
  const histogram = new Float64Array(HIST_BUCKETS);
  for (let i = 0; i < tap.hist.length; i++) histogram[i >> shift] += tap.hist[i];
  return {
    seconds: frames / SAMPLING_RATE,
    hopSec: FRAME_SEC,
    halted,
    aborted,
    pre: pre.finish(),
    post: post.finish(),
    histogram,
    bitDepth: tap.bitDepth,
    bits,
  };
}

/**
 * What gain would put the render's true peak exactly at `targetDb` dBTP — the
 * arithmetic behind the "set make-up for −1 dBTP" button.
 *
 * `atGainDb` is the gain THIS ANALYSIS WAS RENDERED AT, not whatever is set
 * now. That distinction is the whole contract: the answer is then an absolute
 * value derived from the measurement alone, so applying it twice is applying it
 * once. Hand it the live value instead and every click adds the same distance
 * again.
 *
 * It is deliberately an arithmetic answer to an arithmetic question, offered as
 * a number the user then applies: nothing here decides that −1 dBTP is the
 * right ceiling for this song.
 *
 * Returns null when the render was silent (nothing to measure against).
 */
export function gainForTruePeak(analysis, targetDb, atGainDb = 0) {
  const peak = analysis.post.truePeakDb;
  if (!Number.isFinite(peak) || peak <= -144) return null;
  return atGainDb + (targetDb - peak);
}

/** …and the same for a loudness target, in LUFS. */
export function gainForLoudness(analysis, targetLufs, atGainDb = 0) {
  const i = analysis.post.integratedLufs;
  if (!Number.isFinite(i)) return null;
  return atGainDb + (targetLufs - i);
}

/**
 * The input trim that would present the mix to the chain's PROCESSING at
 * `targetLufs` — how you set a compressor threshold up once and have it mean
 * the same thing on the next song.
 *
 * It does not read the current trim, and cannot: the pre tap measures the mix
 * arriving at the chain, which is upstream of the trim (that is what makes it
 * a clean A/B against the finished master). So the answer is the whole distance
 * from the mix's own loudness to the target, whatever the trim happens to be.
 */
export function trimForLoudness(analysis, targetLufs) {
  const i = analysis.pre.integratedLufs;
  if (!Number.isFinite(i)) return null;
  return targetLufs - i;
}

