// The engine's parts, callable one at a time: a voice made for the purpose,
// and the functions the engine runs on a voice — the envelope walks, the
// filter refresh, the sample fetch, an effect's row pass — under the names the
// engine gives them. They are the C engine's own (core/engine/c/src/
// wasm_parts.c, `tw_part_*`), run on views of its records, so a test of one
// rule tests the engine that plays.
//
//   const P = engineParts();            // an engine of its own
//   const P = engineParts(eng);         // …or the parts of one you have
//   const v = P.voice();                // a fresh voice, in no list
//   v.activeVolEnv = P.envelope(points);
//   P.advanceEnvelope(v, 0.05);
//
// A voice, an instrument and a patch passed to one of these must be views of
// THIS engine's memory (`P.eng.instruments[n]`, `inst.resolvePatch(…)`).
//
// Besides a voice's walks: the pieces a test drives on their own, each with
// the method names its JavaScript ancestor had so a test reads as it did —
//
//   P.binaural(sphere, rate)   the head (channelGains, decode(bus, frames))
//   P.imixChain(block, …)      an instrument mixing chain (process, readGr)
//   P.opl / P.psg              a chip channel keyed by hand
//   P.samplemod                the sample-modification decoders
//   P.table(name)              a table of the engine's (SNES_GAUSS, MOD_SIN_TABLE, …)
//   P.lfoSampleWide, P.advanceLfoPhase, P.equalLoudness, P.encodeSN3D,
//   P.sampleChannelLayout/Angles, P.hrirTable, and P.pow / P.exp — the
//   engine's own, for a reference formula that must agree to the bit

import { TaudEngine } from "../../core/engine/engine.js";
import { recordSize } from "../../core/engine/wasm-reflect.js";
import { SAMPLING_RATE, TRACKER_CHUNK } from "../../core/engine/constants.js";
import { buildImixSection } from "../../core/format/imix-section.js";

/** The C engine's EXT_KIND_* order, by the names the decoder used to give. */
const EXT_KINDS = [
  "noop", "invert", "funk", "xor", "mirror", "invertJit", "funkJit", "jumpN", "jumpNBounded",
  "swap", "scatter", "rol", "sub", "bitrot", "bitperm",
];

/** tw_part_table's names: which, and the element type. */
const TABLES = {
  SNES_GAUSS: [0, Int32Array], MOD_SIN_TABLE: [1, Int32Array], MOD_STEP: [2, Int32Array],
  MOD_JUMP_SLICES: [3, Int32Array], MOD_SCATTER_FRAC: [4, Float64Array],
  EXT_JUMP_N: [5, Int32Array], EXT_SCATTER_FRAC: [6, Float64Array],
};

const addr = (v) => (v === null || v === undefined ? 0 : typeof v === "number" ? v >>> 0 : v.$ptr >>> 0);

export function engineParts(eng = new TaudEngine()) {
  const x = eng._x;
  const e = eng._e;
  const mem = eng.$mem;
  const box = x.malloc(16) >>> 0; // an int and a double, for the walks' out-parameters
  const voiceAt = (p) => mem.view("TaudVoice", p >>> 0);
  let scratchPtr = 0, scratchLen = 0;
  const ENGINE_GR_BYTES = recordSize("TaudImxGr");

  return {
    eng,

    /** A fresh voice of its own (te_voice_init). */
    voice() {
      const p = x.tw_part_voice_new() >>> 0;
      if (!p) throw new Error("out of memory");
      return voiceAt(p);
    },

    /** A fresh voice IN the background list, as an NNA leaves one. */
    backgroundVoice() { return voiceAt(x.tw_part_bg_voice(e)); },

    /** Twenty-five envelope nodes in the engine's memory, from `points`
     *  ({ value, offset }; the rest are `fill`): what a voice's
     *  `activeVolEnv` (…PanEnv, …PitchEnv, …FilterEnv) can be set to, and
     *  what the pitch/filter walks take. */
    envelope(points, fill = { value: 0, offset: 0 }) {
      const p = x.malloc(50) >>> 0;
      const u8 = new Uint8Array(x.memory.buffer, p, 50);
      for (let i = 0; i < 25; i++) {
        const pt = points[i] ?? fill;
        u8[i * 2] = pt.value;
        u8[i * 2 + 1] = pt.offset;
      }
      return p;
    },

    // ── envelope.c ──
    advanceAutoVibrato(v) { return x.tw_part_advance_auto_vibrato(e, addr(v)); },
    applyKeyLift(v, inst) { x.tw_part_apply_key_lift(addr(v), addr(inst)); },
    forceKeyLift(v) { x.tw_part_force_key_lift(addr(v)); },
    advanceEnvelope(v, tickSec) { x.tw_part_advance_envelope(e, addr(v), tickSec); },
    /** → { value, idx, time }: where the walk settles before its first tick. */
    seedPfRole(env, loopWord, susWord) {
      const value = x.tw_part_seed_pf_role(addr(env), loopWord, susWord, box, box + 8);
      return { value, idx: mem.dv.getInt32(box, true), time: mem.dv.getFloat64(box + 8, true) };
    },
    /** One tick of the pitch/filter walk from (idx, time) → { value, idx, time }. */
    advancePfRole(env, loopWord, susWord, keyOff, tickSec, idx = 0, time = 0) {
      mem.dv.setInt32(box, idx, true);
      mem.dv.setFloat64(box + 8, time, true);
      const value = x.tw_part_advance_pf_role(addr(env), loopWord, susWord, keyOff ? 1 : 0, tickSec, box, box + 8);
      return { value, idx: mem.dv.getInt32(box, true), time: mem.dv.getFloat64(box + 8, true) };
    },

    // ── filter.c ──
    refreshVoiceFilter(v) { x.tw_part_refresh_voice_filter(e, addr(v)); },
    advanceFilterGlide(v) { x.tw_part_advance_filter_glide(e, addr(v)); },

    // ── sampler.c ──
    fetchTrackerSample(v, inst, interpMode) { return x.tw_part_fetch_tracker_sample(e, addr(v), addr(inst), interpMode); },
    readSamplePoint(v, inst, idx, sampleLen, binMax, basePtr = 0) {
      return x.tw_part_read_sample_point(e, addr(v), addr(inst), idx, sampleLen, binMax, basePtr);
    },
    advancePitchRamp(v, spt) { x.tw_part_advance_pitch_ramp(e, addr(v), spt); },

    // ── trigger.c ──
    applyActiveSample(v, inst, patch) { x.tw_part_apply_active_sample(addr(v), addr(inst), addr(patch)); },
    resolveActiveEnvelopes(v, inst, patch) { x.tw_part_resolve_active_envelopes(addr(v), addr(inst), addr(patch)); },
    /** The copy an NNA takes of `src`, for lane `lane`. In no list: read it at once. */
    ghostVoice(src, lane) { return voiceAt(x.tw_part_ghost_voice(e, addr(src), lane)); },

    // ── effects.c ──
    /** One effect's row pass on voice `v` of lane `vi`; `ext` the wide cell's
     *  second argument word, or null for a narrow cell. */
    applyEffectRow(v, vi, op, rawArg, ext = null) {
      x.tw_part_apply_effect_row(e, addr(v), vi, op, rawArg, ext ?? 0, ext === null ? 0 : 1);
    },
    applyFilterParamEffect(v, vi, rawArg, isResonance) {
      x.tw_part_apply_filter_param_effect(e, addr(v), vi, rawArg, isResonance ? 1 : 0);
    },

    // ── fm.c ──
    /** Which of a rack's `count` operators its program (an array of words)
     *  reaches: a byte each, 1 or 0. */
    fmReferencedOperators(program, count) {
      const n = program.length;
      const p = x.malloc(n * 2 + count + 2) >>> 0;
      new Uint16Array(x.memory.buffer, p + ((p & 1) ? 1 : 0), n).set(program);
      const used = p + ((p & 1) ? 1 : 0) + n * 2;
      new Uint8Array(x.memory.buffer, used, count).fill(0);
      x.tw_part_fm_referenced_operators(p + ((p & 1) ? 1 : 0), n, count, used);
      const out = Uint8Array.from(new Uint8Array(x.memory.buffer, used, count));
      x.free(p);
      return out;
    },

    // ── jsmath.c ──
    /** The engine's own pow and exp: a reference formula written with these
     *  is the engine's arithmetic to the bit (Node's Math.pow is the
     *  platform's libm). */
    pow(a, b) { return x.tw_part_pow(a, b); },
    exp(v) { return x.tw_part_exp(v); },

    // ── the engine's tables ──
    /** A table of the engine's, copied out (SNES_GAUSS, MOD_SIN_TABLE,
     *  MOD_STEP, MOD_JUMP_SLICES, MOD_SCATTER_FRAC, EXT_JUMP_N, EXT_SCATTER_FRAC). */
    table(name) {
      const [which, Arr] = TABLES[name];
      const p = x.tw_part_table(which, box) >>> 0;
      const n = mem.dv.getInt32(box, true);
      return Arr.from(new Arr(x.memory.buffer, p, n));
    },
    lfoSampleWide(pos, wave) { return x.tw_part_lfo_sample_wide(e, pos, wave); },
    advanceLfoPhase(pos, speed) { return x.tw_part_advance_lfo_phase(pos, speed); },

    // ── formant.c ──
    /** The equal-loudness power weight at f Hz (only its shape matters). */
    equalLoudness(f) { return 10 ** (x.tw_part_equal_loudness_db(e, f) / 10); },

    // ── spatial.c ──
    /** SN3D/ACN harmonics up to `order` for a source at (az, el), into `out`. */
    encodeSN3D(az, el, order, out) {
      const n = (order + 1) ** 2;
      x.tw_part_encode_sn3d(az, el, order, scratch(n));
      out.set(new Float64Array(x.memory.buffer, scratchPtr, n));
      return out;
    },
    /** Where channel k of a `chans`-channel sample sits round its source. */
    sampleChannelLayout(chans, k) { return x.tw_part_sample_channel_layout(chans, k); },
    sampleChannelAngles(az, el, localAz, out) {
      x.tw_part_sample_channel_angles(az, el, localAz, scratch(2));
      out[0] = mem.dv.getFloat64(scratchPtr, true);
      out[1] = mem.dv.getFloat64(scratchPtr + 8, true);
      return out;
    },

    // ── binaural.c ──
    /** The head: { numChannels, taps, acn, channelGains(az, el, out, off),
     *  decode(bus, frames) → [left, right] (the history cleared first) }. */
    binaural(sphere = true, rate = SAMPLING_RATE) {
      const p = x.tw_part_binaural_new(sphere ? 1 : 0, rate) >>> 0;
      if (!p) throw new Error("out of memory");
      const view = mem.view("TaudBinaural", p);
      return {
        $ptr: p,
        numChannels: view.numChannels,
        taps: view.taps,
        acn: Int32Array.from(view.acn).subarray(0, view.numChannels),
        channelGains(az, el, out, off = 0) {
          x.tw_part_binaural_channel_gains(p, az, el, scratch(view.numChannels), 0);
          for (let c = 0; c < view.numChannels; c++) out[off + c] = mem.dv.getFloat64(scratchPtr + c * 8, true);
        },
        decode(bus, frames) {
          x.tw_part_binaural_reset(p);
          const n = bus.length;
          const q = x.malloc((n + 2 * frames) * 8) >>> 0;
          new Float64Array(x.memory.buffer, q, n).set(bus);
          x.tw_part_binaural_decode(p, q, frames, q + n * 8, q + (n + frames) * 8);
          const l = Float64Array.from(new Float64Array(x.memory.buffer, q + n * 8, frames));
          const r = Float64Array.from(new Float64Array(x.memory.buffer, q + (n + frames) * 8, frames));
          x.free(q);
          return [l, r];
        },
        free() { x.tw_part_binaural_free(p); },
      };
    },
    /** The HRIR set as stored: 16 channels × 256 taps, int16, channel-major. */
    hrirTable() { return Int16Array.from(new Int16Array(x.memory.buffer, x.tw_part_hrir_table() >>> 0, 16 * 256)); },

    // ── imix.c ──
    /** An instrument mixing chain on `block` (the Mixing tab's block object):
     *  process(data, stride, n0, n1, bpm, fed) runs a channel-major Float64Array
     *  in place, readGr() → the gain-reduction readout, setBlock, reset,
     *  noteOn, idle, unisonNow() → { curCents, curWidth } or null. */
    imixChain(block, rate = SAMPLING_RATE, nch = 2, stereo = true, ambisonic = false) {
      const withBytes = (b, fn) => {
        const bytes = buildImixSection([{ ...b, id: b.id || 1 }]);
        const q = x.malloc(bytes.length) >>> 0;
        new Uint8Array(x.memory.buffer, q, bytes.length).set(bytes);
        try { return fn(q, bytes.length); } finally { x.free(q); }
      };
      const c = withBytes(block, (q, n) => x.tw_part_imix_chain_new(q, n, rate, nch, stereo ? 1 : 0, ambisonic ? 1 : 0)) >>> 0;
      if (!c) throw new Error("no valid block (or out of memory)");
      // The engine runs a chain over its bus a chunk at a time, stride
      // TRACKER_CHUNK, and the chain's scratch is that wide: a span of any
      // shape is fed to it as engine-shaped pieces (its output does not
      // depend on where a span is cut — imix.test.js pins that).
      const buf = x.malloc(nch * TRACKER_CHUNK * 8) >>> 0;
      const grPtr = x.malloc(ENGINE_GR_BYTES) >>> 0;
      return {
        $ptr: c,
        process(data, stride, n0, n1, bpm = 125, fed = true) {
          for (let s = n0; s < n1; s += TRACKER_CHUNK) {
            const m = Math.min(TRACKER_CHUNK, n1 - s);
            let w = new Float64Array(x.memory.buffer, buf, nch * TRACKER_CHUNK);
            for (let ch = 0; ch < nch; ch++) w.set(data.subarray(ch * stride + s, ch * stride + s + m), ch * TRACKER_CHUNK);
            x.tw_part_imix_chain_process(c, buf, TRACKER_CHUNK, 0, m, bpm, fed ? 1 : 0);
            w = new Float64Array(x.memory.buffer, buf, nch * TRACKER_CHUNK); // the memory may have grown
            for (let ch = 0; ch < nch; ch++) data.set(w.subarray(ch * TRACKER_CHUNK, ch * TRACKER_CHUNK + m), ch * stride + s);
          }
        },
        readGr() {
          x.tw_part_imix_chain_read_gr(c, grPtr);
          const g = mem.view("TaudImxGr", grPtr);
          return {
            comp: Float64Array.from(g.comp), deq1: Float64Array.from(g.deq1), deq2: Float64Array.from(g.deq2),
            tsh1: Float64Array.from(g.tsh1), expd: g.expd, expdLvl: g.expdLvl, lim: g.lim,
            compLvl: Float64Array.from(g.compLvl), deq1Lvl: Float64Array.from(g.deq1Lvl),
            deq2Lvl: Float64Array.from(g.deq2Lvl),
          };
        },
        setBlock(b) { withBytes(b, (q, n) => x.tw_part_imix_chain_set_block(c, q, n)); },
        reset() { x.tw_part_imix_chain_reset(c); },
        noteOn() { x.tw_part_imix_chain_note_on(c); },
        get idle() { return x.tw_part_imix_chain_idle(c) !== 0; },
        unisonNow() {
          if (!x.tw_part_imix_chain_unison_now(c, scratch(2))) return null;
          return { curCents: mem.dv.getFloat64(scratchPtr, true), curWidth: mem.dv.getFloat64(scratchPtr + 8, true) };
        },
        free() { x.tw_part_imix_chain_free(c); x.free(buf); x.free(grPtr); },
      };
    },
    /** An LFO's phase increment per sample (16.16 per sample, as the file's rate). */
    imixLfoIncrement(sync, rate, bpm, fs) { return x.tw_part_imix_lfo_increment(sync ? 1 : 0, rate, bpm, fs); },

    // ── opl.c ──
    opl: {
      /** A patch decoded from its block (encodeOplPatch's bytes): a TaudOplPatch view. */
      patch(block) { return mem.view("TaudOplPatch", withBlock(block, (q) => x.tw_part_opl_patch_new(q))); },
      /** A fresh channel: a TaudOplState view. */
      state() { return mem.view("TaudOplState", x.tw_part_opl_state_new()); },
      keyOn(st, patch, carry = false) { x.tw_part_opl_key_on(addr(st), addr(patch), carry ? 1 : 0); },
      keyOff(st) { x.tw_part_opl_key_off(addr(st)); },
      /** The channel at output frame `frame` (oplRender): retunes, steps the chip. */
      render(st, frame, rate, vol = 1, keyOff = false) {
        return x.tw_part_opl_render(e, addr(st), frame, rate, vol, keyOff ? 1 : 0);
      },
      chipStep(st, k) { return x.tw_part_opl_chip_step(addr(st), k); },
      expand(att) { return x.tw_part_opl_expand(att); },
      blockFnum(hz, lowFnum) { return x.tw_part_opl_block_fnum(hz, lowFnum ? 1 : 0); },
      logSin() { return Uint16Array.from(new Uint16Array(x.memory.buffer, x.tw_part_opl_log_sin() >>> 0, 256)); },
      exp() { return Uint16Array.from(new Uint16Array(x.memory.buffer, x.tw_part_opl_exp() >>> 0, 256)); },
    },

    // ── psg.c ──
    psg: {
      /** A patch decoded from its block (encodePsgPatch's bytes): a TaudPsgPatch view. */
      patch(block) { return mem.view("TaudPsgPatch", withBlock(block, (q) => x.tw_part_psg_patch_new(q))); },
      state() { return mem.view("TaudPsgState", x.tw_part_psg_state_new()); },
      keyOn(st, patch, carry = false) { x.tw_part_psg_key_on(addr(st), addr(patch), carry ? 1 : 0); },
      keyOff(st) { x.tw_part_psg_key_off(addr(st)); },
      quarterTick(st) { x.tw_part_psg_quarter_tick(addr(st)); },
      currentWave(st, i) { return x.tw_part_psg_current_wave(addr(st), i); },
      render(st, frame, rate, keyOff = false) { return x.tw_part_psg_render(e, addr(st), frame, rate, keyOff ? 1 : 0); },
      writeRegister(patch, reg) { return x.tw_part_psg_write_register(addr(patch), reg) !== 0; },
      level(patch, i) { return x.tw_part_psg_level(addr(patch), i); },
      muted(patch, i) { return x.tw_part_psg_muted(addr(patch), i) !== 0; },
    },

    // ── samplemod.c ──
    samplemod: {
      /** The $se region byte → its code (0 none, 1 an extent, 2 a comb), with
       *  [from, to, combBits, combOdd] in `out`. */
      decodeSampleRegion(se, out) {
        const code = x.tw_part_decode_sample_region(se, scratch(4));
        for (let i = 0; i < 4; i++) out[i] = mem.dv.getFloat64(scratchPtr + i * 8, true);
        return code;
      },
      modStepPeriod(y) { return x.tw_part_mod_step_period(y); },
      /** A jump's rotation, drawn from the engine's own random stream. */
      jumpRot(op, domainLen) { return x.tw_part_jump_rot(e, op, domainLen); },
      scatterReach(op, domainLen) { return x.tw_part_scatter_reach(op, domainLen); },
      decodeExtOp(code) {
        const kind = x.tw_part_decode_ext_op(code, scratch(1));
        return { kind: EXT_KINDS[kind], param: mem.dv.getFloat64(scratchPtr, true) };
      },
      extJitterFrac(v) { return x.tw_part_ext_jitter_frac(v); },
      extYkPeriodTicks(yk) { return x.tw_part_ext_yk_period_ticks(yk); },
      /** applyExtLevelPrev on an instrument of this engine's. */
      applyExtLevelPrev(inst, b) { return x.tw_part_apply_ext_level_prev(addr(inst), b); },
    },
  };

  /** Copy a patch block into the engine's memory for fn(ptr); returns fn's
   *  result as an address. */
  function withBlock(block, fn) {
    const q = x.malloc(block.length) >>> 0;
    new Uint8Array(x.memory.buffer, q, block.length).set(block);
    try { return fn(q) >>> 0; } finally { x.free(q); }
  }
  /** A scratch array of `n` doubles in the engine's memory (one, reused). */
  function scratch(n) {
    if (n > scratchLen) {
      if (scratchPtr) x.free(scratchPtr);
      scratchPtr = x.malloc(n * 8) >>> 0;
      scratchLen = n;
    }
    return scratchPtr;
  }
}
