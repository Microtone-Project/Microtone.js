// A flip switch — puts a piece of equipment, or one band of it, into the
// signal or bypasses it: the Mixing tab's and the Mastering tab's units, an
// EQ's bands.
//
// It is the one control on the instrument panel that is about the SIGNAL PATH
// rather than a setting, so it looks unlike the rest: a track with a knob, ON
// with the knob at the right end and the track filled with the theme's accent,
// OFF with the knob at the left and no fill at all. Filled is "in circuit";
// that is a state, so the accent here does not compete with Proceed, which is
// an action. It sits at the right end of the piece's titlebar, opposite the
// fold twisty, and keeps working while the piece is folded.
//
// It is a real button with role="switch", so Tab reaches it and Space and
// Enter flip it. The state lives with the caller, as for lampbutton.js:
// `setOn(v)` shows a state without reporting it; a press flips it and reports
// the new state through `onChange`; the DOM is written only on a change.

/**
 * A flip switch. `label` names what it switches (the accessible name; the
 * switch shows no text). Returns { button, isOn(), setOn(on) }.
 */
export function flipSwitch({ label = "", on = false, onChange = null, title = "", disabled = false, className = "" }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className ? `flip-switch ${className}` : "flip-switch";
  button.setAttribute("role", "switch");
  if (label) button.setAttribute("aria-label", label);
  if (title) button.title = title;
  button.disabled = !!disabled;
  const knob = document.createElement("span");
  knob.className = "flip-knob";
  knob.setAttribute("aria-hidden", "true");
  button.append(knob);

  let state = null;
  const setOn = (v) => {
    v = !!v;
    if (v === state) return;
    state = v;
    button.setAttribute("aria-checked", String(v));
  };
  setOn(on);
  button.addEventListener("click", () => {
    setOn(!state);
    onChange?.(state);
  });
  return { button, isOn: () => state, setOn };
}
