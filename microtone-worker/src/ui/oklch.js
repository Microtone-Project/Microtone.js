// OKLCh colour maths — for the ramps a canvas has to build at run time.
//
// The stylesheet stays the source of truth: a ramp is declared there as its
// ENDS, two or three tokens, and the steps between them are computed here.
// The alternative — ten tokens per ramp per theme — is forty numbers nobody
// can keep in step, and the interesting property of a ramp (that its steps are
// perceptually even) is exactly what hand-picked hex cannot promise.
//
// OKLab is Björn Ottosson's 2020 perceptual space; OKLCh is its polar form
// (lightness, chroma, hue). Working there rather than in sRGB is what keeps a
// blue→green→yellow ramp from sagging through mud in the middle, and what lets
// `evenSteps` below spend its steps where the eye can actually tell them
// apart — which, hue resolution being as poor as it is, is the difference
// between a ramp you can read a value off and a smear.
//
// Pure — no DOM — so the ramp is unit-testable.

// sRGB transfer function, both directions.
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/** "#rgb" / "#rrggbb" → [r, g, b] in 0..1. Anything unparseable reads black,
 *  which is visible rather than silently absent — a missing token is a bug. */
export function parseHex(css) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(css).trim());
  if (!m) return [0, 0, 0];
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

export function toHex([r, g, b]) {
  const b8 = (v) => Math.round(Math.min(Math.max(v, 0), 1) * 255).toString(16).padStart(2, "0");
  return `#${b8(r)}${b8(g)}${b8(b)}`;
}

/** sRGB (0..1) → OKLab. Ottosson's matrices, verbatim. */
export function rgbToOklab([r, g, b]) {
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

/** OKLab → LINEAR sRGB, unclamped — so a caller can ask whether it fits. */
function oklabToLinear([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

/** OKLab → sRGB (0..1). */
export function oklabToRgb(lab) {
  return oklabToLinear(lab).map((c) => Math.min(Math.max(toGamma(c), 0), 1));
}

const GAMUT_EPS = 1e-4;

/** Does this OKLCh colour exist in sRGB at all? */
export function inGamut(lch) {
  return oklabToLinear(oklchToOklab(lch))
    .every((c) => c >= -GAMUT_EPS && c <= 1 + GAMUT_EPS);
}

/**
 * Pull an out-of-gamut colour back by reducing its CHROMA, keeping its
 * lightness and hue exactly.
 *
 * The obvious alternative — clip each sRGB channel at 0 and 1 — is what most
 * naive conversions do, and it does not merely desaturate: a blue-cyan whose
 * red channel goes negative comes back as a DIFFERENT HUE, so a ramp walking
 * through the cyans (which sRGB holds less of than any other region) arrives
 * somewhere other than where it set off for, and no amount of careful
 * perceptual spacing upstream survives that. Reducing chroma along constant
 * L and h lands on the gamut boundary in the direction the eye reads as
 * "the same colour, less of it", which is the one distortion that keeps a
 * ramp coherent.
 */
export function gamutClamp(lch) {
  if (inGamut(lch)) return lch;
  const [L, C, h] = lch;
  let lo = 0, hi = C;
  for (let i = 0; i < 24; i++) {         // ≈ C/16M — far below 8-bit output
    const mid = (lo + hi) / 2;
    if (inGamut([L, mid, h])) lo = mid;
    else hi = mid;
  }
  return [L, lo, h];
}

/** OKLab → OKLCh. Hue in degrees, 0..360. */
export function oklabToOklch([L, a, b]) {
  return [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
}

export function oklchToOklab([L, C, h]) {
  const rad = (h * Math.PI) / 180;
  return [L, C * Math.cos(rad), C * Math.sin(rad)];
}

export const hexToOklch = (css) => oklabToOklch(rgbToOklab(parseHex(css)));
/** OKLCh → hex, gamut-mapped: an unreachable chroma comes back reduced, not
 *  hue-shifted. Every colour this module hands out goes through here. */
export const oklchToHex = (lch) => toHex(oklabToRgb(oklchToOklab(gamutClamp(lch))));

/**
 * Mix `fromHex` toward `toHex` at `t` ∈ 0..1, taking the SHORT way round the
 * hue circle. Endpoints are exact.
 */
export function mixOklch(fromHex, toHexCss, t) {
  const [L, C, h] = pathAt(hexToOklch(fromHex), hexToOklch(toHexCss),
    Math.min(Math.max(t, 0), 1));
  return oklchToHex([L, C, h]);
}

/** A point on the OKLCh path between two colours, hue taking the short way. */
function pathAt(a, b, t) {
  const dh = ((b[2] - a[2] + 540) % 360) - 180;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, (a[2] + dh * t + 360) % 360];
}

/** Sampling resolution for the arc-length walk below. 256 puts the error in
 *  locating a step well under one 8-bit code, which is all the output has. */
const ARC_SAMPLES = 256;

/**
 * `n` colours along the path through `stops` (two or more), inclusive of both
 * ends, spaced so that every ADJACENT PAIR is the same perceptual distance
 * apart — not so that the interpolation parameter advances evenly.
 *
 * The two are not the same thing, and the difference is the whole reason this
 * function exists. A path through OKLCh does not travel at a constant speed
 * through OKLab: sweeping the hue while the chroma is high covers far more
 * ground than the same sweep near the grey axis, and a path with a stop in the
 * middle is almost never two segments of equal length. Cut such a path at even
 * parameter values and several steps land inside the stretch the eye separates
 * worst, while the stretch it separates best gets one. Measuring the arc in
 * OKLab — where distance IS perceived difference — and dividing THAT evenly
 * spends the steps where they can be told apart.
 */
export function evenSteps(stops, n) {
  if (n <= 1) return [stops[0]];
  const lch = stops.map(hexToOklch);
  const segs = lch.length - 1;

  // Walk the whole path once, accumulating how far the eye has travelled.
  const cum = new Float64Array(segs * ARC_SAMPLES + 1);
  // Measured on the GAMUT-MAPPED path: the steps have to be even in what is
  // seen, and a stretch the gamut has desaturated covers less ground than
  // the one that was asked for.
  let prev = oklchToOklab(gamutClamp(lch[0]));
  for (let i = 1; i <= segs * ARC_SAMPLES; i++) {
    const cur = oklchToOklab(gamutClamp(pathPoint(lch, i / (segs * ARC_SAMPLES))));
    cum[i] = cum[i - 1] + Math.hypot(cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2]);
    prev = cur;
  }
  const last = segs * ARC_SAMPLES;
  const total = cum[last];

  const out = [];
  let i = 0;
  for (let k = 0; k < n; k++) {
    const want = (total * k) / (n - 1);
    while (i < last && cum[i + 1] < want) i++;
    // …and land between the two samples that bracket it, so the answer does
    // not quantise to the sampling grid.
    const span = cum[i + 1] - cum[i];
    const frac = span > 0 ? (want - cum[i]) / span : 0;
    out.push(oklchToHex(pathPoint(lch, Math.min((i + frac) / last, 1))));
  }
  return out;
}

/** The point `t` ∈ 0..1 of the way along a piecewise OKLCh path. */
function pathPoint(lch, t) {
  const segs = lch.length - 1;
  const at = Math.min(Math.max(t, 0), 1) * segs;
  const seg = Math.min(Math.floor(at), segs - 1);
  return pathAt(lch[seg], lch[seg + 1], at - seg);
}
