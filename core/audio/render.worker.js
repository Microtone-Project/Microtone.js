// Tier 2 render Worker — hosts the TaudEngine OFF the audio thread and streams
// engine-rate float frames into a SharedArrayBuffer ring the AudioWorklet reads.
// The audio callback then only resamples + copies, so it can never overrun
// regardless of lane count / voice load (the whole point of Tier 2). Only
// used when crossOriginIsolated (SAB available); the non-isolated fallback keeps
// the engine in the worklet (see taud-processor.js render mode).
//
// Self-clocked: every ~5 ms a tick tops the ring up to AR_HIGH_WATER and
// refreshes the snapshot on a ~16 ms wall cadence. Commands arrive by
// postMessage and are applied between ticks (single-threaded, so no lock vs the
// producer).
//
// The clock is an Atomics.wait on AR_DOORBELL, NOT a setInterval, and the
// event loop is handed back only when a message is already waiting in it. A
// worker whose event queue ever drains gets Firefox's idle-GC timer armed
// (dom/workers/WorkerPrivate.cpp): five seconds later it runs a NON-incremental
// SHRINKING GC, which also throws away every piece of JIT code — and later
// activity is deliberately not allowed to cancel that timer. A 5 ms interval
// drains the queue after every tick, so the engine was stalled every 5 s by a
// ~6 ms mark of its whole heap and then re-ran cold for a while, bailing out
// and recompiling: 10–21 ms wakes against a 32 ms ring on a Ryzen 9950X.
// Sleeping inside a task never drains the queue, so that timer is never armed.
// The main thread bumps the doorbell after each postMessage (AudioSystem), the
// wait wakes, and the handler for that message re-enters the clock.

import { TaudEngine } from "../engine/engine.js";
import { TRACKER_CHUNK } from "../engine/constants.js";
import { CMD, MSG, SNAP_FLOATS, SNAP_SAB_I32_CELLS } from "../worklet/protocol.js";
import {
  applyAudioCommand, isTransportReset, invertMaskBuffer, modMaskBuffer, fillSnapshotInto,
  drainInterruptsInto,
} from "../worklet/engine-commands.js";
import {
  audioRingViews, AR_FRAMES, AR_MASK,
  AR_WRITE, AR_READ, AR_STATE, AR_EPOCH, AR_FLUSH_POS, AR_DOORBELL, AR_HIGH_WATER,
} from "./audio-ring.js";

const PLAYHEAD = 0;
const PRODUCE_INTERVAL_MS = 5;

const engine = new TaudEngine();
const chunk = new Uint8Array(TRACKER_CHUNK * 2);

let ring = null;            // {ctrl, L, R}
let writeFrames = 0;        // authoritative producer cursor (Int32-wrapping)
let snapF32 = null, snapI32 = null;
let snapshotIntervalMs = 16;
let lastSnapshotMs = -1e9;
let timer = null;           // setInterval fallback — only where this agent may not block
let handled = 0;            // messages received; AR_DOORBELL counts the same ones as posted

// Atomics.wait throws, before it compares anything, in an agent that may not
// suspend. Every dedicated worker may, but an embedding that says otherwise
// keeps the old interval clock rather than a dead one.
const canBlock = (() => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 1, 0); return true; }
  catch { return false; }
})();

const now = () => (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();

// Transport reset (play/seek/stop): drop the buffered tail without a counter
// reset race — publish the current write frame as the flush mark and bump the
// epoch; the worklet jumps its read cursor there on the next callback.
function flushRing() {
  if (!ring) return;
  Atomics.store(ring.ctrl, AR_FLUSH_POS, writeFrames);
  Atomics.store(ring.ctrl, AR_EPOCH, (Atomics.load(ring.ctrl, AR_EPOCH) + 1) | 0);
}

function produceAudio() {
  if (!ring) return;
  const ph = engine.playheads[PLAYHEAD];
  const active = ph.isPlaying || ph.jamActive;
  Atomics.store(ring.ctrl, AR_STATE, active ? 1 : 0);
  if (!active) return;
  const read = Atomics.load(ring.ctrl, AR_READ);
  let occ = (writeFrames - read) | 0;
  while (occ < AR_HIGH_WATER && (AR_FRAMES - occ) >= TRACKER_CHUNK) {
    const out = engine.renderChunk(PLAYHEAD, chunk);
    if (out === null) {
      for (let n = 0; n < TRACKER_CHUNK; n++) { const w = (writeFrames + n) & AR_MASK; ring.L[w] = 0; ring.R[w] = 0; }
    } else {
      const ts = ph.trackerState;
      const mL = ts.mixLeft, mR = ts.mixRight;
      for (let n = 0; n < TRACKER_CHUNK; n++) { const w = (writeFrames + n) & AR_MASK; ring.L[w] = mL[n]; ring.R[w] = mR[n]; }
    }
    writeFrames = (writeFrames + TRACKER_CHUNK) | 0;
    Atomics.store(ring.ctrl, AR_WRITE, writeFrames);
    occ = (writeFrames - read) | 0;
  }
}

function maybeSnapshot(force) {
  if (!snapF32) return;
  const t = now();
  if (!force && t - lastSnapshotMs < snapshotIntervalMs) return;
  lastSnapshotMs = t;
  fillSnapshotInto(engine, PLAYHEAD, snapF32);
  drainInterruptsInto(engine, PLAYHEAD, snapF32, snapI32);
}

function tick() {
  produceAudio();
  maybeSnapshot(false);
}

/** Tick until the main thread has posted a message this worker has not read
 *  yet, then return so the event loop can deliver it — never with the queue
 *  empty. The tick comes first so a burst of messages (a song upload) still
 *  tops the ring up between them. A tick that throws is reported and the
 *  clock carries on, as the interval it replaced did. */
function clock() {
  const ctrl = ring.ctrl;
  for (;;) {
    try {
      tick();
    } catch (err) {
      console.error(err);
    }
    const posted = Atomics.load(ctrl, AR_DOORBELL);
    if (posted !== handled) return;
    Atomics.wait(ctrl, AR_DOORBELL, posted, PRODUCE_INTERVAL_MS);
  }
}

self.onmessage = (e) => {
  handled = (handled + 1) | 0;
  try {
    handleMessage(e.data);
  } catch (err) {
    // Reported now: the clock below may not return until the next message.
    console.error(err);
  }
  if (ring !== null && canBlock) clock();
};

function handleMessage(m) {
  if (applyAudioCommand(engine, m)) {
    if (isTransportReset(m.t)) flushRing();
    produceAudio();      // start filling immediately (low play/seek latency)
    maybeSnapshot(true); // reflect the new state (isPlaying, position) at once
    return;
  }
  switch (m.t) {
    case CMD.INIT:
      if (m.snapshotIntervalMs) snapshotIntervalMs = m.snapshotIntervalMs;
      break;
    case CMD.USE_SAB:
      snapF32 = new Float32Array(m.sab, 0, SNAP_FLOATS);
      snapI32 = new Int32Array(m.sab, SNAP_FLOATS * 4, SNAP_SAB_I32_CELLS);
      break;
    case CMD.USE_AUDIO_SAB:
      ring = audioRingViews(m.sab);
      if (!canBlock && timer === null) timer = setInterval(tick, PRODUCE_INTERVAL_MS);
      break;
    case CMD.QUERY_INVERT_MASK: {
      const buf = invertMaskBuffer(engine, m.slot);
      const modBuf = modMaskBuffer(engine, m.slot);
      self.postMessage({
        t: MSG.INVERT_MASK, slot: m.slot, mask: buf,
        mod: engine.getInstrumentSampleMod(m.slot), modMask: modBuf,
      }, [buf, modBuf]);
      break;
    }
  }
}

self.postMessage({ t: MSG.READY });
