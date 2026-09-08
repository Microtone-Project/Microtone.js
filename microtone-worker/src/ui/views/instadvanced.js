// Advanced Edit (item 49b) — whole-panel Ixmp patch editor over the Instruments
// view's `div.side-detail`, entered via the Zones subtab's "Advanced Edit…"
// button (taut_views.mjs openAdvancedInstEdit is the read-only layout
// reference; the web version adds editing: every patch parameter, add /
// duplicate / delete / reorder). Layout: patch list (left) + zone map
// (top-right, live trigger overlay) + selected-patch form + envelope sub-tabs
// (Vol/Pan/Filter/Pitch with draggable node graphs, + Wave scope).
//
// Every edit clones the decoded patch list, mutates the clone, re-encodes with
// writePatchesBlob and applies ONE setInstPatchesOp — undo/redo is byte-exact
// and playback re-syncs eagerly via the {kind:"ixmp"} dirty tag. Edits that
// can change the sample census (bind/ptr/len, add/delete/duplicate) fold an
// SNam realignment payload into the same op, so pool-order names survive.

import { setInstPatchesOp } from "../../doc/ops.js";
import {
  writePatchesBlob, makeInstPatch, patchVibratoInherits, baseStereoPatchIndex,
} from "../../engine/inst.js";
import { TOTAL_VOICES } from "../../engine/constants.js";
import { encodeNameTable } from "../../doc/cleanup.js";
import { envPresent, envCarry } from "../../engine/envelope.js";
import { minifloatToDouble, minifloatFromDouble } from "../../engine/minifloat.js";
import {
  envActiveCount, envAddNode, envRemoveNode, envFollowTailSustain, envClampWrap,
} from "../../doc/envedit.js";
import { META_MIX_GAIN } from "../../engine/tables.js";
import { noteToStr, rangeToStr, hex4 } from "../notenames.js";
import { themeColors } from "../theme.js";
import { unescapeName } from "../names.js";
import {
  annFadeout, annFilter, annSfCutoff, annSfReso, SEG_MINIFLOAT_MAP,
} from "../units.js";
import { mapSpinner } from "../widgets/spinner.js";
import { t } from "../i18n.js";

// Fraction of the env plot width the time axis uses (item 37 headroom rule,
// same constant as the base-instrument envelope tabs).
const ENV_TIME_FRAC = 0.8;

// The four patch envelope blocks. `mbit` is the LOOP-word role marker written
// when the editor CREATES the block (bit 7: 1 = filter, 0 = pitch — spec Note
// 7; vol/pan have no role bit). `base*` name the base-inst fields the fresh
// block is seeded from (filter/pitch resolve their base slot dynamically).
const ENV_KINDS = [
  { key: "volEnv", loopKey: "volEnvLoop", susKey: "volEnvSustain", labelKey: "adv.volEnv",
    max: 63, defVal: 0x3f, mbit: null, base: "vol",
    liveIdx: "getVoiceEnvVolIndex", liveTime: "getVoiceEnvVolTime" },
  { key: "panEnv", loopKey: "panEnvLoop", susKey: "panEnvSustain", labelKey: "adv.panEnv",
    max: 255, defVal: 0x80, mbit: null, base: "pan",
    liveIdx: "getVoiceEnvPanIndex", liveTime: "getVoiceEnvPanTime" },
  { key: "filterEnv", loopKey: "filterEnvLoop", susKey: "filterEnvSustain", labelKey: "adv.filterEnv",
    max: 255, defVal: 0x80, mbit: 1, base: "role",
    liveIdx: "getVoiceEnvFilterIndex", liveTime: "getVoiceEnvFilterTime" },
  { key: "pitchEnv", loopKey: "pitchEnvLoop", susKey: "pitchEnvSustain", labelKey: "adv.pitchEnv",
    max: 255, defVal: 0x80, mbit: 0, base: "role",
    liveIdx: "getVoiceEnvPitchIndex", liveTime: "getVoiceEnvPitchTime" },
];
const ENV_WAVE = 4; // the fifth sub-tab: sample wavescope

const VIB_WAVES = ["sine", "ramp-down", "square", "random", "ramp-up"];

function clonePatch(p) {
  const cloneEnv = (e) => (e === null ? null : e.map((n) => ({ value: n.value, offset: n.offset })));
  return { ...p, volEnv: cloneEnv(p.volEnv), panEnv: cloneEnv(p.panEnv),
           filterEnv: cloneEnv(p.filterEnv), pitchEnv: cloneEnv(p.pitchEnv) };
}

function escape(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function clampN(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

const annHex4 = (v) => "$" + hex4(v & 0xffff);
const noteAnn = (v) => `${noteToStr(v)} ${annHex4(v)}`;

/** PSO attenuation octet → dB label (159 = 0 dB; 0 = unity sentinel). */
function attenLabel(octet) {
  if ((octet & 0xff) === 0) return t("adv.attenUnset");
  const g = META_MIX_GAIN[octet & 0xff];
  if (!(g > 0)) return "−∞ dB";
  const db = 20 * Math.log10(g);
  return (db >= 0 ? "+" : "−") + Math.abs(db).toFixed(1) + " dB";
}

export class AdvancedZoneEditor {
  constructor(iv) {
    this.iv = iv;          // owning InstrumentsView (store / panel / selected)
    this.selIdx = 0;       // selected list row; patches.length = the base row
    this.envKind = 0;      // 0..3 = ENV_KINDS, 4 = Wave
    this.selNode = 0;      // env node targeted by the spinners
    this.logTime = false;  // logarithmic env time axis
    this.dragState = null; // env node drag {idx, gestureId}
    this._liveSig = "~";
    this._voicePeak = [];  // per-voice peak effective volume (map blob Y proxy)
  }

  get store() { return this.iv.store; }
  get doc() { return this.iv.store.doc; }
  get slot() { return this.iv.selected; }
  get inst() { return this.doc.instruments[this.slot]; }
  patches() { return this.inst.extraPatches ?? []; }

  // ── edit plumbing ──────────────────────────────────────────────────────────

  /**
   * Clone the patch list, run `mutate(patches)`, encode and apply ONE
   * setInstPatchesOp. `census: true` additionally realigns SNam when the edit
   * changes the (ptr:len) census (pool order IS the name mapping). Quiet apply
   * — the caller repaints what it needs (a full render() after discrete edits;
   * canvas-only during drags).
   */
  _commit(mutate, { gestureId = null, census = false } = {}) {
    const doc = this.doc;
    const patches = this.patches().map(clonePatch);
    mutate(patches);
    const blob = patches.length > 0 ? writePatchesBlob(patches) : null;
    let snam;
    if (census) {
      const keyOf = (e) => `${e.ptr}:${e.len}`;
      const before = doc.sampleList();
      const after = doc.sampleList(new Map([[this.slot, patches.length ? patches : null]]));
      const changed = before.length !== after.length ||
        before.some((e, i) => keyOf(e) !== keyOf(after[i]));
      if (changed && doc.projSections.some((s) => s.fourcc === "SNam")) {
        const byKey = new Map(before.map((e) => [keyOf(e), e.name]));
        snam = encodeNameTable(after.map((e) => byKey.get(keyOf(e)) ?? ""));
      }
    }
    this.iv.applyQuiet(setInstPatchesOp(this.slot, blob, snam, gestureId));
    this.iv.refreshListBadge(this.slot);
  }

  /** Discrete (non-drag) edit: commit then rebuild the whole panel. */
  _edit(mutate, opts = {}) {
    this._commit(mutate, opts);
    this.render();
  }

  /** Mutate one field of the selected patch. */
  _field(name, value, opts = {}) {
    const i = this.selIdx;
    this._edit((ps) => { if (ps[i]) ps[i][name] = value; }, opts);
  }

  // ── panel construction ─────────────────────────────────────────────────────

  render() {
    const panel = this.iv.panel;
    // render() rebuilds the whole panel (map/detail/env all depend on the
    // selection). Clearing panel.innerHTML collapses the scroll regions, so the
    // independently-scrolling list + main columns snap back to the top; capture
    // their offsets now and restore them once the content is rebuilt (item 64).
    // (.side-detail is capped to the pane and no longer scrolls in advanced
    // mode — kept for robustness in case a host has no definite height.)
    const paneEl = this.iv.right;
    const prevPaneScroll = paneEl?.scrollTop ?? 0;
    const prevListScroll = panel.querySelector(".adv-list")?.scrollTop ?? 0;
    const prevMainScroll = panel.querySelector(".adv-main")?.scrollTop ?? 0;
    panel.innerHTML = "";
    const doc = this.doc;
    const inst = this.inst;
    const patches = this.patches();
    this.selIdx = clampN(this.selIdx, 0, patches.length); // patches.length = base row
    // The base stereo patch (item 90/180) isn't a real zone — it exists only
    // to add channels to the instrument's OWN base sample, and its rectangle
    // always wins over the base record, so hand-editing it here as if it were
    // an ordinary zone is exactly how it goes stale. Hide it from the list,
    // the map and selection; it stays reachable (kept in sync) through the
    // base instrument's own Sample section instead.
    this.shadowIdx = baseStereoPatchIndex(inst);
    if (this.selIdx === this.shadowIdx) this.selIdx = patches.length;
    const visibleCount = patches.length - (this.shadowIdx >= 0 ? 1 : 0);
    this._census = doc.sampleList();
    this._liveSig = "~";

    // header: back + title + patch ops
    const head = document.createElement("div");
    head.className = "adv-head";
    const back = this.btn(t("adv.back"), t("adv.backTitle"), () => this.iv.closeAdvanced());
    back.classList.add("adv-back");
    const title = document.createElement("span");
    title.className = "adv-title";
    const nm = unescapeName(doc.instrumentName(this.slot) || "");
    title.textContent = `${t("adv.title")} — $${this.slot.toString(16).toUpperCase().padStart(2, "0")}` +
      `${nm ? " " + nm : ""} — ${visibleCount === 1 ? t("adv.patch1") : t("adv.patches", { n: visibleCount })}`;
    const spacer = document.createElement("span");
    spacer.className = "adv-spacer";
    const sel = this.selIdx < patches.length ? this.selIdx : -1;
    head.append(back, title, spacer,
      this.btn(t("adv.add"), t("adv.addTitle"), () => this.addPatch()),
      this.btn(t("adv.duplicate"), t("adv.duplicateTitle"), () => this.duplicatePatch(), sel < 0),
      this.btn("▲", t("adv.moveUpTitle"), () => this.movePatch(-1), sel <= 0),
      this.btn("▼", t("adv.moveDownTitle"), () => this.movePatch(1), sel < 0 || sel >= patches.length - 1),
      this.btn(t("adv.delete"), t("adv.deleteTitle"), () => this.deletePatch(), sel < 0));
    panel.appendChild(head);

    // body: list | (map + detail + env)
    const body = document.createElement("div");
    body.className = "adv-body";
    const list = document.createElement("div");
    list.className = "adv-list";
    this.buildList(list, patches, inst);
    const main = document.createElement("div");
    main.className = "adv-main";
    this.mapCanvas = document.createElement("canvas");
    this.mapCanvas.className = "adv-map";
    this.mapCanvas.addEventListener("pointerdown", (e) => this.mapClick(e));
    main.appendChild(this.mapCanvas);
    const detail = document.createElement("div");
    detail.className = "adv-detail";
    if (sel >= 0) this.buildDetail(detail, patches[sel]);
    else this.buildBaseDetail(detail, inst);
    main.appendChild(detail);
    this.buildEnvSection(main, patches[sel] ?? null);
    body.append(list, main);
    panel.appendChild(body);

    this.drawMap();
    this.drawEnvArea();
    // Restore scroll AFTER the canvases are sized (scrollHeight is settled).
    list.scrollTop = prevListScroll;
    main.scrollTop = prevMainScroll;
    if (paneEl) paneEl.scrollTop = prevPaneScroll;
  }

  btn(label, title, onClick, disabled = false) {
    const b = document.createElement("button");
    b.textContent = label;
    b.title = title;
    b.disabled = disabled;
    b.addEventListener("click", onClick);
    return b;
  }

  // ── patch list ─────────────────────────────────────────────────────────────

  /** Sample label from the census (SNam name by pool order, else $ptr·len). */
  sampleLabel(ptr, len) {
    const e = this._census.find((c) => c.ptr === ptr && c.len === len);
    const name = e ? unescapeName(e.name || "") : "";
    return name || `$${ptr.toString(16).toUpperCase()}·${len}`;
  }

  /** True when patch `i`'s rectangle intersects an EARLIER patch's (spec Note
   *  1: overlapping zones are invalid — first match wins at trigger time).
   *  The hidden base stereo patch (item 180) is excluded — it isn't a real
   *  zone, so it can't make a genuine one "overlap". */
  overlapsEarlier(patches, i) {
    const p = patches[i];
    for (let j = 0; j < i; j++) {
      if (j === this.shadowIdx) continue;
      const q = patches[j];
      if (p.pitchStart <= q.pitchEnd && q.pitchStart <= p.pitchEnd &&
          p.volumeStart <= q.volumeEnd && q.volumeStart <= p.volumeEnd) return true;
    }
    return false;
  }

  buildList(host, patches, inst) {
    const head = document.createElement("div");
    head.className = "adv-list-head";
    head.textContent = t("adv.listHead");
    host.appendChild(head);
    this.listRows = [];
    const mkRow = (i, label, rangeTxt, warn) => {
      const row = document.createElement("div");
      row.className = "side-row adv-row" + (i === this.selIdx ? " sel" : "");
      row.innerHTML =
        `<span class="dot"></span>` +
        `<span class="idx">${i < patches.length ? i.toString(16).toUpperCase().padStart(2, "0") : t("adv.baseRow")}</span>` +
        (warn ? `<span class="adv-warn" title="${escape(t("adv.overlapWarn"))}">⚠</span>` : "") +
        `<span class="name">${escape(label)}</span>` +
        `<span class="adv-range">${escape(rangeTxt)}</span>`;
      row.addEventListener("click", () => { this.selIdx = i; this.selNode = 0; this.render(); });
      host.appendChild(row);
      this.listRows.push({ el: row, idx: i });
    };
    patches.forEach((p, i) => {
      if (i === this.shadowIdx) return; // item 180 — not a real zone
      mkRow(i, this.sampleLabel(p.samplePtr, p.sampleLength) +
        (p.hasChanBlock && p.chanCount > 1 ? ` [${t("smp.stereoTag")}]` : ""),
        `${rangeToStr(p.pitchStart, p.pitchEnd)} · ${p.volumeStart}‥${p.volumeEnd}`,
        this.overlapsEarlier(patches, i));
    });
    mkRow(patches.length,
      inst.sampleLength > 0 ? this.sampleLabel(inst.samplePtr, inst.sampleLength) : t("adv.noSample"),
      t("adv.baseFallback"), false);
  }

  // ── zone map ───────────────────────────────────────────────────────────────

  /** Pitch extent: union of VISIBLE patch rectangles (taut fallback
   *  0x1000..0x9000) — the hidden base stereo patch (item 180) is always
   *  full-range and would otherwise zoom every stereo instrument's map out to
   *  the whole keyboard regardless of its real zones. */
  mapRange() {
    let lo = Infinity, hi = -Infinity;
    this.patches().forEach((p, i) => {
      if (i === this.shadowIdx) return;
      if (p.pitchStart < lo) lo = p.pitchStart;
      if (p.pitchEnd > hi) hi = p.pitchEnd;
    });
    if (!isFinite(lo)) { lo = 0x1000; hi = 0x9000; }
    if (hi <= lo) hi = lo + 1;
    return { lo, hi };
  }

  mapGeom() {
    const w = this.mapCanvas.clientWidth || 400;
    const h = this.mapCanvas.clientHeight || 170;
    const { lo, hi } = this.mapRange();
    const plotH = h - 14; // bottom strip = pitch labels
    return {
      w, h, lo, hi, plotH,
      X: (note) => clampN((note - lo) / (hi - lo), 0, 1) * (w - 1),
      Y: (vol) => plotH - clampN(vol / 63, 0, 1) * (plotH - 1) - 1,
    };
  }

  drawMap() {
    const canvas = this.mapCanvas;
    if (!canvas || !canvas.isConnected) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(240, canvas.parentElement.clientWidth - 2);
    const h = 170;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const C = themeColors();
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.cvBg;
    ctx.fillRect(0, 0, w, h);
    const g = this.mapGeom();
    const patches = this.patches();

    // base backdrop (the fallback zone) — selected state included
    ctx.globalAlpha = this.selIdx === patches.length ? 0.30 : 0.15;
    ctx.fillStyle = C.dim;
    ctx.fillRect(0, 0, w, g.plotH);
    ctx.globalAlpha = 1;

    // live voices of this instrument: light matching patches + note/vel blobs
    const audio = this.store.audio;
    const liveKeys = new Set();
    const blobs = [];
    if (audio) {
      for (let vi = 0; vi < TOTAL_VOICES; vi++) {
        if (!audio.getVoiceActive(vi) || audio.getVoiceInstrument(vi) !== this.slot) {
          this._voicePeak[vi] = null;
          continue;
        }
        liveKeys.add(`${audio.getVoiceSamplePtr(vi)}:${audio.getVoiceSampleLength(vi)}`);
        const note = audio.getVoiceNote(vi);
        const eff = audio.getVoiceEffectiveVolume(vi) || 0;
        // pin the blob's Y to the PEAK volume since the note started (taut
        // voicePeak) so it marks the trigger velocity, not the env decay
        let pk = this._voicePeak[vi];
        if (!pk || pk.note !== note) pk = this._voicePeak[vi] = { note, peak: eff };
        else if (eff > pk.peak) pk.peak = eff;
        blobs.push({ x: g.X(note), y: g.Y(Math.round(pk.peak * 63)) });
      }
    }

    patches.forEach((p, i) => {
      if (i === this.shadowIdx) return; // item 180 — not a real zone
      const x = g.X(p.pitchStart);
      const y = g.Y(p.volumeEnd);
      const pw = Math.max(g.X(p.pitchEnd) - x, 2);
      const ph = Math.max(g.Y(p.volumeStart) - y, 2);
      const selP = i === this.selIdx;
      const live = liveKeys.has(`${p.samplePtr}:${p.sampleLength}`);
      ctx.globalAlpha = selP ? 0.7 : live ? 0.55 : 0.35;
      ctx.fillStyle = selP ? C.accent : live ? C.playCursor : `hsl(${(i * 47) % 360} 50% 55%)`;
      ctx.fillRect(x, y, pw, ph);
      ctx.globalAlpha = selP || live ? 1 : 0.45;
      ctx.strokeStyle = selP ? C.accent : live ? C.playCursor : C.envLine;
      ctx.strokeRect(x + 0.5, y + 0.5, pw - 1, ph - 1);
      ctx.globalAlpha = 1;
      ctx.fillStyle = selP ? C.fg : C.dim;
      ctx.font = "10px monospace";
      if (pw > 14) ctx.fillText(i.toString(16).toUpperCase(), x + 2, y + 10);
    });

    // live blobs on top
    ctx.fillStyle = C.live;
    for (const b of blobs) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // pitch axis labels
    ctx.fillStyle = C.dim;
    ctx.font = "9px monospace";
    ctx.textAlign = "left";
    ctx.fillText(noteToStr(g.lo), 1, h - 3);
    ctx.textAlign = "right";
    ctx.fillText(noteToStr(g.hi), w - 1, h - 3);
    ctx.textAlign = "left";
  }

  mapClick(e) {
    const rect = this.mapCanvas.getBoundingClientRect();
    const g = this.mapGeom();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const patches = this.patches();
    let hit = patches.length; // base backdrop
    for (let i = 0; i < patches.length; i++) {
      if (i === this.shadowIdx) continue; // item 180 — not a real zone, not clickable
      const p = patches[i];
      const px = g.X(p.pitchStart);
      const py = g.Y(p.volumeEnd);
      const pw = Math.max(g.X(p.pitchEnd) - px, 2);
      const ph = Math.max(g.Y(p.volumeStart) - py, 2);
      if (x >= px && x <= px + pw && y >= py && y <= py + ph) { hit = i; break; }
    }
    if (hit !== this.selIdx) { this.selIdx = hit; this.selNode = 0; this.render(); }
  }

  // ── detail form ────────────────────────────────────────────────────────────

  group(host, title) {
    const head = document.createElement("div");
    head.className = "inst-group-head";
    head.textContent = title;
    host.appendChild(head);
    const box = document.createElement("div");
    box.className = "adv-rows";
    host.appendChild(box);
    return box;
  }

  /** label + number spinner (+ live annotation fn) committing on change. */
  num(label, value, min, max, onCommit, ann = null, title = "") {
    const l = document.createElement("label");
    l.className = "env-ctl adv-num";
    if (title) l.title = title;
    l.append(document.createTextNode(label));
    const inp = document.createElement("input");
    inp.type = "number"; inp.value = value; inp.min = min; inp.max = max;
    const annEl = document.createElement("span");
    annEl.className = "sl-ann";
    if (ann) annEl.textContent = ann(value);
    inp.addEventListener("input", () => {
      if (ann) annEl.textContent = ann(clampN(Math.round(Number(inp.value) || 0), min, max));
    });
    inp.addEventListener("change", () =>
      onCommit(clampN(Math.round(Number(inp.value) || 0), min, max)));
    l.append(inp);
    if (ann) l.append(annEl);
    return l;
  }

  chk(label, checked, onChange, title = "") {
    const l = document.createElement("label");
    l.className = "env-ctl chk";
    if (title) l.title = title;
    const c = document.createElement("input");
    c.type = "checkbox"; c.checked = checked;
    c.addEventListener("change", () => onChange(c.checked));
    l.append(c, document.createTextNode(label));
    return l;
  }

  sel(label, value, options, onChange, title = "") {
    const l = document.createElement("label");
    l.className = "env-ctl adv-num";
    if (title) l.title = title;
    l.append(document.createTextNode(label));
    const s = document.createElement("select");
    for (const [val, txt] of options) {
      const o = document.createElement("option");
      o.value = val; o.textContent = txt;
      s.appendChild(o);
    }
    s.value = String(value);
    s.addEventListener("change", () => onChange(s.value));
    l.append(s);
    return l;
  }

  row(box, ...kids) {
    const d = document.createElement("div");
    d.className = "env-row";
    d.append(...kids);
    box.appendChild(d);
    return d;
  }

  buildDetail(host, p) {
    // Zone rectangle
    const zone = this.group(host, t("adv.zoneGroup"));
    this.row(zone,
      this.num(t("adv.pitchLo"), p.pitchStart, 0, 0xffff, (v) => this._field("pitchStart", v), noteAnn),
      this.num(t("adv.pitchHi"), p.pitchEnd, 0, 0xffff, (v) => this._field("pitchEnd", v), noteAnn));
    this.row(zone,
      this.num(t("adv.volLo"), p.volumeStart, 0, 63, (v) => this._field("volumeStart", v)),
      this.num(t("adv.volHi"), p.volumeEnd, 0, 63, (v) => this._field("volumeEnd", v)));

    // Sample binding
    const smp = this.group(host, t("adv.sampleGroup"));
    const curKey = `${p.samplePtr}:${p.sampleLength}`;
    const opts = this._census.map((e) => [
      `${e.ptr}:${e.len}`,
      `${String(e.index).padStart(2, "0")} ${this.sampleLabel(e.ptr, e.len)} (${e.len})`,
    ]);
    if (!this._census.some((e) => `${e.ptr}:${e.len}` === curKey)) {
      opts.unshift([curKey, `$${p.samplePtr.toString(16).toUpperCase()}·${p.sampleLength}`]);
    }
    this.row(smp, this.sel(t("adv.bind"), curKey, opts, (key) => {
      const e = this._census.find((c) => `${c.ptr}:${c.len}` === key);
      if (!e) return;
      this._edit((ps) => {
        const q = ps[this.selIdx];
        if (!q) return;
        q.samplePtr = e.ptr; q.sampleLength = e.len;
        q.samplingRate = e.rate;
        q.playStart = 0;
        q.loopStart = e.loopStart; q.loopEnd = e.loopEnd;
        q.loopMode = (q.loopMode & ~0x03) | (e.loopMode & 0x03);
        // Binding follows the sample's own channel layout (item 90): a stereo
        // census entry brings its 's' block, a mono one drops it.
        const extra = e.chanPtrs ?? [];
        q.hasChanBlock = extra.length > 0;
        q.chanCount = 1 + extra.length;
        q.chanMode = e.chanMode ?? 0;
        q.chanPtrs = [...extra];
      }, { census: true });
    }, t("adv.bindTitle")));
    this.row(smp,
      this.num(t("adv.playStart"), p.playStart, 0, 0xffff, (v) => this._field("playStart", v)),
      this.num(t("adv.rate"), p.samplingRate, 0, 0xffff, (v) => this._field("samplingRate", v)),
      this.num(t("adv.detune"), p.sampleDetune, -0x8000, 0x7fff,
        (v) => this._field("sampleDetune", v),
        (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v * 1200 / 4096).toFixed(0)}c`));
    this.row(smp,
      this.sel(t("smp.loop"), p.loopMode & 0x03, [
        ["0", t("smp.loopOff")], ["1", t("smp.loopForward")],
        ["2", t("smp.loopPingpong")], ["3", t("smp.loopOneshot")],
      ], (v) => this._field("loopMode", (p.loopMode & ~0x03) | (Number(v) & 0x03))),
      this.num(t("smp.loopStart"), p.loopStart, 0, 0xffff, (v) => this._field("loopStart", v)),
      this.num(t("smp.loopEnd"), p.loopEnd, 0, 0xffff, (v) => this._field("loopEnd", v)),
      this.chk(t("smp.sustain").trim(), (p.loopMode & 0x04) !== 0,
        (on) => this._field("loopMode", on ? p.loopMode | 0x04 : p.loopMode & ~0x04)));

    // Channels (Ixmp 's' block, item 90). Channel 2 is another pool span of
    // the SAME length — the geometry above describes both — so the picker only
    // offers same-length samples.
    const chanRow = this.row(smp,
      this.chk(t("adv.stereo"), p.hasChanBlock && p.chanCount > 1, (on) => {
        this._edit((ps) => {
          const q = ps[this.selIdx];
          if (!q) return;
          if (on) {
            const alt = this._census.find((e) => e.len === q.sampleLength && e.ptr !== q.samplePtr);
            q.hasChanBlock = true;
            q.chanCount = 2;
            q.chanMode = 0;
            q.chanPtrs = [alt ? alt.ptr : q.samplePtr];
          } else {
            q.hasChanBlock = false;
            q.chanCount = 1;
            q.chanPtrs = [];
          }
        }, { census: true });
      }, t("adv.stereoTitle")));
    if (p.hasChanBlock && p.chanCount > 1) {
      const cur2 = String(p.chanPtrs[0] ?? 0);
      const opts2 = this._census
        .filter((e) => e.len === p.sampleLength)
        .map((e) => [String(e.ptr), `${String(e.index).padStart(2, "0")} ${this.sampleLabel(e.ptr, e.len)}`]);
      if (!opts2.some(([v]) => v === cur2)) {
        opts2.unshift([cur2, `$${(p.chanPtrs[0] ?? 0).toString(16).toUpperCase()}`]);
      }
      chanRow.append(
        this.sel(t("adv.chan2"), cur2, opts2,
          (v) => this._edit((ps) => { ps[this.selIdx].chanPtrs = [Number(v) >>> 0]; }, { census: true }),
          t("adv.chan2Title")),
        this.sel(t("adv.chanMode"), String(p.chanMode ?? 0),
          [["0", t("adv.chanModeDiscrete")], ["1", t("adv.chanModeMatrix")]],
          (v) => this._field("chanMode", Number(v) & 0x0f), t("adv.chanModeTitle")));
    }

    // Per-patch overrides (sentinels defer to the base instrument)
    const ov = this.group(host, t("adv.overridesGroup"));
    const panRow = this.row(ov,
      this.chk(t("adv.panOverride"), p.defaultPan !== 0xff,
        (on) => this._field("defaultPan", on ? 0x80 : 0xff), t("adv.inheritTitle")));
    if (p.defaultPan !== 0xff) {
      panRow.append(this.num("", p.defaultPan, 0, 254, (v) => this._field("defaultPan", Math.min(v, 0xfe))));
    }
    const nvRow = this.row(ov,
      this.chk(t("adv.noteVolOverride"), p.defaultNoteVolume !== 0,
        (on) => this._field("defaultNoteVolume", on ? 0xff : 0), t("adv.inheritTitle")));
    if (p.defaultNoteVolume !== 0) {
      nvRow.append(this.num("", p.defaultNoteVolume, 1, 255, (v) => this._field("defaultNoteVolume", Math.max(v, 1))));
    }
    // Auto-vibrato is ONE override, not five (item 170): the $FF waveform
    // sentinel plus four zeroes is what "inherit" looks like on the wire, so
    // the panel shows the whole block behind a single switch instead of four
    // number boxes whose zeroes silently cancelled the base record's vibrato.
    // Switching it on seeds from the base instrument, so ticking the box alone
    // changes nothing audible.
    const vibOwn = !patchVibratoInherits(p);
    const vibRow = this.row(ov,
      this.chk(t("adv.vibOverride"), vibOwn, (on) => this._edit((ps) => {
        const q = ps[this.selIdx];
        if (!q) return;
        const base = this.inst;
        q.vibratoWaveform = on ? (base.vibratoWaveform & 0x07) : 0xff;
        q.vibratoSpeed = on ? base.vibratoSpeed : 0;
        q.vibratoSweep = on ? base.vibratoSweep : 0;
        q.vibratoDepth = on ? base.vibratoDepth : 0;
        q.vibratoRate = on ? base.vibratoRate : 0;
      }), t("adv.vibOverrideTitle")));
    if (vibOwn) {
      vibRow.append(
        this.sel(t("adv.vibWave"), p.vibratoWaveform === 0xff ? "255" : String(p.vibratoWaveform & 0x07),
          [["255", t("adv.vibInherit")], ...VIB_WAVES.map((w, i) => [String(i), w])],
          (v) => this._field("vibratoWaveform", Number(v))),
        this.num(t("adv.vibSpeed"), p.vibratoSpeed, 0, 255, (v) => this._field("vibratoSpeed", v)),
        this.num(t("adv.vibSweep"), p.vibratoSweep, 0, 255, (v) => this._field("vibratoSweep", v)),
        this.num(t("adv.vibDepth"), p.vibratoDepth, 0, 255, (v) => this._field("vibratoDepth", v)),
        this.num(t("adv.vibRate"), p.vibratoRate, 0, 255, (v) => this._field("vibratoRate", v)));
    }

    // Extra block ('x'): fadeout / filter / attenuation
    const ex = this.group(host, t("adv.extraGroup"));
    this.row(ex, this.chk(t("adv.extraPresent"), p.hasExtra, (on) => {
      this._edit((ps) => {
        const q = ps[this.selIdx];
        if (!q) return;
        q.hasExtra = on;
        if (on && q.fadeoutStep === 0 && q.extraCutoff === 0xff && q.extraResonance === 0xff) {
          // seed from the base record so enabling is a no-op audibly
          const inst = this.inst;
          q.filterSfMode = inst.filterSfMode;
          q.fadeoutStep = inst.volumeFadeoutLow | ((inst.fadeoutHigh & 0x0f) << 8);
          q.extraCutoff = inst.defaultCutoff16;
          q.extraResonance = inst.defaultResonance16;
          q.extraInitialAttenOctet = 0;
        }
      });
    }, t("adv.extraPresentTitle")));
    if (p.hasExtra) {
      // Fadeout / cutoff / resonance carry the SAME units as the base-record
      // fields, so annotate them like the basic edit: fadeout → ticks-to-cut,
      // and cutoff/resonance in Hz/dB (SoundFont mode) or off/hex (IT mode).
      this.row(ex,
        this.sel(t("inst.filterModeLabel"), p.filterSfMode ? "1" : "0",
          [["0", "ImpulseTracker"], ["1", "SoundFont2"]],
          (v) => this._field("filterSfMode", v === "1")),
        this.num(t("adv.fadeout"), p.fadeoutStep, 0, 0xffff, (v) => this._field("fadeoutStep", v), annFadeout),
        this.num(t("adv.cutoff"), p.extraCutoff, 0, 0xffff, (v) => this._field("extraCutoff", v),
          p.filterSfMode ? annSfCutoff : annFilter),
        this.num(t("adv.resonance"), p.extraResonance, 0, 0xffff, (v) => this._field("extraResonance", v),
          p.filterSfMode ? annSfReso : annFilter),
        this.num(t("adv.atten"), p.extraInitialAttenOctet, 0, 255,
          (v) => this._field("extraInitialAttenOctet", v), attenLabel));
    }
  }

  buildBaseDetail(host, inst) {
    const info = document.createElement("div");
    info.className = "detail-info";
    info.textContent = t("adv.baseDetail");
    host.appendChild(info);
    if (inst.sampleLength > 0) {
      const line = document.createElement("div");
      line.className = "detail-info";
      line.textContent =
        `${this.sampleLabel(inst.samplePtr, inst.sampleLength)} · ${inst.sampleLength} B · ` +
        `${inst.samplingRate} Hz@C4 · loop ${annHex4(inst.sampleLoopStart)}‥${annHex4(inst.sampleLoopEnd)}`;
      host.appendChild(line);
    }
  }

  // ── envelope / wave section ───────────────────────────────────────────────

  buildEnvSection(host, p) {
    const tabs = document.createElement("div");
    tabs.className = "subtabs adv-envtabs";
    ENV_KINDS.forEach((k, i) => {
      const b = document.createElement("button");
      b.textContent = t(k.labelKey);
      b.className = i === this.envKind ? "active" : "";
      b.addEventListener("click", () => { this.envKind = i; this.selNode = 0; this.render(); });
      tabs.appendChild(b);
    });
    const wb = document.createElement("button");
    wb.textContent = t("adv.wave");
    wb.className = this.envKind === ENV_WAVE ? "active" : "";
    wb.addEventListener("click", () => { this.envKind = ENV_WAVE; this.render(); });
    tabs.appendChild(wb);
    // source tag: does the selected patch override this envelope?
    const src = document.createElement("span");
    src.className = "adv-envsrc dim";
    if (this.envKind !== ENV_WAVE && p) {
      src.textContent = p[ENV_KINDS[this.envKind].key] !== null ? t("adv.srcPatch") : t("adv.srcBase");
    }
    tabs.appendChild(src);
    host.appendChild(tabs);

    const box = document.createElement("div");
    box.className = "adv-envbox";
    host.appendChild(box);
    this.envBox = box;

    if (this.envKind === ENV_WAVE) {
      this.waveCanvas = document.createElement("canvas");
      this.waveCanvas.className = "adv-wavecv";
      box.appendChild(this.waveCanvas);
      this.envCanvas = null;
      return;
    }
    this.waveCanvas = null;
    const kind = ENV_KINDS[this.envKind];
    if (!p) {
      // base row: read-only pointer to the normal tabs
      const note = document.createElement("div");
      note.className = "detail-info";
      note.textContent = t("adv.baseEnvNote");
      box.appendChild(note);
      this.envCanvas = null;
      return;
    }
    const has = p[kind.key] !== null;
    box.appendChild(this.chk(t("adv.envOverride", { env: t(kind.labelKey) }), has,
      (on) => this.setEnvBlock(kind, on), t("adv.envOverrideTitle")));
    if (!has) {
      const note = document.createElement("div");
      note.className = "detail-info";
      note.textContent = t("adv.envUsesBase");
      box.appendChild(note);
      this.envCanvas = null;
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.className = "env-canvas adv-envcv";
    box.appendChild(canvas);
    this.envCanvas = { canvas, kind, patchIdx: this.selIdx };
    canvas.addEventListener("pointerdown", (e) => this.envPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.envPointerMove(e));
    canvas.addEventListener("pointerup", () => {
      const dragged = this.dragState !== null;
      this.dragState = null;
      if (dragged) this.render();
    });
    box.appendChild(this.buildEnvControls(p, kind));
  }

  /** Toggle a patch env block: ON seeds from the base instrument's matching
   *  envelope (present bit forced + role m-bit for filter/pitch — spec Note 7)
   *  so the override starts audibly identical; OFF removes the block (the
   *  patch defers to the base again). */
  setEnvBlock(kind, on) {
    const inst = this.inst;
    this._edit((ps) => {
      const q = ps[this.selIdx];
      if (!q) return;
      if (!on) {
        q[kind.key] = null; q[kind.loopKey] = 0; q[kind.susKey] = 0;
        return;
      }
      let nodes = null, loop = 0, sus = 0;
      if (kind.base === "vol") {
        nodes = inst.volEnvelopes; loop = inst.volEnvLoop; sus = inst.volEnvSustainWord;
      } else if (kind.base === "pan") {
        nodes = inst.panEnvelopes; loop = inst.panEnvLoop; sus = inst.panEnvSustainWord;
      } else {
        // filter/pitch: the base slot currently HOLDING the role (slot 2 wins)
        const want = kind.mbit;
        const role1 = envPresent(inst.pfEnvLoop) ? (inst.pfEnvLoop >>> 7) & 1 : null;
        const role2 = envPresent(inst.pf2EnvLoop) ? (inst.pf2EnvLoop >>> 7) & 1 : null;
        if (role2 === want) { nodes = inst.pf2Envelopes; loop = inst.pf2EnvLoop; sus = inst.pf2EnvSustainWord; }
        else if (role1 === want) { nodes = inst.pfEnvelopes; loop = inst.pfEnvLoop; sus = inst.pfEnvSustainWord; }
      }
      if (nodes !== null && envPresent(loop)) {
        q[kind.key] = nodes.map((n) => ({ value: n.value, offset: n.offset }));
        q[kind.loopKey] = loop & 0xffff;
        q[kind.susKey] = sus & 0xffff;
      } else {
        // base has none: a single-node hold envelope (value-0x3F terminator for
        // vol — the Schism cut rule ramps a value-0 terminator out instantly)
        q[kind.key] = Array.from({ length: 25 }, () => ({ value: kind.defVal, offset: 0 }));
        q[kind.loopKey] = 0x2000;
        q[kind.susKey] = 0;
      }
      // the block's role is fixed by its kind — stamp the m-bit accordingly
      if (kind.mbit !== null) {
        q[kind.loopKey] = (q[kind.loopKey] & ~0x80) | (kind.mbit ? 0x80 : 0);
      }
    });
  }

  buildEnvControls(p, kind) {
    const env = p[kind.key];
    const active = envActiveCount(env);
    this.selNode = clampN(this.selNode, 0, active - 1);
    const selN = this.selNode;
    const node = env[selN];
    const wrap = document.createElement("div");
    wrap.className = "env-controls";

    const editEnv = (fn) => this._edit((ps) => {
      const q = ps[this.selIdx];
      if (q && q[kind.key] !== null) fn(q, q[kind.key]);
    });
    const setWordBit = (wordKey, bit, on) => editEnv((q) => {
      q[wordKey] = on ? (q[wordKey] | (1 << bit)) & 0xffff : q[wordKey] & ~(1 << bit) & 0xffff;
    });
    const setWordField = (wordKey, shift, mask, val) => editEnv((q) => {
      const v = clampN(val | 0, 0, mask);
      q[wordKey] = ((q[wordKey] & ~(mask << shift)) | (v << shift)) & 0xffff;
    });

    this.row(wrap,
      this.num(t("env.node"), selN, 0, active - 1, (v) => { this.selNode = v; this.render(); }),
      this.num(t("env.value"), node.value, 0, kind.max,
        (v) => editEnv((q, e) => { e[selN].value = v; })),
      (() => {
        // Seconds on screen, one minifloat CODE per press (item 156.2) — the
        // General tab's segment field works the same way, from the same map.
        const l = this.num(t("env.seg"), 0, 0, 255, () => {});
        const inp = l.querySelector("input");
        mapSpinner(inp, SEG_MINIFLOAT_MAP, node.offset);
        inp.addEventListener("change", () => editEnv((q, e) => {
          e[selN].offset = inp.rawValue;
        }));
        return l;
      })(),
      this.btn("＋", t("adv.addNodeTitle"), () => this.addEnvNode(kind, env, selN), active >= 25),
      this.btn("－", t("adv.removeNodeTitle"), () => this.removeEnvNode(kind, env, selN),
        active <= 1 || selN === 0));

    const susW = p[kind.susKey];
    this.row(wrap,
      this.chk(t("env.sustain"), ((susW >> 5) & 1) !== 0, (on) => setWordBit(kind.susKey, 5, on)),
      this.num(t("env.start"), (susW >> 8) & 0x1f, 0, active - 1, (v) => setWordField(kind.susKey, 8, 0x1f, v)),
      this.num(t("env.end"), susW & 0x1f, 0, active - 1, (v) => setWordField(kind.susKey, 0, 0x1f, v)));
    const loopW = p[kind.loopKey];
    this.row(wrap,
      this.chk(t("env.loop"), ((loopW >> 5) & 1) !== 0, (on) => setWordBit(kind.loopKey, 5, on)),
      this.num(t("env.start"), (loopW >> 8) & 0x1f, 0, active - 1, (v) => setWordField(kind.loopKey, 8, 0x1f, v)),
      this.num(t("env.end"), loopW & 0x1f, 0, active - 1, (v) => setWordField(kind.loopKey, 0, 0x1f, v)));
    this.row(wrap,
      this.chk(t("env.present"), envPresent(loopW), (on) => setWordBit(kind.loopKey, 13, on)),
      // The patch's own carry bit (item 169.1): a patch that replaces the base
      // record's envelope replaces its LOOP word too, so it must be able to say
      // this for itself — otherwise a zone could never carry.
      this.chk(t("env.carry"), envCarry(loopW), (on) => setWordBit(kind.loopKey, 6, on),
        t("env.carryTitle")),
      this.chk(t("env.logTimescale"), this.logTime, (on) => { this.logTime = on; this.drawEnv(); }));
    return wrap;
  }

  addEnvNode(kind, env, selN) {
    const res = envAddNode(env, selN, kind.max);
    if (res === null) return;
    const active = envActiveCount(env);
    this._edit((ps) => {
      const q = ps[this.selIdx];
      const e = q?.[kind.key];
      if (!e) return;
      for (let i = 0; i < res.nodes.length; i++) {
        e[i] = { value: res.nodes[i].value, offset: res.nodes[i].offset };
      }
      // A sustain point holding on the old tail follows the new one (item 181).
      if (res.appended) {
        q[kind.susKey] = envFollowTailSustain(q[kind.susKey], active - 1, active);
      }
      // A patch block always carries its P bit — setEnvBlock stamps it when the
      // override is switched on — so there is no presence to claim here.
      this.selNode = res.selected;
    });
  }

  removeEnvNode(kind, env, selN) {
    const res = envRemoveNode(env, selN);
    if (res === null) return;
    this._edit((ps) => {
      const q = ps[this.selIdx];
      const e = q?.[kind.key];
      if (!e) return;
      for (let i = 0; i < res.nodes.length; i++) {
        e[i] = { value: res.nodes[i].value, offset: res.nodes[i].offset };
      }
      // Wrap indices that pointed past the new tail come back into range.
      q[kind.susKey] = envClampWrap(q[kind.susKey], res.active);
      q[kind.loopKey] = envClampWrap(q[kind.loopKey], res.active);
      this.selNode = res.selected;
    });
  }

  // ── envelope graph (linear/log time, drag = 2D node edit) ─────────────────

  envTimeFrac(tv, total) {
    if (!this.logTime) return total > 0 ? tv / total : 0;
    const t0 = Math.max(total / 400, 1e-4);
    return Math.log((tv + t0) / t0) / Math.log((total + t0) / t0);
  }

  envFracTime(f, total) {
    if (!this.logTime) return f * total;
    const t0 = Math.max(total / 400, 1e-4);
    return t0 * (Math.pow((total + t0) / t0, f) - 1);
  }

  /** Current selected patch's env for the open tab (fresh objects each edit). */
  curEnv() {
    const p = this.patches()[this.selIdx];
    const kind = this.envCanvas?.kind;
    return p && kind ? p[kind.key] : null;
  }

  envGeometry(env) {
    const canvas = this.envCanvas.canvas;
    const w = canvas.clientWidth;
    const times = [0];
    for (let i = 0; i < 24; i++) times.push(times[i] + minifloatToDouble(env[i].offset));
    const active = envActiveCount(env);
    const total = Math.max(times[active - 1], 0.25);
    return { w, times, total };
  }

  drawEnv() {
    if (!this.envCanvas || !this.envCanvas.canvas.isConnected) return;
    const env = this.curEnv();
    if (!env) return;
    const { canvas, kind } = this.envCanvas;
    const p = this.patches()[this.selIdx];
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(240, canvas.parentElement.clientWidth - 2);
    const h = 180;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const C = themeColors();
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.cvBg;
    ctx.fillRect(0, 0, w, h);

    const { times, total } = this.envGeometry(env);
    const Xt = (tv) => 10 + this.envTimeFrac(tv, total) * (w - 20) * ENV_TIME_FRAC;
    const X = (i) => Xt(times[i]);
    const Y = (v) => h - 14 - (v / kind.max) * (h - 28);

    ctx.font = "9px monospace";
    ctx.strokeStyle = C.border;
    for (let gl = 0; gl <= 4; gl++) {
      const val = (kind.max * gl) / 4;
      const y = Y(val);
      ctx.globalAlpha = 0.35;
      ctx.beginPath(); ctx.moveTo(10, y); ctx.lineTo(w - 10, y); ctx.stroke();
      ctx.globalAlpha = 0.7;
      ctx.fillStyle = C.dim;
      ctx.fillText(String(Math.round(val)), 1, y - 1.5);
    }
    ctx.globalAlpha = 1;

    const shade = (word, color) => {
      if (((word >> 5) & 1) === 0) return;
      const s = (word >> 8) & 0x1f;
      const e = word & 0x1f;
      ctx.fillStyle = color;
      ctx.fillRect(X(Math.min(s, 24)), 0, Math.max(X(Math.min(e, 24)) - X(Math.min(s, 24)), 2), h);
    };
    shade(p[kind.susKey], C.envSus);
    shade(p[kind.loopKey], C.envLoop);

    const active = envActiveCount(env);
    ctx.strokeStyle = C.envLine;
    ctx.beginPath();
    for (let i = 0; i < active; i++) {
      const x = X(i), y = Y(env[i].value);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = C.envNode;
    for (let i = 0; i < active; i++) {
      ctx.beginPath();
      ctx.arc(X(i), Y(env[i].value), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    if (this.selNode >= 0 && this.selNode < active) {
      ctx.strokeStyle = C.playCursor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(X(this.selNode), Y(env[this.selNode].value), 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    // live cursor: only voices that resolved THIS patch (sample identity match)
    const audio = this.store.audio;
    if (audio && p) {
      ctx.fillStyle = C.live;
      for (let vi = 0; vi < TOTAL_VOICES; vi++) {
        if (!audio.getVoiceActive(vi) || audio.getVoiceInstrument(vi) !== this.slot) continue;
        if (audio.getVoiceSamplePtr(vi) !== p.samplePtr ||
            audio.getVoiceSampleLength(vi) !== p.sampleLength) continue;
        const idx = audio[kind.liveIdx](vi);
        const tv = audio[kind.liveTime](vi);
        if (idx < 0 || idx > 24) continue;
        const x = Xt(Math.min(times[Math.min(idx, 24)] + tv, total));
        ctx.fillRect(x - 1, 0, 2, h);
      }
    }
  }

  envHit(e) {
    const env = this.curEnv();
    const rect = this.envCanvas.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const { w, times, total } = this.envGeometry(env);
    const active = envActiveCount(env);
    let best = -1, bestD = 12;
    for (let i = 0; i < active; i++) {
      const nx = 10 + this.envTimeFrac(times[i], total) * (w - 20) * ENV_TIME_FRAC;
      const d = Math.abs(nx - x);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  envPointerDown(e) {
    const idx = this.envHit(e);
    if (idx < 0) return;
    this.selNode = idx;
    this.envCanvas.canvas.setPointerCapture(e.pointerId);
    this.dragState = { idx, gestureId: `advenv${Date.now()}` };
    this.envPointerMove(e);
  }

  envPointerMove(e) {
    if (!this.dragState || !this.envCanvas) return;
    const env = this.curEnv();
    if (!env) return;
    const { canvas, kind } = this.envCanvas;
    const rect = canvas.getBoundingClientRect();
    const h = canvas.clientHeight;
    const idx = this.dragState.idx;
    const v = clampN(Math.round(((h - 14 - (e.clientY - rect.top)) / (h - 28)) * kind.max), 0, kind.max);
    let prevOffset;
    if (idx > 0) {
      const { w, times, total } = this.envGeometry(env);
      const x = e.clientX - rect.left;
      // headroom rule (item 37): frac may exceed 1 up to 1/ENV_TIME_FRAC so the
      // last node can be dragged rightwards to extend the envelope
      const frac = clampN((x - 10) / ((w - 20) * ENV_TIME_FRAC), 0, 1 / ENV_TIME_FRAC);
      const wantTime = this.envFracTime(frac, total);
      prevOffset = minifloatFromDouble(Math.max(wantTime - times[idx - 1], 0));
    }
    this._commit((ps) => {
      const q = ps[this.selIdx];
      const en = q?.[kind.key];
      if (!en) return;
      en[idx].value = v;
      if (prevOffset !== undefined) en[idx - 1].offset = prevOffset;
    }, { gestureId: this.dragState.gestureId });
    this.drawEnv();
  }

  // ── wave scope ─────────────────────────────────────────────────────────────

  /** Selected row's sample view {ptr, len, loopStart, loopEnd} or null. */
  selSample() {
    const patches = this.patches();
    if (this.selIdx < patches.length) {
      const p = patches[this.selIdx];
      return { ptr: p.samplePtr, len: p.sampleLength, loopStart: p.loopStart, loopEnd: p.loopEnd };
    }
    const inst = this.inst;
    if (inst.sampleLength <= 0) return null;
    return { ptr: inst.samplePtr, len: inst.sampleLength,
             loopStart: inst.sampleLoopStart, loopEnd: inst.sampleLoopEnd };
  }

  drawWave() {
    const canvas = this.waveCanvas;
    if (!canvas || !canvas.isConnected) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(240, canvas.parentElement.clientWidth - 2);
    const h = 140;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const C = themeColors();
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.cvBg;
    ctx.fillRect(0, 0, w, h);
    const smp = this.selSample();
    if (!smp || smp.len <= 0 || !this.doc.sampleBin) {
      ctx.fillStyle = C.dim;
      ctx.font = "11px monospace";
      ctx.fillText(t("adv.noSample"), 8, 20);
      return;
    }
    const bytes = this.doc.sampleBin.subarray(smp.ptr, smp.ptr + smp.len);
    // loop region shading
    if (smp.loopEnd > smp.loopStart) {
      const x0 = (smp.loopStart / smp.len) * w;
      const x1 = (smp.loopEnd / smp.len) * w;
      ctx.fillStyle = C.waveLoop;
      ctx.globalAlpha = 0.25;
      ctx.fillRect(x0, 0, Math.max(x1 - x0, 1), h);
      ctx.globalAlpha = 1;
    }
    // Centre-anchored bars, as every other sample display draws (item 109) —
    // each column is filled from the zero line out to its peak.
    const baseY = h / 2;
    ctx.fillStyle = C.waveMid;
    ctx.fillRect(0, Math.round(baseY), w, 1);
    ctx.fillStyle = C.wave;
    for (let col = 0; col < w; col++) {
      const start = Math.floor((col * smp.len) / w);
      const end = Math.min(smp.len, Math.floor(((col + 1) * smp.len) / w) || start + 1);
      let mn = 255, mx = 0;
      const step = Math.max(1, Math.floor((end - start) / 8));
      for (let i = start; i < end; i += step) {
        const v = bytes[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (mn > mx) continue;
      const yT = Math.min(baseY, h - (mx / 255) * h);
      const yB = Math.max(baseY, h - (mn / 255) * h);
      ctx.fillRect(col, yT, 1, Math.max(1, yB - yT));
    }
    // live play-position hairlines for voices sounding this sample
    const audio = this.store.audio;
    if (audio) {
      ctx.fillStyle = C.playCursor;
      for (let vi = 0; vi < TOTAL_VOICES; vi++) {
        if (!audio.getVoiceActive(vi) || audio.getVoiceInstrument(vi) !== this.slot) continue;
        if (audio.getVoiceSamplePtr(vi) !== smp.ptr ||
            audio.getVoiceSampleLength(vi) !== smp.len) continue;
        const pos = audio.getVoiceSamplePos(vi);
        if (pos < 0) continue;
        ctx.fillRect((pos / smp.len) * w - 1, 0, 2, h);
      }
    }
  }

  drawEnvArea() {
    if (this.envKind === ENV_WAVE) this.drawWave();
    else this.drawEnv();
  }

  // ── patch list ops ─────────────────────────────────────────────────────────

  /** Fresh patch bound to the base sample over the full pitch/vel range. The
   *  auto-vibrato block is left at its inherit sentinel ($FF waveform, four
   *  zeroes) — since item 170 that IS the way to say "whatever the instrument
   *  says", and it keeps tracking the base record if that is edited later. */
  freshPatch() {
    const inst = this.inst;
    return makeInstPatch({
      pitchStart: 0x0020, pitchEnd: 0xffff, volumeStart: 0, volumeEnd: 63,
      samplePtr: inst.samplePtr, sampleLength: inst.sampleLength,
      playStart: inst.samplePlayStart, loopStart: inst.sampleLoopStart,
      loopEnd: inst.sampleLoopEnd, samplingRate: inst.samplingRate,
      sampleDetune: inst.sampleDetuneSigned, loopMode: inst.loopMode & 0x07,
    });
  }

  addPatch() {
    const at = Math.min(this.selIdx + 1, this.patches().length);
    this._edit((ps) => { ps.splice(at, 0, this.freshPatch()); }, { census: true });
    this.selIdx = at;
    this.render();
  }

  duplicatePatch() {
    const i = this.selIdx;
    if (i >= this.patches().length) return;
    this._edit((ps) => { ps.splice(i + 1, 0, clonePatch(ps[i])); }, { census: true });
    this.selIdx = i + 1;
    this.render();
  }

  deletePatch() {
    const i = this.selIdx;
    if (i >= this.patches().length) return;
    this._edit((ps) => { ps.splice(i, 1); }, { census: true });
    this.selIdx = Math.min(i, this.patches().length);
    this.render();
  }

  movePatch(dir) {
    const i = this.selIdx;
    const n = this.patches().length;
    const j = i + dir;
    if (i >= n || j < 0 || j >= n) return;
    this._edit((ps) => { const [p] = ps.splice(i, 1); ps.splice(j, 0, p); });
    this.selIdx = j;
    this.render();
  }

  // ── live overlay (called from InstrumentsView.frame) ──────────────────────

  frame() {
    const audio = this.store.audio;
    if (!audio || !this.mapCanvas?.isConnected) return;
    // repaint the map only when the live-voice signature changes; env/wave
    // cursors repaint while any voice of this instrument sounds (plus one
    // frame after, to erase the last hairline)
    let sig = "";
    let any = false;
    for (let vi = 0; vi < TOTAL_VOICES; vi++) {
      if (!audio.getVoiceActive(vi) || audio.getVoiceInstrument(vi) !== this.slot) continue;
      any = true;
      sig += `${vi}:${audio.getVoiceNote(vi)}:${(audio.getVoiceEffectiveVolume(vi) || 0).toFixed(2)};`;
    }
    if (sig !== this._liveSig) {
      this._liveSig = sig;
      this.drawMap();
    }
    if (any || this._hadLive) this.drawEnvArea();
    this._hadLive = any;
  }
}
