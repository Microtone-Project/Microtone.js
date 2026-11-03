// The Lyrics tab (item 280) — a lyric instrument's words.
//
// A lyric instrument is a formant instrument that sings its lyrics one
// syllable a note (TAUD_ENGINE_SPEC §5.5.3, "Lyric instruments"). Its record
// holds what every syllable shares, edited on the Formant tab: the pool range,
// the source, how the formants follow pitch, the base consonant length, the
// vowel glide. This tab holds what differs:
//
//   Lyrics            the text, in IPA or X-SAMPA, under an IPA keyboard; read
//                     as it is typed (the count, or the first syllable that
//                     cannot be read) and applied when the box is left or on
//                     Ctrl+Enter — a half-typed word never reaches playback
//   Consonant length  the convergence (how far every onset is drawn towards
//                     the lyrics' median, 0…100 %), and — folded away, an
//                     advanced setting — each consonant's own length
//   Syllables         what the lyrics were read as, one chip a syllable, with
//                     how long each takes to reach its vowel; a run of them
//                     picked (on the chips, or selected in the text) takes a
//                     length of its own, which the convergence leaves alone
//
// Everything else — the noise each consonant reads — is chosen (lyrics.js),
// as a formant instrument's source is: the best the record's range has.
// Every edit is one setLyricsOp, so one undo takes it back.

import { setLyricsOp } from "../../doc/ops.js";
import {
  deriveLyrics, readLyrics, lyricRange, onsetMs, lyricTokens, remapSyllableOverrides,
} from "../../doc/lyrics.js";
import { ipaToXsampa, xsampaToIpa } from "../../motif/syllable.js";
import { VOWEL_MARKS, SECONDARY_MARKS, syllabicIpa } from "../../doc/formantedit.js";
import { CONSONANTS, CONSONANT_LIST, SEMIVOWELS, timingScale } from "../../../core/engine/formant.js";
import { machineFor } from "./instformant.js";
import { t } from "../i18n.js";
import { charPalette } from "../components/charpalette.js";
import { makeFoldable } from "../components/fold.js";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** What a lyric instrument starts with: one syllable, [la]. */
export const DEFAULT_LYRICS = "la";

/** Text typed and not yet applied, per document and slot — kept across the
 *  panel's rebuilds (an edit elsewhere, playback), dropped once applied. */
const drafts = new WeakMap();
const draftsOf = (doc) => {
  let m = drafts.get(doc);
  if (!m) { m = new Map(); drafts.set(doc, m); }
  return m;
};

/** The syllables picked on the chips, per document and slot: {anchor, focus},
 *  indices into the applied lyrics (a run is everything between them). */
const picks = new WeakMap();
const picksOf = (doc) => {
  let m = picks.get(doc);
  if (!m) { m = new Map(); picks.set(doc, m); }
  return m;
};

/** The IPA keyboard: the vowels the chart marks, the consonants the engine
 *  has, the marks a syllable can carry, and the breaks between syllables. */
function paletteGroups() {
  const cons = CONSONANT_LIST.map((r) => r.ipa);
  return [
    { label: t("lyr.palVowels"), keys: [...VOWEL_MARKS.map((m) => m.ipa), "ɚ", "ɝ"] },
    { label: t("lyr.palConsonants"), keys: cons },
    {
      label: t("lyr.palMarks"),
      keys: [
        { text: "̃", title: t("lyr.markNasal") }, { text: "˞", title: t("lyr.markRhotic") },
        { text: "̩", title: t("lyr.markSyllabic") }, { text: "ʲ", title: t("lyr.markPalatal") },
        { text: "ˠ", title: t("lyr.markVelar") }, { text: "ˤ", title: t("lyr.markPharyngeal") },
        { text: "ˀ", title: t("lyr.markGlottal") }, { text: "̚", title: t("lyr.markUnreleased") },
        { text: "͡", title: t("lyr.markTie") },
      ],
    },
    { label: t("lyr.palBreaks"), keys: [{ text: ".", title: t("lyr.breakSyllable") }, { text: " ", label: "␣", title: t("lyr.breakWord") }] },
  ];
}

/** A syllable as the chips spell it: its consonants, glide, vowel and marks. */
function syllableIpa(s) {
  const ipa = (id) => CONSONANTS[id]?.ipa ?? "";
  const [a, b, c] = s.cons;
  // The onset's secondary articulation is marked on its last consonant.
  const sec = SECONDARY_MARKS[(s.gr >> 3) & 3] ?? "";
  const on = [a, b].filter(Boolean).map(ipa);
  if (on.length > 0) on[on.length - 1] += sec;
  const gl = s.gr & 7;
  const glide = gl >= 1 && gl <= 4 ? SEMIVOWELS[gl].ipa : "";
  if (!s.vowel) {
    if (on.length === 0) return c ? syllabicIpa(ipa(c)) : "";
    const held = on.pop();
    return on.join("") + syllabicIpa(held) + (c ? ipa(c) : "");
  }
  let best = null, bd = Infinity;
  for (const m of VOWEL_MARKS) {
    const d = (m.front - s.front) ** 2 + (m.open - s.open) ** 2 + ((m.round - s.round) * 0.5) ** 2;
    if (d < bd) { bd = d; best = m; }
  }
  let v = best ? best.ipa : "?";
  if (s.nasal) v += "̃";
  if (s.gr & 0x80) v += "˞";
  return on.join("") + glide + v + (c ? ipa(c) : "");
}

export function renderLyricsTab(view, inst) {
  const doc = view.store.doc;
  const slot = view.selected;
  const entry = doc.lyricEntry(slot);
  if (!entry || !inst?.isFormant) return;
  const ed = entry.editor;
  const rec = inst.formant;
  const range = lyricRange(doc, rec);
  /** The editor's part as it stands NOW — a slider drag applies quietly,
   *  without rebuilding the panel, so what was read at render time can lag. */
  const edNow = () => doc.lyricEntry(slot)?.editor ?? ed;

  /** Read `editor` into an entry and apply it; false (and nothing applied)
   *  when the lyrics cannot be read. `gid` coalesces a slider's drag. */
  const commit = (editor, gid = null) => {
    const machine = range ? machineFor(doc, range[0], range[1]) : null;
    const res = deriveLyrics(rec, editor, machine);
    if (res.entry === null) return false;
    const op = setLyricsOp(doc.lyricPayloadWith(slot, res.entry), gid);
    if (gid === null) view.store.undo.apply(op);
    else { view.applyQuiet(op); paintChips(); }
    return true;
  };

  // ── Lyrics ──
  const drafts = draftsOf(doc);
  const draft = drafts.get(slot);
  const xsampa = draft?.xsampa ?? ed.xsampa;
  const area = el("textarea", "lyr-text");
  area.value = draft?.text ?? ed.text;
  area.rows = 4;
  area.spellcheck = false;
  area.setAttribute("autocapitalize", "off");
  area.setAttribute("autocomplete", "off");
  area.title = t("lyr.textTitle");
  area.setAttribute("aria-label", t("lyr.grpLyrics"));
  if (!xsampa) area.classList.add("ipa");
  const status = el("div", "lyr-status");
  status.setAttribute("aria-live", "polite");
  const paintStatus = () => {
    const text = area.value;
    const { syllables, errors } = readLyrics(text, xsampa);
    status.classList.toggle("bad", errors.length > 0 || syllables.length === 0);
    status.onclick = null;
    if (errors.length > 0) {
      const e = errors[0];
      status.textContent = t("lyr.error", { n: e.index + 1, text: e.text, msg: e.message });
      // A click puts the caret on the syllable that cannot be read.
      status.onclick = () => { area.focus(); area.setSelectionRange(e.at, e.at + e.text.length); };
    } else if (syllables.length === 0) {
      status.textContent = t("lyr.empty");
    } else {
      const pending = text !== ed.text || xsampa !== ed.xsampa;
      status.textContent = t(pending ? "lyr.countPending" : "lyr.count", { n: syllables.length });
    }
  };
  const apply = () => {
    const text = area.value;
    if (text === ed.text && xsampa === ed.xsampa) { drafts.delete(slot); return; }
    // The syllables' own lengths stay on their syllables through the edit.
    const sylOverrides = remapSyllableOverrides(ed.text, ed.xsampa, text, xsampa, ed.sylOverrides);
    if (commit({ ...ed, text, xsampa, sylOverrides })) drafts.delete(slot);
  };
  area.addEventListener("input", () => {
    drafts.set(slot, { text: area.value, xsampa });
    paintStatus();
  });
  area.addEventListener("change", apply);
  area.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); apply(); }
  });
  paintStatus();

  // The notation: switching it rewrites the text into the other one.
  const notationRow = view.selectRow(t("lyr.notation"), xsampa ? 1 : 0,
    [[0, t("lyr.ipa")], [1, t("lyr.xsampa")]],
    (v) => {
      const toX = v === 1;
      if (toX === xsampa) return;
      const text = toX ? ipaToXsampa(area.value).text : toIpa(area.value);
      drafts.delete(slot);
      if (!commit({ ...ed, text, xsampa: toX })) {
        // Unreadable either way: keep it typed, in the new notation, to fix.
        drafts.set(slot, { text, xsampa: toX });
        view.renderPanel();
      }
    });
  notationRow.title = t("lyr.notationTitle");
  // The IPA keyboard folds away (the viewer's choice, kept in the browser);
  // X-SAMPA is typed on the keyboard itself, so there it is not shown.
  const palette = charPalette({ groups: paletteGroups(), target: area, className: "lyr-palette" });
  const palBox = el("div", "lyr-pal-box");
  const palHead = el("div", "lyr-pal-head");
  const palName = el("span", "", t("lyr.palette"));
  palHead.appendChild(palName);
  palBox.append(palHead, palette.element);
  makeFoldable(palBox, { head: palHead, body: palette.element, name: palName, key: "lyrics-ipa-keyboard", label: t("lyr.paletteFold") });
  palBox.hidden = xsampa;
  view.group(t("lyr.grpLyrics"), notationRow, area, status, palBox);

  // ── Consonant length ──
  // What the lyrics come to before the convergence and the syllables' own
  // lengths (`natural`), and the median the convergence draws towards.
  const plan = deriveLyrics(rec, ed, null);
  const natural = plan.natural;
  const read = readLyrics(ed.text, ed.xsampa).syllables;
  const used = new Set();
  for (const { syl } of read) {
    for (const c of [...syl.onset, syl.coda]) if (c) used.add(c);
    if (syl.glide) used.add(SEMIVOWELS[syl.glide].row);
  }
  const convergeRow = view.sliderRow(t("lyr.converge"), ed.converge, 0, 100,
    (v, gid) => commit({ ...edNow(), converge: v }, gid),
    {
      ann: (v) => (v === 0 ? t("lyr.convergeOff") : `${v} %`),
      title: t("lyr.convergeTitle"),
    });
  convergeRow.classList.add("lyr-converge");
  // Each consonant's own length: an advanced setting, folded away by default.
  const consRows = [...used].sort((a, b) => a - b).map((id) => {
    const row = view.sliderRow(`[${CONSONANTS[id].ipa}]`, ed.overrides.find((v) => v.cons === id)?.timing ?? 128, 0, 255, (v, gid) => {
      const next = new Map(edNow().overrides.map((o) => [o.cons, o.timing]));
      if (v === 128) next.delete(id); else next.set(id, v);
      commit({ ...edNow(), overrides: [...next].map(([cons, timing]) => ({ cons, timing })) }, gid);
    }, { ann: (v) => `×${timingScale(v).toFixed(2)}`, title: t("lyr.consLenTitle") });
    row.classList.add("lyr-cons-row");
    return row;
  });
  const consBox = el("div", "lyr-cons-box");
  const consHead = el("div", "lyr-pal-head");
  const consName = el("span", "", t("lyr.perCons"));
  consHead.appendChild(consName);
  const consBody = el("div", "lyr-cons-body");
  consBody.append(...(consRows.length > 0 ? consRows : [el("p", "dim fmt-note", t("lyr.noCons"))]));
  consBox.append(consHead, consBody);
  makeFoldable(consBox, {
    head: consHead, body: consBody, name: consName, key: "lyrics-each-consonant", open: false, label: t("lyr.perConsFold"),
  });
  const medianNote = el("p", "dim fmt-note lyr-median",
    plan.median > 0 ? t("lyr.median", { ms: Math.round(plan.median) }) : t("lyr.noMedian"));
  view.group(t("lyr.grpTiming"), convergeRow, medianNote, consBox, el("p", "dim fmt-note", t("lyr.baseNote")));

  // ── Syllables ──
  // A run of chips is picked (click, Shift+click; or select the syllables in
  // the lyrics) and given a length of its own.
  const count = entry.syllables.length;
  const pickMap = picksOf(doc);
  let pick = pickMap.get(slot) ?? null;
  if (pick && (pick.anchor >= count || pick.focus >= count)) { pick = null; pickMap.delete(slot); }
  const pickedRange = () => (pick ? [Math.min(pick.anchor, pick.focus), Math.max(pick.anchor, pick.focus)] : null);
  const setPick = (p) => {
    pick = p;
    if (p) pickMap.set(slot, p); else pickMap.delete(slot);
    paintChips();
    paintPick();
  };

  const list = el("ol", "lyr-syls");
  list.setAttribute("aria-multiselectable", "true");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", t("lyr.grpSyllables"));
  const chips = entry.syllables.map((s, i) => {
    const li = el("li", "lyr-syl");
    li.setAttribute("role", "option");
    const ipa = syllableIpa(s);
    const ms = el("span", "lyr-syl-ms");
    li.append(el("span", "lyr-syl-n", String(i + 1)), el("span", "lyr-syl-ipa ipa", ipa), ms);
    li.dataset.ipa = ipa;
    li.addEventListener("click", (e) => {
      const r = pickedRange();
      if (e.shiftKey && pick) setPick({ anchor: pick.anchor, focus: i });
      else if (r && r[0] === i && r[1] === i) setPick(null);
      else setPick({ anchor: i, focus: i });
    });
    list.appendChild(li);
    return { li, ms };
  });
  /** The chips from the entry as it stands: each one's way to its vowel, and
   *  whether the convergence moved it, it has a length of its own, it is picked. */
  function paintChips() {
    const now = doc.lyricEntry(slot);
    if (!now || now.syllables.length !== chips.length) return;
    const own = new Set(now.editor.sylOverrides.map((v) => v.index));
    const r = pickedRange();
    now.syllables.forEach((s, i) => {
      const { li, ms } = chips[i];
      const len = onsetMs(rec, s);
      const txt = len > 0 ? String(Math.round(len)) : "";
      if (ms.textContent !== txt) ms.textContent = txt;
      const moved = !own.has(i) && len > 0 && Math.abs(len - (natural[i] ?? len)) >= 0.5;
      li.classList.toggle("squeezed", moved && len < natural[i]);
      li.classList.toggle("stretched", moved && len > natural[i]);
      li.classList.toggle("own", own.has(i));
      const on = !!r && i >= r[0] && i <= r[1];
      li.classList.toggle("picked", on);
      li.setAttribute("aria-selected", String(on));
      li.title = t("lyr.syllableTitle", { n: i + 1, ipa: li.dataset.ipa, ms: Math.round(len) });
    });
  }

  // The picked run's own length.
  const pickBox = el("div", "lyr-pick");
  function paintPick() {
    pickBox.replaceChildren();
    const r = pickedRange();
    if (!r) { pickBox.append(el("p", "dim fmt-note", t("lyr.pickNone"))); return; }
    const own = new Map(edNow().sylOverrides.map((v) => [v.index, v.timing]));
    let first = null, any = false;
    for (let i = r[0]; i <= r[1]; i++) if (own.has(i)) { any = true; first ??= own.get(i); }
    const label = r[0] === r[1] ? t("lyr.pickOne", { a: r[0] + 1 }) : t("lyr.pickRun", { a: r[0] + 1, b: r[1] + 1 });
    const row = view.sliderRow(label, first ?? 128, 0, 255, (v, gid) => {
      const next = new Map(edNow().sylOverrides.map((o) => [o.index, o.timing]));
      for (let i = r[0]; i <= r[1]; i++) next.set(i, v);
      commit({ ...edNow(), sylOverrides: [...next].map(([index, timing]) => ({ index, timing })) }, gid);
      clear.disabled = false;
    }, { ann: (v) => `×${timingScale(v).toFixed(2)}`, title: t("lyr.pickLenTitle") });
    row.classList.add("lyr-pick-row");
    const clear = el("button", "lyr-pick-clear", t("lyr.pickClear"));
    clear.type = "button";
    clear.title = t("lyr.pickClearTitle");
    clear.disabled = !any;
    clear.addEventListener("click", () => {
      const next = edNow().sylOverrides.filter((o) => o.index < r[0] || o.index > r[1]);
      commit({ ...edNow(), sylOverrides: next });
    });
    pickBox.append(row, clear);
  }

  // Selecting syllables in the lyrics picks them, while the text is the
  // applied one (a draft's syllables are not the chips').
  const pickFromText = () => {
    const a = area.selectionStart, b = area.selectionEnd;
    if (a === b || area.value !== ed.text || xsampa !== ed.xsampa) return;
    const toks = lyricTokens(ed.text, ed.xsampa);
    const hit = [];
    toks.forEach((tok, i) => { if (tok.at < b && tok.at + tok.text.length > a) hit.push(i); });
    if (hit.length === 0 || hit[hit.length - 1] >= count) return;
    setPick({ anchor: hit[0], focus: hit[hit.length - 1] });
  };
  area.addEventListener("select", pickFromText);
  area.addEventListener("mouseup", pickFromText);
  area.addEventListener("keyup", (e) => { if (e.shiftKey) pickFromText(); });

  paintChips();
  paintPick();
  view.group(t("lyr.grpSyllables"), list, pickBox, el("p", "dim fmt-note", t("lyr.syllablesNote")));
}

/** X-SAMPA text → IPA, syllable by syllable, the breaks kept; a syllable that
 *  cannot be read is kept as it was typed. */
function toIpa(text) {
  return text.split(/([\s.\-,|"%]+)/u).map((p) => {
    if (p === "" || /^[\s.\-,|"%]+$/u.test(p)) return p;
    try { return xsampaToIpa(p); } catch { return p; }
  }).join("");
}
