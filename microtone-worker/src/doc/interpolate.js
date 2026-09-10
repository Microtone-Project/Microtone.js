// Block interpolation (item 181) — the maths, with no view and no document.
//
// Every editable column of a pattern cell is, underneath, a column of NUMBERS
// with holes in it. Interpolation fills the holes: the numbers already written
// are CONTROL POINTS, the gaps between consecutive ones are segments, and a
// curve carries each segment from one control point to the next. That is the
// whole idea, and it is the same idea whether the column is a 4096-TET note
// word, a volume level, a spherical direction or one byte of a vibrato
// argument — which is why the shape of this file is one interpolator over a
// set of TRACKS, plus a per-column accessor that says which tracks a column
// has and how to read and write them.
//
// Three rules run through all of it:
//
//   * Nothing is ever stamped over a command. A row whose column carries
//     something interpolation cannot speak for — a key-off in the note column,
//     a volume SLIDE, an effect that is not in FX_INTERP — is BLOCKED: it is
//     not a control point and it is never written. A pitch glide with a
//     key-off in the middle of it keeps the key-off and leaves that row alone.
//   * Only the gaps are written. Between two control points the rows that were
//     already empty get the curve; the control points themselves are left
//     exactly as they were typed, so re-interpolating a block is idempotent.
//   * …unless the block is a STAIRCASE, which is the case where "only the gaps"
//     means nothing at all: a hand-written fade of thirteen rows of `24` then
//     thirteen of `20` has no gaps, and the numbers a composer wants smoothed
//     are the STEPS. `collapse` throws away every row of a run but its first,
//     which turns the steps back into control points and the flats between
//     them into the gaps. The caller is expected to have said so out loud
//     first — this rewrites cells that already had values.
//
// The Kotlin engine has no counterpart: this is an editor transform, not
// playback behaviour, so there is nothing here to keep diffable against it.

import {
  readVol, writeVol, writeVolSel, readPan, writePan, writePanSel,
  readElev, writeElev,
} from "./patterntools.js";
import { EffectOp } from "../engine/tables.js";

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);
const wrapTo = (v, n) => ((v % n) + n) % n;

// ── the curves ──

/** The five shapes offered, in the order a chooser should list them. */
export const INTERP_SHAPES = ["linear", "cosine", "concave", "convex", "hermite"];

/** The two ways a NOTE column can be interpolated (see planInterpolate). */
export const PITCH_MODES = ["continuous", "glissando"];

// SoundFont 2's own pair of curves, in the form every SF2 player implements
// them (FluidSynth's conversion tables): with `u` the input over 0…1,
//
//     concave(u) = −(40/96)·log10(1 − u)      convex(u) = 1 + (40/96)·log10(u)
//
// both clamped into 0…1, which is what pins the ends (the logarithm runs away
// in the last half per cent). Concave holds LOW and then rushes — the shape of
// an SF2 volume attack — and convex is its mirror. They are here rather than a
// pair of hand-drawn eases so that a fade written with them matches the curve
// an SF2 envelope would have drawn over the same span.
const SF2_K = 40 / 96;

/** Easing for the four non-spline shapes: 0…1 in, 0…1 out. Hermite is not an
 *  easing (it needs its neighbours) and falls through to linear here. */
export function easeAt(shape, t) {
  switch (shape) {
    case "cosine": return (1 - Math.cos(Math.PI * t)) / 2;
    // Both ends are pinned by hand: the logarithm runs away at one of them,
    // and at the other it returns a negative zero that would travel.
    case "concave": return t <= 0 ? 0 : t >= 1 ? 1 : clamp01(-SF2_K * Math.log10(1 - t));
    case "convex": return t <= 0 ? 0 : clamp01(1 + SF2_K * Math.log10(t));
    default: return t;
  }
}

/**
 * Evaluate one track over its control points.
 *
 * `points` is `[{i, v}]` with strictly ascending `i`. Returns a Map from every
 * integer index between the first and last control point to its value —
 * including the control points themselves, which the caller then declines to
 * write.
 *
 * Hermite is a Catmull-Rom spline with finite-difference tangents, so it runs
 * THROUGH every control point (rather than near them) while carrying the slope
 * across each one; the other four are per-segment eases and know nothing about
 * their neighbours. Hermite can overshoot the control points' own range, which
 * is the point of it — the clamp at the end of the pipeline catches the rest.
 */
export function seriesValues(points, shape) {
  const out = new Map();
  const n = points.length;
  if (n === 0) return out;
  if (n === 1) { out.set(points[0].i, points[0].v); return out; }
  let m = null;
  if (shape === "hermite") {
    m = new Array(n);
    for (let k = 0; k < n; k++) {
      const a = points[Math.max(k - 1, 0)], b = points[Math.min(k + 1, n - 1)];
      m[k] = b.i === a.i ? 0 : (b.v - a.v) / (b.i - a.i);
    }
  }
  for (let k = 0; k < n - 1; k++) {
    const p0 = points[k], p1 = points[k + 1];
    const h = p1.i - p0.i;
    for (let i = p0.i; i <= p1.i; i++) {
      const t = h === 0 ? 0 : (i - p0.i) / h;
      if (m) {
        const t2 = t * t, t3 = t2 * t;
        out.set(i, (2 * t3 - 3 * t2 + 1) * p0.v + (t3 - 2 * t2 + t) * h * m[k] +
                   (-2 * t3 + 3 * t2) * p1.v + (t3 - t2) * h * m[k + 1]);
      } else {
        out.set(i, p0.v + (p1.v - p0.v) * easeAt(shape, t));
      }
    }
  }
  return out;
}

// ── which effect arguments can be interpolated ──
//
// Judgement, not a rule anyone could derive: an argument is interpolatable when
// its fields are QUANTITIES that a value halfway between two of them still
// means something for. That rules out every nibble-packed slide pair (D, N, W,
// K, L, P, Q), where the two nibbles are a discriminated union — "up by x" and
// "down by y" — so an average of two of them is a different command, not a
// middle one. It rules out the switches (S's other forms, 1, 7). What is left
// is the depths, speeds, offsets, levels and directions below.
//
// `fields` are the argument's sub-fields, low bit first, each `{shift, bits}`
// (`signed` where the field is an S8, so an elevation crossing zero does not
// take the long way round through straight-down). Everything OUTSIDE the listed
// fields is INHERITED from the segment's left control point, which is what
// keeps `8`'s clipping-mode nibble and `S $80xx`'s form selector intact.
//
// `ok(arg)` rejects arguments that are not values at all: for the effects that
// recall their last argument (§7 of the effects reference) `$0000` means
// "carry on with what you had", and reading that as the number zero would
// interpolate a ramp down to a command that never said so.
const F16 = [{ shift: 0, bits: 16 }];
const F_HI = [{ shift: 8, bits: 8 }];
const F_LO = [{ shift: 0, bits: 8 }];
const F_BYTES = [{ shift: 8, bits: 8 }, { shift: 0, bits: 8 }];
const nonZero = (a) => a !== 0;

export const FX_INTERP = {
  // Pitch: slide rates and portamento speed. Ramping these accelerates a slide.
  [EffectOp.OP_E]: { fields: F16, ok: nonZero },
  [EffectOp.OP_F]: { fields: F16, ok: nonZero },
  [EffectOp.OP_G]: { fields: F16, ok: nonZero },
  // The LFOs: speed in the high byte, depth in the low one, independent.
  [EffectOp.OP_H]: { fields: F_BYTES, ok: nonZero },
  [EffectOp.OP_U]: { fields: F_BYTES, ok: nonZero },
  [EffectOp.OP_R]: { fields: F_BYTES, ok: nonZero },
  [EffectOp.OP_Y]: { fields: F_BYTES, ok: nonZero },
  // Tremor's on/off times and the arpeggio's two offsets are the same shape.
  [EffectOp.OP_I]: { fields: F_BYTES, ok: nonZero },
  [EffectOp.OP_J]: { fields: F_BYTES, ok: nonZero },
  // Sample offset — a sweep down a recording, the granular one.
  [EffectOp.OP_O]: { fields: F16, ok: nonZero },
  // Absolute levels. M and V take their argument at face value (§7), so zero
  // is a real "set to silence" and a fade INTO it is exactly what is wanted.
  [EffectOp.OP_M]: { fields: F_HI },
  [EffectOp.OP_V]: { fields: F_HI },
  // Tick speed: the low byte is reserved, and `$0000` is ignored outright.
  [EffectOp.OP_A]: { fields: F_HI, ok: (a) => (a >>> 8) !== 0 },
  // Tempo multiplexes on its high byte — `$00xy` is a slide and `$FFxx` the
  // extended set — so only the plain set form is a level to ramp between.
  [EffectOp.OP_T]: { fields: F_HI, ok: (a) => (a >>> 8) !== 0 && (a >>> 8) !== 0xff },
  // Filter cutoff / resonance. `$FFFF` is the reset sentinel, not a value.
  [EffectOp.OP_5]: { fields: F16, ok: (a) => a !== 0xffff },
  [EffectOp.OP_6]: { fields: F16, ok: (a) => a !== 0xffff },
  // Bitcrusher: depth nibble and skip byte sweep, clipping mode inherited.
  [EffectOp.OP_8]: { fields: [{ shift: 8, bits: 4 }, { shift: 0, bits: 8 }],
    ok: (a) => (a & 0x0fff) !== 0 },
  // Overdrive: the amplification byte, clipping mode inherited.
  [EffectOp.OP_9]: { fields: F_LO, ok: (a) => (a & 0x0fff) !== 0 },
  // S is a family, and only `S $80xx` — set channel pan — carries a byte.
  [EffectOp.OP_S]: { fields: F_LO, ok: (a) => (a >>> 8) === 0x80 },
  // The spherical pair: elevation (signed) over azimuth. X places the channel,
  // 4 places the target a Z slide travels to; both are directions.
  [EffectOp.OP_X]: { fields: [{ shift: 8, bits: 8, signed: true }, { shift: 0, bits: 8 }] },
  [EffectOp.OP_4]: { fields: [{ shift: 8, bits: 8, signed: true }, { shift: 0, bits: 8 }] },
};

/** True when `op` names an effect whose argument this can interpolate. */
export function isInterpolatableFx(op, arg) {
  const spec = FX_INTERP[op];
  return !!spec && (spec.ok ? spec.ok(arg & 0xffff) : true);
}

const fieldGet = (arg, f) => {
  const mask = (1 << f.bits) - 1;
  const v = (arg >>> f.shift) & mask;
  return f.signed && v >= 1 << (f.bits - 1) ? v - (1 << f.bits) : v;
};
const fieldSet = (arg, f, v) => {
  const mask = (1 << f.bits) - 1;
  return ((arg & ~(mask << f.shift)) | ((v & mask) << f.shift)) & 0xffff;
};
const fieldLimit = (f) => (f.signed
  ? (v) => clamp(v, -(1 << (f.bits - 1)), (1 << (f.bits - 1)) - 1)
  : (v) => clamp(v, 0, (1 << f.bits) - 1));

// ── per-column access ──
//
// `classify(bytes)` sorts a row into one of three states —
//   "point"    the column holds a number: a control point, carried in `vals`
//              (one entry per track) with `tag` grouping points that belong to
//              the same curve (the effect opcode; 0 everywhere else) and `raw`
//              whatever else the write has to inherit;
//   "blocked"  the column holds something interpolation must not speak for;
//   "empty"    the column is the format's own no-op — a gap to fill.
// `limit[k]` quantises track k after rounding, and `write` puts a whole row's
// worth of already-quantised tracks back into the cell.

/** The column accessor for `kind` ("note"/"vol"/"pan"/"fx"/"fx2"). */
export function columnAccess(kind, wide) {
  switch (kind) {
    case "note": return {
      classify(b) {
        const note = b[0] | (b[1] << 8);
        if (note === 0) return { state: "empty" };
        // $0001…$001F are the sentinels — key-off, cut, fade, the interrupt
        // markers. None of them is a pitch, and a glide must not eat one.
        if (note < 0x20) return { state: "blocked" };
        return { state: "point", vals: [note], tag: 0, raw: note };
      },
      limit: [(v) => clamp(v, 0x20, 0xffff)],
      write(b, vals) { b[0] = vals[0] & 0xff; b[1] = (vals[0] >>> 8) & 0xff; },
    };
    case "vol": return {
      classify(b) {
        const { value, sel } = readVol(b, 0, wide);
        if (sel === 3 && value === 0) return { state: "empty" };
        // A slide or a fine delta is a MOVE, not a level: there is no number
        // here for a curve to pass through, and overwriting one would silently
        // turn a ramp the composer wrote by hand into a jump.
        if (sel !== 0) return { state: "blocked" };
        return { state: "point", vals: [value], tag: 0, raw: value };
      },
      limit: [(v) => clamp(v, 0, wide ? 0xff : 0x3f)],
      write(b, vals) { writeVol(b, 0, wide, vals[0]); writeVolSel(b, 0, wide, 0); },
    };
    case "pan": return wide ? {
      classify(b) {
        const { value, sel } = readPan(b, 0, true);
        if (sel === 3 && value === 0 && readElev(b, 0, true) === 0) return { state: "empty" };
        if (sel !== 0) return { state: "blocked" };
        return { state: "point", vals: [value, readElev(b, 0, true)], tag: 0, raw: 0 };
      },
      // The azimuth is an ANGLE, so an overshooting spline carries on round the
      // listener rather than piling up on hard left; elevation is a segment
      // from pole to pole and clamps.
      limit: [(v) => wrapTo(v, 512), (v) => clamp(v, -128, 127)],
      write(b, vals) {
        writePan(b, 0, true, vals[0]);
        writeElev(b, 0, true, vals[1]);
        writePanSel(b, 0, true, 0);
      },
    } : {
      classify(b) {
        const { value, sel } = readPan(b, 0, false);
        if (sel === 3 && value === 0) return { state: "empty" };
        if (sel !== 0) return { state: "blocked" };
        return { state: "point", vals: [value], tag: 0, raw: value };
      },
      // The narrow column is a front ARC, not a circle: past its ends there is
      // nothing, so it clamps (the same split transformPanAt already makes).
      limit: [(v) => clamp(v, 0, 0x3f)],
      write(b, vals) { writePan(b, 0, false, vals[0]); writePanSel(b, 0, false, 0); },
    };
    case "fx":
    case "fx2": {
      const op = kind === "fx2" ? 10 : 5;
      const lo = op + 1, hi = op + 2;
      return {
        classify(b) {
          const code = b[op], arg = b[lo] | (b[hi] << 8);
          if (code === 0 && arg === 0) return { state: "empty" };
          const spec = FX_INTERP[code];
          if (!spec || (spec.ok && !spec.ok(arg))) return { state: "blocked" };
          return { state: "point", vals: spec.fields.map((f) => fieldGet(arg, f)),
            tag: code, raw: arg };
        },
        // The track count follows the OPCODE, which is not known until a
        // control point has been read, so the limits are resolved per group.
        limitFor: (tag) => FX_INTERP[tag].fields.map(fieldLimit),
        write(b, vals, src) {
          let arg = src.raw;
          FX_INTERP[src.tag].fields.forEach((f, k) => { arg = fieldSet(arg, f, vals[k]); });
          b[op] = src.tag & 0xff;
          b[lo] = arg & 0xff;
          b[hi] = (arg >>> 8) & 0xff;
        },
      };
    }
    default: return null;
  }
}

// ── the plan ──

const cellKey = (pat, row) => `${pat}:${row}`;
const sameVals = (a, b) =>
  a.tag === b.tag && a.vals.length === b.vals.length && a.vals.every((v, k) => v === b.vals[k]);

/** Two channels of a Timeline block can be pointed at the same patterns, which
 *  would make one lane's writes fight the other's over the same cells for no
 *  gain. Identical lanes are one lane. */
function dedupeLanes(lanes) {
  const seen = new Set();
  return lanes.filter((lane) => {
    if (!lane || lane.length === 0) return false;
    if (!lane.some((c) => c)) return false;
    const k = lane.map((c) => (c ? cellKey(c.pat, c.row) : "-")).join("|");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Interpolate `kinds` down every lane.
 *
 * `lanes` is a list of ORDERED `[{pat, row} | null]` runs — one per channel of
 * a Timeline block (a lane crosses patterns, because a song row does), or the
 * single row range of a Patterns column. A `null` entry is a song row this
 * channel has no cell on, and it holds the lane's SPACING: collapsing those out
 * would let a curve run straight across a stretch of song where the channel is
 * not playing. `readCell(pat, row)` hands back that cell's bytes or null.
 *
 * Returns `{ writes, usable, stairs, points }`: `writes` is the
 * `[{pat, row, bytes}]` list setCellsBytesOp wants (one entry per cell, however
 * many columns wrote into it), `usable` the number of curves that had two
 * control points to run between — zero means there is nothing to interpolate —
 * `points` the control points seen, and `stairs` whether any lane looked like a
 * staircase, which is the caller's cue to ask before passing `collapse`.
 */
export function planInterpolate({
  lanes, readCell, kinds, wide = false,
  shape = "linear", dither = false, pitchMode = "continuous",
  snapNote = null, collapse = false, rng = Math.random,
}) {
  const cache = new Map();
  const dirty = new Map();
  const cellBytes = (pat, row) => {
    const k = cellKey(pat, row);
    if (cache.has(k)) return cache.get(k);
    const b = readCell(pat, row) ?? null;
    cache.set(k, b);
    return b;
  };
  const out = { writes: [], usable: 0, stairs: false, points: 0 };

  for (const lane of dedupeLanes(lanes)) {
    for (const kind of kinds) {
      const acc = columnAccess(kind, wide);
      if (!acc) continue;
      const n = lane.length;
      const recs = new Array(n);
      for (let i = 0; i < n; i++) {
        const b = lane[i] ? cellBytes(lane[i].pat, lane[i].row) : null;
        recs[i] = b ? acc.classify(b) : { state: "blocked" };
      }

      let idx = [];
      for (let i = 0; i < n; i++) if (recs[i].state === "point") idx.push(i);
      out.points += idx.length;

      // Staircase: almost every row filled, and the filled rows sit in runs of
      // equal value rather than each saying something new. Both halves matter —
      // a dense column of DISTINCT values is a curve someone already drew, and
      // a sparse staircase still has gaps to fill the ordinary way.
      const runs = [];
      for (const i of idx) {
        const last = runs.length ? runs[runs.length - 1] : null;
        if (last && last.end === i - 1 && sameVals(recs[last.end], recs[i])) last.end = i;
        else runs.push({ start: i, end: i });
      }
      const stairs = n >= 4 && idx.length >= Math.ceil(n * 0.75) &&
        runs.length >= 2 && idx.length >= runs.length * 2;
      if (stairs) out.stairs = true;
      if (stairs && collapse) idx = runs.map((r) => r.start);

      const isPoint = new Set(idx);
      // A curve runs between control points that mean the same thing — for an
      // effect column that is the same OPCODE, so a block holding vibrato and
      // then tremolo interpolates each of them and nothing across the join.
      const groups = [];
      for (const i of idx) {
        const g = groups.length ? groups[groups.length - 1] : null;
        if (g && recs[g[g.length - 1]].tag === recs[i].tag) g.push(i);
        else groups.push([i]);
      }

      for (const group of groups) {
        if (group.length < 2) continue;
        out.usable++;
        const tag = recs[group[0]].tag;
        const limits = acc.limitFor ? acc.limitFor(tag) : acc.limit;
        const tracks = limits.length;
        const series = [];
        for (let k = 0; k < tracks; k++) {
          series.push(seriesValues(group.map((i) => ({ i, v: recs[i].vals[k] })), shape));
        }
        // Glissando (note column only): the curve is quantised onto the
        // notation's own grid and a row is written only where that grid step
        // CHANGES, so a glide reads as the notes it passes through instead of
        // retriggering on all 64 rows. `last` re-anchors on every control
        // point, since the composer's own note is what the ear hears next.
        const gliss = kind === "note" && pitchMode === "glissando" && snapNote !== null;
        let last = null;
        for (let g = 0; g < group.length - 1; g++) {
          if (gliss) last = recs[group[g]].vals[0];
          for (let i = group[g] + 1; i < group[g + 1]; i++) {
            if (recs[i].state === "blocked" || isPoint.has(i)) continue;
            const bytes = cellBytes(lane[i].pat, lane[i].row);
            if (!bytes) continue;
            const vals = new Array(tracks);
            let skip = false;
            for (let k = 0; k < tracks; k++) {
              const raw = series[k].get(i);
              // Dither is RPDF probabilistic rounding: the output is always
              // one of the two integers the exact value sits between, chosen
              // with the probability its fraction says. A ramp shallower than
              // one step per row then tracks the true line on average instead
              // of laying down a fresh staircase of its own.
              const q = dither ? Math.floor(raw + rng()) : Math.round(raw);
              vals[k] = limits[k](q);
            }
            if (gliss) {
              const snapped = snapNote(vals[0]);
              if (snapped === last) skip = true;
              else { vals[0] = snapped; last = snapped; }
            }
            if (skip) continue;
            acc.write(bytes, vals, recs[group[g]]);
            dirty.set(cellKey(lane[i].pat, lane[i].row), { pat: lane[i].pat, row: lane[i].row, bytes });
          }
        }
      }
    }
  }
  out.writes = [...dirty.values()];
  return out;
}
