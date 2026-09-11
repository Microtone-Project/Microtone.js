// Vector note-glyph painter — the web equivalent of taut's custom pattern
// font (tautfont_*.chr), redrawn as canvas paths so they scale with the cell
// metrics. Renders the 4-char-wide note cell:
//
//   [letter][ accidental ×2 ][octave]      normal presets (taut layout —
//                                          accidentals span TWO cells)
//   [tick][letter][acc ×1][octave]         Kite notation (compact accidental)
//   [  CJK char spanning 2  ][oct][ ]      Shi'er lü (conventional CJK font)
//   [    sentinel vector, full width  ]    key-off / cut / fade / fast-fade
//   [ IntH ] / [ hex4 ]                    interrupts / raw mode & no-preset
//
// ── MANUAL TUNING ──
// All glyph geometry lives in the GLYPH table below as fractions of the cell
// box (x/w horizontal, y/h vertical). Tweak a number, reload
// test/browser/glyph-gallery.html (it renders every glyph large), iterate.
// Sentinel shapes per spec: key-off = wide low-height rectangle; cut =
// connected vertically-centred ^^^; fade = connected greater-amplitude ~~~;
// fast-fade = a sinc function with a TRIANGULAR main lobe (the "~^~" sigil —
// the cut-like spike at x=0 sits inside a decaying sinc envelope).

import { resolveNoteSymbol } from "./pitchtables.js";
import { hex2, hex4, fxArgFields, fxOpChar } from "./notenames.js";
import { volPanOp, volPanArg } from "./edit.js";

export const NOTE_CELL_CHARS = 4;

export const GLYPH = {
  lineWidth: 1.3,

  // Vertical shift of EVERY vector-drawn component (sentinels, accidentals,
  // ticks, naturals) as a fraction of row height, positive = down. The text
  // parts of a cell (letter, octave digit) sit on the FONT's own baseline,
  // which moves when the grid font changes (--cv-font) — tune this until the
  // vectors line up with the new font. Live slider in glyph-gallery.html.
  baselineOffset: -0.03,

  // sentinels (fractions of the full 4-char cell)
  keyoffW: 0.76,      // box width
  keyoffH: 0.28,      // box height
  cutAmp: 0.17,       // ^^^ amplitude (of cell height)
  cutPeaks: 3,
  cutSpanX: [0.10, 0.90],
  fadeAmp: 0.13,      // ~~~ amplitude
  fadePeriods: 3,
  fadeSpanX: [0.12, 0.88],
  // fast-fade (~^~): sinc envelope with a triangular main lobe
  ffAmp: 0.30,        // main-lobe (triangle) peak height (of cell height)
  ffSpanX: [0.06, 0.94],
  ffReach: 4.5,         // sinc t-range each side of centre (integer ends on a zero)
  ffLobeGain: 1.8,    // amplify the small sinc side lobes for legibility

  // sharp family (fractions of one accidental box)
  sharpRise: 0.08,    // crossbar upward slant
  sharpBarX: [0.25, 0.75],
  sharpStemX: [0.38, 0.62],
  sharpVertY: [0.16, 0.84],
  sharpCrossY: [0.36, 0.60],

  // flat family
  flatStemY: [0.12, 0.82],
  flatLoopTopY: 0.58,
  flatSpan: [0.62, 0.72, 0.82],     // width used by the loop run (multi-flats divide this)

  // double sharp (𝄪)
  dsRadius: 0.24,     // of box width
  dsDotSize: 0.48,    // serif dot size relative to radius

  // Kite ticks
  tickW: 0.32,
  tickH: 0.16,
  tickDoubleY: [0.36, 0.64],
  bigDotR: 0.16,

  // natural marker (the '-' in "C-")
  naturalX: [0.30, 0.70],

  // CJK font for Shi'er lü
  cjkFont: '"Noto Sans CJK TC", "Noto Sans CJK", "WenQuanYi Zen Hei", sans-serif',
};

// ── sentinel vectors (span the whole cell width) ──

function drawKeyOff(ctx, x, y, w, h) {
  const bw = w * GLYPH.keyoffW;
  const bh = h * GLYPH.keyoffH;
  ctx.strokeRect(x + (w - bw) / 2 + 0.5, y + (h - bh) / 2 + 0.5, bw, bh);
}

function drawCut(ctx, x, y, w, h) {
  // connected ^^^, vertically centred
  const amp = h * GLYPH.cutAmp;
  const cy = y + h / 2;
  const x0 = x + w * GLYPH.cutSpanX[0];
  const x1 = x + w * GLYPH.cutSpanX[1];
  const seg = (x1 - x0) / (GLYPH.cutPeaks * 2);
  ctx.beginPath();
  ctx.moveTo(x0, cy + amp);
  for (let i = 0; i < GLYPH.cutPeaks; i++) {
    ctx.lineTo(x0 + seg * (i * 2 + 1), cy - amp);
    ctx.lineTo(x0 + seg * (i * 2 + 2), cy + amp);
  }
  ctx.stroke();
}

function drawFade(ctx, x, y, w, h) {
  // connected ~~~ — smooth wave, larger amplitude than the cut
  const amp = h * GLYPH.fadeAmp;
  const cy = y + h / 2;
  const x0 = x + w * GLYPH.fadeSpanX[0];
  const x1 = x + w * GLYPH.fadeSpanX[1];
  const n = 32;
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const px = x0 + ((x1 - x0) * i) / n;
    const py = cy - Math.sin((i / n) * Math.PI * 2 * GLYPH.fadePeriods) * amp;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

function drawFastFade(ctx, x, y, w, h) {
  // "~^~" — a sinc(t) = sin(πt)/(πt) with its main lobe replaced by a
  // TRIANGLE: the sharp central peak evokes the cut's instant behaviour while
  // the decaying side lobes read as a fade tail. The main lobe (|t| < 1) is a
  // straight-edged spike; |t| ≥ 1 is the genuine sinc, joined continuously
  // (both are zero at |t| = 1). ffReach is integer so the curve returns to the
  // baseline at each end.
  const amp = h * GLYPH.ffAmp;
  const cy = y + h / 2;
  const x0 = x + w * GLYPH.ffSpanX[0];
  const x1 = x + w * GLYPH.ffSpanX[1];
  const reach = GLYPH.ffReach;
  const gain = GLYPH.ffLobeGain;
  const n = 64;
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const t = -reach + (2 * reach * i) / n;
    const at = Math.abs(t);
    const v = at < 1
      ? 1 - at                                          // triangular main lobe
      : (Math.sin(Math.PI * t) / (Math.PI * t)) * gain; // sinc side lobes
    const px = x0 + ((x1 - x0) * i) / n;
    const py = cy - v * amp;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

// ── accidentals, drawn inside a box (x, y, w, h) ──

function drawSharpBody(ctx, x, y, w, h, verticals) {
  // verticals straight; crossbars slanted UPWARD to the right (♯, not #)
  const rise = h * GLYPH.sharpRise;
  const xL = x + w * GLYPH.sharpBarX[0];
  const xR = x + w * GLYPH.sharpBarX[1];
  const vXs = [];
  for (let i = 0; i < verticals; i++) {
    const t = (verticals === 1 || verticals === 3 && i === 1) ? 0.5 : (i === 0) ? GLYPH.sharpStemX[0] : GLYPH.sharpStemX[1];
    vXs.push(x + w * t);
  }
  ctx.beginPath();
  for (const vx of vXs) {
    ctx.moveTo(vx, y + h * GLYPH.sharpVertY[0]);
    ctx.lineTo(vx, y + h * GLYPH.sharpVertY[1]);
  }
  for (const cyf of GLYPH.sharpCrossY) {
    const cy = y + h * cyf;
    ctx.moveTo(xL, cy + rise);
    ctx.lineTo(xR, cy - rise);
  }
  ctx.stroke();
}

function drawFlatBody(ctx, x, y, w, h, mirrored, count = 1) {
  // stem + right-facing loop (♭); mirrored = demiflat (loop opens left)
  const span = w * GLYPH.flatSpan[count-1];
  const each = span / count;
  for (let i = 0; i < count; i++) {
    const sx = mirrored
      ? x + w * (0.5 + GLYPH.flatSpan[count-1] / 2) - each * i - each * 0.15
      : x + w * (0.5 - GLYPH.flatSpan[count-1] / 2) + each * i + each * 0.15;
    const dir = mirrored ? -1 : 1;
    ctx.beginPath();
    ctx.moveTo(sx, y + h * GLYPH.flatStemY[0]);
    ctx.lineTo(sx, y + h * GLYPH.flatStemY[1]);
    ctx.bezierCurveTo(
      sx + dir * each * 0.85, y + h * (GLYPH.flatLoopTopY - 0.06),
      sx + dir * each * 0.55, y + h * (GLYPH.flatLoopTopY - 0.18),
      sx, y + h * GLYPH.flatLoopTopY,
    );
    ctx.stroke();
  }
}

function drawDoubleSharp(ctx, x, y, w, h, pair = false) {
  // 𝄪 — an × with serif dots; pair=true draws two side by side (quad sharp)
  const draw = (cx, cy, r) => {
    ctx.beginPath();
    ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
    ctx.moveTo(cx - r, cy + r); ctx.lineTo(cx + r, cy - r);
    ctx.stroke();
    const d = r * GLYPH.dsDotSize;
    for (const [dx, dy] of [[-r, -r], [r, -r], [-r, r], [r, r]]) {
      ctx.fillRect(cx + dx - d / 2, cy + dy - d / 2, d, d);
    }
  };
  const cy = y + h * 0.5;
  if (pair) {
    draw(x + w * 0.28, cy, w * GLYPH.dsRadius * 0.62);
    draw(x + w * 0.72, cy, w * GLYPH.dsRadius * 0.62);
  } else {
    draw(x + w * 0.5, cy, w * GLYPH.dsRadius);
  }
}

function drawTripleSharp(ctx, x, y, w, h) {
  // ♯𝄪 — with a two-cell box there is room for both halves
  drawSharpBody(ctx, x, y, w * 0.72, h, 2);
  const cx = x + w * 0.76;
  const cy = y + h * 0.5;
  const r = w * 0.16;
  ctx.beginPath();
  ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
  ctx.moveTo(cx - r, cy + r); ctx.lineTo(cx + r, cy - r);
  ctx.stroke();
  const d = r * GLYPH.dsDotSize;
  for (const [dx, dy] of [[-r, -r], [r, -r], [-r, r], [r, r]]) {
    ctx.fillRect(cx + dx - d / 2, cy + dy - d / 2, d, d);
  }
}

function drawNatural(ctx, x, y, w, h) {
  ctx.beginPath();
  ctx.moveTo(x + w * GLYPH.naturalX[0], y + h * 0.5);
  ctx.lineTo(x + w * GLYPH.naturalX[1], y + h * 0.5);
  ctx.stroke();
}

// ── Kite ticks ──

function drawTick(ctx, x, y, w, h, up, double_) {
  const cx = x + w * 0.5;
  const aw = w * GLYPH.tickW;
  const ah = h * GLYPH.tickH;
  const draw = (cy) => {
    ctx.beginPath();
    if (up) {
      ctx.moveTo(cx - aw, cy + ah);
      ctx.lineTo(cx, cy - ah);
      ctx.lineTo(cx + aw, cy + ah);
    } else {
      ctx.moveTo(cx - aw, cy - ah);
      ctx.lineTo(cx, cy + ah);
      ctx.lineTo(cx + aw, cy - ah);
    }
    ctx.stroke();
  };
  if (double_) {
    draw(y + h * GLYPH.tickDoubleY[0]);
    draw(y + h * GLYPH.tickDoubleY[1]);
  } else {
    draw(y + h * 0.5);
  }
}

/** Sideways tick (item 87) — the up/down tick rotated, for the pan column's
 *  left/right slides. `right` points the apex toward +x. */
function drawSideTick(ctx, x, y, w, h, right) {
  const cx = x + w * 0.5;
  const cy = y + h * 0.5;
  // The tick's "amplitude" runs horizontally here, so the two axes swap: keep
  // the same ink length by measuring the arms against the cell's height.
  const aw = h * GLYPH.tickW * 0.5;
  const ah = w * GLYPH.tickH * 1.4;
  ctx.beginPath();
  if (right) {
    ctx.moveTo(cx - ah, cy - aw);
    ctx.lineTo(cx + ah, cy);
    ctx.lineTo(cx - ah, cy + aw);
  } else {
    ctx.moveTo(cx + ah, cy - aw);
    ctx.lineTo(cx - ah, cy);
    ctx.lineTo(cx + ah, cy + aw);
  }
  ctx.stroke();
}

function drawBigDot(ctx, x, y, w, h) {
  ctx.beginPath();
  ctx.arc(x + w * 0.5, y + h * 0.5, Math.max(w, 4) * GLYPH.bigDotR, 0, Math.PI * 2);
  ctx.fill();
}

function drawAccidental(ctx, code, x, y, w, h) {
  switch (code) {
    case "#": drawSharpBody(ctx, x, y, w, h, 2); break;
    case "t": drawSharpBody(ctx, x, y, w, h, 1); break;          // demisharp
    case "b": drawFlatBody(ctx, x, y, w, h, false, 1); break;
    case "p": drawFlatBody(ctx, x, y, w, h, true, 1); break;     // demiflat
    case "x": drawDoubleSharp(ctx, x, y, w, h, false); break;
    case "B": drawFlatBody(ctx, x, y, w, h, false, 2); break;    // double flat
    case "3": drawTripleSharp(ctx, x, y, w, h); break;
    case "T": drawFlatBody(ctx, x, y, w, h, false, 3); break;    // triple flat
    case "4": drawDoubleSharp(ctx, x, y, w, h, true); break;     // quad sharp
    default: drawNatural(ctx, x, y, w, h); break;                // '-'
  }
}

function drawTickCode(ctx, code, x, y, w, h) {
  switch (code) {
    case ".": drawBigDot(ctx, x, y, w, h); break;
    case "u": drawTick(ctx, x, y, w, h, true, false); break;
    case "d": drawTick(ctx, x, y, w, h, false, false); break;
    case "U": drawTick(ctx, x, y, w, h, true, true); break;
    case "D": drawTick(ctx, x, y, w, h, false, true); break;
    default: break; // ' ' — no tick
  }
}

/**
 * Flat single-ink palette — every glyph part in one colour. Used for the
 * pattern-ditto ghost cells, which must read as "not really here". Covers the
 * note cell and the effect cell, so one object serves both painters.
 */
export function monoPalette(colour) {
  return {
    note: colour, sentinel: colour, dim: colour, offGrid: colour,
    op: colour, a1: colour, a2: colour, a3: colour, ext: colour,
  };
}

/**
 * Paint the 4-char note cell at (x, y).
 * palette: {note, sentinel, dim, offGrid} — off-grid ("out of tune") notes
 * paint in palette.offGrid (taut's yellow). rawMode forces hex4 for playable
 * notes (the taut rawNoteView toggle).
 */
export function paintNoteCell(ctx, note, preset, x, y, charW, rowH, palette, rawMode = false) {
  const cellW = charW * NOTE_CELL_CHARS;
  const x1 = x + 0;
  const midY = y + rowH / 2;
  // Vector components shift by the baseline axis; fillText stays on the
  // font's own baseline (it IS the reference being matched).
  const dy = rowH * GLYPH.baselineOffset;

  if (note === 0x0000) {
    ctx.fillStyle = palette.dim;
    ctx.globalAlpha = 0.4;
    ctx.fillText("····", x, midY);
    ctx.globalAlpha = 1;
    return;
  }

  // Sentinels — full-width vectors.
  if (note >= 0x0001 && note <= 0x0004) {
    ctx.strokeStyle = palette.sentinel;
    ctx.fillStyle = palette.sentinel;
    ctx.lineWidth = GLYPH.lineWidth;
    ctx.lineJoin = "miter";
    switch (note) {
      case 0x0001: drawKeyOff(ctx, x, y + dy, cellW, rowH); break;
      case 0x0002: drawCut(ctx, x, y + dy, cellW, rowH); break;
      case 0x0003: drawFade(ctx, x, y + dy, cellW, rowH); break;
      case 0x0004: drawFastFade(ctx, x, y + dy, cellW, rowH); break; // ~^~
    }
    return;
  }
  if (note >= 0x0005 && note <= 0x000f) {
    ctx.fillStyle = palette.dim;
    ctx.fillText("rsvd", x, midY);
    return;
  }
  if (note >= 0x0010 && note <= 0x001f) {
    // taut notation: IntH, H = hex 0..F
    ctx.fillStyle = palette.sentinel;
    ctx.fillText("Int" + (note - 0x0010).toString(16).toUpperCase(), x, midY);
    return;
  }

  const symb = rawMode ? null : resolveNoteSymbol(note, preset);
  if (symb === null) {
    ctx.fillStyle = rawMode ? palette.note : palette.dim;
    ctx.fillText(hex4(note), x, midY);
    return;
  }

  // "Out of tune" (off the preset's grid): taut paints it yellow.
  const ink = symb.offGrid ? palette.offGrid : palette.note;
  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;
  ctx.lineWidth = GLYPH.lineWidth;
  ctx.lineJoin = "miter";

  if (symb.cjk) {
    // Shi'er lü — conventional CJK font across two slots + octave digit.
    const prevFont = ctx.font;
    ctx.font = `${Math.round(rowH - 3)}px ${GLYPH.cjkFont}`;
    ctx.fillText(symb.cjk, x + charW * 0.1, midY + 0.5);
    ctx.font = prevFont;
    ctx.fillText(String(symb.octave), x + charW * 2.35, midY);
    return;
  }

  if (symb.tick !== " ") {
    // Kite: [tick][letter][compact accidental][octave]
    drawTickCode(ctx, symb.tick, x1, y + 1 + dy, charW, rowH - 2);
    ctx.fillText(symb.letter, x + charW * 1.1, midY);
    drawAccidental(ctx, symb.acc, x + charW * 1.8, y + 2 + dy, charW * 1.5, rowH - 4);
    ctx.fillText(String(symb.octave), x + charW * 3.1, midY);
  } else {
    // Normal presets: [letter][ accidental spanning TWO cells ][octave]
    ctx.fillText(symb.letter, x + charW * 0.1, midY);
    drawAccidental(ctx, symb.acc, x1 + charW * 1.05, y + 2 + dy, charW * 1.9, rowH - 4);
    ctx.fillText(String(symb.octave), x + charW * 3.1, midY);
  }
}

/**
 * Paint a volume or panning column (item 87) at (x, y): the SYMBOL cell then
 * two argument digits, 3 chars in all.
 *   set          blank symbol — nothing is happening to the value, the digits
 *                simply are the volume / panning
 *   slide        a tick: up/down for volume, left/right for panning, drawn as
 *                vectors so they read at grid size
 *   fine slide   '+' / '−' — a one-shot delta, sign in the symbol and
 *                magnitude (00..1F) in the digits
 *   no-op ($C0)  "···", dimmed like every other empty column
 * palette: {ink, dim} — ink covers symbol + digits (the callers colour the
 * volume, panning and ditto-ghost variants differently).
 */
export function paintVolPanCell(ctx, value, sel, isPan, x, y, charW, rowH, palette) {
  const wide = palette.wide === true;
  const digits = wide && isPan ? 3 : 2;
  const op = volPanOp(value, sel, isPan, wide);
  const midY = y + rowH / 2;
  if (op === "none" && !(wide && isPan && palette.elevation)) {
    ctx.fillStyle = palette.dim;
    ctx.globalAlpha = 0.4;
    // A wide panning column is symbol + elevation + azimuth: six dots, not three.
    ctx.fillText(wide && isPan ? "······" : "···", x, midY);
    ctx.globalAlpha = 1;
    return;
  }
  ctx.fillStyle = palette.ink;
  ctx.strokeStyle = palette.ink;
  ctx.lineWidth = GLYPH.lineWidth;
  ctx.lineJoin = "miter";
  const dy = rowH * GLYPH.baselineOffset;
  switch (op) {
    case "up":
      if (isPan) drawSideTick(ctx, x, y + dy, charW, rowH, true);
      else drawTick(ctx, x, y + 1 + dy, charW, rowH - 2, true, false);
      break;
    case "down":
      if (isPan) drawSideTick(ctx, x, y + dy, charW, rowH, false);
      else drawTick(ctx, x, y + 1 + dy, charW, rowH - 2, false, false);
      break;
    case "fineUp": ctx.fillText("+", x, midY); break;
    case "fineDown": ctx.fillText("−", x, midY); break;
    default: break; // "set" — a deliberate blank
  }
  // The wide panning column carries the ELEVATION between the symbol and the
  // azimuth, in its own ink: the two numbers are different quantities and must
  // not read as one six-digit field.
  let argX = x + charW;
  if (wide && isPan) {
    const el = palette.elevation | 0;
    const txt = elevationCellText(el, op, palette.spatial === true);
    const stated = txt !== "··";
    ctx.fillStyle = stated ? (palette.elevationInk ?? palette.ink) : palette.dim;
    if (!stated) ctx.globalAlpha = 0.4;
    ctx.fillText(txt, argX, midY);
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.ink;
    argX += 2 * charW;
  }
  const arg = volPanArg(value, sel, isPan, wide);
  ctx.fillText(digits === 3 ? hex3(arg) : hex2(arg), argX, midY);
}

/**
 * Paint the 5-char effect cell (opcode + 4 hex nibbles) at (x, y), colouring
 * each of the command's ARGUMENT FIELDS separately — item 120.
 *
 * A Taud argument is rarely one number: `H $2277` is a speed and a depth,
 * `D $4000` is one slide nibble over a reserved byte, `S $8040` is a
 * two-character command carrying a pan. The field map (notenames.fxArgFields)
 * says which nibble belongs to what; this paints field 1/2/3 in three shades of
 * amber, the S / Z multiplexer nibble in the opcode's own ink so the command
 * reads as one token, and reserved nibbles dim because the engine ignores them.
 *
 * palette: {op, a1, a2, a3, dim, ext} — monoPalette() collapses all six for
 * the pattern-ditto ghosts. `paired` (item 162, widened by item 181; the
 * caller decides via notenames.fxColonWarns, which returns one flag per SLOT):
 * true only for the `:` arrangements worth a second look — `:` sitting on the
 * FIRST effect slot (functionally fine, but not where a reader expects it),
 * `:` paired with a command that does not read it at all (a silent no-op), or
 * the SECOND `:` on an interrupt row, whose argument the first one has already
 * won. A `:` correctly on the second slot, paired with something that reads
 * it, is the unremarkable common case and paints through the ordinary
 * per-field colours below like any other row. When `paired` IS true, the whole
 * 5-character cell paints in `palette.ext` instead — the argument-field ramp
 * doesn't describe this cell meaningfully once it's flagged.
 *
 * `pairedOp` (item 162): the OTHER effect slot on this row — passed through
 * to notenames.fxArgFields so an UNflagged (`paired` false) correctly-paired
 * `:`/J/O/2/3 cell colours by what the COMBINED argument means rather than
 * each cell's own isolated layout (see fxArgFields' own doc for exactly
 * which pairings this changes). Ignored when `paired` is true, and harmless
 * to pass for an ordinary unpaired row — fxLayout only branches on it for
 * the specific opcode combinations that define one.
 */
export function paintFxCell(ctx, effect, arg, x, y, charW, rowH, palette, paired = false, pairedOp = 0) {
  const midY = y + rowH / 2;
  if (effect === 0 && arg === 0) {
    ctx.fillStyle = palette.dim;
    ctx.globalAlpha = 0.4;
    ctx.fillText("·····", x, midY);
    ctx.globalAlpha = 1;
    return;
  }
  if (paired) {
    ctx.fillStyle = palette.ext;
    ctx.fillText(fxOpChar(effect) + hex4(arg), x, midY);
    return;
  }
  ctx.fillStyle = palette.op;
  ctx.fillText(fxOpChar(effect), x, midY);
  const fields = fxArgFields(effect, arg, pairedOp);
  const inks = [palette.a1, palette.a2, palette.a3];
  const digits = hex4(arg);
  for (let i = 0; i < 4; i++) {
    const f = fields[i];
    ctx.fillStyle = f === 0 ? palette.op : f < 0 ? palette.dim : inks[f - 1];
    if (f < 0) ctx.globalAlpha = 0.55; // reserved: present, but not a value
    ctx.fillText(digits[i], x + (i + 1) * charW, midY);
    ctx.globalAlpha = 1;
  }
}

/**
 * What the wide panning column's elevation digits read as.
 *
 * On the sphere, ear level is a POSITION — as much a decision as any other
 * height — so a spatial song states it: a placing column shows `00` rather than
 * hiding it under the dots that mean "this field says nothing". A planar song
 * has no height to state, and under a SLIDE selector the field is reserved, so
 * both keep the dots.
 */
export function elevationCellText(el, op, spatial) {
  if (el !== 0) return hex2(el & 0xff);
  return spatial && op === "set" ? "00" : "··";
}

/** Three-digit hex, for the wide panning column's 9-bit azimuth. */
function hex3(v) {
  return (v & 0x1ff).toString(16).toUpperCase().padStart(3, "0");
}
