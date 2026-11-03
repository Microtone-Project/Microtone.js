// A character palette — keys that type what a typing keyboard has not got:
// the IPA keyboard under a lyric instrument's lyrics, or any text field whose
// characters are phonetic symbols, marks or notation.
//
// Groups of keys, each a caption and its keys. A key types its text into the
// target field at the caret, replacing the selection, exactly as typing it
// would — an `input` event follows, so the field's own handlers see it — and
// the field KEEPS the focus: a press never takes it (the keys are not focus
// targets for the pointer), so a field that commits on blur is not committed
// by a key, and typing goes on where it was.
//
// A combining mark is shown on a dotted circle (◌̃), the way a chart shows one,
// but types the mark alone. The keys are drawn in the face the app shows IPA
// in, and tell what they are in their tooltip.

const DOTTED_CIRCLE = "◌";

/** Is `ch` a combining mark (it needs a base to be seen)? */
const isCombining = (ch) => /^\p{M}$/u.test(ch);

/**
 * A palette. `groups` is [{label, keys: [string | {text, label?, title?}]}];
 * `target` the <input> or <textarea> the keys type into (or a function that
 * answers it, read at each press). Returns { element, setTarget(field) }.
 */
export function charPalette({ groups, target, className = "" }) {
  const element = document.createElement("div");
  element.className = className ? `char-palette ${className}` : "char-palette";
  let field = target;
  const fieldNow = () => (typeof field === "function" ? field() : field);

  const type = (text) => {
    const f = fieldNow();
    if (!f) return;
    const start = f.selectionStart ?? f.value.length;
    const end = f.selectionEnd ?? start;
    f.setRangeText(text, start, end, "end");
    f.dispatchEvent(new Event("input", { bubbles: true }));
    if (document.activeElement !== f) f.focus();
  };

  for (const g of groups) {
    const row = document.createElement("div");
    row.className = "char-pal-group";
    row.setAttribute("role", "group");
    if (g.label) {
      const cap = document.createElement("span");
      cap.className = "char-pal-label";
      cap.textContent = g.label;
      row.setAttribute("aria-label", g.label);
      row.appendChild(cap);
    }
    for (const k of g.keys) {
      const key = typeof k === "string" ? { text: k } : k;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "char-pal-key";
      b.textContent = key.label ?? ([...key.text].every(isCombining) ? DOTTED_CIRCLE + key.text : key.text);
      if (key.title) { b.title = key.title; b.setAttribute("aria-label", key.title); }
      // Keep the focus in the field: the pointer never moves it here.
      b.addEventListener("pointerdown", (e) => e.preventDefault());
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => type(key.text));
      row.appendChild(b);
    }
    element.appendChild(row);
  }
  return { element, setTarget(f) { field = f; } };
}
