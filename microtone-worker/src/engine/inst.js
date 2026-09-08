// Taud instrument data model — port of AudioAdapter.kt TaudInstEnvPoint (5246),
// TaudInstPatch (5261), MetaLayer (5312), TaudInst (5378-5766).
// Envelope point `offset` is the ThreeFiveMiniUfloat LUT index (0..255);
// use minifloatToDouble(pt.offset) for seconds.

export function envPoint(value, offset = 0) {
  return { value, offset };
}

function makeEnv(defaultValue) {
  const a = new Array(25);
  for (let i = 0; i < 25; i++) a[i] = envPoint(defaultValue, 0);
  return a;
}

/**
 * One Ixmp "extra sample" patch — overlays sample-scope state on a base
 * instrument for a (noteVal, rowVolume) rectangle. Optional v/p/f/P/x blocks
 * additionally override envelopes and fadeout/cutoff/resonance; anything left
 * absent (null env / hasExtra=false) defers to the base TaudInst.
 * Sentinels: defaultPan 0xFF, defaultNoteVolume 0, vibratoWaveform 0xFF all
 * mean "inherit the base instrument's value".
 *
 * The 's' block (hasChanBlock) makes the patch MULTI-CHANNEL: every channel is
 * a separate pool span sharing this record's length / loop / rate geometry,
 * with `chanPtrs` holding the pointers for channels 2..chanCount (channel 1 is
 * samplePtr). Only stereo (chanCount 2) is played today; the format's
 * quadraphonic/ambisonic cases are TODO #998.
 */
export function makeInstPatch(fields) {
  return {
    pitchStart: 0, pitchEnd: 0, volumeStart: 0, volumeEnd: 0,
    samplePtr: 0, sampleLength: 0, playStart: 0, loopStart: 0, loopEnd: 0,
    samplingRate: 0, sampleDetune: 0, loopMode: 0,
    defaultPan: 0xff, defaultNoteVolume: 0,
    vibratoSpeed: 0, vibratoSweep: 0, vibratoDepth: 0, vibratoRate: 0,
    vibratoWaveform: 0xff,
    volEnv: null, volEnvLoop: 0, volEnvSustain: 0,
    panEnv: null, panEnvLoop: 0, panEnvSustain: 0,
    filterEnv: null, filterEnvLoop: 0, filterEnvSustain: 0,
    pitchEnv: null, pitchEnvLoop: 0, pitchEnvSustain: 0,
    hasExtra: false, fadeoutStep: 0, filterSfMode: false,
    extraCutoff: 0xff, extraResonance: 0xff, extraInitialAttenOctet: 0,
    hasChanBlock: false, chanCount: 1, chanMode: CHAN_MODE_DISCRETE,
    chanFlags: 0, chanPtrs: [],
    ...fields,
  };
}

/** 's' block channel modes (low nibble of the count/mode byte). */
export const CHAN_MODE_DISCRETE = 0; // XY stereo, 4-track quad — one channel per speaker feed
export const CHAN_MODE_MATRIX = 1;   // M/S stereo, ambisonic B-format — decoded before panning

export function patchSampleLoopSustain(patch) {
  return (patch.loopMode & 0x04) !== 0;
}

/** Every pool span the patch plays, channel order: [samplePtr, ...chanPtrs]. */
export function patchChannelPtrs(patch) {
  return patch.hasChanBlock && patch.chanCount > 1
    ? [patch.samplePtr, ...patch.chanPtrs.slice(0, patch.chanCount - 1)]
    : [patch.samplePtr];
}

/**
 * The Ixmp patch a voice is actually sounding, from the index applyActiveSample
 * recorded on it (-1 = the base record). Bounds-checked: a mid-playback patch
 * re-upload (the Advanced editor) can shorten the list under a live voice.
 */
export function patchAt(inst, patchIndex) {
  if (inst == null || patchIndex < 0) return null;
  const patches = inst.extraPatches;
  return patches !== null && patchIndex < patches.length ? patches[patchIndex] : null;
}

/** True when the patch plays exactly two channels (the only multi-channel case
 *  the mixer renders today). */
export function patchIsStereo(patch) {
  return patch.hasChanBlock && patch.chanCount === 2 && patch.chanPtrs.length >= 1;
}

/** Base-record field name → the Ixmp patch field it is duplicated into, for
 *  the sample geometry every patch record carries independently (spec §9.11:
 *  "Loop mode ... identical to base record byte 14"). Used to keep a base
 *  stereo patch (below) in sync when the instrument's own sample fields are
 *  edited (item 180). */
export const BASE_TO_PATCH_FIELD = {
  samplePtr: "samplePtr", sampleLength: "sampleLength", samplingRate: "samplingRate",
  samplePlayStart: "playStart", sampleLoopStart: "loopStart", sampleLoopEnd: "loopEnd",
  sampleDetune: "sampleDetune", loopMode: "loopMode",
};

/**
 * Index of the Ixmp patch that exists ONLY to add channels to this
 * instrument's OWN base sample (item 90/180): a base record cannot itself
 * carry the 's' block, so a stereo canonical sample gets one extra,
 * full-range patch that duplicates the base record's sample geometry and adds
 * the 's' block. Matched by sample identity (same samplePtr/sampleLength as
 * the base record) plus `hasChanBlock`, not by rectangle bounds — that is the
 * same condition `Document.sampleList()` uses to decide a base record and a
 * patch describe "the same sample" (its `chanPtrs` merge rule), so an
 * ordinary same-sample zone that carries no 's' block is never matched here.
 * Because its rectangle is the whole keyboard, this patch always wins patch
 * selection, so the base record's own copy of these fields is otherwise dead
 * for playback — it must be kept in sync, not edited independently. -1 when
 * the instrument has none.
 */
export function baseStereoPatchIndex(inst) {
  const patches = inst.extraPatches;
  if (!patches) return -1;
  return patches.findIndex((p) => p.hasChanBlock && p.chanCount > 1 &&
    p.samplePtr === inst.samplePtr && p.sampleLength === inst.sampleLength);
}

/**
 * True when the patch says nothing about auto-vibrato and the base record's
 * block should be used whole (item 170). The wire has one sentinel for five
 * fields — the $FF waveform — and a patch that carries it while leaving all
 * four numbers at zero is stating "inherit", not "no vibrato": reading its
 * zeroes switched the instrument's own vibrato off on every note a keyboard
 * map covered. Any non-zero number means the patch IS stating its own vibrato
 * and only borrows the waveform.
 */
export function patchVibratoInherits(patch) {
  return patch.vibratoWaveform === 0xff && patch.vibratoSpeed === 0 &&
    patch.vibratoSweep === 0 && patch.vibratoDepth === 0 && patch.vibratoRate === 0;
}

/**
 * Parse a flat variable-length Ixmp patch blob (wire format) into patch
 * objects — the codec from AudioJSR223Delegate.kt:357-430, shared by the
 * engine upload path and the document layer. Returns [] for a short blob.
 */
export function parsePatchesBlob(bytes) {
  if (bytes.length < 31) return [];
  const u8 = (o) => bytes[o] & 0xff;
  const u16 = (o) => (bytes[o] & 0xff) | ((bytes[o + 1] & 0xff) << 8);
  const s16 = (o) => { const v = u16(o); return v >= 0x8000 ? v - 0x10000 : v; };
  const u32 = (o) =>
    ((bytes[o] & 0xff) | ((bytes[o + 1] & 0xff) << 8) | ((bytes[o + 2] & 0xff) << 16)) +
    (bytes[o + 3] & 0xff) * 0x1000000;

  const patches = [];
  let o = 0;
  outer: while (o + 31 <= bytes.length) {
    const ver = u8(o);
    let p = o + 31;
    let hasExtra = false, fadeoutStep = 0, extraCutoff = 0xff, extraResonance = 0xff;
    let extraAttenOctet = 0, filterSfMode = false;
    if ((ver & 0x80) !== 0) { // 'x' block (15 bytes)
      if (p + 15 > bytes.length) break;
      filterSfMode = (u8(p) & 0x01) !== 0;
      fadeoutStep = u16(p + 8);
      extraCutoff = u16(p + 10);
      extraResonance = u16(p + 12);
      extraAttenOctet = u8(p + 14);
      hasExtra = true;
      p += 15;
    }
    const readEnv = () => {
      if (p + 54 > bytes.length) return null;
      const loop = u16(p);
      const sus = u16(p + 2);
      const arr = new Array(25);
      for (let k = 0; k < 25; k++) arr[k] = envPoint(u8(p + 4 + 2 * k), u8(p + 5 + 2 * k));
      p += 54;
      return { arr, loop, sus };
    };
    let volEnv = null, volLoop = 0, volSus = 0;
    let panEnv = null, panLoop = 0, panSus = 0;
    let filEnv = null, filLoop = 0, filSus = 0;
    let pitEnv = null, pitLoop = 0, pitSus = 0;
    if ((ver & 0x02) !== 0) { const e = readEnv(); if (e === null) break outer; volEnv = e.arr; volLoop = e.loop; volSus = e.sus; }
    if ((ver & 0x04) !== 0) { const e = readEnv(); if (e === null) break outer; panEnv = e.arr; panLoop = e.loop; panSus = e.sus; }
    if ((ver & 0x08) !== 0) { const e = readEnv(); if (e === null) break outer; filEnv = e.arr; filLoop = e.loop; filSus = e.sus; }
    if ((ver & 0x10) !== 0) { const e = readEnv(); if (e === null) break outer; pitEnv = e.arr; pitLoop = e.loop; pitSus = e.sus; }
    // 's' block LAST (terranmon.txt Ixmp Note 6): u8 count/mode + u24 flags +
    // one u32 sample pointer per EXTRA channel.
    let hasChanBlock = false, chanCount = 1, chanMode = CHAN_MODE_DISCRETE;
    let chanFlags = 0, chanPtrs = [];
    if ((ver & 0x20) !== 0) {
      if (p + 4 > bytes.length) break;
      const cb = u8(p);
      chanCount = (cb >>> 4) + 1;
      chanMode = cb & 0x0f;
      chanFlags = u8(p + 1) | (u8(p + 2) << 8) | (u8(p + 3) << 16);
      if (p + 4 + 4 * (chanCount - 1) > bytes.length) break;
      for (let k = 0; k < chanCount - 1; k++) chanPtrs.push(u32(p + 4 + 4 * k));
      hasChanBlock = true;
      p += 4 + 4 * (chanCount - 1);
    }
    patches.push(makeInstPatch({
      pitchStart: u16(o + 1),
      pitchEnd: u16(o + 3),
      volumeStart: u8(o + 5),
      volumeEnd: u8(o + 6),
      samplePtr: u32(o + 7),
      sampleLength: u16(o + 11),
      playStart: u16(o + 13),
      loopStart: u16(o + 15),
      loopEnd: u16(o + 17),
      samplingRate: u16(o + 19),
      sampleDetune: s16(o + 21),
      loopMode: u8(o + 23),
      defaultPan: u8(o + 24),
      defaultNoteVolume: u8(o + 25),
      vibratoSpeed: u8(o + 26),
      vibratoSweep: u8(o + 27),
      vibratoDepth: u8(o + 28),
      vibratoRate: u8(o + 29),
      vibratoWaveform: u8(o + 30),
      volEnv, volEnvLoop: volLoop, volEnvSustain: volSus,
      panEnv, panEnvLoop: panLoop, panEnvSustain: panSus,
      filterEnv: filEnv, filterEnvLoop: filLoop, filterEnvSustain: filSus,
      pitchEnv: pitEnv, pitchEnvLoop: pitLoop, pitchEnvSustain: pitSus,
      hasExtra, fadeoutStep, filterSfMode,
      extraCutoff, extraResonance, extraInitialAttenOctet: extraAttenOctet,
      hasChanBlock, chanCount, chanMode, chanFlags, chanPtrs,
    }));
    o = p;
  }
  return patches;
}

/**
 * Serialise patch objects back to the flat wire blob — the exact byte-inverse
 * of parsePatchesBlob (blocks emitted in on-wire order x, v, p, f, P, s).
 * Shared by the engine capture path (getInstrumentPatches) and the document
 * layer's Ixmp patch editor.
 */
export function writePatchesBlob(patches) {
  const out = [];
  const w8 = (v) => out.push(v & 0xff);
  const w16 = (v) => { out.push(v & 0xff, (v >>> 8) & 0xff); };
  const w32 = (v) => { w16(v); w16(v >>> 16); };
  const wEnv = (env, loop, sus) => {
    w16(loop); w16(sus);
    for (let k = 0; k < 25; k++) { w8(env[k].value); w8(env[k].offset); }
  };
  for (const p of patches) {
    let ver = 0x01;
    if (p.hasExtra) ver |= 0x80;
    if (p.volEnv !== null) ver |= 0x02;
    if (p.panEnv !== null) ver |= 0x04;
    if (p.filterEnv !== null) ver |= 0x08;
    if (p.pitchEnv !== null) ver |= 0x10;
    if (p.hasChanBlock) ver |= 0x20;
    w8(ver);
    w16(p.pitchStart); w16(p.pitchEnd);
    w8(p.volumeStart); w8(p.volumeEnd);
    w32(p.samplePtr);
    w16(p.sampleLength); w16(p.playStart); w16(p.loopStart); w16(p.loopEnd);
    w16(p.samplingRate); w16(p.sampleDetune); // two's complement round-trips
    w8(p.loopMode); w8(p.defaultPan); w8(p.defaultNoteVolume);
    w8(p.vibratoSpeed); w8(p.vibratoSweep); w8(p.vibratoDepth);
    w8(p.vibratoRate); w8(p.vibratoWaveform);
    if (p.hasExtra) {
      w32(p.filterSfMode ? 1 : 0); w32(0);
      w16(p.fadeoutStep); w16(p.extraCutoff); w16(p.extraResonance);
      w8(p.extraInitialAttenOctet);
    }
    if (p.volEnv !== null) wEnv(p.volEnv, p.volEnvLoop, p.volEnvSustain);
    if (p.panEnv !== null) wEnv(p.panEnv, p.panEnvLoop, p.panEnvSustain);
    if (p.filterEnv !== null) wEnv(p.filterEnv, p.filterEnvLoop, p.filterEnvSustain);
    if (p.pitchEnv !== null) wEnv(p.pitchEnv, p.pitchEnvLoop, p.pitchEnvSustain);
    if (p.hasChanBlock) {
      const extra = Math.max(0, Math.min(15, p.chanCount - 1));
      w8(((extra & 0x0f) << 4) | (p.chanMode & 0x0f));
      w8(p.chanFlags); w8(p.chanFlags >>> 8); w8(p.chanFlags >>> 16);
      for (let k = 0; k < extra; k++) w32(p.chanPtrs[k] ?? 0);
    }
  }
  return Uint8Array.from(out);
}

/**
 * One layer of a Metainstrument. mixOctet is the raw PSO-dB octet (159 = unity).
 *
 * `fixedPitch` is the type-0 NON-MELODIC flag (item 179, §7.4 byte +9 bit 6):
 * the layer sounds one pitch whatever key was struck, and `detune` stops being
 * a signed offset and becomes that pitch — an UNSIGNED 4096-TET note word, the
 * same units a pattern cell writes. Everything else about the layer is
 * unchanged, the gating rectangle included: which keys reach the layer is still
 * a question the rectangle answers, and only what it then sounds is fixed.
 */
export function makeMetaLayer(instIdx, mixOctet, detune, pitchStart, pitchEnd, volStart, volEnd,
                              fixedPitch = false) {
  return { instIdx, mixOctet, detune, pitchStart, pitchEnd, volStart, volEnd, fixedPitch };
}

/** Layer byte +9, bit 6 — the type-0 fixed-pitch flag. RESERVED in every other
 *  kind: a type-4 rack's entries read the bit as nothing at all. */
export const META_LAYER_FIXED_PITCH = 0x40;

/**
 * The note word a layer sounds for a trigger at `noteVal`, before clamping — a
 * fixed-pitch layer's own absolute pitch, or the trigger displaced by the
 * layer's detune. The one place the flag changes an arithmetic, so every reader
 * (trigger, audition probe, editor preview) goes through it.
 */
export function layerNote(layer, noteVal) {
  return layer.fixedPitch ? (layer.detune & 0xffff) : noteVal + layer.detune;
}

/** Layers a 256-byte metainstrument record can hold: byte 0 flags + byte 1
 *  count + bytes 2..3 sentinel, then 10 bytes per layer. */
export const META_MAX_LAYERS = 25;

// ── Metainstrument types (record byte 0, high nibble) ─────────────────────
/** Type 0 — LAYERED: every layer whose rectangle covers the trigger sounds on
 *  its own voice, mixed in parallel (§7.4). */
export const META_TYPE_LAYERED = 0;
/**
 * Type 4 — FM (item 159): the layer table becomes an OPERATOR RACK and the
 * bytes after it carry an RPN program saying how the operators feed each other.
 * The rack is one voice, not `n` of them: operator 0 sounds on the channel and
 * the rest are read by the program.
 */
export const META_TYPE_FM = 4;

/**
 * Operators an FM rack can hold. The whole rack — 10 bytes an operator plus the
 * program — has to fit the 252 bytes a record has left after the header, so this
 * is a floor on the room the program gets: 16 operators leave 92 bytes = 46
 * words, which is more than any 16-operator algorithm needs (n pushes + n−1
 * combining operators + END = 32 words at the very worst).
 */
export const FM_MAX_OPERATORS = 16;

/** Bytes of a 256-byte record the operator rack and its program share. */
export const FM_BUDGET_BYTES = 252;

// ── RPN word classes (§7.6) ──────────────────────────────────────────────
// A word is read as (class, operand): the top nibble pair picks the class and
// the low 10 bits the operator it addresses. $FFxx is the operator space, which
// no operand word can collide with because an operand's index is 10-bit.
export const FM_WORD_OSC = 0x0000;  // $0000-$03FF — push operator n, free-running
export const FM_WORD_MOD = 0x0400;  // $0400-$07FF — push operator n, phase-modulated by TOS
export const FM_WORD_FB  = 0x0800;  // $0800-$0BFF — push operator n's PREVIOUS output (z-1)
export const FM_WORD_OP  = 0xff00;  // $FF00-$FFFE — a stack operator
export const FM_INDEX_MASK = 0x03ff;

/** Stack operators. Opcode = the word's low byte. */
export const FmOp = {
  ADD: 0xff00,   // pop b, a -> push a + b            (parallel carriers)
  MUL: 0xff01,   // pop b, a -> push a * b            (ring modulation)
  NEG: 0xff02,   // pop a    -> push -a               (inverted modulator)
  DUP: 0xff03,   // pop a    -> push a, a
  SWAP: 0xff04,  // pop b, a -> push b, a
  END: 0xffff,   // stop; the stack top is the patch's output
};

/** Deepest the evaluation stack may go. A program that pushes past it is
 *  invalid (buildFmProgram refuses it; the engine treats the overflow as END). */
export const FM_STACK_MAX = 16;

/**
 * The default algorithm for an `n`-operator rack: a straight modulation CHAIN,
 * operator n−1 into n−2 into … into 0, with 0 as the carrier. One push and
 * n−1 modulated pushes — the shape every FM patch starts life as.
 */
export function defaultFmProgram(n) {
  const count = Math.max(1, Math.min(n | 0, FM_MAX_OPERATORS));
  const out = [count - 1];
  for (let k = count - 2; k >= 0; k--) out.push(FM_WORD_MOD | k);
  return Uint16Array.from(out);
}

/**
 * How many stack cells a word pops and pushes — the whole of what validation
 * needs to know about it, and the reason an unknown word can be rejected rather
 * than guessed at. Returns null for a word that is not a legal operand or
 * operator against a rack of `opCount` operators.
 */
export function fmWordArity(word, opCount) {
  const w = word & 0xffff;
  if (w >= FM_WORD_OP) {
    switch (w) {
      case FmOp.ADD: case FmOp.MUL: return { pop: 2, push: 1 };
      case FmOp.NEG: return { pop: 1, push: 1 };
      case FmOp.DUP: return { pop: 1, push: 2 };
      case FmOp.SWAP: return { pop: 2, push: 2 };
      default: return null; // END is handled by the caller; the rest is reserved
    }
  }
  const idx = w & FM_INDEX_MASK;
  if (idx >= opCount) return null;
  switch (w & ~FM_INDEX_MASK) {
    case FM_WORD_OSC: case FM_WORD_FB: return { pop: 0, push: 1 };
    case FM_WORD_MOD: return { pop: 1, push: 1 };
    default: return null;
  }
}

/**
 * Read the RPN program packed at byte `off` of a type-4 record and hand back
 * its words WITHOUT the END terminator, or null when it does not parse.
 *
 * Rejecting outright is deliberate. An FM rack whose algorithm is half-read is
 * not a patch that sounds a bit wrong — it is a stack machine running on
 * whatever the record's tail happened to hold, so the engine treats a program
 * it cannot verify as no program at all and the instrument stays silent.
 */
export function decodeFmProgram(b, off, opCount) {
  const words = [];
  let depth = 0;
  let ended = false;
  for (let o = off; o + 2 <= 256; o += 2) {
    const w = (b[o] & 0xff) | ((b[o + 1] & 0xff) << 8);
    if (w === FmOp.END) { ended = true; break; }
    const arity = fmWordArity(w, opCount);
    if (arity === null) return null;
    if (depth < arity.pop) return null;                    // stack underflow
    depth += arity.push - arity.pop;
    if (depth > FM_STACK_MAX) return null;                 // stack overflow
    words.push(w);
  }
  // A program that fills the record to the last byte ends there; one that stops
  // early must say so, or the words after it are being ignored by accident.
  if (!ended && off + words.length * 2 + 2 <= 256) return null;
  return depth >= 1 ? Uint16Array.from(words) : null;
}

/** Bytes an `n`-operator rack with a `words`-word program occupies of the 252 —
 *  the END terminator counted, because the record has to carry it too. */
export function fmRecordBytes(n, words) {
  return n * 10 + (words + 1) * 2;
}

/**
 * Pack a 256-byte metainstrument record — the byte-inverse of loadRecord's meta
 * branch. `layers` are makeMetaLayer shapes; layer 0 is the FOREGROUND layer and
 * the rest spawn as background children (trigger.js triggerMetaOrNote). Layers
 * beyond the type's capacity are dropped.
 *
 * A layer child must NOT itself be a metainstrument: triggerMetaOrNote resolves
 * layers through triggerNote, which never re-enters the meta branch, so a nested
 * meta's record would be read as sample fields.
 *
 * `type` picks the metainstrument kind (§7.4). META_TYPE_FM makes `layers` an
 * OPERATOR RACK and appends `program` — the RPN algorithm — after it, terminated
 * by END. Program words past the 252-byte budget are dropped, which is why the
 * editor keeps a memory meter: the rack and the algorithm share one record.
 */
export function buildMetaRecord(layers, {
  strict = false, percussion = false, type = META_TYPE_LAYERED, program = null,
} = {}) {
  const fm = type === META_TYPE_FM;
  const use = layers.slice(0, fm ? FM_MAX_OPERATORS : META_MAX_LAYERS);
  const b = new Uint8Array(256);
  // samplePtr high 16 bits = 0xFFFF is the Metainstrument sentinel; the low
  // bytes carry the flags (byte 0) and the layer count (byte 1) instead.
  b[0] = ((type & 0x0f) << 4) | (strict ? 0x01 : 0) | (percussion ? 0x02 : 0);
  b[1] = use.length & 0xff;
  b[2] = 0xff;
  b[3] = 0xff;
  let o = 4;
  for (const l of use) {
    const idx = l.instIdx & 0x3ff;
    const det = l.detune & 0xffff; // two's complement round-trips
    b[o] = idx & 0xff;
    b[o + 1] = l.mixOctet & 0xff;
    b[o + 2] = det & 0xff;
    b[o + 3] = (det >>> 8) & 0xff;
    b[o + 4] = l.pitchStart & 0xff;
    b[o + 5] = (l.pitchStart >>> 8) & 0xff;
    b[o + 6] = l.pitchEnd & 0xff;
    b[o + 7] = (l.pitchEnd >>> 8) & 0xff;
    // Layer inst index bits 8..9 ride in the vol-start byte's top two bits.
    b[o + 8] = (l.volStart & 0x3f) | (((idx >>> 8) & 0x3) << 6);
    // …and the fixed-pitch flag in the vol-end byte's bit 6, which is where a
    // type-0 layer says its pitch is its own (item 179). A rack's entries never
    // carry it: the bit is RESERVED in every kind but Layered, and `fixedPitch`
    // is false on every operator the editor builds.
    b[o + 9] = (l.volEnd & 0x3f) | (!fm && l.fixedPitch ? META_LAYER_FIXED_PITCH : 0);
    o += 10;
  }
  if (fm) {
    const prog = program === null ? defaultFmProgram(use.length) : program;
    // The END word is the packer's, not the caller's: a program is a word LIST
    // everywhere above this line, and the terminator only exists because the
    // record's tail has to say where the algorithm stops.
    for (const w of prog) {
      if ((w & 0xffff) === FmOp.END || o + 4 > 256) break;
      b[o] = w & 0xff;
      b[o + 1] = (w >>> 8) & 0xff;
      o += 2;
    }
    if (o + 2 <= 256) { b[o] = 0xff; b[o + 1] = 0xff; }
  }
  return b;
}

/**
 * 256-byte instrument record (terranmon.txt:2001+). See AudioAdapter.kt:5322-5376
 * for the full byte layout. Envelopes have LOOP (always-active wrap) and SUSTAIN
 * (key-on-only wrap) words; playback priority matches schismtracker sndmix.c.
 */
export class TaudInst {
  constructor(index) {
    this.index = index;

    this.samplePtr = 0;
    this.sampleLength = 0;
    this.samplingRate = 0;
    this.samplePlayStart = 0;
    this.sampleLoopStart = 0;
    this.sampleLoopEnd = 0;
    this.loopMode = 0;            // byte 14: bits 0-1 mode, bit 2 sustain, bit 4 percussion,
                                  //          bit 5 spatial azimuth MSB (#998)
    this.volEnvLoop = 0;          // bytes 15-16 (LOOP word)
    this.panEnvLoop = 0;          // bytes 17-18
    this.pfEnvLoop = 0;           // bytes 19-20
    this.instGlobalVolume = 0xff;
    this.volEnvelopes = makeEnv(0x3f);
    this.panEnvelopes = makeEnv(0x80);
    this.pfEnvelopes = makeEnv(0x80);
    this.volumeFadeoutLow = 0;
    this.fadeoutHigh = 0;
    this.volumeSwing = 0;
    this.vibratoSpeed = 0;
    this.vibratoSweep = 0;
    this.defaultPan = 0x80;
    this.pitchPanCentre = 0x5000;
    this.pitchPanSeparation = 0;
    this.panSwing = 0;
    this.defaultCutoff = 0xff;
    this.defaultResonance = 0;    // matches Kotlin secondary-ctor default order
    this.sampleDetune = 0;
    this.instrumentFlag = 0;
    this.vibratoDepth = 0;
    this.vibratoRate = 0;
    this.volEnvSustainWord = 0;
    this.panEnvSustainWord = 0;
    this.pfEnvSustainWord = 0;
    this.dupCheckFlag = 0;
    this.defaultNoteVolume = 0;   // byte 196; 0 = legacy fall back to 0x3F
    this.pf2EnvLoop = 0;          // bytes 197-198
    this.pf2EnvSustainWord = 0;   // bytes 199-200
    this.pf2Envelopes = makeEnv(0x80); // bytes 201-250

    // Reserved padding at offsets 251..255; note the Kotlin indexing quirk:
    // getByte(252..255) reads reserved[offset-251] (reserved[0] unused), and
    // defaultCutoff16/defaultResonance16 read reserved[1]/reserved[2].
    this.reserved = new Uint8Array(5);
    this.initialAttenOctet = 0;   // byte 251; 0 = unity sentinel

    // Runtime notefx 5/6 overrides (-1 = none).
    this.cutoffOverride = -1;
    this.resonanceOverride = -1;

    // Ixmp patches (null when none uploaded).
    this.extraPatches = null;

    // Metainstrument state.
    this.metaLayers = null;
    this.metaRaw = null;          // verbatim 256-byte record for lossless capture
    this.metaStrict = false;
    this.metaType = META_TYPE_LAYERED; // record byte 0's high nibble (§7.4)
    // FM rack (type 4, item 159): the RPN algorithm packed after the operator
    // table, END-terminated and already validated by decodeFmProgram — null for
    // every other type AND for an FM record whose program does not parse, which
    // is what makes the instrument silent rather than unpredictable.
    this.fmProgram = null;

    // Invert loop (S $F0xx) XOR bit-mask over the loop region.
    this.invertMask = null;

    // Sample modification (items 130, 152, 153, notefx 2 / 3) — ONE per
    // instrument: the opcodes are the same command, `2` inverting which side of
    // the region is touched. The extent is a FRACTION of the sounding voice's
    // loop region (item 153), so it means the same thing whatever is loaded and
    // wherever an Ixmp patch moves the loop; combBits -1 = solid. Only the
    // ACTIVE operation's accumulator is ever non-zero.
    this.modOp = 0;               // MOD_OFF
    this.modInvert = false;       // notefx 2: the region is what is NOT touched
    this.modFrom = 0;             // extent, as a fraction of the domain
    this.modTo = 1;
    this.modCombBits = -1;        // comb: the extent cut into 2^(n+1) chunks
    this.modCombOdd = false;      // ...keeping the odd ones ($Ex) or the even ($Fx)
    this.modMask = null;          // MOD_INVERT: one bit per sample byte
    this.modRot = 0;              // MOD_ROL*/MOD_JUMP*: byte displacement
    this.modSub = 0;              // MOD_SUB*: running subtrahend, 0..255
    this.modScatter = 0;          // MOD_RND*: per-byte throw, in bytes (0 = off)
    this.modSeed = 0;             // MOD_RND*: this step's scramble
    this.modOn = false;           // hot-path guard: does it change any byte yet?
    this.modEpoch = 0;            // bumped whenever the GEOMETRY moves, so a
                                  // voice's resolved view knows to rebuild
    // The state the last step replaced, for the anti-click crossfade (item
    // 153.5): for MOD_XFADE_SAMPLES output samples a voice reads both mappings.
    this.modPrevRot = 0;
    this.modPrevSub = 0;
    this.modPrevScatter = 0;
    this.modPrevSeed = 0;

    // Argument extension (item 162): notefx 2/3 paired with `:`. Mutually
    // exclusive with modOp above — writing either clears the other (see
    // setModOp/setModOpExt) — so every field below is only ever live while
    // modOpExt is non-zero. $se's own extent/comb (modFrom/modTo/modCombBits)
    // is shared with the classic path; everything here is the extended-only
    // remainder: $f's sub-range, the step counter it alternates on, and the
    // wider operation table's own accumulators. modRot/modSub/modScatter/
    // modSeed above are reused as-is for the extended rotate/jump/scatter/
    // sub/add kinds (see samplemod.js decodeExtOp) rather than duplicated.
    this.modOpExt = 0;            // 0x000..0xFFF, 0 = off ($xuu)
    this.modF = 0;                 // $f sub-range modifier
    this.modStepIndex = 0;        // counts steps, for $f's A-D alternation
    this.modXor = 0;               // xor / "simply invert" (103) / NOT (920) accumulator
    this.modPrevXor = 0;
    this.modBitRot = 0;            // 90x/91x: net bit-rotation, mod 8 (no crossfade)
    this.modBitPermIdx = 0;        // 921-927: which permutation (920 folds into modXor)
    this.modBitPermOn = false;     // toggled each step (an involution applied twice is identity)
    this.modExtSwapA = -1;         // 160: swapped byte-pair addresses (no crossfade)
    this.modExtSwapB = -1;
    this.modExtMirror = false;     // 104: reverse, toggled each step (no crossfade)
    // 102/12x: this instrument's own funk-repeat walk — an ABSOLUTE SAMPLE
    // BYTE POSITION (like Z $Ffxx's voice.funkWalk/funkPos, -1 = never
    // walked), NOT bounded to the resolved region: the formal Funk Repeat
    // spec moves the loop itself through the whole physical sample, replen
    // (the region's own length) at a time. modFunkWalk is the deterministic
    // grid position; modFunkPos is this step's pointer WITH $12x's jitter
    // added — latched into a sounding voice's own modFunkWindow only when
    // that voice's loop actually wraps (sampler.js advanceSamplePos), same
    // as Z's funkPos -> funkWindow latch.
    this.modFunkWalk = -1;
    this.modFunkPos = -1;
    this.modFunkLen = 0;          // this step's window width (= dl, the resolved
                                   // region's own length) — stashed here because
                                   // sampler.js's advanceSamplePos runs on the
                                   // per-sample clock and must not re-resolve
                                   // modGeom itself to find it
  }

  get sampleLoopSustain() { return (this.loopMode & 0x04) !== 0; }
  get isPercussion() {
    return this.metaRaw !== null
      ? (this.metaRaw[0] & 0x02) !== 0
      : (this.loopMode & 0x10) !== 0;
  }
  /**
   * The instrument's default position as a 9-bit azimuth (#998): record byte
   * 177 is its LOW byte and byte 14's bit 5 (`A`) the ninth — exactly the
   * relationship `S $8xxx` has with the legacy pan byte, which is what makes
   * this backwards compatible. An old file has bit 5 clear, so its pan lands on
   * the front arc it always meant, and a stereo song reads byte 177 alone.
   */
  get defaultAzimuth() {
    return ((this.loopMode & 0x20) !== 0 ? 256 : 0) | (this.defaultPan & 0xff);
  }
  /** Default elevation (#998), record byte 254, signed. Spatial songs only. */
  get defaultElevation() {
    const b = this.reserved[3] & 0xff; // byte 254 → reserved[254 − 251]
    return b >= 0x80 ? b - 256 : b;
  }
  get nnaKeyLift() { return ((this.instrumentFlag >>> 5) & 1) !== 0; }
  /** 0=note off, 1=note cut, 2=continue, 3=note fade. */
  get newNoteAction() { return this.instrumentFlag & 0x03; }
  /** 0=sine, 1=ramp-down, 2=square, 3=random, 4=ramp-up (FT2). */
  get vibratoWaveform() { return (this.instrumentFlag >>> 2) & 0x07; }
  get sampleDetuneSigned() {
    const v = this.sampleDetune & 0xffff;
    return v >= 0x8000 ? v - 0x10000 : v;
  }
  get duplicateCheckType() { return this.dupCheckFlag & 0x03; }
  get duplicateCheckAction() { return (this.dupCheckFlag >>> 2) & 0x03; }
  /** byte 173 bit 4: false = ImpulseTracker filter units, true = SoundFont. */
  get filterSfMode() { return ((this.fadeoutHigh >>> 4) & 1) !== 0; }
  get isMeta() { return this.metaLayers !== null; }
  /** True for a type-4 rack: the layer table is an OPERATOR rack read by
   *  `fmProgram`, not a set of parallel layers (§7.6). */
  get isFm() { return this.metaLayers !== null && this.metaType === META_TYPE_FM; }

  get defaultCutoff16() {
    if (this.cutoffOverride >= 0) return this.cutoffOverride;
    return this.filterSfMode
      ? ((this.defaultCutoff & 0xff) << 8) | (this.reserved[1] & 0xff)
      : this.defaultCutoff;
  }
  get defaultResonance16() {
    if (this.resonanceOverride >= 0) return this.resonanceOverride;
    return this.filterSfMode
      ? ((this.defaultResonance & 0xff) << 8) | (this.reserved[2] & 0xff)
      : this.defaultResonance;
  }

  /** First Ixmp patch whose pitch+volume rectangle contains the trigger, else null. */
  resolvePatch(noteVal, rowVolume) {
    const patches = this.extraPatches;
    if (patches === null) return null;
    for (const p of patches) {
      if (noteVal >= p.pitchStart && noteVal <= p.pitchEnd &&
          rowVolume >= p.volumeStart && rowVolume <= p.volumeEnd) return p;
    }
    return null;
  }

  /** All meta layers whose rectangle contains the trigger, in record order. */
  resolveMetaLayers(noteVal, rowVolume) {
    const layers = this.metaLayers;
    if (layers === null) return [];
    return layers.filter(
      (l) => noteVal >= l.pitchStart && noteVal <= l.pitchEnd &&
             rowVolume >= l.volStart && rowVolume <= l.volEnd
    );
  }

  /** Load a full 256-byte record; detects the Metainstrument sentinel
   *  (samplePtr high 16 bits == 0xFFFF) and parses its layer table — which for
   *  a type-4 record is an operator rack followed by an RPN program (§7.6). */
  loadRecord(b) {
    this.cutoffOverride = -1;
    this.resonanceOverride = -1;
    const sp = ((b[0] & 0xff) | ((b[1] & 0xff) << 8) | ((b[2] & 0xff) << 16)) + (b[3] & 0xff) * 0x1000000;
    if (((sp >>> 16) & 0xffff) === 0xffff) {
      const type = (b[0] >>> 4) & 0x0f;
      const fm = type === META_TYPE_FM;
      const rawCount = (sp >>> 8) & 0xff; // byte 1 = layer / operator count
      const count = fm ? Math.min(rawCount, FM_MAX_OPERATORS) : rawCount;
      const layers = [];
      let o = 4;
      for (let n = 0; n < count; n++) {
        if (o + 10 > b.length) break;
        // 10-bit layer inst index: low 8 in byte 0, bits 8..9 in bits 6..7 of vol-start (+8).
        const instIdx = (b[o] & 0xff) | (((b[o + 8] >>> 6) & 0x3) << 8);
        const mixOctet = b[o + 1] & 0xff;
        const detRaw = (b[o + 2] & 0xff) | ((b[o + 3] & 0xff) << 8);
        // A fixed-pitch layer's detune field is an unsigned NOTE WORD, not a
        // signed offset (item 179), so the sign conversion has to know which it
        // is looking at. The flag is the Layered kind's alone: in a rack those
        // bits are reserved and the field stays a frequency ratio.
        const fixedPitch = !fm && (b[o + 9] & META_LAYER_FIXED_PITCH) !== 0;
        const detune = fixedPitch ? detRaw : (detRaw >= 0x8000 ? detRaw - 0x10000 : detRaw);
        const pStart = (b[o + 4] & 0xff) | ((b[o + 5] & 0xff) << 8);
        const pEnd = (b[o + 6] & 0xff) | ((b[o + 7] & 0xff) << 8);
        const vStart = b[o + 8] & 0x3f;
        const vEnd = b[o + 9] & 0x3f;
        const usable = instIdx >= 1 && instIdx <= 1023 && instIdx !== this.index;
        // A layered record DROPS an unusable layer; an FM rack MUTES it in
        // place, because the program addresses operators by POSITION and
        // compacting the rack would rewire the algorithm under it.
        if (usable || fm) {
          const layer = makeMetaLayer(usable ? instIdx : 0, mixOctet, detune,
            pStart, pEnd, vStart, vEnd, fixedPitch);
          layer.rawOffset = o; // metaRaw byte offset of this layer (editors target it)
          layers.push(layer);
        }
        o += 10;
      }
      this.metaLayers = layers.length === 0 ? null : layers;
      this.metaRaw = this.metaLayers !== null ? Uint8Array.from(b.slice(0, 256)) : null;
      this.metaStrict = this.metaLayers !== null && (b[0] & 0x01) !== 0;
      this.metaType = this.metaLayers !== null ? type : META_TYPE_LAYERED;
      this.fmProgram = this.metaLayers !== null && fm
        ? decodeFmProgram(b, o, layers.length) : null;
      this.extraPatches = null;
    } else {
      this.metaLayers = null;
      this.metaRaw = null;
      this.metaStrict = false;
      this.metaType = META_TYPE_LAYERED;
      this.fmProgram = null;
      const n = Math.min(256, b.length);
      for (let i = 0; i < n; i++) this.setByte(i, b[i] & 0xff);
    }
  }

  // Invert-loop mask — sized for the loop length; stale masks are discarded.
  // `loopLen` is the SOUNDING voice's active loop length — an Ixmp patch brings
  // its own loop points, so sizing the mask off the base record would index a
  // patched voice's inversion into the wrong bytes (item 116). Defaults to the
  // base record's loop for a voice with no patch.
  toggleInvertBit(loopOffset, loopLen = this.sampleLoopEnd - this.sampleLoopStart) {
    const len = Math.max(loopLen, 1);
    const expectedSize = (len + 7) >> 3;
    let mask = this.invertMask;
    if (mask === null || mask.length !== expectedSize) {
      mask = new Uint8Array(expectedSize);
      this.invertMask = mask;
    }
    const idx = Math.min(Math.max(loopOffset, 0), len - 1);
    mask[idx >> 3] ^= 1 << (idx & 7);
  }

  invertBit(loopOffset, loopLen = this.sampleLoopEnd - this.sampleLoopStart) {
    const mask = this.invertMask;
    if (mask === null) return false;
    const len = Math.max(loopLen, 1);
    if (mask.length !== (len + 7) >> 3) { this.invertMask = null; return false; }
    const idx = Math.min(Math.max(loopOffset, 0), len - 1);
    return ((mask[idx >> 3] >>> (idx & 7)) & 1) !== 0;
  }

  /**
   * Point the modification at a new extent (item 130), as a fraction of the
   * sounding voice's domain. Its accumulated state is indexed against that
   * region, so a move invalidates it, and a fresh extent is always solid — the
   * comb is the other half of the same argument and is written after it.
   * Returns whether anything MOVED, which is what tells the caller to restart
   * the walk: writing the same region every row must not keep resetting it.
   */
  setModRegion(from, to) {
    if (this.modFrom === from && this.modTo === to && this.modCombBits === -1) return false;
    this.modFrom = from;
    this.modTo = to;
    this.modCombBits = -1;
    this.modCombOdd = false;
    this.modEpoch++;
    this.clearModState();
    return true;
  }

  /** Comb the extent without moving its ends ($Fn even bristles, $En odd). */
  setModComb(bits, odd) {
    if (this.modCombBits === bits && this.modCombOdd === odd) return false;
    this.modCombBits = bits;
    this.modCombOdd = odd;
    this.modEpoch++;
    this.clearModState();
    return true;
  }

  /** Select the operation and which side of the region it works on. Changing
   *  either starts the new operation from scratch — a rotation offset means
   *  nothing to a subtract. Classic and extended ($xuu, item 162) are mutually
   *  exclusive, so writing the classic op also turns any extended one off. */
  setModOp(op, invert) {
    if (this.modOp === op && this.modInvert === invert && this.modOpExt === 0) return false;
    this.modOp = op;
    this.modInvert = invert;
    this.modOpExt = 0;
    this.modF = 0;
    this.modEpoch++;   // the inversion decides the wrap domain, so it is geometry
    this.clearModState();
    return true;
  }

  /** Extended counterpart of setModOp (item 162): a 12-bit $xuu code plus the
   *  $f sub-range modifier, mutually exclusive with the classic modOp. */
  setModOpExt(code, invert, f) {
    if (this.modOpExt === code && this.modInvert === invert && this.modF === f && this.modOp === 0) return false;
    this.modOp = 0;
    this.modOpExt = code;
    this.modInvert = invert;
    this.modF = f;
    this.modEpoch++;
    this.clearModState();
    return true;
  }

  /** Drop what the operation has accumulated, keeping its region. */
  clearModState() {
    this.modMask = null;
    this.modRot = 0;
    this.modSub = 0;
    this.modScatter = 0;
    this.modSeed = 0;
    this.modOn = false;
    this.modPrevRot = 0;
    this.modPrevSub = 0;
    this.modPrevScatter = 0;
    this.modPrevSeed = 0;
    this.modStepIndex = 0;
    this.modXor = 0;
    this.modPrevXor = 0;
    this.modBitRot = 0;
    this.modBitPermIdx = 0;
    this.modBitPermOn = false;
    this.modExtSwapA = -1;
    this.modExtSwapB = -1;
    this.modExtMirror = false;
    this.modFunkWalk = -1;
    this.modFunkPos = -1;
    this.modFunkLen = 0;
  }

  /** Remember what the next step is replacing, for the crossfade that covers
   *  it (item 153.5). Called immediately BEFORE the step lands. */
  snapshotModState() {
    this.modPrevRot = this.modRot;
    this.modPrevSub = this.modSub;
    this.modPrevScatter = this.modScatter;
    this.modPrevSeed = this.modSeed;
    this.modPrevXor = this.modXor;
  }

  /** $x = 0 — the modification, region and all. */
  resetMod() {
    this.modOp = 0;
    this.modOpExt = 0;
    this.modF = 0;
    this.modInvert = false;
    this.modFrom = 0;
    this.modTo = 1;
    this.modCombBits = -1;
    this.modCombOdd = false;
    this.modEpoch++;
    this.clearModState();
  }

  /** Flip the modification's inversion bit for sample byte `i` (MOD_INVERT). The
   *  mask spans the whole SAMPLE — an inverted region's touched set is not a
   *  contiguous span, so there is no smaller origin to index from. */
  toggleModBit(i, sampleLen) {
    const len = Math.max(sampleLen, 1);
    const expectedSize = (len + 7) >> 3;
    let mask = this.modMask;
    if (mask === null || mask.length !== expectedSize) {
      mask = new Uint8Array(expectedSize);
      this.modMask = mask;
    }
    const idx = Math.min(Math.max(i, 0), len - 1);
    mask[idx >> 3] ^= 1 << (idx & 7);
    this.modOn = true;
  }

  modBit(i) {
    const mask = this.modMask;
    if (mask === null) return false;
    const byte = i >> 3;
    if (byte < 0 || byte >= mask.length) return false;
    return ((mask[byte] >>> (i & 7)) & 1) !== 0;
  }

  _envPointGet(env, base, offset) {
    const rel = offset - base;
    const pt = env[rel >> 1];
    return (rel & 1) === 0 ? pt.value & 0xff : pt.offset & 0xff;
  }

  _envPointSet(env, base, offset, byte) {
    const rel = offset - base;
    const pt = env[rel >> 1];
    if ((rel & 1) === 0) pt.value = byte;
    else pt.offset = byte & 0xff;
  }

  /** Read one record byte (0..255). Metainstruments serve verbatim metaRaw. */
  getByte(offset) {
    if (this.metaRaw !== null) return this.metaRaw[offset] & 0xff;
    return this.getByteNormal(offset);
  }

  getByteNormal(o) {
    if (o >= 21 && o <= 70) return this._envPointGet(this.volEnvelopes, 21, o);
    if (o >= 71 && o <= 120) return this._envPointGet(this.panEnvelopes, 71, o);
    if (o >= 121 && o <= 170) return this._envPointGet(this.pfEnvelopes, 121, o);
    if (o >= 201 && o <= 250) return this._envPointGet(this.pf2Envelopes, 201, o);
    if (o >= 252 && o <= 255) return this.reserved[o - 251];
    switch (o) {
      case 0: return this.samplePtr & 0xff;
      case 1: return (this.samplePtr >>> 8) & 0xff;
      case 2: return (this.samplePtr >>> 16) & 0xff;
      case 3: return (this.samplePtr >>> 24) & 0xff;
      case 4: return this.sampleLength & 0xff;
      case 5: return (this.sampleLength >>> 8) & 0xff;
      case 6: return this.samplingRate & 0xff;
      case 7: return (this.samplingRate >>> 8) & 0xff;
      case 8: return this.samplePlayStart & 0xff;
      case 9: return (this.samplePlayStart >>> 8) & 0xff;
      case 10: return this.sampleLoopStart & 0xff;
      case 11: return (this.sampleLoopStart >>> 8) & 0xff;
      case 12: return this.sampleLoopEnd & 0xff;
      case 13: return (this.sampleLoopEnd >>> 8) & 0xff;
      case 14: return this.loopMode & 0x37;
      case 15: return this.volEnvLoop & 0xff;
      case 16: return (this.volEnvLoop >>> 8) & 0xff;
      case 17: return this.panEnvLoop & 0xff;
      case 18: return (this.panEnvLoop >>> 8) & 0xff;
      case 19: return this.pfEnvLoop & 0xff;
      case 20: return (this.pfEnvLoop >>> 8) & 0xff;
      case 171: return this.instGlobalVolume & 0xff;
      case 172: return this.volumeFadeoutLow & 0xff;
      case 173: return this.fadeoutHigh & 0xff;
      case 174: return this.volumeSwing & 0xff;
      case 175: return this.vibratoSpeed & 0xff;
      case 176: return this.vibratoSweep & 0xff;
      case 177: return this.defaultPan & 0xff;
      case 178: return this.pitchPanCentre & 0xff;
      case 179: return (this.pitchPanCentre >>> 8) & 0xff;
      case 180: return this.pitchPanSeparation & 0xff;
      case 181: return this.panSwing & 0xff;
      case 182: return this.defaultCutoff & 0xff;
      case 183: return this.defaultResonance & 0xff;
      case 184: return this.sampleDetune & 0xff;
      case 185: return (this.sampleDetune >>> 8) & 0xff;
      case 186: return this.instrumentFlag & 0xff;
      case 187: return this.vibratoDepth & 0xff;
      case 188: return this.vibratoRate & 0xff;
      case 189: return this.volEnvSustainWord & 0xff;
      case 190: return (this.volEnvSustainWord >>> 8) & 0xff;
      case 191: return this.panEnvSustainWord & 0xff;
      case 192: return (this.panEnvSustainWord >>> 8) & 0xff;
      case 193: return this.pfEnvSustainWord & 0xff;
      case 194: return (this.pfEnvSustainWord >>> 8) & 0xff;
      case 195: return this.dupCheckFlag & 0xff;
      case 196: return this.defaultNoteVolume & 0xff;
      case 197: return this.pf2EnvLoop & 0xff;
      case 198: return (this.pf2EnvLoop >>> 8) & 0xff;
      case 199: return this.pf2EnvSustainWord & 0xff;
      case 200: return (this.pf2EnvSustainWord >>> 8) & 0xff;
      case 251: return this.initialAttenOctet & 0xff;
      default: throw new Error(`Bad offset ${o}`);
    }
  }

  setByte(o, byte) {
    if (o >= 21 && o <= 70) return this._envPointSet(this.volEnvelopes, 21, o, byte);
    if (o >= 71 && o <= 120) return this._envPointSet(this.panEnvelopes, 71, o, byte);
    if (o >= 121 && o <= 170) return this._envPointSet(this.pfEnvelopes, 121, o, byte);
    if (o >= 201 && o <= 250) return this._envPointSet(this.pf2Envelopes, 201, o, byte);
    if (o >= 252 && o <= 255) { this.reserved[o - 251] = byte & 0xff; return; }
    switch (o) {
      case 0: this.samplePtr = (this.samplePtr & 0xffffff00) | byte; break;
      case 1: this.samplePtr = (this.samplePtr & 0xffff00ff) | (byte << 8); break;
      case 2: this.samplePtr = (this.samplePtr & 0xff00ffff) | (byte << 16); break;
      case 3: this.samplePtr = ((this.samplePtr & 0x00ffffff) | (byte << 24)) >>> 0; break;
      case 4: this.sampleLength = (this.sampleLength & 0xff00) | byte; break;
      case 5: this.sampleLength = (this.sampleLength & 0x00ff) | (byte << 8); break;
      case 6: this.samplingRate = (this.samplingRate & 0xff00) | byte; break;
      case 7: this.samplingRate = (this.samplingRate & 0x00ff) | (byte << 8); break;
      case 8: this.samplePlayStart = (this.samplePlayStart & 0xff00) | byte; break;
      case 9: this.samplePlayStart = (this.samplePlayStart & 0x00ff) | (byte << 8); break;
      case 10: this.sampleLoopStart = (this.sampleLoopStart & 0xff00) | byte; break;
      case 11: this.sampleLoopStart = (this.sampleLoopStart & 0x00ff) | (byte << 8); break;
      case 12: this.sampleLoopEnd = (this.sampleLoopEnd & 0xff00) | byte; break;
      case 13: this.sampleLoopEnd = (this.sampleLoopEnd & 0x00ff) | (byte << 8); break;
      case 14: this.loopMode = byte & 0x37; break;
      case 15: this.volEnvLoop = (this.volEnvLoop & 0xff00) | byte; break;
      case 16: this.volEnvLoop = (this.volEnvLoop & 0x00ff) | (byte << 8); break;
      case 17: this.panEnvLoop = (this.panEnvLoop & 0xff00) | byte; break;
      case 18: this.panEnvLoop = (this.panEnvLoop & 0x00ff) | (byte << 8); break;
      case 19: this.pfEnvLoop = (this.pfEnvLoop & 0xff00) | byte; break;
      case 20: this.pfEnvLoop = (this.pfEnvLoop & 0x00ff) | (byte << 8); break;
      case 171: this.instGlobalVolume = byte & 0xff; break;
      case 172: this.volumeFadeoutLow = byte & 0xff; break;
      case 173: this.fadeoutHigh = byte & 0x1f; break; // bits 0-3 fadeout high, bit 4 SF filter mode
      case 174: this.volumeSwing = byte & 0xff; break;
      case 175: this.vibratoSpeed = byte & 0xff; break;
      case 176: this.vibratoSweep = byte & 0xff; break;
      case 177: this.defaultPan = byte & 0xff; break;
      case 178: this.pitchPanCentre = (this.pitchPanCentre & 0xff00) | byte; break;
      case 179: this.pitchPanCentre = (this.pitchPanCentre & 0x00ff) | (byte << 8); break;
      case 180: this.pitchPanSeparation = byte >= 0x80 ? byte - 0x100 : byte; break;
      case 181: this.panSwing = byte & 0xff; break;
      case 182: this.defaultCutoff = byte & 0xff; break;
      case 183: this.defaultResonance = byte & 0xff; break;
      case 184: this.sampleDetune = (this.sampleDetune & 0xff00) | byte; break;
      case 185: this.sampleDetune = (this.sampleDetune & 0x00ff) | (byte << 8); break;
      case 186: this.instrumentFlag = byte & 0xff; break;
      case 187: this.vibratoDepth = byte & 0xff; break;
      case 188: this.vibratoRate = byte & 0xff; break;
      case 189: this.volEnvSustainWord = (this.volEnvSustainWord & 0xff00) | byte; break;
      case 190: this.volEnvSustainWord = (this.volEnvSustainWord & 0x00ff) | (byte << 8); break;
      case 191: this.panEnvSustainWord = (this.panEnvSustainWord & 0xff00) | byte; break;
      case 192: this.panEnvSustainWord = (this.panEnvSustainWord & 0x00ff) | (byte << 8); break;
      case 193: this.pfEnvSustainWord = (this.pfEnvSustainWord & 0xff00) | byte; break;
      case 194: this.pfEnvSustainWord = (this.pfEnvSustainWord & 0x00ff) | (byte << 8); break;
      case 195: this.dupCheckFlag = byte & 0x0f; break;
      case 196: this.defaultNoteVolume = byte & 0xff; break;
      case 197: this.pf2EnvLoop = (this.pf2EnvLoop & 0xff00) | byte; break;
      case 198: this.pf2EnvLoop = (this.pf2EnvLoop & 0x00ff) | (byte << 8); break;
      case 199: this.pf2EnvSustainWord = (this.pf2EnvSustainWord & 0xff00) | byte; break;
      case 200: this.pf2EnvSustainWord = (this.pf2EnvSustainWord & 0x00ff) | (byte << 8); break;
      case 251: this.initialAttenOctet = byte & 0xff; break;
      default: throw new Error(`Bad offset ${o}`);
    }
  }
}
