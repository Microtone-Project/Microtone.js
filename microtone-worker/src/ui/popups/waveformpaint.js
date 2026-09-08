// Paint a waveform by hand with the mouse (item 53). Two entry points share the
// canvas/paint/seed core:
//   paintNewSample  — CREATE a fresh sample+instrument (Instruments view), landed
//     through planSampleImport + importBankOp (undo/sync for free). A length
//     field + seed shapes; the whole sample loops so a single cycle sustains.
//   paintEditSample — EDIT the selected pooled sample in place (Samples view,
//     next to Edit…): the canvas is primed with the sample's bytes, its length is
//     fixed, and OK rewrites the pool span via setSampleBytesOp (every instrument
//     using the sample hears it). A confirm warns when the sample is long
//     (> PAINT_WARN_LEN), since hand-painting is meant for short waveforms.
// A STEREO sample (item 90) paints as one lane per channel: the pointer edits
// the lane it is in, so the pair keeps its image instead of being flattened.
// The shape buttons seed EVERY lane — a seed is a whole-waveform shape.

import { planSampleImport } from "../../doc/bankmerge.js";
import { importBankOp, setSampleBytesOp, multiSampleBytesOp } from "../../doc/ops.js";
import { sampleSpans } from "../../doc/document.js";
import { escapeNonAscii } from "../names.js";
import { t } from "../i18n.js";

const MIN_LEN = 2, MAX_LEN = 0xffff, DEF_LEN = 256, RATE = 32000;
const LANE_H = 200;   // canvas height PER CHANNEL
export const PAINT_WARN_LEN = 1024;

/** CREATE a new sample+instrument by painting. Resolves {firstSlot, count} | null. */
export function paintNewSample(store) {
  if (!store.doc) return Promise.resolve(null);
  return openPaintModal({
    store,
    title: t("wave.title"),
    length: DEF_LEN,
    fixedLength: false,
    okLabel: t("common.create"),
    showName: true,
    commit: (bufs, name) => {
      const nameBytes = new TextEncoder().encode(escapeNonAscii(name || t("wave.defaultName")));
      const plan = planSampleImport(store.doc, { nameBytes, pcm: bufs[0], rate: RATE, loop: true });
      if (plan.error) { alert(plan.error); return undefined; }
      store.undo.apply(importBankOp(plan));
      return { firstSlot: plan.insts[0].destSlot, count: 1 };
    },
  });
}

/** EDIT the pooled sample `sample` (a doc.sampleList() entry) by painting over
 *  its current bytes. Resolves true on apply, else null. A stereo sample opens
 *  with one lane per channel and commits both in a single undo step. */
export function paintEditSample(store, sample) {
  if (!store.doc || !sample) return Promise.resolve(null);
  if (sample.len > PAINT_WARN_LEN &&
      !confirm(t("wave.longWarn", { len: sample.len, limit: PAINT_WARN_LEN }))) {
    return Promise.resolve(null);
  }
  const spans = sampleSpans(sample);
  const initial = spans.map((sp) =>
    Uint8Array.from(store.doc.sampleBin.subarray(sp.ptr, sp.ptr + sp.len)));
  return openPaintModal({
    store,
    title: t("wave.editTitle", { name: sample.name || `#${sample.index}`, len: sample.len }),
    length: sample.len,
    fixedLength: true,
    initial,
    okLabel: t("common.apply"),
    showName: false,
    commit: (bufs) => {
      store.undo.apply(bufs.length === 1
        ? setSampleBytesOp(sample.ptr, bufs[0])
        : multiSampleBytesOp(spans.map((sp, i) => ({ ptr: sp.ptr, bytes: bufs[i] }))));
      return true;
    },
  });
}

// ── shared modal ──
function openPaintModal(opts) {
  return new Promise((resolve) => {
    let length = opts.length;
    // One buffer per channel; `opts.initial` may be a single buffer or a list.
    let bufs = opts.initial
      ? (Array.isArray(opts.initial) ? opts.initial : [opts.initial]).map((b) => Uint8Array.from(b))
      : [new Uint8Array(length).fill(128)];

    let cssMaxW1 = ((window.innerWidth * 94) / 100)|0 // 94 vw
    let cssMaxW2 = 1280 // 1280 px
    let cssMaxW = Math.min(cssMaxW1, cssMaxW2)

    const dlg = document.createElement("dialog");
    dlg.className = "modal wavepaint-modal";
    const lenRow = opts.fixedLength
      ? `<span class="wave-len-fixed">${esc(t("wave.length"))}: ${length}</span>`
      : `<label>${esc(t("wave.length"))} <input type="number" class="wave-len" min="${MIN_LEN}" max="${MAX_LEN}" value="${length}"></label>`;
    dlg.innerHTML = `
      <h3>${esc(opts.title)}</h3>
      <div class="wave-row">
        ${lenRow}
        <span class="wave-shapes">
          <button data-shape="sine">${esc(t("wave.sine"))}</button>
          <button data-shape="saw">${esc(t("wave.saw"))}</button>
          <button data-shape="square">${esc(t("wave.square"))}</button>
          <button data-shape="triangle">${esc(t("wave.triangle"))}</button>
          <button data-shape="noise">${esc(t("wave.noise"))}</button>
          <button data-shape="flat">${esc(t("wave.clear"))}</button>
        </span>
      </div>
      <div class="wave-row">
        <span class="wave-opl-label dim">${esc(t("wave.oplLabel"))}</span>
        <span class="wave-shapes">
          <button data-shape="opl0" title="${esc(t("wave.opl0Title"))}">${esc(t("wave.opl0"))}</button>
          <button data-shape="opl1" title="${esc(t("wave.opl1Title"))}">${esc(t("wave.opl1"))}</button>
          <button data-shape="opl2" title="${esc(t("wave.opl2Title"))}">${esc(t("wave.opl2"))}</button>
          <button data-shape="opl3" title="${esc(t("wave.opl3Title"))}">${esc(t("wave.opl3"))}</button>
          <button data-shape="opl4" title="${esc(t("wave.opl4Title"))}">${esc(t("wave.opl4"))}</button>
          <button data-shape="opl5" title="${esc(t("wave.opl5Title"))}">${esc(t("wave.opl5"))}</button>
          <button data-shape="opl6" title="${esc(t("wave.opl6Title"))}">${esc(t("wave.opl6"))}</button>
          <button data-shape="opl7" title="${esc(t("wave.opl7Title"))}">${esc(t("wave.opl7"))}</button>
        </span>
      </div>
      <canvas class="wave-paint" width="${cssMaxW - 48}" height="${LANE_H * bufs.length}"></canvas>
      <p class="wave-hint">${esc(t("wave.hint"))}${bufs.length > 1 ? " · " + esc(t("wave.stereoHint")) : ""}</p>
      ${opts.showName ? `<div class="wave-row"><label>${esc(t("wave.name"))} <input type="text" class="wave-name" value="${esc(t("wave.defaultName"))}"></label></div>` : ""}
      <div class="modal-buttons">
        <button class="wave-cancel">${esc(t("common.cancel"))}</button>
        <button class="wave-ok">${esc(opts.okLabel)}</button>
      </div>`;
    document.body.appendChild(dlg);

    const canvas = dlg.querySelector(".wave-paint");
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const lenInput = dlg.querySelector(".wave-len");
    const nameInput = dlg.querySelector(".wave-name");

    const xToIdx = (x) => Math.min(length - 1, Math.max(0, Math.round((x / W) * (length - 1))));
    // Which lane a y coordinate belongs to, and the value it means inside it.
    const laneH = () => H / bufs.length;
    const yToLane = (y) => Math.min(bufs.length - 1, Math.max(0, Math.floor(y / laneH())));
    const yToVal = (y) => {
      const h = laneH();
      const inLane = y - yToLane(y) * h;
      return Math.min(255, Math.max(0, Math.round((1 - inLane / h) * 255)));
    };

    function draw() {
      const cs = getComputedStyle(document.documentElement);
      const bg = cs.getPropertyValue("--cv-bg").trim() || "#111";
      const fg = cs.getPropertyValue("--accent").trim() || "#4af";
      const grid = cs.getPropertyValue("--dim").trim() || "#666";
      const dim = cs.getPropertyValue("--fg").trim() || "#ccc";
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
      const h = laneH();
      bufs.forEach((b, li) => {
        const top = li * h;
        ctx.strokeStyle = grid; ctx.globalAlpha = 0.4;
        ctx.beginPath(); ctx.moveTo(0, top + h / 2); ctx.lineTo(W, top + h / 2); ctx.stroke();
        if (li > 0) { // lane divider
          ctx.beginPath(); ctx.moveTo(0, top); ctx.lineTo(W, top); ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.strokeStyle = fg; ctx.lineWidth = 1.5; ctx.beginPath();
        for (let x = 0; x < W; x++) {
          const y = top + h - (b[xToIdx(x)] / 255) * h;
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
        if (bufs.length > 1) {
          ctx.fillStyle = dim;
          ctx.globalAlpha = 0.85;
          ctx.font = "11px sans-serif";
          ctx.fillText(li === 0 ? t("lab.chanL") : t("lab.chanR"), 4, top + 13);
          ctx.globalAlpha = 1;
        }
      });
    }

    // Paint: fill the range between the previous and current sample index so a
    // fast drag has no gaps (linear ramp of the value across skipped indices).
    // A stroke stays in the lane it STARTED in, so a wobble across the divider
    // can't smear the other channel.
    let painting = false, lastIdx = -1, lastVal = 128, lane = 0;
    function paintAt(e) {
      const r = canvas.getBoundingClientRect();
      const x = (e.clientX - r.left) * (W / r.width);
      const y = (e.clientY - r.top) * (H / r.height);
      const idx = xToIdx(x), val = yToVal(y);
      const buf = bufs[lane];
      if (lastIdx < 0) { buf[idx] = val; }
      else {
        const a = Math.min(lastIdx, idx), b = Math.max(lastIdx, idx);
        const va = lastIdx <= idx ? lastVal : val, vb = lastIdx <= idx ? val : lastVal;
        for (let i = a; i <= b; i++) {
          buf[i] = b === a ? val : Math.round(va + ((vb - va) * (i - a)) / (b - a));
        }
      }
      lastIdx = idx; lastVal = val;
      draw();
    }
    canvas.addEventListener("pointerdown", (e) => {
      const r = canvas.getBoundingClientRect();
      lane = yToLane((e.clientY - r.top) * (H / r.height));
      painting = true; lastIdx = -1;
      try { canvas.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer (smokes) */ }
      paintAt(e);
    });
    canvas.addEventListener("pointermove", (e) => { if (painting) paintAt(e); });
    canvas.addEventListener("pointerup", (e) => {
      painting = false;
      try { canvas.releasePointerCapture?.(e.pointerId); } catch { /* never captured */ }
    });

    function seed(shape) {
      for (let i = 0; i < length; i++) {
        const p = i / length; let v = 128;
        switch (shape) {
          case "sine": v = 128 + 127 * Math.sin(2 * Math.PI * p); break;
          case "saw": v = 255 * p; break;
          case "square": v = p < 0.5 ? 255 : 0; break;
          case "triangle": v = p < 0.5 ? 510 * p : 510 * (1 - p); break;
          case "noise": v = Math.random() * 255; break;
          // OPL3's eight-entry waveform table (item 177) — closed forms derived
          // from the phase-generator algebra in Nuked-OPL3's EnvelopeCalcSinN
          // (opl3.c), the reference already vendored for opl2taud.py, rather
          // than the chip's own fixed-point log/exp ROMs: this is a paint
          // preset, not a cycle-accurate emulation, so the continuous curve is
          // enough. Furnace's oplWaveformsStandard names the eight in this
          // order (Sine, Half Sine, Absolute Sine, Pulse Sine, Sine/AbsSine at
          // even periods, Square, Derived Square).
          case "opl0": v = 128 + 127 * Math.sin(2 * Math.PI * p); break;
          case "opl1": v = 128 + 127 * Math.max(0, Math.sin(2 * Math.PI * p)); break;
          case "opl2": v = 128 + 127 * Math.abs(Math.sin(2 * Math.PI * p)); break;
          case "opl3": {
            const q = p % 0.5;
            v = q < 0.25 ? 128 + 127 * Math.sin(2 * Math.PI * q) : 128;
            break;
          }
          case "opl4": v = p < 0.5 ? 128 + 127 * Math.sin(4 * Math.PI * p) : 128; break;
          case "opl5": v = p < 0.5 ? 128 + 127 * Math.abs(Math.sin(4 * Math.PI * p)) : 128; break;
          case "opl6": v = p < 0.5 ? 255 : 0; break;
          case "opl7":
            v = p < 0.5
              ? 128 + 127 * Math.pow(2, -32 * p)
              : 128 - 127 * Math.pow(2, -32 * (1 - p));
            break;
          case "flat": default: v = 128; break;
        }
        const q = Math.min(255, Math.max(0, Math.round(v)));
        for (const b of bufs) b[i] = q;   // a seed is a whole-waveform shape
      }
      draw();
    }
    for (const b of dlg.querySelectorAll(".wave-shapes button")) {
      b.addEventListener("click", () => seed(b.dataset.shape));
    }

    if (lenInput) {
      lenInput.addEventListener("change", () => {
        const newLen = Math.min(MAX_LEN, Math.max(MIN_LEN, parseInt(lenInput.value, 10) || DEF_LEN));
        bufs = bufs.map((b) => {
          const nb = new Uint8Array(newLen);
          for (let i = 0; i < newLen; i++) nb[i] = b[Math.min(length - 1, Math.round((i / newLen) * length))];
          return nb;
        });
        length = newLen; lenInput.value = newLen;
        draw();
      });
    }

    const close = (result) => { dlg.close(); dlg.remove(); resolve(result); };
    dlg.querySelector(".wave-cancel").addEventListener("click", () => close(null));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(null); });
    dlg.addEventListener("keydown", (e) => e.stopPropagation()); // don't leak to the grid
    dlg.querySelector(".wave-ok").addEventListener("click", () => {
      const result = opts.commit(bufs, nameInput ? nameInput.value : "");
      if (result === undefined) return; // commit reported an error; keep the modal open
      close(result);
    });

    draw();
    dlg.showModal();
  });
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
