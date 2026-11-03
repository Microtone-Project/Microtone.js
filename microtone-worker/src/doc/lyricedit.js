// The `ILyr` section's part in the bank tools (item 280): a lyric instrument's
// entry is keyed by its slot and its recipes point into the pool, so whatever
// moves an instrument or a pool span has to move these too — as it moves an
// Ixmp blob's slot id and a formant record's pointers.
//
// Every function here answers with the section payload a plan should install:
// `undefined` when nothing changes (the plan then leaves the section alone),
// `null` when no entry is left (the section goes), or the new bytes.

import { buildLyricSection, cloneLyricEntry } from "../../core/format/lyric-section.js";

function payloadOf(entries, changed) {
  if (!changed) return undefined;
  return entries.length === 0 ? null : buildLyricSection(entries);
}

/**
 * The entries moved to other slots: `fn(slot)` answers the new slot, the same
 * slot, or null to drop the entry.
 */
export function lyricsWithSlots(doc, fn) {
  const out = [];
  let changed = false;
  for (const e of doc.lyricMap().entries.values()) {
    const to = fn(e.instId & 0x3ff);
    if (to === null || to === undefined) { changed = true; continue; }
    if (to !== e.instId) changed = true;
    out.push({ ...e, instId: to });
  }
  return payloadOf(out, changed);
}

/**
 * The entries with their recipes' pool pointers rewritten: `fn(ptr, len)`
 * answers the new pointer, undefined to leave it, or null to take the
 * recipe off its sample — the consonant then sounds the noise generator, as a
 * formant record's slot does when its sample is deleted.
 */
export function lyricsWithRecipes(doc, fn) {
  const out = [];
  let changed = false;
  for (const e0 of doc.lyricMap().entries.values()) {
    const e = cloneLyricEntry(e0);
    for (const r of e.recipes) {
      if (r.len <= 0) continue;
      const to = fn(r.ptr, r.len);
      if (to === undefined || to === r.ptr) continue;
      changed = true;
      if (to === null) Object.assign(r, { ptr: 0, len: 0, offset: 0, rate: 0, tilt: 0, gain: 0 });
      else r.ptr = to;
    }
    out.push(e);
  }
  return payloadOf(out, changed);
}

/**
 * The entries with their recipes edited by `fn(recipe)`, which changes the
 * recipe (a copy) in place and answers whether it did.
 */
export function lyricsEditRecipes(doc, fn) {
  const out = [];
  let changed = false;
  for (const e0 of doc.lyricMap().entries.values()) {
    const e = cloneLyricEntry(e0);
    for (const r of e.recipes) if (r.len > 0 && fn(r)) changed = true;
    out.push(e);
  }
  return payloadOf(out, changed);
}

/** Apply a plan's `ilyr` field to `doc` inside a swap-style op (renumber,
 *  delete, cleanup), recording the previous payload in `old` so the inverse
 *  restores it. A plan without the field leaves the section alone. */
export function swapLyricsSection(doc, plan, old) {
  if (!("ilyr" in plan) || plan.ilyr === undefined) return;
  const sec = doc.projSections.find((x) => x.fourcc === "ILyr");
  old.ilyr = sec ? sec.payload : null;
  doc.setSection("ILyr", plan.ilyr);
}
