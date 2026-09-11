// TaudProcessor — AudioWorkletProcessor with two modes:
//
//   RENDER mode (non-isolated fallback): hosts the TaudEngine and renders
//     engine-rate U8/float chunks into a local FIFO ring, reading them back
//     with a fractional resample cursor. This is the original single-thread path.
//
//   CONSUME mode (Tier 2, crossOriginIsolated): the engine lives in a separate
//     render Worker that fills a SharedArrayBuffer audio ring; process() only
//     resamples + copies from that ring, so it can never overrun. Entered on
//     CMD.USE_AUDIO_SAB; no engine commands are routed here in this mode.
//
// The engine renders at SAMPLING_RATE — 48 kHz since item 108, which is the
// rate audio-system.js asks the AudioContext for, so the common case reads the
// ring back one frame at a time with no interpolation at all (step === 1: a
// straight copy, not even a kernel). A context that insists on another rate
// (44.1 kHz hardware) is served by a fractional cursor reading through the
// Kaiser-windowed sinc in audio/resampler.js — the same kernel the exporters
// and the sample Lab use. That kernel needs `lead` frames AHEAD of the cursor,
// so both modes buffer that much extra look-ahead. Loaded via
// audioWorklet.addModule() as an ES module; the committed single-file concat
// (taud-processor.bundle.js) is the non-module-worklet fallback — regenerate
// with tools/make-worklet-bundle.js after any change here.

import { TaudEngine } from "../engine/engine.js";
import { SAMPLING_RATE, TRACKER_CHUNK } from "../engine/constants.js";
import { CMD, MSG, SNAP_FLOATS, SNAP_SAB_I32_CELLS } from "./protocol.js";
import {
  applyAudioCommand, isTransportReset, invertMaskBuffer, modMaskBuffer, fillSnapshotInto,
  drainInterruptsInto,
} from "./engine-commands.js";
import {
  audioRingViews, AR_MASK, AR_WRITE, AR_READ, AR_STATE, AR_EPOCH, AR_FLUSH_POS,
} from "../audio/audio-ring.js";
import { kaiserKernel } from "../audio/resampler.js";

const RING_FRAMES = 4096; // power of two (render-mode local ring)

class TaudProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.engine = new TaudEngine();
    this.playhead = 0; // the browser player drives playhead 0

    this.chunk = new Uint8Array(TRACKER_CHUNK * 2);
    this.ringL = new Float32Array(RING_FRAMES);
    this.ringR = new Float32Array(RING_FRAMES);
    this.ringWrite = 0;      // absolute frame counter (wraps via mask)
    this.ringReadPos = 0.0;  // fractional absolute read cursor
    this.ringFloor = 0;      // oldest frame the kernel may read (flush barrier)
    this.step = SAMPLING_RATE / sampleRate; // 1.0 at a 48 kHz context
    // null at a matching context rate — then a frame is a frame and the read
    // loops copy. Otherwise the sinc kernel both read cursors run through.
    this.rs = this.step === 1.0 ? null : kaiserKernel(SAMPLING_RATE, sampleRate);

    // CONSUME mode (Tier 2): audio-ring SAB views + wrap-safe read cursor.
    this.audioRing = null;
    this.arEpoch = -1;       // forces a re-sync on the first callback
    this.arReadBase = 0;     // Int32-wrapping integer read frame
    this.arReadFrac = 0.0;   // 0..1 fractional accumulator
    this.arFloor = 0;        // ditto, on the SAB ring's wrapping counter

    const opts = options?.processorOptions ?? {};
    this.snapshotIntervalFrames =
      Math.max(1, Math.round(((opts.snapshotIntervalMs ?? 16) / 1000) * sampleRate));
    this.framesSinceSnapshot = 0;
    // Recycled snapshot buffers (transferred out, posted back via SNAPSHOT_RETURN).
    this.snapshotPool = [
      new ArrayBuffer(SNAP_FLOATS * 4),
      new ArrayBuffer(SNAP_FLOATS * 4),
    ];
    // SAB fast path (CMD.USE_SAB): write snapshots straight into shared memory.
    this.sabF32 = null;
    this.sabI32 = null;

    // ── dev profiler (opt-in via processorOptions.profile; zero cost when off) ──
    // Times the whole process() callback (the true xrun predictor) AND the
    // engine.renderChunk DSP alone. In CONSUME mode renderChunk is never called,
    // so renderCount≈0 — which is exactly the point: the audio thread stops
    // rendering. Reports rolling stats to the main thread ≈ once per second.
    this.profiling = !!opts.profile;
    // AudioWorkletGlobalScope does not reliably expose performance.now on older
    // iPad Safari — feature-detect and fall back to the 1 ms-resolution
    // Date.now, reporting which clock is live so the numbers stay interpretable.
    const hasPerf = (typeof performance !== "undefined" && typeof performance.now === "function");
    this.clockNow = hasPerf ? () => performance.now() : () => Date.now();
    this.hiResClock = hasPerf;
    this.clockResMs = hasPerf ? 0.005 : 1; // nominal resolution
    this.profileIntervalFrames = Math.max(1, Math.round(sampleRate)); // ≈ 1 s window
    this.pfReset();

    this.port.onmessage = (e) => this.onCommand(e.data);
    this.port.postMessage({ t: MSG.READY });
  }

  pfReset() {
    this.pfFrames = 0;
    this.pfProcBusy = 0; this.pfProcMax = 0; this.pfProcCount = 0; this.pfXruns = 0;
    this.pfRenderBusy = 0; this.pfRenderMax = 0; this.pfRenderCount = 0;
    this.pfPeakVoices = 0;
    this.pfUnderruns = 0; // CONSUME mode: callbacks starved while the producer was active
  }

  onCommand(m) {
    // Enter CONSUME mode: the worker owns the engine now; free ours (~8 MB).
    if (m.t === CMD.USE_AUDIO_SAB) {
      this.audioRing = audioRingViews(m.sab);
      this.engine = null;
      return;
    }
    if (this.audioRing) return; // consume mode: no engine commands routed here

    const eng = this.engine;
    if (applyAudioCommand(eng, m)) {
      // Transport reset (play/seek/stop): drop the local look-ahead ring's
      // buffered tail, or a block rendered against the OLD tracker state
      // leaks into the new playback (item 96) — render.worker.js's
      // flushRing/AR_EPOCH does the same job for the Tier 2 SAB path; this
      // mode never had the equivalent, since applyAudioCommand only touches
      // `eng`, not the processor's own ring pointers.
      if (isTransportReset(m.t)) this.flushRing();
      return;
    }
    switch (m.t) {
      case CMD.INIT:
        if (m.snapshotIntervalMs) {
          this.snapshotIntervalFrames =
            Math.max(1, Math.round((m.snapshotIntervalMs / 1000) * sampleRate));
        }
        break;
      case CMD.QUERY_INVERT_MASK: {
        const buf = invertMaskBuffer(eng, m.slot);
        const modBuf = modMaskBuffer(eng, m.slot);
        this.port.postMessage({
          t: MSG.INVERT_MASK, slot: m.slot, mask: buf,
          mod: eng.getInstrumentSampleMod(m.slot), modMask: modBuf,
        }, [buf, modBuf]);
        break;
      }
      case CMD.SNAPSHOT_RETURN:
        if (this.snapshotPool.length < 2) this.snapshotPool.push(m.buffer);
        break;
      case CMD.USE_SAB:
        this.sabF32 = new Float32Array(m.sab, 0, SNAP_FLOATS);
        this.sabI32 = new Int32Array(m.sab, SNAP_FLOATS * 4, SNAP_SAB_I32_CELLS);
        break;
    }
  }

  /** Discard whatever look-ahead audio is still queued (not yet read out) —
   *  it was rendered against the tracker state from BEFORE this transport
   *  reset. renderAndPlay re-fills from the current (already-reset) engine
   *  state starting exactly at the read cursor, so nothing is left to leak. */
  flushRing() {
    this.ringReadPos = this.ringWrite;
    // …and the sinc's history taps must not reach back across the cut either:
    // those frames are the discarded tail, and half a kernel of it would be
    // mixed into the first frames of the new playback.
    this.ringFloor = this.ringWrite;
  }

  renderIntoRing() {
    const t0 = this.profiling ? this.clockNow() : 0;
    const out = this.engine.renderChunk(this.playhead, this.chunk);
    if (this.profiling) {
      const dt = this.clockNow() - t0;
      this.pfRenderBusy += dt;
      if (dt > this.pfRenderMax) this.pfRenderMax = dt;
      this.pfRenderCount++;
      const ts0 = this.engine.playheads[this.playhead].trackerState;
      let nv = ts0.backgroundVoices.length;
      for (let i = 0; i < ts0.voices.length; i++) if (ts0.voices[i].active) nv++;
      if (nv > this.pfPeakVoices) this.pfPeakVoices = nv;
    }
    const mask = RING_FRAMES - 1;
    if (out === null) {
      for (let n = 0; n < TRACKER_CHUNK; n++) {
        const w = (this.ringWrite + n) & mask;
        this.ringL[w] = 0;
        this.ringR[w] = 0;
      }
    } else {
      // Feed the pre-dither Float32 mix bus directly — clean output, no 8-bit
      // dithering. (renderChunk still fills the dithered U8 `out` so the engine
      // stays bit-exact for the JVM-oracle conformance tests; playback ignores it.)
      const ts = this.engine.playheads[this.playhead].trackerState;
      const mL = ts.mixLeft;
      const mR = ts.mixRight;
      for (let n = 0; n < TRACKER_CHUNK; n++) {
        const w = (this.ringWrite + n) & mask;
        this.ringL[w] = mL[n];
        this.ringR[w] = mR[n];
      }
    }
    this.ringWrite += TRACKER_CHUNK;
  }

  assembleSnapshot() {
    if (this.sabF32 !== null) {
      // Shared-memory path: fill in place; interrupts accumulate in the
      // trailing Int32 cell until the main thread drains it atomically.
      fillSnapshotInto(this.engine, this.playhead, this.sabF32);
      drainInterruptsInto(this.engine, this.playhead, this.sabF32, this.sabI32);
      return;
    }
    const buffer = this.snapshotPool.pop();
    if (!buffer) return; // main thread slow returning — skip, never allocate
    const f = new Float32Array(buffer);
    fillSnapshotInto(this.engine, this.playhead, f);
    drainInterruptsInto(this.engine, this.playhead, f);
    this.port.postMessage({ t: MSG.SNAPSHOT, buffer }, [buffer]);
  }

  // RENDER mode: keep the local ring one chunk ahead, then read it out resampled.
  renderAndPlay(outL, outR, frames) {
    const ph = this.engine.playheads[this.playhead];
    const mask = RING_FRAMES - 1;
    const rs = this.rs;
    if (ph.isPlaying || ph.jamActive || this.ringReadPos < this.ringWrite) {
      // The last output frame's newest tap sits `lead` frames past its cursor.
      const lead = (rs === null ? 0 : rs.lead) + 2;
      while (this.ringWrite < this.ringReadPos + frames * this.step + lead) {
        if (ph.isPlaying || ph.jamActive) {
          this.renderIntoRing();
        } else {
          const w = this.ringWrite & mask;
          this.ringL[w] = 0;
          this.ringR[w] = 0;
          this.ringWrite += 1;
        }
      }
      if (rs === null) {
        const i0 = this.ringReadPos;
        for (let n = 0; n < frames; n++) {
          const a = (i0 + n) & mask;
          outL[n] = this.ringL[a];
          outR[n] = this.ringR[a];
        }
        this.ringReadPos = i0 + frames;
      } else {
        const { rows, deltas, phases, history, nTaps } = rs;
        const floor = this.ringFloor;
        for (let n = 0; n < frames; n++) {
          const pos = this.ringReadPos;
          const i0 = Math.floor(pos);
          const fp = (pos - i0) * phases;
          const p = fp | 0;
          const g = fp - p;
          const row = rows[p], dRow = deltas[p];
          const base = i0 - history;
          let l = 0.0, r = 0.0;
          for (let t = 0; t < nTaps; t++) {
            const src = base + t;
            const a = (src < floor ? floor : src) & mask;
            const w = row[t] + dRow[t] * g;
            l += this.ringL[a] * w;
            r += this.ringR[a] * w;
          }
          outL[n] = l;
          outR[n] = r;
          this.ringReadPos = pos + this.step;
        }
      }
    } else {
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
    }

    this.framesSinceSnapshot += frames;
    if (this.framesSinceSnapshot >= this.snapshotIntervalFrames) {
      this.framesSinceSnapshot = 0;
      this.assembleSnapshot();
    }
  }

  // CONSUME mode: read the worker's SAB ring resampled to the context rate.
  consumeFromRing(outL, outR, frames) {
    const { ctrl, L, R } = this.audioRing;
    // A transport reset (play/seek/stop) bumps the epoch and publishes a flush
    // mark — jump the read cursor there, dropping the stale buffered tail.
    const rs = this.rs;
    const epoch = Atomics.load(ctrl, AR_EPOCH) | 0;
    if (epoch !== this.arEpoch) {
      this.arEpoch = epoch;
      this.arReadBase = Atomics.load(ctrl, AR_FLUSH_POS) | 0;
      this.arReadFrac = 0;
      this.arFloor = this.arReadBase; // no history taps into the dropped tail
    }
    const write = Atomics.load(ctrl, AR_WRITE) | 0;
    const avail = (write - this.arReadBase) | 0;
    // …+ the frames the kernel's newest tap needs beyond the last read cursor.
    const need = Math.ceil(frames * this.step) + (rs === null ? 0 : rs.lead) + 2;
    if (avail < need) {
      // Silence, hold the cursor. If the PRODUCER is active (playing/jam) this
      // is a real dropout — the worker isn't refilling the ring in time; that is
      // the Tier 2 glitch signal the audio-thread xrun counter can no longer see.
      if (this.profiling && Atomics.load(ctrl, AR_STATE)) this.pfUnderruns++;
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
      Atomics.store(ctrl, AR_READ, this.arReadBase);
      return;
    }
    let base = this.arReadBase, frac = this.arReadFrac;
    const step = this.step;
    if (rs === null) {
      for (let n = 0; n < frames; n++) {
        const a = base & AR_MASK;
        outL[n] = L[a];
        outR[n] = R[a];
        base = (base + 1) | 0;
      }
    } else {
      const { rows, deltas, phases, history, nTaps } = rs;
      const floor = this.arFloor;
      for (let n = 0; n < frames; n++) {
        const fp = frac * phases;
        const p = fp | 0;
        const g = fp - p;
        const row = rows[p], dRow = deltas[p];
        const first = (base - history) | 0;
        let l = 0.0, r = 0.0;
        for (let t = 0; t < nTaps; t++) {
          // Counters are Int32-wrapping, so "older than the floor" is a signed
          // DIFFERENCE, never a plain <.
          const src = (first + t) | 0;
          const a = (((src - floor) | 0) < 0 ? floor : src) & AR_MASK;
          const w = row[t] + dRow[t] * g;
          l += L[a] * w;
          r += R[a] * w;
        }
        outL[n] = l;
        outR[n] = r;
        frac += step;
        while (frac >= 1) { frac -= 1; base = (base + 1) | 0; }
      }
    }
    this.arReadBase = base;
    this.arReadFrac = frac;
    Atomics.store(ctrl, AR_READ, base);
  }

  emitProfile(quantumMs) {
    const audioMs = this.pfFrames / sampleRate * 1000;
    this.port.postMessage({
      t: MSG.PROFILE,
      cpuFrac: audioMs > 0 ? this.pfProcBusy / audioMs : 0,
      renderFrac: audioMs > 0 ? this.pfRenderBusy / audioMs : 0,
      procMeanMs: this.pfProcCount ? this.pfProcBusy / this.pfProcCount : 0,
      procMaxMs: this.pfProcMax,
      renderMeanMs: this.pfRenderCount ? this.pfRenderBusy / this.pfRenderCount : 0,
      renderMaxMs: this.pfRenderMax,
      quantumMs,
      xruns: this.pfXruns,
      underruns: this.pfUnderruns,
      procCount: this.pfProcCount,
      renderCount: this.pfRenderCount,
      peakVoices: this.pfPeakVoices,
      windowMs: audioMs,
      sampleRate,
      step: this.step,
      sab: this.sabF32 !== null || this.audioRing !== null,
      workerRender: this.audioRing !== null,
      hiResClock: this.hiResClock,
      clockResMs: this.clockResMs,
    });
    this.pfReset();
  }

  process(_inputs, outputs) {
    const t0 = this.profiling ? this.clockNow() : 0;
    const outL = outputs[0][0];
    const outR = outputs[0].length > 1 ? outputs[0][1] : outputs[0][0];
    const frames = outL.length;

    if (this.audioRing) {
      this.consumeFromRing(outL, outR, frames);
    } else {
      this.renderAndPlay(outL, outR, frames);
    }

    if (this.profiling) {
      // Measure the whole callback — the work the audio thread must finish
      // within one quantum. The report post itself is excluded (dt before emit).
      const dt = this.clockNow() - t0;
      this.pfProcBusy += dt;
      if (dt > this.pfProcMax) this.pfProcMax = dt;
      this.pfProcCount++;
      const quantumMs = frames / sampleRate * 1000;
      if (dt > quantumMs) this.pfXruns++;
      this.pfFrames += frames;
      if (this.pfFrames >= this.profileIntervalFrames) this.emitProfile(quantumMs);
    }
    return true;
  }
}

registerProcessor("taud-processor", TaudProcessor);
