// Notation Maker (item 61) — create, import and edit CUSTOM notations (the
// "nota" project section, slots 0..15 → sMet notation values 65535..65520).
//
// The major path is Scala .scl import (one file per scale, the last pitch is
// the period), but everything is hand-editable without ever touching a .scl:
// degrees are cents inputs, symbols are tick/letter/accidental pickers over
// the same DSL the shipped presets use, previewed live through the vector
// glyph painter (so what you assign is exactly what the Timeline draws).
// Definitions can be shared between projects as .taudnot files (the spec's
// suggested serialisation).
//
// Edits are local to the dialog until Save, which lands as ONE undoable
// setSectionOp("nota") — display-only, so no device upload happens. The
// "use for this song" checkbox additionally points the song's sMet notation
// at the saved slot (same non-undoable metadata write as changeNotation).
//
// Two kinds of definition (terranmon.txt §nota):
//   interval > 0 — a repeating lattice; degrees are offsets within one period
//     rooted at C4 (ANCHOR_NOTE), and the base-note field must stay 0.
//   interval = 0 — "no interval system": the table lists EVERY note the
//     notation can express, absolutely, offset from the base-note field
//     (0 = default C4). This is how a hardware grid like ProTracker pitch is
//     expressed — its base is 0x3000, two octaves below C4, because the
//     offsets are unsigned. The "No interval" chip switches modes.

import { t } from "../i18n.js";
import { showModal } from "../widgets/modal.js";
import { pickFile, download } from "../../storage/import-export.js";
import { setSectionOp } from "../../doc/ops.js";
import { themeColors } from "../theme.js";
import { canvasFont } from "../fonts.js";
import { paintNoteCell } from "../glyphs.js";
import { ANCHOR_NOTE, presetForNotation, resolveNoteSymbol } from "../../../core/tuning/pitchtables.js";
import {
  NOTA_SLOTS, notationValueForSlot, buildNotaPayload, parseTaudnot, buildTaudnot,
  parseScl, sclToDef, centsToUnits, unitsToCents, autoAssignSyms, defToPreset,
  validateDef, FALLBACK_SYM,
} from "../../doc/notation.js";

const TICKS = [" ", ".", "u", "d", "U", "D"];
const ACCS = ["-", "#", "b", "t", "p", "x", "B", "3", "T", "4"];
const ACC_LABELS = { "-": "♮", "#": "♯", b: "♭", t: "♯̸ demi", p: "ɔ demi", x: "𝄪", B: "♭♭", 3: "♯𝄪", T: "♭♭♭", 4: "𝄪𝄪" };
const TICK_LABELS = { " ": "·", ".": "●", u: "˄", d: "˅", U: "˄˄", D: "˅˅" };
const OCTAVE = 0x1000;
const TRITAVE = 0x195c;
const TETRAVE = 0x2000;
const PENTAVE = 0x2527;
const HEXAVE = 0x295C;
const HEPTAVE = 0x2CEB;
const EIGHTVE = 0x3000;
const NONAVE = 0x32B8;
const DECAVE = 0x3527;

const INTERVAL_OPTIONS = [
[t("nota.octave"), OCTAVE],
[t("nota.tritave"), TRITAVE],
[t("nota.tetrave"), TETRAVE],
[t("nota.pentave"), PENTAVE],
[t("nota.hexave"), HEXAVE],
[t("nota.heptave"), HEPTAVE],
[t("nota.eightve"), EIGHTVE],
// [t("nota.nonave"), NONAVE],
// [t("nota.decave"), DECAVE],
]

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

function deepCopyDef(d) {
  return { slot: d.slot, flags: d.flags ?? 0, interval: d.interval,
           base: d.base ?? 0, name: d.name,
           table: d.table.slice(), syms: d.syms.slice() };
}

/** Note that degree 0 sits on — the declared base for an absolute def, C4
 *  otherwise (mirrors presetBase on the preset side). */
function defBase(def) {
  return (def.interval === 0 && def.base) ? def.base : ANCHOR_NOTE;
}

/** A fresh definition seed: 12 equal divisions of the octave, nearest-named. */
function seedDef(slot) {
  const table = [];
  for (let i = 0; i < 12; i++) table.push(Math.round((i * OCTAVE) / 12));
  const def = { slot, flags: 0, interval: OCTAVE, base: 0, name: "", table, syms: [] };
  def.syms = autoAssignSyms(def, "nearest");
  return def;
}

export function showNotationMaker(store) {
  return new Promise((resolve) => {
    const doc = store.doc;
    // Local working copy — nothing touches the document until Save.
    const defs = doc.customNotations().map(deepCopyDef);
    let sel = defs.length > 0 ? 0 : -1;

    const dlg = document.createElement("dialog");
    dlg.className = "modal nota-modal";
    dlg.innerHTML = `
      <h3>${esc(t("nota.title"))}</h3>
      <p class="dim nota-hint">${esc(t("nota.hint"))}</p>
      <div class="nota-grid">
        <div class="nota-left">
          <div class="nota-slots" data-f="slots"></div>
          <div class="nota-left-btns">
            <button data-f="importScl">${esc(t("nota.importScl"))}</button>
            <button data-f="importNot">${esc(t("nota.importTaudnot"))}</button>
          </div>
        </div>
        <div class="nota-editor" data-f="editor"></div>
      </div>
      <div class="modal-buttons nota-btns">
        <label class="nota-assign"><input type="checkbox" data-f="assign" checked>
          ${esc(t("nota.useForSong"))}</label>
        <span class="nota-issues dim" data-f="issues"></span>
        <button data-f="save">${esc(t("nota.save"))}</button>
        <button data-f="cancel">${esc(t("common.cancel"))}</button>
      </div>`;
    document.body.appendChild(dlg);
    const $ = (name) => dlg.querySelector(`[data-f="${name}"]`);

    const referencedBy = (slot) => {
      const v = notationValueForSlot(slot);
      return Object.entries(doc.meta.songMeta).filter(([, m]) => m.notation === v)
        .map(([k]) => k);
    };
    const firstFreeSlot = () => {
      for (let s = 0; s < NOTA_SLOTS; s++) if (!defs.some((d) => d.slot === s)) return s;
      return -1;
    };

    // ── slot list ──
    function renderSlots() {
      const box = $("slots");
      box.textContent = "";
      for (let s = 0; s < NOTA_SLOTS; s++) {
        const i = defs.findIndex((d) => d.slot === s);
        const row = document.createElement("div");
        row.className = "nota-slot" + (i >= 0 && i === sel ? " sel" : "") + (i < 0 ? " empty" : "");
        const value = notationValueForSlot(s);
        row.innerHTML = `<span class="nota-slot-num">${s}</span>` +
          `<span class="nota-slot-name">${i >= 0 ? esc(defs[i].name || t("nota.unnamed")) : esc(t("nota.emptySlot"))}</span>` +
          `<span class="dim nota-slot-val">${value.toString(16).toUpperCase()}</span>`;
        row.addEventListener("click", () => {
          if (i >= 0) { sel = i; }
          else { defs.push(seedDef(s)); sel = defs.length - 1; }
          renderAll();
        });
        box.appendChild(row);
      }
    }

    // ── glyph preview cell ──
    function previewCanvas(def, idx) {
      const cv = document.createElement("canvas");
      const charW = 9, rowH = 20;
      cv.width = charW * 4 + 4; cv.height = rowH;
      cv.className = "nota-preview";
      const ctx = cv.getContext("2d");
      const C = themeColors();
      ctx.fillStyle = C.cvBg;
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.font = canvasFont(13);
      ctx.textBaseline = "middle";
      const note = Math.min(Math.max(defBase(def) + def.table[idx], 0x20), 0xffff);
      paintNoteCell(ctx, note, defToPreset(def), 2, 0, charW, rowH,
        { note: C.fg, sentinel: C.fg2, dim: C.dim, offGrid: C.accent });
      return cv;
    }

    // ── editor pane ──
    function renderEditor() {
      const ed = $("editor");
      // Every edit re-renders this pane, which used to throw the degrees table
      // back to degree 0 and drop focus mid-work (item 72.2). Capture both and
      // restore after the rebuild — the same trick the Advanced Edit panel uses
      // (item 64). `data-k` gives each control a rebuild-stable identity; only
      // a control still focused INSIDE the pane is restored, so tabbing away or
      // clicking elsewhere is never fought.
      const prevScroll = ed.querySelector(".nota-degrees")?.scrollTop ?? 0;
      const prevFocus = ed.contains(document.activeElement)
        ? document.activeElement.dataset.k ?? null : null;
      // preventScroll: focus() would otherwise scroll the control into view and
      // undo the scroll restore below — the very thing 72.2 is about.
      const restoreFocus = () => {
        if (prevFocus) ed.querySelector(`[data-k="${prevFocus}"]`)?.focus({ preventScroll: true });
      };
      ed.textContent = "";
      if (sel < 0 || !defs[sel]) {
        ed.innerHTML = `<p class="dim nota-empty-hint">${esc(t("nota.pickSlot"))}</p>`;
        return;
      }
      const def = defs[sel];

      const head = document.createElement("div");
      head.className = "nota-ed-head";
      // name
      const nameLb = document.createElement("label");
      nameLb.className = "nota-field";
      nameLb.append(t("nota.name") + " ");
      const nameIn = document.createElement("input");
      nameIn.type = "text";
      nameIn.dataset.k = "name";
      nameIn.value = def.name;
      nameIn.addEventListener("change", () => { def.name = nameIn.value; renderSlots(); });
      nameLb.appendChild(nameIn);
      head.appendChild(nameLb);
      // interval
      const absolute = def.interval === 0;
      const intLb = document.createElement("label");
      intLb.className = "nota-field";
      intLb.append(t("nota.interval") + " ");
      const intIn = document.createElement("input");
      intIn.type = "number";
      intIn.step = "0.01";
      intIn.dataset.k = "interval";
      if (absolute) {
        // No period exists in absolute mode; the field only reads "—".
        intIn.value = "";
        intIn.placeholder = "—";
        intIn.disabled = true;
      } else {
        intIn.value = unitsToCents(def.interval).toFixed(2);
      }
      intIn.addEventListener("change", () => {
        const c = parseFloat(intIn.value);
        if (Number.isFinite(c) && c > 0) def.interval = centsToUnits(c);
        renderAll();
      });
      intLb.appendChild(intIn);
      intLb.append(" " + t("nota.cents") + " ");
      const intHex = document.createElement("span");
      intHex.className = "dim";
      intHex.textContent = `($${def.interval.toString(16).toUpperCase()})`;
      intLb.appendChild(intHex);
      // The 0 chip is absolute mode. Switching away parks the base note in a
      // dialog-local stash (the field must be 0 for an interval system) and
      // switching back restores it, so exploring the chips never loses work.
      for (const [label, units] of [...INTERVAL_OPTIONS, [t("nota.noInterval"), 0]]) {
        const b = document.createElement("button");
        b.textContent = label;
        b.dataset.k = "chip" + units;
        if (units === 0) b.title = t("nota.noIntervalTitle");
        b.className = "nota-chip" + (def.interval === units ? " sel" : "");
        b.addEventListener("click", () => {
          if (units === 0) {
            def.base = def._stashBase ?? def.base ?? 0;
          } else if (def.interval === 0) {
            def._stashBase = def.base;
            def.base = 0;
          }
          def.interval = units;
          renderAll();
        });
        intLb.appendChild(b);
      }
      head.appendChild(intLb);

      // base note — absolute mode only (interval systems root at C4 and the
      // field must stay 0; validateDef enforces it)
      if (absolute) {
        const baseLb = document.createElement("label");
        baseLb.className = "nota-field";
        baseLb.title = t("nota.baseNoteTitle");
        baseLb.append(t("nota.baseNote") + " ");
        const baseIn = document.createElement("input");
        baseIn.type = "text";
        baseIn.size = 6;
        baseIn.dataset.k = "base";
        const eff = defBase(def);
        baseIn.value = "$" + eff.toString(16).toUpperCase().padStart(4, "0");
        baseIn.addEventListener("change", () => {
          const v = parseInt(baseIn.value.replace(/^\$/, ""), 16);
          if (Number.isFinite(v) && v >= 0 && v <= 0xffff) {
            // C4 is what an empty field means — store the canonical 0 so an
            // untouched def stays byte-identical on disk.
            def.base = v === ANCHOR_NOTE ? 0 : v;
          }
          renderAll();
        });
        baseLb.appendChild(baseIn);
        const baseAnn = document.createElement("span");
        baseAnn.className = "dim";
        const r = resolveNoteSymbol(eff, presetForNotation(120));
        baseAnn.textContent = r
          ? ` ${r.offGrid ? "≈ " : ""}${r.letter}${r.acc === "-" ? "" : r.acc}${r.octave}`
          : "";
        baseLb.appendChild(baseAnn);
        head.appendChild(baseLb);
      }
      // tool row
      const tools = document.createElement("div");
      tools.className = "nota-tools";
      const mkBtn = (label, title, fn, key) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.dataset.k = key;
        if (title) b.title = title;
        b.addEventListener("click", fn);
        tools.appendChild(b);
      };
      mkBtn(t("nota.equalDiv"), t("nota.equalDivTitle"), async () => {
        if (absolute) {
          // No interval to divide — the generalisation is N equal steps per
          // OCTAVE listed across M octaves (count = N·M absolute degrees).
          const spanNow = Math.max(1,
            Math.round((def.table[def.table.length - 1] || OCTAVE) / OCTAVE));
          const r = await showModal({
            title: t("nota.equalDiv"),
            fields: [
              { name: "n", label: t("nota.equalDivPerOct"), type: "number",
                value: "12", min: 1, max: 4096 },
              { name: "m", label: t("nota.equalDivSpan"), type: "number",
                value: String(Math.min(spanNow, 15)), min: 1, max: 15 },
            ],
          });
          const n = parseInt(r?.n, 10), m = parseInt(r?.m, 10);
          if (!Number.isFinite(n) || n < 1 || n > 4096) return;
          if (!Number.isFinite(m) || m < 1 || m > 15) return;
          const count = Math.min(n * m, 4096);
          def.table = [];
          for (let i = 0; i < count; i++) def.table.push(Math.round((i * OCTAVE) / n));
          def.syms = autoAssignSyms(def, "nearest");
          renderAll();
          return;
        }
        const r = await showModal({
          title: t("nota.equalDiv"),
          fields: [{ name: "n", label: t("nota.equalDivN"), type: "number",
                     value: String(def.table.length), min: 1, max: 4096 }],
        });
        const n = parseInt(r?.n, 10);
        if (!Number.isFinite(n) || n < 1 || n > 4096) return;
        def.table = [];
        for (let i = 0; i < n; i++) def.table.push(Math.round((i * def.interval) / n));
        def.syms = autoAssignSyms(def, "nearest");
        renderAll();
      }, "equalDiv");
      mkBtn(t("nota.autoNearest"), t("nota.autoNearestTitle"), () => {
        def.syms = autoAssignSyms(def, "nearest");
        renderAll();
      }, "autoNearest");
      mkBtn(t("nota.autoSeq"), t("nota.autoSeqTitle"), () => {
        def.syms = autoAssignSyms(def, "sequence");
        renderAll();
      }, "autoSeq");
      mkBtn(t("nota.duplicate"), null, () => {
        const s = firstFreeSlot();
        if (s < 0) { alert(t("nota.noFreeSlot")); return; }
        const copy = deepCopyDef(def);
        copy.slot = s;
        defs.push(copy);
        sel = defs.length - 1;
        renderAll();
      }, "duplicate");
      mkBtn(t("nota.exportTaudnot"), null, () => {
        download(buildTaudnot([def]), (def.name.trim() || `custom-${def.slot}`) + ".taudnot");
      }, "exportTaudnot");
      mkBtn(t("nota.delete"), null, () => {
        const refs = referencedBy(def.slot);
        if (refs.length > 0 && !confirm(t("nota.deleteRefWarn", { songs: refs.join(", ") }))) return;
        defs.splice(sel, 1);
        sel = defs.length > 0 ? 0 : -1;
        renderAll();
      }, "delete");
      head.appendChild(tools);
      ed.appendChild(head);

      // degrees table
      const wrap = document.createElement("div");
      wrap.className = "nota-degrees";
      const tbl = document.createElement("table");
      tbl.innerHTML = `<thead><tr><th>#</th><th>${esc(t("nota.colCents"))}</th>` +
        `<th>${esc(t("nota.colUnits"))}</th><th>${esc(t("nota.colTick"))}</th>` +
        `<th>${esc(t("nota.colLetter"))}</th><th>${esc(t("nota.colAcc"))}</th>` +
        `<th>${esc(t("nota.colPreview"))}</th><th></th></tr></thead>`;
      const tbody = document.createElement("tbody");
      def.table.forEach((units, i) => {
        const tr = document.createElement("tr");
        const tok = def.syms[i] ?? FALLBACK_SYM;
        // degree number — plain decimal (item 72.3): this is a table index the
        // user counts with, not a timeline degree label (those stay base-36).
        const tdN = document.createElement("td");
        tdN.className = "dim";
        tdN.textContent = String(i);
        tr.appendChild(tdN);
        // cents
        const tdC = document.createElement("td");
        const cIn = document.createElement("input");
        cIn.type = "number";
        cIn.step = "0.01";
        cIn.dataset.k = "cents" + i;
        cIn.value = unitsToCents(units).toFixed(2);
        cIn.disabled = i === 0; // spec: index 0 is always 0
        cIn.addEventListener("change", () => {
          const c = parseFloat(cIn.value);
          if (Number.isFinite(c)) def.table[i] = centsToUnits(c);
          renderAll();
        });
        tdC.appendChild(cIn);
        tr.appendChild(tdC);
        // 4096-TET units
        const tdU = document.createElement("td");
        tdU.className = "dim";
        tdU.textContent = "$" + units.toString(16).toUpperCase().padStart(3, "0");
        tr.appendChild(tdU);
        // symbol pickers — a decoded 3-char DSL token, or a raw single char
        // (imported CJK / escape) shown read-only until a picker replaces it.
        const isDsl = tok.length === 3;
        const mkSel = (opts, labels, cur, apply, key) => {
          const td = document.createElement("td");
          const s = document.createElement("select");
          s.dataset.k = key + i;
          for (const o of opts) {
            const el = document.createElement("option");
            el.value = o;
            el.textContent = labels ? labels[o] : o;
            s.appendChild(el);
          }
          if (!isDsl) {
            const el = document.createElement("option");
            el.value = "\x00raw";
            el.textContent = tok;
            s.appendChild(el);
            s.value = "\x00raw";
          } else s.value = cur;
          s.addEventListener("change", () => { apply(s.value); renderAll(); });
          td.appendChild(s);
          return td;
        };
        const parts = isDsl ? [tok[0], tok[1], tok[2]] : [" ", "C", "-"];
        const setPart = (idx) => (v) => {
          if (v === "\x00raw") return;
          const p = def.syms[i]?.length === 3 ? [...def.syms[i]] : [...parts];
          p[idx] = v;
          def.syms[i] = p.join("");
        };
        tr.appendChild(mkSel(TICKS, TICK_LABELS, parts[0], setPart(0), "tick"));
        tr.appendChild(mkSel([..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"], null, parts[1], setPart(1), "letter"));
        tr.appendChild(mkSel(ACCS, ACC_LABELS, parts[2], setPart(2), "acc"));
        // live glyph preview
        const tdP = document.createElement("td");
        tdP.appendChild(previewCanvas(def, i));
        tr.appendChild(tdP);
        // remove
        const tdX = document.createElement("td");
        if (i > 0) {
          const x = document.createElement("button");
          x.textContent = "×";
          x.dataset.k = "del" + i;
          x.title = t("nota.removeDegree");
          x.addEventListener("click", () => {
            def.table.splice(i, 1);
            def.syms.splice(i, 1);
            renderAll();
          });
          tdX.appendChild(x);
        }
        tr.appendChild(tdX);
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      wrap.appendChild(tbl);
      ed.appendChild(wrap);

      const add = document.createElement("button");
      add.textContent = t("nota.addDegree");
      add.dataset.k = "add";
      add.className = "nota-add";
      add.addEventListener("click", () => {
        const last = def.table[def.table.length - 1] ?? 0;
        let units;
        if (absolute) {
          // The interval-mode midpoint rule below would HALVE the last degree
          // at interval 0 (non-ascending). Extend upward instead, repeating
          // the last gap — a semitone when there's no gap to repeat yet.
          const prev = def.table[def.table.length - 2];
          units = Math.min(last + (prev != null ? last - prev : 0x155), 0xffff);
        } else {
          // Midpoint between the last degree and the period top.
          units = Math.min(Math.round((last + def.interval) / 2), 0xffff);
        }
        def.table.push(units);
        const named = autoAssignSyms({ table: [units], interval: def.interval }, "nearest");
        def.syms.push(named[0]);
        renderAll();
      });
      ed.appendChild(add);

      // item 72.2 — put the user back where they were (scrollTop self-clamps if
      // the table shrank, so a removed degree can't strand the view).
      wrap.scrollTop = prevScroll;
      restoreFocus();
    }

    function renderIssues() {
      const bad = [];
      for (const d of defs) {
        for (const code of validateDef(d)) {
          bad.push(t("nota.issue." + code, { slot: d.slot }));
        }
      }
      $("issues").textContent = bad.join(" · ");
      $("save").disabled = bad.length > 0;
      return bad.length === 0;
    }

    function renderAll() { renderSlots(); renderEditor(); renderIssues(); }

    // ── imports ──
    $("importScl").addEventListener("click", async () => {
      const file = await pickFile(".scl");
      if (!file) return;
      let def;
      try {
        def = sclToDef(parseScl(await file.text()), 0);
      } catch (e) {
        alert(t("nota.sclError", { msg: e.message }));
        return;
      }
      const s = firstFreeSlot();
      if (s < 0) { alert(t("nota.noFreeSlot")); return; }
      def.slot = s;
      if (!def.name) def.name = file.name.replace(/\.scl$/i, "");
      defs.push(def);
      sel = defs.length - 1;
      renderAll();
    });
    $("importNot").addEventListener("click", async () => {
      const file = await pickFile(".taudnot");
      if (!file) return;
      const list = parseTaudnot(new Uint8Array(await file.arrayBuffer()));
      if (!list || list.length === 0) { alert(t("nota.taudnotError")); return; }
      for (const d of list) {
        // keep the stored slot when free, else relocate
        let s = defs.some((x) => x.slot === d.slot) ? firstFreeSlot() : d.slot;
        if (s < 0) { alert(t("nota.noFreeSlot")); break; }
        d.slot = s;
        defs.push(d);
        sel = defs.length - 1;
      }
      renderAll();
    });

    // ── save / close ──
    const finish = () => { dlg.close(); dlg.remove(); resolve(); };
    $("cancel").addEventListener("click", finish);
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); });
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    $("save").addEventListener("click", () => {
      if (!renderIssues()) return;
      const payload = defs.length > 0 ? buildNotaPayload(defs) : null;
      const cur = doc.projSections.find((s) => s.fourcc === "nota")?.payload ?? null;
      const same = payload !== null && cur !== null && payload.length === cur.length &&
        payload.every((b, i) => b === cur[i]);
      if (!same && !(payload === null && cur === null)) {
        store.undo.apply(setSectionOp("nota", payload));
      }
      if ($("assign").checked && sel >= 0 && defs[sel]) {
        const value = notationValueForSlot(defs[sel].slot);
        const sm = doc.meta.songMeta[store.songIndex] ??
          (doc.meta.songMeta[store.songIndex] =
            { notation: 120, beatPri: 4, beatSec: 16, name: "", composer: "", copyright: "" });
        sm.notation = value;
        doc.smetEdited = true;
        doc.dirty = true;
        store.pitchPreset = presetForNotation(value, doc);
      }
      store.emit("doc"); // repaint glyphs with the (possibly) new table
      finish();
    });

    dlg.showModal();
    renderAll();
  });
}
