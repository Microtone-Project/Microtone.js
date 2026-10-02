// The instrument presets — synthesised, not sampled, and so not shipped.
//
// Touch has no instrument editor and no Ixmp: every instrument is one sample
// in the pool plus one 256-byte record, built here at start-up into a fresh
// sample+instrument image (TAUD_FILE_FORMAT.md §3, §7). The image goes into
// every sketch that is played or sent, so a sketch opened in Microtone sounds
// exactly as it did on the phone, with nothing to install.
//
// Melodic presets are ONE-CYCLE LOOPS behind a short attack: the attack is a
// few dozen cycles of a waveform that settles into the loop cycle, and from
// there the volume envelope does the decaying. Pitch is exact by
// construction — a cycle is a whole number of samples, and the record's
// sampling rate is chosen so that cycle sounds C4 — which matters on a
// keyboard whose whole point is pitches a piano does not have. A loop at
// eight bits is also clean: the quantisation noise scales down with the
// envelope instead of being frozen into a long decaying recording.
//
// Everything is deterministic (a seeded PRNG for the noise), so two phones
// build byte-identical banks, and a test can pin them.

import { TaudInst, envPoint } from "../core/engine/inst.js";
import { minifloatFromDouble } from "../core/engine/minifloat.js";
import { SAMPLEBIN_SIZE, SAMPLEINST_SIZE, INST_RECORD_SIZE } from "../core/format/taud-const.js";

/** Concert-pitch C4 (A4 = 440 Hz) — what a song declaring A4 @ 440 plays a
 *  record's "sampling rate at C4" against (TAUD_FILE_FORMAT.md §4 Tuning). */
const C4_HZ = 440 * 2 ** (-9 / 12);
/** Drum hits are recorded at this rate and played at their own pitch on C4. */
const DRUM_RATE = 32000;
/** Samples past the loop end, so interpolation at the seam reads the loop's
 *  own continuation rather than the next sample in the pool. */
const GUARD = 8;

/** The drum kit, in pad order. `short` labels a pattern cell (3 chars). */
export const DRUMS = Object.freeze([
  { id: "kick", name: "Kick", short: "KCK" },
  { id: "snare", name: "Snare", short: "SNR" },
  { id: "hatc", name: "Closed hat", short: "HHC" },
  { id: "hato", name: "Open hat", short: "HHO" },
  { id: "clap", name: "Clap", short: "CLP" },
  { id: "toml", name: "Low tom", short: "TML" },
  { id: "tomh", name: "High tom", short: "TMH" },
  { id: "rim", name: "Rim", short: "RIM" },
]);

/** Melodic presets, in picker order, then the kit. `short` heads a lane;
 *  `octave` is where the keyboard's origin key sits for the preset. */
export const PRESETS = Object.freeze([
  { id: "piano", name: "Piano", short: "PNO", octave: 3 },
  { id: "epiano", name: "Electric piano", short: "EP", octave: 3 },
  { id: "bass", name: "Bass", short: "BAS", octave: 1 },
  { id: "pluck", name: "Pluck", short: "PLK", octave: 3 },
  { id: "lead", name: "Lead", short: "LEAD", octave: 4 },
  { id: "pad", name: "Pad", short: "PAD", octave: 3 },
  { id: "organ", name: "Organ", short: "ORG", octave: 3 },
  { id: "drums", name: "Drums", short: "DRM", octave: 4, kit: true },
]);

export const presetById = (id) => PRESETS.find((p) => p.id === id) ?? PRESETS[0];

// ── synthesis ────────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One period of Σ amps[k−1]·sin(2πk·t/P), sampled at t = 0…P−1. */
function harmonicCycle(P, amps, out = new Float64Array(P), offset = 0, gain = 1) {
  for (let t = 0; t < P; t++) {
    let v = 0;
    for (let k = 1; k <= amps.length; k++) {
      const a = amps[k - 1];
      if (a !== 0) v += a * Math.sin((2 * Math.PI * k * t) / P);
    }
    out[offset + t] += gain * v;
  }
  return out;
}

/**
 * A melodic sample: `attackCycles` cycles whose harmonic amplitudes are
 * `ampsAt(c)` for cycle c (plus `extra(c, t)` per sample, for noise or FM),
 * then the loop cycle `ampsAt(attackCycles)`, then the guard. Every cycle is
 * a whole period, so the joins are continuous whenever the amplitudes move
 * smoothly.
 */
function buildMelodic(P, attackCycles, ampsAt, extra = null) {
  const len = (attackCycles + 1) * P;
  const x = new Float64Array(len + GUARD);
  for (let c = 0; c <= attackCycles; c++) {
    harmonicCycle(P, ampsAt(c), x, c * P);
    if (extra && c < attackCycles) {
      for (let t = 0; t < P; t++) x[c * P + t] += extra(c, t);
    }
  }
  for (let g = 0; g < GUARD; g++) x[len + g] = x[attackCycles * P + g];
  return { pcm: x, loopStart: attackCycles * P, loopEnd: len, rate: Math.round(C4_HZ * P) };
}

/** Peak-normalise to `peak` and quantise to unsigned 8-bit ($80 = zero). */
function toU8(x, peak = 0.9) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  const k = m > 0 ? (peak * 127) / m : 0;
  const out = new Uint8Array(x.length);
  for (let i = 0; i < x.length; i++) {
    out[i] = Math.min(255, Math.max(1, Math.round(128 + x[i] * k)));
  }
  return out;
}

function synthPiano() {
  const P = 128, A = 80; // ~0.31 s of attack at C4
  return buildMelodic(P, A, (c) => {
    const s = c / A; // 0 → 1 across the attack
    const amps = [];
    for (let k = 1; k <= 24; k++) {
      // A hammer-struck string: bright at the strike, the upper partials dying
      // first, settling into a round tone with a little second harmonic.
      const steady = (1 / k ** 1.6) * Math.exp(-0.18 * k);
      const strike = (1 / k ** 0.9) * Math.exp(-0.07 * k);
      const w = Math.exp(-s * (2 + 0.6 * k));
      amps.push(steady + strike * w);
    }
    return amps;
  }, (() => {
    const rnd = mulberry32(0x91a0);
    return (c, t) => (c < 3 ? (rnd() - 0.5) * 0.25 * Math.exp(-(c * P + t) / 90) : 0);
  })());
}

function synthEPiano() {
  const P = 128, A = 96;
  // Two-operator FM at 1:1 — whole-number ratios stay periodic — with a
  // decaying index, plus the tine's bell partial at the 14th harmonic.
  const cyc = new Float64Array((A + 1) * P + GUARD);
  for (let c = 0; c <= A; c++) {
    const s = Math.min(1, c / A);
    const index = 0.35 + 1.6 * Math.exp(-s * 3.2);
    const bell = c < A ? 0.22 * Math.exp(-s * 9) : 0;
    for (let t = 0; t < P; t++) {
      const th = (2 * Math.PI * t) / P;
      cyc[c * P + t] = Math.sin(th + index * Math.sin(th)) + bell * Math.sin(14 * th);
    }
  }
  const len = (A + 1) * P;
  for (let g = 0; g < GUARD; g++) cyc[len + g] = cyc[A * P + g];
  return { pcm: cyc, loopStart: A * P, loopEnd: len, rate: Math.round(C4_HZ * P) };
}

function synthBass() {
  const P = 200, A = 40; // more samples per cycle: it is played octaves down
  return buildMelodic(P, A, (c) => {
    const s = c / A;
    const cutoff = 4 + 14 * Math.exp(-s * 4); // a plucked, closing filter
    const amps = [];
    for (let k = 1; k <= 40; k++) {
      const saw = 1 / k;
      const odd = k % 2 === 1 ? 0.35 / k : 0;
      amps.push((saw + odd) / (1 + (k / cutoff) ** 4));
    }
    return amps;
  });
}

function synthPluck() {
  // Clean on purpose: a near-sine with a touch of triangle. Two pluck notes a
  // few cents apart beat audibly against each other, which is what this preset
  // is for — it makes a tuning's small differences conspicuous.
  const P = 128, A = 24;
  return buildMelodic(P, A, (c) => {
    const w = Math.exp(-(c / A) * 5); // the bright onset fades in ~0.1 s
    return [1, 0.12 + 0.25 * w, -0.06 - 0.15 * w, 0.18 * w, -0.08 * w, 0.06 * w, -0.04 * w, 0.03 * w];
  });
}

function synthLead() {
  const P = 128, A = 4;
  return buildMelodic(P, A, () => {
    const amps = [];
    for (let k = 1; k <= 18; k++) amps.push((1 / k) * (k % 2 === 0 ? 0.8 : 1) * Math.exp(-0.04 * k));
    return amps;
  });
}

function synthPad() {
  // Three saws over one long loop: L samples hold 64 cycles of one, 65 of the
  // next and 128 of an octave above, so the mix repeats exactly every L and
  // beats slowly (about 4 Hz at C4) — chorus without any modulation at all.
  const L = 8192;
  const x = new Float64Array(L + GUARD);
  const saw = (cycles, gain, nH) => {
    for (let t = 0; t < L; t++) {
      let v = 0;
      for (let k = 1; k <= nH; k++) v += Math.sin((2 * Math.PI * k * cycles * t) / L) / (k * (1 + (k / 5) ** 2));
      x[t] += gain * v;
    }
  };
  saw(64, 1, 14);
  saw(65, 0.9, 14);
  saw(128, 0.35, 8);
  for (let g = 0; g < GUARD; g++) x[L + g] = x[g];
  // The perceived pitch is the mean of 64 and 65 cycles per loop.
  return { pcm: x, loopStart: 0, loopEnd: L, rate: Math.round((C4_HZ * L) / 64.5) };
}

function synthOrgan() {
  // Drawbars 16′ 8′ 4′ 2⅔′ 2′ over a two-cycle loop, so the sub-octave fits.
  const P = 256, A = 6;
  const draw = (click) => {
    // Harmonic k of the 16′ fundamental; the 8′ (k = 2) is the sounding pitch.
    const a = new Array(16).fill(0);
    a[0] = 0.5; a[1] = 1; a[3] = 0.7; a[5] = 0.45; a[7] = 0.4;
    if (click) for (let k = 10; k <= 16; k++) a[k - 1] = 0.08;
    return a;
  };
  const s = buildMelodic(P, A, (c) => draw(c < 2));
  s.rate = Math.round(C4_HZ * (P / 2)); // two cycles of the 8′ per loop
  return s;
}

/** A drum hit: `fn(t, rnd)` over `seconds`, at DRUM_RATE. */
function drum(seconds, seed, fn) {
  const n = Math.round(seconds * DRUM_RATE);
  const x = new Float64Array(n);
  const rnd = mulberry32(seed);
  for (let i = 0; i < n; i++) x[i] = fn(i / DRUM_RATE, rnd);
  return { pcm: x, loopStart: 0, loopEnd: 0, rate: DRUM_RATE, drum: true };
}

/** One-pole high-pass over a noise source, kept as closure state. */
function hpNoise(alpha) {
  let prevIn = 0, prevOut = 0;
  return (rnd) => {
    const v = rnd() * 2 - 1;
    prevOut = alpha * (prevOut + v - prevIn);
    prevIn = v;
    return prevOut;
  };
}

function sweepSine(f0, f1, tau) {
  let phase = 0, last = 0;
  return (t) => {
    const f = f1 + (f0 - f1) * Math.exp(-t / tau);
    phase += (2 * Math.PI * f) * (t - last);
    last = t;
    return Math.sin(phase);
  };
}

const DRUM_SYNTH = {
  kick: () => { const s = sweepSine(170, 48, 0.035); return drum(0.45, 1, (t, r) => s(t) * Math.exp(-t / 0.16) + (t < 0.004 ? (r() - 0.5) * 0.6 : 0)); },
  snare: () => { const n = hpNoise(0.7); const s = sweepSine(240, 185, 0.02); return drum(0.3, 2, (t, r) => n(r) * 0.8 * Math.exp(-t / 0.07) + s(t) * 0.55 * Math.exp(-t / 0.05)); },
  hatc: () => { const n = hpNoise(0.25); return drum(0.09, 3, (t, r) => n(r) * Math.exp(-t / 0.018)); },
  hato: () => { const n = hpNoise(0.25); return drum(0.5, 4, (t, r) => n(r) * Math.exp(-t / 0.13)); },
  clap: () => {
    const n = hpNoise(0.6);
    return drum(0.32, 5, (t, r) => {
      const v = n(r);
      let e = 0;
      for (const at of [0, 0.011, 0.022]) if (t >= at) e = Math.max(e, Math.exp(-(t - at) / 0.006));
      return v * (e + (t >= 0.022 ? 0.6 * Math.exp(-(t - 0.022) / 0.09) : 0));
    });
  },
  toml: () => { const s = sweepSine(150, 92, 0.06); return drum(0.5, 6, (t) => s(t) * Math.exp(-t / 0.17)); },
  tomh: () => { const s = sweepSine(240, 160, 0.05); return drum(0.4, 7, (t) => s(t) * Math.exp(-t / 0.13)); },
  rim: () => drum(0.12, 8, (t, r) => (Math.sin(2 * Math.PI * 1680 * t) * 0.6 + Math.sin(2 * Math.PI * 820 * t) * 0.5 + (r() - 0.5) * 0.4) * Math.exp(-t / 0.018)),
};

// ── instrument records ───────────────────────────────────────────────────────

/** Envelope nodes from [value, seconds-to-next] pairs; the last pair's time
 *  is ignored — that node holds (offset 0 is the terminator, §7.2). */
function setEnvelope(inst, pairs) {
  pairs.forEach(([value, sec], i) => {
    const last = i === pairs.length - 1;
    inst.volEnvelopes[i] = envPoint(value, last ? 0 : Math.max(1, minifloatFromDouble(sec)));
  });
  inst.volEnvLoop = 0x2000; // P: the envelope is present (and does not wrap)
}

/** SUSTAIN word holding the envelope at node `n` while the key is down. */
const sustainAt = (n) => (n << 8) | 0x20 | n;

/** Volume fadeout after key-off, in ticks to silence (§7.1 fadeout). */
function setFadeout(inst, ticks) {
  const stored = Math.min(4095, Math.max(1, Math.round(1024 / ticks)));
  inst.volumeFadeoutLow = stored & 0xff;
  inst.fadeoutHigh = (inst.fadeoutHigh & 0xf0) | ((stored >>> 8) & 0x0f);
}

const SHAPE = {
  piano: (i) => { setEnvelope(i, [[63, 0.06], [46, 0.9], [30, 2.6], [12, 6], [0, 0]]); setFadeout(i, 14); },
  epiano: (i) => { setEnvelope(i, [[63, 0.25], [42, 1.8], [22, 4.5], [0, 0]]); setFadeout(i, 18); },
  bass: (i) => { setEnvelope(i, [[63, 0.18], [46, 0.12], [0, 0]]); i.volEnvSustainWord = sustainAt(1); },
  pluck: (i) => { setEnvelope(i, [[63, 0.03], [48, 0.5], [22, 1.6], [0, 0]]); setFadeout(i, 10); },
  lead: (i) => {
    setEnvelope(i, [[58, 0.03], [63, 0.25], [54, 0.18], [0, 0]]);
    i.volEnvSustainWord = sustainAt(2);
    // Delayed vibrato: ~5.5 Hz at 48 ticks/s, about ±12 cents, ramping in
    // over half a second (FT2 sweep = ticks to full depth).
    i.vibratoSpeed = 118; i.vibratoDepth = 30; i.vibratoSweep = 24;
  },
  pad: (i) => { setEnvelope(i, [[0, 0.7], [63, 1.4], [0, 0]]); i.volEnvSustainWord = sustainAt(1); },
  organ: (i) => { setEnvelope(i, [[63, 0.06], [0, 0]]); i.volEnvSustainWord = sustainAt(0); },
};

function recordBytes(inst) {
  const rec = new Uint8Array(INST_RECORD_SIZE);
  for (let b = 0; b < INST_RECORD_SIZE; b++) rec[b] = inst.getByteNormal(b);
  return rec;
}

/**
 * Build the whole bank. → {
 *   image:   the 8 650 752-byte sample+instrument image,
 *   slots:   { piano: 1, …, organ: 7, drums: [8, …, 15] },
 *   names:   instrument names by slot (slot 0 is ""),
 * }
 */
export function buildBank() {
  const image = new Uint8Array(SAMPLEINST_SIZE);
  image.fill(0x80, 0, SAMPLEBIN_SIZE); // silence, not $00, in the unused pool
  const slots = {};
  const names = [""];
  let ptr = 0;
  let slot = 1;

  const place = (synth, name, shape) => {
    const u8 = toU8(synth.pcm, synth.drum ? 0.95 : 0.9);
    if (ptr + u8.length > SAMPLEBIN_SIZE) throw new Error("preset bank: sample pool full");
    image.set(u8, ptr);
    const inst = new TaudInst(slot);
    inst.samplePtr = ptr;
    inst.sampleLength = u8.length;
    inst.samplingRate = synth.rate;
    inst.sampleLoopStart = synth.loopStart;
    inst.sampleLoopEnd = synth.loopEnd;
    inst.loopMode = synth.drum ? 0x10 : 1; // percussion one-shot, or forward loop
    inst.defaultNoteVolume = 0xff;
    if (shape) shape(inst);
    image.set(recordBytes(inst), SAMPLEBIN_SIZE + slot * INST_RECORD_SIZE);
    names[slot] = name;
    ptr += u8.length;
    return slot++;
  };

  const synth = {
    piano: synthPiano, epiano: synthEPiano, bass: synthBass, pluck: synthPluck,
    lead: synthLead, pad: synthPad, organ: synthOrgan,
  };
  for (const p of PRESETS) {
    if (p.kit) {
      slots[p.id] = DRUMS.map((d) => place(DRUM_SYNTH[d.id](), `${d.name}`, null));
    } else {
      slots[p.id] = place(synth[p.id](), p.name, SHAPE[p.id]);
    }
  }
  return { image, slots, names };
}
