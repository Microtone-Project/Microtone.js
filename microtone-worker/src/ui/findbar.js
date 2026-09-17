// Find (item 177) — Ctrl+F, and the bar it opens.
//
// A browser find bar, for a tracker: it docks above the status line, it holds
// ONE quick criterion, and Enter walks the matches while the grid behind it
// keeps the cursor. Escape puts it away and hands focus back.
//
// Two deliberate divisions of labour:
//
// · The criteria are patternquery.js's PREDICATE, so the bar and Find & Change
//   speak the same language and share the same remembered query. The bar shows
//   one term because one term is what a search almost always is ("every C-4",
//   "every note on instrument $03", "every S command"); anything more — ANDs,
//   ORs, ranges, modulo — opens the full editor through Criteria…, and the bar
//   then reports what it is holding instead of pretending to fit it.
//
// · WHERE it searches follows the view, and is not a setting: on the Timeline a
//   match is a place in the song (row × lane, play order), and in Patterns
//   it is a place in the bank (pattern × row, ascending) — which is also the
//   only way to find anything in a pattern no cue has placed yet. Those are the
//   two coordinate systems the two grids actually have; a scope selector would
//   only offer the user a way to pick the wrong one.
//
// The match list is computed once per search and thrown away on any edit, which
// is what makes stepping instant on a long song. It is deliberately NOT kept
// live across edits: a list that silently re-ordered itself under Next would be
// worse than one that is honestly recomputed.

import {
  songMatches, patternMatches, stepMatch, songCursorCmp, patternCursorCmp, indexAt,
} from "../doc/patternfind.js";
import {
  FIELDS, fieldsFor, fieldById, termOpsFor, TERM_OPS, fieldDigits,
  parseFieldValue, formatFieldValue, defaultTerm,
} from "../doc/patternquery.js";
import { noteToStr } from "./notenames.js";
import { FX_INFO, fxName, fxArg } from "./palette.js";
import { t } from "./i18n.js";
import { icon } from "./icons.js";

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** How many operands an operator wants. */
const argsOf = (id) => TERM_OPS.find((o) => o.id === id)?.args ?? 0;

/** Is this predicate simple enough for the bar's one row of controls? */
function isQuick(predicate) {
  return predicate.length === 1 && predicate[0].length === 1;
}

export class FindBar {
  /**
   * @param host the (hidden) container element
   * @param store the app store
   * @param deps  { view: () => "timeline"|"pattern"|…,
   *                goSong(match), goPattern(match), focusGrid() }
   */
  constructor(host, store, deps) {
    this.host = host;
    this.store = store;
    this.deps = deps;
    // One term, unfinished — the same shape defaultQuery() starts from, so the
    // bar and the dialog are always looking at the same kind of thing.
    this.predicate = [[defaultTerm("note")]];
    this.matches = null;   // null = not computed for the current predicate/scope
    this.index = -1;
    this.scopeKey = "";
    this.built = false;

    // Any edit, any song change, any reload: the list is stale, and the count
    // beside the box would be a lie. So it is dropped and recomputed — which is
    // affordable at the rate edits arrive: the whole of the corpus's biggest
    // song (948 patterns) walks in 9 ms, the same order as the Find & Change
    // dialog's own live recount (measured, 2026-09-04).
    for (const topic of ["edit", "doc"]) store.on(topic, () => this.invalidate());
    // A view change moves the goalposts twice over: the walk's coordinate
    // system is the view's, and a view with nowhere to put a cursor has no
    // business holding a find bar open over it.
    store.on("view", () => {
      this.invalidate();
      if (this.open && !this.canFind()) this.hide();
      else if (this.open) this.render();
    });
  }

  get open() { return !this.host.hidden; }

  /** Is the current view one a match can be pointed at? */
  canFind() {
    const v = this.deps.view();
    return v === "timeline" || v === "pattern";
  }

  /** Which coordinate system this view searches in. */
  scope() {
    return this.deps.view() === "pattern" ? "patterns" : "song";
  }

  /** A key that changes whenever the match list would have to be rebuilt. */
  fingerprint() {
    return `${this.scope()}:${this.store.songIndex}:${JSON.stringify(this.predicate)}`;
  }

  invalidate() {
    this.matches = null;
    if (this.open) this.paintCount();
  }

  // ── opening and closing ──────────────────────────────────────────────────

  /** Ctrl+F: show the bar and put the caret where the typing goes. */
  show() {
    if (!this.store.doc || !this.canFind()) return;
    if (!this.built) this.build();
    this.host.hidden = false;
    this.render();
    const box = this.host.querySelector(".fb-val");
    if (box) { box.focus(); box.select(); }
    else this.host.querySelector(".fb-crit")?.focus();
  }

  hide() {
    // Only take the focus back if the bar had it: closing on a view change must
    // not reach into whatever the new view has just focused.
    const hadFocus = this.host.contains(document.activeElement);
    this.host.hidden = true;
    if (hadFocus) this.deps.focusGrid?.();
  }

  // ── the DOM ──────────────────────────────────────────────────────────────

  build() {
    this.built = true;
    this.host.replaceChildren();
    this.host.append(
      el("span", "fb-label", t("fb.label")),
      el("span", "fb-quick"),
      el("span", "fb-summary dim"),
    );

    const btn = (cls, label, title, onClick) => {
      const b = el("button", cls, label);
      b.type = "button";
      b.title = title;
      b.addEventListener("click", onClick);
      this.host.append(b);
      return b;
    };
    // What the operand parsed to, in the column's own dialect and with the note
    // NAME beside a note word — the same readout the dialog carries, and for
    // the same reason: a column's base is not something to have to remember.
    this.host.append(el("span", "fb-read dim"), el("span", "fb-count dim"));
    // Text arrows rather than icons: the step buttons on every spinner in the
    // app are text, and ↑ ↓ say "the previous / next one down the list" more
    // plainly than a pair of 12-pixel chevrons.
    //
    // A pointer click on a button in this app deliberately drops its focus
    // (item 105, so Enter goes back to meaning play/stop) — which here would
    // mean clicking ↓ once and then having Enter start the song instead of
    // finding the next one. So a stepped click hands the caret back to the box.
    const stepBtn = (label, title, dir) => btn("fb-step", label, title, () => {
      this.step(dir);
      this.host.querySelector(".fb-val")?.focus();
    });
    stepBtn("\u2191", t("fb.prevTitle"), -1);
    stepBtn("\u2193", t("fb.nextTitle"), 1);
    btn("fb-crit", t("fb.criteria"), t("fb.criteriaTitle"), () => this.editCriteria());
    btn("fb-close", "", t("fb.closeTitle"), () => this.hide()).innerHTML = icon("close");

    // The bar is a text field with buttons beside it, and it claims only the
    // keys a text field may claim. Ctrl/Cmd chords are let through untouched —
    // Save works anywhere, any time (item 47.4), and so do undo and the
    // transport — with Ctrl+F itself the exception, because "search again" is
    // what pressing it a second time means everywhere else.
    this.host.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        e.stopPropagation();
        const box = this.host.querySelector(".fb-val");
        if (box?.select) { box.focus(); box.select(); }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      e.stopPropagation(); // no piano or transport keys under the caret
      if (e.key === "Enter") { e.preventDefault(); this.step(e.shiftKey ? -1 : 1); }
      else if (e.key === "Escape") { e.preventDefault(); this.hide(); }
    });
  }

  /** Rebuild the quick controls from the predicate. */
  render() {
    if (!this.built) this.build();
    const quick = this.host.querySelector(".fb-quick");
    const summary = this.host.querySelector(".fb-summary");
    const wide = this.store.doc?.wideCells === true;
    quick.replaceChildren();
    if (!isQuick(this.predicate)) {
      // Written by the full editor: say what it holds rather than showing a
      // control that could only misrepresent it.
      quick.hidden = true;
      summary.hidden = false;
      const conds = this.predicate.length;
      const terms = this.predicate.reduce((n, c) => n + c.length, 0);
      summary.textContent = conds === 0
        ? t("fb.summaryAll")
        : t("fb.summary", { conds, terms });
      this.paintCount();
      return;
    }
    quick.hidden = false;
    summary.hidden = true;
    const term = this.predicate[0][0];
    const field = fieldById(term.field) ?? FIELDS[0];

    const fieldSel = el("select", "fb-field");
    for (const f of fieldsFor(wide)) {
      const o = el("option", null, t(`find.f.${f.id}`));
      o.value = f.id;
      o.selected = f.id === field.id;
      fieldSel.append(o);
    }
    fieldSel.title = t("fb.fieldTitle");
    fieldSel.addEventListener("change", () => {
      term.field = fieldSel.value;
      term.a = ""; term.b = "";
      const ops = termOpsFor(fieldById(term.field)?.kind ?? "num");
      if (!ops.some((o) => o.id === term.op)) term.op = ops[0].id;
      this.changed();
      this.render();
      this.host.querySelector(".fb-val")?.focus();
    });

    const opSel = el("select", "fb-op");
    const ops = termOpsFor(field.kind);
    if (!ops.some((o) => o.id === term.op)) term.op = ops[0].id;
    for (const o of ops) {
      const opt = el("option", null, t(`find.op.${o.id}`));
      opt.value = o.id;
      opt.selected = o.id === term.op;
      opSel.append(opt);
    }
    opSel.title = t("fb.opTitle");
    opSel.addEventListener("change", () => {
      term.op = opSel.value;
      this.changed();
      this.render();
    });
    quick.append(fieldSel, opSel);

    // Operands. An opcode is picked from a list — there is no typing a `G` you
    // have to look up first — and everything else is typed in the column's own
    // base, with the readout beside the bar saying what it parsed to.
    const n = argsOf(term.op);
    for (let i = 0; i < n; i++) {
      const key = i === 0 ? "a" : "b";
      if (i === 1) quick.append(el("span", "fb-and", t(term.op === "mod" ? "find.modIs" : "find.to")));
      quick.append(this.operand(term, field, key, wide));
    }
    this.paintCount();
  }

  /** One operand control, bound to `term[key]`. */
  operand(term, field, key, wide) {
    if (field.kind === "fxop" || field.kind === "vpop") {
      const sel = el("select", "fb-val");
      const entries = field.kind === "fxop"
        ? Object.entries(FX_INFO).map(([op, info]) => [op, `${info.l} — ${fxName(info)}`, fxArg(info)])
        : ["set", "up", "down", "fineUp", "fineDown", "none"].map((op, i) =>
          [String(i), t(`find.${field.id === "panop" ? "vpan" : "vp"}.${op}`), ""]);
      const cur = Number(term[key]);
      for (const [value, label, title] of entries) {
        const o = el("option", null, label);
        o.value = value;
        if (title) o.title = title;
        o.selected = Number(value) === cur;
        sel.append(o);
      }
      // A fresh term holds "" — seed the model from what the list shows, so
      // what is on screen is what is searched for.
      if (!(cur >= 0)) term[key] = sel.value;
      sel.addEventListener("change", () => { term[key] = sel.value; this.changed(); });
      return sel;
    }
    const input = el("input", "fb-val");
    input.type = "text";
    input.value = term[key] ?? "";
    input.placeholder = field.hex ? "$" + "0".repeat(fieldDigits(field.id, wide)) : "0";
    input.title = t(field.kind === "note" ? "fb.valNoteTitle" : "fb.valTitle");
    input.addEventListener("input", () => { term[key] = input.value; this.changed(); });
    return input;
  }

  /** The predicate changed: the list is stale and the readout has to say so. */
  changed() {
    this.matches = null;
    this.index = -1;
    this.paintCount();
  }

  // ── searching ────────────────────────────────────────────────────────────

  /** The compiled predicate, dropping anything half-typed (compileQuery's rule:
   *  a term with no operand yet is not a term). */
  compiled() {
    const out = [];
    for (const cond of this.predicate) {
      const terms = [];
      for (const term of cond) {
        const f = fieldById(term.field);
        if (!f || !termOpsFor(f.kind).some((o) => o.id === term.op)) continue;
        const need = argsOf(term.op);
        const c = { field: f.id, op: term.op };
        let ok = true;
        for (let i = 0; i < need; i++) {
          const key = i === 0 ? "a" : "b";
          const v = parseFieldValue(f.id, term[key]);
          if (v === null) { ok = false; break; }
          c[key] = v;
        }
        if (ok) terms.push(c);
      }
      if (terms.length) out.push(terms);
    }
    return out;
  }

  /** The match list for the current predicate and scope, computed on demand. */
  list() {
    const print = this.fingerprint();
    if (this.matches !== null && print === this.scopeKey) return this.matches;
    const doc = this.store.doc;
    const predicate = this.compiled();
    // An EMPTY predicate matches every cell in patternquery's world, which is
    // right for "change everything here" and useless as a search — nothing is
    // found rather than everything.
    this.matches = predicate.length === 0 || !doc
      ? []
      : (this.scope() === "patterns"
        ? patternMatches(doc, this.store.songIndex, predicate)
        : songMatches(doc, this.store.songIndex, predicate));
    this.scopeKey = print;
    return this.matches;
  }

  /** Where the cursor sits, in the scope's own coordinates. */
  cursorCmp() {
    if (this.scope() === "patterns") {
      const pane = this.deps.patternCursor?.();
      return patternCursorCmp(pane?.pat ?? 0, pane?.row ?? 0);
    }
    const c = this.store.cursor;
    return songCursorCmp(c.row, c.ch);
  }

  /** Find next (dir 1) / previous (dir −1) and take the cursor there. */
  step(dir) {
    const list = this.list();
    if (list.length === 0) { this.paintCount(); return; }
    const i = stepMatch(list, this.cursorCmp(), dir);
    if (i < 0) { this.paintCount(); return; }
    this.index = i;
    const m = list[i];
    if (this.scope() === "patterns") this.deps.goPattern(m);
    else this.deps.goSong(m);
    this.paintCount();
  }

  /** `n of m`, or why there is no number — plus what the operands parsed to. */
  paintCount() {
    const countEl = this.host.querySelector(".fb-count");
    if (!countEl) return;
    this.paintRead();
    const compiled = this.compiled();
    if (compiled.length === 0) {
      countEl.textContent = t("fb.noCriteria");
      countEl.classList.remove("fb-none");
      return;
    }
    const list = this.list();
    // The cursor may have moved off the match since the last step (an arrow
    // key, a click), so the position is re-read from where it actually is
    // rather than from what Next last did.
    const at = indexAt(list, this.cursorCmp());
    countEl.textContent = list.length === 0
      ? t("fb.none")
      : (at >= 0 ? t("fb.at", { n: at + 1, total: list.length })
        : t("fb.total", { total: list.length }));
    countEl.classList.toggle("fb-none", list.length === 0);
  }

  /** The operand readout: `$5000 C-4`, `$30 (48)`, or a bare `?` for something
   *  that is not a value at all (which is also why the count says nothing). */
  paintRead() {
    const readEl = this.host.querySelector(".fb-read");
    if (!readEl) return;
    if (!isQuick(this.predicate)) { readEl.textContent = ""; return; }
    const term = this.predicate[0][0];
    const f = fieldById(term.field);
    const wide = this.store.doc?.wideCells === true;
    const parts = [];
    for (const key of ["a", "b"]) {
      const raw = term[key];
      if (raw === undefined || raw === "") continue;
      if (f?.kind === "fxop" || f?.kind === "vpop") continue; // picked from a list
      const v = parseFieldValue(term.field, raw);
      if (v === null) { parts.push(t("find.badValue")); continue; }
      let text = formatFieldValue(term.field, v, wide);
      if (f?.kind === "note") text += " " + noteToStr(v);
      else if (f?.hex) text += ` (${v})`;
      parts.push(text);
    }
    readEl.textContent = parts.join(" · ");
  }

  // ── the full editor ──────────────────────────────────────────────────────

  /** Criteria… — the Find & Change dialog with its Change half put away. */
  async editCriteria() {
    const doc = this.store.doc;
    if (!doc) return;
    const { showFindQuery } = await import("./popups/findchange.js");
    const next = await showFindQuery(this.store, {
      predicate: this.predicate,
      cells: this.dialogCells(),
      scope: t(this.scope() === "patterns" ? "fb.scopePatterns" : "fb.scopeSong"),
    });
    if (next === null) { this.show(); return; }
    // The editor hands back RAW rows (operands still text), which is the shape
    // the quick controls edit and compiled() parses — so a criterion built in
    // the dialog can be adjusted in the bar afterwards.
    //
    // A predicate the editor left empty would match every cell, which the bar
    // reads as "no criteria" — keep the row it started from instead of emptying
    // the bar behind the user's back.
    this.predicate = next.length === 0 ? [[defaultTerm("note")]] : next;
    this.changed();
    this.show();
  }

  /**
   * The cells the dialog's live count is measured over — its counter is written
   * against a [{pat, row}] list, so the search's scope is handed to it in that
   * shape: every row of every pattern the scope reaches, deduplicated (one
   * pattern placed in ten cues is still one pattern's worth of cells).
   */
  dialogCells() {
    const doc = this.store.doc;
    const song = doc.songs[this.store.songIndex];
    const pats = new Set();
    if (this.scope() === "patterns") {
      song.patterns.forEach((p, i) => { if (p) pats.add(i); });
    } else {
      for (const e of song.songMap().entries) {
        const words = song.cues[e.cue];
        if (!words) continue;
        for (let ch = 0; ch < doc.channelCount; ch++) {
          const pat = words[ch] & 0x7fff;
          if (pat !== 0x7fff) pats.add(pat);
        }
      }
    }
    const cells = [];
    for (const pat of [...pats].sort((a, b) => a - b)) {
      for (let r = 0; r < 64; r++) cells.push({ pat, row: r });
    }
    return cells;
  }
}
