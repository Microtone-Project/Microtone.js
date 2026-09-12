// Shared right-click menu vocabulary for the three grids (Timeline, Cues,
// Patterns). The three views hit-test differently and hold different cursors,
// but the ACTIONS are the same ones, and a menu that drifted between them
// would be worse than no menu — so the item specs and the document actions
// behind them live here rather than being written out three times.

import { ICON } from "./icons.js";
import { t } from "./i18n.js";
import {
  insertChannelOp, channelHasContent, setCuesOp, createPatternOp, compositeOp,
  deletePatternOp,
} from "../doc/ops.js";
import { CUE_EMPTY, MAX_VOICES } from "../format/taud-const.js";

// A cue word is `pattern (15 bits) | command bit`, and bit 15 belongs to the
// channel POSITION rather than to the pattern sitting in it (ops.js says why),
// so everything below rewrites the low 15 bits and leaves each position's own
// top bit where it was.
const PAT_MASK = 0x7fff;
const CMD_BIT = 0x8000;

/** Copy / Cut / Paste cells. `hasSelection` gates the first two, `canPaste` the
 *  third; `selAnchored` only picks the tooltip that tells the truth about where
 *  the paste will land. */
export function clipboardItems({ hasSelection, canPaste, selAnchored = false }) {
  const items = [];
  if (hasSelection) {
    items.push(
      { id: "copy", label: t("ctx.copy"), icon: ICON.copy, title: t("ctx.copyTitle") },
      { id: "cut", label: t("ctx.cut"), icon: ICON.cut, title: t("ctx.cutTitle") });
  }
  if (canPaste) {
    items.push({ id: "paste", label: t("ctx.paste"), icon: ICON.paste,
      title: t(selAnchored ? "ctx.pasteSelTitle" : "ctx.pasteTitle") });
  }
  return items;
}

/** The two channel inserts for channel `ch` of `chans`. */
export function channelItems(ch, chans) {
  return [
    { id: "insLeft", label: t("ctx.chanLeft"), icon: ICON.channelLeft,
      title: t("ctx.chanLeftTitle", { ch: ch + 1 }) },
    { id: "insRight", label: t("ctx.chanRight"), icon: ICON.channelRight,
      title: t("ctx.chanRightTitle", { ch: ch + 1 }), disabled: ch >= chans - 1 },
  ];
}

/** The cell an empty cue slot gets instead of Paste. */
export function newPatternItem() {
  return { id: "newPat", label: t("ctx.newPattern"), icon: ICON.patternNew,
    title: t("ctx.newPatternTitle") };
}

// ── item 103.1: what a FILLED slot can do ──
// The cells a slot holding a pattern gets on top of the channel inserts: move it
// sideways, unshare it, or take it out of the song. They act on the same
// `[{cue, ch}]` slot list the New-pattern cell does — the block's slots, or the
// one that was clicked — so a block of patterns walks sideways, copies or goes
// as a unit.

/** A slot's cue word. Rows past the stored cue list read as empty: the Cues
 *  view addresses the whole cue space, and writing one materialises it. */
function wordAt(song, cue, ch) {
  const words = song.cues[cue];
  return words ? words[ch] : CUE_EMPTY;
}

/** The slots in `slots` that actually hold a pattern — the only ones any of
 *  this moves or copies. */
function filledSlots(song, slots) {
  return slots.filter((s) => (wordAt(song, s.cue, s.ch) & PAT_MASK) !== CUE_EMPTY);
}

const slotKey = (cue, ch) => `${cue}:${ch}`;

/**
 * The patterns that would be left with NO user at all if every filled slot in
 * `slots` were emptied — "unique to the selection", the ones a delete takes the
 * content of as well as the reference to.
 *
 * Counting is per REFERENCE, not per pattern: a pattern three cues play and two
 * of them are selected still has a user afterwards, and a pattern the selection
 * names twice loses both at once. Only materialised patterns are returned —
 * an index referenced without ever having been written to (item 48) has nothing
 * to delete.
 */
export function orphanedPatterns(song, slots) {
  const going = new Map();
  for (const s of filledSlots(song, slots)) {
    const p = wordAt(song, s.cue, s.ch) & PAT_MASK;
    going.set(p, (going.get(p) ?? 0) + 1);
  }
  const users = new Map();
  for (const words of song.cues) {
    for (let ch = 0; ch < MAX_VOICES; ch++) {
      const p = words[ch] & PAT_MASK;
      if (going.has(p)) users.set(p, (users.get(p) ?? 0) + 1);
    }
  }
  return [...going.keys()]
    .filter((p) => song.patterns[p] && users.get(p) === going.get(p))
    .sort((a, b) => a - b);
}

/**
 * Can every filled slot shift one channel in `dir` (-1 left / +1 right)?
 *
 * A move must not overwrite anything, so each target has to be off the end of
 * nothing and empty — EXCEPT when the target is itself one of the slots being
 * moved, since the whole block shifts at once and that one is about to vacate.
 * That exception is what lets a solid block of channels slide sideways; without
 * it only the leading edge could ever move.
 */
export function canMoveSlots(song, slots, dir, chans) {
  const filled = filledSlots(song, slots);
  if (filled.length === 0) return false;
  const sources = new Set(filled.map((s) => slotKey(s.cue, s.ch)));
  for (const s of filled) {
    const to = s.ch + dir;
    if (to < 0 || to >= chans) return false;
    if (sources.has(slotKey(s.cue, to))) continue;
    if ((wordAt(song, s.cue, to) & PAT_MASK) !== CUE_EMPTY) return false;
  }
  return true;
}

/**
 * The cells a filled slot (or a block containing one) adds to the first row.
 * Move is offered only when it is possible — a blocked or off-the-end move is
 * not a state worth showing greyed out, it is simply not one of the things you
 * can do here. Delete always is: there is always a pattern here to take out,
 * which is what made the row worth offering in the first place.
 */
export function patternSlotItems(store, slots) {
  const song = store.song;
  const chans = store.doc.channelCount;
  const filled = filledSlots(song, slots);
  if (filled.length === 0) return [];
  const items = [];
  if (canMoveSlots(song, slots, -1, chans)) {
    items.push({ id: "movLeft", label: t("ctx.moveLeft"), icon: ICON.moveLeft,
      title: t("ctx.moveLeftTitle") });
  }
  if (canMoveSlots(song, slots, 1, chans)) {
    items.push({ id: "movRight", label: t("ctx.moveRight"), icon: ICON.moveRight,
      title: t("ctx.moveRightTitle") });
  }
  if (song.freePatternNumbers(1).length > 0) {
    items.push({ id: "dupPat", label: t("ctx.duplicate"), icon: ICON.duplicate,
      title: t(filled.length > 1 ? "ctx.duplicateBlockTitle" : "ctx.duplicateTitle") });
  }
  items.push({ id: "delPat", label: t("ctx.delPattern"), icon: ICON.patternDelete,
    title: t("ctx.delPatternTitle", { n: filled.length }) });
  return items;
}

const SLOT_ITEMS = ["movLeft", "movRight", "dupPat", "delPat"];

/** True when `id` is one of the filled-slot cells. */
export function isPatternSlotItem(id) { return SLOT_ITEMS.includes(id); }

/**
 * Shift every filled slot one channel along, in ONE undo step. Pure cue-word
 * writes: the pattern moves, the position's command bit stays. A source is
 * cleared unless another source is landing on it, which is what keeps the
 * interior of a solid block intact as it slides.
 */
export function moveSlots(store, slots, dir) {
  const song = store.song;
  const filled = filledSlots(song, slots);
  if (!canMoveSlots(song, slots, dir, store.doc.channelCount)) return false;
  const sources = new Set(filled.map((s) => slotKey(s.cue, s.ch)));
  const writes = [];
  for (const s of filled) {
    const to = s.ch + dir;
    writes.push({ cue: s.cue, ch: to,
      value: (wordAt(song, s.cue, to) & CMD_BIT) | (wordAt(song, s.cue, s.ch) & PAT_MASK) });
  }
  for (const s of filled) {
    if (sources.has(slotKey(s.cue, s.ch - dir))) continue; // another source lands here
    writes.push({ cue: s.cue, ch: s.ch,
      value: (wordAt(song, s.cue, s.ch) & CMD_BIT) | CUE_EMPTY });
  }
  store.undo.apply(setCuesOp(store.songIndex, writes));
  return true;
}

/**
 * Give every filled slot its OWN copy of the pattern it points at — the
 * unshare: a pattern used by four cues stays shared until you ask one of them
 * to stop sharing it. Each slot gets its own fresh number even when two of them
 * name the same pattern, because "these two cues should now differ" is the only
 * reason to ask.
 *
 * One composite undo step: a created pattern per slot, then the cue words that
 * point at them. The numbers come from freePatternNumbers() up front, so they
 * are distinct and the address space running out just means fewer copies.
 */
export function duplicateSlots(store, slots) {
  const song = store.song;
  const filled = filledSlots(song, slots);
  if (filled.length === 0) return false;
  const nums = song.freePatternNumbers(filled.length);
  if (nums.length === 0) return false;
  const ops = [];
  const writes = [];
  filled.slice(0, nums.length).forEach((s, i) => {
    const word = wordAt(song, s.cue, s.ch);
    ops.push(createPatternOp(store.songIndex, nums[i],
      store.doc.patternBytes(store.songIndex, word & PAT_MASK)));
    writes.push({ cue: s.cue, ch: s.ch, value: (word & CMD_BIT) | (nums[i] & PAT_MASK) });
  });
  ops.push(setCuesOp(store.songIndex, writes));
  store.undo.apply(compositeOp(ops));
  return true;
}

/**
 * Take the patterns in `slots` out of the song: every filled slot's cue word
 * goes back to the empty sentinel, and any pattern that loses its LAST user in
 * the process has its content deleted too.
 *
 * Emptying the slot is the primary act — that is what "there is no pattern here
 * any more" means, and it is all that can be said about a pattern other cues
 * still play. Deleting the content is the tidy-up that follows from it: a
 * pattern nothing references is unreachable, and leaving it materialised would
 * only carry dead music in the file and hold its number against the next New
 * pattern. Sharing is therefore what decides, exactly as it does everywhere
 * else in this file.
 *
 * One composite undo step, cue words FIRST so the deletes unwind after the
 * references come back.
 */
export function deleteSlots(store, slots) {
  const song = store.song;
  const filled = filledSlots(song, slots);
  if (filled.length === 0) return false;
  const writes = filled.map((s) => ({
    cue: s.cue, ch: s.ch,
    value: (wordAt(song, s.cue, s.ch) & CMD_BIT) | CUE_EMPTY,
  }));
  const ops = [setCuesOp(store.songIndex, writes)];
  for (const p of orphanedPatterns(song, slots)) {
    ops.push(deletePatternOp(store.songIndex, p));
  }
  store.undo.apply(compositeOp(ops));
  return true;
}

// ── item 103.2: the channel header's mute row ──

/**
 * The second row for a channel HEADER, where there are no cells for the column
 * tools to act on: the same two things a plain and a Ctrl+click on that header
 * already do, plus the way back out. Unmute-all only appears when something is
 * actually muted — otherwise it is a button that does nothing.
 */
export function muteItems(store, ch) {
  const chans = store.doc?.channelCount ?? 64;
  const muted = store.voiceMutes[ch] === true;
  const items = [
    { id: "solo", label: t("ctx.solo"), icon: ICON.solo,
      title: t("ctx.soloTitle", { ch: ch + 1 }) },
    muted
      ? { id: "mute", label: t("ctx.unmute"), icon: ICON.unmute,
          title: t("ctx.unmuteTitle", { ch: ch + 1 }) }
      : { id: "mute", label: t("ctx.mute"), icon: ICON.mute,
          title: t("ctx.muteTitle", { ch: ch + 1 }) },
  ];
  let n = 0;
  for (let i = 0; i < chans; i++) if (store.voiceMutes[i]) n++;
  if (n > 0) {
    items.push({ id: "unmuteAll", label: t("ctx.unmuteAll"), icon: ICON.unmuteAll,
      title: t("ctx.unmuteAllTitle", { n }) });
  }
  return items;
}

/** Run a mute-row cell. Mutes are playback state, not document state, so none
 *  of this goes on the undo stack. Returns true when `id` was one of them. */
export function runMuteItem(store, id, ch) {
  switch (id) {
    case "solo": store.toggleSolo(ch); return true;
    case "mute": store.toggleMute(ch); return true;
    case "unmuteAll": store.clearMutes(); return true;
  }
  return false;
}

// ── the second effect column (§5.5) ──

/**
 * Show/hide this channel's SECOND effect, plus the all-channels form of the
 * same switch. Only a format-v3 document has a second effect at all, so on
 * anything else this row is empty and the menu simply doesn't mention it.
 *
 * It rides on the channel header's row rather than the grid's column tools: the
 * column is a property of the CHANNEL STRIP — it changes that strip's width —
 * not of the cells under the pointer.
 */
export function fx2Items(store, ch) {
  if (store.doc?.wideCells !== true) return [];
  const on = store.fx2Chan(ch);
  const items = [
    on
      ? { id: "fx2Hide", label: t("ctx.fx2Hide"), icon: ICON.fx2Hide,
          title: t("ctx.fx2HideTitle", { ch: ch + 1 }) }
      : { id: "fx2Show", label: t("ctx.fx2Show"), icon: ICON.fx2Show,
          title: t("ctx.fx2ShowTitle", { ch: ch + 1 }) },
  ];
  // The all-channels cell always offers the OTHER state, so the pair never
  // reads as two ways to do the same thing.
  items.push(store.fx2Any()
    ? { id: "fx2HideAll", label: t("ctx.fx2HideAll"), icon: ICON.fx2HideAll,
        title: t("ctx.fx2HideAllTitle") }
    : { id: "fx2ShowAll", label: t("ctx.fx2ShowAll"), icon: ICON.fx2ShowAll,
        title: t("ctx.fx2ShowAllTitle") });
  return items;
}

/** Run an fx2 cell. View state, so no undo step. True when `id` was one. */
export function runFx2Item(store, id, ch) {
  switch (id) {
    case "fx2Show": case "fx2Hide": store.toggleFx2Chan(ch); return true;
    case "fx2ShowAll": store.setAllFx2(true); return true;
    case "fx2HideAll": store.setAllFx2(false); return true;
  }
  return false;
}

/**
 * Insert an empty channel at `at`, shifting that channel and everything right
 * of it one place along — mutes included, which is why the live array goes in.
 * The channel count is a fixed 32/64, so the last channel falls off the end:
 * ask first when it is carrying something (the drop is in the op's inverse, so
 * it undoes either way). Returns true when the document changed.
 */
export function insertChannelAt(store, at) {
  const chans = store.doc.channelCount;
  if (at < 0 || at >= chans) return false;
  if (channelHasContent(store.song, chans - 1) &&
      !confirm(t("ctx.dropLastConfirm", { ch: chans }))) return false;
  store.undo.apply(insertChannelOp(store.songIndex, at, null, store.voiceMutes));
  return true;
}
