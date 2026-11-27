// MIDI (item 379): the top bar's badge, what is chosen and remembered, and
// where each port's messages go — the control surface's to the ControlSurface
// (surface.js), every keyboard's to the MasterKeyboard (masterkeyboard.js).
//
// Two kinds of device: KEYBOARDS, any number of them at once, and ONE control
// surface (an input and its output). A port is one or the other, never both.
// The configuration is a panel of its own (midipanel.js), shown by the badge
// in a dialog and, in the desktop app, in the Settings tab's MIDI category;
// every change in it applies at once.
//
// What is chosen is remembered by NAME in this browser (the desktop app's
// profile is a browser's), and a device that is not plugged in is opened the
// moment it is. A browser that has already been given MIDI reconnects
// without asking; one that has not waits for the badge, so no permission
// prompt ever appears unasked for.

import { MidiPorts, midiAvailable, midiGranted, partnerOutput } from "../midi/ports.js";
import { parseKbm } from "../midi/kbm.js";
import { showNotice } from "./components/modal.js";
import { actionRow } from "./components/actions.js";
import { buildMidiPanel } from "./midipanel.js";
import { t, onLangChange } from "./i18n.js";

const SURFACE_KEY = "microtone-surface";
const KEYBOARD_KEY = "microtone-midi-keyboards";

function read(key) {
  try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return null; }
}
function write(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* private mode: not remembered */ }
}

function loadSurfacePref() {
  const v = read(SURFACE_KEY);
  return v && typeof v.input === "string" ? { input: v.input, output: typeof v.output === "string" ? v.output : null } : null;
}

/** The keyboards' settings: the inputs chosen, the mapping (its file's name
 *  and text, read again at every start) and whether velocity is written. */
function loadKeyboardPref() {
  const v = read(KEYBOARD_KEY) ?? {};
  const inputs = Array.isArray(v.inputs) ? v.inputs.filter((n) => typeof n === "string" && n !== "") : [];
  let kbm = null;
  if (v.kbm && typeof v.kbm.name === "string" && typeof v.kbm.text === "string") {
    try { kbm = { name: v.kbm.name, text: v.kbm.text, map: parseKbm(v.kbm.text) }; } catch { kbm = null; }
  }
  return { inputs: [...new Set(inputs)], kbm, velocity: v.velocity === true };
}
function saveKeyboardPref(p) {
  write(KEYBOARD_KEY, {
    inputs: p.inputs, velocity: p.velocity,
    kbm: p.kbm ? { name: p.kbm.name, text: p.kbm.text } : null,
  });
}

/**
 * Wire `surface` (a ControlSurface) and `keyboard` (a MasterKeyboard) to the
 * MIDI ports behind `badge`. Returns the link the panel works through, and
 * {frame()} for the app's animation frame. Where the page cannot reach MIDI
 * at all the badge stays hidden and the link says it is unavailable.
 */
export function startMidiLink({ surface, keyboard, badge }) {
  if (!midiAvailable()) return { available: false, frame() {} };
  badge.hidden = false;
  let ports = null;
  let attachedTo = null;   // the output the surface was last attached to
  let openKeyboards = [];  // the keyboards open when the ports last changed
  let surfacePref = loadSurfacePref();
  const keyPref = loadKeyboardPref();
  keyboard.kbm = keyPref.kbm?.map ?? null;
  keyboard.velocity = keyPref.velocity;
  const listeners = new Set();

  function refresh() {
    const kb = ports?.keyboardNames ?? [];
    const sIn = ports?.inputName ?? null;
    const wished = surfacePref !== null || keyPref.inputs.length > 0;
    const on = kb.length > 0 || sIn !== null;
    const text = on ? t("topbar.midiOn") : wished ? t("topbar.midiWaiting") : t("topbar.midiOff");
    if (badge.textContent !== text) badge.textContent = text;
    badge.classList.toggle("on", on);
    // The names live in the tooltip: on the bar they made the badge too long.
    const lines = [t("topbar.midiTitle")];
    if (kb.length) lines.push(t("topbar.midiTitleKeyboards", { names: kb.join(", ") }));
    if (sIn) lines.push(t("topbar.midiTitleSurface", { name: sIn }));
    const title = lines.join("\n");
    if (badge.title !== title) badge.title = title;
  }

  function changed() {
    refresh();
    for (const fn of listeners) fn();
  }

  function portsChanged() {
    const out = ports?.outputName ?? null;
    if (out !== attachedTo) {
      attachedTo = out;
      surface.attach(out ? (bytes) => ports.send(bytes) : null);
    }
    // A keyboard that went (unplugged, or no longer chosen) lets go of its keys.
    const now = ports?.keyboardNames ?? [];
    for (const name of openKeyboards) if (!now.includes(name)) keyboard.forget(name);
    openKeyboards = now.slice();
    changed();
  }

  async function ensure() {
    if (ports) return ports;
    const p = new MidiPorts();
    p.onSurface = (bytes) => surface.receive(bytes);
    p.onKeyboard = (bytes, name) => keyboard.receive(bytes, name);
    p.onChange = portsChanged;
    await p.start();
    if (ports) { p.close(); return ports; } // a second caller got there first
    ports = p;
    openWish();
    return p;
  }

  /** Hand the whole wish to the ports: the surface's pair and the keyboards. */
  function openWish() {
    if (!ports) return;
    const output = surfacePref ? surfacePref.output ?? partnerOutput(surfacePref.input, ports.outputs()) : null;
    ports.open(surfacePref?.input ?? null, output, keyPref.inputs);
    portsChanged();
  }

  const link = {
    available: true,
    frame: () => surface.frame(),
    /** Get the ports (the browser may ask the person). Throws when refused. */
    ensure,
    get ports() { return ports; },
    /** Hear every change: ports, choices. Returns the way to stop. */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    surfacePref: () => surfacePref,
    useSurface(next) {
      if (surfacePref && !next?.input) surface.goodbye();
      surfacePref = next?.input ? { input: next.input, output: next.output || null } : null;
      write(SURFACE_KEY, surfacePref);
      // The surface's input is never a keyboard as well.
      if (surfacePref && keyPref.inputs.includes(surfacePref.input)) {
        keyPref.inputs = keyPref.inputs.filter((n) => n !== surfacePref.input);
        saveKeyboardPref(keyPref);
      }
      if (ports) openWish(); else changed();
    },

    keyboards: () => keyPref.inputs.slice(),
    setKeyboard(name, on) {
      const has = keyPref.inputs.includes(name);
      if (on === has) return;
      keyPref.inputs = on ? [...keyPref.inputs, name] : keyPref.inputs.filter((n) => n !== name);
      if (on && surfacePref?.input === name) {
        surface.goodbye();
        surfacePref = null;
        write(SURFACE_KEY, null);
      }
      saveKeyboardPref(keyPref);
      if (ports) openWish(); else changed();
    },

    /** The mapping in use: {name, map}, or null (a key a degree). */
    kbm: () => (keyPref.kbm ? { name: keyPref.kbm.name, map: keyPref.kbm.map } : null),
    /** Use the mapping in `text` (a .kbm file called `name`), or none with
     *  null. Throws, keeping the one in use, when the text is not one. */
    setKbm(name, text) {
      if (text === null) {
        keyPref.kbm = null;
      } else {
        keyPref.kbm = { name, text, map: parseKbm(text) };
      }
      keyboard.kbm = keyPref.kbm?.map ?? null;
      saveKeyboardPref(keyPref);
      changed();
    },

    velocity: () => keyPref.velocity,
    setVelocity(on) {
      keyPref.velocity = !!on;
      keyboard.velocity = keyPref.velocity;
      saveKeyboardPref(keyPref);
      changed();
    },

    /** The badge's dialog: the panel, applied as it is changed, and Close. */
    async openDialog() {
      try {
        await ensure();
      } catch (err) {
        showNotice({ title: t("midiSetup.title"), body: t("surface.refused", { err: err?.message ?? String(err) }) });
        return;
      }
      const dlg = document.createElement("dialog");
      dlg.className = "modal midi-dialog";
      const h = document.createElement("h3");
      h.textContent = t("midiSetup.title");
      const panel = buildMidiPanel(link);
      const { row, dismiss } = actionRow({ dismiss: true });
      dlg.append(h, panel.root, row);
      document.body.appendChild(dlg);
      const finish = () => { panel.dispose(); dlg.close(); dlg.remove(); };
      dismiss.addEventListener("click", (e) => { e.preventDefault(); finish(); });
      dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); });
      dlg.addEventListener("keydown", (e) => e.stopPropagation());
      dlg.showModal();
      dismiss.focus();
    },
  };

  badge.addEventListener("click", () => link.openDialog());
  badge.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation(); // Space is the transport's everywhere else
    link.openDialog();
  });

  refresh();
  onLangChange(refresh);
  // A page that goes (a reload, the app closing) leaves the surface dark
  // rather than showing a song nobody is playing. The desktop's shell
  // dispatches this pagehide itself before it quits (QtWebEngine sends none),
  // and waits for the flush that follows the goodbye.
  window.addEventListener("pagehide", () => {
    surface.goodbye();
    ports?.flush();
  });
  // Reconnect what was chosen last time, if that needs nobody's permission.
  if (surfacePref || keyPref.inputs.length) {
    midiGranted().then(async (granted) => {
      if (!granted || ports) return;
      try {
        await ensure();
      } catch (err) {
        console.warn("MIDI: could not reopen the ports", err);
      }
    });
  }

  return link;
}
