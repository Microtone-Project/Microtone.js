// App state + tiny event emitter. Topics: "doc" (loaded/replaced),
// "edit" (dirty tags), "view", "cursor", "transport", "mutes", "fx2".

import {
  SharedSlot, encodeBlock, decodeBlock, encodeCueBlock, decodeCueBlock,
} from "./clipshare.js";
import { DEFAULT_KEYMAP, QUOTE_DEFAULT } from "./keymap.js";

/** Panes the Patterns view can hold — the fx2 flags are kept per pane INDEX so
 *  they survive the pane churn a viewport resize causes (pattern.js MAX_PANES).
 *  Twice that, because a split screen can hold TWO Patterns views (item 148.1)
 *  and the second one's columns index from the halfway mark (its fx2Base). */
const FX2_PANES = 32;

export class Store {
  constructor() {
    this.doc = null;         // Document
    this.sync = null;        // DocSync
    this.undo = null;        // UndoStack
    this.audio = null;       // AudioSystem
    this.songIndex = 0;
    // The FOCUSED pane's view — what the keyboard is talking to. `views` is
    // every open pane's view in pane order (item 148: one entry, or two).
    this.view = "timeline";
    this.views = ["timeline"];
    this.fileName = null;
    this.follow = true;
    /** #998.3: monitor surround songs through the binaural head model. Default
     *  on — the stereo fold cannot render height at all. Stereo songs ignore it. */
    this.binaural = true;
    // The jam keyboard's layout, and the Quote key's action — app preferences,
    // not song state: they outlive the document, are never written to the
    // .taud, and keymaplib.js restores both from storage at boot.
    this.keymap = DEFAULT_KEYMAP;
    this.quoteKey = QUOTE_DEFAULT;
    /** Draw the keyboard in true columns rather than typewriter-staggered —
     *  for the ortholinear boards whose keys really are in columns. */
    this.keymapOrtho = false;
    this.cursor = { row: 0, ch: 0 }; // absolute song row + channel
    this.voiceMutes = new Array(64).fill(false); // per-channel mute (UI + engine)
    // Format v3's SECOND effect column (§5.5), exposed per channel (Timeline)
    // and per pane (Patterns). Hidden by default: most songs never use it, and
    // it costs six characters of a column that is already the widest thing on
    // screen. View state, not document state — nothing here is saved.
    this.fx2Chans = new Array(64).fill(false);
    this.fx2Panes = new Array(FX2_PANES).fill(false);
    // The two block clipboards (item 17 cells, item 128 cue words) live in
    // shared slots rather than plain fields, so a copy made in one browser tab
    // pastes in another (item 158). They behave like ordinary properties.
    this._clip = new SharedSlot("microtone.clipboard", encodeBlock, decodeBlock);
    this._cueClip = new SharedSlot("microtone.cueClipboard", encodeCueBlock, decodeCueBlock);
    this._subs = new Map();
  }

  /** Pattern-cell block clipboard — shared across tabs. */
  get clipboard() { return this._clip.get(); }
  set clipboard(b) { this._clip.set(b ?? null); }

  /** Cue-word block clipboard (Cues view) — likewise. */
  get cueClipboard() { return this._cueClip.get(); }
  set cueClipboard(b) { this._cueClip.set(b ?? null); }

  /** Is `name` on screen in ANY pane? Fixtures that belong to a view rather
   *  than to the keyboard (the master strip, the instrument lookup) ask this
   *  instead of comparing against `view`. */
  viewOpen(name) { return this.views.includes(name); }

  // ── the second effect column ──
  /** Is the column exposed on channel `ch`? Only a v3 document HAS one. */
  fx2Chan(ch) { return this.wideCells() && this.fx2Chans[ch] === true; }
  /** …and the same question for Patterns-view pane `i`. */
  fx2Pane(i) { return this.wideCells() && this.fx2Panes[i] === true; }
  wideCells() { return this.doc?.wideCells === true; }

  /** Is it exposed ANYWHERE? Drives the toolbox button's on/off label, and the
   *  Patterns view's column-width budget. */
  fx2Any() {
    if (!this.wideCells()) return false;
    return this.fx2Chans.some(Boolean) || this.fx2Panes.some(Boolean);
  }

  toggleFx2Chan(ch) {
    this.fx2Chans[ch] = !this.fx2Chans[ch];
    this.emit("fx2");
  }

  toggleFx2Pane(i) {
    this.fx2Panes[i] = !this.fx2Panes[i];
    this.emit("fx2");
  }

  /** Show/hide the column EVERYWHERE — every channel and every pattern pane. */
  setAllFx2(on) {
    this.fx2Chans.fill(on);
    this.fx2Panes.fill(on);
    this.emit("fx2");
  }

  /** Project switch: back to hidden, like the mutes (taut finishLoadCommon). */
  clearFx2() {
    this.fx2Chans.fill(false);
    this.fx2Panes.fill(false);
    this.emit("fx2");
  }

  setVoiceMute(ch, muted) {
    this.voiceMutes[ch] = muted;
    this.audio?.setVoiceMute(0, ch, muted);
  }

  toggleMute(ch) {
    this.setVoiceMute(ch, !this.voiceMutes[ch]);
    this.emit("mutes");
  }

  /** taut toggleSolo: mute everything but ch; when ch is ALREADY the solo
   *  (all others muted), unmute all instead. */
  toggleSolo(ch) {
    const n = this.doc?.channelCount ?? 64;
    let inSolo = true;
    for (let i = 0; i < n; i++) {
      if (i !== ch && !this.voiceMutes[i]) { inSolo = false; break; }
    }
    for (let i = 0; i < n; i++) this.setVoiceMute(i, inSolo ? false : i !== ch);
    this.emit("mutes");
  }

  /** Re-push every channel's mute to the engine and repaint. Used when
   *  something has rewritten the whole array rather than toggled one channel —
   *  a channel insert shifts the mutes along with the patterns they belong to,
   *  and its undo shifts them back. */
  syncVoiceMutes() {
    for (let i = 0; i < 64; i++) this.audio?.setVoiceMute(0, i, this.voiceMutes[i] === true);
    this.emit("mutes");
  }

  /** Song/project switch: clear all mutes (taut finishLoadCommon). */
  clearMutes() {
    for (let i = 0; i < 64; i++) {
      if (this.voiceMutes[i]) this.setVoiceMute(i, false);
    }
    this.emit("mutes");
  }

  on(topic, fn) {
    if (!this._subs.has(topic)) this._subs.set(topic, new Set());
    this._subs.get(topic).add(fn);
    return () => this._subs.get(topic).delete(fn);
  }

  emit(topic, payload) {
    const subs = this._subs.get(topic);
    if (subs) for (const fn of subs) fn(payload);
  }

  get song() { return this.doc?.songs[this.songIndex] ?? null; }

  /** Row-highlight divisions from the song's sMet (defaults 4/16). */
  beats() {
    const sm = this.doc?.meta.songMeta[this.songIndex];
    return {
      pri: sm?.beatPri > 0 ? sm.beatPri : 4,
      sec: sm?.beatSec > 0 ? sm.beatSec : 16,
    };
  }

  /**
   * Change them (item 136.1). They are sMet fields, so this is document
   * metadata — but like the notation selector and the song names it is written
   * straight rather than through the undo stack: sMet is regenerated wholesale
   * at save time (Document._rebuildSMet) and has no op of its own.
   *
   * Returns true when something changed, so a caller can skip the repaint.
   */
  setBeats(pri, sec) {
    const doc = this.doc;
    if (!doc) return false;
    const sm = doc.meta.songMeta[this.songIndex] ??
      (doc.meta.songMeta[this.songIndex] =
        { notation: 120, beatPri: 4, beatSec: 16, name: "", composer: "", copyright: "" });
    const p = clampByte(pri), s = clampByte(sec);
    if (sm.beatPri === p && sm.beatSec === s) return false;
    sm.beatPri = p;
    sm.beatSec = s;
    doc.smetEdited = true;
    doc.dirty = true;
    this.emit("edit");   // the two grids band their rows on these
    this.emit("status"); // …and the file is now unsaved
    return true;
  }
}

/** sMet stores each division in one byte, and 0 means "unset" (the reader falls
 *  back to 4/16), so the writable range starts at 1. */
function clampByte(v) {
  const n = Math.round(Number(v) || 0);
  return n < 1 ? 1 : n > 255 ? 255 : n;
}
