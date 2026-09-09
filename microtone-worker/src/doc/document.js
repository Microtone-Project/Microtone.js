// Document — the canonical, fully-decoded project model owned by the main
// thread. The worklet holds a playback copy fed by upload commands (sync.js);
// the .taud container is (de)serialised by src/format/. Pattern cells reuse
// the engine's TaudPlayData codec so byte round-trips are exact.

import { TaudPlayData } from "../engine/state.js";
import { decodeInstWord, INST_PATLEN, INST_HALTAT, INST_HALT, INST_GOBACK, INST_SKIP, INST_JUMP } from "../engine/state.js";
import { TaudInst, parsePatchesBlob } from "../engine/inst.js";
import {
  CUE_EMPTY, MAX_VOICES, NUM_VOICES, PATTERN_SIZE, PATTERN_SIZE_WIDE, SAMPLEBIN_SIZE,
  TAUD_VERSION_WIDE,
} from "../format/taud-const.js";
import { emptyPatternBytes } from "./patterntools.js";
import { widenPattern } from "./upgrade.js";
import { parseNotaPayload, defToPreset, slotForNotationValue } from "./notation.js";
import {
  MASTERING_FOURCC, parseMasteringSection, buildMasteringSection,
} from "../format/mastering-section.js";
import { defaultMastering } from "../engine/mastering.js";
import { parseRegionPayload } from "./sampleregions.js";
import { cueInstructionWords } from "../format/taud-parse.js";
import { writeTaud } from "../format/taud-write.js";

// Cells are decoded with the ENGINE's codec, in whichever of its two layouts
// the file declares (format version 3 = the 16-byte wide cell, §5.5), so a
// round-trip through the document is byte-exact in both.
function decodePattern(bytes, wide = false) {
  const rows = new Array(64);
  const size = wide ? 16 : 8;
  for (let r = 0; r < 64; r++) {
    const cell = new TaudPlayData();
    for (let b = 0; b < size; b++) {
      if (wide) cell.setByteWide(b, bytes[r * size + b]);
      else cell.setByte(b, bytes[r * size + b]);
    }
    rows[r] = cell;
  }
  return rows;
}

function encodePattern(rows, wide = false) {
  const size = wide ? 16 : 8;
  const bytes = new Uint8Array(wide ? PATTERN_SIZE_WIDE : PATTERN_SIZE);
  for (let r = 0; r < 64; r++) {
    for (let b = 0; b < size; b++) {
      bytes[r * size + b] = wide ? rows[r].getByteWide(b) : rows[r].getByte(b);
    }
  }
  return bytes;
}

/**
 * Every pool span a sampleList() census entry occupies: [{ptr, len, chan}],
 * channel 0 first. A mono sample yields one span; a stereo pair (Ixmp 's')
 * yields two. Anything that frees, moves, copies or edits pool bytes for a
 * census entry must go through this — freeing only channel 0 would leave the
 * right channel as unreachable garbage, and moving only channel 0 would break
 * the pairing.
 */
export function sampleSpans(e) {
  const extra = e.chanPtrs ?? [];
  return [
    { ptr: e.ptr, len: e.len, chan: 0 },
    ...extra.map((p, i) => ({ ptr: p, len: e.len, chan: i + 1 })),
  ];
}

/** True when a census entry is a stereo pair. */
export function isStereoSample(e) {
  return (e?.chanPtrs?.length ?? 0) === 1;
}

/** Decode a cue's instruction words into {rowLimit, isHalt, flow:{type,arg}|null}. */
export function cueInfo(words) {
  const [w0, w1] = cueInstructionWords(words);
  const i0 = decodeInstWord(w0);
  const i1 = decodeInstWord(w1);
  const rowsOf = (i) => (i.type === INST_PATLEN || i.type === INST_HALTAT ? i.rows : 64);
  const isFlow = (i) => i.type === INST_GOBACK || i.type === INST_SKIP || i.type === INST_JUMP;
  return {
    inst0: i0,
    inst1: i1,
    rowLimit: Math.min(rowsOf(i0), rowsOf(i1)),
    isHalt: i0.type === INST_HALT || i0.type === INST_HALTAT ||
            i1.type === INST_HALT || i1.type === INST_HALTAT,
    flow: isFlow(i0) ? i0 : isFlow(i1) ? i1 : null,
  };
}

export class Song {
  /** @param wide the file's cell layout (format version 3). */
  constructor(parsedSong, wide = false) {
    this.numVoices = parsedSong.numVoices;
    this.bpm = parsedSong.bpm;
    this.tickRate = parsedSong.tickRate;
    this.tuningBaseNote = parsedSong.tuningBaseNote;
    this.tuningFreq = parsedSong.tuningFreq;
    this.globalFlags = parsedSong.globalFlags;
    /** Surround model (#998): 0 stereo, 1 planar (360°), 2 spatial. */
    this.surroundModel = parsedSong.surroundModel ?? 0;
    this.globalVolume = parsedSong.globalVolume;
    this.mixingVolume = parsedSong.mixingVolume;
    /** @type {TaudPlayData[][]} 64 cells per pattern */
    this.patterns = parsedSong.patterns.map((p) => decodePattern(p, wide));
    /** @type {Uint16Array[]} raw u16 channel words per cue (64-wide) */
    this.cues = parsedSong.cues.map((w) => Uint16Array.from(w));
  }

  /** Index of the last cue with any content (pattern refs or instruction bits). */
  lastUsedCue() {
    for (let c = this.cues.length - 1; c >= 0; c--) {
      const words = this.cues[c];
      for (let ch = 0; ch < MAX_VOICES; ch++) {
        if (words[ch] !== CUE_EMPTY) return c;
      }
    }
    return 0;
  }

  /**
   * Every pattern number the song claims — referenced by a cue, or materialised
   * in the pattern list. Item 48 makes those two independent: an index can be
   * referenced without ever having been materialised, and a materialised one can
   * sit unreferenced, so "free" has to mean neither.
   */
  usedPatternNumbers() {
    const used = new Set();
    for (const w of this.cues) {
      for (let ch = 0; ch < MAX_VOICES; ch++) {
        const p = w[ch] & 0x7fff;
        if (p !== CUE_EMPTY) used.add(p);
      }
    }
    for (let p = 0; p < this.patterns.length; p++) if (this.patterns[p]) used.add(p);
    return used;
  }

  /** Lowest pattern number nothing claims, or -1 when exhausted. */
  firstFreePattern() {
    return this.freePatternNumbers(1)[0] ?? -1;
  }

  /** The `count` lowest unclaimed pattern numbers, ascending — what "New
   *  pattern" hands out when it is filling a whole block of empty slots and
   *  each one wants its own. Short when the address space runs out. */
  freePatternNumbers(count) {
    const used = this.usedPatternNumbers();
    const out = [];
    for (let n = 0; n <= 0x7ffe && out.length < count; n++) {
      if (!used.has(n)) out.push(n);
    }
    return out;
  }

  /**
   * Linear song map for the Timeline: sequential cues 0..lastUsedCue with each
   * cue's effective row count (flow instructions are shown, not followed).
   * Returns { entries: [{cue, startRow, rowLimit, info}], totalRows }.
   */
  songMap() {
    const entries = [];
    let startRow = 0;
    const last = this.lastUsedCue();
    for (let c = 0; c <= last; c++) {
      const info = cueInfo(this.cues[c]);
      entries.push({ cue: c, startRow, rowLimit: info.rowLimit, info });
      startRow += info.rowLimit;
    }
    return { entries, totalRows: startRow };
  }
}

/**
 * Combine a .tpif (patterns/cues/sMet only — the song domain) with an
 * instrument bank into a full parsed shape for `new Document()`. Mirrors the
 * device flow where a .tpif loads over the RESIDENT sample+inst state
 * (taud.mjs:173): the bank contributes the image, Ixmp and INam/SNam names;
 * everything else (songs, sMet, xHDR channel mode, …) comes from the .tpif.
 * `bank` is either a parsed .tsii/.taud or a live Document (whose image must
 * be up to date — call _rebuildInstRegion() first). The image is copied so
 * the combined document never aliases the bank's.
 */
export function combineTpif(bank, tpif) {
  const isBankSec = (s) => ["INam", "SNam", "Ixmp", "SRgn"].includes(s.fourcc);
  return {
    kind: "taud",
    fmtVer: tpif.fmtVer,
    is64Channel: tpif.is64Channel,
    signature: tpif.signature,
    sampleInstImage: bank.sampleInstImage ? bank.sampleInstImage.slice() : null,
    songs: tpif.songs,
    projSections: [
      ...tpif.projSections.filter((s) => !isBankSec(s)),
      ...(bank.projSections ?? []).filter(isBankSec),
    ],
    ixmp: bank.ixmp ?? [],
    meta: tpif.meta,
  };
}

export class Document {
  /** Build from the structure parseTaud returns. */
  constructor(parsed) {
    this.kind = parsed.kind;
    this.fmtVer = parsed.fmtVer;
    /** Format version 3's 16-byte cell (§5.5) — a whole-FILE property, so the
     *  document holds one flag and every song in it is read the same way. */
    this.wideCells = (parsed.fmtVer ?? 2) >= TAUD_VERSION_WIDE;
    this.is64Channel = parsed.is64Channel;
    this.signature = parsed.signature;
    this.sampleInstImage = parsed.sampleInstImage; // Uint8Array(8650752) | null
    this.songs = parsed.songs.map((s) => new Song(s, this.wideCells));
    this.projSections = parsed.projSections.map((s) => ({
      fourcc: s.fourcc,
      payload: Uint8Array.from(s.payload),
    }));
    this.ixmp = parsed.ixmp.map((e) => ({
      instId: e.instId,
      count: e.count,
      blob: Uint8Array.from(e.blob),
    }));
    this.meta = {
      projectName: parsed.meta.projectName,
      songMeta: structuredClone(parsed.meta.songMeta),
    };
    this.dirty = false; // unsaved-changes flag (ops set it; save clears it)

    this._instruments = null;     // lazily-decoded TaudInst[1024]
    this._instrumentsEdited = false; // when true, toBytes rebuilds the inst region
    this._editedSlots = new Set();   // ONLY these slots rebuild — the decode
                                     // masks quirk bits (e.g. byte 173 & 0x1f),
                                     // so untouched records must stay verbatim
    this.smetEdited = false;      // when true, toBytes regenerates the sMet section
  }

  get channelCount() { return this.is64Channel ? MAX_VOICES : NUM_VOICES; }

  /** The 8 MB sample pool region of the image (view, not a copy). */
  get sampleBin() {
    return this.sampleInstImage?.subarray(0, SAMPLEBIN_SIZE) ?? null;
  }

  /**
   * Decoded instruments (TaudInst[1024], engine class) with Ixmp patches
   * attached — decoded lazily from the image. Instrument-scope ops mutate
   * these; toBytes()/instRecordBytes() regenerate the byte view.
   */
  get instruments() {
    if (this._instruments === null) {
      const insts = new Array(1024);
      const usedSlots = new Set();
      const instRegion = this.sampleInstImage?.subarray(SAMPLEBIN_SIZE) ?? null;
      const rec = new Uint8Array(256);
      for (let s = 0; s < 1024; s++) {
        const inst = new TaudInst(s);
        if (instRegion !== null) {
          const raw = instRegion.subarray(s * 256, (s + 1) * 256);
          rec.set(raw);
          inst.loadRecord(rec);
          if (!raw.every((b) => b === 0)) usedSlots.add(s);
        }
        insts[s] = inst;
      }
      for (const e of this.ixmp) {
        const patches = parsePatchesBlob(e.blob);
        if (patches.length > 0) {
          insts[e.instId & 0x3ff].extraPatches = patches;
          usedSlots.add(e.instId & 0x3ff);
        }
      }
      this._instruments = insts;
      this._usedSlots = usedSlots;
    }
    return this._instruments;
  }

  /** Slots (0..1023) with content, ascending. Ops add edited slots via markInstUsed. */
  usedInstrumentSlots() {
    this.instruments; // ensure decoded
    return [...this._usedSlots].sort((a, b) => a - b);
  }

  /** Slots referenced as a layer of some metainstrument (its sub-instruments).
   *  The editor never lets you select these directly (item 59) — they are
   *  components of a metainstrument, not standalone playable instruments. */
  metaChildSlots() {
    const kids = new Set();
    for (const s of this.usedInstrumentSlots()) {
      const layers = this.instruments[s]?.metaLayers;
      // A muted FM operator (index 0) is a hole in a rack, not a child — the
      // rack keeps the row so the algorithm's numbering survives (§7.6).
      if (layers) for (const l of layers) if (l.instIdx >= 1) kids.add(l.instIdx & 0x3ff);
    }
    return kids;
  }

  /** Selectable (top-level) instrument slots: used slots minus meta children. */
  selectableInstrumentSlots() {
    const kids = this.metaChildSlots();
    return this.usedInstrumentSlots().filter((s) => !kids.has(s));
  }

  markInstUsed(slot) {
    this.instruments;
    this._usedSlots.add(slot & 0x3ff);
    this._editedSlots.add(slot & 0x3ff);
    this._instrumentsEdited = true;
  }

  /** Set/replace a Project-Data section payload; null removes the section. */
  setSection(fourcc, payload) {
    const i = this.projSections.findIndex((s) => s.fourcc === fourcc);
    if (payload === null) {
      if (i >= 0) this.projSections.splice(i, 1);
    } else if (i >= 0) {
      this.projSections[i] = { fourcc, payload };
    } else {
      this.projSections.push({ fourcc, payload });
    }
  }

  /** 0x1E-separated name-table lookup (INam / SNam / pNam). */
  _nameTable(fourcc) {
    const sec = this.projSections.find((s) => s.fourcc === fourcc);
    if (!sec) return [];
    const dec = new TextDecoder();
    const parts = [];
    let start = 0;
    for (let i = 0; i <= sec.payload.length; i++) {
      if (i === sec.payload.length || sec.payload[i] === 0x1e) {
        parts.push(dec.decode(sec.payload.subarray(start, i)));
        start = i + 1;
      }
    }
    return parts;
  }

  instrumentName(slot) { return this._nameTable("INam")[slot] ?? ""; }
  sampleName(index) { return this._nameTable("SNam")[index] ?? ""; }
  patternName(idx) { return this._nameTable("pNam")[idx] ?? ""; }

  /**
   * One of the four project strings (§9.2): "PNam" / "PCom" / "PCpr" / "PMsg",
   * decoded as UTF-8 up to the first NUL (the terminator is optional, so a
   * payload without one is taken whole). Returns null when the section is
   * absent, which callers distinguish from a section holding "".
   */
  projectString(fourcc) {
    const sec = this.projSections.find((s) => s.fourcc === fourcc);
    if (!sec) return null;
    const nul = sec.payload.indexOf(0);
    const end = nul < 0 ? sec.payload.length : nul;
    return new TextDecoder().decode(sec.payload.subarray(0, end));
  }

  /**
   * Sample-pool regions from the "SRgn" section (item 175, §9.11): the long
   * recordings loaded into memory that no instrument claims, ascending by
   * pointer. Cached by payload identity like customNotations() — undo/redo
   * swaps the payload ref, which invalidates naturally.
   *
   * A region is editor state: it reserves and names pool bytes, and playback
   * never reads it. Everything that ALLOCATES or FREES pool bytes must consult
   * it, though, or the first byte of a 4 MB recording is where the next
   * imported drum hit lands.
   */
  sampleRegions() {
    const sec = this.projSections.find((s) => s.fourcc === "SRgn");
    const payload = sec ? sec.payload : null;
    if (!this._srgnCache || this._srgnCache.payload !== payload) {
      this._srgnCache = { payload, regions: payload ? parseRegionPayload(payload) : [] };
    }
    return this._srgnCache.regions;
  }

  /**
   * Every song's mastering chain (item 178, §9.12), as `{songIndex: params}`.
   * Cached by payload identity like customNotations() — undo/redo swaps the
   * payload ref, which invalidates naturally.
   */
  masteringMap() {
    const sec = this.projSections.find((s) => s.fourcc === MASTERING_FOURCC);
    const payload = sec ? sec.payload : null;
    if (!this._smstCache || this._smstCache.payload !== payload) {
      this._smstCache = { payload, map: payload ? parseMasteringSection(payload) : {} };
    }
    return this._smstCache.map;
  }

  /**
   * One song's mastering chain, never null: a song that declares none gets the
   * neutral chain, which is defined to change nothing. Callers therefore never
   * have to ask whether the section exists.
   */
  mastering(songIndex = 0) {
    return this.masteringMap()[songIndex] ?? defaultMastering();
  }

  /** The `sMst` payload this document WOULD carry with `params` installed on
   *  `songIndex` — null when that would leave every song neutral, which is how
   *  the section disappears again when a chain is reset. */
  masteringPayloadWith(songIndex, params) {
    return buildMasteringSection({ ...this.masteringMap(), [songIndex]: params });
  }

  /** Custom notation definitions from the "nota" section, cached by payload
   *  identity — undo/redo swaps the payload ref, invalidating naturally. */
  customNotations() {
    const sec = this.projSections.find((s) => s.fourcc === "nota");
    const payload = sec ? sec.payload : null;
    if (!this._notaCache || this._notaCache.payload !== payload) {
      this._notaCache = { payload, defs: payload ? parseNotaPayload(payload) : [] };
    }
    return this._notaCache.defs;
  }

  /** Preset for an sMet notation value in the custom range (65520..65535);
   *  null when the value is out of range or the slot is undefined here. */
  customPreset(value) {
    const slot = slotForNotationValue(value);
    if (slot < 0) return null;
    const def = this.customNotations().find((d) => d.slot === slot);
    return def ? defToPreset(def) : null;
  }

  /** Build a new name-table payload (`fourcc`) with `escaped` (ASCII,
   *  \uHHHH-escaped) at `index`. Untouched entries keep their exact bytes — the
   *  section is split on 0x1E at the byte level (not re-encoded) so imported
   *  names round-trip verbatim. Missing leading entries are padded empty. */
  _buildNameTable(fourcc, index, escaped) {
    const sec = this.projSections.find((s) => s.fourcc === fourcc);
    const src = sec ? sec.payload : new Uint8Array(0);
    const segs = [];
    let start = 0;
    for (let i = 0; i <= src.length; i++) {
      if (i === src.length || src[i] === 0x1e) { segs.push(src.slice(start, i)); start = i + 1; }
    }
    while (segs.length <= index) segs.push(new Uint8Array(0));
    segs[index] = new TextEncoder().encode(escaped);
    const total = segs.reduce((n, s) => n + s.length, 0) + (segs.length - 1);
    const out = new Uint8Array(Math.max(0, total));
    let off = 0;
    segs.forEach((s, i) => { if (i > 0) out[off++] = 0x1e; out.set(s, off); off += s.length; });
    return out;
  }

  buildSampleNames(index, escaped) { return this._buildNameTable("SNam", index, escaped); }
  buildInstrumentNames(slot, escaped) { return this._buildNameTable("INam", slot, escaped); }
  buildPatternNames(idx, escaped) { return this._buildNameTable("pNam", idx, escaped); }

  /**
   * Deduped sample census across base instruments + Ixmp patches, sorted by
   * pool pointer: [{ptr, len, rate, loopStart, loopEnd, loopMode, chanPtrs,
   * chanMode, users}]. SNam names map by pool order (converter emission order).
   * `patchOverrides` (Map slot → patches[]|null) substitutes a slot's Ixmp
   * patches WITHOUT applying them — the patch editor uses it to compute the
   * prospective census (and the SNam realignment it implies) before an edit.
   *
   * A MULTI-CHANNEL sample (Ixmp 's', item 90) is ONE census entry, keyed by
   * its first channel's span, with `chanPtrs` holding the extra channels'
   * pointers (same length/loop/rate). One sample = one name = one row in the
   * Samples view; every consumer that frees or moves pool bytes has to walk
   * `chanPtrs` too — allSpans() is the shorthand for that.
   */
  sampleList(patchOverrides = null) {
    const byKey = new Map();
    const add = (ptr, len, rate, loopStart, loopEnd, loopMode, user,
                 chanPtrs = [], chanMode = 0) => {
      if (len <= 0) return;
      const key = `${ptr}:${len}`;
      let e = byKey.get(key);
      if (!e) {
        e = { ptr, len, rate, loopStart, loopEnd, loopMode, chanPtrs, chanMode,
              users: new Set() };
        byKey.set(key, e);
      } else if (chanPtrs.length > e.chanPtrs.length) {
        // A span used both as a mono base sample and as a stereo patch's first
        // channel is stereo — the extra channels exist either way.
        e.chanPtrs = chanPtrs;
        e.chanMode = chanMode;
      }
      e.users.add(user);
    };
    for (const s of this.usedInstrumentSlots()) {
      const inst = this.instruments[s];
      if (!inst.isMeta) {
        add(inst.samplePtr, inst.sampleLength, inst.samplingRate,
            inst.sampleLoopStart, inst.sampleLoopEnd, inst.loopMode, s);
      }
      const patches = patchOverrides?.has(s) ? patchOverrides.get(s) : inst.extraPatches;
      if (patches !== null) {
        for (const p of patches) {
          add(p.samplePtr, p.sampleLength, p.samplingRate,
              p.loopStart, p.loopEnd, p.loopMode, s,
              p.hasChanBlock ? p.chanPtrs.slice(0, Math.max(0, p.chanCount - 1)) : [],
              p.chanMode ?? 0);
        }
      }
    }
    const list = [...byKey.values()].sort((a, b) => a.ptr - b.ptr);
    list.forEach((e, i) => { e.index = i; e.name = this.sampleName(i); e.users = [...e.users]; });
    return list;
  }

  /** 256-byte record for slot, regenerated from the decoded TaudInst. */
  instRecordBytes(slot) {
    const inst = this.instruments[slot & 0x3ff];
    const rec = new Uint8Array(256);
    for (let i = 0; i < 256; i++) rec[i] = inst.getByte(i);
    return rec;
  }

  /** Fold decoded-instrument edits back into the image's inst region —
   *  edited slots only, so unedited records round-trip byte-exact. */
  /** Drop the decoded-instrument cache so the next access re-decodes from the
   *  (possibly replaced) image; also clears pending-edit state. Used by bank-level
   *  ops that swap the whole image + Ixmp (import / cleanup). */
  _resetInstrumentCache() {
    this._instruments = null;
    this._instrumentsEdited = false;
    this._editedSlots.clear();
  }

  _rebuildInstRegion() {
    if (!this._instrumentsEdited || this.sampleInstImage === null) return;
    const instRegion = this.sampleInstImage.subarray(SAMPLEBIN_SIZE);
    for (const s of this._editedSlots) {
      instRegion.set(this.instRecordBytes(s), s * 256);
    }
    this._editedSlots.clear();
    this._instrumentsEdited = false;
  }

  /** Regenerate the sMet section from meta.songMeta (writer format of
   *  taud.mjs:555-570). Only called when metadata was edited, so unedited
   *  documents keep their original section bytes (byte-exact round trips). */
  _rebuildSMet() {
    if (!this.smetEdited) return;
    const enc = new TextEncoder();
    const out = [];
    const idxs = Object.keys(this.meta.songMeta).map(Number).sort((a, b) => a - b);
    for (const idx of idxs) {
      const m = this.meta.songMeta[idx];
      const sub = [
        m.notation & 0xff, (m.notation >>> 8) & 0xff,
        (m.beatPri | 0) & 0xff, (m.beatSec | 0) & 0xff,
        ...enc.encode(m.name ?? ""), 0,
        ...enc.encode(m.composer ?? ""), 0,
        ...enc.encode(m.copyright ?? ""), 0,
      ];
      out.push(idx & 0xff,
        sub.length & 0xff, (sub.length >>> 8) & 0xff,
        (sub.length >>> 16) & 0xff, (sub.length >>> 24) & 0xff,
        ...sub);
    }
    const payload = Uint8Array.from(out);
    const existing = this.projSections.findIndex((s) => s.fourcc === "sMet");
    if (existing >= 0) this.projSections[existing] = { fourcc: "sMet", payload };
    else this.projSections.push({ fourcc: "sMet", payload });
    this.smetEdited = false;
  }

  /**
   * Widen every pattern in the project to the version-3 cell (§5.5). Called
   * when the project first declares a surround model — see upgradeCellFormatOp,
   * which wraps this so it can be undone within the session.
   */
  upgradeToWideCells() {
    if (this.wideCells) return 0;
    let n = 0;
    for (const song of this.songs) {
      song.patterns = song.patterns.map((rows) => {
        if (!rows) return rows;
        n++;
        return decodePattern(widenPattern(encodePattern(rows, false)), true);
      });
    }
    this.fmtVer = TAUD_VERSION_WIDE;
    this.wideCells = true;
    this._emptyPattern = null; // its width just changed
    return n;
  }

  /** Re-serialise to .taud bytes (via the format layer). */
  toBytes() {
    this._rebuildInstRegion();
    this._rebuildSMet();
    return writeTaud({
      kind: this.kind,
      // The cell layout the patterns below are encoded in — without it the
      // writer would stride the bin as if they were 8-byte cells (§5.5).
      fmtVer: this.fmtVer,
      is64Channel: this.is64Channel,
      signature: this.signature,
      sampleInstImage: this.sampleInstImage,
      songs: this.songs.map((s) => ({
        numVoices: s.numVoices,
        bpm: s.bpm,
        tickRate: s.tickRate,
        tuningBaseNote: s.tuningBaseNote,
        tuningFreq: s.tuningFreq,
        globalFlags: s.globalFlags,
        globalVolume: s.globalVolume,
        mixingVolume: s.mixingVolume,
        surroundModel: s.surroundModel,
        // Null gaps (unmaterialised arbitrary-number patterns, item 48) serialise
        // as empty patterns — gzip compresses the sparsity.
        patterns: s.patterns.map((p) => (p ? encodePattern(p, this.wideCells) : emptyPatternBytes(this.wideCells))),
        cues: s.cues,
      })),
      projSections: this.projSections,
    });
  }

  /** Encode one pattern back to its 512-byte image (worklet sync). An index
   *  past the end (a just-undone append) or a null gap (item 48) serves the
   *  empty-cell image so the sync flush blanks the worklet's stale copy. */
  patternBytes(songIdx, patIdx) {
    const rows = this.songs[songIdx].patterns[patIdx];
    return rows ? encodePattern(rows, this.wideCells) : emptyPatternBytes(this.wideCells);
  }

  // ── item 48: arbitrary pattern numbers ──
  // Every pattern 0x0000..0x7FFE is conceptually available. The in-memory array
  // is grown (with `null` gaps — cheap) only when a pattern is actually EDITED;
  // gaps and the whole 0..length-1 range serialise as empty patterns (gzip
  // compresses the sparsity), so a song can reference/create any pattern number
  // without pre-creating the ones below it.

  /** Highest addressable pattern index (cue words are 15-bit, 0x7FFF = empty). */
  static get MAX_PATTERN() { return 0x7ffe; }

  /** The materialised pattern object at (songIdx, patIdx), or null (a gap /
   *  never-edited index). Read paths that want an editable-but-empty view use
   *  emptyPattern() instead. */
  patternAt(songIdx, patIdx) {
    return this.songs[songIdx].patterns[patIdx] ?? null;
  }

  /** Shared read-only empty pattern for displaying an unmaterialised index. */
  emptyPattern() {
    return (this._emptyPattern ??= decodePattern(emptyPatternBytes(this.wideCells), this.wideCells));
  }

  /** Materialise (songIdx, patIdx) so it can be edited: pad the array with null
   *  gaps up to patIdx, then fill patIdx with a fresh empty pattern (gaps stay
   *  null until they too are edited). Returns the pattern object. Idempotent —
   *  a no-op when the pattern already exists (so undo of an ordinary edit stays
   *  byte-exact). */
  ensurePattern(songIdx, patIdx) {
    const pats = this.songs[songIdx].patterns;
    for (let i = pats.length; i < patIdx; i++) pats[i] = null;
    if (!pats[patIdx]) pats[patIdx] = decodePattern(emptyPatternBytes(this.wideCells), this.wideCells);
    return pats[patIdx];
  }

  /** Parsed-shape view for offline rendering (offline-render.js) — includes
   *  any instrument edits (rebuilds the image inst region first). */
  toRenderable(songIndex) {
    this._rebuildInstRegion();
    const s = this.songs[songIndex];
    return {
      is64Channel: this.is64Channel,
      // The renderer has to read the cells in the layout they were written in.
      fmtVer: this.fmtVer,
      wideCells: this.wideCells,
      sampleInstImage: this.sampleInstImage,
      ixmp: this.ixmp,
      songs: this.songs.map((song, i) => i === songIndex ? {
        bpm: s.bpm, tickRate: s.tickRate, globalFlags: s.globalFlags,
        globalVolume: s.globalVolume, mixingVolume: s.mixingVolume,
        surroundModel: s.surroundModel,
        // The declared tuning (item 77) belongs here too: without it an offline
        // render falls back to the tracker default and every exported note is
        // off against what playback just sounded.
        tuningBaseNote: s.tuningBaseNote, tuningFreq: s.tuningFreq,
        // …and so does the mastering chain (item 178): an exported file is what
        // a conforming player would produce, and the chain is part of that.
        mastering: this.mastering(songIndex),
        patterns: s.patterns.map((_, p) => this.patternBytes(songIndex, p)),
        cues: s.cues,
      } : null),
    };
  }

  /** Encode one cue to its upload byte payload (worklet sync). An index past
   *  the end (a just-undone cue append) serves the all-empty image so the sync
   *  blanks the worklet's stale copy — mirrors patternBytes' empty fallback. */
  cueBytes(songIdx, cueIdx) {
    const words = this.songs[songIdx].cues[cueIdx];
    const chans = this.channelCount;
    const bytes = new Uint8Array(chans * 2);
    for (let ch = 0; ch < chans; ch++) {
      const w = words ? words[ch] : CUE_EMPTY;
      bytes[ch * 2] = w & 0xff;
      bytes[ch * 2 + 1] = (w >>> 8) & 0xff;
    }
    return bytes;
  }
}
