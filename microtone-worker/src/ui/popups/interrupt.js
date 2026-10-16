// Interrupt marker dialog — the note column's `IntN` writer. It used to be a
// row of sixteen bare hex buttons on the command palette, which said nothing
// about the argument an interrupt can carry; this asks both questions at once:
// which interrupt (Int0…IntF, note words $0010‥$001F) and, optionally, the
// 16-bit number it hands the program playing the song — the `: MMMM` effect
// on the same row (core/engine/row.js interruptArgOf).
//
// With an argument it writes `IntN` AND `: MMMM`; with none, only `IntN`, and
// every other field of the cell is left exactly as it was.

import { EffectOp } from "../../../core/engine/tables.js";
import { t } from "../i18n.js";

const INT_BASE = 0x0010;

// ── pure helpers (unit-tested in test/node/interruptdialog.test.js) ────────

/** The interrupt number (0‥15) a note word holds, or -1 for any other note. */
export function interruptNumberOf(note) {
  return note >= INT_BASE && note <= INT_BASE + 15 ? note - INT_BASE : -1;
}

/** The `:` argument the player would read off this cell — the LEFT slot wins,
 *  as in the engine — or -1 when neither slot carries one. */
export function interruptArgFromCell(cell, wide) {
  if (!cell) return -1;
  if (cell.effect === EffectOp.OP_COLON) return cell.effectArg & 0xffff;
  if (wide && cell.effect2 === EffectOp.OP_COLON) return cell.effectArg2 & 0xffff;
  return -1;
}

/**
 * The typed argument → 0‥65535, `null` for a blank field (no argument), or
 * NaN for anything that is not one to four hex digits. A leading `$` or `0x`
 * is accepted, since that is how the rest of the app writes hex.
 */
export function parseInterruptArg(text) {
  const s = String(text ?? "").trim();
  if (s === "") return null;
  const m = /^(?:\$|0x)?([0-9a-f]{1,4})$/i.exec(s);
  return m ? parseInt(m[1], 16) : NaN;
}

/**
 * The fields to write for interrupt `n` with argument `arg` (`null` = none).
 *
 * The `:` goes where the player will read it as THE argument: a slot already
 * holding a `:` first (left one first, since the left one wins), then an empty
 * slot, and only failing both does it take over the first effect slot — the
 * second slot exists in a wide (v3) cell only.
 */
export function interruptFields(cell, n, arg, wide) {
  const fields = { note: INT_BASE + (n & 0xf) };
  if (arg === null || arg === undefined) return fields;
  const value = arg & 0xffff;
  const e1 = cell?.effect ?? 0;
  const e2 = cell?.effect2 ?? 0;
  let second = false;
  if (e1 === EffectOp.OP_COLON) second = false;
  else if (wide && e2 === EffectOp.OP_COLON) second = true;
  else if (e1 === 0) second = false;
  else if (wide && e2 === 0) second = true;
  if (second) {
    fields.effect2 = EffectOp.OP_COLON;
    fields.effectArg2 = value;
  } else {
    fields.effect = EffectOp.OP_COLON;
    fields.effectArg = value;
  }
  return fields;
}

// ── the popup ────────────────────────────────────────────────────────────

/**
 * @param target {channel, rowLabel, wide, cell, apply(fields)} — the cursor's
 *               cell (the command palette's context); `wide` is format v3's
 *               second effect slot (§5.5)
 * @returns Promise<boolean> — whether anything was written
 */
export function showInterruptDialog(target) {
  return new Promise((resolve) => {
    const wide = target?.wide === true;
    const cell = target?.cell ?? null;
    const curN = interruptNumberOf(cell?.note ?? 0);
    const curArg = curN >= 0 ? interruptArgFromCell(cell, wide) : -1;

    const dlg = document.createElement("dialog");
    dlg.className = "modal modal-text interrupt-modal";
    const h = document.createElement("h3");
    h.textContent = t("interrupt.title");
    const info = document.createElement("p");
    info.className = "dim";
    info.textContent = target
      ? t("interrupt.writesTo", { ch: target.channel + 1, row: target.rowLabel })
      : t("interrupt.noCell");

    const form = document.createElement("div");
    form.className = "modal-form";
    const mkField = (labelKey, control) => {
      const lab = document.createElement("label");
      lab.className = "modal-field";
      const cap = document.createElement("span");
      cap.className = "modal-label";
      cap.textContent = t(labelKey);
      lab.append(cap, control);
      form.appendChild(lab);
      return lab;
    };

    const numSel = document.createElement("select");
    for (let n = 0; n < 16; n++) {
      const o = document.createElement("option");
      o.value = String(n);
      o.textContent = `Int${n.toString(16).toUpperCase()}`;
      numSel.appendChild(o);
    }
    numSel.value = String(Math.max(0, curN));
    mkField("interrupt.number", numSel);

    const argInp = document.createElement("input");
    argInp.type = "text";
    argInp.size = 6;
    argInp.maxLength = 6;
    argInp.spellcheck = false;
    argInp.autocomplete = "off";
    argInp.placeholder = t("interrupt.argPlaceholder");
    argInp.className = "interrupt-arg";
    if (curArg >= 0) argInp.value = curArg.toString(16).toUpperCase().padStart(4, "0");
    mkField("interrupt.argument", argInp);

    const hint = document.createElement("p");
    hint.className = "modal-hint";
    form.appendChild(hint);

    const btnRow = document.createElement("div");
    btnRow.className = "modal-buttons";
    const ok = document.createElement("button");
    ok.textContent = t("common.ok");
    const cancel = document.createElement("button");
    cancel.textContent = t("common.cancel");
    btnRow.append(ok, cancel);

    dlg.append(h, info, form, btnRow);
    document.body.appendChild(dlg);

    // The hint says what OK will write, so the optional argument's two
    // outcomes are visible before committing to either.
    const sync = () => {
      const n = parseInt(numSel.value, 10);
      const arg = parseInterruptArg(argInp.value);
      const name = `Int${n.toString(16).toUpperCase()}`;
      if (Number.isNaN(arg)) {
        hint.textContent = t("interrupt.badArg");
        argInp.setAttribute("aria-invalid", "true");
      } else {
        argInp.removeAttribute("aria-invalid");
        hint.textContent = arg === null
          ? t("interrupt.writesNoArg", { name })
          : t("interrupt.writesArg", { name, arg: arg.toString(16).toUpperCase().padStart(4, "0") });
      }
      ok.disabled = target === null || Number.isNaN(arg);
    };
    numSel.addEventListener("change", sync);
    argInp.addEventListener("input", sync);
    sync();

    const finish = (wrote) => {
      dlg.close();
      dlg.remove();
      resolve(wrote);
    };
    const commit = () => {
      if (ok.disabled || !target) return;
      const n = parseInt(numSel.value, 10);
      const arg = parseInterruptArg(argInp.value);
      target.apply(interruptFields(cell, n, arg, wide));
      finish(true);
    };
    ok.addEventListener("click", (e) => { e.preventDefault(); commit(); });
    cancel.addEventListener("click", (e) => { e.preventDefault(); finish(false); });
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(false); });
    dlg.addEventListener("keydown", (e) => {
      e.stopPropagation(); // keep the grid's piano/transport keys out of the dialog
      if (e.key === "Enter" && e.target.tagName !== "BUTTON") { e.preventDefault(); commit(); }
    });

    dlg.showModal();
    numSel.focus();
  });
}
