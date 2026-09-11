// Contextual command palette (screen bottom) — contents follow the cursor's
// sub-column: sentinel inserts on the note column, selector buttons on the
// vol/pan columns, an effect-opcode chooser on the fx-op column, and argument
// documentation (no commands) on the fx-arg column.

import {
  SUB_NOTE, SUB_INST, SUB_VOL, SUB_PAN, SUB_FX_OP, SUB_FX_ARG,
  SUB_FX2_OP, SUB_FX2_ARG,
  volPanOp, volPanSelect,
} from "./edit.js";
import { t } from "./i18n.js";
import { EffectOp, EXT_CAPABLE_OPS } from "../engine/tables.js";

// Effect reference (TAUD_NOTE_EFFECTS.md digest): opcode → button label (l).
// The displayed name/argument-format text is looked up in the language table
// under `pal.fx.<l>.n` / `pal.fx.<l>.a` (see fxName/fxArg below) — the strings
// themselves live in lang/en.js (source of truth) and its translations.
export const FX_INFO = {
  0x01: { l: "1" },
  0x02: { l: "2" },
  0x03: { l: "3" },
  0x04: { l: "4" },
  0x05: { l: "5" },
  0x06: { l: "6" },
  0x07: { l: "7" },
  0x08: { l: "8" },
  0x09: { l: "9" },
  0x0a: { l: "A" },
  0x0b: { l: "B" },
  0x0c: { l: "C" },
  0x0d: { l: "D" },
  0x0e: { l: "E" },
  0x0f: { l: "F" },
  0x10: { l: "G" },
  0x11: { l: "H" },
  0x12: { l: "I" },
  0x13: { l: "J" },
  0x14: { l: "K" },
  0x15: { l: "L" },
  0x16: { l: "M" },
  0x17: { l: "N" },
  0x18: { l: "O" },
  0x19: { l: "P" },
  0x1a: { l: "Q" },
  0x1b: { l: "R" },
  0x1c: { l: "S" },
  0x1d: { l: "T" },
  0x1e: { l: "U" },
  0x1f: { l: "V" },
  0x20: { l: "W" },
  0x21: { l: "X" },
  0x22: { l: "Y" },
  0x23: { l: "Z" },
  // Item 162: the ASCII-symbol opcode space opened once base-36 filled.
  // `:`'s own name/argument text (pal.fx.:.n/.a) is the UNPAIRED / not-yet-
  // extending-anything description — see fxArgHint below for the paired one,
  // and for the interrupt-argument reading an Int row gives it (item 181).
  0xba: { l: ":" },
};

/** An effect's display name / argument format. Exported because the right-click
 *  quick palette (blocktools.js) labels the same opcodes and must not drift. */
export const fxName = (info) => t(`pal.fx.${info.l}.n`);
export const fxArg = (info) => t(`pal.fx.${info.l}.a`);

/**
 * The SUB_FX_ARG/SUB_FX2_ARG hint for opcode `cur`, given `other` — the
 * OTHER effect slot on the same row (item 162) — and `note`, the row's note
 * word (item 181). Everywhere but the `:` readings this reduces to the plain
 * `fxArg` text; those read the CONTEXTUAL description instead of "unknown
 * opcode" / the base command's isolated one, matching the field colouring
 * notenames.fxArgFields already gives the same pairings.
 *
 * The note matters because on an interrupt row a `:` is not an extension at
 * all — it is that interrupt's argument, which is a different sentence to put
 * under the cell even when the same colon ALSO extends a J beside it. Pure
 * (no DOM) — testable directly.
 */
export function fxArgHint(cur, other, note = 0) {
  const info = FX_INFO[cur];
  if (!info) return cur === 0 ? t("pal.noEffect") : t("pal.unknownOpcode");
  const onInterrupt = note >= 0x0010 && note <= 0x001f;
  let desc;
  if (cur === EffectOp.OP_COLON) {
    if (onInterrupt) desc = t("pal.fx.:.aInt");
    else if (other === EffectOp.OP_J) desc = t("pal.fx.:.aJ");
    else if (other === EffectOp.OP_O) desc = t("pal.fx.:.aO");
    else if (other === EffectOp.OP_2 || other === EffectOp.OP_3) desc = t("pal.fx.:.aMod");
    else desc = fxArg(info);
  } else if (other === EffectOp.OP_COLON && EXT_CAPABLE_OPS.has(cur)) {
    desc = t(`pal.fx.${info.l}.aExt`);
  } else {
    desc = fxArg(info);
  }
  return `${info.l} ${fxName(info)}: ${desc}`;
}

export class CommandPalette {
  /** getContext() → {sub, cell, apply(fields)} | null */
  constructor(host, getContext) {
    this.host = host;
    this.getContext = getContext;
    this.lastKey = null;
  }

  refresh() {
    const ctx = this.getContext();
    if (!ctx) {
      this.host.hidden = true;
      this.lastKey = null;
      return;
    }
    // The vol/pan buttons highlight by OPERATION, and a fine slide's direction
    // lives in the value's bit 5 — so the key tracks the op, not the selector
    // (and not the whole value, which would re-render on every digit typed).
    const wide = ctx.wide === true;
    const panVal = ctx.cell ? (wide ? ctx.cell.azimuth : ctx.cell.pan) : 0;
    // Item 162: effect2 has to be in the key too — a `:` pairing's hint and
    // colouring depend on the OTHER slot, so editing it must re-render this
    // one even though ctx.sub and ctx.cell.effect haven't moved.
    // Item 181: which INTERRUPT the note column holds (and only that — an
    // ordinary note changes nothing on this bar, so putting the whole note word
    // in the key would rebuild 21 buttons on every cursor step down a column).
    const intNote = ctx.cell && ctx.cell.note >= 0x0010 && ctx.cell.note <= 0x001f
      ? ctx.cell.note : -1;
    const key = `${ctx.sub}:${ctx.cell?.effect ?? -1}:${ctx.cell?.effect2 ?? -1}:${wide}:${intNote}:` +
      `${ctx.cell ? volPanOp(ctx.cell.volume, ctx.cell.volumeEff, false, wide) : ""}:` +
      `${ctx.cell ? volPanOp(panVal, ctx.cell.panEff, true, wide) : ""}`;
    if (key === this.lastKey && !this.host.hidden) return; // avoid re-render churn
    this.lastKey = key;
    this.host.hidden = false;
    this.host.innerHTML = "";

    const label = (text) => {
      const s = document.createElement("span");
      s.className = "pal-label";
      s.textContent = text;
      this.host.appendChild(s);
    };
    const btn = (text, title, onClick, active = false) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.title = title ?? "";
      if (active) b.classList.add("active");
      b.addEventListener("click", () => { onClick(); this.lastKey = null; this.refresh(); });
      this.host.appendChild(b);
      return b;
    };
    const hint = (text) => {
      const s = document.createElement("span");
      s.className = "pal-hint";
      s.textContent = text;
      this.host.appendChild(s);
    };

    switch (ctx.sub) {
      case SUB_NOTE:
        label(t("pal.note"));
        btn(t("pal.sentKeyOff"), t("pal.sentKeyOffTitle"), () => ctx.apply({ note: 0x0001 }));
        btn(t("pal.sentCut"), t("pal.sentCutTitle"), () => ctx.apply({ note: 0x0002 }));
        btn(t("pal.sentFade"), t("pal.sentFadeTitle"), () => ctx.apply({ note: 0x0003 }));
        btn(t("pal.sentFastFade"), t("pal.sentFastFadeTitle"), () => ctx.apply({ note: 0x0004 }));
        btn(t("pal.clear"), t("pal.clearNoteTitle"), () => ctx.apply({ note: 0, instrment: 0 }));
        // Interrupt markers (item 181). Sixteen of them, so they get their own
        // label and a row of bare hex digits rather than sixteen "Int n"
        // buttons — the fx chooser next door already reads this way.
        label(t("pal.interrupt"));
        for (let n = 0; n < 16; n++) {
          btn(n.toString(16).toUpperCase(), t("pal.interruptTitle"),
            () => ctx.apply({ note: 0x0010 + n }), ctx.cell?.note === 0x0010 + n);
        }
        hint(t("pal.noteHint"));
        break;
      case SUB_INST:
        label(t("pal.instrument"));
        hint(t("pal.instHint"));
        break;
      // The vol/pan buttons drive the same operation model as the symbol cell
      // (item 87): picking one re-interprets the argument already in the cell,
      // and a fine slide seeds a magnitude of 1 rather than the $C0 no-op.
      case SUB_VOL: {
        label(t("pal.volColumn"));
        const op = volPanOp(ctx.cell.volume, ctx.cell.volumeEff, false, wide);
        const pick = (o) => () => { const f = volPanSelect(false, o, ctx.cell, wide); if (f) ctx.apply(f); };
        btn(t("pal.volSet"), t("pal.volSetTitle"), pick("set"), op === "set");
        btn(t("pal.slideUp"), t("pal.slideUpTitle"), pick("up"), op === "up");
        btn(t("pal.slideDn"), t("pal.slideDnTitle"), pick("down"), op === "down");
        btn(t("pal.fineUp"), t("pal.volFineUpTitle"), pick("fineUp"), op === "fineUp");
        btn(t("pal.fineDn"), t("pal.volFineDnTitle"), pick("fineDown"), op === "fineDown");
        btn(t("pal.clear"), t("pal.noopTitle"), () => ctx.apply({ volume: 0, volumeEff: 3 }));
        hint(t("pal.volHint"));
        break;
      }
      case SUB_PAN: {
        label(t("pal.panColumn"));
        const op = volPanOp(panVal, ctx.cell.panEff, true, wide);
        const pick = (o) => () => { const f = volPanSelect(true, o, ctx.cell, wide); if (f) ctx.apply(f); };
        btn(t("pal.panSet"), t("pal.panSetTitle"), pick("set"), op === "set");
        btn(t("pal.slideLeft"), t("pal.slideLeftTitle"), pick("down"), op === "down");
        btn(t("pal.slideRight"), t("pal.slideRightTitle"), pick("up"), op === "up");
        btn(t("pal.fineUp"), t("pal.panFineUpTitle"), pick("fineUp"), op === "fineUp");
        btn(t("pal.fineDn"), t("pal.panFineDnTitle"), pick("fineDown"), op === "fineDown");
        btn(t("pal.clear"), t("pal.noopTitle"), () => ctx.apply(
          wide ? { azimuth: 0, elevation: 0, panEff: 3 } : { pan: 0, panEff: 3 }));
        hint(t(wide ? "pal.panHintWide" : "pal.panHint"));
        break;
      }
      // Both effect columns are the same chooser, aimed at a different pair of
      // fields — the second effect runs after the first on every pass (§5.5),
      // so it takes the same opcodes and the same arguments.
      case SUB_FX_OP:
      case SUB_FX2_OP: {
        const second = ctx.sub === SUB_FX2_OP;
        const cur = second ? ctx.cell.effect2 : ctx.cell.effect;
        const set = (op) => (second ? { effect2: op } : { effect: op });
        label(t(second ? "pal.effect2" : "pal.effect"));
        for (const [op, info] of Object.entries(FX_INFO)) {
          btn(info.l, `${fxName(info)} — ${fxArg(info)}`, () => ctx.apply(set(parseInt(op, 10))),
            cur === parseInt(op, 10));
        }
        btn("×", t("pal.clearFxTitle"), () => ctx.apply(
          second ? { effect2: 0, effectArg2: 0 } : { effect: 0, effectArg: 0 }));
        break;
      }
      case SUB_FX_ARG:
      case SUB_FX2_ARG: {
        const second = ctx.sub === SUB_FX2_ARG;
        const cur = second ? ctx.cell.effect2 : ctx.cell.effect;
        const other = second ? ctx.cell.effect : ctx.cell.effect2;
        label(t("pal.argument"));
        hint(fxArgHint(cur, other, ctx.cell?.note ?? 0));
        break;
      }
    }
  }
}
