// taudplay's AudioWorkletProcessor — the whole audio side of the library.
//
// It hosts a TaudEngine, renders engine-rate frames into a look-ahead ring and
// reads them back through a fractional cursor, exactly as Microtone's own
// render mode does; the resampler is a no-op at a 48 kHz context, which is what
// the library asks for. What it does NOT have is Microtone's second tier: no
// SharedArrayBuffer, no render Worker, no COOP/COEP requirement. One thread on
// any host that can open an AudioContext — and for a host whose AudioWorklet
// cannot import ES modules, the generated single-file concat of this exact
// graph (worklet.bundle.js) instead.
//
// The one piece of machinery that is here and NOT in Microtone is the fader
// ramp. The engine's per-voice fader is a plain byte applied straight to the
// gain, so a game moving it every animation frame would step the gain 60 times
// a second and zipper audibly. Ramping it here — once per rendered chunk, which
// is every 2.7 ms at 48 kHz — makes "fade this voice out over two seconds" a
// single call that sounds like a fade instead of a staircase, and it costs the
// engine nothing: the byte the mixer reads is still just a byte.

import { TaudEngine } from "../engine/engine.js";
import { SAMPLING_RATE, TRACKER_CHUNK } from "../engine/constants.js";
import { displayPanByte } from "../engine/spatial.js";
import { loadIntoEngine } from "../audio/offline-render.js";
import { FaderBank } from "./faders.js";
import { kaiserKernel } from "../audio/resampler.js";
import {
  CMD, MSG,
  SNAP_PLAYING, SNAP_CUE, SNAP_ROW, SNAP_BPM, SNAP_TICK_RATE, SNAP_CHANNELS,
  SNAP_SONG_INDEX, SNAP_HEADER,
  SNAP_V_ACTIVE, SNAP_V_VOLUME, SNAP_V_PAN, SNAP_V_STRIDE,
  SNAP_VOICES, SNAP_FLOATS,
} from "./protocol.js";

const RING_FRAMES = 4096; // power of two

class TaudPlayProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.engine = new TaudEngine();
    this.doc = null;
    this.songIndex = 0;

    this.chunk = new Uint8Array(TRACKER_CHUNK * 2); // the engine's U8 output, unused
    this.ringL = new Float32Array(RING_FRAMES);
    this.ringR = new Float32Array(RING_FRAMES);
    this.ringWrite = 0;     // absolute frame counter (wraps via mask)
    this.ringReadPos = 0.0; // fractional absolute read cursor
    this.ringFloor = 0;     // oldest frame the kernel may read (flush barrier)
    this.step = SAMPLING_RATE / sampleRate;
    this.rs = this.step === 1.0 ? null : kaiserKernel(SAMPLING_RATE, sampleRate);

    this.faders = new FaderBank();

    const opts = options?.processorOptions ?? {};
    this.snapshotIntervalFrames =
      Math.max(1, Math.round(((opts.snapshotIntervalMs ?? 16) / 1000) * sampleRate));
    this.framesSinceSnapshot = 0;
    this.snapshotPool = [
      new ArrayBuffer(SNAP_FLOATS * 4),
      new ArrayBuffer(SNAP_FLOATS * 4),
    ];

    this.port.onmessage = (e) => this.onCommand(e.data);
    this.port.postMessage({ t: MSG.READY });
  }

  onCommand(m) {
    const eng = this.engine;
    switch (m.t) {
      case CMD.LOAD:
        this.doc = m.doc;
        this.uploadSong(m.songIndex | 0);
        break;
      case CMD.SELECT_SONG:
        this.uploadSong(m.songIndex | 0);
        break;
      case CMD.PLAY:
        eng.resetSampleFxState(0);
        eng.setCuePosition(0, 0);
        eng.setTrackerRow(0, 0);
        eng.play(0);
        this.flushRing();
        break;
      case CMD.STOP:
        eng.stop(0);
        this.flushRing();
        break;
      case CMD.SEEK_CUE:
        eng.setCuePosition(0, Math.max(0, m.cue | 0));
        eng.setTrackerRow(0, 0);
        this.flushRing();
        break;
      case CMD.SET_VOLUME:
        eng.setMasterVolume(0, m.volume & 255);
        break;
      case CMD.SET_MONITOR:
        eng.setMonitorMode(0, m.mode | 0);
        break;
      case CMD.SET_FADER:
        this.faders.set(m.voice | 0, m.value, m.samples | 0);
        this.faders.writeInto(eng.playheads[0].trackerState);
        break;
      case CMD.SNAPSHOT_RETURN:
        if (this.snapshotPool.length < 2) this.snapshotPool.push(m.buffer);
        break;
    }
  }

  /** Re-run the whole upload sequence for `songIndex` off the retained doc.
   *  Faders survive a song switch — a game's mix is its own state, not the
   *  file's — so they are re-applied to the freshly loaded voices. */
  uploadSong(songIndex) {
    if (this.doc === null) return;
    if (songIndex < 0 || songIndex >= this.doc.songs.length) return;
    this.songIndex = songIndex;
    this.engine.stop(0);
    loadIntoEngine(this.engine, this.doc, songIndex);
    this.faders.dirty = true; // a fresh upload zeroed the voices' faders
    this.faders.writeInto(this.engine.playheads[0].trackerState);
    this.flushRing();
    this.port.postMessage({
      t: MSG.LOADED, songIndex, channelCount: this.engine.channelCount(),
    });
  }

  /** Drop look-ahead rendered against the pre-seek tracker state. */
  flushRing() {
    this.ringReadPos = this.ringWrite;
    this.ringFloor = this.ringWrite;
  }

  renderIntoRing() {
    this.faders.advance(TRACKER_CHUNK);
    this.faders.writeInto(this.engine.playheads[0].trackerState);
    const out = this.engine.renderChunk(0, this.chunk);
    const mask = RING_FRAMES - 1;
    if (out === null) {
      for (let n = 0; n < TRACKER_CHUNK; n++) {
        const w = (this.ringWrite + n) & mask;
        this.ringL[w] = 0;
        this.ringR[w] = 0;
      }
    } else {
      // The pre-dither Float32 mix bus, not the dithered U8 the device would
      // emit: the 8-bit character belongs to the hardware, not to a web player.
      const ts = this.engine.playheads[0].trackerState;
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
    const buffer = this.snapshotPool.pop();
    if (!buffer) return; // main thread slow returning one — skip, never allocate
    const f = new Float32Array(buffer);
    const ph = this.engine.playheads[0];
    const ts = ph.trackerState;
    f[SNAP_PLAYING] = ph.isPlaying ? 1 : 0;
    f[SNAP_CUE] = ts.cuePos;
    f[SNAP_ROW] = ts.rowIndex;
    f[SNAP_BPM] = ph.bpm;
    f[SNAP_TICK_RATE] = ph.tickRate;
    f[SNAP_CHANNELS] = this.engine.channelCount();
    f[SNAP_SONG_INDEX] = this.songIndex;
    for (let vi = 0; vi < SNAP_VOICES; vi++) {
      const v = ts.voices[vi];
      const o = SNAP_HEADER + vi * SNAP_V_STRIDE;
      if (!v.active) {
        f[o + SNAP_V_ACTIVE] = 0;
        f[o + SNAP_V_VOLUME] = 0;
        f[o + SNAP_V_PAN] = 0.5;
        continue;
      }
      f[o + SNAP_V_ACTIVE] = 1;
      // The gain the mixer actually applies, fader included — which is the
      // point: a game fading a voice out watches its own fade on this probe.
      const effEnvVol = v.volEnvOn ? v.envVolMix : 1.0;
      const faderGain = (255 - v.fader) / 255.0;
      const ev = effEnvVol * v.fadeoutVolume * v.currentMixVolume * faderGain;
      f[o + SNAP_V_VOLUME] = ev < 0 ? 0 : ev > 1 ? 1 : ev;
      // Where it SOUNDS in the stereo image: a surround voice reports where the
      // monitor downmix puts it, and a metainstrument the mix-weighted mean of
      // its layers rather than layer 0's position.
      f[o + SNAP_V_PAN] = displayPanByte(ts, vi, v) / 255.0;
    }
    this.port.postMessage({ t: MSG.SNAPSHOT, buffer }, [buffer]);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const outL = out[0];
    const outR = out.length > 1 ? out[1] : out[0];
    const frames = outL.length;
    const ph = this.engine.playheads[0];
    const mask = RING_FRAMES - 1;
    const rs = this.rs;

    if (ph.isPlaying || this.ringReadPos < this.ringWrite) {
      const lead = (rs === null ? 0 : rs.lead) + 2;
      while (this.ringWrite < this.ringReadPos + frames * this.step + lead) {
        if (ph.isPlaying) {
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
        // Phase-interpolated Kaiser sinc — the same read Microtone's worklet
        // does, tap for tap, so a 44.1 kHz host hears the same thing here.
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
    return true;
  }
}

registerProcessor("taudplay-processor", TaudPlayProcessor);
