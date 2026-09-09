// Shared spectrum machinery: the FFT itself, the band split every spectral
// display in the app agrees on, and the framer that turns a stream of samples
// into per-band energy.
//
// It lives here rather than beside its first user because it now has three:
// the radiation surface and the soundfield cloud (src/ui/), the Mastering
// view's live spectrometer, and the offline spectral analysis (src/audio/).
// Pure computation with no DOM and no engine state, so it satisfies the
// src/engine/ rule and can be unit-tested on its own.
//
// The FFT is the one radiation.js has always used, moved verbatim — the
// radiation surface and the cloud still import it from there, so nothing about
// their numbers changed.

/** Iterative radix-2 complex FFT with precomputed twiddles and bit reversal. */
export class Fft {
  constructor(n) {
    if ((n & (n - 1)) !== 0) throw new Error("Fft: size must be a power of two");
    this.n = n;
    const bits = Math.round(Math.log2(n));
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n >> 1);
    this.sin = new Float64Array(n >> 1);
    for (let i = 0; i < n >> 1; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
  }

  /** In place, decimation in time. */
  run(re, im) {
    const n = this.n;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const a = i + k;
          const b = a + half;
          const wr = this.cos[t];
          const wi = this.sin[t];
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

/** A Hann taper of length `n`, plus the Σw² Parseval needs. */
export function hannWindow(n) {
  const w = new Float64Array(n);
  let ss = 0;
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    ss += w[i] * w[i];
  }
  return { win: w, sumSq: ss };
}

/**
 * The five bands every spectral display in the app splits on — the mixing-desk
 * octave groups, low to high. `RAD_BANDS` (src/ui/radiation.js) is this list
 * with a theme ink attached to each entry, which is why the radiation surface,
 * the soundfield cloud, the Mastering view's spectrometer and its offline
 * spectrogram all read the same colour for the same frequencies.
 */
export const SPECTRUM_BANDS = Object.freeze([
  Object.freeze({ lo: 20, hi: 200, label: "20–200 Hz" }),
  Object.freeze({ lo: 200, hi: 800, label: "200–800 Hz" }),
  Object.freeze({ lo: 800, hi: 2000, label: "800 Hz–2 kHz" }),
  Object.freeze({ lo: 2000, hi: 8000, label: "2–8 kHz" }),
  Object.freeze({ lo: 8000, hi: 20000, label: "8–20 kHz" }),
]);
export const SPECTRUM_NBANDS = SPECTRUM_BANDS.length;

/**
 * DISPLAY TILT — +3 dB per octave, the pink slope, applied to a spectrum before
 * it is drawn and never to anything that is measured.
 *
 * Real music is not flat: its energy falls away with frequency at close to this
 * rate, so an untilted analyser hands most of its height to the bass and the
 * top two octaves — where a good deal of what you are actually EQ-ing lives —
 * never get to say anything. Tilting by the slope music already has makes a
 * balanced mix read as roughly level, so the shape on screen is telling you
 * about THIS mix rather than about the shape of music in general. Pink noise
 * comes out flat, which is what makes 3 dB/octave the standard choice.
 *
 * The pivot is cosmetic — it scales every bin by one constant — so only the
 * SLOPE is visible; 1 kHz because that is where a reference is expected to be,
 * and because the radiation surface already tilts about the same point.
 */
export const SPECTRUM_TILT_DB_PER_OCT = 3;
export const SPECTRUM_TILT_PIVOT_HZ = 1000;

/** The tilt as a LEVEL offset in dB at `hz` — what a display adds to a bin. */
export function tiltDbAt(hz, dbPerOct = SPECTRUM_TILT_DB_PER_OCT,
                         pivotHz = SPECTRUM_TILT_PIVOT_HZ) {
  return hz > 0 ? dbPerOct * Math.log2(hz / pivotHz) : 0;
}

/** …and as a per-bin POWER weight, for a display that sums energy into bands.
 *  Bin 0 is DC and carries no octave, so its weight is 0. */
export function tiltWeights(n, rate, dbPerOct = SPECTRUM_TILT_DB_PER_OCT,
                            pivotHz = SPECTRUM_TILT_PIVOT_HZ) {
  const half = n >> 1;
  const w = new Float64Array(half);
  const binHz = rate / n;
  for (let k = 1; k < half; k++) {
    w[k] = 10 ** (tiltDbAt(k * binHz, dbPerOct, pivotHz) / 10);
  }
  return w;
}

/**
 * Turns a stream of mono samples into per-band mean-square energy.
 *
 * Feed it whatever blocks you have — a render chunk, a snapshot's worth — and
 * it collects them into overlapping windows of `n` samples advanced by `hop`,
 * transforms each, and hands the five band energies to `onFrame`. Pacing the
 * analysis in AUDIO time rather than in caller-sized blocks is what makes an
 * offline pass and a live one produce the same picture of the same music.
 *
 * Energies are Parseval-normalised, so a full-scale sine inside one band reads
 * that band at its own mean square (0.5) and the dB figures are dBFS rather
 * than FFT-scaling accidents.
 */
export class BandAnalyser {
  /**
   * @param tiltDbPerOct  DISPLAY tilt, in dB per octave, folded into the
   *   per-bin weights (see SPECTRUM_TILT_DB_PER_OCT). 0 — the default — is a
   *   plain measurement; anything else makes the output a picture, not a figure.
   */
  constructor(rate, { n = 2048, hop = 512, tiltDbPerOct = 0 } = {}) {
    this.n = n;
    this.hop = hop;
    this.tiltDbPerOct = tiltDbPerOct;
    this.tilt = tiltDbPerOct === 0 ? null : tiltWeights(n, rate, tiltDbPerOct);
    this.fft = new Fft(n);
    const { win, sumSq } = hannWindow(n);
    this.win = win;
    this.norm = 1 / ((n / 2) * sumSq);
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.buf = new Float64Array(n);
    this.fill = 0;      // samples held in `buf`, always < n after a flush
    this.bandOf = new Int8Array(n >> 1);
    const binHz = rate / n;
    for (let k = 0; k < n >> 1; k++) {
      const f = k * binHz;
      let b = -1;
      for (let i = 0; i < SPECTRUM_NBANDS; i++) {
        if (f >= SPECTRUM_BANDS[i].lo && f < SPECTRUM_BANDS[i].hi) { b = i; break; }
      }
      this.bandOf[k] = b;
    }
    this.bands = new Float64Array(SPECTRUM_NBANDS);
  }

  reset() { this.buf.fill(0); this.fill = 0; }

  /**
   * Push `count` samples from `src` (offset `off`). `onFrame(bands)` fires once
   * per completed window with this instance's own `bands` array — read it or
   * copy it before returning, it is reused.
   */
  push(src, off, count, onFrame) {
    let i = 0;
    while (i < count) {
      const room = this.n - this.fill;
      const take = Math.min(room, count - i);
      for (let k = 0; k < take; k++) this.buf[this.fill + k] = src[off + i + k];
      this.fill += take;
      i += take;
      if (this.fill < this.n) return;
      this._analyse(onFrame);
      // Slide by the hop, keeping the overlap.
      this.buf.copyWithin(0, this.hop);
      this.fill = this.n - this.hop;
    }
  }

  _analyse(onFrame) {
    const n = this.n;
    for (let k = 0; k < n; k++) { this.re[k] = this.buf[k] * this.win[k]; this.im[k] = 0; }
    this.fft.run(this.re, this.im);
    this.bands.fill(0);
    const tilt = this.tilt;
    for (let k = 1; k < n >> 1; k++) {
      const b = this.bandOf[k];
      if (b < 0) continue;
      const p = (this.re[k] * this.re[k] + this.im[k] * this.im[k]) * this.norm;
      // Per BIN, not per band: a band three octaves wide has no single tilt.
      this.bands[b] += tilt === null ? p : p * tilt[k];
    }
    onFrame(this.bands);
  }
}

/**
 * One window's magnitude spectrum in dBFS, for a display that wants bins rather
 * than bands. `samples` is a power-of-two RING read forward from `from`, which
 * is how the metering tap hands its audio over. `out` is filled with n/2
 * entries; `floorDb` is what silence reads.
 *
 * Bin levels carry the Hann window's scalloping: a tone spreads over about
 * three bins and no single one of them holds its whole power (their SUM does).
 * That is fine for a display and wrong for a measurement — use BandAnalyser,
 * which sums, when the number has to mean something.
 */
export function spectrumDb(fft, win, norm, samples, from, out, floorDb = -120) {
  const n = fft.n;
  const re = spectrumDb._re && spectrumDb._re.length === n ? spectrumDb._re
    : (spectrumDb._re = new Float64Array(n));
  const im = spectrumDb._im && spectrumDb._im.length === n ? spectrumDb._im
    : (spectrumDb._im = new Float64Array(n));
  const mask = samples.length - 1;
  for (let k = 0; k < n; k++) {
    re[k] = samples[(from + k) & mask] * win[k];
    im[k] = 0;
  }
  fft.run(re, im);
  const half = n >> 1;
  for (let k = 0; k < half; k++) {
    const p = (re[k] * re[k] + im[k] * im[k]) * norm;
    out[k] = p > 0 ? Math.max(10 * Math.log10(p), floorDb) : floorDb;
  }
  return out;
}
