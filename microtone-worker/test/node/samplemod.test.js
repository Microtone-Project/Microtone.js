// Sample-modification note effects (items 130, 152, 153) — notefx 2 and 3, one
// command with two spellings ($sexy: region, operation, step period; `2`
// inverts which side of the region is touched). Region decoding is pinned here
// against TAUD_NOTE_EFFECTS.md; the engine legs drive real rows through the
// tracker so the per-tick clock and the read-time transforms are the ones the
// mixer actually uses.
//
// Item 153 made the command loop-relative: EVERY selector, comb, wrap and jump
// quantum is measured against the sounding voice's loop region (the whole
// sample when it has none), so the decoder returns FRACTIONS and resolveModGeom
// cuts them per voice.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../core/engine/engine.js";
import { TRACKER_CHUNK, setSamplingRate } from "../../core/engine/constants.js";
import {
  decodeSampleRegion, MOD_STEP, MOD_MAX, MOD_COMB_MAX, MOD_COMB_ODD_MAX,
  MOD_SCATTER_FRAC, MOD_JUMP_SLICES, MOD_JUMP8, MOD_JUMP16, MOD_JUMP_ALL,
  MOD_RND512, MOD_RND8,
  MOD_XFADE_SAMPLES, modStepPeriod, isJumpOp, isRndOp, jumpRot, scatterReach,
  scatterSource, ModGeom, resolveModGeom, modTouches, modAddress,
  REGION_NONE, REGION_SET, REGION_COMB,
  // Argument extension (item 162)
  fModTouches, extModTouches, decodeExtOp, EXT_JUMP_N, extJitterFrac,
  EXT_SCATTER_FRAC, EXT_BITPERM_LUT, extYkPeriodTicks, modAddressExt,
  bitRotate8, applyExtLevel, applyExtLevelPrev,
} from "../../core/engine/samplemod.js";
import { setRandomSource, makeSeededRandom } from "../../core/engine/rng.js";
import { readSamplePoint } from "../../core/engine/sampler.js";
import { EffectOp } from "../../core/engine/tables.js";

setSamplingRate(32000);

const out = new Float64Array(4);
/** decodeSampleRegion, as [from, to] fractions + the comb pair. */
const dec = (se) => ({
  code: decodeSampleRegion(se, out),
  from: out[0], to: out[1], bits: out[2], odd: out[3],
});

/**
 * The decoded region resolved against a voice's geometry, exactly as
 * applySampleModEffect + resolveModGeom do it: an extent replaces the extent
 * and clears the comb, a comb keeps whatever extent is standing (here the
 * whole domain, which is what a fresh instrument carries).
 */
function geomOf(se, { len = 1000, ls = 0, le = 0, invert = false } = {}) {
  const code = decodeSampleRegion(se, out);
  if (code === REGION_NONE) return null;
  const view = {
    modFrom: 0, modTo: 1, modCombBits: -1, modCombOdd: false,
    modInvert: invert, modEpoch: 0,
  };
  if (code === REGION_COMB) {
    view.modCombBits = out[2];
    view.modCombOdd = out[3] !== 0;
  } else {
    view.modFrom = out[0];
    view.modTo = out[1];
  }
  const g = new ModGeom();
  resolveModGeom(g, view, ls, le, len);
  return g;
}

/** Which bytes of [0, len) a resolved region touches. */
function touchedOf(g, invert, len = 1000) {
  const hits = [];
  for (let i = 0; i < len; i++) if (modTouches(g, invert, i)) hits.push(i);
  return hits;
}

test("region: s <= e is the percentage form of the DOMAIN", () => {
  // $0F — all of it; $4B — exactly the middle half.
  assert.deepEqual(dec(0x0f), { code: REGION_SET, from: 0, to: 1, bits: -1, odd: 0 });
  assert.deepEqual(dec(0x4b), { code: REGION_SET, from: 4 / 16, to: 12 / 16, bits: -1, odd: 0 });
  // Boundaries: start s/16, end (e+1)/16 — so $88 is the ninth sixteenth alone.
  assert.deepEqual(dec(0x88), { code: REGION_SET, from: 8 / 16, to: 9 / 16, bits: -1, odd: 0 });
  assert.deepEqual(dec(0xff), { code: REGION_SET, from: 15 / 16, to: 1, bits: -1, odd: 0 });
});

test("region: $00 is the whole loop region — the same span as $0F", () => {
  assert.deepEqual(dec(0x00), { code: REGION_SET, from: 0, to: 1, bits: -1, odd: 0 });
  assert.deepEqual(dec(0x00), dec(0x0f),
    "item 153: everything is relative to the loop, so 'the loop' and 'all of it' coincide");
});

test("region: the named fractions", () => {
  assert.deepEqual(dec(0x10), { code: REGION_SET, from: 1 / 4, to: 3 / 4, bits: -1, odd: 0 });
  assert.deepEqual(dec(0x20), { code: REGION_SET, from: 0, to: 2 / 3, bits: -1, odd: 0 });
  assert.deepEqual(dec(0x21), { code: REGION_SET, from: 1 / 3, to: 1, bits: -1, odd: 0 });
  assert.deepEqual(dec(0x30), { code: REGION_SET, from: 0, to: 1 / 3, bits: -1, odd: 0 });
  assert.deepEqual(dec(0x31), { code: REGION_SET, from: 1 / 3, to: 2 / 3, bits: -1, odd: 0 });
  assert.deepEqual(dec(0x32), { code: REGION_SET, from: 2 / 3, to: 1, bits: -1, odd: 0 });
  // $10 and $4B name the same middle half two ways.
  assert.deepEqual(dec(0x10), dec(0x4b));
});

test("region: a fresh extent is solid — the comb is written after it", () => {
  assert.equal(dec(0x0f).bits, -1);
  assert.equal(dec(0x31).bits, -1);
});

test("region: $Fn / $En are the two comb ladders and keep the extent", () => {
  for (let n = 0; n <= MOD_COMB_MAX; n++) {
    const r = dec(0xf0 | n);
    assert.equal(r.code, REGION_COMB, `$F${n.toString(16)} combs`);
    assert.equal(r.bits, n);
    assert.equal(r.odd, 0, "$Fn keeps the EVEN chunks");
  }
  for (let n = 0; n <= MOD_COMB_ODD_MAX; n++) {
    const r = dec(0xe0 | n);
    assert.equal(r.code, REGION_COMB, `$E${n.toString(16)} combs`);
    assert.equal(r.bits, n);
    assert.equal(r.odd, 1, "$En keeps the ODD chunks");
  }
  // …but $FF, $EE and $EF are s <= e, i.e. ordinary extents. That is exactly
  // why the odd ladder is one rung shorter than the even one.
  for (const se of [0xff, 0xee, 0xef]) assert.equal(dec(se).code, REGION_SET);
});

test("region: s > e outside the named set is reserved and ignored", () => {
  // $40 and $41 are among them: they used to set the rotate step, which the
  // operation nibble now carries.
  for (const se of [0x40, 0x41, 0x54, 0xa9, 0xd3, 0x73]) {
    assert.ok((se >> 4) > (se & 0xf), `$${se.toString(16)} really is s > e`);
    assert.equal(dec(se).code, REGION_NONE, `$${se.toString(16)} is reserved`);
  }
});

test("the speed nibble is a period in TICKS, not a funk-ladder index", () => {
  // $F every tick, $E every other one, … $1 every fifteenth, $0 frozen.
  assert.deepEqual([0, 1, 2, 8, 0xe, 0xf].map(modStepPeriod), [0, 15, 14, 8, 2, 1]);
  for (let y = 1; y <= 0xf; y++) assert.equal(modStepPeriod(y), 16 - y);
});

test("operation steps: rotate by 1/2/4/8 bytes, subtract 2/8/32/128", () => {
  assert.deepEqual([...MOD_STEP].slice(0, 10), [0, 0, 1, 2, 4, 8, 2, 8, 32, 128]);
  assert.equal(MOD_STEP.length, 16, "one entry per $x nibble");
  // $A..$F are the two random families: $A/$B/$C throw the whole region,
  // $D/$E/$F throw its bytes. No operation nibble is reserved any more.
  assert.equal(MOD_MAX, 0xf);
  assert.deepEqual([...MOD_JUMP_SLICES], [8, 16], "$A eighths, $B sixteenths");
  assert.deepEqual([...MOD_SCATTER_FRAC], [1 / 512, 1 / 64, 1 / 8]);
  assert.deepEqual([0x9, 0xa, 0xb, 0xc, 0xd].map(isJumpOp),
    [false, true, true, true, false]);
  assert.deepEqual([0xc, 0xd, 0xe, 0xf].map(isRndOp), [false, true, true, true]);
});

// ── the domain: everything is relative to the loop region (item 153) ─────────

test("the domain is the loop region, and the whole sample when there is none", () => {
  // No loop: $0F is the file.
  const whole = geomOf(0x0f, { len: 1000 });
  assert.deepEqual([whole.es, whole.ee, whole.ds, whole.dl], [0, 1000, 0, 1000]);
  // A loop over [200, 600): the SAME argument now names those 400 bytes.
  const looped = geomOf(0x0f, { len: 1000, ls: 200, le: 600 });
  assert.deepEqual([looped.es, looped.ee, looped.ds, looped.dl], [200, 600, 200, 400]);
  // …and every selector is cut against them, not against the file.
  const third = geomOf(0x31, { len: 1000, ls: 200, le: 600 });
  assert.deepEqual([third.es, third.ee], [333, 467], "the middle third OF THE LOOP");
  assert.deepEqual([third.ds, third.dl], [333, 134], "…and that is what a rotate wraps in");
});

test("$00 and $0F resolve identically, loop or no loop", () => {
  for (const geom of [{ len: 1000 }, { len: 1000, ls: 200, le: 600 }]) {
    const a = geomOf(0x00, geom);
    const b = geomOf(0x0f, geom);
    assert.deepEqual([a.es, a.ee, a.dl], [b.es, b.ee, b.dl]);
  }
});

test("notefx 2's wrap domain is the LOOP, not the file", () => {
  // An inverted region reaches both ends of the domain — but never past it: `2`
  // spares its region and modifies the rest of the LOOP.
  const g = geomOf(0x31, { len: 1000, ls: 200, le: 600, invert: true });
  assert.deepEqual([g.ds, g.dl], [200, 400], "the wrap domain is the loop region");
  const hits = touchedOf(g, true);
  assert.equal(hits[0], 200, "nothing before the loop is touched");
  assert.equal(hits[hits.length - 1], 599, "…and nothing after it");
  for (let i = 333; i < 467; i++) assert.ok(!modTouches(g, true, i), `byte ${i} is spared`);
});

test("a degenerate extent is not live and the read path skips it", () => {
  assert.equal(geomOf(0x00, { len: 1, ls: 0, le: 0 }).live, false);
  assert.equal(geomOf(0x88, { len: 8 }).live, false, "a sixteenth of 8 bytes is half a byte");
  assert.equal(geomOf(0x88, { len: 1000 }).live, true);
});

// ── the comb ladders (items 153.3, 153.4) ────────────────────────────────────

test("$F0 is the first half and $E0 the second", () => {
  const even = geomOf(0xf0, { len: 1000 });
  assert.equal(even.combN, 2);
  assert.deepEqual([touchedOf(even, false)[0], touchedOf(even, false).length], [0, 500]);
  const odd = geomOf(0xe0, { len: 1000 });
  assert.equal(odd.combN, 2);
  assert.deepEqual([touchedOf(odd, false)[0], touchedOf(odd, false).length], [500, 500]);
});

test("$F1 touches '1-3-' and $E1 touches '-2-4'", () => {
  const quarters = (se) => {
    const g = geomOf(se, { len: 1000 });
    assert.equal(g.combN, 4);
    return [0, 1, 2, 3].map((q) => modTouches(g, false, q * 250 + 10));
  };
  assert.deepEqual(quarters(0xf1), [true, false, true, false]);
  assert.deepEqual(quarters(0xe1), [false, true, false, true]);
});

test("the comb divides the EXTENT, so it composes with a region", () => {
  // 3 $311F then 3 $F21F — the middle third, combed into 8.
  decodeSampleRegion(0x31, out);
  const from = out[0], to = out[1];
  decodeSampleRegion(0xf2, out);
  const g = new ModGeom();
  resolveModGeom(g, {
    modFrom: from, modTo: to, modCombBits: out[2], modCombOdd: out[3] !== 0,
    modInvert: false, modEpoch: 0,
  }, 0, 0, 1000);
  assert.deepEqual([g.es, g.ee, g.combN], [333, 667, 8]);
  const hits = touchedOf(g, false);
  assert.ok(hits[0] === 333, "the extent still starts where it did");
  assert.ok(hits[hits.length - 1] < 667, "…and ends where it did");
  // 8 chunks of ~41 bytes, alternating: about half the extent survives.
  assert.ok(Math.abs(hits.length - 167) <= 2, `half the extent, chunked (${hits.length})`);
});

test("n-bristle: $Fn cuts the extent into 2^(n+1) chunks", () => {
  for (const [se, n] of [[0xf0, 2], [0xf1, 4], [0xf2, 8], [0xf3, 16], [0xf7, 256]]) {
    assert.equal(geomOf(se, { len: 4096 }).combN, n);
  }
  assert.equal(geomOf(0xfe, { len: 4096 }).combN, 32768, "$FE — 32768 bristles");
  // Finer than the extent is not an error: the chunks fall below a byte, so the
  // comb degrades into roughly-every-other-byte — half the extent, never more
  // than two bytes together. That is where the ladder is meant to end up.
  const hits = touchedOf(geomOf(0xfe, { len: 1000 }), false);
  assert.ok(Math.abs(hits.length - 500) < 25, `about half the extent (${hits.length})`);
  let run = 1, worst = 1;
  for (let k = 1; k < hits.length; k++) {
    run = hits[k] === hits[k - 1] + 1 ? run + 1 : 1;
    worst = Math.max(worst, run);
  }
  assert.equal(worst, 2, "…in ones and twos, not in runs");
});

test("the comb is relative to the loop region too", () => {
  const g = geomOf(0xf0, { len: 1000, ls: 200, le: 600 });
  const hits = touchedOf(g, false);
  assert.deepEqual([hits[0], hits[hits.length - 1], hits.length], [200, 399, 200],
    "the first half OF THE LOOP");
});

// The JVM twin (tsvm devtests/webconf/SampleModTest.java) prints the same
// checksum over the same sweep: rounding is the classic port hazard here
// (Math.round on a .5 boundary, integer vs double division), so every argument
// is decoded AND resolved against a spread of geometries and reduced to ONE
// number the two engines can be compared on.
test("region decode + resolve: the whole $se space matches the JVM engine", () => {
  let h = 0xcbf29ce484222325n;
  const MASK = (1n << 64n) - 1n;
  const bite = (v) => { h = ((h ^ (BigInt(v) & 0xffffffffn)) * 1099511628211n) & MASK; };
  const g = new ModGeom();
  const view = {
    modFrom: 0, modTo: 1, modCombBits: -1, modCombOdd: false, modInvert: false, modEpoch: 0,
  };
  for (const [len, ls, le] of [
    [2, 0, 0], [3, 0, 3], [1000, 0, 0], [1000, 100, 900], [999, 0, 999],
    [4095, 1000, 3000], [65535, 0, 0], [1048577, 7, 1048577],
  ]) {
    for (let se = 0; se < 256; se++) {
      for (const invert of [false, true]) {
        const code = decodeSampleRegion(se, out);
        bite(code);
        if (code === REGION_NONE) continue;
        // A comb keeps the standing extent; anything else replaces it solid.
        view.modFrom = 0; view.modTo = 1;
        view.modCombBits = -1; view.modCombOdd = false;
        if (code === REGION_COMB) {
          view.modCombBits = out[2]; view.modCombOdd = out[3] !== 0;
        } else {
          view.modFrom = out[0]; view.modTo = out[1];
        }
        view.modInvert = invert;
        view.modEpoch++;
        resolveModGeom(g, view, ls, le, len);
        for (const v of [g.es, g.ee, g.combN, g.combOdd ? 1 : 0, g.live ? 1 : 0, g.ds, g.dl]) bite(v);
      }
    }
  }
  assert.equal(h.toString(16), "e53e629f4d780104",
    "region decode must agree with SampleModTest's REGION-DECODE-CHECKSUM");
});

// ── engine legs ──────────────────────────────────────────────────────────────

/** Engine with a 1000-byte ramp sample in slot 1, looping over `[ls, le)`
 *  (whole-sample by default, so byte offsets read straight off the argument). */
function makeEngine(ls = 0, le = 1000) {
  const eng = new TaudEngine();
  for (let i = 0; i < 1000; i++) eng.sampleBin[i] = i & 0xff;
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 1000);   // sampleLength
  w16(6, 32000);  // samplingRate @C4
  w16(10, ls);    // loopStart
  w16(12, le);    // loopEnd
  rec[14] = 1;    // forward loop
  rec[21] = 0x3f; // vol env node 0 = full
  rec[171] = 255;
  rec[196] = 255;
  eng.uploadInstrument(1, rec);
  return eng;
}

// One tick is 640 samples at 125 BPM / 32 kHz; a 6-tick row is 3840, and row
// r's first tick lands exactly on sample r·ROW — so rendering ROW leaves the
// playhead ON the next row, and ROW − TICK inside the current one.
const TICK = 640;
const ROW = 6 * TICK;

/**
 * Row 0 sounds C4 on instrument 1; `rows` gives each row's [effect, arg] in
 * turn (later rows carry no note, so the voice plays on under them).
 */
function loadRows(eng, rows) {
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  pat[0] = 0x00; pat[1] = 0x50;
  pat[2] = 1;
  rows.forEach(([effect, arg], r) => {
    pat[r * 8 + 5] = effect;
    pat[r * 8 + 6] = arg & 0xff;
    pat[r * 8 + 7] = (arg >> 8) & 0xff;
  });
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0x00; cue[1] = 0x00;
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125);
  eng.setTickRate(0, 6);
  eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0);
  eng.play(0);
}

function render(eng, samples) {
  const buf = new Uint8Array(TRACKER_CHUNK * 2);
  for (let i = 0; i < Math.ceil(samples / TRACKER_CHUNK); i++) eng.renderChunk(0, buf);
}

/**
 * Render `samples`, then one chunk more so the anti-click crossfade (item
 * 153.5) has run out and a read is the new mapping alone. A tick lands on the
 * LAST sample of a whole row, so without this every byte read after one is a
 * blend of the mapping before it and the mapping after.
 */
function renderSettled(eng, samples) {
  render(eng, samples);
  render(eng, MOD_XFADE_SAMPLES);
}

/** The byte the mixer would read at `i`, back in U8. */
const rawOf = (eng, voice, inst) => (i) =>
  Math.round(readSamplePoint(eng, voice, inst, i, 1000, 1 << 23) * 127.5 + 127.5);

test("notefx 3 confines its operation to the region it names", () => {
  const eng = makeEngine();
  loadRows(eng, [[0x03, 0x311f]]); // 3 $311F — middle third, INVERT, every tick
  render(eng, ROW);
  const inst = eng.instruments[1];
  assert.equal(inst.modFrom, 1 / 3, "region start = a third in");
  assert.equal(inst.modTo, 2 / 3);
  assert.equal(inst.modOp, 1, "operation 1 is INVERT");
  assert.equal(inst.modInvert, false, "notefx 3 modifies the region it names");
  assert.ok(inst.modMask !== null, "the walk must have flipped something");

  const voice = eng.playheads[0].trackerState.voices[0];
  assert.deepEqual([voice.modGeom.es, voice.modGeom.ee], [333, 667]);
  const raw = rawOf(eng, voice, inst);
  for (const i of [0, 100, 332, 667, 999]) {
    assert.equal(raw(i), i & 0xff, `byte ${i} is outside the region and must be untouched`);
  }
  let flipped = 0;
  for (let i = 333; i < 667; i++) if (raw(i) !== (i & 0xff)) flipped++;
  assert.equal(flipped, 6, "one byte per tick, six ticks to the row");
});

test("notefx 2 is the same command with the region inverted", () => {
  const eng = makeEngine();
  loadRows(eng, [[0x02, 0x311f]]); // 2 $311F — invert EVERYTHING BUT the middle third
  render(eng, ROW);
  const inst = eng.instruments[1];
  assert.equal(inst.modInvert, true);
  assert.equal(inst.modFrom, 1 / 3, "the region it names is the one it spares");
  assert.equal(inst.modTo, 2 / 3);

  const voice = eng.playheads[0].trackerState.voices[0];
  const raw = rawOf(eng, voice, inst);
  for (let i = 333; i < 667; i++) {
    assert.equal(raw(i), i & 0xff, `byte ${i} is inside the spared region`);
  }
  let flipped = 0;
  for (let i = 0; i < 1000; i++) if (raw(i) !== (i & 0xff)) flipped++;
  assert.ok(flipped > 0, "…and the rest of the sample carries the inversion");
});

test("the region follows the voice's own loop", () => {
  // The same argument on a sample looping over [200, 600) names the middle
  // third OF THE LOOP — item 153's whole point.
  const eng = makeEngine(200, 600);
  loadRows(eng, [[0x03, 0x311f]]);
  render(eng, ROW);
  const inst = eng.instruments[1];
  const voice = eng.playheads[0].trackerState.voices[0];
  assert.deepEqual([voice.modGeom.es, voice.modGeom.ee], [333, 467]);
  const raw = rawOf(eng, voice, inst);
  for (const i of [0, 199, 332, 467, 700, 999]) {
    assert.equal(raw(i), i & 0xff, `byte ${i} is outside the region`);
  }
  let flipped = 0;
  for (let i = 333; i < 467; i++) if (raw(i) !== (i & 0xff)) flipped++;
  assert.equal(flipped, 6);
});

test("$x = 0 resets the modification, region and all", () => {
  const eng = makeEngine();
  loadRows(eng, [[0x03, 0x311f], [0x03, 0x3100]]);
  render(eng, ROW - TICK);
  assert.ok(eng.instruments[1].modMask !== null);
  render(eng, TICK); // …into row 1's reset
  const inst = eng.instruments[1];
  assert.equal(inst.modMask, null, "reset clears what the operation accumulated");
  assert.equal(inst.modOp, 0);
  assert.equal(inst.modFrom, 0, "…and hands the region back to the whole domain");
  assert.equal(inst.modTo, 1);
  assert.equal(inst.modCombBits, -1);
  assert.equal(inst.modOn, false);
  assert.equal(eng.playheads[0].trackerState.voices[0].modPeriod, 0);
});

test("re-stating the same command does not restart the walk", () => {
  const eng = makeEngine();
  // Both rows carry the SAME argument: the walk must continue across them.
  loadRows(eng, [[0x03, 0x0f1f], [0x03, 0x0f1f]]); // whole sample, INVERT, one flip/tick
  render(eng, ROW);
  const after = eng.playheads[0].trackerState.voices[0].modWritePos;
  assert.ok(after > 1, `write pos must have walked (was ${after})`);
  render(eng, ROW);
  assert.ok(eng.playheads[0].trackerState.voices[0].modWritePos > after,
    "a repeated identical command must not reset the write position");
});

test("$y is a tick period: $F every tick, $8 every eighth, $1 every fifteenth", () => {
  // INVERT flips one byte per step, so the mask's popcount IS the step count.
  const bitsSet = (eng) => {
    const mask = eng.instruments[1].modMask;
    let n = 0;
    if (mask) for (const b of mask) for (let k = 0; k < 8; k++) if ((b >> k) & 1) n++;
    return n;
  };
  for (const [y, ticks] of [[0xf, 24], [0xe, 12], [0xc, 6], [0x8, 3], [0x1, 1]]) {
    const eng = makeEngine();
    loadRows(eng, [[0x03, 0x0f10 | y]]);
    render(eng, 4 * ROW); // 24 ticks
    assert.equal(bitsSet(eng), ticks,
      `$y = ${y.toString(16)} steps every ${16 - y} ticks`);
    assert.equal(eng.playheads[0].trackerState.voices[0].modPeriod, 16 - y);
  }
});

test("$y = 0 freezes the modification without discarding it", () => {
  const eng = makeEngine();
  loadRows(eng, [[0x03, 0x0f5f], [0x03, 0x0f50]]); // ROL8 at speed, then frozen
  render(eng, ROW); // row 0's six steps, then row 1 freezes the clock
  const inst = eng.instruments[1];
  const held = inst.modRot;
  assert.equal(held, 48, "six ticks of eight bytes");
  render(eng, 3 * ROW);
  assert.equal(eng.playheads[0].trackerState.voices[0].modPeriod, 0);
  assert.equal(inst.modRot, held, "frozen keeps what it had");
  assert.equal(inst.modOn, true);
});

test("ROL rotates the region left by its own step, wrapping inside it", () => {
  const eng = makeEngine();
  loadRows(eng, [[0x03, 0x214f]]); // 3 $214F — last two thirds, ROL4, every tick
  renderSettled(eng, ROW);
  const inst = eng.instruments[1];
  assert.equal(inst.modOp, 4, "operation 4 is ROL4");
  assert.equal(inst.modRot, 24, "six ticks of four bytes");
  assert.ok(inst.modOn);

  const voice = eng.playheads[0].trackerState.voices[0];
  assert.deepEqual([voice.modGeom.es, voice.modGeom.ee], [333, 1000]);
  const raw = rawOf(eng, voice, inst);
  for (const i of [0, 100, 332]) {
    assert.equal(raw(i), i & 0xff, `byte ${i} sits outside the region`);
  }
  const span = 1000 - 333;
  const src = 333 + (((400 - 333 + inst.modRot) % span) + span) % span;
  assert.equal(raw(400), src & 0xff, "a byte inside the region reads from its rotated source");
});

test("SUB slides the region's level, wrapping through zero", () => {
  const eng = makeEngine();
  loadRows(eng, [[0x03, 0x0f8f]]); // 3 $0F8F — whole sample, SUB32, every tick
  renderSettled(eng, ROW);
  const inst = eng.instruments[1];
  assert.equal(inst.modOp, 8, "operation 8 is SUB32");
  assert.equal(inst.modSub, (6 * 32) & 0xff, "…and it moves 32 a tick");
  assert.ok(inst.modOn);

  const voice = eng.playheads[0].trackerState.voices[0];
  const raw = rawOf(eng, voice, inst);
  for (const i of [0, 1, 300, 999]) {
    assert.equal(raw(i), ((i & 0xff) - inst.modSub) & 0xff,
      `byte ${i} is the sample byte less the running subtrahend, wrapped`);
  }
});

test("SUB wraps: 128 twice over is the sample back again", () => {
  const eng = makeEngine();
  // $y = 8 is a step every 8 ticks (5120 samples).
  loadRows(eng, [[0x03, 0x0f98]]); // whole sample, SUB128, every 8th tick
  renderSettled(eng, 5632); // one step: past tick 8, before tick 16
  const inst = eng.instruments[1];
  assert.equal(inst.modSub, 128);
  const voice = eng.playheads[0].trackerState.voices[0];
  const raw = rawOf(eng, voice, inst);
  assert.equal(raw(10), (10 - 128) & 0xff);
  renderSettled(eng, 5632); // …the second lands back on zero
  assert.equal(inst.modSub, 0);
  assert.equal(inst.modOn, false, "a modification that changes nothing costs nothing to read");
  assert.equal(raw(10), 10);
});

test("a reserved region is ignored whole — speed included", () => {
  for (const [name, arg] of [["region $54", 0x548f], ["region $A9", 0xa98f]]) {
    const eng = makeEngine();
    loadRows(eng, [[0x03, arg]]);
    render(eng, ROW);
    assert.equal(eng.playheads[0].trackerState.voices[0].modPeriod, 0,
      `${name} must not arm the clock either`);
    assert.equal(eng.instruments[1].modOp, 0, `${name} must not select an operation`);
  }
});

test("S $Fxxx is untouched by any of it", () => {
  const eng = makeEngine();
  loadRows(eng, [[0x1c, 0xf040]]); // S $F040
  render(eng, ROW);
  const inst = eng.instruments[1];
  assert.ok(inst.invertMask !== null, "the legacy invert loop still walks the loop");
  assert.equal(inst.modOp, 0, "…and never touches the notefx 2/3 modification");
  assert.equal(inst.modCombBits, -1);
});

test("resetSampleFxState clears the modification and the legacy mask alike", () => {
  const eng = makeEngine();
  loadRows(eng, [[0x03, 0x0f1f]]);
  render(eng, ROW);
  assert.ok(eng.instruments[1].modMask !== null);
  eng.resetSampleFxState(0);
  const inst = eng.instruments[1];
  assert.equal(inst.invertMask, null);
  assert.equal(inst.modMask, null);
  assert.equal(inst.modOp, 0);
  assert.equal(inst.modFrom, 0);
  assert.equal(inst.modTo, 1);
  assert.equal(inst.modOn, false);
  const v = eng.playheads[0].trackerState.voices[0];
  assert.equal(v.invertSpeed, 0);
  assert.equal(v.modPeriod, 0);
  assert.equal(v.modWritePos, 0);
  assert.equal(v.modXfade, 0);
});

// ── the scatter ladder ($D $E $F) ────────────────────────────────────────────
//
// SHUFFLE: every byte of the region is displaced on its own, each by its own
// UNIFORM draw within 1/512, 1/64 or 1/8 of the wrap domain. Not the region
// moved as a block — that is what $2..$5 and the jumps are for.

/** How far byte `i` travelled, the short way round a domain of `dl`. */
const travel = (i, src, dl) => {
  const d = ((src - i) % dl + dl) % dl;
  return d > dl / 2 ? d - dl : d;
};

/** rot as a SIGNED displacement: the short way round the wrap domain. */
const signedRot = (rot, dl) => (rot > dl / 2 ? rot - dl : rot);

test("scatterReach: the fraction of the domain each byte may be thrown", () => {
  assert.equal(scatterReach(0xd, 1000), 2, "$D — a 512th, rounded");
  assert.equal(scatterReach(0xe, 1000), 16);
  assert.equal(scatterReach(0xf, 1000), 125, "$F — an eighth, the widest there is");
  assert.deepEqual([0xd, 0xe, 0xf].map((op) => scatterReach(op, 65536)), [128, 1024, 8192]);
  // A reach never rounds down to nothing: the narrowest setting on the shortest
  // domain still moves a byte.
  assert.equal(scatterReach(0xd, 100), 1);
  // Degenerate domains cannot displace anything.
  for (const dl of [0, 1]) {
    for (let op = MOD_RND512; op <= MOD_RND8; op++) assert.equal(scatterReach(op, dl), 0);
  }
});

test("scatterSource: every byte gets its OWN throw, inside the reach", () => {
  const dl = 4096;
  const seed = 0x12345678;
  for (const op of [0xd, 0xe, 0xf]) {
    const reach = scatterReach(op, dl);
    const seen = new Set();
    let moved = 0;
    for (let i = 0; i < dl; i++) {
      const src = scatterSource(i, 0, dl, reach, seed);
      assert.ok(src >= 0 && src < dl, "the source stays inside the domain");
      const d = travel(i, src, dl);
      assert.ok(Math.abs(d) <= reach, `byte ${i} moved ${d}, past ±${reach}`);
      seen.add(d);
      if (d !== 0) moved++;
    }
    assert.ok(seen.size >= Math.min(2 * reach + 1, 64),
      `op $${op.toString(16)}: the throws differ per byte (${seen.size} distinct)`);
    // Every byte draws its own offset out of 2·reach+1, so only the 1-in-that
    // many that draw zero stay put.
    assert.ok(moved > dl * (1 - 1.5 / (2 * reach + 1)),
      `op $${op.toString(16)}: nearly every byte moves — a shuffle, not a rotation (${moved})`);
  }
});

test("the throw is UNIFORM: every distance inside the reach is as likely", () => {
  // $F on a big domain — the widest reach there is, and still only an eighth of
  // it, so nothing folds round the wrap and travel() measures the draw itself.
  // A bell was tried here (item 153.2) and reverted: leaving most bytes at home
  // and flinging a few reads as noise under the sample, not as the sample
  // breaking up (item 153.10).
  const dl = 20000;
  const reach = scatterReach(MOD_RND8, dl);
  let sum = 0, sumsq = 0, far = 0;
  for (let i = 0; i < dl; i++) {
    const d = travel(i, scatterSource(i, 0, dl, reach, 0x5eed), dl);
    sum += d;
    sumsq += d * d;
    if (Math.abs(d) > reach / 3) far++;
  }
  const mean = sum / dl;
  const sd = Math.sqrt(sumsq / dl - mean * mean);
  const flat = reach / Math.sqrt(3);   // sd of a flat draw over ±reach
  assert.ok(Math.abs(mean) < reach * 0.02, `the draw is centred on home (mean ${mean.toFixed(1)})`);
  assert.ok(Math.abs(sd - flat) < reach * 0.03,
    `flat, not belled (sd ${sd.toFixed(1)} vs ${flat.toFixed(1)}; a 3-sigma bell would read ${(reach / 3).toFixed(1)})`);
  // Two bytes in three land past a third of the reach — the flat draw's answer.
  // A bell would put well under half of them there.
  assert.ok(far / dl > 0.6 && far / dl < 0.72,
    `two thirds of the bytes are past reach/3 (${(far / dl).toFixed(2)})`);
});

test("scatterSource is NOT a rotation: neighbours do not keep their spacing", () => {
  const dl = 1000, reach = scatterReach(0xf, dl), seed = 99;
  let sameDelta = 0;
  let prev = travel(0, scatterSource(0, 0, dl, reach, seed), dl);
  for (let i = 1; i < dl; i++) {
    const d = travel(i, scatterSource(i, 0, dl, reach, seed), dl);
    if (d === prev) sameDelta++;
    prev = d;
  }
  assert.ok(sameDelta < dl / 20, `adjacent bytes rarely share a throw (${sameDelta}/${dl - 1})`);
});

test("scatterSource is stable within a step and different across steps", () => {
  const dl = 1000, reach = scatterReach(0xf, dl);
  // Stable: an output sample reads the same position through every sinc tap.
  for (let i = 0; i < 50; i++) {
    assert.equal(scatterSource(i, 0, dl, reach, 7), scatterSource(i, 0, dl, reach, 7));
  }
  let differs = 0;
  for (let i = 0; i < dl; i++) {
    if (scatterSource(i, 0, dl, reach, 7) !== scatterSource(i, 0, dl, reach, 8)) differs++;
  }
  assert.ok(differs > dl * 0.9, "a new seed is a new scramble");
});

test("scatterSource wraps inside a region rather than leaving it", () => {
  const start = 300, dl = 200, reach = scatterReach(0xf, dl);
  for (let i = start; i < start + dl; i++) {
    const src = scatterSource(i, start, dl, reach, 0xabcdef);
    assert.ok(src >= start && src < start + dl, `byte ${i} left the region (${src})`);
  }
});

test("$F reaches an eighth of the domain, $D barely leaves home", () => {
  const dl = 4096;
  const spread = (op) => {
    let far = 0;
    const reach = scatterReach(op, dl);
    for (let i = 0; i < dl; i++) {
      far = Math.max(far, Math.abs(travel(i, scatterSource(i, 0, dl, reach, 55), dl)));
    }
    return far;
  };
  assert.equal(spread(0xd), 8, "$D — a 512th of 4096, and it uses all of it");
  assert.equal(spread(0xf), 512, "$F — an eighth, the end of the ladder");
});

test("notefx 3 $D..$F scramble the region byte by byte, and keep scrambling", () => {
  try {
    setRandomSource(makeSeededRandom(7));
    for (const [op, frac] of [[0xd, 1 / 512], [0xe, 1 / 64], [0xf, 1 / 8]]) {
      const eng = makeEngine();
      loadRows(eng, [[0x03, 0x0f00 | (op << 4) | 0xf]]); // 3 $0F{op}F — whole sample, every tick
      const inst = eng.instruments[1];
      const reach = Math.round(1000 * frac);
      const seeds = new Set();
      // 40 rows is 240 steps: nothing accumulates, so every byte is still
      // measured from where it belongs at the end of it.
      for (let r = 0; r < 40; r++) {
        render(eng, ROW);
        assert.equal(inst.modOp, op);
        assert.equal(inst.modScatter, reach, `op $${op.toString(16)} reach`);
        assert.equal(inst.modRot, 0, "a scatter is not a rotation");
        seeds.add(inst.modSeed);
        for (let i = 0; i < 1000; i += 37) {
          const src = scatterSource(i, 0, 1000, inst.modScatter, inst.modSeed);
          assert.ok(Math.abs(travel(i, src, 1000)) <= reach,
            `op $${op.toString(16)}: byte ${i} stayed within ${reach} of home`);
        }
      }
      assert.ok(seeds.size > 30, "each step is a fresh scramble");
    }
  } finally {
    setRandomSource(null);
  }
});

test("a scatter really moves which byte is read, per byte", () => {
  try {
    setRandomSource(makeSeededRandom(99));
    const eng = makeEngine();
    loadRows(eng, [[0x03, 0x0fef]]); // 3 $0FEF — whole sample, 1/64 scatter, every tick
    renderSettled(eng, ROW);
    const inst = eng.instruments[1];
    assert.ok(inst.modOn, "the scramble is live");
    assert.equal(inst.modSub, 0, "a scatter is an address transform, not a level one");
    assert.equal(inst.modMask, null, "…and keeps no inversion mask");
    const voice = eng.playheads[0].trackerState.voices[0];
    assert.equal(voice.modXfade, 0, "the crossfade has run out");
    const raw = rawOf(eng, voice, inst);
    let moved = 0;
    for (let i = 0; i < 1000; i++) {
      const src = scatterSource(i, 0, 1000, inst.modScatter, inst.modSeed);
      assert.equal(raw(i), src & 0xff, `byte ${i} is read from its own displaced position`);
      if (src !== i) moved++;
    }
    assert.ok(moved > 900, "the whole region is shuffled, not shifted");
  } finally {
    setRandomSource(null);
  }
});

test("notefx 2 scatters everything BUT the region it names", () => {
  try {
    setRandomSource(makeSeededRandom(11));
    const eng = makeEngine();
    loadRows(eng, [[0x02, 0x31ef]]); // 2 $31EF — spare the middle third, scatter the rest
    renderSettled(eng, ROW);
    const inst = eng.instruments[1];
    assert.equal(inst.modInvert, true);
    assert.ok(inst.modScatter > 0);
    const voice = eng.playheads[0].trackerState.voices[0];
    const raw = rawOf(eng, voice, inst);
    for (const i of [400, 500, 600]) assert.equal(raw(i), i & 0xff, `byte ${i} is spared`);
    let moved = 0;
    for (let i = 0; i < 333; i++) if (raw(i) !== (i & 0xff)) moved++;
    assert.ok(moved > 250, "the region OUTSIDE the named third is scrambled");
  } finally {
    setRandomSource(null);
  }
});

test("switching from a rotate to a scatter discards the rotation", () => {
  try {
    setRandomSource(makeSeededRandom(3));
    const eng = makeEngine();
    loadRows(eng, [[0x03, 0x0f5f], [0x03, 0x0fdf]]); // ROL8 for a row, then scatter
    render(eng, ROW - TICK);
    const inst = eng.instruments[1];
    assert.equal(inst.modOp, 5);
    assert.ok(inst.modRot > 0, "the rotate accumulated");
    assert.equal(inst.modScatter, 0);
    render(eng, TICK + 1); // into row 1: the operation changes
    assert.equal(inst.modOp, 0xd);
    assert.equal(inst.modRot, 0, "the ROL's offset is gone, not scattered from");
    assert.equal(inst.modPrevRot, 0, "…and there is nothing left to fade back to");
    render(eng, TICK); // …and the first scatter step lands
    assert.equal(inst.modScatter, 2, "$D throws each byte a 512th of the domain");
  } finally {
    setRandomSource(null);
  }
});

test("$x = 0 clears the scatter with everything else", () => {
  try {
    setRandomSource(makeSeededRandom(5));
    const eng = makeEngine();
    loadRows(eng, [[0x03, 0x0fff], [0x03, 0x0f0f]]);
    render(eng, ROW - TICK);
    assert.ok(eng.instruments[1].modScatter > 0);
    render(eng, TICK + 1);
    const inst = eng.instruments[1];
    assert.equal(inst.modOp, 0);
    assert.equal(inst.modScatter, 0);
    assert.equal(inst.modSeed, 0);
    assert.equal(inst.modOn, false);
  } finally {
    setRandomSource(null);
  }
});

// ── the jump family ($A $B $C) ───────────────────────────────────────────────
//
// The scatter ladder's other half: one draw moves the WHOLE region, so the
// waveform survives intact and lands somewhere else. Same read transform the
// ROLs use — a rotation whose step is thrown rather than fixed. $A and $B
// quantise the throw to eighths and sixteenths of the domain; $C is free.

test("$A lands only on eighths of the domain, and on all eight of them", () => {
  const dl = 1000;
  const slice = dl / MOD_JUMP_SLICES[0];
  try {
    setRandomSource(makeSeededRandom(0xbeef));
    const seen = new Set();
    for (let n = 0; n < 4000; n++) {
      const d = jumpRot(MOD_JUMP8, dl);
      assert.equal(d % slice, 0, `$A: ${d} is not a whole slice of ${slice}`);
      seen.add(d);
    }
    assert.deepEqual([...seen].sort((a, b) => a - b),
      [0, 125, 250, 375, 500, 625, 750, 875], "every slice is reachable, home included");
  } finally {
    setRandomSource(null);
  }
});

test("$B is the same throw at sixteenths — the finer grid, same reach", () => {
  const dl = 1024;
  try {
    setRandomSource(makeSeededRandom(0xb16));
    const seen = new Set();
    for (let n = 0; n < 6000; n++) {
      const d = jumpRot(MOD_JUMP16, dl);
      assert.equal(d % 64, 0, `$B: ${d} is not a whole sixteenth of ${dl}`);
      seen.add(d);
    }
    assert.equal(seen.size, 16, "all sixteen slices are reachable, home included");
    assert.equal(Math.max(...seen), 960, "…up to the last one");
    // The two spellings differ ONLY in grain: every eighth is also a
    // sixteenth, so $A's outcomes are a subset of $B's.
    for (let n = 0; n < 2000; n++) assert.equal(jumpRot(MOD_JUMP8, dl) % 128, 0);
  } finally {
    setRandomSource(null);
  }
});

test("$A reaches the whole domain — it is quantised, not narrowed", () => {
  const dl = 1000;
  try {
    setRandomSource(makeSeededRandom(1234));
    let far = 0;
    for (let n = 0; n < 4000; n++) far = Math.max(far, Math.abs(signedRot(jumpRot(MOD_JUMP8, dl), dl)));
    assert.ok(far >= 500, `$A reaches the far side of the domain (${far})`);
  } finally {
    setRandomSource(null);
  }
});

test("$C is the free throw: anywhere, off both slice grids", () => {
  const dl = 1000;
  const slice = dl / MOD_JUMP_SLICES[1];
  try {
    setRandomSource(makeSeededRandom(0xf00d));
    let far = 0, offGrid = 0;
    for (let n = 0; n < 4000; n++) {
      const d = jumpRot(MOD_JUMP_ALL, dl);
      far = Math.max(far, Math.abs(signedRot(d, dl)));
      if (d % slice !== 0) offGrid++;
    }
    assert.ok(far > dl * 0.45, "$C draws from the whole domain");
    assert.ok(offGrid > 3700, "…and is not even on the sixteenth grid");
  } finally {
    setRandomSource(null);
  }
});

test("$A slices a domain that does not divide by eight without drifting", () => {
  // 1007 / 8 = 125.875 → a rounded slice of 126; truncating would put the last
  // slice 7 bytes short of where the eighth boundary really is.
  const dl = 1007;
  try {
    setRandomSource(makeSeededRandom(5));
    const seen = new Set();
    for (let n = 0; n < 2000; n++) {
      const d = jumpRot(MOD_JUMP8, dl);
      assert.ok(d >= 0 && d < dl, `${d} stays inside the domain`);
      assert.equal(d % 126, 0);
      seen.add(d);
    }
    assert.equal(seen.size, 8);
  } finally {
    setRandomSource(null);
  }
});

test("jumpRot is safe on a domain too short to displace", () => {
  for (const dl of [0, 1]) {
    for (const op of [MOD_JUMP8, MOD_JUMP16, MOD_JUMP_ALL]) assert.equal(jumpRot(op, dl), 0);
  }
});

test("notefx 3 $A/$B/$C move the whole region, leaving the waveform intact", () => {
  try {
    setRandomSource(makeSeededRandom(21));
    for (const op of [0xa, 0xb, 0xc]) {
      const eng = makeEngine();
      loadRows(eng, [[0x03, 0x0f00 | (op << 4) | 0xf]]); // 3 $0F{op}F
      renderSettled(eng, ROW);
      const inst = eng.instruments[1];
      assert.equal(inst.modOp, op);
      assert.equal(inst.modScatter, 0, "a jump is not a shuffle");
      // $A can draw slice 0 — landing at home is one of its eight outcomes, and
      // the guard has to agree with the offset rather than assume it moved.
      assert.equal(inst.modOn, inst.modRot !== 0);
      const voice = eng.playheads[0].trackerState.voices[0];
      const raw = rawOf(eng, voice, inst);
      // EVERY byte moves by the SAME offset — that is what keeps the sound.
      for (let i = 0; i < 1000; i++) {
        assert.equal(raw(i), (i + inst.modRot) % 1000 & 0xff,
          `op $${op.toString(16)}: byte ${i} follows the one offset`);
      }
    }
  } finally {
    setRandomSource(null);
  }
});

test("$A quantises to eighths of the LOOP, not of the file", () => {
  try {
    setRandomSource(makeSeededRandom(0xa11));
    const eng = makeEngine(200, 600); // a 400-byte loop: slices of 50
    loadRows(eng, [[0x03, 0x0faf]]);
    const inst = eng.instruments[1];
    for (let r = 0; r < 20; r++) {
      render(eng, ROW);
      assert.equal(inst.modRot % 50, 0, `${inst.modRot} is a whole eighth of the loop`);
      assert.ok(inst.modRot < 400);
    }
  } finally {
    setRandomSource(null);
  }
});

test("$A stays on the slice grid however long it runs", () => {
  try {
    setRandomSource(makeSeededRandom(4));
    const eng = makeEngine();
    loadRows(eng, [[0x03, 0x0faf]]); // 3 $0FAF — whole sample, sliced jump, every tick
    const inst = eng.instruments[1];
    const seen = new Set();
    for (let r = 0; r < 40; r++) {
      render(eng, ROW);
      assert.equal(inst.modRot % 125, 0,
        "every throw is measured from home in whole slices, not added to the last");
      seen.add(inst.modRot);
    }
    assert.ok(seen.size >= 6, `and it really is a fresh throw each step (${seen.size} of 8 slices)`);
  } finally {
    setRandomSource(null);
  }
});

test("a jump and a scatter replace each other cleanly", () => {
  try {
    setRandomSource(makeSeededRandom(6));
    const eng = makeEngine();
    loadRows(eng, [[0x03, 0x0fcf], [0x03, 0x0fff]]); // $C then $F
    render(eng, ROW - TICK);
    const inst = eng.instruments[1];
    assert.equal(inst.modOp, 0xc);
    assert.equal(inst.modScatter, 0);
    render(eng, TICK + 1);
    assert.equal(inst.modOp, 0xf);
    assert.equal(inst.modRot, 0, "the jump's offset is discarded");
    render(eng, TICK);
    assert.equal(inst.modScatter, 125, "…and the scatter takes over");
  } finally {
    setRandomSource(null);
  }
});

// ── the anti-click crossfade (item 153.5) ────────────────────────────────────

test("a step crossfades out of the mapping it replaced", () => {
  try {
    setRandomSource(makeSeededRandom(0xc1c1));
    const eng = makeEngine();
    loadRows(eng, [[0x03, 0x0f5f]]); // ROL8 every tick — a known 8-byte step
    render(eng, TICK);              // tick 1's step has just landed
    const inst = eng.instruments[1];
    const voice = eng.playheads[0].trackerState.voices[0];
    assert.ok(voice.modXfade > 0, "the fade is armed by the step");
    assert.equal(inst.modRot - inst.modPrevRot, 8, "…and it fades out of the previous offset");
    // Mid-fade a read is a genuine BLEND of the two mappings, so it need not
    // equal either byte.
    const w = voice.modXfade / MOD_XFADE_SAMPLES;
    const mixed = readSamplePoint(eng, voice, inst, 400, 1000, 1 << 23) * 127.5 + 127.5;
    const now = (400 + inst.modRot) % 1000 & 0xff;
    const then = (400 + inst.modPrevRot) % 1000 & 0xff;
    assert.ok(Math.abs(mixed - (then * w + now * (1 - w))) < 1e-6,
      `the read is the crossfade of both mappings (${mixed})`);
    assert.ok(w > 0 && w < 1);
  } finally {
    setRandomSource(null);
  }
});

test("the crossfade runs on the output clock and is over in 2 ms", () => {
  const eng = makeEngine();
  loadRows(eng, [[0x03, 0x0f5f]]);
  render(eng, TICK);
  const voice = eng.playheads[0].trackerState.voices[0];
  const armed = voice.modXfade;
  assert.ok(armed > 0 && armed <= MOD_XFADE_SAMPLES);
  render(eng, MOD_XFADE_SAMPLES * 2);
  assert.equal(voice.modXfade, 0, "…and then the new mapping stands alone");
  const inst = eng.instruments[1];
  const raw = rawOf(eng, voice, inst);
  assert.equal(raw(400), (400 + inst.modRot) % 1000 & 0xff);
});

test("the crossfade actually flattens the step a jump would otherwise cut", () => {
  // The worst case: $B throws the whole region somewhere else every tick. Ask
  // the same voice for the same byte over the fade and the answer must WALK
  // from the old mapping to the new one rather than snap to it.
  try {
    setRandomSource(makeSeededRandom(0x9ee9));
    const eng = makeEngine();
    loadRows(eng, [[0x03, 0x0fbf]]);
    render(eng, TICK);
    const inst = eng.instruments[1];
    const voice = eng.playheads[0].trackerState.voices[0];
    const now = (400 + inst.modRot) % 1000 & 0xff;
    const then = (400 + inst.modPrevRot) % 1000 & 0xff;
    assert.notEqual(now, then, "the throw really did move this byte");
    // Walk the countdown by hand: the chunk clock is 128 samples and the whole
    // fade is 64, so rendering cannot sample it.
    let prev = null;
    for (let x = MOD_XFADE_SAMPLES; x >= 0; x--) {
      voice.modXfade = x;
      const v = readSamplePoint(eng, voice, inst, 400, 1000, 1 << 23) * 127.5 + 127.5;
      if (prev !== null) {
        assert.ok(Math.abs(v - now) <= Math.abs(prev - now) + 1e-9,
          `sample ${x} moved away from the new mapping (${prev} → ${v}, target ${now})`);
      }
      prev = v;
    }
    assert.ok(Math.abs(prev - now) < 1e-9, "…and arrives at it exactly");
  } finally {
    setRandomSource(null);
  }
});

test("INVERT steps do not arm a crossfade — one byte is not a discontinuity", () => {
  const eng = makeEngine();
  loadRows(eng, [[0x03, 0x0f1f]]);
  render(eng, TICK + 1);
  assert.equal(eng.playheads[0].trackerState.voices[0].modXfade, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// Argument extension (item 162): notefx 2/3 paired with `:`. Pure-function
// tests against the exports themselves — the wide-cell engine legs (J, O and
// a couple of $xuu ops driven through real rows) live in widecell.test.js,
// next to the rest of the Format-3-only machinery.
// ═══════════════════════════════════════════════════════════════════════════

test("fModTouches $0 is a no-op; $1/$2 keep the extent's own halves", () => {
  const es = 100, ee = 200; // a 100-byte extent
  for (let i = es; i < ee; i++) assert.ok(fModTouches(0x0, i, es, ee, 0));
  for (let i = es; i < ee; i++) {
    assert.equal(fModTouches(0x1, i, es, ee, 0), i < 150, `$1 (left half) at ${i}`);
    assert.equal(fModTouches(0x2, i, es, ee, 0), i >= 150, `$2 (right half) at ${i}`);
  }
});

test("fModTouches $4/$9 keep the leftmost/rightmost quarter", () => {
  const es = 0, ee = 400;
  assert.equal(fModTouches(0x4, 50, es, ee, 0), true);
  assert.equal(fModTouches(0x4, 150, es, ee, 0), false);
  assert.equal(fModTouches(0x9, 350, es, ee, 0), true);
  assert.equal(fModTouches(0x9, 150, es, ee, 0), false);
});

test("fModTouches $A/$B alternate halves with the step index; $C/$D alternate quarters", () => {
  const es = 0, ee = 400;
  // $A opens on the first half (step 0), flips to the second on step 1.
  assert.equal(fModTouches(0xa, 50, es, ee, 0), true);
  assert.equal(fModTouches(0xa, 350, es, ee, 0), false);
  assert.equal(fModTouches(0xa, 50, es, ee, 1), false);
  assert.equal(fModTouches(0xa, 350, es, ee, 1), true);
  // $B is $A's mirror image at every step.
  assert.equal(fModTouches(0xb, 50, es, ee, 0), fModTouches(0xa, 50, es, ee, 1));
  // $C opens on quarters 1+3 (chunks 0,2 of 4), $D on 2+4 (chunks 1,3).
  assert.equal(fModTouches(0xc, 50, es, ee, 0), true);   // chunk 0
  assert.equal(fModTouches(0xc, 150, es, ee, 0), false); // chunk 1
  assert.equal(fModTouches(0xc, 250, es, ee, 0), true);  // chunk 2
  assert.equal(fModTouches(0xc, 350, es, ee, 0), false); // chunk 3
  assert.equal(fModTouches(0xd, 50, es, ee, 0), false);
  assert.equal(fModTouches(0xd, 150, es, ee, 0), true);
});

test("fModTouches $E/$F are BYTE-granularity combs, independent of extent length", () => {
  const es = 0, ee = 1000; // wide extent — $E/$F must not scale with it
  const kept = (f) => {
    const out = [];
    for (let i = 0; i < 16; i++) if (fModTouches(f, i, es, ee, 0)) out.push(i);
    return out;
  };
  assert.deepEqual(kept(0xe), [0, 1, 2, 3, 8, 9, 10, 11], "4-of-every-8");
  assert.deepEqual(kept(0xf), [0, 2, 4, 6, 8, 10, 12, 14], "every other byte");
});

test("extModTouches ANDs the base region test with $f", () => {
  const g = new ModGeom();
  resolveModGeom(g, { modFrom: 0, modTo: 1, modCombBits: -1, modCombOdd: false, modEpoch: 1 }, 0, 0, 400);
  // Base region is the whole domain; $1 narrows it to the left half.
  assert.equal(extModTouches(g, false, 0x1, 0, 100), true);
  assert.equal(extModTouches(g, false, 0x1, 0, 300), false);
});

test("decodeExtOp: one representative per group, matching TAUD_NOTE_EFFECTS.md", () => {
  assert.deepEqual(decodeExtOp(0x000), { kind: "noop", param: 0 });
  assert.deepEqual(decodeExtOp(0x100), { kind: "noop", param: 0 });
  assert.deepEqual(decodeExtOp(0x101), { kind: "invert", param: 0 });
  assert.deepEqual(decodeExtOp(0x102), { kind: "funk", param: 0 });
  assert.deepEqual(decodeExtOp(0x103), { kind: "xor", param: 0xff }, "simply invert IS xor $FF");
  assert.deepEqual(decodeExtOp(0x104), { kind: "mirror", param: 0 });
  assert.deepEqual(decodeExtOp(0x11a), { kind: "invertJit", param: 0xa });
  assert.deepEqual(decodeExtOp(0x12f), { kind: "funkJit", param: 0xf });
  assert.deepEqual(decodeExtOp(0x135), decodeExtOp(0x145), "$13x and $14x fold together (see the doc note)");
  assert.equal(decodeExtOp(0x135).kind, "jumpN");
  assert.equal(decodeExtOp(0x135).param, EXT_JUMP_N[5]);
  assert.deepEqual(decodeExtOp(0x150), { kind: "jumpNBounded", param: EXT_JUMP_N[0] });
  assert.deepEqual(decodeExtOp(0x160), { kind: "swap", param: 0 });
  assert.deepEqual(decodeExtOp(0x168), { kind: "scatter", param: EXT_SCATTER_FRAC[8] });
  assert.deepEqual(decodeExtOp(0x2ff), { kind: "rol", param: 255 });
  assert.deepEqual(decodeExtOp(0x301), { kind: "rol", param: -1 }, "rotate-right is negative rol");
  assert.deepEqual(decodeExtOp(0x401), { kind: "rol", param: 256 });
  assert.deepEqual(decodeExtOp(0x501), { kind: "rol", param: -256 });
  assert.deepEqual(decodeExtOp(0x605), { kind: "sub", param: 5 });
  assert.deepEqual(decodeExtOp(0x705), { kind: "sub", param: -5 }, "add is negative sub");
  assert.deepEqual(decodeExtOp(0x8aa), { kind: "xor", param: 0xaa });
  assert.deepEqual(decodeExtOp(0x903), { kind: "bitrot", param: 3 });
  assert.deepEqual(decodeExtOp(0x913), { kind: "bitrot", param: -3 });
  assert.deepEqual(decodeExtOp(0x924), { kind: "bitperm", param: 4 });
  assert.deepEqual(decodeExtOp(0x999), { kind: "noop", param: 0 }, "reserved code");
});

test("EXT_JUMP_N is the documented 16-entry table", () => {
  assert.deepEqual([...EXT_JUMP_N], [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 16, 18, 21, 24, 32]);
});

test("extJitterFrac: 2^(x-15), 100% at $F", () => {
  assert.equal(extJitterFrac(0xf), 1);
  assert.equal(extJitterFrac(0x0), Math.pow(2, -15));
  assert.equal(extJitterFrac(0x7), Math.pow(2, -8));
});

test("EXT_SCATTER_FRAC: 16 levels, 1/16384 .. fully", () => {
  assert.equal(EXT_SCATTER_FRAC[0], 0);
  assert.equal(EXT_SCATTER_FRAC[1], 1 / 16384);
  assert.equal(EXT_SCATTER_FRAC[15], 1);
});

test("extYkPeriodTicks: $00 stops, the fine ladder is linear, $Fx is the coarse table", () => {
  assert.equal(extYkPeriodTicks(0x00), 0, "stop");
  assert.equal(extYkPeriodTicks(0x01), 1 / 16);
  assert.equal(extYkPeriodTicks(0x10), 1);
  assert.equal(extYkPeriodTicks(0x1f), 1 + 15 / 16);
  assert.equal(extYkPeriodTicks(0xe5), 14 + 5 / 16);
  const coarse = [15, 16, 18, 20, 22, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64];
  for (let k = 0; k < 16; k++) assert.equal(extYkPeriodTicks(0xf0 | k), coarse[k], `$F${k.toString(16)}`);
});

test("EXT_BITPERM_LUT matches the worked bit examples in TAUD_NOTE_EFFECTS.md", () => {
  // An independent, literal re-derivation of "abcdefgh" from the doc table,
  // for two asymmetric test bytes — deliberately NOT sharing code with
  // samplemod.js's own bit-twiddling implementation.
  const bitsOf = (byte) => Array.from({ length: 8 }, (_, i) => (byte >> (7 - i)) & 1); // [a..h]
  const fromBits = (bits) => bits.reduce((acc, b) => (acc << 1) | b, 0);
  const reorder = (byte, order) => { // order is a string like "hgfedcba"
    const bits = bitsOf(byte);
    const idx = { a: 0, b: 1, c: 2, d: 3, e: 4, f: 5, g: 6, h: 7 };
    return fromBits([...order].map((c) => bits[idx[c]]));
  };
  const expected = {
    0: (b) => b ^ 0xff,
    1: (b) => reorder(b, "hgfedcba"),
    2: (b) => reorder(b, "efghabcd"),
    3: (b) => reorder(b, "dcbahgfe"),
    4: (b) => reorder(b, "badcfehg"),
    5: (b) => reorder(b, "ghefcdab"),
    6: (b) => reorder(b, "fehgbadc"),
    7: (b) => reorder(b, "cdabghef"),
  };
  for (const testByte of [0xb4, 0x2d, 0x00, 0xff]) {
    for (let idx = 0; idx < 8; idx++) {
      assert.equal(EXT_BITPERM_LUT[idx][testByte], expected[idx](testByte),
        `permutation ${920 + idx} on 0x${testByte.toString(16)}`);
    }
  }
});

test("EXT_BITPERM_LUT permutations are involutions (applying one twice is identity)", () => {
  for (let idx = 0; idx < 8; idx++) {
    for (let b = 0; b < 256; b++) {
      assert.equal(EXT_BITPERM_LUT[idx][EXT_BITPERM_LUT[idx][b]], b);
    }
  }
});

test("bitRotate8: left/right, mod 8, and a no-op at amount 0", () => {
  assert.equal(bitRotate8(0b00000001, 1), 0b00000010);
  assert.equal(bitRotate8(0b10000000, 1), 0b00000001, "wraps");
  assert.equal(bitRotate8(0b00000001, -1), 0b10000000, "negative = right");
  assert.equal(bitRotate8(0b00000001, 8), 0b00000001, "a full turn is the identity");
  assert.equal(bitRotate8(0x5a, 0), 0x5a);
});

test("modAddressExt: swap pair takes priority, then mirror, then the classic rot/scatter fallback", () => {
  const g = new ModGeom();
  resolveModGeom(g, { modFrom: 0, modTo: 1, modCombBits: -1, modCombOdd: false, modEpoch: 1 }, 0, 0, 100);
  // swap
  const swapInst = { modExtSwapA: 10, modExtSwapB: 20, modExtMirror: false, modRot: 0, modScatter: 0, modSeed: 0 };
  assert.equal(modAddressExt(g, 10, swapInst), 20);
  assert.equal(modAddressExt(g, 20, swapInst), 10);
  assert.equal(modAddressExt(g, 15, swapInst), 15, "untouched byte passes through");
  // mirror
  const mirrorInst = { modExtSwapA: -1, modExtSwapB: -1, modExtMirror: true, modRot: 0, modScatter: 0, modSeed: 0 };
  assert.equal(modAddressExt(g, 0, mirrorInst), 99);
  assert.equal(modAddressExt(g, 99, mirrorInst), 0);
  // neither -> falls back to the classic address transform (rot)
  const rotInst = { modExtSwapA: -1, modExtSwapB: -1, modExtMirror: false, modRot: 5, modScatter: 0, modSeed: 0 };
  assert.equal(modAddressExt(g, 0, rotInst), 5);
});

test("applyExtLevel/applyExtLevelPrev: sub/add share modSub, xor its own, bit ops layer on top", () => {
  const inst = {
    modSub: 10, modXor: 0, modBitRot: 0, modBitPermOn: false, modBitPermIdx: 0,
    modPrevSub: 0, modPrevXor: 0,
  };
  assert.equal(applyExtLevel(inst, 50), (50 - 10) & 0xff);
  inst.modSub = 0; inst.modXor = 0xff;
  assert.equal(applyExtLevel(inst, 0x0f), 0xf0);
  inst.modXor = 0; inst.modBitRot = 1;
  assert.equal(applyExtLevel(inst, 0b00000001), 0b00000010);
  inst.modBitRot = 0; inst.modBitPermOn = true; inst.modBitPermIdx = 0; // NOT
  assert.equal(applyExtLevel(inst, 0x0f), 0xf0);
  inst.modBitPermOn = false;
  inst.modPrevSub = 5;
  assert.equal(applyExtLevelPrev(inst, 50), (50 - 5) & 0xff);
});

test("extended `:` in a narrow (Format 1/2) cell's single effect slot is a structural no-op", () => {
  const withColon = makeEngine();
  loadRows(withColon, [[EffectOp.OP_COLON & 0xff, 0x1234]]);
  const bare = makeEngine();
  loadRows(bare, []);
  const bufA = new Uint8Array(TRACKER_CHUNK * 2);
  const bufB = new Uint8Array(TRACKER_CHUNK * 2);
  for (let i = 0; i < 8; i++) {
    withColon.renderChunk(0, bufA);
    bare.renderChunk(0, bufB);
    assert.deepEqual([...bufA], [...bufB], `chunk ${i} diverged`);
  }
});
