// The Microtone Player's radio (item 373): when a looping song is over, how
// the next one is matched to it, and the song walk the Music Hub lists songs
// by (the same LoopWatch, so the length it lists is the length that plays).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LoopWatch, matchScale, glideSeconds, pickNext } from "../../src/player/radio.js";
import { walkSong } from "../../src/player/walk.js";
import { songFacts, tempoOf, displayTempo } from "../../src/player/songfacts.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { setSamplingRate } from "../../core/engine/constants.js";
import { setRandomSource, makeSeededRandom } from "../../core/engine/rng.js";

const feed = (watch, cues) => cues.map((c) => watch.observe(c, true));

test("a jump back across the song is the loop; the cue after it is the seam", () => {
  const w = new LoopWatch();
  assert.deepEqual(feed(w, [0, 1, 2, 3, 4, 5, 6, 2]), [null, null, null, null, null, null, null, "loop"]);
  assert.equal(w.loopFrom, 6);
  assert.equal(w.loopTo, 2);
  // the cue it landed on plays once more; the next change is the seam
  assert.equal(w.observe(2, true), null);
  assert.equal(w.observe(3, true), "seam");
});

test("a short repeat is the song's structure, not its loop", () => {
  const w = new LoopWatch();
  // 0 1 2 1 2 3 …: back two cues, a written repeat
  assert.deepEqual(feed(w, [0, 1, 2, 1, 2, 3, 4, 5]), [null, null, null, null, null, null, null, null]);
  // …but back to the first cue is a loop however short the song is
  const two = new LoopWatch();
  assert.deepEqual(feed(two, [0, 1, 0]), [null, null, "loop"]);
  // a jump back to a cue never played is a jump, not a loop
  const skip = new LoopWatch();
  assert.deepEqual(feed(skip, [0, 5, 6, 7, 8, 9, 2]), [null, null, null, null, null, null, null]);
});

test("a song that stops by itself ends; one that never started does not", () => {
  const w = new LoopWatch();
  assert.equal(w.observe(0, false), null);
  w.observe(0, true);
  w.observe(1, true);
  assert.equal(w.observe(1, false), "end");
});

test("the incoming song is matched to the outgoing tempo, folded by octaves", () => {
  assert.equal(matchScale(20, 20), 1);
  assert.equal(matchScale(25, 20), 1.25);
  // twice as fast is already matched at half time
  assert.equal(matchScale(40, 20), 1);
  assert.equal(matchScale(10, 20), 1);
  assert.ok(Math.abs(matchScale(30, 20) - 0.75) < 1e-12);
  for (const [a, b] of [[7, 53], [300, 2], [1, 1e4]]) {
    const s = matchScale(a, b);
    assert.ok(s >= Math.SQRT1_2 && s < Math.SQRT2, `${a}/${b} → ${s}`);
  }
  assert.equal(matchScale(0, 20), 1);
});

test("the glide lasts four of the incoming song's bars, within 4…20 s", () => {
  // 125 BPM speed 6: a row is 0.12 s, a 16-row bar 1.92 s, four bars 7.68 s
  assert.ok(Math.abs(glideSeconds(125, 6, 16) - 7.68) < 1e-9);
  assert.equal(glideSeconds(280, 1, 16), 4);
  assert.equal(glideSeconds(25, 31, 64), 20);
});

test("the next song is never the one playing, nor a recent one while others remain", () => {
  const pool = [{ id: "a" }, { id: "b" }, { id: "c" }];
  for (let i = 0; i < 50; i++) {
    const n = pickNext(pool, "a", ["b"], () => i / 50);
    assert.equal(n.id, "c");
  }
  assert.equal(pickNext([{ id: "a" }], "a").id, "a");
  assert.equal(pickNext([], "a"), null);
});

test("the tempo unit is BPM ÷ speed", () => {
  assert.ok(Math.abs(tempoOf(747, 14) - 53.357) < 1e-3);
  assert.equal(displayTempo(tempoOf(125, 6)), 125);
});

test("the facts come from the file, and the walk agrees with the player's radio", () => {
  setSamplingRate(48000);
  setRandomSource(makeSeededRandom(1));
  try {
    const bytes = readFileSync(new URL("../../assets/demo_projects/Huygens_clock.taud", import.meta.url));
    const parsed = parseTaud(bytes);
    const facts = songFacts(new Document(parsed));
    assert.ok(facts.title.length > 0);
    assert.equal(facts.speed, parsed.songs[0].tickRate);
    assert.equal(facts.tuning.length > 0, true);
    const walk = walkSong(parsed, 0, { limitSec: 900 });
    assert.ok(walk.seconds > 10, `${walk.seconds} s`);
    assert.ok(walk.tempo >= walk.minTempo - 1e-9 && walk.tempo <= walk.maxTempo + 1e-9);
    assert.notEqual(walk.ending, "limit");
  } finally {
    setRandomSource(null);
  }
});
