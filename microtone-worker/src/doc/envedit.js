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

import { minifloatToDouble, minifloatFromDouble } from "../../core/engine/minifloat.js";

/** Physical node slots in a record; the array is always this long. */
export const ENV_MAX_NODES = 25;

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
