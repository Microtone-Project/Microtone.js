// Find & Change (item 132) — the pure core of the advanced pattern edit: a
// PREDICATE that picks cells out of a block, and an ACTION list that rewrites
// the ones it picked. The dialog over it is ui/popups/findchange.js; both the
// Patterns toolbar and the grids' right-click menu open that same dialog, so
// there is one set of rules however you got here.
//
// The item's own vocabulary, kept verbatim:
//
//   term       one test on one column — `volume ≥ $30`, `note in $4000‥$4FFF`
//   condition  one or more terms, ANDed together
//   predicate  one or more conditions, ORed together
//   action     one write to one column: SET / ADD / MULTIPLY-AND-ADD / CLEAR
//
// An EMPTY predicate matches every cell — "change everything here" is a real
// thing to ask for, and making it the no-conditions state is cheaper than a
// checkbox that means the same. An empty action list changes nothing.
//
// ── the rules, in one place ──
//
// · The predicate is evaluated on the cell AS IT WAS. The actions then run in
//   the order they are listed, each seeing the previous one's result, so
//   "×2 then +1" is a two-line answer as well as a one-line one.
// · ADD and MULTIPLY-AND-ADD only touch a column that CARRIES something: they
//   amplify what is there rather than conjuring commands into blank cells
//   (patterntools.js's scaleVolumeAt has always worked this way, and a bulk
//   "+1 instrument" that filled every empty cell with instrument 01 would be
//   unusable). SET writes regardless — that is what makes it SET.
// · SET on a volume/panning column that is BLANK (the FINE-with-0 sentinel)
//   promotes it to the plain SET selector, exactly as typing a digit into an
//   empty column does (edit.js volPanDigit). Writing $30 into a blank column
//   and getting a fine slide of 16 instead would be a trap.
// · Changing a column's OPERATION (the `volop`/`panop` fields) leaves a blank
//   column blank: the operation says what to do with a value the column hasn't
//   got. edit.js volPanSelect refuses the same thing for the same reason.
// · Notes: arithmetic skips the sentinel space $0000‥$001F (an empty cell, a
//   key-off, an interrupt) and clamps its result to $0020‥$FFFF — you cannot
//   transpose a key-off, and a note must not fall INTO the sentinels. SET can
//   still write any word, which is how you stamp a key-off across a block.
// · Panning: the narrow cell's column is a front ARC and clamps; the wide
//   cell's is a 9-bit ANGLE and wraps. Same reasoning as transformPanAt —
//   past hard left is a direction, not a wall.
//
// Pure: no DOM, no i18n, no document. Labels are i18n keys the UI owns; this
// module deals in ids and numbers, and is therefore Node-testable on its own.

import { MIDDLE_C } from "../engine/constants.js";
import { CUE_EMPTY } from "../format/taud-const.js";
import {
  cellStride, readVol, writeVol, writeVolSel, readPan, writePan, writePanSel,
  readElev, writeElev,
} from "./patterntools.js";

/** The selector value that means "one-shot fine delta"; with a zero argument
 *  it is the blank-column sentinel (file format §5.5). */
const SEL_FINE = 3;
const SEL_SET = 0;

/** The lowest PLAYABLE note word — everything below is a sentinel
 *  (terranmon.txt:3041: $0000 empty, $0001‥$0004 key-off/cut/fade,
 *  $0010‥$001F interrupts). */
export const NOTE_MIN = 0x0020;

// ── the columns you can ask about ──────────────────────────────────────────
// `kind` picks the operator set and how a value is typed:
//   "num"   a plain number, hex by default (the grid's own base)
//   "note"  a note word — also accepts a note NAME ("C-4", "F#3")
//   "fxop"  an effect opcode — also accepts its base-36 letter ("S", "G")
//   "vpop"  which OPERATION a volume/panning column carries (VP_OPS below)
//   "cell"  the whole cell, and only the has/blank tests
// `wideOnly` fields exist only in the 16-byte cell (§5.5); `readOnly` ones can
// be tested but not written (there is no writing a row number).

export const FIELDS = [
  { id: "note", kind: "note", hex: true, digits: 4 },
  { id: "inst", kind: "num", hex: true, digits: 2, min: 0, max: 0xff },
  { id: "vol", kind: "num", hex: true, digits: 2, min: 0 },
  { id: "volop", kind: "vpop" },
  { id: "pan", kind: "num", hex: true, min: 0 },
  { id: "panop", kind: "vpop" },
  { id: "elev", kind: "num", hex: false, min: -128, max: 127, wideOnly: true },
  { id: "fx1", kind: "fxop" },
  { id: "fx1arg", kind: "num", hex: true, digits: 4, min: 0, max: 0xffff },
  { id: "fx2", kind: "fxop", wideOnly: true },
  { id: "fx2arg", kind: "num", hex: true, digits: 4, min: 0, max: 0xffff, wideOnly: true },
  { id: "row", kind: "num", hex: false, min: 0, max: 63, readOnly: true },
  { id: "cell", kind: "cell", readOnly: true },
];

const FIELD_BY_ID = new Map(FIELDS.map((f) => [f.id, f]));

/** The field record for an id, or null. */
export function fieldById(id) { return FIELD_BY_ID.get(id) ?? null; }

/** The fields available in a format, for testing (`readOnly` included) or for
 *  writing (`readOnly` dropped). */
export function fieldsFor(wide, forWriting = false) {
  return FIELDS.filter((f) => (wide || !f.wideOnly) && (!forWriting || !f.readOnly));
}

/** A field's value range in the format in play — the volume column is 6-bit in
 *  the narrow cell and a whole byte in the wide one, and the panning column is
 *  a 6-bit arc there and a 9-bit angle here (§5.5). */
export function fieldRange(id, wide) {
  switch (id) {
    case "note": return { min: 0, max: 0xffff };
    case "vol": return { min: 0, max: wide ? 0xff : 0x3f };
    case "pan": return { min: 0, max: wide ? 0x1ff : 0x3f };
    case "fx1": case "fx2": return { min: 0, max: 0xff };
    case "volop": case "panop": return { min: 0, max: VP_OPS.length - 1 };
    case "cell": return { min: 0, max: 1 };
    default: {
      const f = fieldById(id);
      return { min: f?.min ?? 0, max: f?.max ?? 0xffff };
    }
  }
}

/** Hex digits a field is written in — the wide cell's panning angle needs
 *  three, everything else follows its own record. */
export function fieldDigits(id, wide) {
  if (id === "pan") return wide ? 3 : 2;
  if (id === "vol") return 2;
  return fieldById(id)?.digits ?? 2;
}

/** The five operations a volume/panning column can carry, plus the blank one —
 *  the same list edit.js volPanOp names, in its order, so a code IS an index
 *  into it. */
export const VP_OPS = ["set", "up", "down", "fineUp", "fineDown", "none"];

// ── operators ──────────────────────────────────────────────────────────────

/** Term operators. `args` is how many operands the UI must ask for. */
export const TERM_OPS = [
  { id: "eq", args: 1 },
  { id: "ne", args: 1 },
  { id: "lt", args: 1 },
  { id: "le", args: 1 },
  { id: "gt", args: 1 },
  { id: "ge", args: 1 },
  { id: "in", args: 2 },
  { id: "notin", args: 2 },
  { id: "mod", args: 2 },
  { id: "has", args: 0 },
  { id: "blank", args: 0 },
];

/** Action operators — the item's "as simple as SET, as complex as
 *  MULTIPLY-AND-ADD", plus the CLEAR every bulk editor ends up wanting. */
export const ACTION_OPS = [
  { id: "set", args: 1 },
  { id: "add", args: 1 },
  { id: "muladd", args: 2 },
  { id: "clear", args: 0 },
];

const ORDERED_OPS = ["eq", "ne", "lt", "le", "gt", "ge", "in", "notin", "mod", "has", "blank"];
const ENUM_OPS = ["eq", "ne", "has", "blank"];

/** Which term operators a field kind can be tested with: only the columns that
 *  hold a NUMBER can be ordered, and the whole-cell field is a yes/no. */
export function termOpsFor(kind) {
  if (kind === "cell") return TERM_OPS.filter((o) => o.id === "has" || o.id === "blank");
  const ids = kind === "num" || kind === "note" ? ORDERED_OPS : ENUM_OPS;
  return TERM_OPS.filter((o) => ids.includes(o.id));
}

/** …and which action operators: arithmetic needs a number to do it to, so an
 *  opcode or a column operation can only be set or cleared. */
export function actionOpsFor(kind) {
  if (kind === "num" || kind === "note") return ACTION_OPS;
  return ACTION_OPS.filter((o) => o.id === "set" || o.id === "clear");
}

/** Is this action operand a MULTIPLIER (a plain decimal float) rather than a
 *  value in the field's own base? Only MULTIPLY-AND-ADD's first one is. */
export function operandIsMultiplier(op, index) { return op === "muladd" && index === 0; }

// ── reading a cell ─────────────────────────────────────────────────────────

/** Which operation a vol/pan column carries, as an index into VP_OPS. The
 *  narrow column's fine-direction flag is bit 5, the wide one's the top bit of
 *  whichever field it is (edit.js colSpec). */
function vpCode({ value, sel }, isPan, wide) {
  if (sel !== SEL_FINE) return sel === 1 ? 1 : sel === 2 ? 2 : 0;
  if (value === 0) return 5; // "none" — the blank-column sentinel
  const dir = wide ? (isPan ? 0x100 : 0x80) : 0x20;
  return (value & dir) !== 0 ? 3 : 4;
}

/**
 * One column's value, as the operators see it. `ctx` supplies what is not in
 * the bytes — the row number. Returns null for a field this format hasn't got.
 */
export function readField(bytes, wide, id, ctx = {}) {
  switch (id) {
    case "note": return bytes[0] | (bytes[1] << 8);
    case "inst": return bytes[2];
    case "vol": return readVol(bytes, 0, wide).value;
    case "volop": return vpCode(readVol(bytes, 0, wide), false, wide);
    case "pan": return readPan(bytes, 0, wide).value;
    case "panop": return vpCode(readPan(bytes, 0, wide), true, wide);
    case "elev": return wide ? readElev(bytes, 0, wide) : null;
    case "fx1": return bytes[5];
    case "fx1arg": return bytes[6] | (bytes[7] << 8);
    case "fx2": return wide ? bytes[10] : null;
    case "fx2arg": return wide ? bytes[11] | (bytes[12] << 8) : null;
    case "row": return ctx.row ?? 0;
    case "cell": return cellHasContent(bytes, wide) ? 1 : 0;
    default: return null;
  }
}

/** Does this cell say anything at all? The engine's own reading of a blank
 *  column (row.js volIsSet/panIsSet), extended to the whole cell. */
export function cellHasContent(bytes, wide) {
  for (const id of ["note", "inst", "vol", "pan", "elev", "fx1", "fx2"]) {
    if (fieldHasContent(bytes, wide, id)) return true;
  }
  return false;
}

/**
 * Does this COLUMN carry something? What `has`/`blank` test, and what gates
 * the arithmetic operators.
 *
 * An effect ARGUMENT belongs to its opcode: an argument with no command in
 * front of it is dead bytes, so `fx1arg has …` asks whether there is a first
 * effect at all, not whether those two bytes happen to be non-zero.
 */
export function fieldHasContent(bytes, wide, id) {
  switch (id) {
    case "note": return (bytes[0] | (bytes[1] << 8)) !== 0;
    case "inst": return bytes[2] !== 0;
    case "vol": case "volop": {
      const v = readVol(bytes, 0, wide);
      return !(v.sel === SEL_FINE && v.value === 0);
    }
    case "pan": case "panop": {
      const p = readPan(bytes, 0, wide);
      if (!(p.sel === SEL_FINE && p.value === 0)) return true;
      return wide ? readElev(bytes, 0, wide) !== 0 : false;
    }
    case "elev": return wide ? readElev(bytes, 0, wide) !== 0 : false;
    case "fx1": case "fx1arg": return bytes[5] !== 0;
    case "fx2": case "fx2arg": return wide ? bytes[10] !== 0 : false;
    case "row": return true;
    case "cell": return cellHasContent(bytes, wide);
    default: return false;
  }
}

/** Can arithmetic run on this column? Same question as fieldHasContent, except
 *  that a note in the sentinel space is not a pitch to move. */
function fieldIsArithmetic(bytes, wide, id) {
  if (id === "note") return (bytes[0] | (bytes[1] << 8)) >= NOTE_MIN;
  return fieldHasContent(bytes, wide, id);
}

// ── evaluating a predicate ─────────────────────────────────────────────────

/** One term against one cell. A term naming a field this format hasn't got is
 *  false rather than an error — a v2 project simply has no second effect. */
export function evalTerm(bytes, wide, term, ctx = {}) {
  if (!term || !fieldById(term.field)) return false;
  if (term.op === "has") return fieldHasContent(bytes, wide, term.field);
  // A column the format hasn't got is blank, not an error: fieldHasContent
  // already reads a second effect as absent in a version-2 project.
  if (term.op === "blank") return !fieldHasContent(bytes, wide, term.field);
  const v = readField(bytes, wide, term.field, ctx);
  if (v === null) return false;
  const a = Number(term.a ?? 0), b = Number(term.b ?? 0);
  switch (term.op) {
    case "eq": return v === a;
    case "ne": return v !== a;
    case "lt": return v < a;
    case "le": return v <= a;
    case "gt": return v > a;
    case "ge": return v >= a;
    case "in": return v >= Math.min(a, b) && v <= Math.max(a, b);
    case "notin": return v < Math.min(a, b) || v > Math.max(a, b);
    // "every 4th row" and "every other note" — the one test a tracker asks for
    // that no comparison can express.
    case "mod": return a > 0 && ((v % a) + a) % a === (((b % a) + a) % a);
    default: return false;
  }
}

/** All the terms, ANDed. An EMPTY condition matches nothing — it is a row the
 *  user has not filled in yet, and treating it as "everything" would make a
 *  half-built predicate silently select the whole song. */
export function evalCondition(bytes, wide, condition, ctx = {}) {
  if (!condition || condition.length === 0) return false;
  return condition.every((term) => evalTerm(bytes, wide, term, ctx));
}

/** The conditions, ORed. An empty predicate matches EVERY cell. */
export function evalPredicate(bytes, wide, predicate, ctx = {}) {
  if (!predicate || predicate.length === 0) return true;
  return predicate.some((cond) => evalCondition(bytes, wide, cond, ctx));
}

// ── writing a cell ─────────────────────────────────────────────────────────

const clampTo = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Fit a value to the column: the wide cell's azimuth WRAPS (it is an angle),
 *  everything else clamps to its own range. */
function fit(id, wide, v) {
  const { min, max } = fieldRange(id, wide);
  if (id === "pan" && wide) return ((Math.round(v) % 512) + 512) % 512;
  return clampTo(Math.round(v), min, max);
}

/** Write one column. Returns true when the bytes actually changed. */
export function writeField(bytes, wide, id, value) {
  const before = snapshot(bytes);
  switch (id) {
    case "note": {
      const v = fit("note", wide, value);
      bytes[0] = v & 0xff; bytes[1] = (v >>> 8) & 0xff;
      break;
    }
    case "inst": bytes[2] = fit("inst", wide, value) & 0xff; break;
    case "vol": {
      // A blank column promotes to SET, so "volume = $30" means what it says
      // rather than "fine-slide by 16" (edit.js volPanDigit).
      const cur = readVol(bytes, 0, wide);
      if (cur.sel === SEL_FINE && cur.value === 0) writeVolSel(bytes, 0, wide, SEL_SET);
      writeVol(bytes, 0, wide, fit("vol", wide, value));
      break;
    }
    case "volop": return writeVpOp(bytes, wide, false, value);
    case "pan": {
      const cur = readPan(bytes, 0, wide);
      if (cur.sel === SEL_FINE && cur.value === 0) writePanSel(bytes, 0, wide, SEL_SET);
      writePan(bytes, 0, wide, fit("pan", wide, value));
      break;
    }
    case "panop": return writeVpOp(bytes, wide, true, value);
    case "elev":
      if (!wide) return false;
      writeElev(bytes, 0, wide, fit("elev", wide, value));
      break;
    case "fx1": bytes[5] = fit("fx1", wide, value) & 0xff; break;
    case "fx1arg": {
      const v = fit("fx1arg", wide, value);
      bytes[6] = v & 0xff; bytes[7] = (v >>> 8) & 0xff;
      break;
    }
    case "fx2":
      if (!wide) return false;
      bytes[10] = fit("fx2", wide, value) & 0xff;
      break;
    case "fx2arg": {
      if (!wide) return false;
      const v = fit("fx2arg", wide, value);
      bytes[11] = v & 0xff; bytes[12] = (v >>> 8) & 0xff;
      break;
    }
    default: return false;
  }
  return changedSince(bytes, before);
}

/**
 * Switch a volume/panning column to VP_OPS[code].
 *
 * A blank column stays blank (see the header): the operation describes what to
 * do with a value that isn't there. A fine slide can't carry a zero magnitude
 * — that byte IS the blank sentinel — so it seeds 1, exactly as
 * edit.js volPanSelect does.
 */
function writeVpOp(bytes, wide, isPan, code) {
  const read = isPan ? readPan : readVol;
  const writeVal = isPan ? writePan : writeVol;
  const writeSel = isPan ? writePanSel : writeVolSel;
  const cur = read(bytes, 0, wide);
  const blank = cur.sel === SEL_FINE && cur.value === 0;
  const op = VP_OPS[code | 0] ?? "set";
  if (op === "none") {
    if (blank) return false;
    writeVal(bytes, 0, wide, 0);
    writeSel(bytes, 0, wide, SEL_FINE);
    return true;
  }
  if (blank) return false;
  const dir = wide ? (isPan ? 0x100 : 0x80) : 0x20;
  const mag = wide ? (isPan ? 0xff : 0x7f) : 0x1f;
  // The argument the user can SEE, carried across the switch: a fine slide
  // shows its magnitude, everything else its plain value.
  const arg = cur.sel === SEL_FINE ? (cur.value & mag) : cur.value;
  const before = snapshot(bytes);
  switch (op) {
    case "set": writeVal(bytes, 0, wide, arg); writeSel(bytes, 0, wide, 0); break;
    case "up": writeVal(bytes, 0, wide, arg); writeSel(bytes, 0, wide, 1); break;
    case "down": writeVal(bytes, 0, wide, arg); writeSel(bytes, 0, wide, 2); break;
    case "fineUp":
      writeVal(bytes, 0, wide, dir | Math.max(1, arg & mag));
      writeSel(bytes, 0, wide, SEL_FINE);
      break;
    case "fineDown":
      writeVal(bytes, 0, wide, Math.max(1, arg & mag));
      writeSel(bytes, 0, wide, SEL_FINE);
      break;
    default: return false;
  }
  return changedSince(bytes, before);
}

/** Blank a column — each one's own idea of empty (§5.5). Clearing the panning
 *  column of a wide cell takes its elevation with it: the two are one column on
 *  screen and one question to the engine (row.js panIsSet). */
function clearField(bytes, wide, id) {
  const before = snapshot(bytes);
  switch (id) {
    case "note": bytes[0] = 0; bytes[1] = 0; break;
    case "inst": bytes[2] = 0; break;
    case "vol": case "volop":
      writeVol(bytes, 0, wide, 0);
      writeVolSel(bytes, 0, wide, SEL_FINE);
      break;
    case "pan": case "panop":
      writePan(bytes, 0, wide, 0);
      writePanSel(bytes, 0, wide, SEL_FINE);
      if (wide) writeElev(bytes, 0, wide, 0);
      break;
    case "elev": if (wide) writeElev(bytes, 0, wide, 0); break;
    // An argument with no opcode in front of it is junk the grid would still
    // paint, so clearing an effect clears the whole command.
    case "fx1": bytes[5] = 0; bytes[6] = 0; bytes[7] = 0; break;
    case "fx1arg": bytes[6] = 0; bytes[7] = 0; break;
    case "fx2": if (wide) { bytes[10] = 0; bytes[11] = 0; bytes[12] = 0; } break;
    case "fx2arg": if (wide) { bytes[11] = 0; bytes[12] = 0; } break;
    default: return false;
  }
  return changedSince(bytes, before);
}

const snapshot = (bytes) => Uint8Array.from(bytes);
function changedSince(bytes, before) {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== before[i]) return true;
  return false;
}

/**
 * Run one action against one cell's bytes, in place. Returns true when it
 * changed them.
 *
 * ADD and MULTIPLY-AND-ADD are the same operation with the multiplier fixed at
 * 1, and both refuse a column that carries nothing — the header says why.
 */
export function applyAction(bytes, wide, action) {
  const f = fieldById(action?.field);
  if (!f || f.readOnly) return false;
  if (f.wideOnly && !wide) return false;
  if (action.op === "clear") return clearField(bytes, wide, f.id);
  if (action.op === "set") return writeField(bytes, wide, f.id, Number(action.a ?? 0));
  if (action.op !== "add" && action.op !== "muladd") return false;
  if (!fieldIsArithmetic(bytes, wide, f.id)) return false;
  const cur = readField(bytes, wide, f.id);
  if (cur === null) return false;
  const mult = action.op === "muladd" ? Number(action.a ?? 1) : 1;
  const add = Number(action.op === "muladd" ? (action.b ?? 0) : (action.a ?? 0));
  if (!Number.isFinite(mult) || !Number.isFinite(add)) return false;
  let next = cur * mult + add;
  // A note must not land IN the sentinels — $0020 is the floor for a pitch.
  if (f.id === "note") next = clampTo(Math.round(next), NOTE_MIN, 0xffff);
  return writeField(bytes, wide, f.id, next);
}

/** Every action in turn, each seeing the last one's work. */
export function applyActions(bytes, wide, actions) {
  let changed = false;
  for (const a of actions ?? []) if (applyAction(bytes, wide, a)) changed = true;
  return changed;
}

// ── the driver ─────────────────────────────────────────────────────────────

/**
 * Run a whole query over a list of cells.
 *
 * `cells` is [{pat, row, bytes}] — `bytes` the cell's CURRENT image, which is
 * never mutated (each match is transformed on a copy). Returns the tally the
 * dialog's readout wants plus the `writes` list setCellsBytesOp takes, so the
 * whole edit lands as ONE undo step however many patterns it crossed.
 *
 * `perCondition` counts each condition ON ITS OWN — the events (rows ×
 * channels) that condition alone would select — so the dialog can say which
 * alternative of an OR is doing the work. A cell that two conditions both match
 * is counted in both, which is why the numbers can add up to more than
 * `matched`: they answer "what does this one select", not "what did this one
 * contribute". Every condition is therefore evaluated for every cell, with no
 * short-circuit on the first hit.
 */
export function runPatternQuery(cells, query, wide) {
  const predicate = query?.predicate ?? [];
  const actions = query?.actions ?? [];
  const writes = [];
  const perCondition = new Array(predicate.length).fill(0);
  let matched = 0;
  for (const cell of cells) {
    const ctx = { row: cell.row };
    let hit = predicate.length === 0; // no conditions = every cell
    for (let i = 0; i < predicate.length; i++) {
      if (!evalCondition(cell.bytes, wide, predicate[i], ctx)) continue;
      perCondition[i]++;
      hit = true;
    }
    if (!hit) continue;
    matched++;
    const bytes = Uint8Array.from(cell.bytes);
    if (applyActions(bytes, wide, actions)) writes.push({ pat: cell.pat, row: cell.row, bytes });
  }
  return { total: cells.length, matched, perCondition, writes };
}

/**
 * The scopes a Find & Change can offer over `cells`, narrowest first — the
 * question "and everywhere else?", answered only where an answer exists.
 *
 *   {id: "here"}              the caller's own cells; carries `pat` when they
 *                             happen to BE one whole pattern, so the dialog can
 *                             name it as the pattern rather than list it twice
 *   {id: "pattern", pat}      all 64 rows of the pattern those cells sit in
 *   {id: "column", ch, patterns}  every pattern one voice column plays
 *   {id: "song", patterns}    every pattern the song has
 *
 * Only MATERIALISED patterns are listed (item 48): an index a cue names but
 * nothing has ever been written to holds nothing to change, and conjuring a
 * hundred empty patterns into the file to write nothing into them is not what
 * a wide scope means. The caller's own cells are left alone — a pattern you
 * have named and can type into is a different thing from a hundred you have
 * not.
 *
 * `channel` is the voice the cells belong to when the caller knows it (a
 * Timeline block does); without it the column is DERIVED — the sole voice
 * whose cue words name this pattern, since one shared by several columns names
 * none of them.
 */
export function queryScopes(song, channelCount, cells, channel = null) {
  const isReal = (p) => !!song?.patterns[p];
  const list = cells ?? [];
  const onePat = list.length && list.every((c) => c.pat === list[0].pat) ? list[0].pat : null;
  const hereIsPattern = onePat !== null && list.length === 64;
  const out = [hereIsPattern ? { id: "here", pat: onePat } : { id: "here" }];
  if (onePat !== null && !hereIsPattern) out.push({ id: "pattern", pat: onePat });

  const ch = channel ?? soleColumnFor(song, channelCount, onePat);
  if (ch !== null) {
    const seen = new Set();
    for (const words of song?.cues ?? []) {
      const p = words[ch] & 0x7fff;
      if (p !== CUE_EMPTY) seen.add(p);
    }
    const patterns = [...seen].filter(isReal);
    if (patterns.length) out.push({ id: "column", ch, patterns });
  }

  const patterns = [];
  for (let p = 0; p < (song?.patterns.length ?? 0); p++) if (isReal(p)) patterns.push(p);
  if (patterns.length) out.push({ id: "song", patterns });
  return out;
}

/** The one voice column whose cue words name `pat`, or null when several do,
 *  none do, or there is no pattern to ask about. */
export function soleColumnFor(song, channelCount, pat) {
  if (pat === null || pat === undefined || !song) return null;
  let found = null;
  for (const words of song.cues) {
    for (let ch = 0; ch < channelCount; ch++) {
      if ((words[ch] & 0x7fff) !== pat) continue;
      if (found !== null && found !== ch) return null;
      found = ch;
    }
  }
  return found;
}

/** Pull a pattern IMAGE apart into the per-cell records runPatternQuery takes.
 *  `rows` limits the span (an inclusive [r0, r1] pair); omit for all 64. */
export function cellsFromPattern(image, pat, wide, rows = null) {
  const w = cellStride(wide);
  const [r0, r1] = rows ?? [0, 63];
  const out = [];
  for (let r = r0; r <= r1; r++) out.push({ pat, row: r, bytes: image.subarray(r * w, r * w + w) });
  return out;
}

// ── typing values in ───────────────────────────────────────────────────────

const NOTE_LETTERS = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/**
 * A note NAME as the grid writes it: letter, optional accidental (`#`/`b`, or
 * the `-` the grid uses as a placeholder), octave. C-4 is middle C = $5000,
 * matching notenames.js's labelling and edit.js semiToNote's arithmetic.
 * Returns null for anything that is not one.
 */
export function parseNoteName(s) {
  const m = /^([A-Ga-g])([#b-]?)(-?\d{1,2})$/.exec(String(s).trim());
  if (!m) return null;
  const semi = NOTE_LETTERS[m[1].toLowerCase()] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
  const octave = parseInt(m[3], 10);
  const v = MIDDLE_C + (octave - 4) * 4096 + Math.round((semi * 4096) / 12);
  return v >= 0 && v <= 0xffff ? v : null;
}

/**
 * A scalar in a column's own base. Tracker columns are HEX — that is what the
 * grid shows and what the change-instrument dialog has always taken — so a
 * bare `30` in the volume column is $30, and `#48` is the decimal way to say
 * the same thing. `$`/`0x` are accepted for the people who type them anyway,
 * and a leading sign for the fields that go below zero.
 */
function parseScalar(s, hex) {
  const m = /^([+-]?)(\$|0x|0X|#)?([0-9a-fA-F]+)$/.exec(String(s).trim());
  if (!m) return null;
  const base = m[2] === "#" ? 10 : m[2] ? 16 : (hex ? 16 : 10);
  if (base === 10 && !/^\d+$/.test(m[3])) return null;
  const v = parseInt(m[3], base);
  if (!Number.isFinite(v)) return null;
  return m[1] === "-" ? -v : v;
}

/**
 * Parse what the user typed into a field's operand. Note fields also take note
 * names, effect fields their base-36 letter (`S`, `G` — the grid's own
 * spelling). Returns null when it is not a value at all, which is what the
 * dialog shows as an unfinished row.
 */
export function parseFieldValue(id, text) {
  const f = fieldById(id);
  const s = String(text ?? "").trim();
  if (!f || s === "") return null;
  if (f.kind === "note") {
    const named = parseNoteName(s);
    if (named !== null) return named;
  }
  if (f.kind === "fxop" && /^[0-9A-Za-z]$/.test(s)) {
    const op = parseInt(s, 36);
    if (op >= 1 && op <= 0x23) return op;
  }
  return parseScalar(s, f.hex === true);
}

/** A multiplier — always plain decimal, never a column's hex. */
export function parseMultiplier(text) {
  const v = parseFloat(String(text ?? "").trim());
  return Number.isFinite(v) ? v : null;
}

/** Canonical text for a value in a field's own base: `$30`, `-12`, `C-4`'s
 *  word as `$5000`, an effect as its base-36 letter. The UI adds the note NAME
 *  beside it — that needs the song's notation, which this module has no
 *  business knowing. */
export function formatFieldValue(id, value, wide) {
  const f = fieldById(id);
  if (!f || value === null || value === undefined) return "";
  if (f.kind === "fxop") return value >= 1 ? value.toString(36).toUpperCase() : "—";
  if (f.kind === "vpop") return VP_OPS[value] ?? String(value);
  if (!f.hex) return String(value);
  const digits = fieldDigits(id, wide);
  const neg = value < 0;
  return (neg ? "-$" : "$") + Math.abs(value).toString(16).toUpperCase().padStart(digits, "0");
}

// ── a query as a whole ─────────────────────────────────────────────────────

/** A fresh term for `field`, with an operator it actually supports. */
export function defaultTerm(field = "note") {
  const kind = fieldById(field)?.kind ?? "num";
  return { field, op: termOpsFor(kind)[0].id, a: "", b: "" };
}

/** A fresh action for `field`. */
export function defaultAction(field = "vol") {
  const kind = fieldById(field)?.kind ?? "num";
  return { field, op: actionOpsFor(kind)[0].id, a: "", b: "" };
}

/** The query a freshly opened dialog starts from: one condition of one term,
 *  one action, nothing filled in. */
export function defaultQuery() {
  return { predicate: [[defaultTerm("note")]], actions: [defaultAction("vol")] };
}

/**
 * Turn the dialog's text fields into the numbers the evaluator wants, dropping
 * anything unfinished: a term whose operand is blank, a condition left with no
 * usable term, an action that would not know what to write. What comes back is
 * always runnable — which is what lets the readout recompute on every keystroke
 * without the half-typed states throwing.
 *
 * Dropping a condition renumbers the rest, so `condOf[i]` gives the RAW index
 * compiled condition `i` came from: that is how the dialog puts each condition's
 * own event count back on the card it belongs to. (An unfinished condition
 * cannot simply be kept as an empty one — an empty condition matches nothing,
 * while an empty PREDICATE matches everything, and a half-typed first term must
 * not silently mean "no cells".)
 */
export function compileQuery(raw) {
  const predicate = [];
  const condOf = [];
  for (const [ci, cond] of (raw?.predicate ?? []).entries()) {
    const terms = [];
    for (const term of cond ?? []) {
      const compiled = compileTerm(term);
      if (compiled) terms.push(compiled);
    }
    if (terms.length) { predicate.push(terms); condOf.push(ci); }
  }
  const actions = [];
  for (const action of raw?.actions ?? []) {
    const compiled = compileAction(action);
    if (compiled) actions.push(compiled);
  }
  return { predicate, actions, condOf };
}

/** Per-RAW-condition event counts, from a compiled query's `condOf` map and a
 *  run's `perCondition` tally. Unfinished conditions come back as null rather
 *  than 0 — they select nothing because they are not written yet, and "0
 *  events" would read as an answer. */
export function conditionCounts(raw, compiled, result) {
  const counts = new Array(raw?.predicate?.length ?? 0).fill(null);
  (compiled?.condOf ?? []).forEach((rawIdx, i) => {
    counts[rawIdx] = result?.perCondition?.[i] ?? 0;
  });
  return counts;
}

function operandCount(ops, id) { return ops.find((o) => o.id === id)?.args ?? 0; }

function compileTerm(term) {
  const f = fieldById(term?.field);
  if (!f) return null;
  if (!termOpsFor(f.kind).some((o) => o.id === term.op)) return null;
  const need = operandCount(TERM_OPS, term.op);
  const out = { field: f.id, op: term.op };
  if (need >= 1) {
    const a = parseFieldValue(f.id, term.a);
    if (a === null) return null;
    out.a = a;
  }
  if (need >= 2) {
    const b = parseFieldValue(f.id, term.b);
    if (b === null) return null;
    out.b = b;
  }
  return out;
}

function compileAction(action) {
  const f = fieldById(action?.field);
  if (!f || f.readOnly) return null;
  if (!actionOpsFor(f.kind).some((o) => o.id === action.op)) return null;
  const need = operandCount(ACTION_OPS, action.op);
  const out = { field: f.id, op: action.op };
  for (let i = 0; i < need; i++) {
    const key = i === 0 ? "a" : "b";
    const v = operandIsMultiplier(action.op, i)
      ? parseMultiplier(action[key])
      : parseFieldValue(f.id, action[key]);
    if (v === null) return null;
    out[key] = v;
  }
  return out;
}
