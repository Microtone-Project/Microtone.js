// The lanes as the song arrives at a row, for a stopped control surface
// (src/ui/lanechase.js): the engine's own chase, on an engine of its own,
// kept in step with edits.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseTaud } from "../../core/format/taud-parse.js";
import { EffectOp } from "../../core/engine/tables.js";
import { Document } from "../../src/doc/document.js";
import { setCellOp, setSongScalarOp } from "../../src/doc/ops.js";
import { LaneChase } from "../../src/ui/lanechase.js";

const demo = (name) => fileURLToPath(new URL(`../../assets/demo_projects/${name}.taud`, import.meta.url));
const { OP_M, OP_N } = EffectOp;

/** A lane of cue 0 whose rows 0…7 neither set nor slide its volume. */
function quietLane(doc) {
  const cue = doc.songs[0].cues[0];
  for (let ch = 0; ch < doc.channelCount; ch++) {
    const pat = doc.patternAt(0, cue[ch]);
    if (!pat) continue;
    const touches = (c) => [c.effect, c.effect2].some((e) => e === OP_M || e === OP_N);
    if (!pat.slice(0, 8).some(touches)) return { ch, pat: cue[ch] };
  }
  throw new Error("no quiet lane in cue 0");
}

test("a lane as the song arrives at a row, edits included", () => {
  const doc = new Document(parseTaud(readFileSync(demo("Huygens_clock"))));
  doc.upgradeToWideCells();
  const { ch, pat } = quietLane(doc);
  const lc = new LaneChase({ compile: false });
  const before = lc.lane(doc, 0, 0, 3, ch).vol;
  // M $4000 on row 1: in force from row 2, not on row 1 itself (the chase stops
  // before the row's own event)
  const edit = (row, arg) => {
    const op = setCellOp(0, pat, row, { effect: OP_M, effectArg: arg });
    op.apply(doc);
    lc.onDirty(op.dirty());
  };
  edit(1, 0x4000);
  assert.equal(lc.lane(doc, 0, 0, 1, ch).vol, lc.lane(doc, 0, 0, 0, ch).vol);
  assert.equal(lc.lane(doc, 0, 0, 2, ch).vol, 0x40);
  assert.equal(lc.lane(doc, 0, 0, 7, ch).vol, 0x40);
  assert.notEqual(before, 0x40);
  // an edited pattern is uploaded again, without building the engine afresh
  const eng = lc.eng;
  edit(1, 0x8000);
  assert.equal(lc.lane(doc, 0, 0, 3, ch).vol, 0x80);
  assert.equal(lc.eng, eng);
  // anything else builds it afresh, and the answer still holds
  const op = setSongScalarOp(0, "bpm", doc.songs[0].bpm + 1);
  op.apply(doc);
  lc.onDirty(op.dirty());
  assert.equal(lc.lane(doc, 0, 0, 3, ch).vol, 0x80);
  assert.notEqual(lc.eng, eng);
  // another document is another engine; release lets it go
  lc.release();
  assert.equal(lc.eng, null);
});
