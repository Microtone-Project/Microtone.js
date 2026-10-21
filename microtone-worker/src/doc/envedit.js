// Envelope node-array surgery (item 181) — pure functions over the decoded
// 25-node array and its two control words, shared by the base instrument's
// envelope tabs (ui/views/instruments.js) and the Ixmp patch editor's
// envelope sub-tabs (ui/views/instadvanced.js). Both had their own copy; the
// copies disagreed about nothing, which is how they both carried the same two
// bugs for as long as they existed.
//
// THE ARRAY IS ALWAYS 25 NODES LONG AND THE COUNT IS IMPLIED. A node's
// `offset` is the duration of the segment that FOLLOWS it, so a zero offset
// marks the end: the active count is "index of the first zero-offset node,
// plus one" (TAUD_FILE_FORMAT.md §7.2). Nothing stores a length, which is why
// every edit here is really an edit to where that terminator sits — and why
// "delete the last node" is not "shift the array down one".

import { minifloatToDouble, minifloatFromDouble, MINIFLOAT_LUT } from "../../core/engine/minifloat.js";

/** Physical node slots in a record; the array is always this long. */
export const ENV_MAX_NODES = 25;

/** The longest segment one node offset holds (code 255), in seconds. */
export const ENV_MAX_SEGMENT = MINIFLOAT_LUT[255];

/** Seconds given to the segment a freshly appended tail node opens up. */
const TAIL_SEGMENT_SEC = 0.1;

/** Active node count: nodes 0…N where N is the first zero-duration
 *  (terminator) node, capped at the physical slot count. */
export function envActiveCount(env) {
  for (let i = 0; i < ENV_MAX_NODES - 1; i++) if (env[i].offset === 0) return i + 1;
  return ENV_MAX_NODES;
}

/** A plain, detached copy of the node array — the shape both ops and the
 *  patch editor's in-place mutation want to start from. */
export function envCopy(env) {
  return env.map((n) => ({ value: n.value, offset: n.offset }));
}

/**
 * The offset code whose duration lies NEAREST `sec`, from code `lo` up. A drag
 * snaps through this rather than minifloatFromDouble, which keeps the Kotlin
 * rounding quirk (between two codes it takes the EVEN one, not the nearer) and
 * so would move a node only every other step. `lo = 1` keeps a segment open:
 * code 0 is the terminator, and would end the envelope there.
 */
export function minifloatNearest(sec, lo = 0) {
  if (!(sec > MINIFLOAT_LUT[lo])) return lo;
  if (sec >= MINIFLOAT_LUT[255]) return 255;
  let a = lo, b = 255; // LUT[a] < sec <= LUT[b]
  while (b - a > 1) {
    const m = (a + b) >>> 1;
    if (MINIFLOAT_LUT[m] < sec) a = m; else b = m;
  }
  return sec - MINIFLOAT_LUT[a] <= MINIFLOAT_LUT[b] - sec ? a : b;
}

/**
 * Where a sideways drag puts node `idx`, as the codes of the segments either
 * side of it: `{ prevOffset, offset }`, `offset` left out for the last node
 * (its own offset is the terminator). `null` for node 0, which is anchored at
 * t=0. `env` is the envelope AS THE GESTURE FOUND IT, so a drag that comes back
 * to where it began leaves every code as it was; `want` is the node's new time
 * in seconds, from wherever the pointer is.
 *
 * The last node lengthens or shortens the envelope by exactly the distance it
 * is dragged, to the nearest code — the 1/256 s one included, which the
 * engine's own rounding never gives (minifloatNearest).
 *
 * An interior node moves BETWEEN ITS NEIGHBOURS, and the envelope keeps its
 * length: the segment before the node takes what the one after it gives up,
 * so the next node stays where it was. Re-timing only the segment before the
 * node used to carry everything after it along, which is how one sideways
 * nudge made the whole envelope longer. Both segments stay open and within the
 * longest a code holds.
 *
 * "Stays where it was" is a choice of PAIR, because the two codes sit on
 * different grids: a step is 1/256 s below an eighth of a second and doubles
 * with every octave of length, and pairs that keep the sum exact come round
 * only once per step of the coarser grid. Rounding each to its own nearest
 * code shifts the next node by up to half that step; insisting on an exact
 * pair snaps the dragged node to the coarse grid, and a 4 ms attack before a
 * half-second decay could not be dragged at all. So `slack` is how far from
 * `want` the node may sit unnoticed — a few pixels' worth at the graph's
 * zoom — and of the codes that close, the drag takes the one that shifts the
 * next node least. Zoomed out, the neighbours hold still; zoomed in, the node
 * goes exactly where it is put.
 *
 * `carry` (a Shift-drag) re-times only the segment before the node and takes
 * the rest along with it, as the Seg spinner does; its `offset` is the
 * unchanged one, so the gesture's first step (the one undo keeps) names every
 * field a later step can change.
 */
export function envDragNode(env, idx, want, { carry = false, slack = 0 } = {}) {
  const active = envActiveCount(env);
  if (idx <= 0 || idx >= active) return null;
  let start = 0;
  for (let i = 0; i < idx - 1; i++) start += minifloatToDouble(env[i].offset);
  if (idx === active - 1) return { prevOffset: minifloatNearest(want - start, 1) };
  if (carry) return { prevOffset: minifloatNearest(want - start, 1), offset: env[idx].offset };
  const span = minifloatToDouble(env[idx - 1].offset) + minifloatToDouble(env[idx].offset);
  const lo = Math.max(MINIFLOAT_LUT[1], span - ENV_MAX_SEGMENT);
  const hi = Math.min(span - MINIFLOAT_LUT[1], ENV_MAX_SEGMENT);
  const d = Math.min(Math.max(want - start, lo), hi);
  const reach = Math.max(slack, Math.abs(MINIFLOAT_LUT[minifloatNearest(d, 1)] - d));
  let best = null;
  for (let a = 1; a < 256; a++) {
    const dist = Math.abs(MINIFLOAT_LUT[a] - d);
    if (dist > reach) continue;
    const b = minifloatNearest(span - MINIFLOAT_LUT[a], 1);
    const drift = Math.abs(MINIFLOAT_LUT[a] + MINIFLOAT_LUT[b] - span);
    if (best === null || drift < best.drift || (drift === best.drift && dist < best.dist)) {
      best = { drift, dist, prevOffset: a, offset: b };
    }
  }
  return { prevOffset: best.prevOffset, offset: best.offset };
}

/**
 * Insert a node after `sel`: split its segment (interior) or extend the tail.
 * Returns `{ nodes, selected, appended }` — `appended` is true when the tail
 * grew, which is the case a sustain point sitting on the old last node has to
 * follow ([envFollowTailSustain]). `null` when the envelope is already full.
 */
export function envAddNode(env, sel, max) {
  const active = envActiveCount(env);
  if (active >= ENV_MAX_NODES) return null;
  const nodes = envCopy(env);
  if (sel >= active - 1) {
    // Extend: give the current last node a span, and append the terminator
    // after it at the same value, so the envelope holds where it held before.
    nodes[active - 1].offset = minifloatFromDouble(TAIL_SEGMENT_SEC);
    nodes[active] = { value: env[active - 1].value, offset: 0 };
    return { nodes, selected: active, appended: true };
  }
  // Interior: halve `sel`'s segment and put the new node at the midpoint of
  // the two values it lands between.
  const total = minifloatToDouble(env[sel].offset);
  const half = minifloatFromDouble(total / 2);
  const midVal = Math.round((env[sel].value + env[sel + 1].value) / 2);
  for (let i = ENV_MAX_NODES - 1; i > sel + 1; i--) {
    nodes[i] = { value: nodes[i - 1].value, offset: nodes[i - 1].offset };
  }
  nodes[sel].offset = half;
  nodes[sel + 1] = {
    value: Math.min(Math.max(midVal, 0), max),
    offset: minifloatFromDouble(Math.max(total - minifloatToDouble(half), 0)),
  };
  return { nodes, selected: sel + 1, appended: false };
}

/**
 * Delete node `sel`. Returns `{ nodes, selected, active }` with `active` the
 * new node count, or `null` when the deletion is not allowed — node 0 is
 * anchored at t=0, and an envelope always keeps at least one node.
 *
 * **The tail is not a shift.** Deleting an interior node merges its segment
 * into the node before it, so everything after keeps its timing. Deleting the
 * LAST node cannot do that: the last node IS the terminator, its own segment
 * is already zero, and merging zero into the node before it leaves that node's
 * offset non-zero — so the count stayed exactly where it was and the button
 * appeared to do nothing (it silently zeroed the tail VALUE instead, which on
 * a volume envelope is the Schism cut rule: an instant note cut). The node
 * before the deleted one has to BECOME the terminator.
 */
export function envRemoveNode(env, sel) {
  const active = envActiveCount(env);
  if (sel === 0 || sel >= active || active <= 1) return null;
  const nodes = envCopy(env);
  if (sel === active - 1) {
    nodes[sel - 1].offset = 0;                       // the new terminator
    nodes[sel] = { value: 0, offset: 0 };
  } else {
    const merged = minifloatToDouble(env[sel - 1].offset) + minifloatToDouble(env[sel].offset);
    nodes[sel - 1].offset = minifloatFromDouble(merged);
    for (let i = sel; i < ENV_MAX_NODES - 1; i++) {
      nodes[i] = { value: env[i + 1].value, offset: env[i + 1].offset };
    }
    // A FULL envelope has no terminator to shift down — the count saturates
    // at the slot total and the last node's offset is never read — so the
    // shift has to make one, or the array still reads as 25 nodes and the
    // deletion is invisible all over again. The vacated slot is cleared with
    // it; leaving it duplicated the tail instead of shortening it.
    if (active === ENV_MAX_NODES) nodes[ENV_MAX_NODES - 2].offset = 0;
    nodes[ENV_MAX_NODES - 1] = { value: 0, offset: 0 };
  }
  return { nodes, selected: Math.max(sel - 1, 0), active: active - 1 };
}

/**
 * A SUSTAIN word whose start or end sat on `oldLast` follows the tail to
 * `newLast`. Returns the word unchanged when there is nothing to do.
 *
 * Holding the final level until key-off — sustain start = end = the last
 * node — is how a pad is built, and appending a node used to leave that point
 * stranded mid-envelope, so the note began releasing through the new segment
 * while still holding the key. A sustain RANGE ending on the tail grows to
 * include the new node for the same reason.
 *
 * An already-enabled sustain is the only one that moves ON ITS OWN: the
 * indices of a disabled one are not describing anything, and rewriting them
 * would churn the record on every fresh envelope (a new record's start and end
 * are both 0, which IS the last node of a one-node envelope).
 *
 * `arm` is the exception, and it is passed when the same click also claimed
 * the envelope's PRESENCE — the moment an envelope goes from "the file says
 * this instrument has none" to "here is one". That envelope is being built
 * now, so the sustain is switched on with it and its points move like a live
 * one's: the first appended node arrives with the sustain already holding the
 * tail, instead of the box needing to be found before any of it does anything.
 * Pass an `oldLast` no index can match (−1) to arm without following.
 */
export function envFollowTailSustain(susWord, oldLast, newLast, arm = false) {
  const enabled = ((susWord >>> 5) & 1) !== 0;
  if (!enabled && !arm) return susWord & 0xffff;
  const start = (susWord >>> 8) & 0x1f;
  const end = susWord & 0x1f;
  const ns = start === oldLast ? newLast : start;
  const ne = end === oldLast ? newLast : end;
  const armed = arm ? susWord | 0x20 : susWord;
  if (ns === start && ne === end && armed === susWord) return susWord & 0xffff;
  return ((armed & ~0x1f1f) | ((ns & 0x1f) << 8) | (ne & 0x1f)) & 0xffff;
}

/**
 * Clamp a LOOP or SUSTAIN word's start and end indices into an envelope of
 * `active` nodes. Both editors already clamp the SPINNERS to the active count,
 * so a word left pointing past the tail is a record that disagrees with the
 * panel showing it — and an index into a zeroed node, which the engine reads
 * as a value-0 hold.
 */
export function envClampWrap(word, active) {
  const hi = Math.max(active - 1, 0);
  const start = Math.min((word >>> 8) & 0x1f, hi);
  const end = Math.min(word & 0x1f, hi);
  return ((word & ~0x1f1f) | (start << 8) | end) & 0xffff;
}
