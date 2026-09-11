// Interrupt dispatch — the one place a drained Int0..IntF latch becomes calls.
//
// A song fires an interrupt by putting `Int0`…`IntF` in a note column: no
// sound, no channel touched, just the song saying something to the program
// playing it, exactly in time with the music. The argument comes from a `:` on
// the same row (0 where the row has none).
//
// Both halves of the library end up here — TaudPlayer off a posted snapshot,
// TaudRenderer off the engine directly — because the SEMANTICS are the thing
// worth keeping identical: edge-triggered, one call per set bit, an unset slot
// costs nothing, and a callback that throws must not take the rest of the
// interrupts (or the audio) down with it.

import { SNAP_INT_COUNT } from "./protocol.js";

/** A fresh, empty callback bank — one slot per interrupt, all unregistered. */
export function makeInterruptBank() { return new Array(SNAP_INT_COUNT).fill(null); }

/** Register (or, with a non-function, unregister) interrupt `n`'s callback. */
export function setInterruptIn(bank, n, fn) {
  if (n < 0 || n >= SNAP_INT_COUNT) return;
  bank[n | 0] = typeof fn === "function" ? fn : null;
}

/** Call the registered callbacks for every bit in `mask`, lowest first.
 *  `argOf(n)` supplies the argument; a throwing callback is reported and
 *  skipped, never allowed to swallow the interrupts queued behind it. */
export function fireInterrupts(bank, mask, argOf) {
  if (!mask) return;
  for (let n = 0; n < SNAP_INT_COUNT; n++) {
    if (!(mask & (1 << n))) continue;
    const fn = bank[n];
    if (!fn) continue;
    try {
      fn(argOf(n));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`taudplay: interrupt ${n} callback threw`, err);
    }
  }
}

/** Snapshot form (TaudPlayer): the latch was drained in the worklet, and the
 *  mask and its arguments travelled in the snapshot floats. */
export function dispatchInterrupts(bank, snapshot, maskAt, argsAt) {
  fireInterrupts(bank, snapshot[maskAt] | 0, (n) => snapshot[argsAt + n] | 0);
}

/** Engine form (TaudRenderer): no wire at all — drain the playhead's latch and
 *  dispatch it, which a pull-driven render can do per block. */
export function dispatchInterruptsFromState(bank, ts) {
  fireInterrupts(bank, ts.drainInterrupts(), (n) => ts.interruptArg(n));
}
