// The layout a PROJECT carries (item 189.1) — the `PKey` Project-Data section.
//
// A keymap is a performer preference everywhere else in the app, and this is
// the one place it is not: a piece written in a nine-note unequal temperament
// on a split four-row board cannot be edited on whatever keyboard its reader
// happens to have, so the piece is allowed to carry its own. What that costs is
// exactly one rule per direction — the section survives a save, and the layout
// in it outranks the one the user picked while that project is open.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { parseTaud } from "../../src/format/taud-parse.js";
import { KEYMAP_FOURCC } from "../../src/format/taud-const.js";
import { Document } from "../../src/doc/document.js";
import { setSectionOp } from "../../src/doc/ops.js";
import { UndoStack } from "../../src/doc/undo.js";
import { KeymapLibrary } from "../../src/ui/keymaplib.js";
import {
  BUILTIN_KEYMAPS, buildTaudkey, normaliseKeymap, resolveKeymap, builtinKeymap,
} from "../../src/ui/keymap.js";
import { pitchTablePresets } from "../../src/ui/pitchtables.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const whenBytes = await readFile(corpusDir + "WHEN.taud");

const P12 = pitchTablePresets[120];

/** The Bosanquet-over-nine-degrees layout item 189 is about: four rows, the
 *  upper hand twenty degrees above the lower. */
const SPLIT = normaliseKeymap({
  name: "Bosanquet9", unit: "deg", rows: ["Z", "A", "Q", "N"],
  origin: { code: "KeyA", value: -1 }, x: 2, y: -1, upper: 20,
});

const encode = (spec) => new TextEncoder().encode(buildTaudkey(spec));

/** The bits of the app store the library actually touches, and nothing else. */
function fakeStore(doc = null) {
  const subs = new Map();
  return {
    doc,
    pitchPreset: P12,
    songIndex: 0,
    keymap: null,
    on(topic, fn) { (subs.get(topic) ?? subs.set(topic, new Set()).get(topic)).add(fn); },
    emit(topic, payload) { for (const fn of subs.get(topic) ?? []) fn(payload); },
  };
}

/** A library that has finished booting, with no OPFS and no saved layouts —
 *  `init()` needs both, and every rule under test is about what the DOCUMENT
 *  carries rather than about what is on disk. */
function readyLibrary(store, chosen = "Piano") {
  const lib = new KeymapLibrary(store);
  lib._ready = true;
  lib.chosenName = chosen;
  return lib;
}

const loadWhen = () => new Document(parseTaud(whenBytes));

test("PKey: the section is the .taudkey text, and it survives a save", () => {
  const doc = loadWhen();
  assert.equal(doc.embeddedKeymap(), null, "the corpus file carries no layout");

  doc.setSection(KEYMAP_FOURCC, encode(SPLIT));
  assert.equal(doc.embeddedKeymap(), buildTaudkey(SPLIT), "read back verbatim");

  const reloaded = new Document(parseTaud(doc.toBytes()));
  assert.equal(reloaded.embeddedKeymap(), buildTaudkey(SPLIT), "…and through the container");
});

test("PKey: embedding and removing are one undo step each", () => {
  const doc = loadWhen();
  const undo = new UndoStack(doc);

  undo.apply(setSectionOp(KEYMAP_FOURCC, encode(SPLIT)));
  assert.equal(doc.embeddedKeymap(), buildTaudkey(SPLIT));
  undo.undo();
  assert.equal(doc.embeddedKeymap(), null, "one Ctrl+Z takes the whole layout back out");
  undo.redo();
  assert.equal(doc.embeddedKeymap(), buildTaudkey(SPLIT));

  // …and removing it is the same edit in the other direction.
  undo.apply(setSectionOp(KEYMAP_FOURCC, null));
  assert.equal(doc.embeddedKeymap(), null);
  undo.undo();
  assert.equal(doc.embeddedKeymap(), buildTaudkey(SPLIT), "which one Ctrl+Z puts back");
});

test("PKey: the library lists the project's layout and can find it by name", () => {
  const doc = loadWhen();
  doc.setSection(KEYMAP_FOURCC, encode(SPLIT));
  const lib = readyLibrary(fakeStore(doc));

  const entry = lib.entries().find((e) => e.name === SPLIT.name);
  assert.ok(entry, "it is in the list");
  assert.equal(entry.project, true, "tagged as the project's own");
  assert.equal(entry.builtin, false, "and not as a shipped built-in");
  assert.deepEqual(lib.find(SPLIT.name), SPLIT);

  // Every one of the forty keys came back, split included — the list entry is
  // the layout itself, not a name with nothing behind it.
  assert.equal(resolveKeymap(lib.find(SPLIT.name)).get("KeyQ"), 18);
});

test("PKey: a saved layout of the same name still wins over the project's copy", () => {
  // `find` is what the CHOSEN name resolves through, and a layout you are
  // editing has to stay the one you are editing — otherwise embedding it once
  // would quietly hand every later edit to the frozen copy in the song.
  const doc = loadWhen();
  doc.setSection(KEYMAP_FOURCC, encode(SPLIT));
  const lib = readyLibrary(fakeStore(doc));
  const mine = normaliseKeymap({ ...SPLIT, upper: 7 });
  lib.user.set(mine.name, mine);
  assert.equal(lib.find(SPLIT.name).upper, 7);
});

test("PKey: the project's layout takes the keyboard, and gives it back", () => {
  const doc = loadWhen();
  doc.setSection(KEYMAP_FOURCC, encode(SPLIT));
  const store = fakeStore(doc);
  const lib = readyLibrary(store, "Piano");

  lib.applyForPreset(P12, null);
  assert.equal(lib.activeName, SPLIT.name, "opening the project brings up its layout");
  assert.equal(lib.chosenName, "Piano", "…without changing what the user picked");

  // Close the project and the keyboard goes back to the chosen layout — the
  // same bargain a tuning-bound layout makes.
  store.doc = null;
  lib.applyForPreset(P12, null);
  assert.equal(lib.activeName, "Piano");
});

test("PKey: the project's layout outranks one bound to the tuning", () => {
  // Both volunteer for the same song. The project's copy is the more specific
  // statement of the two — "this song plays on THIS keyboard", not "this tuning
  // suits that one" — so it is the one that gets the keyboard.
  const shier = builtinKeymap("Shi'er lü (十二律)");
  const doc = loadWhen();
  doc.setSection(KEYMAP_FOURCC, encode(SPLIT));
  const lib = readyLibrary(fakeStore(doc), "Piano");

  lib.applyForPreset(P12, shier.notation);
  assert.equal(lib.activeName, SPLIT.name);

  // Without one embedded, the tuning binding is still what volunteers.
  doc.setSection(KEYMAP_FOURCC, null);
  lib.applyForPreset(P12, shier.notation);
  assert.equal(lib.activeName, shier.name);
});

test("PKey: a section edit re-applies the keyboard, undo included", () => {
  // Ctrl+Z lands wherever the user is standing, so the library listens for the
  // tag rather than trusting the Keymap tab to tell it.
  const doc = loadWhen();
  const store = fakeStore(doc);
  const lib = readyLibrary(store, "Piano");
  const undo = new UndoStack(doc, (dirty) => store.emit("edit", dirty));

  undo.apply(setSectionOp(KEYMAP_FOURCC, encode(SPLIT)));
  assert.equal(lib.activeName, SPLIT.name, "embedding puts it on the keyboard");
  undo.undo();
  assert.equal(lib.activeName, "Piano", "and undoing takes it off again");

  // An unrelated section edit must not disturb the keyboard at all.
  lib.activeName = "sentinel";
  undo.apply(setSectionOp("PNam", new TextEncoder().encode("hello")));
  assert.equal(lib.activeName, "sentinel");
});

test("PKey: a layout this build cannot read is ignored, not fatal", () => {
  const doc = loadWhen();
  const store = fakeStore(doc);
  const lib = readyLibrary(store, "Piano");

  for (const bad of ["TAUDKEY 99\nname  From the future\n", "not a keymap at all", ""]) {
    doc.setSection(KEYMAP_FOURCC, new TextEncoder().encode(bad));
    assert.equal(lib.projectKeymap(), null, JSON.stringify(bad));
    assert.equal(lib.applyForPreset(P12, null).name, "Piano", "the chosen layout still plays");
    // …and the bytes are left exactly where they were, so a round trip through
    // this build does not throw away a layout a later one would understand.
    assert.equal(doc.embeddedKeymap(), bad);
  }
});

test("PKey: isEmbedded compares what would be WRITTEN, not object identity", () => {
  // It is what the tab's one button reads to decide between Embed and Remove,
  // so an edit to the layout in hand has to make it say Embed again.
  const doc = loadWhen();
  const lib = readyLibrary(fakeStore(doc));
  assert.equal(lib.isEmbedded(SPLIT), false, "nothing embedded yet");

  doc.setSection(KEYMAP_FOURCC, encode(SPLIT));
  assert.equal(lib.isEmbedded(SPLIT), true);
  assert.equal(lib.isEmbedded({ ...SPLIT }), true, "a copy is the same layout");
  assert.equal(lib.isEmbedded(normaliseKeymap({ ...SPLIT, upper: 21 })), false,
    "one nudge and the song's copy is no longer this layout");
  assert.equal(lib.isEmbedded(BUILTIN_KEYMAPS[0]), false);
});
