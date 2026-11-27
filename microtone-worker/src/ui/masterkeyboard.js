// The master keyboard (item 379): MIDI keyboards as the piano keys.
//
// A key plays what a key of the typing keyboard's piano plays, by the same
// rules (jam.js, edit.js): out of record mode, or anywhere notes are not
// entered, it auditions on the jam bank, chording; in record mode on the
// Timeline or the Patterns view it enters a note into the cursor's cell, with
// the current instrument, and steps the cursor down by the input step — one
// note at a time, as typing does. Which degree a key plays is the Scala
// keyboard mapping's (src/midi/kbm.js; a key a degree from key 60 without
// one), in the note's own notation, from the keyboard's octave (Oct on the
// top bar; not its transposition, whose unit is the typing layout's): key 60
// is degree 0 of octave 4 by default, C-4 in 12-TET.
//
// The sustain pedal (CC 64) writes `S $7200` into the cursor's cell when it
// goes down and `S $7100` when it comes up (record mode, the grids only), and
// holds the auditions it was pressed over until it comes up. Velocity is
// written into the volume column when the person asks for it (`velocity`).
//
// Every keyboard counts on its own: a key is known by its keyboard, its MIDI
// channel and its number, and each keyboard has a pedal of its own. The
// controller is pure over its host (app.js `keyboardHost`), so Node tests
// drive it with bytes.

import { kbmDegree } from "../midi/kbm.js";
import { noteForDegree } from "../../core/tuning/pitchtables.js";
import { EffectOp } from "../../core/engine/tables.js";
import { effectFields } from "./surface.js";

/** The pedal's two commands: down, up. */
export const PEDAL_DOWN_ARG = 0x7200;
export const PEDAL_UP_ARG = 0x7100;
const isPedal = (op, arg) => op === EffectOp.OP_S && (arg === PEDAL_DOWN_ARG || arg === PEDAL_UP_ARG);

/** A velocity (1…127) as a volume SET: 0…255 in a wide cell, 0…63 in a
 *  legacy one, rounded, 127 the loudest. */
export function velocityVolume(velocity, wide) {
  const v = Math.min(Math.max(velocity, 0), 127);
  return Math.round((v * (wide ? 255 : 63)) / 127);
}

export class MasterKeyboard {
  /**
   * `host`: {
   *   octave()                      the keyboard's octave (jam.octave)
   *   period()                      the notation's period in degrees, for a
   *                                 mapping whose formal octave is 0
   *   enterNote(id, noteFor, vol)   record-mode entry into the cursor's cell;
   *                                 true when it entered (and auditions it)
   *   audition(id, noteFor)         sound it on the jam bank
   *   release(id)                   the key is up
   *   pedalTarget()                 {cell, fx2, apply} where the pedal writes,
   *                                 or null
   * }
   * `noteFor(preset)` is the key's note in a notation: the host knows which
   * notation a note goes in (the cell's, the jam's).
   */
  constructor(host) {
    this.host = host;
    /** The keyboard mapping (parseKbm), or null: a key a degree. */
    this.kbm = null;
    /** Write velocity into the volume column. */
    this.velocity = false;
    this.held = new Map();      // key id → keyboard name
    this.sustained = new Map(); // key id → keyboard name: up, held by the pedal
    this.pedals = new Map();    // keyboard name → down
  }

  /** One whole MIDI message from keyboard `source` (a port's name). */
  receive(bytes, source) {
    if (!bytes || bytes.length < 1) return;
    const status = bytes[0];
    const type = status & 0xf0;
    const ch = status & 0x0f;
    if (type === 0x90 && bytes.length >= 3) {
      if (bytes[2] > 0) this.noteOn(source, ch, bytes[1], bytes[2]);
      else this.noteOff(source, ch, bytes[1]);
    } else if (type === 0x80 && bytes.length >= 3) {
      this.noteOff(source, ch, bytes[1]);
    } else if (type === 0xb0 && bytes.length >= 3) {
      const cc = bytes[1];
      if (cc === 64) this.pedal(source, bytes[2] >= 64);
      // All Sound Off, All Notes Off: every key of this keyboard goes up
      // (and a pedal it held lets go of the auditions, writing nothing).
      else if (cc === 120 || cc === 123) this.allOff(source);
    }
  }

  noteOn(source, ch, key, velocity) {
    const id = `midi:${source}:${ch}:${key}`;
    // A second note-on with no note-off between: the key struck again.
    if (this.held.has(id) || this.sustained.has(id)) {
      this.held.delete(id);
      this.sustained.delete(id);
      this.host.release(id);
    }
    const degree = kbmDegree(this.kbm, key, this.host.period?.() ?? 0);
    if (degree === null) return; // a key the mapping leaves silent
    const octave = this.host.octave();
    const noteFor = (preset) => noteForDegree(octave, degree, preset);
    this.held.set(id, source);
    if (!this.host.enterNote(id, noteFor, this.velocity ? velocity : undefined)) {
      this.host.audition(id, noteFor);
    }
  }

  noteOff(source, ch, key) {
    const id = `midi:${source}:${ch}:${key}`;
    if (!this.held.has(id)) return;
    this.held.delete(id);
    if (this.pedals.get(source)) this.sustained.set(id, source);
    else this.host.release(id);
  }

  pedal(source, down) {
    if ((this.pedals.get(source) ?? false) === down) return; // a half-pedal's stream
    this.pedals.set(source, down);
    const target = this.host.pedalTarget();
    if (target) {
      const arg = down ? PEDAL_DOWN_ARG : PEDAL_UP_ARG;
      target.apply(effectFields(target.cell, isPedal, EffectOp.OP_S, arg, target.fx2));
    }
    if (!down) this._releaseSustained(source);
  }

  /** Every key of keyboard `source` up, and its pedal with them. */
  allOff(source) {
    for (const [id, s] of [...this.held]) {
      if (s !== source) continue;
      this.held.delete(id);
      this.host.release(id);
    }
    this.pedals.delete(source);
    this._releaseSustained(source);
  }

  /** A keyboard that went (unplugged, unticked): as All Notes Off. */
  forget(source) { this.allOff(source); }

  _releaseSustained(source) {
    for (const [id, s] of [...this.sustained]) {
      if (s !== source) continue;
      this.sustained.delete(id);
      this.host.release(id);
    }
  }
}
