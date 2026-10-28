// The FM Easy tab (item 247) — the fixed-shape overlay of an FM rack
// (doc/fmeasy.js): a preset or a hand-drawn wiring, operators with a level, a
// multiplier, a detune and an envelope each, feedback loops counted in the
// classic unit, and the principal's DSP as the instrument's own.
//
// Nothing here is state. The tab reads the rack every time it draws and every
// edit writes the rack back through easyCompile, so the FM tab and this one
// are two views of one record, whichever of them was used last.
//
// Wiring is drawn and edited in two places that say the same thing: the
// algorithm diagram, where an operator is dragged onto what it should feed,
// and the routing grid under it, one row per operator and one column per
// destination, which is also the keyboard's way in.

import {
  easyDecode, easyNeeds, easyRecordOf, easyFormula, easyTree, easyPresetOf,
  easyApplyPreset, easyToggleWire, easyToggleCarrier, easyWired, easyWireKind,
  easySetFeedback, easyPatchOp, easyAddOperator, easyRemoveOperator, easyCanRemoveOperator,
  easySplitDetune, easyJoinDetune, easyFbAmount, EASY_FB_OCTETS, EASY_PRESETS,
  EASY_MULT_MIN, EASY_MULT_MAX, EASY_MAX_OPERATORS,
} from "../../doc/fmeasy.js";
import { fmOperators, fmProgramOf, fmBudget } from "../../doc/fmedit.js";
import { fmTreeGraph } from "../../doc/fmlayout.js";
import { metaRecordWithFlags } from "../../doc/metaedit.js";
import { setMetaRecordOp, importBankOp } from "../../doc/ops.js";
import { planEasyFm } from "../../doc/bankmerge.js";
import { fmGraphSvg } from "../fmgraph.js";
import { showNotice } from "../components/modal.js";
import { META_MIX_GAIN } from "../../../core/engine/tables.js";
import { t } from "../i18n.js";
import { setIconLabel } from "../icons.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** The classic feedback depths, as the selector spells them. */
const FB_RADIANS = ["0", "π/16", "π/8", "π/4", "π/2", "π", "2π", "4π"];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const dbOf = (octet) => {
  const g = META_MIX_GAIN[octet & 0xff];
  return g <= 0 ? "−∞ dB" : `${(20 * Math.log10(g)).toFixed(1).replace("-", "−")} dB`;
};

/**
 * Write `next` into the rack in `slot`. A model that only rewires and
 * retunes is one record write (and coalesces like any other); one that needs
 * instruments — a new operator, a first feedback depth — is a bank edit that
 * makes them in the same undo step.
 */
function commitModel(view, slot, next) {
  const doc = view.store.doc;
  const inst = doc.instruments[slot];
  const needs = easyNeeds(next);
  if (needs.osc.length > 0 || needs.constant) {
    const plan = planEasyFm(doc, slot, next);
    if (plan.error) { showNotice({ title: t("easy.cantTitle"), body: plan.error }); return; }
    view.store.undo.apply(importBankOp(plan));
  } else {
    const record = easyRecordOf(inst, next);
    if (record === null) { showNotice({ title: t("easy.cantTitle"), body: t("easy.noFit") }); return; }
    view.store.undo.apply(setMetaRecordOp(slot, record));
  }
  view.refresh();
}

/** Render the Easy tab into `view.panel`. */
export function renderFmEasyTab(view, inst) {
  const slot = view.selected;
  const ops = fmOperators(inst);
  const program = fmProgramOf(inst);
  const decoded = easyDecode(ops, program);
  if (!decoded.ok) {
    view.panel.appendChild(lostBanner(view, slot, inst, decoded.reason));
    return;
  }
  const model = decoded.model;
  const commit = (next) => commitModel(view, slot, next);
  const label = (i) => String(model.labels[i] ?? i);
  // The operator whose envelope is open below, kept across redraws.
  const sel = Math.min(Math.max(view._easyOp ?? 0, 0), model.ops.length - 1);
  view._easyOp = sel;

  view.panel.appendChild(toolbar(view, slot, inst, model, commit));

  // ── routing ──
  const algo = el("div", "fm-algo fm-easy-routing");
  const head = el("div", "fm-algo-head");
  head.append(el("h4", "", t("easy.routing")));
  const formula = el("code", "fm-formula", easyFormula(model));
  formula.title = t("easy.formulaTitle");
  head.append(formula);
  algo.append(head);
  algo.append(diagram(model, label, commit));
  algo.append(routingGrid(model, label, commit));
  view.panel.appendChild(algo);

  // ── operators ──
  view.panel.appendChild(operatorTable(view, slot, model, label, sel, commit));
  view.panel.appendChild(el("p", "dim fm-easy-hint", t("easy.multHint")));

  // ── feedback ──
  view.panel.appendChild(feedbackList(model, label, commit));

  // ── the open operator's envelope ──
  const opSlot = model.ops[sel].instIdx & 0x3ff;
  const envHead = el("div", "inst-group-head", t("easy.envHead", { n: label(sel) }));
  view.panel.appendChild(envHead);
  if (opSlot !== 0) view.renderOperatorEnv(opSlot);
}

/** The banner for a rack whose Easy Mode bit is set but which no longer
 *  reads as Easy Mode — an edit made somewhere that could not check. */
function lostBanner(view, slot, inst, reason) {
  const box = el("div", "fm-warn");
  box.append(el("strong", "", t("easy.lostTitle")), " ",
    el("span", "", `${t(`easy.why.${reason}`)} — ${t("easy.lostBody")}`));
  const off = el("button", "", t("easy.turnOff"));
  off.addEventListener("click", () => {
    view.store.undo.apply(setMetaRecordOp(slot, metaRecordWithFlags(inst, { easy: false })));
    view.tab = "fm";
    view.refresh();
  });
  const row = el("div", "fm-easy-lost-actions");
  row.append(off);
  box.append(row);
  return box;
}

/** Preset, output level, the shared DSP, and what the rack costs. */
function toolbar(view, slot, inst, model, commit) {
  const bar = el("div", "meta-bar fm-easy-bar");

  const presetLab = el("label", "fm-easy-field", t("easy.preset"));
  const preset = document.createElement("select");
  preset.title = t("easy.presetTitle");
  const current = easyPresetOf(model);
  if (current === 0) preset.append(new Option(t("easy.custom"), "0", true, true));
  const groups = [[2, t("easy.presets2")], [4, t("easy.presets4")], [6, t("easy.presets6")]];
  for (const [count, name] of groups) {
    const g = document.createElement("optgroup");
    g.label = name;
    for (const p of EASY_PRESETS) {
      if (p.count !== count) continue;
      g.append(new Option(`${p.n} · ${p.formula}`, String(p.n), false, p.n === current));
    }
    preset.append(g);
  }
  preset.addEventListener("change", () => {
    const n = Number(preset.value);
    if (n > 0) commit(easyApplyPreset(model, n));
  });
  presetLab.append(preset);

  const outLab = el("label", "fm-easy-field", t("easy.output"));
  outLab.title = t("easy.outputTitle");
  outLab.append(view.levelInput(model.principal.mixOctet, (octet) =>
    commit({ ...model, principal: { ...model.principal, mixOctet: octet } }), t("easy.outputTitle")));

  const dsp = el("button", "");
  setIconLabel(dsp, "instrument", t("easy.shared"));
  dsp.title = t("easy.sharedTitle");
  dsp.addEventListener("click", () => view.openChild(model.principal.instIdx & 0x3ff, slot));

  const budget = fmBudget(inst.metaLayers.length, fmProgramOf(inst).length);
  const tally = el("span", "dim meta-tally",
    `${t("easy.tally", { n: model.ops.length, max: EASY_MAX_OPERATORS })} · ` +
    `${t("fm.bytes", { used: budget.used, total: budget.total })}`);

  bar.append(presetLab, outLab, dsp, tally);
  return bar;
}


/**
 * The algorithm diagram, its boxes live: drag one onto another to make it
 * modulate that one (or feed it back, where that would close a loop), onto
 * itself for self-feedback, onto OUT to hear it; drag the same way again to
 * undo it. Operators wired to nothing wait in a tray under it.
 */
function diagram(model, label, commit) {
  const wrap = el("div", "fm-easy-diagram");
  const frame = el("div", "fm-graph-frame");
  frame.title = t("easy.dragTitle");
  const svg = fmGraphSvg(fmTreeGraph(easyTree(model)), {
    label,
    title: (i) => t("easy.opTitle", { n: label(i) }),
    loopTitle: (i, level) => t("easy.loopTitle", { n: label(i), depth: FB_RADIANS[level ?? 0] }),
    outLabel: t("fm.out"),
  });
  frame.append(svg);
  wrap.append(frame);

  const shown = new Set();
  const walk = (i) => { shown.add(i); model.mods[i].forEach(walk); };
  model.carriers.forEach(walk);
  const unwired = model.ops.map((_, i) => i).filter((i) => !shown.has(i));
  if (unwired.length > 0) {
    const tray = el("div", "fm-easy-tray");
    tray.append(el("span", "dim", t("easy.unwired")));
    for (const i of unwired) {
      const chip = el("span", "fm-easy-chip", label(i));
      chip.dataset.op = String(i);
      chip.title = t("easy.chipTitle");
      tray.append(chip);
    }
    wrap.append(tray);
  }

  attachWireDrag(wrap, svg, (from, to) => {
    if (to === "out") commit(easyToggleCarrier(model, from));
    else commit(easyToggleWire(model, from, to));
  });
  return wrap;
}

/**
 * Pointer dragging between [data-op] boxes and chips and the [data-out] sink
 * inside `root`. A line follows the pointer from where the drag began; the
 * box under it lights up. `drop(from, to)` gets an operator index and an
 * operator index or "out".
 */
function attachWireDrag(root, svg, drop) {
  let drag = null;
  const targetAt = (x, y) => {
    const hit = document.elementFromPoint(x, y);
    const op = hit?.closest?.("[data-op]");
    if (op && root.contains(op)) return { node: op, to: Number(op.dataset.op) };
    const out = hit?.closest?.("[data-out]");
    if (out && root.contains(out)) return { node: out, to: "out" };
    return null;
  };
  const toSvg = (x, y) => {
    const m = svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = svg.createSVGPoint();
    p.x = x; p.y = y;
    const q = p.matrixTransform(m.inverse());
    return { x: q.x, y: q.y };
  };
  const light = (node) => {
    if (drag.lit === node) return;
    drag.lit?.classList.remove("fm-easy-target");
    drag.lit = node;
    node?.classList.add("fm-easy-target");
  };
  const end = (e, apply) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.line?.remove();
    d.lit?.classList.remove("fm-easy-target");
    root.classList.remove("fm-easy-dragging");
    if (!apply) return;
    const hit = targetAt(e.clientX, e.clientY);
    if (hit) drop(d.from, hit.to);
  };
  root.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const src = e.target.closest?.("[data-op]");
    if (!src || !root.contains(src)) return;
    e.preventDefault();
    const start = toSvg(e.clientX, e.clientY);
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("class", "fm-easy-rubber");
    line.setAttribute("x1", start.x); line.setAttribute("y1", start.y);
    line.setAttribute("x2", start.x); line.setAttribute("y2", start.y);
    svg.append(line);
    drag = { from: Number(src.dataset.op), line, lit: null };
    root.classList.add("fm-easy-dragging");
    try { root.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer */ }
  });
  root.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const p = toSvg(e.clientX, e.clientY);
    drag.line.setAttribute("x2", p.x); drag.line.setAttribute("y2", p.y);
    light(targetAt(e.clientX, e.clientY)?.node ?? null);
  });
  root.addEventListener("pointerup", (e) => end(e, true));
  root.addEventListener("pointercancel", (e) => end(e, false));
  root.addEventListener("lostpointercapture", (e) => end(e, false));
}

/**
 * The routing grid: a row for each operator, a column for each place its
 * output can go — another operator's input, its own, or OUT. A cell reads
 * ● for modulation, ′ for a feedback loop and · for nothing, and a press
 * toggles it; a cell that would close a loop makes a feedback loop instead,
 * and says so in its title.
 */
function routingGrid(model, label, commit) {
  const n = model.ops.length;
  const table = el("table", "fm-easy-grid");
  table.title = t("easy.gridTitle");
  const thead = el("thead");
  const hr = el("tr");
  hr.append(el("th", "dim", t("easy.gridCorner")));
  for (let j = 0; j < n; j++) hr.append(el("th", "", label(j)));
  hr.append(el("th", "", t("fm.out")));
  thead.append(hr);
  table.append(thead);
  const tbody = el("tbody");
  for (let i = 0; i < n; i++) {
    const tr = el("tr");
    tr.append(el("th", "", label(i)));
    for (let j = 0; j < n; j++) {
      const now = easyWired(model, i, j);
      const kind = now ?? easyWireKind(model, i, j);
      const b = el("button", `fm-easy-cell${now ? " on" : ""}${kind === "fb" ? " fb" : ""}`,
        now === "mod" ? "●" : now === "fb" ? "′" : "·");
      b.type = "button";
      b.setAttribute("aria-pressed", now ? "true" : "false");
      b.title = t(kind === "fb" ? "easy.cellFbTitle" : "easy.cellModTitle", { from: label(i), to: label(j) });
      b.addEventListener("click", () => commit(easyToggleWire(model, i, j)));
      const td = el("td");
      td.append(b);
      tr.append(td);
    }
    const carrier = model.carriers.includes(i);
    const out = el("button", `fm-easy-cell${carrier ? " on" : ""}`, carrier ? "●" : "·");
    out.type = "button";
    out.setAttribute("aria-pressed", carrier ? "true" : "false");
    out.title = t("easy.cellOutTitle", { from: label(i) });
    out.disabled = carrier && model.carriers.length === 1;
    out.addEventListener("click", () => commit(easyToggleCarrier(model, i)));
    const td = el("td");
    td.append(out);
    tr.append(td);
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

/** One row per operator: level, multiplier, detune, and what to do with it. */
function operatorTable(view, slot, model, label, sel, commit) {
  const wrap = el("div", "fm-easy-ops");
  const bar = el("div", "meta-bar");
  bar.append(el("h4", "", t("easy.operators")));
  const add = el("button", "");
  setIconLabel(add, "filePlus", t("easy.addOp"));
  add.title = t("easy.addOpTitle");
  add.disabled = model.ops.length >= EASY_MAX_OPERATORS;
  add.addEventListener("click", () => commit(easyAddOperator(model)));
  bar.append(add);
  wrap.append(bar);

  const table = el("table", "files-table meta-table fm-easy-table");
  const hr = el("tr");
  for (const k of ["easy.colOp", "fm.level", "easy.colMult", "easy.colDetune", ""]) {
    hr.append(el("th", "", k ? t(k) : ""));
  }
  const thead = el("thead");
  thead.append(hr);
  table.append(thead);
  const tbody = el("tbody");
  model.ops.forEach((o, i) => {
    const tr = el("tr", i === sel ? "fm-easy-sel" : "");
    tr.append(el("td", "idxCell", label(i)));

    const lv = el("td");
    lv.append(view.levelInput(o.mixOctet, (octet) => commit(easyPatchOp(model, i, { mixOctet: octet })),
      t("easy.levelTitle")));
    tr.append(lv);

    const { mult, fine } = easySplitDetune(o.detune);
    const mt = el("td");
    const multIn = view.metaNumIn(mult, EASY_MULT_MIN, EASY_MULT_MAX,
      (v) => commit(easyPatchOp(model, i, { detune: easyJoinDetune(v, fine) })), t("easy.multTitle"));
    mt.append(multIn);
    tr.append(mt);

    const dt = el("td");
    dt.append(view.detuneInput(fine, -2048, 2047,
      (v) => commit(easyPatchOp(model, i, { detune: easyJoinDetune(mult, v) })), t("easy.detuneTitle")));
    tr.append(dt);

    const act = el("td", "advCell");
    const envBtn = el("button", "toggle", t("easy.env"));
    envBtn.setAttribute("aria-pressed", i === sel ? "true" : "false");
    envBtn.title = t("easy.envTitle");
    envBtn.addEventListener("click", () => { view._easyOp = i; view.renderPanel(); });
    act.append(envBtn,
      view.metaIconBtn(null, t("meta.edit"), t("easy.editTitle"),
        () => view.openChild(o.instIdx & 0x3ff, slot), (o.instIdx & 0x3ff) === 0),
      view.metaIconBtn("close", "", easyCanRemoveOperator(model, i) ? t("easy.removeTitle") : t("easy.removeBlocked"),
        () => commit(easyRemoveOperator(model, i)), !easyCanRemoveOperator(model, i)));
    tr.append(act);
    tbody.append(tr);
  });
  table.append(tbody);
  wrap.append(table);
  return wrap;
}

/** Every feedback loop and its depth. */
function feedbackList(model, label, commit) {
  const wrap = el("div", "fm-easy-fb");
  wrap.append(el("h4", "", t("easy.feedback")));
  if (model.feedback.length === 0) {
    wrap.append(el("p", "dim", t("easy.noFeedback")));
    return wrap;
  }
  for (const f of model.feedback) {
    const row = el("label", "fm-easy-field");
    row.append(el("span", "fm-easy-loop", f.from === f.to
      ? t("easy.loopSelf", { n: label(f.to) }) : t("easy.loopFrom", { from: label(f.from), to: label(f.to) })));
    const s = document.createElement("select");
    s.title = t("easy.depthTitle");
    const { amount, exact } = easyFbAmount(f.octet);
    if (!exact) s.append(new Option(t("easy.depthOdd", { n: amount, db: dbOf(f.octet) }), "-1", true, true));
    EASY_FB_OCTETS.forEach((octet, n) => {
      s.append(new Option(`${n} · ${FB_RADIANS[n]}`, String(n), false, exact && n === amount));
    });
    s.addEventListener("change", () => {
      const n = Number(s.value);
      if (n >= 0) commit(easySetFeedback(model, f.from, f.to, EASY_FB_OCTETS[n]));
    });
    row.append(s);
    wrap.append(row);
  }
  return wrap;
}

