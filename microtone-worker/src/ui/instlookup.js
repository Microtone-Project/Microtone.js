// Quick instrument lookup (item 27) — a toggleable panel docked to the LEFT
// of the Timeline + Patterns grids (item 168, mirroring the master strip's
// dock on the right) listing the top-level instruments ($01..$FF) with their
// names. Clicking a row makes it the current jam/entry instrument. Meta LAYER
// CHILDREN (sub-instruments) that happen to fall in $01..$FF are hidden —
// only real, directly-triggerable instruments are shown.
//
// Each row's index number doubles as a play-indicator lamp while a voice is
// actually sounding that instrument (item 169) — the same "which slots are
// live" query the Instruments tab's own blinkenlights use (instruments.js
// updateLiveDots), but lighting the NUMBER TEXT itself rather than a separate
// dot, per iyagimusic-js's text-blinkenlight convention (`.ch-name`/`.on`,
// see visualiser.js + style.css there). Brightness (not just on/off) follows
// the shared lamp.js ballistics — see there for the why.

import { unescapeName } from "../../core/format/names.js";
import { t } from "./i18n.js";
import { TOTAL_VOICES } from "../../core/engine/constants.js";
import { Lamp, liveBrightnessByKey } from "./lamp.js";

const PREF_KEY = "microtone-instlist";

function loadPref() {
  try { return localStorage.getItem(PREF_KEY) === "1"; } catch { return false; }
}
function savePref(v) {
  try { localStorage.setItem(PREF_KEY, v ? "1" : "0"); } catch { /* private mode */ }
}

export class InstLookup {
  constructor(store, jam, el, onPick) {
    this.store = store;
    this.jam = jam;
    this.el = el;
    this.onPick = onPick; // called after a pick so the shell can refresh status
    this.enabled = loadPref();
    this.lamps = new Map(); // slot -> Lamp; outlives render() rebuilds
    this._lastFrameMs = 0;

    store.on("doc", () => this.render());
    store.on("view", () => this.applyVisibility());
    store.on("edit", (tags) => {
      if (tags?.some?.((tag) => tag.kind === "bank" || tag.kind === "inst" || tag.kind === "section")) {
        this.render();
      }
    });
    // current-instrument changes (topbar wheel, Enter pick-up, jam) repaint the
    // highlight cheaply without a full rebuild.
    store.on("instsel", () => this.highlight());
  }

  get visible() { return this.enabled; }

  toggle() {
    this.enabled = !this.enabled;
    savePref(this.enabled);
    this.applyVisibility();
    return this.enabled;
  }

  /** Shown only when enabled AND on a grid view (Timeline/Patterns) with a doc.
   *  With the view split (item 148) either pane will do — the shell moves the
   *  panel into whichever one is holding a grid. A real flex sibling of
   *  .view-canvases (item 168), so hiding it (`hidden` ⇒ `display:none`) is
   *  everything needed to hand its width back — no separate class to keep in
   *  step. */
  applyVisibility() {
    const onGrid = this.store.viewOpen("timeline") || this.store.viewOpen("pattern");
    const show = this.enabled && onGrid && !!this.store.doc;
    this.el.hidden = !show;
    if (show) this.render();
  }

  /** Used top-level slots in $01..$FF, excluding meta-layer children. */
  topLevelSlots() {
    const doc = this.store.doc;
    if (!doc) return [];
    const children = new Set();
    const used = doc.usedInstrumentSlots();
    for (const s of used) {
      const layers = doc.instruments[s].metaLayers;
      if (layers) for (const l of layers) children.add(l.instIdx);
    }
    return used.filter((s) => s >= 1 && s <= 0xff && !children.has(s));
  }

  render() {
    if (this.el.hidden) return;
    const doc = this.store.doc;
    if (!doc) { this.el.innerHTML = ""; this.rowEls = []; return; }
    const slots = this.topLevelSlots();
    const head =
      `<div class="il-head">${esc(t("instList.title"))} ` +
      `<span class="dim">(${slots.length})</span></div>`;
    const rows = slots.map((s) => {
      const inst = doc.instruments[s];
      const kind = inst.isFm ? "F" : inst.isMeta ? "M" : inst.extraPatches ? "X" : "";
      const name = esc(unescapeName(doc.instrumentName(s)) || t("instList.unnamed"));
      const sel = s === this.jam.currentInst ? " sel" : "";
      return `<div class="il-row${sel}" data-slot="${s}">` +
        `<span class="il-idx">${s.toString(16).toUpperCase().padStart(2, "0")}</span>` +
        `<span class="il-name">${name}</span>` +
        `<span class="il-kind">${kind}</span></div>`;
    }).join("");
    this.el.innerHTML = head +
      `<div class="il-list">${rows || `<div class="dim il-empty">${esc(t("instList.none"))}</div>`}</div>`;
    this.rowEls = [...this.el.querySelectorAll(".il-row")]
      .map((el) => ({ el, slot: parseInt(el.dataset.slot, 10) }));
    for (const { el, slot } of this.rowEls) {
      el.addEventListener("click", () => {
        this.jam.currentInst = slot;
        this.highlight();
        this.onPick?.();
      });
    }
  }

  /** Toggle the .sel class to match the current instrument (no rebuild). */
  highlight() {
    if (this.el.hidden) return;
    for (const { el, slot } of this.rowEls ?? []) el.classList.toggle("sel", slot === this.jam.currentInst);
  }

  /** Per-frame (app.js's rAF loop): light each row's index number — the
   *  `.il-idx` text itself is the lamp, no separate dot — while a voice is
   *  actually sounding that slot right now. Mirrors instruments.js's
   *  updateLiveDots() query exactly; only the styling differs. Brightness
   *  (--lamp, read by the CSS) rather than a plain on/off class — see
   *  lamp.js for the volume-driven, slewed, probabilistic-sum ballistics. */
  frame() {
    if (this.el.hidden || !this.rowEls?.length) return;
    const audio = this.store.audio;
    const now = performance.now();
    const dt = this._lastFrameMs ? now - this._lastFrameMs : 16;
    this._lastFrameMs = now;
    const brightByKey = audio
      ? liveBrightnessByKey(audio, TOTAL_VOICES, (vi) => audio.getVoiceInstrument(vi))
      : new Map();
    for (const { el, slot } of this.rowEls) {
      let lamp = this.lamps.get(slot);
      if (!lamp) this.lamps.set(slot, lamp = new Lamp());
      el.style.setProperty("--lamp", lamp.update(brightByKey.get(slot) ?? 0, dt).toFixed(3));
    }
  }
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
