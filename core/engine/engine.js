// TaudEngine as the page and the tests know it — the WebAssembly engine
// (wasm-engine.js) with its state visible under the names the JavaScript
// engine gave it: `eng.instruments[n].sampleLength`,
// `eng.playheads[0].trackerState.voices[v].envVolMix`, `ts.backgroundVoices`.
//
// Every one of those is a VIEW of the C engine's own records in the module's
// memory (wasm-reflect.js, from the compiler's struct layouts): reading one
// reads the engine, writing one writes it. Where the C port's records differ
// in shape from the JavaScript objects they replaced — an instrument's
// metainstrument table hangs off a pointer, a lane's cell format is a field
// of the one flattened playhead — the old name is kept by a getter here.
//
// The audio thread runs wasm-engine.js alone (core/engine/create.js); this
// file, and the layouts it loads, are for everything that looks inside. The
// JavaScript engine this class replaced is engine-js.js, kept while the C
// engine is still tested against it.

import { WasmTaudEngine, WasmPlayhead, WasmTrackerState } from "./wasm-engine.js";
import {
  ReflectMemory, defineStructFields, viewClass, extendView, fieldOffset, recordSize,
} from "./wasm-reflect.js";
import { SAMPLE_BIN_TOTAL, MAX_VOICES, TRACKER_CHUNK } from "./constants.js";
import {
  SURROUND_STEREO, SURROUND_SPATIAL, foldAzimuthToPan, voiceAzimuth, voiceElevation,
} from "./spatial.js";
import { imixBlockMap } from "./imix.js";
import {
  META_TYPE_FM, META_TIER_NONE, META_TIER_LOW, META_TIER_HIGH, INST_VOLENV8, metaTierOf, writePatchesBlob, layerNote,
} from "./inst.js";

const NUM_INST_SLOTS = 1025; // the 1024 bank slots and the audition slot

/** Define accessors for record `type` on `proto`, leaving alone the names
 *  `proto` ITSELF defines (its own getters win; an inherited convenience
 *  getter gives way to the real, writable field). */
function mixInRecord(proto, type, except = []) {
  const own = new Set([...Object.getOwnPropertyNames(proto), ...except]);
  const scratch = {};
  defineStructFields(scratch, type);
  for (const name of Object.getOwnPropertyNames(scratch)) {
    if (own.has(name)) continue;
    Object.defineProperty(proto, name, Object.getOwnPropertyDescriptor(scratch, name));
  }
}

/** What the JavaScript render targets called themselves, by the C bus's kind. */
const SPATIAL_RENDERER_NAMES = {
  0: () => "stereo",
  1: (model) => `binaural-${model === SURROUND_SPATIAL ? "3d" : "2d"}`,
  2: (model, bus) => `analysis-${SPEAKER_NAME_BY_COUNT[bus.spkCount] ?? "foa"}`,
  3: (model, bus) => `ambisonic${bus.numChannels === (bus.order + 1) ** 2 && bus.order > 0 ? "3d" : "2d"}-o${bus.order}`,
  4: (model, bus) => `speakers-${SPEAKER_NAME_BY_COUNT[bus.spkCount]}`,
};
const SPEAKER_NAME_BY_COUNT = { 4: "quad", 6: "5.1", 8: "7.1" };

// ── names the JavaScript objects had that the C records spell differently ──

extendView("TaudFormantState", {
  /** The glottal source when it is a chip channel — the OPL or the PSG state
   *  keyed with the note — or null when the record's sample sings. */
  src: {
    get() { return this.srcKind === 1 ? this.srcOpl : this.srcKind === 2 ? this.srcPsg : null; },
    configurable: true,
  },
});

extendView("TaudImixBus", {
  /** Every instrument slot sharing the bus, ascending (one, outside bus mode). */
  slots: {
    get() {
      const p = this.$mem.dv.getUint32(this.$ptr + fieldOffset("TaudImixBus", "slots"), true);
      return p === 0 ? [this.slot] : [...new Int32Array(this.$mem.buffer, p, this.nSlots)];
    },
    configurable: true,
  },
});

const cellNote = Object.getOwnPropertyDescriptor(viewClass("TaudCell").prototype, "note");
extendView("TaudCell", {
  /** The note as ONE number, word plus sixteenths (a wide cell's fine nibble),
   *  as TaudPlayData had it; the word alone is `noteWord`. */
  note: { get() { return cellNote.get.call(this) + this.noteFrac / 16; }, configurable: true },
  noteWord: { get() { return cellNote.get.call(this); }, configurable: true },
});

// ── an instrument ──

/** One instrument record's view, with the JavaScript TaudInst's derived
 *  properties (inst.js) read off the C record. */
class InstView extends viewClass("TaudInst") {
  /** The metainstrument's layer (or operator) table, or null. */
  get metaLayers() {
    const meta = this.meta;
    return meta === null ? null : meta.layers.slice(0, meta.count);
  }
  get metaStrict() { const m = this.meta; return m !== null && m.strict; }
  get metaType() { const m = this.meta; return m === null ? 0 : m.type; }
  /** An FM rack's decoded program (its words), or null. */
  get fmProgram() {
    const m = this.meta;
    return m !== null && m.type === META_TYPE_FM && m.hasProgram ? m.program.slice(0, m.programLen) : null;
  }
  get isMeta() { return this.meta !== null; }
  get isFm() { const m = this.meta; return m !== null && m.type === META_TYPE_FM; }
  get isOpl() { return this.opl !== null; }
  get isPsg() { return this.psg !== null; }
  get isFormant() { return this.formant !== null; }
  get chipPatch() { return this.opl ?? this.psg; }
  get metaTier() {
    if (this.opl !== null || this.psg !== null) return META_TIER_LOW;
    if (this.formant !== null) return META_TIER_HIGH;
    const m = this.meta;
    if (m !== null) return metaTierOf(m.type);
    return META_TIER_NONE;
  }
  get isHighMeta() { return this.metaTier === META_TIER_HIGH; }
  get isLowMeta() { return this.metaTier === META_TIER_LOW; }

  /** Byte 255 of the record: the mixing chain the instrument runs through. */
  get imixId() { const m = this.meta; return m !== null ? m.imixId : this.reserved[4]; }
  set imixId(v) {
    const m = this.meta;
    if (m !== null) m.imixId = v & 0xff; else this.reserved[4] = v & 0xff;
    this.$engine._x.tw_bump_imix_gen(this.$engine._e);
  }

  get isLyric() { return this.lyric !== null; }
  get sampleLoopSustain() { return (this.loopMode & 0x04) !== 0; }
  /** Byte 14 bit 6: the volume envelopes are 8-bit (file format §7.2). */
  get volEnv8() { return (this.loopMode & INST_VOLENV8) !== 0; }
  get isPercussion() {
    const m = this.meta;
    return m !== null ? (m.flags & 0x02) !== 0 : (this.loopMode & 0x10) !== 0;
  }
  /** The default position as a 9-bit azimuth: byte 177, and byte 14's bit 5 the ninth. */
  get defaultAzimuth() { return ((this.loopMode & 0x20) !== 0 ? 256 : 0) | (this.defaultPan & 0xff); }
  /** Default elevation, record byte 254, signed. */
  get defaultElevation() {
    const b = this.reserved[3] & 0xff;
    return b >= 0x80 ? b - 256 : b;
  }

  /** One byte of the record as it was last uploaded. */
  getByte(o) { return this.$engine._records[this.index * 256 + (o & 0xff)]; }
  /** Write one byte of the record: the record is uploaded again with that
   *  byte changed, which is how a host edits an instrument. */
  setByte(o, byte) {
    const eng = this.$engine;
    const at = this.index * 256;
    eng._records[at + (o & 0xff)] = byte & 0xff;
    eng.uploadInstrument(this.index, eng._records.subarray(at, at + 256));
  }

  /** Replace the Ixmp patches: null for none, or patches in inst.js's own
   *  shape (makeInstPatch), which are uploaded as a blob. */
  set extraPatches(patches) {
    if (patches === null) this.$engine.clearInstrumentPatches(this.index);
    else this.$engine.uploadInstrumentPatches(this.index, writePatchesBlob(patches));
  }

  /** The Ixmp patches, or null. */
  get extraPatches() {
    const n = this.patchCount;
    const p = this.$mem.dv.getUint32(this.$ptr + fieldOffset("TaudInst", "extraPatches"), true);
    if (p === 0 || n === 0) return null;
    const size = recordSize("TaudPatch");
    return Array.from({ length: n }, (_, i) => this.$mem.view("TaudPatch", p + i * size));
  }

  /** A lyric instrument's syllable patches, or null. */
  get lyric() {
    const p = this.$mem.dv.getUint32(this.$ptr + fieldOffset("TaudInst", "lyric"), true);
    const entry = this.lyricEntry;
    if (p === 0 || entry === null) return null;
    const size = recordSize("TaudFormantPatch");
    return Array.from({ length: entry.numSyllables }, (_, i) => this.$mem.view("TaudFormantPatch", p + i * size));
  }

  /** The S $Fx invert-loop bit mask, or null: the engine's own bytes, and the
   *  SAME array object for as long as the mask is the same one. */
  get invertMask() { return this._mask("invertMask", this.invertMaskLen); }
  /** notefx 2/3's inversion mask, likewise. */
  get modMask() { return this._mask("modMask", this.modMaskLen); }
  _mask(field, n) {
    const p = this.$mem.dv.getUint32(this.$ptr + fieldOffset("TaudInst", field), true);
    if (n <= 0 || p === 0) return null;
    const kept = this.$kept ?? (this.$kept = Object.create(null));
    const had = kept[field];
    if (had && had.byteOffset === p && had.length === n && had.buffer === this.$mem.buffer) return had;
    return (kept[field] = new Uint8Array(this.$mem.buffer, p, n));
  }

  get newNoteAction() {
    const n = (this.instrumentFlag & 0x03) | (((this.instrumentFlag >>> 5) & 1) << 2);
    return n <= 4 ? n : 0;
  }
  get nnaKeyLift() { return this.newNoteAction === 4; }
  get retrigFollowsNna() { return (this.instrumentFlag & 0x40) !== 0; }
  get vibratoWaveform() { return (this.instrumentFlag >>> 2) & 0x07; }
  get sampleDetuneSigned() {
    const v = this.sampleDetune & 0xffff;
    return v >= 0x8000 ? v - 0x10000 : v;
  }
  get duplicateCheckType() { return (this.dupCheckFlag & 0x03) | ((this.dupCheckFlag >>> 2) & 0x0c); }
  get duplicateCheckAction() { return ((this.dupCheckFlag >>> 2) & 0x03) | ((this.dupCheckFlag >>> 4) & 0x0c); }
  get filterSfMode() { return ((this.fadeoutHigh >>> 4) & 1) !== 0; }
  get defaultCutoff16() {
    if (this.cutoffOverride >= 0) return this.cutoffOverride;
    return this.filterSfMode ? ((this.defaultCutoff & 0xff) << 8) | (this.reserved[1] & 0xff) : this.defaultCutoff;
  }
  get defaultResonance16() {
    if (this.resonanceOverride >= 0) return this.resonanceOverride;
    return this.filterSfMode ? ((this.defaultResonance & 0xff) << 8) | (this.reserved[2] & 0xff) : this.defaultResonance;
  }
  get sourceSlots() {
    const out = [];
    const layers = this.metaLayers;
    if (layers !== null) for (const l of layers) if (l.instIdx >= 1) out.push(l.instIdx & 0x3ff);
    const f = this.formant;
    if (f !== null && f.srcInst >= 1) out.push(f.srcInst);
    return out;
  }

  // ── what the JavaScript TaudInst did to itself ──
  // (each one the C function of the same name; a default argument as inst.js had it)

  toggleInvertBit(loopOffset, loopLen = this.sampleLoopEnd - this.sampleLoopStart) {
    this.$engine._x.tw_inst_toggle_invert_bit(this.$engine._e, this.index, loopOffset, loopLen);
  }
  invertBit(loopOffset, loopLen = this.sampleLoopEnd - this.sampleLoopStart) {
    return this.$engine._x.tw_inst_invert_bit(this.$engine._e, this.index, loopOffset, loopLen) !== 0;
  }
  toggleModBit(i, sampleLen) { this.$engine._x.tw_inst_toggle_mod_bit(this.$engine._e, this.index, i, sampleLen); }
  modBit(i) { return this.$engine._x.tw_inst_mod_bit(this.$engine._e, this.index, i) !== 0; }
  setModRegion(from, to) { return this.$engine._x.tw_inst_set_mod_region(this.$engine._e, this.index, from, to) !== 0; }
  setModComb(bits, odd) { return this.$engine._x.tw_inst_set_mod_comb(this.$engine._e, this.index, bits, odd ? 1 : 0) !== 0; }
  setModOp(op, invert) { return this.$engine._x.tw_inst_set_mod_op(this.$engine._e, this.index, op, invert ? 1 : 0) !== 0; }
  setModOpExt(code, invert, f) {
    return this.$engine._x.tw_inst_set_mod_op_ext(this.$engine._e, this.index, code, invert ? 1 : 0, f) !== 0;
  }
  clearModState() { this.$engine._x.tw_inst_clear_mod_state(this.$engine._e, this.index); }
  resetMod() { this.$engine._x.tw_inst_reset_mod(this.$engine._e, this.index); }

  /** The Ixmp patch a note of this instrument plays, or null (inst.js). */
  resolvePatch(noteVal, rowVolume) {
    const patches = this.extraPatches;
    if (patches === null || this.opl !== null || this.psg !== null || this.formant !== null) return null;
    for (const p of patches) {
      if (noteVal >= p.pitchStart && noteVal <= p.pitchEnd &&
          rowVolume >= p.volumeStart && rowVolume <= p.volumeEnd) return p;
    }
    return null;
  }

  /** The layers a note of this metainstrument sounds (inst.js). */
  resolveMetaLayers(noteVal, rowVolume) {
    const layers = this.metaLayers;
    if (layers === null) return [];
    return layers.filter((l) => noteVal >= l.pitchStart && noteVal <= l.pitchEnd &&
      rowVolume >= l.volStart && rowVolume <= l.volEnd);
  }
}

// ── the playhead and its tracker state ──
// The C engine has ONE playhead, flattened into the engine record; both
// objects below view that record, each under the names its half had.

class TrackerStateView extends WasmTrackerState {
  constructor(eng) {
    super(eng);
    Object.defineProperty(this, "$mem", { value: eng.$mem });
    Object.defineProperty(this, "$ptr", { value: eng._e >>> 0 });
    Object.defineProperty(this, "$kept", { value: null, writable: true });
  }
  // The flattened record prefixes the two fields both halves had.
  get wideCells() { return this.ts_wideCells; }
  get surroundModel() { return this.ts_surroundModel; }
  /**
   * The surround object bus, or null for a stereo song: its channel count,
   * its data (channel-major, TRACKER_CHUNK frames a channel — a view of the
   * module's memory, the chunk just rendered) and the render target's name as
   * the JavaScript renderers named themselves.
   */
  get spatial() {
    const bus = this.$mem.view("TaudSpatialBus", this.$mem.dv.getUint32(this.$ptr + fieldOffset("TaudEngine", "spatial"), true));
    if (bus === null) return null;
    const mem = this.$mem;
    const model = this.ts_surroundModel;
    const nc = bus.numChannels;
    const dataAt = bus.$ptr + fieldOffset("TaudSpatialBus", "data");
    return {
      numChannels: nc,
      frames: TRACKER_CHUNK,
      get data() { return new Float64Array(mem.buffer, dataAt, nc * TRACKER_CHUNK); },
      renderer: { name: SPATIAL_RENDERER_NAMES[bus.kind]?.(model, bus) ?? `kind-${bus.kind}`, numChannels: nc },
    };
  }

  /** The instrument buses in use, ascending by their first slot. */
  get imixList() {
    const n = this.imixCount;
    const base = this.$mem.dv.getUint32(this.$ptr + fieldOffset("TaudEngine", "imixList"), true);
    const dv = this.$mem.dv;
    return Array.from({ length: n }, (_, i) => this.$mem.view("TaudImixBus", dv.getUint32(base + i * 4, true)));
  }

  /** The NNA ghosts, layer children and FM operators sounding now. */
  get backgroundVoices() {
    const n = this.bgCount;
    const base = this.$mem.dv.getUint32(this.$ptr + fieldOffset("TaudEngine", "bg"), true);
    const dv = this.$mem.dv;
    const list = new Array(n);
    for (let i = 0; i < n; i++) list[i] = this.$mem.view("TaudVoice", dv.getUint32(base + i * 4, true));
    return list;
  }
}
// `imixMeters` stays the base class's own (the seats' JavaScript side), not
// the C record's pointer pair of the same name.
mixInRecord(TrackerStateView.prototype, "TaudEngine", ["imixMeters"]);

class PlayheadView extends WasmPlayhead {
  constructor(eng) {
    super(eng, new TrackerStateView(eng));
    this.parent = eng;
    this.index = 0;
    Object.defineProperty(this, "$mem", { value: eng.$mem });
    Object.defineProperty(this, "$ptr", { value: eng._e >>> 0 });
    Object.defineProperty(this, "$kept", { value: null, writable: true });
  }
}
mixInRecord(PlayheadView.prototype, "TaudEngine");

// ── the engine ──

export class TaudEngine extends WasmTaudEngine {
  _makePlayhead() {
    this.$mem = new ReflectMemory(this._x.memory);
    this._instViews = null;
    this._records = new Uint8Array(NUM_INST_SLOTS * 256);
    this._patternViews = new Map();
    return new PlayheadView(this);
  }

  // The records as they were last uploaded: the C engine keeps what it
  // decoded, not the bytes, and a record edited a byte at a time (setByte) or
  // captured back (captureSampleInstImage) needs the bytes.
  uploadSampleInstBlob(image) {
    const n = super.uploadSampleInstBlob(image);
    if (n !== 0) {
      this._records.fill(0);
      const count = Math.min(1024, Math.trunc((image.length - SAMPLE_BIN_TOTAL) / 256));
      this._records.set(image.subarray(SAMPLE_BIN_TOTAL, SAMPLE_BIN_TOTAL + count * 256));
    }
    return n;
  }

  uploadInstrument(slot, bytes) {
    const at = (slot & 0x3ff) * 256;
    const rec = new Uint8Array(256);
    rec.set(bytes.length > 256 ? bytes.subarray(0, 256) : bytes);
    this._records.set(rec, at); // (a no-op copy when setByte hands the stored record back)
    super.uploadInstrument(slot, rec);
  }

  /** The raw sample+instrument image: the 8 MB pool, then the 1024 records as
   *  uploaded. */
  captureSampleInstImage() {
    const out = new Uint8Array(SAMPLE_BIN_TOTAL + 1024 * 256);
    out.set(this.sampleBin);
    out.set(this._records.subarray(0, 1024 * 256), SAMPLE_BIN_TOTAL);
    return out;
  }

  /** The pattern every unwritten slot reads as. */
  get emptyPattern() { return this._cells(this._x.tw_empty_pattern(this._e) >>> 0); }

  /** The 64 cell views at `p` — the same array for the same pattern. */
  _cells(p) {
    let cells = this._patternViews.get(p);
    if (cells === undefined) {
      const size = recordSize("TaudCell");
      cells = Object.freeze(Array.from({ length: 64 }, (_, r) => this.$mem.view("TaudCell", p + r * size)));
      this._patternViews.set(p, cells);
    }
    return cells;
  }

  /** True when metainstrument `inst` would sound at least one layer at `note`
   *  (engine.js _metaSoundsAt, read off the views). */
  _metaSoundsAt(inst, note) {
    if (inst.isFm) {
      const o = inst.metaLayers[0];
      return inst.fmProgram !== null && o.instIdx >= 1 &&
        note >= o.pitchStart && note <= o.pitchEnd && o.volStart <= 0x3f && o.volEnd >= 0x3f;
    }
    let layers = inst.resolveMetaLayers(note, 0x3f);
    if (inst.metaStrict) {
      layers = layers.filter((l) => {
        let n = layerNote(l, note);
        n = n < 0x20 ? 0x20 : n > 0xffff ? 0xffff : n;
        return this.instruments[l.instIdx].resolvePatch(n, 0x3f) !== null;
      });
    }
    return layers.length > 0;
  }

  /** Nearest note to `note` that metainstrument `instId` actually sounds, or −1. */
  _auditionNoteFor(instId, note) {
    const inst = this.instruments[instId];
    if (!inst || !inst.isMeta) return -1;
    let lo = 0xffff, hi = 0x20;
    for (const l of inst.metaLayers) {
      if (l.pitchStart < lo) lo = l.pitchStart;
      if (l.pitchEnd > hi) hi = l.pitchEnd;
    }
    if (lo < 0x20) lo = 0x20;
    if (hi < lo) return -1;
    for (let d = 0; d <= hi - lo; d += 0x20) {
      const up = note + d, dn = note - d;
      if (up >= lo && up <= hi && this._metaSoundsAt(inst, up)) return up;
      if (dn >= lo && dn <= hi && this._metaSoundsAt(inst, dn)) return dn;
    }
    return -1;
  }

  /** Bring the instruments' route table up to date now (the mixer does it at
   *  the top of a chunk); `trackerState.imixRoutes` then shows the buses. */
  syncImixRoutes() { this._x.tw_sync_imix_routes(this._e); }

  /** Every instrument slot (the 1024 of the bank and the audition slot). */
  get instruments() {
    if (this._instViews === null) {
      const base = this.$mem.dv.getUint32((this._e >>> 0) + fieldOffset("TaudEngine", "instruments"), true);
      const size = recordSize("TaudInst");
      const list = new Array(NUM_INST_SLOTS);
      for (let i = 0; i < NUM_INST_SLOTS; i++) {
        const v = new InstView(this.$mem, base + i * size);
        Object.defineProperty(v, "$engine", { value: this });
        list[i] = this.$mem.adopt("TaudInst", v);
      }
      this._instViews = Object.freeze(list);
    }
    return this._instViews;
  }

  /**
   * The whole 8 MB sample pool, writable. The engine keeps only the pool up to
   * its last non-zero byte; asking for this grows it to full size first, so a
   * test may poke samples in directly. A view on the module's memory: take it
   * afresh after anything that uploads.
   */
  get sampleBin() {
    const p = this._x.tw_sample_pool_full(this._e) >>> 0;
    if (!p) throw new Error("taud engine: out of memory");
    return new Uint8Array(this._x.memory.buffer, p, SAMPLE_BIN_TOTAL);
  }

  // ── per-voice readbacks (engine.js's, read off the views) ──

  _voice(ph, vi) {
    const v = Math.min(Math.max(vi, 0), MAX_VOICES - 1);
    return this.playheads[0].trackerState.voices[v];
  }

  getVoiceEffectiveVolume(ph, vi) {
    const v = this._voice(ph, vi);
    if (!v.active) return 0.0;
    const effEnvVol = v.hasVolEnv && v.volEnvOn ? v.envVolMix : 1.0;
    const faderGain = (255 - v.fader) / 255.0;
    return Math.min(Math.max(effEnvVol * v.fadeoutMix * v.currentMixVolume * faderGain, 0.0), 1.0);
  }

  /** Pan as the stereo meters want it: a surround voice reports where the
   *  monitor downmix puts it. */
  getVoiceEffectivePan(ph, vi) {
    const v = this._voice(ph, vi);
    if (!v.active) return 128;
    if (this.playheads[0].surroundModel !== SURROUND_STEREO) {
      return Math.round(foldAzimuthToPan(voiceAzimuth(v)));
    }
    if (v.hasPanEnv && v.panEnvOn) {
      const envPanRaw = Math.min(Math.max(Math.trunc(v.envPan * 255.0), 0), 255);
      return Math.min(Math.max(v.channelPan + v.notePan + envPanRaw - 128 + v.panbrelloOffset, 0), 255);
    }
    return Math.min(Math.max(v.channelPan + v.notePan + v.panbrelloOffset, 0), 255);
  }

  getVoiceSpatialAzimuth(ph, vi) {
    const v = this._voice(ph, vi);
    return this.playheads[0].surroundModel === SURROUND_STEREO
      ? Math.min(Math.max(v.channelPan + v.notePan + v.panbrelloOffset, 0), 255) : voiceAzimuth(v);
  }
  getVoiceSpatialElevation(ph, vi) {
    const v = this._voice(ph, vi);
    return this.playheads[0].surroundModel === SURROUND_STEREO ? 0 : voiceElevation(v);
  }

  getVoiceActive(ph, vi) { return this._voice(ph, vi).active; }
  getVoiceChannelVolume(ph, vi) { return this._voice(ph, vi).channelVolume; }
  getVoiceChannelAzimuth(ph, vi) {
    const v = this._voice(ph, vi);
    return this.playheads[0].surroundModel === SURROUND_STEREO ? v.channelPan : v.panAzimuth;
  }
  getVoiceChannelElevation(ph, vi) {
    const v = this._voice(ph, vi);
    return this.playheads[0].surroundModel === SURROUND_SPATIAL ? v.panElevation : 0.0;
  }
  getVoiceChannelVolumeSet(ph, vi) { return this._voice(ph, vi).channelVolumeSet; }
  getVoiceChannelPanSet(ph, vi) { return this._voice(ph, vi).channelPanSet; }

  getVoiceInvertSpeed(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.invertSpeed : 0; }
  getVoiceNote(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.noteVal & 0xffff : 0; }
  getVoiceInstrument(ph, vi) {
    const v = this._voice(ph, vi);
    return v.active ? (v.displayInst || v.instrumentId) & 0x3ff : 0;
  }
  getVoiceSamplePos(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.samplePos : -1.0; }
  getVoiceSamplePtr(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.activeSamplePtr : -1; }
  getVoiceSampleLength(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.activeSampleLength : 0; }
  getVoiceEnvVolIndex(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envIndex : -1; }
  getVoiceEnvVolTime(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envTimeSec : 0.0; }
  getVoiceEnvPanIndex(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envPanIndex : -1; }
  getVoiceEnvPanTime(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envPanTimeSec : 0.0; }
  getVoiceEnvPitchIndex(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envPitchIndex : -1; }
  getVoiceEnvPitchTime(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envPitchTimeSec : 0.0; }
  getVoiceEnvFilterIndex(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envFilterIndex : -1; }
  getVoiceEnvFilterTime(ph, vi) { const v = this._voice(ph, vi); return v.active ? v.envFilterTimeSec : 0.0; }

  // ── patterns, chains ──

  /** The 64 cells of pattern `idx` as the engine holds them (read-only). */
  patternRead(idx) { return this._cells(this._x.tw_pattern_read(this._e, idx) >>> 0); }

  /** The mixing chains installed, as setImix normalised them. */
  setImix(blocks) {
    this.imixBlocks = imixBlockMap(blocks);
    super.setImix(blocks);
  }
  getImix() { return [...(this.imixBlocks ?? new Map()).values()]; }

  /** Step the song by hand: the row event, then a tick pass, at the playhead. */
  applyTrackerRow() { this._x.tw_apply_tracker_row(this._e); }
  applyTrackerTick() { this._x.tw_apply_tracker_tick(this._e); }

  /** A change to the chains or to an instrument's byte 255, for a host that
   *  wrote one behind the engine's back (the JavaScript engine's counter). */
  get imixGen() { return this.playheads[0].trackerState.imixGen; }
  set imixGen(v) { this._x.tw_bump_imix_gen(this._e); }
}
