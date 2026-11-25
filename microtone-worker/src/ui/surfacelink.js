// The control surface's connection (item 379): the top bar's badge, the
// dialog that picks its ports, and reconnecting at the next start.
//
// The ports chosen are remembered by NAME in this browser (the desktop app's
// profile is a browser's), and a surface that is not plugged in is opened
// the moment it is. A browser that has already been given MIDI reconnects
// without asking; one that has not waits for the badge, so no permission
// prompt ever appears unasked for.

import { MidiPorts, midiAvailable, midiGranted, partnerOutput, looksLikeSurface } from "../midi/ports.js";
import { showModal, showNotice } from "./components/modal.js";
import { t, onLangChange } from "./i18n.js";

const PREF_KEY = "microtone-surface";

function loadPref() {
  try {
    const v = JSON.parse(localStorage.getItem(PREF_KEY) ?? "null");
    return v && typeof v.input === "string" ? { input: v.input, output: typeof v.output === "string" ? v.output : null } : null;
  } catch {
    return null;
  }
}
function savePref(pref) {
  try {
    if (pref) localStorage.setItem(PREF_KEY, JSON.stringify(pref));
    else localStorage.removeItem(PREF_KEY);
  } catch { /* private mode: not remembered */ }
}

/**
 * Wire `surface` (a ControlSurface) to the MIDI ports behind `badge`. Returns
 * {frame()} for the app's animation frame. Where the page cannot reach MIDI
 * at all the badge stays hidden and nothing else happens.
 */
export function startSurfaceLink(surface, badge) {
  if (!midiAvailable()) return { frame() {} };
  badge.hidden = false;
  let ports = null;
  let attachedTo = null; // the output the surface was last attached to
  let pref = loadPref();

  function refresh() {
    const name = ports?.inputName ?? null;
    const text = name ? t("topbar.surfaceOn", { name }) : pref ? t("topbar.surfaceWaiting") : t("topbar.surfaceOff");
    if (badge.textContent !== text) badge.textContent = text;
    badge.classList.toggle("on", !!name);
  }

  function portsChanged() {
    const out = ports?.outputName ?? null;
    if (out !== attachedTo) {
      attachedTo = out;
      surface.attach(out ? (bytes) => ports.send(bytes) : null);
    }
    refresh();
  }

  async function ensurePorts() {
    if (ports) return ports;
    const p = new MidiPorts();
    p.onMessage = (bytes) => surface.receive(bytes);
    p.onChange = portsChanged;
    await p.start();
    ports = p;
    return p;
  }

  function use(next) {
    pref = next;
    savePref(next);
    if (!ports) return;
    if (!next) {
      surface.goodbye();
      ports.open(null, null);
    } else {
      ports.open(next.input, next.output ?? partnerOutput(next.input, ports.outputs()));
    }
    portsChanged();
  }

  async function openDialog() {
    try {
      await ensurePorts();
    } catch (err) {
      showNotice({ title: t("surface.title"), body: t("surface.refused", { err: err?.message ?? String(err) }) });
      return;
    }
    const inputs = ports.inputs();
    const outputs = ports.outputs();
    // A surface the name gives away is offered first.
    const byLook = (a, b) => Number(looksLikeSurface(b)) - Number(looksLikeSurface(a));
    const current = pref?.input ?? inputs.slice().sort(byLook)[0] ?? "";
    const choice = await showModal({
      title: t("surface.title"),
      body: inputs.length ? t("surface.body") : t("surface.noPorts"),
      fields: [
        {
          name: "input", label: t("surface.input"), type: "select", value: current,
          options: [{ value: "", label: t("surface.off") },
            ...inputs.slice().sort(byLook).map((n) => ({ value: n, label: n }))],
        },
        {
          name: "output", label: t("surface.output"), type: "select", value: pref?.output ?? "",
          options: [{ value: "", label: t("surface.sameAsInput") },
            ...outputs.map((n) => ({ value: n, label: n }))],
        },
      ],
      okLabel: t("surface.use"),
    });
    if (!choice) return;
    use(choice.input ? { input: choice.input, output: choice.output || null } : null);
  }

  badge.addEventListener("click", () => openDialog());
  badge.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    e.stopPropagation(); // Space is the transport's everywhere else
    openDialog();
  });

  refresh();
  onLangChange(refresh);
  // A page that goes (a reload, the app closing) leaves the surface dark
  // rather than showing a song nobody is playing.
  window.addEventListener("pagehide", () => surface.goodbye());
  // Reconnect what was chosen last time, if that needs nobody's permission.
  if (pref) {
    midiGranted().then(async (granted) => {
      if (!granted || ports) return;
      try {
        await ensurePorts();
        use(pref);
      } catch (err) {
        console.warn("SURFACE: could not reopen the MIDI ports", err);
      }
    });
  }

  return { frame: () => surface.frame() };
}
