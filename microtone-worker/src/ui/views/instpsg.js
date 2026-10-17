// The PSG tab — the editor of a type-9 instrument's two oscillators
// (TAUD_FILE_FORMAT §7.9).
//
// Laid out as the OPL tab is, because its envelopes ARE the chip's: one group
// per oscillator, with the envelope sketched at its top under a window that
// draws the waveform, then the same AR DR SL RR TL KSL MULT fields and the
// Sustain / Key scale rate switches, then what is the PSG's own — invert,
// reset on trigger, tremolo and vibrato depths, auto-advance and its pattern. The mixer's
// group (add or multiply, and the two mutes) sits above both.
//
// During playback the tab shows what `S $Axxx` and the auto-advance have done
// to the instrument, in the accent colour, as the Samples tab shows invert
// loop's mask: a level, an auto-advance or a mute the overlay holds stands in
// its field, and a waveform the auto-advance has moved is drawn in its window.
// When playback stops the record's own values come back.

import { setInstBytesOp } from "../../doc/ops.js";
import {
  psgFields, psgOscBytes, psgSwitchBytes, psgWavePoints, PSG_ENV_FIELDS, psgPatternLabels,
} from "../../doc/psgedit.js";
import { oplEnvelopeSvg } from "../oplsketch.js";
import { t } from "../i18n.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** The waveform's name, its hex digit first as the record and S $Axxx know it. */
export function psgWaveName(w) {
  return `${w.toString(16).toUpperCase()} · ${t(`psg.wave${w.toString(16).toUpperCase()}`)}`;
}

/**
 * The waveform window: two cycles of `wave` in volts, 0 V along the bottom and
 * 1 V along the top, with no reference line — the window shows the shape the
 * oscillator makes, as small as the OPL envelope sketch beside it. `live`
 * draws it in the accent colour and names it, for a waveform the auto-advance
 * has moved.
 */
function waveSvg(wave, invert, index, live = false) {
  const W = 150, H = 48;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "psg-wave" + (live ? " live" : ""));
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", psgWaveName(wave));
  svg.dataset.osc = String(index);
  // A step drawn as a step: each point holds until the next, so a pulse's
  // edges stand upright and a 4-bit wave shows its stairs.
  const pts = psgWavePoints(wave, invert, 128, 2);
  const y = (v) => 4 + (1 - v) * (H - 8);    // 1 V (+1) at the top, 0 V (−1) at the bottom
  const coords = [];
  for (let i = 0; i < pts.length; i++) {
    const x0 = (i / pts.length) * W, x1 = ((i + 1) / pts.length) * W;
    coords.push(`${x0.toFixed(2)},${y(pts[i]).toFixed(2)}`, `${x1.toFixed(2)},${y(pts[i]).toFixed(2)}`);
  }
  const line = document.createElementNS(SVG_NS, "polyline");
  line.setAttribute("points", coords.join(" "));
  line.setAttribute("vector-effect", "non-scaling-stroke");
  svg.appendChild(line);
  if (live) {
    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", W - 3); label.setAttribute("y", 10);
    label.setAttribute("text-anchor", "end");
    label.setAttribute("class", "psg-wave-label");
    label.textContent = wave.toString(16).toUpperCase();
    svg.appendChild(label);
  }
  return svg;
}

/** Render the PSG tab into `view.panel`. */
export function renderPsgTab(view, inst) {
  const slot = view.selected;
  const f = psgFields(inst);
  // The fields the playback display writes into, by oscillator.
  const live = { slot, level: [], advance: [], mute: [], wave: [], shown: false };

  const apply = (pairs, key) => {
    view.applyQuiet(setInstBytesOp(slot, pairs, view.oplGesture(`psg.${key}`)));
    refreshSketches(view, slot);
    view.refreshListBadge(slot);
  };
  const field = (label, control, title = "") => {
    const row = el("label", "inst-field");
    if (title) row.title = title;
    row.append(el("span", "", label), control);
    return row;
  };
  const num = (value, max, onChange, min = 0) => {
    const input = document.createElement("input");
    input.type = "number";
    input.min = min; input.max = max; input.value = value;
    input.addEventListener("change", () => {
      const v = Math.min(Math.max(Math.round(+input.value || 0), min), max);
      input.value = v;
      onChange(v);
    });
    return input;
  };
  const check = (value, onChange) => {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!value;
    input.addEventListener("change", () => onChange(input.checked ? 1 : 0));
    return input;
  };
  const select = (value, options, onChange) => {
    const sel = document.createElement("select");
    for (const [v, text] of options) sel.appendChild(new Option(text, v, false, v === value));
    sel.addEventListener("change", () => onChange(+sel.value));
    return sel;
  };

  // ── the mixer ──
  const mixer = el("div", "inst-group opl-chan");
  mixer.appendChild(el("div", "inst-group-head", t("psg.grpMixer")));
  mixer.appendChild(field(t("psg.mix"),
    select(f.multiply ? 1 : 0, [[0, t("psg.mixAdd")], [1, t("psg.mixMul")]],
      (v) => {
        view.store.undo.apply(setInstBytesOp(slot, psgSwitchBytes(inst, "multiply", v === 1)));
        view.refreshListBadge(slot);
      }),
    t("psg.mixTitle")));
  for (const [i, key] of [[0, "muteA"], [1, "muteB"]]) {
    const box = check(f[key], (v) => view.store.undo.apply(setInstBytesOp(slot, psgSwitchBytes(inst, key, v === 1))));
    live.mute[i] = { input: box, record: f[key] };
    mixer.appendChild(field(t(i === 0 ? "psg.muteA" : "psg.muteB"), box, t("psg.muteTitle")));
  }

  // ── the oscillators ──
  const waves = Array.from({ length: 16 }, (_, w) => [w, psgWaveName(w)]);
  const oscillator = (o) => {
    const of = f.osc[o];
    const box = el("div", "inst-group opl-op psg-osc");
    box.appendChild(el("div", "inst-group-head", t(o === 0 ? "psg.oscA" : "psg.oscB")));
    const win = waveSvg(of.wave, of.invert, o);
    live.wave[o] = { svg: win, record: of.wave, invert: !!of.invert, shown: of.wave };
    box.append(win, oplEnvelopeSvg({ ...of, eg: of.eg }, o));
    box.appendChild(field(t("psg.f.wave"),
      select(of.wave, waves, (v) => apply(psgOscBytes(inst, o, "wave", v), `${o}.wave`)),
      t("psg.f.waveTitle")));
    for (const fd of PSG_ENV_FIELDS) {
      const val = of[fd.key];
      const control = fd.max === 1
        ? check(val, (v) => apply(psgOscBytes(inst, o, fd.key, v), `${o}.${fd.key}`))
        : num(val, fd.max, (v) => apply(psgOscBytes(inst, o, fd.key, v), `${o}.${fd.key}`));
      if (fd.key === "tl") live.level[o] = { input: control, record: val };
      box.appendChild(field(t(`opl.f.${fd.key}`), control, t(`opl.f.${fd.key}Title`)));
    }
    box.appendChild(field(t("psg.f.invert"),
      check(of.invert, (v) => apply(psgOscBytes(inst, o, "invert", v), `${o}.invert`)),
      t("psg.f.invertTitle")));
    box.appendChild(field(t("psg.f.reset"),
      check(of.reset, (v) => apply(psgOscBytes(inst, o, "reset", v), `${o}.reset`)),
      t("psg.f.resetTitle")));
    const depth = (key, labels) => select(of[key] === 3 ? 0 : of[key],
      labels.map((text, v) => [v, text]),
      (v) => apply(psgOscBytes(inst, o, key, v), `${o}.${key}`));
    box.appendChild(field(t("psg.f.tremolo"),
      depth("tremolo", [t("psg.off"), "1 dB", "4.8 dB"]), t("psg.f.tremoloTitle")));
    box.appendChild(field(t("psg.f.vibrato"),
      depth("vibrato", [t("psg.off"), t("psg.cents", { n: 7 }), t("psg.cents", { n: 14 })]),
      t("psg.f.vibratoTitle")));
    const adv = num(of.advance, 255, (v) => apply(psgOscBytes(inst, o, "advance", v), `${o}.advance`));
    live.advance[o] = { input: adv, record: of.advance };
    box.appendChild(field(t("psg.f.advance"), adv, t("psg.f.advanceTitle")));
    // Each pattern named by the waveforms it plays from this oscillator's own,
    // rewritten whenever that changes (refreshSketches).
    const patSel = select(of.pattern, psgPatternLabels(of.wave).map((text, v) => [v, text]),
      (v) => apply(psgOscBytes(inst, o, "pattern", v), `${o}.pattern`));
    patSel.dataset.psgPattern = String(o);
    const pat = field(t("psg.f.pattern"), patSel, t("psg.f.patternTitle"));
    pat.classList.add("psg-pattern");
    box.appendChild(pat);
    return box;
  };

  const wrap = el("div", "opl-edit psg-edit");
  const grid = el("div", "inst-grid");
  grid.append(oscillator(0), oscillator(1), mixer);
  wrap.append(grid,
    el("p", "dim opl-note", t("psg.liveNote")),
    el("p", "dim opl-note", t("opl.envNote")));
  view.panel.appendChild(wrap);
  view._psgLive = live;
}

/** Redraw the waveform windows and envelope sketches after an edit. */
function refreshSketches(view, slot) {
  const inst = view.store.doc?.instruments[slot];
  if (!inst?.isPsg) return;
  const f = psgFields(inst);
  for (const svg of view.panel.querySelectorAll("svg.opl-env[data-op]")) {
    svg.replaceWith(oplEnvelopeSvg(f.osc[+svg.dataset.op], +svg.dataset.op));
  }
  // The pattern picker names what each pattern plays from the waveform now set.
  for (const sel of view.panel.querySelectorAll("select[data-psg-pattern]")) {
    const labels = psgPatternLabels(f.osc[+sel.dataset.psgPattern].wave);
    labels.forEach((text, v) => { if (sel.options[v].text !== text) sel.options[v].text = text; });
  }
  const live = view._psgLive;
  for (const svg of view.panel.querySelectorAll("svg.psg-wave[data-osc]")) {
    const o = +svg.dataset.osc;
    const next = waveSvg(f.osc[o].wave, f.osc[o].invert, o);
    svg.replaceWith(next);
    if (live?.wave[o]) Object.assign(live.wave[o], { svg: next, record: f.osc[o].wave, invert: !!f.osc[o].invert, shown: f.osc[o].wave });
  }
  if (live) {
    for (let o = 0; o < 2; o++) {
      if (live.level[o]) live.level[o].record = f.osc[o].tl;
      if (live.advance[o]) live.advance[o].record = f.osc[o].advance;
    }
    live.mute[0].record = f.muteA;
    live.mute[1].record = f.muteB;
  }
}

/** A field showing an overlay value, or its record's own again. */
function showLive(entry, value, isLive, title) {
  const input = entry.input;
  if (input.type === "checkbox") input.checked = !!value;
  else if (document.activeElement !== input) input.value = value;
  input.classList.toggle("psg-live", isLive);
  input.title = isLive ? title : "";
}

/**
 * Per frame while the PSG tab is open: ask the engine for the instrument's
 * live state (the reply lands a frame later) and show it. With playback
 * stopped, put the record's own values back once.
 */
export function psgTabFrame(view) {
  const live = view._psgLive;
  if (!live || !view.panel.isConnected) return;
  const audio = view.store.audio;
  const playing = !!audio?.isPlaying();
  if (playing) audio.requestInvertMask(live.slot);
  const st = playing ? audio.getPsgState(live.slot) : null;
  if (st === null && !live.shown) return;
  live.shown = st !== null;
  for (let o = 0; o < 2; o++) {
    const lv = st ? st.rtLevel[o] : -1;
    showLive(live.level[o], lv >= 0 ? lv : live.level[o].record, lv >= 0, t("psg.liveTitle"));
    const av = st ? st.rtAdvance[o] : -1;
    showLive(live.advance[o], av >= 0 ? av : live.advance[o].record, av >= 0, t("psg.liveTitle"));
    const mu = st ? st.rtMute : -1;
    showLive(live.mute[o], mu >= 0 ? ((mu >> o) & 1) === 1 : live.mute[o].record, mu >= 0,
      t("psg.liveTitle"));
    const w = live.wave[o];
    const want = st?.wave ? st.wave[o] : w.record;
    const isLive = want !== w.record;
    if (want !== w.shown || isLive !== w.svg.classList.contains("live")) {
      const next = waveSvg(want, w.invert, o, isLive);
      w.svg.replaceWith(next);
      w.svg = next;
      w.shown = want;
    }
  }
}
