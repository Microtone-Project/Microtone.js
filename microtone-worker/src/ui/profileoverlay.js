// Dev audio profiler overlay (opt-in via ?profile=1). Renders the worklet's
// rolling per-callback timing so an affected device (e.g. a laggy iPad) can be
// read at a glance. Deliberately self-contained: inline styles only, no app CSS
// or theme dependency, so it looks the same wherever it is dropped in.
//
// The headline question it answers: is the audio thread actually over budget,
// and if so is the ENGINE (renderChunk) the cost — where a WASM rewrite could
// help — or the surrounding OVERHEAD (resample / snapshot / messaging), where
// it would not. profileVerdict() is pure so it can be unit-tested in Node.

import { toLayout } from "./zoom.js";

// Sustained mean load above this fraction of real time = little headroom.
export const PF_LOAD_WARN = 0.7;
// Mean load at/above this while glitching = genuine throughput saturation
// (not just bad scheduling). Below it, xruns mean the work is arriving in
// bursts too big for one quantum — spreadable without making the DSP faster.
export const PF_LOAD_SATURATED = 0.85;
// renderChunk taking at least this share of the busy callback = engine-dominated.
export const PF_DSP_SHARE = 0.6;

/**
 * Classify a profiler report. Pure: {tone: "ok"|"warn"|"bad", label, detail}.
 * `tone` drives the overlay colour; `label`/`detail` are the human verdict.
 *
 * The order matters: a device can be over budget (glitching) yet have plenty of
 * average headroom — that is a burst/scheduling problem, cheaper to fix than the
 * DSP itself, so it is reported before the DSP-bound / overhead-bound split.
 */
export function profileVerdict(p) {
  // Tier 2 (render Worker): the audio thread only copies, so it cannot overrun —
  // the real glitch signal is ring underruns (worker not refilling in time).
  if (p.workerRender) {
    if ((p.underruns ?? 0) > 0) {
      return {
        tone: "bad",
        label: "Ring underrun",
        detail:
          "Rendering runs off the audio thread, but the Worker isn't refilling the " +
          "ring in time — the engine can't keep up with playback. Deepen the ring " +
          "(AR_HIGH_WATER), lighten the song, or move to a faster (WASM) engine.",
      };
    }
    return {
      tone: "ok",
      label: "Off-thread OK",
      detail:
        "Rendering runs in the Worker; the audio thread only resamples + copies, so " +
        "it cannot overrun at any lane count. No ring underruns — playback is clean.",
    };
  }

  const load = p.cpuFrac ?? 0;
  const quantumMs = p.quantumMs ?? Infinity;
  const overBudget = (p.xruns ?? 0) > 0 || (p.procMaxMs ?? 0) > quantumMs;
  const dspShare = load > 0 ? (p.renderFrac ?? 0) / load : 0;

  if (!overBudget) {
    if (load < PF_LOAD_WARN) {
      return {
        tone: "ok",
        label: "Headroom OK",
        detail:
          "The audio thread has spare budget and nothing is glitching. If the app " +
          "still feels laggy, suspect output latency or main-thread jank, not the " +
          "engine.",
      };
    }
    return {
      tone: "warn",
      label: "Near budget",
      detail:
        "High sustained load but no dropouts yet — little margin for heavier songs " +
        "or more voices. " +
        (dspShare >= PF_DSP_SHARE
          ? "The engine is most of the cost, so a faster DSP (WASM) would buy the headroom."
          : "Most cost is outside the engine — check the SAB path and resampler."),
    };
  }

  // Over budget (dropouts). Burstiness first: spare average capacity means the
  // fix is to spread the render, not to make it faster.
  if (load < PF_LOAD_SATURATED) {
    return {
      tone: "bad",
      label: "Bursty overrun",
      detail:
        "Dropouts, but average load is well under 100% — the render arrives in " +
        "bursts too big for one audio quantum. Spread it (smaller render chunk, or " +
        "render off the audio thread) BEFORE any WASM rewrite; that alone should " +
        "clear most of the xruns.",
    };
  }
  if (dspShare >= PF_DSP_SHARE) {
    return {
      tone: "bad",
      label: "DSP-bound",
      detail:
        "Saturated and the engine render dominates the callback. This is the case " +
        "where a WASM rewrite of the hot DSP path could genuinely help.",
    };
  }
  return {
    tone: "bad",
    label: "Overhead-bound",
    detail:
      "Saturated, but most of the callback is spent OUTSIDE the engine (resample / " +
      "snapshot / messaging). A WASM engine rewrite would not fix this — check the " +
      "SAB path and the engine→context resampler first.",
  };
}

const TONE_COLOUR = { ok: "#4ade80", warn: "#fbbf24", bad: "#f87171" };

function fmt(n, d = 2) {
  return (typeof n === "number" && isFinite(n)) ? n.toFixed(d) : "–";
}
function pct(frac) {
  return (typeof frac === "number" && isFinite(frac)) ? Math.round(frac * 100) + "%" : "–";
}

/**
 * Build the overlay. Returns {el, update(profile), destroy()}. Append `el` to
 * the document; call update() from AudioSystem.onProfile.
 */
export function createProfileOverlay() {
  const el = document.createElement("div");
  el.setAttribute("data-profile-overlay", "");
  Object.assign(el.style, {
    position: "fixed", bottom: "8px", right: "8px", zIndex: "99999",
    font: "12px/1.45 ui-monospace, Menlo, Consolas, monospace",
    color: "#e5e7eb", background: "rgba(10,12,18,0.92)",
    border: "1px solid rgba(255,255,255,0.15)", borderRadius: "8px",
    padding: "10px 12px", maxWidth: "340px", pointerEvents: "auto",
    boxShadow: "0 6px 24px rgba(0,0,0,0.45)", userSelect: "text",
    whiteSpace: "pre-wrap",
  });

  const title = document.createElement("div");
  Object.assign(title.style, {
    fontWeight: "700", marginBottom: "6px", display: "flex",
    justifyContent: "space-between", gap: "8px",
    cursor: "move", userSelect: "none", touchAction: "none",
  });
  const titleText = document.createElement("span");
  titleText.textContent = "Audio profiler";
  const closeBtn = document.createElement("span");
  closeBtn.textContent = "\u00d7"; // Latin-1 ×, not a dingbat: this file stays
                                  // self-contained, so it cannot use the SVG
                                  // icon set — and × is in every font anyway.
  Object.assign(closeBtn.style, { cursor: "pointer", opacity: "0.6", touchAction: "none" });
  closeBtn.addEventListener("click", () => el.remove());
  title.append(titleText, closeBtn);

  // Drag by the title bar — pointer events so mouse AND finger (iPad) both work.
  // On first grab, convert the bottom/right anchoring to left/top so it can move
  // freely, then clamp within the viewport.
  let startX = 0, startY = 0, baseLeft = 0, baseTop = 0, elW = 0, elH = 0, dragging = false;
  title.addEventListener("pointerdown", (e) => {
    if (closeBtn.contains(e.target)) return; // let the close button click through
    const r = el.getBoundingClientRect();
    el.style.left = toLayout(r.left) + "px";
    el.style.top = toLayout(r.top) + "px";
    el.style.right = "auto";
    el.style.bottom = "auto";
    startX = e.clientX; startY = e.clientY;
    baseLeft = r.left; baseTop = r.top; elW = r.width; elH = r.height;
    dragging = true;
    try { title.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    e.preventDefault();
  });
  title.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const maxX = Math.max(0, window.innerWidth - elW);
    const maxY = Math.max(0, window.innerHeight - elH);
    const nx = Math.min(Math.max(0, baseLeft + (e.clientX - startX)), maxX);
    const ny = Math.min(Math.max(0, baseTop + (e.clientY - startY)), maxY);
    el.style.left = nx + "px";
    el.style.top = ny + "px";
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    try { title.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  };
  title.addEventListener("pointerup", endDrag);
  title.addEventListener("pointercancel", endDrag);

  const body = document.createElement("div");
  const verdict = document.createElement("div");
  Object.assign(verdict.style, { marginTop: "8px", paddingTop: "8px", borderTop: "1px solid rgba(255,255,255,0.12)", fontWeight: "600" });
  const verdictDetail = document.createElement("div");
  Object.assign(verdictDetail.style, { marginTop: "4px", fontWeight: "400", opacity: "0.85" });

  el.append(title, body, verdict, verdictDetail);

  function update(p) {
    if (!p) { body.textContent = "waiting for audio…"; return; }
    const dspShare = (p.cpuFrac ?? 0) > 0 ? (p.renderFrac ?? 0) / p.cpuFrac : 0;
    const resample = Math.abs((p.step ?? 1) - 1) > 1e-6;
    const path = p.usingSab ? "SAB (shared mem)" : "postMessage";
    const clock = p.hiResClock
      ? "hi-res (performance.now)"
      : "COARSE ⚠ " + p.clockResMs + "ms — per-call ms approx, trust load% + xruns";
    const rows = [
      `ctx rate     ${p.contextSampleRate ?? p.sampleRate} Hz` + (resample ? `  (resample ×${fmt(p.step, 3)})` : "  (no resample)"),
      `snapshot     ${path}${p.bundleFallback ? "  [bundle worklet]" : ""}`,
      `render       ${p.workerRender ? "Worker (off audio thread)" : "in-worklet"}`,
      `clock        ${clock}`,
      ``,
      `load (mean)  ${pct(p.cpuFrac)}   of real time (audio thread)`,
      `callback     mean ${fmt(p.procMeanMs)}  max ${fmt(p.procMaxMs)} ms   / ${fmt(p.quantumMs)} ms budget`,
      `  xruns/win  ${p.xruns ?? 0}` + ((p.xruns ?? 0) > 0 ? "  ← GLITCHING" : ""),
    ];
    if (p.workerRender) {
      rows.push(`  underruns  ${p.underruns ?? 0}` + ((p.underruns ?? 0) > 0 ? "  ← RING STARVED" : "  (ring OK)"));
    } else {
      rows.push(`renderChunk  mean ${fmt(p.renderMeanMs)}  max ${fmt(p.renderMaxMs)} ms   (${pct(dspShare)} of busy time)`);
      rows.push(`voices peak  ${p.peakVoices ?? 0}`);
    }
    body.textContent = rows.join("\n");

    const v = profileVerdict(p);
    verdict.textContent = v.label;
    verdict.style.color = TONE_COLOUR[v.tone] || "#e5e7eb";
    verdictDetail.textContent = v.detail;
  }

  update(null);
  return { el, update, destroy: () => el.remove() };
}
