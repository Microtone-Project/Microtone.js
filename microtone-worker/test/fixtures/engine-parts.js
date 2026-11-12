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

import { TaudEngine } from "../../core/engine/engine.js";

const addr = (v) => (v === null || v === undefined ? 0 : typeof v === "number" ? v >>> 0 : v.$ptr >>> 0);

export function engineParts(eng = new TaudEngine()) {
  const x = eng._x;
  const e = eng._e;
  const mem = eng.$mem;
  const box = x.malloc(16) >>> 0; // an int and a double, for the walks' out-parameters
  const voiceAt = (p) => mem.view("TaudVoice", p >>> 0);

  return {
    eng,

    /** A fresh voice of its own (voice.js `new Voice()`). */
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
  };
}
