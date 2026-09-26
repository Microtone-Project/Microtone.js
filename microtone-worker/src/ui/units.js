// Shared numeric-field annotations for the instrument editors — the basic
// General tab (views/instruments.js) and the Advanced Edit 'x' block
// (views/instadvanced.js) present the same fadeout / filter fields, so the
// unit translations live here to stay identical. Filter units follow the
// engine (AudioAdapter.refreshVoiceFilter).

import { t } from "./i18n.js";
import { minifloatToDouble, minifloatFromDouble } from "../engine/minifloat.js";

/**
 * Envelope segment length, as a spinner mapping (item 156.2). The record stores
 * a 3.5-minifloat CODE and a person reads seconds, so − and + walk ONE code —
 * every value the format can hold, in order, none of them skipped and none of
 * them unreachable — while the box shows what that code actually lasts. A plain
 * "step by 0.01 s" could do neither: most of its stops do not exist in the
 * format and the ones near the top are hundreds of codes apart.
 */
export const SEG_MINIFLOAT_MAP = {
  toDisplay: (code) => `${minifloatToDouble(code).toFixed(3)} s`,
  fromDisplay: (text) => minifloatFromDouble(Math.max(parseFloat(text) || 0, 0)),
  step: (code, dir) => Math.min(Math.max((code | 0) + dir, 0), 255),
};

export const annHex2 = (v) => "$" + (v & 0xff).toString(16).toUpperCase().padStart(2, "0");

/** ImpulseTracker filter byte: 0xFF = off (unfiltered), else the raw hex value. */
export const annFilter = (v) => (v === 0xff ? t("inst.annOff") : annHex2(v));

/** Volume Fadeout step → ticks-to-silence (0 = none, ≥1024 = instant cut). */
export function annFadeout(v) {
  if (v <= 0) return t("inst.annNone");
  if (v >= 1024) return t("inst.annCut");
  return t("inst.annTicks", { n: Math.round(1024 / v) });
}

// SoundFont filter units (AudioAdapter.refreshVoiceFilter): cutoff = absolute
// cents → Hz (8.176·2^(cents/1200)); resonance = centibels above DC → dB. The
// cents/cB are clamped to the SF2-spec range for display — a value carried over
// from a toggled ImpulseTracker instrument can sit far outside it (the engine
// clamps too), and the raw Hz/dB would otherwise read as an absurd number.
export function annSfCutoff(v) {
  if (v >= 0xffff) return t("inst.annOff");
  const hz = 8.176 * Math.pow(2, Math.min(Math.max(v, 1500), 13500) / 1200);
  if (hz >= 10000) return Math.round(hz / 1000) + " kHz";
  if (hz >= 1000) return (hz / 1000).toFixed(2) + " kHz";
  return Math.round(hz) + " Hz";
}
export function annSfReso(v) {
  if (v >= 0xffff) return t("inst.annFlat");
  return (Math.min(v, 960) / 10).toFixed(1) + " dB";
}

// ── spatial directions (#998) ────────────────────────────────────────────
// Shared by the Panner dialog and the Instruments view's default-position
// fields, so a direction is named the same wherever it is shown.

/** Human label for a 9-bit azimuth: "90.0° front". */
export function azimuthLabel(az) {
  const a = ((az % 512) + 512) % 512;
  const deg = (a * 360) / 512;
  const names = ["dir.left", "dir.frontLeft", "dir.front", "dir.frontRight", "dir.right",
    "dir.backRight", "dir.back", "dir.backLeft", "dir.left"];
  return `${deg.toFixed(1)}° ${t(names[Math.round(deg / 45)])}`;
}

/** Human label for a signed elevation byte: "+45.0°". */
export function elevationLabel(el) {
  const deg = (el * 90) / 128;
  return `${deg >= 0 ? "+" : ""}${deg.toFixed(1)}°`;
}

/** Human label for a stereo pan byte ($00 left, $80 centre, $FF right):
 *  "centre", "50% left". The two ends are asymmetric by one step, so each side
 *  is scaled to its own reach and both ends read 100%. */
export function panLabel(pan) {
  const p = Math.max(0, Math.min(255, Math.round(pan)));
  if (p === 128) return t("dir.centre");
  return p < 128
    ? t("panner.panLeft", { pct: Math.round(((128 - p) * 100) / 128) })
    : t("panner.panRight", { pct: Math.round(((p - 128) * 100) / 127) });
}
