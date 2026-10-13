// The Motif editor's side panel: a tool window that folds away to a strip of
// tabs on the right edge. Structure (an outline of the program) is always
// there; Call hierarchy and Preview join it when they are asked for, and can be
// closed again. Which tool was open, and whether the panel was, is remembered
// in this browser.
//
// The panel draws what it is given and reports clicks; the view decides what
// they mean (motif.js).

import { t } from "../i18n.js";
import { icon } from "../icons.js";

const STATE_KEY = "microtone-motif-panel";

function loadState() {
  try { return JSON.parse(localStorage.getItem(STATE_KEY) ?? "null") ?? {}; } catch { return {}; }
}
function saveState(s) {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Structure groups, in the order a program is usually written. */
const GROUPS = [
  ["song", ["song", "master"]],
  ["sections", ["section"]],
  ["instruments", ["instrument"]],
  ["lanes", ["lane"]],
  ["functions", ["function"]],
  ["variables", ["variable"]],
];

export class MotifPanel {
  /**
   * @param host  the row the editor sits in; the panel and its strip are added
   *              to its right
   * @param cb    {goTo(offset, length), play(), stop(), direction(dir)}
   */
  constructor(host, cb) {
    this.cb = cb;
    const st = loadState();
    // open unless it was folded — or, the first time, on a screen too narrow
    // to have it beside the program (it would lie over the text)
    this.open = st.open ?? !window.matchMedia?.("(max-width: 760px)").matches;
    this.active = st.active === "calls" || st.active === "preview" ? "structure" : (st.active ?? "structure");
    this.tools = new Set(["structure"]);
    this.side = el("aside", "motif-side");
    this.head = el("div", "motif-side-head");
    this.title = el("span", "motif-side-title");
    this.closeTool = el("button", "icon-btn motif-side-close");
    this.closeTool.innerHTML = icon("close"); // our own markup
    this.closeTool.addEventListener("click", () => this.dropTool(this.active));
    this.hideBtn = el("button", "icon-btn motif-side-hide");
    this.hideBtn.innerHTML = icon("arrowRight");
    this.hideBtn.addEventListener("click", () => this.setOpen(false));
    this.head.append(this.title, this.closeTool, this.hideBtn);
    this.body = el("div", "motif-side-body");
    this.side.append(this.head, this.body);
    this.dock = el("nav", "motif-dock");
    host.append(this.side, this.dock);
    this.views = {
      structure: el("div", "motif-tool motif-structure"),
      calls: el("div", "motif-tool motif-calls"),
      preview: el("div", "motif-tool motif-preview"),
    };
    this.body.append(...Object.values(this.views));
    this.structure = [];
    this.structureNote = null;
    this.callsModel = null;
    this.previewModel = null;
    this.render();
  }

  saveState() { saveState({ open: this.open, active: this.active }); }

  setOpen(open) {
    this.open = open;
    this.saveState();
    this.render();
  }

  /** Show a tool (adding its tab when it is new) and open the panel on it. */
  showTool(id) {
    this.tools.add(id);
    this.active = id;
    this.open = true;
    this.saveState();
    this.render();
  }

  dropTool(id) {
    if (id === "structure") return;
    this.tools.delete(id);
    if (id === "preview") this.cb.stop();
    if (this.active === id) this.active = "structure";
    this.saveState();
    this.render();
  }

  applyLabels() { this.render(); }

  render() {
    // the strip: one tab a tool; the open one, pressed again, folds the panel
    this.dock.replaceChildren(...[...this.tools].map((id) => {
      const b = el("button", "motif-dock-tab", t(`motif.panel.${id}`));
      b.classList.toggle("on", this.open && this.active === id);
      b.title = this.open && this.active === id ? t("motif.panel.hide") : t(`motif.panel.${id}`);
      b.addEventListener("click", () => {
        if (this.open && this.active === id) this.setOpen(false);
        else this.showTool(id);
      });
      return b;
    }));
    this.side.hidden = !this.open;
    this.title.textContent = t(`motif.panel.${this.active}`);
    this.closeTool.hidden = this.active === "structure";
    this.closeTool.title = t("motif.panel.close");
    this.hideBtn.title = t("motif.panel.hide");
    for (const [id, v] of Object.entries(this.views)) v.hidden = id !== this.active;
    if (this.active === "structure") this.drawStructure();
    else if (this.active === "calls") this.drawCalls();
    else this.drawPreview();
  }

  // ── Structure ──

  /** `items`: analysis.structure; `note`: why it may be out of date, or null. */
  setStructure(items, note = null) {
    this.structure = items;
    this.structureNote = note;
    if (this.open && this.active === "structure") this.drawStructure();
  }

  drawStructure() {
    const v = this.views.structure;
    const frag = document.createDocumentFragment();
    if (this.structureNote) frag.append(el("p", "motif-side-note", this.structureNote));
    if (!this.structure.length) frag.append(el("p", "motif-side-note", t("motif.st.empty")));
    for (const [group, kinds] of GROUPS) {
      const items = this.structure.filter((i) => kinds.includes(i.kind));
      if (!items.length) continue;
      const sec = el("section", "motif-st-group");
      sec.append(el("h4", null, t(`motif.st.${group}`)));
      sec.append(this.itemList(items));
      frag.append(sec);
    }
    v.replaceChildren(frag);
  }

  itemList(items) {
    const ul = el("ul", "motif-tree");
    for (const it of items) {
      const li = el("li");
      const row = el("button", `motif-tree-row motif-k-${it.kind}`);
      row.append(el("span", "motif-tree-name", it.name));
      if (it.detail) row.append(el("span", "motif-tree-detail", it.detail));
      row.addEventListener("click", () => this.cb.goTo(it.start, it.kind === "song" || it.kind === "master" || it.kind === "section" ? 0 : it.name.length));
      li.append(row);
      if (it.children) li.append(this.itemList(it.children));
      ul.append(li);
    }
    return ul;
  }

  // ── Call hierarchy ──

  /**
   * `model`: {name, direction: "callers" | "callees", roots: [node], note}
   * where a node is {label, count, sites: [offset], expand: () => [node] | null,
   * recursive}.
   */
  setCalls(model) {
    this.callsModel = model;
    if (this.open && this.active === "calls") this.drawCalls();
  }

  drawCalls() {
    const v = this.views.calls;
    const m = this.callsModel;
    if (!m) { v.replaceChildren(); return; }
    const frag = document.createDocumentFragment();
    const bar = el("div", "motif-calls-bar");
    for (const dir of ["callers", "callees"]) {
      const b = el("button", null, t(`motif.calls.${dir}`));
      b.classList.toggle("on", m.direction === dir);
      b.addEventListener("click", () => this.cb.direction(dir));
      bar.append(b);
    }
    frag.append(bar);
    frag.append(el("p", "motif-side-sub", t(m.direction === "callers" ? "motif.calls.callersOf" : "motif.calls.calleesOf", { name: m.name })));
    if (m.note) frag.append(el("p", "motif-side-note", m.note));
    if (!m.roots.length) frag.append(el("p", "motif-side-note", t(m.direction === "callers" ? "motif.calls.noCallers" : "motif.calls.noCallees", { name: m.name })));
    frag.append(this.callList(m.roots));
    v.replaceChildren(frag);
  }

  callList(nodes) {
    const ul = el("ul", "motif-tree");
    for (const n of nodes) {
      const li = el("li");
      const line = el("div", "motif-tree-line");
      const tw = el("button", "motif-twisty");
      const kids = !n.recursive && n.expand ? n.expand : null;
      if (kids) tw.innerHTML = icon("caretDown"); // turned to point right while shut (CSS)
      tw.disabled = !kids;
      const row = el("button", "motif-tree-row");
      row.append(el("span", "motif-tree-name", n.label));
      if (n.recursive) row.append(el("span", "motif-tree-detail", t("motif.calls.recursive")));
      if (n.count) row.append(el("span", "motif-tree-count", t("motif.calls.count", { n: n.count })));
      row.title = t("motif.calls.siteTitle");
      let next = 0;
      row.addEventListener("click", () => {
        if (!n.sites.length) return;
        this.cb.goTo(n.sites[next % n.sites.length], 0);
        next++;
      });
      let open = null;
      tw.addEventListener("click", () => {
        if (open) { open.remove(); open = null; tw.classList.remove("open"); return; }
        open = this.callList(kids());
        li.append(open);
        tw.classList.add("open");
      });
      line.append(tw, row);
      li.append(line);
      ul.append(li);
    }
    return ul;
  }

  // ── Preview ──

  /**
   * `model`: {title, summary, note, canPlay, playing, rows: [[cells…]], more}.
   */
  setPreview(model) {
    this.previewModel = model;
    if (this.open && this.active === "preview") this.drawPreview();
  }

  drawPreview() {
    const v = this.views.preview;
    const m = this.previewModel;
    if (!m) { v.replaceChildren(); return; }
    const frag = document.createDocumentFragment();
    frag.append(el("p", "motif-side-sub", m.title));
    const bar = el("div", "motif-calls-bar");
    const play = el("button", null, m.playing ? t("motif.preview.stop") : t("motif.preview.play"));
    play.disabled = !m.canPlay;
    play.addEventListener("click", () => (m.playing ? this.cb.stop() : this.cb.play()));
    bar.append(play);
    frag.append(bar);
    if (m.note) frag.append(el("p", "motif-side-note", m.note));
    if (m.summary) frag.append(el("p", "motif-side-sub", m.summary));
    if (m.rows.length) {
      const table = el("table", "motif-preview-table");
      const head = el("tr");
      for (const k of ["row", "lane", "note", "vol", "fx"]) head.append(el("th", null, t(`motif.preview.${k}`)));
      table.append(head);
      for (const r of m.rows) {
        const tr = el("tr");
        for (const c of r) tr.append(el("td", null, c));
        table.append(tr);
      }
      frag.append(table);
      if (m.more) frag.append(el("p", "motif-side-note", t("motif.preview.more", { n: m.more })));
    }
    v.replaceChildren(frag);
  }
}
