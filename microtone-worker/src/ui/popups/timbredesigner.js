// The Timbre designer (item 307): a simple additive sound designer for an FM
// rack, opened from the FM tab and the FM Easy tab. It writes the rack as
// Easy Mode — a principal carrying the note's shape, every partial a sine
// operator summed into the output, each with its own decay — and, when the
// song's notation is an equal grid, can put every partial ON the grid so the
// instrument's overtones agree with the tuning (doc/timbredesign.js,
// core/tuning/timbre.js).
//
// The picture is the sound's roughness against itself, interval by interval
// across one period: the designed timbre's curve over the plain harmonic one,
// the grid's steps ticked, the steps that came out as valleys marked. Listen
// writes the design into the rack as one undo step and plays it on the
// audition voices; Cancel takes that step back, Apply keeps it.

import {
  defaultTimbreSettings, designFromSettings, designReport, timbreSpec, timbreVoices, partialRows,
  TIMBRE_SPECTRA, TIMBRE_PLACEMENTS, TIMBRE_SHAPES, TIMBRE_BITES,
  TIMBRE_MIN_PARTIALS, TIMBRE_MAX_PARTIALS,
} from "../../doc/timbredesign.js";
import { gridOf, dyadCurve } from "../../../core/tuning/timbre.js";
import { ANCHOR_NOTE } from "../../../core/tuning/pitchtables.js";
import { planTimbreFm } from "../../doc/bankmerge.js";
import { importBankOp } from "../../doc/ops.js";
import { metaFlags } from "../../doc/metaedit.js";
import { actionRow } from "../components/actions.js";
import { noteGlyph } from "../components/noteglyph.js";
import { themeColors } from "../theme.js";
import { canvasMonoFont } from "../fonts.js";
import { t } from "../i18n.js";

/** The settings last used, for the next time the dialog opens this session. */
let lastSettings = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A labelled form row, as showModal lays one out. */
function row(label, control, title = "") {
  const r = el("label", "modal-field");
  r.append(el("span", "modal-label", label), control);
  if (title) r.title = title;
  return r;
}

/** A segmented row of pushbuttons: [[value, label|Node, title]] → the row,
 *  with `set(value)` to show a value and `enable(value, on)`. */
function segmented(options, value, onPick, ariaLabel) {
  const seg = el("div", "mst-seg");
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", ariaLabel);
  const buttons = new Map();
  for (const [v, label, title] of options) {
    const b = el("button");
    b.type = "button";
    if (typeof label === "string") b.textContent = label; else b.append(label);
    if (title) b.title = title;
    b.addEventListener("click", (e) => { e.preventDefault(); onPick(v); });
    buttons.set(v, b);
    seg.append(b);
  }
  const set = (v) => {
    for (const [k, b] of buttons) {
      const on = k === v;
      if (b.classList.contains("active") !== on) b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    }
  };
  set(value);
  return { seg, set, enable: (v, on) => { const b = buttons.get(v); if (b) b.disabled = !on; } };
}

/** A number field: `get()` reads it clamped, `onChange` on every edit. */
function numberField(value, { min, max, step }, onChange) {
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(min); input.max = String(max); input.step = String(step);
  input.value = String(value);
  const read = () => {
    const v = Number(input.value);
    return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : value;
  };
  input.addEventListener("input", () => onChange(read()));
  input.addEventListener("change", () => { const v = read(); input.value = String(v); onChange(v); });
  return input;
}

/**
 * Open the designer on the FM rack in `slot`. `view` is the Instruments view
 * (its store, and refresh after). Resolves true when a design was applied.
 */
export function showTimbreDesigner(view, slot) {
  const store = view.store;
  const doc = store.doc;
  const inst = doc?.instruments[slot];
  if (!inst?.isFm) return Promise.resolve(false);
  const preset = store.pitchPreset;
  const grid = gridOf(preset);
  const s = { ...(lastSettings ?? defaultTimbreSettings()) };
  if (!grid) s.placement = "harmonic";
  else if (lastSettings === null) s.placement = "smoothest";

  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "modal timbre-modal";
    dlg.append(el("h3", "", t("timbre.title")));
    dlg.append(el("p", "dim", grid
      ? t("timbre.introGrid", { tuning: preset.name, n: grid.n })
      : t("timbre.introNoGrid", { tuning: preset.name })));
    dlg.append(el("p", "modal-hint", t(metaFlags(inst).easy ? "timbre.replaceEasy" : "timbre.replaceRaw")));

    const form = el("div", "modal-form timbre-form");
    const changed = () => schedule();

    // ── the spectrum ──
    form.append(row(t("timbre.partials"),
      numberField(s.partials, { min: TIMBRE_MIN_PARTIALS, max: TIMBRE_MAX_PARTIALS, step: 1 },
        (v) => { s.partials = Math.round(v); changed(); }), t("timbre.partialsTitle")));
    const spectrum = segmented(TIMBRE_SPECTRA.map((k) => [k, t(`timbre.spectrum.${k}`), t(`timbre.spectrumTitle.${k}`)]),
      s.spectrum, (v) => { s.spectrum = v; spectrum.set(v); changed(); }, t("timbre.spectrum"));
    form.append(row(t("timbre.spectrum"), spectrum.seg));
    const placement = segmented(TIMBRE_PLACEMENTS.map((k) => [k, t(`timbre.place.${k}`), t(`timbre.placeTitle.${k}`)]),
      s.placement, (v) => { s.placement = v; placement.set(v); changed(); }, t("timbre.placement"));
    if (!grid) { placement.enable("grid", false); placement.enable("smoothest", false); }
    form.append(row(t("timbre.placement"), placement.seg));
    // Where it should sound best: the roots of five periods, C2 … C6 in an octave tuning.
    const roots = [-2, -1, 0, 1, 2].map((k) => ANCHOR_NOTE + k * (preset.interval || 0x1000));
    if (!roots.includes(s.register)) s.register = ANCHOR_NOTE;
    const register = segmented(roots.map((w) => [w, noteGlyph(w, preset), ""]),
      s.register, (v) => { s.register = v; register.set(v); changed(); }, t("timbre.register"));
    form.append(row(t("timbre.register"), register.seg, t("timbre.registerTitle")));

    // ── the note's shape ──
    const shape = segmented(TIMBRE_SHAPES.map((k) => [k, t(`timbre.shape.${k}`), t(`timbre.shapeTitle.${k}`)]),
      s.shape, (v) => { s.shape = v; shape.set(v); showShapeRows(); changed(); }, t("timbre.shape"));
    form.append(row(t("timbre.shape"), shape.seg));
    const attackRow = row(t("timbre.attack"), numberField(s.attack, { min: 0, max: 5, step: 0.01 }, (v) => { s.attack = v; changed(); }));
    const decayRow = row(t("timbre.decay"), numberField(s.decay, { min: 0.05, max: 15, step: 0.05 }, (v) => { s.decay = v; changed(); }), t("timbre.decayTitle"));
    const sustainRow = row(t("timbre.sustain"), numberField(Math.round(s.sustain * 100), { min: 0, max: 100, step: 5 }, (v) => { s.sustain = v / 100; changed(); }));
    const brightRow = row(t("timbre.brightness"), numberField(s.brightness, { min: 0, max: 2, step: 0.1 }, (v) => { s.brightness = v; changed(); }), t("timbre.brightnessTitle"));
    const releaseRow = row(t("timbre.release"), numberField(s.release, { min: 0.02, max: 10, step: 0.05 }, (v) => { s.release = v; changed(); }), t("timbre.releaseTitle"));
    const bite = segmented(TIMBRE_BITES.map((k) => [k, t(`timbre.bite.${k}`), ""]),
      s.bite, (v) => { s.bite = v; bite.set(v); changed(); }, t("timbre.bite"));
    const biteRow = row(t("timbre.bite"), bite.seg, t("timbre.biteTitle"));
    // the envelope's numbers in two columns, so the dialog fits a laptop's height
    const shapeGrid = el("div", "timbre-shape-grid");
    shapeGrid.append(attackRow, decayRow, sustainRow, brightRow, releaseRow);
    form.append(shapeGrid, biteRow);
    // A field the shape makes meaningless is dimmed, not hidden: the form
    // should not move about under the pointer when the shape changes.
    const enableRow = (r, on) => {
      r.classList.toggle("modal-disabled", !on);
      for (const input of r.querySelectorAll("input")) input.disabled = !on;
    };
    const showShapeRows = () => {
      enableRow(attackRow, s.shape === "held");
      enableRow(decayRow, s.shape !== "held");
      enableRow(sustainRow, s.shape === "plucked");
      enableRow(brightRow, s.shape !== "held");
    };
    showShapeRows();
    dlg.append(form);

    // ── the picture, the summary and the partials ──
    const frame = el("div", "timbre-curve-frame");
    const canvas = el("canvas", "timbre-curve");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", t("timbre.curveLabel"));
    frame.append(canvas);
    dlg.append(frame);
    const legend = el("p", "dim timbre-legend", t(grid ? "timbre.legendGrid" : "timbre.legendNoGrid"));
    dlg.append(legend);
    const summary = el("p", "timbre-summary", "");
    dlg.append(summary);
    const table = el("table", "files-table meta-table timbre-table");
    dlg.append(table);
    const errEl = el("p", "import-error", "");
    errEl.hidden = true;
    dlg.append(errEl);

    const canListen = !!store.audio;
    const { row: btnRow, proceed: okBtn, cancel: cancelBtn, alternatives: [listenBtn] } = actionRow({
      cancel: true,
      alternatives: [{ label: t("timbre.listen"), icon: "play", title: t("timbre.listenTitle"), disabled: !canListen }],
      proceed: t("timbre.apply"),
    });
    dlg.append(btnRow);

    // ── the design, recomputed as the settings change ──
    let design = null;
    let timer = null;
    const recompute = () => {
      timer = null;
      design = designFromSettings(s, grid);
      paint();
    };
    function schedule() {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(recompute, 90);
    }

    function paint() {
      const C = themeColors();
      const report = designReport(design);
      // the picture
      const W = Math.max(240, Math.round(frame.clientWidth || 520));
      const H = 132;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.style.width = `${W}px`; }
      if (canvas.height !== Math.round(H * dpr)) { canvas.height = Math.round(H * dpr); canvas.style.height = `${H}px`; }
      const g = canvas.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = C.cvBg; g.fillRect(0, 0, W, H);
      const span = grid ? grid.periodCents : 1200;
      const res = span / (W / 2);
      const a = dyadCurve(design.partials, { f0: design.f0, to: span, res });
      const b = design.placement === "harmonic" ? null : dyadCurve(design.plain, { f0: design.f0, to: span, res });
      // scale both against the larger, leaving out the unison's own bump
      const skip = Math.ceil(60 / res);
      let max = 0;
      for (const c of [a, b]) if (c) for (let i = skip; i < c.d.length; i++) max = Math.max(max, c.d[i]);
      const top = 10, bottom = H - 18;
      const x = (cents) => (cents / span) * (W - 1);
      const y = (d) => bottom - Math.min(1, d / (max || 1)) * (bottom - top);
      if (grid) {
        g.strokeStyle = C.border; g.lineWidth = 1;
        for (let k = 1; k <= grid.n; k++) {
          const px = Math.round(x((k * span) / grid.n)) + 0.5;
          g.beginPath(); g.moveTo(px, top); g.lineTo(px, bottom); g.stroke();
        }
      }
      const line = (c, ink, width) => {
        g.strokeStyle = ink; g.lineWidth = width; g.beginPath();
        c.d.forEach((d, i) => { const px = x(c.cents[i]), py = y(d); if (i === 0) g.moveTo(px, py); else g.lineTo(px, py); });
        g.stroke();
      };
      if (b) line(b, C.dim, 1);
      line(a, C.accent2, 1.6);
      if (report) {
        // a valley floor on a step: a tick under it
        g.fillStyle = C.fg;
        for (const r of report.report) if (r.margin > 0) g.fillRect(Math.round(x(r.cents)) - 1, bottom + 3, 3, 5);
      }
      g.fillStyle = C.dim; g.font = canvasMonoFont(10); g.textBaseline = "bottom";
      g.textAlign = "left"; g.fillText("0", 2, H - 1);
      g.textAlign = "right"; g.fillText(`${Math.round(span)}¢`, W - 2, H - 1);

      // the summary: valleys, the smoothest triad, the voices a note takes
      const bits = [];
      if (report) bits.push(t("timbre.valleys", { n: report.valleys, steps: report.steps }), " · ");
      if (report?.chord) bits.push(`${t("timbre.chord")} `, chordGlyphs(report.chord), " · ");
      bits.push(t("timbre.voices", { n: timbreVoices(s) }));
      summary.replaceChildren(...bits);

      // the partials, one column each: harmonic, step, how far off the harmonic, level
      const rows = partialRows(design);
      const tr = (head, cells) => {
        const r = el("tr");
        r.append(el("th", "", head), ...cells.map((c) => el("td", "", c)));
        return r;
      };
      const thead = el("thead");
      thead.append(tr("#", rows.map((_, i) => String(i))));
      const tbody = el("tbody");
      tbody.append(
        tr(t("timbre.colHarmonic"), rows.map((r) => String(r.h))),
        tr(t("timbre.colStep"), rows.map((r) => (r.step === null ? "—" : String(r.step)))),
        tr(t("timbre.colCents"), rows.map((r) => (r.step === null ? "—" : signed(Math.round(r.cents))))),
        tr(t("timbre.colLevel"), rows.map((r) => signed(r.db.toFixed(1)))),
      );
      table.replaceChildren(thead, tbody);
    }

    /** The smoothest triad as notes on the register's root. */
    function chordGlyphs(steps) {
      const span = el("span", "timbre-chord");
      steps.forEach((k, i) => {
        const word = s.register + Math.round((k * preset.interval) / grid.n);
        if (i > 0) span.append(" ");
        span.append(noteGlyph(word, preset));
      });
      return span;
    }

    // ── listen, apply, cancel ──
    // A trial is a design already written into the rack (one undo step), so
    // the audition voices can play it; `trialKey` says which settings it was.
    let trialKey = null;
    const keyOf = () => JSON.stringify(s);
    const takeBack = () => {
      if (trialKey === null) return;
      store.undo.undo();
      trialKey = null;
    };
    const write = () => {
      if (timer !== null) { clearTimeout(timer); recompute(); }
      const plan = planTimbreFm(store.doc, slot, timbreSpec(design, s));
      if (plan.error) {
        errEl.textContent = plan.error;
        errEl.hidden = false;
        return false;
      }
      errEl.hidden = true;
      store.undo.apply(importBankOp(plan));
      trialKey = keyOf();
      return true;
    };
    const voices = [0, 1, 2].map((i) => store.audio?.jamVoice(i));
    let releaseTimer = null;
    const silence = () => {
      if (releaseTimer !== null) { clearTimeout(releaseTimer); releaseTimer = null; }
      for (const v of voices) if (v !== undefined) store.audio?.jamStopVoice(0, v);
    };
    const listen = () => {
      if (!store.audio) return;
      if (trialKey !== keyOf()) { takeBack(); if (!write()) return; }
      silence();
      const report = designReport(design);
      const steps = report?.chord ?? null;
      const notes = steps
        ? steps.map((k) => s.register + Math.round((k * preset.interval) / grid.n))
        : [s.register];
      // the root alone, then the chord on top of it
      store.audio.jamNote(0, voices[0], notes[0], slot, true);
      notes.slice(1).forEach((n, i) => setTimeout(() => store.audio?.jamNote(0, voices[i + 1], n, slot, true), 450 + 150 * i));
      releaseTimer = setTimeout(() => {
        releaseTimer = null;
        for (const v of voices) store.audio?.jamKeyOff(0, v);
      }, 2200);
    };

    const finish = (applied) => {
      silence();
      dlg.close();
      dlg.remove();
      lastSettings = { ...s };
      if (applied) view.tab = "fmeasy";
      view.refresh();
      resolve(applied);
    };
    listenBtn.addEventListener("click", (e) => { e.preventDefault(); listen(); });
    cancelBtn.addEventListener("click", (e) => { e.preventDefault(); takeBack(); finish(false); });
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); takeBack(); finish(false); });
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    okBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (trialKey !== keyOf()) { takeBack(); if (!write()) return; }
      trialKey = null; // kept
      finish(true);
    });

    document.body.appendChild(dlg);
    dlg.showModal();
    recompute();
    okBtn.focus();
  });
}

const signed = (v) => (Number(v) > 0 ? `+${v}` : String(v).replace("-", "−"));
