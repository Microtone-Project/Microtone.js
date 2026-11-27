// The MIDI configuration (item 379): keyboards and the control surface, as
// one panel — in the top bar badge's dialog, and in the desktop app's
// Settings tab (its MIDI category). Every change applies at once, through the
// link (midilink.js), so the dialog round it has nothing to commit and one
// Close; the panel redraws itself when a device comes or goes.
//
//   Keyboards        one option per input (any number at once), the key
//                    mapping (a Scala .kbm) and whether velocity is written
//   Control surface  its input and output (one surface)

import { t } from "./i18n.js";
import { looksLikeSurface } from "../midi/ports.js";
import { pickFile } from "../storage/import-export.js";
import { showAlert } from "./components/modal.js";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** What a mapping does, in a line: its pattern and where it starts. */
export function kbmSummary(map) {
  if (!map || map.size === 0) {
    return t("midiSetup.mappingLinear", { middle: map?.middle ?? 60, first: map?.first ?? 0, last: map?.last ?? 127 });
  }
  return t("midiSetup.mappingSummary", {
    size: map.size, octave: map.octave || t("midiSetup.mappingOctaveScale"),
    middle: map.middle, first: map.first, last: map.last,
  });
}

/**
 * Build the panel over `link` (startMidiLink's). Returns {root, dispose()}:
 * dispose stops it listening. The ports must have been started
 * (`link.ensure()`) for the lists to be there; before that it says so.
 */
export function buildMidiPanel(link) {
  const root = el("div", "midi-panel");

  function render() {
    // Keep the focus where it was across a redraw (a device plugged in while
    // someone is choosing).
    const focusKey = root.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    root.replaceChildren();
    const ports = link.ports;
    const inputs = ports ? ports.inputs() : [];
    const outputs = ports ? ports.outputs() : [];
    const surface = link.surfacePref();

    // ── Keyboards ──
    const kb = el("div", "set-section");
    kb.append(el("h3", "set-head", t("midiSetup.keyboards")));
    kb.append(el("p", "set-note", t("midiSetup.keyboardsBody")));
    const chosen = link.keyboards();
    const open = ports?.keyboardNames ?? [];
    // Every input but the surface's, and a chosen one that is not plugged in
    // (so it can be let go of).
    const names = inputs.filter((n) => n !== surface?.input);
    for (const n of chosen) if (!names.includes(n)) names.push(n);
    if (names.length === 0) kb.append(el("p", "set-note", t("midiSetup.noInputs")));
    for (const name of names) {
      const label = el("label", "modal-field modal-check midi-input");
      const box = el("input");
      box.type = "checkbox";
      box.checked = chosen.includes(name);
      box.dataset.key = `kb:${name}`;
      box.addEventListener("change", () => link.setKeyboard(name, box.checked));
      const present = inputs.includes(name);
      const caption = el("span", "modal-label", present ? name : t("midiSetup.missing", { name }));
      if (box.checked && present && !open.includes(name)) caption.textContent = t("midiSetup.notOpen", { name });
      label.append(box, caption);
      kb.append(label);
    }

    // The mapping: a Scala .kbm, or a key a step.
    const kbm = link.kbm();
    const mapCell = el("div", "set-inline");
    const load = el("button", "", t("midiSetup.mappingLoad"));
    load.type = "button";
    load.dataset.key = "kbm-load";
    load.addEventListener("click", async () => {
      const file = await pickFile(".kbm", t("dialog.kbm"));
      if (!file) return;
      try {
        link.setKbm(file.name, await file.text());
      } catch (err) {
        showAlert(t("midiSetup.mappingBad", { name: file.name, err: err?.message ?? String(err) }));
      }
    });
    mapCell.append(el("span", "set-value", kbm ? kbm.name : t("midiSetup.mappingNone")), load);
    if (kbm) {
      const none = el("button", "", t("midiSetup.mappingClear"));
      none.type = "button";
      none.dataset.key = "kbm-clear";
      none.addEventListener("click", () => link.setKbm(null, null));
      mapCell.append(none);
    }
    const mapRow = el("div", "set-row");
    mapRow.append(el("span", "set-label", t("midiSetup.mapping")), mapCell);
    kb.append(mapRow);
    kb.append(el("p", "set-note set-indent", kbmSummary(kbm?.map ?? null)));
    kb.append(el("p", "set-note set-indent", t("midiSetup.mappingNote")));

    const vel = el("label", "modal-field modal-check");
    const velBox = el("input");
    velBox.type = "checkbox";
    velBox.checked = link.velocity();
    velBox.dataset.key = "velocity";
    velBox.addEventListener("change", () => link.setVelocity(velBox.checked));
    vel.append(velBox, el("span", "modal-label", t("midiSetup.velocity")));
    kb.append(vel, el("p", "set-note midi-hint", t("midiSetup.velocityHint")));
    root.append(kb);

    // ── Control surface ──
    const sf = el("div", "set-section");
    sf.append(el("h3", "set-head", t("midiSetup.surface")));
    sf.append(el("p", "set-note", t("surface.body")));
    // A surface the name gives away is offered first; a chosen keyboard is
    // not offered (a port is one or the other).
    const byLook = (a, b) => Number(looksLikeSurface(b)) - Number(looksLikeSurface(a));
    const inSel = el("select", "set-select");
    inSel.dataset.key = "surface-in";
    inSel.append(new Option(t("surface.off"), ""));
    const candidates = inputs.filter((n) => !chosen.includes(n)).sort(byLook);
    if (surface && !candidates.includes(surface.input)) candidates.unshift(surface.input);
    for (const n of candidates) {
      inSel.append(new Option(inputs.includes(n) ? n : t("midiSetup.missing", { name: n }), n));
    }
    inSel.value = surface?.input ?? "";
    const outSel = el("select", "set-select");
    outSel.dataset.key = "surface-out";
    outSel.append(new Option(t("surface.sameAsInput"), ""));
    for (const n of outputs) outSel.append(new Option(n, n));
    if (surface?.output && !outputs.includes(surface.output)) {
      outSel.append(new Option(t("midiSetup.missing", { name: surface.output }), surface.output));
    }
    outSel.value = surface?.output ?? "";
    outSel.disabled = !surface;
    inSel.addEventListener("change", () => link.useSurface(inSel.value ? { input: inSel.value, output: outSel.value || null } : null));
    outSel.addEventListener("change", () => link.useSurface(surface ? { input: surface.input, output: outSel.value || null } : null));
    const row = (label, control) => {
      const r = el("div", "set-row");
      r.append(el("span", "set-label", label), control);
      return r;
    };
    sf.append(row(t("surface.input"), inSel), row(t("surface.output"), outSel));
    root.append(sf);

    if (!ports) root.prepend(el("p", "set-note", t("midiSetup.notStarted")));
    if (focusKey) {
      const again = [...root.querySelectorAll("[data-key]")].find((e) => e.dataset.key === focusKey);
      again?.focus();
    }
  }

  render();
  const stop = link.subscribe(render);
  return { root, refresh: render, dispose: stop };
}
