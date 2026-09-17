import { test } from "node:test";
import assert from "node:assert/strict";

import { JamKeyboard } from "../../src/ui/jam.js";
import { semiToNoteInTable, JAM_SEMIS } from "../../src/ui/edit.js";
import { JAM_VOICES, JAM_VOICE_BASE, TOTAL_VOICES } from "../../src/engine/constants.js";

/** `view`/`record` decide chording (item 140.1): the default is the Timeline
 *  with record OFF, i.e. a pure audition, i.e. polyphonic. */
function mkJam(opts = {}) {
  const log = [];
  const store = {
    audio: {
      jamNote: (ph, voice, note, inst, audition) => log.push({ t: "on", voice, note, inst, audition }),
      jamStopVoice: (ph, voice) => log.push({ t: "off", voice }),
    },
    cursor: { ch: 3 },
    pitchPreset: undefined,
    view: opts.view ?? "timeline",
    record: opts.record ?? false,
  };
  return { jam: new JamKeyboard(store), log };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Release and wait out the grace window, so the note-off has landed. */
const release = async (jam, code) => { jam.up(code); await sleep(jam.releaseGraceMs + 20); };

test("jam: a held key is one note — autorepeat never retriggers", async () => {
  const { jam, log } = mkJam();
  assert.ok(jam.down("KeyA", false));
  assert.equal(log.length, 1);
  assert.equal(log[0].note, semiToNoteInTable(4, JAM_SEMIS.KeyA, undefined));

  for (let i = 0; i < 5; i++) assert.ok(jam.down("KeyA", true), "repeat is still consumed");
  assert.equal(log.length, 1, "no retrigger from the repeat flag");

  // Backstop: a host that leaves `repeat` unset must not retrigger either.
  jam.down("KeyA", false);
  assert.equal(log.length, 1, "no retrigger from a keydown for an already-held key");

  await release(jam, "KeyA");
  assert.deepEqual(log.map((e) => e.t), ["on", "off"]);
});

test("jam: autorepeat delivered as keyup+keydown pairs is not a release", async () => {
  const { jam, log } = mkJam();
  jam.down("KeyA", false);
  // X11 without detectable autorepeat: each repeat is a full up/down pair,
  // arriving back to back. The note must ride straight through them.
  for (let i = 0; i < 8; i++) {
    jam.up("KeyA");
    jam.down("KeyA", false);
    await sleep(1);
  }
  assert.deepEqual(log.map((e) => e.t), ["on"], "no note-off, no retrigger");
  assert.ok(jam.held.has("KeyA"), "still held");

  await release(jam, "KeyA");
  assert.deepEqual(log.map((e) => e.t), ["on", "off"], "the real release still ends it");
});

test("jam: the release grace is short and can be switched off", async () => {
  const { jam, log } = mkJam();
  assert.ok(jam.releaseGraceMs > 0 && jam.releaseGraceMs <= 50, "inaudible, sub-strike-rate");
  jam.down("KeyA", false);
  jam.up("KeyA");
  assert.equal(log.length, 1, "the note-off waits for its would-be repeat partner");
  await sleep(jam.releaseGraceMs + 20);
  assert.equal(log.at(-1).t, "off");

  jam.releaseGraceMs = 0;
  jam.down("KeyA", false);
  jam.up("KeyA");
  assert.equal(log.at(-1).t, "off", "grace 0 releases synchronously");
});

// ── item 140: auditions live on the dedicated jam bank, never on a lane ─────

test("jam: every audition lands on the jam bank, above the song's channels", async () => {
  for (const opts of [{}, { record: true }, { view: "instruments" }]) {
    const { jam, log } = mkJam(opts);
    jam.releaseGraceMs = 0;
    jam.down("KeyA", false);
    jam.hold("KeyS", 0x5000);
    for (const e of log) {
      assert.ok(e.voice >= JAM_VOICE_BASE && e.voice < TOTAL_VOICES,
        `voice ${e.voice} is a jam voice (${JSON.stringify(opts)})`);
    }
  }
});

// ── item 140.1: chord where the piano auditions, mono where it enters ──

test("jam: record mode is monophonic — last key wins on ONE voice", async () => {
  const { jam, log } = mkJam({ record: true });
  jam.down("KeyA", false);
  jam.down("KeyS", false);
  const ons = log.filter((e) => e.t === "on");
  assert.equal(ons.length, 2);
  assert.equal(ons[0].voice, ons[1].voice, "both keys sound on the same voice");
  await release(jam, "KeyA");
  assert.ok(!log.some((e) => e.t === "off"), "the still-held key keeps sounding");
  await release(jam, "KeyS");
  assert.equal(log.at(-1).t, "off", "the last release stops the voice");
  assert.equal(log.at(-1).voice, ons[0].voice);
});

test("jam: with record off held keys chord, and each release stops its own note", async () => {
  const { jam, log } = mkJam();
  jam.releaseGraceMs = 0;
  jam.down("KeyA", false);
  jam.down("KeyS", false);
  jam.down("KeyD", false);
  const ons = log.filter((e) => e.t === "on");
  assert.equal(new Set(ons.map((e) => e.voice)).size, 3, "three notes, three voices");

  jam.up("KeyS");
  assert.deepEqual(log.at(-1), { t: "off", voice: ons[1].voice }, "only the released key stops");
  assert.equal(jam.held.size, 2, "the other two are still down");
  jam.up("KeyA");
  jam.up("KeyD");
  assert.deepEqual(log.filter((e) => e.t === "off").map((e) => e.voice),
    [ons[1].voice, ons[0].voice, ons[2].voice]);
});

test("jam: the Instruments/Samples views chord even in record mode", () => {
  const { jam, log } = mkJam({ view: "instruments", record: true });
  jam.down("KeyA", false);
  jam.down("KeyS", false);
  const ons = log.filter((e) => e.t === "on");
  assert.notEqual(ons[0].voice, ons[1].voice, "record mode enters nothing here — chord");
  assert.equal(ons[0].audition, true, "…and still snaps a strict meta to a sounding note");
});

test("jam: a chord bigger than the bank steals the oldest voice", () => {
  const { jam, log } = mkJam();
  jam.releaseGraceMs = 0;
  const codes = Object.entries(JAM_SEMIS).sort((a, b) => a[1] - b[1]).map((e) => e[0]);
  assert.ok(codes.length > JAM_VOICES, "the keyboard has more keys than the bank has voices");
  for (const code of codes) jam.down(code, false);
  const voices = log.filter((e) => e.t === "on").map((e) => e.voice);
  assert.equal(new Set(voices).size, JAM_VOICES, "every bank voice is in use, none doubled up early");
  for (const v of voices) assert.ok(v >= JAM_VOICE_BASE && v < TOTAL_VOICES);
  // The stolen keys' releases must not silence the voice their thief is on.
  jam.up(codes[0]);
  assert.equal(log.at(-1).t, "on", "the first key's voice was taken over — nothing to stop");
});

test("jam: hold() (record-mode entry) shares the held-key bookkeeping", async () => {
  const { jam, log } = mkJam({ record: true });
  jam.currentInst = 0x12;
  jam.hold("KeyA", 0x1234);
  assert.equal(log.length, 1);
  assert.deepEqual({ t: log[0].t, note: log[0].note, inst: log[0].inst }, { t: "on", note: 0x1234, inst: 0x12 });
  // A plain jam of the same key while it is held must not retrigger it...
  jam.down("KeyA", false);
  assert.equal(log.length, 1);
  // ...and its release ends the note.
  await release(jam, "KeyA");
  assert.equal(log.at(-1).t, "off");
});

test("jam: a keyup for a key we never took still stops a stray audition", () => {
  const { jam, log } = mkJam();
  jam.store.audio.jamNote(0, JAM_VOICE_BASE, 0x1000, 1);   // jammed by some other path
  jam.up("KeyA");
  assert.deepEqual(log.at(-1), { t: "off", voice: -1 }, "clears the bank, not the song's voices");
});

test("jam: allUp() drops everything (focus loss eats the keyup)", async () => {
  const { jam, log } = mkJam();
  jam.down("KeyA", false);
  jam.down("KeyS", false);
  jam.up("KeyA");            // release in flight when focus goes
  jam.allUp();
  assert.deepEqual(log.at(-1), { t: "off", voice: -1 });
  assert.equal(jam.held.size, 0);
  await sleep(jam.releaseGraceMs + 20);
  assert.equal(log.filter((e) => e.t === "off").length, 1, "the cancelled release never fires");
  assert.equal(jam.down("KeyA", false), true);
  assert.equal(log.at(-1).t, "on", "the keyboard is usable again");
});

test("jam: non-piano keys are not consumed", () => {
  const { jam, log } = mkJam();
  assert.equal(jam.down("ArrowDown", false), false);
  assert.equal(jam.up("ArrowDown"), false);
  assert.equal(log.length, 0);
});

test("jam: the whole extended region plays, half-sharps included (item 133)", () => {
  const { jam, log } = mkJam({ record: true }); // mono: one voice, twenty keys
  // Both physical rows, in pitch order — every key sounds, and the three
  // half-sharp keys fall between the white keys they sit between.
  const codes = Object.entries(JAM_SEMIS).sort((a, b) => a[1] - b[1]).map((e) => e[0]);
  assert.equal(codes.length, 20, "10 + 10 physical keys");
  for (const code of codes) {
    assert.ok(jam.down(code, false), `${code} is a piano key`);
    assert.equal(log.at(-1).note, semiToNoteInTable(4, JAM_SEMIS[code], undefined), code);
  }
  const notes = log.filter((e) => e.t === "on").map((e) => e.note);
  assert.equal(notes.length, 20);
  for (let i = 1; i < notes.length; i++) assert.ok(notes[i] > notes[i - 1], "rising");
  // Twenty keys down, ONE voice: only the last release stops it.
  jam.releaseGraceMs = 0; // the grace window is covered above; keep this quick
  for (const code of codes.slice(0, -1)) jam.up(code);
  assert.ok(!log.some((e) => e.t === "off"), "still sounding while any key is held");
  jam.up(codes.at(-1));
  assert.equal(log.at(-1).t, "off");
});
