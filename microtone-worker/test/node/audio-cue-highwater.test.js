// AudioSystem cue high-water blanking: the engine keeps ONE persistent cueSheet
// across document loads, so a shorter song loading over a longer one must blank
// the stale tail — otherwise a doc grown into that range (now reachable via the
// Cues view's full-range scroll) could replay the previous song's patterns.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AudioSystem } from "../../src/audio/audio-system.js";
import { CMD } from "../../src/worklet/protocol.js";

const CUE_EMPTY = 0x7fff;

/** A doc-shaped stub with `n` cues (cue i, lane 0 = pattern i, unless empty). */
function fakeDoc(n, { empties = false } = {}) {
  const cues = [];
  for (let i = 0; i < n; i++) {
    const w = new Uint16Array(64).fill(CUE_EMPTY);
    if (!empties) w[0] = i & 0x7fff;
    cues.push(w);
  }
  return {
    is64Channel: false,
    sampleInstImage: null,
    ixmp: [],
    songs: [{
      patterns: [new Uint8Array(512)],
      cues, bpm: 120, tickRate: 6, globalFlags: 0, globalVolume: 0x80, mixingVolume: 0x80,
    }],
  };
}

/** Load a doc through a mocked engine target; return the UPLOAD_CUE messages. */
function cuesUploaded(sys, doc) {
  const msgs = [];
  sys.engineTarget = { postMessage: (m) => msgs.push(m) };
  sys.loadDocument(doc, 0);
  return msgs.filter((m) => m.t === CMD.UPLOAD_CUE);
}

test("loadDocument tracks the cue high-water mark", () => {
  const sys = new AudioSystem();
  cuesUploaded(sys, fakeDoc(100));
  assert.equal(sys._cueHighWater, 100);
  // uploadCue past the mark raises it (Cues-view edit path)
  sys.engineTarget = { postMessage: () => {} };
  sys.uploadCue(500, new Uint8Array(64));
  assert.equal(sys._cueHighWater, 501);
});

test("a shorter song loading over a longer one blanks the stale tail", () => {
  const sys = new AudioSystem();
  cuesUploaded(sys, fakeDoc(200));       // doc A: 200 cues
  const uploads = cuesUploaded(sys, fakeDoc(20)); // doc B: 20 cues

  // 0..19 carry B's real cues; 20..199 are blanked to CUE_EMPTY; nothing beyond
  const byIdx = new Map(uploads.map((m) => [m.idx, new Uint8Array(m.bytes)]));
  assert.equal(byIdx.size, 200, "20 real + 180 blanking uploads");
  // a real cue (idx 5) is pattern 5
  assert.equal(byIdx.get(5)[0], 5);
  // a stale-tail cue (idx 150) is blanked (0x7FFF → bytes 0xFF, 0x7F)
  assert.equal(byIdx.get(150)[0], 0xff);
  assert.equal(byIdx.get(150)[1], 0x7f);
  assert.ok(!byIdx.has(200), "nothing past the old high-water");
  assert.equal(sys._cueHighWater, 20, "high-water follows the current song");
});

test("a longer song loading over a shorter one needs no blanking", () => {
  const sys = new AudioSystem();
  cuesUploaded(sys, fakeDoc(20));
  const uploads = cuesUploaded(sys, fakeDoc(200));
  assert.equal(uploads.length, 200, "just the 200 real cues, no extra blanks");
  assert.equal(sys._cueHighWater, 200);
});
