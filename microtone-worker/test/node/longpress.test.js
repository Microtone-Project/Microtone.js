// Press-and-hold → context menu (item 190.1), and the gauge that shows it
// coming. The timer and the slop rule are the whole of the gesture, and both
// are pure — the grids only supply canvas coordinates and a rectangle.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LongPress, LONGPRESS_MS, LONGPRESS_SLOP, longPressable, paintPerimeterGauge,
} from "../../src/ui/longpress.js";

/** A clock under the test's control — the gesture is all about elapsed time,
 *  and a test that waited for it in real seconds would be a slow test. */
function fakeClock() {
  let t = 1000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/** The bits of a PointerEvent the gesture reads. */
const ptr = (opts = {}) => ({ pointerId: 1, pointerType: "touch", clientX: 0, clientY: 0, ...opts });

function harness(clock = fakeClock()) {
  const fired = [];
  let paints = 0;
  const hold = new LongPress({
    now: clock.now,
    onFire: (press) => fired.push(press),
    onPaint: () => { paints++; },
  });
  return { hold, fired, clock, paints: () => paints };
}

test("longpress: a mouse is the one pointer the gesture is NOT armed for", () => {
  // It has the button this whole gesture exists to replace, and arming it would
  // turn a held click — the start of every block drag — into a menu.
  assert.equal(longPressable({ pointerType: "mouse" }), false);
  assert.equal(longPressable({ pointerType: "touch" }), true);
  assert.equal(longPressable({ pointerType: "pen" }), true);
  assert.equal(longPressable({}), false, "and an event with no pointerType is not one");
  // The empty string is what a PointerEvent nobody's hand made reports — a
  // synthetic one, or some assistive tech. "Anything but a mouse" would have
  // armed the gesture for every one of them.
  assert.equal(longPressable({ pointerType: "" }), false);
  assert.equal(longPressable(undefined), false);
});

test("longpress: a held press fires once, with what it was pressed on", async () => {
  const { hold, fired, clock } = harness();
  const rect = { x: 10, y: 20, w: 100, h: 16 };
  hold.start(ptr({ clientX: 40, clientY: 50 }), 30, 44, rect);
  assert.equal(hold.active, true);

  clock.advance(LONGPRESS_MS);
  await new Promise((r) => setTimeout(r, LONGPRESS_MS + 40));
  assert.equal(fired.length, 1);
  assert.equal(fired[0].clientX, 40, "the menu opens where the finger is");
  assert.equal(fired[0].clientY, 50);
  assert.deepEqual(fired[0].rect, rect);
  // Cleared BEFORE the menu opens: the menu is modal and awaits, and a press
  // still in flight would go on painting its ring underneath it.
  assert.equal(hold.active, false);
});

test("longpress: moving past the slop cancels it — the press was a drag", async () => {
  const { hold, fired } = harness();
  hold.start(ptr(), 100, 100, null);
  assert.equal(hold.moved(ptr(), 100 + LONGPRESS_SLOP, 100), false, "a finger is never still");
  assert.equal(hold.active, true);
  assert.equal(hold.moved(ptr(), 100, 100 + LONGPRESS_SLOP + 1), true);
  assert.equal(hold.active, false);
  await new Promise((r) => setTimeout(r, LONGPRESS_MS + 40));
  assert.equal(fired.length, 0, "and nothing fires afterwards");
});

test("longpress: a second finger replaces the first, and never doubles up", async () => {
  const { hold, fired, clock } = harness();
  hold.start(ptr({ pointerId: 1, clientX: 1 }), 0, 0, null);
  hold.start(ptr({ pointerId: 2, clientX: 2 }), 0, 0, null);
  clock.advance(LONGPRESS_MS);
  await new Promise((r) => setTimeout(r, LONGPRESS_MS + 40));
  assert.equal(fired.length, 1, "one menu, not two");
  assert.equal(fired[0].clientX, 2, "the second press is the one in flight");

  // A move reported by the OTHER pointer is not this press moving.
  const b = harness();
  b.hold.start(ptr({ pointerId: 7 }), 0, 0, null);
  assert.equal(b.hold.moved(ptr({ pointerId: 8 }), 500, 500), false);
  assert.equal(b.hold.active, true);
});

test("longpress: a lift cancels it, and asks for one more paint", () => {
  const h = harness();
  h.hold.start(ptr(), 0, 0, null);
  const before = h.paints();
  h.hold.cancel();
  assert.equal(h.hold.active, false);
  assert.equal(h.paints(), before + 1, "the ring has to be rubbed out");
  h.hold.cancel();
  assert.equal(h.paints(), before + 1, "…once, not on every stray pointerup");
});

test("longpress: progress runs 0…1 and stops there", () => {
  const { hold, clock } = harness();
  assert.equal(hold.progress(), 0, "nothing in flight");
  hold.start(ptr(), 0, 0, null);
  assert.equal(hold.progress(), 0);
  clock.advance(LONGPRESS_MS / 4);
  assert.equal(hold.progress(), 0.25);
  clock.advance(LONGPRESS_MS * 4);
  assert.equal(hold.progress(), 1, "clamped — the ring never overshoots");
  hold.cancel();
});

test("gauge: the arc is dashed to the fraction of the perimeter held", () => {
  // The ring is one dashed rectangle whose dash length IS the progress, so the
  // corners come free from the path. Recorded off a stub context, because that
  // dash is the entire mechanism and it is invisible in a pixel comparison.
  const calls = [];
  const ctx = {
    save() {}, restore() {},
    setLineDash(d) { calls.push(["dash", d]); },
    strokeRect(...a) { calls.push(["rect", a]); },
    set strokeStyle(v) { calls.push(["style", v]); },
    set globalAlpha(v) { calls.push(["alpha", v]); },
    set lineWidth(v) {}, set lineCap(v) {},
  };
  paintPerimeterGauge(ctx, { x: 0, y: 0, w: 40, h: 10 }, 0.25, "#f00", "#333");
  const dashes = calls.filter((c) => c[0] === "dash").map((c) => c[1]);
  assert.deepEqual(dashes[0], [], "the faint full outline underneath is solid");
  assert.deepEqual(dashes[1], [25, 100], "a quarter of a 100 px perimeter");
  assert.equal(calls.filter((c) => c[0] === "rect").length, 2);

  // Nothing to draw is drawn as nothing — no rect, no stray dot in a corner.
  calls.length = 0;
  paintPerimeterGauge(ctx, null, 0.5, "#f00");
  paintPerimeterGauge(ctx, { x: 0, y: 0, w: 40, h: 10 }, 0, "#f00");
  paintPerimeterGauge(ctx, { x: 0, y: 0, w: 0, h: 10 }, 0.5, "#f00");
  assert.equal(calls.length, 0);
});
