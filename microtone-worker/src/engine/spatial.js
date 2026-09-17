// Surround and ambisonics core — TODO #998.0/.1/.2.
//
// The engine's spatial model is OBJECT-based: a sounding voice is a source with
// a DIRECTION and a gain, and nothing in the mixer knows what the eventual
// output format will be. A SpatialRenderer turns those objects into the
// channels of a SpatialBus, so a file format is always a render TARGET, never
// the thing the engine holds: playback installs StereoRenderer (the device is
// stereo), and an export installs whatever the chosen format wants —
// AmbisonicRenderer today, ITU speaker layouts when #998.5 lands — then
// re-renders the song through the very same mixer.
//
// ── Units ──
// Azimuth is the 9-bit angle of the extended `S $8xxx` command (#998.1): 512
// units to a full turn, 0 = left (0°), 128 = front (90°), 256 = right (180°),
// 384 = behind (270°), increasing CLOCKWISE seen from above. Its low 8 bits are
// exactly the legacy pan byte, so pan $00 / $80 / $FF still mean left / centre
// / right and every ordinary pan write lands on the front arc.
// Elevation is effect X's signed byte: 128 units to 90°, −128 = below, +127 ≈
// above. Both are kept as doubles — a Z slide (#998.2) moves continuously.
//
// Direction vectors use the AmbiX axes: +x front, +y left, +z up.
//
// This is not a port: the Kotlin engine has no surround yet, so this file IS
// the reference implementation. Behaviour contract: TAUD_NOTE_EFFECTS.md
// ("Spatial panning effects" + S $80xx), terranmon.txt (song flag `ss`).

import { clamp } from "./tables.js";
import { isSoundingChild } from "./voice.js";

/** Song-immutable surround model (terranmon.txt song table, `ss` bits). */
export const SURROUND_STEREO = 0;
export const SURROUND_PLANAR = 1;   // 360° panning, horizontal only
export const SURROUND_SPATIAL = 2;  // full sphere

/** Azimuth units in a full turn (the S $8xxx angle). */
export const AZIMUTH_TURN = 512;
/** Elevation units in a quarter turn (effect X's signed byte). */
export const ELEVATION_QUARTER = 128;
/** Widest multi-channel sample the placement table knows (terranmon.txt 's'). */
export const MAX_SAMPLE_CHANNELS = 8;

const AZ_TO_RAD = (2 * Math.PI) / AZIMUTH_TURN;
const EL_TO_RAD = Math.PI / 2 / ELEVATION_QUARTER;
const AZ_PER_DEG = AZIMUTH_TURN / 360;
/** Taud azimuth 128 is straight ahead — the ambisonic 0° — and runs the other way. */
const AZ_FRONT = 128;

/** Fold an azimuth into [0, 512). */
export function wrapAzimuth(a) {
  const r = a % AZIMUTH_TURN;
  return r < 0 ? r + AZIMUTH_TURN : r;
}

/**
 * Fold a full-circle azimuth onto the legacy pan byte (0..255) by mirroring the
 * rear arc onto the front one. Two speakers cannot render front/back, so a
 * stereo downmix keeps the left/right axis and drops the other; the mapping is
 * the identity on the front arc, which is what makes ordinary pan values behave
 * identically in every surround model.
 */
export function foldAzimuthToPan(az) {
  const a = wrapAzimuth(az);
  const p = a <= 256 ? a : AZIMUTH_TURN - a;
  return p > 255 ? 255 : p;
}

/** Unit vector for (azimuth, elevation). */
export function directionFromAngles(az, el, out) {
  const th = (AZ_FRONT - az) * AZ_TO_RAD;
  const ph = el * EL_TO_RAD;
  const cph = Math.cos(ph);
  out[0] = cph * Math.cos(th);
  out[1] = cph * Math.sin(th);
  out[2] = Math.sin(ph);
  return out;
}

/** (azimuth, elevation) of a unit vector — the inverse of directionFromAngles. */
export function anglesFromDirection(x, y, z, out) {
  out[0] = wrapAzimuth(AZ_FRONT - Math.atan2(y, x) / AZ_TO_RAD);
  out[1] = Math.asin(clamp(z, -1.0, 1.0)) / EL_TO_RAD;
  return out;
}

const layoutOf = (...deg) => Float64Array.from(deg, (d) => d * AZ_PER_DEG);

/**
 * ITU-style placement of a MULTI-CHANNEL sample's channels (#998.0), as azimuth
 * offsets from the source's own direction, in WAV channel order. Stereo is the
 * ±30° "equilateral triangle" of BS.775; the surround sets are the BS.775 /
 * BS.2051 angles. Only 1 and 2 are reachable today — the sampler plays at most
 * two pool spans (terranmon.txt Ixmp note 8) — but the placement RULE is what
 * #998.0 pins down, so the whole table lives here.
 */
export const SAMPLE_CHANNEL_LAYOUT = Object.freeze({
  1: layoutOf(0),
  2: layoutOf(-30, 30),                            // L R
  4: layoutOf(-30, 30, -110, 110),                 // L R Ls Rs
  6: layoutOf(-30, 30, 0, 0, -110, 110),           // L R C LFE Ls Rs
  8: layoutOf(-30, 30, 0, 0, -90, 90, -135, 135),  // L R C LFE Lss Rss Lrs Rrs
});

/**
 * World (azimuth, elevation) of a sample channel sitting `localAz` off the
 * source's own direction. The layout is a rigid body aimed at the source: it
 * yaws AND pitches with it, so a stereo pair keeps its 60° width however high
 * the source flies instead of collapsing at the poles the way a plain azimuth
 * offset would.
 */
export function sampleChannelAngles(az, el, localAz, out) {
  if (localAz === 0) { out[0] = az; out[1] = el; return out; }
  if (el === 0) { out[0] = az + localAz; out[1] = 0; return out; } // exact, and the common case
  const psi = -localAz * AZ_TO_RAD; // layout offset is clockwise; ambisonic azimuth is not
  const th = (AZ_FRONT - az) * AZ_TO_RAD;
  const ph = el * EL_TO_RAD;
  const cpsi = Math.cos(psi), spsi = Math.sin(psi);
  const cph = Math.cos(ph), sph = Math.sin(ph);
  const cth = Math.cos(th), sth = Math.sin(th);
  return anglesFromDirection(
    cpsi * cph * cth - spsi * sth,
    cpsi * cph * sth + spsi * cth,
    cpsi * sph,
    out,
  );
}

/**
 * Orthogonal projection of a direction onto the listener's left–right axis:
 * −1 hard left … 0 centre … +1 hard right. It is the SHADOW the source casts
 * on that line — height and depth both collapse onto it, so a source overhead
 * or directly behind reads centre, and a hard-left source 60° up reads
 * half-left. The lane-header pan strip draws exactly this (#998.6), which
 * is why it lines up with the radar dot above it.
 *
 * Not the same thing as the audible downmix position (foldAzimuthToPan mirrors
 * the rear arc instead of foreshortening it) — this one is a POSITION display.
 */
export function lateralProjection(az, el) {
  const th = (AZ_FRONT - az) * AZ_TO_RAD;
  return -Math.cos(el * EL_TO_RAD) * Math.sin(th);
}

/**
 * Decode an X / 4 argument (`$eeaa`) into [azimuth, elevation]. The commands
 * and any UI that writes them share this pair so the two encodings cannot
 * drift: azimuth is a byte over the full turn (half the engine's resolution),
 * elevation is signed.
 */
export function anglesFromSpatialArg(arg, out) {
  const ee = (arg >>> 8) & 0xff;
  out[0] = (arg & 0xff) * 2;
  out[1] = ee >= 0x80 ? ee - 256 : ee;
  return out;
}

/** Encode (azimuth, elevation) back into an X / 4 argument. */
export function spatialArgFromAngles(az, el) {
  const a = Math.round(wrapAzimuth(az) / 2) & 0xff;
  const e = clamp(Math.round(el), -128, 127) & 0xff;
  return (e << 8) | a;
}

const slerpA = new Float64Array(3);
const slerpB = new Float64Array(3);

/**
 * One tick of a Z slide (#998.2): rotate (az, el) toward (tgtAz, tgtEl) along
 * the great circle by at most `stepUnits` azimuth units, at constant angular
 * velocity — the SLERP the spec RECOMMENDS. Identical directions do nothing;
 * ANTIPODAL ones (where the great circle is undefined) take the CLOCKWISE path,
 * matching effect P's rule. Writes [azimuth, elevation] into `out`.
 */
export function stepTowardTarget(az, el, tgtAz, tgtEl, stepUnits, out) {
  const a = directionFromAngles(az, el, slerpA);
  const b = directionFromAngles(tgtAz, tgtEl, slerpB);
  const dot = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1.0, 1.0);
  const omega = Math.acos(dot);
  const step = stepUnits * AZ_TO_RAD;
  if (!(omega > 1e-12) || step <= 0.0) { out[0] = az; out[1] = el; return out; }
  if (step >= omega) { out[0] = wrapAzimuth(tgtAz); out[1] = tgtEl; return out; }

  let vx, vy, vz;
  if (omega > Math.PI - 1e-9) {
    // Antipodal: pick the axis whose rotation makes the azimuth INCREASE, i.e.
    // the part of −z perpendicular to the source (front → right → behind).
    let kx = a[2] * a[0];
    let ky = a[2] * a[1];
    let kz = a[2] * a[2] - 1.0;
    let len = Math.hypot(kx, ky, kz);
    if (len < 1e-9) {
      // Source is straight up or down: rotate through its own azimuth instead.
      const th = (AZ_FRONT - az) * AZ_TO_RAD;
      const hx = Math.cos(th), hy = Math.sin(th);
      kx = -a[2] * hy;
      ky = a[2] * hx;
      kz = a[0] * hy - a[1] * hx;
      len = Math.hypot(kx, ky, kz);
    }
    kx /= len; ky /= len; kz /= len;
    // Rodrigues, with k ⟂ a so the k(k·a) term vanishes.
    const c = Math.cos(step), s = Math.sin(step);
    vx = a[0] * c + (ky * a[2] - kz * a[1]) * s;
    vy = a[1] * c + (kz * a[0] - kx * a[2]) * s;
    vz = a[2] * c + (kx * a[1] - ky * a[0]) * s;
  } else {
    const sinOmega = Math.sin(omega);
    const c0 = Math.sin(omega - step) / sinOmega;
    const c1 = Math.sin(step) / sinOmega;
    vx = a[0] * c0 + b[0] * c1;
    vy = a[1] * c0 + b[1] * c1;
    vz = a[2] * c0 + b[2] * c1;
  }
  return anglesFromDirection(vx, vy, vz, out);
}

// ── Renderers ─────────────────────────────────────────────────────────────
// A renderer answers one question — "what gain does a source at (az, el) get in
// each of my channels?" — plus a monitoring stereo pair so any render target
// can be auditioned on the device. Everything format-specific stops here.

/**
 * Stereo render target: the device path, and the stereo downmix every other
 * format offers. Sources on the FRONT ARC hit exactly the legacy equal-energy
 * pan law (same expression, same order of operations), so a song that only uses
 * ordinary pan renders bit-for-bit like it does in stereo mode. Behind the
 * listener the image folds back onto the front, and elevation collapses it
 * toward the centre — at ±90° a source is dead centre, the only choice that
 * stays continuous at the poles.
 */
export class StereoRenderer {
  constructor() {
    this.numChannels = 2;
    this.name = "stereo";
  }

  channelGains(az, el, out, off) {
    const p = foldAzimuthToPan(az);
    const pan = el === 0 ? p : 128 + (p - 128) * Math.cos(el * EL_TO_RAD);
    out[off] = Math.cos((Math.PI * pan) / 512.0);
    out[off + 1] = Math.sin((Math.PI * pan) / 512.0);
  }

  monitorStereo(data, frames, n, out) {
    out[0] = data[n];
    out[1] = data[frames + n];
  }
}

/** ACN indices carried by an order-N basis; planar keeps the horizontal (|m| = l) set. */
export function acnChannelList(order, planar) {
  const list = [];
  for (let l = 0; l <= order; l++) {
    for (let m = -l; m <= l; m++) {
      if (!planar || Math.abs(m) === l) list.push(l * l + l + m);
    }
  }
  return Int32Array.from(list);
}

const SQRT3 = Math.sqrt(3.0);
const SQRT15 = Math.sqrt(15.0);
const SQRT5_8 = Math.sqrt(5.0 / 8.0);
const SQRT3_8 = Math.sqrt(3.0 / 8.0);

/**
 * Real spherical harmonics up to `order` (≤ 3) for one direction, SN3D
 * normalised and ACN ordered — the AmbiX convention (#998.4's export format,
 * and a perfectly good internal scene basis). Fills out[0 .. (order+1)²).
 */
export function encodeSN3D(az, el, order, out) {
  const th = (AZ_FRONT - az) * AZ_TO_RAD;
  const ph = el * EL_TO_RAD;
  const cph = Math.cos(ph);
  const x = cph * Math.cos(th);
  const y = cph * Math.sin(th);
  const z = Math.sin(ph);

  out[0] = 1.0;
  if (order < 1) return out;
  out[1] = y;
  out[2] = z;
  out[3] = x;
  if (order < 2) return out;
  out[4] = SQRT3 * x * y;
  out[5] = SQRT3 * y * z;
  out[6] = (3.0 * z * z - 1.0) * 0.5;
  out[7] = SQRT3 * x * z;
  out[8] = SQRT3 * (x * x - y * y) * 0.5;
  if (order < 3) return out;
  out[9] = SQRT5_8 * y * (3.0 * x * x - y * y);
  out[10] = SQRT15 * x * y * z;
  out[11] = SQRT3_8 * y * (5.0 * z * z - 1.0);
  out[12] = z * (5.0 * z * z - 3.0) * 0.5;
  out[13] = SQRT3_8 * x * (5.0 * z * z - 1.0);
  out[14] = SQRT15 * z * (x * x - y * y) * 0.5;
  out[15] = SQRT5_8 * x * (x * x - 3.0 * y * y);
  return out;
}

/** Highest ambisonic order encodeSN3D implements. */
export const AMBISONIC_ORDER_MAX = 3;

/**
 * Ambisonic (scene-based) render target — the export basis for #998.4, and the
 * proof that the mixer is format-agnostic: same voices, same objects, a
 * different set of channels. `planar` drops the harmonics a horizontal-only
 * song cannot excite (7 channels instead of 16 at order 3); an AmbiX writer
 * zero-fills the missing ACNs.
 */
export class AmbisonicRenderer {
  constructor(order = AMBISONIC_ORDER_MAX, planar = false) {
    this.order = Math.min(order, AMBISONIC_ORDER_MAX);
    this.planar = planar;
    this.acn = acnChannelList(this.order, planar);
    this.numChannels = this.acn.length;
    this.name = `ambisonic${planar ? "2d" : "3d"}-o${this.order}`;
    this._sh = new Float64Array((this.order + 1) * (this.order + 1));
  }

  channelGains(az, el, out, off) {
    const sh = encodeSN3D(az, el, this.order, this._sh);
    const acn = this.acn;
    for (let c = 0; c < acn.length; c++) out[off + c] = sh[acn[c]];
  }

  /** Coincident cardioid pair at ±90° — W ± Y, the classic FOA monitor decode. */
  monitorStereo(data, frames, n, out) {
    const w = data[n];
    const yy = data[frames + n]; // ACN 1 is bus channel 1 in both bases
    out[0] = 0.5 * (w + yy);
    out[1] = 0.5 * (w - yy);
  }
}

// ── Bus ───────────────────────────────────────────────────────────────────

/**
 * The channel bus a renderer writes into: channel-major, one chunk deep, and
 * Float64 because the legacy stereo path accumulates in double locals — an
 * export tap (or #998.3's downmix) reads `data` directly.
 */
export class SpatialBus {
  constructor(renderer, frames) {
    this.renderer = renderer;
    this.numChannels = renderer.numChannels;
    this.frames = frames;
    this.data = new Float64Array(this.numChannels * frames);
    this.pair = new Float64Array(2);
  }

  clear() { this.data.fill(0.0); }

  /**
   * Accumulate one positioned source sample into frame `n`. The factor order
   * matches the stereo path's `s * vol * gain * ramp` exactly — do not
   * "simplify" it, that is what keeps a planar song bit-identical to stereo.
   */
  addSource(n, value, gains, off, ramp) {
    const d = this.data;
    const nc = this.numChannels;
    const f = this.frames;
    for (let c = 0; c < nc; c++) d[c * f + n] += (value * gains[off + c]) * ramp;
  }

  /** The device's stereo pair for frame `n`, as the renderer defines it. */
  stereoAt(n) {
    this.renderer.monitorStereo(this.data, this.frames, n, this.pair);
    return this.pair;
  }
}

// ── Per-voice spatial state ───────────────────────────────────────────────
// Legacy pan writes funnel through applyPanSet / applyPanSlide so that the
// stereo model keeps its exact arithmetic (clamped 0..255 integers) while the
// surround models track the continuous azimuth that the mixer and the Z slide
// actually use. `voice.channelPan` stays the integer mirror the UI reads.

/** Lane-pan write: absolute. `pan` is the legacy byte, or a 9-bit angle. */
export function applyPanSet(ts, voice, pan) {
  if (ts.surroundModel === SURROUND_STEREO) {
    voice.channelPan = pan & 0xff;
  } else {
    voice.panAzimuth = wrapAzimuth(pan);
    voice.channelPan = mirrorPanByte(voice.panAzimuth);
  }
  voice.rowPan = clamp(voice.channelPan >>> 2, 0, 63);
}

/** Lane-pan write: signed delta — clamped in stereo, wrapped in surround. */
export function applyPanSlide(ts, voice, delta) {
  if (ts.surroundModel === SURROUND_STEREO) {
    voice.channelPan = delta < 0
      ? Math.max(voice.channelPan + delta, 0)
      : Math.min(voice.channelPan + delta, 0xff);
  } else {
    voice.panAzimuth = wrapAzimuth(voice.panAzimuth + delta);
    voice.channelPan = mirrorPanByte(voice.panAzimuth);
  }
  voice.rowPan = clamp(voice.channelPan >>> 2, 0, 63);
}

/** Elevation write (effect X / 4). Planar songs stay on the horizon. */
export function applyElevation(ts, voice, el) {
  voice.panElevation = ts.surroundModel === SURROUND_SPATIAL ? el : 0.0;
}

// ── Note-pan axis ─────────────────────────────────────────────────────────
// The lane trio above places the LANE; this pair offsets the note within
// it. The offset is stored signed with 0 = neutral, so the writers take the
// same 128-is-centre values every other pan command takes and subtract the
// centre themselves — an Ixmp patch pan of $80 and a column SET of centre both
// mean "no shift", whatever the lane is doing.

/** Fold a note offset into range: clamped like a stereo pan, wrapped like an angle. */
export function boundNotePan(ts, off) {
  return boundNoteOffset(ts, off);
}

function boundNoteOffset(ts, off) {
  if (ts.surroundModel === SURROUND_STEREO) return clamp(off, -0xff, 0xff);
  return wrapAzimuth(off + AZIMUTH_TURN / 2) - AZIMUTH_TURN / 2;
}

/** Note-pan write: absolute. `pan` is a legacy byte or 9-bit angle, 128 = centre. */
export function applyNotePanSet(ts, voice, pan) {
  voice.notePan = boundNoteOffset(ts, pan - AZ_FRONT);
}

/** Note-pan write: signed delta. */
export function applyNotePanSlide(ts, voice, delta) {
  voice.notePan = boundNoteOffset(ts, voice.notePan + delta);
}

/** Note-elevation write (wide panning column). Planar songs stay on the horizon. */
export function applyNoteElevation(ts, voice, el) {
  voice.noteElevation = ts.surroundModel === SURROUND_SPATIAL ? el : 0.0;
}

/** The integer pan the UI and ghost copies see: the monitoring (folded) byte. */
export function mirrorPanByte(az) {
  return Math.round(foldAzimuthToPan(az));
}

/**
 * Effective azimuth of a voice: its own angle plus the note-pan offset, the pan
 * envelope's offset, the instrument's random pan swing and the panbrello LFO —
 * the surround twin of the stereo path's pan sum, wrapping where that one
 * clamps. So a Y that sweeps a stereo song across the front arc sweeps a
 * surround song along the same arc, and keeps turning past its ends.
 */
export function voiceAzimuth(voice) {
  if (voice.hasPanEnv && voice.panEnvOn) {
    let envPanRaw = Math.round(voice.envPan * 255.0);
    envPanRaw = envPanRaw < 0 ? 0 : envPanRaw > 255 ? 255 : envPanRaw;
    return wrapAzimuth(voice.panAzimuth + voice.notePan + envPanRaw - 128 + voice.randomPanBias +
      voice.panbrelloOffset);
  }
  return wrapAzimuth(voice.panAzimuth + voice.notePan + voice.randomPanBias + voice.panbrelloOffset);
}

/**
 * Effective STEREO pan of a voice: the lane and note axes, the pan
 * envelope's offset, the instrument's random pan swing and the panbrello LFO,
 * clamped to the byte the equal-energy law takes. The twin of voiceAzimuth
 * above, and the ONE place that sum is written — the meters used to keep their
 * own copy of it and quietly lost the pan swing (item 155).
 */
export function voicePanByte(voice) {
  let pan;
  if (voice.hasPanEnv && voice.panEnvOn) {
    let envPanRaw = Math.round(voice.envPan * 255.0);
    envPanRaw = envPanRaw < 0 ? 0 : envPanRaw > 255 ? 255 : envPanRaw;
    pan = voice.channelPan + voice.notePan + envPanRaw - 128 + voice.randomPanBias +
      voice.panbrelloOffset;
  } else {
    pan = voice.channelPan + voice.notePan + voice.randomPanBias + voice.panbrelloOffset;
  }
  return pan < 0 ? 0 : pan > 255 ? 255 : pan;
}

/** Effective elevation: the lane's height plus the note's own offset. */
export function voiceElevation(voice) {
  return voice.panElevation + voice.noteElevation;
}

// ── Where a lane SOUNDS, for the meters ───────────────────────────────────
// Everything above answers for ONE voice. A metainstrument is several at once,
// and the foreground voice is only its layer 0 — so a kit whose layers pan
// apart was being drawn at the first layer's position rather than at the
// note's (item 155.1). The displayed position is the mix-weighted MEAN of the
// constituents: for a plain instrument that is the voice's own value unchanged,
// and for a kit whose layers agree on panning it is still that value.

/** A voice's share of the lane's output, as the mixer weights it. */
function displayWeight(v) {
  const env = v.volEnvOn ? v.envVolMix : 1.0;
  return env * v.fadeoutVolume * v.currentMixVolume * v.layerMixGain *
    ((255 - v.fader) / 255.0);
}

/** Every voice lane `vi` is sounding — the foreground plus its layer
 *  children — visited with its display weight. */
function forEachSoundingLayer(ts, vi, voice, fn) {
  fn(voice, displayWeight(voice));
  if (!voice.metaForeground) return;
  for (const bg of ts.backgroundVoices) {
    if (bg.active && isSoundingChild(ts, bg, vi)) fn(bg, displayWeight(bg));
  }
}

/** The stereo pan the METERS show for lane `vi` (item 155.1). */
export function displayPanByte(ts, vi, voice) {
  let sum = 0.0, wsum = 0.0;
  forEachSoundingLayer(ts, vi, voice, (v, w) => { sum += voicePanByte(v) * w; wsum += w; });
  // A kit whose every layer has faded to nothing still has to be drawn
  // somewhere: fall back to the foreground voice's own position.
  return wsum > 1e-9 ? sum / wsum : voicePanByte(voice);
}

/** …and the same for a surround song, as [azimuth, elevation] into `out`.
 *  Angles are averaged as DIRECTIONS, so two layers either side of front
 *  average to front rather than to the back of the room. */
export function displayAngles(ts, vi, voice, out) {
  let x = 0.0, y = 0.0, z = 0.0, wsum = 0.0;
  forEachSoundingLayer(ts, vi, voice, (v, w) => {
    directionFromAngles(voiceAzimuth(v), voiceElevation(v), dirScratch);
    x += dirScratch[0] * w; y += dirScratch[1] * w; z += dirScratch[2] * w;
    wsum += w;
  });
  // Weightless, or layers exactly opposite each other (whose directions cancel):
  // neither has a mean direction, so the foreground voice speaks for the note.
  const len = Math.sqrt(x * x + y * y + z * z);
  if (wsum <= 1e-9 || len < 1e-6) {
    out[0] = voiceAzimuth(voice);
    out[1] = voiceElevation(voice);
    return out;
  }
  // The mean of unit vectors is shorter than one; anglesFromDirection reads the
  // z component as a sine, so it has to be put back on the sphere first.
  anglesFromDirection(x / len, y / len, z / len, out);
  return out;
}

const dirScratch = new Float64Array(3);

const angleScratch = new Float64Array(2);

/**
 * Renderer gains for every channel of `voice`, cached in `sc` and recomputed
 * only when the source actually moves (a direction changes at most once per
 * tick, the mixer asks once per sample). Returns the cache entry, which the
 * caller stores back — each BUS needs its own, or two buses alternating on the
 * same voice would invalidate each other's on every single sample.
 */
function voiceGainsCache(bus, voice, sc) {
  const nc = bus.numChannels;
  const layout = SAMPLE_CHANNEL_LAYOUT[voice.activeChanCount] ?? SAMPLE_CHANNEL_LAYOUT[1];
  const chans = layout.length;
  // The RAMPED azimuth (item 141) — the mixer advanced it once for this sample,
  // and the stereo path is smoothing the very same number, which is what keeps a
  // planar song rendering identically to its stereo twin.
  const az = voice.currentPan;
  const el = voiceElevation(voice);
  if (sc === null || sc.gains.length < nc * MAX_SAMPLE_CHANNELS) {
    sc = {
      az: NaN, el: NaN, chans: 0, renderer: null,
      gains: new Float64Array(nc * MAX_SAMPLE_CHANNELS),
    };
  }
  if (sc.az !== az || sc.el !== el || sc.chans !== chans || sc.renderer !== bus.renderer) {
    for (let k = 0; k < chans; k++) {
      sampleChannelAngles(az, el, layout[k], angleScratch);
      bus.renderer.channelGains(angleScratch[0], angleScratch[1], sc.gains, k * nc);
    }
    sc.az = az; sc.el = el; sc.chans = chans; sc.renderer = bus.renderer;
  }
  return sc;
}

/** Gains for the MONITOR / export bus (voice.spatial). */
export function spatialVoiceGains(bus, voice) {
  return (voice.spatial = voiceGainsCache(bus, voice, voice.spatial)).gains;
}

/** Gains for the master-strip analysis bus (item 98) — its own cache slot. */
export function analysisVoiceGains(bus, voice) {
  return (voice.analysisSpatial = voiceGainsCache(bus, voice, voice.analysisSpatial)).gains;
}
