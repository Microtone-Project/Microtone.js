// Instrument sample-marker editor (Instruments tab) — play / loop / sustain
// markers of ONE instrument's record (draggable markers + spinners + loop
// mode), written through setInstBytesOp on bytes 8..14 of that slot only.
// Edits go through the undo stack as they happen (so playback hears them);
// Apply keeps them, Cancel (or Esc) rolls the stack back to the open depth.
//
// The AUDIO of a sample is not edited here — that is the Sample Lab's job
// (samplelab.js), the one editor for waveform content since item 109. This
// modal only moves the markers of the slot it was opened on, which is per
// instrument and therefore not something the Lab can own.

import { setInstBytesOp, syncBaseStereoPatchOp, compositeOp } from "../../doc/ops.js";
import { resolveLoopRegion, residualDb, LOOP_POLICIES } from "../../doc/looptune.js";
import { themeColors } from "../theme.js";
import { unescapeName } from "../names.js";
import { t } from "../i18n.js";
import { setIconLabel } from "../icons.js";
import { JAM_VOICES, JAM_VOICE_BASE } from "../../engine/constants.js";

const W = 720, H = 200;

// Marker preview goes on the jam bank's top slot (item 140): it is not a song
// channel, so the preview is neither muted by the desk nor able to cut what the
// song is playing — and the piano keyboard hands out the bank from slot 0 up,
// so a held chord has to run all the way round before it reaches this one.
const AUDITION_VOICE = JAM_VOICE_BASE + JAM_VOICES - 1;

const MARKERS = [
  { key: "playStart", labelKey: "smp.play", lo: 8, colorKey: "accent2" },
  { key: "loopStart", labelKey: "smp.loopStart", lo: 10, colorKey: "accent" },
  { key: "loopEnd", labelKey: "smp.loopEnd", lo: 12, colorKey: "accent" },
];

/** Instruments-tab editor for slot's play/loop/sustain record fields. */
export function openInstSampleEditor(store, slot) {
  return new Promise((resolve) => {
    const doc = store.doc;
    const inst = () => doc.instruments[slot & 0x3ff];
    const len = inst().sampleLength;
    const ptr = inst().samplePtr;
    const shell = buildShell(store, {
      title: t("smp.editInst", {
        slot: slot.toString(16).toUpperCase().padStart(3, "0"),
        name: unescapeName(doc.instrumentName(slot)) || "(unnamed)",
      }),
      info: `${len} bytes · ${inst().samplingRate} Hz@C4 · ` + t("smp.markersNote"),
      className: "sample-editor",
      resolve,
    });

    const fields = () => ({
      playStart: inst().samplePlayStart,
      loopStart: inst().sampleLoopStart,
      loopEnd: inst().sampleLoopEnd,
      loopMode: inst().loopMode & 3,
      sustain: (inst().loopMode & 4) !== 0,
    });

    // field row: three spinners + loop mode + sustain
    const fieldRow = document.createElement("div");
    fieldRow.className = "smp-fields";
    const spinners = {};
    for (const m of MARKERS) {
      const lab = document.createElement("label");
      lab.append(t(m.labelKey) + " ");
      const num = document.createElement("input");
      num.type = "number";
      num.min = 0;
      num.max = len;
      num.addEventListener("change", () => {
        applyFields({ [m.key]: Math.max(0, Math.min(len, Math.round(Number(num.value) || 0))) });
      });
      spinners[m.key] = num;
      lab.appendChild(num);
      fieldRow.appendChild(lab);
    }
    const modeLab = document.createElement("label");
    modeLab.append(t("smp.loop"));
    const modeSel = document.createElement("select");
    for (const [v, name] of [[0, t("smp.loopOff")], [1, t("smp.loopForward")],
                             [2, t("smp.loopPingpong")], [3, t("smp.loopOneshot")]]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = name;
      modeSel.appendChild(o);
    }
    modeSel.addEventListener("change", () => applyFields({ loopMode: Number(modeSel.value) }));
    modeLab.appendChild(modeSel);
    const susLab = document.createElement("label");
    const susBox = document.createElement("input");
    susBox.type = "checkbox";
    susBox.addEventListener("change", () => applyFields({ sustain: susBox.checked }));
    susLab.append(susBox, t("smp.sustain"));
    fieldRow.append(modeLab, susLab);

    const opRow = document.createElement("div");
    opRow.className = "smp-ops";
    // Preview the BASE sample of this slot with the live-edited markers (bug
    // #65: even when the slot is a metainstrument layer child with patches).
    opRow.appendChild(shell.makeAuditionButton(() => {
      const f = fields();
      const i = inst();
      return {
        ptr, len, rate: i.samplingRate, playStart: f.playStart,
        loopStart: f.loopStart, loopEnd: f.loopEnd,
        loopMode: (f.loopMode & 3) | (f.sustain ? 4 : 0),
        detune: i.sampleDetuneSigned,
      };
    }));

    // ── auto loop resolver (item 176) ──
    // Three policies, one search each, and the numbers it finds land in the
    // spinners as an ordinary marker edit — so the audition button beside it
    // plays the result, and Cancel or Ctrl+Z takes it back. It NEVER writes on
    // its own: only picking a policy or pressing Find runs a search, which is
    // what makes it safe to type over the answer afterwards.
    const autoLab = document.createElement("label");
    autoLab.className = "smp-auto";
    autoLab.append(t("smp.auto") + " ");
    const autoSel = document.createElement("select");
    for (const p of LOOP_POLICIES) {
      const o = document.createElement("option");
      o.value = p;
      o.textContent = t(`smp.auto.${p}`);
      autoSel.appendChild(o);
    }
    autoSel.value = "balanced";
    autoSel.title = t("smp.autoTitle");
    autoLab.appendChild(autoSel);
    const autoBtn = document.createElement("button");
    autoBtn.textContent = t("smp.autoFind");
    autoBtn.title = t("smp.autoFindTitle");
    const autoStatus = document.createElement("span");
    autoStatus.className = "smp-auto-status";
    opRow.append(autoLab, autoBtn, autoStatus);

    let resolverWriting = false;   // suppresses the stale-status clear below
    let resolving = false;
    autoSel.addEventListener("change", () => runResolver());
    autoBtn.addEventListener("click", (e) => { e.preventDefault(); runResolver(); });

    async function runResolver() {
      if (resolving) return;
      const f = fields();
      if (f.loopMode !== 1 && f.loopMode !== 2) { autoStatus.textContent = t("smp.autoNeedMode"); return; }
      resolving = true;
      autoSel.disabled = autoBtn.disabled = true;
      autoStatus.textContent = t("smp.autoWorking");
      // One frame for that label to reach the screen before the search takes
      // the thread — a dialog that freezes silently reads as broken. RACED with
      // a timer, never awaited alone: a hidden tab (or a headless render) stops
      // firing frames altogether, and a search that waits for one that never
      // comes leaves the editor stuck on "searching…" with its controls off.
      await new Promise((r) => {
        let done = false;
        const go = () => { if (!done) { done = true; r(); } };
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(go);
        setTimeout(go, 32);
      });
      let res = null;
      try {
        res = resolveLoopRegion(doc.sampleBin.subarray(ptr, ptr + len), {
          mode: f.loopMode, policy: autoSel.value,
          playStart: f.playStart, rate: inst().samplingRate || 32000,
        });
      } catch (err) {
        console.warn("loop resolver:", err);
      }
      resolving = false;
      autoSel.disabled = autoBtn.disabled = false;
      if (!res) { autoStatus.textContent = t("smp.autoNone"); return; }
      resolverWriting = true;
      applyFields({ loopStart: res.loopStart, loopEnd: res.loopEnd });
      resolverWriting = false;
      autoStatus.textContent = describeResult(res);
    }

    shell.dlg.insertBefore(fieldRow, shell.btnRow);
    shell.dlg.insertBefore(opRow, shell.btnRow);

    // ── field writes: one setInstBytesOp per change/drag-step ──
    function applyFields(change, gestureId = null) {
      // A hand edit makes the resolver's readout describe numbers that are no
      // longer on screen, so it goes rather than lies. The numbers stay.
      if (!resolverWriting) autoStatus.textContent = "";
      const f = { ...fields(), ...change };
      // the edited marker wins; the other loop end follows to keep start ≤ end
      if ("loopStart" in change && f.loopStart > f.loopEnd) f.loopEnd = f.loopStart;
      if ("loopEnd" in change && f.loopEnd < f.loopStart) f.loopStart = f.loopEnd;
      const modeByte = (inst().loopMode & 0x10) | (f.sustain ? 4 : 0) | (f.loopMode & 3);
      const pairs = [
        [8, f.playStart & 0xff], [9, (f.playStart >>> 8) & 0xff],
        [10, f.loopStart & 0xff], [11, (f.loopStart >>> 8) & 0xff],
        [12, f.loopEnd & 0xff], [13, (f.loopEnd >>> 8) & 0xff],
        [14, modeByte],
      ];
      const bytesOp = setInstBytesOp(slot, pairs, gestureId);
      // Item 180: these bytes are the base record's copy of the sample's own
      // geometry — for a stereo instrument the base stereo patch's duplicate
      // copy is what actually plays, so it must move with the markers too.
      const sync = syncBaseStereoPatchOp(doc, slot, {
        samplePlayStart: f.playStart, sampleLoopStart: f.loopStart,
        sampleLoopEnd: f.loopEnd, loopMode: modeByte,
      }, gestureId);
      store.undo.apply(sync ? compositeOp([bytesOp, sync], gestureId) : bytesOp);
      paint();
    }

    function paint() {
      const f = fields();
      paintWaveform(shell.canvas, doc.sampleBin, ptr, len, {
        loopStart: f.loopMode !== 0 ? f.loopStart : 0,
        loopEnd: f.loopMode !== 0 ? f.loopEnd : 0,
        markers: MARKERS.map((m) => ({ ...m, pos: f[m.key] })),
      });
      for (const m of MARKERS) spinners[m.key].value = f[m.key];
      modeSel.value = f.loopMode;
      susBox.checked = f.sustain;
      // Modes 0 and 3 play straight to the end — there is no seam to resolve.
      const loops = f.loopMode === 1 || f.loopMode === 2;
      autoSel.disabled = autoBtn.disabled = !loops || resolving;
      autoLab.title = autoBtn.title = loops ? t("smp.autoFindTitle") : t("smp.autoNeedMode");
    }
    paint();

    // ── marker dragging ──
    let drag = null; // {key, gestureId}
    const markerAt = (x) => {
      const f = fields();
      let best = null, bestDist = 6; // px grab radius
      for (const m of MARKERS) {
        const mx = (f[m.key] / len) * W;
        const d = Math.abs(x - mx);
        if (d < bestDist) { bestDist = d; best = m.key; }
      }
      return best;
    };
    shell.canvas.addEventListener("pointerdown", (e) => {
      const rect = shell.canvas.getBoundingClientRect();
      const key = markerAt(e.clientX - rect.left);
      if (!key) return;
      drag = { key, gestureId: `smpdrag${Date.now()}` };
      shell.canvas.setPointerCapture(e.pointerId);
    });
    shell.canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const rect = shell.canvas.getBoundingClientRect();
      const pos = Math.max(0, Math.min(len,
        Math.round(((e.clientX - rect.left) / W) * len)));
      applyFields({ [drag.key]: pos }, drag.gestureId);
    });
    shell.canvas.addEventListener("pointerup", () => { drag = null; });

    shell.show();
  });
}

const fmtDb = (rel) => {
  const db = residualDb(rel);
  return Number.isFinite(db) ? db.toFixed(1) : "−∞";
};

/**
 * One line saying what the search kept and what it left behind. The seam is
 * reported in dB relative to the sound carrying it, because that is how a click
 * is heard — the same step is nothing under a loud sustain and a tick over a
 * decayed tail. Ping-pong reports BOTH turning points, since its two ends are
 * independent and one of them can be the bad one.
 */
function describeResult(res) {
  const bytes = res.loopEnd - res.loopStart;
  let s = res.mode === 2
    ? t("smp.autoPP", { bytes, a: fmtDb(res.relStart), b: fmtDb(res.relEnd) })
    : res.cycles >= 1
      ? t("smp.autoFwd", { bytes, cycles: res.cycles.toFixed(1), db: fmtDb(res.rel) })
      : t("smp.autoFwdNP", { bytes, db: fmtDb(res.rel) });
  const widerBy = res.widest ? (res.widest.loopEnd - res.widest.loopStart) / bytes : 1;
  if (!res.metBudget) s += t("smp.autoOverBudget");
  // Only worth saying when the region on offer is substantially bigger, and
  // WITHOUT its seam figure: a crossfade removes that seam rather than leaving
  // it, so quoting the number reads as the quality the longer loop would have.
  else if (widerBy >= 1.5) {
    s += t("smp.autoWider", { bytes: res.widest.loopEnd - res.widest.loopStart });
  }
  return s;
}

// ── shared dialog shell: title/info/canvas + Apply/Cancel with undo rollback ──
function buildShell(store, { title, info, className, resolve }) {
  const dlg = document.createElement("dialog");
  dlg.className = `modal ${className}`;
  const h = document.createElement("h3");
  h.textContent = title;
  const infoEl = document.createElement("p");
  infoEl.className = "dim";
  infoEl.textContent = info;
  const canvas = document.createElement("canvas");
  canvas.className = "smp-canvas";

  const btnRow = document.createElement("div");
  btnRow.className = "modal-buttons";
  const applyBtn = document.createElement("button");
  applyBtn.textContent = t("common.apply");
  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = t("common.cancel");
  btnRow.append(applyBtn, cancelBtn);

  dlg.append(h, infoEl, canvas, btnRow);
  document.body.appendChild(dlg);

  // Cancel = undo everything applied while the editor was open. Sound because
  // coalescing only merges ops with a NON-null shared gestureId — a modal edit
  // can never fold into an entry that predates the open.
  const depth0 = store.undo?.undoStack.length ?? 0;
  let auditioning = false;
  const finish = (rollback) => {
    if (auditioning) store.audio?.jamStopVoice(0, AUDITION_VOICE);
    if (rollback && store.undo) {
      while (store.undo.undoStack.length > depth0) store.undo.undo();
    }
    dlg.close();
    dlg.remove();
    resolve();
  };
  applyBtn.addEventListener("click", (e) => { e.preventDefault(); finish(false); });
  cancelBtn.addEventListener("click", (e) => { e.preventDefault(); finish(true); });
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(true); });
  dlg.addEventListener("keydown", (e) => e.stopPropagation());

  /** Engine audition on the jam bank; toggles play/stop. `getSpec` returns
   *  the EXACT pooled sample to play ({ptr,len,rate,loop...}) at click time, so
   *  the preview follows live marker edits and plays the wave on screen rather
   *  than whatever a metainstrument would map C4 to (bug #65). */
  const makeAuditionButton = (getSpec) => {
    const playBtn = document.createElement("button");
    setIconLabel(playBtn, "play", t("smp.audition"));
    playBtn.title = t("smp.auditionTitle");
    playBtn.addEventListener("click", async () => {
      await window.__microtoneEnsureAudio?.();
      const audio = store.audio;
      if (!audio) return;
      if (auditioning) {
        audio.jamStopVoice(0, AUDITION_VOICE);
        setIconLabel(playBtn, "play", t("smp.audition"));
        auditioning = false;
      } else {
        const spec = getSpec?.();
        if (!spec || !(spec.len > 0)) return;
        audio.jamSample(0, AUDITION_VOICE, 0x5000, spec);
        setIconLabel(playBtn, "stop", t("smp.auditionStop"));
        auditioning = true;
      }
    });
    return playBtn;
  };

  return { dlg, canvas, btnRow, makeAuditionButton, show: () => dlg.showModal() };
}

// ── waveform painter (centre-anchored bars, loop shading, markers) ──
/**
 * Draw the pool span at `ptr`. One lane: this editor shows a slot's BASE record,
 * and a base record has no channel block — a stereo pair only exists through an
 * Ixmp patch, which the Instruments tab's patch panel and the Sample Lab draw.
 * Every column is a bar off the centre line, as every sample display draws.
 */
function paintWaveform(canvas, bin, ptr, len, { loopStart, loopEnd, markers }) {
  const C = themeColors();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = C.cvBg;
  ctx.fillRect(0, 0, W, H);
  if (len <= 0) return;

  if (loopEnd > loopStart) {
    ctx.fillStyle = C.waveLoop;
    ctx.fillRect((loopStart / len) * W, 0, ((loopEnd - loopStart) / len) * W, H);
  }
  const baseY = H / 2;
  const yOf = (v) => (H * (255 - v)) / 255;
  ctx.fillStyle = C.waveMid ?? C.dim;
  ctx.fillRect(0, Math.round(baseY), W, 1);
  ctx.fillStyle = C.wave;
  if (len <= W) {
    const rectW = Math.max(1, Math.ceil(W / len));
    for (let i = 0; i < len; i++) {
      const yv = yOf(bin[ptr + i]);
      ctx.fillRect(Math.floor((i * W) / len), Math.min(baseY, yv),
        rectW, Math.max(1, Math.abs(baseY - yv)));
    }
  } else {
    for (let col = 0; col < W; col++) {
      const start = Math.floor((col * len) / W);
      const end = Math.min(len, Math.floor(((col + 1) * len) / W));
      if (end <= start) continue;
      const step = Math.max(1, ((end - start) / 8) | 0);
      let mn = 255, mx = 0;
      for (let p = start; p < end; p += step) {
        const v = bin[ptr + p];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const yTop = Math.min(baseY, yOf(mx));
      const yBot = Math.max(baseY, yOf(mn));
      ctx.fillRect(col, yTop, 1, Math.max(1, yBot - yTop + 1));
    }
  }
  for (const m of markers) {
    const x = (m.pos / len) * W;
    ctx.fillStyle = C[m.colorKey];
    ctx.fillRect(x - 1, 0, 2, H);
    ctx.font = "10px sans-serif";
    ctx.fillText(t(m.labelKey), Math.min(W - 30, x + 3), m.key === "loopEnd" ? H - 4 : 11);
  }
}
