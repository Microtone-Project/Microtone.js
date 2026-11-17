// The desktop's native audio host, the page's side (core/audio/native-engine.js)
// and its agreement with the host's C (desktop-qt/src/enginehost.c). The host
// itself is checked in the desktop build (its README): a capture of what it
// rendered on the device callback is bit-identical to the WebAssembly engine's
// offline render. What can rot without anyone hearing it is pinned here:
//  - every engine command the web dispatcher handles has a lowering, so a CMD
//    added to protocol.js cannot silently do nothing on the desktop;
//  - every name the page can send is a case in enginehost.c, and the reverse;
//  - a lowering hands over what WasmTaudEngine hands the C (the conversions);
//  - the frames and the host's messages decode as they were encoded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CMD, MSG } from "../../core/worklet/protocol.js";
import { applyAudioCommand } from "../../core/worklet/engine-commands.js";
import {
  lowerCommand, encodeFrames, decodeSnapshot, decodeInvertMask, NATIVE_MSG, NativeEngineLink, nativeApiName,
} from "../../core/audio/native-engine.js";
import {
  engineAnalysisArgs, engineMasterMeterArgs, engineJamSampleSpec, ENGINE_FORMANT_VOICES, ENGINE_FORMANT_DOUBLES,
} from "../../core/engine/wasm-engine.js";
import { ANALYSIS_STEREO } from "../../core/engine/analysis.js";
import { TOTAL_VOICES } from "../../core/engine/constants.js";

const ENGINE_HOST = new URL("../../../desktop-qt/src/enginehost.c", import.meta.url);

/** The commands the web dispatcher hands to an engine: everything
 *  applyAudioCommand takes, found by asking it with a recording stand-in. */
function engineCommands() {
  const handled = [];
  for (const [name, t] of Object.entries(CMD)) {
    const eng = new Proxy({}, { get: () => () => 0 });
    const m = { t, slots: [], blob: new ArrayBuffer(0), bytes: null, image: new ArrayBuffer(0), entries: [], blocks: [] };
    if (applyAudioCommand(eng, m)) handled.push(name);
  }
  return handled;
}

/** A sample message for each CMD: enough fields that lowering can run. */
function sample(t) {
  return {
    t, ph: 0, slot: 7, idx: 3, on: true, wide: true, bpm: 125.9, baseNote: 0x5000, freq: 440.5, rate: 6,
    volume: 200, pan: 128, flags: 3, model: 1, mode: 1, target: ANALYSIS_STEREO, params: null, scramble: true,
    bitDepth: 8, histSpan: 0, blocks: [], entries: [], bytes: new Uint8Array([1, 2, 3]).buffer, seat: 1,
    pos: 4, row: 9, cue: 2, voice: 65, note: 0x5000 + 7.5, inst: 12, audition: true, muted: true, fader: 99,
    spec: { ptr: 4096, len: 100, rate: 32000, loopStart: 0, loopEnd: 100, loopMode: 1 },
    image: new ArrayBuffer(16), slots: [1, 2], blob: new ArrayBuffer(2048), snapshotIntervalMs: 16,
  };
}

/** Decode frames (the host's parser, in JavaScript, for the test). */
function decodeFrames(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let o = 0;
  while (o < bytes.length) {
    const n = bytes[o++];
    const name = new TextDecoder().decode(bytes.subarray(o, o + n)); o += n;
    const nInts = dv.getUint16(o, true), nDoubles = bytes[o + 2], nBlobs = bytes[o + 3]; o += 4;
    const ints = [], doubles = [], blobs = [];
    for (let i = 0; i < nInts; i++) { ints.push(dv.getInt32(o, true)); o += 4; }
    for (let i = 0; i < nDoubles; i++) { doubles.push(dv.getFloat64(o, true)); o += 8; }
    for (let i = 0; i < nBlobs; i++) { const len = dv.getUint32(o, true); o += 4; blobs.push(bytes.slice(o, o + len)); o += len; }
    out.push({ name, ints, doubles, blobs });
  }
  return out;
}

test("every engine command the web dispatcher handles is lowered for the native host", () => {
  const commands = engineCommands();
  assert.ok(commands.length >= 40, `found ${commands.length} engine commands`);
  for (const name of commands) {
    assert.notEqual(lowerCommand(sample(CMD[name])), null, `CMD.${name} has no lowering in native-engine.js`);
  }
  // The host's own business, which the dispatcher leaves to its host.
  for (const name of ["INIT", "QUERY_INVERT_MASK", "SET_PROFILE"]) assert.notEqual(lowerCommand(sample(CMD[name])), null, name);
  // The web transports' plumbing never goes to the host.
  for (const name of ["SNAPSHOT_RETURN", "USE_SAB", "USE_AUDIO_SAB", "USE_AUDIO_PORT"]) {
    assert.equal(lowerCommand(sample(CMD[name])), null, name);
  }
});

test("enginehost.c handles exactly the names the page sends", () => {
  const c = readFileSync(ENGINE_HOST, "utf8");
  const inC = new Set([...c.matchAll(/is\(c, "([A-Z0-9_]+)"\)/g)].map((m) => m[1]));
  const sent = new Set();
  for (const t of Object.values(CMD)) {
    const low = lowerCommand(sample(t));
    if (low !== null) sent.add(low.name);
  }
  sent.delete("SET_PROFILE"); // the host's C++ side (nativeaudio.cpp), not the engine's
  assert.deepEqual([...sent].filter((n) => !inC.has(n)), [], "sent but not handled in enginehost.c");
  assert.deepEqual([...inC].filter((n) => !sent.has(n)), [], "handled in enginehost.c but never sent");
});

test("a lowering hands over what WasmTaudEngine hands the C", () => {
  const low = (m) => lowerCommand({ ...sample(m.t), ...m });
  // Numbers through `| 0`, as the WebAssembly boundary converts them: a wide
  // note's sixteenths do not reach tw_jam_note there either.
  assert.deepEqual(low({ t: CMD.JAM_NOTE }).ints, [65, 0x5000 + 7, 12, 1]);
  assert.deepEqual(low({ t: CMD.SET_BPM }).ints, [125]);
  assert.deepEqual(low({ t: CMD.SET_TUNING }).doubles, [440.5]);
  // setVoiceMute is the fader at 255.
  assert.deepEqual(low({ t: CMD.SET_VOICE_MUTE }), { name: "SET_VOICE_FADER", ints: [65, 255], doubles: [], blobs: [] });
  assert.deepEqual(low({ t: CMD.SET_VOICE_MUTE, muted: false }).ints, [65, 0]);
  // The structured ones by WasmTaudEngine's own functions.
  assert.deepEqual(low({ t: CMD.SET_ANALYSIS }).ints, engineAnalysisArgs(ANALYSIS_STEREO));
  assert.deepEqual(low({ t: CMD.SET_ANALYSIS, target: undefined }).ints, [-1, 0]);
  assert.deepEqual(low({ t: CMD.SET_MASTER_METER }).ints, engineMasterMeterArgs(true, true, 8, 0));
  assert.deepEqual(low({ t: CMD.SET_MASTER_METER, on: false }).ints, [0, 0, 16, 0]);
  assert.deepEqual([...low({ t: CMD.JAM_SAMPLE }).blobs[0]],
    [...new Uint8Array(engineJamSampleSpec(sample(CMD.JAM_SAMPLE).spec).buffer)]);
  assert.equal(low({ t: CMD.SET_MASTERING }).blobs[0].length, 0, "null = no chain");
  assert.deepEqual(low({ t: CMD.UPLOAD_PATTERNS }).ints, [1, 2]);
  assert.deepEqual(low({ t: CMD.SET_IMIX_METER, seat: undefined }).ints, [7, 0]);
});

test("frames decode as they were encoded, in order", () => {
  const list = [CMD.INIT, CMD.UPLOAD_PATTERNS, CMD.SET_TUNING, CMD.JAM_SAMPLE, CMD.PLAY].map((t) => lowerCommand(sample(t)));
  const back = decodeFrames(encodeFrames(list));
  assert.equal(back.length, list.length);
  back.forEach((f, i) => {
    assert.equal(f.name, list[i].name);
    assert.deepEqual(f.ints, list[i].ints);
    assert.deepEqual(f.doubles, list[i].doubles);
    assert.deepEqual(f.blobs.map((b) => [...b]), list[i].blobs.map((b) => [...b]));
  });
  // More slots than a byte counts.
  const many = lowerCommand({ ...sample(CMD.UPLOAD_PATTERNS), slots: Array.from({ length: 1000 }, (_, i) => i) });
  assert.equal(decodeFrames(encodeFrames([many]))[0].ints.length, 1000);
});

test("a SNAPSHOT message decodes to its interrupts and ranges", () => {
  const ranges = [[0, [1, 2, 3]], [100, [4.5]], [2000, []]];
  const floats = ranges.reduce((n, [, f]) => n + f.length, 0);
  const buf = new ArrayBuffer(76 + ranges.length * 8 + floats * 4);
  const dv = new DataView(buf);
  dv.setUint8(0, NATIVE_MSG.SNAPSHOT);
  dv.setUint32(4, 0b101, true);
  dv.setInt32(8, 77, true);           // Int 0's argument
  dv.setInt32(8 + 2 * 4, -5, true);   // Int 2's
  dv.setUint32(72, ranges.length, true);
  let at = 76 + ranges.length * 8;
  ranges.forEach(([from, f], i) => {
    dv.setUint32(76 + i * 8, from, true);
    dv.setUint32(80 + i * 8, f.length, true);
    f.forEach((v) => { dv.setFloat32(at, v, true); at += 4; });
  });
  const s = decodeSnapshot(buf);
  assert.equal(s.mask, 0b101);
  assert.equal(s.args[0], 77);
  assert.equal(s.args[2], -5);
  assert.deepEqual(s.ranges.map((r) => [r.from, [...r.floats]]), ranges);
});

test("an INVERT_MASK reply decodes to what the render Worker posts", () => {
  // Laid out as enginehost.c reply_invert_mask writes it.
  const parts = [];
  const i32 = (...v) => parts.push(new Uint8Array(new Int32Array(v).buffer));
  const f64 = (v) => parts.push(new Uint8Array(new Float64Array(v).buffer));
  parts.push(new Uint8Array([NATIVE_MSG.INVERT_MASK, 0, 0, 0]));
  i32(9);
  i32(3); parts.push(new Uint8Array([0xf0, 0x0f, 0xff]));   // invert mask
  i32(1); parts.push(new Uint8Array([0x55]));               // mod mask
  f64(Array.from({ length: 25 }, (_, i) => i === 8 ? 1 : i)); // sample mod: modOn = d[8]
  i32(1); i32(10, 11, 12, 13, 1, 5, 6, 1);                   // PSG, a wave
  i32(2); i32(...Array.from({ length: 32 }, (_, i) => (i < 4 ? [3, 0, 7, 1][i] : 0)));
  i32(1); i32(...Array.from({ length: 128 }, (_, i) => (i < 4 ? [2, 5, 9, 0][i] : 0)));
  i32(1);
  const fv = new Array(ENGINE_FORMANT_VOICES * ENGINE_FORMANT_DOUBLES).fill(0);
  fv[0] = 1; fv[1] = 0.25; fv[7] = 1; fv[8] = 0.5; fv[9] = 0.75;
  f64(fv);
  i32(...Array.from({ length: ENGINE_FORMANT_VOICES * 2 }, (_, i) => (i === 0 ? 4 : i === 1 ? 1 : 0)));
  i32(1, 2);                                                 // counts: one voice, two lyric entries
  i32(TOTAL_VOICES); i32(...Array.from({ length: TOTAL_VOICES }, (_, i) => (i < 2 ? [5, 8][i] : 0)));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { bytes.set(p, o); o += p.length; }

  const m = decodeInvertMask(bytes.buffer);
  assert.equal(m.t, MSG.INVERT_MASK);
  assert.equal(m.slot, 9);
  assert.deepEqual([...new Uint8Array(m.mask)], [0xf0, 0x0f, 0xff]);
  assert.deepEqual([...new Uint8Array(m.modMask)], [0x55]);
  assert.equal(m.mod.modOn, true);
  assert.equal(m.mod.modFunkLen, 24);
  assert.deepEqual(m.psg, { rtAdvance: [10, 11], rtLevel: [12, 13], rtMute: 1, wave: [5, 6] });
  assert.deepEqual(m.fadeout, [{ step: 3, released: false }, { step: 7, released: true }]);
  assert.deepEqual(m.fmVibrato, [{ entry: 2, speed: 5, depth: 9, released: false }]);
  assert.equal(m.formant.voices.length, 1);
  assert.deepEqual(m.formant.voices[0].nasal, { v: 0.5, to: 0.75 });
  assert.equal(m.formant.voices[0].glide, 4);
  assert.equal(m.formant.voices[0].coda, true);
  assert.deepEqual(m.formant.lyric, [5, 8]);
});

test("the host's own requests: the device list and another output, each answered in turn", async () => {
  const sent = [];
  const socket = { readyState: WebSocket.OPEN, send: (b) => sent.push(b) };
  const link = new NativeEngineLink(socket, { ok: true, apiId: "pulse", rate: 48000 });
  const statuses = [];
  link.onStatus = (s) => statuses.push(s);
  const devices = link.requestDevices();
  const config = { api: "alsa", device: "", rate: 44100, bufferFrames: 128 };
  const configured = link.configure(config);
  await new Promise((r) => setTimeout(r, 0)); // the frames of one turn go as one message
  assert.equal(sent.length, 1);
  const frames = decodeFrames(sent[0]);
  assert.deepEqual(frames.map((f) => f.name), ["HOST_DEVICES", "HOST_CONFIGURE"]);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(frames[1].blobs[0])), config);
  // The host answers each by its kind.
  const reply = (kind, obj) => {
    const json = new TextEncoder().encode(JSON.stringify(obj));
    const b = new Uint8Array(4 + json.length);
    b[0] = kind;
    b.set(json, 4);
    return b.buffer;
  };
  const list = { apis: [{ id: "alsa", name: "ALSA", devices: [] }], current: {} };
  socket.onmessage({ data: reply(NATIVE_MSG.DEVICES, list) });
  socket.onmessage({ data: reply(NATIVE_MSG.STATUS, { ok: true, apiId: "alsa", rate: 44100, error: "" }) });
  assert.deepEqual(await devices, list);
  assert.equal((await configured).rate, 44100);
  assert.equal(link.hello.apiId, "alsa", "the link keeps the newest status");
  assert.equal(statuses.length, 1);
  assert.equal(nativeApiName("pulse"), "PulseAudio");
  assert.equal(nativeApiName("weird", "Weird"), "Weird");
});
