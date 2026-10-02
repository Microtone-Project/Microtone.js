// Soundfield cloud (item 133) — the master strip's fourth scope family, and the
// only one that draws the spatial IMAGE rather than the field itself.
//
// The radiation monitor (radiation.js) answers "what does the field radiate in
// each direction?" exactly, and bluntly: it is one smooth surface, so two
// sources thirty degrees apart are one broad lobe. This one asks the sharper
// question — "where is the energy actually coming FROM, frequency by
// frequency?" — and answers it as a cloud of splats, one per frequency tile.
// Different sources occupy different tiles, so they separate.
//
// ── The parameters, per bin ──
// The ring is SECOND-ORDER B-format. Order 1 gives a complex pressure W and a
// complex velocity v = (X, Y, Z); from them, three real quantities:
//
//     P  = |W|²                     the pressure power
//     Ia = Re{ conj(W)·v }          the ACTIVE intensity — net transport
//     Vt = |v|²                     the velocity power
//
// (Ia points AT the source in our SN3D convention — see encodeSN3D.)
//
// ── The radius is |Ia| / P, and that IS the transfer function ──
// For two coherent sources at ±θ the arithmetic gives, with no fitting and no
// curve, exactly
//
//     |Ia| / P = cos θ
//
// so a single source (θ = 0) is at the rim, an ordinary ±30° stereo pair sits
// at cos 30° = 0.87, ±60° at 0.5, and ±90° — equidistant either side of you —
// at 0. That last is the in-head phantom you actually hear from such a pair.
//
// ── …but only for the part of the field that PROPAGATES ──
// Invert one source of a pair and W cancels to nothing: there is no net
// transport at all, Ia = 0, and a radius alone would send it to the centre —
// to exactly where the in-phase pair goes. That is wrong twice over, because an
// anti-phase pair does not image in the middle; it is heard as two separate
// sources, wide apart.
//
// So the bin is SPLIT, by how much of the velocity the pressure can explain:
//
//     Vres = max(0, Vt − P)         velocity the pressure cannot account for
//
// — because a propagating wave carries exactly as much velocity power as
// pressure power, so any EXCESS is air being moved by sources that are
// cancelling each other in pressure. The propagating part becomes ONE splat at Î_a
// with the radius above; the residue becomes a PAIR of splats on the rim, at
// both ends of the axis the residual velocity oscillates along. A single source
// and an in-phase pair have no residue at all, an anti-phase pair is nothing
// but residue, and real material is a mixture — which is the point.
//
// ── …and order 2 says WHERE the two of them are ──
// At first order that residue is only an AXIS. Worse, it is the same axis
// whatever the separation: two anti-phase sources at ±15° and at ±90° encode to
// identical W Y Z X, so a first-order display has to draw both of them a full
// 180° apart and overstate the width of every one.
//
// Order 2 breaks it. For an anti-phase pair the order-2 field is a pure
// quadrupole,
//
//     T = a·sin2θ·(ĉ ûᵀ + û ĉᵀ)
//
// with û the dipole axis order 1 already gave and ĉ the bearing the pair
// straddles. Since ĉ ⊥ û, one matrix-vector product recovers both:
//
//     T û = a·sin2θ·ĉ        ⇒   ĉ = normalise(T û),  cos θ = |T û| / |v|
//
// and the two sources are ĉ·cos θ ± û·sin θ. Exact, in three dimensions, at any
// bearing and any elevation — so an anti-phase pair is drawn where it actually
// is rather than flung to the edges.
//
// ── What the splats carry ──
//   position  the intensity direction, at the radius above (or the rim, for
//             the anti-phase pair)
//   colour    the tile's band (RAD_BANDS), same inks as the radiation surface
//   SIZE      the tile's level in DECIBELS, after the same +4.5 dB/oct tilt
//   ALPHA     how much of that direction is still being HELD — see below
//
// ── Size and opacity are both the level ──
// A splat's size and its opacity are the same reading — its level in decibels,
// after the same tilt the radiation surface uses. Loud is big and solid, quiet
// is small and faint, and the two never disagree with one another. (An earlier
// pass drove opacity from whether the note's key was still down; it made a song
// with no key-offs at all read as a flat wall, and one reading per channel is
// worth more than two that compete.)
//
// Nothing here touches the DOM: the analyser owns typed arrays and the renderer
// fills a caller's RGBA bytes, exactly as crtbeam.js and radiation.js do.

import {
  SCOPE_CHANNELS, SCOPE_FRAMES, SCOPE_W, SCOPE_Y, SCOPE_Z, SCOPE_X, SCOPE_ORDER2,
} from "../../core/engine/analysis.js";
import { Fft, RAD_BANDS, RAD_NBANDS, radTilt } from "./radiation.js";

/** Analysis window and hop — the radiation monitor's, so both families see the
 *  same 43 ms of audio and a panel of each agrees about the moment. */
export const CLOUD_FFT = 1024;
export const CLOUD_HOP = 512;

/** Bins quieter than this below the loudest one are dropped: between the
 *  partials there is only leakage, and leakage has no direction to report. */
export const CLOUD_FLOOR_DB = -42;

/**
 * How far past the rim the propagating radius is allowed to read. |Ia|/P is
 * cos θ for a clean pair, but a bin holding several unrelated things can put
 * more velocity under the pressure than a plane wave would, so it is clamped.
 */
export const CLOUD_R_MAX = 1;

/** How much of the dial the rim is. */
export const CLOUD_FILL = 0.94;

/** Splat size, as a fraction of the dial's radius, over CLOUD_SIZE_DB of level.
 *  Opacity follows the same decibels over the same range, so size and weight
 *  say one thing together instead of two things at once. */
export const CLOUD_SIG_MIN = 0.018;
export const CLOUD_SIG_MAX = 0.075;
export const CLOUD_SIZE_DB = 40;

/** Phosphor. The cloud is an accumulation — a still frame of it is a handful of
 *  dots, and what makes it a CLOUD is the trail the image leaves as it moves. */
export const CLOUD_TAU_MS = 230;
export const CLOUD_FLOOR = 1e-4;

/** Faintest a splat gets at the bottom of CLOUD_SIZE_DB, so the quiet end of
 *  the spectrum thins out rather than vanishing outright. */
export const CLOUD_ALPHA_MIN = 0.06;

/**
 * DEPTH. The projection is orthographic, so without a cue a splat behind you
 * and one in front of you land in the same place looking identical. Aerial
 * perspective is the one channel still free: what is far off is DIMMER and
 * slightly out of FOCUS, while hue stays the band's own and the radius stays
 * the phantom distance. Size still reads level — the defocus is small next to
 * the four-to-one range level covers, and it always arrives together with the
 * dimming, so the pair read as distance rather than as a quieter sound.
 */
export const CLOUD_DEPTH_DIM = 0.4;   // what the farthest splat keeps
export const CLOUD_DEPTH_BLUR = 1.5;  // …and how much wider it spreads

/**
 * AUTO-GAIN. Both the analysis and the develop are normalised, and both were
 * doing it INSTANTANEOUSLY — every window re-referenced to its own loudest bin
 * and every frame re-scanned the accumulator's peak — so on busy material the
 * whole display's brightness wobbled at the analysis rate instead of following
 * the music. Both references are now slewed, and asymmetrically: quick to rise
 * so a transient cannot blow the display out, slow to fall so the gaps between
 * notes do not pump the gain back up.
 */
export const CLOUD_GAIN_ATTACK_MS = 150;
export const CLOUD_GAIN_RELEASE_MS = 1400;

/** Energy that develops to ~63% ink, as a fraction of the (slewed) peak. */
export const CLOUD_REF = 0.42;
export const CLOUD_GAMMA = 0.7071;
export const CLOUD_BLOOM = 9;
export const CLOUD_DEVELOP_GAIN = 1.4142;

// ── pure helpers (unit-tested in test/node/cloud.test.js) ──────────────────

/**
 * The radius of the propagating part: |Ia| / P, clamped. This IS the transfer
 * function — for a coherent pair at ±θ it comes out as cos θ exactly, so ±60°
 * lands on 0.5 and ±90° on the centre with nothing fitted.
 */
export function cloudRadius(iaMag, p) {
  if (!(p > 0) || !(iaMag > 0)) return 0;
  const r = iaMag / p;
  return r > CLOUD_R_MAX ? CLOUD_R_MAX : r;
}

/** What a coherent pair at ±`half` radians is supposed to read. The tests hold
 *  the analyser to this; it is the spec, not an implementation detail. */
export function cloudPairRadius(half) {
  const c = Math.cos(half);
  return c < 0 ? 0 : c;
}

/** The separation a radius stands for, in radians of HALF-angle — the inverse
 *  of cloudPairRadius, for reading the display back. */
export function cloudHalfAngle(r) {
  return Math.acos(r < 0 ? 0 : r > 1 ? 1 : r);
}

/** Level in dB below the frame's loudest bin → splat opacity, 0…1. */
export function cloudLevelAlpha(db) {
  const t = 1 + db / CLOUD_SIZE_DB;
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return CLOUD_ALPHA_MIN + (1 - CLOUD_ALPHA_MIN) * u;
}

/** Level in dB below the frame's loudest bin → splat σ, in dial radii. */
export function cloudSigma(db) {
  const t = 1 + db / CLOUD_SIZE_DB; // 1 at the peak, 0 at the bottom of the range
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return CLOUD_SIG_MIN + (CLOUD_SIG_MAX - CLOUD_SIG_MIN) * u;
}

/** Depth (−1 behind … +1 toward you) → the dim and the defocus that go with it. */
export function cloudDepthDim(depth) {
  const t = depth * 0.5 + 0.5;
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return CLOUD_DEPTH_DIM + (1 - CLOUD_DEPTH_DIM) * u;
}
export function cloudDepthBlur(depth) {
  const t = depth * 0.5 + 0.5;
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return CLOUD_DEPTH_BLUR + (1 - CLOUD_DEPTH_BLUR) * u;
}

/** Fraction of a splat's energy left after `dtMs` of decay. */
export function cloudDecay(dtMs, tauMs = CLOUD_TAU_MS) {
  return dtMs <= 0 ? 1 : Math.exp(-dtMs / tauMs);
}

/** Accumulated energy → ink alpha, 0…1. */
export function cloudAlpha(energy, ref = CLOUD_REF, gamma = CLOUD_GAMMA) {
  if (!(energy > 0)) return 0;
  return Math.pow(1 - Math.exp(-energy / ref), 1 / gamma);
}

// ── the field ─────────────────────────────────────────────────────────────

/** Splat record stride in the flat array: dir(3), radius, sigma, alpha, band. */
const S_DX = 0, S_DY = 1, S_DZ = 2, S_R = 3, S_SIG = 4, S_A = 5, S_BAND = 6;
const S_STRIDE = 7;
const INV_SQRT3 = 1 / Math.sqrt(3);

/**
 * One analysis of the soundfield into splats. The strip owns exactly one
 * however many cloud panels are up — they are three cameras on one image.
 */
export class CloudField {
  constructor(n = CLOUD_FFT) {
    this.fft = new Fft(n);
    this.n = n;
    this.win = new Float64Array(n);
    let ss = 0;
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
      this.win[i] = w;
      ss += w * w;
    }
    this.norm = 1 / ((n / 2) * ss);
    // Nine real channels ride in five complex transforms, two channels to a
    // transform (the last carries only ACN 8).
    this.fre = [];
    this.fim = [];
    for (let i = 0; i < 5; i++) {
      this.fre.push(new Float64Array(n));
      this.fim.push(new Float64Array(n));
    }

    const half = n >> 1;
    this.band = new Int8Array(half);   // −1 = outside every band
    this.tilt = new Float64Array(half);
    this.binHz = 0;

    this.splats = new Float32Array(half * 3 * S_STRIDE);
    this.count = 0;
    this.pending = 0;
    this.ready = false;
    this.ref = 0; // slewed loudest-bin reference — see CLOUD_GAIN_ATTACK_MS

  }

  reset() {
    this.count = 0;
    this.ref = 0;
    this.pending = 0;
    this.ready = false;
    this.ref = 0; // slewed loudest-bin reference — see CLOUD_GAIN_ATTACK_MS
  }

  setSampleRate(rate) {
    const binHz = rate / this.n;
    if (binHz === this.binHz) return;
    this.binHz = binHz;
    for (let k = 0; k < this.band.length; k++) {
      const hz = k * binHz;
      let b = -1;
      for (let i = 0; i < RAD_NBANDS; i++) {
        if (hz >= RAD_BANDS[i].lo && hz < RAD_BANDS[i].hi) { b = i; break; }
      }
      this.band[k] = b;
      this.tilt[k] = radTilt(hz);
    }
  }

  /** Write one splat. Size and opacity are the same reading — its own level in
   *  decibels below the loudest bin of the window. */
  _emit(splats, count, dx, dy, dz, r, rel, band) {
    const o = count * S_STRIDE;
    const db = 10 * Math.log10(rel > 1e-12 ? rel : 1e-12);
    splats[o + S_DX] = dx;
    splats[o + S_DY] = dy;
    splats[o + S_DZ] = dz;
    splats[o + S_R] = r;
    splats[o + S_SIG] = cloudSigma(db);
    splats[o + S_A] = cloudLevelAlpha(db);
    splats[o + S_BAND] = band;
    return count + 1;
  }

  /**
   * Fold the newest window of the B-format ring into a set of splats. Paced by
   * CLOUD_HOP of AUDIO, like the radiation monitor, so the cost does not follow
   * the frame rate.
   *
   * @returns {boolean} whether a new window was analysed
   */
  analyse(ring, ringWrite, rate, fresh) {
    this.setSampleRate(rate);
    this.pending += fresh;
    if (this.pending < CLOUD_HOP && this.ready) return false;
    this.pending = 0;
    this.ready = true;

    const n = this.n;
    const w = this.win;
    const fre = this.fre, fim = this.fim;
    let idx = (((ringWrite - n) % SCOPE_FRAMES) + SCOPE_FRAMES) % SCOPE_FRAMES;
    for (let i = 0; i < n; i++) {
      const o = idx * SCOPE_CHANNELS;
      const g = w[i];
      // Channel pairs: (W,Y) (Z,X) (ACN4,ACN5) (ACN6,ACN7) (ACN8, —).
      for (let t = 0; t < 5; t++) {
        const a = t * 2;
        fre[t][i] = ring[o + a] * g;
        fim[t][i] = a + 1 < SCOPE_CHANNELS ? ring[o + a + 1] * g : 0;
      }
      idx = idx + 1 === SCOPE_FRAMES ? 0 : idx + 1;
    }
    for (let t = 0; t < 5; t++) this.fft.run(fre[t], fim[t]);
    const re1 = fre[0], im1 = fim[0], re2 = fre[1], im2 = fim[1];

    // Two passes: the splat's SIZE is its level relative to the loudest bin,
    // which is not known until every bin has been measured. The first keeps the
    // spectra, the second splits each bin and emits its splats.
    const half = n >> 1;
    const norm = this.norm;
    const splats = this.splats;
    let count = 0;
    let peak = 0;
    const raw = this._raw ?? (this._raw = new Float64Array(half));
    const sw = this._sw ?? (this._sw = new Float64Array(half * 2));      // W re,im
    const sv = this._sv ?? (this._sv = new Float64Array(half * 6));      // v re×3, im×3
    const s2 = this._s2 ?? (this._s2 = new Float64Array(half * 10));     // order 2, re×5, im×5
    for (let k = 1; k < half; k++) {
      const b = this.band[k];
      if (b < 0) { raw[k] = 0; continue; }
      const kr = n - k;
      const wr = (re1[k] + re1[kr]) * 0.5;
      const wi = (im1[k] - im1[kr]) * 0.5;
      const yr = (im1[k] + im1[kr]) * 0.5;
      const yi = (re1[kr] - re1[k]) * 0.5;
      const zr = (re2[k] + re2[kr]) * 0.5;
      const zi = (im2[k] - im2[kr]) * 0.5;
      const xr = (im2[k] + im2[kr]) * 0.5;
      const xi = (re2[kr] - re2[k]) * 0.5;
      sw[k * 2] = wr; sw[k * 2 + 1] = wi;
      // The five order-2 harmonics (ACN 4..8), unpacked the same way — they
      // are what locates an anti-phase pair.
      const o10 = k * 10;
      for (let c = 0; c < 5; c++) {
        const t = 2 + (c >> 1);
        const pr = fre[t], pi = fim[t];
        if ((c & 1) === 0) {                    // the real half of that pair
          s2[o10 + c] = (pr[k] + pr[kr]) * 0.5;
          s2[o10 + 5 + c] = (pi[k] - pi[kr]) * 0.5;
        } else {                                // the imaginary half
          s2[o10 + c] = (pi[k] + pi[kr]) * 0.5;
          s2[o10 + 5 + c] = (pr[kr] - pr[k]) * 0.5;
        }
      }
      // v is stored (front, left, up) — the order every direction here uses.
      const o6 = k * 6;
      sv[o6] = xr; sv[o6 + 1] = yr; sv[o6 + 2] = zr;
      sv[o6 + 3] = xi; sv[o6 + 4] = yi; sv[o6 + 5] = zi;
      const P = wr * wr + wi * wi;
      const Vt = xr * xr + xi * xi + yr * yr + yi * yi + zr * zr + zi * zi;
      const t = (P + Vt) * 0.5 * norm * this.tilt[k];
      raw[k] = t;
      if (t > peak) peak = t;
    }

    // The dB every splat's size and opacity are measured against is a SLEWED
    // peak, not this window's own — otherwise a window that happens to be quiet
    // re-references its handful of bins to 0 dB and the display flares.
    // One hop of audio per step, so the slew is in audio time.
    const hopMs = (CLOUD_HOP / rate) * 1000;
    const tau = peak > this.ref ? CLOUD_GAIN_ATTACK_MS : CLOUD_GAIN_RELEASE_MS;
    this.ref += (peak - this.ref) * (1 - Math.exp(-hopMs / tau));
    const ref = this.ref > 1e-30 ? this.ref : peak;

    if (peak > 0 && ref > 0) {
      const floor = ref * Math.pow(10, CLOUD_FLOOR_DB / 10);
      const invPeakDb = 1 / ref;
      for (let k = 1; k < half; k++) {
        const t = raw[k];
        if (!(t > floor)) continue;
        const band = this.band[k];
        const wr = sw[k * 2], wi = sw[k * 2 + 1];
        const o6 = k * 6;
        const o10 = k * 10;
        const xr = sv[o6], yr = sv[o6 + 1], zr = sv[o6 + 2];
        const xi = sv[o6 + 3], yi = sv[o6 + 4], zi = sv[o6 + 5];

        const P = wr * wr + wi * wi;
        const Vt = xr * xr + xi * xi + yr * yr + yi * yi + zr * zr + zi * zi;
        // Ia = Re{conj(W)·v}
        const iax = wr * xr + wi * xi;
        const iay = wr * yr + wi * yi;
        const iaz = wr * zr + wi * zi;
        const iaMag = Math.sqrt(iax * iax + iay * iay + iaz * iaz);
        // A PROPAGATING wave carries exactly as much velocity power as
        // pressure power. So velocity in EXCESS of the pressure cannot be
        // propagating at all — it is the part where the sources are cancelling
        // in pressure while still moving the air, which is precisely what an
        // out-of-phase pair does. That excess is the split.
        const vprop = Vt < P ? Vt : P;
        const vres = Vt - P > 0 ? Vt - P : 0;
        const eTot = (P + Vt) * 0.5;
        const share = eTot > 0 ? t / eTot : 0; // energy → display weight

        // (1) the PROPAGATING splat, at cos θ of the pair that would make it.
        const wIn = (P + vprop) * 0.5 * share;
        if (wIn > floor && iaMag > 1e-30) {
          const dx = iax / iaMag, dy = iay / iaMag, dz = iaz / iaMag;
          count = this._emit(splats, count, dx, dy, dz,
            cloudRadius(iaMag, P), wIn * invPeakDb, band);
        }

        // (2) the ANTI-PHASE pair, on the rim at both ends of the axis the
        // residual velocity oscillates along — two distinct sources, which is
        // what an out-of-phase pair is heard as.
        const wRes = vres * 0.5 * share;
        if (wRes > floor) {
          // The residue oscillates along an axis. Its ellipse degenerates to a
          // line for the case that matters, so the longer of the real and
          // imaginary parts IS that axis — and the same part of the order-2
          // field is the quadrupole that goes with it.
          const lr = xr * xr + yr * yr + zr * zr;
          const li = xi * xi + yi * yi + zi * zi;
          const useRe = lr >= li;
          const len = Math.sqrt(useRe ? lr : li);
          if (len > 1e-30) {
            const ux = (useRe ? xr : xi) / len;
            const uy = (useRe ? yr : yi) / len;
            const uz = (useRe ? zr : zi) / len;
            // T û, where T is the traceless quadrupole the order-2 channels
            // carry: ĉ = normalise(T û) and cos θ = |T û| / |v|.
            const q = o10 + (useRe ? 0 : 5);
            const mxy = s2[q] * INV_SQRT3;
            const myz = s2[q + 1] * INV_SQRT3;
            const mzz = s2[q + 2] * (2 / 3);
            const mxz = s2[q + 3] * INV_SQRT3;
            const dxy = s2[q + 4] * INV_SQRT3 * 2; // Mxx − Myy
            const mxx = -mzz / 2 + dxy / 2;
            const myy = -mzz / 2 - dxy / 2;
            const cx = mxx * ux + mxy * uy + mxz * uz;
            const cy = mxy * ux + myy * uy + myz * uz;
            const cz = mxz * ux + myz * uy + mzz * uz;
            const cLen = Math.sqrt(cx * cx + cy * cy + cz * cz);
            const halfW = wRes * 0.5 * invPeakDb;
            let cosT = cLen / len;
            if (!(cosT > 0)) cosT = 0;
            if (cosT > 1) cosT = 1;
            if (cLen > 1e-30 && cosT > 1e-4) {
              // Both bearings, exactly: ĉ·cos θ ± û·sin θ.
              const sinT = Math.sqrt(1 - cosT * cosT);
              const hx = cx / cLen, hy = cy / cLen, hz = cz / cLen;
              count = this._emit(splats, count, hx * cosT + ux * sinT,
                hy * cosT + uy * sinT, hz * cosT + uz * sinT, 1, halfW, band);
              count = this._emit(splats, count, hx * cosT - ux * sinT,
                hy * cosT - uy * sinT, hz * cosT - uz * sinT, 1, halfW, band);
            } else {
              // No usable quadrupole — the pair really is on the axis.
              count = this._emit(splats, count, ux, uy, uz, 1, halfW, band);
              count = this._emit(splats, count, -ux, -uy, -uz, 1, halfW, band);
            }
          }
        }
      }
    }
    this.count = count;
    return true;
  }
}

// ── the renderer ──────────────────────────────────────────────────────────

/**
 * One panel's camera and its accumulator. Additive and unbounded, decayed by
 * wall time and developed at the end through a saturating response — the same
 * order crtbeam.js uses, and for the same reason: saturate first and the
 * twentieth splat on a spot would look like the second.
 */
export class CloudView {
  constructor(size) {
    this.size = 0;
    this.acc = null; // linear-light RGB energy
    this.ref = 0;    // slewed develop reference — see CLOUD_GAIN_ATTACK_MS
    this.resize(size);
  }

  resize(size) {
    const s = Math.max(4, Math.round(size));
    if (s === this.size) return;
    this.size = s;
    this.acc = new Float64Array(s * s * 3);
    this.gx = new Float64Array(s); // one splat's horizontal Gaussian factors (splat)
  }

  clear() { this.acc.fill(0); this.ref = 0; }

  /** Advance the accumulator by `dtMs` of wall time. */
  decay(dtMs) {
    if (!(dtMs > 0)) return;
    const k = cloudDecay(dtMs);
    const a = this.acc;
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (v === 0) continue;
      const d = v * k;
      a[i] = d > CLOUD_FLOOR ? d : 0;
    }
  }

  /**
   * Lay one analysis of `field` down through `basis`. `bandLin` is RAD_NBANDS
   * linear-light RGB triples, and `weight` scales the whole deposit (so a frame
   * that covers more wall time is worth more).
   */
  splat(field, basis, bandLin, weight = 1) {
    const size = this.size;
    const acc = this.acc;
    const mid = size / 2;
    const rad = size / 2 - 1;
    const h = basis.h, v = basis.v, d = basis.d;
    const s = field.splats;
    for (let i = 0; i < field.count; i++) {
      const o = i * S_STRIDE;
      const r = s[o + S_R];
      const px = s[o + S_DX] * r, py = s[o + S_DY] * r, pz = s[o + S_DZ] * r;
      const sx = mid + (px * h[0] + py * h[1] + pz * h[2]) * rad;
      const sy = mid - (px * v[0] + py * v[1] + pz * v[2]) * rad;
      // Aerial perspective: what is pointing away from you is dimmer and a
      // little out of focus. `pz`-style depth is the splat's own bearing along
      // the camera axis, so it is the DIRECTION that recedes, not the radius.
      const depth = s[o + S_DX] * d[0] + s[o + S_DY] * d[1] + s[o + S_DZ] * d[2];
      const sig = s[o + S_SIG] * rad * cloudDepthBlur(depth);
      const alpha = s[o + S_A] * cloudDepthDim(depth);
      if (!(alpha > 0.002)) continue;
      // Charge conservation: a splat carries the same total energy however
      // wide it is, so SIZE reads as level without also reading as brightness.
      const amp = (alpha * weight) / (2 * Math.PI * sig * sig);
      const c = bandLin[s[o + S_BAND]];
      const reach = Math.ceil(3 * sig);
      const inv = 1 / (2 * sig * sig);
      let x0 = Math.floor(sx - reach), x1 = Math.ceil(sx + reach);
      let y0 = Math.floor(sy - reach), y1 = Math.ceil(sy + reach);
      if (x0 < 0) x0 = 0;
      if (y0 < 0) y0 = 0;
      if (x1 > size - 1) x1 = size - 1;
      if (y1 > size - 1) y1 = size - 1;
      // The Gaussian is separable — e^(−(dx²+dy²)k) = e^(−dx²k)·e^(−dy²k) — so
      // a splat costs one exp per column and one per row instead of one per
      // pixel it covers: the transcendental was most of this panel's frame.
      const gx = this.gx;
      for (let px2 = x0; px2 <= x1; px2++) {
        const dx = px2 + 0.5 - sx;
        gx[px2 - x0] = Math.exp(-(dx * dx) * inv);
      }
      const r0 = c[0] * amp, g0 = c[1] * amp, b0 = c[2] * amp;
      for (let py2 = y0; py2 <= y1; py2++) {
        const dy = py2 + 0.5 - sy;
        const gy = Math.exp(-(dy * dy) * inv);
        if (gy < 1e-3) continue; // every pixel on the row is below the cut
        const row = py2 * size;
        for (let px2 = x0; px2 <= x1; px2++) {
          const g = gx[px2 - x0] * gy;
          if (g < 1e-3) continue;
          const p = (row + px2) * 3;
          acc[p] += r0 * g;
          acc[p + 1] += g0 * g;
          acc[p + 2] += b0 * g;
        }
      }
    }
  }

  /** Develop into RGBA bytes: density → opacity, ratio → hue, overdrive →
   *  toward `core` (white on a dark ground, black on a light one). */
  develop(out, core, dtMs = 16) {
    const acc = this.acc;
    let peak = 0;
    for (let i = 0; i < acc.length; i += 3) {
      const l = acc[i] * 0.2126 + acc[i + 1] * 0.7152 + acc[i + 2] * 0.0722;
      if (l > peak) peak = l;
    }
    // Slewed, for the same reason the analysis reference is: a per-frame
    // rescale makes the whole picture breathe at the frame rate.
    const want = peak * CLOUD_REF;
    const tau = want > this.ref ? CLOUD_GAIN_ATTACK_MS : CLOUD_GAIN_RELEASE_MS;
    this.ref += (want - this.ref) * (dtMs > 0 ? 1 - Math.exp(-dtMs / tau) : 1);
    const ref = this.ref;
    if (!(peak > 0) || !(ref > 0)) { out.fill(0); return; }
    for (let p = 0, i = 0; i < acc.length; p += 4, i += 3) {
      const r = acc[i], g = acc[i + 1], b = acc[i + 2];
      const lum = r * 0.2126 + g * 0.7152 + b * 0.0722;
      if (lum <= 0) { out[p + 3] = 0; continue; }
      const bloom = Math.min(1, (lum / (ref * CLOUD_BLOOM)) ** 2);
      const m = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const inv = m > 0 ? 1 / m : 0;
      out[p] = 255 * lerpTo(r * inv, core[0] / 255, bloom);
      out[p + 1] = 255 * lerpTo(g * inv, core[1] / 255, bloom);
      out[p + 2] = 255 * lerpTo(b * inv, core[2] / 255, bloom);
      out[p + 3] = Math.round(255 * CLOUD_DEVELOP_GAIN * cloudAlpha(lum, ref));
    }
  }

  /** Total energy on the screen — what the tests watch accumulate and decay. */
  totalEnergy() {
    let s = 0;
    for (let i = 0; i < this.acc.length; i++) s += this.acc[i];
    return s;
  }
}

function lerpTo(v, to, t) {
  const x = v + (to - v) * t;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
