// A pushbutton with a lamp — the instrument panel's on/off for an OPTION:
// Sync, True peak, Ping-pong, a chain's Enabled, an envelope's Loop.
//
// It stands in for a checkbox, which was too small a target for a control
// pressed while listening, on a touchscreen as often as with a mouse. The whole
// button is the target; the lamp at its left says whether the option is on —
// lit in the meter's green, a dark trough while off — so the label stays the
// option's NAME and never has to say its state. The lamp is the same
// `.seg-lamp` the segmented rows carry for a band's own on/off, so "this part
// is on" reads alike wherever it is shown.
//
// What it is NOT for: switching a piece of equipment (or a band of one) in and
// out of the signal — that is a flip switch (flipswitch.js), in the piece's
// titlebar; and picking one of a few choices — that is a segmented row.
//
// The state lives with the caller. `setOn(v)` shows a state without reporting
// it (a view's refresh after undo); a press flips the shown state and reports
// the new one through `onChange`. Both write the DOM only when the state moved.

/**
 * A lamp pushbutton. `label` is the option's name, or a pair [offText, onText]
 * where the row already names the option and the button says its state (the
 * instrument editor's On / Off). `on` is the initial state. Returns
 * { button, isOn(), setOn(on) }.
 */
export function lampButton({ label, on = false, onChange = null, title = "", disabled = false, className = "" }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className ? `lamp-btn ${className}` : "lamp-btn";
  if (title) button.title = title;
  button.disabled = !!disabled;
  const lamp = document.createElement("span");
  lamp.className = "seg-lamp";
  lamp.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.className = "lamp-text";
  // A fixed label is written once, so a page that translates its own static
  // text (index.html's data-i18n) can relabel it without being undone here.
  if (!Array.isArray(label)) text.textContent = label;
  button.append(lamp, text);

  let state = null;
  const setOn = (v) => {
    v = !!v;
    if (v === state) return;
    state = v;
    lamp.classList.toggle("lit", v);
    button.setAttribute("aria-pressed", String(v));
    if (Array.isArray(label)) text.textContent = label[v ? 1 : 0];
  };
  setOn(on);
  button.addEventListener("click", () => {
    setOn(!state);
    onChange?.(state);
  });
  return { button, isOn: () => state, setOn };
}
