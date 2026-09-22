// Sample Lab (items 83/84/109/999) — THE sample editor, "a tiny Audacity
// running inside": a zoomable waveform over a FLOAT working buffer with drag
// selection, length-changing edits (crop/cut/extend), fades/gain/normalise/etc over
// the selection, an oversampled parametric EQ with a live response graph, and a
// transient chopper (item 84) that splits the take into per-hit chunks the user
// can merge/split/discard. Length is only finalised at commit: each chunk is
// Kaiser-resampled to the target rate and, if still over the 65535-frame
// budget, squeezed with the rate following — the info line shows that fate
// BEFORE the irreversible step.
//
// TWO commits, both ONE undo step (item 109 — there is no second, lesser
// editor; this one does everything):
//   * Import as new — every kept chunk through planMultiSampleImport, minting
//     fresh samples and instruments. The only option for a take that came from
//     a file, the microphone or the chord maker.
//   * Replace — planReplaceSample writes the edit back over the POOLED sample
//     it was opened on, so every instrument already playing it follows, length
//     changes and all. Offered only when the Lab was opened on a pooled sample
//     (`replaceTarget`), and only for a single kept chunk.
//
// Entry points (resolve {firstSlot, count} | {replaced:true} | null):
//   file import (importsample.js) · mic recording (recordsample.js) ·
//   Samples-view "Edit…" / "Chord…" (a pooled sample, replaceable in place).
//
// The working buffer is a CHANNEL LIST (item 90): one Float32Array for mono,
// two for a stereo take. Every op maps over the channels — normalise is the
// one that must not (a shared peak keeps the stereo image), and transient
// detection runs on the mono fold. Committing a stereo take allocates two pool
// spans and an Ixmp 's' patch (planMultiSampleImport).

import { planMultiSampleImport, planReplaceSample } from "../../doc/bankmerge.js";
import { importBankOp } from "../../doc/ops.js";
import {
  crop, cut, repeatRange, silenceRange, fadeInRange, fadeOutRange, gainRange,
  normaliseRangeLinked, downmixChannels,
  reverseRange, invertRange, removeDCRange, eqApply, eqResponseDb,
  detectTransients, chunksFromSplits, planFit, fitToBudget, quantiseU8,
  TARGET_RATE_MAX,
} from "../../doc/wavelab.js";
import { encodeFloatWav } from "../../audio/wavwrite.js";
import { download } from "../../storage/import-export.js";
import { sanitiseName } from "../../audio/stem-export.js";
import { showModal } from "../widgets/modal.js";
import { themeColors } from "../theme.js";
import { escapeNonAscii } from "../names.js";
import { t } from "../i18n.js";
import { icon, setIconLabel } from "../icons.js";
import { uiDpr, localPoint } from "../zoom.js";

const WAVE_H = 220;
const EQGRAPH_H = 150;
const UNDO_CAP = 24;
const SPLIT_GRAB_PX = 6;
const EQ_DB_RANGE = 18; // graph spans ±this many dB

// 8 bands: 1 high-pass, 2 shelves (Q-adjustable), 5 peaks — spread ascending.
const DEFAULT_BANDS = () => ([
  { type: "highpass", freq: 80, q: 0.707, enabled: false },
  { type: "lowshelf", freq: 120, gainDb: 0, q: 0.707, enabled: true },
  { type: "peak", freq: 250, gainDb: 0, q: 1.0, enabled: true },
  { type: "peak", freq: 600, gainDb: 0, q: 1.0, enabled: true },
  { type: "peak", freq: 1500, gainDb: 0, q: 1.0, enabled: true },
  { type: "peak", freq: 4000, gainDb: 0, q: 1.0, enabled: true },
  { type: "peak", freq: 8000, gainDb: 0, q: 1.0, enabled: true },
  { type: "highshelf", freq: 12000, gainDb: 0, q: 0.707, enabled: true },
]);

/**
 * Open the Lab on a working buffer.
 * @param store the app store (doc + undo + audio)
 * @param data Float32Array mono, nominal ±1 — or an ARRAY of them (one per
 *        channel, same length) for a stereo take
 * @param rate sample rate of `data`
 * @param name default instrument/sample name
 * @param sourceLabel free-text provenance shown in the title
 * @param confirmDiscard confirm before closing without importing (recordings)
 * @param openChord open the chord maker straight away (the Samples view's
 *        "Chord…" button lands here — the Lab is where the result gets named,
 *        auditioned and committed)
 * @param replaceTarget the sampleList() census entry `data` was read out of
 *        (item 109). Its presence is what offers "Replace": the edit is written
 *        back over those pool bytes and every instrument bound to them follows.
 */
export function openSampleLab(store, { data, rate, name = "", sourceLabel = "", confirmDiscard = false, openChord = false, replaceTarget = null }) {
  const srcChans = (Array.isArray(data) ? data : [data]).filter((c) => c && c.length > 0);
  if (!store.doc || srcChans.length === 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    // ── state ──
    // chans[0] is channel 1 (left); a stereo take adds chans[1]. `buf` is kept
    // as the shorthand for channel 1 — it drives the view maths and every
    // length question, since the channels are always the same length.
    let chans = srcChans.slice(0, 2).map((c) => Float32Array.from(c));
    let buf = chans[0];
    // Fixed snapshot of the take as it was opened — "export original" stays
    // this regardless of edits made to `chans` for the rest of the session.
    const originalChans = chans.map((c) => Float32Array.from(c));
    const setChans = (next) => { chans = next; buf = chans[0]; };
    const isStereo = () => chans.length === 2;
    const srcRate = Math.max(1, Math.round(rate));
    // The rate spinner's ceiling. TARGET_RATE_MAX is the bandwidth-vs-bytes
    // suggestion for a FRESH capture (mic/file) — but Replace re-opens a
    // sample that has ALREADY been through that decision once, and its own
    // rate can legitimately sit above it (a waveform-paint instrument's
    // detune-math tuning, item 195, can declare a rate past 32 kHz). Raising
    // the ceiling to match keeps a straight re-commit from silently retuning
    // it — see planFit's `maxRate`.
    const rateCeil = replaceTarget ? Math.max(TARGET_RATE_MAX, srcRate) : TARGET_RATE_MAX;
    let sel = null;            // {a, b} in samples, a < b
    let splits = [];           // chop boundaries (samples)
    let chopOn = false;
    let discarded = new Set(); // chunk START positions left out of the import
    // clamp default corners below the Nyquist of this take (a low-rate pooled
    // sample can sit under 12 kHz, where the high shelf's default would fall)
    const nyquist = Math.max(1, Math.floor(srcRate / 2));
    let bands = DEFAULT_BANDS().map((b) => ({ ...b, freq: Math.min(b.freq, nyquist - 1) }));
    let eqOpen = false;
    // Where a frame of the TAKE AS OPENED sits in the working buffer now.
    // Length-changing edits compose a step onto it, so a Replace can carry the
    // pooled sample's play/loop markers through whatever was done to the
    // waveform (item 109) instead of guessing at them afterwards.
    let posMap = (p) => p;
    const composeMap = (step) => { const prev = posMap; posMap = (p) => step(prev(p)); };
    const undoStack = [], redoStack = [];
    let edited = false;
    let playing = null;        // {src, gain, t0, from}
    let actx = null;

    // ── view transform ──
    const dlg = document.createElement("dialog");
    dlg.className = "modal samplelab-modal";
    const cssW = Math.min(Math.floor((window.innerWidth * 94) / 100), 1280) - 48*2;
    const W = Math.max(480, cssW);
    let spp = buf.length / W;  // samples per px
    let scroll = 0;            // sample index at x=0
    const fitSpp = () => Math.max(1 / 16, buf.length / W);
    const clampView = () => {
      spp = Math.max(1 / 16, Math.min(fitSpp(), spp));
      scroll = Math.max(0, Math.min(Math.max(0, buf.length - W * spp), scroll));
    };
    const xOf = (i) => (i - scroll) / spp;
    const iOf = (x) => Math.round(scroll + x * spp);

    // ── DOM ──
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    dlg.innerHTML = `
      <h3>${esc(t("lab.title", { name: name || t("lab.untitled") }))}${sourceLabel ? ` <span class="dim">· ${esc(sourceLabel)}</span>` : ""}</h3>
      <div class="lab-info dim"></div>
      <div class="lab-tools">
        <button class="lab-play">${icon("play")}${esc(t("lab.play"))}</button>
        <span class="lab-sep"></span>
        <button class="lab-zin">${esc(t("lab.zoomIn"))}</button>
        <button class="lab-zout">${esc(t("lab.zoomOut"))}</button>
        <button class="lab-zfit">${esc(t("lab.zoomFit"))}</button>
        <span class="lab-sep"></span>
        <button class="lab-undo">${esc(t("lab.undo"))}</button>
        <button class="lab-redo">${esc(t("lab.redo"))}</button>
        <span class="lab-sep"></span>
        <button class="lab-chop" aria-pressed="false" title="${esc(t("lab.chopTitle"))}">${esc(t("lab.chop"))}</button>
        <span class="lab-chopctl" hidden>
          <button class="lab-detect" title="${esc(t("lab.detectTitle"))}">${esc(t("lab.detect"))}</button>
          <button class="lab-merge" title="${esc(t("lab.mergeTitle"))}">${esc(t("lab.merge"))}</button>
          <label>${esc(t("lab.threshold"))} <input type="range" class="lab-sens" min="1.1" max="3.5" step="0.1" value="1.8"></label>
        </span>
      </div>
      <canvas class="lab-wave"></canvas>
      <div class="lab-chunks" hidden></div>
      <div class="lab-tools lab-ops">
        <button data-op="crop" title="${esc(t("lab.cropTitle"))}">${esc(t("lab.crop"))}</button>
        <button data-op="cut" title="${esc(t("lab.cutTitle"))}">${esc(t("lab.cut"))}</button>
        <button data-op="extend" title="${esc(t("lab.extendTitle"))}">${esc(t("lab.extend"))}</button>
        <button data-op="silence">${esc(t("lab.silence"))}</button>
        <button data-op="fadeIn">${esc(t("lab.fadeIn"))}</button>
        <button data-op="fadeOut">${esc(t("lab.fadeOut"))}</button>
        <button data-op="gain" title="${esc(t("lab.gainTitle"))}">${esc(t("lab.gain"))}</button>
        <button data-op="normalise">${esc(t("lab.normalise"))}</button>
        <button data-op="reverse">${esc(t("lab.reverse"))}</button>
        <button data-op="invert">${esc(t("lab.invert"))}</button>
        <button data-op="removeDC">${esc(t("lab.removeDC"))}</button>
        <span class="lab-sep"></span>
        <button class="lab-eqtoggle">${esc(t("lab.eq"))}${icon("caretDown", true)}</button>
        <button class="lab-chord" title="${esc(t("lab.chordTitle"))}">${esc(t("lab.chord"))}</button>
        <span class="lab-sep"></span>
        <button class="lab-chans" title="${esc(t("lab.channelsTitle"))}"></button>
        <span class="lab-sep"></span>
        <button class="lab-exp-orig" title="${esc(t("lab.exportOriginalTitle"))}">${esc(t("lab.exportOriginal"))}${icon("download", true)}</button>
        <button class="lab-exp-edit" title="${esc(t("lab.exportEditedTitle"))}">${esc(t("lab.exportEdited"))}${icon("download", true)}</button>
      </div>
      <div class="lab-eq" hidden>
        <div class="lab-eqbands"></div>
        <canvas class="lab-eqgraph"></canvas>
        <div class="lab-tools">
          <button class="lab-eqapply">${esc(t("lab.eqApply"))}</button>
          <span class="dim lab-eqhint">${esc(t("lab.eqHint"))}</span>
        </div>
      </div>
      <div class="lab-row">
        <label>${esc(t("lab.name"))} <input type="text" class="lab-name" value="${esc(name)}"></label>
        <label>${esc(t("lab.rate"))} <input type="number" class="lab-rate" min="1" max="${rateCeil}" value="${Math.min(srcRate, rateCeil)}"></label>
        <span class="lab-fit dim"></span>
      </div>
      <p class="dim lab-hint">${esc(t("lab.hint"))}</p>
      <div class="modal-buttons">
        ${replaceTarget ? `<button class="lab-replace" title="${esc(t("lab.replaceTitle"))}">${esc(t("lab.replace"))}</button>` : ""}
        <button class="lab-ok">${esc(t(replaceTarget ? "lab.importNew" : "lab.import"))}</button>
        <button class="lab-cancel">${esc(t("common.cancel"))}</button>
      </div>`;
    document.body.appendChild(dlg);

    const $ = (q) => dlg.querySelector(q);
    const canvas = $(".lab-wave");
    const eqGraph = $(".lab-eqgraph");
    const chunkStrip = $(".lab-chunks");
    const nameInput = $(".lab-name");
    const rateInput = $(".lab-rate");
    const playBtn = $(".lab-play");
    const chanBtn = $(".lab-chans");
    const okBtn = $(".lab-ok");
    const replaceBtn = $(".lab-replace");
    const dpr = uiDpr();
    canvas.width = W * dpr; canvas.height = WAVE_H * dpr;
    canvas.style.width = W + "px"; canvas.style.height = WAVE_H + "px";
    eqGraph.width = W * dpr; eqGraph.height = EQGRAPH_H * dpr;
    eqGraph.style.width = W + "px"; eqGraph.style.height = EQGRAPH_H + "px";

    // ── helpers ──
    const chunks = () => chunksFromSplits(buf.length, splits);
    const keptChunks = () => (chopOn ? chunks().filter((c) => !discarded.has(c.a)) : [{ a: 0, b: buf.length }]);
    const targetRate = () => {
      const v = parseInt(rateInput.value, 10);
      return Number.isFinite(v) && v >= 1 ? Math.min(rateCeil, v) : null;
    };

    const snapshot = () => ({ chans, splits: [...splits], discarded: new Set(discarded), posMap });
    function pushUndo() {
      undoStack.push(snapshot());
      if (undoStack.length > UNDO_CAP) undoStack.shift();
      redoStack.length = 0;
      edited = true;
    }
    function restore(s) {
      setChans(s.chans);
      splits = [...s.splits];
      discarded = new Set(s.discarded);
      posMap = s.posMap;
      sel = null;
      clampView();
      refresh();
    }
    const labUndo = () => {
      if (!undoStack.length) return;
      redoStack.push(snapshot());
      restore(undoStack.pop());
    };
    const labRedo = () => {
      if (!redoStack.length) return;
      undoStack.push(snapshot());
      restore(redoStack.pop());
    };

    // splits/discards follow a length-changing edit (crop keeps the window,
    // cut closes the gap); discards are keyed by chunk start so they remap
    // with the same arithmetic
    function remapPositions(list, fn) {
      return list.map(fn).filter((p) => p !== null && p > 0 && p < buf.length);
    }
    function applyRanged(op, count = 2) {
      const [a, b] = sel ? [sel.a, sel.b] : [0, buf.length];
      if ((op === "crop" || op === "cut") && !sel) { alert(t("lab.needSel")); return; }
      pushUndo();
      // Every channel gets the same treatment; only normalise is LINKED, so a
      // stereo take keeps its balance instead of being re-centred.
      const each = (fn) => setChans(chans.map(fn));
      switch (op) {
        case "crop": {
          each((c) => crop(c, a, b));
          const shift = (p) => (p <= a ? null : p >= b ? null : p - a);
          splits = remapPositions(splits, shift);
          discarded = new Set(remapPositions([...discarded], shift));
          // Markers keep the ends they were pinned to (the split/discard remap
          // above DROPS what falls outside; a loop point must survive as the
          // nearest surviving frame instead).
          composeMap((p) => Math.max(0, Math.min(b - a, p - a)));
          sel = null; scroll = 0; spp = fitSpp();
          break;
        }
        case "cut": {
          each((c) => cut(c, a, b));
          const shift = (p) => (p < a ? p : p < b ? null : p - (b - a));
          splits = remapPositions(splits, shift);
          discarded = new Set(remapPositions([...discarded], shift));
          composeMap((p) => (p < a ? p : p < b ? a : p - (b - a)));
          sel = null;
          break;
        }
        case "extend": {
          // Insert count-1 extra copies of [a, b) — or, with no selection,
          // the WHOLE take — right after itself: a one-click way to extend a
          // short one-shot into a longer loop. Nothing is destroyed, so
          // unlike crop/cut every split and loop marker carries over with a
          // plain shift, no drops.
          const extra = (b - a) * (Math.max(1, Math.floor(count) || 1) - 1);
          each((c) => repeatRange(c, a, b, count));
          const shift = (p) => (p < b ? p : p + extra);
          splits = remapPositions(splits, shift);
          discarded = new Set(remapPositions([...discarded], shift));
          composeMap(shift);
          sel = { a: b, b: b + extra }; // select the fresh copies, ready for their own edit
          break;
        }
        case "silence": each((c) => silenceRange(c, a, b)); break;
        case "fadeIn": each((c) => fadeInRange(c, a, b)); break;
        case "fadeOut": each((c) => fadeOutRange(c, a, b)); break;
        case "normalise": setChans(normaliseRangeLinked(chans, a, b)); break;
        case "reverse": each((c) => reverseRange(c, a, b)); break;
        case "invert": each((c) => invertRange(c, a, b)); break;
        case "removeDC": each((c) => removeDCRange(c, a, b)); break;
      }
      clampView();
      refresh();
    }
    async function gainTool() {
      const [a, b] = sel ? [sel.a, sel.b] : [0, buf.length];
      const res = await showModal({
        title: t("lab.gain"),
        fields: [{ name: "db", label: t("lab.gainAsk"), type: "number", value: "-3" }],
        okLabel: t("common.apply"),
      });
      if (!res) return;
      const db = Number(res.db);
      if (!Number.isFinite(db)) return;
      pushUndo();
      setChans(chans.map((c) => gainRange(c, a, b, Math.pow(10, db / 20))));
      refresh();
    }
    async function extendTool() {
      const [a, b] = sel ? [sel.a, sel.b] : [0, buf.length];
      const rangeLen = b - a;
      const res = await showModal({
        title: t("lab.extend"),
        fields: [{
          name: "count", label: t("lab.extendAsk"), type: "number", value: "2", min: "2",
          hint: (raw) => {
            const n = Math.max(2, Math.floor(Number(raw)) || 2);
            const newLen = buf.length + rangeLen * (n - 1);
            return t("lab.extendPreview", { frames: newLen, secs: (newLen / srcRate).toFixed(2) });
          },
        }],
        okLabel: t("common.apply"),
      });
      if (!res) return;
      const n = Math.max(2, Math.floor(Number(res.count)) || 2);
      applyRanged("extend", n);
    }

    // ── painting ──
    // One channel's lane: [top, top+h) of the canvas, same x transform.
    function paintChannel(ctx, C, data, top, h) {
      const mid = top + h / 2;
      const yOf = (v) => mid - v * (h / 2 - 4);
      ctx.fillStyle = C.waveMid ?? C.dim;
      ctx.fillRect(0, Math.round(mid), W, 1);
      ctx.fillStyle = C.wave;
      if (spp <= 1) {
        const rectW = Math.max(1, Math.ceil(1 / spp));
        const i0 = Math.max(0, Math.floor(scroll));
        const i1 = Math.min(data.length - 1, Math.ceil(scroll + W * spp));
        for (let i = i0; i <= i1; i++) {
          const x = Math.floor(xOf(i)), y = yOf(data[i]);
          ctx.fillRect(x, Math.min(mid, y), rectW, Math.max(1, Math.abs(mid - y)));
        }
      } else {
        // Every column is a BAR anchored to the centre line, exactly like the
        // Samples view (item 109): the fill runs from the zero line out to the
        // column's peak on each side, so a column whose min and max sit on the
        // SAME side of zero still reads as a bar growing off the axis. Drawing
        // the bare min..max envelope instead leaves a hairline floating in
        // space, which is what a resampled waveform is hardest to read as.
        for (let col = 0; col < W; col++) {
          const a = Math.floor(scroll + col * spp);
          const b = Math.min(data.length, Math.floor(scroll + (col + 1) * spp));
          if (b <= a || a >= data.length) continue;
          const step = Math.max(1, ((b - a) / 8) | 0);
          let mn = Infinity, mx = -Infinity;
          for (let p = a; p < b; p += step) {
            const v = data[p];
            if (v < mn) mn = v;
            if (v > mx) mx = v;
          }
          // mx >= mn ⟹ yOf(mx) <= yOf(mn); clamping BOTH ends against `mid`
          // grows the bar from the axis. (Clamping only the top — as this once
          // did — is the bug that flattened all-negative columns onto zero.)
          const yT = Math.min(mid, yOf(mx)), yB = Math.max(mid, yOf(mn));
          ctx.fillRect(col, yT, 1, Math.max(1, yB - yT));
        }
      }
    }

    /** The pooled sample's loop region, followed through this session's edits —
     *  where Replace will leave it. Null when there is nothing to show. */
    function loopRegion() {
      const s = replaceTarget;
      if (!s || (s.loopMode & 3) === 0 || s.loopEnd <= s.loopStart) return null;
      const a = Math.max(0, Math.min(buf.length, posMap(s.loopStart)));
      const b = Math.max(0, Math.min(buf.length, posMap(s.loopEnd)));
      return b > a ? { a, b } : null;
    }

    function paintWave() {
      const C = themeColors();
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = C.cvBg;
      ctx.fillRect(0, 0, W, WAVE_H);

      // loop region of the pooled sample, under everything
      const loop = loopRegion();
      if (loop) {
        ctx.fillStyle = C.waveLoop;
        ctx.fillRect(xOf(loop.a), 0, Math.max(1, xOf(loop.b) - xOf(loop.a)), WAVE_H);
      }

      // selection under the wave
      if (sel) {
        ctx.fillStyle = C.sel || C.accent;
        ctx.globalAlpha = 0.22;
        ctx.fillRect(xOf(sel.a), 0, xOf(sel.b) - xOf(sel.a), WAVE_H);
        ctx.globalAlpha = 1;
      }

      // one lane per channel, stacked, with a divider and L/R tags when stereo
      const laneH = WAVE_H / chans.length;
      chans.forEach((data, i) => paintChannel(ctx, C, data, i * laneH, laneH));
      if (chans.length > 1) {
        ctx.fillStyle = C.dim;
        ctx.globalAlpha = 0.6;
        ctx.fillRect(0, Math.round(laneH), W, 1);
        ctx.globalAlpha = 0.9;
        ctx.font = "10px sans-serif";
        ctx.fillStyle = C.fg2 || C.fg;
        ctx.fillText(t("lab.chanL"), 3, 11);
        ctx.fillText(t("lab.chanR"), 3, Math.round(laneH) + 11);
        ctx.globalAlpha = 1;
      }

      if (chopOn) {
        const cs = chunks();
        // discarded chunks dim out
        ctx.fillStyle = C.bg;
        ctx.globalAlpha = 0.55;
        for (const c of cs) {
          if (discarded.has(c.a)) ctx.fillRect(xOf(c.a), 0, xOf(c.b) - xOf(c.a), WAVE_H);
        }
        ctx.globalAlpha = 1;
        // split flags
        for (const p of splits) {
          const x = xOf(p);
          if (x < -4 || x > W + 4) continue;
          ctx.fillStyle = C.accent2;
          ctx.fillRect(x - 0.5, 0, 1.5, WAVE_H);
          ctx.beginPath();
          ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 9);
          ctx.closePath();
          ctx.fill();
        }
        // chunk numbers
        ctx.fillStyle = C.fg2 || C.fg;
        ctx.font = "11px sans-serif";
        cs.forEach((c, i) => {
          const x = Math.max(2, xOf(c.a) + 3);
          if (x < W) ctx.fillText(String(i + 1), x, 20);
        });
      }

      if (playing) {
        const pos = playPos();
        if (pos !== null) {
          ctx.fillStyle = C.waveCursor || C.playCursor || C.accent;
          ctx.fillRect(xOf(pos) - 0.5, 0, 1.5, WAVE_H);
        }
      }
    }

    const fmtHz = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(f % 1000 ? 1 : 0)}k` : `${Math.round(f)}`);
    function paintEqGraph() {
      const C = themeColors();
      const ctx = eqGraph.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = C.cvBg;
      ctx.fillRect(0, 0, W, EQGRAPH_H);

      const GL = 30, GB = 15;                 // gutters: dB labels (left), Hz labels (bottom)
      const plotW = W - GL, plotH = EQGRAPH_H - GB;
      const fLo = 20, fHi = srcRate / 2;       // view spans 20 Hz → Nyquist
      const xF = (f) => GL + (Math.log(f / fLo) / Math.log(fHi / fLo)) * plotW;
      const yDb = (db) => plotH / 2 - (db / EQ_DB_RANGE) * (plotH / 2 - 4);
      ctx.font = "10px sans-serif";
      ctx.textBaseline = "alphabetic";

      // ── dB grid (horizontal, every 6 dB) + left-gutter labels ──
      for (let db = -EQ_DB_RANGE; db <= EQ_DB_RANGE; db += 6) {
        const y = yDb(db);
        ctx.fillStyle = C.dim;
        ctx.globalAlpha = db === 0 ? 0.5 : 0.22;
        ctx.fillRect(GL, y, plotW, 1);
        ctx.globalAlpha = 0.85;
        ctx.fillText(db > 0 ? `+${db}` : `${db}`, 2, y + 3);
      }

      // ── frequency grid (log, 1-2-3-5-7 per decade); majors labelled ──
      const majors = new Set([20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]);
      const lines = [20, 30, 50, 70, 100, 200, 300, 500, 700, 1000, 2000, 3000,
                     5000, 7000, 10000, 20000];
      ctx.fillStyle = C.dim;
      for (const f of lines) {
        if (f <= fLo || f >= fHi) continue;
        const x = xF(f);
        ctx.globalAlpha = majors.has(f) ? 0.38 : 0.16;
        ctx.fillRect(x, 0, 1, plotH);
        if (majors.has(f)) {
          ctx.globalAlpha = 0.85;
          ctx.fillText(fmtHz(f), x + 2, EQGRAPH_H - 4);
        }
      }
      // always label the view's extremes: 20 Hz at the left, Nyquist at the right
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = C.fg2 || C.fg;
      ctx.fillText(`${fLo}`, GL + 2, EQGRAPH_H - 4);
      const hi = fmtHz(fHi);
      ctx.fillText(hi, W - ctx.measureText(hi).width - 2, EQGRAPH_H - 4);
      ctx.globalAlpha = 1;

      // ── response curve, clipped to the plot ──
      ctx.save();
      ctx.beginPath();
      ctx.rect(GL, 0, plotW, plotH);
      ctx.clip();
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let px = 0; px <= plotW; px++) {
        const f = fLo * Math.pow(fHi / fLo, px / plotW);
        const y = yDb(eqResponseDb(bands, srcRate, f));
        px === 0 ? ctx.moveTo(GL + px, y) : ctx.lineTo(GL + px, y);
      }
      ctx.stroke();
      ctx.restore();
    }

    function refreshInfo() {
      const secs = (n) => (n / srcRate).toFixed(2);
      let line = t("lab.info", { frames: buf.length, rate: srcRate, secs: secs(buf.length) });
      line += " · " + t(isStereo() ? "lab.stereo" : "lab.mono");
      if (sel) line += t("lab.selInfo", { frames: sel.b - sel.a, secs: secs(sel.b - sel.a) });
      if (replaceTarget) {
        line += " · " + t("lab.pooledUsers", {
          list: replaceTarget.users.map((u) => "$" + u.toString(16).toUpperCase().padStart(2, "0")).join(" "),
        });
      }
      $(".lab-info").textContent = line;
      setIconLabel(chanBtn, "arrowRight", t(isStereo() ? "lab.toMono" : "lab.toStereo"));

      const kept = keptChunks();
      let fitStr;
      if (kept.length === 0) {
        fitStr = t("lab.noChunks");
      } else {
        const fits = kept.map((c) => planFit(c.b - c.a, srcRate, targetRate(), rateCeil));
        const big = fits.reduce((m, f) => (f.frames > m.frames ? f : m), fits[0]);
        fitStr = kept.length === 1
          ? t("lab.importOne", { frames: big.frames, rate: big.rate })
          : t("lab.importMany", { n: kept.length, frames: big.frames, rate: big.rate });
        if (fits.some((f) => f.squeezed)) fitStr += t("lab.squeezed");
      }
      $(".lab-fit").textContent = fitStr;
      okBtn.textContent = chopOn && kept.length > 1
        ? t("lab.importN", { n: kept.length })
        : t(replaceTarget ? "lab.importNew" : "lab.import");
      okBtn.disabled = kept.length === 0;
      if (replaceBtn) {
        // Replace writes ONE sample back over ONE pooled sample: a chop that
        // keeps several chunks is an import, not a replacement.
        replaceBtn.disabled = kept.length !== 1;
        replaceBtn.title = kept.length !== 1 ? t("lab.replaceOneOnly") : t("lab.replaceTitle");
      }
    }

    function refreshChunkStrip() {
      chunkStrip.hidden = !chopOn;
      chunkStrip.innerHTML = "";
      if (!chopOn) return;
      chunks().forEach((c, i) => {
        const pill = document.createElement("span");
        pill.className = "lab-chunk" + (discarded.has(c.a) ? " off" : "");
        pill.title = t("lab.chunkTitle");
        const keep = document.createElement("input");
        keep.type = "checkbox";
        keep.checked = !discarded.has(c.a);
        keep.addEventListener("change", () => {
          keep.checked ? discarded.delete(c.a) : discarded.add(c.a);
          edited = true;
          refresh();
        });
        const lab = document.createElement("button");
        lab.textContent = `${i + 1} · ${((c.b - c.a) / srcRate).toFixed(2)}s`;
        lab.addEventListener("click", () => {
          sel = { a: c.a, b: c.b };
          if (xOf(c.a) < 0 || xOf(c.b) > W) scroll = Math.max(0, c.a - ((W * spp) - (c.b - c.a)) / 2);
          clampView();
          refresh();
        });
        pill.append(keep, lab);
        chunkStrip.appendChild(pill);
      });
    }

    function refresh() {
      paintWave();
      refreshChunkStrip();
      refreshInfo();
      $(".lab-undo").disabled = undoStack.length === 0;
      $(".lab-redo").disabled = redoStack.length === 0;
    }

    // ── waveform interaction: drag = select, click = chop-edit / clear ──
    let drag = null; // {x0, i0, moved}
    canvas.addEventListener("pointerdown", (e) => {
      const x = localPoint(canvas, e).x;
      drag = { x0: x, i0: Math.max(0, Math.min(buf.length, iOf(x))), moved: false };
      try { canvas.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer (smokes) */ }
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const x = localPoint(canvas, e).x;
      if (!drag.moved && Math.abs(x - drag.x0) < 3) return;
      drag.moved = true;
      const i = Math.max(0, Math.min(buf.length, iOf(x)));
      sel = i === drag.i0 ? null : { a: Math.min(drag.i0, i), b: Math.max(drag.i0, i) };
      paintWave();
      refreshInfo();
    });
    canvas.addEventListener("pointerup", (e) => {
      if (!drag) return;
      const wasDrag = drag.moved;
      const x = localPoint(canvas, e).x;
      drag = null;
      if (wasDrag) return;
      if (chopOn) {
        // click near a flag removes the split, elsewhere adds one
        const near = splits.find((p) => Math.abs(xOf(p) - x) <= SPLIT_GRAB_PX);
        pushUndo();
        if (near !== undefined) splits = splits.filter((p) => p !== near);
        else {
          const p = Math.max(1, Math.min(buf.length - 1, iOf(x)));
          splits = [...splits, p].sort((m, n) => m - n);
        }
        refresh();
      } else {
        sel = null;
        refresh();
      }
    });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const x = localPoint(canvas, e).x;
      if (e.ctrlKey || e.metaKey) {
        const focus = iOf(x);
        spp *= e.deltaY > 0 ? 1.3 : 1 / 1.3;
        clampView();
        scroll = Math.max(0, focus - x * spp);
        clampView();
      } else {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        scroll += d * spp;
        clampView();
      }
      paintWave();
    }, { passive: false });

    $(".lab-zin").addEventListener("click", () => {
      const centre = iOf(W / 2);
      spp /= 2; clampView();
      scroll = Math.max(0, centre - (W / 2) * spp); clampView();
      paintWave();
    });
    $(".lab-zout").addEventListener("click", () => {
      const centre = iOf(W / 2);
      spp *= 2; clampView();
      scroll = Math.max(0, centre - (W / 2) * spp); clampView();
      paintWave();
    });
    $(".lab-zfit").addEventListener("click", () => { spp = fitSpp(); scroll = 0; paintWave(); });

    // ── tools ──
    for (const b of dlg.querySelectorAll(".lab-ops button[data-op]")) {
      b.addEventListener("click", () => {
        if (b.dataset.op === "gain") gainTool();
        else if (b.dataset.op === "extend") extendTool();
        else applyRanged(b.dataset.op);
      });
    }
    $(".lab-undo").addEventListener("click", labUndo);
    $(".lab-redo").addEventListener("click", labRedo);

    // ── chop ──
    const chopBtn = $(".lab-chop");
    const detect = () => {
      pushUndo();
      splits = detectTransients(downmixChannels(chans), srcRate,
        { sensitivity: Number($(".lab-sens").value) });
      discarded.clear();
      refresh();
    };
    const setChopMode = (on) => {
      chopOn = on;
      chopBtn.classList.toggle("on", on);
      chopBtn.setAttribute("aria-pressed", on ? "true" : "false");
      $(".lab-chopctl").hidden = !on;
      if (on && splits.length === 0) detect(); // first entry auto-detects
      else refresh();
    };
    chopBtn.addEventListener("click", () => setChopMode(!chopOn));
    $(".lab-detect").addEventListener("click", detect);
    // Merge: drop every split that falls strictly inside the selection, so the
    // chunks it spans collapse into one (two or more, in a single action). The
    // simplest case — merging two neighbours — is also a click on their shared
    // split flag on the waveform.
    function mergeSelection() {
      if (!chopOn) return;
      if (!sel) { alert(t("lab.mergeNoSel")); return; }
      const inSel = (p) => p > sel.a && p < sel.b;
      if (!splits.some(inSel)) { alert(t("lab.mergeNone")); return; }
      pushUndo();
      splits = splits.filter((p) => !inSel(p));
      // a discarded chunk whose start was one of the dropped splits is gone
      discarded = new Set([...discarded].filter((p) => !inSel(p)));
      refresh();
    }
    $(".lab-merge").addEventListener("click", mergeSelection);

    // ── EQ ──
    const bandsEl = $(".lab-eqbands");
    function buildEqBands() {
      bandsEl.innerHTML = "";
      bands.forEach((band) => {
        const row = document.createElement("div");
        row.className = "lab-eqband";
        const en = document.createElement("input");
        en.type = "checkbox";
        en.checked = band.enabled !== false;
        en.addEventListener("change", () => { band.enabled = en.checked; paintEqGraph(); });
        const kind = document.createElement("span");
        kind.className = "lab-eqkind";
        kind.textContent = t(`lab.eqBand.${band.type}`);
        row.append(en, kind);
        const num = (key, min, max, step, unit) => {
          if (band[key] === undefined) return;
          const lab = document.createElement("label");
          const inp = document.createElement("input");
          inp.type = "number";
          inp.min = min; inp.max = max; inp.step = step;
          inp.value = band[key];
          inp.addEventListener("change", () => {
            band[key] = Math.max(min, Math.min(max, Number(inp.value) || 0));
            inp.value = band[key];
            paintEqGraph();
          });
          lab.append(inp, " " + unit);
          row.appendChild(lab);
        };
        num("freq", 20, Math.floor(srcRate / 2), 1, t("lab.eqFreq"));
        num("gainDb", -24, 24, 0.5, t("lab.eqGain"));
        num("q", 0.1, 12, 0.1, t("lab.eqQ"));
        bandsEl.appendChild(row);
      });
    }
    $(".lab-eqtoggle").addEventListener("click", () => {
      eqOpen = !eqOpen;
      $(".lab-eq").hidden = !eqOpen;
      if (eqOpen) { buildEqBands(); paintEqGraph(); }
    });
    $(".lab-eqapply").addEventListener("click", () => {
      const [a, b] = sel ? [sel.a, sel.b] : [0, buf.length];
      pushUndo();
      setChans(chans.map((c) => eqApply(c, srcRate, bands, { a, b })));
      refresh();
    });

    // ── chord maker (item 89) ──────────────────────────────────────────────
    // Mixes pitch-shifted copies of the WHOLE working buffer into one chorded
    // sample. Length-changing (a note below unison runs longer), which is
    // legal here for the same reason crop is: nothing is pooled yet. Chop
    // positions describe the old waveform, so they go.
    async function chordTool() {
      const { openChordMaker } = await import("./chordmaker.js");
      const res = await openChordMaker(store, {
        data: buf, dataR: chans[1] ?? null, rate: srcRate,
        name: nameInput.value.trim() || name,
      });
      if (!res) return;
      pushUndo();
      // A stereo take is chorded channel by channel with the SAME notes, and
      // the maker links the normalisation across them.
      setChans(res.dataR ? [res.data, res.dataR] : [res.data]);
      splits = [];
      discarded.clear();
      sel = null;
      scroll = 0; spp = fitSpp();
      clampView();
      refresh();
    }
    $(".lab-chord").addEventListener("click", (e) => { e.preventDefault(); chordTool(); });

    // ── mono / stereo ──────────────────────────────────────────────────────
    // Undoable, like every other buffer change: → mono folds the channels
    // together, → stereo duplicates channel 1 (a dual-mono pair, which costs
    // twice the pool bytes — the info line says so).
    function setChannelCount(n) {
      if (n === chans.length || n < 1 || n > 2) return;
      pushUndo();
      setChans(n === 1 ? [downmixChannels(chans)] : [chans[0], Float32Array.from(chans[0])]);
      refresh();
    }
    chanBtn.addEventListener("click", (e) => {
      e.preventDefault();
      setChannelCount(isStereo() ? 1 : 2);
    });

    // ── export (download the working buffer as a WAV, original or edited) ──
    function exportTake(chansArg, suffix) {
      const nm = nameInput.value.trim() || name || t("lab.untitled");
      const bytes = encodeFloatWav(chansArg, srcRate, 16);
      download(bytes, `${sanitiseName(nm)}-${suffix}.wav`);
    }
    $(".lab-exp-orig").addEventListener("click", (e) => { e.preventDefault(); exportTake(originalChans, "original"); });
    $(".lab-exp-edit").addEventListener("click", (e) => { e.preventDefault(); exportTake(chans, "edited"); });

    // ── audition (Web Audio on the working buffer — it is not pooled yet) ──
    function playPos() {
      if (!playing || !actx) return null;
      const pos = playing.from + (actx.currentTime - playing.t0) * srcRate;
      return pos >= 0 && pos <= buf.length ? pos : null;
    }
    function stopPlay() {
      if (!playing) return;
      try { playing.src.stop(); } catch { /* already ended */ }
      playing = null;
      setIconLabel(playBtn, "play", t("lab.play"));
      paintWave();
    }
    function startPlay() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!actx) actx = new AC();
      if (actx.state === "suspended") actx.resume();
      const [a, b] = sel ? [sel.a, sel.b] : [0, buf.length];
      // AudioBuffer rates clamp to [8000, 96000]; playbackRate restores pitch
      const bufRate = Math.max(8000, Math.min(96000, srcRate));
      const ab = actx.createBuffer(chans.length, buf.length, bufRate);
      chans.forEach((c, i) => ab.getChannelData(i).set(c));
      const src = actx.createBufferSource();
      src.buffer = ab;
      src.playbackRate.value = srcRate / bufRate;
      let head = src;
      if (eqOpen) {
        // live preview of the EQ panel with native filters (the destructive
        // Apply is the oversampled render — marginally cleaner near Nyquist)
        const map = { highpass: "highpass", lowshelf: "lowshelf", peak: "peaking", highshelf: "highshelf" };
        for (const band of bands) {
          if (band.enabled === false) continue;
          if (band.type !== "highpass" && Math.abs(band.gainDb ?? 0) < 1e-6) continue;
          const f = actx.createBiquadFilter();
          f.type = map[band.type];
          f.frequency.value = band.freq;
          if (band.gainDb !== undefined) f.gain.value = band.gainDb;
          if (band.q !== undefined) f.Q.value = band.q;
          head.connect(f);
          head = f;
        }
      }
      head.connect(actx.destination);
      src.start(0, a / bufRate, (b - a) / bufRate);
      playing = { src, t0: actx.currentTime, from: a };
      setIconLabel(playBtn, "stop", t("lab.stop"));
      src.onended = () => { if (playing?.src === src) stopPlay(); };
      const tick = () => {
        if (!playing) return;
        paintWave();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
    playBtn.addEventListener("click", () => (playing ? stopPlay() : startPlay()));

    // ── commit / close ──
    const enc = new TextEncoder();
    const finalName = () => nameInput.value.trim() || name || t("lab.untitled");
    // What the Name field said on arrival. A Replace only writes SNam when the
    // user actually typed something else: the field of an UNNAMED pooled sample
    // is pre-filled with a placeholder ("sample 7") that would otherwise become
    // its name just for having been read.
    const openedWithName = nameInput.value;
    /** One kept chunk, resampled + quantised: {pcm, pcmR, rate, ratio, clipped}. */
    function renderChunk(c) {
      // planFit depends only on the frame count, so every channel of a chunk
      // resamples by the same ratio to the same length and rate.
      const fitted = chans.map((ch) => fitToBudget(ch.slice(c.a, c.b), srcRate, targetRate(), rateCeil));
      const q = fitted.map((f) => quantiseU8(f.data));
      return {
        pcm: q[0].pcm,
        pcmR: q.length > 1 ? q[1].pcm : null,
        rate: fitted[0].rate,
        ratio: fitted[0].data.length / Math.max(1, c.b - c.a),
        clipped: q.some((x) => x.clipped),
      };
    }

    function commit() {
      const kept = keptChunks();
      if (kept.length === 0) { alert(t("lab.noChunks")); return; }
      const nm = finalName();
      let clippedCount = 0;
      const items = kept.map((c, i) => {
        const r = renderChunk(c);
        if (r.clipped) clippedCount++;
        return {
          nameBytes: enc.encode(escapeNonAscii(kept.length > 1 ? `${nm} ${i + 1}` : nm)),
          pcm: r.pcm, pcmR: r.pcmR, rate: r.rate,
        };
      });
      if (clippedCount > 0 && !confirm(t("lab.clipWarn", { n: clippedCount }))) return;
      const plan = planMultiSampleImport(store.doc, items);
      if (plan.error) { alert(plan.error); return; }
      store.undo.apply(importBankOp(plan));
      finish({ firstSlot: plan.insts[0].destSlot, count: plan.insts.length });
    }

    /**
     * Write the edit back over the pooled sample the Lab was opened on (item
     * 109). The markers of every instrument bound to it are carried through by
     * the session's position map composed with the chunk crop and the final
     * resample ratio, so a loop still lands on the sound it looped.
     */
    function commitReplace() {
      if (!replaceTarget) return;
      const kept = keptChunks();
      if (kept.length !== 1) { alert(t("lab.replaceOneOnly")); return; }
      const c = kept[0];
      const r = renderChunk(c);
      if (r.clipped && !confirm(t("lab.clipWarn", { n: 1 }))) return;
      const renamed = nameInput.value !== openedWithName;
      const plan = planReplaceSample(store.doc, replaceTarget, {
        pcm: r.pcm,
        pcmR: r.pcmR,
        rate: r.rate,
        nameBytes: renamed ? enc.encode(escapeNonAscii(finalName())) : null,
        mapPos: (p) => (Math.max(c.a, Math.min(c.b, posMap(p))) - c.a) * r.ratio,
      });
      if (plan.error) { alert(plan.error); return; }
      const users = replaceTarget.users.map((u) => "$" + u.toString(16).toUpperCase().padStart(2, "0")).join(" ");
      let ask = t("lab.replaceAsk", {
        frames: plan.len, rate: plan.rate, list: users, n: replaceTarget.users.length,
      });
      if (plan.len !== plan.oldLen) ask += "\n" + t("lab.replaceLenNote", { from: plan.oldLen, to: plan.len });
      if (plan.rate !== replaceTarget.rate) ask += "\n" + t("lab.replaceRateNote", { from: replaceTarget.rate, to: plan.rate });
      if (plan.droppedChannel) ask += "\n" + t("lab.replaceMonoNote");
      if (plan.clampedLoops > 0) ask += "\n" + t("lab.replaceLoopNote", { n: plan.clampedLoops });
      if (!confirm(ask)) return;
      store.undo.apply(importBankOp(plan));
      finish({ replaced: true, ptr: plan.ptr, len: plan.len });
    }
    function finish(result) {
      stopPlay();
      if (actx) { actx.close().catch(() => {}); actx = null; }
      dlg.close();
      dlg.remove();
      resolve(result);
    }
    function requestCancel() {
      if ((confirmDiscard || edited) && !confirm(t("lab.confirmClose"))) return;
      finish(null);
    }
    okBtn.addEventListener("click", (e) => { e.preventDefault(); commit(); });
    replaceBtn?.addEventListener("click", (e) => { e.preventDefault(); commitReplace(); });
    $(".lab-cancel").addEventListener("click", (e) => { e.preventDefault(); requestCancel(); });
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); requestCancel(); });
    dlg.addEventListener("keydown", (e) => {
      e.stopPropagation(); // never leak piano/transport keys to the grid
      const inField = e.target.tagName === "INPUT" && e.target.type !== "checkbox" && e.target.type !== "range";
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !inField) {
        e.preventDefault();
        e.shiftKey ? labRedo() : labUndo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y" && !inField) {
        e.preventDefault();
        labRedo();
      } else if (e.key === " " && !inField && e.target.tagName !== "BUTTON") {
        e.preventDefault();
        playing ? stopPlay() : startPlay();
      } else if ((e.key === "Delete" || e.key === "Backspace") && !inField && sel) {
        e.preventDefault();
        applyRanged("cut");
      }
    });
    rateInput.addEventListener("change", refreshInfo);

    // ── test hooks (headless smokes drive the modal through these) ──
    dlg.__lab = {
      state: () => ({
        len: buf.length, rate: srcRate, sel: sel && { ...sel },
        splits: [...splits], chop: chopOn, channels: chans.length,
        discarded: [...discarded], undoDepth: undoStack.length,
        canReplace: !!replaceBtn && !replaceBtn.disabled,
        loop: loopRegion(),
      }),
      mapPos: (p) => posMap(p),
      buffer: () => buf,
      buffers: () => chans,
      setChannelCount,
      setSelection: (a, b) => { sel = { a: Math.min(a, b), b: Math.max(a, b) }; refresh(); },
      clearSelection: () => { sel = null; refresh(); },
      tool: (op, count) => applyRanged(op, count),
      extend: () => extendTool(),
      gainDb: (db) => {
        pushUndo();
        const [a, b] = sel ? [sel.a, sel.b] : [0, buf.length];
        setChans(chans.map((c) => gainRange(c, a, b, Math.pow(10, db / 20))));
        refresh();
      },
      undo: labUndo,
      redo: labRedo,
      setChop: (on) => setChopMode(on),
      detect,
      setSplits: (arr) => { pushUndo(); splits = [...arr].sort((a, b) => a - b); refresh(); },
      merge: mergeSelection,
      toggleChunk: (i) => {
        const c = chunks()[i];
        if (!c) return;
        discarded.has(c.a) ? discarded.delete(c.a) : discarded.add(c.a);
        edited = true;
        refresh();
      },
      chunks: () => chunks(),
      bands: () => bands,
      setBand: (i, patch) => { Object.assign(bands[i], patch); if (eqOpen) { buildEqBands(); paintEqGraph(); } },
      applyEq: () => $(".lab-eqapply").click(),
      chord: () => chordTool(),
      setName: (s) => { nameInput.value = s; },
      setTargetRate: (v) => { rateInput.value = v; refreshInfo(); },
      commit,
      replace: commitReplace,
      cancel: () => finish(null),
    };

    refresh();
    dlg.showModal();
    if (openChord) chordTool();
  });
}
