// `sLan` — per-song, per-lane editor settings (item 339, TAUD_FILE_FORMAT.md
// §9.19). The first field is "show the second effect column on this lane".
// What is pinned: the codec reads what it writes and keeps what it does not
// know (a wider record, more lanes); the document reads and writes a lane's
// flags through the section, which travels with its lane through an insert and
// back through the undo, goes with a removed song, and survives a save; the
// store shows a lane the song says to show even through Hide all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  LANE_FOURCC, LANE_FLAG_FX2, LANE_STRIDE, parseLaneSection, buildLaneSection, laneByte, laneEntryFor,
} from "../../core/format/lane-section.js";
import { insertChannelOp } from "../../src/doc/ops.js";
import { UndoStack } from "../../src/doc/undo.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { Store } from "../../src/ui/store.js";

const corpusDir = fileURLToPath(new URL("../corpus/", import.meta.url));
const load = () => {
  const doc = new Document(parseTaud(readFileSync(corpusDir + "WHEN.taud")));
  if (!doc.wideCells) doc.upgradeToWideCells();
  return doc;
};

test("the codec reads what it writes, and drops an all-zero song", () => {
  const e = laneEntryFor(null, 5, 32);
  assert.equal(e.count, 32);
  assert.equal(e.stride, LANE_STRIDE);
  e.bytes[5 * e.stride] = LANE_FLAG_FX2;
  const payload = buildLaneSection(new Map([[0, e], [1, laneEntryFor(null, 0, 32)]]));
  const back = parseLaneSection(payload);
  assert.deepEqual([...back.keys()], [0], "song 1 said nothing, so it is not written");
  assert.equal(laneByte(back.get(0), 5), LANE_FLAG_FX2);
  assert.equal(laneByte(back.get(0), 6), 0);
  assert.equal(laneByte(back.get(0), 200), 0, "a lane past the count reads as zero");
  assert.equal(laneByte(back.get(0), 5, 40), 0, "a field past the stride reads as zero");
  assert.equal(buildLaneSection(new Map([[0, laneEntryFor(null, 0, 32)]])), null);
});

test("a newer writer's wider records and extra lanes are kept through an edit", () => {
  // 256 lanes of 40 bytes, with something in a field this version does not know.
  const wide = { count: 256, stride: 40, bytes: new Uint8Array(256 * 40) };
  wide.bytes[3 * 40 + 39] = 0x5a;
  wide.bytes[255 * 40] = 0x80;
  const doc = load();
  doc.setSection(LANE_FOURCC, buildLaneSection(new Map([[0, wide]])));
  assert.ok(doc.setLaneFlag(0, 3, LANE_FLAG_FX2, true));
  const e = parseLaneSection(doc.projSections.find((s) => s.fourcc === LANE_FOURCC).payload).get(0);
  assert.equal(e.stride, 40);
  assert.equal(e.count, 256);
  assert.equal(laneByte(e, 3, 39), 0x5a);
  assert.equal(laneByte(e, 255, 0), 0x80);
  assert.equal(laneByte(e, 3, 0), LANE_FLAG_FX2);
});

test("a lane's flag is the song's, and survives a save", async () => {
  const doc = load();
  assert.equal(doc.laneFlags(0, 4), 0);
  assert.equal(doc.projSections.some((s) => s.fourcc === LANE_FOURCC), false, "nothing said, no section");
  doc.setLaneFlag(0, 4, LANE_FLAG_FX2, true);
  assert.equal(doc.dirty, true);
  assert.equal(doc.laneFlags(0, 4), LANE_FLAG_FX2);
  const again = new Document(parseTaud(await doc.toBytes()));
  assert.equal(again.laneFlags(0, 4), LANE_FLAG_FX2);
  assert.equal(again.laneFlags(0, 5), 0);
  doc.setLaneFlag(0, 4, LANE_FLAG_FX2, false);
  assert.equal(doc.projSections.some((s) => s.fourcc === LANE_FOURCC), false, "cleared, the section goes");
});

test("the flag travels with its lane through an insert, and back through the undo", () => {
  const doc = load();
  const chans = doc.channelCount;
  doc.setLaneFlag(0, 2, LANE_FLAG_FX2, true);
  doc.setLaneFlag(0, chans - 1, LANE_FLAG_FX2, true);
  const undo = new UndoStack(doc);
  undo.apply(insertChannelOp(0, 1));
  assert.equal(doc.laneFlags(0, 1), 0, "the new lane says nothing");
  assert.equal(doc.laneFlags(0, 2), 0);
  assert.equal(doc.laneFlags(0, 3), LANE_FLAG_FX2, "lane 2's flag moved to 3 with it");
  assert.equal(doc.laneFlags(0, chans - 1), 0, "the last lane's fell off the end");
  undo.undo();
  assert.equal(doc.laneFlags(0, 2), LANE_FLAG_FX2);
  assert.equal(doc.laneFlags(0, 3), 0);
  assert.equal(doc.laneFlags(0, chans - 1), LANE_FLAG_FX2, "…and comes back with the undo");
});

test("removing a song takes its lane records, and later songs' move down", () => {
  const doc = load();
  doc.setLaneFlag(1, 0, LANE_FLAG_FX2, true);
  doc.setLaneFlag(2, 7, LANE_FLAG_FX2, true);
  doc.removeSongLanes(1);
  assert.equal(doc.laneFlags(1, 7), LANE_FLAG_FX2);
  assert.equal(doc.laneFlags(1, 0), 0);
});

test("the lane header writes the song's setting; Show all / Hide all do not, and Hide all keeps it", () => {
  const store = new Store();
  store.doc = load();
  store.songIndex = 0;
  store.toggleFx2Chan(3);
  assert.equal(store.fx2Chan(3), true);
  assert.equal(store.doc.laneFlags(0, 3), LANE_FLAG_FX2, "saved with the song");
  store.setAllFx2(true);
  assert.equal(store.fx2AllShown(), true);
  store.setAllFx2(false);
  assert.equal(store.fx2AllShown(), false, "the all-lanes switch can turn itself off");
  assert.equal(store.fx2Chan(3), true, "Hide all leaves lane 3 shown");
  assert.equal(store.fx2Chan(4), false);
  store.setAllFx2(true);
  store.toggleFx2Chan(5); // shown by Show all, hidden by its own header
  assert.equal(store.fx2Chan(5), false);
  assert.equal(store.doc.laneFlags(0, 5), 0);
  store.clearFx2(); // a song switch: the transient half goes
  assert.equal(store.fx2Chan(3), true);
  assert.equal(store.fx2Any(), true, "the column budget counts lanes the song shows");
});
