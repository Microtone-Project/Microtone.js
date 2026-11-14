// Sample-modification note effects (items 130, 152, 153) — what the Samples
// view draws them with. The effects themselves are the engine's
// (core/engine/c/src/samplemod.c); this is their geometry and opcodes.
//
// notefx 2 and 3, ONE
// command with two spellings: `3` names the region to modify, `2` names the
// region to leave alone. Both are NON-DESTRUCTIVE views over the sample pool,
// exactly as S $Fxxx is: the state lives on the INSTRUMENT and is applied when
// a byte is read (sampler.c readSamplePoint), so the pool itself is never
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

export const EXT_OP_FUNK = 0x102;

/** True for `$102` and `$12x` — the funk-repeat kinds, checked from
 *  sampler.c's per-output-sample loop-wrap test, so it must not allocate
 *  the way decodeExtOp's `{kind, param}` object does. */
export function isExtFunkOp(code) {
  return code === EXT_OP_FUNK || (code >= 0x120 && code <= 0x12f);
}

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

/** modTouches, ANDed with $f's further narrowing — the one gate both the
 *  extended read path and the INVERT-family walk test against. */
export function extModTouches(g, invert, f, stepIndex, i) {
  return modTouches(g, invert, i) && fModTouches(f, i, g.es, g.ee, stepIndex);
}
