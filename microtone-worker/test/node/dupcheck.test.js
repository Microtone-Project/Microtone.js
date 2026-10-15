// Item 216 — Duplicate Check Type 4, Lane, and byte 195 as two nibbles.
//
// Two things to pin. (1) The byte: `0b AATT aatt`, each nibble split so that a
// record written when the fields were two bits each reads exactly as it did.
// (2) Lane: ANY note arriving on the lane is a duplicate, whatever instrument
// plays it and whether or not it names one — while types 1-3 keep asking only
// about a note that names its instrument, exactly as before.

import { test } from "node:test";
import assert from "node:assert/strict";

import { TaudEngine } from "../../core/engine/engine.js";
import { TRACKER_CHUNK, SAMPLING_RATE, setSamplingRate } from "../../core/engine/constants.js";
import { TaudInst, packDupCheck, DCT_LANE, buildMetaRecord, makeMetaLayer } from "../../core/engine/inst.js";

setSamplingRate(32000);

/** A looping single-cycle sine in `slot`; `nna`, `dct`, `dca` as the record says them. */
function uploadSine(eng, slot, ptr, { nna = 2, dct = 0, dca = 0 } = {}) {
  for (let i = 0; i < 256; i++) eng.sampleBin[ptr + i] = 128 + Math.round(120 * Math.sin((2 * Math.PI * i) / 256));
  const rec = new Uint8Array(256);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  rec[0] = ptr & 0xff; rec[1] = (ptr >> 8) & 0xff; rec[2] = (ptr >> 16) & 0xff;
  w16(4, 256); w16(6, 32000); w16(12, 256);
  rec[14] = 1;                        // forward loop
  rec[21] = 0x3f;
  rec[171] = 255;
  rec[182] = 0xff;                    // filter open
  rec[186] = nna & 0x03;
  rec[195] = packDupCheck(dct, dca);
  rec[196] = 255;
  eng.uploadInstrument(slot, rec);
}

function play(eng, rows) {
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  for (const c of rows) {
    const o = c.row * 8;
    pat[o] = c.note & 0xff; pat[o + 1] = (c.note >>> 8) & 0xff;
    if (c.inst !== undefined) pat[o + 2] = c.inst;
  }
  eng.uploadPattern(0, pat);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0; cue[1] = 0;
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125); eng.setTickRate(0, 6); eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0); eng.play(0);
  const CHUNKS_PER_ROW = ((SAMPLING_RATE * 2.5) / 125 / TRACKER_CHUNK) * 6;
  const last = Math.max(...rows.map((c) => c.row));
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  for (let i = 0; i < CHUNKS_PER_ROW * (last + 1) + 1; i++) eng.renderChunk(0, out);
  return eng.playheads[0].trackerState;
}

/** Background voices still sounding instrument `slot`. */
const ringing = (ts, slot) => ts.backgroundVoices.filter((v) => v.active && v.instrumentId === slot).length;

// ── the byte ─────────────────────────────────────────────────────────────

test("byte 195 is 0b AATT aatt, and every nibble pair round-trips", () => {
  assert.equal(packDupCheck(DCT_LANE, 0), 0x10, "Type 4 is the high pair's low bit");
  assert.equal(packDupCheck(0, 4), 0x40, "Action 4 likewise, two bits further up");
  assert.equal(packDupCheck(DCT_LANE, 1), 0x14, "Lane → Note Off");
  const inst = new TaudInst(1);
  for (let t = 0; t < 16; t++) {
    for (let a = 0; a < 16; a++) {
      inst.setByte(195, packDupCheck(t, a));
      assert.equal(inst.duplicateCheckType, t);
      assert.equal(inst.duplicateCheckAction, a);
      assert.equal(inst.getByte(195), packDupCheck(t, a));
    }
  }
});

test("a record from before the nibbles reads exactly as it did", () => {
  const inst = new TaudInst(1);
  for (let b = 0; b < 16; b++) {
    inst.setByte(195, b);
    assert.equal(inst.duplicateCheckType, b & 3);
    assert.equal(inst.duplicateCheckAction, (b >>> 2) & 3);
  }
});

// ── Lane ─────────────────────────────────────────────────────────────────

/** Instrument 1 sounds a note, Continue as its New Note Action, and then
 *  `second` arrives on the same lane. Does the first note ring on as a ghost? */
function afterSecond(dct, second) {
  const eng = new TaudEngine();
  uploadSine(eng, 1, 0, { dct, dca: 0 });   // …→ Note Cut
  uploadSine(eng, 2, 512);
  return ringing(play(eng, [{ row: 0, note: 0x5000, inst: 1 }, { row: 1, ...second }]), 1);
}

test("Lane: a note of ANOTHER instrument ends the old one", () => {
  const other = { note: 0x5400, inst: 2 };
  assert.equal(afterSecond(0, other), 1, "check off: the old note rings on under the new");
  assert.equal(afterSecond(3, other), 1, "Instrument: another instrument is no duplicate");
  assert.equal(afterSecond(DCT_LANE, other), 0, "Lane: any note on the lane is");
});

test("Lane: a note with no instrument byte ends the old one; types 1-3 are left as they were", () => {
  const bare = { note: 0x5400 };
  assert.equal(afterSecond(DCT_LANE, bare), 0, "Lane: a bare note is a note arriving on the lane");
  // A bare note was never checked against types 1-3, and is not now.
  assert.equal(afterSecond(3, bare), 1, "Instrument: a bare note is still not checked");
  assert.equal(afterSecond(3, { note: 0x5400, inst: 1 }), 0, "…though the same note naming its instrument is");
});

test("Lane reaches every voice the lane is sounding: a layered note's background layers too", () => {
  const layered = (dct) => {
    const eng = new TaudEngine();
    uploadSine(eng, 1, 0, { dct, dca: 0 });
    uploadSine(eng, 2, 512);
    eng.uploadInstrument(3, buildMetaRecord([
      makeMetaLayer(1, 159, 0, 0x0000, 0xffff, 0, 63),
      makeMetaLayer(1, 159, 0x0555, 0x0000, 0xffff, 0, 63),
    ]));
    const ts = play(eng, [{ row: 0, note: 0x5000, inst: 3 }, { row: 1, note: 0x5400, inst: 2 }]);
    return ringing(ts, 1);
  };
  assert.ok(layered(0) > 0, "check off: the layers ring on (Continue)");
  assert.equal(layered(DCT_LANE), 0, "Lane: both layers are ended by a note of another instrument");
});

test("Lane leaves other lanes alone", () => {
  const eng = new TaudEngine();
  uploadSine(eng, 1, 0, { dct: DCT_LANE, dca: 0 });
  uploadSine(eng, 2, 512);
  // Lane 1 holds instrument 1; the second note arrives on lane 0.
  const pat0 = new Uint8Array(512), pat1 = new Uint8Array(512);
  for (const p of [pat0, pat1]) for (let r = 0; r < 64; r++) { p[r * 8 + 3] = 0xc0; p[r * 8 + 4] = 0xc0; }
  pat1[0] = 0x00; pat1[1] = 0x50; pat1[2] = 1;
  pat0[8] = 0x00; pat0[9] = 0x54; pat0[10] = 2;
  eng.uploadPattern(0, pat0); eng.uploadPattern(1, pat1);
  const cue = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { cue[ch * 2] = 0xff; cue[ch * 2 + 1] = 0x7f; }
  cue[0] = 0; cue[1] = 0; cue[2] = 1; cue[3] = 0;
  eng.uploadCue(0, cue);
  eng.setBPM(0, 125); eng.setTickRate(0, 6); eng.setMasterVolume(0, 255);
  eng.setCuePosition(0, 0); eng.play(0);
  const out = new Uint8Array(TRACKER_CHUNK * 2);
  for (let i = 0; i < 2 * ((SAMPLING_RATE * 2.5) / 125 / TRACKER_CHUNK) * 6 + 1; i++) eng.renderChunk(0, out);
  const ts = eng.playheads[0].trackerState;
  assert.ok(ts.voices[1].active && ts.voices[1].instrumentId === 1, "lane 1's note sounds on");
});
