// The desktop's native audio host, from the page's side: the engine runs in
// the Qt shell on the audio device's own callback (desktop-qt/src/
// nativeaudio.h, enginehost.c), and the page drives it over a WebSocket the
// shell names in window.__MICROTONE_NATIVE__. AudioSystem uses this in place
// of the worklet and the render Worker; everything else on the page is
// unchanged: the same CMD protocol goes in, the same snapshot comes out.
//
// The host has no JavaScript, so every command is LOWERED here to what the C
// host API takes: integers through `| 0` and booleans to 0/1 exactly as the
// WebAssembly boundary converts them, and the structured parameters
// (mastering, mixing chains, lyrics, a jam sample's spec) encoded by the very
// functions WasmTaudEngine uses. A native engine is handed what a WebAssembly
// one is, argument for argument.
//
// The wire, little-endian:
//   page → host  frames: u8 name length, the CMD's name, u16 ints, u8 doubles,
//                u8 blobs, then the i32s, the f64s and (u32 length, bytes) per
//                blob; the frames of one turn of the page's event loop go as
//                one message, in order
//   host → page  u8 kind, 3 pad, then per NATIVE_MSG below
//
// Besides the engine's commands the page asks the host itself (the desktop
// Settings tab): HOST_DEVICES, every audio API's output devices; HOST_CONFIGURE,
// another output (a JSON blob), answered by a STATUS; HOST_PANEL, the open ASIO
// driver's own settings window, unanswered. A STATUS also comes unasked when
// the host reopened a device that went away (or whose driver asked for it).

import { CMD, MSG } from "../worklet/protocol.js";
import { engineSeed } from "../engine/rng.js";
import {
  engineLyricsSection, engineJamSampleSpec, engineAnalysisArgs, engineMasterMeterArgs,
  decodeEngineSampleMod, decodeEnginePsgState, decodeEngineFadeoutState, decodeEngineFmVibratoState,
  decodeEngineFormantState, ENGINE_FORMANT_VOICES, ENGINE_FORMANT_DOUBLES,
} from "../engine/wasm-engine.js";
import { buildMasteringBlock } from "../format/mastering-section.js";
import { buildImixSection } from "../format/imix-section.js";

/** What the host sends (nativeaudio.cpp). STATUS is first the hello. */
export const NATIVE_MSG = { STATUS: 0, SNAPSHOT: 1, INVERT_MASK: 2, PROFILE: 3, DEVICES: 4 };

/** An audio API's name as people know it (RtAudio's id → its own short
 *  display name otherwise). */
const API_NAMES = {
  pulse: "PulseAudio", alsa: "ALSA", jack: "JACK", wasapi: "WASAPI", asio: "ASIO", ds: "DirectSound",
  core: "Core Audio", oss: "OSS",
};
export function nativeApiName(id, fallback = id) { return API_NAMES[id] ?? fallback ?? ""; }

// What a reply's fixed parts hold (enginehost.c).
const SAMPLE_MOD_DOUBLES = 25;
const PSG_INTS = 8;
const FADEOUT_CAP = 16;
const FM_VIBRATO_CAP = 32;

const CMD_NAME = Object.fromEntries(Object.entries(CMD).map(([name, t]) => [t, name]));
const NO_BYTES = new Uint8Array(0);
const UTF8 = new TextEncoder();

const bytesOf = (b) => (b === null || b === undefined ? NO_BYTES : b instanceof Uint8Array ? b
  : ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b));

/**
 * One CMD message as the host's C takes it: { name, ints, doubles, blobs },
 * or null for what is not the engine's (the web transports' own plumbing).
 * Each case is the WasmTaudEngine method engine-commands.js calls for it.
 */
export function lowerCommand(m) {
  const name = CMD_NAME[m.t];
  const low = (ints = [], doubles = [], blobs = []) => ({ name, ints, doubles, blobs });
  switch (m.t) {
    case CMD.INIT: return low([engineSeed() | 0, (m.snapshotIntervalMs ?? 16) | 0]);
    case CMD.UPLOAD_SAMPLE_INST_BLOB: return low([], [], [bytesOf(m.image)]);
    case CMD.UPLOAD_INSTRUMENT:
    case CMD.UPLOAD_INSTRUMENT_PATCHES:
    case CMD.UPLOAD_PATTERN: return low([m.slot | 0], [], [bytesOf(m.bytes)]);
    case CMD.CLEAR_INSTRUMENT_PATCHES:
    case CMD.CLEAR_PATTERN: return low([m.slot | 0]);
    case CMD.UPLOAD_PATTERNS: return low(m.slots.map((s) => s | 0), [], [bytesOf(m.blob)]);
    case CMD.UPLOAD_CUE: return low([m.idx | 0], [], [bytesOf(m.bytes)]);
    case CMD.SET_64CH: return low([m.on ? 1 : 0]);
    case CMD.SET_CELL_FORMAT: return low([m.wide ? 1 : 0]);
    case CMD.SET_BPM: return low([m.bpm | 0]);
    case CMD.SET_TUNING: return low([m.baseNote | 0], [+m.freq]);
    case CMD.SET_TICK_RATE: return low([m.rate | 0]);
    case CMD.SET_SONG_GLOBAL_VOLUME:
    case CMD.SET_SONG_MIXING_VOLUME:
    case CMD.SET_MASTER_VOLUME: return low([m.volume | 0]);
    case CMD.SET_MASTER_PAN: return low([m.pan | 0]);
    case CMD.SET_TRACKER_MIXER_FLAGS: return low([m.flags | 0]);
    case CMD.SET_SURROUND_MODEL: return low([m.model | 0]);
    case CMD.SET_MONITOR_MODE: return low([m.mode | 0]);
    case CMD.SET_ANALYSIS: return low(engineAnalysisArgs(m.target));
    case CMD.SET_MASTERING:
      return low([], [], [m.params === null || m.params === undefined ? NO_BYTES : buildMasteringBlock(m.params)]);
    case CMD.SET_MASTER_METER: return low(engineMasterMeterArgs(m.on, m.scramble, m.bitDepth, m.histSpan));
    case CMD.SET_IMIX: {
      const b = m.blocks;
      const list = !b ? [] : b instanceof Map ? [...b.values()] : [...b];
      return low([], [], [buildImixSection(list) ?? NO_BYTES]);
    }
    case CMD.SET_LYRICS: return low([], [], [engineLyricsSection(m.entries)]);
    case CMD.SET_PITCH_EXT: return low([], [], [bytesOf(m.bytes)]);
    case CMD.SET_IMIX_METER: return low([m.slot | 0, (m.seat ?? 0) | 0]);
    case CMD.PLAY:
    case CMD.STOP:
    case CMD.RESET_PARAMS:
    case CMD.RESET_SAMPLE_FX_STATE:
    case CMD.JAM_STOP: return low();
    case CMD.SET_CUE_POSITION: return low([m.pos | 0]);
    case CMD.SET_TRACKER_ROW: return low([m.row | 0]);
    case CMD.CHASE_TRACKER_ROW: return low([m.cue | 0, m.row | 0]);
    case CMD.JAM_NOTE: return low([m.voice | 0, m.note | 0, m.inst | 0, m.audition ? 1 : 0]);
    case CMD.JAM_SAMPLE: return low([m.voice | 0, m.note | 0], [], [bytesOf(engineJamSampleSpec(m.spec))]);
    case CMD.JAM_STOP_VOICE:
    case CMD.JAM_KEY_OFF:
    case CMD.JAM_RELEASE: return low([m.voice | 0]);
    // setVoiceMute IS the fader: muted = 255.
    case CMD.SET_VOICE_MUTE: return { name: "SET_VOICE_FADER", ints: [m.voice | 0, m.muted ? 255 : 0], doubles: [], blobs: [] };
    case CMD.SET_VOICE_FADER: return low([m.voice | 0, m.fader | 0]);
    case CMD.QUERY_INVERT_MASK: return low([m.slot | 0]);
    case CMD.SET_PROFILE: return low([m.on ? 1 : 0]);
    default: return null; // SNAPSHOT_RETURN, USE_SAB, USE_AUDIO_SAB, USE_AUDIO_PORT
  }
}

/** Lowered commands as one message. */
export function encodeFrames(list) {
  let size = 0;
  const names = list.map((c) => UTF8.encode(c.name));
  list.forEach((c, i) => {
    size += 1 + names[i].length + 4 + c.ints.length * 4 + c.doubles.length * 8;
    for (const b of c.blobs) size += 4 + b.length;
  });
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let o = 0;
  list.forEach((c, i) => {
    if (c.ints.length > 0xffff || c.doubles.length > 0xff || c.blobs.length > 4) throw new Error(`native engine: ${c.name} too large`);
    out[o++] = names[i].length;
    out.set(names[i], o); o += names[i].length;
    dv.setUint16(o, c.ints.length, true); out[o + 2] = c.doubles.length; out[o + 3] = c.blobs.length; o += 4;
    for (const v of c.ints) { dv.setInt32(o, v, true); o += 4; }
    for (const v of c.doubles) { dv.setFloat64(o, v, true); o += 8; }
    for (const b of c.blobs) { dv.setUint32(o, b.length, true); o += 4; out.set(b, o); o += b.length; }
  });
  return out;
}

/** A SNAPSHOT message: the interrupts drained since the last one and the
 *  ranges of the snapshot that are current — { mask, args, ranges: [{from,
 *  floats}] }, `floats` views of the message. */
export function decodeSnapshot(buffer) {
  const dv = new DataView(buffer);
  const mask = dv.getUint32(4, true);
  const args = new Int32Array(16);
  for (let n = 0; n < 16; n++) args[n] = dv.getInt32(8 + n * 4, true);
  const count = dv.getUint32(72, true);
  const ranges = [];
  let at = 76 + count * 8;
  for (let i = 0; i < count; i++) {
    const from = dv.getUint32(76 + i * 8, true), n = dv.getUint32(80 + i * 8, true);
    ranges.push({ from, floats: new Float32Array(buffer, at, n) });
    at += n * 4;
  }
  return { mask, args, ranges };
}

/** An INVERT_MASK reply, decoded into the MSG.INVERT_MASK the render Worker
 *  posts (render.worker.js), by WasmTaudEngine's own decoders. */
export function decodeInvertMask(buffer) {
  const dv = new DataView(buffer);
  let o = 4;
  const i32 = () => { const v = dv.getInt32(o, true); o += 4; return v; };
  const ints = (n) => { const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = i32(); return a; };
  const doubles = (n) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) { a[i] = dv.getFloat64(o, true); o += 8; } return a; };
  const bytes = () => { const n = i32(); const b = buffer.slice(o, o + n); o += n; return b; };
  const slot = i32();
  const mask = bytes();
  const modMask = bytes();
  const mod = decodeEngineSampleMod(doubles(SAMPLE_MOD_DOUBLES));
  const psgOk = i32();
  const psg = ints(PSG_INTS);
  const fadeN = i32();
  const fade = ints(FADEOUT_CAP * 2);
  const vibN = i32();
  const vib = ints(FM_VIBRATO_CAP * 4);
  const formantOk = i32();
  const fv = doubles(ENGINE_FORMANT_VOICES * ENGINE_FORMANT_DOUBLES);
  const extra = ints(ENGINE_FORMANT_VOICES * 2);
  const counts = ints(2);
  const lyric = ints(i32());
  return {
    t: MSG.INVERT_MASK, slot, mask, modMask, mod,
    psg: psgOk ? decodeEnginePsgState(psg) : null,
    formant: formantOk ? decodeEngineFormantState(fv, extra, lyric, counts) : null,
    fadeout: decodeEngineFadeoutState(fade, fadeN),
    fmVibrato: decodeEngineFmVibratoState(vib, vibN),
  };
}

const textOf = (buffer) => new TextDecoder().decode(new Uint8Array(buffer, 4));

/** The page's end of the socket. */
export class NativeEngineLink {
  /**
   * Connect, and resolve once the host has said hello with a device open —
   * or to null (no host, a refusal, no device, `timeoutMs` gone by), in which
   * case the page plays through Web Audio as it would in a browser.
   */
  static connect(url, { timeoutMs = 3000 } = {}) {
    return new Promise((resolve) => {
      let ws;
      try {
        ws = new WebSocket(url);
      } catch {
        resolve(null);
        return;
      }
      ws.binaryType = "arraybuffer";
      const timer = setTimeout(() => { ws.close(); resolve(null); }, timeoutMs);
      ws.onerror = () => { clearTimeout(timer); resolve(null); };
      ws.onmessage = (e) => {
        clearTimeout(timer);
        const kind = new Uint8Array(e.data, 0, 1)[0];
        const hello = kind === NATIVE_MSG.STATUS ? JSON.parse(textOf(e.data)) : null;
        if (!hello?.ok) { ws.close(); resolve(null); return; }
        resolve(new NativeEngineLink(ws, hello));
      };
    });
  }

  constructor(ws, hello) {
    this.ws = ws;
    // The output as the host last said: { ok, api, apiId, device,
    // deviceChoice, rate, rateChoice, engineRate, bufferFrames, bufferMs,
    // latencyMs, realtime, error } (nativeaudio.cpp status()).
    this.hello = hello;
    this.onSnapshot = null;   // ({ mask, args, ranges }) per SNAPSHOT
    this.onMessage = null;    // MSG-shaped messages: INVERT_MASK, PROFILE
    this.onClose = null;
    this.onStatus = null;     // (status) whenever the output changes
    this._queue = [];
    this._flushQueued = false;
    this._waiting = { [NATIVE_MSG.STATUS]: [], [NATIVE_MSG.DEVICES]: [] };
    ws.onmessage = (e) => this._receive(e.data);
    ws.onclose = () => { if (this.onClose) this.onClose(); };
    ws.onerror = null;
  }

  get open() { return this.ws.readyState === WebSocket.OPEN; }

  /** AudioSystem posts here as it would to a Worker. */
  postMessage(m) {
    const low = lowerCommand(m);
    if (low === null) return;
    this._queue.push(low);
    if (!this._flushQueued) {
      this._flushQueued = true;
      queueMicrotask(() => this._flush());
    }
  }

  /** Every audio API the host has and its output devices: { apis: [{ id,
   *  name, devices: [{ name, isDefault, rates, preferredRate }] }], current }. */
  requestDevices() { return this._ask("HOST_DEVICES", null, NATIVE_MSG.DEVICES); }

  /** Another output: { api, device, rate, bufferFrames, mode } (device ""
   *  and rate 0 = the defaults; bufferFrames 0 = the driver's own size,
   *  where it has one). Resolves to the host's status once the device is
   *  open again — the asked-for one, or, with `error` said, the one before. */
  configure(config) { return this._ask("HOST_CONFIGURE", config, NATIVE_MSG.STATUS); }

  /** The open ASIO driver's settings window (status.driverPanel). Nothing
   *  answers; a change made there reopens the output, and a STATUS says so. */
  openDriverPanel() { this._request("HOST_PANEL", null); }

  _ask(name, json, replyKind) {
    return new Promise((resolve) => {
      this._waiting[replyKind].push(resolve);
      this._request(name, json);
    });
  }

  _request(name, json) {
    const blobs = json === null ? [] : [UTF8.encode(JSON.stringify(json))];
    this._queue.push({ name, ints: [], doubles: [], blobs });
    if (!this._flushQueued) {
      this._flushQueued = true;
      queueMicrotask(() => this._flush());
    }
  }

  _flush() {
    this._flushQueued = false;
    if (this._queue.length === 0 || !this.open) { this._queue.length = 0; return; }
    const frames = encodeFrames(this._queue);
    this._queue.length = 0;
    this.ws.send(frames);
  }

  _receive(buffer) {
    const kind = new Uint8Array(buffer, 0, 1)[0];
    if (kind === NATIVE_MSG.SNAPSHOT) {
      if (this.onSnapshot) this.onSnapshot(decodeSnapshot(buffer));
    } else if (kind === NATIVE_MSG.INVERT_MASK) {
      if (this.onMessage) this.onMessage(decodeInvertMask(buffer));
    } else if (kind === NATIVE_MSG.PROFILE) {
      if (this.onMessage) this.onMessage({ ...JSON.parse(textOf(buffer)), t: MSG.PROFILE });
    } else if (kind === NATIVE_MSG.STATUS) {
      this.hello = JSON.parse(textOf(buffer));
      this._waiting[kind].shift()?.(this.hello);
      if (this.onStatus) this.onStatus(this.hello);
    } else if (kind === NATIVE_MSG.DEVICES) {
      this._waiting[kind].shift()?.(JSON.parse(textOf(buffer)));
    }
  }

  close() { this.ws.close(); }
}
