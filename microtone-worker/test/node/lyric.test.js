// Item 280 — lyric instruments: a formant instrument with an `ILyr` entry,
// singing one syllable of its lyrics per note.
//
// What is pinned here: (1) the section — its codec round-trips, and a reader
// drops what it cannot trust; (2) the engine — which syllable each note sings:
// an instrument byte starts the lyrics over, every trigger moves them on,
// tone portamento and Q do not, the lyrics wrap, a play started mid-song
// finds the syllable a play from the start would have reached; (3) a syllable
// is the record with its own fields in place, so an edit of the record is
// heard on every syllable, and per-slot timing bytes time each consonant.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../core/engine/engine.js";
import { TRACKER_CHUNK, SAMPLING_RATE } from "../../core/engine/constants.js";
import { buildFormantRecord } from "../../core/engine/inst.js";
import * as F from "../../core/engine/formant.js";
import {
  parseLyricSection, buildLyricSection, buildLyricEntry, blankSyllable, lyricRecipeSpans,
  cloneLyricEntry, ILYR_FOURCC,
} from "../../core/format/lyric-section.js";
import { SAMPLEINST_SIZE, SAMPLEBIN_SIZE } from "../../core/format/taud-const.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";
import { DocSync } from "../../src/doc/sync.js";
import {
  importBankOp, cleanupBankOp, setLyricsOp, renumberInstrumentOp, deleteInstrumentOp,
} from "../../src/doc/ops.js";
import { planCreateOpl, planImport, planDuplicateInstruments } from "../../src/doc/bankmerge.js";
import { planPoolDefrag } from "../../src/doc/pooldefrag.js";
import { planDeleteSample, planRenumberInstrument, planDeleteInstrument } from "../../src/doc/cleanup.js";
import { defaultFormantRecord } from "../../src/doc/formantedit.js";
import {
  deriveLyrics, readLyrics, onsetMs, lyricContinues, lyricTokens, medianOnset, remapSyllableOverrides,
} from "../../src/doc/lyrics.js";
import { ipaToXsampa, xsampaToIpa } from "../../src/motif/syllable.js";

const C4_HZ = 261.6255653005986;
const id = (ipa) => F.CONSONANT_LIST.find((r) => r.ipa === ipa).id;
const SAW = { ptr: 0x1000, len: 128, rate: Math.round(128 * C4_HZ), loopStart: 0, loopEnd: 128, loopMode: 1 };

function fillPool(bin) {
  for (let i = 0; i < SAW.len; i++) bin[SAW.ptr + i] = Math.round((255 * i) / (SAW.len - 1));
}

function record() {
  const p = new F.FormantPatch();
  p.srcPtr = SAW.ptr;
  return buildFormantRecord(F.encodeFormantBlock(p), SAW, {});
}

/** A syllable: onset consonants, a vowel mark's chart point, a coda. */
function syl(onset = [], vowel = [200, 255, 0], coda = 0, extra = {}) {
  const s = blankSyllable();
  [s.front, s.open, s.round] = vowel;
  s.cons = [onset[0] ?? 0, onset[1] ?? 0, coda];
  return Object.assign(s, extra);
}

const LYRICS = [syl([id("d")], [255, 85, 0]), syl([id("z")], [255, 0, 0]), syl([id("ɡ")], [255, 0, 0], id("m")),
  syl([id("m")], [255, 0, 0])];

function entry(syllables = LYRICS, recipes = []) {
  return { instId: 1, syllables, recipes, editor: { xsampa: false, converge: 0, overrides: [], sylOverrides: [], text: "" } };
}

/** Lane 0 plays `cells` at tick 1 (one row = 20 ms); returns, per row, the
 *  index of the syllable lane 0's note is singing (-1 for none / not a syllable). */
function sungPerRow(cells, rows, { lyric = entry(), hook = null, chaseTo = null } = {}) {
  const eng = new TaudEngine();
  fillPool(eng.sampleBin);
  eng.uploadInstrument(1, record());
  eng.setLyrics([lyric]);
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  for (const c of cells) {
    const o = c.row * 8;
    if (c.note !== undefined) { pat[o] = c.note & 0xff; pat[o + 1] = (c.note >>> 8) & 0xff; }
    if (c.inst !== undefined) pat[o + 2] = c.inst;
    if (c.fx !== undefined) { pat[o + 5] = c.fx; pat[o + 6] = c.arg & 0xff; pat[o + 7] = (c.arg >>> 8) & 0xff; }
  }
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0; cue[1] = 0;
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125); eng.setTickRate(0, 1); eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0);
  if (chaseTo !== null) { eng.play(0); eng.chaseTrackerRow(0, 0, chaseTo); } else eng.play(0);
  const ts = eng.playheads[0].trackerState;
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  const perRow = Math.round((SAMPLING_RATE * 20) / 1000);
  const sung = [];
  const inst = eng.instruments[1];
  const r0 = chaseTo ?? 0;
  let done = 0;
  for (let r = r0; r < rows; r++) {
    if (hook) hook(r, eng);
    // Read in the middle of the row, well clear of its neighbours' events.
    const mid = (r - r0) * perRow + perRow / 2;
    while (done < mid) { eng.renderChunk(0, out); done += TRACKER_CHUNK; }
    const st = ts.voices[0].formant;
    sung.push(st === null || inst.lyric === null ? -1 : inst.lyric.indexOf(st.patch));
  }
  return { sung, eng };
}

const G = 0x10, Q = 0x1a;

// ── the section ──────────────────────────────────────────────────────────

test("the ILyr codec round-trips an entry, the editor's tail included", () => {
  const e = entry(LYRICS, [{ cons: id("z"), ptr: 0x123456, len: 4000, offset: 12, rate: 22050, tilt: -32, gain: 7 }]);
  e.editor = {
    xsampa: true, converge: 65, overrides: [{ cons: id("s"), timing: 150 }],
    sylOverrides: [{ index: 1, timing: 90 }, { index: 300, timing: 200 }], text: "de.zi gim.mi — 가사",
  };
  e.syllables[1].nasal = true;
  e.syllables[2].vowel = false;
  e.syllables[3].timing = [100, 110, 120, 130];
  e.syllables[3].gr = 0x8b;
  const two = { ...cloneLyricEntry(e), instId: 0x2f3 };
  const { entries, problems } = parseLyricSection(buildLyricSection([two, e]));
  assert.deepEqual(problems, []);
  assert.deepEqual([...entries.keys()], [1, 0x2f3]);
  assert.deepEqual(entries.get(1), e);
  assert.deepEqual(entries.get(0x2f3), two);
  assert.equal(ILYR_FOURCC, "ILyr");
  assert.deepEqual(lyricRecipeSpans(e).map((s) => [s.ptr, s.len]), [[0x123456, 4000]]);
});

test("a reader drops an entry with no syllable, a truncated one and a second entry for an instrument", () => {
  const good = buildLyricEntry(entry());
  const empty = buildLyricEntry(entry([syl()]));
  empty[6] = 0; // S = 0
  const dup = buildLyricEntry(entry([syl([id("s")])]));
  const cut = buildLyricEntry({ ...entry(), instId: 9 }).subarray(0, 20);
  const all = new Uint8Array(good.length + empty.length + dup.length + cut.length);
  let o = 0;
  for (const p of [empty, good, dup, cut]) { all.set(p, o); o += p.length; }
  const { entries, problems } = parseLyricSection(all);
  assert.deepEqual([...entries.keys()], [1]);
  assert.equal(entries.get(1).syllables.length, LYRICS.length);
  assert.deepEqual(problems.map((p) => p.detail), ["invalid", "duplicate", "truncated"]);
});

test("an editor's tail is optional: an entry without one plays the same", () => {
  const b = buildLyricEntry(entry());
  const fixed = 6 + 4 + LYRICS.length * 12;
  const bare = b.slice(0, fixed);
  const len = fixed - 6;
  bare[2] = len & 0xff; bare[3] = len >>> 8; bare[4] = 0; bare[5] = 0;
  const { entries, problems } = parseLyricSection(bare);
  assert.deepEqual(problems, []);
  assert.deepEqual(entries.get(1).syllables, LYRICS);
  assert.equal(entries.get(1).editor.text, "");
});

// ── which syllable a note sings ─────────────────────────────────────────

test("an instrument byte starts the lyrics over; every trigger moves them on, and they wrap", () => {
  // The TODO's own example, shortened: a note with the instrument, notes
  // without it, a tone portamento, then the instrument again.
  const cells = [
    { row: 0, note: 0x4800, inst: 1 },        // d…
    { row: 1, note: 0x4400, fx: G, arg: 0x0100 }, // a glide, not a trigger
    { row: 2, note: 0x4400 },                 // z…
    { row: 3, note: 0x4000 },                 // g…m
    { row: 4, note: 0x3c00 },                 // m…
    { row: 5, note: 0x4000 },                 // wraps: d…
    { row: 6, note: 0x4400 },                 // z…
    { row: 7, note: 0x4200, inst: 1 },        // the instrument again: d…
    { row: 8, note: 0x4400 },                 // z…
  ];
  const { sung } = sungPerRow(cells, 9);
  assert.deepEqual(sung, [0, 0, 1, 2, 3, 0, 1, 0, 1]);
});

test("Q says the syllable again without moving the lyrics on", () => {
  const cells = [
    { row: 0, note: 0x4800, inst: 1 },
    { row: 1, fx: Q, arg: 0x0001 },
    { row: 2, note: 0x4400 },
  ];
  const { sung, eng } = sungPerRow(cells, 3);
  assert.deepEqual(sung, [0, 0, 1]);
  assert.equal(eng.playheads[0].trackerState.voices[0].lyricPos, 2);
});

test("an instrument byte without a note starts the lyrics over and leaves the note its syllable", () => {
  const cells = [
    { row: 0, note: 0x4800, inst: 1 },
    { row: 1, note: 0x4400 },          // z…
    { row: 2, inst: 1 },               // no trigger: the note keeps singing z…
    { row: 3, note: 0x4400 },          // …and the next note starts over: d…
  ];
  const { sung } = sungPerRow(cells, 4);
  assert.deepEqual(sung, [0, 1, 1, 0]);
});

test("a play started mid-song sings the syllable a play from the start would have", () => {
  const cells = [];
  for (let r = 0; r < 12; r++) cells.push({ row: r, note: 0x4000 + 0x100 * r, inst: r === 0 ? 1 : undefined });
  const whole = sungPerRow(cells, 12).sung;
  const chased = sungPerRow(cells, 12, { chaseTo: 7 }).sung;
  assert.deepEqual(chased, whole.slice(7));
});

test("a play started on a glide sings the syllable it glides, not the next one", () => {
  // Started at row 2 nothing is sounding, so the G triggers — but it is still
  // the glide of row 1's z…, and the note after it must sing g…m, as it does
  // in a play from the start where the G only glides.
  const cells = [
    { row: 0, note: 0x4800, inst: 1 },            // d…
    { row: 1, note: 0x4400 },                     // z…
    { row: 2, note: 0x4600, fx: G, arg: 0x0100 }, // z… gliding
    { row: 3, note: 0x4000 },                     // g…m
    { row: 4, note: 0x3c00 },                     // m…
  ];
  const whole = sungPerRow(cells, 5).sung;
  assert.deepEqual(whole, [0, 1, 1, 2, 3]);
  assert.deepEqual(sungPerRow(cells, 5, { chaseTo: 2 }).sung, whole.slice(2));
  // …and with the instrument byte on the glide: the lyrics start over, the
  // note keeps its syllable, and the next note sings the first.
  cells[2].inst = 1;
  const whole2 = sungPerRow(cells, 5).sung;
  assert.deepEqual(whole2, [0, 1, 1, 0, 1]);
  assert.deepEqual(sungPerRow(cells, 5, { chaseTo: 2 }).sung, whole2.slice(2));
});

test("each lane keeps its own place in the lyrics", () => {
  const eng = new TaudEngine();
  fillPool(eng.sampleBin);
  eng.uploadInstrument(1, record());
  eng.setLyrics([entry()]);
  const ts = eng.playheads[0].trackerState;
  ts.voices[3].lyricPos = 2;
  assert.equal(ts.voices[0].lyricPos, 0);
});

// ── a syllable is the record with its own fields ─────────────────────────

test("a syllable takes its vowel, consonants and timing from the entry, everything else from the record", () => {
  const eng = new TaudEngine();
  fillPool(eng.sampleBin);
  eng.uploadInstrument(1, record());
  const recipe = { cons: id("z"), ptr: 0x9000, len: 2000, offset: 4, rate: 16000, tilt: 16, gain: 3 };
  const e = entry([syl([id("z")], [10, 20, 30], id("m"), { nasal: true, timing: [90, 128, 140, 150] }),
    syl([id("n")], [255, 0, 0], 0, { vowel: false })], [recipe]);
  eng.setLyrics([e]);
  const inst = eng.instruments[1];
  assert.ok(inst.isLyric);
  const [a, b] = inst.lyric;
  assert.deepEqual([a.front, a.open, a.round, a.nasal], [10, 20, 30, true]);
  assert.equal(a.refNote, inst.formant.refNote);
  assert.equal(b.refNote, 0, "a syllable with no vowel");
  assert.deepEqual([a.slots[0].cons, a.slots[0].ptr, a.slots[0].len, a.slots[0].offset, a.slots[0].rate,
    a.slots[0].tilt, a.slots[0].gain], [recipe.cons, recipe.ptr, recipe.len, 4, 16000, 16, 3]);
  assert.deepEqual([a.slots[2].cons, a.slots[2].len], [id("m"), 0], "no recipe: the generator");
  assert.deepEqual([...a.slotTiming], [90, 128, 140, 150]);
  assert.equal(a.lyricOf, inst.formant);
  // An edit of the record reaches every syllable, in place.
  const track = 197 + F.FB_TRACK, glide = 197 + F.FB_GLIDE;
  inst.setByte(track, 100);
  inst.setByte(glide, 77);
  assert.equal(inst.lyric[0], a, "refreshed in place");
  assert.deepEqual([a.track, a.glide, b.track], [100, 77, 100]);
  // Lyrics go with setLyrics([]), and the record is a plain formant instrument again.
  eng.setLyrics([]);
  assert.equal(inst.isLyric, false);
});

test("per-slot timing times each consonant and the glide by its own byte; a record times them all by one", () => {
  const onsetEnd = (p) => {
    const st = new F.FormantState();
    F.formantNoteOn(st, p);
    return { onset: st.onset.map((s) => s.end), coda: st.coda?.end ?? 0, glide: st.sv ? st.svEnd : 0 };
  };
  const rec = new F.FormantPatch();
  rec.slots[0].cons = id("s"); rec.slots[1].cons = id("t"); rec.slots[2].cons = id("n"); rec.semivowel = 1;
  const base = onsetEnd(rec);
  const s = syl([id("s"), id("t")], [255, 0, 0], id("n"), { gr: 1, timing: [64, 128, 192, 64] });
  const p = F.lyricSyllable(rec, s, new Map());
  const got = onsetEnd(p);
  // [s] at twice the pace, [t] as the record, [n] half the pace, [j] twice
  // the pace — each against the record timed by its one byte (128), on top
  // of which a syllable's bytes scale.
  const slow = new F.FormantPatch(); Object.assign(slow, rec); slow.timing = 192;
  const fast = new F.FormantPatch(); Object.assign(fast, rec); fast.timing = 64;
  assert.equal(got.onset[1], base.onset[1]);
  assert.equal(got.onset[0], onsetEnd(fast).onset[0]);
  assert.equal(got.coda, onsetEnd(slow).coda);
  assert.equal(got.glide, onsetEnd(fast).glide);
});

test("a syllable's timing scales on top of the record's: the record's byte is the base length", () => {
  const rec = new F.FormantPatch();
  rec.slots[0].cons = id("s");
  rec.timing = 192;
  const s = syl([id("s")], [255, 0, 0], 0, { timing: [64, 128, 128, 128] });
  const st = new F.FormantState();
  F.formantNoteOn(st, F.lyricSyllable(rec, s, new Map()));
  const plain = new F.FormantState();
  const r128 = new F.FormantPatch(); r128.slots[0].cons = id("s"); r128.timing = 128;
  F.formantNoteOn(plain, r128);
  assert.equal(st.onset[0].end, plain.onset[0].end, "×2 then ×½ is the record's own pace at 128");
});

test("a jammed lyric instrument sings its lyrics on, a syllable a key, whichever jam voice takes it", () => {
  const eng = new TaudEngine();
  fillPool(eng.sampleBin);
  eng.uploadInstrument(1, record());
  eng.setLyrics([entry()]);
  const ts = eng.playheads[0].trackerState;
  const sung = [];
  for (let k = 0; k < 6; k++) {
    const v = eng.jamVoice(k);
    eng.jamNote(0, v, 0x4000, 1);
    sung.push(eng.instruments[1].lyric.indexOf(ts.voices[v].formant.patch));
  }
  assert.deepEqual(sung, [0, 1, 2, 3, 0, 1]);
});

// ── the document: the section follows the instrument and its samples ─────

const NOISE = { ptr: 0x2000, len: 22050, rate: 22050 };
const SQUARE = { ptr: 0x8000, len: 8000, rate: 16000 };

function plainRecord(src) {
  const r = new Uint8Array(256);
  r[0] = src.ptr & 0xff; r[1] = (src.ptr >>> 8) & 0xff; r[2] = (src.ptr >>> 16) & 0xff;
  r[4] = src.len & 0xff; r[5] = src.len >>> 8; r[6] = src.rate & 0xff; r[7] = src.rate >>> 8;
  for (let i = 0; i < 25; i++) { r[21 + 2 * i] = 0x3f; r[71 + 2 * i] = 0x80; r[121 + 2 * i] = 0x80; r[201 + 2 * i] = 0x80; }
  r[171] = 255; r[177] = 0x80; r[179] = 0x50; r[182] = 0xff; r[196] = 255;
  return r;
}

/** A project with a saw ($01), a noise ($02), a square ($03) and a lyric
 *  instrument made from the pool whose [s] reads the noise. */
function lyricProject() {
  const image = new Uint8Array(SAMPLEINST_SIZE);
  fillPool(image);
  let x = 0x12345678;
  for (let i = 0; i < NOISE.len; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    image[NOISE.ptr + i] = 16 + ((x >>> 8) % 224);
  }
  for (let i = 0; i < SQUARE.len; i++) image[SQUARE.ptr + i] = Math.floor((i * 440 * 2) / 16000) % 2 ? 200 : 56;
  [SAW, NOISE, SQUARE].forEach((s, i) => image.set(plainRecord(s), SAMPLEBIN_SIZE + (i + 1) * 256));
  const emptyPat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { emptyPat[r * 8 + 3] = 0xc0; emptyPat[r * 8 + 4] = 0xc0; }
  const doc = new Document({
    kind: "taud", fmtVer: 2, is64Channel: false, signature: "Microtone.js  ",
    sampleInstImage: image,
    songs: [{
      numVoices: 32, bpm: 125, tickRate: 6, tuningBaseNote: 0x4500, tuningFreq: 440, globalFlags: 0,
      globalVolume: 128, mixingVolume: 48, patterns: [emptyPat], cues: [new Uint16Array(64).fill(0x7fff)],
    }],
    projSections: [], ixmp: [], meta: { projectName: "test", songMeta: {} },
  });
  doc.undo = new UndoStack(doc);
  const plan = planCreateOpl(doc, defaultFormantRecord({ ...SAW }, SAW.rate, SAW.ptr, SQUARE.ptr + SQUARE.len), "Lyrics");
  assert.ok(!plan.error, plan.error);
  doc.undo.apply(importBankOp(plan));
  const slot = plan.metaSlot;
  const res = deriveLyrics(doc.instruments[slot].formant, { text: "sa.si.na", overrides: [] });
  const e = res.entry;
  e.recipes = [{ cons: id("s"), ptr: NOISE.ptr, len: NOISE.len, offset: 0, rate: NOISE.rate, tilt: 0, gain: 0 }];
  doc.undo.apply(setLyricsOp(doc.lyricPayloadWith(slot, e)));
  return { doc, slot };
}

test("a document keeps the lyrics in its ILyr section: saved, reloaded, undone", () => {
  const { doc, slot } = lyricProject();
  assert.ok(doc.isLyricSlot(slot));
  assert.ok(doc.instruments[slot].isLyric, "the decoded instrument carries them");
  assert.equal(doc.instruments[slot].lyric.length, 3);
  const again = new Document(parseTaud(doc.toBytes()));
  assert.deepEqual(again.lyricEntry(slot), doc.lyricEntry(slot));
  assert.deepEqual(again.toRenderable(0).lyrics.map((e) => e.instId), [slot], "a render is given them");
  doc.undo.undo();
  assert.equal(doc.lyricEntry(slot), null);
  assert.equal(doc.instruments[slot].isLyric, false, "…and the instrument is a formant instrument again");
});

test("the census counts a lyric recipe's noise as the instrument's sample", () => {
  const { doc, slot } = lyricProject();
  const e = doc.sampleList().find((x) => x.ptr === NOISE.ptr && x.len === NOISE.len);
  assert.ok(e.users.includes(slot));
});

test("a renumbered lyric instrument takes its lyrics with it; a deleted one, away", () => {
  const { doc, slot } = lyricProject();
  const want = doc.lyricEntry(slot);
  const plan = planRenumberInstrument(doc, slot, 0x40);
  assert.ok(!plan.error, plan.error);
  doc.undo.apply(renumberInstrumentOp(plan));
  assert.equal(doc.lyricEntry(slot), null);
  assert.deepEqual(doc.lyricEntry(0x40).syllables, want.syllables);
  doc.undo.undo();
  assert.deepEqual(doc.lyricEntry(slot), want);
  const del = planDeleteInstrument(doc, slot);
  assert.ok(!del.error, del.error);
  doc.undo.apply(deleteInstrumentOp(del));
  assert.equal(doc.lyricMap().entries.size, 0, "the entry goes with the instrument");
  doc.undo.undo();
  assert.deepEqual(doc.lyricEntry(slot), want);
});

test("deleting the sample a lyric consonant reads leaves the consonant on the generator", () => {
  const { doc, slot } = lyricProject();
  const noise = doc.sampleList().find((e) => e.ptr === NOISE.ptr);
  doc.undo.apply(cleanupBankOp(planDeleteSample(doc, noise)));
  const r = doc.lyricEntry(slot).recipes[0];
  assert.deepEqual([r.cons, r.ptr, r.len], [id("s"), 0, 0]);
  doc.undo.undo();
  assert.equal(doc.lyricEntry(slot).recipes[0].ptr, NOISE.ptr);
});

test("defragmenting the pool moves a lyric recipe with its sample", () => {
  const { doc, slot } = lyricProject();
  doc.undo.apply(cleanupBankOp(planDeleteSample(doc, doc.sampleList().find((e) => e.ptr === SQUARE.ptr))));
  // Something below the noise has to go for it to move: the saw's own instrument.
  const plan = planPoolDefrag(doc);
  assert.ok(!plan.error, plan.error);
  if (!plan.noop) doc.undo.apply(importBankOp(plan));
  const r = doc.lyricEntry(slot).recipes[0];
  assert.ok(doc.sampleList().some((e) => e.ptr === r.ptr && e.len === r.len), "it still names a census sample");
  const bytes = doc.sampleBin.subarray(r.ptr, r.ptr + 64);
  const want = lyricProject().doc.sampleBin.subarray(NOISE.ptr, NOISE.ptr + 64);
  assert.deepEqual([...bytes], [...want], "the bytes moved with the pointer");
});

test("an imported or duplicated lyric instrument has its lyrics, its recipes on the copied samples", () => {
  const { doc, slot } = lyricProject();
  const dest = lyricProject().doc;
  dest.sampleBin.fill(7, NOISE.ptr, NOISE.ptr + NOISE.len); // nothing dedupes onto the old noise
  const plan = planImport(dest, doc, [slot]);
  assert.ok(!plan.error, plan.error);
  dest.undo.apply(importBankOp(plan));
  const to = plan.slotMap.get(slot);
  const e = dest.lyricEntry(to);
  assert.deepEqual(e.syllables, doc.lyricEntry(slot).syllables);
  const r = e.recipes[0];
  assert.notEqual(r.ptr, NOISE.ptr);
  assert.deepEqual([...dest.sampleBin.subarray(r.ptr, r.ptr + 64)], [...doc.sampleBin.subarray(NOISE.ptr, NOISE.ptr + 64)]);
  assert.ok(dest.lyricEntry(slot), "the destination's own lyric instrument keeps its lyrics");
  const dup = planDuplicateInstruments(doc, [slot]);
  assert.ok(!dup.error, dup.error);
  doc.undo.apply(importBankOp(dup));
  const copy = dup.duplicates[0].destSlot;
  assert.deepEqual(doc.lyricEntry(copy).syllables, doc.lyricEntry(slot).syllables);
  assert.equal(doc.lyricEntry(copy).recipes[0].ptr, NOISE.ptr, "a copy shares the samples");
});

test("a save retires the lyrics of a slot that is no longer a formant instrument", () => {
  const { doc, slot } = lyricProject();
  doc.instruments[slot].loadRecord(plainRecord(SAW));
  doc.markInstUsed(slot);
  const again = new Document(parseTaud(doc.toBytes()));
  assert.equal(again.lyricMap().entries.size, 0);
  assert.equal(again.projSections.some((s) => s.fourcc === "ILyr"), false);
});

test("DocSync sends the lyrics to the engine on a lyrics edit, a bank change and a load", () => {
  const { doc, slot } = lyricProject();
  const calls = [];
  const audio = new Proxy({}, { get: (_, name) => (...args) => { calls.push([name, args]); } });
  const sync = new DocSync(audio, doc, 0);
  const undo = new UndoStack(doc, (tags) => sync.onDirty(tags));
  const e = doc.lyricEntry(slot);
  undo.apply(setLyricsOp(doc.lyricPayloadWith(slot, { ...e, syllables: e.syllables.slice(0, 1) })));
  const sent = calls.filter(([n]) => n === "setLyrics");
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1][0][0].syllables.length, 1);
  sync.loadAll();
  const load = calls.find(([n]) => n === "loadDocument");
  assert.equal(load[1][0].lyrics.length, 1);
});

// ── reading the lyrics ───────────────────────────────────────────────────

test("lyrics split on spaces, full stops, hyphens and stress marks", () => {
  assert.deepEqual(lyricTokens("de.zi gim-mi  ˈsa").map((t) => t.text), ["de", "zi", "gim", "mi", "sa"]);
  assert.deepEqual(lyricTokens("de.zi \"sa%ri", true).map((t) => t.text), ["de", "zi", "sa", "ri"]);
  const { syllables, errors } = readLyrics("ba.q!a.n");
  assert.equal(syllables.length, 2);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].index, 1);
  assert.equal(errors[0].at, 3);
});

test("a syllable with no vowel holds its consonant without the syllabic mark", () => {
  const rec = new F.FormantPatch();
  const { entry } = deriveLyrics(rec, { text: "n.ps.ɚ", overrides: [] });
  const [n, ps, er] = entry.syllables;
  assert.equal(n.vowel, false);
  assert.deepEqual(n.cons, [id("n"), 0, 0]);
  assert.equal(ps.vowel, false);
  assert.deepEqual(ps.cons, [id("p"), id("s"), 0], "the last consonant is the peak when none is a sonorant");
  assert.equal(er.vowel, true);
  assert.equal(er.gr & 0x80, 0x80, "[ɚ] is r-coloured");
});

test("with an error nothing is derived", () => {
  const r = deriveLyrics(new F.FormantPatch(), { text: "la.q!", overrides: [] });
  assert.equal(r.entry, null);
  assert.equal(r.errors.length, 1);
  assert.equal(deriveLyrics(new F.FormantPatch(), { text: " . ", overrides: [] }).entry, null, "no syllable");
});

test("a consonant's own length scales on top of the base; convergence draws every onset towards the median, both ways", () => {
  const rec = new F.FormantPatch();
  const text = "de.zi.de.zi.gim.mi.jɝ.an.sɝ.du.sta";
  const plain = deriveLyrics(rec, { text, overrides: [] }).entry.syllables;
  const longS = deriveLyrics(rec, { text, overrides: [{ cons: id("s"), timing: 192 }] }).entry.syllables;
  assert.deepEqual(longS[8].timing, [192, 128, 128, 128], "[s] in [sɝ]");
  assert.ok(onsetMs(rec, longS[8]) > onsetMs(rec, plain[8]));
  const before = plain.map((s) => onsetMs(rec, s));
  const has = before.filter((x) => x > 0).sort((a, b) => a - b);
  const median = has.length % 2 ? has[has.length >> 1] : (has[(has.length >> 1) - 1] + has[has.length >> 1]) / 2;
  assert.equal(median, medianOnset(before));
  assert.ok(before.some((x) => x > median + 5) && before.some((x) => x > 0 && x < median - 5), "the test lyrics need both sides");

  const at = (converge) => deriveLyrics(rec, { text, converge, overrides: [] });
  const zero = at(0);
  assert.deepEqual(zero.entry.syllables, plain, "0: as spoken");
  assert.deepEqual(zero.natural, before);
  for (const p of [40, 100]) {
    const r = at(p);
    assert.equal(r.median, median);
    r.entry.syllables.forEach((s, i) => {
      const ms = onsetMs(rec, s);
      assert.equal(s.timing[2], 128, "the coda is never touched");
      if (before[i] === 0) { assert.equal(ms, 0); return; }
      const target = before[i] + (p / 100) * (median - before[i]);
      // One byte step is 2^(1/64) ≈ 1.1 %: the nearest step lands within it.
      assert.ok(Math.abs(ms - target) <= Math.max(1, before[i] * 0.02), `${p} %: syllable ${i + 1} ${ms} ms, aimed at ${target}`);
      if (before[i] > median + 1) assert.ok(ms < before[i], `${p} %: syllable ${i + 1} shortened`);
      if (before[i] < median - 1) assert.ok(ms > before[i], `${p} %: syllable ${i + 1} lengthened`);
    });
  }
});

test("a syllable's own length: the convergence leaves it alone, and it is out of the median", () => {
  const rec = new F.FormantPatch();
  const text = "de.zi.de.zi.gim.mi.jɝ.an.sɝ.du.sta";
  const plain = deriveLyrics(rec, { text, overrides: [] });
  const own = [{ index: 10, timing: 128 }, { index: 2, timing: 160 }];
  const r = deriveLyrics(rec, { text, converge: 100, overrides: [], sylOverrides: own });
  assert.deepEqual(r.entry.editor.sylOverrides, [{ index: 2, timing: 160 }, { index: 10, timing: 128 }], "kept, in order");
  assert.deepEqual(r.entry.syllables[10], plain.entry.syllables[10], "[sta] at its own ×1: as spoken");
  assert.deepEqual(r.entry.syllables[2].timing, [160, 128, 128, 128], "[de] at its own length");
  assert.equal(r.median, medianOnset(plain.natural.filter((_, i) => i !== 2 && i !== 10)), "the median without them");
  const out = deriveLyrics(rec, { text, overrides: [], sylOverrides: [{ index: 99, timing: 10 }] });
  assert.deepEqual(out.entry.editor.sylOverrides, [], "one past the lyrics is dropped");
});

test("an edit of the lyrics keeps the syllables' own lengths on their syllables", () => {
  const own = [{ index: 0, timing: 100 }, { index: 3, timing: 150 }, { index: 5, timing: 170 }];
  const old = "a.b.c d.e.f";
  assert.deepEqual(remapSyllableOverrides(old, false, "x.a.b.c d.e.f", false, own),
    [{ index: 1, timing: 100 }, { index: 4, timing: 150 }, { index: 6, timing: 170 }], "a syllable put in front");
  assert.deepEqual(remapSyllableOverrides(old, false, "a.b.c d.e.f.g", false, own), own, "one put after");
  assert.deepEqual(remapSyllableOverrides(old, false, "a.b.c q.e.f", false, own), own, "one retyped in place");
  assert.deepEqual(remapSyllableOverrides(old, false, "a.b.c e.f", false, own),
    [{ index: 0, timing: 100 }, { index: 4, timing: 170 }], "the one taken out goes with it");
});

test("X-SAMPA lyrics read as their IPA do, and the notation switch converts both ways", () => {
  const rec = new F.FormantPatch();
  const ipa = deriveLyrics(rec, { text: "t͡ʃa.kʰo.ŋ̍.jɝ", overrides: [] }).entry.syllables;
  const xs = ipaToXsampa("t͡ʃa.kʰo.ŋ̍.jɝ");
  assert.ok(xs.ok);
  const viaX = deriveLyrics(rec, { text: xs.text, xsampa: true, overrides: [] }).entry.syllables;
  assert.deepEqual(viaX, ipa);
  assert.equal(xsampaToIpa("t_Sa"), "t͡ʃa");
});

test("pattern entry: a note goes on with the lyrics unless it starts the lane's", () => {
  const cell = (note = 0, instrment = 0) => ({ note, instrment });
  const rows = [cell(0x4000, 5), cell(), cell(0x4400), cell(), cell(0x4000, 7), cell(0x4400)];
  assert.equal(lyricContinues(rows, 0, 5), false, "nothing above: the first syllable");
  assert.equal(lyricContinues(rows, 1, 5), true, "this instrument's number above");
  assert.equal(lyricContinues(rows, 3, 5), true, "…past a note without one");
  assert.equal(lyricContinues(rows, 5, 5), false, "another instrument's number above");
  assert.equal(lyricContinues([cell(), cell(0x4000), cell()], 2, 5), true, "a note above, sung by what the lane was playing");
});
