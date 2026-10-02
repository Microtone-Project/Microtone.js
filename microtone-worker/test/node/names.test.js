// Name-table edits for instruments (INam) and patterns (pNam). Mirrors the
// SNam rename coverage in sampleedit.test.js: byte-level splice keeps siblings
// verbatim, setSectionOp is invertible byte-exact, and a FRESH pNam section
// survives the toBytes → parseTaud round-trip (WHEN has no pNam to start).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { setSectionOp, setProjectStringOp } from "../../src/doc/ops.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { UndoStack } from "../../src/doc/undo.js";
import { decodeProjectString, encodeProjectString } from "../../core/format/names.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const loadWhen = () => new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));

test("buildInstrumentNames splices INam by slot; siblings verbatim; op invertible", () => {
  const doc = loadWhen();
  const slots = doc.usedInstrumentSlots();
  const slot = slots[2];
  const sibling = slots[1];
  const siblingName = doc.instrumentName(sibling); // must stay byte-identical
  const before = Buffer.from(doc.toBytes());
  const undo = new UndoStack(doc);

  undo.apply(setSectionOp("INam", doc.buildInstrumentNames(slot, "Lead Synth")));
  assert.equal(doc.instrumentName(slot), "Lead Synth", "renamed entry");
  assert.equal(doc.instrumentName(sibling), siblingName, "sibling untouched");
  const after = Buffer.from(doc.toBytes());
  assert.ok(!after.equals(before), "bytes changed");

  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo byte-exact");
  undo.redo();
  assert.ok(Buffer.from(doc.toBytes()).equals(after), "redo byte-exact");
});

test("buildPatternNames creates a fresh pNam section that round-trips", () => {
  const doc = loadWhen();
  assert.equal(doc.patternName(0), "", "starts unnamed (no pNam)");
  assert.ok(!doc.projSections.some((s) => s.fourcc === "pNam"), "no pNam yet");
  const before = Buffer.from(doc.toBytes());
  const undo = new UndoStack(doc);

  // Two names at non-adjacent indices — the gap between must be empty entries.
  undo.apply(setSectionOp("pNam", doc.buildPatternNames(0, "Intro")));
  undo.apply(setSectionOp("pNam", doc.buildPatternNames(3, "Chorus")));
  assert.equal(doc.patternName(0), "Intro");
  assert.equal(doc.patternName(3), "Chorus");
  assert.equal(doc.patternName(1), "", "gap entry empty");

  // The new section survives serialisation and re-parse.
  const reloaded = new Document(parseTaud(doc.toBytes()));
  assert.equal(reloaded.patternName(0), "Intro", "pNam persisted through write/read");
  assert.equal(reloaded.patternName(3), "Chorus");

  undo.undo();
  undo.undo();
  assert.ok(Buffer.from(doc.toBytes()).equals(before), "undo removes the fresh section byte-exact");
});

// ── Project strings, §9.2 (item 115) ──

test("project strings round-trip; names escape, the message stays UTF-8", () => {
  const doc = loadWhen();
  const undo = new UndoStack(doc);
  const write = (fourcc, text) =>
    undo.apply(setProjectStringOp(fourcc, encodeProjectString(fourcc, text)));

  write("PCom", "Frédéric");
  write("PCpr", "© 2026 Someone");
  write("PMsg", "first line\r\nsecond — with an em dash\rthird");

  // Names are stored ASCII-escaped for the ASCII-only readers; the message is
  // plain UTF-8 with its CR / CRLF line breaks normalised to LF.
  assert.equal(doc.projectString("PCom"), "Fr\\u00E9d\\u00E9ric");
  assert.equal(doc.projectString("PCpr"), "\\u00A9 2026 Someone");
  assert.equal(doc.projectString("PMsg"), "first line\nsecond — with an em dash\nthird");

  // What the editor shows is the decoded form of whichever convention applies.
  assert.equal(decodeProjectString("PCom", doc.projectString("PCom")), "Frédéric");
  assert.equal(decodeProjectString("PMsg", doc.projectString("PMsg")),
    "first line\nsecond — with an em dash\nthird");

  const reloaded = new Document(parseTaud(doc.toBytes()));
  for (const cc of ["PCom", "PCpr", "PMsg"]) {
    assert.equal(reloaded.projectString(cc), doc.projectString(cc), `${cc} survived write/read`);
  }
});

test("PNam op keeps the cached meta.projectName in step through undo and redo", () => {
  const doc = loadWhen();
  const undo = new UndoStack(doc);
  const before = doc.meta.projectName;
  const beforeBytes = Buffer.from(doc.toBytes());

  undo.apply(setProjectStringOp("PNam", encodeProjectString("PNam", "Neue Œuvre")));
  assert.equal(doc.projectString("PNam"), "Neue \\u0152uvre");
  assert.equal(doc.meta.projectName, doc.projectString("PNam"), "cache follows the section");

  undo.undo();
  assert.equal(doc.meta.projectName, before, "cache restored by undo");
  assert.ok(Buffer.from(doc.toBytes()).equals(beforeBytes), "undo byte-exact");
  undo.redo();
  assert.equal(doc.meta.projectName, "Neue \\u0152uvre", "cache restored by redo");
});

test("an absent project string reads null, and a NUL terminator is optional", () => {
  const doc = loadWhen();
  assert.equal(doc.projectString("PMsg"), null, "no section → null, not empty string");
  // A producer may omit the terminator (taud_common.py does) — read the lot.
  doc.setSection("PMsg", new TextEncoder().encode("no terminator"));
  assert.equal(doc.projectString("PMsg"), "no terminator");
  // ...and the encoder's own payload ends in one, which must not be returned.
  const payload = encodeProjectString("PMsg", "terminated");
  assert.equal(payload[payload.length - 1], 0);
  doc.setSection("PMsg", payload);
  assert.equal(doc.projectString("PMsg"), "terminated");
});

test("name builders \\uHHHH-escape convention passes bytes through verbatim", () => {
  const doc = loadWhen();
  // The frontend escapes non-ASCII before storing; the builder is byte-level.
  const escaped = "caf\\u00E9";
  const payload = doc.buildInstrumentNames(doc.usedInstrumentSlots()[0], escaped);
  doc.setSection("INam", payload);
  assert.equal(doc.instrumentName(doc.usedInstrumentSlots()[0]), escaped, "stored verbatim");
});
