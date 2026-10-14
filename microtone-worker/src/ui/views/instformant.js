// The Formant tab (item 212) — the editor of a type-1 instrument's tract.
//
// Four groups, in the order an instrument is made:
//
//   Material   the pool range the instrument is made from, and which sample in
//              it the vowel is sung with — ranked by the recipe machine
//   Vowel      Lindsey's acoustic vowel chart as a 2D slider (log F1 down, log
//              F2 right to left, as Praat's VowelEditor draws it), the IPA
//              marked on it, and roundness beside it
//   Syllable   the two onset consonants and the coda, each picked from an IPA
//              chart coloured by how well the range can make it, and each
//              sounded by a recipe from a list sorted best first
//   Pitch      how the formants follow the note, and the consonants' pace
//
// Every edit is a setInstBytesOp on the tract block (formantedit.js), so a
// sounding note hears it at once and one undo takes it back. Drags go through
// applyQuiet and repaint in place, as the General tab's sliders do.

import { setInstBytesOp, compositeOp } from "../../doc/ops.js";
import {
  formantFields, formantFieldBytes, formantVowelBytes, formantRangeBytes, formantSlotBytes,
  formantSourceBytes, formantSourceFlagByte, slotFromRecipe, VOWEL_MARKS, nearestVowelMark,
  vowelEffectArg, vowelF1, vowelF2, vowelFormants, vowelCoordsOf, noteHz, timingScale,
  VOWEL_F1_MIN, VOWEL_F1_MAX, CONSONANTS,
} from "../../doc/formantedit.js";
import { FormantMachine, rangeCandidates, poolSpan } from "../../doc/formantrecipe.js";
import {
  CONSONANT_LIST, consonantNeedsNoise,
  MANNER_STOP, MANNER_AFFRICATE, MANNER_FRICATIVE, MANNER_ASPIRATE, MANNER_NASAL,
  MANNER_APPROX, MANNER_TAP, MANNER_TRILL, MANNER_GLOTTAL,
  PLACE_BILABIAL, PLACE_LABIODENTAL, PLACE_DENTAL, PLACE_ALVEOLAR, PLACE_POSTALVEOLAR,
  PLACE_RETROFLEX, PLACE_ALVEOLOPALATAL, PLACE_PALATAL, PLACE_VELAR, PLACE_UVULAR,
  PLACE_PHARYNGEAL, PLACE_GLOTTAL, PLACE_LABIOVELAR, PLACE_LABIOPALATAL,
} from "../../../core/engine/formant.js";
import { unescapeName } from "../../../core/format/names.js";
import { noteToStr } from "../notenames.js";
import { t } from "../i18n.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const POOL_END = 0x800000;
const hex6 = (n) => "$" + (n >>> 0).toString(16).toUpperCase().padStart(6, "0");

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function svg(name, attrs = {}) {
  const n = document.createElementNS(SVG_NS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}

// ── the machine, kept per document while its material is unchanged ─────────

const machines = new WeakMap();

/** A cheap fingerprint of the candidates' bytes: every 16th byte, FNV-1a. */
function fingerprint(bin, cands) {
  let h = 0x811c9dc5;
  for (const e of cands) {
    h = Math.imul(h ^ e.ptr, 16777619) >>> 0;
    h = Math.imul(h ^ e.len, 16777619) >>> 0;
    h = Math.imul(h ^ (e.rate | 0), 16777619) >>> 0;
    for (let i = 0; i < e.len; i += 16) h = Math.imul(h ^ bin[e.ptr + i], 16777619) >>> 0;
  }
  return h;
}

function machineFor(doc, lo, hi) {
  const cands = rangeCandidates(doc, lo, hi);
  const key = `${lo}:${hi}:${fingerprint(doc.sampleBin, cands)}`;
  const had = machines.get(doc);
  if (had && had.key === key) return had.machine;
  const machine = new FormantMachine(doc.sampleBin, cands);
  machines.set(doc, { key, machine });
  return machine;
}

/** The census entry the record's source is, or null. */
function sourceEntry(machine, inst) {
  return machine.cands.find((e) => e.ptr === inst.samplePtr && e.len === inst.sampleLength) ?? null;
}

/** "0.42", or "—" for a consonant no sample can make. */
const fmtBad = (b) => (Number.isFinite(b) ? b.toFixed(2) : "—");
/** good ≤ 0.5 < fair ≤ 1.5 < poor; impossible. */
const badClass = (b) => (!Number.isFinite(b) ? "none" : b <= 0.5 ? "good" : b <= 1.5 ? "fair" : "poor");

// ── the vowel chart ─────────────────────────────────────────────────────────
//
// Lindsey's chart is Praat's VowelEditor plane: log F2 across, high to the
// LEFT, and log F1 down, low at the TOP — so close front [i] is top left and
// open [a] at the bottom. The drawn region is every vowel the chart's bytes
// can name; a drag outside it lands on its edge.

const CH_W = 440, CH_H = 300, PAD = 30;
const F2_LO = 520, F2_HI = 2700, F1_LO = 215, F1_HI = 920;
const xOfF2 = (f2) => PAD + ((Math.log(F2_HI) - Math.log(f2)) / (Math.log(F2_HI) - Math.log(F2_LO))) * (CH_W - 2 * PAD);
const yOfF1 = (f1) => PAD + ((Math.log(f1) - Math.log(F1_LO)) / (Math.log(F1_HI) - Math.log(F1_LO))) * (CH_H - 2 * PAD);
const f2OfX = (x) => Math.exp(Math.log(F2_HI) - ((x - PAD) / (CH_W - 2 * PAD)) * (Math.log(F2_HI) - Math.log(F2_LO)));
const f1OfY = (y) => Math.exp(Math.log(F1_LO) + ((y - PAD) / (CH_H - 2 * PAD)) * (Math.log(F1_HI) - Math.log(F1_LO)));
const pointOf = (front, open) => {
  const f1 = vowelF1(open);
  return [xOfF2(vowelF2(front, f1)), yOfF1(f1)];
};

function regionPath() {
  const pts = [];
  for (let i = 0; i <= 24; i++) pts.push(pointOf(255, (i * 255) / 24));
  for (let i = 24; i >= 0; i--) pts.push(pointOf(0, (i * 255) / 24));
  return "M " + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L ") + " Z";
}

/**
 * The chart as an element. `get()` answers the current {front, open, round};
 * `onDrag(front, open, gid)` is called through a drag and `onMark(mark)` when a
 * symbol is clicked. Returns {node, update(front, open, round)}.
 */
function vowelChart(get, onDrag, onMark) {
  const wrap = el("div", "fmt-chart");
  const s = svg("svg", { viewBox: `0 0 ${CH_W} ${CH_H}`, class: "fmt-chart-svg", role: "img" });
  s.setAttribute("aria-label", t("fmt.chartLabel"));
  const title = svg("title");
  title.textContent = t("fmt.chartTitle");
  s.appendChild(title);
  // The grid, in Hz along both axes.
  for (const f1 of [300, 400, 500, 600, 700, 800]) {
    const y = yOfF1(f1);
    s.append(svg("line", { x1: PAD, x2: CH_W - PAD, y1: y, y2: y, class: "fmt-grid" }));
    const tx = svg("text", { x: CH_W - PAD + 4, y: y + 3, class: "fmt-axis" });
    tx.textContent = String(f1);
    s.appendChild(tx);
  }
  for (const f2 of [600, 800, 1000, 1500, 2000, 2500]) {
    const x = xOfF2(f2);
    s.append(svg("line", { x1: x, x2: x, y1: PAD, y2: CH_H - PAD, class: "fmt-grid" }));
    const tx = svg("text", { x, y: PAD - 8, class: "fmt-axis", "text-anchor": "middle" });
    tx.textContent = f2 >= 1000 ? (f2 / 1000) + "k" : String(f2);
    s.appendChild(tx);
  }
  const axisF1 = svg("text", { x: CH_W - 4, y: CH_H - 8, class: "fmt-axis", "text-anchor": "end" });
  axisF1.textContent = "F1 ↓";
  const axisF2 = svg("text", { x: PAD, y: 12, class: "fmt-axis" });
  axisF2.textContent = "← F2";
  s.append(svg("path", { d: regionPath(), class: "fmt-region" }), axisF1, axisF2);

  // The marks. A pair sharing a position sits either side of it, unrounded
  // on the left, as the IPA chart sets them.
  const at = new Map();
  for (const m of VOWEL_MARKS) {
    const k = `${m.front}:${m.open}`;
    if (!at.has(k)) at.set(k, []);
    at.get(k).push(m);
  }
  const markEls = [];
  for (const group of at.values()) {
    for (const m of group) {
      const [x, y] = pointOf(m.front, m.open);
      const dx = group.length > 1 ? (m.round ? 7 : -7) : 0;
      const g = svg("g", { class: "fmt-mark", tabindex: "0", role: "button" });
      const dot = svg("circle", { cx: x, cy: y, r: 2, class: "fmt-mark-dot" });
      const tx = svg("text", { x: x + dx, y: y - 6, "text-anchor": "middle", class: "fmt-mark-ipa" });
      tx.textContent = m.ipa;
      const tt = svg("title");
      tt.textContent = t(m.round ? "fmt.markRounded" : "fmt.markUnrounded", { ipa: m.ipa });
      g.append(tt, dot, tx);
      const pick = (e) => { e.preventDefault(); e.stopPropagation(); onMark(m); };
      g.addEventListener("pointerdown", (e) => e.stopPropagation());
      g.addEventListener("click", pick);
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") pick(e); });
      markEls.push({ m, tx });
      s.appendChild(g);
    }
  }
  const handle = svg("circle", { r: 7, class: "fmt-handle" });
  s.appendChild(handle);
  wrap.appendChild(s);

  const update = (front, open, round) => {
    const [x, y] = pointOf(front, open);
    handle.setAttribute("cx", x.toFixed(1));
    handle.setAttribute("cy", y.toFixed(1));
    const near = nearestVowelMark(front, open, round);
    for (const { m, tx } of markEls) tx.classList.toggle("near", m === near);
  };

  // Dragging: the pointer's F1/F2, clamped into the region by the chart's own
  // inverse, so the handle never leaves it.
  let gid = null;
  const toCoords = (e) => {
    const r = s.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * CH_W;
    const y = ((e.clientY - r.top) / r.height) * CH_H;
    const f1 = Math.min(Math.max(f1OfY(y), VOWEL_F1_MIN), VOWEL_F1_MAX);
    const [front, open] = vowelCoordsOf(f1, f2OfX(x));
    return [Math.round(front), Math.round(open)];
  };
  s.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    gid = "fmt" + Date.now() + Math.random();
    try { s.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
    const [front, open] = toCoords(e);
    onDrag(front, open, gid);
  });
  s.addEventListener("pointermove", (e) => {
    if (gid === null) return;
    const [front, open] = toCoords(e);
    onDrag(front, open, gid);
  });
  const end = () => { gid = null; };
  s.addEventListener("pointerup", end);
  s.addEventListener("pointercancel", end);
  const cur = get();
  update(cur.front, cur.open, cur.round);
  return { node: wrap, update };
}

// ── the consonant chart ─────────────────────────────────────────────────────

const LATERAL = new Set(["ɬ", "ɮ", "l", "ɭ", "ʎ", "ʟ"]);
const PLACES = [
  PLACE_BILABIAL, PLACE_LABIODENTAL, PLACE_DENTAL, PLACE_ALVEOLAR, PLACE_POSTALVEOLAR,
  PLACE_RETROFLEX, PLACE_ALVEOLOPALATAL, PLACE_PALATAL, PLACE_VELAR, PLACE_UVULAR,
  PLACE_PHARYNGEAL, PLACE_GLOTTAL, -1,
];
const PLACE_KEY = {
  [PLACE_BILABIAL]: "bilabial", [PLACE_LABIODENTAL]: "labiodental", [PLACE_DENTAL]: "dental",
  [PLACE_ALVEOLAR]: "alveolar", [PLACE_POSTALVEOLAR]: "postalveolar", [PLACE_RETROFLEX]: "retroflex",
  [PLACE_ALVEOLOPALATAL]: "alveolopalatal", [PLACE_PALATAL]: "palatal", [PLACE_VELAR]: "velar",
  [PLACE_UVULAR]: "uvular", [PLACE_PHARYNGEAL]: "pharyngeal", [PLACE_GLOTTAL]: "glottal", [-1]: "other",
};
const ROWS = ["plosive", "aspirated", "nasal", "trill", "tap", "fricative", "latfric", "approx", "latapprox", "affricate"];

function rowOf(r) {
  if (r.manner === MANNER_STOP) return r.ipa.endsWith("ʰ") ? "aspirated" : "plosive";
  if (r.manner === MANNER_GLOTTAL) return "plosive";
  if (r.manner === MANNER_NASAL) return "nasal";
  if (r.manner === MANNER_TRILL) return "trill";
  if (r.manner === MANNER_TAP) return "tap";
  if (r.manner === MANNER_FRICATIVE || r.manner === MANNER_ASPIRATE) return LATERAL.has(r.ipa) ? "latfric" : "fricative";
  if (r.manner === MANNER_APPROX) return LATERAL.has(r.ipa) ? "latapprox" : "approx";
  if (r.manner === MANNER_AFFRICATE) return "affricate";
  return "fricative";
}
const placeOf = (r) => (r.place === PLACE_LABIOVELAR || r.place === PLACE_LABIOPALATAL ? -1 : r.place);

/**
 * The IPA consonant chart as a picker: places across, manners down, the
 * voiceless member of a pair on the left. Each symbol is coloured by the best
 * badness the range can make it with. Resolves the chosen id, 0 for "none",
 * or null when cancelled.
 */
function pickConsonant(best, current) {
  return new Promise((resolve) => {
    const dlg = el("dialog", "modal fmt-cons-modal");
    const finish = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    const table = el("table", "fmt-cons-table");
    const head = el("tr");
    head.appendChild(el("th"));
    for (const p of PLACES) {
      const th = el("th", "fmt-cons-place", t(`fmt.place.${PLACE_KEY[p]}`));
      head.appendChild(th);
    }
    table.appendChild(head);
    for (const rk of ROWS) {
      const rowEls = CONSONANT_LIST.filter((r) => rowOf(r) === rk);
      if (rowEls.length === 0) continue;
      const tr = el("tr");
      tr.appendChild(el("th", "fmt-cons-manner", t(`fmt.manner.${rk}`)));
      for (const p of PLACES) {
        const td = el("td");
        const here = rowEls.filter((r) => placeOf(r) === p).sort((a, b) => Number(a.voiced) - Number(b.voiced));
        for (const r of here) {
          const b = best.get(r.id);
          const btn = el("button", `fmt-cons ${badClass(b)}${r.id === current ? " current" : ""}`, r.ipa);
          btn.type = "button";
          btn.title = `[${r.ipa}] · ${t("fmt.badness", { b: fmtBad(b) })}` +
            (consonantNeedsNoise(r) ? "" : ` · ${t("fmt.noNoise")}`);
          btn.addEventListener("click", (e) => { e.preventDefault(); finish(r.id); });
          td.appendChild(btn);
        }
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }
    const scroller = el("div", "fmt-cons-scroll");
    scroller.appendChild(table);
    const legend = el("p", "dim fmt-cons-legend", t("fmt.pickHint"));
    const btnRow = el("div", "modal-buttons");
    const noneBtn = el("button", "", t("fmt.consClear"));
    const cancelBtn = el("button", "", t("common.cancel"));
    noneBtn.addEventListener("click", (e) => { e.preventDefault(); finish(0); });
    cancelBtn.addEventListener("click", (e) => { e.preventDefault(); finish(null); });
    btnRow.append(noneBtn, cancelBtn);
    dlg.append(el("h3", "", t("fmt.pickTitle")), legend, scroller, btnRow);
    document.body.appendChild(dlg);
    dlg.addEventListener("cancel", () => finish(null));
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    dlg.showModal();
    (dlg.querySelector(".fmt-cons.current") ?? dlg.querySelector(".fmt-cons.good") ?? cancelBtn).focus();
  });
}

// ── the tab ─────────────────────────────────────────────────────────────────

/** A candidate as a list names it: a census number and name, or a region
 *  and the second a window was cut at. */
function nameOf(e) {
  return e.label ?? `${String(e.index).padStart(3, "0")} ${unescapeName(e.name) || t("smp.namePlaceholder")}`;
}

/** Recipe list label: sample, offset, speed, tilt, badness. */
function recipeLabel(r) {
  if (!r.cand) return t("fmt.recipeVoicing");
  const speed = r.rate / Math.max(1, r.cand.rate);
  const tilt = r.tilt === 0 ? "" : r.tilt > 0 ? ` · ${t("fmt.brighter")}` : ` · ${t("fmt.darker")}`;
  return `${fmtBad(r.badness)} — ${nameOf(r.cand)} · @${r.offset} · ×${speed.toFixed(2)}${tilt}`;
}

const sameRecipe = (s, r) => r.cand !== null && s.ptr === r.cand.ptr && s.len === r.cand.len &&
  s.offset === r.offset && s.rate === r.rate && s.tilt === r.tilt;

export function renderFormantTab(view, inst) {
  const doc = view.store.doc;
  const slot = view.selected;
  const f = formantFields(inst);
  const apply = (pairs, gid = null) => view.store.undo.apply(setInstBytesOp(slot, pairs, gid));
  const applyQuiet = (pairs, gid) => view.applyQuiet(setInstBytesOp(slot, pairs, gid));

  // ── Material ──
  let lo = f.rangeLo, hi = f.rangeHi;
  if (hi <= lo) [lo, hi] = poolSpan(doc);  // a record with no range: everything
  const machine = machineFor(doc, lo, hi);
  const src = sourceEntry(machine, inst);
  const ranked = machine.sources();

  const rangeRow = el("div", "slider-row fmt-range");
  const loIn = el("input", "sl-num wide");
  loIn.type = "text"; loIn.value = hex6(lo); loIn.title = t("fmt.rangeLoTitle");
  const hiIn = el("input", "sl-num wide");
  hiIn.type = "text"; hiIn.value = hex6(hi); hiIn.title = t("fmt.rangeHiTitle");
  const parseHex = (s) => {
    const v = parseInt(String(s).trim().replace(/^\$|^0x/i, ""), 16);
    return Number.isFinite(v) ? Math.max(0, Math.min(POOL_END, v)) : null;
  };
  const commitRange = () => {
    const a = parseHex(loIn.value), b = parseHex(hiIn.value);
    if (a === null || b === null || b <= a) { loIn.value = hex6(lo); hiIn.value = hex6(hi); return; }
    apply(formantRangeBytes(a, b));
  };
  loIn.addEventListener("change", commitRange);
  hiIn.addEventListener("change", commitRange);
  const allBtn = el("button", "", t("fmt.rangeAll"));
  allBtn.type = "button";
  allBtn.title = t("fmt.rangeAllTitle");
  allBtn.addEventListener("click", () => {
    const [a, b] = poolSpan(doc);
    if (b > a) apply(formantRangeBytes(a, b));
  });
  rangeRow.append(el("span", "sl-label", t("fmt.range")), loIn, el("span", "fmt-dash", "–"), hiIn,
    el("span", "sl-ann", t("fmt.rangeCount", { n: machine.materialCount })), allBtn);
  rangeRow.title = t("fmt.rangeTitle");

  const srcOpts = ranked.map((j) => [
    `${j.cand.ptr}:${j.cand.len}`,
    `${nameOf(j.cand)} · ${j.hz > 0 ? j.hz.toFixed(0) + " Hz" : "—"} · ${fmtBad(j.badness)}`,
  ]);
  const srcKey = src ? `${src.ptr}:${src.len}` : "";
  const srcRow = view.pickRow(t("fmt.source"), srcKey,
    src ? srcOpts : [["", t("fmt.sourceNone")], ...srcOpts],
    (v) => {
      const j = ranked.find((x) => `${x.cand.ptr}:${x.cand.len}` === v);
      if (!j) return;
      // The new source sets the level every recipe's noise is matched to, so
      // each slot keeps its recipe and takes the gain the new source asks for.
      const pairs = [...formantSourceBytes(j.cand, j.c4Rate), ...formantSourceFlagByte(inst, j.cand)];
      f.slots.forEach((s, i) => {
        if (!s.cons || s.len === 0) return;
        const r = machine.recipes(s.cons, j.cand, f.timing).find((x) => sameRecipe(s, x));
        if (r) pairs.push(...formantSlotBytes(i, slotFromRecipe(s.cons, r)));
      });
      apply(pairs);
    });
  srcRow.title = t("fmt.sourceTitle");
  view.group(t("fmt.grpMaterial"), rangeRow, srcRow,
    machine.cands.length === 0 ? el("p", "dim fmt-note", t("fmt.rangeEmpty")) : null);

  // ── Vowel ──
  const vowel = { front: f.front, open: f.open, round: f.round };
  const readout = el("div", "fmt-readout");
  const paintReadout = () => {
    const F = vowelFormants(vowel.front, vowel.open, vowel.round, new Float64Array(5));
    const m = nearestVowelMark(vowel.front, vowel.open, vowel.round);
    const arg = vowelEffectArg(vowel.front, vowel.open, vowel.round);
    const fx = "S $" + arg.toString(16).toUpperCase().padStart(4, "0");
    readout.textContent = t("fmt.readout", {
      f1: Math.round(F[0]), f2: Math.round(F[1]), f3: Math.round(F[2]), ipa: m?.ipa ?? "?", fx,
    });
  };
  const chart = vowelChart(
    () => vowel,
    (front, open, gid) => {
      vowel.front = front; vowel.open = open;
      chart.update(front, open, vowel.round);
      paintReadout();
      applyQuiet(formantVowelBytes(front, open, vowel.round), gid);
    },
    (m) => {
      vowel.front = m.front; vowel.open = m.open; vowel.round = m.round;
      apply(formantVowelBytes(m.front, m.open, m.round));
    },
  );
  paintReadout();
  const roundRow = view.sliderRow(t("fmt.round"), f.round, 0, 255, (v, gid) => {
    vowel.round = v;
    chart.update(vowel.front, vowel.open, v);
    paintReadout();
    applyQuiet(formantFieldBytes("round", v), gid);
  }, { ann: (v) => (v < 64 ? t("fmt.spread") : v > 191 ? t("fmt.rounded") : t("fmt.halfRounded")) });
  view.group(t("fmt.grpVowel"), chart.node, roundRow, readout);

  // ── Syllable ──
  const best = machine.bestPerConsonant(src, f.timing);
  const slotRow = (i, labelKey) => {
    const s = f.slots[i];
    const row = el("div", "slider-row fmt-slot");
    const r = CONSONANTS[s.cons];
    const consBtn = el("button", `fmt-slot-cons${r ? "" : " empty"}`, r ? r.ipa : t("fmt.consNone"));
    consBtn.type = "button";
    consBtn.title = t("fmt.consTitle");
    consBtn.addEventListener("click", async () => {
      const id = await pickConsonant(best, s.cons);
      if (id === null) return;
      if (id === 0) { apply(formantSlotBytes(i, { cons: 0 })); return; }
      const top = machine.recipes(id, src, f.timing)[0] ?? null;
      apply(formantSlotBytes(i, slotFromRecipe(id, top)));
    });
    row.append(el("span", "sl-label", t(labelKey)), consBtn);
    if (r && consonantNeedsNoise(r)) {
      const list = machine.recipes(s.cons, src, f.timing).slice(0, 16);
      const curIdx = list.findIndex((x) => sameRecipe(s, x));
      const opts = list.map((x, k) => [String(k), recipeLabel(x)]);
      const sel = el("select", "sl-pick fmt-recipe");
      if (curIdx < 0) {
        const o = el("option", "", s.len > 0 ? t("fmt.recipeStored") : t("fmt.recipeNone"));
        o.value = "";
        sel.appendChild(o);
      }
      for (const [v, text] of opts) {
        const o = el("option", "", text);
        o.value = v;
        sel.appendChild(o);
      }
      sel.value = curIdx >= 0 ? String(curIdx) : "";
      sel.title = t("fmt.recipeTitle");
      sel.addEventListener("change", () => {
        const x = list[parseInt(sel.value, 10)];
        if (x) apply(formantSlotBytes(i, slotFromRecipe(s.cons, x)));
      });
      row.appendChild(sel);
    } else if (r) {
      row.appendChild(el("span", "sl-ann", t("fmt.recipeVoicing")));
    }
    return row;
  };
  view.group(t("fmt.grpSyllable"),
    slotRow(0, "fmt.onset1"), slotRow(1, "fmt.onset2"), slotRow(2, "fmt.coda"),
    el("p", "dim fmt-note", t("fmt.syllableNote")));

  // ── Pitch and timing ──
  view.group(t("fmt.grpPitch"),
    view.sliderRow(t("fmt.track"), f.track, 0, 255,
      (v, gid) => applyQuiet(formantFieldBytes("track", v), gid),
      { ann: (v) => t("fmt.trackAnn", { k: (v / 256).toFixed(2) }) }),
    view.sliderRow(t("fmt.ref"), f.refNote, 0x2000, 0x7000,
      (v, gid) => applyQuiet(formantFieldBytes("refNote", v), gid),
      { ann: (v) => `${noteToStr(v)} · ${noteHz(v).toFixed(1)} Hz` }),
    view.sliderRow(t("fmt.timing"), f.timing, 0, 255,
      (v, gid) => applyQuiet(formantFieldBytes("timing", v), gid),
      { ann: (v) => `×${timingScale(v).toFixed(2)}` }),
    view.sliderRow(t("fmt.glide"), f.glide, 0, 255,
      (v, gid) => applyQuiet(formantFieldBytes("glide", v), gid),
      { ann: (v) => `${v * 2} ms` }),
  );
  const notes = view.panel.querySelectorAll(".inst-rows");
  const last = notes[notes.length - 1];
  if (last) {
    last.querySelector(".slider-row:nth-child(1)")?.setAttribute("title", t("fmt.trackTitle"));
    last.querySelector(".slider-row:nth-child(2)")?.setAttribute("title", t("fmt.refTitle"));
    last.querySelector(".slider-row:nth-child(3)")?.setAttribute("title", t("fmt.timingTitle"));
    last.querySelector(".slider-row:nth-child(4)")?.setAttribute("title", t("fmt.glideTitle"));
  }
}
