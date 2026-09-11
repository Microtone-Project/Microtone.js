// The row trough's right-click menu (item 136) — the Timeline's left-hand
// gutter, where the numbers are.
//
// A cell in the grid belongs to one channel; a row in the trough belongs to the
// whole SONG, so the actions here are the ones that move every channel at once:
// Excel's insert-rows-above/below and delete-rows, plus the row highlighting
// those numbers are read against. Only the Timeline has a trough — the Cues
// view's gutter counts cues, not rows — so unlike gridmenu.js this vocabulary
// has one caller; it lives here rather than in the view for the same reason
// blocktools.js does, to keep the item specs and their dialogs out of the
// canvas code.
//
// The document work is doc/songrows.js, applied through remapPatternsOp: one
// undo step for an edit that can rewrite the whole order list.

import { ICON } from "./icons.js";
import { t } from "./i18n.js";
import { showModal } from "./widgets/modal.js";
import {
  planInsertRows, planDeleteRows, planInsertCue, planSplitCue, planCutCue,
  splitPointAt,
} from "../doc/songrows.js";
import { remapPatternsOp } from "../doc/ops.js";
import { encodeNameTable } from "../doc/cleanup.js";
import { NUM_CUES, NUM_CUES_64 } from "../format/taud-const.js";

/**
 * The trough menu's first row: what can be done to the rows themselves.
 * `rows` is how many the click covers — the selected band, or the one row under
 * the pointer — and every label says so, because "Delete 16 rows" and "Delete
 * row" are very different offers to accept blind.
 */
export function rowBandItems(rows) {
  return [
    { id: "rowsAbove", label: t("ctx.rowsAbove"), icon: ICON.rowsAbove,
      title: t("ctx.rowsAboveTitle", { n: rows }) },
    { id: "rowsBelow", label: t("ctx.rowsBelow"), icon: ICON.rowsBelow,
      title: t("ctx.rowsBelowTitle", { n: rows }) },
    { id: "rowsDelete", label: t("ctx.rowsDelete"), icon: ICON.rowsDelete,
      title: t("ctx.rowsDeleteTitle", { n: rows }) },
  ];
}

/**
 * The second row: the CUE GRID itself. Two of them put a whole empty pattern row
 * — a blank cue — above or below the cue the click landed in; the other two put
 * a new cue boundary INSIDE it, at the clicked row.
 *
 * The row commands above shift the music through a fixed cue grid, which rewrites
 * every pattern below the edit. These four move the GRID instead and leave the
 * music exactly where it is: the song plays the same afterwards, whichever you
 * pick. Split and Cut differ only in what the grid below the new boundary does —
 * Split leaves it alone and costs a pattern or two, Cut re-bars the whole song
 * from there and rebuilds every pattern below it.
 *
 * `canSplit` is false on a row that already IS a cue boundary — there the
 * boundary they would add is the one that is there — so both cells are offered
 * greyed rather than silently doing nothing.
 */
export function cueItems(canSplit = true) {
  return [
    { id: "patsAbove", label: t("ctx.patsAbove"), icon: ICON.patsAbove,
      title: t("ctx.patsAboveTitle") },
    { id: "patsBelow", label: t("ctx.patsBelow"), icon: ICON.patsBelow,
      title: t("ctx.patsBelowTitle") },
    { id: "patsSplit", label: t("ctx.patsSplit"), icon: ICON.patsSplit,
      title: t("ctx.patsSplitTitle"), disabled: !canSplit },
    { id: "patsCut", label: t("ctx.patsCut"), icon: ICON.patsCut,
      title: t("ctx.patsCutTitle"), disabled: !canSplit },
  ];
}

/** Whether "Split here" / "Cut here" have anything to do at absolute song row
 *  `row` — the view asks before it builds the menu. */
export function canSplitAt(song, row) {
  return !!song && splitPointAt(song, row) !== null;
}

/** …and its third: the beat/bar divisions (item 136.1). The Project tab has the
 *  same two numbers — this is the one that is where you are looking when you
 *  notice the banding is wrong. */
export function beatItems() {
  return [{ id: "beats", label: t("ctx.beats"), icon: ICON.beats, title: t("ctx.beatsTitle") }];
}

const ROW_TOOLS = ["rowsAbove", "rowsBelow", "rowsDelete",
  "patsAbove", "patsBelow", "patsSplit", "patsCut", "beats"];

/** True when `id` came from one of the three rows above. */
export function isRowTool(id) { return ROW_TOOLS.includes(id); }

/**
 * Run one of them. `ctx` is `{ store, row0, row1 }` — the absolute song rows the
 * click covers, inclusive. Resolves true when the document changed.
 */
export async function runRowTool(id, ctx) {
  switch (id) {
    case "rowsAbove": return insertRows(ctx, ctx.row0);
    case "rowsBelow": return insertRows(ctx, ctx.row1 + 1);
    case "rowsDelete": return deleteRows(ctx);
    case "patsAbove": return insertCue(ctx, ctx.row0, true);
    case "patsBelow": return insertCue(ctx, ctx.row1, false);
    case "patsSplit": return splitCue(ctx);
    case "patsCut": return cutCue(ctx);
    case "beats": return beatsDialog(ctx.store);
  }
  return false;
}

/** How many cues this document can address — the ceiling a big insert hits. */
function cueCeiling(store) {
  return store.doc.is64Channel ? NUM_CUES_64 : NUM_CUES;
}

const planOpts = (store) => ({
  wide: store.doc.wideCells === true,
  patternNames: store.doc._nameTable("pNam"),
  maxCues: cueCeiling(store),
});

/** Apply a plan as one undo step. `null` means the planner refused; `changed:
 *  false` means it would have been a no-op. */
function applyPlan(store, plan, failKey) {
  if (!plan) { alert(t(failKey)); return false; }
  if (!plan.changed) return false;
  store.undo.apply(remapPatternsOp(
    store.songIndex, plan.patterns, plan.cues, encodeNameTable(plan.pNam)));
  return true;
}

/**
 * Insert blank rows starting at absolute row `at`. The count defaults to the
 * size of the band that was clicked, which is Excel's rule: select four rows,
 * ask for an insert, get four.
 */
async function insertRows(ctx, at) {
  const { store, row0, row1 } = ctx;
  const suggested = row1 - row0 + 1;
  const result = await showModal({
    title: t("rows.insertTitle"),
    body: t("rows.insertBody"),
    fields: [{ name: "count", label: t("rows.count"), type: "number",
      value: suggested, min: 1, max: 1024 }],
    okLabel: t("rows.insertOk"),
  });
  if (!result) return false;
  const n = Math.min(1024, Math.max(1, parseInt(result.count || "0", 10) | 0));
  return applyPlan(store, planInsertRows(store.song, at, n, planOpts(store)), "rows.noRoom");
}

/**
 * Delete the clicked rows, everything below shifting up. Confirmed first when
 * it is more than a handful: it is undoable, but it can rewrite the order list
 * out from under a song, and "I meant to delete one row" is a click away from
 * "I had a hundred selected".
 */
function deleteRows(ctx) {
  const { store, row0, row1 } = ctx;
  const n = row1 - row0 + 1;
  if (n > 4 && !confirm(t("rows.deleteConfirm", { n }))) return false;
  return applyPlan(store, planDeleteRows(store.song, row0, row1, planOpts(store)), "rows.noRoom");
}

/**
 * Add an empty pattern row — a blank cue, as long as the cue it goes beside —
 * above or below the cue holding `row`. No dialog: there is one obvious answer
 * and it is instant and undoable, which is the whole appeal next to the row
 * commands.
 */
function insertCue(ctx, row, before) {
  const { store } = ctx;
  return applyPlan(store, planInsertCue(store.song, row, before, planOpts(store)), "rows.noRoom");
}

/**
 * Cut the cue at the top of the band in two: it keeps the rows above the split,
 * and the rest move to the top of a new cue below it. No dialog and no confirm —
 * nothing about the song moves, the boundary is all that changes, and a wrong
 * click is one Ctrl+Z away.
 */
function splitCue(ctx) {
  const { store, row0 } = ctx;
  if (!canSplitAt(store.song, row0)) return false; // the split is already there
  return applyPlan(store, planSplitCue(store.song, row0, planOpts(store)), "rows.noRoom");
}

/**
 * The same cut, then the song below re-barred through it: the new cue takes the
 * cut cue's own full length and every cue under it keeps the length it had, so
 * the music slides up through the grid and every pattern from here down is
 * rebuilt. Nothing is moved and nothing is lost — it is the expensive half of
 * the pair, and it is what you want when the music turns out to be written a few
 * rows out of step with the bar lines.
 */
function cutCue(ctx) {
  const { store, row0 } = ctx;
  if (!canSplitAt(store.song, row0)) return false; // the boundary is already there
  return applyPlan(store, planCutCue(store.song, row0, planOpts(store)), "rows.noRoom");
}

/**
 * The row-highlight divisions (item 136.1): how many rows to a beat, and how
 * many to a bar. They are the song's own sMet fields — 4 and 16 when the file
 * says nothing — and they only change how the grids are BANDED; nothing about
 * playback reads them.
 */
export async function beatsDialog(store) {
  const cur = store.beats();
  const result = await showModal({
    title: t("rows.beatsTitle"),
    body: t("rows.beatsBody"),
    fields: [
      { name: "pri", label: t("rows.beatPri"), type: "number", value: cur.pri, min: 1, max: 255 },
      { name: "sec", label: t("rows.beatSec"), type: "number", value: cur.sec, min: 1, max: 255 },
    ],
    okLabel: t("common.apply"),
  });
  if (!result) return false;
  return store.setBeats(parseInt(result.pri || "0", 10), parseInt(result.sec || "0", 10));
}
