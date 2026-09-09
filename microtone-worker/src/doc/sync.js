// DocSync — mirrors document edits into the worklet's playback copy, with the
// exact strategy taut.js proved out against the TSVM device:
//   cues     → eager  (uploadCue on every edit)
//   scalars  → eager  (setBPM / setTickRate / volumes / flags)
//   patterns → lazy   (dirty set, bulk-flushed right before playback starts)
// A full document (re)load pushes everything (audio-system.loadDocument).

export class DocSync {
  constructor(audio, doc, songIndex = 0) {
    this.audio = audio;
    this.doc = doc;
    this.songIndex = songIndex;
    this.dirtyPatterns = new Set();
  }

  /** Push the whole current song to the worklet (load / song switch). */
  loadAll() {
    this.dirtyPatterns.clear();
    this.audio.loadDocument(
      { // adapt Document → the parsed shape loadDocument expects
        is64Channel: this.doc.is64Channel,
        // The cell layout has to reach the engine before the patterns do.
        fmtVer: this.doc.fmtVer,
        sampleInstImage: this.doc.sampleInstImage,
        songs: this.doc.songs.map((s, i) => i === this.songIndex ? {
          bpm: s.bpm, tickRate: s.tickRate, globalFlags: s.globalFlags,
          globalVolume: s.globalVolume, mixingVolume: s.mixingVolume,
          tuningBaseNote: s.tuningBaseNote, tuningFreq: s.tuningFreq,
          surroundModel: s.surroundModel,
          mastering: this.doc.mastering(this.songIndex),
          patterns: s.patterns.map((_, p) => this.doc.patternBytes(this.songIndex, p)),
          cues: s.cues,
        } : null),
        ixmp: this.doc.ixmp,
      },
      this.songIndex,
    );
  }

  /** Route an op's dirty tags to the device-sync strategy. */
  onDirty(tags) {
    for (const tag of tags) {
      if (tag.song !== undefined && tag.song !== this.songIndex) continue;
      switch (tag.kind) {
        case "pattern":
          this.dirtyPatterns.add(tag.pat);
          break;
        case "cue":
          this.audio.uploadCue(tag.cue, this.doc.cueBytes(this.songIndex, tag.cue));
          break;
        case "format":
          // The cell layout changed under the whole project (v2 → v3): the
          // worklet must be told before it reads another pattern byte, so this
          // is a full reload rather than a dirty set.
          this.loadAll();
          break;
        case "resync":
          // A structural pattern remap (cleanup / renumber, item 60) rewrote
          // every pattern index + cue word: re-push all patterns (lazily) + cues.
          this.resyncSong();
          break;
        case "scalar":
          this.pushScalar(tag.key);
          break;
        case "mastering":
          // Eager, like the scalars: the chain is part of how the song sounds,
          // so a control moved during playback has to be audible at once —
          // that is the whole point of having the meters on screen beside it.
          this.audio.setMastering(0, this.doc.mastering(this.songIndex));
          break;
        case "inst":
          // Instruments sync eagerly — jam must always hear the current edit.
          this.audio.uploadInstrument(tag.slot, this.doc.instRecordBytes(tag.slot));
          break;
        case "ixmp": {
          // Ixmp patch edit (Advanced Edit): eagerly re-upload the slot's
          // patch blob — an empty blob clears the engine's patch state.
          const e = [...this.doc.ixmp].reverse()
            .find((x) => (x.instId & 0x3ff) === tag.slot);
          this.audio.uploadInstrumentPatches(tag.slot, e ? e.blob : new Uint8Array(0));
          break;
        }
        case "bank":
          // Bank import/undo touches the sample pool + many inst records +
          // Ixmp patches at once: re-upload the whole image (which clears all
          // patch state in the engine) then every patch blob, mirroring the
          // loadDocument order.
          this.doc._rebuildInstRegion();
          if (this.doc.sampleInstImage) {
            this.audio.uploadSampleInstImage(this.doc.sampleInstImage);
            for (const e of this.doc.ixmp) {
              this.audio.uploadInstrumentPatches(e.instId, e.blob);
            }
          }
          break;
      }
    }
  }

  pushScalar(key) {
    const s = this.doc.songs[this.songIndex];
    switch (key) {
      case "bpm": this.audio.setBPM(0, s.bpm); break;
      case "tickRate": this.audio.setTickRate(0, s.tickRate); break;
      case "globalVolume": this.audio.setSongGlobalVolume(0, s.globalVolume); break;
      case "mixingVolume": this.audio.setSongMixingVolume(0, s.mixingVolume); break;
      case "globalFlags": this.audio.setTrackerMixerFlags(0, s.globalFlags); break;
      case "surroundModel": this.audio.setSurroundModel(0, s.surroundModel); break;
      // Either tuning field retunes the whole song (item 77): push the pair.
      case "tuningBaseNote":
      case "tuningFreq":
        this.audio.setTuning(0, s.tuningBaseNote, s.tuningFreq);
        break;
    }
  }

  /**
   * Re-push every pattern (lazily) + cue after a structural remap (item 60).
   *
   * A row delete (item 136.2) can make the cue list SHORTER, and the engine
   * keeps one persistent cueSheet — so this runs past the end of the new list,
   * up to the highest cue the engine has ever been given. cueBytes() serves the
   * all-empty image for those, which is what blanks them.
   */
  resyncSong() {
    const s = this.doc.songs[this.songIndex];
    for (let p = 0; p < s.patterns.length; p++) this.dirtyPatterns.add(p);
    const end = Math.max(s.cues.length, this.audio.cueHighWater ?? 0);
    for (let c = 0; c < end; c++) {
      this.audio.uploadCue(c, this.doc.cueBytes(this.songIndex, c));
    }
  }

  /** Flush lazily-dirty patterns; call right before starting playback. */
  flushPatterns() {
    for (const pat of this.dirtyPatterns) {
      this.audio.uploadPattern(pat, this.doc.patternBytes(this.songIndex, pat));
    }
    this.dirtyPatterns.clear();
  }
}
