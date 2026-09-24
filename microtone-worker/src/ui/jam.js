// Jam (audition) keyboard: held piano keys → worklet jamNote on the dedicated
// jam bank, releasing a key stops the voice it took. Chording where the piano
// auditions, last-key-wins on one voice where it ENTERS notes (item 140.1).

import { DEFAULT_KEYMAP, keymapHas, keymapNote } from "./keymap.js";
import { JAM_VOICES, JAM_VOICE_BASE } from "../engine/constants.js";

// Hosts that deliver hardware autorepeat as a keyup+keydown PAIR (X11 without
// detectable autorepeat) give no way to tell the phantom release from a real
// one at the instant it lands — the only tell is the keydown that follows in
// the same input burst. So a release waits this long for its partner before it
// takes effect. Nothing human re-strikes a key inside 30 ms, and a note-off
// that late is inaudible; browsers that set `repeat` never pay the wait, since
// they send no keyup at all.
const RELEASE_GRACE_MS = 30;

export const TRANSPOSE_MAX = 99;

export class JamKeyboard {
  constructor(store) {
    this.store = store;
    /** code → jam-bank voice index currently sounding it. */
    this.held = new Map();
    this.octave = 4;
    /** Keyboard transposition in the layout's own unit (a degree, or a
     *  semitone on a `semi` layout) — Shift+Alt+←/→. On top of the octave. */
    this.transpose = 0;
    this.currentInst = 1;
    /** code → timer id for releases still waiting out the grace window. */
    this.releasing = new Map();
    /** 0 releases synchronously (tests, and hosts known to set `repeat`). */
    this.releaseGraceMs = RELEASE_GRACE_MS;
    /** Round-robin cursor into the bank, so a re-struck key takes a fresh
     *  voice instead of the one still ramping out under it. */
    this._nextSlot = 0;
  }

  /**
   * Do held keys CHORD, or does the last one win? They chord wherever the piano
   * is an audition (item 140.1): the Instruments/Samples editors always, the
   * grids whenever record is off. Record mode is note ENTRY — one key writes
   * one cell and steps the cursor — so it stays monophonic on a single voice,
   * exactly as it was.
   */
  get chording() {
    const view = this.store.view;
    if (view === "samples" || view === "instruments") return true;
    return !this.store.record;
  }

  /**
   * The bank voice a fresh keypress sounds on. Monophonic mode always answers
   * the same slot, so a new key retriggers the voice the last one is on (NNA
   * and all — taut's jam model). Chording hands out the next FREE slot and,
   * once all 16 are held, steals the oldest.
   */
  _takeVoice() {
    if (!this.chording) return JAM_VOICE_BASE;
    for (let i = 0; i < JAM_VOICES; i++) {
      const voice = JAM_VOICE_BASE + this._nextSlot;
      this._nextSlot = (this._nextSlot + 1) % JAM_VOICES;
      if (!this._sounding(voice)) return voice;
    }
    const voice = JAM_VOICE_BASE + this._nextSlot;
    this._nextSlot = (this._nextSlot + 1) % JAM_VOICES;
    return voice;
  }

  /** Is any still-held key sounding `voice`? (Monophonic mode shares one.) */
  _sounding(voice) {
    for (const v of this.held.values()) if (v === voice) return true;
    return false;
  }

  /** The active keymap — which keys are piano keys and what they play. A store
   *  that never set one (tests, boot) gets the shipped Piano map, i.e. exactly
   *  the keyboard this class has always had. */
  get keymap() { return this.store.keymap ?? DEFAULT_KEYMAP; }

  /** keydown → true when consumed (a piano key). */
  down(code, repeat) {
    if (!keymapHas(this.keymap, code)) return false;
    // The keydown half of a phantom repeat pair: the note never stopped, so
    // calling the pending release off is the whole job.
    this._cancelRelease(code);
    // A held key is one note: autorepeat must not retrigger it. `held` is the
    // backstop for hosts that leave `repeat` unset on the synthesised events.
    if (repeat || this.held.has(code)) return true;
    const voice = this._takeVoice();
    this.held.set(code, voice);
    const audio = this.store.audio;
    if (audio) {
      const note = keymapNote(this.keymap, code, this.octave, this.store.pitchPreset, null, this.transpose);
      // Pure audition on the DOM views (Instruments/Samples) may snap a strict
      // metainstrument to a note it can actually sound (item 51); note-entry
      // views keep the exact pitch.
      const audition = this.store.view === "instruments" || this.store.view === "samples";
      audio.jamNote(0, voice, note, this.currentInst, audition);
    }
    return true;
  }

  /**
   * Audition a note the grid editor just entered, tracked under its key `code`
   * so record-mode entry obeys the same piano rules as a plain jam: last key
   * wins, and only the release of the LAST held key stops the voice. It sounds
   * on the jam bank rather than the edited lane (item 140), so entering into
   * a muted lane is still audible and never cuts what the song is playing
   * there.
   */
  hold(code, note) {
    const mine = keymapHas(this.keymap, code);
    let voice = this.held.get(code);
    if (voice === undefined) {
      voice = this._takeVoice();
      if (mine) this.held.set(code, voice);
    }
    if (mine) this._cancelRelease(code);
    this.store.audio?.jamNote(0, voice, note, this.currentInst);
  }

  up(code) {
    if (!keymapHas(this.keymap, code)) return false;
    if (!this.held.has(code)) {
      // Not ours to release (a jam issued by some other path): keep the old
      // safety net so its voice can never be left sounding. Only the BANK is
      // cleared — the song's own lanes are none of this keyboard's business.
      if (this.held.size === 0) this.store.audio?.jamStopVoice(0, -1);
      return true;
    }
    this._cancelRelease(code);
    if (this.releaseGraceMs > 0) {
      this.releasing.set(code, setTimeout(() => {
        this.releasing.delete(code);
        this._release(code);
      }, this.releaseGraceMs));
    } else {
      this._release(code);
    }
    return true;
  }

  /** Drop every held key at once — a focus loss ends the gesture (no keyup). */
  allUp() {
    for (const code of this.releasing.keys()) clearTimeout(this.releasing.get(code));
    this.releasing.clear();
    const sounding = this.held.size > 0;
    this.held.clear();
    if (sounding) this.store.audio?.jamStopVoice(0, -1);
  }

  _release(code) {
    const voice = this.held.get(code);
    this.held.delete(code);
    // Monophonic mode has every held key on one voice, so the release only
    // lands when the last of them goes.
    if (voice !== undefined && !this._sounding(voice)) {
      this.store.audio?.jamStopVoice(0, voice);
    }
  }

  _cancelRelease(code) {
    const timer = this.releasing.get(code);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.releasing.delete(code);
    }
  }

  octaveDelta(d) {
    this.octave = Math.min(Math.max(this.octave + d, 0), 9);
  }

  /** Step the keyboard transposition, clamped to two digits either way —
   *  anything wider is what the octave keys are for. */
  transposeDelta(d) {
    this.transpose = Math.min(Math.max(this.transpose + d, -TRANSPOSE_MAX), TRANSPOSE_MAX);
  }
}
