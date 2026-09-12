// Find & Change (item 132) — the advanced pattern edit's dialog, over
// doc/patternquery.js.
//
// Two halves, exactly as the item puts it: a PREDICATE (conditions of ANDed
// terms, ORed together) and an ACTION list (SET / ADD / MULTIPLY-AND-ADD /
// CLEAR on any column). The same dialog opens from the Patterns toolbar and
// from either grid's right-click menu; all that differs is the cell list it is
// handed, which is why the whole thing is written against a plain
// `[{pat, row}]` and knows nothing about who selected them.
//
// Two things make it usable rather than merely powerful:
//   · every operand says what it parsed — `$30 (48)`, `$5000 C-4` — so a
//     column's base is never something you have to remember;
//   · the readout under the form counts the matches LIVE, on every keystroke,
//     so you find out what a predicate selects before you commit to it, and
//     Apply greys out when the answer is "nothing".
//
// The whole edit is one setCellsBytesOp: one undo step, however many patterns
// it crossed.
//
// The same dialog opens in FIND mode (item 177): the Change half is put away
// and OK hands the compiled PREDICATE back instead of applying anything, which
// is how the find bar borrows the whole condition vocabulary — every term,
// every operator, every operand readout — without a second editor for it. The
// predicate is remembered across both modes on purpose: "find these" and then
// "change the ones I just found" is one thought.

import {
  VP_OPS, TERM_OPS, ACTION_OPS,
  fieldById, fieldsFor, fieldDigits, termOpsFor, actionOpsFor, operandIsMultiplier,
  parseFieldValue, parseMultiplier, formatFieldValue,
  defaultTerm, defaultAction, defaultQuery, compileQuery, runPatternQuery,
  conditionCounts, queryScopes,
} from "../../doc/patternquery.js";
import { setCellsBytesOp } from "../../doc/ops.js";
import { cellToBytes } from "../../doc/clipboard.js";
import { noteToStr, hex4 } from "../notenames.js";
import { FX_INFO, fxName, fxArg } from "../palette.js";
import { t } from "../i18n.js";
import { icon } from "../icons.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * The query the last Find & Change was left holding, so re-opening the dialog
 * carries on from there. Bulk edits come in runs — "now the same thing an
 * octave up" — and retyping six fields to change one of them is the whole
 * difference between a tool you reach for and one you don't. Session-lived and
 * deliberately not persisted: it is a scratch thought, not a document.
 */
let lastQuery = null;

const clone = (q) => JSON.parse(JSON.stringify(q));

/**
 * Open Find & Change.
 *
 * @param store the app store (document, song index and undo stack)
 * @param cells [{pat, row}] the caller's cells — a block selection, a row
 *        range, or the one cell that was right-clicked
 * @param scope human label for those cells ("selected rows 0–15")
 * @param titleArg what the title names (the pattern number, usually)
 * @param channel the voice column those cells belong to, when the caller knows
 *        it (a Timeline block does; the Patterns view works it out from the
 *        cue list) — it names the "whole column" scope
 * @returns Promise<boolean> — true when the document changed
 */
export function showFindChange(store, opts) {
  return openQueryDialog(store, { ...opts, mode: "change" });
}

/**
 * Open the same dialog as a CRITERIA editor (item 177): no actions, no Apply,
 * and the answer is the predicate.
 *
 * @param predicate the conditions to start from — the find bar's current ones,
 *        so opening the editor never loses what the quick controls hold
 * @param cells the cells the live count is measured over (the bar's scope)
 * @returns Promise<predicate|null> — null when cancelled
 */
export function showFindQuery(store, opts) {
  return openQueryDialog(store, { ...opts, mode: "find" });
}

function openQueryDialog(store, {
  cells, scope, titleArg = "", channel = null, mode = "change", predicate = null,
}) {
  const findOnly = mode === "find";
  return new Promise((resolve) => {
    const doc = store.doc;
    if (!doc) { resolve(findOnly ? null : false); return; }
    const wide = doc.wideCells === true;
    const query = findOnly
      ? { predicate: clone(predicate ?? lastQuery?.predicate ?? defaultQuery().predicate),
          actions: [] }
      : (lastQuery ? clone(lastQuery) : defaultQuery());
    let target = "here";

    // ── the scopes on offer ─────────────────────────────────────────────────
    // "And everywhere else?" — queryScopes answers it (narrowest first, and
    // only where an answer exists); all that belongs here is naming them. Each
    // wider one is named with what it will COST, because the number of
    // patterns is the whole difference between an edit you meant and one you
    // did not.
    const scopes = findOnly
      ? [] : queryScopes(doc.songs[store.songIndex], doc.channelCount, cells, channel);
    const nPats = (n) => (n === 1 ? t("find.pats1") : t("find.pats", { n }));
    const scopeName = (s) => {
      // "here" carries a pattern number when the caller's cells ARE one whole
      // pattern (the toolbar with nothing selected): name it as the pattern
      // rather than list the same 64 rows twice under two different names.
      if (s.id === "here") {
        return s.pat === undefined
          ? t("find.scopeHere", { scope }) : t("find.scopePattern", { pat: hex4(s.pat) });
      }
      if (s.id === "pattern") return t("find.scopePattern", { pat: hex4(s.pat) });
      if (s.id === "column") return t("find.scopeColumn", { pats: nPats(s.patterns.length) });
      return t("find.scopeSong", { pats: nPats(s.patterns.length) });
    };

    const dlg = document.createElement("dialog");
    dlg.className = "modal findchange-modal";
    // A block on the Timeline crosses patterns, so the title names one only
    // when the caller is sure which it is.
    const title = findOnly
      ? t("find.queryTitle")
      : (titleArg ? t("find.title", { pat: titleArg }) : t("find.titlePlain"));
    dlg.innerHTML = `
      <h3>${esc(title)}</h3>
      <p class="dim fc-lead">${esc(t(findOnly ? "find.queryLead" : "find.lead"))}</p>
      <div class="fc-block">
        <div class="fc-legend">${esc(t("find.findHead"))}
          <span class="dim">${esc(t("find.findHint"))}</span></div>
        <div class="fc-conds"></div>
        <button type="button" class="fc-addcond">${esc(t("find.addCond"))}</button>
      </div>
      ${findOnly ? "" : `<div class="fc-block">
        <div class="fc-legend">${esc(t("find.changeHead"))}
          <span class="dim">${esc(t("find.changeHint"))}</span></div>
        <div class="fc-acts"></div>
        <button type="button" class="fc-addact">${esc(t("find.addAct"))}</button>
      </div>`}
      <div class="fc-foot">
        ${findOnly ? `<span class="dim fc-scope-l">${esc(t("find.scopeIs", { scope }))}</span>`
          : `<label class="fc-scope-l">${esc(t("find.scope"))}
          <select class="fc-scope">
            ${scopes.map((s) =>
              `<option value="${s.id}">${esc(scopeName(s))}</option>`).join("")}
          </select></label>`}
        <span class="fc-count"></span>
      </div>
      <div class="modal-buttons">
        <button type="button" class="fc-ok">${esc(t(findOnly ? "find.doFind" : "common.apply"))}</button>
        <button type="button" class="fc-cancel">${esc(t("common.cancel"))}</button>
      </div>`;
    document.body.appendChild(dlg);

    const $ = (q) => dlg.querySelector(q);
    const condsEl = $(".fc-conds");
    const actsEl = $(".fc-acts");
    const countEl = $(".fc-count");
    const okBtn = $(".fc-ok");

    // ── the cells in play ───────────────────────────────────────────────────
    // Cached per scope: the readout recomputes on every keystroke, and reading
    // a whole song's patterns out to bytes each time would make typing crawl.
    const cache = new Map();
    function scopeCells() {
      if (cache.has(target)) return cache.get(target);
      const list = [];
      // An arbitrary-number pattern that has never been edited (item 48) has no
      // object yet, and the grid shows it as the shared empty pattern — so read
      // that, exactly as the pane does. A change that writes to it materialises
      // it: setCellsBytesOp ensurePattern()s each cell it touches.
      const blank = doc.emptyPattern();
      const wholePattern = (pat) => {
        const rows = doc.patternAt(store.songIndex, pat) ?? blank;
        for (let r = 0; r < 64; r++) list.push({ pat, row: r, bytes: cellToBytes(rows[r], wide) });
      };
      const sc = scopes.find((s) => s.id === target);
      if (sc?.patterns) sc.patterns.forEach(wholePattern);
      else if (sc?.id === "pattern") wholePattern(sc.pat);
      else {
        for (const { pat, row } of cells) {
          const cell = (doc.patternAt(store.songIndex, pat) ?? blank)[row];
          if (cell) list.push({ pat, row, bytes: cellToBytes(cell, wide) });
        }
      }
      cache.set(target, list);
      return list;
    }

    // ── option lists ────────────────────────────────────────────────────────
    const fieldOptions = (forWriting, selected) => fieldsFor(wide, forWriting)
      .map((f) => `<option value="${f.id}"${f.id === selected ? " selected" : ""}>` +
        `${esc(t(`find.f.${f.id}`))}</option>`).join("");
    const opOptions = (list, selected, prefix) => list
      .map((o) => `<option value="${o.id}"${o.id === selected ? " selected" : ""}>` +
        `${esc(t(`${prefix}.${o.id}`))}</option>`).join("");
    // Effect opcodes as the grid spells them: the base-36 letter, its name and
    // its argument format, so picking one needs no second window.
    const fxOptions = (selected) => Object.entries(FX_INFO)
      .map(([op, info]) => `<option value="${op}"${Number(op) === Number(selected) ? " selected" : ""} ` +
        `title="${esc(fxArg(info))}">${esc(info.l)} — ${esc(fxName(info))}</option>`).join("");
    // The five column operations are the same five in both columns, but a
    // panning slide goes left and right rather than up and down — the command
    // palette names them that way and so does this.
    const vpOptions = (selected, isPan) => VP_OPS
      .map((op, i) => `<option value="${i}"${i === Number(selected) ? " selected" : ""}>` +
        `${esc(t(`find.${isPan ? "vpan" : "vp"}.${op}`))}</option>`).join("");

    /** How many operands an operator wants. */
    const argsOf = (list, id) => list.find((o) => o.id === id)?.args ?? 0;

    /**
     * One operand widget. Opcodes and column operations are picked from a list
     * (there is no typing a `G` you have to look up); everything else is typed,
     * in the column's own base, with a placeholder that says which that is.
     */
    function operandHtml(row, field, key, isMult) {
      const f = fieldById(field);
      if (isMult) {
        return `<input type="text" class="fc-val" data-k="${key}" inputmode="decimal" ` +
          `placeholder="1.0" value="${esc(row[key] ?? "")}">`;
      }
      if (f?.kind === "fxop") {
        return `<select class="fc-val" data-k="${key}">${fxOptions(row[key])}</select>`;
      }
      if (f?.kind === "vpop") {
        return `<select class="fc-val" data-k="${key}">` +
          `${vpOptions(row[key], f.id === "panop")}</select>`;
      }
      const hint = f?.hex ? "$" + "0".repeat(fieldDigits(field, wide)) : "0";
      return `<input type="text" class="fc-val" data-k="${key}" ` +
        `placeholder="${esc(hint)}" value="${esc(row[key] ?? "")}">`;
    }

    /**
     * The field a row is really on. `lastQuery` outlives the project it was
     * built against, so a query written on a version-3 song can be carried into
     * a version-2 one, where its elevation term names a column that is not in
     * the list — the select would quietly show something else while the model
     * said otherwise. Fall back to the first column the format does have, and
     * drop the operands with it: they were about the old one.
     */
    function liveField(row, forWriting) {
      const list = fieldsFor(wide, forWriting);
      const f = list.find((x) => x.id === row.field);
      if (f) return f;
      row.field = list[0].id;
      row.a = ""; row.b = "";
      return list[0];
    }

    /** A select operand holds a number, not the empty string a fresh row
     *  starts with — seed the model from the list so what is shown is what is
     *  meant. */
    function seedSelects(row, field) {
      const f = fieldById(field);
      if (f?.kind === "fxop" && !(Number(row.a) >= 1)) row.a = 0x1c; // S — the corpus's commonest
      if (f?.kind === "vpop" && !(Number(row.a) >= 0 && Number(row.a) < VP_OPS.length)) row.a = 0;
    }

    // ── render ──────────────────────────────────────────────────────────────
    function render() {
      condsEl.innerHTML = query.predicate.map((cond, ci) => `
        <div class="fc-cond" data-ci="${ci}">
          ${ci > 0 ? `<div class="fc-or">${esc(t("find.or"))}</div>` : ""}
          <div class="fc-terms">${cond.map((term, ti) => termHtml(term, ci, ti)).join("")}</div>
          <div class="fc-condfoot">
            <button type="button" class="fc-addterm" data-ci="${ci}">${esc(t("find.addTerm"))}</button>
            <button type="button" class="fc-delcond" data-ci="${ci}"
              title="${esc(t("find.delCond"))}">${icon("close")}</button>
            <span class="fc-condcount" title="${esc(t("find.condCountTitle"))}"></span>
          </div>
        </div>`).join("") ||
        `<p class="dim fc-empty">${esc(t("find.noConds"))}</p>`;
      if (actsEl) {
        actsEl.innerHTML = query.actions.map((a, ai) => actionHtml(a, ai)).join("") ||
          `<p class="dim fc-empty">${esc(t("find.noActs"))}</p>`;
      }
      refresh();
    }

    function termHtml(term, ci, ti) {
      const f = liveField(term, false);
      const ops = termOpsFor(f.kind);
      if (!ops.some((o) => o.id === term.op)) term.op = ops[0].id;
      const n = argsOf(TERM_OPS, term.op);
      if (n >= 1) seedSelects(term, f.id);
      return `
        <div class="fc-row fc-term" data-ci="${ci}" data-ti="${ti}">
          <select class="fc-field">${fieldOptions(false, f.id)}</select>
          <select class="fc-op">${opOptions(ops, term.op, "find.op")}</select>
          <span class="fc-vals">
            ${n >= 1 ? operandHtml(term, f.id, "a", false) : ""}
            ${n >= 2 ? `<span class="fc-and">${esc(t(term.op === "mod" ? "find.modIs" : "find.to"))}</span>` +
                       operandHtml(term, f.id, "b", false) : ""}
          </span>
          <span class="fc-read dim"></span>
          <button type="button" class="fc-delterm" title="${esc(t("find.delTerm"))}">${icon("close")}</button>
        </div>`;
    }

    function actionHtml(action, ai) {
      const f = liveField(action, true);
      const ops = actionOpsFor(f.kind);
      if (!ops.some((o) => o.id === action.op)) action.op = ops[0].id;
      const n = argsOf(ACTION_OPS, action.op);
      if (n >= 1 && !operandIsMultiplier(action.op, 0)) seedSelects(action, f.id);
      return `
        <div class="fc-row fc-act" data-ai="${ai}">
          <select class="fc-field">${fieldOptions(true, f.id)}</select>
          <select class="fc-op">${opOptions(ops, action.op, "find.act")}</select>
          <span class="fc-vals">
            ${n >= 1 ? operandHtml(action, f.id, "a", operandIsMultiplier(action.op, 0)) : ""}
            ${n >= 2 ? `<span class="fc-and">${esc(t("find.plus"))}</span>` +
                       operandHtml(action, f.id, "b", operandIsMultiplier(action.op, 1)) : ""}
          </span>
          <span class="fc-read dim"></span>
          <button type="button" class="fc-delact" title="${esc(t("find.delAct"))}">${icon("close")}</button>
        </div>`;
    }

    // ── the live half: what each operand parsed to, and what it all selects ──

    /** What one operand came out as, in the column's own dialect — with the
     *  note NAME beside a note word, which is the whole reason the readout is
     *  worth the space. */
    function readoutFor(row, field, isMult) {
      const f = fieldById(field);
      const parts = [];
      for (const key of ["a", "b"]) {
        const raw = row[key];
        if (raw === undefined || raw === "") continue;
        const mult = isMult(key);
        const v = mult ? parseMultiplier(raw) : parseFieldValue(field, raw);
        if (v === null) { parts.push(t("find.badValue")); continue; }
        if (mult) { parts.push("×" + v); continue; }
        let text = formatFieldValue(field, v, wide);
        if (f?.kind === "note") text += " " + noteToStr(v);
        else if (f?.hex) text += ` (${v})`;
        parts.push(text);
      }
      return parts.join(" · ");
    }

    /** Re-read every operand and re-run the query. Called on every keystroke,
     *  which is affordable even at the song scope: the whole of a 428-pattern
     *  song is ~27 000 cells and ~7 ms of runPatternQuery, so there is nothing
     *  here worth debouncing (measured, 2026-08-15). */
    function refresh() {
      for (const el of dlg.querySelectorAll(".fc-term")) {
        const term = query.predicate[+el.dataset.ci]?.[+el.dataset.ti];
        if (!term) continue;
        el.querySelector(".fc-read").textContent = readoutFor(term, term.field, () => false);
      }
      for (const el of dlg.querySelectorAll(".fc-act")) {
        const action = query.actions[+el.dataset.ai];
        if (!action) continue;
        el.querySelector(".fc-read").textContent =
          readoutFor(action, action.field, (k) => operandIsMultiplier(action.op, k === "a" ? 0 : 1));
      }
      const compiled = compileQuery(query);
      const res = runPatternQuery(scopeCells(), compiled, wide);
      // Each OR card says what IT selects on its own, so you can see which
      // alternative is doing the work (and which one is selecting nothing you
      // did not mean). Overlaps are counted on both cards — the question is
      // "what does this condition match", not "what did it add".
      const per = conditionCounts(query, compiled, res);
      for (const el of dlg.querySelectorAll(".fc-cond")) {
        const n = per[+el.dataset.ci];
        el.querySelector(".fc-condcount").textContent =
          n === null ? "" : t("find.condCount", { n });
      }
      // In find mode there is nothing to write, so the readout counts what the
      // predicate SELECTS and OK asks only that there is a predicate at all: a
      // search that currently matches nothing is still a search worth keeping
      // (the next edit may well make it match).
      countEl.textContent = findOnly
        ? t("find.countFound", { matched: res.matched, total: res.total })
        : t("find.count", { matched: res.matched, total: res.total, changed: res.writes.length });
      const none = findOnly ? res.matched === 0 : res.writes.length === 0;
      countEl.classList.toggle("fc-none", none);
      okBtn.disabled = findOnly ? compiled.predicate.length === 0 : none;
      return res;
    }

    // ── events ──────────────────────────────────────────────────────────────
    // One delegated listener per kind: the form is rebuilt whenever its SHAPE
    // changes (a different column wants different operand widgets), and only
    // the readouts are touched while someone is typing — a rebuild mid-word
    // would take the caret with it.
    dlg.addEventListener("input", (e) => {
      const el = e.target.closest(".fc-val");
      if (!el) return;
      const row = rowFor(el);
      if (!row) return;
      row[el.dataset.k] = el.value;
      refresh();
    });
    dlg.addEventListener("change", (e) => {
      const el = e.target;
      if (el.classList.contains("fc-scope")) {
        target = el.value;
        refresh();
        return;
      }
      const row = rowFor(el);
      if (!row) return;
      if (el.classList.contains("fc-field")) {
        // A different column means different operators and different operands:
        // keeping the old ones would carry `$30` into the elevation column.
        row.field = el.value;
        row.a = ""; row.b = "";
        const kind = fieldById(row.field)?.kind ?? "num";
        const ops = el.closest(".fc-act") ? actionOpsFor(kind) : termOpsFor(kind);
        if (!ops.some((o) => o.id === row.op)) row.op = ops[0].id;
        render();
      } else if (el.classList.contains("fc-op")) {
        row.op = el.value;
        render();
      } else if (el.classList.contains("fc-val")) {
        row[el.dataset.k] = el.value;
        refresh();
      }
    });
    dlg.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      if (btn.classList.contains("fc-addcond")) {
        query.predicate.push([defaultTerm("note")]);
        render();
      } else if (btn.classList.contains("fc-addterm")) {
        query.predicate[+btn.dataset.ci]?.push(defaultTerm("vol"));
        render();
      } else if (btn.classList.contains("fc-delcond")) {
        query.predicate.splice(+btn.dataset.ci, 1);
        render();
      } else if (btn.classList.contains("fc-delterm")) {
        const row = btn.closest(".fc-term");
        const cond = query.predicate[+row.dataset.ci];
        cond?.splice(+row.dataset.ti, 1);
        // A condition with no terms left selects nothing, so it goes with them.
        if (cond && cond.length === 0) query.predicate.splice(+row.dataset.ci, 1);
        render();
      } else if (btn.classList.contains("fc-addact")) {
        query.actions.push(defaultAction("vol"));
        render();
      } else if (btn.classList.contains("fc-delact")) {
        query.actions.splice(+btn.closest(".fc-act").dataset.ai, 1);
        render();
      } else if (btn.classList.contains("fc-ok")) {
        // The predicate goes back the way it came in: as the RAW rows, with
        // their operands still text. Handing back the compiled form would make
        // the caller's numbers un-editable — parseFieldValue would read a
        // compiled `4660` back as `$4660` (item 177).
        if (findOnly) finish(clone(query.predicate));
        else finish(apply());
      } else if (btn.classList.contains("fc-cancel")) {
        finish(findOnly ? null : false);
      }
    });
    dlg.addEventListener("keydown", (e) => {
      e.stopPropagation(); // no piano/transport keys while the dialog is up
      if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); okBtn.click(); }
    });
    dlg.addEventListener("cancel", () => finish(findOnly ? null : false));

    /** The model row a control belongs to — a term or an action. */
    function rowFor(el) {
      const term = el.closest(".fc-term");
      if (term) return query.predicate[+term.dataset.ci]?.[+term.dataset.ti];
      const act = el.closest(".fc-act");
      if (act) return query.actions[+act.dataset.ai];
      return null;
    }

    function apply() {
      const res = refresh();
      if (res.writes.length === 0) return false;
      store.undo.apply(setCellsBytesOp(store.songIndex, res.writes));
      return true;
    }

    function finish(result) {
      // Find mode carries no actions, so it writes back only its half — the
      // Change dialog's action list is left exactly as it was.
      lastQuery = findOnly
        ? { predicate: clone(query.predicate),
            actions: lastQuery ? clone(lastQuery.actions) : defaultQuery().actions }
        : clone(query);
      dlg.close();
      dlg.remove();
      resolve(result);
    }

    render();
    dlg.showModal();
    dlg.querySelector("select")?.focus();
  });
}
