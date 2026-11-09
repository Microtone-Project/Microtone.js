// The Keymap Maker — a layout built from a scale, opened from the Keymap tab.
//
// The scales and the layout are keymapscale.js; this is the form over them and
// a picture of the board it makes, drawn by the same painter as the tab, so
// what is previewed is what the keyboard will play. A click on a cap of the
// picture sounds it.
//
// Two frames (keymapscale.js makerFrame): the song's own tuning system, in its
// degrees — where every choice the tuning cannot play is GREYED, never hidden,
// so a 13-TET user can see that a heptatonic scale exists and that this tuning
// has none — and any tuning system, in semitones, where everything is on offer
// and the board plays the nearest note of whatever tuning it lands in.
//
// The result is a NEW layout of the user's own (the tab names it uniquely and
// saves it); nothing here touches the document.

import { t } from "../i18n.js";
import { actionRow } from "../components/actions.js";
import { lampButton } from "../components/lampbutton.js";
import { noteGlyph } from "../components/noteglyph.js";
import { noteLabel } from "./keymapmanual.js";
import { paintKeymapBoard, boardExtent, defaultLegend } from "../keymapboard.js";
import { keymapNote, keymapStats } from "../keymap.js";
import {
  makerFrame, kindAvailable, scaleOf, scaleOffsets, makeScaleKeymap, rowStepOf,
  mosPatterns, mosModes, mosSizes, defaultMosSize,
  SCALE_KINDS, PENTA_MODES, HEPTA_MODES,
} from "../keymapscale.js";
import {
  noteForDegree, semiToNote, semiToNoteInTable, pitchTablePresets,
} from "../../../core/tuning/pitchtables.js";
import { uiDpr, toLayout } from "../zoom.js";

const TET12 = pitchTablePresets[120];
/** 5L 2s's modes, brightest first, by the names the major scale's modes have. */
const DIATONIC_BRIGHTNESS = ["lydian", "ionian", "mixolydian", "dorian", "aeolian", "phrygian", "locrian"];
const ROWS = ["N", "Q", "A", "Z"];

/** The settings last used, so the dialog opens where it was left this session. */
let lastSettings = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A labelled form row, as showModal lays one out. */
function row(label, control, title = "") {
  const r = el("div", "modal-field");
  r.append(el("span", "modal-label", label), control);
  if (title) r.title = title;
  return r;
}

/** A segmented row of pushbuttons: [[value, label, title]] → { seg, set, enable }. */
function segmented(options, onPick, ariaLabel) {
  const seg = el("div", "mst-seg");
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", ariaLabel);
  const buttons = new Map();
  for (const [v, label, title] of options) {
    const b = el("button", "", label);
    b.type = "button";
    if (title) b.title = title;
    b.addEventListener("click", (e) => { e.preventDefault(); onPick(v); });
    buttons.set(v, b);
    seg.append(b);
  }
  return {
    seg,
    set(v) {
      for (const [k, b] of buttons) {
        const on = k === v;
        if (b.classList.contains("active") !== on) b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      }
    },
    enable(v, on) { const b = buttons.get(v); if (b) b.disabled = !on; },
  };
}

/** Fill a <select> with [[value, label, enabled]] and an optional group per
 *  entry; a disabled option stays listed — greyed, not hidden. */
function fillSelect(sel, options) {
  sel.replaceChildren();
  let group = null, groupName = null;
  for (const [value, label, enabled = true, groupLabel = null] of options) {
    if (groupLabel !== groupName) {
      groupName = groupLabel;
      group = groupLabel === null ? null : el("optgroup");
      if (group) { group.label = groupLabel; sel.append(group); }
    }
    const o = el("option", "", label);
    o.value = String(value);
    o.disabled = !enabled;
    (group ?? sel).append(o);
  }
}

function defaultSettings(rows) {
  return {
    mode: "tuning",
    kind: "hepta",
    penta: "major",
    hepta: "ionian",
    mos: { a: 5, b: 2, L: 2, s: 1, mode: 1 },
    tonic: 0,
    rowStep: null,
    rows: rows.slice(),
  };
}

/**
 * Open the maker.
 *
 * @param opts.preset   the song's tuning (or 12-TET with no song open)
 * @param opts.hasSong  is a song open — without one there is no tuning of its own
 * @param opts.octave   the jam octave the preview plays at
 * @param opts.rows     the rows of the layout in hand, the first default
 * @param opts.ortho    draw the board in columns (the tab's own setting)
 * @param opts.legend   (code) => the key's printed letter
 * @param opts.play     (code, note) => sound a key; opts.stop(code) releases it
 * @returns a keymap spec (named, not yet unique), or null on Cancel
 */
export function showKeymapMaker({
  preset, hasSong, octave, rows, ortho = false, legend = defaultLegend, play = null, stop = null,
}) {
  const tuningUsable = hasSong && makerFrame("tuning", preset).usable;
  const s = lastSettings ? structuredClone(lastSettings) : defaultSettings(rows);
  if (!tuningUsable) s.mode = "any";
  let nameEdited = false;

  return new Promise((resolve) => {
    const dlg = el("dialog", "modal kmaker-modal");
    dlg.append(el("h3", "", t("kmaker.title")), el("p", "dim", t("kmaker.intro")));
    const form = el("div", "modal-form kmaker-form");

    // ── the frame ──
    const modeSeg = segmented([
      ["tuning", t("kmaker.frame.tuning", { tuning: preset.name })],
      ["any", t("kmaker.frame.any")],
    ], (v) => { s.mode = v; update(); }, t("kmaker.frame"));
    modeSeg.enable("tuning", tuningUsable);
    form.append(row(t("kmaker.frame"), modeSeg.seg));
    const frameHint = el("p", "modal-hint kmaker-hint", "");
    form.append(frameHint);

    // ── the scale ──
    const kindSeg = segmented(SCALE_KINDS.map((k) => [k, t(`kmaker.kind.${k}`), t(`kmaker.kindTitle.${k}`)]),
      (v) => { s.kind = v; update(); }, t("kmaker.scale"));
    form.append(row(t("kmaker.scale"), kindSeg.seg));

    const pentaSeg = segmented(PENTA_MODES.map((m) => [m, t(`kmaker.penta.${m}`)]),
      (v) => { s.penta = v; update(); }, t("kmaker.mode"));
    const pentaRow = row(t("kmaker.mode"), pentaSeg.seg);
    const heptaSel = el("select");
    fillSelect(heptaSel, HEPTA_MODES.map((m) => [m, t(`kmaker.hepta.${m}`)]));
    heptaSel.addEventListener("change", () => { s.hepta = heptaSel.value; update(); });
    const heptaRow = row(t("kmaker.mode"), heptaSel);

    const patternSel = el("select");
    patternSel.addEventListener("change", () => {
      const [a, b] = patternSel.value.split(",").map(Number);
      s.mos = { ...s.mos, a, b, mode: 0 };
      update();
    });
    const patternRow = row(t("kmaker.pattern"), patternSel, t("kmaker.patternTitle"));
    const sizeSel = el("select");
    sizeSel.addEventListener("change", () => {
      const [L, sm] = sizeSel.value.split(",").map(Number);
      s.mos = { ...s.mos, L, s: sm };
      update();
    });
    const sizeRow = row(t("kmaker.sizes"), sizeSel, t("kmaker.sizesTitle"));
    const mosModeSel = el("select");
    mosModeSel.addEventListener("change", () => { s.mos = { ...s.mos, mode: Number(mosModeSel.value) }; update(); });
    const mosModeRow = row(t("kmaker.mode"), mosModeSel, t("kmaker.mosModeTitle"));
    form.append(pentaRow, heptaRow, patternRow, sizeRow, mosModeRow);

    // ── where it sits on the board ──
    const tonicSel = el("select");
    tonicSel.addEventListener("change", () => { s.tonic = Number(tonicSel.value); update(); });
    form.append(row(t("kmaker.tonic"), tonicSel));

    const stepInput = el("input");
    stepInput.type = "number";
    stepInput.min = "1"; stepInput.max = "40"; stepInput.step = "1";
    stepInput.addEventListener("change", () => {
      const v = Math.round(Number(stepInput.value));
      s.rowStep = Number.isFinite(v) && v >= 1 ? Math.min(v, 40) : null;
      update();
    });
    const stepWrap = el("span", "kmaker-step");
    stepWrap.append(stepInput, el("span", "dim", t("kmaker.rowStepUnit")));
    const stepNote = el("p", "modal-hint kmaker-hint", "");
    form.append(row(t("kmaker.rowStep"), stepWrap), stepNote);

    const rowWrap = el("span", "keymap-rows kmaker-rows");
    const lamps = new Map();
    for (const name of ROWS) {
      const lamp = lampButton({
        label: t(`keymap.row.${name}`), on: s.rows.includes(name),
        onChange: (on) => {
          const next = ROWS.filter((r) => (r === name ? on : s.rows.includes(r)));
          if (next.length === 0) { lamp.setOn(true); return; } // a layout needs a row
          s.rows = next;
          update();
        },
      });
      lamps.set(name, lamp);
      rowWrap.append(lamp.button);
    }
    form.append(row(t("keymap.rows"), rowWrap));

    const nameInput = el("input", "kmaker-name");
    nameInput.type = "text";
    nameInput.addEventListener("input", () => { nameEdited = nameInput.value.trim() !== ""; });
    form.append(row(t("kmaker.name"), nameInput));
    dlg.append(form);

    // ── the picture and what it reaches ──
    const stage = el("div", "kmaker-stage");
    const canvas = el("canvas", "kmaker-board");
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", t("kmaker.previewLabel"));
    stage.append(canvas);
    dlg.append(stage);
    const notesLine = el("p", "kmaker-notes", "");
    const reachLine = el("p", "dim kmaker-reach", "");
    dlg.append(notesLine, reachLine);

    const { row: btnRow, proceed: okBtn, cancel: cancelBtn } =
      actionRow({ cancel: true, proceed: t("kmaker.make") });
    dlg.append(btnRow);

    // ── recomputing ──
    let spec = null;
    let layout = new Map();
    const held = new Set();

    /** Bring every control in line with `s` and the frame, then rebuild the
     *  layout. A choice the frame cannot play is moved to the first one it
     *  can, so the form never sits on a greyed option. */
    function update() {
      const frame = makerFrame(s.mode, preset);
      modeSeg.set(s.mode);
      frameHint.textContent = s.mode === "tuning"
        ? t("kmaker.frameHint.tuning", { tuning: preset.name })
        : tuningUsable ? t("kmaker.frameHint.any") : t("kmaker.frameHint.anyOnly");

      for (const k of SCALE_KINDS) kindSeg.enable(k, kindAvailable(k, frame));
      if (!kindAvailable(s.kind, frame)) s.kind = SCALE_KINDS.find((k) => kindAvailable(k, frame)) ?? s.kind;
      kindSeg.set(s.kind);

      pentaRow.hidden = s.kind !== "penta";
      heptaRow.hidden = s.kind !== "hepta";
      patternRow.hidden = sizeRow.hidden = mosModeRow.hidden = s.kind !== "mos";
      pentaSeg.set(s.penta);
      heptaSel.value = s.hepta;
      if (s.kind === "mos") updateMos(frame);

      updateTonic(frame);
      const scale = scaleOf(s, frame);
      const k = scale?.steps.length ?? 7;
      stepInput.value = String(rowStepOf(s, k));
      const rs = rowStepOf(s, k);
      stepNote.textContent = rs === k ? t("kmaker.rowStepNote.period")
        : rs === 10 ? t("kmaker.rowStepNote.run")
        : rs < 10 ? t("kmaker.rowStepNote.overlap", { n: 10 - rs })
        : t("kmaker.rowStepNote.gap", { n: rs - 10 });
      for (const [name, lamp] of lamps) lamp.setOn(s.rows.includes(name));

      if (!nameEdited) nameInput.value = autoName(frame, scale);
      spec = scale ? makeScaleKeymap({ ...s, name: nameInput.value }, frame) : null;
      okBtn.disabled = spec === null;
      describe(frame, scale);
      paint();
    }

    function updateMos(frame) {
      const patterns = mosPatterns();
      fillSelect(patternSel, patterns.map((p) => [`${p.a},${p.b}`,
        t("kmaker.patternOption", { a: p.a, b: p.b }),
        mosSizes(p.a, p.b, frame).length > 0,
        t("kmaker.patternGroup", { n: p.size })]));
      const playable = (p) => mosSizes(p.a, p.b, frame).length > 0;
      if (!patterns.some((p) => p.a === s.mos.a && p.b === s.mos.b && playable(p))) {
        // The diatonic pattern where the tuning has it, else the first it has.
        const pick = patterns.find((p) => p.a === 5 && p.b === 2 && playable(p)) ?? patterns.find(playable);
        if (pick) s.mos = { ...s.mos, a: pick.a, b: pick.b, mode: 0 };
      }
      patternSel.value = `${s.mos.a},${s.mos.b}`;

      const sizes = mosSizes(s.mos.a, s.mos.b, frame);
      fillSelect(sizeSel, sizes.map(([L, sm]) => [`${L},${sm}`, frame.mode === "any"
        ? t("kmaker.sizeOption.any", { L, s: sm, n: s.mos.a * L + s.mos.b * sm })
        : t("kmaker.sizeOption.tuning", { L, s: sm })]));
      if (!sizes.some(([L, sm]) => L === s.mos.L && sm === s.mos.s)) {
        const d = defaultMosSize(sizes);
        if (d) s.mos = { ...s.mos, L: d[0], s: d[1] };
      }
      sizeSel.value = `${s.mos.L},${s.mos.s}`;

      const modes = mosModes(s.mos.a, s.mos.b);
      const diatonic = s.mos.a === 5 && s.mos.b === 2;
      fillSelect(mosModeSel, modes.map((w, i) => [i, diatonic
        ? t("kmaker.mosModeNamed", { i: i + 1, word: w, name: t(`kmaker.hepta.${DIATONIC_BRIGHTNESS[i]}`) })
        : i === 0 ? t("kmaker.mosModeBrightest", { i: i + 1, word: w })
        : i === modes.length - 1 ? t("kmaker.mosModeDarkest", { i: i + 1, word: w })
        : t("kmaker.mosModeOption", { i: i + 1, word: w })]));
      s.mos.mode = Math.min(s.mos.mode, modes.length - 1);
      mosModeSel.value = String(s.mos.mode);
    }

    /** The tonic list: the tuning's degrees by their own names, or the twelve
     *  semitones from C. */
    function updateTonic(frame) {
      const deg = frame.unit === "deg";
      const n = deg ? frame.n : 12;
      const opts = [];
      for (let i = 0; i < n; i++) {
        const note = deg ? noteForDegree(4, i, preset) : semiToNote(4, i);
        const name = noteLabel(note, deg ? preset : TET12, { octave: false });
        opts.push([i, deg ? t("kmaker.tonicDegree", { name, n: i }) : name]);
      }
      fillSelect(tonicSel, opts);
      if (!(s.tonic >= 0 && s.tonic < n)) s.tonic = 0;
      tonicSel.value = String(s.tonic);
    }

    function tonicName(frame) {
      const deg = frame.unit === "deg";
      const note = deg ? noteForDegree(4, s.tonic, preset) : semiToNote(4, s.tonic);
      return noteLabel(note, deg ? preset : TET12, { octave: false });
    }

    function autoName(frame, scale) {
      const tonic = tonicName(frame);
      let name;
      if (s.kind === "penta") name = t(`kmaker.name.penta.${s.penta}`, { tonic });
      else if (s.kind === "hepta") name = t(`kmaker.name.hepta.${s.hepta}`, { tonic });
      else name = t("kmaker.name.mos", { tonic, a: s.mos.a, b: s.mos.b, L: s.mos.L, s: s.mos.s, mode: s.mos.mode + 1 });
      // A layout in degrees is only right in its own tuning, so it says which.
      return s.mode === "tuning" && scale ? t("kmaker.name.inTuning", { name, tuning: preset.name }) : name;
    }

    /** The scale's notes as the song will spell them, and what the board reaches. */
    function describe(frame, scale) {
      if (!scale) {
        notesLine.replaceChildren(t("kmaker.unavailable", { tuning: preset.name }));
        reachLine.textContent = "";
        return;
      }
      const parts = [el("span", "dim", `${t("kmaker.notes")} `)];
      for (const off of scaleOffsets(scale)) {
        const v = s.tonic + off;
        const note = frame.unit === "deg" ? noteForDegree(4, v, preset) : semiToNoteInTable(4, v, preset);
        parts.push(noteGlyph(note, preset), " ");
      }
      const steps = s.kind === "mos" ? scale.word.split("").join(" ") : scale.steps.join(" ");
      parts.push(el("span", "dim", ` · ${t("kmaker.steps")} ${steps}`));
      if (frame.mode === "any") parts.push(el("span", "dim", ` · ${t("kmaker.exactIn", { n: scale.period })}`));
      notesLine.replaceChildren(...parts);
      const st = keymapStats(spec, preset, octave);
      reachLine.textContent = st.total > 0
        ? t("kmaker.reach", { n: st.reachable, total: st.total, dup: st.duplicates })
        : t("kmaker.reachRaw", { n: st.reachable, dup: st.duplicates });
    }

    function paint() {
      const dpr = uiDpr();
      const W = Math.max(320, Math.round(stage.clientWidth || 600));
      const shown = spec ?? { rows: s.rows, x: 0, y: 0, overrides: {}, unit: "deg",
        origin: { code: "KeyA", value: 0 } };
      const ext = boardExtent(shown, "full", ortho);
      const H = Math.round(Math.min(W * (ext.h / ext.w), 260));
      if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.style.width = `${W}px`; }
      if (canvas.height !== Math.round(H * dpr)) { canvas.height = Math.round(H * dpr); canvas.style.height = `${H}px`; }
      const g = canvas.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      layout = paintKeymapBoard(g, { spec: shown, preset, octave, w: W, h: H, size: "full", ortho, held, legend });
    }

    // ── audition: a click on a cap sounds it ──
    function capAt(x, y) {
      const a = layout.get("KeyA") ?? layout.get("KeyQ"), b = layout.get("KeyS") ?? layout.get("KeyW");
      const pitch = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 40;
      let best = null, bestD = (pitch * 0.6) ** 2;
      for (const [code, pt] of layout) {
        const d = (pt.x - x) ** 2 + (pt.y - y) ** 2;
        if (d < bestD) { bestD = d; best = code; }
      }
      return best;
    }
    canvas.addEventListener("pointerdown", (e) => {
      if (!spec || !play) return;
      const code = capAt(toLayout(e.offsetX), toLayout(e.offsetY));
      const note = code && keymapNote(spec, code, octave, preset);
      if (!code || note === null) return;
      play(code, note);
      held.add(code);
      paint();
      const release = () => {
        window.removeEventListener("pointerup", release);
        stop?.(code);
        held.delete(code);
        paint();
      };
      window.addEventListener("pointerup", release);
    });

    // ── finishing ──
    const ro = new ResizeObserver(() => paint());
    const finish = (result) => {
      ro.disconnect();
      lastSettings = structuredClone(s);
      dlg.close();
      dlg.remove();
      resolve(result);
    };
    cancelBtn.addEventListener("click", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("cancel", () => finish(null));
    // Never leak a key to the piano or the transport behind the dialog.
    // Enter is Proceed from a text or number field, as in every other dialog.
    dlg.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && e.target.tagName === "INPUT") {
        e.preventDefault();
        e.target.dispatchEvent(new Event("change"));
        okBtn.click();
      }
    });
    okBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (!spec) return;
      const name = nameInput.value.trim() || autoName(makerFrame(s.mode, preset), scaleOf(s, makerFrame(s.mode, preset)));
      finish({ ...spec, name });
    });

    document.body.appendChild(dlg);
    dlg.showModal();
    update();
    ro.observe(stage);
  });
}
