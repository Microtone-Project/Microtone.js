// The Microtone Player's radio (item 373): when a looping song is over, how
// the next one is matched to it, and the song walk the Music Hub lists songs
// by (the same RadioWatch, so the length it lists is the length that plays).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RadioWatch, RADIO_MIN_SECONDS, matchScale, glideSeconds, pickNext } from "../../src/player/radio.js";
import { walkSong } from "../../src/player/walk.js";
import { songFacts, tempoOf, displayTempo } from "../../src/player/songfacts.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../../src/doc/document.js";
import { setSamplingRate } from "../../core/engine/constants.js";
import { setRandomSource, makeSeededRandom } from "../../core/engine/rng.js";

/** Feed whole cues (row 0, one bar each at the default 16 rows a bar). */
const feed = (watch, cues, { dt = 1, level = 0.5 } = {}) =>
  cues.map((cue) => watch.observe({ cue, playing: true, dt, level }));

/**
 * Play `song` — a list of cues, each `bars` bars of `rowsPerBar` rows, the
 * last one jumping back to `loopTo` — row by row at `rowSec` a row, until the
 * watch calls it over. Returns where: the event, the time, the bar it left
 * at, and the cue and row it was on.
 */
function playSong(watch, { cues, loopTo = 0, bars = 1, rowsPerBar = 16, rowSec = 0.125, level = () => 0.5, limit = 10000 }) {
  watch.reset(0, rowsPerBar);
  let t = 0;
  watch.observe({ cue: cues[0], row: 0, playing: true, level: level(cues[0], 0, t) });
  let i = 0, row = 1;
  for (let step = 0; step < limit; step++) {
    if (row >= bars * rowsPerBar) { row = 0; i = i + 1 < cues.length ? i + 1 : cues.indexOf(loopTo); }
    t += rowSec;
    const cue = cues[i];
    const ev = watch.observe({ cue, row, playing: true, dt: rowSec, level: level(cue, row, t) });
    if (ev && ev !== "loop") return { ev, t, bar: watch.bar, cue, row };
    row++;
  }
  return null;
}

test("a jump back across the song is the loop", () => {
  const w = new RadioWatch();
  assert.deepEqual(feed(w, [0, 1, 2, 3, 4, 5, 6, 2]), [null, null, null, null, null, null, null, "loop"]);
  assert.equal(w.loopFrom, 6);
  assert.equal(w.loopTo, 2);
});

test("a short repeat is the song's structure, not its loop", () => {
  const w = new RadioWatch();
  // 0 1 2 1 2 3 …: back two cues, a written repeat
  assert.deepEqual(feed(w, [0, 1, 2, 1, 2, 3, 4, 5]), [null, null, null, null, null, null, null, null]);
  // …but back to the first cue is a loop however short the song is
  const two = new RadioWatch();
  assert.deepEqual(feed(two, [0, 1, 0]), [null, null, "loop"]);
  // a jump back to a cue never played is a jump, not a loop
  const skip = new RadioWatch();
  assert.deepEqual(feed(skip, [0, 5, 6, 7, 8, 9, 2]), [null, null, null, null, null, null, null]);
});

test("a song that stops by itself ends; one that never started does not", () => {
  const w = new RadioWatch();
  assert.equal(w.observe({ cue: 0, playing: false }), null);
  feed(w, [0, 1]);
  assert.equal(w.observe({ cue: 1, playing: false }), "end");
});

test("a looping song plays its 170 s, then leaves on the next 4-bar line", () => {
  // 7 one-bar cues of 2 s a bar (16 rows × 0.125 s), looping to the top:
  // 14 s a pass, so it goes round thirteen times before 170 s are up
  const w = new RadioWatch();
  const r = playSong(w, { cues: [0, 1, 2, 3, 4, 5, 6] });
  assert.equal(r.ev, "seam");
  assert.ok(r.t >= RADIO_MIN_SECONDS, `${r.t} s`);
  assert.equal(r.bar % 4, 0, `left at bar ${r.bar}`);
  assert.equal(r.row, 0, "on a bar line");
  // …and the first 4-bar line after the 170 s: 85 bars are 170 s, 88 is next
  assert.equal(r.bar, 88);
  assert.ok(r.t - RADIO_MIN_SECONDS < 4 * 2 + 1e-9);
});

test("bars are counted in the song's own rows, a new cue starting a new one", () => {
  // 64-row cues at 32 rows a bar: two bars a cue, 2 s a bar
  const w = new RadioWatch();
  const r = playSong(w, { cues: [0, 1, 2], bars: 2, rowsPerBar: 32, rowSec: 2 / 32 });
  assert.equal(r.ev, "seam");
  assert.equal(r.bar % 4, 0);
  assert.ok(r.row === 0 || r.row === 32, `row ${r.row}`);
  assert.ok(r.t >= RADIO_MIN_SECONDS);
});

test("the loop's own jump is never the seam: the song is heard coming round", () => {
  // an 88-bar intro and a 4-bar body looping: the first jump back, at
  // 184 s, is itself the start of bar 92, a 4-bar line past 170 s
  const cues = Array.from({ length: 92 }, (_, i) => i);
  const w = new RadioWatch();
  const r = playSong(w, { cues, loopTo: 88 });
  assert.equal(r.ev, "seam");
  assert.equal(w.loopTo, 88);
  // …so the seam is the next line, once the body has been heard again
  assert.equal(r.bar, 96);
  assert.equal(r.cue, 88);
});

test("the watch arms for the bar before the seam, and a halt there is the seam", () => {
  const w = new RadioWatch();
  w.reset(0, 16);
  let t = 0, armedAt = -1;
  w.observe({ cue: 0, row: 0, playing: true, level: 0.5 });
  for (let step = 1; step < 4000 && armedAt < 0; step++) {
    const cue = Math.floor(step / 16) % 7, row = step % 16;
    t += 0.125;
    w.observe({ cue, row, playing: true, dt: 0.125, level: 0.5 });
    if (w.armed) armedAt = w.bar;
  }
  assert.equal((armedAt + 1) % 4, 0, `armed in bar ${armedAt}`);
  // the host halted its engine on the line (taudplay stopAtBarLine)
  assert.equal(w.observe({ cue: 0, row: 0, playing: false, dt: 0.01, level: 0.5 }), "seam");
});

test("a song that fades out is over where it fades, and is not matched", () => {
  // a 16-bar song, its last four bars fading the global volume to nothing,
  // then looping: over at the loop, long before 170 s
  const cues = Array.from({ length: 16 }, (_, i) => i);
  const fading = (cue, row) => (cue < 12 ? 0.5 : 0.5 * Math.max(0, 1 - ((cue - 12) * 16 + row + 1) / 60));
  const w = new RadioWatch();
  const r = playSong(w, { cues, level: fading });
  assert.equal(r.ev, "fade");
  assert.equal(r.cue, 0, "at the jump back");
  assert.ok(r.t < 40);
  // …and one that fades then stops by itself
  const s = new RadioWatch();
  feed(s, [0, 1, 2, 3]);
  s.observe({ cue: 4, playing: true, dt: 1, level: 0.02 });
  assert.equal(s.observe({ cue: 4, playing: false }), "fade");
});

test("a rest before the loop is not a fade, nor a soft stretch of the song", () => {
  // nothing sounds on the last bar (level −1): what was last heard counts
  const cues = Array.from({ length: 8 }, (_, i) => i);
  const rest = (cue) => (cue === 7 ? -1 : 0.5);
  const w = new RadioWatch();
  assert.equal(playSong(w, { cues, level: rest }).ev, "seam");
  // a quiet passage in the middle does not end it either
  const quiet = (cue) => (cue === 3 ? 0.01 : 0.5);
  assert.equal(playSong(new RadioWatch(), { cues, level: quiet }).ev, "seam");
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
