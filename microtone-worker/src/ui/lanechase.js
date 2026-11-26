// Where a lane stands at a row while the song is stopped (item 379): the
// control surface's motor fader and knob ring, which show the cursor lane's
// volume and position.
//
// While the song plays, the engine's own lane registers say it. Stopped, they
// say where the last play left the lane — or the power-on state, full volume
// and centre, when nothing has played — which is not the lane at the cursor:
// a lane the song turned down at row 0 read as full on row 1. What the song
// leaves a lane at on a row is the engine's CHASE (engine spec §15.1: the walk
// from the song start, slides, jumps and loops included), so that is what this
// asks — of an engine of its own. The live engine cannot be chased for it: a
// chase moves the playback position (which a stopped surface shows until Stop
// clears it) and ends a jam (a note being auditioned as it is typed).
//
// The engine is built from the document when first asked, and kept in step
// with edits as the live one is: an edited pattern or cue is uploaded again
// before the next chase, anything else builds it afresh. It exists only while
// a surface is attached (`release()`), since it holds a copy of the samples.

import { TaudEngine } from "../../core/engine/engine.js";
import { loadIntoEngine } from "../../core/audio/offline-render.js";
import { prepareEngineModule } from "../../core/engine/wasm-module.js";

export class LaneChase {
  /** `compile`: the page compiles the engine module off its thread first;
   *  tests pass `false` (Node compiles it on the spot). */
  constructor({ compile = true } = {}) {
    this.ready = !compile;
    this.compiling = null;
    this.eng = null;
    this.doc = null;
    this.songIndex = -1;
    this.dirtyPatterns = new Set();
    this.dirtyCues = new Set();
    this.at = null; // "cue,row" of the last chase
  }

  /** An edit's dirty tags (UndoStack's): what the next chase must see. */
  onDirty(tags) {
    if (!this.eng) return;
    for (const tag of tags) {
      if (tag.song !== undefined && tag.song !== this.songIndex) continue;
      if (tag.kind === "pattern") this.dirtyPatterns.add(tag.pat);
      else if (tag.kind === "cue") this.dirtyCues.add(tag.cue);
      // A tempo, a speed, a volume, an instrument, the cell layout, a
      // structural remap: rarer, and simplest to take afresh.
      else { this.release(); return; }
    }
    this.at = null;
  }

  /** Let the engine (and its memory) go; the next question builds it again. */
  release() {
    this.eng = null;
    this.doc = null;
    this.songIndex = -1;
    this.dirtyPatterns.clear();
    this.dirtyCues.clear();
    this.at = null;
  }

  /**
   * Lane `ch` as song `songIndex` of `doc` arrives at row `row` of cue `cue`:
   * `{vol, az, el}` in the units the live engine reports them (the snapshot's
   * SNAP_V_CHAN_*), or null while the engine module is still compiling.
   */
  lane(doc, songIndex, cue, row, ch) {
    const eng = this._engine(doc, songIndex);
    if (!eng) return null;
    const key = `${cue},${row}`;
    if (this.at !== key) {
      // The chase sets out from the song's own tempo, speed and volumes, as a
      // play does (app.js playFrom): the last chase left the walk's.
      const song = doc.songs[songIndex];
      eng.setBPM(0, song.bpm);
      eng.setTickRate(0, song.tickRate > 0 ? song.tickRate : 6);
      eng.setSongGlobalVolume(0, song.globalVolume);
      eng.setSongMixingVolume(0, song.mixingVolume);
      eng.chaseTrackerRow(0, cue, row);
      this.at = key;
    }
    return {
      vol: eng.getVoiceChannelVolume(0, ch),
      az: eng.getVoiceChannelAzimuth(0, ch),
      el: eng.getVoiceChannelElevation(0, ch),
    };
  }

  _engine(doc, songIndex) {
    if (!this.ready) {
      this.compiling ??= prepareEngineModule().then(() => { this.ready = true; });
      return null;
    }
    if (this.eng && (this.doc !== doc || this.songIndex !== songIndex)) this.release();
    if (!this.eng) {
      const eng = new TaudEngine();
      loadIntoEngine(eng, doc.toRenderable(songIndex), songIndex);
      this.eng = eng;
      this.doc = doc;
      this.songIndex = songIndex;
      this.dirtyPatterns.clear();
      this.dirtyCues.clear();
      return eng;
    }
    const eng = this.eng;
    for (const p of this.dirtyPatterns) eng.uploadPattern(p, doc.patternBytes(songIndex, p));
    this.dirtyPatterns.clear();
    for (const c of this.dirtyCues) eng.uploadCue(c, doc.cueBytes(songIndex, c));
    this.dirtyCues.clear();
    return eng;
  }
}
