// AudioSystem pattern high-water blanking (item 174): the engine keeps ONE
// persistent pattern store across document loads, exactly as its cueSheet
// does (audio-cue-highwater.test.js) — so a shorter song loading over a
// longer one must blank the stale tail, or a cue reaching a pattern slot the
// new song never re-uploads can still play the previous song's rows.

import { test } from "node:test";
import assert from "node:assert/strict";

import { AudioSystem } from "../../src/audio/audio-system.js";
import { CMD } from "../../src/worklet/protocol.js";
import { TaudEngine } from "../../src/engine/engine.js";

/** A doc-shaped stub with `n` patterns, each one byte `i` repeated. */
function fakeDoc(n) {
  const patterns = [];
  for (let i = 0; i < n; i++) patterns.push(new Uint8Array(512).fill(i & 0xff));
  return {
    is64Channel: false,
    sampleInstImage: null,
    ixmp: [],
    songs: [{
      patterns, cues: [],
      bpm: 120, tickRate: 6, globalFlags: 0, globalVolume: 0x80, mixingVolume: 0x80,
    }],
  };
}

/** Load a doc through a mocked engine target; return the pattern-touching messages. */
function patternMsgs(sys, doc) {
  const msgs = [];
  sys.engineTarget = { postMessage: (m) => msgs.push(m) };
  sys.loadDocument(doc, 0);
  return msgs.filter((m) => m.t === CMD.UPLOAD_PATTERNS || m.t === CMD.CLEAR_PATTERN);
}

test("loadDocument tracks the pattern high-water mark", () => {
  const sys = new AudioSystem();
  patternMsgs(sys, fakeDoc(100));
  assert.equal(sys._patternHighWater, 100);
  // uploadPattern past the mark raises it (pattern-edit dirty-flush path)
  sys.engineTarget = { postMessage: () => {} };
  sys.uploadPattern(500, new Uint8Array(512));
  assert.equal(sys._patternHighWater, 501);
});

test("a shorter song loading over a longer one blanks the stale tail", () => {
  const sys = new AudioSystem();
  patternMsgs(sys, fakeDoc(200));       // doc A: 200 patterns
  const msgs = patternMsgs(sys, fakeDoc(20)); // doc B: 20 patterns

  const bulk = msgs.find((m) => m.t === CMD.UPLOAD_PATTERNS);
  assert.deepEqual(bulk.slots, Array.from({ length: 20 }, (_, i) => i));
  const cleared = msgs.filter((m) => m.t === CMD.CLEAR_PATTERN).map((m) => m.slot);
  assert.deepEqual(cleared, Array.from({ length: 180 }, (_, i) => i + 20),
    "20..199 (A's stale tail) are cleared back to unallocated");
  assert.equal(sys._patternHighWater, 20, "high-water follows the current song");
});

test("a longer song loading over a shorter one needs no blanking", () => {
  const sys = new AudioSystem();
  patternMsgs(sys, fakeDoc(20));
  const msgs = patternMsgs(sys, fakeDoc(200));
  assert.equal(msgs.filter((m) => m.t === CMD.CLEAR_PATTERN).length, 0);
  assert.equal(sys._patternHighWater, 200);
});

test("clearPattern deallocates the engine's slot (patternRead falls back to empty)", () => {
  const eng = new TaudEngine();
  const bytes = new Uint8Array(512).fill(0x42);
  eng.uploadPattern(9, bytes);
  assert.notEqual(eng.patternRead(9), eng.emptyPattern);
  eng.clearPattern(9);
  assert.equal(eng.patternRead(9), eng.emptyPattern);
});
