// The low-meta generators as one kind of thing: an OPL channel (opl.js) or a
// PSG pair (psg.js), for the high metas that take either as a source — a
// formant instrument singing from one (formant.js) — without asking which.
//
// A chip state is an OplState or a PsgState, and the patch it plays an
// OplPatch or a PsgPatch; every function here dispatches on that. The volume
// argument is the OPL channel's (its drivers put the note volume in the
// operators); a PSG pair takes none, and is always read at unity here.

import {
  OplState, oplKeyOn, oplRender, oplChannelAlive, cloneOplState,
} from "./opl.js";
import {
  PsgState, PsgPatch, psgKeyOn, psgRender, psgChannelAlive, clonePsgState,
} from "./psg.js";

/** Whether `patch` is a PSG patch (else an OPL one). */
export function isPsgPatch(patch) { return patch instanceof PsgPatch; }

/** A fresh channel for `patch`'s kind. */
export function newChipState(patch) {
  return patch instanceof PsgPatch ? new PsgState() : new OplState();
}

/** Whether `st` can play `patch` (the same kind of channel). */
export function chipStateFits(st, patch) {
  return st !== null && (patch instanceof PsgPatch) === (st instanceof PsgState);
}

export function chipKeyOn(st, patch, carry) {
  if (st instanceof PsgState) psgKeyOn(st, patch, carry);
  else oplKeyOn(st, patch, carry);
}

/** The channel at output frame `frame`, at unity volume. */
export function chipRender(st, frame, rate, keyOff) {
  return st instanceof PsgState
    ? psgRender(st, frame, rate, keyOff)
    : oplRender(st, frame, rate, 1.0, keyOff);
}

export function chipAlive(st) {
  return st instanceof PsgState ? psgChannelAlive(st) : oplChannelAlive(st);
}

export function cloneChipState(st) {
  return st instanceof PsgState ? clonePsgState(st) : cloneOplState(st);
}

/** A key the measurement memo can hold a patch's sound by: its decode, and for
 *  a PSG patch its S $Axxx overlay too, which changes what it sounds like. */
export function chipSoundKey(patch) {
  return patch instanceof PsgPatch ? `${patch.gen}.${patch.rtGen}` : `${patch.gen}`;
}
