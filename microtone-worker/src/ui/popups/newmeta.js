// New-metainstrument popup (item 72) and the Layers tab's "Add layers…" (item
// 113) — one picker over the project's ordinary instruments, with a COUNT per
// row rather than a checkbox. The "Meta…" toolbox button enters through
// showNewMetaKind, which asks layered-or-FM first (item 167).
//
// The count is the whole point. Picking one instrument three times is how a
// unison/chord stack is built ("a chorded piano out of one piano"): the source
// is copied ONCE into a $100+ sub-slot and three LINKED layers point at that
// copy, so retuning or refiltering the piano moves all three of its voices
// together. Splitting one voice off later is the Layers tab's Unlink.
//
// Metainstruments are not offered: the engine resolves layers with triggerNote,
// which never re-enters the meta branch, so metas can't nest.

import { planCreateMeta, planCreateFm, planAddMetaLayers } from "../../doc/bankmerge.js";
import { importBankOp } from "../../doc/ops.js";
import { META_MAX_LAYERS, metaLayers } from "../../doc/metaedit.js";
import { FM_MAX_OPERATORS, fmProgramOf, fmBudget, fmCanAddOperator } from "../../doc/fmedit.js";
import { escapeNonAscii, unescapeName } from "../../../core/format/names.js";
import { t } from "../i18n.js";

const hex3 = (n) => "$" + n.toString(16).toUpperCase().padStart(3, "0");

function el(tag, cls, text) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * The shared instrument list. Each row carries a −/+ stepper; 0 means "not
 * picked" and the row dims. Returns {list, picks(), total(), onChange, setAll}.
 * `budget` is how many layers the target can still take.
 */
function buildPicker(doc, candidates, budget, onTally, cap = META_MAX_LAYERS) {
  const list = el("div", "import-list meta-picker");
  const rows = [];

  const total = () => rows.reduce((n, r) => n + r.count, 0);
  const sync = () => {
    for (const r of rows) {
      r.node.classList.toggle("picked", r.count > 0);
      r.readout.textContent = r.count > 0 ? `×${r.count}` : "—";
      r.minus.disabled = r.count === 0;
      r.plus.disabled = total() >= budget;
    }
    onTally(total());
  };

  for (const slot of candidates) {
    const row = el("div", "import-row meta-pick-row");
    row.dataset.slot = slot;
    const inst = doc.instruments[slot];
    const badge = inst.extraPatches ? `IXMP·${inst.extraPatches.length}` : "";

    const rec = { count: 0, slot, node: row };
    const minus = el("button", "meta-step", "−");
    const readout = el("span", "meta-count", "—");
    const plus = el("button", "meta-step", "+");
    minus.type = "button"; plus.type = "button";
    rec.minus = minus; rec.plus = plus; rec.readout = readout;

    const bump = (d) => {
      const next = rec.count + d;
      if (next < 0 || next > cap) return;
      if (d > 0 && total() >= budget) return;
      rec.count = next;
      sync();
    };
    minus.addEventListener("click", (e) => { e.preventDefault(); bump(-1); });
    plus.addEventListener("click", (e) => { e.preventDefault(); bump(+1); });

    // Clicking the row itself is the common case: on, or back off.
    const name = el("span", "name", unescapeName(doc.instrumentName(slot)) || t("inst.unnamed"));
    const hit = el("button", "meta-pick-hit");
    hit.type = "button";
    hit.append(el("span", "idx", hex3(slot)), name, el("span", "badge-sm", badge));
    hit.addEventListener("click", (e) => {
      e.preventDefault();
      if (rec.count > 0) rec.count = 0;
      else if (total() < budget) rec.count = 1;
      sync();
    });

    row.append(minus, readout, plus, hit);
    list.appendChild(row);
    rows.push(rec);
  }

  return {
    list,
    total,
    picks: () => rows.filter((r) => r.count > 0).map((r) => ({ slot: r.slot, count: r.count })),
    setAll: (n) => {
      let left = budget;
      for (const r of rows) { r.count = Math.min(n, left); left -= r.count; }
      sync();
    },
    sync,
  };
}

/** "n of 25 layers · up to n voices per note" — the layer table's capacity and
 *  what the stack will cost in polyphony, which is the surprise otherwise. */
function tallyText(total, existing) {
  const n = total + existing;
  return `${t("meta.tally", { n, max: META_MAX_LAYERS })} · ${t("meta.voiceCost", { n })}`;
}

/** The rack's own tally. A rack costs ONE voice however many operators it has
 *  — that is the whole point of it — so what is worth showing instead is the
 *  record space the operators are eating (item 159.1). */
function fmTallyText(total, existing, words) {
  const n = total + existing;
  const b = fmBudget(n, words);
  return `${t("fm.tally", { n, max: FM_MAX_OPERATORS })} · ` +
    `${t("fm.bytes", { used: b.used, total: b.total })}`;
}

/**
 * Shared modal shell. `commit(picks, name)` returns a plan; the caller applies
 * it. Resolves whatever `done(plan)` returns, or null on cancel.
 */
function pickerModal(store, {
  title, hint, candidates, existing, withName, okLabel, commit, done,
  cap = META_MAX_LAYERS, tally: tallyFn = tallyText,
}) {
  const doc = store.doc;
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "modal import-modal";
    const parts = [el("h3", "", title), el("p", "dim", hint)];

    let nameIn = null;
    if (withName) {
      const nameRow = el("div", "import-bar");
      nameIn = document.createElement("input");
      nameIn.type = "text";
      nameIn.className = "import-filter";
      nameIn.placeholder = t("newmeta.namePlaceholder");
      nameRow.append(el("span", "", t("newmeta.name")), nameIn);
      parts.push(nameRow);
    }

    const bar = el("div", "import-bar");
    const allBtn = el("button", "", t("common.all"));
    const noneBtn = el("button", "", t("common.none"));
    const tally = el("span", "import-tally", "");
    bar.append(allBtn, noneBtn, tally);
    parts.push(bar);

    const errEl = el("p", "import-error", "");
    errEl.hidden = true;
    const btnRow = el("div", "modal-buttons");
    const okBtn = el("button", "", okLabel);
    const cancelBtn = el("button", "", t("common.cancel"));
    btnRow.append(okBtn, cancelBtn);

    const budget = cap - existing;
    const picker = buildPicker(doc, candidates, budget, (total) => {
      tally.textContent = tallyFn(total, existing);
      okBtn.disabled = total === 0;
    }, cap);
    parts.splice(parts.length, 0, picker.list, errEl, btnRow);

    dlg.append(...parts);
    document.body.appendChild(dlg);
    picker.sync();

    allBtn.addEventListener("click", (e) => { e.preventDefault(); picker.setAll(1); });
    noneBtn.addEventListener("click", (e) => { e.preventDefault(); picker.setAll(0); });

    const finish = (result) => { dlg.close(); dlg.remove(); resolve(result); };
    cancelBtn.addEventListener("click", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("cancel", () => finish(null));
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    okBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const plan = commit(picker.picks(), nameIn ? escapeNonAscii(nameIn.value.trim()) : "");
      if (plan.error) {
        errEl.textContent = plan.error;
        errEl.hidden = false;
        return;
      }
      store.undo.apply(importBankOp(plan));
      finish(done(plan));
    });
    dlg.showModal();
    (nameIn ?? okBtn).focus();
  });
}

/** Ordinary (layerable) instruments — everything but the metas. */
function layerCandidates(doc) {
  return doc.selectableInstrumentSlots().filter((s) => !doc.instruments[s].isMeta);
}

const SVG_NS = "http://www.w3.org/2000/svg";

const svgEl = (name, attrs) => {
  const n = document.createElementNS(SVG_NS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};

/** The two kinds, drawn rather than described: three children into a summing
 *  bus, versus three children in a chain where only the last one is heard.
 *  Boxes carry no text — the caption below the picture does the naming, and a
 *  label inside would need translating and would not fit. */
function kindDiagram(kind) {
  const W = 168, H = 72;
  const svg = svgEl("svg", {
    width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "kind-diagram", role: "img",
  });
  const box = (x, y) => svgEl("rect", {
    x, y, width: 30, height: 16, rx: 3,
    fill: "none", stroke: "currentColor", "stroke-width": 1.4,
  });
  const line = (x1, y1, x2, y2, dash) => svgEl("path", {
    d: `M ${x1} ${y1} L ${x2} ${y2}`, fill: "none", stroke: "currentColor",
    "stroke-width": 1.2, ...(dash ? { "stroke-dasharray": "3 2.5", opacity: 0.75 } : {}),
  });
  // The output: a speaker cone, so "this is what reaches the mixer" needs no word.
  const out = (x, y) => svgEl("path", {
    d: `M ${x} ${y - 4} l 5 -5 v 18 l -5 -5 z M ${x + 8} ${y - 4} q 3 4 0 8`,
    fill: "none", stroke: "currentColor", "stroke-width": 1.3, "stroke-linejoin": "round",
  });
  const head = (x, y) => svgEl("path", {
    d: `M ${x - 5} ${y - 3} L ${x} ${y} L ${x - 5} ${y + 3}`,
    fill: "none", stroke: "currentColor", "stroke-width": 1.2, "stroke-linejoin": "round",
  });

  if (kind === "meta") {
    // Three parallel children onto one bus, then one arrow out: everything is
    // heard, and the mixer adds them up.
    const ys = [12, 30, 48];
    for (const y of ys) {
      svg.append(box(10, y), line(40, y + 8, 96, y + 8), head(96, y + 8));
    }
    svg.append(
      line(96, 20, 96, 56),
      line(96, 38, 122, 38), head(122, 38),
      out(128, 38),
    );
    const plus = svgEl("text", {
      x: 104, y: 38, "text-anchor": "middle", "dominant-baseline": "central",
      "font-size": 13, fill: "currentColor", opacity: 0.8,
    });
    plus.textContent = "+";
    svg.appendChild(plus);
  } else {
    // A chain: each child bends the next (dashed = modulation, not audio), and
    // only the last box has a solid line to the speaker.
    const xs = [8, 50, 92];
    for (let i = 0; i < xs.length; i++) svg.appendChild(box(xs[i], 28));
    for (let i = 0; i < xs.length - 1; i++) {
      svg.append(line(xs[i] + 30, 36, xs[i + 1] - 4, 36, true), head(xs[i + 1] - 2, 36));
    }
    svg.append(line(122, 36, 134, 36), head(134, 36), out(138, 36));
  }
  return svg;
}

/**
 * The "Meta…" button's first step. A layered metainstrument and an FM rack are
 * built from the same picker out of the same candidates, but they are not the
 * same thing at all — one SUMS its children, the other MODULATES with them —
 * so the choice comes first, with enough prose to make it without guessing.
 *
 * Resolves whatever the chosen picker resolves, or null if either step is
 * cancelled.
 */
export async function showNewMetaKind(store) {
  if (!store.doc) return null;
  // Both kinds draw on the same candidates, so the empty case is answered
  // BEFORE the chooser rather than after it: picking a kind and only then being
  // told there is nothing to build with is a wasted decision.
  if (layerCandidates(store.doc).length === 0) {
    alert(t("newkind.noCandidates"));
    return null;
  }
  const kind = await pickMetaKind();
  if (kind === "meta") return showNewMeta(store);
  if (kind === "fm") return showNewFm(store);
  return null;
}

/** Resolves "meta", "fm", or null on cancel. */
function pickMetaKind() {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "modal kind-modal";
    const cards = el("div", "kind-cards");
    const finish = (kind) => { dlg.close(); dlg.remove(); resolve(kind); };

    for (const kind of ["meta", "fm"]) {
      const card = el("button", "kind-card");
      card.type = "button";
      card.append(
        kindDiagram(kind),
        el("span", "kind-card-name", t(`newkind.${kind}`)),
        el("span", "kind-card-sub", t(`newkind.${kind}Sub`)),
        el("p", "kind-card-body", t(`newkind.${kind}Body`)),
      );
      card.addEventListener("click", (e) => { e.preventDefault(); finish(kind); });
      cards.appendChild(card);
    }

    const btnRow = el("div", "modal-buttons");
    const cancelBtn = el("button", "", t("common.cancel"));
    btnRow.appendChild(cancelBtn);
    cancelBtn.addEventListener("click", (e) => { e.preventDefault(); finish(null); });

    dlg.append(el("h3", "", t("newkind.title")), el("p", "dim", t("newkind.hint")), cards, btnRow);
    document.body.appendChild(dlg);
    dlg.addEventListener("cancel", () => finish(null));
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    dlg.showModal();
    cards.firstChild.focus();
  });
}

/**
 * Resolves {firstSlot, count} after the metainstrument is created (firstSlot =
 * the new meta, so the caller can adopt and show it), or null when cancelled.
 */
export function showNewMeta(store) {
  const doc = store.doc;
  if (!doc) return Promise.resolve(null);
  const candidates = layerCandidates(doc);
  if (candidates.length === 0) {
    alert(t("newmeta.noCandidates"));
    return Promise.resolve(null);
  }
  return pickerModal(store, {
    title: t("newmeta.title"),
    hint: t("newmeta.hint"),
    candidates,
    existing: 0,
    withName: true,
    okLabel: t("newmeta.create"),
    commit: (picks, name) => planCreateMeta(store.doc, picks, name),
    done: (plan) => ({ firstSlot: plan.metaSlot, count: plan.childSlots.length }),
  });
}

/**
 * Add layers to the metainstrument in `metaSlot` (Layers tab). Resolves the
 * number of layers added, or null on cancel.
 */
export function showAddMetaLayers(store, metaSlot) {
  const doc = store.doc;
  const meta = doc?.instruments[metaSlot & 0x3ff];
  if (!meta?.isMeta) return Promise.resolve(null);
  const existing = metaLayers(meta).length;
  if (existing >= META_MAX_LAYERS) {
    alert(t("meta.fullTable", { max: META_MAX_LAYERS }));
    return Promise.resolve(null);
  }
  const candidates = layerCandidates(doc);
  if (candidates.length === 0) {
    alert(t("newmeta.noCandidates"));
    return Promise.resolve(null);
  }
  return pickerModal(store, {
    title: t("meta.addTitle"),
    hint: t("meta.addHint"),
    candidates,
    existing,
    withName: false,
    okLabel: t("meta.addLayers"),
    commit: (picks) => planAddMetaLayers(store.doc, metaSlot, picks),
    done: (plan) => plan.addedLayers,
  });
}

/**
 * New type-4 FM rack (item 159). Same picker as showNewMeta — an operator is an
 * ordinary instrument — but the order is load-bearing here in a way it is not
 * for layers: the FIRST operator picked becomes operator 0, the principal whose
 * envelope is the note's own.
 *
 * Resolves {firstSlot, count} after the rack is created, or null on cancel.
 */
export function showNewFm(store) {
  const doc = store.doc;
  if (!doc) return Promise.resolve(null);
  const candidates = layerCandidates(doc);
  if (candidates.length === 0) {
    alert(t("newfm.noCandidates"));
    return Promise.resolve(null);
  }
  return pickerModal(store, {
    title: t("newfm.title"),
    hint: t("newfm.hint"),
    candidates,
    existing: 0,
    withName: true,
    okLabel: t("newmeta.create"),
    cap: FM_MAX_OPERATORS,
    tally: (total, existing) => fmTallyText(total, existing, total + existing),
    commit: (picks, name) => planCreateFm(store.doc, picks, name),
    done: (plan) => ({ firstSlot: plan.metaSlot, count: plan.childSlots.length }),
  });
}

/**
 * Add operators to the rack in `metaSlot` (FM tab). Resolves the number added,
 * or null on cancel. New operators land after the ones already there and are
 * NOT wired into the algorithm — the FM tab's word list is where that happens,
 * and doing it silently would rewrite a patch the user did not ask to change.
 */
export function showAddFmOperators(store, metaSlot) {
  const doc = store.doc;
  const meta = doc?.instruments[metaSlot & 0x3ff];
  if (!meta?.isFm) return Promise.resolve(null);
  const existing = metaLayers(meta).length;
  const words = fmProgramOf(meta).length;
  if (!fmCanAddOperator(new Array(existing), new Array(words))) {
    alert(t("fm.fullRack", { max: FM_MAX_OPERATORS }));
    return Promise.resolve(null);
  }
  const candidates = layerCandidates(doc);
  if (candidates.length === 0) {
    alert(t("newfm.noCandidates"));
    return Promise.resolve(null);
  }
  return pickerModal(store, {
    title: t("fm.addTitle"),
    hint: t("fm.addHint"),
    candidates,
    existing,
    withName: false,
    okLabel: t("fm.addOps"),
    cap: FM_MAX_OPERATORS,
    tally: (total, ex) => fmTallyText(total, ex, words),
    commit: (picks) => planAddMetaLayers(store.doc, metaSlot, picks),
    done: (plan) => plan.addedLayers,
  });
}
