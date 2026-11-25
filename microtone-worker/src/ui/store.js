// App state + tiny event emitter. Topics: "doc" (loaded/replaced),
// "edit" (dirty tags), "view", "cursor", "transport", "mutes", "fx2",
// "notation" (a lane's own notation),
// "keymap" (the jam layout or its settings), "octave" (the jam octave).

import {
  SharedSlot, encodeBlock, decodeBlock, encodeCueBlock, decodeCueBlock,
} from "./clipshare.js";
import { DEFAULT_KEYMAP, QUOTE_DEFAULT } from "./keymap.js";
import { envClipToJson, envClipFromJson } from "../doc/envedit.js";
import { LANE_FLAG_FX2 } from "../../core/format/lane-section.js";
import { presetForNotation, GM_DRUM_NOTATION } from "../../core/tuning/pitchtables.js";

/** Panes the Patterns view can hold — the fx2 flags are kept per pane INDEX so
 *  they survive the pane churn a viewport resize causes (pattern.js MAX_PANES).
 *  Four times that, because a split screen can hold FOUR Patterns views (items
 *  148.1, 335) and copy k's columns index from 16·k (its fx2Base). */
const FX2_PANES = 64;

export class Store {
  constructor() {
    this.doc = null;         // Document
    this.sync = null;        // DocSync
    this.undo = null;        // UndoStack
    this.audio = null;       // AudioSystem
    this.songIndex = 0;
    // The FOCUSED pane's view — what the keyboard is talking to. `views` is
    // every open pane's view in pane order (items 148, 335: one to four).
    this.view = "timeline";
    this.views = ["timeline"];
    this.fileName = null;
    /** The folder of the File view's local list the open project was opened
     *  from or saved to ("" the top; "A/B" nested). `fileName` stays the bare
     *  name, which is what every export and the status bar want; `localPath`
     *  is the two together, which is what OPFS wants. */
    this.folder = "";
    /** Where the open document lives online, if it does: { doc, id, etag } —
     *  the project it was opened from or last saved to, and the ETag the next
     *  save must quote. Read it through `onlineProject`, which checks `doc`:
     *  loading anything else retires it without every load path having to
     *  remember. Only a local Save As (same document, new home) clears it. */
    this.online = null;
    /** Follow: the FOCUSED pane's (item 381) — app.js replaces this field
     *  with an accessor onto the split view's panes once it has them. */
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
    /** Ghost cells in the two grids — the pattern-ditto repeats and the bend
     *  trails, both of which say "nothing is written here, but this is what
     *  plays". One switch for both: they are the same statement, and a reader
     *  who wants the grid to show only what was typed wants neither. Default
     *  on, and a view preference like the rest — never saved with the song. */
    this.ghosts = true;
    /** Absolute-pitch plot in the two grids (item 198.5): the contour behind
     *  the note and instrument cells, plus the register tab beside them. ON by
     *  default (item 324; app.js reads the browser's remembered choice over
     *  it). A view preference like `ghosts`: never saved with the song. */
    this.pitchPlot = true;
    /** The Timeline's cell width (item 254): 0 the full cell, 1 two slots
     *  (note/effect, volume/panning), 2 one (note/effect) — narrowcell.js. A
     *  view preference for MONITORING many lanes at once; never saved. */
    this.timelineCells = 0;
    /** The Timeline lane headers' wavescopes (item 358): each lane's own
     *  signal, for diagnosing what it plays. Off by default; a view
     *  preference, never saved. */
    this.laneScope = false;
    /** Where a narrow Timeline cell's cursor WANTS to be, and where it was
     *  last seated (narrowcell.js): a narrow slot shows a different column
     *  from row to row, so the column the cursor stands on follows the row,
     *  and the one it was put on is remembered to come back to. Null in a full
     *  cell. Shared by both panes' Timelines, as the cursor is. */
    this.cellSeat = null;
    this.cursor = { row: 0, ch: 0 }; // absolute song row + lane
    this.voiceMutes = new Array(64).fill(false); // per-lane mute (UI + engine)
    // Format v3's SECOND effect column (§5.5), exposed per lane (Timeline)
    // and per pane (Patterns). Hidden by default: most songs never use it, and
    // it costs six characters of a column that is already the widest thing on
    // screen. These two arrays are the TRANSIENT half — Show all / Hide all —
    // and are never saved; a lane's own setting, made from its header's menu,
    // is the song's, kept in the document's `sLan` section (file format
    // §9.19), and a lane it shows stays shown through Hide all.
    this.fx2Chans = new Array(64).fill(false);
    this.fx2Panes = new Array(FX2_PANES).fill(false);
    // The two block clipboards (item 17 cells, item 128 cue words) live in
    // shared slots rather than plain fields, so a copy made in one browser tab
    // pastes in another (item 158). They behave like ordinary properties.
    this._clip = new SharedSlot("microtone.clipboard", encodeBlock, decodeBlock);
    this._cueClip = new SharedSlot("microtone.cueClipboard", encodeCueBlock, decodeCueBlock);
    // The envelope clipboard (item 300): one envelope's shape, pasted onto
    // any envelope of any instrument — in this tab or another.
    this._envClip = new SharedSlot("microtone.envClipboard", envClipToJson, (d) => {
      const clip = envClipFromJson(d);
      if (clip === null) throw new Error("not an envelope");
      return clip;
    });
    this._subs = new Map();
    this.gen = 0; // emit() generation — see emit()
  }

  /** Pattern-cell block clipboard — shared across tabs. */
  get clipboard() { return this._clip.get(); }
  set clipboard(b) { this._clip.set(b ?? null); }

  /** Cue-word block clipboard (Cues view) — likewise. */
  get cueClipboard() { return this._cueClip.get(); }
  set cueClipboard(b) { this._cueClip.set(b ?? null); }

  /** Envelope clipboard (doc/envedit.js envClip) — likewise. */
  get envClipboard() { return this._envClip.get(); }
  set envClipboard(c) { this._envClip.set(c ?? null); }

  /** The open project's path in the local list (null before it has a name). */
  get localPath() {
    if (!this.fileName) return null;
    return this.folder ? `${this.folder}/${this.fileName}` : this.fileName;
  }

  /** `online`, while it still belongs to the open document. */
  get onlineProject() {
    return this.online !== null && this.online.doc === this.doc ? this.online : null;
  }

  /** Is `name` on screen in ANY pane? Fixtures that belong to a view rather
   *  than to the keyboard (the master strip, the instrument lookup) ask this
   *  instead of comparing against `view`. */
  viewOpen(name) { return this.views.includes(name); }

  // ── the second effect column ──
  /** Is the column exposed on lane `ch`? Only a v3 document HAS one. Shown
   *  when the song's own setting for the lane says so OR Show all is on. */
  fx2Chan(ch) {
    return this.wideCells() && (this.fx2Chans[ch] === true || this.fx2Saved(ch));
  }
  /** The song's own setting for lane `ch` (sLan, file format §9.19). */
  fx2Saved(ch) {
    return (this.doc?.laneFlags(this.songIndex, ch) & LANE_FLAG_FX2) !== 0;
  }
  /** …and the same question for Patterns-view pane `i`. */
  fx2Pane(i) { return this.wideCells() && this.fx2Panes[i] === true; }
  wideCells() { return this.doc?.wideCells === true; }

  /** Is it exposed ANYWHERE? Drives the toolbox button's on/off label, and the
   *  Patterns view's column-width budget. */
  fx2Any() {
    if (!this.wideCells()) return false;
    if (this.fx2Chans.some(Boolean) || this.fx2Panes.some(Boolean)) return true;
    const chans = this.doc?.channelCount ?? 0;
    for (let ch = 0; ch < chans; ch++) if (this.fx2Saved(ch)) return true;
    return false;
  }

  /** Is Show all in force anywhere? What the all-lanes switches offer to undo
   *  — a lane the song itself shows is not theirs to hide, so it must not
   *  keep them saying "Hide all" for ever. */
  fx2AllShown() {
    return this.wideCells() && (this.fx2Chans.some(Boolean) || this.fx2Panes.some(Boolean));
  }

  /** The lane header's Show/Hide: the song's own setting for the lane, saved
   *  with it (sLan). The transient flag follows, so Hide works on a lane Show
   *  all had opened as well. */
  toggleFx2Chan(ch) {
    const on = !this.fx2Chan(ch);
    this.doc?.setLaneFlag(this.songIndex, ch, LANE_FLAG_FX2, on);
    this.fx2Chans[ch] = on;
    this.emit("fx2");
  }

  toggleFx2Pane(i) {
    this.fx2Panes[i] = !this.fx2Panes[i];
    this.emit("fx2");
  }

  /** Show/hide the column EVERYWHERE — every lane and every pattern pane.
   *  The lanes' own settings are left alone: Hide all keeps a lane the song
   *  shows. */
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

  /** Re-push every lane's mute to the engine and repaint. Used when
   *  something has rewritten the whole array rather than toggled one lane —
   *  a lane insert shifts the mutes along with the patterns they belong to,
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
    // Bumped on EVERY topic: a view that caches pixels between frames (the
    // Timeline's rows while playing) keys them on this, so anything anyone
    // announces invalidates them — the conservative side of a stale grid.
    this.gen++;
    const subs = this._subs.get(topic);
    if (subs) for (const fn of subs) fn(payload);
  }

  get song() { return this.doc?.songs[this.songIndex] ?? null; }

  // ── notations of a lane and an instrument (item 374) ──
  // The song has a notation (`pitchPreset`); a lane may have its own (sLan)
  // and so may an instrument (INtn), and a drum kit that says nothing gets the
  // General MIDI drum names. A note is spelled, and typed, in its
  // instrument's notation, else its lane's, else the song's.

  /** The preset for notation index `value` in the open document — the song's
   *  own object when it is the song's, and one object per index otherwise
   *  (a custom notation is rebuilt from `nota` each time it is asked for, so
   *  this keeps the grids from rebuilding it per cell). */
  presetOf(value) {
    const doc = this.doc;
    if (!doc) return this.pitchPreset;
    if (value === (doc.meta.songMeta[this.songIndex]?.notation ?? 120) && this.pitchPreset) return this.pitchPreset;
    const nota = doc.projSections.find((x) => x.fourcc === "nota")?.payload ?? null;
    const c = this._presetCache;
    if (!c || c.doc !== doc || c.nota !== nota || c.wide !== doc.wideCells) {
      this._presetCache = { doc, nota, wide: doc.wideCells, map: new Map() };
    }
    const map = this._presetCache.map;
    let p = map.get(value);
    if (p === undefined) { p = presetForNotation(value, doc); map.set(value, p); }
    return p;
  }

  /** The notation index instrument `inst` (1…1023) gives its notes, or null
   *  when it leaves them to the lane and the song. */
  instNotationIndex(inst) {
    const doc = this.doc;
    if (!doc || !(inst > 0)) return null;
    const own = doc.instNotation(inst);
    if (own === "follow") return null;
    if (own !== null) return own;
    return doc.isDrumKit(inst) ? GM_DRUM_NOTATION : null;
  }

  /** Lane `ch`'s own notation index, or null when it follows the song. */
  laneNotationIndex(ch) {
    return this.doc?.laneNotation(this.songIndex, ch) ?? null;
  }

  /** The preset a note on lane `ch`, played by instrument `inst` (0: none
   *  known), is spelled and entered in. The instruments' answers are kept
   *  until the next announcement (store.gen), since the grids ask per cell. */
  notationFor(ch, inst = 0) {
    if (!this.doc) return this.pitchPreset;
    if (inst > 0) {
      const c = this._instNotaCache;
      if (!c || c.gen !== this.gen || c.doc !== this.doc) this._instNotaCache = { gen: this.gen, doc: this.doc, map: new Map() };
      const map = this._instNotaCache.map;
      let v = map.get(inst);
      if (v === undefined) { v = this.instNotationIndex(inst); map.set(inst, v); }
      if (v !== null) return this.presetOf(v);
    }
    const lane = ch >= 0 ? this.laneNotationIndex(ch) : null;
    return lane !== null ? this.presetOf(lane) : this.pitchPreset;
  }

  /** The preset the jam keyboard plays instrument `inst` in: its own
   *  notation, else — on the Timeline — the cursor lane's, else the song's. */
  jamPreset(inst) {
    return this.notationFor(this.view === "timeline" ? this.cursor.ch : -1, inst);
  }

  /** Does any instrument of the open project have a notation — its own or
   *  a drum kit's? Lets a grid skip working out which instrument plays a note.
   *  Kept until the next announcement. */
  anyInstNotation() {
    const doc = this.doc;
    if (!doc) return false;
    if (this._anyInstNota?.gen === this.gen && this._anyInstNota.doc === doc) return this._anyInstNota.v;
    let v = false;
    for (const s of doc.selectableInstrumentSlots()) {
      if (this.instNotationIndex(s) !== null) { v = true; break; }
    }
    this._anyInstNota = { gen: this.gen, doc, v };
    return v;
  }

  /** Give lane `ch` its own notation (null: back to the song's). Saved with
   *  the song, no undo step — the song's notation has none either. */
  setLaneNotation(ch, value) {
    if (this.doc?.setLaneNotation(this.songIndex, ch, value)) {
      this.doc.dirty = true;
      this.emit("notation");
    }
  }

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
