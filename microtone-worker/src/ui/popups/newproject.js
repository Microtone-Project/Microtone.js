// Elaborate New-Project dialog — the web equivalent of taut_newproj.mjs, bumped
// to a richer GUI. Collects every song setting BEFORE the blank project is built:
// tempo (BPM/speed) with a live "blinkenlights" tempo preview, meter (time
// signature + rows/beat → derived rows/bar; these are the primary/secondary
// beat divisors that drive the timeline row-highlight), tuning reference, project
// metadata, lane layout, and the display notation (default 24-TET).
//
// showNewProject({ fromBank, bankName }) resolves with a settings object or null
// (cancel). The caller (app.js newProject) turns it into the Document shape.
//   { name, composer, copyright, lanes(32|64), bpm, tickRate, notation,
//     beatPri, beatSec, timeSigNum, timeSigDen, baseNote, baseFreq }

import { t } from "../i18n.js";
import { pitchTablePresets } from "../pitchtables.js";

// Base-note tuning references (note value in the 0x1000-per-octave space, C4 =
// 0x5000). Written to the song's tuning fields, which the engine APPLIES (item
// 77): both references below are concert pitch, so a fresh project starts
// unretuned. A4 @ 440 is the exact-identity pair; C4 @ 261.6256 is concert
// rounded to 7 digits, 0.0003 cents off — inaudible, and the Project view can
// dial in any tuning afterwards.
const BASE_NOTES = [
  { label: "C4", note: 0x5000, freq: 261.6256 },
  { label: "A4", note: 0x5c00, freq: 440.0 },
];
const DEN_OPTIONS = [1, 2, 4, 8, 16, 32];
const NOTATION_DEFAULT = 240; // 24-TET

const NOTE_PRESETS = Object.values(pitchTablePresets).sort((a, b) => a.index - b.index);
// Notation-type badge colours (mirrors taut's list palette): d diatonic-ish,
// M macrotonal, m microtonal, "" raw.
const TYPE_LABEL = { d: "12", M: "M", m: "µ", "": "·" };

const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(v, 10);
  return isNaN(n) ? dflt : Math.max(lo, Math.min(hi, n));
};

// ── tap tempo (unit-tested in test/node/taptempo.test.js) ─────────────────
// A tap marks a NOTATED beat — beatPri rows of tickRate ticks — and one tick is
// 2.5/BPM seconds (engine tick.js), so a beat lasts beatPri·tickRate·2.5/BPM
// seconds. Inverting that is the whole conversion: the tapper is calibrated
// against the beat lamp beside it, not against the field, so on the defaults
// (4 rows/beat × speed 6 = the classic 24 ticks) tapping 125 writes 125, while
// on any other meter/speed the written BPM keeps the beat you tapped.
export const TAP_MAX = 8;              // taps kept — the averaging window
export const TAP_RESET_MIN_MS = 2000;  // silence that starts a new count
export const TAP_RESET_MAX_MS = 6000;

/** How long a tap series survives without a tap: a couple of the user's own
 *  beats, so a slow tempo isn't cut off mid-count. */
export function tapResetMs(taps) {
  if (taps.length < 2) return TAP_RESET_MIN_MS;
  const mean = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
  return Math.max(TAP_RESET_MIN_MS, Math.min(TAP_RESET_MAX_MS, mean * 2.5));
}

/** Tap timestamps (ms, oldest first) → { intervalMs, tapBpm, bpm }, or null
 *  before there are two taps to measure. `bpm` is the song field, clamped to
 *  its 25..535 range; `tapBpm` is the tempo actually tapped. */
export function tapAnalyse(taps, beatPri, tickRate) {
  if (taps.length < 2) return null;
  const intervalMs = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
  if (!(intervalMs > 0)) return null;
  const raw = (2500 * beatPri * tickRate) / intervalMs;
  return {
    intervalMs,
    tapBpm: 60000 / intervalMs,
    bpm: Math.max(25, Math.min(535, Math.round(raw))),
  };
}

export function showNewProject({ fromBank = null, bankName = null } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "modal np-modal";

    // ── state ──
    let baseSel = 1;      // default A4
    let freqAuto = true;  // freq tracks the base note until the user edits it
    let noteSel = Math.max(0, NOTE_PRESETS.findIndex((p) => p.index === NOTATION_DEFAULT));

    const title = fromBank ? t("np.titleFromBank", { bank: bankName }) : t("np.title");
    const body = fromBank ? t("np.bodyFromBank") : t("np.body");

    dlg.innerHTML = `
      <h3>${esc(title)}</h3>
      <p class="dim np-body">${esc(body)}</p>
      <div class="np-grid">
        <div class="np-col">
          <fieldset class="np-sec">
            <legend>${esc(t("np.secTempo"))}</legend>
            <label class="np-field"><span>${esc(t("np.bpm"))}</span>
              <input type="number" data-f="bpm" min="25" max="535" value="125"></label>
            <label class="np-field"><span>${esc(t("np.speed"))}</span>
              <input type="number" data-f="spd" min="1" max="127" value="6"></label>
            <div class="np-field np-tap-row"><span>${esc(t("np.tapTempo"))}</span>
              <button type="button" class="np-tap" data-f="tap" title="${esc(t("np.tapTip"))}">${esc(t("np.tapBtn"))}</button>
              <span class="dim np-tap-read" data-f="tapread">${esc(t("np.tapIdle"))}</span></div>
            <div class="np-field np-blink-row"><span class="np-blink-label">${esc(t("np.beat"))}</span>
              <canvas class="np-blink" width="188" height="16"></canvas></div>
          </fieldset>
          <fieldset class="np-sec">
            <legend>${esc(t("np.secMeter"))}</legend>
            <div class="np-field"><span>${esc(t("np.timeSig"))}</span>
              <span class="np-tsig">
                <input type="number" data-f="tnum" min="1" max="16" value="4">
                <span class="np-tsig-sep">/</span>
                <select data-f="tden">${DEN_OPTIONS.map((d) =>
                  `<option value="${d}"${d === 4 ? " selected" : ""}>${d}</option>`).join("")}</select>
              </span></div>
            <label class="np-field"><span>${esc(t("np.rowsPerBeat"))}</span>
              <input type="number" data-f="rpb" min="1" max="16" value="4"></label>
            <div class="np-field np-derived"><span></span>
              <span class="dim" data-f="rpbar"></span></div>
          </fieldset>
          <fieldset class="np-sec">
            <legend>${esc(t("np.secTuning"))}</legend>
            <div class="np-field"><span>${esc(t("np.baseNote"))}</span>
              <span class="np-chips" data-f="base">${BASE_NOTES.map((b, i) =>
                `<button type="button" class="np-chip${i === baseSel ? " sel" : ""}" data-base="${i}">${b.label}</button>`).join("")}</span></div>
            <label class="np-field"><span>${esc(t("np.frequency"))}</span>
              <span class="np-freq"><input type="number" data-f="freq" min="0" step="0.0001" value="440"> Hz</span></label>
          </fieldset>
          <fieldset class="np-sec">
            <legend>${esc(t("np.secMeta"))}</legend>
            <label class="np-field"><span>${esc(t("np.name"))}</span>
              <input type="text" data-f="name" maxlength="63" value="${esc(t("np.untitled"))}"></label>
            <label class="np-field"><span>${esc(t("np.composer"))}</span>
              <input type="text" data-f="comp" maxlength="63" value=""></label>
            <label class="np-field"><span>${esc(t("np.copyright"))}</span>
              <input type="text" data-f="copy" maxlength="63" value=""></label>
          </fieldset>
          <fieldset class="np-sec">
            <legend>${esc(t("np.secLayout"))}</legend>
            <div class="np-field"><span>${esc(t("np.channels"))}</span>
              <span class="np-chips" data-f="chan">
                <button type="button" class="np-chip sel" data-chan="32">32</button>
                <button type="button" class="np-chip" data-chan="64">64</button>
              </span></div>
            <div class="np-field"><span>${esc(t("np.panning"))}</span>
              <span class="np-chips" data-f="pan">
                <button type="button" class="np-chip sel" data-pan="0">${esc(t("proj.surroundStereo"))}</button>
                <button type="button" class="np-chip" data-pan="1">${esc(t("proj.surroundPlanar"))}</button>
                <button type="button" class="np-chip" data-pan="2">${esc(t("proj.surroundSpatial"))}</button>
              </span></div>
            <p class="np-derived dim" data-f="panhint"></p>
          </fieldset>
        </div>
        <div class="np-col np-col-right">
          <fieldset class="np-sec np-sec-grow">
            <legend>${esc(t("np.secNotation"))}</legend>
            <div class="np-notelist" data-f="notes" tabindex="0">${NOTE_PRESETS.map((p, i) =>
              `<div class="np-note${i === noteSel ? " sel" : ""}" data-note="${i}">
                 <span class="np-note-badge np-badge-${p.t || "raw"}">${TYPE_LABEL[p.t] ?? "·"}</span>
                 <span class="np-note-name">${esc(p.name)}</span></div>`).join("")}</div>
          </fieldset>
          <fieldset class="np-sec">
            <legend>${esc(t("np.secPreview"))}</legend>
            <div class="np-preview" data-f="preview"></div>
          </fieldset>
        </div>
      </div>
      <div class="modal-buttons">
        <button class="np-ok">${esc(t("common.create"))}</button>
        <button class="np-cancel">${esc(t("common.cancel"))}</button>
      </div>`;

    document.body.appendChild(dlg);
    const q = (sel) => dlg.querySelector(sel);
    const inp = (f) => dlg.querySelector(`[data-f="${f}"]`);

    // ── value getters ──
    const beatPri = () => clampInt(inp("rpb").value, 1, 16, 4);
    const timeNum = () => clampInt(inp("tnum").value, 1, 16, 4);
    const beatSec = () => Math.min(255, beatPri() * timeNum());
    const bpmVal = () => clampInt(inp("bpm").value, 25, 535, 125);
    const spdVal = () => clampInt(inp("spd").value, 1, 127, 6);
    const curFreq = () => {
      const n = parseFloat(inp("freq").value);
      return isNaN(n) || n <= 0 ? BASE_NOTES[baseSel].freq : n;
    };

    // ── row-highlight preview: two columns of pattern rows tinted by the beat
    //    divisions, exactly like the Timeline gutter/banding. ──
    const PREV_ROWS = 16, PREV_COLS = 2;
    function drawPreview() {
      const bp = beatPri(), bs = beatSec();
      const host = inp("preview");
      let html = "";
      for (let col = 0; col < PREV_COLS; col++) {
        html += '<div class="np-prev-col">';
        for (let r = 0; r < PREV_ROWS; r++) {
          const row = col * PREV_ROWS + r;
          const isBar = row % bs === 0;
          const isBeat = row % bp === 0;
          const cls = isBar ? "bar" : isBeat ? "beat" : "";
          html += `<div class="np-prev-row ${cls}">${row.toString(16).toUpperCase().padStart(2, "0")}</div>`;
        }
        html += "</div>";
      }
      host.innerHTML = html;
    }

    function drawDerived() {
      inp("rpbar").textContent = t("np.rowsPerBar", { n: beatSec() });
    }

    // ── blinkenlights: a strip whose length = the tick speed, a cursor
    //    advancing one LED per tick (rate = BPM), and a beat lamp lit on every
    //    notated-beat row. Purely a live BPM×speed preview. ──
    const canvas = q(".np-blink");
    const cx = canvas.getContext("2d");
    const css = getComputedStyle(dlg);
    const COL = {
      off: css.getPropertyValue("--meter-bg").trim() || "#2a2f3a",
      tick: css.getPropertyValue("--accent").trim() || "#ffc043",
      beatOn: css.getPropertyValue("--meter").trim() || "#8be400",
    };
    let blinkTick = 0;
    function drawBlinken() {
      const w = canvas.width, h = canvas.height;
      const spd = spdVal(), bp = beatPri();
      const row = Math.floor(blinkTick / spd);
      const tickInRow = blinkTick % spd;
      const onBeat = row % bp === 0;
      cx.clearRect(0, 0, w, h);
      // beat lamp (left)
      const r = h / 2 - 1;
      cx.fillStyle = onBeat ? COL.beatOn : COL.off;
      cx.beginPath(); cx.arc(r + 1, h / 2, r, 0, Math.PI * 2); cx.fill();
      // tick strip
      const x0 = h + 4;
      const stripW = w - x0;
      const seg = stripW / Math.max(1, spd);
      for (let i = 0; i < spd; i++) {
        cx.fillStyle = i === tickInRow ? COL.tick : COL.off;
        const cxp = x0 + i * seg + seg / 2;
        cx.beginPath();
        cx.arc(cxp, h / 2, Math.min(r, seg / 2 - 0.5), 0, Math.PI * 2);
        cx.fill();
      }
    }

    // animation loop (rAF, tempo-accurate: 2.5/BPM seconds per tick)
    let raf = 0, lastMs = 0, accMs = 0;
    function frame(ms) {
      if (!lastMs) lastMs = ms;
      let dt = ms - lastMs; lastMs = ms;
      if (dt < 0) dt = 0;
      const tickMs = 2500 / bpmVal();
      accMs += dt;
      if (accMs > tickMs * 8) accMs = tickMs; // no long catch-up burst
      let advanced = false;
      while (accMs >= tickMs) { accMs -= tickMs; blinkTick = (blinkTick + 1) & 0x7fffffff; advanced = true; }
      if (advanced) drawBlinken();
      raf = requestAnimationFrame(frame);
    }

    // ── tap tempo: the BPM field follows the beat you tap (the button, or
    //    Space anywhere the key isn't a character someone means to type). Each
    //    tap also re-phases the beat lamp above, so the preview blinks along
    //    with your tapping. A pause starts a new count. ──
    const taps = [];
    let tapTimer = 0, tapFlash = 0;
    function tapReset() {
      taps.length = 0;
      clearTimeout(tapTimer); tapTimer = 0;
      inp("tapread").textContent = t("np.tapIdle");
    }
    function tap() {
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (taps.length && now - taps[taps.length - 1] > tapResetMs(taps)) taps.length = 0;
      taps.push(now);
      if (taps.length > TAP_MAX) taps.shift();
      applyTap();
      clearTimeout(tapTimer);
      tapTimer = setTimeout(tapReset, tapResetMs(taps));
      // flash the button, and start the preview beat on this tap
      const btn = inp("tap");
      btn.classList.add("hit");
      clearTimeout(tapFlash);
      tapFlash = setTimeout(() => btn.classList.remove("hit"), 90);
      blinkTick = 0; accMs = 0; drawBlinken();
    }
    /** Write the tapped tempo into the BPM field. Also re-run when the meter or
     *  the speed changes under a live count — those are what the beat the user
     *  is tapping is made of. */
    function applyTap() {
      const a = tapAnalyse(taps, beatPri(), spdVal());
      if (!a) { inp("tapread").textContent = t("np.tapWait"); return; }
      inp("bpm").value = String(a.bpm);
      inp("tapread").textContent = t("np.tapRead", { bpm: a.tapBpm.toFixed(1), n: taps.length });
    }

    // ── selection helpers ──
    function selectBase(i) {
      baseSel = i;
      dlg.querySelectorAll("[data-base]").forEach((el) =>
        el.classList.toggle("sel", +el.dataset.base === i));
      if (freqAuto) inp("freq").value = String(BASE_NOTES[i].freq);
    }
    function selectChan(v) {
      dlg.querySelectorAll("[data-chan]").forEach((el) =>
        el.classList.toggle("sel", el.dataset.chan === String(v)));
    }
    function selectNote(i) {
      noteSel = i;
      dlg.querySelectorAll("[data-note]").forEach((el) =>
        el.classList.toggle("sel", +el.dataset.note === i));
      const el = dlg.querySelector(`[data-note="${i}"]`);
      el?.scrollIntoView({ block: "nearest" });
    }
    function curChan() {
      return dlg.querySelector("[data-chan].sel")?.dataset.chan === "64" ? 64 : 32;
    }
    function curPan() {
      return +(dlg.querySelector("[data-pan].sel")?.dataset.pan ?? 0);
    }
    /** A surround project is born in format version 3 (the wide cell, §5.5),
     *  which nothing can read back down to version 2 — say so BEFORE creating
     *  it rather than in a dialog afterwards. */
    function selectPan(v) {
      dlg.querySelectorAll("[data-pan]").forEach((el) =>
        el.classList.toggle("sel", el.dataset.pan === String(v)));
      inp("panhint").textContent = +v === 0 ? "" : t("np.panHintV3");
    }

    // ── wiring ──
    dlg.querySelectorAll("[data-base]").forEach((el) =>
      el.addEventListener("click", () => selectBase(+el.dataset.base)));
    dlg.querySelectorAll("[data-chan]").forEach((el) =>
      el.addEventListener("click", () => selectChan(el.dataset.chan)));
    dlg.querySelectorAll("[data-pan]").forEach((el) =>
      el.addEventListener("click", () => selectPan(el.dataset.pan)));
    dlg.querySelectorAll("[data-note]").forEach((el) =>
      el.addEventListener("click", () => selectNote(+el.dataset.note)));

    inp("freq").addEventListener("input", () => { freqAuto = false; });
    for (const f of ["rpb", "tnum"]) inp(f).addEventListener("input", () => {
      drawDerived(); drawPreview();
      if (taps.length >= 2) applyTap(); // keep the tapped beat, new row count
    });
    inp("spd").addEventListener("input", () => { if (taps.length >= 2) applyTap(); });
    inp("bpm").addEventListener("input", tapReset); // typed BPM wins over a count
    inp("tap").addEventListener("click", (e) => { e.preventDefault(); tap(); });

    // arrow-key navigation on the notation list
    inp("notes").addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        selectNote(Math.max(0, Math.min(NOTE_PRESETS.length - 1, noteSel + (e.key === "ArrowDown" ? 1 : -1))));
      }
    });

    // ── close / result ──
    const finish = (result) => {
      cancelAnimationFrame(raf);
      clearTimeout(tapTimer);
      clearTimeout(tapFlash);
      dlg.close();
      dlg.remove();
      resolve(result);
    };
    function buildResult() {
      return {
        name: inp("name").value,
        composer: inp("comp").value,
        copyright: inp("copy").value,
        channels: curChan(),
        surroundModel: curPan(),
        bpm: bpmVal(),
        tickRate: spdVal(),
        notation: NOTE_PRESETS[noteSel].index,
        beatPri: beatPri(),
        beatSec: beatSec(),
        timeSigNum: timeNum(),
        timeSigDen: DEN_OPTIONS[inp("tden").selectedIndex],
        baseNote: BASE_NOTES[baseSel].note,
        baseFreq: curFreq(),
      };
    }
    q(".np-ok").addEventListener("click", (e) => { e.preventDefault(); finish(buildResult()); });
    q(".np-cancel").addEventListener("click", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("keydown", (e) => {
      e.stopPropagation(); // don't leak piano/transport keys while modal is up
      // Space taps the tempo — everywhere except a text field (where it is a
      // character) and a button (where the browser's own activation runs it,
      // which is how the Tap button itself, and only it, taps on Space).
      if (e.code === "Space" && !isTypingTarget(e.target) && e.target.tagName !== "BUTTON") {
        e.preventDefault();
        if (!e.repeat) tap();
        return;
      }
      // Enter submits, except inside the notation list (arrows drive it) and
      // on the buttons (their own click handler runs).
      if (e.key === "Enter" && e.target.tagName !== "BUTTON" && e.target !== inp("notes")) {
        e.preventDefault(); finish(buildResult());
      }
    });

    // ── first paint ──
    drawDerived();
    drawPreview();
    drawBlinken();
    dlg.showModal();
    // reveal the default-selected notation (the list opens mid-way down)
    const selEl = dlg.querySelector(".np-note.sel");
    if (selEl) {
      const list = inp("notes");
      list.scrollTop = selEl.offsetTop - list.clientHeight / 2 + selEl.clientHeight / 2;
    }
    inp("name").focus();
    inp("name").select();
    raf = requestAnimationFrame(frame);
  });
}

/** True where a space is a character the user meant to type (the metadata
 *  fields). A number input takes no spaces, so Space there taps instead. */
function isTypingTarget(el) {
  if (!el) return false;
  if (el.tagName === "TEXTAREA") return true;
  return el.tagName === "INPUT" && el.type !== "number";
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
