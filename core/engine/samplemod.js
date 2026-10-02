// Sample-modification note effects (items 130, 152, 153) — notefx 2 and 3, ONE
// command with two spellings: `3` names the region to modify, `2` names the
// region to leave alone. Both are NON-DESTRUCTIVE views over the sample pool,
// exactly as S $Fxxx is: the state lives on the INSTRUMENT and is applied when
// a byte is read (sampler.js readSamplePoint), so the pool itself is never
// written.
//
// Behavioural contract: TAUD_NOTE_EFFECTS.md §"2 $sexy and 3 $sexy".
//
//   $s $e   the region (see decodeSampleRegion)
//   $x      the operation — one at a time, so an instrument carries ONE
//           modification and writing either opcode replaces it
//   $y      the step period in TICKS: $F every tick, $E every other one, down
//           to $1 every fifteenth; $0 freezes (see modStepPeriod)
//
// EVERYTHING IS RELATIVE TO THE LOOP REGION (item 153). The command's domain is
// the sounding voice's loop when it has one and the whole sample when it does
// not, and every selector, every comb, every wrap and every jump quantum is
// measured against THAT — never against raw byte counts and never against the
// base record, so an Ixmp-patched voice follows its own loop (item 116) and a
// region written for one sample means the same thing on the next. The extent is
// therefore stored as a FRACTION pair and resolved per voice at read time
// (resolveModGeom), which is also what lets $A's eighths land on the eighths of
// a bar-length loop rather than of the file that contains it.
//
// Region argument, decoded once here so the two spellings cannot drift apart:
//
//   $00        the whole domain — the loop region, as S $Fxxx has always meant
//              it (same span as $0F, which is the spelling to reach for when
//              the point is "all of it" rather than "the loop")
//   $s..$e     s <= e: from s/16 to (e+1)/16 of the domain, rounded
//              — so $0F is all of it and $4B the middle half
//   $10        middle half            $20 first two thirds   $21 last two thirds
//   $30 $31 $32  first / middle / last third
//   $F0..$FE   COMB, even bristles: cut the extent into 2^(n+1) equal chunks
//              and keep the 0th, 2nd, 4th… — $F0 is the first HALF, $F1 is
//              '1-3-' of four, $FE is 32768 bristles
//   $E0..$ED   COMB, odd bristles: the same cut keeping the 1st, 3rd, 5th…
//              — $E0 is the second half, $E1 is '-2-4' of four
//   otherwise (s > e)  reserved — the whole command is ignored

import { random } from "./rng.js";

/** decodeSampleRegion result: nothing (reserved argument). */
export const REGION_NONE = 0;
/** decodeSampleRegion result: out = [from, to, combBits, combOdd] — a whole region. */
export const REGION_SET = 1;
/** decodeSampleRegion result: out[2..3] = the comb only; the extent is kept. */
export const REGION_COMB = 2;

// ── the operations ($x) ──────────────────────────────────────────────────────
// ROL rotates the region's BYTES left by 1/2/4/8 per step (there is no
// rotate-right: a left rotation of n and a right rotation of span−n are the
// same picture, and the ladder is more useful spent on step sizes). SUB
// subtracts from each byte's U8 value, wrapping through zero, by 2/8/32/128 per
// step — a running level slide that folds rather than clips.
//
// The rest of the nibble is two random families that share the ROL ladder's
// address transform and differ in what they apply it to. Every draw in both is
// UNIFORM (item 153.10).
//
// JUMP ($A $B $C) throws the WHOLE region to a new offset each step — the
// waveform arrives intact, somewhere else, a randomised `O $xxyy`, one draw a
// step. All three reach the whole domain and they differ in GRAIN: $A lands
// only on eighths of it and $B only on sixteenths, so a one-bar drum loop is
// re-dealt a slice at a time and every throw lands where a hit starts; $C lands
// anywhere, mid-transient included.
//
// SCATTER ($D $E $F) throws EVERY BYTE its own way, within 1/512, 1/64 or 1/8
// of the domain: the region is shuffled rather than moved. The ladder stops at
// an eighth on purpose — wider than that, the bytes a throw lands among have
// nothing to do with the ones it left, the interpolator averages strangers, and
// every setting past it arrives at the same quiet white noise. Kept near home
// the throw is a glitch in the waveform rather than a replacement for it, which
// is the sound this family is for.
export const MOD_OFF = 0x0;
export const MOD_INVERT = 0x1;
export const MOD_ROL1 = 0x2;
export const MOD_ROL8 = 0x5;
export const MOD_SUB2 = 0x6;
export const MOD_SUB128 = 0x9;
export const MOD_JUMP8 = 0xa;
export const MOD_JUMP16 = 0xb;
export const MOD_JUMP_ALL = 0xc;
export const MOD_RND512 = 0xd;
export const MOD_RND8 = 0xf;
/** Highest operation; every $x nibble is assigned since item 152's second half. */
export const MOD_MAX = MOD_RND8;

/** Step size per operation — bytes for the ROLs, U8 levels for the SUBs. The
 *  random operations take their reach from their own tables, so they read 0. */
export const MOD_STEP = Object.freeze(
  [0, 0, 1, 2, 4, 8, 2, 8, 32, 128, 0, 0, 0, 0, 0, 0]);

/** How many equal slices a quantised jump throws to, by op − MOD_JUMP8. Eight
 *  is a bar of eighths and sixteen a bar of sixteenths, which is what makes the
 *  throw land where a drum loop's hits start. */
export const MOD_JUMP_SLICES = Object.freeze([8, 16]);

/** SCATTER reach as a fraction of the wrap domain, by op − MOD_RND512. Each
 *  BYTE is thrown up to this far, uniformly and independently of its
 *  neighbours, so the fraction is a hard bound rather than a typical throw. */
export const MOD_SCATTER_FRAC = Object.freeze([1 / 512, 1 / 64, 1 / 8]);

/** Largest comb exponent: $FE cuts the extent into 2^15 = 32768 bristles. The
 *  odd-bristle ladder stops at $ED (16384) because $EE and $EF already read as
 *  ordinary s <= e extents. */
export const MOD_COMB_MAX = 0xe;
export const MOD_COMB_ODD_MAX = 0xd;

/**
 * How far the INVERT walk may scan for the next byte the modification touches.
 * An inverted region can exclude almost the whole domain, and the walk must
 * not turn into a linear search for the one byte that is left — past this many
 * misses the step simply does not land. Well above any musically useful comb.
 */
export const MOD_WALK_SCAN = 4096;

/**
 * Anti-click crossfade, in output samples (item 153.5). Every step of an
 * address or level transform is a discontinuity — a jump teleports the
 * waveform, a scatter re-deals it, SUB128 inverts it — and at $y = $F that is
 * one discontinuity per tick, which is what the clicking IS. So a step does not
 * take effect instantly: for 2 ms the voice reads BOTH mappings and crossfades
 * between them, which costs one extra pool read per tap for 64 samples and
 * turns the click into a transition. Long enough to bury the edge, short enough
 * to leave the effect its bite.
 */
export const MOD_XFADE_SAMPLES = 64;

export const isRolOp = (op) => op >= MOD_ROL1 && op <= MOD_ROL8;
export const isSubOp = (op) => op >= MOD_SUB2 && op <= MOD_SUB128;
export const isJumpOp = (op) => op >= MOD_JUMP8 && op <= MOD_JUMP_ALL;
export const isRndOp = (op) => op >= MOD_RND512 && op <= MOD_RND8;

/**
 * The step period in TICKS for speed nibble $y (item 153.1): $F every tick, $E
 * every other tick, … $1 every fifteenth, $0 frozen.
 *
 * ProTracker's funk-speed ladder is gone from this command. That table is an
 * accumulator divisor — it exists because EFx had to fit its timing into a
 * running sum, which buys an uneven ladder whose steps land where the arithmetic
 * puts them rather than where the bar does. Nothing here needs that compromise,
 * and $A in particular is worth nothing without exact timing: a randomised drum
 * loop has to re-deal itself ON the tick grid or it is not in time. (S $Fxxx
 * keeps the historical ladder — it is ProTracker's effect and stays its own.)
 */
export function modStepPeriod(y) {
  return (y & 0xf) === 0 ? 0 : 16 - (y & 0xf);
}

/**
 * One JUMP step's displacement ($A $B $C): a single offset for the whole region,
 * drawn afresh from its ORIGINAL position every step rather than added to the
 * last one — a random WALK would have made the three the same effect arriving
 * at different speeds. All three draw from the whole domain uniformly; the
 * difference is where they are allowed to LAND.
 *
 * `$A` and `$B` QUANTISE, to eighths and to sixteenths of the domain. That is
 * the difference between a beat repeat and a glitch: a one-bar loop cut into
 * eight lands every throw on a hit rather than in the middle of one, so what
 * comes back is the loop re-ordered, still in time; sixteenths halve the grain
 * for anything busier than a backbeat. `$C` is the free throw — anywhere,
 * transients included.
 *
 * Read back through the same transform ROL uses (the region moves as one
 * piece), so what comes out is the sample intact and re-seated — which is the
 * whole difference between this family and the scatter below.
 */
export function jumpRot(op, domainLen) {
  if (domainLen < 2) return 0;
  if (op === MOD_JUMP8 || op === MOD_JUMP16) {
    // Round the slice, don't truncate it: a 1000-byte domain slices at 125, and
    // the last slice would otherwise drift a byte further from home each time.
    const slices = MOD_JUMP_SLICES[op - MOD_JUMP8];
    const slice = Math.max(1, Math.round(domainLen / slices));
    return (Math.min(Math.floor(random() * slices), slices - 1) * slice) % domainLen;
  }
  if (op !== MOD_JUMP_ALL) return 0;
  return Math.min(Math.floor(random() * domainLen), domainLen - 1);
}

/**
 * How far one scatter step may throw a byte, in bytes (0 = it cannot) — the
 * hard bound of a uniform draw, so a byte is as likely to land at the edge of
 * it as next door.
 */
export function scatterReach(op, domainLen) {
  const frac = MOD_SCATTER_FRAC[op - MOD_RND512];
  if (frac === undefined || domainLen < 2) return 0;
  return Math.max(1, Math.min(Math.round(domainLen * frac), domainLen));
}

/** A fresh scramble for the next step. One draw per step — the per-byte spread
 *  comes out of the hash below, not out of 65535 more calls to the RNG. */
export function scatterSeed() {
  return (random() * 0x100000000) >>> 0;
}

/**
 * Integer avalanche (the murmur3 finaliser's shape): (seed, i) → a uint32 with
 * no visible structure. It has to be a pure FUNCTION of the byte's index, not a
 * stream — one output sample reads the same position through every sinc tap and
 * every channel, and a fresh draw per read would smear the whole sample into
 * white noise regardless of the reach. This IS the per-byte randomness.
 */
function scatterHash(seed, i) {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ i, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Where sample byte `i` is READ FROM under a live scatter (items 152, 153): its
 * own position displaced by its own random amount within ±`reach`, wrapped into
 * [domainStart, domainStart + domainLen). Every byte draws separately, so this
 * shuffles the region rather than moving it.
 *
 * The draw is UNIFORM over that range (item 153.10). A bell was tried, on the
 * reasoning that it would keep the narrow settings recognisable; what it
 * actually did was leave most bytes at home and fling a few, which reads as
 * white noise mixed under the sample rather than as the sample breaking up.
 * The glitch is in every byte moving a little, so the flat draw is the one that
 * sounds like the effect — and the ladder gets its range from `reach` instead,
 * which is why it now stops at an eighth of the domain.
 *
 * The mapping is not a permutation: a source byte may be drawn twice and
 * another not at all. Wanting one would mean shuffling an index table the size
 * of the sample on every step, which is not a thing to do inside a tick, and
 * a draw-with-replacement scramble is indistinguishable from a permutation at
 * this grain anyway.
 */
export function scatterSource(i, domainStart, domainLen, reach, seed) {
  if (reach <= 0 || domainLen < 2) return i;
  const span = 2 * reach + 1;
  // Map the hash onto [0, span) by multiply-shift: no modulo, and the product
  // stays exact in a double (2^32 × 2^17 well under 2^53).
  const d = ((scatterHash(seed, i) * span) / 4294967296 | 0) - reach;
  let k = (i - domainStart + d) % domainLen;
  if (k < 0) k += domainLen;
  return domainStart + k;
}

/** Scratch quad for the decoders (callers own theirs; engine never allocates
 *  inside a tick): [from, to, combBits, combOdd]. */
export const regionScratch = new Float64Array(4);

/**
 * Decode the $se region byte into a FRACTION of the command's domain. Nothing
 * here knows how long anything is: the same $se means the same thing on every
 * sample, and resolveModGeom below is what turns it into byte offsets against
 * whichever loop the voice is actually sounding.
 *
 * Writes [from, to, combBits, combOdd] into `out` and returns one of the
 * REGION_* codes. `combBits` is -1 for a solid region, else n where the extent
 * is cut into 2^(n+1) chunks; `combOdd` picks which alternate chunks are kept.
 */
export function decodeSampleRegion(se, out) {
  const s = (se >>> 4) & 0xf;
  const e = se & 0xf;
  // The two comb ladders come first, so $F0..$FE and $E0..$ED stay combs rather
  // than falling into the s > e reserved space. $FF, $EE and $EF have s <= e
  // and are ordinary extents — which is exactly why the odd ladder is one rung
  // shorter than the even one.
  if (s === 0xf && e !== 0xf) { out[2] = e; out[3] = 0; return REGION_COMB; }
  if (s === 0xe && e <= MOD_COMB_ODD_MAX) { out[2] = e; out[3] = 1; return REGION_COMB; }
  // A new extent clears the comb: the two are independent halves of one region,
  // but a region written from scratch is written solid.
  out[2] = -1;
  out[3] = 0;
  // $00 is the whole domain — the loop region, as S $Fxxx has always meant it.
  // Listed before the s <= e rule, which would otherwise read it as the first
  // sixteenth (unreachable, and no loss: $01 is the first two).
  if (se === 0x00) { out[0] = 0; out[1] = 1; return REGION_SET; }
  if (s <= e) { out[0] = s / 16; out[1] = (e + 1) / 16; return REGION_SET; }
  switch (se) {
    case 0x10: out[0] = 1 / 4; out[1] = 3 / 4; break;
    case 0x20: out[0] = 0;     out[1] = 2 / 3; break;
    case 0x21: out[0] = 1 / 3; out[1] = 1;     break;
    case 0x30: out[0] = 0;     out[1] = 1 / 3; break;
    case 0x31: out[0] = 1 / 3; out[1] = 2 / 3; break;
    case 0x32: out[0] = 2 / 3; out[1] = 1;     break;
    default: return REGION_NONE; // $40..$DD with s > e — reserved
  }
  return REGION_SET;
}

/**
 * One voice's resolved view of the instrument's region: the fractions above cut
 * against the loop the voice is really sounding. Cached on the Voice and
 * refreshed by resolveModGeom when either side moves, because the read path
 * costs two multiplies and a divide to build and is walked once per
 * interpolator tap.
 */
export class ModGeom {
  constructor() {
    // Cache key: the instrument's region and the voice's domain.
    this.epoch = -1;
    this.inst = null;
    this.base = -1;
    this.len = -1;
    // Resolved geometry.
    this.live = false;      // is there anything for the read path to do?
    this.es = 0;            // extent, in absolute sample bytes
    this.ee = 0;
    this.combN = 0;         // chunks the extent is cut into (0 = solid)
    this.combOdd = false;   // keep the odd chunks rather than the even ones
    this.combScale = 0;     // combN / extent length — chunk index by multiply
    this.ds = 0;            // wrap domain for the address transforms
    this.dl = 0;
  }
}

/**
 * Resolve `inst`'s region against the loop the voice is sounding, into `g`.
 * Returns `g`. The domain is the loop region when there is one and the whole
 * sample when there is not — the same test §8.4's invert mask makes, so the two
 * features cover the same bytes.
 *
 * `inst` is duck-typed: anything carrying modFrom / modTo / modCombBits /
 * modCombOdd / modInvert / modEpoch will do, which is how the sample view draws
 * the modification through the engine's own geometry instead of a copy of it.
 */
export function resolveModGeom(g, inst, loopStart, loopEnd, sampleLen) {
  const looped = loopEnd > loopStart;
  const base = looped ? loopStart : 0;
  const len = looped ? loopEnd - loopStart : sampleLen;
  if (g.epoch === inst.modEpoch && g.inst === inst && g.base === base && g.len === len) return g;
  g.epoch = inst.modEpoch;
  g.inst = inst;
  g.base = base;
  g.len = len;
  const es = base + Math.round(len * inst.modFrom);
  const ee = base + Math.round(len * inst.modTo);
  g.es = es;
  g.ee = ee;
  g.live = len >= 2 && ee - es >= 2;
  const bits = inst.modCombBits;
  g.combN = bits < 0 ? 0 : 2 << bits;
  g.combOdd = inst.modCombOdd;
  g.combScale = g.combN / Math.max(ee - es, 1);
  // An inverted region's touched set reaches both ends of the DOMAIN, so that
  // is the span its address transform wraps in; a plain region wraps in itself.
  g.ds = inst.modInvert ? base : es;
  g.dl = inst.modInvert ? len : ee - es;
  return g;
}

/**
 * Does the modification touch sample byte `i`? The extent and its comb decide,
 * and notefx 2's inversion flips the answer — which is the ONLY difference
 * between the two opcodes. Nothing outside the domain is ever touched, by
 * either spelling: `2` spares its region and modifies the REST OF THE LOOP, not
 * the rest of the file.
 */
export function modTouches(g, invert, i) {
  let inside = i >= g.es && i < g.ee;
  if (inside && g.combN > 0) {
    // Which bristle: the extent cut into combN equal chunks, truncated. One
    // multiply, because the divide that makes combScale is done per geometry
    // rather than per read.
    inside = ((((i - g.es) * g.combScale) | 0) & 1) === (g.combOdd ? 1 : 0);
  }
  return invert ? !inside && i >= g.ds && i < g.ds + g.dl : inside;
}

/**
 * Where a touched byte is actually READ FROM: the address transform of whatever
 * operation is live, wrapped into the geometry's domain. `rot` moves every byte
 * together (ROL and JUMP), `scatter` gives each its own throw; only one of the
 * two is ever non-zero, since an instrument carries one operation.
 */
export function modAddress(g, i, rot, scatter, seed) {
  const dl = g.dl;
  if (dl < 2) return i;
  if (scatter > 0) return scatterSource(i, g.ds, dl, scatter, seed);
  if (rot === 0) return i;
  let k = (i - g.ds + rot) % dl;
  if (k < 0) k += dl;
  return g.ds + k;
}

// ═══════════════════════════════════════════════════════════════════════════
// Argument extension (item 162) — notefx 2/3 paired with `:`. Base behaviour
// above is untouched; everything below is new, parallel machinery reached
// only when an instrument's modOpExt is non-zero (mutually exclusive with the
// classic 4-bit modOp — writing one clears the other, see inst.js
// setModOpExt/setModOp). Spec: TAUD_NOTE_EFFECTS.md "`:` $xxxx — Argument
// extension" and its "Extended" subsections under 2/3, J and O.
// ═══════════════════════════════════════════════════════════════════════════

// ── $f — sub-range modifier, layered on top of $se's already-resolved extent ──
//
// $1..$9 are STATIC further cuts of the extent (same shape as $se's own
// $10/$20..$32 rows, just measured against [es,ee) instead of the domain).
// $A..$D ALTERNATE between two such cuts, one step at a time — which, because
// the two halves/quarters of an alternating pair are exactly a comb's even and
// odd chunks, is nothing more than a 2- or 4-way comb whose `odd` flips with
// the step counter (`voice.modStepIndex`) rather than staying fixed. $E/$F are
// a fixed BYTE-count comb (4-of-8, 1-of-2) rather than a fraction of the
// extent, for when the extent itself is too short for $se's own comb ladder to
// bite.
const F_STATIC_RANGE = Object.freeze({
  0x1: [0, 1 / 2], 0x2: [1 / 2, 1],
  0x3: [0, 1 / 3], 0x7: [1 / 3, 2 / 3], 0x8: [2 / 3, 1],
  0x4: [0, 1 / 4], 0x5: [1 / 2, 3 / 4], 0x6: [1 / 4, 3 / 4], 0x9: [3 / 4, 1],
});

/**
 * Does `$f` (0..$F) keep sample byte `i`, given the extent [es,ee) $se already
 * resolved and this instrument's step counter (for the $A-$D alternation)?
 * Called ANDed with the ordinary extent+comb test — a byte must clear both.
 */
export function fModTouches(f, i, es, ee, stepIndex) {
  if (f === 0) return true;
  const len = ee - es;
  if (len < 1) return true;
  const rel = i - es;
  const range = F_STATIC_RANGE[f];
  if (range !== undefined) {
    const lo = es + Math.round(len * range[0]);
    const hi = es + Math.round(len * range[1]);
    return i >= lo && i < hi;
  }
  if (f >= 0xa && f <= 0xd) {
    const n = f >= 0xc ? 4 : 2; // A/B halves, C/D quarters
    const chunk = Math.min(Math.floor((rel * n) / len), n - 1);
    const startOdd = (f === 0xb || f === 0xd) ? 1 : 0; // B/D open on the "second" piece
    return (chunk & 1) === ((stepIndex + startOdd) & 1);
  }
  if (f === 0xe) return (rel & 7) < 4;   // 1234----
  if (f === 0xf) return (rel & 1) === 0; // 1-3-5-
  return true;
}

// ── $xuu — the extended operation table (0x000..0xFFF) ──
export const EXT_OP_NOOP = 0x100;
export const EXT_OP_INVERT = 0x101;
export const EXT_OP_FUNK = 0x102;
export const EXT_OP_SIMPLE_INVERT = 0x103;
export const EXT_OP_REVERSE = 0x104;

/** True for `$102` and `$12x` — the funk-repeat kinds, checked from
 *  sampler.js's per-output-sample loop-wrap test, so it must not allocate
 *  the way decodeExtOp's `{kind, param}` object does. */
export function isExtFunkOp(code) {
  return code === EXT_OP_FUNK || (code >= 0x120 && code <= 0x12f);
}

/** Quantised-jump / bounded-jitter N-table, indexed by the code's low nibble
 *  (16 entries) — shared by $13x/$14x/$15x. */
export const EXT_JUMP_N = Object.freeze([2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 16, 18, 21, 24, 32]);

/** Jitter reach as a fraction of the domain for $11x/$12x's low nibble:
 *  ±100/2^(15-x) %, i.e. 2^(x-15) — a 16-rung geometric ladder from ~0.003%
 *  to 100%. */
export function extJitterFrac(x) { return Math.pow(2, (x & 0xf) - 15); }

/** Scatter reach ladder for $161..$16F (16 levels, finer than the base
 *  command's 3): 1/16384 at $1 down to "fully" (reach = whole domain) at $F. */
export const EXT_SCATTER_FRAC = Object.freeze([
  0, 1 / 16384, 1 / 8192, 1 / 4096, 1 / 2048, 1 / 1024, 1 / 512, 1 / 256,
  1 / 128, 1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1,
]);

// Bit-permutation table for $920..$927 — each entry is a byte->byte LUT.
// Built from three involutions (reverse the 8 bits, swap the two nibbles,
// swap each adjacent bit pair) whose compositions match the TODO's worked
// examples exactly (abcdefgh -> ... for each of the eight codes):
//   920 NOT              921 reverse            922 swap nibbles
//   923 reverse+nibbles  924 swap twobits        925 reverse+twobits
//   926 nibbles+twobits  927 all three (commute)
function revBits8(b) {
  b = ((b & 0xf0) >> 4) | ((b & 0x0f) << 4);
  b = ((b & 0xcc) >> 2) | ((b & 0x33) << 2);
  b = ((b & 0xaa) >> 1) | ((b & 0x55) << 1);
  return b & 0xff;
}
const swapNibbles8 = (b) => ((b & 0xf0) >> 4) | ((b & 0x0f) << 4);
const swapTwobits8 = (b) => ((b & 0xaa) >> 1) | ((b & 0x55) << 1);

function buildBitpermLUT(fn) {
  const t = new Uint8Array(256);
  for (let b = 0; b < 256; b++) t[b] = fn(b);
  return t;
}
/** [920, 921, ..., 927] -> Uint8Array(256) LUT, indexed by (code & 7). */
export const EXT_BITPERM_LUT = Object.freeze([
  buildBitpermLUT((b) => b ^ 0xff),                                  // 920 NOT
  buildBitpermLUT(revBits8),                                          // 921
  buildBitpermLUT(swapNibbles8),                                      // 922
  buildBitpermLUT((b) => swapNibbles8(revBits8(b))),                  // 923
  buildBitpermLUT(swapTwobits8),                                      // 924
  buildBitpermLUT((b) => swapTwobits8(revBits8(b))),                  // 925
  buildBitpermLUT((b) => swapTwobits8(swapNibbles8(b))),              // 926
  buildBitpermLUT((b) => swapTwobits8(swapNibbles8(revBits8(b)))),    // 927
]);

/**
 * Classify a 12-bit $xuu code into a step-function KIND plus its numeric
 * parameter — the one place that knows the table's shape, so the stepper
 * (tick.js advanceSampleModExtended) and nothing else has to.
 */
export function decodeExtOp(code) {
  if (code === 0 || code === EXT_OP_NOOP) return { kind: "noop", param: 0 };
  if (code === EXT_OP_INVERT) return { kind: "invert", param: 0 };
  if (code === EXT_OP_FUNK) return { kind: "funk", param: 0 };
  if (code === EXT_OP_SIMPLE_INVERT) return { kind: "xor", param: 0xff };
  if (code === EXT_OP_REVERSE) return { kind: "mirror", param: 0 };
  if (code >= 0x110 && code <= 0x11f) return { kind: "invertJit", param: code & 0xf };
  if (code >= 0x120 && code <= 0x12f) return { kind: "funkJit", param: code & 0xf };
  // $13x "no domain restriction" and $14x "restricted to $se+$f" land in the
  // same wrap domain either way — this command's architecture already scopes
  // every address transform to the resolved extent (g.ds/g.dl), so the two
  // codes are the same jump under it; see TAUD_NOTE_EFFECTS.md's note on this.
  if (code >= 0x130 && code <= 0x14f) return { kind: "jumpN", param: EXT_JUMP_N[code & 0xf] };
  if (code >= 0x150 && code <= 0x15f) return { kind: "jumpNBounded", param: EXT_JUMP_N[code & 0xf] };
  if (code === 0x160) return { kind: "swap", param: 0 };
  if (code >= 0x161 && code <= 0x16f) return { kind: "scatter", param: EXT_SCATTER_FRAC[code & 0xf] };
  if (code >= 0x200 && code <= 0x2ff) return { kind: "rol", param: code & 0xff };
  if (code >= 0x300 && code <= 0x3ff) return { kind: "rol", param: -(code & 0xff) };
  if (code >= 0x400 && code <= 0x4ff) return { kind: "rol", param: (code & 0xff) * 256 };
  if (code >= 0x500 && code <= 0x5ff) return { kind: "rol", param: -(code & 0xff) * 256 };
  if (code >= 0x600 && code <= 0x6ff) return { kind: "sub", param: code & 0xff };
  if (code >= 0x700 && code <= 0x7ff) return { kind: "sub", param: -(code & 0xff) };
  if (code >= 0x800 && code <= 0x8ff) return { kind: "xor", param: code & 0xff };
  if (code >= 0x900 && code <= 0x90f) return { kind: "bitrot", param: code & 0xf };
  if (code >= 0x910 && code <= 0x91f) return { kind: "bitrot", param: -(code & 0xf) };
  if (code >= 0x920 && code <= 0x927) return { kind: "bitperm", param: code & 0x7 };
  return { kind: "noop", param: 0 };
}

// ── $yk — extended speed ──
//
// $y = 0x0..0xE: period (ticks) = y + k/16 — the linear formula the TODO
// gives for y=0,1,2 simply continues through the whole fine ladder, 1/16-tick
// resolution from 0 up to ~14.94 ticks. $00 is the one exception: "stop"
// (frozen), not "period 0". $y = 0xF: the TODO's own coarse ladder, for
// periods the fine ladder's ~15-tick ceiling can't reach.
const EXT_YK_COARSE = Object.freeze([15, 16, 18, 20, 22, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64]);

/** $yk -> period in TICKS (float), or 0 = frozen ($00 only). */
export function extYkPeriodTicks(yk) {
  const y = (yk >>> 4) & 0xf;
  const k = yk & 0xf;
  if (yk === 0) return 0;
  if (y === 0xf) return EXT_YK_COARSE[k];
  return y + k / 16;
}

/**
 * Where a touched byte is read from, for the address-transform kinds only
 * (`rol`/jump family reuse the classic accumulator via `modAddress`; `mirror`
 * and `swap` need their own map). Level-transform kinds (`sub`/`xor`/`bitrot`/
 * `bitperm`) don't move the address — see applyExtLevel below.
 */
export function modAddressExt(g, i, inst) {
  if (inst.modExtSwapA >= 0) {
    if (i === inst.modExtSwapA) return inst.modExtSwapB;
    if (i === inst.modExtSwapB) return inst.modExtSwapA;
    return i;
  }
  if (inst.modExtMirror) {
    const dl = g.dl;
    if (dl < 2) return i;
    let k = (i - g.ds) % dl;
    if (k < 0) k += dl;
    return g.ds + (dl - 1 - k);
  }
  return modAddress(g, i, inst.modRot, inst.modScatter, inst.modSeed);
}

/** Rotate the low 3 bits of `amt` worth of bit-rotation into byte `b` (left
 *  for amt>0, right for amt<0 — modBitRot is stored net-left, mod 8). */
export function bitRotate8(b, amt) {
  const n = ((amt % 8) + 8) % 8;
  if (n === 0) return b;
  return ((b << n) | (b >>> (8 - n))) & 0xff;
}

/** Apply the CURRENT extended level transform (sub/add share `modSub`'s
 *  accumulator — see inst.js; xor/103/920 share `modXor`'s). */
export function applyExtLevel(inst, b) {
  if (inst.modSub !== 0) b = (b - inst.modSub) & 0xff;
  if (inst.modXor !== 0) b ^= inst.modXor;
  if (inst.modBitRot !== 0) b = bitRotate8(b, inst.modBitRot);
  if (inst.modBitPermOn) b = EXT_BITPERM_LUT[inst.modBitPermIdx][b];
  return b;
}

/** Apply the PREVIOUS step's level transform, for the crossfade — only the
 *  kinds that get one (sub/add, xor/103/920) carry a Prev snapshot. */
export function applyExtLevelPrev(inst, b) {
  if (inst.modPrevSub !== 0) b = (b - inst.modPrevSub) & 0xff;
  if (inst.modPrevXor !== 0) b ^= inst.modPrevXor;
  return b;
}

/** modTouches, ANDed with $f's further narrowing — the one gate both the
 *  extended read path and the INVERT-family walk test against. */
export function extModTouches(g, invert, f, stepIndex, i) {
  return modTouches(g, invert, i) && fModTouches(f, i, g.es, g.ee, stepIndex);
}
