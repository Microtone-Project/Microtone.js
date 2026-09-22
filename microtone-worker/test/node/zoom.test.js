// UI zoom (item 198.4).
//
// The ladder and the two conversions are the whole contract, and the
// conversions are what every canvas hit test in the app now depends on: a
// canvas paints in LAYOUT pixels and a pointer reports VISUAL ones, so
// localPoint's division is the only thing keeping a click on the cell it
// landed on. The rest of the module is two properties on the root: `zoom`
// itself, and `--ui-zoom`, which the stylesheet divides its viewport units by
// because `zoom` does not scale those — the last test here pins that.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// A root element and a localStorage just real enough for the module to boot —
// it touches nothing else, which is why this is testable in Node at all.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const rootStyle = {
  zoom: "",
  props: new Map(),
  setProperty(name, value) { this.props.set(name, value); },
  removeProperty(name) {
    if (name === "zoom") this.zoom = "";
    this.props.delete(name);
  },
};
globalThis.document = { documentElement: { style: rootStyle } };

const {
  initZoom, setUiZoom, uiZoom, uiDpr, zoomStep, resetZoom, zoomLabel,
  canZoomIn, canZoomOut, localPoint, clientPoint, toLayout, onZoomChange,
} = await import("../../src/ui/zoom.js");

/** A stand-in for an element 400 layout pixels wide at the current zoom. */
const elementAt = (left, top, layoutW = 400) => ({
  getBoundingClientRect: () => ({
    left: left * uiZoom(), top: top * uiZoom(),
    width: layoutW * uiZoom(), height: layoutW * uiZoom(),
  }),
});

test("boots at 100% with no zoom property on the root at all", () => {
  store.clear();
  initZoom();
  assert.equal(uiZoom(), 1);
  assert.equal(rootStyle.zoom, "", "100% means the property is absent, not \"1\"");
  assert.equal(rootStyle.props.has("--ui-zoom"), false, "…and so is the custom property");
});

test("the factor is published to CSS as well, for the viewport units", () => {
  // `zoom` does not scale vw/vh, so every viewport length in the stylesheet
  // divides by this — without it the shell lays out a whole window tall
  // inside a zoomed root and hangs its foot off the bottom of the screen.
  store.clear();
  initZoom();
  setUiZoom(1.25);
  assert.equal(rootStyle.zoom, "1.25");
  assert.equal(rootStyle.props.get("--ui-zoom"), "1.25");
  resetZoom();
  assert.equal(rootStyle.props.has("--ui-zoom"), false,
    "…and removed at 100%, where the stylesheet's own `, 1` fallback answers");
});

test("a remembered factor is restored, and a nonsense one is not", () => {
  store.set("microtone-zoom", "1.25");
  initZoom();
  assert.equal(uiZoom(), 1.25);
  assert.equal(rootStyle.zoom, "1.25");

  for (const bad of ["", "banana", "0", "-2", "NaN"]) {
    store.set("microtone-zoom", bad);
    initZoom();
    assert.equal(uiZoom(), 1, `"${bad}" falls back to 100%`);
  }
  // Out of range is clamped rather than refused: it is user data, and a stale
  // value must never wedge the app.
  store.set("microtone-zoom", "99");
  initZoom();
  assert.ok(uiZoom() > 1 && uiZoom() <= 2.5);
});

test("the ladder steps both ways and stops at its ends", () => {
  store.clear();
  initZoom();
  zoomStep(1);
  assert.equal(zoomLabel(), "110%");
  zoomStep(1);
  assert.equal(zoomLabel(), "125%");
  zoomStep(-1);
  zoomStep(-1);
  assert.equal(zoomLabel(), "100%");

  for (let i = 0; i < 40; i++) zoomStep(-1);
  assert.equal(canZoomOut(), false);
  const floor = uiZoom();
  zoomStep(-1);
  assert.equal(uiZoom(), floor, "the end of the ladder is a no-op, not an error");

  for (let i = 0; i < 40; i++) zoomStep(1);
  assert.equal(canZoomIn(), false);
});

test("a factor off the ladder still steps to the next rung either way", () => {
  setUiZoom(1.18); // e.g. restored from a build whose ladder differed
  zoomStep(1);
  assert.equal(zoomLabel(), "125%");
  setUiZoom(1.18);
  zoomStep(-1);
  assert.equal(zoomLabel(), "110%");
});

test("100% is forgotten rather than stored, so the default can still change", () => {
  store.clear();
  initZoom();
  setUiZoom(1.5);
  assert.equal(store.get("microtone-zoom"), "1.5");
  resetZoom();
  assert.equal(store.has("microtone-zoom"), false);
});

test("listeners fire on a real change and not on a repeat of the same factor", () => {
  store.clear();
  initZoom();
  let fired = 0;
  onZoomChange(() => { fired++; });
  setUiZoom(1.25);
  setUiZoom(1.25);
  assert.equal(fired, 1);
  resetZoom();
  assert.equal(fired, 2);
});

test("the canvas backing store carries the zoom as well as the device ratio", () => {
  globalThis.devicePixelRatio = 2;
  store.clear();
  initZoom();
  assert.equal(uiDpr(), 2);
  setUiZoom(1.25);
  assert.equal(uiDpr(), 2.5, "…so a zoomed grid is still pixel-exact");
  delete globalThis.devicePixelRatio;
  assert.equal(uiDpr(), 1.25, "…and a missing ratio reads as 1");
  resetZoom();
});

test("a pointer lands on the same layout point whatever the zoom", () => {
  const probe = (zoom) => {
    setUiZoom(zoom);
    const el = elementAt(50, 20);
    const r = el.getBoundingClientRect();
    // The event a browser would report for the layout point (120, 64).
    const ev = { clientX: r.left + 120 * zoom, clientY: r.top + 64 * zoom };
    return localPoint(el, ev);
  };
  for (const zoom of [0.5, 0.8, 1, 1.25, 2]) {
    const p = probe(zoom);
    assert.ok(Math.abs(p.x - 120) < 1e-9 && Math.abs(p.y - 64) < 1e-9,
      `zoom ${zoom} gave (${p.x}, ${p.y})`);
  }
  resetZoom();
});

test("clientPoint is localPoint's inverse — what a synthetic event has to say", () => {
  for (const zoom of [0.75, 1, 1.75]) {
    setUiZoom(zoom);
    const el = elementAt(37, 11);
    const ev = clientPoint(el, 200, 90);
    const back = localPoint(el, ev);
    assert.ok(Math.abs(back.x - 200) < 1e-9 && Math.abs(back.y - 90) < 1e-9);
  }
  resetZoom();
});

test("toLayout undoes the zoom on a bare distance", () => {
  setUiZoom(1.25);
  assert.equal(toLayout(125), 100);
  setUiZoom(1);
  assert.equal(toLayout(125), 125);
});

// ── the stylesheet's half of the bargain ──

test("no viewport unit in the stylesheet escapes the zoom correction", () => {
  // `zoom` scales the layout but NOT vw/vh, so a bare `height: 100vh` inside
  // a zoomed root lays out a whole window tall and renders a quarter taller
  // than the window. Every viewport length therefore divides by --ui-zoom,
  // and this is what keeps the next one honest: the comment asking for it
  // cannot be enforced, so the file is read instead.
  const css = readFileSync(new URL("../../css/microtone.css", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, ""); // the rule is explained in prose; skip comments
  const bare = [];
  const unit = /(?<![\w.-])\d+(?:\.\d+)?(vw|vh|dvw|dvh|svw|svh|lvw|lvh|vmin|vmax)\b/g;
  for (const m of css.matchAll(unit)) {
    // …accepted only as the numerator of a division by --ui-zoom.
    const after = css.slice(m.index + m[0].length, m.index + m[0].length + 30);
    if (!/^\s*\/\s*var\(--ui-zoom/.test(after)) bare.push(m[0]);
  }
  assert.deepEqual(bare, [],
    `wrap each in calc(N${bare[0]?.replace(/[\d.]/g, "") || "vh"} / var(--ui-zoom, 1))`);
});
