// Find (item 177) — where in the project a predicate is TRUE.
//
// The predicate is patternquery.js's, unchanged: the same terms, the same
// operators, the same parsing, so "find every C-4 on instrument $03" and
// "change every C-4 on instrument $03" are one vocabulary asked two ways. What
// is new here is only the WALK — a query is a set, and a search is an ordered
// list you can step through — and the two orders a tracker actually thinks in:
//
//   SONG      play order: every cue in turn, every row of it, every lane
//             that has a pattern. This is the Timeline's own coordinate system,
//             so a hit is a place the cursor can simply go.
//   PATTERNS  the pattern bank: every materialised pattern, ascending, row by
//             row. A pattern no cue plays is still somewhere you can be
//             editing, and the song walk would never reach it.
//
// One pattern is usually placed in many cues (that is what cues are for), so
// the song walk evaluates each pattern's 64 rows ONCE and reuses the answer
// wherever the pattern is placed. Without that, a long song re-evaluates the
// same eight cells a hundred times over.
//
// The `row` a term can test is the row WITHIN the pattern, exactly as it is in
// Find & Change — "every fourth row" means the same thing in both, and the
// song's absolute row is a position on screen rather than something the music
// knows about.
//
// Pure: no DOM, no i18n. The bar over it is ui/findbar.js.

import { evalPredicate } from "./patternquery.js";
import { cellToBytes } from "./clipboard.js";

const PAT_MASK = 0x7fff;
const PATTERN_EMPTY = 0x7fff;
const PATTERN_ROWS = 64;

/** Which rows of one pattern match, as a 64-entry Uint8Array of 0/1. */
function rowHits(doc, songIndex, pat, predicate, wide) {
  const rows = doc.patternAt(songIndex, pat) ?? doc.emptyPattern();
  const hits = new Uint8Array(PATTERN_ROWS);
  for (let r = 0; r < PATTERN_ROWS; r++) {
    const cell = rows[r];
    if (!cell) continue;
    if (evalPredicate(cellToBytes(cell, wide), wide, predicate, { row: r })) hits[r] = 1;
  }
  return hits;
}

/** Memoised rowHits over one search. */
function hitCache(doc, songIndex, predicate, wide) {
  const cache = new Map();
  return (pat) => {
    let hits = cache.get(pat);
    if (hits === undefined) {
      hits = rowHits(doc, songIndex, pat, predicate, wide);
      cache.set(pat, hits);
    }
    return hits;
  };
}

/**
 * Every match in PLAY ORDER: [{row, ch, cue, pat, patRow}], where `row` is the
 * absolute song row the Timeline's cursor uses and `patRow` the row inside the
 * pattern. Sorted by row, then by lane — reading order on the grid.
 *
 * An empty cue slot holds no pattern and is skipped; a cue shortened by a LEN
 * or HALT instruction contributes only the rows it plays, because the rows past
 * its limit are not part of the song (songMap's `rowLimit`).
 */
export function songMatches(doc, songIndex, predicate) {
  const song = doc?.songs?.[songIndex];
  if (!song) return [];
  const wide = doc.wideCells === true;
  const hitsFor = hitCache(doc, songIndex, predicate, wide);
  const chans = doc.channelCount;
  const out = [];
  for (const e of song.songMap().entries) {
    const words = song.cues[e.cue];
    if (!words) continue;
    for (let ch = 0; ch < chans; ch++) {
      const pat = words[ch] & PAT_MASK;
      if (pat === PATTERN_EMPTY) continue;
      const hits = hitsFor(pat);
      const limit = Math.min(e.rowLimit, PATTERN_ROWS);
      for (let r = 0; r < limit; r++) {
        if (hits[r]) out.push({ row: e.startRow + r, ch, cue: e.cue, pat, patRow: r });
      }
    }
  }
  out.sort((a, b) => a.row - b.row || a.ch - b.ch);
  return out;
}

/**
 * Every match in the PATTERN BANK: [{pat, row}], ascending by pattern then row.
 * Only materialised patterns are walked — an arbitrary-number pattern that has
 * never been edited (item 48) holds nothing to find.
 */
export function patternMatches(doc, songIndex, predicate) {
  const song = doc?.songs?.[songIndex];
  if (!song) return [];
  const wide = doc.wideCells === true;
  const out = [];
  for (let pat = 0; pat < song.patterns.length; pat++) {
    if (!song.patterns[pat]) continue;
    const hits = rowHits(doc, songIndex, pat, predicate, wide);
    for (let r = 0; r < PATTERN_ROWS; r++) if (hits[r]) out.push({ pat, row: r });
  }
  return out;
}

/**
 * Step through a sorted match list from where the cursor is.
 *
 * `cmp(match)` orders a match against the cursor: negative before it, 0 ON it,
 * positive after. Forward lands on the first match strictly after the cursor,
 * backward on the last strictly before it — a match the cursor is already
 * sitting on is passed over, which is what makes pressing Next twice move
 * twice.
 *
 * Both directions WRAP, and the wrap is the point: a search that stopped at the
 * end of the song would make "is there another one" a question about where you
 * happened to start. Returns -1 only for an empty list.
 */
export function stepMatch(list, cmp, dir) {
  if (list.length === 0) return -1;
  if (dir >= 0) {
    for (let i = 0; i < list.length; i++) if (cmp(list[i]) > 0) return i;
    return 0;
  }
  for (let i = list.length - 1; i >= 0; i--) if (cmp(list[i]) < 0) return i;
  return list.length - 1;
}

/** Order a song match against a (row, ch) cursor. */
export function songCursorCmp(row, ch) {
  return (m) => (m.row - row) || (m.ch - ch);
}

/** Order a pattern-bank match against a (pat, row) cursor. */
export function patternCursorCmp(pat, row) {
  return (m) => (m.pat - pat) || (m.row - row);
}

/** Where the cursor is in a match list, or -1 when it is not on a match. */
export function indexAt(list, cmp) {
  return list.findIndex((m) => cmp(m) === 0);
}
