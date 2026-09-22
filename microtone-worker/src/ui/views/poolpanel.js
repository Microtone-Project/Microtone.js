// Sample-memory panel (item 166) — the optional half of the Samples view.
//
// The list on the left is a CENSUS: one row per distinct (ptr:len) claim, which
// is the right unit for naming and editing and says nothing about where the
// bytes are. Several rows can be slices of one recording, a deleted sample
// leaves a hole no row can mention, and a junk instrument record claims a
// pointer nowhere near the pool and still gets a row that looks like a sample.
// This panel draws the address line instead, in three bands:
//
//   pool     the whole 8 MB, so the used part is seen at its real scale
//   claimed  0 … high-water, one lane per overlap — the map proper
//   zoom     the selected sample's neighbourhood, where names and loop
//            regions fit and "these two rows are the same bytes" is visible
//
// Clicking any block selects that census row, so the map navigates the list.
// A live tick per sounding voice rides on top while the song plays.

import { themeColors, pickInk } from "../theme.js";
import { unescapeName } from "../names.js";
import { poolMap, claimsIn, POOL_SIZE } from "../../doc/poolmap.js";
import { TOTAL_VOICES } from "../../engine/constants.js";
import { t } from "../i18n.js";
import { uiDpr, localPoint } from "../zoom.js";

const PAD_X = 4;
const CAP_H = 13;      // caption line above a band
const AXIS_H = 12;     // address labels under a band
const BAND_GAP = 10;
const POOL_H = 15;
const LANE_H = 13;
const ZOOM_LANE_H = 19;
const LOOP_H = 4;      // the loop bar drawn under a zoomed block
/** Overlap lanes drawn before the rest are folded into the last one. Deeper
 *  than this and the panel would grow taller than the waveform above it. */
const MAX_LANES = 8;

function fmtBytes(n) {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

const hexAddr = (n) => "0x" + Math.max(0, n).toString(16).toUpperCase();
/** A census row as the list on the left spells it: three digits, zero-padded. */
const rowLabel = (i) => String(i).padStart(3, "0");

/** Lay overlapping claims onto as few lanes as they need (see poolmap.js). */
function localLanes(claims) {
  const laneEnd = [];
  const of = new Map();
  for (const c of claims) {
    let lane = laneEnd.findIndex((e) => e <= c.ptr);
    if (lane < 0) { lane = laneEnd.length; laneEnd.push(0); }
    laneEnd[lane] = c.end;
    of.set(c, lane);
  }
  return { of, count: Math.max(1, laneEnd.length) };
}

export class PoolPanel {
  /** @param onSelect called with a census index when a block is clicked. */
  constructor(store, { onSelect } = {}) {
    this.store = store;
    this.onSelect = onSelect;
    this.selected = -1;
    this.map = null;
    this._fingerprint = null;
    this._scan = null;
    this.bands = [];

    this.root = document.createElement("div");
    this.root.className = "pool-panel";
    this.stats = document.createElement("div");
    this.stats.className = "pool-stats";
    this.wrap = document.createElement("div");
    this.wrap.className = "pool-wrap";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "pool-canvas";
    // The live ticks ride on their own layer: the map itself is redrawn only
    // when the pool changes, and a sounding voice must not drag it along at
    // sixty frames a second.
    this.overlay = document.createElement("canvas");
    this.overlay.className = "pool-overlay";
    this.wrap.append(this.canvas, this.overlay);
    this.hover = document.createElement("div");
    this.hover.className = "pool-hover";
    this.notes = document.createElement("ul");
    this.notes.className = "pool-notes";
    // Four fills with no key is a puzzle, not a map.
    this.legend = document.createElement("div");
    this.legend.className = "pool-legend";
    for (const [key, cssVar] of [
      ["pool.legendUsed", "--cv-pool-used"],
      ["pool.legendShared", "--cv-pool-shared"],
      ["pool.legendRegion", "--cv-pool-region"],
      ["pool.legendSel", "--accent"],
      ["pool.legendFree", "--cv-pool-free"],
      ["pool.legendStale", "--cv-pool-stale"],
    ]) {
      const sw = document.createElement("i");
      sw.style.background = `var(${cssVar})`;
      const item = document.createElement("span");
      item.append(sw, document.createTextNode(t(key)));
      this.legend.appendChild(item);
    }
    this.root.append(this.stats, this.wrap, this.hover, this.legend, this.notes);

    this.canvas.addEventListener("pointermove", (e) => this.pointerMove(e));
    this.canvas.addEventListener("pointerleave", () => this.setHover(null));
    this.canvas.addEventListener("pointerdown", (e) => this.pointerDown(e));
  }

  get element() { return this.root; }

  /**
   * Recompute the map and repaint. The 8 MB free-space scan (which tells a
   * swept hole from one still holding old audio) is skipped when neither the
   * image nor the census has moved — an in-place waveform edit rewrites bytes
   * INSIDE a claim, which the map does not depend on.
   */
  refresh(selected = this.selected) {
    this.selected = selected;
    const doc = this.store.doc;
    if (!doc) { this.map = null; this._fingerprint = null; this._scan = null; this.clear(); return; }
    const census = doc.sampleList();
    const print = fingerprint(doc, census);
    // The census objects are rebuilt on every call (an instrument edit can move
    // a loop without moving a byte), so the map is always rebuilt — but the
    // free-space scan is not: with the geometry unchanged the holes are the
    // same holes, and their verdicts carry straight over.
    const rescan = print !== this._fingerprint || !this._scan;
    this.map = poolMap(doc, { census, scanBytes: rescan });
    if (rescan) {
      this._fingerprint = print;
      this._scan = {
        stale: this.map.holes.map((h) => h.stale),
        tailStale: this.map.stats.tailStale,
        staleBytes: this.map.stats.staleBytes,
      };
    } else {
      this.map.holes.forEach((h, i) => { h.stale = this._scan.stale[i] ?? 0; });
      this.map.stats.tailStale = this._scan.tailStale;
      this.map.stats.staleBytes = this._scan.staleBytes;
      this.map.stats.scanned = true;
    }
    this.draw();
    this.writeStats();
    this.writeNotes();
  }

  clear() {
    this.stats.textContent = "";
    this.notes.innerHTML = "";
    this.hover.textContent = "";
    const ctx = this.canvas.getContext("2d");
    ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  // ── text ───────────────────────────────────────────────────────────────────

  writeStats() {
    const s = this.map.stats;
    const runs = [...this.map.holes.map((h) => h.len), s.tailFree];
    this.stats.textContent = t("pool.stats", {
      used: fmtBytes(s.usedBytes),
      total: fmtBytes(POOL_SIZE),
      pct: ((s.usedBytes / POOL_SIZE) * 100).toFixed(1),
      spans: s.spans,
      rows: s.entries,
      free: fmtBytes(s.freeBytes),
      largest: fmtBytes(Math.max(0, ...runs)),
    });
  }

  writeNotes() {
    const s = this.map.stats;
    const lines = [];
    if (s.overlapPairs > 0) {
      lines.push(t("pool.noteOverlap", {
        n: new Set(this.map.claims.filter((c) => c.overlaps.length).map((c) => c.index)).size,
        b: fmtBytes(s.sharedBytes),
      }));
    }
    if (this.map.outside.length > 0) {
      lines.push(t("pool.noteOutside", {
        n: this.map.outside.length,
        list: this.map.outside.slice(0, 6)
          .map((c) => `${rowLabel(c.index)} ${hexAddr(c.ptr)}`).join(", "),
      }));
    }
    if (s.holeCount > 0) {
      lines.push(t("pool.noteHoles", {
        n: s.holeCount,
        b: fmtBytes(s.holeBytes),
        largest: fmtBytes(Math.max(...this.map.holes.map((h) => h.len))),
      }));
    }
    if (s.regionCount > 0) {
      lines.push(t("pool.noteRegions", {
        n: s.regionCount, b: fmtBytes(s.regionBytes),
      }));
    }
    if (s.staleBytes > 0) lines.push(t("pool.noteStale", { b: fmtBytes(s.staleBytes) }));
    if (lines.length === 0 && s.spans > 0) lines.push(t("pool.notePacked", { n: s.spans }));
    this.notes.innerHTML = "";
    for (const line of lines) {
      const li = document.createElement("li");
      li.textContent = line;
      this.notes.appendChild(li);
    }
  }

  setHover(text) {
    this.hover.textContent = text ?? "";
    this.canvas.style.cursor = text ? "pointer" : "default";
  }

  /** What sits at a point: a claim, a hole, or nothing. */
  hitTest(x, y) {
    for (const b of this.bands) {
      if (y < b.y || y > b.y + b.h) continue;
      // Claims first, and later ones first within that: a contained slice is
      // drawn over its container, so it has to be picked over it too.
      for (let i = b.rects.length - 1; i >= 0; i--) {
        const r = b.rects[i];
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return { band: b, ...r };
      }
      return { band: b, byte: b.from + ((x - b.x) / b.w) * (b.to - b.from) };
    }
    return null;
  }

  pointerMove(e) {
    const p = localPoint(this.canvas, e);
    const hit = this.hitTest(p.x, p.y);
    if (!hit) { this.setHover(null); return; }
    if (hit.claim) {
      const c = hit.claim;
      const name = unescapeName(c.entry.name) || t("smp.namePlaceholder");
      // The sharing clause is the one fact the list on the left cannot state.
      const shared = new Set(c.overlaps.map((i) => this.map.claims[i].index));
      this.setHover(t("pool.hoverClaim", {
        idx: rowLabel(c.index), name, at: hexAddr(c.ptr), end: hexAddr(c.end),
        len: fmtBytes(c.len),
        chan: c.chan > 0 ? t("pool.hoverChan", { n: c.chan + 1 }) : "",
        users: c.entry.users.length,
      }) + (shared.size ? t("pool.hoverShared", { n: shared.size }) : ""));
    } else if (hit.region) {
      const r = hit.region;
      this.setHover(t("pool.hoverRegion", {
        at: hexAddr(r.ptr), end: hexAddr(r.end),
        name: unescapeName(r.entry.name) || t("rgn.namePlaceholder"),
        len: fmtBytes(r.len),
        chan: r.chan > 0 ? t("pool.hoverChan", { n: r.chan + 1 }) : "",
      }));
    } else if (hit.hole) {
      this.setHover(t(hit.hole.stale > 0 ? "pool.hoverStale" : "pool.hoverFree", {
        at: hexAddr(hit.hole.ptr), len: fmtBytes(hit.hole.len),
        stale: fmtBytes(hit.hole.stale),
      }));
    } else {
      this.setHover(t("pool.hoverAddr", { at: hexAddr(Math.round(hit.byte)) }));
    }
  }

  pointerDown(e) {
    const p = localPoint(this.canvas, e);
    const hit = this.hitTest(p.x, p.y);
    if (hit?.claim) this.onSelect?.(hit.claim.index);
  }

  // ── the map ────────────────────────────────────────────────────────────────

  /** The claims of the selected census row (both channels of a stereo one). */
  selClaims() {
    if (!this.map || this.selected < 0) return [];
    return this.map.claims.filter((c) => c.index === this.selected);
  }

  layout(w) {
    const map = this.map;
    const bands = [];
    let y = 0;
    const add = (kind, from, to, h, extra = {}) => {
      y += CAP_H;
      const b = { kind, from, to, x: PAD_X, y, w: w - PAD_X * 2, h, rects: [], ...extra };
      b.xOf = (byte) => b.x + ((byte - b.from) / Math.max(1, b.to - b.from)) * b.w;
      bands.push(b);
      y += h + AXIS_H + BAND_GAP;
      return b;
    };
    add("pool", 0, POOL_SIZE, POOL_H);
    const lanes = Math.min(Math.max(1, map.lanes), MAX_LANES);
    add("used", 0, Math.max(map.highWater, 1), lanes * LANE_H, { lanes });
    // The zoom window is a handful of the selected sample's own lengths, so a
    // 90-byte chip waveform and a 64 KB drum loop both land readable, and never
    // narrower than a screen's worth of bytes.
    const sel = this.selClaims().filter((c) => !c.outside)[0];
    if (sel) {
      const span = Math.max(sel.len * 6, 2048);
      let from = Math.round(sel.ptr + sel.len / 2 - span / 2);
      from = Math.max(0, Math.min(from, POOL_SIZE - span));
      const to = Math.min(POOL_SIZE, from + span);
      const win = claimsIn(map, from, to - from);
      const ll = localLanes(win);
      add("zoom", Math.max(0, from), to, ll.count * (ZOOM_LANE_H + LOOP_H),
        { laneOf: ll.of, win, sel });
    }
    return { bands, height: Math.max(1, y - BAND_GAP) };
  }

  draw() {
    if (!this.map) return;
    const C = themeColors();
    const dpr = uiDpr();
    const w = Math.max(320, this.wrap.clientWidth || this.root.clientWidth || 640);
    const { bands, height } = this.layout(w);
    this.bands = bands;
    for (const cv of [this.canvas, this.overlay]) {
      cv.width = w * dpr;
      cv.height = height * dpr;
      cv.style.width = w + "px";
      cv.style.height = height + "px";
    }
    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, height);
    ctx.font = "9px monospace";
    ctx.textBaseline = "alphabetic";
    for (const b of bands) {
      if (b.kind === "pool") this.drawPool(ctx, b, C);
      else if (b.kind === "used") this.drawUsed(ctx, b, C);
      else this.drawZoom(ctx, b, C);
    }
    this.drawLive();
  }

  caption(ctx, b, C, text, right = "") {
    ctx.fillStyle = C.dim;
    ctx.textAlign = "left";
    ctx.fillText(text, b.x, b.y - 4);
    if (right) { ctx.textAlign = "right"; ctx.fillText(right, b.x + b.w, b.y - 4); }
    ctx.textAlign = "left";
  }

  axis(ctx, b, C, left, right) {
    ctx.fillStyle = C.dim;
    ctx.textAlign = "left";
    ctx.fillText(left, b.x, b.y + b.h + 9);
    ctx.textAlign = "right";
    ctx.fillText(right, b.x + b.w, b.y + b.h + 9);
    ctx.textAlign = "left";
  }

  /** Band 1 — the whole 8 MB, so "how much is left" needs no arithmetic. */
  drawPool(ctx, b, C) {
    const map = this.map;
    ctx.fillStyle = C.poolFree;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = C.poolUsed;
    for (const u of map.used) {
      ctx.fillRect(b.xOf(u.ptr), b.y, Math.max(1, (u.len / POOL_SIZE) * b.w), b.h);
    }
    // Regions (item 175) are used memory NOTHING claims, so they are drawn over
    // the merged extents rather than beside them: at this scale a 4 MB
    // recording is most of the strip, and it must not read as claimed samples.
    ctx.fillStyle = C.poolRegion;
    for (const r of map.regions) {
      ctx.fillRect(b.xOf(r.ptr), b.y, Math.max(1, (r.len / POOL_SIZE) * b.w), b.h);
    }
    // megabyte gridlines: the only ruler this scale can carry
    ctx.fillStyle = C.border;
    for (let mb = 1; mb < 8; mb++) ctx.fillRect(Math.round(b.xOf(mb * 1048576)), b.y, 1, b.h);
    ctx.fillStyle = C.accent;
    for (const c of this.selClaims()) {
      if (c.outside) continue;
      ctx.fillRect(Math.round(b.xOf(c.ptr)) - 1, b.y - 2, 3, b.h + 4);
    }
    if (map.highWater > 0) {
      ctx.strokeStyle = C.fg2 ?? C.fg;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.moveTo(Math.round(b.xOf(map.highWater)) + 0.5, b.y - 2);
      ctx.lineTo(Math.round(b.xOf(map.highWater)) + 0.5, b.y + b.h + 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    this.caption(ctx, b, C, t("pool.bandPool"),
      t("pool.highWater", { at: hexAddr(map.highWater) }));
    this.axis(ctx, b, C, "0x0", hexAddr(POOL_SIZE));
  }

  /** Band 2 — 0 … high-water, one lane per overlap. The map proper. */
  drawUsed(ctx, b, C) {
    const map = this.map;
    ctx.fillStyle = C.poolFree;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    for (const h of map.holes) {
      const x = b.xOf(h.ptr);
      const hw = Math.max(1, b.xOf(h.ptr + h.len) - x);
      ctx.fillStyle = h.stale > 0 ? C.poolStale : C.poolFree;
      ctx.fillRect(x, b.y, hw, b.h);
      b.rects.push({ x, y: b.y, w: hw, h: b.h, hole: h });
    }
    // Regions run the FULL height of the band, behind every lane: the claims
    // drawn on top of one are the windows cut out of that recording.
    for (const r of map.regions) {
      const x = b.xOf(r.ptr);
      const rw = Math.max(1, b.xOf(r.end) - x);
      ctx.fillStyle = C.poolRegion;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(x, b.y, rw, b.h);
      ctx.globalAlpha = 1;
      b.rects.push({ x, y: b.y, w: rw, h: b.h, region: r });
    }
    const laneH = b.h / b.lanes;
    for (const c of map.claims) {
      if (c.outside) continue;
      const lane = Math.min(c.lane, b.lanes - 1);
      const x = b.xOf(c.ptr);
      const cw = Math.max(1, b.xOf(c.end) - x);
      const y = b.y + lane * laneH;
      const h = laneH - 1;
      const selected = c.index === this.selected;
      const fill = selected ? C.accent : c.overlaps.length ? C.poolShared : C.poolUsed;
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, cw, h);
      // The selection wins the fill — it has to be findable — so a selected
      // block that shares its bytes wears the sharing colour along its top edge
      // instead of losing the fact altogether.
      if (selected && c.overlaps.length) {
        ctx.fillStyle = C.poolShared;
        ctx.fillRect(x, y, cw, 2);
      }
      if (cw >= 3) {
        ctx.strokeStyle = C.cvBg;
        ctx.strokeRect(Math.round(x) + 0.5, y + 0.5, Math.round(cw) - 1, h - 1);
      }
      if (cw >= 18) {
        ctx.fillStyle = pickInk(fill, C);
        ctx.fillText(rowLabel(c.index), x + 2, y + h - 3);
      }
      b.rects.push({ x, y, w: cw, h, claim: c });
    }
    this.caption(ctx, b, C, t("pool.bandUsed", { n: map.claims.length - map.outside.length }),
      map.lanes > b.lanes ? t("pool.laneOverflow", { n: map.lanes - b.lanes }) : "");
    this.axis(ctx, b, C, "0x0", hexAddr(b.to));
  }

  /** Band 3 — the selection's neighbourhood: names, loop regions, and the
   *  rows that turn out to be the same bytes seen a second way. */
  drawZoom(ctx, b, C) {
    ctx.fillStyle = C.poolFree;
    ctx.fillRect(b.x, b.y, b.w, b.h);
    for (const r of this.map.regions) {
      if (r.ptr >= b.to || r.end <= b.from) continue;
      const x = Math.max(b.x, b.xOf(r.ptr));
      const x2 = Math.min(b.x + b.w, b.xOf(r.end));
      ctx.fillStyle = C.poolRegion;
      ctx.globalAlpha = 0.4;
      ctx.fillRect(x, b.y, Math.max(1, x2 - x), b.h);
      ctx.globalAlpha = 1;
    }
    const rowH = ZOOM_LANE_H + LOOP_H;
    for (const c of b.win) {
      const lane = b.laneOf.get(c) ?? 0;
      const x = Math.max(b.x, b.xOf(c.ptr));
      const x2 = Math.min(b.x + b.w, b.xOf(c.end));
      const cw = Math.max(1, x2 - x);
      const y = b.y + lane * rowH;
      const selected = c.index === this.selected;
      const fill = selected ? C.accent : c.overlaps.length ? C.poolShared : C.poolUsed;
      ctx.fillStyle = fill;
      ctx.globalAlpha = selected ? 1 : 0.8;
      ctx.fillRect(x, y, cw, ZOOM_LANE_H);
      ctx.globalAlpha = 1;
      if (selected && c.overlaps.length) {
        ctx.fillStyle = C.poolShared;
        ctx.fillRect(x, y, cw, 2);
      }
      // The loop the row DECLARES, under the bytes it declares them in — the
      // one line that ties the list's numbers back to the address line.
      const e = c.entry;
      if ((e.loopMode & 3) !== 0 && e.loopEnd > e.loopStart) {
        const lx = Math.max(b.x, b.xOf(c.ptr + Math.min(e.loopStart, c.len)));
        const lx2 = Math.min(b.x + b.w, b.xOf(c.ptr + Math.min(e.loopEnd, c.len)));
        ctx.fillStyle = C.accent2 ?? C.accent;
        ctx.fillRect(lx, y + ZOOM_LANE_H, Math.max(1, lx2 - lx), LOOP_H - 1);
      }
      if (cw >= 34) {
        const label = `${rowLabel(c.index)} ` +
          (unescapeName(e.name) || t("smp.namePlaceholder")) +
          (c.chan > 0 ? ` ${t("pool.hoverChan", { n: c.chan + 1 })}` : "");
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, cw, ZOOM_LANE_H);
        ctx.clip();
        ctx.fillStyle = pickInk(fill, C);
        ctx.fillText(label, x + 3, y + 13);
        ctx.restore();
      }
      b.rects.push({ x, y, w: cw, h: ZOOM_LANE_H, claim: c });
    }
    this.caption(ctx, b, C, t("pool.bandZoom", { idx: rowLabel(this.selected) }),
      t("pool.zoomSpan", { n: fmtBytes(b.to - b.from) }));
    this.axis(ctx, b, C, hexAddr(b.from), hexAddr(b.to));
  }

  /** Per-frame: a tick per sounding voice, where its playhead is in memory. */
  drawLive() {
    const audio = this.store.audio;
    const ctx = this.overlay.getContext("2d");
    if (!ctx) return;
    const dpr = uiDpr();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (!audio || !this.map) return;
    ctx.fillStyle = themeColors().waveCursor;
    for (let vi = 0; vi < TOTAL_VOICES; vi++) {
      if (!audio.getVoiceActive(vi)) continue;
      const ptr = audio.getVoiceSamplePtr(vi);
      const pos = audio.getVoiceSamplePos(vi);
      if (!(ptr >= 0) || !(pos >= 0)) continue;
      const addr = ptr + pos;
      if (addr < 0 || addr > POOL_SIZE) continue;
      for (const b of this.bands) {
        if (addr < b.from || addr > b.to) continue;
        ctx.fillRect(Math.round(b.xOf(addr)), b.y - 2, 2, b.h + 4);
      }
    }
  }
}

/** Cheap "has the pool moved?" key: the image the doc holds plus the census's
 *  own geometry. An in-place waveform edit changes neither, and the map does
 *  not depend on the bytes inside a claim. */
function fingerprint(doc, census) {
  let sig = census.length + ":";
  for (const e of census) sig += e.ptr + "," + e.len + ";";
  // Regions reserve pool bytes (item 175), so adding or dropping one moves the
  // holes — which is exactly what the scan measures.
  sig += "|r";
  for (const r of doc.sampleRegions()) sig += r.ptr + "," + r.len + "," + r.chan + ";";
  return sig + "|" + (doc.sampleInstImage?.byteLength ?? 0) + "|" + docImageId(doc);
}

let _imageIds = new WeakMap();
let _nextImageId = 1;
function docImageId(doc) {
  const img = doc.sampleInstImage;
  if (!img) return 0;
  let id = _imageIds.get(img);
  if (id === undefined) { id = _nextImageId++; _imageIds.set(img, id); }
  return id;
}
