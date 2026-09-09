// Ambisonic spectral radiation monitor (item 129) — the master strip's third
// scope family, and the only one that draws the field as a SOLID.
//
// The blobs family draws where the SOURCES are; the goniometer family draws the
// SOUND as a pair of axes. Neither can answer the question this one exists for:
// what does the field the song actually radiates LOOK like, and what is it made
// of? So this one builds a single three-dimensional surface —
//
//     r(θ, φ) = |p(θ, φ)|,   p(θ, φ) = W + Y·dy + Z·dz + X·dx
//
// — the coherent first-order beam steered in every direction at once, and looks
// at it through the same three orthographic cameras the other two families use.
// One soundfield, one surface, three observations: the front, side and top
// panels are the SAME object seen from three places, not three measurements.
//
// ── Why the sum happens before the magnitude ──
// p is LINEAR in the four B-format channels, so two sources that are coherent
// add as amplitudes and only then get squared. That is the whole point, and it
// is what a per-channel level meter can never show you:
//
//   * two equal in-phase sources 60° apart do not draw two lobes. They draw one
//     lobe between them, because that is what the field does — the phantom
//     centre is not a rendering rule, it is arithmetic.
//   * invert one of them and the same two sources draw two lobes with a null
//     between them, because p₁ + p₂ became p₁ − p₂ before the square.
//
// There is no special case in here for either. Phase is not a separate readout
// bolted to the side of the display; it is the shape.
//
// ── What is a band, and what is a colour ──
// The field is analysed in five bands (RAD_BANDS), over a spectrum TILTED by
// +4.5 dB/octave first (RAD_TILT_DB_PER_OCT) so that natural material reads
// balanced rather than as bass with a garnish. The SUM of the bands decides the
// geometry and their RATIO decides the colour, so a direction reads its spectrum
// as a hue and its energy as a distance — a quiet cymbal and a loud one are the
// same colour and different sizes, which is the only way a colour scale can mean
// anything at all.
//
// Each band's whole state is one 4×4 real symmetric cross-spectral matrix,
//
//     G_b[i][j] = Σ_{f ∈ b} Re{ S_i(f) · conj(S_j(f)) }
//
// and the directional energy falls straight out of it as a quadratic form,
// E_b(d) = cᵀ G_b c with c = [1, dy, dz, dx]. Ten numbers per band hold every
// interference relationship in it, which is why a thousand directions cost ten
// multiply-adds each instead of a thousand beamformers.
//
// ── Cost ──
// Nothing in here runs unless a radiation panel is on screen. The analysis is
// done ONCE per strip however many panels are up (they are views of one object),
// and it is paced by a hop in AUDIO time rather than by the frame rate, so a
// 144 Hz display does not pay three times over for the same window.
//
// Nothing here touches the DOM: the analyser owns typed arrays and the renderer
// fills a caller's RGBA bytes, exactly as crtbeam.js does, which is what lets
// test/node/radiation.test.js drive the real thing.

import {
  SCOPE_CHANNELS, SCOPE_FRAMES, SCOPE_W, SCOPE_Y, SCOPE_Z, SCOPE_X,
} from "../engine/analysis.js";
import { Fft, SPECTRUM_BANDS } from "../engine/fft.js";

// The FFT moved to src/engine/fft.js when the Mastering view (item 178) and the
// offline spectral analysis needed it too — same class, same numbers. Re-exported
// so cloud.js and the tests keep importing it from here.
export { Fft };

// ── the bands ─────────────────────────────────────────────────────────────

/**
 * Five bands, low to high, each with the theme ink that stands for it. They are
 * the pattern editor's effect-column ramp (salmon → yellow → green → cyan →
 * violet) on purpose: it is already a spectral order the eye reads without a
 * key, and it is already a colour set that survives all three themes.
 *
 * The edges are the usual mixing-desk octave groups rather than anything
 * psychoacoustic — the display answers "where is the bass sitting", not "how
 * loud is it in Bark 12".
 */
export const RAD_INKS = Object.freeze(["fxOp", "fxA1", "fxA2", "fxA3", "colPan"]);
export const RAD_BANDS = Object.freeze(SPECTRUM_BANDS.map((b, i) =>
  Object.freeze({ lo: b.lo, hi: b.hi, ink: RAD_INKS[i], label: b.label })));
export const RAD_NBANDS = RAD_BANDS.length;

/**
 * Analysis window. 2048 at 48 kHz is 43 ms and 23 Hz per bin — long enough that
 * the 20–200 Hz band is eight bins rather than two, short enough that the
 * surface still moves with the music.
 */
export const RAD_FFT = 2048;
/**
 * …advanced by this much of NEW AUDIO between analyses (4× overlap). Pacing the
 * analysis in audio time rather than in display frames is what keeps its cost —
 * and the look — the same on a 30 Hz display as on a 144 Hz one.
 */
export const RAD_HOP = 512;

/**
 * ANALYSIS TILT — +4.5 dB per octave, applied to the spectrum before any of it
 * becomes geometry or colour.
 *
 * Real music is not flat. Its energy falls away with frequency at something
 * close to this rate, so an untilted analyser hands almost the whole surface to
 * the bass: every mix comes out a salmon ball with a hint of everything else,
 * and the top two bands — where most of the width and height of a mix actually
 * lives — never get to say anything. Tilting the analysis is what makes a
 * natural spectrum read as balanced, so the shape and the colour are telling
 * you about this mix rather than about the shape of music in general.
 *
 * The pivot is cosmetic: it scales every band by one constant, and the geometry
 * is normalised and the colour is a ratio, so only the SLOPE is visible. 1 kHz
 * because that is where a reference is expected to be.
 *
 * It is deliberately NOT applied to the level the surface's presence and its
 * silence floor read — see `density`.
 */
export const RAD_TILT_DB_PER_OCT = 4.5;
export const RAD_TILT_PIVOT_HZ = 1000;

/**
 * The packed 4×4 symmetric cross-spectrum: four diagonals, then six
 * off-diagonals. `radMonomials` writes the matching direction terms, so the
 * quadratic form E(d) = cᵀGc is one ten-term dot product.
 */
export const G_LEN = 10;

// ── ballistics (item 129 §10) ─────────────────────────────────────────────
// Applied to the cross-spectra rather than to the finished geometry: the map
// from G to E is linear, so smoothing a hundred numbers smooths every direction
// at once, and a convex blend of two positive-semidefinite matrices is still
// one — the radius can never come out imaginary.

/** Geometry: fast enough to keep a transient, slow enough not to jitter. */
export const RAD_GEO_ATTACK_MS = 25;
export const RAD_GEO_RELEASE_MS = 220;
/** Colour: slower both ways. A hue that strobes is unreadable, and the spectral
 *  balance of a mix is a slower thing than its envelope anyway. */
export const RAD_COL_ATTACK_MS = 90;
export const RAD_COL_RELEASE_MS = 400;

// ── the surface ───────────────────────────────────────────────────────────

/** Meridians (φ, around) and parallels (θ, pole to pole) of the sphere grid.
 *  40 × 24 puts the silhouette's chord error under a third of a pixel on any
 *  dial the strip can hold, which is as smooth as a smooth surface needs. */
export const RAD_MERIDIANS = 40;
export const RAD_PARALLELS = 24;
export const RAD_VERTS = (RAD_PARALLELS + 1) * RAD_MERIDIANS;

/** Every Nth line of the grid is drawn — a REFERENCE, not a mesh. */
export const RAD_GRID_MERIDIAN = 5; // 8 meridians, 45° apart
export const RAD_GRID_PARALLEL = 4; // 5 parallels, the equator among them

/** How much of the dial the loudest direction fills. */
export const RAD_FILL = 0.94;
/**
 * Below this field amplitude the surface SHRINKS instead of being normalised up.
 * −50 dBFS: a display that renormalises silence would spend every gap between
 * takes showing a dial-filling sphere of dither, which is worse than showing
 * nothing.
 */
export const RAD_SILENCE = 0.00316; // 10^(−50/20)
/** Peak tracking, so the surface breathes rather than snapping. Matches the
 *  goniometer's auto-gain (SCOPE_GAIN_SLEW_MS) so the two panels agree. */
export const RAD_PEAK_SLEW_MS = 300;

/**
 * PRESENCE — how opaque the surface is, as a function of the field's absolute
 * level, and the reason this display dies away when the music does.
 *
 * Everything else here is auto-normalised: the surface fills the dial whatever
 * the level, because the reading is its SHAPE and the meters below are the
 * absolute one. That is right while there is something to look at and quite
 * wrong the moment there is not — a normalised nothing is still a dial-filling
 * blob. So the size stays normalised and the OPACITY carries the level, which
 * is the goniometer's fading phosphor by another means: the surface thins out
 * and goes rather than freezing on the last window it saw.
 */
export const RAD_FADE_LO_DB = -66; // gone
export const RAD_FADE_HI_DB = -45; // fully present
export const RAD_PRESENCE_ATTACK_MS = 30;
export const RAD_PRESENCE_RELEASE_MS = 350;

// ── lighting and depth (item 129 §8) ──────────────────────────────────────

/**
 * The key light, in WORLD space (x front, y left, z up) — front-left-above, so
 * it falls over the viewer's shoulder in all three views. Fixing it to the
 * world rather than to the camera is what makes the three panels show one
 * object lit one way instead of three differently-lit objects.
 */
const LIGHT = (() => {
  const v = [0.35, 0.62, 0.70];
  const n = Math.hypot(v[0], v[1], v[2]);
  return Object.freeze([v[0] / n, v[1] / n, v[2] / n]);
})();

/** Darkest a lit face gets. Lambert is MULTIPLICATIVE (shadow → black), which
 *  is the one shading that reads on a light ground as well as on a dark one. */
export const RAD_AMBIENT = 0.34;
/** Depth cue: the far side of the surface is mixed this far toward the ground,
 *  the near side not at all. */
export const RAD_DEPTH_FADE = 0.38;
/** …and geometry facing AWAY from the camera — the inside of the far wall — is
 *  pushed this much further back, so it reads as behind rather than as a second
 *  surface competing with the near one. */
export const RAD_BACK_DIM = 0.42;
/**
 * How opaque the near surface is where the far one is behind it. Not 1: a lobe
 * pointing away from the camera would otherwise be invisible rather than
 * merely behind, and "switch to the side view to find out" is not a reading.
 */
export const RAD_FRONT_ALPHA = 0.92;
/**
 * Rim: at grazing view angles the surface is lifted this far toward the core,
 * which draws its own outline. Lambert alone leaves a smooth blob melting into
 * the ground at exactly the place the reading lives — the SILHOUETTE — and this
 * is the one term that costs nothing and fixes it. It reads both ways round: a
 * bright edge on a dark ground, a dark one on paper.
 */
export const RAD_RIM = 0.30;
/** Grid ink: this far from the surface's own colour toward the core (white on a
 *  dark ground, black on a light one), so the grid belongs to the surface. */
export const RAD_GRID_MIX = 0.5;
/** Depth bias for the grid, in surface radii — enough to beat the z-buffer's
 *  own quantisation on the facets it lies along. */
const GRID_BIAS = 0.006;

// ── the three cameras (item 129 §7) ───────────────────────────────────────

/**
 * Each view is a basis {h, v, d}: screen right, screen up, and toward the
 * viewer. h and v are exactly the axes the blobs and goniometer families
 * already use for the same plane, so a radiation panel and a blobs panel side
 * by side agree about which way round the room is.
 *
 * TOP and SIDE are honest right-handed cameras (above, and from the listener's
 * left). FRONT is deliberately NOT: keeping L on the left while looking at the
 * frontal image requires a mirror, because a camera that sees the listener's
 * left on your left is standing behind them and would put the REAR hemisphere
 * nearest. The front view exists to show the frontal image, so it is drawn from
 * where the listener sits looking forward — a reflection, which costs nothing
 * on a shape with no handedness and is what everyone means by "the front view".
 */
export const RAD_VIEWS = Object.freeze({
  top: Object.freeze({ h: [0, -1, 0], v: [1, 0, 0], d: [0, 0, 1] }),
  front: Object.freeze({ h: [0, -1, 0], v: [0, 0, 1], d: [1, 0, 0] }),
  side: Object.freeze({ h: [-1, 0, 0], v: [0, 0, 1], d: [0, 1, 0] }),
});

// ── pure helpers (unit-tested in test/node/radiation.test.js) ─────────────

/** sRGB byte → linear light, 0…1. */
export function srgbToLinear(b) {
  const c = b / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear light → sRGB byte. */
export function linearToSrgb(v) {
  const c = v <= 0 ? 0 : v >= 1 ? 1 : v;
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/**
 * Which band an FFT bin belongs to, or −1 for the bins no band claims (DC and
 * the rumble under 20 Hz, and everything over 20 kHz). Dropping DC matters:
 * any offset on the bus would otherwise land in W and inflate the bass band's
 * omni term into a permanent sphere.
 */
export function radBandOfBin(bin, binHz) {
  const f = bin * binHz;
  for (let b = 0; b < RAD_NBANDS; b++) {
    if (f >= RAD_BANDS[b].lo && f < RAD_BANDS[b].hi) return b;
  }
  return -1;
}

/**
 * The analysis tilt as a POWER weight for one frequency — the spectra are
 * squared into G, so the level tilt in dB is applied over 10 rather than 20.
 * 1 at the pivot, under it below, over it above.
 */
export function radTilt(hz) {
  if (!(hz > 0)) return 0;
  return Math.pow(10, (RAD_TILT_DB_PER_OCT * Math.log2(hz / RAD_TILT_PIVOT_HZ)) / 10);
}

/**
 * The ten direction terms of the quadratic form, in G's packed order, for the
 * unit direction (dx front, dy left, dz up). Writes into `out` at `off`.
 */
export function radMonomials(dx, dy, dz, out, off) {
  out[off] = 1;                 // (W,W)
  out[off + 1] = dy * dy;       // (Y,Y)
  out[off + 2] = dz * dz;       // (Z,Z)
  out[off + 3] = dx * dx;       // (X,X)
  out[off + 4] = 2 * dy;        // (W,Y)
  out[off + 5] = 2 * dz;        // (W,Z)
  out[off + 6] = 2 * dx;        // (W,X)
  out[off + 7] = 2 * dy * dz;   // (Y,Z)
  out[off + 8] = 2 * dy * dx;   // (Y,X)
  out[off + 9] = 2 * dz * dx;   // (Z,X)
  return out;
}

/** E(d) = cᵀGc, for one band's packed matrix against one direction's terms. */
export function radEnergy(g, gOff, m, mOff) {
  let e = 0;
  for (let k = 0; k < G_LEN; k++) e += g[gOff + k] * m[mOff + k];
  return e > 0 ? e : 0; // G is PSD; this only clamps rounding
}

/**
 * One display frame of an attack/release follower — the same frame-rate
 * independent exponential the meters use, with two time constants.
 */
export function radFollow(prev, want, dtMs, attackMs, releaseMs) {
  const tau = want > prev ? attackMs : releaseMs;
  if (!(dtMs > 0)) return prev;
  return prev + (want - prev) * (1 - Math.exp(-dtMs / tau));
}

/**
 * What the radius scale should be for a field whose loudest direction reads
 * `peak`: the dial's fill, shrinking to nothing as the field falls under the
 * silence floor.
 *
 * The shrink is keyed to `level` — the field's UNTILTED amplitude — and not to
 * the peak it divides by. The peak is a tilted quantity, so a loud bass-only
 * passage has a small one, and keying the shrink to that would have collapsed
 * the surface of something that is not quiet at all.
 */
export function radScale(peak, level) {
  if (!(peak > 1e-12)) return 0;
  const shrink = level >= RAD_SILENCE ? 1 : level / RAD_SILENCE;
  return (RAD_FILL / peak) * shrink;
}

// ── the field ─────────────────────────────────────────────────────────────

/**
 * One soundfield: the analyser, the smoothed band matrices and the surface they
 * generate. The strip owns exactly one however many radiation panels are up —
 * they are three views of it, and computing it three times would be three times
 * the cost for the same answer.
 */
export class RadiationField {
  constructor(n = RAD_FFT) {
    this.fft = new Fft(n);
    this.n = n;
    // Hann. Any reasonable taper does; what matters is that the same one is
    // used for all four channels, so the cross terms keep their phase.
    this.win = new Float64Array(n);
    let ss = 0;
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
      this.win[i] = w;
      ss += w * w;
    }
    // Parseval, so `density` below comes out as the field's real mean-square
    // energy and the dB thresholds are dBFS rather than FFT-scaling accidents.
    this.norm = 1 / ((n / 2) * ss);

    // Two real signals per complex transform: W + iY, and Z + iX.
    this.re1 = new Float64Array(n);
    this.im1 = new Float64Array(n);
    this.re2 = new Float64Array(n);
    this.im2 = new Float64Array(n);

    this.bandOf = new Int8Array(n >> 1);
    this.tilt = new Float64Array(n >> 1); // per-bin power weight, see radTilt
    this.binHz = 0;

    this.raw = new Float64Array(RAD_NBANDS * G_LEN);
    this.geo = new Float64Array(RAD_NBANDS * G_LEN);
    this.col = new Float64Array(RAD_NBANDS * G_LEN);
    this.geoSum = new Float64Array(G_LEN); // the bands added up: the geometry
    this.density = 0;    // untilted energy density of the window — the LEVEL
    this.pending = 0;    // frames of new audio since the last analysis
    this.ready = false;  // …has there been one at all?

    // The grid. Directions and their monomials never change, so they are built
    // once and the per-frame work is a dot product per vertex.
    this.dir = new Float32Array(RAD_VERTS * 3);
    this.mono = new Float64Array(RAD_VERTS * G_LEN);
    for (let i = 0; i <= RAD_PARALLELS; i++) {
      const th = (i / RAD_PARALLELS) * Math.PI;
      const st = Math.sin(th);
      const ct = Math.cos(th);
      for (let j = 0; j < RAD_MERIDIANS; j++) {
        const ph = (j / RAD_MERIDIANS) * 2 * Math.PI;
        const v = i * RAD_MERIDIANS + j;
        const dx = st * Math.cos(ph); // front
        const dy = st * Math.sin(ph); // left
        const dz = ct;                // up
        this.dir[v * 3] = dx;
        this.dir[v * 3 + 1] = dy;
        this.dir[v * 3 + 2] = dz;
        radMonomials(dx, dy, dz, this.mono, v * G_LEN);
      }
    }

    this.amp = new Float32Array(RAD_VERTS);      // |p(d)|, before scaling
    this.pos = new Float32Array(RAD_VERTS * 3);  // the surface, in dial units
    this.nrm = new Float32Array(RAD_VERTS * 3);
    this.ink = new Uint8Array(RAD_VERTS * 3);    // shaded sRGB, view-independent
    this.bandE = new Float64Array(RAD_NBANDS);
    this.peak = 0;      // slewed peak amplitude (tilted — the geometry's own)
    this.level = 0;     // slewed untilted amplitude — what "quiet" means
    this.scale = 0;     // dial units per unit amplitude
    this.presence = 0;  // 0…1 opacity — see RAD_FADE_LO_DB
    this.live = false;  // is there anything worth drawing?
  }

  /** Drop everything: a hidden strip comes back to a fresh surface rather than
   *  to whatever the field looked like when it went away. */
  reset() {
    this.raw.fill(0);
    this.geo.fill(0);
    this.col.fill(0);
    this.density = 0;
    this.peak = 0;
    this.level = 0;
    this.scale = 0;
    this.presence = 0;
    this.live = false;
    this.pending = 0;
    this.ready = false;
  }

  /**
   * Nothing is arriving any more. The ring keeps whatever it last held, so
   * re-analysing it would hold the surface up forever on the last 40 ms of a
   * stopped take — the release ballistics take it down instead, the way the
   * goniometer's phosphor fades rather than freezing on its last window.
   */
  fade() {
    this.raw.fill(0);
    this.density = 0;
  }

  /** Rebuild the bin → band map and the tilt when the sample rate changes. */
  setSampleRate(rate) {
    const binHz = rate / this.n;
    if (binHz === this.binHz) return;
    this.binHz = binHz;
    for (let k = 0; k < this.bandOf.length; k++) {
      this.bandOf[k] = radBandOfBin(k, binHz);
      this.tilt[k] = radTilt(k * binHz);
    }
  }

  /**
   * Fold the newest RAD_FFT frames of the B-format ring into the raw band
   * matrices. `fresh` is how much new audio has arrived since the last call —
   * the analysis is skipped until a hop's worth has, so its cost is paced by
   * the AUDIO and not by the display.
   *
   * @returns {boolean} whether a new window was actually analysed
   */
  analyse(ring, ringWrite, rate, fresh) {
    this.setSampleRate(rate);
    this.pending += fresh;
    if (this.pending < RAD_HOP && this.ready) return false;
    this.pending = 0;
    this.ready = true;

    const n = this.n;
    const w = this.win;
    const re1 = this.re1;
    const im1 = this.im1;
    const re2 = this.re2;
    const im2 = this.im2;
    let idx = (((ringWrite - n) % SCOPE_FRAMES) + SCOPE_FRAMES) % SCOPE_FRAMES;
    for (let i = 0; i < n; i++) {
      const o = idx * SCOPE_CHANNELS;
      const g = w[i];
      re1[i] = ring[o + SCOPE_W] * g;
      im1[i] = ring[o + SCOPE_Y] * g;
      re2[i] = ring[o + SCOPE_Z] * g;
      im2[i] = ring[o + SCOPE_X] * g;
      idx = idx + 1 === SCOPE_FRAMES ? 0 : idx + 1;
    }
    this.fft.run(re1, im1);
    this.fft.run(re2, im2);

    const raw = this.raw;
    raw.fill(0);
    const bandOf = this.bandOf;
    const tilt = this.tilt;
    const half = n >> 1;
    let dens = 0;
    // Bin 0 and bin n/2 are DC and Nyquist, which no band claims, so the
    // conjugate-symmetric unpacking never has to special-case them.
    for (let k = 1; k < half; k++) {
      const b = bandOf[k];
      if (b < 0) continue;
      const kr = n - k;
      // Two real spectra out of one complex one: S_a = (A[k] + A*[n−k]) / 2,
      // S_b = (A[k] − A*[n−k]) / 2i.
      const wr = (re1[k] + re1[kr]) * 0.5;
      const wi = (im1[k] - im1[kr]) * 0.5;
      const yr = (im1[k] + im1[kr]) * 0.5;
      const yi = (re1[kr] - re1[k]) * 0.5;
      const zr = (re2[k] + re2[kr]) * 0.5;
      const zi = (im2[k] - im2[kr]) * 0.5;
      const xr = (im2[k] + im2[kr]) * 0.5;
      const xi = (re2[kr] - re2[k]) * 0.5;

      const ww = wr * wr + wi * wi;
      const yy = yr * yr + yi * yi;
      const zz = zr * zr + zi * zi;
      const xx = xr * xr + xi * xi;
      // The LEVEL is read off the field untilted, so it stays a real dBFS
      // number: it is what decides whether the surface is there at all, and a
      // bass-heavy passage is not a quiet one however the analyser is weighted.
      dens += ww + yy + zz + xx;

      // …everything the SHAPE and the COLOUR are made of is tilted. One scalar
      // per bin multiplies all four channels alike, so every cross term scales
      // with it and the matrix stays a covariance matrix.
      const tw = tilt[k];
      const g = b * G_LEN;
      raw[g] += ww * tw;
      raw[g + 1] += yy * tw;
      raw[g + 2] += zz * tw;
      raw[g + 3] += xx * tw;
      raw[g + 4] += (wr * yr + wi * yi) * tw;
      raw[g + 5] += (wr * zr + wi * zi) * tw;
      raw[g + 6] += (wr * xr + wi * xi) * tw;
      raw[g + 7] += (yr * zr + yi * zi) * tw;
      raw[g + 8] += (yr * xr + yi * xi) * tw;
      raw[g + 9] += (zr * xr + zi * xi) * tw;
    }
    const norm = this.norm;
    for (let i = 0; i < raw.length; i++) raw[i] *= norm;
    // E = (W² + X² + Y² + Z²) / 2 — the same direction-invariant energy density
    // the ambisonic meter reads (src/engine/analysis.js).
    this.density = dens * norm * 0.5;
    return true;
  }

  /**
   * Advance both smoothed copies. ONE follower coefficient per band drives all
   * ten of its numbers — chosen from the band's total power — because a matrix
   * whose entries were each smoothed at their own rate would stop being a
   * covariance matrix, and directions could then come out with negative energy.
   */
  smooth(dtMs) {
    const raw = this.raw;
    for (let b = 0; b < RAD_NBANDS; b++) {
      const o = b * G_LEN;
      const want = raw[o] + raw[o + 1] + raw[o + 2] + raw[o + 3];
      for (const [dst, atk, rel] of [
        [this.geo, RAD_GEO_ATTACK_MS, RAD_GEO_RELEASE_MS],
        [this.col, RAD_COL_ATTACK_MS, RAD_COL_RELEASE_MS],
      ]) {
        const have = dst[o] + dst[o + 1] + dst[o + 2] + dst[o + 3];
        const tau = want > have ? atk : rel;
        const a = dtMs > 0 ? 1 - Math.exp(-dtMs / tau) : 0;
        for (let k = 0; k < G_LEN; k++) dst[o + k] += (raw[o + k] - dst[o + k]) * a;
      }
    }
  }

  /**
   * Rebuild the surface: radius and normal from the geometry copy, colour from
   * the colour copy. `bandLin` is RAD_NBANDS linear-light RGB triples.
   */
  build(dtMs, bandLin) {
    const geoSum = this.geoSum;
    geoSum.fill(0);
    for (let b = 0; b < RAD_NBANDS; b++) {
      const o = b * G_LEN;
      for (let k = 0; k < G_LEN; k++) geoSum[k] += this.geo[o + k];
    }

    // Radius: the total field's amplitude in every direction.
    const amp = this.amp;
    const mono = this.mono;
    let peak = 0;
    for (let v = 0; v < RAD_VERTS; v++) {
      const e = radEnergy(geoSum, 0, mono, v * G_LEN);
      const a = Math.sqrt(e);
      amp[v] = a;
      if (a > peak) peak = a;
    }
    // The peak is slewed, not taken raw: the surface is a SHAPE, and a scale
    // that jumped every transient would make two moments impossible to compare.
    this.peak = dtMs > 0
      ? this.peak + (peak - this.peak) * (1 - Math.exp(-dtMs / RAD_PEAK_SLEW_MS))
      : peak;
    // The field's own energy density, untilted, so it is a real level (radScale).
    const level = Math.sqrt(this.density);
    // The SHRINK reads it slewed, on the same clock as the peak it divides —
    // `density` drops to zero the instant a take is stopped, and an unslewed
    // one collapsed the surface to a point in a single frame instead of letting
    // it die away.
    this.level = dtMs > 0
      ? this.level + (level - this.level) * (1 - Math.exp(-dtMs / RAD_PEAK_SLEW_MS))
      : level;
    this.scale = radScale(this.peak, this.level);
    // The OPACITY reads it raw, so a stopped take starts fading the moment it
    // stops rather than after the geometry has finished settling.
    const db = level > 0 ? 20 * Math.log10(level) : RAD_FADE_LO_DB;
    const want = (db - RAD_FADE_LO_DB) / (RAD_FADE_HI_DB - RAD_FADE_LO_DB);
    this.presence = radFollow(this.presence, want < 0 ? 0 : want > 1 ? 1 : want,
      dtMs, RAD_PRESENCE_ATTACK_MS, RAD_PRESENCE_RELEASE_MS);
    this.live = this.presence > 0.01 && this.peak > 0;

    const pos = this.pos;
    const dir = this.dir;
    const s = this.scale;
    for (let v = 0; v < RAD_VERTS; v++) {
      const r = amp[v] * s;
      pos[v * 3] = dir[v * 3] * r;
      pos[v * 3 + 1] = dir[v * 3 + 1] * r;
      pos[v * 3 + 2] = dir[v * 3 + 2] * r;
    }

    this.buildNormals();
    this.buildInk(bandLin);
  }

  /**
   * Central differences along the two grid directions. Cheaper than the
   * analytic gradient and, more to the point, it is the normal of the surface
   * that is actually DRAWN, so the shading never disagrees with the silhouette.
   */
  buildNormals() {
    const pos = this.pos;
    const nrm = this.nrm;
    const M = RAD_MERIDIANS;
    for (let i = 1; i < RAD_PARALLELS; i++) {
      for (let j = 0; j < M; j++) {
        const v = i * M + j;
        const a = (i - 1) * M + j;
        const b = (i + 1) * M + j;
        const c = i * M + (j + 1 === M ? 0 : j + 1);
        const d = i * M + (j === 0 ? M - 1 : j - 1);
        const tx = pos[b * 3] - pos[a * 3];
        const ty = pos[b * 3 + 1] - pos[a * 3 + 1];
        const tz = pos[b * 3 + 2] - pos[a * 3 + 2];
        const ux = pos[c * 3] - pos[d * 3];
        const uy = pos[c * 3 + 1] - pos[d * 3 + 1];
        const uz = pos[c * 3 + 2] - pos[d * 3 + 2];
        let nx = ty * uz - tz * uy;
        let ny = tz * ux - tx * uz;
        let nz = tx * uy - ty * ux;
        // The grid's own handedness flips at the poles, so orient against the
        // radius instead of trusting the winding: the surface is star-shaped,
        // so "outward" is always the side the direction vector points at.
        if (nx * pos[v * 3] + ny * pos[v * 3 + 1] + nz * pos[v * 3 + 2] < 0) {
          nx = -nx; ny = -ny; nz = -nz;
        }
        const len = Math.hypot(nx, ny, nz);
        if (len > 1e-20) {
          nrm[v * 3] = nx / len;
          nrm[v * 3 + 1] = ny / len;
          nrm[v * 3 + 2] = nz / len;
        } else {
          // A vanished lobe: fall back to the radial normal.
          nrm[v * 3] = this.dir[v * 3];
          nrm[v * 3 + 1] = this.dir[v * 3 + 1];
          nrm[v * 3 + 2] = this.dir[v * 3 + 2];
        }
      }
    }
    // The poles have no φ direction to difference along, so they take the mean
    // of the ring beside them — which for a smooth surface IS the pole normal.
    for (const [row, ring] of [[0, 1], [RAD_PARALLELS, RAD_PARALLELS - 1]]) {
      let nx = 0, ny = 0, nz = 0;
      for (let j = 0; j < M; j++) {
        const v = ring * M + j;
        nx += nrm[v * 3];
        ny += nrm[v * 3 + 1];
        nz += nrm[v * 3 + 2];
      }
      const len = Math.hypot(nx, ny, nz);
      const ok = len > 1e-12;
      for (let j = 0; j < M; j++) {
        const v = row * M + j;
        nrm[v * 3] = ok ? nx / len : this.dir[v * 3];
        nrm[v * 3 + 1] = ok ? ny / len : this.dir[v * 3 + 1];
        nrm[v * 3 + 2] = ok ? nz / len : this.dir[v * 3 + 2];
      }
    }
  }

  /**
   * Spectral colour, then Lambert. Both happen in LINEAR light: mixing five
   * inks in gamma space turns any broadband direction into mud, and shading in
   * gamma space turns every curve into a stripe.
   */
  buildInk(bandLin) {
    const ink = this.ink;
    const mono = this.mono;
    const nrm = this.nrm;
    const col = this.col;
    const bandE = this.bandE;
    for (let v = 0; v < RAD_VERTS; v++) {
      const mo = v * G_LEN;
      let total = 0;
      for (let b = 0; b < RAD_NBANDS; b++) {
        const e = radEnergy(col, b * G_LEN, mono, mo);
        bandE[b] = e;
        total += e;
      }
      let r = 0, g = 0, bl = 0;
      if (total > 0) {
        const inv = 1 / total;
        for (let b = 0; b < RAD_NBANDS; b++) {
          const f = bandE[b] * inv;
          const c = bandLin[b];
          r += f * c[0];
          g += f * c[1];
          bl += f * c[2];
        }
      }
      const ndl = nrm[v * 3] * LIGHT[0] + nrm[v * 3 + 1] * LIGHT[1] + nrm[v * 3 + 2] * LIGHT[2];
      const shade = RAD_AMBIENT + (1 - RAD_AMBIENT) * (ndl > 0 ? ndl : 0);
      ink[v * 3] = linearToSrgb(r * shade);
      ink[v * 3 + 1] = linearToSrgb(g * shade);
      ink[v * 3 + 2] = linearToSrgb(bl * shade);
    }
  }
}

// ── the renderer ──────────────────────────────────────────────────────────

/**
 * One panel's camera: the projection scratch, a z-buffer and the painter. The
 * FIELD is shared; this is the only part that is per-panel, because the only
 * thing that differs between the three panels is where you are standing.
 *
 * Drawn in two passes with the depth buffer reset between them. A ray through a
 * star-shaped closed surface always meets an outward-facing patch first, so the
 * near pass on its own is the true visible surface, and the far pass underneath
 * it is the inside of the back wall — which is exactly what should show through
 * when the near surface is made slightly translucent over it.
 */
export class RadiationView {
  constructor(size) {
    this.sx = new Float32Array(RAD_VERTS);
    this.sy = new Float32Array(RAD_VERTS);
    this.sz = new Float32Array(RAD_VERTS);
    this.nd = new Float32Array(RAD_VERTS); // normal · toward-viewer
    // Finished sRGB per vertex, one set per pass. Depth cue, back-wall dim and
    // rim are all functions of quantities the rasteriser INTERPOLATES anyway, so
    // they are resolved here — a thousand vertices instead of thirty thousand
    // pixels, for a display that runs every frame the strip is open.
    this.nearRgb = new Float32Array(RAD_VERTS * 3);
    this.farRgb = new Float32Array(RAD_VERTS * 3);
    this.alpha = 255;
    this.size = 0;
    this.z = null;
    this.cov = null;
    this.resize(size);
  }

  resize(size) {
    const s = Math.max(4, Math.round(size));
    if (s === this.size) return;
    this.size = s;
    this.z = new Float32Array(s * s);
    this.cov = new Uint8Array(s * s);
  }

  /**
   * Paint the field into `out` (an ImageData's data, size × size RGBA).
   * `ground` is the panel's background as sRGB bytes — what "further away"
   * fades toward — and `core` is the grid's highlight (see beamCoreInk).
   */
  render(field, basis, out, ground, core) {
    const size = this.size;
    out.fill(0);
    if (!field.live) return;
    // The whole surface is drawn at the field's presence, so a take that ends
    // thins out and goes instead of freezing at full strength (RAD_FADE_LO_DB).
    this.alpha = Math.round(255 * field.presence);

    const mid = size / 2;
    const rad = size / 2 - 1;
    const h = basis.h;
    const v = basis.v;
    const d = basis.d;
    const pos = field.pos;
    const nrm = field.nrm;
    for (let i = 0; i < RAD_VERTS; i++) {
      const px = pos[i * 3];
      const py = pos[i * 3 + 1];
      const pz = pos[i * 3 + 2];
      this.sx[i] = mid + (px * h[0] + py * h[1] + pz * h[2]) * rad;
      this.sy[i] = mid - (px * v[0] + py * v[1] + pz * v[2]) * rad;
      this.sz[i] = px * d[0] + py * d[1] + pz * d[2];
      this.nd[i] = nrm[i * 3] * d[0] + nrm[i * 3 + 1] * d[1] + nrm[i * 3 + 2] * d[2];
    }

    this.shade(field, ground, core);
    this.cov.fill(0);
    this.z.fill(-Infinity);
    this.mesh(out, false); // the far wall
    this.z.fill(-Infinity);
    this.mesh(out, true);  // the near surface, over it
    this.grid(out, core);
  }

  /**
   * Every vertex's finished colour, for both passes.
   *
   * DEPTH CUE and BACK-WALL DIM are a mix toward the GROUND rather than a
   * darkening: what is further off recedes into the background, which is the
   * one form of the cue that reads on a light theme as well as a dark one.
   * RIM lifts the grazing angles toward the core, which draws the surface's own
   * outline — Lambert alone leaves the silhouette, where the whole reading
   * lives, melting into the ground.
   */
  shade(field, ground, core) {
    const ink = field.ink;
    const near = this.nearRgb;
    const far = this.farRgb;
    for (let i = 0; i < RAD_VERTS; i++) {
      let n = this.sz[i] * 0.5 + 0.5;
      if (n < 0) n = 0; else if (n > 1) n = 1;
      const k = 1 - RAD_DEPTH_FADE * (1 - n);
      const nv = this.nd[i];
      const t = 1 - (nv < 0 ? -nv : nv);
      const rim = RAD_RIM * t * t * t;
      for (let ch = 0; ch < 3; ch++) {
        const g = ground[ch];
        const lit = g + (ink[i * 3 + ch] - g) * k;
        near[i * 3 + ch] = lit + (core[ch] - lit) * rim;
        far[i * 3 + ch] = g + (ink[i * 3 + ch] - g) * (k * RAD_BACK_DIM);
      }
    }
  }

  /** Every quad whose facing matches `front`, as two triangles. */
  mesh(out, front) {
    const M = RAD_MERIDIANS;
    const nd = this.nd;
    for (let i = 0; i < RAD_PARALLELS; i++) {
      for (let j = 0; j < M; j++) {
        const jn = j + 1 === M ? 0 : j + 1;
        const a = i * M + j;
        const b = i * M + jn;
        const c = (i + 1) * M + j;
        const e = (i + 1) * M + jn;
        // One facing decision per QUAD, from its four corners, so the two
        // triangles of a quad can never end up in different passes and leave a
        // crack down the middle of it.
        const facing = nd[a] + nd[b] + nd[c] + nd[e];
        if (front !== facing >= 0) continue;
        this.tri(out, a, c, e, front);
        this.tri(out, a, e, b, front);
      }
    }
  }

  /**
   * One Gouraud triangle with a depth test. Winding-agnostic — the front view
   * is a mirror, which flips every triangle's winding, and facing is decided by
   * the normal above rather than by the sign of the area.
   */
  tri(out, i0, i1, i2, front) {
    const sx = this.sx, sy = this.sy, sz = this.sz;
    const x0 = sx[i0], y0 = sy[i0];
    const x1 = sx[i1], y1 = sy[i1];
    const x2 = sx[i2], y2 = sy[i2];
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (area > -1e-9 && area < 1e-9) return;
    const inv = 1 / area;

    const size = this.size;
    let minX = Math.floor(Math.min(x0, x1, x2));
    let maxX = Math.ceil(Math.max(x0, x1, x2));
    let minY = Math.floor(Math.min(y0, y1, y2));
    let maxY = Math.ceil(Math.max(y0, y1, y2));
    if (minX < 0) minX = 0;
    if (minY < 0) minY = 0;
    if (maxX > size - 1) maxX = size - 1;
    if (maxY > size - 1) maxY = size - 1;
    if (minX > maxX || minY > maxY) return;

    const z = this.z;
    const cov = this.cov;
    const col = front ? this.nearRgb : this.farRgb;
    const alpha = this.alpha;
    const o0 = i0 * 3, o1 = i1 * 3, o2 = i2 * 3;
    for (let py = minY; py <= maxY; py++) {
      const fy = py + 0.5;
      const row = py * size;
      for (let px = minX; px <= maxX; px++) {
        const fx = px + 0.5;
        // Barycentric from the same edge functions as the area, so a point on a
        // shared edge lands in exactly one of the two triangles.
        const w0 = ((x1 - fx) * (y2 - fy) - (x2 - fx) * (y1 - fy)) * inv;
        if (w0 < 0) continue;
        const w1 = ((x2 - fx) * (y0 - fy) - (x0 - fx) * (y2 - fy)) * inv;
        if (w1 < 0) continue;
        const w2 = 1 - w0 - w1;
        if (w2 < 0) continue;

        const depth = w0 * sz[i0] + w1 * sz[i1] + w2 * sz[i2];
        const p = row + px;
        if (depth <= z[p]) continue;
        z[p] = depth;

        const o = p * 4;
        // The near pass is slightly translucent WHERE THE FAR WALL IS BEHIND IT,
        // and opaque everywhere else — so a lobe pointing away still reads,
        // without washing the whole surface out over the empty background.
        if (front && cov[p] !== 0) {
          for (let ch = 0; ch < 3; ch++) {
            const lit = w0 * col[o0 + ch] + w1 * col[o1 + ch] + w2 * col[o2 + ch];
            out[o + ch] += (lit - out[o + ch]) * RAD_FRONT_ALPHA;
          }
        } else {
          out[o] = w0 * col[o0] + w1 * col[o1] + w2 * col[o2];
          out[o + 1] = w0 * col[o0 + 1] + w1 * col[o1 + 1] + w2 * col[o2 + 1];
          out[o + 2] = w0 * col[o0 + 2] + w1 * col[o1 + 2] + w2 * col[o2 + 2];
        }
        out[o + 3] = alpha;
        cov[p] = front ? 2 : 1;
      }
    }
  }

  /**
   * The latitude/longitude reference, drawn ON the deformed surface: it is what
   * turns a coloured blob into a sphere you can see has been pushed out in one
   * direction and pulled in in another. Only the near half is drawn — the far
   * half is a ghost already, and a grid over it would read as a second object.
   */
  grid(out, core) {
    const M = RAD_MERIDIANS;
    for (let j = 0; j < M; j += RAD_GRID_MERIDIAN) {
      for (let i = 0; i < RAD_PARALLELS; i++) this.seg(out, core, i * M + j, (i + 1) * M + j);
    }
    for (let i = RAD_GRID_PARALLEL; i < RAD_PARALLELS; i += RAD_GRID_PARALLEL) {
      for (let j = 0; j < M; j++) {
        this.seg(out, core, i * M + j, i * M + (j + 1 === M ? 0 : j + 1));
      }
    }
  }

  /** One depth-tested grid segment: the pixels it covers are lifted toward the
   *  core ink, so the line takes the colour of whatever it is lying on. */
  seg(out, core, a, b) {
    if (this.nd[a] < 0 || this.nd[b] < 0) return;
    const size = this.size;
    const x0 = this.sx[a], y0 = this.sy[a], z0 = this.sz[a];
    const x1 = this.sx[b], y1 = this.sy[b], z1 = this.sz[b];
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    const dx = (x1 - x0) / steps;
    const dy = (y1 - y0) / steps;
    const dz = (z1 - z0) / steps;
    for (let s = 0; s <= steps; s++) {
      const px = Math.round(x0 + dx * s);
      const py = Math.round(y0 + dy * s);
      if (px < 0 || py < 0 || px >= size || py >= size) continue;
      const p = py * size + px;
      if (this.cov[p] === 0) continue; // never over bare background
      if (z0 + dz * s + GRID_BIAS < this.z[p]) continue;
      const o = p * 4;
      for (let ch = 0; ch < 3; ch++) {
        out[o + ch] += (core[ch] - out[o + ch]) * RAD_GRID_MIX;
      }
    }
  }
}
