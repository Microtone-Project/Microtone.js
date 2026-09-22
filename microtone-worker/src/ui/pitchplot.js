// Absolute-pitch plot (item 198.5) — the contour drawn BEHIND the note and
// instrument cells of a lane, and the register tab down their left edge.
//
// The grid tells you which degree of the tuning a row plays; it does not tell
// you the SHAPE of what you have written, and in a 4096-TET grid where two
// notations can spell the same pitch, the shape is the part the eye cannot
// recover from the letters. So each sounding row gets one tick at its pitch on
// a horizontal axis, consecutive ticks are joined, and the melody reads as a
// line running down the column.
//
// WHAT IT PLOTS IS WHAT SOUNDS, not what is typed. A row repeated by a pattern
// ditto gets its tick, and so does every row a slide or a portamento is
// travelling through — which is what turns a `G $0080` from a straight line
// between two written notes into the curve the ear actually hears. The caller
// hands over the pitch in force at each row's tick 0 (the grids already
// compute exactly that for their ghost cells), so this module never has to
// know which of them was written down.
//
// An ARPEGGIO is the one row that is not a single pitch: `J $xxyy` cycles the
// tick through three of them, so such a row draws all three, joined by a bar,
// and the contour runs through the one the row is rooted on. Drawing only the
// root would say the lane holds one note where it is playing a chord.
//
// ── the band ──
// The axis spans ±1 period about a BAND ROOT — an actual octave/period root,
// so the register the tab names is an absolute one. The root only moves when
// a note falls outside that span, and then it re-roots to the new note's own
// period. That hysteresis is the whole design:
//
//   * the axis is two periods wide, so ordinary melodic motion — which lives
//     inside one — never touches the edges, and reads as pure contour;
//   * a B→C step does NOT recolour the tab, because it does not leave the
//     band. Colouring by the note's own octave would flash at every such step,
//     which is the arbitrary place, not the musical one;
//   * a LEAP of more than a period does re-root, and that is exactly when the
//     tab changes colour. One event, one signal.
//
// The contour is not drawn across a re-root: the axis means something
// different on either side of one, so joining them would draw a line nobody
// played. Nor across a long rest — after RE_ENTRY_ROWS silent rows the phrase
// has restarted, and a near-vertical line down half the screen is noise.
//
// The band walk and the ramp are pure — no DOM — so both are testable on their
// own; only paintPitchPlot at the foot of the file touches a 2-D context.

import { ANCHOR_NOTE } from "./pitchtables.js";
import { EffectOp } from "../engine/tables.js";
import { evenSteps } from "./oklch.js";

const OP_J = EffectOp.OP_J;
const OP_COLON = EffectOp.OP_COLON;

/** Lowest note word that is a PITCH rather than a command (0 is empty; 1-4 are
 *  the key-off/cut/fade sentinels, 5-F reserved, 10-1F interrupt markers). */
const FIRST_PITCH = 0x0020;

/** An octave, in 4096-TET units — the fallback period for an ABSOLUTE preset
 *  (`interval: 0`, e.g. ProTracker pitch), whose table is a finite list rather
 *  than a repeating lattice. Such a table has no period to read, but it is
 *  near enough octave-periodic for a contour's scale, and the alternative is
 *  no plot at all on those songs. */
const DEFAULT_PERIOD = 0x1000;

/** Rows of silence after which the contour is not carried across. Eight is two
 *  beats at the usual metre — long enough that a plot survives the gaps inside
 *  a phrase, short enough that it gives up on an actual rest rather than
 *  ruling a line down half the screen. */
export const RE_ENTRY_ROWS = 8;

/** The register ANCHOR_NOTE (middle C) sits in, and so the base the band's
 *  numbering counts from — the same numbering resolveNoteSymbol reports. The
 *  ramp does NOT pivot on it; see the register ramp below. */
export const ANCHOR_OCTAVE = 4;

/** The tuning's period in 4096-TET units. */
export function plotPeriod(preset) {
  const interval = preset?.interval | 0;
  return interval > 0 ? interval : DEFAULT_PERIOD;
}

/** Is this note word something the plot can place? */
export function isPlottable(note) { return note >= FIRST_PITCH; }

/**
 * Walk one lane's rows and place each sounding pitch on its band.
 *
 * @param rows   one entry per row: the note word in force at that row's tick 0
 *               (anything below FIRST_PITCH is "nothing sounds here" — an
 *               empty row, a key-off, an interrupt marker), or an object
 *               `{ note, arp }` where `arp` is the `[off1, off2]` pair an
 *               arpeggio on that row cycles through (see `arpOffsets`).
 * @param preset the active pitch table — only its `interval` is read.
 * @returns one entry per row: null where nothing is placed, else
 *          `{ x, octave, joins, arp }` where `x` ∈ 0..1 is the position across
 *          the cell, `octave` the band's absolute octave/period number,
 *          `joins` whether a contour line may run up to the previous entry,
 *          and `arp` the other two pitches' positions, or null.
 */
export function plotSeries(rows, preset) {
  const period = plotPeriod(preset);
  const octaveOf = (n) => ANCHOR_OCTAVE + Math.floor((n - ANCHOR_NOTE) / period);
  const rootOf = (oct) => ANCHOR_NOTE + (oct - ANCHOR_OCTAVE) * period;

  const out = new Array(rows.length).fill(null);
  let octave = null;   // the band's register
  let root = 0;        // …and the note word at its foot
  let prevRow = -1;    // the last row that placed a tick

  for (let row = 0; row < rows.length; row++) {
    const entry = rows[row];
    const note = (typeof entry === "object" && entry !== null ? entry.note : entry) | 0;
    if (!isPlottable(note)) continue;
    // Re-root on the first note, and whenever one leaves the band. Either way
    // the axis has moved, so the contour breaks here.
    const reRooted = octave === null || Math.abs(note - root) > period;
    if (reRooted) {
      octave = octaveOf(note);
      root = rootOf(octave);
    }
    // ±1 period about the root, so the root itself sits dead centre. An
    // arpeggio's other two pitches are placed on the SAME band — they belong
    // to this row, and a chord that re-rooted the band halfway through would
    // move the axis under the note it is decorating.
    const place = (n) => Math.min(Math.max(0.5 + (n - root) / (2 * period), 0), 1);
    const arp = (typeof entry === "object" && entry !== null ? entry.arp : null) ?? null;
    out[row] = {
      x: place(note),
      octave,
      joins: !reRooted && prevRow >= 0 && row - prevRow <= RE_ENTRY_ROWS,
      // A `J $0000` with nothing in its memory is an arpeggio of the note
      // with itself twice over: it sounds like one pitch, so it draws as one.
      arp: arp && (arp[0] !== 0 || arp[1] !== 0)
        ? [place(note + arp[0]), place(note + arp[1])]
        : null,
    };
    prevRow = row;
  }
  return out;
}

/**
 * The two pitch deltas an arpeggio on this row cycles through, or null when
 * the row does not arpeggiate. A mirror of effects.js `OP_J` and row.js's `:`
 * pairing, close enough to be read against them.
 *
 * `mem` is the lane's running argument memory (`{j, jExt1, jExt2}`, all 0 to
 * begin with) and is UPDATED in place, because `J $0000` means "the one
 * before" — a plot that ignored the recall would drop every arpeggio a song
 * states once and then repeats.
 *
 * @param row  a cell (or a ditto ghost's effective row): `{effect, effectArg,
 *             effect2, effectArg2}`.
 * @param wide does the document HAVE a second effect slot (format v3)?
 */
export function arpOffsets(row, wide, mem) {
  const op1 = row.effect | 0, arg1 = row.effectArg | 0;
  const op2 = wide ? (row.effect2 | 0) : 0;
  const arg2 = wide ? (row.effectArg2 | 0) : 0;
  // A `:` in either slot is a modifier for the OTHER one, never a command of
  // its own — and two colons extend nothing (row.js applyTrackerRow).
  let ext1 = null, ext2 = null;
  if (wide && op1 === OP_COLON && op2 !== OP_COLON) ext2 = arg1;
  else if (wide && op2 === OP_COLON && op1 !== OP_COLON) ext1 = arg2;

  // Both slots are applied in order, so a second J overrides the first.
  let arp = null;
  if (op1 === OP_J) arp = arpFrom(arg1, ext1, mem);
  if (op2 === OP_J) arp = arpFrom(arg2, ext2, mem);
  return arp;
}

function arpFrom(rawArg, ext, mem) {
  if (ext !== null) {
    // Extended (item 162): both bytes are full 16-bit 4096-TET deltas rather
    // than <<8-scaled ones, and they recall from their OWN memory — the units
    // do not agree with classic J's, so one must never answer for the other.
    const off1 = rawArg !== 0 ? rawArg : mem.jExt1;
    const off2 = ext !== 0 ? ext : mem.jExt2;
    if (rawArg !== 0) mem.jExt1 = off1;
    if (ext !== 0) mem.jExt2 = off2;
    return [off1, off2];
  }
  const arg = rawArg !== 0 ? rawArg : mem.j;
  if (rawArg !== 0) mem.j = arg;
  return [((arg >>> 8) & 0xff) << 8, (arg & 0xff) << 8];
}

/**
 * Turn a series into per-row DRAWING geometry, so a painter that walks rows —
 * which is what both grids do — never has to look further than the row it is
 * on. Each entry carries the tick (if the row has one) and `topX`, where the
 * contour crosses the row's TOP edge; a row's BOTTOM crossing is the next
 * row's `topX`, so consecutive rows join exactly and every row's share of the
 * line fits inside its own rectangle. That containment is the point: a grid
 * paints one row's background, then its glyphs, then the next row's, and a
 * line drawn across several rows at once would be half-erased by the ones
 * that follow it.
 *
 * Positions are fractions of the plot's width, and rows the series never
 * reached carry nulls.
 */
export function plotGeometry(series) {
  const geo = series.map((e) => (e
    ? { x: e.x, octave: e.octave, arp: e.arp, band: null, topX: null }
    : { x: null, octave: null, arp: null, band: null, topX: null }));
  // The BAND is carried forward past the rows that place nothing: it is lane
  // state, in force until a leap moves it, so the register tab is a continuous
  // stripe rather than a mark beside each note. A stripe is what makes the
  // colour CHANGE visible — a run of marks that are all the same colour says
  // nothing, and the one place they differ is the whole message.
  let band = null;
  for (let row = 0; row < series.length; row++) {
    if (series[row]) band = series[row].octave;
    geo[row].band = band;
  }
  let prev = -1;
  for (let row = 0; row < series.length; row++) {
    const e = series[row];
    if (!e) continue;
    if (e.joins && prev >= 0) {
      // The ticks sit at their rows' CENTRES, so the crossing above row k is
      // half a row short of the whole span — which is what puts the join
      // between two adjacent ticks exactly on the boundary between them.
      const from = series[prev], span = row - prev;
      for (let k = prev + 1; k <= row; k++) {
        geo[k].topX = from.x + (e.x - from.x) * ((k - prev - 0.5) / span);
      }
    }
    prev = row;
  }
  return geo;
}

// ── the register ramp ──
//
// A SPECTRAL continuum rather than a ramp about a neutral middle: blue at the
// bottom of the keyboard, through cyan and green, to yellow at the top. Three
// stops per theme, and the eight registers between them are computed.
//
// The computation is the interesting part. The steps are NOT cut at even
// intervals along the path — they are spaced so that every adjacent pair is
// the same PERCEPTUAL distance apart (oklch.js evenSteps), because a path
// through hue does not travel at a constant speed through OKLab and a stop in
// the middle almost never lands at its halfway point. Cutting evenly by
// parameter bunches several registers into the stretch the eye separates
// worst — the greens run together while the blues fly apart — which for a
// signal already asking a lot of a sense with famously poor hue resolution is
// the difference between a scale you can read and a smear. So the ramp is
// walked at constant perceptual speed instead, and where the green STOP
// happens to land is wherever the middle of the journey really is.
//
// Memoised per theme: the walk is a few hundred cube roots, and a 64-lane
// screen would otherwise ask for it thousands of times a frame.

/** Registers the ramp covers — the 0..9 a notation can spell. */
const RAMP_LOW = 0;
const RAMP_HIGH = 9;

let _rampKey = null;
let _ramp = null;

/** The tab colour for an absolute octave/period, from the theme's three stops. */
export function octaveColour(octave, C) {
  const key = `${C.octLow}|${C.octMid}|${C.octHigh}`;
  if (_rampKey !== key) {
    _rampKey = key;
    _ramp = evenSteps([C.octLow, C.octMid, C.octHigh], RAMP_HIGH - RAMP_LOW + 1);
  }
  return _ramp[Math.min(Math.max(Math.round(octave), RAMP_LOW), RAMP_HIGH) - RAMP_LOW];
}

// ── the painter ──

/** Characters the plot spans: the 4-character note cell, the gap, and the
 *  2-character instrument cell — the "note-and-inst" group, which is as wide a
 *  run as the two grids share. */
export const PLOT_CHARS = 7;

/** Width of the register tab. Two pixels, and the caller is expected to leave
 *  a clear pixel or two between it and the rule at the cell's left edge —
 *  butted against that rule it stops reading as a mark inside the cell and
 *  starts reading as the lane divider, recoloured. */
const TAB_W = 2;

/** The plot sits BEHIND the notation, so it is painted at less than full
 *  strength: the ticks carry the data, the line joining them is a reading aid,
 *  and the band's centre rule is only a reference. At equal weight a tick is
 *  mistaken for a glyph — a 2-pixel bar between two columns of text looks
 *  exactly like a pipe — and the lane turns into a cat's cradle. */
const TICK_ALPHA = 0.8;
const CONTOUR_ALPHA = 0.45;
/** …and the arpeggio's other two pitches, quieter again: they are where the
 *  row GOES, not where it is rooted, and the contour runs through the root. */
const ARP_ALPHA = 0.5;
/** Height of an arpeggio pitch's mark, as a fraction of the row — short, so a
 *  three-pitch row reads as one row decorated rather than as three rows. */
const ARP_TICK_H = 0.42;

/**
 * Paint one row's share of a lane's plot, BEHIND that row's glyphs.
 *
 * @param g     this row's geometry (plotGeometry entry)
 * @param next  the next row's, or null — its `topX` is this row's bottom crossing
 * @param box   {tabX, x, y, w, rowH} — the tab's left edge, then the plot
 *              rectangle itself (`x`/`w` being the note-and-inst run)
 * @param C     themeColors()
 */
export function paintPitchPlot(ctx, g, next, box, C) {
  if (!g || g.band === null) return;
  const { tabX, x, y, w, rowH } = box;

  ctx.fillStyle = octaveColour(g.band, C);
  ctx.fillRect(tabX-4, y, TAB_W, rowH); // -4 offset to align it onto the left separator

  ctx.fillStyle = C.pitchAxis;
  ctx.fillRect(Math.round(x + w / 2), y, 1, rowH); // the band root, dead centre

  const px = (f) => x + f * w;
  const topX = g.topX;
  const botX = next ? next.topX : null;
  // A row with no tick of its own is a pass-through: the contour crosses it in
  // a straight line, so its middle is halfway between the two crossings.
  const midX = g.x !== null ? g.x
    : topX !== null && botX !== null ? (topX + botX) / 2 : null;
  if (midX !== null && (topX !== null || botX !== null)) {
    ctx.save();
    ctx.globalAlpha = CONTOUR_ALPHA;
    ctx.strokeStyle = C.pitchPole;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (topX !== null) { ctx.moveTo(px(topX), y); ctx.lineTo(px(midX), y + rowH / 2); }
    else ctx.moveTo(px(midX), y + rowH / 2);
    if (botX !== null) ctx.lineTo(px(botX), y + rowH);
    ctx.stroke();
    ctx.restore();
  }

  // An arpeggio: the two pitches the row's other ticks reach, on a bar that
  // spans all three, so the row reads as a chord swept rather than as a note
  // that has wandered. Drawn UNDER the root tick, which stays the full-height
  // one the contour runs through.
  if (g.arp !== null) {
    ctx.save();
    ctx.globalAlpha = ARP_ALPHA;
    ctx.fillStyle = C.pitchPole;
    const xs = [g.x, g.arp[0], g.arp[1]];
    const lo = px(Math.min(...xs)), hi = px(Math.max(...xs));
    const mid = Math.round(y + rowH / 2);
    ctx.fillRect(lo, mid, Math.max(hi - lo, 1), 1);
    const h = Math.round(rowH * ARP_TICK_H);
    for (const f of g.arp) {
      const ax = Math.min(Math.max(Math.round(px(f)) - 1, x), x + w - 2);
      ctx.fillRect(ax, mid - Math.round(h / 2), 2, h);
    }
    ctx.restore();
  }

  if (g.x !== null) {
    ctx.save();
    ctx.globalAlpha = TICK_ALPHA;
    ctx.fillStyle = C.pitchPole;
    // Full row height, so a run of notes at one pitch draws one unbroken line
    // rather than a column of dashes — a plot, not a row of characters.
    // Clamped so a note sitting on either edge of the band still shows its
    // whole width rather than half of it off the side.
    const tx = Math.min(Math.max(Math.round(px(g.x)) - 1, x), x + w - 2);
    ctx.fillRect(tx, y, 2, rowH);
    ctx.restore();
  }
}
