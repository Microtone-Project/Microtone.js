// The audio profiler: a floating panel that reads the audio system's own
// timings, so a machine that crackles can be diagnosed where it crackles. It
// is opened from the top bar's audio badge (or by ?profile=1 at load), in the
// browser and in the desktop app alike, and costs nothing while it is shut:
// AudioSystem.setProfiling() starts and stops the measuring itself.
//
// The engine is the C one, compiled to WebAssembly, and it runs in one of two
// places: in the audio thread itself (a page that is not cross-origin isolated,
// the Linux desktop app), or in a render Worker that keeps a queue of audio
// full while the audio thread only copies it out (Tier 2). The panel says
// which, times the engine where it runs, and reads the dropouts that matter
// there: the audio thread's overruns, or the queue running dry.
//
// The headline question: is something going over budget, and if so is it the
// ENGINE (the song is heavier than this machine renders in real time) or
// everything AROUND it (scheduling, the sample-rate conversion, the meters)?
// profileVerdict() is pure so it can be unit-tested in Node.

import { t } from "./i18n.js";
import { toLayout } from "./zoom.js";
import { setIconLabel } from "./icons.js";

// Sustained mean load above this fraction of real time = little headroom.
export const PF_LOAD_WARN = 0.7;
// Mean load at/above this while glitching = genuine throughput saturation
// (not just bad scheduling). Below it, xruns mean the work is arriving in
// bursts too big for one quantum — spreadable without making the DSP faster.
export const PF_LOAD_SATURATED = 0.85;
// renderChunk taking at least this share of the busy callback = engine-dominated.
export const PF_DSP_SHARE = 0.6;

/**
 * Classify a profiler report. Pure: {tone: "ok"|"warn"|"bad", key}; the
 * panel shows `profiler.verdict.<key>` and `profiler.detail.<key>`.
 *
 * The order matters: a device can be over budget (glitching) yet have plenty of
 * average headroom — that is a burst/scheduling problem, which no faster engine
 * would fix, so it is reported before the engine-bound / overhead-bound split.
 */
export function profileVerdict(p) {
  // Tier 2 (render Worker): the audio thread only copies, so it cannot overrun —
  // the glitch signal is the queue running dry, and the engine's load is the
  // Worker's (p.worker, absent while nothing has been rendered for a while).
  if (p.workerRender) {
    const load = p.worker?.engineFrac ?? 0;
    if ((p.underruns ?? 0) > 0) {
      return load >= PF_LOAD_SATURATED ? { tone: "bad", key: "workerSlow" } : { tone: "bad", key: "workerLate" };
    }
    return load >= PF_LOAD_WARN ? { tone: "warn", key: "workerNear" } : { tone: "ok", key: "workerOk" };
  }

  const load = p.cpuFrac ?? 0;
  const quantumMs = p.quantumMs ?? Infinity;
  const overBudget = (p.xruns ?? 0) > 0 || (p.procMaxMs ?? 0) > quantumMs;
  const dspShare = load > 0 ? (p.renderFrac ?? 0) / load : 0;

  if (!overBudget) {
    if (load < PF_LOAD_WARN) return { tone: "ok", key: "ok" };
    return { tone: "warn", key: dspShare >= PF_DSP_SHARE ? "nearEngine" : "nearOverhead" };
  }
  // Over budget (dropouts). Burstiness first: spare average capacity means the
  // work arrives in lumps, not that there is too much of it.
  if (load < PF_LOAD_SATURATED) return { tone: "bad", key: "bursty" };
  return { tone: "bad", key: dspShare >= PF_DSP_SHARE ? "engine" : "overhead" };
}

function fmt(n, d = 2) {
  return (typeof n === "number" && isFinite(n)) ? n.toFixed(d) : "–";
}
function pct(frac) {
  return (typeof frac === "number" && isFinite(frac)) ? Math.round(frac * 100) + "%" : "–";
}
const mb = (bytes) => fmt((bytes ?? 0) / (1024 * 1024), 1);

/**
 * The rows the panel shows for a report: [[label, value, tone?]]. Pure apart
 * from t(), so the Node test can read what a report says.
 */
export function profileRows(p) {
  const w = p.workerRender ? (p.worker ?? null) : null;
  const engineRate = w?.engineRate ?? p.sampleRate;
  const ctxRate = p.contextSampleRate ?? p.sampleRate;
  const converted = Math.abs((p.step ?? 1) - 1) > 1e-6;
  const memory = w?.memoryBytes ?? p.memoryBytes ?? 0;
  const rows = [
    [t("profiler.engine"), memory > 0 ? t("profiler.engineWasm", { mb: mb(memory) }) : t("profiler.engineWasmIdle")],
    [t("profiler.where"), t(p.workerRender ? "profiler.whereWorker" : "profiler.whereWorklet")],
    [t("profiler.output"), converted
      ? t("profiler.outputConverted", { rate: ctxRate, engine: engineRate })
      : t("profiler.outputNative", { rate: ctxRate })],
    [t("profiler.meters"), t(p.usingSab ? "profiler.metersShared" : "profiler.metersMessages")
      + (p.bundleFallback ? t("profiler.bundle") : "")],
    [t("profiler.clock"), p.hiResClock ? t("profiler.clockFine") : t("profiler.clockCoarse", { ms: p.clockResMs }),
      p.hiResClock ? null : "warn"],
  ];
  if (p.workerRender) {
    if (w) {
      rows.push([t("profiler.engineLoad"), t("profiler.engineLoadValue",
        { pct: pct(w.engineFrac), mean: fmt(w.renderMeanMs), max: fmt(w.renderMaxMs) })]);
      rows.push([t("profiler.voices"), t("profiler.voicesValue", { n: w.peakVoices ?? 0 })]);
      rows.push([t("profiler.queue"), t("profiler.queueValue",
        { low: fmt(w.ringLowMs, 1), target: fmt(w.ringTargetMs, 1), wake: fmt(w.wakeMaxMs, 1) })]);
    } else {
      rows.push([t("profiler.engineLoad"), t("profiler.engineIdle")]);
    }
    const under = p.underruns ?? 0;
    rows.push([t("profiler.dropouts"), under > 0 ? t("profiler.underrunsValue", { n: under }) : t("profiler.none"), under > 0 ? "bad" : null]);
  } else {
    const dspShare = (p.cpuFrac ?? 0) > 0 ? (p.renderFrac ?? 0) / p.cpuFrac : 0;
    rows.push([t("profiler.engineLoad"), (p.renderCount ?? 0) > 0
      ? t("profiler.engineLoadShare", { pct: pct(p.renderFrac), mean: fmt(p.renderMeanMs), max: fmt(p.renderMaxMs), share: pct(dspShare) })
      : t("profiler.engineIdle")]);
    rows.push([t("profiler.voices"), t("profiler.voicesValue", { n: p.peakVoices ?? 0 })]);
  }
  rows.push([t("profiler.audioThread"), t("profiler.audioThreadValue",
    { pct: pct(p.cpuFrac), mean: fmt(p.procMeanMs), max: fmt(p.procMaxMs), budget: fmt(p.quantumMs) })]);
  if (!p.workerRender) {
    const xruns = p.xruns ?? 0;
    rows.push([t("profiler.dropouts"), xruns > 0 ? t("profiler.xrunsValue", { n: xruns }) : t("profiler.none"), xruns > 0 ? "bad" : null]);
  }
  return rows;
}

/**
 * Build the panel. Returns {el, update(profile), destroy()}. Append `el` to
 * the document; call update() from AudioSystem.onProfile. `onClose` runs when
 * the panel's own close button is pressed (the caller stops the measuring).
 */
export function createProfileOverlay({ onClose = null } = {}) {
  const el = document.createElement("div");
  el.className = "profiler";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", t("profiler.title"));
  el.setAttribute("data-profile-overlay", "");

  const head = document.createElement("div");
  head.className = "profiler-head";
  const title = document.createElement("span");
  title.className = "profiler-title";
  title.textContent = t("profiler.title");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "icon-btn profiler-close";
  setIconLabel(close, "close");
  close.title = t("common.close");
  close.setAttribute("aria-label", t("common.close"));
  close.addEventListener("click", () => { el.remove(); onClose?.(); });
  head.append(title, close);

  // Drag by the title bar — pointer events so mouse AND finger (iPad) both work.
  // On first grab, convert the bottom/right anchoring to left/top so it can move
  // freely, then clamp within the viewport.
  let startX = 0, startY = 0, baseLeft = 0, baseTop = 0, elW = 0, elH = 0, dragging = false;
  head.addEventListener("pointerdown", (e) => {
    if (close.contains(e.target)) return; // let the close button click through
    const r = el.getBoundingClientRect();
    el.style.left = toLayout(r.left) + "px";
    el.style.top = toLayout(r.top) + "px";
    el.style.right = "auto";
    el.style.bottom = "auto";
    startX = e.clientX; startY = e.clientY;
    baseLeft = r.left; baseTop = r.top; elW = r.width; elH = r.height;
    dragging = true;
    try { head.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    e.preventDefault();
  });
  head.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const maxX = Math.max(0, window.innerWidth - elW);
    const maxY = Math.max(0, window.innerHeight - elH);
    const nx = Math.min(Math.max(0, baseLeft + (e.clientX - startX)), maxX);
    const ny = Math.min(Math.max(0, baseTop + (e.clientY - startY)), maxY);
    el.style.left = toLayout(nx) + "px";
    el.style.top = toLayout(ny) + "px";
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    try { head.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  };
  head.addEventListener("pointerup", endDrag);
  head.addEventListener("pointercancel", endDrag);

  const body = document.createElement("dl");
  body.className = "profiler-rows";
  const verdict = document.createElement("div");
  verdict.className = "profiler-verdict";
  const detail = document.createElement("p");
  detail.className = "profiler-detail";

  el.append(head, body, verdict, detail);

  // Reports come once a second; the panel is rebuilt only when what it says
  // changed (the frame loop's rule: never write the DOM for nothing).
  let shown = "";
  function update(p) {
    const rows = p ? profileRows(p) : null;
    const v = p ? profileVerdict(p) : null;
    const key = JSON.stringify([rows, v]);
    if (key === shown) return;
    shown = key;
    if (!p) {
      body.replaceChildren();
      verdict.textContent = t("profiler.waiting");
      verdict.removeAttribute("data-tone");
      detail.textContent = "";
      return;
    }
    body.replaceChildren(...rows.flatMap(([label, value, tone]) => {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      if (tone) dd.dataset.tone = tone;
      return [dt, dd];
    }));
    verdict.textContent = t(`profiler.verdict.${v.key}`);
    verdict.dataset.tone = v.tone;
    detail.textContent = t(`profiler.detail.${v.key}`);
  }

  update(null);
  return { el, update, destroy: () => el.remove() };
}
