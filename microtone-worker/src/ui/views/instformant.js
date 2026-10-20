// The Formant tab (item 212) — the editor of a type-1 instrument's tract.
//
// Four groups, in the order an instrument is made:
//
//   Material   the pool range the instrument is made from — a sample, a
//              recording, all of them, or typed addresses — and the source the
//              vowel is sung with, which the recipe machine CHOOSES: the loop in
//              the range that best suits the vowel, chosen again whenever the
//              range or the vowel changes. Or an OPL instrument sings in the
//              sample's place, copied in as a sub-instrument of this one
//   Vowel      the tongue on Lindsey's acoustic vowel chart as a 2D slider
//              (log F1 down, log F2 right to left, as Praat's VowelEditor
//              draws it), the IPA marked on it, and the lips' roundness
//              beside it, which moves both
//   Syllable   the two onset consonants and the coda, each picked from an IPA
//              chart coloured by how well the range can make it, and each
//              sounded by a recipe from a list sorted best first
//   Pitch      how the formants follow the note, and the consonants' pace
//
// Every edit is a setInstBytesOp on the tract block (formantedit.js), so a
// sounding note hears it at once and one undo takes it back. Drags go through
// applyQuiet and repaint in place, as the General tab's sliders do.

import { setInstBytesOp, compositeOp, importBankOp } from "../../doc/ops.js";
import { planSetFormantSource } from "../../doc/bankmerge.js";
import {
  formantFields, formantFieldBytes, formantVowelBytes, formantRangeBytes, formantSlotBytes,
  formantSourceBytes, formantSourceFlagByte, canSourceFormant, slotFromRecipe, slotIsRecipe, VOWEL_MARKS, nearestVowelMark,
  formantGrBytes, rhoticIpa,
  vowelEffectArg, vowelF1F2, vowelFormants, vowelCoordsOf, noteHz, timingScale, CONSONANTS,
} from "../../doc/formantedit.js";
import { FormantMachine, rangeCandidates, poolSpan } from "../../doc/formantrecipe.js";
import {
  CONSONANT_LIST, consonantNeedsNoise, SEMIVOWELS,
  MANNER_STOP, MANNER_AFFRICATE, MANNER_FRICATIVE, MANNER_ASPIRATE, MANNER_NASAL,
  MANNER_APPROX, MANNER_TAP, MANNER_TRILL, MANNER_GLOTTAL,
  PLACE_BILABIAL, PLACE_LABIODENTAL, PLACE_DENTAL, PLACE_ALVEOLAR, PLACE_POSTALVEOLAR,
  PLACE_RETROFLEX, PLACE_ALVEOLOPALATAL, PLACE_PALATAL, PLACE_VELAR, PLACE_UVULAR,
  PLACE_PHARYNGEAL, PLACE_GLOTTAL, PLACE_LABIOVELAR, PLACE_LABIOPALATAL,
} from "../../../core/engine/formant.js";
import { unescapeName } from "../../../core/format/names.js";
import { noteToStr } from "../notenames.js";
import { t } from "../i18n.js";
import { actionRow } from "../components/actions.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const POOL_END = 0x800000;
const hex6 = (n) => "$" + (n >>> 0).toString(16).toUpperCase().padStart(6, "0");
const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(2) + " MB"
  : n >= 1024 ? (n / 1024).toFixed(1) + " KB" : n + " B");

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
// open [a] at the bottom. Everything on it is drawn where it SOUNDS. The
// handle is the tongue, and the drawn region is everywhere the tongue can go
// with the lips as the roundness slider has them: rounding shrinks it towards
// the back and the bottom, and carries the handle with it. A drag outside the
// region lands on its edge. Marks of the other lip setting are dimmed — a
// click on one sets the lips too.

const CH_W = 440, CH_H = 300, PAD = 30;
const F2_LO = 520, F2_HI = 2700, F1_LO = 215, F1_HI = 920;
const xOfF2 = (f2) => PAD + ((Math.log(F2_HI) - Math.log(f2)) / (Math.log(F2_HI) - Math.log(F2_LO))) * (CH_W - 2 * PAD);
const yOfF1 = (f1) => PAD + ((Math.log(f1) - Math.log(F1_LO)) / (Math.log(F1_HI) - Math.log(F1_LO))) * (CH_H - 2 * PAD);
const f2OfX = (x) => Math.exp(Math.log(F2_HI) - ((x - PAD) / (CH_W - 2 * PAD)) * (Math.log(F2_HI) - Math.log(F2_LO)));
const f1OfY = (y) => Math.exp(Math.log(F1_LO) + ((y - PAD) / (CH_H - 2 * PAD)) * (Math.log(F1_HI) - Math.log(F1_LO)));
const f1f2 = new Float64Array(2);
const pointOf = (front, open, round) => {
  vowelF1F2(front, open, round, f1f2);
  return [xOfF2(f1f2[1]), yOfF1(f1f2[0])];
};

/** The tongue's square, front edge, open edge, back edge, close edge, as it
 *  sounds with the lips at `round`. */
function regionPath(round) {
  const pts = [];
  const N = 24, q = (i) => (i * 255) / N;
  for (let i = 0; i <= N; i++) pts.push(pointOf(255, q(i), round));
  for (let i = N - 1; i >= 0; i--) pts.push(pointOf(q(i), 255, round));
  for (let i = N - 1; i >= 0; i--) pts.push(pointOf(0, q(i), round));
  for (let i = 1; i < N; i++) pts.push(pointOf(q(i), 0, round));
  return "M " + pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L ") + " Z";
}

/**
 * The chart as an element. `get()` answers the current {front, open, round};
 * `onDrag(front, open, gid)` is called through a drag and `onMark(mark)` when a
 * symbol is clicked, `onDragEnd()` when a drag lets go. Returns {node,
 * update(front, open, round)}.
 */
function vowelChart(get, onDrag, onMark, onDragEnd = () => {}) {
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
  const region = svg("path", { class: "fmt-region" });
  s.append(region, axisF1, axisF2);

  // The marks, each where it sounds.
  const markEls = [];
  for (const m of VOWEL_MARKS) {
    const [x, y] = pointOf(m.front, m.open, m.round);
    const g = svg("g", { class: "fmt-mark", tabindex: "0", role: "button" });
    const dot = svg("circle", { cx: x, cy: y, r: 2, class: "fmt-mark-dot" });
    const tx = svg("text", { x, y: y - 6, "text-anchor": "middle", class: "fmt-mark-ipa" });
    tx.textContent = m.ipa;
    const tt = svg("title");
    tt.textContent = t(m.round ? "fmt.markRounded" : "fmt.markUnrounded", { ipa: m.ipa });
    g.append(tt, dot, tx);
    const pick = (e) => { e.preventDefault(); e.stopPropagation(); onMark(m); };
    g.addEventListener("pointerdown", (e) => e.stopPropagation());
    g.addEventListener("click", pick);
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") pick(e); });
    markEls.push({ m, g, tx });
    s.appendChild(g);
  }
  const handle = svg("circle", { r: 7, class: "fmt-handle" });
  s.appendChild(handle);
  wrap.appendChild(s);

  let drawnRound = -1;
  const update = (front, open, round) => {
    if (round !== drawnRound) {
      drawnRound = round;
      region.setAttribute("d", regionPath(round));
      for (const { m, g } of markEls) g.classList.toggle("off", Math.abs(m.round - round) > 127);
    }
    const [x, y] = pointOf(front, open, round);
    handle.setAttribute("cx", x.toFixed(1));
    handle.setAttribute("cy", y.toFixed(1));
    const near = nearestVowelMark(front, open, round);
    for (const { m, tx } of markEls) tx.classList.toggle("near", m === near);
  };

  // Dragging: the pointer's F1/F2, turned into the tongue position that
  // sounds nearest it with the lips as they are — so the handle never leaves
  // the region.
  let gid = null;
  const toCoords = (e) => {
    const r = s.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * CH_W;
    const y = ((e.clientY - r.top) / r.height) * CH_H;
    const [front, open] = vowelCoordsOf(f1OfY(y), f2OfX(x), get().round);
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
  const end = () => { if (gid !== null) { gid = null; onDragEnd(); } };
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
    // Picking a cell IS the proceed; clearing is the one other way out that
    // changes something.
    const { row: btnRow, cancel: cancelBtn, alternatives: [noneBtn] } =
      actionRow({ cancel: true, alternatives: [t("fmt.consClear")] });
    noneBtn.addEventListener("click", (e) => { e.preventDefault(); finish(0); });
    cancelBtn.addEventListener("click", (e) => { e.preventDefault(); finish(null); });
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
  if (r.generator) return `${fmtBad(r.badness)} — ${t("fmt.recipeGenerator")}`;
  if (!r.cand) return t("fmt.recipeVoicing");
  const speed = r.rate / Math.max(1, r.cand.rate);
  const tilt = r.tilt === 0 ? "" : r.tilt > 0 ? ` · ${t("fmt.brighter")}` : ` · ${t("fmt.darker")}`;
  return `${fmtBad(r.badness)} — ${nameOf(r.cand)} · @${r.offset} · ×${speed.toFixed(2)}${tilt}`;
}


export function renderFormantTab(view, inst) {
  const doc = view.store.doc;
  const slot = view.selected;
  const f = formantFields(inst);
  const apply = (pairs, gid = null) => view.store.undo.apply(setInstBytesOp(slot, pairs, gid));
  const applyQuiet = (pairs, gid) => view.applyQuiet(setInstBytesOp(slot, pairs, gid));

  // ── Material ──
  // The RANGE is the user's; the SOURCE is the machine's. Whenever the range
  // or the vowel moves, the source is chosen again for them — the loop in the
  // range that best suits the vowel — in the same undo step as the edit.
  let lo = f.rangeLo, hi = f.rangeHi;
  if (hi <= lo) [lo, hi] = poolSpan(doc);  // a record with no range: everything
  const machine = machineFor(doc, lo, hi);
  const vowel = { front: f.front, open: f.open, round: f.round };
  const vowelFor = (v) => ({ ...v, track: f.track, refNote: f.refNote });

  /** The bytes that make machine `m`'s best source for vowel `v` the record's:
   *  {pairs, best}. Always the same offsets (empty when nothing in the range
   *  can be a source), so every step of a drag coalesces into one undo step. */
  const sourcePairs = (m, v) => {
    const best = m.bestSource(vowelFor(v));
    if (!best) return { pairs: [], best: null };
    return { pairs: [...formantSourceBytes(best.cand, best.c4Rate), ...formantSourceFlagByte(inst, best.cand)], best };
  };
  const setRange = (a, b) => {
    const { pairs } = sourcePairs(machineFor(doc, a, b), vowel);
    apply([...formantRangeBytes(a, b), ...pairs]);
  };

  // The range: one of the pool's samples or recordings, all of them, or two
  // addresses typed in.
  const census = doc.sampleList(), regions = doc.sampleRegions();
  const [alo, ahi] = poolSpan(doc);
  const items = [["all", t("fmt.rangeAllItems"), alo, ahi]];
  const sampleItems = census.map((e) => [`s${e.ptr}:${e.len}`,
    `${String(e.index).padStart(3, "0")} ${unescapeName(e.name) || t("smp.namePlaceholder")} · ${fmtBytes(e.len)} · ${hex6(e.ptr)}`,
    e.ptr, e.ptr + e.len]);
  const regionItems = regions.map((r, i) => [`r${r.ptr}:${r.len}`,
    `R${String(i).padStart(2, "0")} ${unescapeName(r.name) || t("rgn.namePlaceholder")} · ${fmtBytes(r.len)} · ${hex6(r.ptr)}`,
    r.ptr, r.ptr + r.len]);
  const all = [...items, ...sampleItems, ...regionItems];
  const current = all.find(([, , a, b]) => a === lo && b === hi) ?? null;
  const pick = ([v, text]) => [v, text];
  const rangePick = view.pickRow(t("fmt.range"), current ? current[0] : "",
    [...(current ? [] : [["", t("fmt.rangeCustom")]]), ...items.map(pick)],
    (v) => {
      const it = all.find((x) => x[0] === v);
      if (it && it[3] > it[2]) setRange(it[2], it[3]);
    },
    [[t("fmt.rangeGroupSamples"), sampleItems.map(pick)], [t("fmt.rangeGroupRecordings"), regionItems.map(pick)]]);
  rangePick.title = t("fmt.rangeTitle");

  const addrRow = el("div", "slider-row fmt-range");
  const loIn = el("input", "sl-num wide");
  loIn.type = "text"; loIn.value = hex6(lo); loIn.title = t("fmt.rangeLoTitle");
  const hiIn = el("input", "sl-num wide");
  hiIn.type = "text"; hiIn.value = hex6(hi); hiIn.title = t("fmt.rangeHiTitle");
  const parseHex = (v) => {
    const n = parseInt(String(v).trim().replace(/^\$|^0x/i, ""), 16);
    return Number.isFinite(n) ? Math.max(0, Math.min(POOL_END, n)) : null;
  };
  const commitRange = () => {
    const a = parseHex(loIn.value), b = parseHex(hiIn.value);
    if (a === null || b === null || b <= a) { loIn.value = hex6(lo); hiIn.value = hex6(hi); return; }
    setRange(a, b);
  };
  loIn.addEventListener("change", commitRange);
  hiIn.addEventListener("change", commitRange);
  addrRow.append(el("span", "sl-label", t("fmt.rangeAddr")), loIn, el("span", "fmt-dash", "–"), hiIn,
    el("span", "sl-ann", t("fmt.rangeCount", { n: machine.materialCount })));

  // The source, as chosen: what it is, where it loops, and for which vowel.
  const srcRow = el("div", "slider-row fmt-source");
  const srcText = el("span", "sl-ann fmt-source-text");
  const paintSource = () => {
    const e = sourceEntry(machine, inst) ?? (inst.sampleLength > 0 ? null : undefined);
    if (e === undefined) { srcText.textContent = t("fmt.sourceNone"); return; }
    const j = e ? machine.judgeSource({ ...e, loopStart: inst.sampleLoopStart, loopEnd: inst.sampleLoopEnd,
      loopMode: inst.loopMode }, vowelFor(vowel)) : null;
    // No pitch here: the source is tuned to middle C, and a census sample
    // reports its rate as the record has it — a figure that would be the tuned
    // pitch, not the recording's own.
    const where = e ? nameOf(e) : hex6(inst.samplePtr);
    const ipa = nearestVowelMark(vowel.front, vowel.open, vowel.round)?.ipa ?? "?";
    srcText.textContent = `${where} · ${t("fmt.sourceLoop", { a: inst.sampleLoopStart, b: inst.sampleLoopEnd })}` +
      (j ? ` · ${t("fmt.sourceFor", { ipa, b: fmtBad(j.badness) })}` : "");
  };
  const againBtn = el("button", "", t("fmt.sourcePick"));
  againBtn.type = "button";
  againBtn.title = t("fmt.sourcePickTitle");
  againBtn.addEventListener("click", () => {
    const { pairs, best } = sourcePairs(machine, vowel);
    if (!best) return;
    if (!pairs.every(([o, v]) => inst.getByte(o) === v)) apply(pairs);
  });
  srcRow.append(el("span", "sl-label", t("fmt.source")), srcText, againBtn);
  srcRow.title = t("fmt.sourceTitle");
  paintSource();

  // What the vowel is sung WITH: the sample above, or a chip instrument's
  // voice (OPL or PSG) in its place. Picking one copies it in as this instrument's own
  // sub-instrument, as a layer is, so the source is edited from here.
  const chip = inst.formant.srcInst >= 1 && canSourceFormant(doc.instruments[inst.formant.srcInst])
    ? inst.formant.srcInst : 0;
  const instLabel = (s) => `$${s.toString(16).toUpperCase().padStart(s > 0xff ? 3 : 2, "0")} ` +
    (unescapeName(doc.instrumentName(s)) || "");
  const oplItems = doc.selectableInstrumentSlots()
    .filter((s) => s !== slot && canSourceFormant(doc.instruments[s]))
    .map((s) => [String(s), instLabel(s)]);
  const sungPick = view.pickRow(t("fmt.sungFrom"), String(chip),
    [["0", t("fmt.sungFromSample")], ...(chip ? [[String(chip), instLabel(chip)]] : [])],
    (v) => {
      const to = Number(v);
      if (to === chip) return;
      const plan = planSetFormantSource(doc, slot, to);
      if (plan.error) { alert(plan.error); return; }
      view.store.undo.apply(importBankOp(plan));
    },
    [[t("fmt.sungFromGroup"), oplItems]]);
  sungPick.title = t("fmt.sungFromTitle");
  if (chip) {
    const editBtn = el("button", "", t("fmt.sungFromEdit"));
    editBtn.type = "button";
    editBtn.addEventListener("click", () => view.openChild(chip, slot));
    sungPick.append(editBtn);
    srcRow.classList.add("dim");
    srcText.textContent += ` · ${t("fmt.sourceIdle")}`;
  }
  view.group(t("fmt.grpMaterial"), rangePick, addrRow, sungPick, srcRow,
    machine.cands.length === 0 && !chip ? el("p", "dim fmt-note", t("fmt.rangeEmpty")) : null);

  // ── Vowel ──
  const readout = el("div", "fmt-readout");
  const paintReadout = () => {
    const F = vowelFormants(vowel.front, vowel.open, vowel.round, new Float64Array(5), f.rhotic);
    const m = nearestVowelMark(vowel.front, vowel.open, vowel.round);
    const ipa = m ? (f.rhotic ? rhoticIpa(m.ipa) : m.ipa) : "?";
    const arg = vowelEffectArg(vowel.front, vowel.open, vowel.round);
    const fx = "S\u00a0$" + arg.toString(16).toUpperCase().padStart(4, "0");
    readout.textContent = t("fmt.readout", {
      f1: Math.round(F[0]), f2: Math.round(F[1]), f3: Math.round(F[2]), ipa, fx,
    });
  };
  // A vowel edit carries the source chosen for the new vowel with it.
  const vowelEdit = (gid) => {
    const { pairs } = sourcePairs(machine, vowel);
    const op = [...formantVowelBytes(vowel.front, vowel.open, vowel.round), ...pairs];
    if (gid === null) apply(op); else applyQuiet(op, gid);
    paintSource();
  };
  const chart = vowelChart(
    () => vowel,
    (front, open, gid) => {
      vowel.front = front; vowel.open = open;
      chart.update(front, open, vowel.round);
      paintReadout();
      vowelEdit(gid);
    },
    (m) => {
      vowel.front = m.front; vowel.open = m.open; vowel.round = m.round;
      vowelEdit(null);
    },
    () => view.renderPanel(),
  );
  paintReadout();
  const roundRow = view.sliderRow(t("fmt.round"), f.round, 0, 255, (v, gid) => {
    vowel.round = v;
    chart.update(vowel.front, vowel.open, v);
    paintReadout();
    vowelEdit(gid);
  }, { ann: (v) => (v < 64 ? t("fmt.spread") : v > 191 ? t("fmt.rounded") : t("fmt.halfRounded")) });
  roundRow.title = t("fmt.roundTitle");
  view.group(t("fmt.grpVowel"), chart.node, roundRow, readout);

  // ── Syllable ──
  const best = machine.bestPerConsonant(f.timing);
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
      const top = machine.recipes(id, f.timing)[0] ?? null;
      apply(formantSlotBytes(i, slotFromRecipe(id, top)));
    });
    row.append(el("span", "sl-label", t(labelKey)), consBtn);
    if (r && consonantNeedsNoise(r)) {
      const list = machine.recipes(s.cons, f.timing).slice(0, 16);
      const curIdx = list.findIndex((x) => slotIsRecipe(s, x));
      const opts = list.map((x, k) => [String(k), recipeLabel(x)]);
      const sel = el("select", "sl-pick fmt-recipe");
      if (curIdx < 0) {
        const o = el("option", "", s.len > 0 ? t("fmt.recipeStored") : t("fmt.recipeGeneratorStored"));
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
  // The glide (G) and the r-colouring (R), between the onset and the coda —
  // the syllable is CCGVRC.
  const glideRow = view.selectRow(t("fmt.semivowel"), f.semivowel,
    [[0, "—"], ...SEMIVOWELS.slice(1).map((sv) => [sv.code, sv.ipa])],
    (v) => { if (v !== f.semivowel) apply(formantGrBytes(v, f.rhotic)); });
  glideRow.classList.add("fmt-sv");
  glideRow.title = t("fmt.semivowelTitle");
  const rhoticRow = view.selectRow(t("fmt.rhotic"), f.rhotic ? 1 : 0,
    [[0, t("fmt.rhoticOff")], [1, t("fmt.rhoticOn")]],
    (v) => { if ((v === 1) !== f.rhotic) apply(formantGrBytes(f.semivowel, v === 1)); });
  rhoticRow.title = t("fmt.rhoticTitle");
  view.group(t("fmt.grpSyllable"),
    slotRow(0, "fmt.onset1"), slotRow(1, "fmt.onset2"), glideRow, rhoticRow, slotRow(2, "fmt.coda"),
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
