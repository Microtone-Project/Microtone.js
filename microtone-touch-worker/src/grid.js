// The pattern grid — one section, every lane side by side, 64 rows.
//
// Built once; afterwards only what changed is written. Each cell remembers the
// text and classes it shows and a render compares before it touches the DOM
// (a same-string textContent write still re-lays-out the page), and the
// playhead moves by toggling one row's class off and the next one's on.

import { LANES, ROWS, NOTE_OFF, FX } from "./sketch.js";
import { DRUMS, presetById } from "./presets.js";
import { noteLabel } from "./notes.js";

const ROWS_PER_BEAT = 4;
const ROWS_PER_BAR = 16;

export class Grid {
  /** `handlers.cell(lane, row)` on a tap, `handlers.lane(lane)` on a header. */
  constructor(el, wrap, handlers) {
    this.el = el;
    this.wrap = wrap;
    this.handlers = handlers;
    this.heads = [];
    this.rows = [];   // rows[r] = [rowLabel, cell 0, …, cell 7]
    this.shown = [];  // shown[l][r] = { text, cls, fx } last written
    this.playRow = -1;
    this.cursor = { lane: -1, row: -1 };
    this._build();
  }

  _build() {
    const frag = document.createDocumentFragment();
    const corner = document.createElement("div");
    corner.className = "gh corner";
    frag.append(corner);
    for (let l = 0; l < LANES; l++) {
      const h = document.createElement("button");
      h.className = "gh";
      h.style.setProperty("--lane-colour", `var(--lane-${l})`);
      h.addEventListener("click", () => this.handlers.lane(l));
      this.heads.push(h);
      frag.append(h);
    }
    for (let r = 0; r < ROWS; r++) {
      const band = r % ROWS_PER_BAR === 0 ? " bar16" : r % ROWS_PER_BEAT === 0 ? " beat" : "";
      const label = document.createElement("div");
      label.className = "gr" + band;
      label.textContent = String(r).padStart(2, "0");
      const row = [label];
      frag.append(label);
      for (let l = 0; l < LANES; l++) {
        const c = document.createElement("div");
        c.className = "gc empty" + band;
        c.dataset.band = band;
        c.style.setProperty("--lane-colour", `var(--lane-${l})`);
        c.addEventListener("click", () => this.handlers.cell(l, r));
        row.push(c);
        frag.append(c);
      }
      this.rows.push(row);
    }
    this.el.append(frag);
    this.shown = Array.from({ length: LANES }, () => new Array(ROWS).fill(null));
  }

  /** Bring every header and cell up to date with `sketch`'s `section`. */
  render(sketch, section, pitchPreset, selectedLane) {
    for (let l = 0; l < LANES; l++) {
      const lane = sketch.lanes[l];
      const h = this.heads[l];
      const text = presetById(lane.preset).short;
      if (h.textContent !== text) h.textContent = text;
      h.classList.toggle("muted", lane.mute);
      const sel = String(l === selectedLane);
      if (h.getAttribute("aria-selected") !== sel) h.setAttribute("aria-selected", sel);
      const cells = sketch.sections[section].cells[l];
      for (let r = 0; r < ROWS; r++) this._paintCell(l, r, cells[r], pitchPreset);
    }
  }

  _paintCell(l, r, cell, pitchPreset) {
    let text = "·", kind = "empty", fx = "";
    if (cell) {
      if (cell.n === NOTE_OFF) { text = "off"; kind = "off"; }
      else {
        text = cell.d !== undefined ? DRUMS[cell.d].short : noteLabel(cell.n, pitchPreset);
        kind = "note";
        if (cell.fx && FX[cell.fx]) fx = FX_TAG[cell.fx] + ((cell.lv ?? 1) + 1);
      }
    }
    const was = this.shown[l][r];
    if (was && was.text === text && was.kind === kind && was.fx === fx) return;
    this.shown[l][r] = { text, kind, fx };
    const el = this.rows[r][l + 1];
    el.classList.toggle("empty", kind === "empty");
    el.classList.toggle("off", kind === "off");
    el.textContent = text;
    if (fx) {
      const tag = document.createElement("span");
      tag.className = "fx";
      tag.textContent = fx;
      el.append(tag);
    }
  }

  // Both of these scroll FIRST and write classes after: the geometry they read
  // is then the previous frame's, already laid out, so a moving playhead never
  // forces a layout of its own.

  setPlayRow(row) {
    if (row === this.playRow) return;
    if (row >= 0) this._keepVisible(row, false);
    if (this.playRow >= 0) for (const el of this.rows[this.playRow]) el.classList.remove("play");
    this.playRow = row;
    if (row >= 0) for (const el of this.rows[row]) el.classList.add("play");
  }

  setCursor(lane, row) {
    const was = this.cursor;
    if (was.lane === lane && was.row === row) return;
    this._keepVisible(row, true);
    if (was.row >= 0) this.rows[was.row][was.lane + 1].classList.remove("cur");
    this.cursor = { lane, row };
    this.rows[row][lane + 1].classList.add("cur");
  }

  /** Scroll only when the row has left the view (or, playing, is about to). */
  _keepVisible(row, nearest) {
    const el = this.rows[row][0];
    const top = el.offsetTop;
    const h = el.offsetHeight;
    const head = this.heads[0].offsetHeight;
    const view = this.wrap;
    const lead = nearest ? 0 : h * 2;
    if (top - head - lead < view.scrollTop) {
      view.scrollTop = Math.max(0, top - head - (nearest ? 0 : view.clientHeight / 3));
    } else if (top + h + lead > view.scrollTop + view.clientHeight) {
      view.scrollTop = top + h - view.clientHeight + (nearest ? 0 : view.clientHeight / 2);
    }
  }
}

/** A cell's effect marker: the effect's letter. */
const FX_TAG = Object.freeze({ slide: "S", vibrato: "V", roll: "R", fade: "F" });
