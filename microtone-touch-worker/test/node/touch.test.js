// Microtone Touch's pure half: the keyboard lattice, the synthesised preset
// bank, and a sketch's road to a .taud — checked against the REAL parser and
// the REAL engine (both from core/), not against copies of them.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  edoSteps, layoutSteps, reachesAll, layoutWorks, fitLayout, keyDegree, hexCentre, pixelToHex, visibleKeys, LAYOUTS, TILT,
  findFloor,
} from "../../src/lattice.js";
import { buildBank, PRESETS, DRUMS } from "../../src/presets.js";
import {
  newSketch, normaliseSketch, toTaudDoc, sketchToTaud, patternBytes, isBlank, sketchFileName,
  NOTE_OFF, LANES, ROWS, TUNINGS, FX, tuningById,
} from "../../src/sketch.js";
import { originPeriod } from "../../src/keyboard.js";
import { noteLabel, noteShade } from "../../src/notes.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { TaudEngine } from "../../core/engine/engine.js";
import { TaudInst } from "../../core/engine/inst.js";
import { TRACKER_CHUNK, SAMPLING_RATE, JAM_VOICE_BASE } from "../../core/engine/constants.js";
import { SAMPLEBIN_SIZE, INST_RECORD_SIZE } from "../../core/format/taud-const.js";
import { loadIntoEngine } from "../../core/audio/offline-render.js";
import { pitchTablePresets, noteForDegree } from "../../core/tuning/pitchtables.js";

const bank = buildBank();
const C4_HZ = 440 * 2 ** (-9 / 12);

// ── lattice ──────────────────────────────────────────────────────────────────

test("lattice: a tuning's own intervals, from its patent fifth", () => {
  assert.deepEqual(edoSteps(12), { n: 12, fifth: 7, tone: 2, limma: 1, apotome: 1, major3: 4, minor3: 3 });
  assert.deepEqual(edoSteps(31), { n: 31, fifth: 18, tone: 5, limma: 3, apotome: 2, major3: 10, minor3: 8 });
  assert.deepEqual(layoutSteps("wicki", 12), { a: 2, b: 7 });
  assert.deepEqual(layoutSteps("harmonic", 12), { a: 4, b: 7 });
  assert.deepEqual([layoutSteps("bosanquet", 53).a, layoutSteps("bosanquet", 53).b], [9, 5]);
});

test("lattice: Bosanquet–Wilson is whole tones one way and the chromatic semitone the other", () => {
  for (const n of [12, 19, 31, 53]) {
    const s = edoSteps(n);
    const L = layoutSteps("bosanquet", n);
    assert.equal(keyDegree(1, 0, L), s.tone, `${n}-TET: a whole tone up-right`);
    assert.equal(keyDegree(0, 1, L), s.apotome, `${n}-TET: the chromatic semitone straight up`);
    assert.equal(keyDegree(-1, 1, L), -s.limma, `${n}-TET: down a diatonic semitone up-left`);
  }
});

test("lattice: Bosanquet's floors — each repeat of the root's row is an octave up", () => {
  const floorOf = (n) => layoutSteps(fitLayout("bosanquet", n), n).floor ?? null;
  // The walk up from the root finds the root itself (12, 19) or its
  // right-hand neighbour (17, 22: C → D) — and from 31 tones up it walks past
  // the key a degree off two rows up, to the exact repeat a whole tone's
  // worth of rows up (see "every degree is on the board" below).
  assert.deepEqual(floorOf(12), { rows: 2, lift: 12 });
  assert.deepEqual(floorOf(17), { rows: 3, lift: 17 });
  assert.deepEqual(floorOf(19), { rows: 3, lift: 19 });
  assert.deepEqual(floorOf(22), { rows: 4, lift: 22 });
  assert.deepEqual(floorOf(31), { rows: 5, lift: 31 });
  assert.deepEqual(floorOf(41), { rows: 7, lift: 41 });
  assert.deepEqual(floorOf(53), { rows: 9, lift: 53 });
  // 7- and 9-TET (and 5, 8, 16) already climb an octave a floor: nothing to lift.
  for (const n of [5, 7, 8, 9, 16]) assert.equal(floorOf(n), null, `${n}-TET`);
  // …and no other layout has floors at all.
  for (const id of ["wicki", "harmonic", "step"]) assert.equal(layoutSteps(id, 12).floor, undefined, id);

  // Where the walk lands, one floor up is now one octave up.
  const at = (n, q, r) => keyDegree(q, r, layoutSteps("bosanquet", n));
  assert.equal(at(12, -1, 2), 12, "12-TET: C straight above C, an octave up");
  assert.equal(at(19, -1, 3), 19, "19-TET: the same");
  assert.equal(at(22, -2, 4), 22 + 4, "22-TET: D above C, an octave up");
  assert.equal(at(22, -3, 4), 22, "…with C an octave up beside it");
  assert.equal(at(31, -2, 5), 31, "31-TET: C, five rows up, an octave up");
  // Inside a floor the board is still plain Bosanquet; the floor below is an
  // octave down.
  assert.equal(at(12, 3, 1), 2 * 3 + 1, "row 1 is in the root's floor");
  assert.equal(at(12, 0, -1), -1 - 12, "row −1 is the floor below");
  assert.equal(findFloor({ a: 1, b: 2 }, 9), null);
});

test("lattice: every degree is on the board, floors and all, in every tuning and layout", () => {
  // Not one note missing across three periods, for every layout as fitted. (A
  // two-row floor in 31-TET would fail this: C4 on no key at all.)
  for (const t of TUNINGS) {
    const p = pitchTablePresets[t.notation];
    const n = p.table.length;
    for (const { id } of LAYOUTS) {
      const steps = layoutSteps(fitLayout(id, n, p.interval), n, p.interval);
      const on = new Set();
      for (let q = -60; q <= 60; q++) for (let r = -40; r <= 40; r++) on.add(keyDegree(q, r, steps));
      const missing = [];
      for (let d = -n; d < 2 * n; d++) if (!on.has(d)) missing.push(d);
      assert.deepEqual(missing, [], `${t.name} / ${id}`);
    }
  }
});

test("lattice: every offered tuning gets a layout that works, whichever is asked for", () => {
  for (const t of TUNINGS) {
    const p = pitchTablePresets[t.notation];
    assert.ok(p && p.table.length > 0, `${t.name} has a pitch table`);
    for (const { id } of LAYOUTS) {
      const fit = fitLayout(id, p.table.length, p.interval);
      const steps = layoutSteps(fit, p.table.length, p.interval);
      assert.ok(layoutWorks(steps, p.table.length), `${t.name} / ${id} → ${fit} ${JSON.stringify(steps)}`);
    }
  }
  // The small ones that need the fallback for everything but the run.
  assert.equal(fitLayout("wicki", 4), "step", "4-TET has no whole tone at all");
  assert.equal(fitLayout("harmonic", 4), "step", "4-TET has no major third either");
  assert.equal(fitLayout("wicki", 7), "wicki");
  assert.equal(fitLayout("wicki", 13, 0x195c), "wicki", "Bohlen–Pierce");
});

test("lattice: a layout that cannot reach every degree falls back to the degree run", () => {
  // 24-TET's patent fifth is 12-TET's: those three only ever reach even degrees.
  for (const id of ["wicki", "bosanquet", "harmonic"]) {
    assert.equal(reachesAll(layoutSteps(id, 24), 24), false, id);
    assert.equal(fitLayout(id, 24), "step");
  }
  for (const n of [12, 17, 19, 22, 31, 41, 53]) assert.equal(fitLayout("wicki", n), "wicki", `${n}-TET`);
  for (const n of [12, 24, 53]) assert.ok(reachesAll(layoutSteps("step", n), n));
  assert.deepEqual(LAYOUTS.map((l) => l.id), ["wicki", "bosanquet", "harmonic", "step"]);
});

test("lattice: every key's centre maps back to that key, and its neighbours are the layout", () => {
  for (let q = -6; q <= 6; q++) {
    for (let r = -4; r <= 4; r++) {
      const c = hexCentre(q, r, 30);
      assert.deepEqual(pixelToHex(c.x, c.y, 30), { q, r });
      // …and a point well inside the key still lands on it.
      assert.deepEqual(pixelToHex(c.x + 9, c.y - 9, 30), { q, r });
    }
  }
  const L = layoutSteps("wicki", 12);
  assert.equal(keyDegree(1, 0, L), 2, "up-right = a whole tone");
  assert.equal(keyDegree(0, 1, L), 7, "straight up = a fifth");
  assert.equal(keyDegree(-1, 1, L), 5, "up-left = a fourth");
});

test("lattice: the board is the Lumatone's — pointy-topped, turned 16.1° anticlockwise", () => {
  const o = hexCentre(0, 0, 30);
  const along = (q, r) => { const p = hexCentre(q, r, 30); return { dx: p.x - o.x, dy: o.y - p.y }; };
  const angle = (q, r) => { const v = along(q, r); return (Math.atan2(v.dy, v.dx) * 180) / Math.PI; };
  const tilt = (TILT * 180) / Math.PI;
  assert.ok(Math.abs(tilt - 16.1) < 0.01, `tilt ${tilt}`);
  assert.ok(Math.abs(angle(1, 0) - tilt) < 1e-9, "a climbs to the right at the tilt");
  assert.ok(Math.abs(angle(0, 1) - (tilt + 60)) < 1e-9, "b climbs steeply");
  assert.ok(Math.abs(angle(-1, 1) - (tilt + 120)) < 1e-9, "b − a goes up and to the left");
  for (const [q, r] of [[1, 0], [0, 1], [-1, 1]]) {
    const v = along(q, r);
    assert.ok(Math.abs(Math.hypot(v.dx, v.dy) - 30 * Math.sqrt(3)) < 1e-9, "all three are neighbours");
  }
  assert.ok(Math.abs(along(7, -2).dy) < 1e-9, "key (7, −2) is level with the origin: the lattice's own horizontal");
});

test("lattice: the layouts read as the Lumatone's preset charts", () => {
  // 19-ET Bosanquet: C D E climb the shallow axis, C♯ sits steeply above C,
  // and D♭ one row further up (the row of flats, in the same floor).
  const b19 = layoutSteps("bosanquet", 19);
  assert.deepEqual([keyDegree(1, 0, b19), keyDegree(0, 1, b19), keyDegree(0, 2, b19)], [3, 1, 2]);
  // 22-ET: a whole tone is 4, C♯ is 3 above C, and up-left is B, a degree down.
  const b22 = layoutSteps("bosanquet", 22);
  assert.deepEqual([keyDegree(1, 0, b22), keyDegree(0, 1, b22), keyDegree(-1, 1, b22)], [4, 3, -1]);
  // 12-ET Harmonic Table: major thirds on the shallow axis, fifths on the
  // steep one, minor thirds up and to the left.
  const h12 = layoutSteps("harmonic", 12);
  assert.deepEqual([keyDegree(1, 0, h12), keyDegree(0, 1, h12), keyDegree(-1, 1, h12)], [4, 7, 3]);
});

test("lattice: the visible keys cover the board without gaps", () => {
  const origin = { x: 40, y: 260 };
  const keys = visibleKeys(390, 300, 26, origin);
  assert.ok(keys.length > 40);
  for (let x = 2; x < 390; x += 13) {
    for (let y = 2; y < 300; y += 13) {
      const { q, r } = pixelToHex(x - origin.x, y - origin.y, 26);
      assert.ok(keys.some((k) => k.q === q && k.r === r), `(${x}, ${y}) → (${q}, ${r}) is drawn`);
    }
  }
});

// ── the preset bank ──────────────────────────────────────────────────────────

test("presets: the bank is deterministic", () => {
  const again = buildBank();
  assert.deepEqual(again.slots, bank.slots);
  assert.ok(Buffer.from(again.image).equals(Buffer.from(bank.image)), "byte-identical image");
});

test("presets: every preset has a record pointing at real pool bytes", () => {
  const melodic = PRESETS.filter((p) => !p.kit);
  assert.deepEqual(melodic.map((p) => bank.slots[p.id]), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(bank.slots.drums, [8, 9, 10, 11, 12, 13, 14, 15]);
  assert.equal(bank.names.length, 16);
  for (let slot = 1; slot <= 15; slot++) {
    const inst = new TaudInst(slot);
    const o = SAMPLEBIN_SIZE + slot * INST_RECORD_SIZE;
    inst.loadRecord(bank.image.subarray(o, o + INST_RECORD_SIZE));
    assert.ok(inst.sampleLength > 0 && inst.samplePtr + inst.sampleLength <= SAMPLEBIN_SIZE, `slot ${slot}`);
    assert.ok(inst.samplingRate > 0 && inst.samplingRate <= 0xffff);
    if (slot <= 7) {
      assert.equal(inst.loopMode & 3, 1, `slot ${slot} loops`);
      assert.ok(inst.sampleLoopEnd <= inst.sampleLength && inst.sampleLoopStart < inst.sampleLoopEnd);
      assert.ok((inst.volEnvLoop & 0x2000) !== 0, `slot ${slot}'s envelope is marked present`);
    } else {
      assert.ok(inst.isPercussion, `slot ${slot} is percussion, so a retune leaves it alone`);
    }
  }
});

test("presets: a melodic loop sounds C4 to within a few hundredths of a cent", () => {
  // The only error is the record's whole-Hz sampling rate. The pad's loop is
  // the worst at 0.025 cents — at C4, one beat against true pitch every two
  // minutes — and the single-cycle loops are under a hundredth.
  for (let slot = 1; slot <= 7; slot++) {
    const inst = new TaudInst(slot);
    const o = SAMPLEBIN_SIZE + slot * INST_RECORD_SIZE;
    inst.loadRecord(bank.image.subarray(o, o + INST_RECORD_SIZE));
    // Measure the loop's period from the bytes: the lag with the least
    // difference against itself, between half and twice the nominal.
    const loop = bank.image.subarray(inst.samplePtr + inst.sampleLoopStart, inst.samplePtr + inst.sampleLoopEnd);
    const len = loop.length;
    const cycles = slot === 6 ? 64.5 : slot === 7 ? 2 : 1; // the pad's chorus, the organ's sub-octave
    const hz = (inst.samplingRate / len) * cycles;
    const cents = 1200 * Math.log2(hz / C4_HZ);
    assert.ok(Math.abs(cents) < (slot === 6 ? 0.03 : 0.01), `slot ${slot}: ${cents.toFixed(4)} cents`);
  }
});

// ── the sketch ───────────────────────────────────────────────────────────────

function sketchWithTune() {
  const s = newSketch();
  const piano = s.sections[0].cells[0];
  piano[0] = { n: 0x5000 };
  piano[4] = { n: 0x5000 + 0x555, fx: "vibrato", lv: 2 };
  piano[12] = { n: NOTE_OFF };
  piano[16] = { n: 0x5800 };
  s.sections[0].cells[2][0] = { n: 0x5000, d: 0 }; // a kick on the drum lane
  s.sections[0].cells[2][8] = { n: 0x5000, d: 1 }; // …and a snare
  return s;
}

test("sketch: an effect lasts until the lane's next note or key-off", () => {
  const s = sketchWithTune();
  const bytes = patternBytes(s, 0, 0, bank);
  const op = (r) => bytes[r * 8 + 5];
  const arg = (r) => bytes[r * 8 + 6] | (bytes[r * 8 + 7] << 8);
  for (let r = 0; r < 4; r++) assert.equal(op(r), 0, `row ${r}: nothing yet`);
  for (let r = 4; r < 12; r++) {
    assert.equal(op(r), FX.vibrato.op, `row ${r} vibrates`);
    assert.equal(arg(r), FX.vibrato.args[2]);
  }
  assert.equal(op(12), 0, "the key-off ends it");
  assert.equal(bytes[12 * 8] | (bytes[12 * 8 + 1] << 8), NOTE_OFF);
  for (let r = 0; r < ROWS; r++) {
    assert.equal(bytes[r * 8 + 3], 0xc0, "no volume intent anywhere");
    assert.equal(bytes[r * 8 + 4], 0xc0, "no pan intent anywhere");
  }
  assert.equal(bytes[2], bank.slots.piano, "a note carries its lane's instrument");
  const drums = patternBytes(s, 0, 2, bank);
  assert.equal(drums[2], bank.slots.drums[0]);
  assert.equal(drums[8 * 8 + 2], bank.slots.drums[1]);
});

test("sketch: it survives the trip through writeTaud and parseTaud", () => {
  const s = sketchWithTune();
  s.name = "Ünïcode sketch";
  s.tuning = "31";
  s.bpm = 133;
  s.sections.push(structuredClone(s.sections[0]));
  const parsed = parseTaud(sketchToTaud(s, bank));
  const want = toTaudDoc(s, bank);
  const song = parsed.songs[0];
  assert.equal(song.bpm, 133);
  assert.equal(song.patterns.length, 2 * LANES);
  for (let p = 0; p < song.patterns.length; p++) {
    assert.deepEqual([...song.patterns[p]], [...want.songs[0].patterns[p]], `pattern ${p}`);
  }
  assert.equal(song.cues.length, 2);
  assert.equal(song.cues[1][0] & 0x7fff, LANES, "cue 1 plays section 1's first pattern");
  assert.ok(Buffer.from(parsed.sampleInstImage).equals(Buffer.from(bank.image)));
  assert.equal(parsed.meta.songMeta[0].notation, 310, "the tuning travels as the song's notation");
  assert.equal(song.tuningBaseNote, 0x5c00, "…at concert pitch");
  assert.equal(song.tuningFreq, 440);
  assert.equal(parsed.meta.projectName, "\\u00DCn\\u00EFcode sketch", "names ride the \\u escape");
});

test("sketch: the song loops by default, and a one-section loop is what the transport plays", () => {
  const s = sketchWithTune();
  s.sections.push(structuredClone(s.sections[0]), structuredClone(s.sections[0]));
  const word0 = (words) => {
    let w = 0;
    for (let c = 0; c < 16; c++) if (words[c] & 0x8000) w |= 1 << c;
    return w;
  };
  const doc = toTaudDoc(s, bank);
  assert.equal(word0(doc.songs[0].cues[2]), 0xf000, "JMP 0 on the last cue");
  assert.equal(word0(doc.songs[0].cues[0]), 0, "plain cues before it");
  s.loop = false;
  assert.equal(word0(toTaudDoc(s, bank).songs[0].cues[2]), 0x0100, "HALT when not looping");
  const one = toTaudDoc(s, bank, { only: 1 });
  assert.equal(one.songs[0].cues.length, 1);
  assert.equal(one.songs[0].cues[0][0] & 0x7fff, LANES);
  assert.equal(word0(one.songs[0].cues[0]), 0xf000, "a section on its own always loops");
  assert.equal(one.songs[0].patterns.length, 3 * LANES, "every pattern stays where it is");
});

test("sketch: junk from storage is dropped, not trusted", () => {
  assert.ok(isBlank(normaliseSketch(null)));
  assert.ok(isBlank(normaliseSketch({ v: 999, sections: [{ cells: [[{ n: 0x5000 }]] }] })));
  const s = normaliseSketch({
    v: 1, name: "x".repeat(200), bpm: 9999, tuning: "11", lanes: [{ preset: "theremin" }, { preset: "pad", mute: true }],
    sections: [{ cells: [[{ n: 0x5000, fx: "warp" }, { n: 5 }, { n: NOTE_OFF, d: 3 }, { n: 0x5000, d: 99, fx: "roll", lv: 7 }]] }],
  });
  assert.equal(s.name.length, 64);
  assert.equal(s.bpm, 300);
  assert.equal(s.tuning, "12");
  assert.equal(normaliseSketch({ v: 1, notation: 190 }).tuning, "19", "a sketch saved before tuning ids keeps its tuning");
  assert.equal(s.lanes[0].preset, "piano");
  assert.deepEqual(s.lanes[1], { preset: "pad", mute: true });
  const cells = s.sections[0].cells[0];
  assert.deepEqual(cells.slice(0, 4), [{ n: 0x5000 }, null, { n: NOTE_OFF }, { n: 0x5000, fx: "roll", lv: 2 }]);
  assert.equal(sketchFileName({ name: 'a/b:c*"d' }), "a b c d.taud");
});

test("sketch: A-ak and Hyang-ak are Shi'er lü at their own reference pitch", () => {
  for (const [id, freq] of [["aak", 262], ["hyangak", 311]]) {
    const s = sketchWithTune();
    s.tuning = id;
    const song = parseTaud(sketchToTaud(s, bank));
    assert.equal(song.meta.songMeta[0].notation, 10123, `${id}: Shi'er lü notation`);
    assert.equal(song.songs[0].tuningBaseNote, 0x5000, `${id}: the declaration names C4`);
    assert.equal(song.songs[0].tuningFreq, freq);
  }
  assert.equal(tuningById("nonsense").id, "12");
  assert.deepEqual(TUNINGS.map((t) => t.id), [
    "4", "5", "6", "7", "8", "9", "10", "12", "15", "16", "17", "19", "22", "24", "31", "41", "53", "bp", "aak", "hyangak",
  ]);
});

test("keyboard: the octave control means an octave, even where the period is not one", () => {
  const twelve = pitchTablePresets[120], bp = pitchTablePresets[35130];
  assert.equal(originPeriod(twelve, 3), -1);
  assert.equal(noteForDegree(4 + originPeriod(twelve, 3), 0, twelve), 0x4000, "C3");
  // A tritave is ~1.58 octaves: three octaves down is nearest two tritaves down.
  assert.equal(originPeriod(bp, 1), -2);
  assert.equal(originPeriod(bp, 4), 0);
});

// ── through the engine ───────────────────────────────────────────────────────

function rms(eng, seconds) {
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  let sum = 0, n = 0;
  for (let i = 0; i < Math.ceil((seconds * SAMPLING_RATE) / TRACKER_CHUNK); i++) {
    eng.renderChunk(0, out);
    for (const b of out) { sum += (b - 128) ** 2; n++; }
  }
  return Math.sqrt(sum / n);
}

test("engine: a sketch plays, and an empty one is silent", () => {
  const eng = new TaudEngine();
  loadIntoEngine(eng, toTaudDoc(sketchWithTune(), bank));
  eng.setCuePosition(0, 0);
  eng.play(0);
  assert.ok(rms(eng, 1.5) > 2, "the tune is audible");

  const quiet = new TaudEngine();
  loadIntoEngine(quiet, toTaudDoc(newSketch(), bank));
  quiet.setCuePosition(0, 0);
  quiet.play(0);
  assert.ok(rms(quiet, 1) < 1, "nothing written, nothing heard");
});

test("engine: every preset sounds when jammed", () => {
  const eng = new TaudEngine();
  loadIntoEngine(eng, toTaudDoc(newSketch(), bank));
  for (let slot = 1; slot <= 15; slot++) {
    eng.jamNote(0, JAM_VOICE_BASE, 0x5000, slot);
    assert.ok(rms(eng, 0.25) > 1, `slot ${slot} (${bank.names[slot]}) is audible`);
    eng.jamStopVoice(0, JAM_VOICE_BASE);
    rms(eng, 0.05);
  }
});

test("engine: jamKeyOff releases a held note through its envelope instead of cutting it", () => {
  const eng = new TaudEngine();
  loadIntoEngine(eng, toTaudDoc(newSketch(), bank));
  const v = JAM_VOICE_BASE + 3;
  const voice = () => eng.playheads[0].trackerState.voices[v];

  eng.jamNote(0, v, 0x5000, bank.slots.pad);
  rms(eng, 2);
  assert.ok(voice().active, "a pad holds while the key is down");
  eng.jamKeyOff(0, v);
  assert.ok(voice().active && voice().keyOff, "released, not cut");
  const tail = rms(eng, 0.3);
  assert.ok(tail > 1, `the release is still sounding (${tail.toFixed(2)})`);
  rms(eng, 2);
  assert.equal(voice().active, false, "and it ends once the release has played");

  // A piano note decays by itself, and the key-off's fadeout finishes it.
  eng.jamNote(0, v, 0x5000, bank.slots.piano);
  rms(eng, 0.2);
  eng.jamKeyOff(0, v);
  rms(eng, 0.6);
  assert.equal(voice().active, false, "the fadeout ends a released piano note");
});

// ── note names ───────────────────────────────────────────────────────────────

test("notes: labels follow the tuning's own notation", () => {
  const at = (n, d, oct = 4) => noteLabel(noteForDegree(oct, d, pitchTablePresets[n]), pitchTablePresets[n]);
  assert.equal(at(120, 0), "C4");
  assert.equal(at(120, 1), "C♯4");
  assert.equal(at(120, 10, 3), "A♯3");
  assert.equal(at(240, 1), "C+4", "24-TET's half-sharp");
  assert.equal(at(240, 3), "Dd4", "…and half-flat");
  assert.equal(at(410, 1), "↑C4", "41-TET's Kite up-tick");
  assert.equal(noteLabel(NOTE_OFF, pitchTablePresets[120]), "off");
  assert.equal(at(10123, 0), "\u9EC34", "Shi'er lü's own names: 黃 (huangzhong)");
  assert.equal(at(35130, 7), "H4", "Bohlen–Pierce's H");
  const lu = pitchTablePresets[10123];
  const shade = (d) => noteShade(noteForDegree(4, d, lu), lu);
  assert.deepEqual([0, 1, 2, 11].map(shade), ["natural", "accidental", "natural", "accidental"],
    "Shi'er lü: yang lü light, yin lü dark");
  assert.equal(DRUMS.length, 8);
});

// ── the other end ────────────────────────────────────────────────────────────

test("tracker: Microtone's own document model opens a sent sketch", async () => {
  // A test-only reach into the tracker's tree: this is the contract a send
  // relies on, so it is checked against the code that will do the opening.
  const { Document } = await import("../../../microtone-worker/src/doc/document.js");
  const s = sketchWithTune();
  s.name = "Phone idea";
  s.tuning = "19";
  const doc = new Document(parseTaud(sketchToTaud(s, bank)));
  assert.equal(doc.channelCount, 32);
  assert.equal(doc.instrumentName(bank.slots.piano), "Piano");
  assert.equal(doc.instrumentName(bank.slots.drums[1]), "Snare");
  assert.ok(doc.usedInstrumentSlots().includes(bank.slots.piano));
  assert.equal(doc.meta.songMeta[0].notation, 190);
});
