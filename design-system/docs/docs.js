// The design-system docs page. Everything it shows comes from the system's
// own sources — tokens.json, components.json and README.md for the words and
// values, the app's stylesheet and component modules for the drawing — so
// the page cannot describe something the app does not do.
//
// Served from the REPO ROOT (design-system/README.md, "Viewing the docs"): the
// components are imported by their real path under microtone-worker/, never
// through design-system/components, whose relative imports would resolve
// against the link. microtone.cc/design-system/ serves a staged copy of this
// page with those paths rewritten (tools/stage-site.js), so keep every URL in
// the page and in index.html in the `../../microtone-worker/…` / `../<data>.json`
// shape that rewrite knows.

import { actionRow } from "../../microtone-worker/src/ui/components/actions.js";
import { showModal, showNotice } from "../../microtone-worker/src/ui/components/modal.js";
import { startControlEnhancer } from "../../microtone-worker/src/ui/components/spinner.js";
import { showContextMenu } from "../../microtone-worker/src/ui/components/contextmenu.js";
import { dragGrip, focusGrip } from "../../microtone-worker/src/ui/components/dragsort.js";
import { noteRun, rangeGlyph } from "../../microtone-worker/src/ui/components/noteglyph.js";
import { BTN_ICON, ICON, icon } from "../../microtone-worker/src/ui/icons.js";
import { renderMarkdown } from "../../microtone-worker/src/ui/markdown.js";
import { pitchTablePresets, ANCHOR_NOTE } from "../../microtone-worker/core/tuning/pitchtables.js";

const THEMES = ["dark", "dim", "light", "warmth"];
const $ = (sel, root = document) => root.querySelector(sel);

/** An element with a class and text — the page's one DOM helper. */
function el(tag, cls = "", text = "") {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

// ── copy to the clipboard, with a word of confirmation ──────────────────────

let toastTimer = 0;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), 1400);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast(`Copied ${text}`); }
  catch { toast(text); }
}
function chip(text, copyText = text) {
  const c = el("button", "ds-chip", text);
  c.type = "button";
  c.title = `Copy ${copyText}`;
  c.addEventListener("click", () => copy(copyText));
  return c;
}
function chips(label, items, toCopy = (x) => x) {
  const row = el("div", "ds-chips");
  if (!items?.length) return row;
  row.append(el("span", "ds-label", label), ...items.map((x) => chip(x, toCopy(x))));
  return row;
}

/** A paragraph of the manifest's prose, `code` spans and all. */
function prose(text) {
  const p = el("p");
  text.split(/`([^`]+)`/).forEach((part, i) => p.append(i % 2 ? el("code", "", part) : part));
  return p;
}

// ── theme ───────────────────────────────────────────────────────────────────

const onTheme = new Set();
const theme = () => document.documentElement.dataset.theme || "dark";
function setTheme(name) {
  document.documentElement.dataset.theme = name;
  try { localStorage.setItem("microtone-ds-theme", name); } catch { /* private mode */ }
  for (const b of document.querySelectorAll("[data-theme-pick]")) {
    b.setAttribute("aria-pressed", String(b.dataset.themePick === name));
  }
  for (const fn of onTheme) fn(name);
}

// ── sections ────────────────────────────────────────────────────────────────

function renderRules(manifest) {
  const host = $("#ruleList");
  for (const r of manifest.rules) {
    const card = el("article", "ds-rule");
    card.id = `rule-${r.id}`;
    card.dataset.rule = r.id;
    card.append(el("h3", "", r.title), prose(r.text));
    if (r.tokens) card.append(chips("tokens", r.tokens, (n) => `var(--${n})`));
    if (r.exceptions) for (const x of r.exceptions) card.append(el("p", "ds-enf", `Exception: ${x}`));
    if (r.enforcedBy) card.append(el("p", "ds-enf", `Enforced by ${r.enforcedBy.join(", ")}`));
    if (r.id === "dialog-actions") card.append(dialogDoDont());
    if (r.id === "proceed-style") card.append(proceedDemo());
    host.append(card);
  }
}

/** A dialog drawn in place (not in the top layer), for side-by-side views. */
function mockDialog(title, text, row) {
  const m = el("div", "modal ds-mock");
  m.append(el("h3", "", title));
  if (text) m.append(el("p", "dim", text));
  m.append(row);
  return m;
}

function dialogDoDont() {
  const grid = el("div", "ds-dodont");
  const good = el("div");
  good.append(el("div", "ds-verdict ds-do", "Do"),
    mockDialog("Make a chord", "Cancel at the left end; the alternative beside Proceed.",
      actionRow({ cancel: true, alternatives: [{ label: "Preview", icon: "play" }], proceed: "Apply" }).row));
  const bad = el("div");
  // Hand-built on purpose: this is the layout the rule replaced.
  const row = el("div", "modal-buttons");
  row.append(el("button", "", "Preview"), el("button", "", "Apply"), el("button", "", "Cancel"));
  bad.append(el("div", "ds-verdict ds-dont", "Don't"),
    mockDialog("Make a chord", "Cancel last, Proceed in the middle, nothing to tell them apart.", row));
  const lone = el("div");
  lone.append(el("div", "ds-verdict ds-do", "Do"),
    mockDialog("That name is taken", "Nothing to commit or abandon: one Dismiss, at the right end.",
      actionRow({ dismiss: "OK" }).row));
  grid.append(good, bad, lone);
  return grid;
}

function proceedDemo() {
  const row = el("div", "ds-row");
  row.style.marginTop = "0.6rem";
  const plain = el("button", "", "A button");
  const pro = el("button", "proceed", "Proceed");
  const off = el("button", "proceed", "Proceed, disabled");
  off.disabled = true;
  row.append(plain, pro, off);
  return row;
}

function renderColour(tokens) {
  const host = $("#colourList");
  const groups = new Map();
  for (const tok of tokens.color.tokens) {
    if (!groups.has(tok.group)) groups.set(tok.group, []);
    groups.get(tok.group).push(tok);
  }
  const valueCells = [];
  for (const [name, list] of groups) {
    const g = el("div", "ds-group");
    g.append(el("h3", "", name));
    for (const tok of list) {
      const row = el("div", "ds-tok");
      row.dataset.token = tok.name;
      const sw = el("div", "ds-sw");
      sw.style.background = `var(--${tok.name})`;
      const nm = el("button", "ds-name", `--${tok.name}`);
      nm.type = "button";
      nm.title = `Copy var(--${tok.name})`;
      nm.addEventListener("click", () => copy(`var(--${tok.name})`));
      const val = el("span", "ds-val");
      valueCells.push([val, tok]);
      const four = el("div", "ds-sw4");
      for (const th of THEMES) {
        const s = el("span");
        s.style.background = tok.value[th];
        s.title = `${th}: ${tok.value[th]}`;
        four.append(s);
      }
      row.append(sw, nm, val, four, el("span", "ds-use", tok.usage ?? ""));
      g.append(row);
    }
    host.append(g);
  }
  const sync = (th) => { for (const [cell, tok] of valueCells) cell.textContent = tok.value[th] ?? ""; };
  onTheme.add(sync);
}

function renderContrast(tokens) {
  const wrap = el("div", "ds-scroll");
  const table = el("table", "ds-table");
  const head = el("tr");
  head.append(el("th", "", "Ink"), el("th", "", "on ground"), el("th", "", "Live"),
    ...THEMES.map((th) => el("th", "", th)));
  table.append(head);
  for (const c of tokens.contrast) {
    const tr = el("tr");
    const sample = el("span", "ds-sample", "Aa 0O");
    sample.style.color = `var(--${c.ink})`;
    sample.style.background = `var(--${c.ground})`;
    const live = el("td");
    live.append(sample);
    tr.append(el("td", "ds-mono", c.ink), el("td", "ds-mono", c.ground), live);
    for (const th of THEMES) {
      const r = c.ratio[th];
      const td = el("td", "num");
      const b = el("span", `ds-aa ${r >= 4.5 ? "pass" : r >= 3 ? "large" : "fail"}`, r.toFixed(2));
      b.title = r >= 4.5 ? "passes 4.5:1" : r >= 3 ? "3:1 — large text and borders only" : "below 3:1";
      td.append(b);
      tr.append(td);
    }
    table.append(tr);
  }
  wrap.append(table);
  $("#contrastTable").append(wrap);
}

/** The faces, each in its own words. */
const SPECIMENS = {
  ui: "Import MIDI… · Export audio · Apply — 0123456789",
  "mono-font": "$FF $1F80 12.5 dB · O0 Il1 · 0x7F",
  "transport-font": "Oct 4  Inst 01  Step 1  Cue 03  Row 1F  BPM 125  Spd 6",
  "code-font": "lane bass = melody(\"C3 E3 G3\")  // Motif Code",
};

function renderType(tokens) {
  const host = $("#typeList");
  const fams = tokens.type.families;
  for (const [key, stack] of Object.entries(fams)) {
    const face = el("div", "ds-face");
    const headRow = el("div", "ds-face-head");
    headRow.append(el("b", "", stack.split(",")[0].replace(/"/g, "")), chip(key.endsWith("font") ? `var(--${key})` : stack));
    const spec = el("div", "ds-specimen");
    if (key === "display") {
      spec.className = "ds-specimen wc-brand";
      spec.innerHTML = '<span class="brand brand-red">Micro</span><span class="brand brand-white">tone</span><span class="brand brand-tm"></span>';
    } else if (key === "cv-font") {
      spec.style.fontFamily = stack;
      spec.append("C-4 01 40 A04  ");
      const p = pitchTablePresets;
      const scale = (id, n) => p[id].table.slice(0, n).flatMap((o, i) => (i ? [" ", ANCHOR_NOTE + o] : [ANCHOR_NOTE + o]));
      spec.append(noteRun(scale(240, 5), p[240]), "  ", noteRun(scale(410, 4), p[410]), "  ", noteRun(scale(10123, 3), p[10123]));
    } else {
      spec.style.fontFamily = stack;
      spec.textContent = SPECIMENS[key] ?? "";
      if (key === "ui") spec.style.fontVariationSettings = '"wdth" 86.6667';
    }
    face.append(headRow, spec);
    if (key !== "ui" && key !== "display") {
      const w = el("div", "ds-weights");
      w.style.fontFamily = stack;
      for (const wt of [100, 300, 500, 700, 900]) {
        const s = el("span", "", `${wt} Ab0`);
        s.style.fontWeight = wt;
        w.append(s);
      }
      face.append(w);
    }
    host.append(face);
  }
  host.append(el("h3", "", "Text styles"));
  for (const g of tokens.type.groups) {
    for (const s of g.styles) {
      const row = el("div", "ds-style");
      const fam = fams[s.family ?? g.family] ?? fams.ui;
      const meta = el("div");
      meta.append(el("div", "", s.name),
        el("div", "ds-meta", [s.fontSize, s.lineHeight && `/${s.lineHeight}`, s.fontWeight, s.fontStyle].filter(Boolean).join(" ")));
      const sample = el("div", "", s.sample ?? s.name);
      Object.assign(sample.style, {
        fontFamily: fam, fontSize: s.fontSize, fontWeight: s.fontWeight,
        lineHeight: s.lineHeight ?? "normal", fontStyle: s.fontStyle ?? "normal",
      });
      if (s.name === "tab") sample.style.textTransform = "uppercase";
      if (s.name === "proceed") { sample.className = "ds-row"; sample.textContent = ""; sample.append(el("button", "proceed", s.sample)); }
      if (g.name === "Wordmark") {
        sample.innerHTML = '<span class="brand brand-red">Micro</span><span class="brand brand-white">tone</span><span class="brand brand-tm"></span>';
      }
      const use = el("div", "dim ds-small", s.usage ?? "");
      const right = el("div");
      right.append(sample, use);
      row.append(meta, right);
      $("#typeList").append(row);
    }
  }
}

function renderShape(tokens) {
  const host = $("#shapeList");
  const shapes = el("div", "ds-shapes");
  for (const r of tokens.radius.tokens) {
    const s = el("div", "ds-shape");
    const box = el("i");
    box.style.borderRadius = `var(--${r.name})`;
    s.append(box, chip(`--${r.name}`, `var(--${r.name})`), el("span", "dim", r.value));
    shapes.append(s);
  }
  host.append(shapes);
  const list = el("div");
  for (const r of [...tokens.radius.tokens, ...tokens.weight.tokens]) {
    const row = el("div", "ds-tok");
    row.style.gridTemplateColumns = "12rem 4rem minmax(0, 1fr)";
    row.append(chip(`--${r.name}`, `var(--${r.name})`), el("span", "ds-val", r.value), el("span", "ds-use", r.usage));
    list.append(row);
  }
  host.append(list);
  host.append(el("h3", "", "Weight: Proceed against every other button"), proceedDemo());
}

// ── component demos ─────────────────────────────────────────────────────────

const DEMOS = {
  ActionRow(box) {
    const play = el("div", "ds-play");
    const opts = el("div", "ds-opts");
    const preview = el("div");
    const code = el("pre");
    const state = {
      cancel: true, alt1: true, alt1Label: "Preview", alt2: false, alt2Label: "Record",
      proceed: true, proceedLabel: "Apply", disabled: false, dismiss: false, extras: false,
    };
    const opt = (key, label, textKey) => {
      const l = el("label");
      const c = el("input");
      c.type = "checkbox";
      c.checked = state[key];
      c.dataset.key = key;
      c.addEventListener("change", () => { state[key] = c.checked; draw(); });
      l.append(c, label);
      if (textKey) {
        const t = el("input");
        t.type = "text";
        t.value = state[textKey];
        t.addEventListener("input", () => { state[textKey] = t.value; draw(); });
        l.append(t);
      }
      opts.append(l);
      return c;
    };
    const boxes = [
      opt("cancel", "Cancel"), opt("alt1", "Alternative", "alt1Label"), opt("alt2", "Alternative", "alt2Label"),
      opt("proceed", "Proceed", "proceedLabel"), opt("disabled", "Proceed disabled"),
      opt("extras", "Extras (a status line)"), opt("dismiss", "Dismiss alone"),
    ];
    function draw() {
      for (const b of boxes) if (b.dataset.key !== "dismiss") b.disabled = state.dismiss;
      const spec = state.dismiss ? { dismiss: true } : {
        cancel: state.cancel || null,
        alternatives: [state.alt1 && { label: state.alt1Label, icon: "play" }, state.alt2 && state.alt2Label],
        proceed: state.proceed ? { label: state.proceedLabel, disabled: state.disabled } : null,
        extras: state.extras ? [el("span", "dim ds-small", "2 issues")] : [],
      };
      preview.replaceChildren(mockDialog("Dialog title", "The row is rebuilt by actionRow() on every change.", actionRow(spec).row));
      code.textContent = state.dismiss ? "actionRow({ dismiss: true })" : "actionRow({\n" + [
        state.cancel && "  cancel: true,",
        (state.alt1 || state.alt2) && `  alternatives: [${[state.alt1 && `{ label: "${state.alt1Label}", icon: "play" }`, state.alt2 && `"${state.alt2Label}"`].filter(Boolean).join(", ")}],`,
        state.proceed && `  proceed: ${state.disabled ? `{ label: "${state.proceedLabel}", disabled: true }` : `"${state.proceedLabel}"`},`,
        state.extras && "  extras: [statusLine],",
      ].filter(Boolean).join("\n") + "\n})";
    }
    const right = el("div");
    right.append(preview, code);
    play.append(opts, right);
    box.append(play);
    draw();
  },

  Modal(box) {
    const out = el("div", "ds-out");
    const form = el("button", "", "Open a form dialog");
    form.addEventListener("click", async () => {
      const r = await showModal({
        title: "Export stems",
        body: "One file per lane, in a single ZIP.",
        fields: [
          { name: "prefix", label: "File prefix", value: "song", select: true },
          { name: "mode", label: "Lanes", type: "select", value: "all",
            options: [{ value: "all", label: "Every lane" }, { value: "used", label: "Lanes with notes" }],
            hints: { all: "Silent lanes export as silence.", used: "Lanes that never play are left out." } },
          { name: "cap", label: "Length (s)", type: "number", value: 180, min: 1, max: 3600 },
          { name: "norm", label: "Normalise each stem", type: "checkbox", value: true,
            hint: "Each file is brought up to full scale on its own." },
        ],
        okLabel: "Export",
      });
      out.textContent = `resolved ${JSON.stringify(r)}`;
    });
    const notice = el("button", "", "Open a notice");
    notice.addEventListener("click", async () => {
      await showNotice({ title: "That name is taken", body: "Pick another name for the copy.", okLabel: "OK" });
      out.textContent = "notice closed";
    });
    const row = el("div", "ds-row");
    row.append(form, notice);
    box.append(row, out);
  },

  ValueControl(box) {
    const row = el("div", "ds-row");
    const n = el("input");
    n.type = "number"; n.min = "20"; n.max = "999"; n.value = "125";
    const s = el("select");
    for (const name of ["12-TET", "24-TET", "31-TET", "41-TET (Kite)"]) s.append(new Option(name));
    const out = el("div", "ds-out");
    const say = () => { out.textContent = `value ${n.value} · ${s.value}`; };
    n.addEventListener("change", say);
    s.addEventListener("change", say);
    row.append(n, s);
    box.append(row, out);
    say();
  },

  ContextMenu(box) {
    const out = el("div", "ds-out");
    const open = el("button", "", "Open the menu here");
    const item = (id, label, disabled = false) => ({ id, label, icon: ICON[id], disabled });
    open.addEventListener("click", async () => {
      const r = open.getBoundingClientRect();
      const id = await showContextMenu(r.left, r.bottom + 4, [
        [item("cut", "Cut"), item("copy", "Copy"), item("paste", "Paste"), item("interpolate", "Interpolate"), item("transpose", "Transpose", true)],
        [item("channelLeft", "Insert lane left"), item("mute", "Mute"), item("solo", "Solo")],
      ]);
      out.textContent = `chose ${id ?? "nothing"}`;
    });
    box.append(open, out);
  },

  DragGrip(box) {
    let lanes = ["Lead", "Bass", "Drums", "Pad"];
    const table = el("table", "ds-drag");
    const body = el("tbody");
    table.append(body);
    const draw = (focus = -1) => {
      body.replaceChildren();
      lanes.forEach((name, i) => {
        const tr = el("tr");
        const g = el("td");
        g.append(dragGrip({
          index: i, count: lanes.length, title: "Drag to reorder (or ↑ ↓)",
          onMove: (from, to, via) => {
            const next = [...lanes];
            next.splice(to, 0, ...next.splice(from, 1));
            lanes = next;
            draw(via === "key" ? to : -1);
          },
        }));
        tr.append(g, el("td", "", `Lane ${i + 1}`), el("td", "", name));
        body.append(tr);
      });
      if (focus >= 0) focusGrip(table, focus);
    };
    draw();
    box.append(table);
  },

  NoteGlyph(box) {
    const pick = el("select");
    for (const id of [120, 240, 310, 410, 530, 10123]) pick.append(new Option(pitchTablePresets[id].name, id));
    pick.value = "240";
    const line = el("div", "ds-specimen");
    line.style.fontSize = "1.3rem";
    const range = el("div");
    const draw = () => {
      const p = pitchTablePresets[pick.value];
      const notes = p.table.slice(0, 12).map((o) => ANCHOR_NOTE + o);
      line.replaceChildren(noteRun(notes.flatMap((n, i) => (i ? [" ", n] : [n])), p));
      range.replaceChildren("Range: ", rangeGlyph(notes[0], notes[notes.length - 1], p, "whole range"),
        " · off the grid: ", noteRun([ANCHOR_NOTE + 0x20], p));
    };
    pick.addEventListener("change", draw);
    draw();
    box.append(pick, line, range);
  },

  Button(box) {
    box.innerHTML = `
      <div class="ds-row">
        <button>${icon("folder")}Open…</button>
        <button class="big">${icon("filePlus")}New project</button>
        <button>Export audio${icon("download", true)}</button>
        <button disabled>Disabled</button>
        <button class="proceed">Proceed</button>
      </div>
      <div class="ds-row">
        <button class="icon-btn" aria-label="Play">${icon("play")}</button>
        <button class="icon-btn" aria-label="Stop">${icon("stop")}</button>
        <button class="rec">${icon("record")}Rec</button>
        <button class="rec on">${icon("record")}Rec</button>
        <span class="tb-sep"></span>
        <button class="icon-btn" aria-label="Undo">${icon("undo")}</button>
        <button class="icon-btn" aria-label="Redo" disabled>${icon("redo")}</button>
        <button class="icon-btn" aria-label="Theme">${icon("theme")}</button>
      </div>`;
  },

  Badge(box) {
    box.innerHTML = `<div class="ds-row"><span class="badge">Audio off</span><span class="badge on">Audio on</span><span class="sel-mode">SEL</span></div>`;
  },

  Tabs(box) {
    box.style.padding = "0";
    box.style.overflow = "hidden";
    box.innerHTML = `
      <div class="pane-head" style="width:100%"><div class="tabs"><button>File</button><button class="active">Timeline</button><button>Cues</button><button>Patterns</button><button>Samples</button><button disabled>Mastering</button></div><button class="pane-btn" aria-label="Split">${icon("split")}</button></div>
      <div style="padding:0.6rem 1rem"><div class="subtabs"><button class="active">Envelope</button><button>Vibrato</button><button>Zones</button></div></div>`;
  },

  Toolbar(box) {
    box.style.padding = "0";
    box.style.overflow = "hidden";
    box.innerHTML = `
      <div class="topbar" style="width:100%"><span class="brand-container"><span class="brand brand-red">Micro</span><span class="brand brand-white">tone</span><span class="brand brand-tm"></span></span>
        <span class="transport-controls"><button class="icon-btn" aria-label="Play">${icon("play")}</button><button class="icon-btn" aria-label="Stop">${icon("stop")}</button><button class="rec">${icon("record")}Rec</button></span>
        <span class="tb-sep"></span><span class="pos"><span>Oct <b>4</b></span><span>Inst <b>01</b></span></span></div>
      <div class="toolbox" style="width:100%"><button class="active">Draw</button><button>Select</button><button>Find &amp; Change…</button></div>
      <div class="cmd-palette" style="width:100%"><span class="pal-label">Effect</span><button class="active">J</button><button>O</button><button>S</button><span class="pal-hint">J Arpeggio: three offsets in degrees</span></div>
      <div class="statusbar" style="width:100%"><span class="badge on">Audio on</span><span class="pos"><span>Row <b>12</b></span><span>Step <b>1</b></span></span></div>`;
  },

  Wordmark(box) {
    box.innerHTML = `
      <div class="wc-brand"><span class="brand brand-red">Micro</span><span class="brand brand-white">tone</span><span class="brand brand-tm"></span></div>
      <span class="brand-container" style="margin:0"><span class="brand brand-red">Micro</span><span class="brand brand-white">tone</span><span class="brand brand-tm"></span></span>`;
  },
};

function renderComponents(manifest) {
  const host = $("#componentList");
  const nav = $("#navComponents");
  for (const c of manifest.components) {
    const sec = el("article", "ds-comp");
    sec.id = `c-${c.name}`;
    sec.dataset.component = c.name;
    const head = el("div", "ds-comp-head");
    head.append(el("h3", "", c.name), el("span", "ds-kind", c.kind === "js" ? "module" : "CSS"));
    if (c.module) head.append(chip(c.module.replace("microtone-worker/src/ui/", "")));
    sec.append(head, prose(c.summary));
    const demo = el("div", "ds-demo");
    DEMOS[c.name]?.(demo);
    sec.append(demo);
    if (c.api) sec.append(el("pre", "", c.api));
    if (c.example) sec.append(el("pre", "", c.example));
    sec.append(chips("classes", c.classes, (x) => `.${x}`), chips("hooks", c.hooks, (x) => `.${x}`),
      chips("tokens", c.tokens, (n) => `var(--${n})`));
    if (c.rules?.length) {
      const r = el("div", "ds-chips");
      r.append(el("span", "ds-label", "rules"));
      for (const id of c.rules) {
        const a = el("a", "ds-chip", id);
        a.href = `#rule-${id}`;
        r.append(a);
      }
      sec.append(r);
    }
    host.append(sec);
    const link = el("a", "", c.name);
    link.href = `#${sec.id}`;
    nav.append(link);
  }
}

function renderIcons() {
  const host = $("#iconList");
  const grid = (title, names, svgOf, note) => {
    host.append(el("h3", "", title), el("p", "dim", note));
    const g = el("div", "ds-icons");
    for (const name of names) {
      const b = el("button", "ds-icon");
      b.type = "button";
      b.title = `Copy "${name}"`;
      b.innerHTML = svgOf(name); // the app's own markup
      b.append(el("span", "", name));
      b.addEventListener("click", () => copy(name));
      g.append(b);
    }
    host.append(g);
  };
  grid("Button icons — BTN_ICON", Object.keys(BTN_ICON), (n) => icon(n),
    "24×24, currentColor: solid for transport, 2px round-capped strokes otherwise. icon(name) for markup, setIconLabel(el, name, text) for a button, { icon: name } in an action-row spec.");
  grid("Menu icons — ICON", Object.keys(ICON), (n) => ICON[n],
    "Drawn for the 30px context-menu cells: 1.6px strokes, filled bars for what exists, dashed outlines for the slot an action makes.");
}

// ── boot ────────────────────────────────────────────────────────────────────

async function main() {
  const [tokens, manifest, readme] = await Promise.all([
    fetch("../tokens.json").then((r) => r.json()),
    fetch("../components.json").then((r) => r.json()),
    fetch("../README.md").then((r) => r.text()),
  ]);
  // As the app does: every number field and dropdown, the dialogs' included,
  // becomes a value control as it is built.
  startControlEnhancer(document.body);
  renderRules(manifest);
  renderColour(tokens);
  renderContrast(tokens);
  renderType(tokens);
  renderShape(tokens);
  renderComponents(manifest);
  renderIcons();
  // The README's first heading is the page's own title.
  $("#guideText").innerHTML = renderMarkdown(readme.replace(/^# .*\n/, ""));
  $("#stamp").textContent = `${tokens.color.tokens.length} colour tokens in ${tokens.color.themes.length} themes · ` +
    `${tokens.type.fonts.length} font files · ${manifest.components.length} components · ${manifest.rules.length} rules`;

  for (const b of document.querySelectorAll("[data-theme-pick]")) {
    b.addEventListener("click", () => setTheme(b.dataset.themePick));
  }
  setTheme(THEMES.includes(theme()) ? theme() : "dim");

  // The contents follow the reading position.
  const links = new Map([...document.querySelectorAll(".ds-nav > a")].map((a) => [a.hash.slice(1), a]));
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      for (const a of links.values()) a.classList.toggle("here", a === links.get(e.target.id));
    }
  }, { rootMargin: "-20% 0px -70% 0px" });
  for (const id of links.keys()) { const s = document.getElementById(id); if (s) seen.observe(s); }
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  document.documentElement.dataset.ready = "1";
}

main().catch((err) => {
  $("#main").prepend(el("pre", "", `The docs could not load: ${err.message}\nServe the repo root (design-system/README.md, "Viewing the docs").`));
});
