// Row-level song surgery (item 136.2): insert or delete ABSOLUTE song rows —
// the Timeline trough's Excel-style row commands. Pure planners; the invertible
// wrapper is remapPatternsOp (ops.js), which swaps in the whole patterns array +
// cue list + pNam in one undo step.
//
// A row here is a row of the SONG, so deleting one pulls the whole song below it
// UP THROUGH THE CUE GRID: the cue boundaries stay where they are and the music
// slides past them. Cue 4's first rows move into cue 3's tail, cue 5's into
// cue 4's, all the way down, and the song loses its last rows. That is what
// makes this expensive — every pattern from the cut to the end of the song ends
// up holding a different stretch of music, and each one has to be rebuilt.
//
// The rebuild is an OUTLINE, one entry per output cue:
//   { inherit, limit, rows }
//   rows === null → the cue plays exactly what `inherit` played (or nothing at
//                   all, when inherit is null): its cue word is copied and NO
//                   pattern is touched. Every cue above the cut is one of these.
//   rows !== null → the cue's content is rebuilt from those ABSOLUTE rows of the
//                   original song (-1 = a blank row an insert made).
//
// Patterns are then allocated per (output cue, channel) by the SEQUENCE of
// (pattern, row) pairs that slot resolves to. Slots resolving to the same
// sequence were drawing from the same source at the same alignment, so they were
// already sharing before the edit and go on sharing one pattern after it.
// Numbers are RECYCLED: a pattern only the rebuilt cues referenced is dead the
// moment they are rebuilt, so it is written over rather than left behind, and a
// shift costs roughly as many patterns as it frees instead of one per slot.
//
// Two alignments avoid the shift altogether, because they are exactly equivalent
// to plain cue-list surgery — deleting a whole number of cues is splicing them
// out, and inserting rows AT a cue boundary is inserting a blank cue. Those
// leave every pattern and all of their sharing untouched, which is also what the
// menu's "Patterns above/below" does on purpose.
//
// planSplitCue and planCutCue are the odd ones out: they move a cue BOUNDARY
// without moving any music, so the song reads exactly the same top to bottom and
// every row keeps the absolute position it had. They differ in what the grid
// BELOW the new boundary does.
//   SPLIT gives the cut cue's tail a cue of its own, exactly as long as the tail
//     is, and stops. The cue after it is the next one along, untouched: nothing
//     below the split is rebuilt at all.
//   CUT hands the same tail a full-length cue — the cut cue's own original
//     length — and re-lays the whole song below it onto the lengths that were
//     already there. Every cue from the cut down then holds a different stretch
//     of music (its events pulled up, its end topped up from the cue after it)
//     and has to be rebuilt, and the song's LAST cue comes out shorter by
//     exactly what the head kept. Same music, same total rows, new bar lines.
// Both build the head the same way: its outline entry carries one extra flag,
// `noEnd`, which hands the cue's HALT and flow instruction down to the cue below
// — that is where the cue's end now is.
//
// Cue instruction words follow: the row limit tracks the cue's new length,
// absolute jumps (JMP) are remapped through the old→new cue map and the relative
// pair (BAK/FWD) re-measured against it, so flow still points at the same music
// after cues have been added or removed.

import {
  TaudPlayData, INST_HALT, INST_HALTAT, INST_PATLEN,
  INST_GOBACK, INST_SKIP, INST_JUMP,
} from "../engine/state.js";
import { CUE_EMPTY, MAX_VOICES, NUM_CUES } from "../format/taud-const.js";
import { cueInfo } from "./document.js";
import { cueInstructionWords } from "../format/taud-parse.js";
import { emptyPatternBytes, cellStride } from "./patterntools.js";

const PAT_MASK = 0x7fff;
/** Rows in a pattern — the hard ceiling on any cue's length. */
export const PATTERN_ROWS = 64;

// ── instruction word encoders (the decoders are engine/state.js) ──
const encLen = (rows) => 0x0200 | ((rows - 1) & 0x3f);
// "halt at x", where x = 0 spells the full 64 rows.
const encHaltAt = (rows) => 0x0140 | (rows & 0x3f);
const FLOW_TOP = { [INST_GOBACK]: 0x8000, [INST_SKIP]: 0x9000, [INST_JUMP]: 0xf000 };
const encFlow = (type, arg) => FLOW_TOP[type] | (arg & 0xfff);

const clampInt = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** One pattern cell, copied through the layout the document is in (§5.5). */
function cloneCell(src, wide) {
  const cell = new TaudPlayData();
  const n = cellStride(wide);
  for (let b = 0; b < n; b++) {
    if (wide) cell.setByteWide(b, src.getByteWide(b));
    else cell.setByte(b, src.getByte(b));
  }
  return cell;
}

/** A blank cell — read off the converter's empty-pattern image so "empty" keeps
 *  meaning the same thing here as it does everywhere else (patterntools.js). */
function blankCell(wide) {
  const bytes = emptyPatternBytes(wide);
  const cell = new TaudPlayData();
  const n = cellStride(wide);
  for (let b = 0; b < n; b++) {
    if (wide) cell.setByteWide(b, bytes[b]);
    else cell.setByte(b, bytes[b]);
  }
  return cell;
}

/** [from, to) as an array. */
function range(from, to) {
  const out = [];
  for (let i = from; i < to; i++) out.push(i);
  return out;
}

/** An unchanged cue. `start` is the absolute row it began at in the ORIGINAL
 *  song, which is what "these are still its own rows" is measured against. */
const keepCue = (e) => ({
  inherit: e.cue, limit: e.rowLimit, srcLimit: e.rowLimit, start: e.startRow, rows: null,
});

/**
 * A blank cue of `limit` rows. It always spells its length out, even at the full
 * 64: a cue whose words are ALL empty is not "used" at all (Song.lastUsedCue),
 * so one appended at the end of a song without an instruction in it would add no
 * rows to the song and simply vanish.
 */
const blankCue = (limit) => ({ inherit: null, limit, srcLimit: 0, start: -1, rows: null });

/** Blank cues totalling `count` rows — one cue can only hold 64. */
function blankCues(count) {
  const out = [];
  for (let left = count; left > 0; left -= PATTERN_ROWS) {
    out.push(blankCue(Math.min(PATTERN_ROWS, left)));
  }
  return out;
}

/**
 * The song's cues split into the part the Timeline addresses (0..lastUsedCue,
 * the rows) and whatever is stored past it. The tail is inert — every word of it
 * is empty — but it is kept so an edit doesn't quietly shorten the cue list, and
 * anything new has to go BEFORE it or it would be off the end of the song.
 */
function baseOutline(song) {
  const map = song.songMap();
  const head = map.entries.map(keepCue);
  const tail = [];
  for (let c = map.entries.length; c < song.cues.length; c++) {
    const lim = cueInfo(song.cues[c]).rowLimit;
    tail.push({ inherit: c, limit: lim, srcLimit: lim, rows: null });
  }
  return { head, tail, map };
}

/**
 * Delete absolute song rows `row0..row1` (inclusive). Everything below them
 * moves UP through the cue grid — cue lengths stay as they are and the music
 * slides past them — so the song ends `n` rows earlier than it did.
 */
export function planDeleteRows(song, row0, row1, opts = {}) {
  const { head, tail, map } = baseOutline(song);
  const r0 = Math.max(0, Math.min(row0, row1));
  const r1 = Math.min(map.totalRows - 1, Math.max(row0, row1));
  if (r1 < r0 || map.totalRows === 0) return null;

  // Whole cues: splicing them out of the order list reads exactly the same and
  // leaves every pattern (and all of its sharing) alone.
  const from = map.entries.findIndex((e) => e.startRow === r0);
  const to = r1 + 1 === map.totalRows
    ? map.entries.length
    : map.entries.findIndex((e) => e.startRow === r1 + 1);
  if (from >= 0 && to > from) {
    const kept = [...head.slice(0, from), ...head.slice(to)];
    if (kept.length === 0) kept.push(blankCue(PATTERN_ROWS));
    return planRowOutline(song, [...kept, ...tail], opts);
  }

  const srcRows = [];
  for (let r = 0; r < map.totalRows; r++) if (r < r0 || r > r1) srcRows.push(r);
  return planRowOutline(song, [...layOntoCues(head, srcRows), ...tail], opts);
}

/**
 * Insert `count` blank rows so they start at absolute row `at`. Everything from
 * there down moves DOWN through the cue grid and the song ends that much later.
 * `at === totalRows` appends to the end.
 */
export function planInsertRows(song, at, count, opts = {}) {
  const n = Math.max(1, count | 0);
  const { head, tail, map } = baseOutline(song);
  const row = clampInt(at, 0, map.totalRows);

  // At a cue boundary the shift is exactly a blank cue in the order list — the
  // music below starts `n` rows later either way — so take the cheap one.
  const boundary = row === map.totalRows
    ? head.length
    : map.entries.findIndex((e) => e.startRow === row);
  if (boundary >= 0) {
    const grown = [...head.slice(0, boundary), ...blankCues(n), ...head.slice(boundary)];
    return planRowOutline(song, [...grown, ...tail], opts);
  }

  const srcRows = [...range(0, row), ...new Array(n).fill(-1), ...range(row, map.totalRows)];
  return planRowOutline(song, [...layOntoCues(head, srcRows), ...tail], opts);
}

/**
 * Insert an empty cue — a whole blank row of patterns — before or after the cue
 * that holds absolute row `atRow`, as long as the cue it is put beside. Pure
 * order-list surgery: it moves nothing through the patterns, which is the point
 * of having it next to the row commands.
 */
export function planInsertCue(song, atRow, before = true, opts = {}) {
  const { head, tail, map } = baseOutline(song);
  if (head.length === 0) return null;
  const row = clampInt(atRow, 0, Math.max(0, map.totalRows - 1));
  let i = map.entries.findIndex((e) => row >= e.startRow && row < e.startRow + e.rowLimit);
  if (i < 0) i = head.length - 1;
  const at = before ? i : i + 1;
  const grown = [...head.slice(0, at), blankCue(head[i].limit), ...head.slice(at)];
  return planRowOutline(song, [...grown, ...tail], opts);
}

/**
 * Where a split at absolute song row `row` would fall: the cue holding it, its
 * index in the song map, and how far into that cue the row lands. Null when
 * there is nothing to split — the row is off the end of the song, or it IS a cue
 * boundary, where the split this would make is the one already there.
 */
export function splitPointAt(song, row) {
  const map = song.songMap();
  const index = map.entries.findIndex(
    (e) => row >= e.startRow && row < e.startRow + e.rowLimit);
  if (index < 0) return null;
  const entry = map.entries[index];
  const local = row - entry.startRow;
  return local > 0 ? { index, entry, local } : null;
}

/**
 * Split the cue holding absolute row `row` in two THERE: it keeps the rows above
 * the split, and a new cue below it holds the rest. The song is not moved — it
 * reads exactly the same top to bottom, every row at the absolute position it
 * was already at — so this is the one command here that changes where the cue
 * boundaries are instead of what plays through them.
 *
 * The head keeps the cue's own patterns, sharing and all: its music is already
 * at the top of them and a shorter cue just stops reading earlier, so nothing
 * another cue still plays whole is touched. Only the TAIL needs patterns of its
 * own — its rows have to start at row 0 of one — and that is the untangling:
 * channels whose tails read the same rows out of the same pattern go on sharing
 * one copy, and a pattern the head (or anybody else) still plays is never
 * written over.
 *
 * What happens at the END of a cue goes with the tail, which is where that end
 * now is: its HALT and its flow instruction move down, and the head is left
 * carrying nothing but its new length.
 */
export function planSplitCue(song, row, opts = {}) {
  const at = splitPointAt(song, row);
  if (!at) return null;
  const { head, tail } = baseOutline(song);
  const { index, entry, local } = at;
  const first = { ...head[index], limit: local, rows: null, noEnd: true };
  const second = {
    inherit: entry.cue,
    limit: entry.rowLimit - local,
    srcLimit: entry.rowLimit,
    start: entry.startRow + local,
    rows: range(entry.startRow + local, entry.startRow + entry.rowLimit),
  };
  return planRowOutline(song,
    [...head.slice(0, index), first, second, ...head.slice(index + 1), ...tail], opts);
}

/**
 * Cut the cue holding absolute row `row` there, and RE-BAR everything below it:
 * the cue keeps the rows above the cut, the rows below them start a cue of the
 * cut cue's own full length, and the rest of the song is laid back onto the cue
 * lengths that were already there — so a $40-row cue cut at row $20 leaves a cue
 * of $20 followed by a full $40, not the $20 + $20 a split would leave.
 *
 * No music moves and none is lost: the song reads exactly the same top to bottom
 * and is exactly as long as it was. What moves is the GRID, and because it moves
 * under every cue below the cut, every one of them ends up holding a different
 * stretch of music — its events pulled up by the size of the head, its own end
 * topped up out of the cue after it — and each is rebuilt. The song's last cue
 * absorbs the difference and comes out that much shorter.
 *
 * That is the whole difference from planSplitCue, which stops at the tail and
 * touches nothing below it. This one is the expensive half of the pair, and the
 * one to reach for when the music turns out to be written a few rows out of step
 * with the bar lines: it re-bars the song from here on instead of adding a short
 * cue and leaving the step in.
 */
export function planCutCue(song, row, opts = {}) {
  const at = splitPointAt(song, row);
  if (!at) return null;
  const { head, tail, map } = baseOutline(song);
  const { index, entry, local } = at;
  const first = { ...head[index], limit: local, rows: null, noEnd: true };
  // The cue lengths from the cut cue down, re-used in order for the rows that
  // are left. There are exactly `local` fewer rows than slots to hold them, so
  // nothing spills — the shortfall lands in the last cue.
  const below = layOntoCues(head.slice(index), range(entry.startRow + local, map.totalRows));
  return planRowOutline(song, [...head.slice(0, index), first, ...below, ...tail], opts);
}

/**
 * Lay a new row sequence back onto the cue grid: each cue keeps its length and
 * takes the next slice of `srcRows`. A cue whose rows are still exactly its own
 * comes out unchanged (a delete at the very end only shortens the last cue's
 * LEN); a cue the sequence runs out inside is the song's new last cue and the
 * ones after it are gone; anything left over at the bottom lengthens the last
 * cue as far as a pattern allows and then becomes fresh cues.
 */
function layOntoCues(head, srcRows) {
  const out = [];
  let p = 0;
  for (const e of head) {
    if (p >= srcRows.length) break; // the song ended above this cue
    const take = Math.min(e.limit, srcRows.length - p);
    const rows = srcRows.slice(p, p + take);
    p += take;
    // "Unchanged" is about the ROWS, not the length: a cue still playing its own
    // rows from the top needs no pattern work even if it now stops earlier,
    // which is what makes a delete at the end of the song only a LEN edit.
    const own = rows.every((r, j) => r === e.start + j);
    out.push({ ...e, limit: take, rows: own ? null : rows });
  }
  if (p < srcRows.length && out.length > 0) {
    const last = out[out.length - 1];
    if (last.limit < PATTERN_ROWS) {
      const take = Math.min(PATTERN_ROWS - last.limit, srcRows.length - p);
      const base = last.rows ?? range(last.start, last.start + last.limit);
      last.rows = [...base, ...srcRows.slice(p, p + take)];
      last.limit += take;
      p += take;
    }
  }
  while (p < srcRows.length) {
    const take = Math.min(PATTERN_ROWS, srcRows.length - p);
    out.push({ inherit: null, srcLimit: 0, start: -1, limit: take,
      rows: srcRows.slice(p, p + take) });
    p += take;
  }
  if (out.length === 0) out.push(blankCue(PATTERN_ROWS));
  return out;
}

/**
 * Turn an outline into `{patterns, cues, pNam, changed}` for remapPatternsOp,
 * or null when it cannot be done (more cues than the format addresses, or the
 * pattern number space exhausted). Pure — `song` is not touched.
 */
export function planRowOutline(song, outline, {
  wide = false, patternNames = [], maxCues = NUM_CUES,
} = {}) {
  if (outline.length === 0 || outline.length > maxCues) return null;
  const oldCount = song.cues.length;
  const map = song.songMap();

  // Which output cue each source cue became. A cue the edit removed maps to
  // whatever now stands in its place, so a jump aimed at it lands on the music
  // that follows rather than on a stale index.
  const firstOf = new Map();
  outline.forEach((o, i) => {
    if (o.inherit !== null && !firstOf.has(o.inherit)) firstOf.set(o.inherit, i);
  });
  const newOf = new Array(oldCount + 1);
  let nextNew = outline.length;
  for (let c = oldCount; c >= 0; c--) {
    if (firstOf.has(c)) nextNew = firstOf.get(c);
    newOf[c] = nextNew;
  }

  // Absolute original row → the cue entry playing it.
  const rowOwner = new Array(map.totalRows);
  for (const e of map.entries) {
    for (let r = 0; r < e.rowLimit; r++) rowOwner[e.startRow + r] = e;
  }
  /** What channel `ch` plays at absolute original row `abs`: the pattern it sits
   *  in and the row within it, or null when nothing is there. */
  const cellRef = (abs, ch) => {
    if (abs < 0) return null;
    const e = rowOwner[abs];
    if (!e) return null;
    const pat = song.cues[e.cue][ch] & PAT_MASK;
    return pat === PAT_MASK ? null : { pat, row: abs - e.startRow };
  };
  const keyOf = (refs) => refs.map((r) => (r ? `${r.pat}:${r.row}` : "-")).join(",");

  // ── which patterns are still spoken for, and which are now free ──
  // A pattern an UNCHANGED cue plays has to keep its content. One that only the
  // rebuilt cues referenced is dead as soon as they are rebuilt, so its number
  // can be written over — that is what stops a shift allocating a pattern per
  // slot. Patterns nothing references at all are left alone: they are somebody's
  // scratch space, not ours to take.
  const kept = new Set();
  const recyclable = new Set();
  for (const o of outline) {
    if (o.inherit === null) continue;
    const words = song.cues[o.inherit];
    if (!words) continue;
    const into = o.rows === null ? kept : recyclable;
    for (let ch = 0; ch < MAX_VOICES; ch++) {
      const p = words[ch] & PAT_MASK;
      if (p !== PAT_MASK && song.patterns[p]) into.add(p);
    }
  }
  for (const p of kept) recyclable.delete(p);

  // ── the distinct sequences the rebuilt cues need, in play order ──
  const seqs = new Map();               // key → refs
  const order = [];                     // keys, first-seen order
  const slotKeys = outline.map(() => new Map()); // output cue → ch → key
  outline.forEach((o, i) => {
    if (o.rows === null) return;
    for (let ch = 0; ch < MAX_VOICES; ch++) {
      const refs = o.rows.map((abs) => cellRef(abs, ch));
      if (refs.every((r) => r === null)) continue; // this channel plays nothing here
      const key = keyOf(refs);
      if (!seqs.has(key)) { seqs.set(key, refs); order.push(key); }
      slotKeys[i].set(ch, key);
    }
  });

  // ── numbers for them ──
  const alloc = new Map();
  const claimed = new Set();
  for (const key of order) {
    // Prefer a free number the sequence itself reads from: the music mostly
    // stays in the pattern it was already in, so the numbering stays readable.
    for (const r of seqs.get(key)) {
      if (r && recyclable.has(r.pat) && !claimed.has(r.pat)) {
        claimed.add(r.pat);
        alloc.set(key, r.pat);
        break;
      }
    }
  }
  const spare = [...recyclable].filter((p) => !claimed.has(p)).sort((a, b) => a - b);
  const unassigned = order.filter((k) => !alloc.has(k));
  const fresh = song.freePatternNumbers(Math.max(0, unassigned.length - spare.length));
  if (spare.length + fresh.length < unassigned.length) return null; // no numbers left
  unassigned.forEach((key, i) => {
    const n = i < spare.length ? spare[i] : fresh[i - spare.length];
    claimed.add(n);
    alloc.set(key, n);
  });

  // ── build them ──
  const patterns = song.patterns.slice();
  const names = patternNames.slice();
  const blank = blankCell(wide);
  for (const [key, idx] of alloc) {
    const refs = seqs.get(key);
    const built = new Array(PATTERN_ROWS);
    for (let r = 0; r < PATTERN_ROWS; r++) {
      // Sources come off the ORIGINAL arrays, which nothing here mutates, so a
      // recycled number can be written before another sequence reads from it.
      const ref = r < refs.length ? refs[r] : null;
      const cell = ref ? song.patterns[ref.pat]?.[ref.row] : null;
      built[r] = cloneCell(cell ?? blank, wide);
    }
    for (let i = patterns.length; i < idx; i++) patterns[i] = null; // item 48 gaps
    patterns[idx] = built;
    const from = refs.find((r) => r !== null)?.pat;
    if (from !== undefined && from !== idx) {
      // The music mostly came from one pattern; the copy carries its name.
      while (names.length < idx) names.push("");
      names[idx] = patternNames[from] ?? "";
    }
  }
  // Anything recyclable nobody claimed is now unreferenced with stale content:
  // drop it rather than leave it in the file.
  for (const p of recyclable) if (!claimed.has(p)) patterns[p] = null;
  while (patterns.length && !patterns[patterns.length - 1]) patterns.pop();
  while (names.length && names[names.length - 1] === "") names.pop();

  // ── the cue list ──
  const cues = outline.map((o, i) => {
    const words = new Uint16Array(MAX_VOICES).fill(CUE_EMPTY);
    let w0 = 0, w1 = 0;
    if (o.rows === null && o.inherit !== null) {
      const src = song.cues[o.inherit];
      for (let ch = 0; ch < MAX_VOICES; ch++) words[ch] = src[ch] & PAT_MASK;
    } else if (o.rows !== null) {
      for (const [ch, key] of slotKeys[i]) words[ch] = alloc.get(key) & PAT_MASK;
    }
    if (o.inherit !== null && song.cues[o.inherit]) {
      [w0, w1] = rewriteInstructions(song, o, i, newOf);
    } else {
      w0 = encLen(o.limit); // a cue this made: it has to say how long it is
    }
    // The two instruction words live in the sign bits of channels 0-15 / 16-31.
    for (let ch = 0; ch < 16; ch++) {
      if ((w0 >> ch) & 1) words[ch] |= 0x8000;
      if ((w1 >> ch) & 1) words[16 + ch] |= 0x8000;
    }
    return words;
  });

  const changed = alloc.size > 0 || cues.length !== oldCount ||
    cues.some((w, i) => w.some((v, ch) => v !== song.cues[i][ch]));
  return { patterns, cues, pNam: names, changed };
}

/**
 * One output cue's two instruction words. The row limit follows the cue's own
 * new length; HALT and the flow instruction stay with it, since a cue keeps its
 * place in the order list even when the music running through it has moved.
 */
function rewriteInstructions(song, o, newIdx, newOf) {
  // The HEAD of a split cue is not where that cue ends any more, so everything
  // that happens at a cue's end — its HALT, its flow instruction — belongs to
  // the half below it and this one says only how long it is.
  if (o.noEnd) return [encLen(o.limit), 0];
  const info = cueInfo(song.cues[o.inherit]);
  const src = cueInstructionWords(song.cues[o.inherit]);
  // A cue whose length is unchanged keeps its words byte-for-byte — the rebuild
  // below is faithful but not literal (it would spell a plain HALT beside a LEN
  // as one HALT@), and a cue that only changed CONTENT has no business
  // rewriting its instructions. The one thing that can move under it is a jump,
  // when the cue list it counts in changed.
  if (o.limit === o.srcLimit) {
    const flow = info.flow;
    if (!flow || retarget(flow, o.inherit, newIdx, newOf) === flow.arg) return src;
  }
  const out = [0, 0];
  let hasLimit = false;
  for (let k = 0; k < 2; k++) {
    const inst = k === 0 ? info.inst0 : info.inst1;
    switch (inst.type) {
      case INST_PATLEN:
        out[k] = encLen(o.limit);
        hasLimit = true;
        break;
      case INST_HALTAT:
        // "halt at x" IS the row limit, so the two move together.
        out[k] = encHaltAt(o.limit);
        hasLimit = true;
        break;
      case INST_HALT:
        if (o.limit === PATTERN_ROWS) out[k] = src[k];
        else { out[k] = encHaltAt(o.limit); hasLimit = true; }
        break;
      case INST_GOBACK: case INST_SKIP: case INST_JUMP:
        out[k] = encFlow(inst.type, retarget(inst, o.inherit, newIdx, newOf));
        break;
      default: break; // NOP
    }
  }
  if (!hasLimit && o.limit !== PATTERN_ROWS) {
    // Nothing carried the length yet. Prefer a free word; with both taken (two
    // flow instructions — legal, if meaningless) the length wins, because it
    // decides what actually plays.
    out[out[0] === 0 ? 0 : 1] = encLen(o.limit);
  }
  return out;
}

/** A flow instruction's argument after the cue list moved under it: JMP is an
 *  absolute index, BAK/FWD are distances, so all three are re-derived from where
 *  their TARGET ended up. */
function retarget(inst, srcCue, newIdx, newOf) {
  const at = (c) => newOf[clampInt(c, 0, newOf.length - 1)];
  switch (inst.type) {
    case INST_JUMP: return clampInt(at(inst.arg), 0, 0xfff);
    case INST_GOBACK: return clampInt(newIdx - at(srcCue - inst.arg), 0, 0xfff);
    case INST_SKIP: return clampInt(at(srcCue + inst.arg) - newIdx, 0, 0xfff);
    default: return inst.arg;
  }
}
