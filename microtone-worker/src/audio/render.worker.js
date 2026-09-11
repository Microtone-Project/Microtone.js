// Tier 2 render Worker — hosts the TaudEngine OFF the audio thread and streams
// engine-rate float frames into a SharedArrayBuffer ring the AudioWorklet reads.
// The audio callback then only resamples + copies, so it can never overrun
// regardless of channel count / voice load (the whole point of Tier 2). Only
// used when crossOriginIsolated (SAB available); the non-isolated fallback keeps
// the engine in the worklet (see taud-processor.js render mode).
//
// Self-clocked: a ~5 ms timer tops the ring up to AR_HIGH_WATER and refreshes
// the snapshot on a ~16 ms wall cadence. Commands arrive by postMessage and are
// applied between ticks (single-threaded, so no lock vs the producer) — we do
// NOT Atomics.wait here (that would freeze the message loop).

import { TaudEngine } from "../engine/engine.js";
import { TRACKER_CHUNK } from "../engine/constants.js";
import { CMD, MSG, SNAP_FLOATS, SNAP_SAB_I32_CELLS } from "../worklet/protocol.js";
import {
  applyAudioCommand, isTransportReset, invertMaskBuffer, modMaskBuffer, fillSnapshotInto,
  drainInterruptsInto,
} from "../worklet/engine-commands.js";
import {
  audioRingViews, AR_FRAMES, AR_MASK,
  AR_WRITE, AR_READ, AR_STATE, AR_EPOCH, AR_FLUSH_POS, AR_HIGH_WATER,
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
let timer = null;

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

self.onmessage = (e) => {
  const m = e.data;
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
      if (timer === null) timer = setInterval(tick, PRODUCE_INTERVAL_MS);
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
};

self.postMessage({ t: MSG.READY });
