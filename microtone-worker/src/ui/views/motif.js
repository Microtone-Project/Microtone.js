// Motif view — write a song as a Taud Motif Language program and build it
// (TAUD_MOTIF_LANGUAGE.md). The editor shows the source of the project that is
// open, when that project was built by Motif (its PMtf section); otherwise a
// draft of your own, kept in this browser between visits. Build runs the
// program in the Motif worker and opens what it makes as the project.
//
// DOM-only and change-driven: nothing here runs per frame.

import { startMotifBuild, MotifCancelled } from "../motifbuild.js";
import { MOTIF_EXAMPLE } from "../motifexample.js";
import { MOTIF_FOURCC, BUNDLED_SOUNDFONT } from "../../motif/build.js";
import { getBundledSoundfont, pickUserSoundfont, lastUserSoundfont } from "../soundfont.js";
import { pickFile, download } from "../../storage/import-export.js";
import { showModal } from "../widgets/modal.js";
import { applyIcons } from "../icons.js";
import { t } from "../i18n.js";

const DRAFT_KEY = "microtone-motif-draft";
const td = new TextDecoder();

function loadDraft() {
  try { return localStorage.getItem(DRAFT_KEY); } catch { return null; }
}
function saveDraft(text) {
  try { localStorage.setItem(DRAFT_KEY, text); } catch { /* private mode: the draft lives as long as the page */ }
}

/** The PMtf source a document carries, or null. */
export function motifSourceOf(doc) {
  const s = doc?.projSections?.find((x) => x.fourcc === MOTIF_FOURCC);
  return s ? td.decode(s.payload) : null;
}

export class MotifView {
  /**
   * @param cb.loadBuilt  async (name, bytes) → load a build as the project;
   *                      resolves false when the person kept the one they had
   */
  constructor(store, host, cb = {}) {
    this.store = store;
    this.host = host;
    this.cb = cb;
    this.visible = false;
    this.job = null;            // the build in progress: {cancel}
    this.origin = "draft";      // "doc" (the open project's source) | "file" | "draft"
    this.fileName = null;       // the .tml this text came from, when it did
    this.builtText = null;      // the text the open project was built from
    this.lineCount = 0;
    this.errorLine = 0;
    this.docSeen = undefined;   // the document the text was last chosen for
    this.build();
    store.on("doc", () => this.adoptDocument());
    this.adoptDocument();
  }

  build() {
    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    this.root = el("div", "motif-view");
    const bar = el("div", "motif-bar");
    this.buildBtn = el("button", "motif-build");
    this.buildBtn.addEventListener("click", () => (this.job ? this.cancel() : this.runBuild()));
    this.openBtn = el("button");
    this.openBtn.addEventListener("click", () => this.openFile());
    this.saveBtn = el("button");
    this.saveBtn.addEventListener("click", () => this.saveFile());
    this.exampleBtn = el("button");
    this.exampleBtn.addEventListener("click", () => this.useExample());
    this.refLink = el("a", "motif-ref");
    this.refLink.href = "docs.html#motif";
    this.refLink.target = "_blank";
    this.refLink.rel = "noopener";
    this.refLink.dataset.icon = "external";
    this.refLink.dataset.iconAfter = "";
    this.refLabel = el("span");
    this.refLink.append(this.refLabel);
    this.state = el("span", "motif-state dim");
    bar.append(this.buildBtn, this.openBtn, this.saveBtn, this.exampleBtn, this.refLink, this.state);

    const editor = el("div", "motif-editor");
    this.gutter = el("pre", "motif-gutter");
    this.gutter.setAttribute("aria-hidden", "true");
    this.text = el("textarea", "motif-text");
    this.text.spellcheck = false;
    this.text.wrap = "off";
    this.text.setAttribute("autocapitalize", "off");
    this.text.setAttribute("autocomplete", "off");
    this.text.addEventListener("input", () => this.onInput());
    this.text.addEventListener("scroll", () => { this.gutter.scrollTop = this.text.scrollTop; });
    this.text.addEventListener("keydown", (e) => this.onKey(e));
    editor.append(this.gutter, this.text);

    const out = el("div", "motif-out");
    this.progressRow = el("div", "motif-progress");
    this.progressRow.hidden = true;
    this.progress = el("progress", "progress-bar");
    this.progress.max = 1;
    this.stage = el("span", "dim");
    this.progressRow.append(this.progress, this.stage);
    this.msgs = el("ol", "motif-msgs");
    out.append(this.progressRow, this.msgs);

    this.root.append(bar, editor, out);
    this.host.appendChild(this.root);
    applyIcons(this.root);
    this.applyLabels();
  }

  /** Every string this view shows, in the current language. */
  applyLabels() {
    this.buildBtn.textContent = this.job ? t("motif.cancel") : t("motif.build");
    this.buildBtn.title = this.job ? t("motif.cancelTitle") : t("motif.buildTitle");
    this.openBtn.textContent = t("motif.open");
    this.openBtn.title = t("motif.openTitle");
    this.saveBtn.textContent = t("motif.save");
    this.saveBtn.title = t("motif.saveTitle");
    this.exampleBtn.textContent = t("motif.example");
    this.exampleBtn.title = t("motif.exampleTitle");
    this.refLabel.textContent = t("motif.reference");
    this.text.setAttribute("aria-label", t("motif.editorLabel"));
    this.showState();
  }

  show() { this.visible = true; this.applyLabels(); }
  hide() { this.visible = false; }

  // ── where the text comes from ──

  /** A document was loaded (or replaced): show its source when it has one.
   *  ("doc" is also announced for edits that redraw everything; those keep
   *  whatever is in the editor.) Text that would be replaced unbuilt becomes
   *  the draft, so nothing typed here is ever thrown away. */
  adoptDocument() {
    if (this.store.doc === this.docSeen) return;
    this.docSeen = this.store.doc;
    if (this.job) return; // a build in progress will put its own source here
    const src = motifSourceOf(this.store.doc);
    const unbuilt = this.origin === "draft" || (this.builtText !== null && this.text.value !== this.builtText) || this.origin === "file";
    if (src !== null) {
      if (unbuilt && this.text.value && this.text.value !== src) saveDraft(this.text.value);
      this.setText(src, "doc");
      this.builtText = src;
      this.fileName = null;
    } else if (this.origin === "doc") {
      // the project that owned the text is gone: back to the draft
      if (unbuilt) saveDraft(this.text.value);
      this.setText(loadDraft() ?? MOTIF_EXAMPLE, "draft");
      this.builtText = null;
    } else if (!this.text.value) {
      this.setText(loadDraft() ?? MOTIF_EXAMPLE, "draft");
    }
    this.showState();
  }

  setText(text, origin) {
    if (this.text.value !== text) this.text.value = text; // the same text keeps the caret where it is
    this.origin = origin;
    if (origin !== "file") this.fileName = null;
    // "edited since it was built" is about the open project's own program
    if (origin !== "doc") this.builtText = null;
    this.errorLine = 0;
    this.updateGutter(true);
  }

  /** Open a .tml's text (the File menu, a drop, ?load=) and build it. */
  async openSource(name, text, { build = true } = {}) {
    if (this.origin === "draft") saveDraft(this.text.value);
    this.setText(text, "file");
    this.fileName = name;
    this.builtText = null;
    this.clearMessages();
    this.showState();
    if (build) await this.runBuild();
  }

  async openFile() {
    const file = await pickFile(".tml,text/plain");
    if (!file) return;
    await this.openSource(file.name, await file.text(), { build: false });
  }

  saveFile() {
    const name = this.fileName ?? (this.store.fileName ?? "motif.taud").replace(/\.[^.]+$/, "") + ".tml";
    download(new TextEncoder().encode(this.text.value), name);
  }

  async useExample() {
    if (this.text.value === MOTIF_EXAMPLE) return;
    const ok = await showModal({ title: t("motif.example"), body: t("motif.exampleAsk"), okLabel: t("motif.exampleOk") });
    if (!ok) return;
    this.setText(MOTIF_EXAMPLE, "draft");
    saveDraft(MOTIF_EXAMPLE);
    this.fileName = null;
    this.clearMessages();
    this.showState();
  }

  // ── editing ──

  onInput() {
    if (this.origin === "draft") saveDraft(this.text.value);
    if (this.errorLine) { this.errorLine = 0; this.updateGutter(true); }
    else this.updateGutter(false);
    this.showState();
  }

  onKey(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      if (!this.job) this.runBuild();
      return;
    }
    // Tab indents (two spaces) instead of leaving the editor; Esc then Tab
    // still moves on, as the editor gives the key back after Esc.
    if (e.key === "Escape") { this.tabFree = true; return; }
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey && !this.tabFree) {
      e.preventDefault();
      const ta = this.text;
      const { selectionStart: a, selectionEnd: b, value } = ta;
      if (!e.shiftKey && a === b) {
        ta.setRangeText("  ", a, b, "end");
      } else {
        // indent or outdent every line the selection touches
        const ls = value.lastIndexOf("\n", a - 1) + 1;
        const le = value.indexOf("\n", Math.max(a, b - 1));
        const end = le < 0 ? value.length : le;
        const lines = value.slice(ls, end).split("\n");
        const moved = lines.map((l) => (e.shiftKey ? l.replace(/^ {1,2}/, "") : "  " + l)).join("\n");
        ta.setRangeText(moved, ls, end, "select");
      }
      this.onInput();
      return;
    }
    this.tabFree = false;
  }

  updateGutter(force) {
    const n = this.text.value.split("\n").length;
    if (!force && n === this.lineCount) return;
    this.lineCount = n;
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= n; i++) {
      const s = document.createElement("span");
      s.textContent = String(i);
      if (i === this.errorLine) s.className = "motif-err-line";
      frag.append(s, "\n");
    }
    this.gutter.replaceChildren(frag);
    this.gutter.scrollTop = this.text.scrollTop;
  }

  showState() {
    let s;
    if (this.origin === "doc") s = t("motif.originDoc", { name: this.store.fileName ?? t("common.currentProject") });
    else if (this.origin === "file") s = this.fileName ?? "";
    else if (!this.store.doc) s = t("motif.originDraft");
    else s = t(motifSourceOf(this.store.doc) !== null ? "motif.originDraftOther" : "motif.originDraftDoc");
    if (this.builtText !== null && this.text.value !== this.builtText) s += ` · ${t("motif.edited")}`;
    if (this.state.textContent !== s) this.state.textContent = s;
  }

  // ── messages ──

  clearMessages() { this.msgs.replaceChildren(); }

  message(text, cls = "", pos = null) {
    const li = document.createElement("li");
    if (cls) li.className = cls;
    if (pos) {
      const a = document.createElement("button");
      a.className = "motif-pos";
      a.textContent = `${pos.line}:${pos.col}`;
      a.title = t("motif.gotoTitle");
      a.addEventListener("click", () => this.goTo(pos));
      li.append(a, " ");
    }
    li.append(text);
    this.msgs.append(li);
    li.scrollIntoView?.({ block: "nearest" });
    return li;
  }

  /** Put the caret on a line and column, and that line in view. */
  goTo(pos) {
    const v = this.text.value;
    let off = 0;
    for (let l = 1; l < pos.line && off >= 0; l++) off = v.indexOf("\n", off) + 1;
    off = Math.min(v.length, off + Math.max(0, pos.col - 1));
    this.text.focus();
    this.text.setSelectionRange(off, off);
    const lineHeight = parseFloat(getComputedStyle(this.text).lineHeight) || 16;
    const target = (pos.line - 1) * lineHeight;
    if (target < this.text.scrollTop || target > this.text.scrollTop + this.text.clientHeight - 2 * lineHeight) {
      this.text.scrollTop = Math.max(0, target - this.text.clientHeight / 3);
    }
  }

  // ── building ──

  /** The soundfont a song asks for: the bundled one, or a file the person picks. */
  async resolveSoundfont(name) {
    if (name === null || name === BUNDLED_SOUNDFONT) {
      const b = await getBundledSoundfont();
      if (b) return b;
      const ok = await showModal({ title: t("motif.sfTitle"), body: t("motif.sfNoBundled"), okLabel: t("motif.sfPick") });
      return ok ? pickUserSoundfont() : null;
    }
    const last = lastUserSoundfont();
    if (last && last.name.toLowerCase() === name.toLowerCase()) return last;
    const ok = await showModal({ title: t("motif.sfTitle"), body: t("motif.sfAsk", { name }), okLabel: t("motif.sfPick") });
    return ok ? pickUserSoundfont() : null;
  }

  async runBuild() {
    if (this.job) return;
    const source = this.text.value;
    this.clearMessages();
    this.errorLine = 0;
    this.updateGutter(true);
    this.progressRow.hidden = false;
    this.progress.value = 0;
    this.stage.textContent = t("motif.stage.evaluate");
    const t0 = performance.now();
    let lastStage = null;
    this.job = startMotifBuild(source, {
      resolveSoundfont: (name) => this.resolveSoundfont(name),
      onLog: (line) => this.message(line, "dim"),
      onProgress: (stage, frac) => {
        if (stage !== lastStage) {
          lastStage = stage;
          const label = t(`motif.stage.${stage}`);
          if (this.stage.textContent !== label) this.stage.textContent = label;
        }
        // the stages in the order they run, the re-tuning the long one
        const span = { evaluate: [0, 0.05], compile: [0.05, 0.1], bank: [0.1, 0.45], instruments: [0.45, 0.5],
          cleanup: [0.5, 0.55], retune: [0.55, 0.98], done: [1, 1] }[stage] ?? [0, 0];
        this.progress.value = span[0] + (span[1] - span[0]) * frac;
      },
    });
    this.applyLabels();
    try {
      const { bytes, report } = await this.job.promise;
      this.job = null;
      this.applyLabels();
      this.progressRow.hidden = true;
      const name = this.buildName(source);
      const loaded = await this.cb.loadBuilt(name, bytes);
      if (loaded === false) {
        this.message(t("motif.builtKept"), "motif-ok");
        return;
      }
      this.builtText = source;
      this.origin = "doc";
      this.fileName = null;
      this.docSeen = this.store.doc;
      this.message(t("motif.built", {
        s: ((performance.now() - t0) / 1000).toFixed(1), lanes: report.lanes, patterns: report.patterns,
      }), "motif-ok");
      this.showState();
    } catch (err) {
      this.job = null;
      this.applyLabels();
      this.progressRow.hidden = true;
      if (err instanceof MotifCancelled) {
        this.message(t("motif.cancelled"), "dim");
        return;
      }
      this.message(err.message, "motif-err", err.pos ?? null);
      for (const f of err.trace ?? []) {
        this.message(t("motif.traceLine", { name: f.name }), "motif-trace", f.line ? { line: f.line, col: f.col } : null);
      }
      if (err.pos) {
        this.errorLine = err.pos.line;
        this.updateGutter(true);
        this.goTo(err.pos);
      }
    }
  }

  cancel() { this.job?.cancel(); }

  /** The project name a build gets: the one it replaces, when it is a rebuild
   *  of the open Motif project; else the .tml's; else the song's title. */
  buildName(source) {
    if (this.origin === "doc" && this.store.fileName) return this.store.fileName;
    if (this.fileName) return this.fileName.replace(/\.[^.]+$/, "") + ".taud";
    const m = /title\s*:\s*"([^"\n]{1,60})"/.exec(source);
    const base = (m ? m[1] : "motif").replace(/[\\/:*?"<>|]+/g, "").trim() || "motif";
    return `${base}.taud`;
  }
}
