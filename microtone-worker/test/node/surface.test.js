// Item 379: a Mackie Control surface — the wire format (src/midi/mackie.js)
// and what each control does to the app (src/ui/surface.js, through a host).
// The inbound bytes are the ones a Behringer X-Touch One sent on 2026-11-26
// (tsvm reference_materials/mackie-control/captures).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decode, BUTTON, ledMessage, faderMessage, ringMessage, segmentCode, segmentCells,
  timecodeMessages, assignmentMessages, lcdMessage, relativeDelta, RING,
} from "../../src/midi/mackie.js";
import {
  ControlSurface, HOME_STRIP, effectFields, cellArg, panStart, panTurn, panRing, positionText,
  nextPanels, faderLevel, levelFader, jogGain, jogRows, JOG_ROWS,
} from "../../src/ui/surface.js";
import { partnerOutput, looksLikeSurface } from "../../src/midi/ports.js";
import { EffectOp } from "../../core/engine/tables.js";

const noteOn = (n, v = 127) => [0x90, n, v];
const noteOff = (n) => [0x80, n, 0];

test("the X-Touch One's buttons decode to their MCU names", () => {
  // The capture's order: the strip's Select, Mute, Solo, Rec; BPM/Time;
  // F1–F6; Marker…Solo; the transport; banks; cursor; the foot pedal.
  const seen = [24, 16, 8, 0, 53, 54, 55, 56, 57, 58, 59, 84, 85, 86, 87, 88, 89, 90,
    91, 92, 93, 94, 95, 46, 47, 48, 49, 96, 97, 98, 99, 100, 101, 102].map((n) => decode(noteOn(n)));
  assert.deepEqual(seen.map((e) => e.name), [
    "select", "mute", "solo", "rec", "timecodeBeats", "f1", "f2", "f3", "f4", "f5", "f6",
    "marker", "nudge", "cycle", "drop", "replace", "click", "transportSolo",
    "rewind", "fastForward", "stop", "play", "record",
    "bankLeft", "bankRight", "channelLeft", "channelRight",
    "up", "down", "left", "right", "zoom", "scrub", "userA",
  ]);
  assert.ok(seen.every((e) => e.type === "button" && e.down));
  assert.equal(seen[1].strip, 0);
  assert.equal(seen.at(-1).strip, null);
  // aseqdump shows Note Off; a Note On at velocity 0 means the same
  assert.equal(decode(noteOff(94)).down, false);
  assert.equal(decode([0x90, 94, 0]).down, false);
  // a strip other than the first
  assert.deepEqual(decode(noteOn(0x13)), { type: "button", name: "mute", strip: 3, down: true });
  assert.deepEqual(decode(noteOn(32)), { type: "button", name: "vpotPush", strip: 0, down: true });
});

test("fader, touch, knob and jog", () => {
  assert.deepEqual(decode(noteOn(104)), { type: "touch", strip: 0, master: false, down: true });
  assert.deepEqual(decode(noteOn(112)), { type: "touch", strip: null, master: true, down: true });
  // pitch bend −8192 (aseqdump's signed reading) is the bottom, 8191 the top
  assert.deepEqual(decode([0xe0, 0x00, 0x00]), { type: "fader", strip: 0, master: false, value: 0 });
  assert.deepEqual(decode([0xe8, 0x7f, 0x7f]), { type: "fader", strip: null, master: true, value: 0x3fff });
  assert.deepEqual(decode([0xb0, 16, 1]), { type: "vpot", strip: 0, delta: 1 });
  assert.deepEqual(decode([0xb0, 16, 65]), { type: "vpot", strip: 0, delta: -1 });
  assert.deepEqual(decode([0xb0, 60, 1]), { type: "jog", delta: 1 });
  assert.deepEqual(decode([0xb0, 60, 65]), { type: "jog", delta: -1 });
  assert.equal(relativeDelta(0x43), -3);
  // what is not Mackie Control
  assert.equal(decode([0xf8]), null);
  assert.equal(decode([0x91, 94, 127]), null); // another channel
  assert.equal(decode([0xb0, 7, 100]), null);
});

test("outgoing messages", () => {
  assert.deepEqual(ledMessage(BUTTON.play, "on"), [0x90, 0x5e, 0x7f]);
  assert.deepEqual(ledMessage(BUTTON.play, "flash"), [0x90, 0x5e, 0x01]);
  assert.deepEqual(ledMessage(BUTTON.play, "off"), [0x90, 0x5e, 0x00]);
  assert.deepEqual(faderMessage(0, 0x3fff), [0xe0, 0x7f, 0x7f]);
  assert.deepEqual(faderMessage(null, 0x2000), [0xe8, 0x00, 0x40]);
  assert.deepEqual(ringMessage(0, RING.dot, 6, true), [0xb0, 0x30, 0x46]);
  assert.deepEqual(ringMessage(2, RING.boostCut, 11), [0xb0, 0x32, 0x1b]);
  // Ardour's seven-segment table
  assert.equal(segmentCode("5"), 0x35);
  assert.equal(segmentCode("a"), 0x01);
  assert.equal(segmentCode("F"), 0x06);
  assert.equal(segmentCode(" "), 0x20);
  assert.equal(segmentCode("~"), 0x20);
  assert.deepEqual(segmentCells("1.2", 4), [0x71, 0x32, 0x20, 0x20]);
  // digit i from the left is CC 0x49 − i; only changes are sent
  const a = segmentCells("0123456789", 10);
  assert.deepEqual(timecodeMessages(a)[0], [0xb0, 0x49, 0x30]);
  assert.deepEqual(timecodeMessages(a)[9], [0xb0, 0x40, 0x39]);
  const b = a.slice(); b[9] = segmentCode("0");
  assert.deepEqual(timecodeMessages(b, a), [[0xb0, 0x40, 0x30]]);
  assert.deepEqual(assignmentMessages(segmentCells("05", 2)), [[0xb0, 0x4b, 0x30], [0xb0, 0x4a, 0x35]]);
  const lcd = lcdMessage(1, 1, "Lane 05!!");
  assert.deepEqual(lcd.slice(0, 7), [0xf0, 0, 0, 0x66, 0x14, 0x12, 0x38 + 7]);
  assert.equal(String.fromCharCode(...lcd.slice(7, 14)), "Lane 05");
  assert.equal(lcd.at(-1), 0xf7);
});

const S = EffectOp.OP_S, X = EffectOp.OP_X, M = EffectOp.OP_M, V = EffectOp.OP_V;
const blank = () => ({ effect: 0, effectArg: 0, effect2: 0, effectArg2: 0 });
const isM = (op) => op === M;

test("an effect goes over its own kind, else into the first empty slot", () => {
  assert.deepEqual(effectFields(blank(), isM, M, 0x4000, false), { effect: M, effectArg: 0x4000 });
  const busy = { ...blank(), effect: EffectOp.OP_D, effectArg: 0x0100 };
  assert.deepEqual(effectFields(busy, isM, M, 0x4000, true), { effect2: M, effectArg2: 0x4000 });
  // the second slot is not used where it is hidden
  assert.deepEqual(effectFields(busy, isM, M, 0x4000, false), { effect: M, effectArg: 0x4000 });
  const hasM2 = { ...busy, effect2: M, effectArg2: 0x2000 };
  assert.deepEqual(effectFields(hasM2, isM, M, 0x4000, true), { effect2: M, effectArg2: 0x4000 });
  assert.deepEqual(cellArg(hasM2, isM), { effect: M, arg: 0x2000 });
  assert.equal(cellArg(blank(), isM), null);
});

test("the knob: stereo pan byte, planar azimuth, spatial X", () => {
  const live = { vol: 255, az: 128, el: 0 };
  // stereo: S $80xx, clamped
  let p = panTurn(0, panStart(0, blank(), live), 3, "azimuth");
  assert.deepEqual([p.effect, p.arg], [S, 0x8000 | (128 + 12)]);
  assert.equal(panTurn(0, { az: 254, el: 0 }, 5).az, 255);
  // a cell's own command is where the knob starts
  const cell = { ...blank(), effect: S, effectArg: 0x8010 };
  assert.equal(panStart(0, cell, live).az, 0x10);
  // planar: 512 units, wrapping
  p = panTurn(1, panStart(1, blank(), { ...live, az: 2 }), -1, "azimuth");
  assert.deepEqual([p.effect, p.arg], [S, 0x8000 | 510]);
  // spatial: X $eeaa, both axes from the cell
  const xc = { ...blank(), effect: X, effectArg: (0x10 << 8) | 0x40 };
  const st = panStart(2, xc, live);
  assert.deepEqual(st, { az: 0x40, el: 0x10 });
  p = panTurn(2, st, 1, "elevation");
  assert.deepEqual([p.effect, p.arg], [X, (0x12 << 8) | 0x40]);
  p = panTurn(2, { az: 0x40, el: -2 }, -1, "elevation");
  assert.equal(p.arg >> 8, (-4) & 0xff);
  p = panTurn(2, { az: 255, el: 0 }, 1, "azimuth");
  assert.equal(p.arg & 0xff, 1);
  // the ring: centre lit at the centre / front, ends at the far sides
  assert.deepEqual(panRing(0, { az: 128 }, "azimuth"), { mode: RING.dot, pos: 6, centre: true });
  assert.equal(panRing(0, { az: 0 }, "azimuth").pos, 1);
  assert.equal(panRing(0, { az: 255 }, "azimuth").pos, 11);
  assert.equal(panRing(1, { az: 128 }, "azimuth").pos, 6);  // planar front
  assert.equal(panRing(1, { az: 256 }, "azimuth").pos, 9);  // planar right: half way to behind
  assert.equal(panRing(1, { az: 384 }, "azimuth").pos, 11); // planar behind
  assert.equal(panRing(2, { az: 64, el: 0 }, "azimuth").pos, 6); // X's front
  assert.equal(panRing(2, { az: 64, el: 127 }, "elevation").mode, RING.boostCut);
});

test("the display's two readings", () => {
  const pos = { cue: 0x1a, row: 0x05, speed: 6, bpm: 125, barsBefore: 3, pri: 4, sec: 16 };
  assert.equal(positionText(pos, false), " 1A0506125");
  // row 5 of the cue: bar 4 (three before), beat 2, subdivision 2
  assert.equal(positionText(pos, true), "  4 2 2   ");
  assert.equal(positionText({ ...pos, row: 0x3f, barsBefore: 0 }, true), "  4 4 4   ");
});

test("Global View walks the panels: none, instruments, both, master", () => {
  let p = { inst: false, master: false };
  const seen = [];
  for (let i = 0; i < 4; i++) { p = nextPanels(p); seen.push(`${+p.inst}${+p.master}`); }
  assert.deepEqual(seen, ["10", "11", "01", "00"]);
});

test("ports: a surface's output is found by its input's name", () => {
  assert.equal(partnerOutput("X-Touch One", ["Midi Through", "X-Touch One"]), "X-Touch One");
  assert.equal(partnerOutput("X-Touch One MIDI 1", ["X-Touch One MIDI 2"]), "X-Touch One MIDI 2");
  assert.equal(partnerOutput("Foo", ["Bar"]), null);
  assert.ok(looksLikeSurface("X-Touch One"));
  assert.ok(!looksLikeSurface("Midi Through Port-0"));
});

/** A host that records what it is asked to do. */
function fakeHost(over = {}) {
  const calls = [];
  const cell = blank();
  const host = {
    calls, cell,
    rec: true, playingNow: false, sel: false, mark: null, split: false, view_: "timeline",
    ready: () => true,
    view: () => host.view_,
    viewIndex: () => 0,
    lane: () => 4,
    surroundModel: () => 0,
    editTarget: (any) => (host.rec || any ? {
      cell, fx2: false,
      apply: (fields, gesture) => { Object.assign(cell, fields); calls.push(["apply", fields, gesture]); },
    } : null),
    engineLane: () => ({ vol: 200, az: 128, el: 0 }),
    globalVolume: () => 0x80,
    muted: () => false, soloed: () => false, fx2: () => false,
    toggleMute: (ch) => calls.push(["mute", ch]),
    toggleSolo: (ch) => calls.push(["solo", ch]),
    toggleFx2: (ch) => calls.push(["fx2", ch]),
    laneMenu: () => calls.push(["menu"]),
    showView: (i) => calls.push(["view", i]),
    splitToggle: () => calls.push(["split"]),
    isSplit: () => host.split,
    paneStep: (d) => calls.push(["pane", d]),
    cyclePanels: () => calls.push(["panels"]),
    record: () => host.rec,
    setRecord: (on) => { host.rec = on; calls.push(["rec", on]); },
    playing: () => host.playingNow,
    play: () => calls.push(["play"]),
    stop: () => calls.push(["stop"]),
    togglePlay: () => calls.push(["toggle"]),
    seekCue: (d) => calls.push(["seek", d]),
    key: (code, mods) => calls.push(["key", code, mods]),
    selMode: () => host.sel,
    setSelMode: (on) => { host.sel = on; calls.push(["sel", on]); },
    undo: () => calls.push(["undo"]),
    cursorRow: () => 40,
    row: 40,
    gridRow: () => host.row,
    marker: () => host.mark,
    setMarker: (r) => { host.mark = r; calls.push(["marker", r]); },
    gotoMarker: () => calls.push(["goto"]),
    keymapStep: (d) => calls.push(["keymap", d]),
    position: () => ({ cue: 0, row: 0, speed: 6, bpm: 125, barsBefore: 0, pri: 4, sec: 16 }),
    dialog: false,
    dialogOpen: () => host.dialog,
    dialogKey: (code) => calls.push(["dkey", code]),
    dialogTake: () => calls.push(["take"]),
    dialogCancel: () => calls.push(["cancel"]),
    ...over,
  };
  return host;
}

test("every strip's buttons act on the lane being edited", () => {
  const h = fakeHost();
  const s = new ControlSurface(h);
  s.receive(noteOn(0x10 + 5)); // strip 6's Mute
  s.receive(noteOn(0x08));     // strip 1's Solo
  s.receive(noteOn(0x00 + 2)); // strip 3's Rec
  s.receive(noteOn(0x18 + 3)); // strip 4's Select: the one the surface is kept on
  assert.deepEqual(h.calls, [["mute", 4], ["solo", 4], ["fx2", 4], ["menu"]]);
});

test("the transport and the function keys", () => {
  const h = fakeHost();
  const s = new ControlSurface(h, () => 0);
  for (const n of [BUTTON.f3, BUTTON.rewind, BUTTON.fastForward, BUTTON.stop, BUTTON.play,
    BUTTON.record, BUTTON.userA, BUTTON.cycle, BUTTON.drop, BUTTON.replace, BUTTON.click,
    BUTTON.transportSolo, BUTTON.zoom, BUTTON.scrub, BUTTON.globalView, BUTTON.nudge]) {
    s.receive(noteOn(n));
  }
  assert.deepEqual(h.calls, [
    ["view", 2], ["seek", -1], ["seek", 1], ["stop"], ["play"], ["rec", false], ["toggle"],
    ["keymap", -1], ["keymap", 1], ["pane", -1], ["pane", 1], ["split"], ["sel", true], ["undo"],
    ["panels"], ["goto"],
  ]);
  // Play while playing does nothing
  h.calls.length = 0;
  h.playingNow = true;
  s.receive(noteOn(BUTTON.play));
  assert.deepEqual(h.calls, []);
});

test("Marker sets the row, and on the marked row clears it", () => {
  const h = fakeHost();
  const s = new ControlSurface(h);
  s.receive(noteOn(BUTTON.marker));
  assert.equal(h.mark, 40);
  s.receive(noteOn(BUTTON.marker));
  assert.equal(h.mark, null);
});

test("navigation is the keyboard's chords; held arrows repeat", () => {
  let now = 0;
  const h = fakeHost();
  const s = new ControlSurface(h, () => now);
  s.attach(() => {});
  s.receive(noteOn(BUTTON.channelRight));
  s.receive(noteOn(BUTTON.bankLeft));
  s.receive([0xb0, 60, 0x42]); // two steps back, the first of a turn: a unit each
  assert.deepEqual(h.calls, [
    ["key", "ArrowRight", { shift: true, ctrl: true }],
    ["key", "ArrowLeft", { shift: true, ctrl: true, alt: true }],
    ...Array(2 * JOG_ROWS).fill(["key", "ArrowUp", {}]),
  ]);
  h.calls.length = 0;
  h.view_ = "pattern"; // Bank steps through patterns there
  s.receive(noteOn(BUTTON.bankRight));
  assert.deepEqual(h.calls, [["key", "ArrowDown", { shift: true, ctrl: true, alt: true }]]);
  h.calls.length = 0;
  s.receive(noteOn(BUTTON.down));
  now = 300; s.frame();
  now = 410; s.frame();
  now = 480; s.frame();
  s.receive(noteOff(BUTTON.down));
  now = 900; s.frame();
  assert.deepEqual(h.calls.filter((c) => c[0] === "key").map((c) => c[1]),
    ["ArrowDown", "ArrowDown", "ArrowDown"]);
});

test("the fader writes M at the cursor, one undo step a touch", () => {
  let now = 0;
  const h = fakeHost();
  const s = new ControlSurface(h, () => now);
  s.receive(noteOn(104));
  s.receive([0xe0, 0x00, 0x20]); // 0x1000 → $40
  now = 10;
  s.receive([0xe0, 0x7f, 0x7f]); // the top → $FF
  s.receive(noteOff(104));
  const applies = h.calls.filter((c) => c[0] === "apply");
  assert.deepEqual(applies.map((c) => c[1]), [{ effect: M, effectArg: 0x4000 }, { effect: M, effectArg: 0xff00 }]);
  assert.equal(applies[0][2], applies[1][2]); // one gesture
  assert.ok(applies[0][2]);
  // the master fader writes V, and a second touch is a second step
  h.calls.length = 0;
  s.receive(noteOn(112));
  s.receive([0xe8, 0x00, 0x40]);
  s.receive(noteOff(112));
  const v = h.calls.filter((c) => c[0] === "apply");
  assert.deepEqual(v[0][1].effect2 ?? v[0][1].effect, V);
  assert.notEqual(v[0][2], applies[0][2]);
  // record mode off: nothing is written
  h.calls.length = 0;
  h.rec = false;
  s.receive([0xe0, 0x00, 0x10]);
  assert.deepEqual(h.calls, []);
  assert.equal(faderLevel(levelFader(0x80)), 0x80);
});

test("the knob writes the lane's position; its push switches axis in a spatial song", () => {
  const h = fakeHost({ surroundModel: () => 2 });
  let now = 1000;
  const s = new ControlSurface(h, () => now);
  s.receive([0xb0, 16, 1]);
  assert.deepEqual(h.calls[0][1], { effect: X, effectArg: 0x42 }); // front ($40) + one step of 2
  s.receive(noteOn(32));
  assert.equal(s.axis, "elevation");
  now = 2000; // (detents close together count more: a quick turn goes further)
  s.receive([0xb0, 17, 1]); // another strip's knob: the same lane
  assert.equal(h.cell.effectArg, (2 << 8) | 0x42);
  now = 2010;
  s.receive([0xb0, 16, 1]);
  assert.equal(h.cell.effectArg >> 8, 2 + 2 * 4);
  // in a stereo song the push does nothing
  const st = new ControlSurface(fakeHost(), () => 0);
  st.receive(noteOn(32));
  assert.equal(st.axis, "azimuth");
});

test("feedback is sent once, and again only when it changes", () => {
  const h = fakeHost();
  const sent = [];
  let now = 1000;
  const s = new ControlSurface(h, () => now);
  s.attach((m) => sent.push(m));
  s.frame();
  const first = sent.length;
  assert.ok(first > 0);
  // the record lamp lit, the play lamp dark, the fader at the lane's 200
  assert.ok(sent.some((m) => m[0] === 0x90 && m[1] === BUTTON.record && m[2] === 0x7f));
  assert.ok(sent.some((m) => m[0] === 0x90 && m[1] === BUTTON.play && m[2] === 0));
  assert.ok(sent.some((m) => m[0] === 0xe0 && (m[1] | (m[2] << 7)) === levelFader(200)));
  s.frame();
  assert.equal(sent.length, first);
  h.playingNow = true;
  s.frame();
  assert.deepEqual(sent.slice(first), [[0x90, BUTTON.play, 0x7f], [0x90, BUTTON.stop, 0]]);
  // the motor leaves a touched fader alone
  sent.length = 0;
  s.receive(noteOn(104));
  h.engineLane = () => ({ vol: 10, az: 128, el: 0 });
  s.frame();
  assert.ok(!sent.some((m) => m[0] === 0xe0));
  // goodbye puts the lamps out
  sent.length = 0;
  s.goodbye();
  assert.ok(sent.some((m) => m[0] === 0x90 && m[1] === BUTTON.record && m[2] === 0));
  assert.equal(s.send, null);
});

test("with a dialog or menu open, the surface walks it", () => {
  let now = 0;
  const h = fakeHost();
  const s = new ControlSurface(h, () => now);
  h.dialog = true;
  s.receive(noteOn(BUTTON.right));
  s.receive([0xb0, 60, 1]);     // jog: a row
  now = 100;
  s.receive([0xb0, 16, 0x41]);  // knob: back an item
  s.receive(noteOn(32));        // knob push: take it
  s.receive(noteOn(0x1b));      // Select: close
  s.receive(noteOn(0x10));      // a strip's Mute does nothing meanwhile
  s.receive(noteOn(BUTTON.stop)); // the transport still works
  assert.deepEqual(h.calls, [["dkey", "ArrowRight"], ["dkey", "ArrowDown"], ["dkey", "ArrowLeft"],
    ["take"], ["cancel"], ["stop"]]);
});

test("a touch that bounces, or follows its own movement, is one undo step", () => {
  let now = 0;
  const h = fakeHost();
  const s = new ControlSurface(h, () => now);
  s.receive([0xe0, 0x7f, 0x7f]); // a move reported just before the touch
  now = 5; s.receive(noteOn(104));
  now = 10; s.receive([0xe0, 0x00, 0x60]);
  now = 15; s.receive(noteOff(104)); // the bounce
  now = 18; s.receive(noteOn(104));
  now = 30; s.receive([0xe0, 0x00, 0x40]);
  now = 40; s.receive(noteOff(104));
  const gestures = new Set(h.calls.filter((c) => c[0] === "apply").map((c) => c[2]));
  assert.equal(gestures.size, 1);
  // a new touch a while later is a new step
  now = 2000; s.receive(noteOn(104));
  now = 2010; s.receive([0xe0, 0x00, 0x20]);
  const all = new Set(h.calls.filter((c) => c[0] === "apply").map((c) => c[2]));
  assert.equal(all.size, 2);
});

test("a one-fader surface's Channel ◀ ▶ arrive as the next strip's Select", () => {
  const h = fakeHost();
  const sent = [];
  const s = new ControlSurface(h, () => 1000);
  s.attach((m) => sent.push(m));
  s.frame();
  // the home strip's Select is lit, the others dark
  const selects = sent.filter((m) => m[0] === 0x90 && m[1] >= 0x18 && m[1] < 0x20);
  assert.deepEqual(selects.map((m) => m[2]), [0, 0, 0, 0x7f, 0, 0, 0, 0]);
  assert.equal(HOME_STRIP, 3);
  // strip 5's Select: one lane right, and the home strip is lit again
  sent.length = 0;
  s.receive(noteOn(0x1c));
  assert.deepEqual(h.calls, [["key", "ArrowRight", { shift: true, ctrl: true }]]);
  s.frame();
  assert.ok(sent.some((m) => m[0] === 0x90 && m[1] === 0x1b && m[2] === 0x7f));
  // strip 1's (an eight-strip surface): three lanes left
  h.calls.length = 0;
  s.receive(noteOn(0x18));
  assert.equal(h.calls.filter((c) => c[1] === "ArrowLeft").length, 3);
  // in a menu, a step walks it
  h.calls.length = 0;
  h.dialog = true;
  s.receive(noteOn(0x1a));
  assert.deepEqual(h.calls, [["dkey", "ArrowLeft"]]);
});

test("the jog: a unit a slow step, more the faster, on a grid of every other row", () => {
  assert.equal(JOG_ROWS, 2);
  assert.equal(jogGain(1000), 1);
  assert.equal(jogGain(400), 1);
  assert.ok(jogGain(51) > 3.5 && jogGain(51) < 4.1);
  assert.equal(jogGain(1), jogGain(50)); // two messages a millisecond apart are one tick
  // onto the grid: from row 41, down lands on 42, up on 40
  assert.equal(jogRows(41, 1), 1);
  assert.equal(jogRows(41, -1), -1);
  assert.equal(jogRows(40, 2), 4);
  assert.equal(jogRows(null, -1), -2);

  let now = 0;
  const h = fakeHost();
  const s = new ControlSurface(h, () => now);
  const moved = () => h.calls.reduce((n, c) => n + (c[1] === "ArrowDown" ? 1 : c[1] === "ArrowUp" ? -1 : 0), 0);
  // slow: one unit (two rows) a step
  for (let i = 0; i < 4; i++) { now += 900; s.receive([0xb0, 60, 1]); }
  assert.equal(moved(), 4 * JOG_ROWS);
  // fast: at the device's ~51 ms the steps grow toward four units
  h.calls.length = 0;
  for (let i = 0; i < 20; i++) { now += 51; s.receive([0xb0, 60, 1]); }
  const fast = moved();
  assert.ok(fast > 20 * JOG_ROWS * 2.5, `fast moved ${fast}`);
  assert.equal(fast % JOG_ROWS, 0);
  // reversing starts the speed afresh: the first step back is one unit
  h.calls.length = 0;
  now += 51; s.receive([0xb0, 60, 65]);
  assert.equal(moved(), -JOG_ROWS);
  // in a menu, a row a step
  h.calls.length = 0;
  h.dialog = true;
  now += 51; s.receive([0xb0, 60, 1]);
  assert.deepEqual(h.calls, [["dkey", "ArrowDown"]]);
});
