// FM Easy Mode (item 247) — a fixed-shape overlay over a type-4 rack, never a
// second model of one. Everything here reads a rack's table and program into an
// EASY MODEL and writes one back, and the rack stays the only state: the Easy
// tab draws what easyDecode reads, every edit there is easyCompile of a changed
// model, and an edit on the FM tab simply shows up the next time it is read.
//
// The shape (TAUD_FILE_FORMAT §7.7, "Easy Mode"):
//
//   entry 0          the PRINCIPAL — a constant 1.0 that the whole patch is
//                    multiplied by (`… $0000 $FF01`), so its envelope, filter
//                    and pan are the instrument's own shared DSP and its level
//                    the output level
//   entries 1…n      the OPERATORS, an Easy rack's operators 0…n−1 — the
//                    oscillators, each its own instrument and so its own
//                    volume envelope
//   entries n+1…     the CONSTANTS — one per feedback loop, a constant whose
//                    level is the loop's depth: `a′ × c` modulating `b` is a
//                    feedback from a into b
//
// Feedback is counted in the classic unit: 0 none, then π/16, π/8, π/4, π/2,
// π, 2π, 4π radians of phase per unit of output. A rack measures phase in
// CYCLES (§5.5.1), so those are 1/32 … 2, and the constants' octets are the
// nearest the decibel table has (within 1.2 %). 2π is exactly one cycle, an
// unscaled tap, and costs no constant at all.
//
// The two directions are not symmetric, and that is the contract:
//
//   Easy → rack → Easy   is the identity: the model comes back as it went in.
//   rack → Easy → rack   keeps the MATHS, not the words. The program is
//                        rewritten in one canonical order and the constants
//                        move to the end of the table; the patch sounds the
//                        same.
//
// A rack that does not read as Easy Mode (ring modulation, a sign, a value
// left on the stack, a principal that is also an oscillator…) makes
// easyDecode say why rather than guess.

import {
  FM_WORD_OSC, FM_WORD_MOD, FM_WORD_FB, FmOp, makeMetaLayer, FM_MAX_OPERATORS,
} from "../../core/engine/inst.js";
import { fmPrincipalIsDsp } from "../../core/engine/fm.js";
import { META_MIX_GAIN } from "../../core/engine/tables.js";
import { LINEAR_FREQ_C4_HZ } from "../../core/engine/constants.js";
import {
  fmValidate, fmWordClass, fmWordIndex, FM_CLASS_OSC, FM_CLASS_MOD, FM_CLASS_FB,
} from "./fmedit.js";
import { buildMetaRecord, META_TYPE_FM } from "../../core/engine/inst.js";
import { metaFlags } from "./metaedit.js";

/** Unity on the decibel octet table (§7.10). */
export const OCTET_UNITY = 159;

/** The most operators an Easy rack may have: the presets' six, and room to
 *  grow by hand up to the rack's own cap less the principal. */
export const EASY_MAX_OPERATORS = FM_MAX_OPERATORS - 1;

// ── feedback depth ──────────────────────────────────────────────────────────

/** The octet whose gain is nearest `g` (by ratio), above silence. */
function nearestOctet(g) {
  let best = 1, err = Infinity;
  for (let o = 1; o < 256; o++) {
    const e = Math.abs(Math.log(META_MIX_GAIN[o] / g));
    if (e < err) { err = e; best = o; }
  }
  return best;
}

/**
 * The constant's octet for each feedback amount 0…7 — 0 is silence, 6 is
 * unity (one cycle = 2π), and each step between doubles.
 */
export const EASY_FB_OCTETS = Object.freeze([0, ...[1, 2, 3, 4, 5, 6, 7].map(
  (n) => (n === 6 ? OCTET_UNITY : nearestOctet(2 ** (n - 6))))]);

/** The amount (0…7) a constant's octet stands for, and whether it is exactly
 *  that amount's octet. An octet set by hand on the FM tab reads as its
 *  nearest amount; the Easy tab shows it as it is and keeps it until changed. */
export function easyFbAmount(octet) {
  const o = octet & 0xff;
  const exact = EASY_FB_OCTETS.indexOf(o);
  if (exact >= 0) return { amount: exact, exact: true };
  let best = 0, err = Infinity;
  for (let n = 1; n < EASY_FB_OCTETS.length; n++) {
    const e = Math.abs(Math.log(META_MIX_GAIN[o] / META_MIX_GAIN[EASY_FB_OCTETS[n]]));
    if (e < err) { err = e; best = n; }
  }
  return { amount: best, exact: false };
}

// ── frequency: multiplier and detune ────────────────────────────────────────

export const EASY_MULT_MIN = -8;
export const EASY_MULT_MAX = 8;

/**
 * An operator's detune field as the Easy tab shows it: a whole number of
 * octaves (the multiplier) and what is left over, in 4096-TET units within
 * half an octave either way. `detune = fine + 4096 × mult` exactly.
 */
export function easySplitDetune(detune) {
  const d = detune | 0;
  const mult = Math.round(d / 4096) + 0; // `+ 0`: never −0
  return { mult, fine: d - 4096 * mult };
}

/** …and back, clamped to the S16 field. */
export function easyJoinDetune(mult, fine) {
  const m = Math.max(EASY_MULT_MIN, Math.min(EASY_MULT_MAX, Math.round(mult) || 0));
  return Math.max(-32768, Math.min(32767, 4096 * m + (Math.round(fine) || 0)));
}

// ── the model ───────────────────────────────────────────────────────────────

/**
 * A model, as easyDecode returns it and easyCompile takes it:
 *
 *   principal  the table entry of the principal
 *   ops        the operators' table entries, in order — operator i is ops[i].
 *              An entry whose instIdx is 0 has no instrument yet (easyNeeds).
 *   labels     the number each operator is SHOWN as: its table position less
 *              one, which is the operator `S $Apsd` reaches. Dense (0…n−1)
 *              for every rack easyCompile wrote.
 *   mods       mods[i]: the operators modulating operator i, ascending
 *   carriers   the operators summed into the output, ascending
 *   feedback   [{from, to, octet, constant}], sorted by (to, from): `from`'s
 *              previous output modulates `to`, at `octet` (EASY_FB_OCTETS).
 *              `constant` is the entry the depth's constant had (its
 *              instrument and rectangle), or null — a new loop, or a unity one.
 */

const sortNum = (a) => [...a].sort((x, y) => x - y);

/** A fresh, full-range operator entry with no instrument yet. */
export function easyBlankEntry(mixOctet = OCTET_UNITY, detune = 0) {
  return makeMetaLayer(0, mixOctet, detune, 0x0000, 0xffff, 0, 63);
}

/** Copy an entry, dropping everything that is not the §7.4 layout's. */
function entryOf(e) {
  return makeMetaLayer(e.instIdx, e.mixOctet, e.detune, e.pitchStart, e.pitchEnd, e.volStart, e.volEnd);
}

/** A loop's constant as the model keeps it: its instrument and rectangle.
 *  Its level is the loop's `octet`, so the entry's own is always 0 here. */
function constantEntry(e) {
  return { ...entryOf(e), mixOctet: 0 };
}

/** A deep copy of a model, so an edit never reaches the one it came from. */
export function easyClone(model) {
  return {
    principal: entryOf(model.principal),
    ops: model.ops.map(entryOf),
    labels: model.labels.slice(),
    mods: model.mods.map((m) => m.slice()),
    carriers: model.carriers.slice(),
    feedback: model.feedback.map((f) => ({ ...f, constant: f.constant ? constantEntry(f.constant) : null })),
  };
}

function sortFeedback(fb) {
  return fb.sort((a, b) => a.to - b.to || a.from - b.from);
}

/** A failed decode: `reason` is the i18n stem the Easy tab explains it with. */
const fail = (reason) => ({ ok: false, reason, model: null });

/** The terms of a sum node (a single term for anything else). */
const termsOf = (n) => (n.t === "sum" ? n.terms : [n]);

/**
 * Read a rack as an Easy model: {ok, model} or {ok: false, reason}.
 *
 * The program is evaluated SYMBOLICALLY, by the engine's own rule: an operator
 * is defined where it is first named, with the modulation it was read through
 * there; every later naming is the same value again, whatever it was read
 * through. So the decode agrees with what sounds, not with what the words
 * look like — which is what lets the FM tab write a patch any way it likes and
 * still have it read here.
 */
export function easyDecode(ops, program) {
  const n = ops.length;
  if (n < 2) return fail("tooFew");
  if (!fmValidate(program, n).ok) return fail("invalid");
  if (!fmPrincipalIsDsp(program)) return fail("principal");

  const def = new Map();      // table index → its modulation node, or null
  const discarded = [];       // modulation read for an operator already defined
  const stack = [];
  for (const w of program.slice(0, -2)) {
    const cls = fmWordClass(w);
    const k = fmWordIndex(w);
    if (cls === FM_CLASS_OSC) {
      if (!def.has(k)) def.set(k, null);
      stack.push({ t: "ref", k });
    } else if (cls === FM_CLASS_MOD) {
      const m = stack.pop();
      if (!def.has(k)) def.set(k, m); else discarded.push(m);
      stack.push({ t: "ref", k });
    } else if (cls === FM_CLASS_FB) {
      stack.push({ t: "tap", k });
    } else {
      switch (w) {
        case FmOp.ADD: {
          const b = stack.pop(), a = stack.pop();
          stack.push({ t: "sum", terms: [...termsOf(a), ...termsOf(b)] });
          break;
        }
        case FmOp.MUL: { const b = stack.pop(), a = stack.pop(); stack.push({ t: "mul", a, b }); break; }
        case FmOp.NEG: return fail("sign");
        case FmOp.DUP: stack.push(stack[stack.length - 1]); break;
        case FmOp.SWAP: { const b = stack.pop(), a = stack.pop(); stack.push(b, a); break; }
        default: return fail("invalid");
      }
    }
  }
  if (stack.length !== 1) return fail("leftover");

  // Roles. A constant is an operator read only as the depth of a feedback
  // loop; everything past the principal that is not one is an operator.
  const constants = new Set();
  const loops = [];           // [{from, to, c}] in table indices; c = −1 for a bare tap
  const modEdges = new Map(); // table index → [table index]
  for (const [k, m] of def) {
    if (k === 0) return fail("principal");
    if (m === null) continue;
    const refs = [];
    for (const term of termsOf(m)) {
      if (term.t === "ref") refs.push(term.k);
      else if (term.t === "tap") loops.push({ from: term.k, to: k, c: -1 });
      else if (term.t === "mul" && term.a.t === "tap" && term.b.t === "ref") {
        loops.push({ from: term.a.k, to: k, c: term.b.k });
        constants.add(term.b.k);
      } else if (term.t === "mul" && term.a.t === "ref" && term.b.t === "tap") {
        loops.push({ from: term.b.k, to: k, c: term.a.k });
        constants.add(term.a.k);
      } else {
        return fail(term.t === "mul" ? "ring" : "shape");
      }
    }
    modEdges.set(k, refs);
  }
  const carrierRefs = [];
  for (const term of termsOf(stack[0])) {
    if (term.t !== "ref") return fail(term.t === "mul" ? "ring" : "shape");
    carrierRefs.push(term.k);
  }

  // A constant is a constant and nothing else: never modulated, never heard,
  // never modulating, never the source of a loop.
  for (const c of constants) {
    if (def.get(c) !== null) return fail("constant");
    if (carrierRefs.includes(c) || loops.some((l) => l.from === c)) return fail("constant");
    for (const refs of modEdges.values()) if (refs.includes(c)) return fail("constant");
  }
  for (const l of loops) if (l.from === 0) return fail("principal");

  // Everything the program sounds must be somewhere in the model, or a
  // rewrite would stop sounding it — and its feedback taps would go quiet.
  const reach = new Set(constants);
  const visit = (k) => {
    if (reach.has(k)) return;
    reach.add(k);
    for (const j of modEdges.get(k) ?? []) visit(j);
  };
  for (const k of carrierRefs) visit(k);
  for (const k of def.keys()) if (!reach.has(k)) return fail("hidden");
  void discarded; // its operators are all in `def`, so the check above covers them

  // Table → model.
  const oscTable = [];
  for (let k = 1; k < n; k++) if (!constants.has(k)) oscTable.push(k);
  if (oscTable.length === 0) return fail("tooFew");
  const eff = new Map(oscTable.map((k, i) => [k, i]));
  const uniq = (a) => new Set(a).size === a.length;

  const mods = oscTable.map((k) => (modEdges.get(k) ?? []).map((j) => eff.get(j)));
  if (!mods.every(uniq) || !uniq(carrierRefs)) return fail("twice");
  const feedback = loops.map((l) => ({
    from: eff.get(l.from),
    to: eff.get(l.to),
    octet: l.c < 0 ? OCTET_UNITY : ops[l.c].mixOctet & 0xff,
    constant: l.c < 0 ? null : constantEntry(ops[l.c]),
  }));
  const pairs = feedback.map((f) => `${f.from}>${f.to}`);
  if (!uniq(pairs)) return fail("twice");

  return {
    ok: true,
    reason: null,
    model: {
      principal: entryOf(ops[0]),
      ops: oscTable.map((k) => entryOf(ops[k])),
      labels: oscTable.map((k) => k - 1),
      mods: mods.map(sortNum),
      carriers: sortNum(carrierRefs.map((k) => eff.get(k))),
      feedback: sortFeedback(feedback),
    },
  };
}

/**
 * Write a model as a rack: {ops, program}. The program is canonical — every
 * operator defined once, at its first naming, its modulators and loops in
 * ascending order and summed as they arrive, the carriers likewise, and the
 * principal last. Throws on a modulation cycle (the editor turns one into a
 * feedback loop before it gets here) and on an operator with no instrument
 * (easyNeeds / easyFill come first).
 */
export function easyCompile(model) {
  const n = model.ops.length;
  if (model.ops.some((o) => (o.instIdx & 0x3ff) === 0)) throw new Error("easyCompile: an operator has no instrument");
  const table = [entryOf(model.principal), ...model.ops.map(entryOf)];
  const program = [];
  const done = new Uint8Array(n);
  const open = new Uint8Array(n);
  const loops = sortFeedback(model.feedback.map((f) => ({ ...f })));

  const emit = (i) => {
    if (done[i]) { program.push(FM_WORD_OSC | (1 + i)); return; }
    if (open[i]) throw new Error("easyCompile: modulation cycle");
    open[i] = 1;
    let terms = 0;
    const term = () => { if (++terms > 1) program.push(FmOp.ADD); };
    for (const j of sortNum(model.mods[i])) { emit(j); term(); }
    for (const f of loops) {
      if (f.to !== i) continue;
      program.push(FM_WORD_FB | (1 + f.from));
      if ((f.octet & 0xff) !== OCTET_UNITY) {
        if (!f.constant || (f.constant.instIdx & 0x3ff) === 0) {
          throw new Error("easyCompile: a feedback loop has no constant");
        }
        table.push({ ...constantEntry(f.constant), mixOctet: f.octet & 0xff });
        program.push(FM_WORD_OSC | (table.length - 1), FmOp.MUL);
      }
      term();
    }
    program.push((terms > 0 ? FM_WORD_MOD : FM_WORD_OSC) | (1 + i));
    open[i] = 0;
    done[i] = 1;
  };
  const carriers = sortNum(model.carriers);
  if (carriers.length === 0) throw new Error("easyCompile: no carrier");
  carriers.forEach((c, k) => { emit(c); if (k > 0) program.push(FmOp.ADD); });
  program.push(FM_WORD_OSC | 0, FmOp.MUL);
  return { ops: table, program };
}

/**
 * What a model still needs before it can be compiled: the operators with no
 * instrument, and whether a loop needs a constant instrument no loop has yet.
 * `constSlot` is the constant instrument the rack already uses, if any.
 */
export function easyNeeds(model) {
  const osc = [];
  model.ops.forEach((o, i) => { if ((o.instIdx & 0x3ff) === 0) osc.push(i); });
  const have = model.feedback.find((f) => f.constant && (f.constant.instIdx & 0x3ff) !== 0);
  const constSlot = have ? have.constant.instIdx & 0x3ff : 0;
  const constant = constSlot === 0 && model.feedback.some((f) => (f.octet & 0xff) !== OCTET_UNITY);
  return { osc, constant, constSlot };
}

/** Give the model's blank operators their instruments (`oscSlots`, in the
 *  order easyNeeds listed them) and every loop that needs one a constant. */
export function easyFill(model, oscSlots = [], constSlot = 0) {
  const m = easyClone(model);
  const { osc, constSlot: have } = easyNeeds(m);
  osc.forEach((i, k) => { m.ops[i].instIdx = oscSlots[k] & 0x3ff; });
  const c = have || (constSlot & 0x3ff);
  for (const f of m.feedback) {
    if ((f.octet & 0xff) === OCTET_UNITY) continue;
    if (!f.constant || (f.constant.instIdx & 0x3ff) === 0) {
      f.constant = constantEntry(makeMetaLayer(c, 0, 0, 0x0000, 0xffff, 0, 63));
    }
  }
  return m;
}

// ── routing edits ───────────────────────────────────────────────────────────

/** True when `a`'s sound depends on `b`'s: walking modulators back from `a`
 *  reaches `b`. Wiring `a` into `b` would then close a loop. */
function dependsOn(model, a, b) {
  const seen = new Set();
  const walk = (k) => {
    if (k === b) return true;
    if (seen.has(k)) return false;
    seen.add(k);
    return model.mods[k].some(walk);
  };
  return walk(a);
}

/**
 * What wiring `from` into `to` would make: "mod" when `from` can simply
 * modulate `to`, "fb" when that would close a loop — `to` already feeds
 * `from`, or it is `from` itself — so the connection has to be a feedback
 * tap, which reads the previous sample and so is allowed to.
 */
export function easyWireKind(model, from, to) {
  return from === to || dependsOn(model, from, to) ? "fb" : "mod";
}

/** Is `from` wired into `to` already, and how? null, "mod" or "fb". */
export function easyWired(model, from, to) {
  if (model.mods[to]?.includes(from)) return "mod";
  if (model.feedback.some((f) => f.from === from && f.to === to)) return "fb";
  return null;
}

/**
 * Connect `from` into `to` — or disconnect it, when it is connected already.
 * A new loop starts silent (amount 0), so drawing one never changes the sound
 * before its depth is set. Returns a new model.
 */
export function easyToggleWire(model, from, to) {
  const m = easyClone(model);
  const now = easyWired(m, from, to);
  if (now === "mod") m.mods[to] = m.mods[to].filter((j) => j !== from);
  else if (now === "fb") m.feedback = m.feedback.filter((f) => !(f.from === from && f.to === to));
  else if (easyWireKind(m, from, to) === "mod") m.mods[to] = sortNum([...m.mods[to], from]);
  else m.feedback = sortFeedback([...m.feedback, { from, to, octet: EASY_FB_OCTETS[0], constant: null }]);
  return m;
}

/** Make `i` a carrier, or stop it being one (the last carrier stays). */
export function easyToggleCarrier(model, i) {
  const m = easyClone(model);
  if (m.carriers.includes(i)) {
    if (m.carriers.length > 1) m.carriers = m.carriers.filter((c) => c !== i);
  } else {
    m.carriers = sortNum([...m.carriers, i]);
  }
  return m;
}

/** Set one loop's depth (an octet from EASY_FB_OCTETS, or any octet). */
export function easySetFeedback(model, from, to, octet) {
  const m = easyClone(model);
  for (const f of m.feedback) if (f.from === from && f.to === to) f.octet = octet & 0xff;
  return m;
}

/** Overwrite fields of operator `i`'s entry. */
export function easyPatchOp(model, i, fields) {
  const m = easyClone(model);
  m.ops[i] = { ...m.ops[i], ...fields };
  return m;
}

/** Append an unwired operator with no instrument yet. */
export function easyAddOperator(model) {
  if (model.ops.length >= EASY_MAX_OPERATORS) return model;
  const m = easyClone(model);
  m.ops.push(easyBlankEntry());
  m.labels.push(m.labels.length === 0 ? 0 : Math.max(...m.labels) + 1);
  m.mods.push([]);
  return m;
}

/**
 * Drop operator `i` and every wire to and from it; the ones after it move
 * down a place. The last operator, or the last carrier, cannot go.
 */
export function easyCanRemoveOperator(model, i) {
  return model.ops.length > 1 && !(model.carriers.length === 1 && model.carriers[0] === i);
}

export function easyRemoveOperator(model, i) {
  if (!easyCanRemoveOperator(model, i)) return model;
  const down = (k) => (k > i ? k - 1 : k);
  const m = easyClone(model);
  m.ops.splice(i, 1);
  m.labels = m.ops.map((_, k) => k);
  m.mods.splice(i, 1);
  m.mods = m.mods.map((list) => list.filter((j) => j !== i).map(down));
  m.carriers = m.carriers.filter((c) => c !== i).map(down);
  m.feedback = m.feedback.filter((f) => f.from !== i && f.to !== i)
    .map((f) => ({ ...f, from: down(f.from), to: down(f.to) }));
  return m;
}

// ── presets ─────────────────────────────────────────────────────────────────

/**
 * The forty presets, in the notation the FM tab's formula readout uses:
 * `k[…]` is operator k read through what is inside, `a′` (inside a bracket)
 * a feedback from a, and `+` a sum. Operator 0 is the first operator, not the
 * principal, which no preset mentions — every Easy rack has one.
 */
export const EASY_PRESET_FORMULAS = Object.freeze([
  // two operators
  "0[0′] + 1",
  "1[0[0′]]",
  // four operators
  "3[2[1[0[0′]]]]",
  "1[0[0′]] + 3[2]",
  "0[0′] + 3[2[1]]",
  "0[0′] + 1[2] + 3",
  "3[1[0] + 2[2′]]",
  "0[0′] + 1 + 2 + 3",
  // six operators
  "3[2[1[0[0′]]]] + 5[4]",
  "1[0[0′]] + 5[4[3[2]]]",
  "2[1[0[0′]]] + 5[4[3]]",
  "2[1[0[2′]]] + 5[4[3]]",
  "1[0[0′]] + 3[2] + 5[4]",
  "1[0[1′]] + 3[2] + 5[4]",
  "3[1[0[0′]] + 2] + 5[4]",
  "3[1[0] + 2[2′]] + 5[4]",
  "3[1[0] + 2] + 5[4[4′]]",
  "2[1[0[0′]]] + 5[3 + 4]",
  "2[1[0]] + 5[3[3′] + 4]",
  "1[0[0′]] + 5[2 + 3 + 4]",
  "1[0] + 5[2[2′] + 3 + 4]",
  "3[2[0 + 1[1′]]] + 5[4]",
  "3[2[0 + 1]] + 5[4[4′]]",
  "5[1[0[0′]] + 3[2] + 4]",
  "5[1[0] + 3[2] + 4[4′]]",
  "5[2[1[0]] + 3[3′] + 4]",
  "1[0[0′]] + 2[0[0′]] + 5[4[3]]",
  "2[0 + 1] + 4[3[3′]] + 5[3[3′]]",
  "1[0] + 2[0] + 4[3[3′]] + 5[3[3′]]",
  "1[0[0′]] + 2[0[0′]] + 3[0[0′]] + 5[4]",
  "1[0[0′]] + 2[0[0′]] + 4[3] + 5",
  "1[0[0′]] + 2[0[0′]] + 3[0[0′]] + 4 + 5",
  "1[0[0′]] + 2[0[0′]] + 3 + 4 + 5",
  "2[0 + 1[1′]] + 4[3] + 5",
  "2[0 + 1] + 4[3[3′]] + 5",
  "0 + 3[2[1[1′]]] + 5[4]",
  "1[0[0′]] + 3[2] + 4 + 5",
  "0 + 3[2[1[1′]]] + 4 + 5",
  "1[0[0′]] + 2 + 3 + 4 + 5",
  "0[0′] + 1 + 2 + 3 + 4 + 5",
]);

/**
 * Parse a routing formula: {count, mods, carriers, feedback: [{from, to}]}.
 * Round parentheses group and mean nothing else, so a formula written with the
 * old readout's spare ones still reads. Naming an operator twice with the same
 * modulation is the same operator (`1[0[0′]] + 2[0[0′]]` is ONE operator 0
 * feeding two carriers); naming it twice with different modulations is an
 * error, because an operator has one phase input.
 */
export function parseEasyFormula(text) {
  const src = String(text).replace(/\s+/g, "");
  let at = 0;
  const mods = new Map();
  const fb = new Map();
  const touched = new Set();
  let count = 0;
  const err = (what) => { throw new Error(`parseEasyFormula: ${what} at ${at} in "${text}"`); };

  // An expression is a list of terms: {k, tap}.
  const expr = () => {
    const terms = [...term()];
    while (src[at] === "+") { at++; terms.push(...term()); }
    return terms;
  };
  const term = () => {
    if (src[at] === "(") {
      at++;
      const inner = expr();
      if (src[at] !== ")") err("missing )");
      at++;
      return inner;
    }
    const m = /^\d+/.exec(src.slice(at));
    if (!m) err("operator expected");
    at += m[0].length;
    const k = Number(m[0]);
    count = Math.max(count, k + 1);
    if (src[at] === "′" || src[at] === "'") { at++; return [{ k, tap: true }]; }
    let own = [], loops = [];
    if (src[at] === "[") {
      at++;
      for (const t of expr()) (t.tap ? loops : own).push(t.k);
      if (src[at] !== "]") err("missing ]");
      at++;
    }
    const key = (a) => sortNum([...new Set(a)]).join(",");
    if (touched.has(k)) {
      if (key(own) !== key(mods.get(k)) || key(loops) !== key(fb.get(k))) err(`operator ${k} read two ways`);
    } else {
      touched.add(k);
      mods.set(k, own);
      fb.set(k, loops);
    }
    return [{ k, tap: false }];
  };

  const top = expr();
  if (at !== src.length) err("unexpected text");
  if (top.some((t) => t.tap)) err("a feedback tap outside a bracket");
  const feedback = [];
  for (const [to, list] of fb) for (const from of new Set(list)) feedback.push({ from, to });
  return {
    count,
    mods: Array.from({ length: count }, (_, k) => sortNum([...new Set(mods.get(k) ?? [])])),
    carriers: sortNum([...new Set(top.map((t) => t.k))]),
    feedback: sortFeedback(feedback),
  };
}

/** The presets, parsed: [{n (1-based), formula, count, mods, carriers, feedback}]. */
export const EASY_PRESETS = Object.freeze(EASY_PRESET_FORMULAS.map((formula, i) => Object.freeze({
  n: i + 1, formula, ...parseEasyFormula(formula),
})));

/** The routing of a model as a key: equal keys are the same wiring. */
function routingKey(r) {
  return JSON.stringify([r.mods.length, r.mods, sortNum(r.carriers),
    sortFeedback(r.feedback.map((f) => ({ from: f.from, to: f.to })))]);
}

/** The preset a model's wiring is (1…40), or 0 when it is none of them. */
export function easyPresetOf(model) {
  const key = routingKey(model);
  return EASY_PRESETS.find((p) => routingKey(p) === key)?.n ?? 0;
}

/**
 * Rewire a model to preset `n`. The operators it already has keep their
 * instruments, levels and frequencies, position by position; extra ones are
 * dropped and missing ones are added blank (easyNeeds names them). Every loop
 * takes the depth of the model's first loop, as switching an algorithm keeps
 * the feedback knob where it was. A fresh carrier is levelled so the carriers
 * together reach unity rather than clipping.
 */
export function easyApplyPreset(model, n) {
  const p = EASY_PRESETS[n - 1];
  if (!p) return model;
  const m = easyClone(model);
  const depth = m.feedback[0]?.octet ?? EASY_FB_OCTETS[0];
  const constant = m.feedback.find((f) => f.constant)?.constant ?? null;
  const carrierOctet = carrierLevel(p.carriers.length);
  const ops = [];
  for (let i = 0; i < p.count; i++) {
    ops.push(i < m.ops.length ? m.ops[i]
      : easyBlankEntry(p.carriers.includes(i) ? carrierOctet : OCTET_UNITY));
  }
  return {
    principal: m.principal,
    ops,
    labels: ops.map((_, i) => i),
    mods: p.mods.map((l) => l.slice()),
    carriers: p.carriers.slice(),
    feedback: p.feedback.map((f) => ({ from: f.from, to: f.to, octet: depth,
      constant: (depth & 0xff) === OCTET_UNITY || !constant ? null : constantEntry(constant) })),
  };
}

/** The level each of `n` carriers is given so the sum stays at unity. */
export function carrierLevel(n) {
  return n <= 1 ? OCTET_UNITY : nearestOctet(1 / n);
}

/** A model for a brand-new Easy rack wired as preset `n` — every entry blank
 *  but its levels, ready for easyNeeds/easyFill. */
export function easyNewModel(n) {
  const empty = {
    principal: easyBlankEntry(), ops: [], labels: [], mods: [], carriers: [], feedback: [],
  };
  return easyApplyPreset(empty, n);
}

/**
 * The model's wiring in the preset notation, operators named by `name(i)`
 * (their labels by default). A shared modulator is written out at each place
 * it feeds, as the presets write it — it is one operator either way.
 */
export function easyFormula(model, name = (i) => String(model.labels[i] ?? i)) {
  const op = (i) => {
    const inner = [
      ...model.mods[i].map(op),
      ...model.feedback.filter((f) => f.to === i).map((f) => `${name(f.from)}′`),
    ];
    return inner.length > 0 ? `${name(i)}[${inner.join(" + ")}]` : name(i);
  };
  return model.carriers.map(op).join(" + ");
}

/**
 * The model as the algorithm diagram's expression tree (doc/fmlayout.js
 * fmTreeGraph): operators by their index in `ops`, the constants left out —
 * a loop is drawn as the tap it is, carrying its depth (0…7) as `level`, so
 * a curl whose depth is 0 is drawn idle.
 */
export function easyTree(model) {
  const sum = (nodes) => nodes.reduce((a, b) => (a === null ? b : { kind: "add", a, b }), null);
  const op = (i) => {
    const inner = [
      ...model.mods[i].map(op),
      ...model.feedback.filter((f) => f.to === i)
        .map((f) => ({ kind: "tap", op: f.from, level: easyFbAmount(f.octet).amount })),
    ];
    return { kind: "op", op: i, mod: sum(inner) };
  };
  return sum(model.carriers.map(op));
}

/**
 * The record `inst` (an Easy rack) would have with `model` written into it —
 * its flags and IMix id kept, the Easy Mode bit set — or null when the wiring
 * does not fit a rack. Every operator must have its instrument already
 * (easyNeeds); planEasyFm is the path that makes them.
 */
export function easyRecordOf(inst, model) {
  let compiled;
  try { compiled = easyCompile(model); } catch { return null; }
  const { ops, program } = compiled;
  if (ops.length > FM_MAX_OPERATORS || !fmValidate(program, ops.length).ok) return null;
  return buildMetaRecord(ops, { ...metaFlags(inst), type: META_TYPE_FM, program, easy: true });
}

// ── the instruments Easy Mode makes ─────────────────────────────────────────

/** Frames in an Easy oscillator's one cycle. */
export const EASY_SINE_FRAMES = 256;

/** One cycle of sine, as the pool stores it (U8, symmetric about 127.5). */
export function easySinePcm(frames = EASY_SINE_FRAMES) {
  const out = new Uint8Array(frames);
  for (let i = 0; i < frames; i++) {
    out[i] = Math.max(0, Math.min(255, Math.round(127.5 + 127.5 * Math.sin((2 * Math.PI * i) / frames))));
  }
  return out;
}

/** A constant 1.0 — the principal's and the constants' "waveform". */
export function easyDcPcm(frames = 16) {
  return new Uint8Array(frames).fill(0xff);
}

/**
 * The rate and detune that make a looped cycle of `frames` sound middle C at
 * C-4 — the waveform painter's rule (item 195): the rate as fine as its
 * 16-bit field allows, the detune taking the octaves and the remainder.
 */
export function easyCycleTuning(frames) {
  const target = LINEAR_FREQ_C4_HZ * frames;
  let rate = target;
  while (rate > 0xffff) rate /= 2;
  while (rate < 1) rate *= 2;
  const samplingRate = Math.max(1, Math.min(0xffff, Math.round(rate)));
  const detune = Math.max(-32768, Math.min(32767, Math.round(4096 * Math.log2(target / samplingRate))));
  return { samplingRate, detune };
}

/**
 * The principal's release, in fadeout units (TAUD_FILE_FORMAT §7.1: about
 * 430 ms at 50 ticks a second). Without one, a looped constant with no
 * envelope would hold every note for ever after its key was let go.
 */
export const EASY_PRINCIPAL_FADEOUT = 48;
