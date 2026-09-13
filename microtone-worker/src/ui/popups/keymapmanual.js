// Set every key by hand (item 187) — the editor for layouts that are not
// lattices at all.
//
// A generator is the right way to describe a keyboard for an EQUAL tuning: one
// step sideways is worth the same interval wherever you are, so two numbers
// describe the whole board. An unequal temperament breaks that. Its degrees are
// different sizes, so "up two degrees" is a different interval in every part of
// the scale, and a lattice stops meaning anything — the layout has to be placed
// note by note, by someone who knows which notes they want under which fingers.
//
// So this dialog is the whole board as one number per key, laid out the way the
// keyboard is, each showing the note it would play. It opens seeded from the
// layout you already have (start from a run or a lattice, then hand-tune it),
// and saving writes every key as an override and ZEROES the generator — because
// once every key is placed, an x/y that no longer describes anything would only
// lie in the readout and stamp over the work the next time it was touched.

import { t } from "../i18n.js";
import { noteToStr, noteCentsOff } from "../notenames.js";
import { resolveNoteSymbol } from "../pitchtables.js";
import {
  ROW_CODES, ROW_ORDER, resolveKeymap, keymapNote, normaliseKeymap, OFF,
} from "../keymap.js";
import { defaultLegend } from "../keymapboard.js";

// The sym DSL (pitchtables.js) is written for the vector glyph painter; these
// are its nearest text equivalents, so a cell can name a note in the TUNING'S
// own notation rather than in 12-EDO. On an unequal temperament the 12-EDO name
// is the misleading one — it is the nearest piano key, not the degree you are
// placing — so the notation's own symbol wins wherever the preset has one.
const TICK_TEXT = { " ": "", ".": "\u00B7", u: "\u2191", d: "\u2193", U: "\u21C8", D: "\u21CA" };
const ACC_TEXT = {
  "-": "", "#": "\u266F", b: "\u266D", t: "\u1D57", p: "\u1D56", x: "\uD834\uDD2A",
  B: "\u266D\u266D", 3: "\u266F\uD834\uDD2A", T: "\u266D\u266D\u266D", 4: "\uD834\uDD2A\uD834\uDD2A",
};

/** What a cell prints under its number: the notation's own name for the note,
 *  falling back to the 12-EDO name, with a cents marker when it sits between
 *  the degrees that notation can spell. */
function noteLabel(note, preset) {
  const sym = resolveNoteSymbol(note, preset);
  const cents = noteCentsOff(note);
  const tail = cents === 0 ? "" : ` ${cents > 0 ? "+" : ""}${cents}\u00A2`;
  if (!sym) return noteToStr(note) + tail;
  if (sym.cjk) return `${sym.cjk}${sym.octave}`;
  return `${TICK_TEXT[sym.tick] ?? ""}${sym.letter}${ACC_TEXT[sym.acc] ?? ""}${sym.octave}`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * @param spec    the layout to seed from (its resolved values fill the grid)
 * @param preset  the tuning the note names are read against
 * @param octave  the octave the preview names notes at
 * @param legend  (code) => the key's printed letter
 * @returns a new spec with every key overridden and no generator, or null
 */
export function showKeymapManual(spec, preset, octave, legend = defaultLegend) {
  const base = normaliseKeymap(spec);
  const rows = ROW_ORDER.filter((r) => base.rows.includes(r)).reverse(); // top row first
  const seeded = resolveKeymap(base);

  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "modal keymanual-modal";

    const keyCount = rows.length * 10;
    dlg.append(
      el("h3", "", t("keymanual.title")),
      el("p", "dim", t("keymanual.hint", { n: keyCount })),
    );

    /** code → {input, noteEl} */
    const cells = new Map();
    const grid = el("div", "keymanual-grid");
    // Opt out of the app-wide spinner upgrade (item 156): a pair of step
    // buttons on each of forty cells would be three times the width of the
    // keyboard this grid is supposed to look like, and the board's own − / =
    // already step one key at a time.
    grid.dataset.mt = "off";

    for (const row of rows) {
      const rowEl = el("div", "keymanual-row");
      for (const code of ROW_CODES[row]) {
        const cell = el("label", "keymanual-cell");
        cell.appendChild(el("span", "keymanual-legend", legend(code)));
        // Text rather than number: an EMPTY field is how a key is silenced, and
        // a native number input has its own ideas about what empty means.
        const input = document.createElement("input");
        input.type = "text";
        input.inputMode = "numeric";
        input.value = seeded.has(code) ? String(seeded.get(code)) : "";
        input.placeholder = t("keymanual.off");
        input.dataset.code = code;
        cell.appendChild(input);
        const noteEl = el("span", "keymanual-note", "");
        cell.appendChild(noteEl);
        cells.set(code, { input, noteEl, cell });
        rowEl.appendChild(cell);
      }
      grid.appendChild(rowEl);
    }
    dlg.appendChild(grid);

    /** The spec the inputs currently describe: every key an override, no
     *  generator left to recompute anything under them. */
    const currentSpec = () => {
      const overrides = {};
      for (const [code, { input }] of cells) {
        const raw = input.value.trim();
        // Empty, or the word itself, silences the key: it keeps its place on
        // the board and plays nothing. Anything unparseable is treated the same
        // way rather than quietly becoming zero, which would put a note under a
        // finger the user was trying to leave bare.
        const v = raw === "" || raw.toLowerCase() === OFF ? null : parseFloat(raw);
        overrides[code] = v === null || !Number.isFinite(v) ? null : v;
      }
      return normaliseKeymap({ ...base, x: 0, y: 0, overrides });
    };

    // Live note names: the point of the grid is seeing what you are placing.
    const refresh = () => {
      const live = currentSpec();
      const resolved = resolveKeymap(live);
      for (const [code, { noteEl, cell }] of cells) {
        const note = keymapNote(live, code, octave, preset, resolved);
        noteEl.textContent = note === null ? t("keymanual.off") : noteLabel(note, preset);
        cell.classList.toggle("off", note === null);
      }
    };
    grid.addEventListener("input", refresh);

    const btnRow = el("div", "modal-buttons");
    const okBtn = el("button", "", t("keymanual.apply"));
    const cancelBtn = el("button", "", t("common.cancel"));
    btnRow.append(okBtn, cancelBtn);
    dlg.appendChild(btnRow);

    document.body.appendChild(dlg);
    refresh();

    const finish = (result) => { dlg.close(); dlg.remove(); resolve(result); };
    cancelBtn.addEventListener("click", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("cancel", () => finish(null));
    // Never leak a digit to the piano keys or the transport behind the dialog.
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    okBtn.addEventListener("click", (e) => { e.preventDefault(); finish(currentSpec()); });

    dlg.showModal();
    cells.values().next().value?.input.focus();
  });
}
