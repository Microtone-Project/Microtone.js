// Tier 2 without shared memory (item 334): on a page that is not cross-origin
// isolated — the desktop apps' webviews — the render Worker posts its audio to
// the worklet over a MessagePort (CMD.USE_AUDIO_PORT, protocol.js
// AUDIO_PORT_MSG) instead of writing a SharedArrayBuffer ring, and the
// worklet's READ reports are its clock.
//
// This runs the REAL render.worker.js and the REAL TaudProcessor joined by a
// real MessageChannel: the worker module under a stub `self`, the processor
// under the three AudioWorkletGlobalScope globals (as worklet-ring.test.js
// does). Node delivers port messages as macrotasks, so `pump()` lets them flow
// between audio callbacks — what the audio thread's event loop does between
// render quanta.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";

import { CMD, MSG, AUDIO_PORT_MSG, SNAP_FLOATS, SNAP_FLAGS } from "../../core/worklet/protocol.js";
import { AR_HIGH_WATER, AP_REPORT_FRAMES } from "../../core/audio/audio-ring.js";
import { TRACKER_CHUNK } from "../../core/engine/constants.js";

globalThis.sampleRate = 48000;
globalThis.AudioWorkletProcessor = class {
  constructor() { this.port = { onmessage: null, postMessage() {} }; }
};
let TaudProcessor = null;
globalThis.registerProcessor = (name, cls) => { TaudProcessor = cls; };
await import("../../core/worklet/taud-processor.js");

// The worker module's `self`: what it posts to the main thread lands here. A
// snapshot is copied and handed back, as AudioSystem does — unless the test
// holds them.
const fromWorker = [];
const snapshots = [];
let holdSnapshots = false;
globalThis.self = {
  onmessage: null,
  postMessage(m) {
    fromWorker.push(m);
    if (m.t !== MSG.SNAPSHOT) return;
    snapshots.push(new Float32Array(m.buffer).slice());
    if (!holdSnapshots) queueMicrotask(() => toWorker({ t: CMD.SNAPSHOT_RETURN, buffer: m.buffer }));
  },
};
await import("../../core/audio/render.worker.js");
const toWorker = (m) => self.onmessage({ data: m });
assert.equal(fromWorker.shift()?.t, MSG.READY, "the worker says it has loaded");

const PATTERN_EMPTY = [0xff, 0x7f];

/** Instrument 1: a looping sawtooth-ish sample (not DC, so a misplaced or
 *  reordered frame shows), sustaining indefinitely. */
function sampleInstImage() {
  const SAMPLES = 8388608;
  const image = new Uint8Array(SAMPLES + 1024 * 256);
  for (let i = 0; i < 1000; i++) image[i] = (i * 37) & 0xff;
  const rec = image.subarray(SAMPLES + 256, SAMPLES + 512);
  const w16 = (o, v) => { rec[o] = v & 0xff; rec[o + 1] = (v >> 8) & 0xff; };
  w16(4, 1000); w16(6, 32000); w16(12, 1000);
  rec[14] = 1;    // forward loop
  rec[21] = 0x3f; // vol env node 0 = full
  rec[171] = 255; rec[196] = 255;
  return image;
}

function pattern(withNote) {
  const pat = new Uint8Array(512);
  for (let r = 0; r < 64; r++) { pat[r * 8 + 3] = 0xc0; pat[r * 8 + 4] = 0xc0; }
  if (withNote) { pat[0] = 0x00; pat[1] = 0x50; pat[2] = 1; }
  return pat;
}

function cue(patSlot) {
  const c = new Uint8Array(64);
  for (let ch = 0; ch < 32; ch++) { c[ch * 2] = PATTERN_EMPTY[0]; c[ch * 2 + 1] = PATTERN_EMPTY[1]; }
  c[0] = patSlot & 0xff; c[1] = (patSlot >> 8) & 0xff;
  return c;
}

/** The song as engine commands, sent the way AudioSystem sends them. */
function songCommands() {
  return [
    { t: CMD.UPLOAD_SAMPLE_INST_BLOB, image: sampleInstImage().buffer },
    { t: CMD.UPLOAD_PATTERN, slot: 0, bytes: pattern(true).buffer },
    { t: CMD.UPLOAD_PATTERN, slot: 1, bytes: pattern(false).buffer },
    { t: CMD.UPLOAD_CUE, idx: 0, bytes: cue(0).buffer },
    { t: CMD.UPLOAD_CUE, idx: 1, bytes: cue(1).buffer },
    { t: CMD.SET_BPM, ph: 0, bpm: 125 },
    { t: CMD.SET_TICK_RATE, ph: 0, rate: 6 },
    { t: CMD.SET_MASTER_VOLUME, ph: 0, volume: 255 },
  ];
}

const playFrom = (pos) => [
  { t: CMD.SET_CUE_POSITION, ph: 0, pos },
  { t: CMD.SET_TRACKER_ROW, ph: 0, row: 0 },
  { t: CMD.PLAY, ph: 0 },
];

async function pump(n = 4) { for (let i = 0; i < n; i++) await tick(); }

// The streaming pair, built once (the worker module is a singleton). Every
// READ the worklet posts is watched on the way past.
const streamer = new TaudProcessor({ processorOptions: {} });
const { port1, port2 } = new MessageChannel();
const reads = [];
const watched = port1.postMessage.bind(port1);
port1.postMessage = (m, transfer) => {
  if (m.t === AUDIO_PORT_MSG.READ) reads.push(m.read);
  watched(m, transfer);
};
streamer.onCommand({ t: CMD.USE_AUDIO_PORT, port: port1 });
toWorker({ t: CMD.USE_AUDIO_PORT, port: port2 });
toWorker({ t: CMD.INIT, snapshotIntervalMs: 16 });
for (const m of songCommands()) toWorker(m);
await pump();

const maxAbs = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

/** `quanta` audio callbacks of 128 frames, with the ports pumped between. */
async function stream(quanta) {
  const L = [], R = [];
  const outL = new Float32Array(128), outR = new Float32Array(128);
  for (let q = 0; q < quanta; q++) {
    await pump();
    streamer.process([], [[outL, outR]]);
    L.push(...outL); R.push(...outR);
  }
  return { L, R };
}

test.after(() => { port1.close(); port2.close(); });

test("the streamed audio is the in-worklet render's, frame for frame", async () => {
  // Reference: the same song rendered in the worklet itself (RENDER mode).
  const local = new TaudProcessor({ processorOptions: {} });
  local.onCommand({ t: CMD.INIT });
  for (const m of [...songCommands(), ...playFrom(0)]) local.onCommand(m);
  const want = [];
  const outL = new Float32Array(128), outR = new Float32Array(128);
  for (let q = 0; q < 120; q++) { local.process([], [[outL, outR]]); want.push(...outL); }

  for (const m of playFrom(0)) toWorker(m);
  streamer.profiling = true;
  streamer.pfReset();
  const got = await stream(140);
  const first = got.L.findIndex((v) => v !== 0);
  assert.ok(first >= 0 && first < 4 * 128, `the first block arrives within a few callbacks (frame ${first})`);
  const wantFirst = want.findIndex((v) => v !== 0);
  const a = got.L.slice(first, first + 120 * 128 - wantFirst - 512);
  const b = want.slice(wantFirst, wantFirst + a.length);
  assert.ok(maxAbs(b) > 0.05, "sanity: the reference is audible");
  assert.deepEqual(a, b, "the same frames, in the same order");
  assert.equal(streamer.pfUnderruns, 0, "a worker fed on time never lets the worklet run dry");
});

test("the worker keeps AR_HIGH_WATER queued and no more, paced by the READ reports", async () => {
  reads.length = 0;
  await stream(40);
  assert.ok(reads.length >= 40 * 128 / AP_REPORT_FRAMES - 2, `a READ every ${AP_REPORT_FRAMES} frames (${reads.length})`);
  const queued = streamer.ringWrite - streamer.ringReadPos;
  assert.ok(queued > 0 && queued <= AR_HIGH_WATER + TRACKER_CHUNK, `queued ${queued}`);
  for (let i = 1; i < reads.length; i++) assert.ok(reads[i] - reads[i - 1] >= AP_REPORT_FRAMES - 128);
});

test("a transport reset drops the queued tail at once", async () => {
  await stream(4);
  assert.ok(streamer.ringWrite - streamer.ringReadPos > 512, "sanity: a full queue of the loud cue");
  for (const m of playFrom(1)) toWorker(m); // the silent cue, without stopping first
  const got = await stream(6);
  assert.ok(maxAbs(got.L) < 1e-6 && maxAbs(got.R) < 1e-6, `the old cue leaked: ${maxAbs(got.L)}`);
});

test("stopping says IDLE: running dry is then no dropout, and the last snapshot says stopped", async () => {
  for (const m of playFrom(0)) toWorker(m);
  await stream(20);
  snapshots.length = 0;
  toWorker({ t: CMD.STOP, ph: 0 });
  streamer.pfReset();
  const got = await stream(20);
  assert.ok(maxAbs(got.L.slice(128)) < 1e-6, "silent after the stop");
  assert.equal(streamer.portActive, false, "the worklet was told the producer stopped");
  assert.equal(streamer.pfUnderruns, 0, "an empty queue after a stop is not a dropout");
  assert.ok(snapshots.length > 0, "the worker posts its snapshots to the main thread");
  const last = snapshots.at(-1);
  assert.equal(last.length, SNAP_FLOATS);
  assert.equal(last[SNAP_FLAGS] & 1, 0, "the latest snapshot shows the transport stopped");
});

test("a snapshot due while both buffers are out is sent when one comes back", async () => {
  holdSnapshots = true;
  fromWorker.length = 0;
  for (const m of playFrom(0)) toWorker(m);
  await stream(30); // several snapshots are due; none are returned
  const out = fromWorker.filter((m) => m.t === MSG.SNAPSHOT);
  assert.equal(out.length, 2, "two buffers, and no more until they come back");
  fromWorker.length = 0;
  toWorker({ t: CMD.STOP, ph: 0 });
  assert.equal(fromWorker.length, 0, "nothing to send it in");
  toWorker({ t: CMD.SNAPSHOT_RETURN, buffer: out[0].buffer });
  const owed = fromWorker.filter((m) => m.t === MSG.SNAPSHOT);
  assert.equal(owed.length, 1, "the owed snapshot went with the returned buffer");
  assert.equal(new Float32Array(owed[0].buffer)[SNAP_FLAGS] & 1, 0);
  holdSnapshots = false;
  toWorker({ t: CMD.SNAPSHOT_RETURN, buffer: owed[0].buffer });
  toWorker({ t: CMD.SNAPSHOT_RETURN, buffer: out[1].buffer });
});
