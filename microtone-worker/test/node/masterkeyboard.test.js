// Item 379: the master keyboard — Scala keyboard mappings (src/midi/kbm.js),
// the controller (src/ui/masterkeyboard.js, through a host), the MIDI ports'
// routing of several keyboards beside one surface (src/midi/ports.js), and
// note entry of a MIDI key (edit.js interpretEditKey).

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseKbm, kbmDegree, LINEAR_KBM } from "../../src/midi/kbm.js";
import { MasterKeyboard, velocityVolume, PEDAL_DOWN_ARG, PEDAL_UP_ARG } from "../../src/ui/masterkeyboard.js";
import { MidiPorts, keyboardWish } from "../../src/midi/ports.js";
import { interpretEditKey, SUB_NOTE } from "../../src/ui/edit.js";
import { pitchTablePresets, finePreset, noteForDegree } from "../../core/tuning/pitchtables.js";
import { EffectOp } from "../../core/engine/tables.js";
import { TaudPlayData } from "../../core/engine/state.js";

// Scala's own template, as a 31-EDO mapping (the shape of every .kbm the
// user keeps in ~/Downloads).
const KBM_31 = `! Template for a keyboard mapping
!
! Size of map. The pattern repeats every so many keys:
31
! First MIDI note number to retune:
0
! Last MIDI note number to retune:
127
! Middle note where the first entry of the mapping is mapped to:
60
! Reference note for which frequency is given:
60
! Frequency to tune the above note to
261.6255653005987
! Scale degree to consider as formal octave (determines difference in pitch
! between adjacent mapping patterns):
31
! Mapping.
${Array.from({ length: 31 }, (_, i) => String(i)).join("\n")}
`;

// White keys only on a seven-note scale, keys 36…96: the shape a 12-key
// pattern over a smaller scale takes, with x for the black keys and the last
// entries left out.
const KBM_WHITE = `! white keys
12
36
96
60
69
440.0
7
0
x
1
x
2
3
x
4
x
5
`;

const T12 = pitchTablePresets[120];

test("a .kbm reads as Scala writes it", () => {
  const m = parseKbm(KBM_31);
  assert.equal(m.size, 31);
  assert.equal(m.first, 0);
  assert.equal(m.last, 127);
  assert.equal(m.middle, 60);
  assert.equal(m.reference, 60);
  assert.equal(m.frequency, 261.6255653005987);
  assert.equal(m.octave, 31);
  assert.deepEqual(m.map, Array.from({ length: 31 }, (_, i) => i));

  const w = parseKbm(KBM_WHITE);
  assert.equal(w.size, 12);
  // missing entries at the end are x
  assert.deepEqual(w.map, [0, null, 1, null, 2, 3, null, 4, null, 5, null, null]);
  // CRLF and a comment after a value
  const crlf = parseKbm("0\r\n0\r\n127\r\n60 ! the middle\r\n69\r\n440\r\n0\r\n");
  assert.equal(crlf.size, 0);
  assert.equal(crlf.middle, 60);
});

test("a file that is not a .kbm says what is wrong", () => {
  assert.throws(() => parseKbm(""), /ends before the size/);
  assert.throws(() => parseKbm("12\n0\n127\n60\n69\n"), /ends before the reference frequency/);
  assert.throws(() => parseKbm("12\n0\n200\n60\n69\n440\n12\n"), /last key is out of range/);
  assert.throws(() => parseKbm("1\n0\n127\n60\n69\n-1\n1\n0\n"), /not a frequency/);
  assert.throws(() => parseKbm("1\n0\n127\n60\n69\n440\n1\ny\n"), /neither a degree nor x/);
});

test("a key's degree: linear, a repeating pattern, x, and the ends", () => {
  assert.equal(kbmDegree(null, 60), 0);
  assert.equal(kbmDegree(null, 72), 12);
  assert.equal(kbmDegree(null, 59), -1);
  assert.equal(kbmDegree(LINEAR_KBM, 0), -60);

  const m31 = parseKbm(KBM_31);
  assert.equal(kbmDegree(m31, 91), 31);
  assert.equal(kbmDegree(m31, 59), -1);

  const w = parseKbm(KBM_WHITE);
  assert.equal(kbmDegree(w, 60), 0);
  assert.equal(kbmDegree(w, 61), null); // a black key
  assert.equal(kbmDegree(w, 64), 2);
  assert.equal(kbmDegree(w, 65), 3);
  assert.equal(kbmDegree(w, 72), 7); // the pattern's next turn: the formal octave
  assert.equal(kbmDegree(w, 59), null); // entry 11 is left out: x
  assert.equal(kbmDegree(w, 57), -2); // entry 9 of the turn below
  assert.equal(kbmDegree(w, 35), null); // below the first key
  assert.equal(kbmDegree(w, 97), null); // above the last

  // a formal octave of 0 is the scale's own size, which the caller gives
  const zero = parseKbm("2\n0\n127\n60\n69\n440\n0\n0\n1\n");
  assert.equal(kbmDegree(zero, 62, 5), 5);
});

test("velocity as a volume SET", () => {
  assert.equal(velocityVolume(127, true), 255);
  assert.equal(velocityVolume(64, true), 129);
  assert.equal(velocityVolume(1, true), 2);
  assert.equal(velocityVolume(127, false), 63);
  assert.equal(velocityVolume(200, true), 255);
});

/** A host that records what the controller asks of it. `entering` says
 *  whether enterNote takes the key (record mode on a grid). */
function fakeHost({ entering = false, octave = 4, target = null } = {}) {
  const log = [];
  const host = {
    log,
    octave: () => octave,
    period: () => 12,
    enterNote(id, noteFor, velocity) {
      if (!entering) return false;
      log.push(["enter", id, noteFor(T12), velocity]);
      return true;
    },
    audition: (id, noteFor) => log.push(["audition", id, noteFor(T12)]),
    release: (id) => log.push(["release", id]),
    pedalTarget: () => target,
  };
  return host;
}

test("a key auditions where nothing is entered, and goes up with its note-off", () => {
  const host = fakeHost();
  const kb = new MasterKeyboard(host);
  kb.receive([0x90, 60, 100], "Keys");
  kb.receive([0x90, 64, 100], "Keys");
  kb.receive([0x80, 60, 0], "Keys");
  kb.receive([0x90, 64, 0], "Keys"); // a note-on of velocity 0 is a note-off
  assert.deepEqual(host.log, [
    ["audition", "midi:Keys:0:60", noteForDegree(4, 0, T12)],
    ["audition", "midi:Keys:0:64", noteForDegree(4, 4, T12)],
    ["release", "midi:Keys:0:60"],
    ["release", "midi:Keys:0:64"],
  ]);
  // key 60 is C-4 by default
  assert.equal(host.log[0][2], 0x5000);
  // a note-off for a key not held says nothing
  kb.receive([0x80, 61, 0], "Keys");
  assert.equal(host.log.length, 4);
});

test("in record mode a key is entered; velocity rides along only when asked for", () => {
  const host = fakeHost({ entering: true, octave: 3 });
  const kb = new MasterKeyboard(host);
  kb.receive([0x91, 72, 90], "Keys"); // channel 2
  kb.velocity = true;
  kb.receive([0x91, 74, 90], "Keys");
  assert.deepEqual(host.log, [
    ["enter", "midi:Keys:1:72", noteForDegree(3, 12, T12), undefined],
    ["enter", "midi:Keys:1:74", noteForDegree(3, 14, T12), 90],
  ]);
  // the keyboard's octave: key 72 at Oct 3 is C-4
  assert.equal(host.log[0][2], 0x5000);
});

test("a mapping's silent keys play nothing; a key struck twice without a note-off retriggers", () => {
  const host = fakeHost();
  const kb = new MasterKeyboard(host);
  kb.kbm = parseKbm(KBM_WHITE);
  kb.receive([0x90, 61, 100], "Keys");
  assert.deepEqual(host.log, []);
  kb.receive([0x90, 62, 100], "Keys");
  kb.receive([0x90, 62, 100], "Keys");
  assert.deepEqual(host.log.map((e) => e[0]), ["audition", "release", "audition"]);
  assert.equal(host.log[0][2], noteForDegree(4, 1, T12)); // the white key D plays degree 1
});

test("the pedal writes S $7200 down and S $7100 up, and holds the auditions it was down over", () => {
  const applied = [];
  const cell = new TaudPlayData();
  const target = { cell, fx2: false, apply: (fields) => { applied.push(fields); Object.assign(cell, fields); } };
  const host = fakeHost({ target });
  const kb = new MasterKeyboard(host);
  kb.receive([0xb0, 64, 127], "Keys");
  kb.receive([0x90, 60, 100], "Keys");
  kb.receive([0x80, 60, 0], "Keys");
  assert.deepEqual(host.log.map((e) => e[0]), ["audition"]); // still sounding
  kb.receive([0xb0, 64, 100], "Keys"); // a half-pedal's stream: nothing new
  kb.receive([0xb0, 64, 0], "Keys");
  assert.deepEqual(host.log.map((e) => e[0]), ["audition", "release"]);
  assert.deepEqual(applied, [
    { effect: EffectOp.OP_S, effectArg: PEDAL_DOWN_ARG },
    { effect: EffectOp.OP_S, effectArg: PEDAL_UP_ARG }, // over the pedal's own command
  ]);
  assert.equal(PEDAL_DOWN_ARG, 0x7200);
  assert.equal(PEDAL_UP_ARG, 0x7100);
});

test("the pedal takes a free effect slot, and writes nothing where there is no cell", () => {
  const cell = new TaudPlayData();
  cell.effect = EffectOp.OP_D;
  cell.effectArg = 0x0400;
  const applied = [];
  const kb = new MasterKeyboard(fakeHost({ target: { cell, fx2: true, apply: (f) => applied.push(f) } }));
  kb.receive([0xb0, 64, 127], "Keys");
  assert.deepEqual(applied, [{ effect2: EffectOp.OP_S, effectArg2: PEDAL_DOWN_ARG }]);
  const none = new MasterKeyboard(fakeHost());
  none.receive([0xb0, 64, 127], "Keys"); // no target: nothing to write, no error
});

test("keyboards count on their own: keys, pedals and All Notes Off", () => {
  const host = fakeHost();
  const kb = new MasterKeyboard(host);
  kb.receive([0xb0, 64, 127], "A");
  kb.receive([0x90, 60, 100], "A");
  kb.receive([0x90, 60, 100], "B");
  kb.receive([0x80, 60, 0], "B"); // B has no pedal down
  kb.receive([0x80, 60, 0], "A"); // A's is held by its pedal
  assert.deepEqual(host.log.map((e) => e.slice(0, 2)), [
    ["audition", "midi:A:0:60"], ["audition", "midi:B:0:60"], ["release", "midi:B:0:60"],
  ]);
  kb.receive([0x90, 62, 100], "A");
  kb.receive([0xb0, 123, 0], "A"); // All Notes Off: A's held and sustained keys go
  assert.deepEqual(host.log.slice(4).map((e) => e.slice(0, 2)).sort(), [
    ["release", "midi:A:0:60"], ["release", "midi:A:0:62"],
  ]);
  // …and its pedal with them: the next note-off is not held
  kb.receive([0x90, 64, 100], "A");
  kb.receive([0x80, 64, 0], "A");
  assert.deepEqual(host.log.at(-1), ["release", "midi:A:0:64"]);
  // a keyboard that goes lets go of its keys
  kb.receive([0x90, 65, 100], "B");
  kb.forget("B");
  assert.deepEqual(host.log.at(-1), ["release", "midi:B:0:65"]);
});

test("a MIDI key is entered as a note in the cell's own notation, whatever the cursor's column", () => {
  const cell = new TaudPlayData();
  const fine = finePreset(T12);
  const ev = { code: "midi:Keys:0:62", key: "", noteFor: (p) => noteForDegree(4, 2, p) };
  const ctx = { octave: 4, currentInst: 3, preset: fine, wideCells: true };
  const a = interpretEditKey(ev, SUB_NOTE, 0, cell, ctx);
  assert.deepEqual(a, { fields: { note: noteForDegree(4, 2, fine), instrment: 3 }, jamNote: noteForDegree(4, 2, fine), advanceRow: true });
  // over a raw-hex note column too: a MIDI key is always a note
  const raw = interpretEditKey(ev, SUB_NOTE, 0, cell, { ...ctx, rawHex: true });
  assert.equal(raw.fields.note, noteForDegree(4, 2, fine));
  // velocity: a volume SET
  const v = interpretEditKey({ ...ev, volume: 200 }, SUB_NOTE, 0, cell, ctx);
  assert.equal(v.fields.volume, 200);
  assert.equal(v.fields.volumeEff, 0);
  // a lyric that goes on keeps its instrument number off
  assert.equal(interpretEditKey(ev, SUB_NOTE, 0, cell, { ...ctx, lyricContinues: true }).fields.instrment, undefined);
});

// ── the ports ──

/** A Web MIDI access with these input names (and one output). */
function fakeAccess(names) {
  const inputs = new Map(names.map((name, i) => [`in${i}`, { name, state: "connected", onmidimessage: null }]));
  const outputs = new Map([["out0", { name: "X-Touch One", state: "connected", sent: [], send(b) { this.sent.push(b); } }]]);
  return { inputs, outputs, onstatechange: null };
}
const port = (access, name) => [...access.inputs.values()].find((p) => p.name === name);

test("Web MIDI: one surface and any number of keyboards, each heard under its own name", async () => {
  const access = fakeAccess(["X-Touch One", "Keystation 61", "Launchkey 25"]);
  const ports = new MidiPorts({ native: null, access: async () => access });
  const heard = [];
  ports.onSurface = (b) => heard.push(["surface", [...b]]);
  ports.onKeyboard = (b, name) => heard.push([name, [...b]]);
  await ports.start();
  assert.deepEqual(ports.inputs(), ["X-Touch One", "Keystation 61", "Launchkey 25"]);
  // the surface's own input asked for as a keyboard too is the surface's alone
  ports.open("X-Touch One", "X-Touch One", ["Keystation 61", "X-Touch One", "Launchkey 25", "Gone"]);
  assert.deepEqual(ports.keyboardNames, ["Keystation 61", "Launchkey 25"]);
  assert.equal(ports.inputName, "X-Touch One");
  port(access, "X-Touch One").onmidimessage({ data: [0x90, 0x18, 0x7f] });
  port(access, "Keystation 61").onmidimessage({ data: [0x90, 60, 100] });
  port(access, "Launchkey 25").onmidimessage({ data: [0x80, 62, 0] });
  assert.deepEqual(heard, [
    ["surface", [0x90, 0x18, 0x7f]], ["Keystation 61", [0x90, 60, 100]], ["Launchkey 25", [0x80, 62, 0]],
  ]);
  // unplugged: let go; plugged again: heard again
  port(access, "Launchkey 25").state = "disconnected";
  access.onstatechange();
  assert.deepEqual(ports.keyboardNames, ["Keystation 61"]);
  assert.equal(port(access, "Launchkey 25").onmidimessage, null);
  port(access, "Launchkey 25").state = "connected";
  access.onstatechange();
  assert.deepEqual(ports.keyboardNames, ["Keystation 61", "Launchkey 25"]);
  // the keyboards alone, the surface kept
  ports.openKeyboards(["Launchkey 25"]);
  assert.deepEqual(ports.keyboardNames, ["Launchkey 25"]);
  assert.equal(port(access, "Keystation 61").onmidimessage, null);
  assert.equal(ports.inputName, "X-Touch One");
  // a keyboard that becomes the surface is heard as the surface only
  ports.open("Launchkey 25", null, ["Launchkey 25"]);
  assert.deepEqual(ports.keyboardNames, []);
  heard.length = 0;
  port(access, "Launchkey 25").onmidimessage({ data: [0x90, 1, 2] });
  assert.deepEqual(heard, [["surface", [0x90, 1, 2]]]);
  assert.equal(port(access, "X-Touch One").onmidimessage, null);
});

test("the desktop's socket: a source byte names the surface or a keyboard by the shell's id", () => {
  const ports = new MidiPorts({ native: null });
  const heard = [];
  ports.onSurface = (b) => heard.push(["surface", [...b]]);
  ports.onKeyboard = (b, name) => heard.push([name, [...b]]);
  ports._nativeState({
    ports: { inputs: ["X-Touch One", "Keys"], outputs: ["X-Touch One"] },
    open: { input: "X-Touch One", output: "X-Touch One", keyboards: [{ name: "Keys", id: 5 }] },
  });
  assert.deepEqual(ports.keyboardNames, ["Keys"]);
  ports._nativeMessage(Uint8Array.of(0, 0x90, 0x18, 0x7f));
  ports._nativeMessage(Uint8Array.of(5, 0x90, 60, 100));
  ports._nativeMessage(Uint8Array.of(6, 0x90, 61, 100)); // an id nobody has: dropped
  ports._nativeMessage(Uint8Array.of(5)); // nothing after the source byte
  assert.deepEqual(heard, [["surface", [0x90, 0x18, 0x7f]], ["Keys", [0x90, 60, 100]]]);
  // the surface closed: its input's messages are dropped
  ports._nativeState({ open: { input: null, output: null, keyboards: [{ name: "Keys", id: 5 }] } });
  ports._nativeMessage(Uint8Array.of(0, 0x90, 0x18, 0x7f));
  assert.equal(heard.length, 2);
});

test("a wish's keyboards: each once, never the surface's input", () => {
  assert.deepEqual(keyboardWish(["A", "B", "A", "", null, "S"], "S"), ["A", "B"]);
  assert.deepEqual(keyboardWish(undefined, null), []);
});
