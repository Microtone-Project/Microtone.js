// Keymap view — the jam keyboard laid out as a lattice you can see and edit.
//
// The board is drawn the way the Lumatone's own preset sheets are drawn: a
// staggered field of hex caps, each one showing the note it plays IN THE
// SONG'S NOTATION (41-TET caps carry Kite glyphs, Shi'er lü caps carry CJK)
// and coloured by its degree within the period. Colour is what makes a
// lattice legible — the repeating bands ARE the isomorphism, and a layout
// that strands a pitch class shows it as a colour that never appears.
//
// Nothing here touches the document: a keymap is a performer preference, so
// edits are live, saved to the library rather than to the song, and carry no
// undo entry. That is the deliberate difference from the Notation Maker, which
// edits a project section and lands as one undoable op.

import { t } from "../i18n.js";
import { themeColors, onThemeChange } from "../theme.js";
import { canvasFont } from "../fonts.js";
import { presetForNotation, pitchTablePresets } from "../pitchtables.js";
import { noteToStr } from "../notenames.js";
import { paintKeymapBoard, defaultLegend } from "../keymapboard.js";
import { pickFile, download } from "../../storage/import-export.js";
import { showModal } from "../widgets/modal.js";
import { showKeymapManual } from "../popups/keymapmanual.js";
import {
  resolveKeymap, keymapNote, keymapStats,
  normaliseKeymap, buildTaudkey, parseTaudkey, nearestRatio,
  QUOTE_ACTIONS, UNITS, BUILTIN_KEYMAPS,
} from "../keymap.js";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export class KeymapView {
  /**
   * @param host  container element
   * @param lib   KeymapLibrary — owns persistence and the active choice
   * @param jam   JamKeyboard, for the octave the board previews at
   */
  constructor(store, host, lib, jam) {
    this.store = store;
    this.host = host;
    this.lib = lib;
    this.jam = jam;
    /** The layout being edited — always a copy, so the library's own specs and
     *  the store's active map are never mutated under anyone. */
    this.draft = normaliseKeymap(store.keymap);
    this.draftIsBuiltin = true;
    this.selected = null;   // code of the cap under edit
    this.held = new Set();  // codes sounding right now, for the flash
    this.visible = false;
    this._layout = new Map(); // code → {x, y} cap centres, for hit-testing
    this._legends = new Map();

    this.root = document.createElement("div");
    this.root.className = "keymap-view";
    host.appendChild(this.root);
    this._build();
    onThemeChange(() => this.paint());
    // What the caps SAY comes from outside this view: the song's tuning (a load
    // or a notation change) and the jam octave, which the bracket keys and the
    // toolbar stepper move. The readouts are computed from both too, so these
    // refresh rather than merely repaint.
    store.on("doc", () => { if (this.visible) this.refresh(); });
    store.on("keymap", () => { if (this.visible) this.refresh(); });
    store.on("octave", () => { if (this.visible) this.refresh(); });
    this._loadLegends();
  }

  // ── lifecycle (the shell's view protocol) ──

  show() {
    this.visible = true;
    this.host.hidden = false;
    this.refresh();
  }

  hide() {
    this.visible = false;
    this.held.clear();
  }

  resize() { if (this.visible) this.paint(); }

  /** The view can be moved between split panes (item 148) — point the size
   *  observer at the stage it landed in and measure that one. */
  rehost() {
    this._ro.disconnect();
    this._ro.observe(this.canvas.parentElement);
    this.resize();
  }

  /** The tuning the board previews against — 12-TET when no song is loaded,
   *  since the tab is reachable before anything is open. */
  get preset() {
    return this.store.pitchPreset ?? pitchTablePresets[120];
  }

  // ── DOM ──

  _build() {
    this.root.innerHTML = `
      <aside class="keymap-library">
        <div class="keymap-head">${esc(t("keymap.layouts"))}</div>
        <ul class="keymap-list"></ul>
        <div class="keymap-libactions"></div>
      </aside>
      <div class="keymap-stage">
        <canvas class="keymap-board"></canvas>
        <div class="keymap-hint"></div>
      </div>
      <aside class="keymap-panel"></aside>`;
    this.listEl = this.root.querySelector(".keymap-list");
    this.libActions = this.root.querySelector(".keymap-libactions");
    this.canvas = this.root.querySelector(".keymap-board");
    this.hintEl = this.root.querySelector(".keymap-hint");
    this.panelEl = this.root.querySelector(".keymap-panel");

    this.canvas.addEventListener("pointerdown", (e) => this._onPointer(e));
    this.canvas.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });

    // The board is sized from its stage, so it has to be told when the stage
    // changes — a window resize, the pane divider being dragged, the split
    // opening or closing. Every other canvas view here owns an observer for the
    // same reason; this one was missing hers.
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this.canvas.parentElement);
  }

  /** The rail's fixed furniture. Rebuilt on every refresh rather than once, so
   *  a language change relabels it along with everything else. */
  _renderActions() {
    this.root.querySelector(".keymap-head").textContent = t("keymap.layouts");
    // Rename and Delete act on the SAVED layout in hand, so they are dead on a
    // built-in — shown disabled rather than silently doing nothing, which is
    // what Delete used to do.
    const rename = mkBtn(t("keymap.rename"), () => this._rename());
    const del = mkBtn(t("keymap.delete"), () => this._delete());
    rename.disabled = del.disabled = this.draftIsBuiltin;
    this.libActions.replaceChildren(
      mkBtn(t("keymap.new"), () => this._new()),
      mkBtn(t("keymap.duplicate"), () => this._duplicate()),
      rename,
      del,
      mkBtn(t("keymap.import"), () => this._import()),
      mkBtn(t("keymap.export"), () => this._export()),
    );
  }

  /** Physical legends, so a Dvorak or AZERTY user reads their OWN keys off the
   *  board — the mapping is by position, which is exactly why the printed
   *  letters cannot be assumed. Chromium-only; elsewhere the code name does. */
  async _loadLegends() {
    try {
      const map = await navigator.keyboard.getLayoutMap();
      for (const [code, label] of map) this._legends.set(code, label.toUpperCase());
      if (this.visible) this.paint();
    } catch { /* no keyboard map API — fall back to the code name */ }
  }

  legend(code) {
    return this._legends.get(code) ?? defaultLegend(code);
  }

  refresh() {
    // A layout is editable exactly when it is one of the user's saved ones;
    // everything else is a shipped built-in, which duplicates rather than
    // edits. Derived rather than remembered, so a save or a delete elsewhere
    // cannot leave the panel enabled over a layout that is no longer there.
    this.draftIsBuiltin = !this.lib.user.has(this.draft.name);
    this._renderActions();
    this._renderList();
    this._renderPanel();
    this.paint();
  }

  _renderList() {
    this.listEl.innerHTML = "";
    for (const entry of this.lib.entries()) {
      const li = document.createElement("li");
      li.className = "keymap-item";
      li.classList.toggle("active", entry.name === this.draft.name);
      li.classList.toggle("builtin", entry.builtin);
      li.innerHTML = `<span class="keymap-item-name">${esc(entry.name)}</span>` +
        (entry.spec.notation !== null
          ? `<span class="keymap-item-tag">${esc(notationName(entry.spec.notation))}</span>` : "");
      li.addEventListener("click", () => this._choose(entry));
      this.listEl.appendChild(li);
    }
  }

  _renderPanel() {
    const s = this.draft;
    const stats = keymapStats(s, this.preset, this.jam.octave);
    const locked = this.draftIsBuiltin;
    const p = document.createElement("div");
    p.className = "keymap-panel-inner";

    p.appendChild(section(t("keymap.startFrom"), (body) => {
      const sel = document.createElement("select");
      sel.innerHTML = `<option value="">${esc(t("keymap.startFromNone"))}</option>` + BUILTIN_KEYMAPS
        .map((k) => `<option value="${esc(k.name)}">${esc(k.name)}</option>`).join("");
      sel.addEventListener("change", () => {
        const base = BUILTIN_KEYMAPS.find((k) => k.name === sel.value);
        if (base) this._edit({ unit: base.unit, x: base.x, y: base.y, rows: base.rows, overrides: {} });
        sel.value = "";
      });
      sel.disabled = locked;
      body.appendChild(sel);
    }));

    p.appendChild(section(t("keymap.generator"), (body) => {
      body.appendChild(selectField(t("keymap.unit"), UNITS, s.unit, locked,
        (v) => this._edit({ unit: v })));
      body.appendChild(rowsField(s.rows, locked, (rows) => this._edit({ rows })));
      body.appendChild(numField(t("keymap.stepX"), s.x, locked, (v) => this._edit({ x: v })));
      body.appendChild(numField(t("keymap.stepY"), s.y, locked, (v) => this._edit({ y: v })));
      body.appendChild(numField(t("keymap.originValue"), s.origin.value, locked,
        (v) => this._edit({ origin: { ...s.origin, value: v } })));
      const originNote = document.createElement("div");
      originNote.className = "keymap-sub";
      originNote.textContent = t("keymap.originKey", { key: this.legend(s.origin.code) });
      body.appendChild(originNote);

      // The escape hatch from the lattice. An unequal temperament has degrees
      // of different sizes, so no pair of steps describes a useful keyboard for
      // it — those layouts get placed key by key instead.
      const manual = mkBtn(t("keymap.setEveryKey"), () => this._manual());
      manual.disabled = locked;
      body.appendChild(manual);
    }));

    p.appendChild(section(t("keymap.readout"), (body) => {
      const cover = stats.total > 0
        ? t("keymap.coverage", { n: stats.reachable, total: stats.total })
        : t("keymap.coverageRaw", { n: stats.reachable });
      body.appendChild(readout(t("keymap.degrees"), cover,
        stats.total > 0 && stats.reachable < stats.total));
      body.appendChild(readout(t("keymap.span"),
        stats.lowest === null ? "—" : `${noteToStr(stats.lowest)} … ${noteToStr(stats.highest)}`));
      body.appendChild(readout(t("keymap.axisX"), axisLabel(stats.axisCents.x)));
      body.appendChild(readout(t("keymap.axisY"), axisLabel(stats.axisCents.y)));
      body.appendChild(readout(t("keymap.doubled"), String(stats.duplicates)));
      if (s.rows.includes("Z")) {
        const warn = document.createElement("div");
        warn.className = "keymap-warn";
        warn.textContent = t("keymap.zRowWarning");
        body.appendChild(warn);
      }
    }));

    p.appendChild(section(t("keymap.binding"), (body) => {
      const sel = document.createElement("select");
      sel.innerHTML = `<option value="">${esc(t("keymap.anyTuning"))}</option>` +
        notationOptions().map(([value, label]) =>
          `<option value="${value}">${esc(label)}</option>`).join("");
      sel.value = s.notation === null ? "" : String(s.notation);
      sel.disabled = locked;
      sel.addEventListener("change", () =>
        this._edit({ notation: sel.value === "" ? null : Number(sel.value) }));
      body.appendChild(labelled(t("keymap.forNotation"), sel));
    }));

    // App configuration, NOT part of the layout — stated plainly, because a
    // setting sitting in this panel would otherwise look like one that travels
    // in the .taudkey with everything else here.
    p.appendChild(section(t("keymap.appSettings"), (body) => {
      const sel = document.createElement("select");
      sel.innerHTML = QUOTE_ACTIONS
        .map((a) => `<option value="${a}">${esc(t(`keymap.quote.${a}`))}</option>`).join("");
      sel.value = this.store.quoteKey;
      sel.addEventListener("change", () => { this.lib.setQuoteKey(sel.value); this._renderPanel(); });
      body.appendChild(labelled(t("keymap.quoteKey"), sel));

      // Ortholinear boards (Planck, Preonic, most split ergonomic keyboards)
      // put their keys in true columns. Drawing them staggered would be the
      // misleading picture, so this is a property of the reader's HARDWARE —
      // app configuration, like the Quote key, not part of any layout.
      const ortho = document.createElement("input");
      ortho.type = "checkbox";
      ortho.checked = this.store.keymapOrtho === true;
      ortho.addEventListener("change", () => {
        this.lib.setOrtho(ortho.checked);
        this.refresh();
      });
      body.appendChild(labelled(t("keymap.ortho"), ortho));

      const note = document.createElement("div");
      note.className = "keymap-sub";
      note.textContent = t("keymap.appSettingsNote");
      body.appendChild(note);
    }));

    this.panelEl.replaceChildren(p);
    this.hintEl.textContent = locked
      ? t("keymap.hintBuiltin")
      : t("keymap.hintEdit");
  }

  // ── editing ──

  /** Apply a change to the draft. Specs are immutable (the resolver memoises
   *  on identity), so every edit makes a new object. */
  _edit(patch) {
    if (this.draftIsBuiltin) return;
    this.draft = normaliseKeymap({ ...this.draft, ...patch });
    this._commit();
  }

  async _commit() {
    if (!this.draftIsBuiltin) await this.lib.save(this.draft);
    this.lib.setActive(this.draft, this.preset);
    this.refresh();
  }

  _choose(entry) {
    // The DRAFT is the fitted layout, not the stored one: "Octave rows" means
    // octaves of THIS tuning, and the board has to draw what the keyboard
    // actually plays rather than the spec's unfitted placeholder.
    this.draft = normaliseKeymap(this.lib.setActive(entry.spec, this.preset));
    this.draftIsBuiltin = entry.builtin;
    this.selected = null;
    this.refresh();
  }

  /** Place every key by hand — for tunings no generator can describe. */
  async _manual() {
    if (this.draftIsBuiltin) return;
    const next = await showKeymapManual(
      this.draft, this.preset, this.jam.octave, (c) => this.legend(c));
    if (!next) return;
    this.draft = normaliseKeymap({ ...next, name: this.draft.name });
    await this._commit();
  }

  async _new() {
    const name = this.lib.uniqueName(t("keymap.untitled"));
    this.draft = normaliseKeymap({ ...this.draft, name, overrides: {} });
    this.draftIsBuiltin = false;
    await this._commit();
  }

  async _duplicate() {
    const name = this.lib.uniqueName(`${this.draft.name} ${t("keymap.copySuffix")}`);
    this.draft = normaliseKeymap({ ...this.draft, name });
    this.draftIsBuiltin = false;
    await this._commit();
  }

  /** Rename the layout in hand. Refuses a name another SAVED layout already
   *  has rather than renumbering it, so nothing is silently written over — the
   *  same bargain the File tab's rename makes. */
  async _rename() {
    if (this.draftIsBuiltin) return;
    const old = this.draft.name;
    const result = await showModal({
      title: t("keymap.renameTitle", { name: old }),
      fields: [{ name: "name", label: t("files.name"), value: old }],
      okLabel: t("common.rename"),
    });
    if (!result) return;
    const name = (result.name || "").trim();
    if (!name || name === old) return;
    if (this.lib.savedNameTaken(name, old)) {
      await showModal({ title: t("keymap.renameExists", { name }), okLabel: t("common.ok") });
      return;
    }
    const next = await this.lib.rename(old, name);
    if (!next) return;
    this.draft = next;
    await this._commit();
  }

  async _delete() {
    if (this.draftIsBuiltin) return;
    const ok = await showModal({
      title: t("keymap.deleteTitle"),
      body: t("keymap.deleteBody", { name: this.draft.name }),
      okLabel: t("common.delete"),
    });
    if (!ok) return;
    await this.lib.remove(this.draft.name);
    this._choose(this.lib.entries()[0]);
  }

  async _import() {
    const file = await pickFile(".taudkey,text/plain");
    if (!file) return;
    try {
      const spec = parseTaudkey(await file.text());
      spec.name = this.lib.uniqueName(spec.name);
      this.draft = spec;
      this.draftIsBuiltin = false;
      await this._commit();
    } catch (err) {
      await showModal({ title: t("keymap.importFailed"), body: String(err.message ?? err) });
    }
  }

  _export() {
    download(new TextEncoder().encode(buildTaudkey(this.draft)), `${this.draft.name}.taudkey`);
  }

  // ── keys ──

  /**
   * Editor keys. Piano keys are NOT handled here — they fall through to the
   * jam keyboard and come back as onJamKey, so pressing a key both sounds it
   * and selects its cap. That is what keeps the view out of a mode.
   */
  processKey(e) {
    switch (e.code) {
      case "Escape": this.selected = null; this.paint(); return true;
      case "Minus": this._nudge(-1); return true;
      case "Equal": this._nudge(1); return true;
      case "Delete": case "Backspace":
        if (e.shiftKey) this._edit({ overrides: {} });
        else this._clearOverride();
        return true;
      default: return false;
    }
  }

  /** A piano key went down: select its cap and light it. */
  onJamKey(code) {
    if (!resolveKeymap(this.draft).has(code)) return;
    this.selected = code;
    this.held.add(code);
    this.paint();
  }

  onJamKeyUp(code) {
    if (this.held.delete(code)) this.paint();
  }

  _nudge(dir) {
    if (this.selected === null || this.draftIsBuiltin) return;
    const cur = resolveKeymap(this.draft).get(this.selected);
    if (cur === undefined) return;
    this._edit({ overrides: { ...this.draft.overrides, [this.selected]: cur + dir } });
  }

  _clearOverride() {
    if (this.selected === null || this.draftIsBuiltin) return;
    if (!(this.selected in this.draft.overrides)) return;
    const overrides = { ...this.draft.overrides };
    delete overrides[this.selected];
    this._edit({ overrides });
  }

  _onPointer(e) {
    const code = this._capAt(e.offsetX, e.offsetY);
    if (!code) return;
    this.selected = code;
    this.paint();
    const note = keymapNote(this.draft, code, this.jam.octave, this.preset);
    if (note !== null) this.jam.hold(code, note);
    const release = () => { this.jam.up(code); window.removeEventListener("pointerup", release); };
    window.addEventListener("pointerup", release);
  }

  _onWheel(e) {
    const code = this._capAt(e.offsetX, e.offsetY);
    if (!code) return;
    e.preventDefault();
    this.selected = code;
    this._nudge(e.deltaY < 0 ? 1 : -1);
  }

  /** The cap nearest (x, y), or null when the click missed the board. The
   *  cut-off is half the spacing between two caps in a row, which is the right
   *  radius at any zoom without the view having to know the scale. */
  _capAt(x, y) {
    const a = this._layout.get("KeyA"), b = this._layout.get("KeyS");
    const pitch = a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 40;
    let best = null, bestD = (pitch * 0.6) ** 2;
    for (const [code, pt] of this._layout) {
      const d = (pt.x - x) ** 2 + (pt.y - y) ** 2;
      if (d < bestD) { bestD = d; best = code; }
    }
    return best;
  }

  // ── the board ──

  paint() {
    if (!this.visible) return;
    const cv = this.canvas;
    const stage = cv.parentElement;
    const dpr = globalThis.devicePixelRatio || 1;
    const w = Math.max(stage.clientWidth, 320);
    const h = Math.max(stage.clientHeight - 28, 200);
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // The board itself is drawn by the shared painter, so the strip that docks
    // under the grids shows exactly what is built here.
    this._layout = paintKeymapBoard(ctx, {
      spec: this.draft, preset: this.preset, octave: this.jam.octave,
      w, h, size: "full", ortho: this.store.keymapOrtho === true,
      held: this.held, selected: this.selected, legend: (c) => this.legend(c),
    });

    this._paintFooter(ctx, w, h, themeColors());
  }

  _paintFooter(ctx, w, h, C) {
    ctx.font = canvasFont(12);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = C.dim;
    const note = this.selected === null
      ? null : keymapNote(this.draft, this.selected, this.jam.octave, this.preset);
    const parts = [t("keymap.octave", { n: this.jam.octave })];
    if (note !== null) {
      parts.push(`${this.legend(this.selected)} → ${noteToStr(note)}`);
      const value = resolveKeymap(this.draft).get(this.selected);
      parts.push(t(this.draft.unit === "deg" ? "keymap.degreeN" : "keymap.semiN", { n: round2(value) }));
    }
    ctx.fillText(parts.join("   ·   "), 8, h - 8);
  }
}

// ── panel helpers ──

const round2 = (v) => Math.round(v * 100) / 100;

function axisLabel(cents) {
  const c = Math.round(cents);
  if (c === 0) return "—";
  const r = nearestRatio(cents);
  return r.err < 12 ? `${c}¢ ≈ ${r.n}/${r.d}` : `${c}¢`;
}

/** Every notation the binding dropdown can name: the shipped presets, plus
 *  whatever the open song defines in its own nota section. */
function notationOptions() {
  return Object.values(pitchTablePresets)
    .filter((p) => p.table.length > 0)
    .map((p) => [p.index, p.name]);
}

function notationName(value) {
  return presetForNotation(value)?.name ?? String(value);
}

// ── tiny DOM builders (the panel is a form, not a canvas) ──

function mkBtn(label, onClick) {
  const b = document.createElement("button");
  b.className = "keymap-btn";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function section(title, fill) {
  const el = document.createElement("section");
  el.className = "keymap-section";
  const h = document.createElement("h3");
  h.textContent = title;
  el.appendChild(h);
  const body = document.createElement("div");
  body.className = "keymap-section-body";
  fill(body);
  el.appendChild(body);
  return el;
}

function labelled(text, control) {
  const row = document.createElement("label");
  row.className = "keymap-field";
  const span = document.createElement("span");
  span.textContent = text;
  row.append(span, control);
  return row;
}

function numField(label, value, disabled, onChange) {
  const input = document.createElement("input");
  input.type = "number";
  input.value = String(value);
  input.step = "any";
  input.disabled = disabled;
  input.addEventListener("change", () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) onChange(v);
  });
  return labelled(label, input);
}

function selectField(label, options, value, disabled, onChange) {
  const sel = document.createElement("select");
  sel.innerHTML = options.map((o) => `<option value="${o}">${esc(t(`keymap.unit.${o}`))}</option>`).join("");
  sel.value = value;
  sel.disabled = disabled;
  sel.addEventListener("change", () => onChange(sel.value));
  return labelled(label, sel);
}

function rowsField(rows, disabled, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "keymap-rows";
  for (const name of ["N", "Q", "A", "Z"]) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = rows.includes(name);
    box.disabled = disabled;
    box.addEventListener("change", () => {
      const next = ["N", "Q", "A", "Z"].filter((r) =>
        r === name ? box.checked : rows.includes(r));
      if (next.length > 0) onChange(next);
      else box.checked = true; // a keymap with no rows is not a keymap
    });
    label.append(box, document.createTextNode(t(`keymap.row.${name}`)));
    wrap.appendChild(label);
  }
  return labelled(t("keymap.rows"), wrap);
}

function readout(label, value, warn = false) {
  const row = document.createElement("div");
  row.className = "keymap-readout" + (warn ? " warn" : "");
  const l = document.createElement("span");
  l.textContent = label;
  const v = document.createElement("strong");
  v.textContent = value;
  row.append(l, v);
  return row;
}
