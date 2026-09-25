// Absolute-pitch plot (item 198.5) — the band walk, its drawing geometry, and
// the OKLCh register ramp underneath the left-gutter tab.
//
// The band's whole value is its HYSTERESIS: ordinary melodic motion must not
// move it (or the tab's colour flickers at every octave line, which is the
// arbitrary place rather than the musical one), and a real leap must. Those
// two facts are what these tests pin.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  plotSeries, plotGeometry, octaveColour, plotPeriod, isPlottable, arpOffsets,
  paintPitchTab,
  RE_ENTRY_ROWS, ANCHOR_OCTAVE,
} from "../../src/ui/pitchplot.js";
import { EffectOp } from "../../src/engine/tables.js";
import {
  hexToOklch, mixOklch, evenSteps, gamutClamp, inGamut,
  parseHex, toHex, rgbToOklab, oklabToRgb,
} from "../../src/ui/oklch.js";
import { pitchTablePresets, ANCHOR_NOTE } from "../../src/ui/pitchtables.js";

const P12 = pitchTablePresets[120];
/** A 12-TET note word: octave + semitone offset from that octave's C. */
const N = (oct, semi) => ANCHOR_NOTE + (oct - 4) * 0x1000 + Math.round((semi * 4096) / 12);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !≈ ${b}`);

test("the band root sits dead centre, and a period either way is still inside it", () => {
  const s = plotSeries([N(4, 0), N(5, 0), N(3, 0)], P12);
  near(s[0].x, 0.5);   // the root itself
  near(s[1].x, 1);     // +1 period: the top edge, and the band holds
  near(s[2].x, 0);     // −1 period: the bottom edge, symmetrically
  for (const e of s) assert.equal(e.octave, ANCHOR_OCTAVE, "the band is closed at ±1 period");
});

test("one step past the edge is outside, and re-roots", () => {
  const s = plotSeries([N(4, 0), N(5, 1), N(4, 0), N(2, 11)], P12);
  assert.equal(s[1].octave, 5, "a semitone above +1 period has left the band");
  // It re-roots to its OWN period, so it lands just above that root's centre —
  // one semitone of a two-period axis — not at the far edge it came over.
  near(s[1].x, 0.5 + 1 / 24, 1e-3);
  // Coming back down to C-4 is exactly one period from the NEW root, so it
  // stays in the new band at its bottom edge. That is the hysteresis working:
  // the band follows where the music went, and does not snap back for a note
  // it can still show.
  assert.equal(s[2].octave, 5);
  near(s[2].x, 0);
  assert.equal(s[3].octave, 2, "…until something is genuinely out of reach again");
  near(s[3].x, 0.5 + 11 / 24, 1e-3);
});

test("a melody that stays inside one period never moves the band", () => {
  // B-3 → C-4 crosses an octave LINE but is a semitone of motion: the band,
  // and therefore the tab's colour, must not notice.
  const s = plotSeries([N(4, 0), N(3, 11), N(4, 0), N(4, 7), N(4, 11)], P12);
  for (const e of s) assert.equal(e.octave, ANCHOR_OCTAVE, "band held");
  assert.ok(s[1].x < 0.5, "B-3 reads below the root");
  assert.ok(s[3].x > 0.5, "G-4 reads above it");
  assert.deepEqual(s.map((e) => e.joins), [false, true, true, true, true]);
});

test("a leap of more than a period re-roots the band, and breaks the contour there", () => {
  const s = plotSeries([N(4, 0), N(4, 7), N(6, 0), N(6, 4)], P12);
  assert.equal(s[1].octave, 4);
  assert.equal(s[2].octave, 6, "re-rooted to the new note's own period");
  assert.equal(s[2].joins, false, "…and the axis changed, so no line across it");
  assert.equal(s[3].octave, 6);
  assert.equal(s[3].joins, true, "…but the next note joins normally");
  near(s[2].x, 0.5);
});

test("the contour gives up after a rest longer than RE_ENTRY_ROWS", () => {
  const near_ = new Array(RE_ENTRY_ROWS + 1).fill(0);
  near_[0] = N(4, 0); near_[RE_ENTRY_ROWS] = N(4, 4);
  assert.equal(plotSeries(near_, P12)[RE_ENTRY_ROWS].joins, true, "exactly the limit still joins");

  const far = new Array(RE_ENTRY_ROWS + 2).fill(0);
  far[0] = N(4, 0); far[RE_ENTRY_ROWS + 1] = N(4, 4);
  assert.equal(plotSeries(far, P12)[RE_ENTRY_ROWS + 1].joins, false, "one row further does not");
});

test("only pitches are plotted — sentinels, interrupts and empty rows are not", () => {
  const s = plotSeries([0x0000, 0x0001, 0x0004, 0x000a, 0x0010, 0x001f, N(4, 0)], P12);
  assert.deepEqual(s.slice(0, 6), new Array(6).fill(null));
  assert.ok(s[6] !== null);
  for (const n of [0, 1, 4, 0x0a, 0x10, 0x1f]) assert.equal(isPlottable(n), false);
  assert.equal(isPlottable(0x20), true);
});

test("a non-octave tuning uses ITS period; an absolute table falls back to an octave", () => {
  const bp = Object.values(pitchTablePresets).find((p) => p.interval === 0x12ec)
    ?? { interval: 0x12ec }; // Bohlen-Pierce: the tritave, not the octave
  assert.equal(plotPeriod(bp), 0x12ec);
  assert.equal(plotPeriod(pitchTablePresets[1]), 0x1000, "ProTracker pitch has no lattice");
  assert.equal(plotPeriod(undefined), 0x1000);
  // A tritave up is the edge of a tritave-wide band, exactly as an octave is
  // in a 12-TET one — the band is the TUNING's period, not always an octave.
  near(plotSeries([ANCHOR_NOTE, ANCHOR_NOTE + 0x12ec], bp)[1].x, 1);
});

test("the geometry joins ticks through the rows between them, and carries the band forward", () => {
  const g = plotGeometry(plotSeries([N(4, 0), 0, 0, N(4, 12)], P12));
  assert.equal(g[0].topX, null, "nothing crosses above the first tick");
  // Ticks sit at row CENTRES, so the crossings are evenly spaced eighths of
  // the way from 0.5 to 1 — and the one just above the second tick is 5/6 of
  // the journey, not all of it.
  for (let r = 1; r <= 3; r++) {
    near(g[r].topX, 0.5 + 0.5 * ((r - 0.5) / 3));
  }
  assert.deepEqual(g.map((e) => e.band), [4, 4, 4, 4], "the band holds over silent rows");
  assert.deepEqual(g.map((e) => e.x !== null), [true, false, false, true]);
});

test("geometry rows before the first note carry no band at all", () => {
  const g = plotGeometry(plotSeries([0, 0, N(4, 0)], P12));
  assert.deepEqual(g.map((e) => e.band), [null, null, 4]);
});

test("an arpeggio places its other two pitches on the SAME band as its root", () => {
  // J $0407: a major third and a fifth above, in 12-TET terms.
  const s = plotSeries([{ note: N(4, 0), arp: [0x0400, 0x0700] }, N(4, 4)], P12);
  near(s[0].x, 0.5, 1e-3);
  assert.equal(s[0].arp.length, 2);
  assert.ok(s[0].arp[0] > s[0].x && s[0].arp[1] > s[0].arp[0], "…in order, above the root");
  // Placed on the root's band, so the row's three pitches are comparable with
  // each other AND with the rows around them.
  near(s[0].arp[1], 0.5 + 0x0700 / 0x2000, 1e-3);
  assert.equal(s[1].arp, null, "a row with no J carries none");
});

test("an arpeggio of nothing is not drawn as one", () => {
  // `J $0000` with an empty memory is the note with itself, twice: one pitch.
  const s = plotSeries([{ note: N(4, 0), arp: [0, 0] }], P12);
  assert.equal(s[0].arp, null);
});

test("a row is its note word, or an object — both mean the same thing", () => {
  const plain = plotSeries([N(4, 0), 0, N(4, 7)], P12);
  const objs = plotSeries([{ note: N(4, 0) }, { note: 0 }, { note: N(4, 7) }], P12);
  assert.deepEqual(objs, plain);
});

// ── the arpeggio reader ──

const freshMem = () => ({ j: 0, jExt1: 0, jExt2: 0 });
const OP_J = EffectOp.OP_J, OP_COLON = EffectOp.OP_COLON;

test("J's two bytes are pitch deltas scaled by 256", () => {
  const arp = arpOffsets({ effect: OP_J, effectArg: 0x0407 }, false, freshMem());
  assert.deepEqual(arp, [0x0400, 0x0700]);
  assert.equal(arpOffsets({ effect: EffectOp.OP_M, effectArg: 0x3f00 }, false, freshMem()), null);
});

test("J $0000 recalls the last one — a song states an arpeggio once and repeats it", () => {
  const mem = freshMem();
  assert.deepEqual(arpOffsets({ effect: OP_J, effectArg: 0x0407 }, false, mem), [0x0400, 0x0700]);
  assert.deepEqual(arpOffsets({ effect: OP_J, effectArg: 0x0000 }, false, mem), [0x0400, 0x0700]);
  // …and a fresh lane has nothing to recall.
  assert.deepEqual(arpOffsets({ effect: OP_J, effectArg: 0x0000 }, false, freshMem()), [0, 0]);
});

test("a paired colon makes both bytes full 4096-TET deltas, from their own memory", () => {
  const mem = freshMem();
  const row = { effect: OP_J, effectArg: 0x0123, effect2: OP_COLON, effectArg2: 0x0456 };
  assert.deepEqual(arpOffsets(row, true, mem), [0x0123, 0x0456], "not <<8-scaled");
  // The extended memory is SEPARATE from classic J's — the units disagree, so
  // one must never answer for the other.
  assert.deepEqual(arpOffsets({ effect: OP_J, effectArg: 0, effect2: OP_COLON, effectArg2: 0 }, true, mem),
    [0x0123, 0x0456]);
  assert.deepEqual(arpOffsets({ effect: OP_J, effectArg: 0 }, false, mem), [0, 0],
    "classic J's own memory is untouched by the extended form");
  // The colon reads the same either way round, and two colons extend nothing.
  assert.deepEqual(
    arpOffsets({ effect: OP_COLON, effectArg: 0x0456, effect2: OP_J, effectArg2: 0x0123 }, true, freshMem()),
    [0x0123, 0x0456]);
});

test("a second effect slot only counts when the document HAS one", () => {
  const row = { effect: 0, effectArg: 0, effect2: OP_J, effectArg2: 0x0203 };
  assert.deepEqual(arpOffsets(row, true, freshMem()), [0x0200, 0x0300]);
  assert.equal(arpOffsets(row, false, freshMem()), null, "a v2 cell has no second slot");
});

// ── the register tab ──
//
// The band is in force continuously, but the TAB marks only the rows that
// sound: held down every row it reads as decoration and buries the one place
// the colour changes. A recording context is enough to pin that, and it is
// the one thing about the tab worth pinning.

/** Just enough of a 2-D context to see what was filled, and in what. */
function recordingCtx() {
  const calls = [];
  return {
    calls,
    set fillStyle(v) { this._fill = v; },
    get fillStyle() { return this._fill; },
    fillRect(x, y, w, h) { calls.push({ x, y, w, h, fill: this._fill }); },
  };
}

/** Paint a whole series' worth of tabs and report one entry per row. */
function tabsFor(rows, C) {
  const geo = plotGeometry(plotSeries(rows, P12));
  return geo.map((g, row) => {
    const ctx = recordingCtx();
    paintPitchTab(ctx, g, { tabX: 100, y: row * 10, rowH: 10 }, C);
    return ctx.calls[0]?.fill ?? null;
  });
}

test("the tab marks the rows that sound a note, and only those", () => {
  const C = { octRed: "#ec1c15", octYellow: "#f4ce23", octGreen: "#1cee65", octBlue: "#0f79fd" };
  //            note    gap   gap    note     key-off  cut     fade   Int3    empty
  const rows = [N(4, 0), 0, 0, N(4, 7), 0x0001, 0x0002, 0x0003, 0x0013, 0];
  const tabs = tabsFor(rows, C);
  assert.deepEqual(tabs.map((t) => t !== null),
    [true, false, false, true, false, false, false, false, false]);
  // …and what it paints is that note's own register.
  assert.equal(tabs[0], octaveColour(4, C));
  assert.equal(tabs[3], octaveColour(4, C));
});

test("a rest between two notes keeps the BAND without wearing the tab", () => {
  // The band has to carry on — the centre rule and the contour run through
  // those rows — but the colour must not.
  const geo = plotGeometry(plotSeries([N(4, 0), 0, 0, N(4, 2)], P12));
  assert.deepEqual(geo.map((g) => g.band), [4, 4, 4, 4], "the band is continuous");
  assert.deepEqual(geo.map((g) => g.x !== null), [true, false, false, true],
    "…and the tab, which follows the ticks, is not");
});

test("a leap recolours the tab on the note that caused it", () => {
  const C = { octRed: "#ec1c15", octYellow: "#f4ce23", octGreen: "#1cee65", octBlue: "#0f79fd" };
  const tabs = tabsFor([N(4, 0), 0, N(6, 0), 0, N(2, 0)], C);
  assert.equal(tabs[0], octaveColour(4, C));
  assert.equal(tabs[2], octaveColour(6, C), "…two periods up, and bluer");
  assert.equal(tabs[4], octaveColour(2, C), "…four down, and redder");
  assert.notEqual(tabs[0], tabs[2]);
  assert.notEqual(tabs[2], tabs[4]);
});

// ── the register ramp ──

const RAMP = {
  octRed: "#ec1c15", octYellow: "#f4ce23", octGreen: "#1cee65", octBlue: "#0f79fd",
};
/** OKLab distance — perceived difference, which is the thing being spaced. */
const deltaE = (x, y) => {
  const a = rgbToOklab(parseHex(x)), b = rgbToOklab(parseHex(y));
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
};

test("the ramp is a spectral continuum: red at the bottom of the keyboard, blue at the top", () => {
  const steps = [];
  for (let oct = 0; oct <= 9; oct++) steps.push(hexToOklch(octaveColour(oct, RAMP)));
  // Hue sweeps monotonically from the red end to the blue end — the whole walk
  // is one arc through yellow and green, and never doubles back.
  for (let oct = 1; oct <= 9; oct++) {
    assert.ok(steps[oct][2] > steps[oct - 1][2], `hue advances at octave ${oct}`);
  }
  assert.ok(steps[0][2] > 15 && steps[0][2] < 45, "the bottom of the keyboard is red");
  assert.ok(steps[9][2] > 235 && steps[9][2] < 275, "the top of it is blue");
  // Every step carries real chroma: a spectral ramp with a washed-out member
  // is a ramp with a hole in it.
  for (const [i, lch] of steps.entries()) {
    assert.ok(lch[1] > 0.1, `octave ${i} is properly coloured (C ${lch[1].toFixed(3)})`);
  }
  // …and lightness deliberately carries NOTHING: each stop sits near its own
  // hue's most colourful lightness, and those disagree. Asserted so nobody
  // "fixes" the ramp into a monotone one and quietly halves its chroma.
  const ls = steps.map((l) => l[0]);
  assert.ok(Math.max(...ls) > ls[0] && Math.max(...ls) > ls[9],
    "the lightest step is in the middle, not at an end");
});

test("the steps are spaced by PERCEPTUAL distance, not by interpolation parameter", () => {
  const steps = [];
  for (let oct = 0; oct <= 9; oct++) steps.push(octaveColour(oct, RAMP));
  const gaps = steps.slice(1).map((c, i) => deltaE(steps[i], c));
  const lo = Math.min(...gaps), hi = Math.max(...gaps);
  assert.ok(hi / lo < 1.2, `neighbour gaps are flat: ${lo.toFixed(3)}..${hi.toFixed(3)}`);

  // …and that this is worth doing: cutting the same path at even PARAMETER
  // values instead bunches the steps, because the three arms are nowhere near
  // equal in perceptual length — red to yellow is a far longer journey than
  // yellow to green.
  const arms = [RAMP.octRed, RAMP.octYellow, RAMP.octGreen, RAMP.octBlue];
  const naive = [];
  for (let k = 0; k <= 9; k++) {
    const t = (k / 9) * 3;
    const seg = Math.min(Math.floor(t), 2);
    naive.push(mixOklch(arms[seg], arms[seg + 1], t - seg));
  }
  const nGaps = naive.slice(1).map((c, i) => deltaE(naive[i], c));
  assert.ok(Math.max(...nGaps) / Math.min(...nGaps) > 1.5,
    "the naive spacing really is lopsided, or this test proves nothing");
});

test("the ramp saturates at both ends rather than running off them", () => {
  assert.equal(octaveColour(0, RAMP), octaveColour(-3, RAMP));
  assert.equal(octaveColour(9, RAMP), octaveColour(14, RAMP));
  assert.equal(octaveColour(0, RAMP), RAMP.octRed, "…and the ends ARE the stops");
  assert.equal(octaveColour(9, RAMP), RAMP.octBlue);
});

test("a new theme's ramp replaces the old one rather than answering from its cache", () => {
  const dark = octaveColour(7, RAMP);
  const light = octaveColour(7, {
    octRed: "#e11d16", octYellow: "#dbb801", octGreen: "#00cd53", octBlue: "#046de9",
  });
  assert.notEqual(dark, light);
  assert.equal(octaveColour(7, RAMP), dark, "…and switching back gives the first one again");
});

// ── the colour space itself ──

test("sRGB survives a round trip through OKLab", () => {
  for (const hex of ["#000000", "#ffffff", "#16181d", "#ffc043", "#78dce7", "#c6b78c"]) {
    assert.equal(toHex(oklabToRgb(rgbToOklab(parseHex(hex)))), hex);
  }
});

test("mixing takes the short way round the hue circle and lands on both ends", () => {
  const from = "#467ac6", to = "#efd54a";
  assert.equal(mixOklch(from, to, 0), from);
  assert.equal(mixOklch(from, to, 1), to);
  // Blue (≈258°) to yellow (≈98°) the short way goes DOWN through green, not
  // up through magenta — every intermediate hue sits between the two.
  for (const t of [0.25, 0.5, 0.75]) {
    const h = hexToOklch(mixOklch(from, to, t))[2];
    assert.ok(h > 95 && h < 260, `t=${t} stays on the spectral side (${h.toFixed(0)}°)`);
  }
  assert.equal(mixOklch(from, to, -5), from, "out-of-range factors clamp");
  assert.equal(mixOklch(from, to, 5), to);
});

test("an unreachable chroma is desaturated, not hue-shifted", () => {
  const want = [0.55, 0.3, 200]; // far outside sRGB — cyan is the narrowest region
  assert.equal(inGamut(want), false);
  const got = gamutClamp(want);
  assert.equal(got[0], want[0], "lightness is kept");
  assert.equal(got[2], want[2], "…and so is hue, which is the whole point");
  assert.ok(got[1] < want[1] && got[1] > 0, `chroma came back reduced (${got[1].toFixed(3)})`);
  assert.equal(inGamut(got), true);
  // A colour that already fits is returned untouched.
  const fine = [0.55, 0.05, 200];
  assert.deepEqual(gamutClamp(fine), fine);
});

test("evenSteps returns both endpoints, honours n, and is monotone along the path", () => {
  const stops = ["#467ac6", "#57bd72", "#efd54a"];
  assert.deepEqual(evenSteps(stops, 1), ["#467ac6"]);
  assert.equal(evenSteps(stops, 2).length, 2);
  const many = evenSteps(stops, 24);
  assert.equal(many.length, 24);
  assert.equal(many[0], stops[0]);
  assert.equal(many[23], stops[2]);
  // Hue only ever advances — a step that went backwards would mean the walk
  // had overshot a stop and come back.
  const hues = many.map((c) => hexToOklch(c)[2]);
  for (let i = 1; i < hues.length; i++) assert.ok(hues[i] <= hues[i - 1] + 1e-6);
});
