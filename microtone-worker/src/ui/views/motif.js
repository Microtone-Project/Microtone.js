// Motif view — write a song as a Taud Motif Language program and build it
// (TAUD_MOTIF_LANGUAGE.md). The editor shows the source of the project that is
// open, when that project was built by Motif (its PMtf section); otherwise a
// draft of your own, kept in this browser between visits. Build runs the
// program in the Motif worker and opens what it makes as the project.
//
// The editor is a textarea whose text is transparent, over a <pre> holding the
// same text highlighted (motif/highlight.js) in the Syntello / Dimtello
// colours the theme gives the --code-* tokens. Both use one monospace face with
// no synthesised bold or italic, so their glyphs line up exactly; the <pre>
// follows the textarea's scroll by a transform. The names in it are coloured by
// what the latest analysis says they are (a parameter, a lane, a local), so
// it is painted again when an analysis comes in. Under the text, the marks
// (motifmarks.js): the selection, and the other uses of the name at the caret.
//
// The program is analysed as it is typed (motif/analysis.js) — what each name
// refers to, every call — for the occurrence marks, the side panel's Structure
// and Call hierarchy (motifpanel.js), Rename, and Preview, which plays what one
// call writes through the open project's instruments (motifpreview.js).
//
// DOM-only and change-driven: nothing here runs per frame.

import { startMotifBuild, MotifCancelled, captureInWorker } from "../motifbuild.js";
import { analyze, planRename } from "../../motif/analysis.js";
import { opName } from "../../motif/music.js";
import { CodeMarks } from "./motifmarks.js";
import { MotifPanel } from "./motifpanel.js";
import { playCapture } from "../motifpreview.js";
import { showContextMenu } from "../components/contextmenu.js";
import { ICON } from "../icons.js";
import { MOTIF_EXAMPLE } from "../motifexample.js";
import { MOTIF_FOURCC, BUNDLED_SOUNDFONT } from "../../motif/build.js";
import { highlightTML } from "../../motif/highlight.js";
import { getBundledSoundfont, pickUserSoundfont, lastUserSoundfont } from "../soundfont.js";
import { pickFile, download } from "../../storage/import-export.js";
import { showModal } from "../components/modal.js";
import { applyIcons } from "../icons.js";
import { t } from "../i18n.js";

const DRAFT_KEY = "microtone-motif-draft";
/** Instrument packs picked this session, by the name a program asks for. */
const packs = new Map();
const td = new TextDecoder();

function loadDraft() {
  try { return localStorage.getItem(DRAFT_KEY); } catch { return null; }
}
function saveDraft(text) {
  try { localStorage.setItem(DRAFT_KEY, text); } catch { /* private mode: the draft lives as long as the page */ }
}

/** The instruments a program declares, as a string to compare two programs
 *  by (name and source of each, in order), or null when it does not parse. */
function instrumentSignature(source) {
  const a = analyze(source);
  return a.ok ? a.structure.filter((i) => i.kind === "instrument").map((i) => `${i.name}:${i.detail}`).join(",") : null;
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
    this.painted = null;        // the text the overlay was last highlighted from
    this.paintedWith = null;    // …the analysis it coloured the names by
    this.paintedHtml = "";      // …and what that made
    this.caretLine = 0;         // the line the caret row is drawn on
    this.analysis = null;       // the last analysis of a program that parsed
    this.analysedText = null;   // …and the text it was of
    this.analyseTimer = 0;
    this.callsRoot = null;      // the call hierarchy's subject: {name, kind, start}
    this.callsDirection = "callers";
    this.preview = null;        // {call, cap, player}
    this.slotMaps = new WeakMap(); // a project built here → {slots, sig}
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

    const main = el("div", "motif-main");
    const editor = el("div", "motif-editor");
    this.gutter = el("pre", "motif-gutter");
    this.gutter.setAttribute("aria-hidden", "true");
    const code = el("div", "motif-code");
    this.caretRow = el("div", "motif-caret-row");
    this.marksLayer = el("div", "motif-marks");
    this.hl = el("pre", "motif-hl");
    this.hl.setAttribute("aria-hidden", "true");
    this.text = el("textarea", "motif-text");
    this.text.spellcheck = false;
    this.text.wrap = "off";
    this.text.setAttribute("autocapitalize", "off");
    this.text.setAttribute("autocomplete", "off");
    this.text.addEventListener("input", () => this.onInput());
    this.text.addEventListener("scroll", () => this.onScroll());
    this.text.addEventListener("keydown", (e) => this.onKey(e));
    for (const ev of ["keyup", "pointerup", "focus", "selectionchange"]) {
      this.text.addEventListener(ev, () => this.updateCaretLine());
    }
    this.text.addEventListener("blur", () => { this.caretRow.hidden = true; });
    this.caretRow.hidden = true;
    // the selection is drawn under the text, so it follows every way of making one
    const onSel = () => { if (document.activeElement === this.text) this.updateSelection(); };
    document.addEventListener("selectionchange", onSel);
    for (const ev of ["selectionchange", "select", "keyup", "pointerup", "input"]) this.text.addEventListener(ev, onSel);
    this.text.addEventListener("keydown", () => setTimeout(onSel)); // Shift+arrow held down
    this.text.addEventListener("pointermove", (e) => { if (e.buttons) onSel(); });
    this.text.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    code.append(this.caretRow, this.marksLayer, this.hl, this.text);
    editor.append(this.gutter, code);
    this.marks = new CodeMarks(this.hl, this.marksLayer, ["read", "write", "sel"]);
    main.append(editor);
    this.panel = new MotifPanel(main, {
      goTo: (offset, length) => this.goToOffset(offset, length),
      play: () => this.playPreview(),
      stop: () => this.stopPreview(),
      direction: (dir) => { this.callsDirection = dir; this.refreshCalls(); },
    });

    const out = el("div", "motif-out");
    this.progressRow = el("div", "motif-progress");
    this.progressRow.hidden = true;
    this.progress = el("progress", "progress-bar");
    this.progress.max = 1;
    this.stage = el("span", "dim");
    this.progressRow.append(this.progress, this.stage);
    this.msgs = el("ol", "motif-msgs");
    out.append(this.progressRow, this.msgs);

    this.root.append(bar, main, out);
    this.host.appendChild(this.root);
    applyIcons(this.root);
    this.applyLabels();
    document.fonts?.ready.then(() => this.redrawMarks()); // the face changes the geometry
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
    this.panel?.applyLabels();
    this.showState();
  }

  show() {
    this.visible = true;
    this.applyLabels();
    // marks drawn while the view was hidden have no geometry: draw them again
    requestAnimationFrame(() => this.redrawMarks());
  }

  redrawMarks() {
    this.selDrawn = null;
    this.updateSelection();
  }
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
    this.paint();
    this.analyseNow();
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
    this.paint();
    this.scheduleAnalysis();
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
    // the editor's own commands, at the keys they have in most code editors
    if (e.key === "F6" && e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.rename(this.text.selectionStart);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      this.goToDeclaration(this.text.selectionStart);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === "h" || e.key === "H")) {
      e.preventDefault();
      this.callHierarchy(this.text.selectionStart);
      return;
    }
    if (e.key === "Escape" && this.preview?.player?.playing) this.stopPreview();
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

  /** Highlight the text into the overlay (a few milliseconds even for a long
   *  program, so it keeps up with typing without being deferred). */
  paint() {
    const v = this.text.value;
    if (v === this.painted && this.analysis === this.paintedWith) return;
    // until the text is analysed again, the names keep what the last analysis made of them
    this.paintedWith = this.analysis;
    // the trailing line break keeps an empty last line as tall as the textarea's
    const html = highlightTML(v, this.analysis) + "\n";
    if (v === this.painted) {
      // the same text, its names seen afresh: nothing moves, so the marks stay
      if (html !== this.paintedHtml) {
        this.hl.innerHTML = this.paintedHtml = html;
        this.marks.index();
      }
      return;
    }
    this.painted = v;
    this.hl.innerHTML = this.paintedHtml = html;
    this.marks.index();
    this.onScroll();
    this.updateCaretLine();
    this.updateSelection();
    this.marks.clear("read"); // the uses are drawn again once the new text is analysed
    this.marks.clear("write");
  }

  onScroll() {
    const { scrollLeft: x, scrollTop: y } = this.text;
    this.gutter.scrollTop = y;
    const tf = `translate(${-x}px, ${-y}px)`;
    if (this.hl.style.transform !== tf) {
      this.hl.style.transform = tf;
      this.marksLayer.style.transform = tf;
    }
    this.placeCaretRow();
  }

  /** The selection, under the text; and the uses of the name at the caret. */
  updateSelection() {
    const { selectionStart: a, selectionEnd: b } = this.text;
    if (a === this.selDrawn?.[0] && b === this.selDrawn?.[1] && this.painted === this.selDrawn[2]) return;
    this.selDrawn = [a, b, this.painted];
    this.marks.set("sel", a === b ? [] : [{ start: a, end: b }]);
    this.updateOccurrences();
  }

  // ── what the program's names mean ──

  scheduleAnalysis() {
    clearTimeout(this.analyseTimer);
    this.analyseTimer = setTimeout(() => this.analyseNow(), 150);
  }

  analyseNow() {
    clearTimeout(this.analyseTimer);
    const text = this.text.value;
    const a = analyze(text);
    if (a.ok) {
      this.analysis = a;
      this.analysedText = text;
      this.paint();
      this.panel.setStructure(a.structure);
      if (this.callsRoot) this.refreshCalls();
    } else {
      this.analysedText = null;
      this.panel.setStructure(this.analysis?.structure ?? [], t("motif.st.stale", { line: a.error?.pos?.line ?? "?" }));
    }
    this.updateOccurrences();
  }

  /** The analysis of the text as it is now, or null while it does not parse. */
  current() {
    if (this.analysedText !== this.text.value) this.analyseNow();
    return this.analysedText === this.text.value ? this.analysis : null;
  }

  updateOccurrences() {
    const a = this.analysedText === this.text.value ? this.analysis : null;
    const { selectionStart: s, selectionEnd: e } = this.text;
    const o = a ? a.occAt(s) : null;
    // a selection that is not just that name lights nothing
    if (!o || (e !== s && (s !== o.start || e !== o.end))) {
      this.marks.clear("read");
      this.marks.clear("write");
      return;
    }
    const uses = a.occurrencesOf(o.sym);
    this.marks.set("read", uses.filter((u) => !u.write));
    this.marks.set("write", uses.filter((u) => u.write));
  }

  /** The source offset under a pointer, or null. */
  offsetAtPoint(x, y) {
    const ta = this.text.style.pointerEvents, hl = this.hl.style.pointerEvents;
    this.text.style.pointerEvents = "none";
    this.hl.style.pointerEvents = "auto";
    let node = null, off = 0;
    try {
      if (document.caretPositionFromPoint) {
        const p = document.caretPositionFromPoint(x, y);
        node = p?.offsetNode ?? null; off = p?.offset ?? 0;
      } else if (document.caretRangeFromPoint) {
        const r = document.caretRangeFromPoint(x, y);
        node = r?.startContainer ?? null; off = r?.startOffset ?? 0;
      }
    } finally {
      this.text.style.pointerEvents = ta;
      this.hl.style.pointerEvents = hl;
    }
    return node ? this.marks.offsetOf(node, off) : null;
  }

  async onContextMenu(e) {
    // the menu key and Shift+F10 open it at the caret, a pointer where it is
    let x = e.clientX, y = e.clientY, off;
    if (e.button !== 2) {
      off = this.text.selectionStart;
      const box = this.caretBox(off);
      if (box) { x = box.left; y = box.bottom; }
    } else off = this.offsetAtPoint(x, y);
    const a = off === null ? null : this.current();
    const o = a?.occAt(off) ?? null;
    const call = a?.callAt(off) ?? null;
    if (!o && !call) return; // nothing of ours here: the browser's own menu
    e.preventDefault();
    const { selectionStart: s, selectionEnd: en } = this.text;
    if (off < s || off > en) { this.text.setSelectionRange(off, off); this.updateSelection(); }
    const sym = o?.sym ?? null;
    const callable = sym && (sym.kind === "function" || sym.kind === "builtin" || (sym.kind === "variable" && sym.fnNode));
    const named = [];
    if (sym && sym.kind !== "builtin") {
      named.push({ id: "rename", label: t("motif.menu.rename"), icon: ICON.rename, title: t("motif.menu.renameTitle") });
      if (!o.decl) named.push({ id: "decl", label: t("motif.menu.decl"), icon: ICON.declaration, title: t("motif.menu.declTitle") });
    }
    if (callable) named.push({ id: "calls", label: t("motif.menu.calls"), icon: ICON.hierarchy, title: t("motif.menu.callsTitle") });
    const preview = call ? [{ id: "preview", label: t("motif.menu.preview"), icon: ICON.preview, title: t("motif.menu.previewTitle") }] : [];
    const clip = [];
    if (this.text.selectionStart !== this.text.selectionEnd) {
      clip.push({ id: "copy", label: t("ctx.copy"), icon: ICON.copy }, { id: "cut", label: t("ctx.cut"), icon: ICON.cut });
    }
    const pick = await showContextMenu(x, y, [named, preview, clip]);
    this.text.focus();
    switch (pick) {
      case "rename": this.rename(off); break;
      case "decl": this.goToDeclaration(off); break;
      case "calls": this.callHierarchy(off); break;
      case "preview": this.previewCall(call); break;
      case "copy": document.execCommand("copy"); break;
      case "cut": document.execCommand("cut"); break;
      default: break;
    }
  }

  /** Where the character at `offset` is on screen, or null. */
  caretBox(offset) {
    const node = this.marks.point(offset);
    if (!node) return null;
    const r = document.createRange();
    r.setStart(node[0], node[1]);
    r.setEnd(node[0], Math.min(node[0].data.length, node[1] + 1));
    const box = r.getClientRects()[0];
    return box ?? null;
  }

  goToDeclaration(offset) {
    const o = this.current()?.occAt(offset);
    if (!o || o.sym.kind === "builtin") return;
    this.goToOffset(o.sym.start, o.sym.name.length);
  }

  /** Rename the name at `offset` everywhere it is used (Shift+F6). */
  async rename(offset) {
    const a = this.current();
    if (!a) {
      this.message(t("motif.rename.parse"), "motif-err");
      return;
    }
    const o = a.occAt(offset);
    if (!o) return;
    if (o.sym.kind === "builtin") {
      this.message(t("motif.rename.builtin", { name: o.sym.name }), "motif-err");
      return;
    }
    const uses = a.occurrencesOf(o.sym);
    const got = await showModal({
      title: t("motif.rename.title"),
      body: t("motif.rename.body", { kind: t(`motif.kind.${o.sym.kind}`), name: o.sym.name, n: uses.length }),
      fields: [{ name: "name", label: t("motif.rename.field"), value: o.sym.name, select: true }],
      okLabel: t("motif.rename.ok"),
    });
    const to = got?.name?.trim();
    if (!to || to === o.sym.name) return;
    if (this.text.value !== a.source) return; // edited while the dialog was up
    const plan = planRename(a.source, offset, to);
    if (plan.error) {
      this.message(t(`motif.rename.${plan.error}`, { name: plan.name ?? to, line: plan.line ?? "?" }), "motif-err",
        plan.line ? { line: plan.line, col: 1 } : null);
      return;
    }
    // one edit, over the stretch between the first change and the last, so a
    // single undo takes the whole rename back
    const ta = this.text;
    const old = ta.value, neu = plan.source;
    let p = 0;
    while (p < old.length && p < neu.length && old[p] === neu[p]) p++;
    let q = 0;
    while (q < old.length - p && q < neu.length - p && old[old.length - 1 - q] === neu[neu.length - 1 - q]) q++;
    const { scrollLeft, scrollTop } = ta;
    ta.focus();
    ta.setSelectionRange(p, old.length - q);
    if (!document.execCommand("insertText", false, neu.slice(p, neu.length - q))) {
      ta.value = neu;
      this.onInput();
    }
    ta.scrollLeft = scrollLeft;
    ta.scrollTop = scrollTop;
    // the caret stays in the name it was in
    let at = o.start;
    for (const x of uses) {
      if (x.start >= o.start) break;
      at += (x.shorthand ? `${o.sym.name}: ${to}` : to).length - (x.end - x.start);
    }
    if (o.shorthand) at += o.sym.name.length + 2;
    at += Math.min(to.length, Math.max(0, offset - o.start));
    ta.setSelectionRange(at, at);
    this.analyseNow();
    this.updateSelection();
    this.message(t("motif.rename.done", { from: o.sym.name, to, n: plan.count }), "motif-ok");
  }

  // ── call hierarchy ──

  callHierarchy(offset) {
    const o = this.current()?.occAt(offset);
    if (!o) return;
    this.callsRoot = { name: o.sym.name, kind: o.sym.kind, start: o.sym.start };
    this.panel.showTool("calls");
    this.refreshCalls();
  }

  /** The hierarchy again, on the latest analysis (its subject found by name,
   *  kind and nearness, since editing moves it). */
  refreshCalls() {
    if (!this.callsRoot) return;
    const a = this.analysedText === this.text.value ? this.analysis : null;
    if (!a) return;
    const R = this.callsRoot;
    let sym = null;
    if (R.kind === "builtin") sym = a.calls.find((c) => c.callee?.kind === "builtin" && c.callee.name === R.name)?.callee ?? null;
    else {
      for (const x of a.symbols) {
        if (x.name === R.name && x.kind === R.kind && (!sym || Math.abs(x.start - R.start) < Math.abs(sym.start - R.start))) sym = x;
      }
    }
    if (!sym) {
      this.panel.setCalls({ name: R.name, direction: this.callsDirection, roots: [], note: t("motif.calls.gone", { name: R.name }) });
      return;
    }
    R.start = sym.start;
    const dir = this.callsDirection;
    const node = (group, path) => {
      const fn = group.fn;
      const label = fn ? fn.name : t("motif.calls.top");
      const recursive = !!fn && path.includes(fn);
      const grow = fn && (dir === "callers" || fn.kind !== "builtin")
        ? () => (dir === "callers" ? a.callers(fn) : a.callees(fn)).map((g) => node(g, [...path, fn]))
        : null;
      return { label, count: group.sites.length, sites: group.sites.map((c) => c.start), recursive, expand: grow };
    };
    const groups = dir === "callers" ? a.callers(sym) : a.callees(sym);
    this.panel.setCalls({ name: sym.name, direction: dir, roots: groups.map((g) => node(g, [sym])) });
  }

  // ── preview ──

  /** Hear what one call writes, and see it, without building the song. */
  async previewCall(call) {
    this.stopPreview();
    const source = this.text.value;
    const label = `${call.name ?? "…"}() — ${t("motif.preview.line", { line: call.line })}`;
    this.panel.showTool("preview");
    this.panel.setPreview({ title: label, rows: [], canPlay: false, playing: false, note: t("motif.preview.working") });
    let cap;
    try {
      cap = await captureInWorker(source, call.start);
    } catch (err) {
      this.panel.setPreview({ title: label, rows: [], canPlay: false, playing: false, note: err.message });
      return;
    }
    const slots = this.previewSlots(source, cap);
    this.preview = { call, cap, slots, label, player: null };
    this.drawPreview();
    if (slots && cap.first !== null) await this.playPreview();
  }

  /** Which slot each instrument of the program sits in, in the OPEN project —
   *  or null when the open project was not built from these instruments. */
  previewSlots(source, cap) {
    const doc = this.store.doc;
    if (!doc) return null;
    const sig = instrumentSignature(source);
    const built = this.slotMaps.get(doc);
    if (built && sig !== null && built.sig === sig) return built.slots;
    const own = motifSourceOf(doc);
    if (own !== null && sig !== null && instrumentSignature(own) === sig && cap.instruments.every((i) => i.kind === "sf2")) {
      return Object.fromEntries(cap.instruments.map((i) => [i.id, i.slot]));
    }
    return null;
  }

  drawPreview() {
    const p = this.preview;
    if (!p) return;
    const { cap } = p;
    const rows = [];
    const MAX = 400;
    let total = 0;
    const br = cap.song.barRows;
    for (const lane of cap.lanes) {
      for (const [row, c] of lane.cells) {
        total++;
        if (rows.length >= MAX) continue;
        const note = c.note === undefined ? "" : c.note === 1 ? "off" : c.note === 2 ? "cut" : c.note === 3 ? "fade" : (cap.names[c.note] ?? "");
        const vol = c.vol !== undefined ? String(c.vol) : c.volRaw !== undefined ? "~" : "";
        const fx = [c.fx !== undefined ? `${opName(c.fx)} $${(c.arg ?? 0).toString(16).toUpperCase().padStart(4, "0")}` : "",
          c.fx2 !== undefined ? `${opName(c.fx2)} $${(c.arg2 ?? 0).toString(16).toUpperCase().padStart(4, "0")}` : ""].filter(Boolean).join(" · ");
        rows.push([`${Math.floor(row / br) + 1}.${row % br}`, lane.label, note, vol, fx]);
      }
    }
    const nLanes = cap.lanes.length;
    this.panel.setPreview({
      title: p.label,
      rows, more: Math.max(0, total - rows.length),
      summary: cap.first === null ? null : t("motif.preview.summary", { n: total, lanes: cap.lanes.map((l) => l.label).join(", "), k: nLanes }),
      note: cap.first === null ? t("motif.preview.empty") : p.slots ? null : t("motif.preview.cannot"),
      canPlay: !!p.slots && cap.first !== null,
      playing: !!p.player?.playing,
    });
  }

  async playPreview() {
    const p = this.preview;
    if (!p?.slots) return;
    p.player?.stop();
    p.player = await playCapture(this.store, p.cap, (id) => p.slots[id] ?? null);
    this.drawPreview();
    // the Play button goes back to Play when the engine stops by itself
    const watch = setInterval(() => {
      if (!p.player?.playing) { clearInterval(watch); this.drawPreview(); }
    }, 300);
  }

  stopPreview() {
    if (!this.preview?.player) return;
    this.preview.player.stop();
    this.drawPreview();
  }

  /** Put the caret on an offset (selecting `length` characters) and the line in view. */
  goToOffset(offset, length = 0) {
    const v = this.text.value;
    const line = v.slice(0, offset).split("\n").length;
    const col = offset - (v.lastIndexOf("\n", offset - 1) + 1) + 1;
    this.goTo({ line, col });
    this.text.setSelectionRange(offset, offset + length);
    this.updateSelection();
  }

  /** The line the caret is on: a band behind it, and its number lit in the margin. */
  updateCaretLine() {
    if (document.activeElement !== this.text) return;
    const v = this.text.value;
    let line = 1;
    for (let i = v.indexOf("\n"), end = this.text.selectionStart; i >= 0 && i < end; i = v.indexOf("\n", i + 1)) line++;
    if (line !== this.caretLine) {
      this.gutter.children[this.caretLine - 1]?.classList.remove("motif-here");
      this.caretLine = line;
      this.gutter.children[line - 1]?.classList.add("motif-here");
    }
    this.caretRow.hidden = false;
    this.placeCaretRow();
  }

  placeCaretRow() {
    if (this.caretRow.hidden || !this.caretLine) return;
    const cs = getComputedStyle(this.text);
    const lh = parseFloat(cs.lineHeight) || 16;
    const top = `${parseFloat(cs.paddingTop) + (this.caretLine - 1) * lh - this.text.scrollTop}px`;
    if (this.caretRow.style.top !== top) this.caretRow.style.top = top;
    const h = `${lh}px`;
    if (this.caretRow.style.height !== h) this.caretRow.style.height = h;
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
    this.gutter.children[this.caretLine - 1]?.classList.add("motif-here");
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

  /** The instrument pack a program names: picked once a session, then kept. */
  async resolvePack(name) {
    const key = name.toLowerCase();
    if (packs.has(key)) return packs.get(key);
    const ok = await showModal({ title: t("motif.packTitle"), body: t("motif.packAsk", { name }), okLabel: t("motif.sfPick") });
    if (!ok) return null;
    const file = await pickFile(".tsii,.taud");
    if (!file) return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    packs.set(key, bytes);
    packs.set(file.name.toLowerCase(), bytes);
    return bytes;
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
    // A rebuild keeps the signature of the project it replaces (a demo stays
    // a demo); anything new is signed by the app. A program never chooses it.
    const signature = this.origin === "doc" ? this.store.doc?.signature : undefined;
    this.job = startMotifBuild(source, {
      signature,
      resolveSoundfont: (name) => this.resolveSoundfont(name),
      resolvePack: (name) => this.resolvePack(name),
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
      if (report.slots) this.slotMaps.set(this.store.doc, { slots: report.slots, sig: instrumentSignature(source) });
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
