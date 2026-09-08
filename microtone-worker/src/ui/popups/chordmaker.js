// Chord maker (item 89) — the UI over doc/chord.js. Six voice slots, each an
// independent pitch offset expressed in whichever of the four idioms suits it
// (just ratio · notation degrees · playback ratio · raw 4096-TET), mixed into
// one sample: the Amiga trick of baking a chord into the waveform because the
// channel can only play one note.
//
// The interface is built around never having to look anything up:
//   · every just interval names itself AND shows its ratio and cents;
//   · every row paints the note it lands on with the ordinary note-cell glyph
//     painter, in the song's own notation — so a just third in 12-TET reads
//     "E-4" in off-grid yellow with "grid −13" beside it, and the same third
//     in 31-TET reads as an exact degree;
//   · a chord-preset menu fills all six slots at once, so the manual modes are
//     somewhere to arrive at rather than somewhere to start.
//
// Opened from the Sample Lab (which owns undo, naming and the pool commit) —
// Apply replaces the Lab's working buffer with the mix.

import {
  JI_INTERVALS, CHORD_GROUPS, MAX_VOICES, UNITS_PER_OCTAVE,
  applyChordPreset, buildChord, chordLength, chordPresetById, chordPresetLabel, chordPresetsFor,
  maxInversion, voiceNote, voiceRatio, voiceUnits,
} from "../../doc/chord.js";
import { presetForNotation, gridDelta } from "../pitchtables.js";
import { paintNoteCell } from "../glyphs.js";
import { canvasFont } from "../fonts.js";
import { themeColors } from "../theme.js";
import { t } from "../i18n.js";
import { icon, setIconLabel } from "../icons.js";

const WAVE_H = 96;
const GLYPH_CHAR_W = 9, GLYPH_H = 20;
const REBUILD_DEBOUNCE_MS = 180;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const centsOf = (units) => (units * 1200) / UNITS_PER_OCTAVE;
const signed = (v, digits = 0) => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(digits);

/**
 * Open the chord maker on a float working buffer.
 * @param store the app store (only `pitchPreset` is read — no document edits)
 * @param data Float32Array mono, nominal ±1 (channel 1 — what the preview and
 *        the audition use)
 * @param dataR optional second channel of a STEREO take (item 90): the same
 *        voices are mixed into it and the two results share one normalisation
 *        factor, so the chord keeps the take's stereo image
 * @param rate sample rate of `data` (audition + the info line)
 * @param name shown in the title
 * @returns Promise<{data, dataR, voices} | null> — null on cancel
 */
export function openChordMaker(store, { data, dataR = null, rate, name = "" }) {
  if (!data || data.length === 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const preset = store?.pitchPreset ?? presetForNotation(120);
    const srcRate = Math.max(1, Math.round(rate));
    let presetId = "major";
    let inversion = 0;
    let voices = applyChordPreset(presetId, inversion, preset);
    let lengthMode = "longest";
    let normalise = true;
    let mix = null;        // {data, peak, voices} — null when dirty
    let rebuildTimer = 0;
    let playing = null;
    let actx = null;

    const dlg = document.createElement("dialog");
    dlg.className = "modal chord-modal";

    const jiOptions = JI_INTERVALS.map((iv, i) => {
      const c = Math.round(centsOf(UNITS_PER_OCTAVE * Math.log2(iv.num / iv.den)));
      const cents = esc(t("chord.cents", { v: signed(c) }));
      return `<option value="${esc(iv.id)}">${esc(t(iv.key))} · ${iv.num}:${iv.den} · ${cents}</option>`;
    }).join("");
    const modeOptions = ["ji", "key", "ratio", "units"]
      .map((m) => `<option value="${m}">${esc(t(`chord.mode.${m}`))}</option>`).join("");
    // The family is its OWN control, and the chord menu holds one family at a
    // time. It used to be a single grouped list, which stopped scaling once the
    // tuning-specific vocabularies landed: 31-TET reaches 143 rows in one
    // dropdown — longer than a screen, and long enough that the platform's own
    // popup starts leaving rows unpainted. Which families exist follows the
    // project's notation, since tetrachords and arto/tendo belong to ONE tuning
    // each (items 141, 167), so an empty family simply does not appear.
    const menu = chordPresetsFor(preset);
    const families = CHORD_GROUPS.filter((g) => menu.some((p) => p.group === g));
    let family = chordPresetById(presetId)?.group ?? families[0];
    const familyOptions = families
      .map((g) => `<option value="${g}">${esc(t(`chord.group.${g}`))}</option>`).join("");
    const presetOptionsFor = (g) => menu.filter((p) => p.group === g)
      .map((p) => `<option value="${esc(p.id)}">${esc(chordPresetLabel(p, t))}</option>`).join("");

    dlg.innerHTML = `
      <h3>${esc(t("chord.title", { name: name || t("lab.untitled") }))}</h3>
      <p class="dim chord-lead">${esc(t("chord.lead"))}</p>
      <div class="chord-head">
        <label>${esc(t("chord.family"))}
          <select class="chord-family">${familyOptions}</select></label>
        <label>${esc(t("chord.preset"))}
          <select class="chord-preset">${presetOptionsFor(family)}</select></label>
        <label>${esc(t("chord.inversion"))}
          <select class="chord-inv" title="${esc(t("chord.inversionTitle"))}"></select></label>
        <label>${esc(t("chord.length"))}
          <select class="chord-len">
            <option value="longest">${esc(t("chord.lenLongest"))}</option>
            <option value="source">${esc(t("chord.lenSource"))}</option>
            <option value="shortest">${esc(t("chord.lenShortest"))}</option>
          </select></label>
        <label><input type="checkbox" class="chord-norm" checked> ${esc(t("chord.normalise"))}</label>
      </div>
      <div class="chord-voices"></div>
      <p class="dim chord-hint">${esc(t("chord.hint", { notation: preset?.name ?? "12-TET" }))}</p>
      <canvas class="chord-wave"></canvas>
      <div class="chord-info dim"></div>
      <div class="modal-buttons">
        <button class="chord-play">${icon("play")}${esc(t("chord.preview"))}</button>
        <button class="chord-ok">${esc(t("chord.apply"))}</button>
        <button class="chord-cancel">${esc(t("common.cancel"))}</button>
      </div>`;
    document.body.appendChild(dlg);

    const $ = (q) => dlg.querySelector(q);
    const voicesEl = $(".chord-voices");
    const wave = $(".chord-wave");
    const playBtn = $(".chord-play");
    const dpr = window.devicePixelRatio || 1;
    // The canvas stretches to the dialog (CSS width: 100%), so its backing
    // store can only be sized once it is laid out — i.e. after showModal.
    let waveW = 600;
    wave.style.height = WAVE_H + "px";
    function sizeWave() {
      const w = Math.max(200, Math.round(wave.getBoundingClientRect().width) || waveW);
      if (w === waveW && wave.width === w * dpr) return;
      waveW = w;
      wave.width = w * dpr;
      wave.height = WAVE_H * dpr;
    }

    // ── voice rows ─────────────────────────────────────────────────────────
    // Every value control exists in every row; only the active mode's is
    // shown, so switching modes never rebuilds (and never loses what the other
    // modes were set to — a voice remembers its ratio while you try degrees).
    const rows = [];
    for (let i = 0; i < MAX_VOICES; i++) {
      const row = document.createElement("div");
      row.className = "chord-voice";
      row.innerHTML = `
        <input type="checkbox" class="cv-on" title="${esc(t("chord.onTitle"))}">
        <span class="cv-num">${i + 1}</span>
        <select class="cv-mode">${modeOptions}</select>
        <span class="cv-val">
          <select class="cv-ji">${jiOptions}</select>
          <input type="number" class="cv-step" step="1" title="${esc(t("chord.stepTitle"))}">
          <input type="text" inputmode="decimal" class="cv-ratio" title="${esc(t("chord.ratioTitle"))}">
          <input type="text" class="cv-units" title="${esc(t("chord.unitsTitle"))}">
        </span>
        <label class="cv-oct-l">${esc(t("chord.oct"))}
          <input type="number" class="cv-oct" min="-4" max="4" step="1"></label>
        <label class="cv-gain-l">${esc(t("chord.level"))}
          <input type="number" class="cv-gain" min="-24" max="6" step="0.5"></label>
        <canvas class="cv-glyph"></canvas>
        <span class="cv-read"></span>`;
      voicesEl.appendChild(row);
      const cv = row.querySelector(".cv-glyph");
      cv.width = (GLYPH_CHAR_W * 4 + 4) * dpr; cv.height = GLYPH_H * dpr;
      cv.style.width = GLYPH_CHAR_W * 4 + 4 + "px"; cv.style.height = GLYPH_H + "px";
      rows.push(row);

      const v = () => voices[i];
      const q = (sel) => row.querySelector(sel);
      q(".cv-on").addEventListener("change", () => { v().on = q(".cv-on").checked; touch(); });
      q(".cv-mode").addEventListener("change", () => { v().mode = q(".cv-mode").value; touch(); });
      q(".cv-ji").addEventListener("change", () => { v().ji = q(".cv-ji").value; touch(); });
      q(".cv-step").addEventListener("input", () => { v().step = parseInt(q(".cv-step").value, 10) || 0; touch(); });
      q(".cv-ratio").addEventListener("input", () => {
        const r = parseRatio(q(".cv-ratio").value);
        v().ratio = r ?? 1;
        touch();
      });
      q(".cv-units").addEventListener("input", () => { v().units = parseUnits(q(".cv-units").value); touch(); });
      q(".cv-oct").addEventListener("input", () => { v().oct = clampInt(q(".cv-oct").value, -4, 4); touch(); });
      q(".cv-gain").addEventListener("input", () => {
        const g = Number(q(".cv-gain").value);
        v().gainDb = Number.isFinite(g) ? Math.max(-24, Math.min(6, g)) : 0;
        touch();
      });
    }

    /** "1.5", "3:2", "3/2" — a ratio, or the two notations that name one
     *  without doing the division by hand (item 172). */
    function parseRatio(str) {
      const s = String(str).trim();
      const m = s.match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
      if (m) {
        const n = Number(m[1]), d = Number(m[2]);
        return n > 0 && d > 0 ? n / d : null;
      }
      const n = Number(s);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    /** "0x100", "256", "-100" — hex is how the note words themselves read. */
    function parseUnits(str) {
      const s = String(str).trim();
      if (/^[+-]?0x[0-9a-f]+$/i.test(s)) {
        const n = parseInt(s.replace(/0x/i, ""), 16);
        return s.startsWith("-") ? -n : n;
      }
      const n = parseInt(s, 10);
      return Number.isFinite(n) ? n : 0;
    }
    function clampInt(str, lo, hi) {
      const n = parseInt(str, 10);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0;
    }

    // ── rendering ──────────────────────────────────────────────────────────
    function renderVoices() {
      rows.forEach((row, i) => {
        const v = voices[i];
        const q = (sel) => row.querySelector(sel);
        row.classList.toggle("off", !v.on);
        q(".cv-on").checked = !!v.on;
        q(".cv-mode").value = v.mode;
        q(".cv-ji").value = v.ji;
        setIfIdle(q(".cv-step"), String(v.step));
        setIfIdle(q(".cv-ratio"), String(round4(v.ratio)));
        setIfIdle(q(".cv-units"), String(v.units));
        setIfIdle(q(".cv-oct"), String(v.oct));
        setIfIdle(q(".cv-gain"), String(v.gainDb));
        q(".cv-ji").hidden = v.mode !== "ji";
        q(".cv-step").hidden = v.mode !== "key";
        q(".cv-ratio").hidden = v.mode !== "ratio";
        q(".cv-units").hidden = v.mode !== "units";
        paintVoiceReadout(row, v);
      });
    }
    // Typing "1.00" would otherwise be rewritten to "1" under the caret.
    const setIfIdle = (el, value) => {
      if (document.activeElement !== el && el.value !== value) el.value = value;
    };
    const round4 = (x) => Math.round(Number(x) * 1e4) / 1e4;

    function paintVoiceReadout(row, v) {
      const units = voiceUnits(v, preset);
      const note = voiceNote(v, preset);
      const cv = row.querySelector(".cv-glyph");
      const ctx = cv.getContext("2d");
      const C = themeColors();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = C.cvBg;
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.font = canvasFont(13);
      ctx.textBaseline = "middle";
      ctx.globalAlpha = v.on ? 1 : 0.4;
      paintNoteCell(ctx, note, preset, 2, 0, GLYPH_CHAR_W, GLYPH_H,
        { note: C.fg, sentinel: C.fg2, dim: C.dim, offGrid: C.accent });
      ctx.globalAlpha = 1;

      const delta = gridDelta(note, preset);
      const read = row.querySelector(".cv-read");
      // "cents" spelled out, as everywhere else in the app — the ¢ sign is
      // barely distinguishable from a C at this size in the UI font.
      read.textContent = t("chord.voiceRead", {
        ratio: voiceRatio(v, preset).toFixed(4),
        cents: signed(centsOf(units), 1),
      }) + (Math.abs(delta) >= 1 ? t("chord.voiceOffGrid", { delta: signed(centsOf(delta), 0) }) : "");
      read.title = Math.abs(delta) >= 1 ? t("chord.offGridTitle") : t("chord.onGridTitle");
    }

    function paintWave() {
      sizeWave();
      const C = themeColors();
      const ctx = wave.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = C.cvBg;
      ctx.fillRect(0, 0, waveW, WAVE_H);
      const mid = WAVE_H / 2;
      ctx.fillStyle = C.waveMid ?? C.dim;
      ctx.fillRect(0, Math.round(mid), waveW, 1);
      const buf = mix?.data;
      if (!buf || buf.length === 0) return;
      ctx.fillStyle = C.wave;
      const spp = buf.length / waveW;
      if (spp <= 1) {
        // Fewer samples than pixels (a short one-shot, or a voice pitched
        // WAY up shrinking the mix): one bar per sample, or min/max columns
        // degenerate to a single point every few columns — a scatter of dots.
        const rectW = Math.max(1, Math.ceil(1 / spp));
        for (let i = 0; i < buf.length; i++) {
          const x = Math.floor(i / spp), y = mid - buf[i] * (mid - 2);
          ctx.fillRect(x, Math.min(mid, y), rectW, Math.max(1, Math.abs(mid - y)));
        }
      } else {
        // Bars anchored to the centre line, as everywhere else a sample is
        // drawn (item 109) — clamping BOTH ends against `mid` grows each
        // column off the zero axis instead of leaving a min..max hairline
        // floating where the whole column sits on one side of zero.
        for (let col = 0; col < waveW; col++) {
          const a = Math.floor(col * spp), b = Math.min(buf.length, Math.floor((col + 1) * spp));
          if (b <= a) continue;
          const step = Math.max(1, ((b - a) / 8) | 0);
          let mn = Infinity, mx = -Infinity;
          for (let p = a; p < b; p += step) {
            if (buf[p] < mn) mn = buf[p];
            if (buf[p] > mx) mx = buf[p];
          }
          // mx >= mn ⟹ yT <= yB. (Clamping only the top — as this once did —
          // is the bug that flattened all-negative columns onto the zero line.)
          const yT = Math.min(mid, mid - mx * (mid - 2));
          const yB = Math.max(mid, mid - mn * (mid - 2));
          ctx.fillRect(col, yT, 1, Math.max(1, yB - yT));
        }
      }
      if (playing) {
        const pos = playPos();
        if (pos !== null) {
          ctx.fillStyle = C.waveCursor || C.playCursor || C.accent;
          ctx.fillRect((pos / buf.length) * waveW - 0.5, 0, 1.5, WAVE_H);
        }
      }
    }

    function refreshInfo() {
      const n = voices.filter((v) => v.on).length;
      const frames = chordLength(data.length, voices, preset, lengthMode);
      const info = $(".chord-info");
      if (n === 0) {
        info.textContent = t("chord.noVoices");
      } else {
        let line = t("chord.info", {
          n, frames, secs: (frames / srcRate).toFixed(2),
        });
        if (mix) {
          const db = mix.peak > 0 ? 20 * Math.log10(mix.peak) : -Infinity;
          line += t("chord.infoPeak", { db: mix.peak > 0 ? signed(db, 1) : "−∞" });
          if (normalise && mix.peak > 0) line += t("chord.infoNormalised");
        }
        info.textContent = line;
      }
      $(".chord-ok").disabled = n === 0;
      playBtn.disabled = n === 0;
    }

    /** Any control changed: readouts are instant, the mix is not. */
    function touch() {
      mix = null;
      renderVoices();
      refreshInfo();
      paintWave();
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => {
        ensureMix();
        refreshInfo();
        paintWave();
      }, REBUILD_DEBOUNCE_MS);
    }

    function ensureMix() {
      if (!mix) mix = buildChord(data, voices, preset, { normalise, lengthMode });
      return mix;
    }

    // ── head controls ──────────────────────────────────────────────────────
    /** The inversion menu only offers the inversions this chord HAS — a triad
     *  has two, and a preset with one voice has none at all. */
    function renderInversions() {
      const sel = $(".chord-inv");
      const top = maxInversion(presetId);
      inversion = Math.min(inversion, top);
      sel.replaceChildren();
      for (let i = 0; i <= top; i++) {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = t(`chord.inv${i}`);
        sel.appendChild(o);
      }
      sel.value = String(inversion);
      sel.disabled = top === 0;
    }
    /** Refill the chord menu with `family`'s chords, keeping the current one
     *  selected when it belongs to the family and taking the first when it does
     *  not. mtSync re-reads the option list for the ◄ ► buttons. */
    function renderPresets() {
      const sel = $(".chord-preset");
      sel.innerHTML = presetOptionsFor(family);
      sel.value = presetId;
      if (!sel.value) {
        presetId = sel.options[0]?.value ?? presetId;
        sel.value = presetId;
      }
      sel.mtSync?.();
    }
    /** Preset and inversion are ONE choice — the six slots are re-seeded from
     *  both, so an inversion never compounds onto an already-inverted set. */
    function seedFromPreset() {
      voices = applyChordPreset(presetId, inversion, preset);
      touch();
    }
    $(".chord-family").addEventListener("change", (e) => {
      family = e.target.value;
      // A family change is a chord change: it lands on the family's first
      // chord and keeps the inversion, clamped to what that chord has — the
      // same contract as picking another chord within a family.
      presetId = menu.find((p) => p.group === family)?.id ?? presetId;
      renderPresets();
      renderInversions();
      seedFromPreset();
    });
    $(".chord-preset").addEventListener("change", (e) => {
      presetId = e.target.value;
      renderInversions(); // …keeping the inversion, clamped to the new chord
      seedFromPreset();
    });
    $(".chord-inv").addEventListener("change", (e) => {
      inversion = parseInt(e.target.value, 10) || 0;
      seedFromPreset();
    });
    $(".chord-len").addEventListener("change", (e) => { lengthMode = e.target.value; touch(); });
    $(".chord-norm").addEventListener("change", (e) => { normalise = e.target.checked; touch(); });

    // ── audition (Web Audio — the mix is not pooled yet) ───────────────────
    function playPos() {
      if (!playing || !actx) return null;
      const pos = (actx.currentTime - playing.t0) * srcRate;
      return pos >= 0 && pos <= (mix?.data.length ?? 0) ? pos : null;
    }
    function stopPlay() {
      if (!playing) return;
      try { playing.src.stop(); } catch { /* already ended */ }
      playing = null;
      setIconLabel(playBtn, "play", t("chord.preview"));
      paintWave();
    }
    function startPlay() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const m = ensureMix();
      if (!m.data.length) return;
      if (!actx) actx = new AC();
      if (actx.state === "suspended") actx.resume();
      const bufRate = Math.max(8000, Math.min(96000, srcRate));
      const ab = actx.createBuffer(1, m.data.length, bufRate);
      ab.getChannelData(0).set(m.data);
      const src = actx.createBufferSource();
      src.buffer = ab;
      src.playbackRate.value = srcRate / bufRate;
      src.connect(actx.destination);
      src.start();
      playing = { src, t0: actx.currentTime };
      setIconLabel(playBtn, "stop", t("chord.stop"));
      src.onended = () => { if (playing?.src === src) stopPlay(); };
      const tick = () => { if (!playing) return; paintWave(); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }
    playBtn.addEventListener("click", (e) => { e.preventDefault(); playing ? stopPlay() : startPlay(); });

    // ── close ──────────────────────────────────────────────────────────────
    function finish(result) {
      clearTimeout(rebuildTimer);
      stopPlay();
      if (actx) { actx.close().catch(() => {}); actx = null; }
      dlg.close();
      dlg.remove();
      resolve(result);
    }
    function apply() {
      const m = ensureMix();
      if (!m.data.length) return;
      const out = { data: m.data, dataR: null, voices: voices.map((v) => ({ ...v })), lengthMode, normalise };
      if (dataR) {
        // Build both channels UNNORMALISED, then scale by the shared peak —
        // normalising each on its own would re-balance the stereo image.
        const opts = { normalise: false, lengthMode };
        const l = buildChord(data, voices, preset, opts);
        const r = buildChord(dataR, voices, preset, opts);
        const peak = Math.max(l.peak, r.peak);
        const scale = normalise && peak > 0 ? 1 / peak : 1;
        const scaled = (buf) => {
          if (scale === 1) return buf;
          const o = new Float32Array(buf.length);
          for (let i = 0; i < buf.length; i++) o[i] = buf[i] * scale;
          return o;
        };
        out.data = scaled(l.data);
        out.dataR = scaled(r.data);
      }
      finish(out);
    }
    $(".chord-ok").addEventListener("click", (e) => { e.preventDefault(); apply(); });
    $(".chord-cancel").addEventListener("click", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("keydown", (e) => e.stopPropagation()); // never leak piano keys

    // ── test hooks ─────────────────────────────────────────────────────────
    dlg.__chord = {
      voices: () => voices.map((v) => ({ ...v })),
      setVoice: (i, patch) => { Object.assign(voices[i], patch); touch(); },
      setChordPreset: (id, inv = 0) => {
        presetId = id; inversion = inv;
        family = chordPresetById(id)?.group ?? family;
        $(".chord-family").value = family;
        renderPresets();
        renderInversions();
        seedFromPreset();
      },
      setInversion: (n) => { inversion = n; $(".chord-inv").value = String(n); seedFromPreset(); },
      preset: () => ({ id: presetId, inversion, options: $(".chord-inv").options.length }),
      setLength: (m) => { lengthMode = m; $(".chord-len").value = m; touch(); },
      setNormalise: (on) => { normalise = on; $(".chord-norm").checked = on; touch(); },
      units: (i) => voiceUnits(voices[i], preset),
      note: (i) => voiceNote(voices[i], preset),
      mix: () => ensureMix(),
      info: () => $(".chord-info").textContent,
      read: (i) => rows[i].querySelector(".cv-read").textContent,
      apply,
      cancel: () => finish(null),
    };

    renderInversions();
    renderVoices();
    ensureMix();
    refreshInfo();
    dlg.showModal();
    paintWave(); // laid out now — sizeWave can measure the canvas
  });
}
