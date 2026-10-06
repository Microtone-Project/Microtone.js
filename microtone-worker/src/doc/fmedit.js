// FM rack editing (item 159) — the type-4 twin of metaedit.js.
//
// A layered metainstrument's whole structure is its table, so every edit there
// is "rebuild the record from a new array". A rack has TWO structures in one
// record — the operator table and the algorithm that reads it — and the second
// addresses the first BY POSITION. That is the entire difficulty of this file:
// any edit that moves a row has to renumber the program with it, and any edit
// that removes one has to leave a program that still verifies.
//
// So the removal rule is deliberately strict: an operator can only go when the
// algorithm does not name it. The alternative — deleting the words that named
// it — silently unbalances the stack and rewrites the user's patch into
// something they did not ask for, which is much worse than being told to
// unwire it first.

import {
  buildMetaRecord, makeMetaLayer, fmWordArity, fmRecordBytes,
  FM_MAX_OPERATORS, FM_BUDGET_BYTES, FM_STACK_MAX, FM_INDEX_MASK,
  FM_WORD_OSC, FM_WORD_MOD, FM_WORD_FB, FM_WORD_OP, FmOp, META_TYPE_FM,
} from "../../core/engine/inst.js";
import { metaFlags } from "./metaedit.js";

export { FM_MAX_OPERATORS, FM_BUDGET_BYTES, FmOp, META_TYPE_FM };

/** The word classes an editor offers, in the order they read best. */
export const FM_CLASS_OSC = "osc";
export const FM_CLASS_MOD = "mod";
export const FM_CLASS_FB = "fb";
export const FM_CLASS_OP = "op";

/** Which class a word belongs to, or null when it is none of them. */
export function fmWordClass(word) {
  const w = word & 0xffff;
  if (w >= FM_WORD_OP) return FM_CLASS_OP;
  switch (w & ~FM_INDEX_MASK) {
    case FM_WORD_OSC: return FM_CLASS_OSC;
    case FM_WORD_MOD: return FM_CLASS_MOD;
    case FM_WORD_FB: return FM_CLASS_FB;
    default: return null;
  }
}

/** The operator an operand word addresses (meaningless for FM_CLASS_OP). */
export function fmWordIndex(word) {
  return word & FM_INDEX_MASK;
}

/** Build a word from a class and its operand. */
export function fmWord(cls, value) {
  switch (cls) {
    case FM_CLASS_OSC: return FM_WORD_OSC | (value & FM_INDEX_MASK);
    case FM_CLASS_MOD: return FM_WORD_MOD | (value & FM_INDEX_MASK);
    case FM_CLASS_FB: return FM_WORD_FB | (value & FM_INDEX_MASK);
    default: return value & 0xffff;
  }
}

/** The stack operators an editor may offer: the word, the symbol the formula
 *  readout uses for it, and the i18n stem for its name. */
export const FM_OPERATORS = [
  { word: FmOp.ADD, symbol: "+", key: "add" },
  { word: FmOp.MUL, symbol: "×", key: "mul" },
  { word: FmOp.NEG, symbol: "±", key: "neg" },
  { word: FmOp.DUP, symbol: "⌥", key: "dup" },
  { word: FmOp.SWAP, symbol: "⇄", key: "swap" },
];

/** Editable copies of a rack's operator table (metaedit.metaLayers' twin). */
export function fmOperators(inst) {
  return (inst?.metaLayers ?? []).map((l) => makeMetaLayer(
    l.instIdx, l.mixOctet, l.detune, l.pitchStart, l.pitchEnd, l.volStart, l.volEnd));
}

/** …and of its algorithm. Never null: a rack whose program did not verify is
 *  edited as an empty one, which is the only state from which it can be fixed. */
export function fmProgramOf(inst) {
  return inst?.fmProgram === null || inst?.fmProgram === undefined
    ? [] : [...inst.fmProgram];
}

/** Repack a rack — table and algorithm together, since they share the record. */
export function fmRecordOf(inst, ops, program) {
  return buildMetaRecord(ops, {
    ...metaFlags(inst),
    type: META_TYPE_FM,
    program: Uint16Array.from(program),
  });
}

/**
 * Walk a program and report what an editor needs to paint: the stack depth
 * BEFORE each word, whether the whole thing verifies, and where it first went
 * wrong. Same rules as the engine's own decode (inst.js decodeFmProgram) — this
 * is the editor's copy of them, and the tests pin the two together.
 */
export function fmValidate(program, opCount) {
  const depth = [];
  let d = 0;
  for (let i = 0; i < program.length; i++) {
    depth.push(d);
    const w = program[i] & 0xffff;
    const arity = w === FmOp.END ? null : fmWordArity(w, opCount);
    if (arity === null) return { ok: false, depth, at: i, error: "badWord" };
    if (d < arity.pop) return { ok: false, depth, at: i, error: "underflow" };
    d += arity.push - arity.pop;
    if (d > FM_STACK_MAX) return { ok: false, depth, at: i, error: "overflow" };
  }
  depth.push(d);
  if (d < 1) return { ok: false, depth, at: program.length, error: "empty" };
  if (fmRecordBytes(opCount, program.length) > FM_BUDGET_BYTES) {
    return { ok: false, depth, at: program.length, error: "budget" };
  }
  return { ok: true, depth, at: -1, error: null };
}

/** Bytes of the 252 this rack spends, and how many are left. */
export function fmBudget(opCount, programLength) {
  const used = fmRecordBytes(opCount, programLength);
  return { used, total: FM_BUDGET_BYTES, free: FM_BUDGET_BYTES - used };
}

/** Can another operator fit — rack cap AND record budget? */
export function fmCanAddOperator(ops, program) {
  return ops.length < FM_MAX_OPERATORS &&
    fmRecordBytes(ops.length + 1, program.length) <= FM_BUDGET_BYTES;
}

/** Can another word fit? */
export function fmCanAddWord(ops, program) {
  return fmRecordBytes(ops.length, program.length + 1) <= FM_BUDGET_BYTES;
}

/** Operators the algorithm names at all — a feedback tap counts here, unlike
 *  the engine's "which operators sound" question, because an editor must not
 *  delete a row some word still points at whatever that word does with it. */
export function fmOperatorsNamed(program, opCount) {
  const used = new Array(opCount).fill(0);
  for (const w of program) {
    if (fmWordClass(w) === FM_CLASS_OP) continue;
    const k = fmWordIndex(w);
    if (k < opCount) used[k]++;
  }
  return used;
}

/** Renumber every operand word through `map` (old index → new, −1 = gone). */
function remapProgram(program, map) {
  return program.map((w) => {
    if (fmWordClass(w) === FM_CLASS_OP) return w;
    const to = map[fmWordIndex(w)];
    return to === undefined || to < 0 ? w : fmWord(fmWordClass(w), to);
  });
}

/** True when operator `i` can be removed: it is not operator 0 (the rack needs
 *  a principal), it is not the last one left, and no word names it. */
export function canRemoveOperator(ops, program, i) {
  if (i <= 0 || i >= ops.length || ops.length <= 1) return false;
  return fmOperatorsNamed(program, ops.length)[i] === 0;
}

/** Drop operator `i` and slide the algorithm's references down past it. */
export function removeOperator(ops, program, i) {
  if (!canRemoveOperator(ops, program, i)) return { ops, program };
  const map = ops.map((_, n) => (n < i ? n : n === i ? -1 : n - 1));
  return { ops: ops.filter((_, n) => n !== i), program: remapProgram(program, map) };
}

/**
 * Copy operator `i`, inserting the copy directly after it — metaedit's
 * duplicateLayer for a rack, and LINKED the same way: the copy names the same
 * sub-instrument, so editing that instrument moves both. Every word that named
 * an operator past `i` is renumbered one place up, so the patch sounds exactly
 * as it did; the copy itself is unwired until the algorithm names it. Returns
 * the rack unchanged when another operator would not fit.
 */
export function duplicateOperator(ops, program, i) {
  if (i < 0 || i >= ops.length || !fmCanAddOperator(ops, program)) return { ops, program };
  const src = ops[i];
  const copy = makeMetaLayer(src.instIdx, src.mixOctet, src.detune,
    src.pitchStart, src.pitchEnd, src.volStart, src.volEnd);
  const map = ops.map((_, n) => (n <= i ? n : n + 1));
  return {
    ops: [...ops.slice(0, i + 1), copy, ...ops.slice(i + 1)],
    program: remapProgram(program, map),
  };
}

/**
 * Move operator `i` by `delta`. A reorder is a permutation, so the algorithm
 * survives it exactly — every word is renumbered and the patch sounds the same.
 * What DOES change is which operator is principal, and that is the point: this
 * is how the rack's carrier is chosen.
 */
export function moveOperator(ops, program, i, delta) {
  const to = i + delta;
  if (i < 0 || i >= ops.length || to < 0 || to >= ops.length) return { ops, program };
  const next = ops.slice();
  const [moved] = next.splice(i, 1);
  next.splice(to, 0, moved);
  const map = new Array(ops.length);
  for (let n = 0; n < ops.length; n++) {
    map[n] = n === i ? to : n < Math.min(i, to) || n > Math.max(i, to) ? n : n + (i < to ? -1 : 1);
  }
  return { ops: next, program: remapProgram(program, map) };
}

/** Overwrite fields of operator `i` (the layer editor's patchLayer). */
export function patchOperator(ops, i, fields) {
  if (i < 0 || i >= ops.length) return ops;
  return ops.map((o, n) => (n === i ? { ...o, ...fields } : o));
}

// ── the algorithm ────────────────────────────────────────────────────────

/** Insert `word` after position `i` (−1 = at the front). */
export function insertWord(program, i, word) {
  const at = Math.min(Math.max(i + 1, 0), program.length);
  return [...program.slice(0, at), word & 0xffff, ...program.slice(at)];
}

/** Drop word `i`. */
export function removeWord(program, i) {
  if (i < 0 || i >= program.length) return program;
  return program.filter((_, n) => n !== i);
}

/** Move word `i` by `delta`. */
export function moveWord(program, i, delta) {
  const to = i + delta;
  if (i < 0 || i >= program.length || to < 0 || to >= program.length) return program;
  const out = program.slice();
  const [moved] = out.splice(i, 1);
  out.splice(to, 0, moved);
  return out;
}

/** Replace word `i`. */
export function setWord(program, i, word) {
  if (i < 0 || i >= program.length) return program;
  return program.map((w, n) => (n === i ? word & 0xffff : w));
}

/**
 * The algorithm as an expression TREE, rooted at the value the program leaves
 * on the stack. `fmFormula` and `fmGraph` are both readings of this — one in
 * words, one in wires.
 *
 * Nodes: `{kind:"op", op, mod}` (an operator, optionally read through the
 * subtree that modulates it), `{kind:"tap", op}` (a z-1 feedback tap),
 * `{kind:"add"|"mul", a, b}` and `{kind:"neg", a}`.
 *
 * Returns null when the program does not verify — there is nothing to draw, and
 * drawing half a patch would read as a working one. Values left BELOW the top
 * of the stack are computed and discarded by the engine, so they are not in the
 * tree either: this is what reaches the output.
 *
 * A `dup` puts the SAME node object on the stack twice. That is deliberate —
 * the engine evaluates an operator once per output sample however often it is
 * named, so the two occurrences really are one operator, and the layout below
 * is free to draw the box twice under the one number.
 */
export function fmTree(program, opCount) {
  if (!fmValidate(program, opCount).ok) return null;
  const stack = [];
  for (const w of program) {
    const cls = fmWordClass(w);
    const k = fmWordIndex(w);
    if (cls === FM_CLASS_OSC) { stack.push({ kind: "op", op: k, mod: null }); continue; }
    if (cls === FM_CLASS_FB) { stack.push({ kind: "tap", op: k }); continue; }
    if (cls === FM_CLASS_MOD) { stack.push({ kind: "op", op: k, mod: stack.pop() }); continue; }
    switch (w) {
      case FmOp.ADD: { const b = stack.pop(); stack.push({ kind: "add", a: stack.pop(), b }); break; }
      case FmOp.MUL: { const b = stack.pop(); stack.push({ kind: "mul", a: stack.pop(), b }); break; }
      case FmOp.NEG: stack.push({ kind: "neg", a: stack.pop() }); break;
      case FmOp.DUP: stack.push(stack[stack.length - 1]); break;
      case FmOp.SWAP: { const b = stack.pop(), a = stack.pop(); stack.push(b, a); break; }
      default: break;
    }
  }
  return stack.pop() ?? null;
}

/**
 * Place the tree on a grid for the algorithm diagram — the FM chip's own
 * picture, which says in one glance what the formula says in one sentence.
 *
 * `col` counts modulation depth AWAY from the output, so column 0 is the
 * carrier and the deepest modulator has the highest column; the painter mirrors
 * that into left-to-right, which puts the signal flow the way it is read.
 * `row` is a lane: parallel carriers get one each, a chain stays on one.
 *
 * Every node returns the rows it occupies and the ANCHORS its parent draws a
 * wire from — a list, because a sum has no box of its own and its branches
 * converge directly on whatever consumes them, exactly as several carriers
 * converge on OUTPUT.
 *
 * Returns {cells, edges, cols, rows, outRow} in grid coordinates, or null.
 */
export function fmGraph(program, opCount) {
  const tree = fmTree(program, opCount);
  if (tree === null) return null;
  const cells = [];
  const edges = [];
  const root = placeFmNode(tree, 0, 0, cells, edges);
  let cols = 1;
  for (const c of cells) if (c.col + 1 > cols) cols = c.col + 1;
  const outRow = (root.height - 1) >> 1;
  for (const a of root.anchors) edges.push({ from: a, to: { col: -1, row: outRow } });
  return { cells, edges, cols, rows: root.height, outRow };
}

/** One node of fmGraph's placement. See its comment for the contract. */
function placeFmNode(node, col, row, cells, edges) {
  if (node.kind === "tap") {
    cells.push({ kind: "op", op: node.op, tap: true, col, row });
    return { height: 1, anchors: [{ col, row }] };
  }
  if (node.kind === "op") {
    // An operator read through its OWN previous output is the self-feedback
    // loop every FM chip draws as a curl on the box, so it is one box here too
    // rather than a box wired to a copy of itself.
    if (node.mod !== null && node.mod.kind === "tap" && node.mod.op === node.op) {
      cells.push({ kind: "op", op: node.op, selfFeedback: true, col, row });
      return { height: 1, anchors: [{ col, row }] };
    }
    if (node.mod === null) {
      cells.push({ kind: "op", op: node.op, col, row });
      return { height: 1, anchors: [{ col, row }] };
    }
    const m = placeFmNode(node.mod, col + 1, row, cells, edges);
    const r = row + ((m.height - 1) >> 1);
    cells.push({ kind: "op", op: node.op, col, row: r });
    for (const a of m.anchors) edges.push({ from: a, to: { col, row: r } });
    return { height: m.height, anchors: [{ col, row: r }] };
  }
  if (node.kind === "add") {
    // No box: a sum is what the wires already do where they meet.
    const a = placeFmNode(node.a, col, row, cells, edges);
    const b = placeFmNode(node.b, col, row + a.height, cells, edges);
    return { height: a.height + b.height, anchors: [...a.anchors, ...b.anchors] };
  }
  // mul / neg — these DO need a mark, because meeting wires would read as a sum.
  const kids = node.kind === "mul" ? [node.a, node.b] : [node.a];
  const anchors = [];
  let h = 0;
  for (const kid of kids) {
    const k = placeFmNode(kid, col + 1, row + h, cells, edges);
    h += k.height;
    anchors.push(...k.anchors);
  }
  const r = row + ((h - 1) >> 1);
  cells.push({ kind: node.kind, col, row: r });
  for (const a of anchors) edges.push({ from: a, to: { col, row: r } });
  return { height: h, anchors: [{ col, row: r }] };
}

/**
 * The algorithm as an expression, for the readout above the word list.
 *
 * RPN is exactly the notation you would not choose to read a patch in, so the
 * editor shows the same program the other way round: `0[1[2]] + 3` says at a
 * glance that operator 2 modulates 1 modulates 0, and that 3 is a second
 * carrier beside it. Square brackets are the modulation, because that is what
 * "operator 0, read through 1" is.
 *
 * Returns null when the program does not verify — there is no expression to
 * show, and showing a half-built one would read as a working patch.
 */
export function fmFormula(program, opCount, name = (k) => String(k)) {
  if (!fmValidate(program, opCount).ok) return null;
  const stack = [];
  for (const w of program) {
    const cls = fmWordClass(w);
    const k = fmWordIndex(w);
    if (cls === FM_CLASS_OSC) { stack.push(name(k)); continue; }
    if (cls === FM_CLASS_FB) { stack.push(`${name(k)}′`); continue; }
    if (cls === FM_CLASS_MOD) { stack.push(`${name(k)}[${stack.pop()}]`); continue; }
    switch (w) {
      case FmOp.ADD: { const b = stack.pop(); stack.push(`(${stack.pop()} + ${b})`); break; }
      case FmOp.MUL: { const b = stack.pop(); stack.push(`(${stack.pop()} × ${b})`); break; }
      case FmOp.NEG: stack.push(`−${stack.pop()}`); break;
      case FmOp.DUP: stack.push(stack[stack.length - 1]); break;
      case FmOp.SWAP: {
        const b = stack.pop(), a = stack.pop();
        stack.push(b, a);
        break;
      }
      default: break;
    }
  }
  const out = stack.pop() ?? "";
  return out.startsWith("(") && out.endsWith(")") ? out.slice(1, -1) : out;
}
