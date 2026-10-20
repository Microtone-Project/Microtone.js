// The action row at the foot of a dialog — the ONE place that decides where a
// dialog's buttons go and how they look (design-system/README.md, "Dialog
// actions"). Every dialog in the app builds its row here, so the rule holds by
// construction rather than by everyone remembering it:
//
//   [Cancel]                                 [alternative …] [Proceed]
//
// - cancel        abandons the dialog: nothing it was about to do happens.
//                 Always the LEFT end, so it is in the same place every time.
//                 Esc does the same (the <dialog>'s own `cancel` event).
// - proceed       does what the dialog is for — Apply, Create, Import, Delete.
//                 Always the RIGHT end, and the one coloured button: `.proceed`
//                 fills it with the theme's --proceed-bg and sets its label at
//                 --weight-proceed, 200 heavier than every other button's.
//                 At most one per dialog.
// - alternatives  other actions that do NOT cancel (Preview, Record, Import as
//                 new, Clear …). Neutral, PREPENDED to Proceed — immediately left of
//                 it, in the order given.
// - dismiss       the one button of a dialog that has nothing to commit and
//                 nothing to abandon (About, a notice, a finished log, a panel
//                 whose edits apply live). Neutral, at the right end. Never
//                 together with cancel or proceed: a dialog that can be
//                 cancelled has something to proceed with.
//
// Non-button content that belongs with the actions — a status line, an option
// that changes what Proceed does — goes in `extras`, laid out just before the
// alternatives.
//
// The buttons come back by role, so a caller wires them directly instead of
// finding them again with querySelector; `className` on a spec keeps an
// existing hook (tests and stylesheet rules that name `.chord-ok`) working.

import { t } from "../i18n.js";
import { setIconLabel } from "../icons.js";

/**
 * A button spec is a label string, `true` for the role's default label
 * (cancel: "Cancel", dismiss: "Close"), or
 * `{ label, icon, iconAfter, title, className, disabled }` — `icon` names a
 * BTN_ICON (icons.js), drawn before the label (after it with `iconAfter`).
 *
 * @returns {{ row: HTMLDivElement, cancel: HTMLButtonElement|null,
 *   proceed: HTMLButtonElement|null, dismiss: HTMLButtonElement|null,
 *   alternatives: HTMLButtonElement[] }}
 */
export function actionRow({ cancel = null, alternatives = [], proceed = null, dismiss = null,
  extras = [], className = "" } = {}) {
  if (dismiss && (cancel || proceed)) {
    throw new Error("actionRow: a dismiss button stands alone — use cancel + proceed instead");
  }
  const row = document.createElement("div");
  row.className = className ? `modal-buttons ${className}` : "modal-buttons";
  const out = {
    row,
    cancel: cancel ? actionButton(cancel, "cancel") : null,
    alternatives: alternatives.filter(Boolean).map((spec) => actionButton(spec, "alt")),
    proceed: proceed ? actionButton(proceed, "proceed") : null,
    dismiss: dismiss ? actionButton(dismiss, "dismiss") : null,
  };
  // DOM order IS the visual order (and the Tab order): Cancel first, Proceed
  // last. The stylesheet only pushes Cancel to the far left.
  row.append(...[out.cancel, ...extras, ...out.alternatives, out.proceed, out.dismiss].filter(Boolean));
  return out;
}

/** One action button in a role's dress, outside a row — for the odd place
 *  that has a Proceed of its own (a form that is not a dialog). */
export function actionButton(spec, role) {
  const s = typeof spec === "object" && spec !== null ? spec : { label: spec };
  const label = typeof s.label === "string" ? s.label
    : role === "cancel" ? t("common.cancel")
    : role === "dismiss" ? t("common.close")
    : "";
  const b = document.createElement("button");
  b.type = "button";
  b.className = ROLE_CLASS[role] + (s.className ? ` ${s.className}` : "");
  if (s.icon) setIconLabel(b, s.icon, label, { after: !!s.iconAfter });
  else b.textContent = label;
  if (s.title) b.title = s.title;
  if (s.disabled) b.disabled = true;
  return b;
}

/** The class each role wears. `proceed` is also a plain button variant
 *  (microtone.css), which is why it is not prefixed. */
export const ROLE_CLASS = Object.freeze({
  cancel: "act-cancel",
  alt: "act-alt",
  proceed: "proceed",
  dismiss: "act-dismiss",
});
