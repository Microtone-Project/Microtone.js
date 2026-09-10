// Minimal modal helper over <dialog>. Builds a form-style dialog from field
// specs and resolves with the values (or null on cancel).

import { t } from "../i18n.js";

export function showModal({ title, fields = [], okLabel = "OK", body = null }) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    // `modal-text` caps the width: these dialogs are title + prose + fields, and
    // a <dialog> otherwise grows to fit its longest line — the format-upgrade
    // explanation would run the width of the screen. Dialogs with their own
    // layout (the panner, the export picker, New Project) build their own
    // element and set their own width.
    dlg.className = "modal modal-text";
    const h = document.createElement("h3");
    h.textContent = title;
    dlg.appendChild(h);
    if (body) {
      const p = document.createElement("p");
      p.className = "dim";
      p.textContent = body;
      dlg.appendChild(p);
    }
    // One container for every field, so the controls can share a column: with
    // each label its own block, a select landed wherever its label happened to
    // end and the dialog read as a ragged list of sentences. Scoped to the
    // fields THIS helper builds — the panner and the export picker append
    // `.modal-field` labels to layouts of their own.
    const form = document.createElement("div");
    form.className = "modal-form";
    const inputs = {};
    const deps = [];
    for (const f of fields) {
      const label = document.createElement("label");
      label.className = "modal-field";
      // The caption is its own element rather than a bare text node: it is what
      // gives the control column something to measure against, and on a
      // checkbox it is what sits AFTER the box.
      const caption = document.createElement("span");
      caption.className = "modal-label";
      caption.textContent = f.label ?? "";
      let input;
      if (f.type === "select") {
        input = document.createElement("select");
        for (const opt of f.options) {
          const o = document.createElement("option");
          o.value = opt.value;
          o.textContent = opt.label;
          input.appendChild(o);
        }
        if (f.value !== undefined) input.value = f.value;
      } else if (f.type === "checkbox") {
        input = document.createElement("input");
        input.type = "checkbox";
        input.checked = !!f.value; // resolves as a boolean, not a string
        label.classList.add("modal-check");
      } else {
        input = document.createElement("input");
        input.type = f.type ?? "text";
        if (f.value !== undefined) input.value = f.value;
        if (f.min !== undefined) input.min = f.min;
        if (f.max !== undefined) input.max = f.max;
        if (f.placeholder) input.placeholder = f.placeholder;
      }
      input.name = f.name;
      inputs[f.name] = input;
      // A checkbox leads with its box, so a column of options can be scanned
      // and hit down one edge; everything else leads with its caption.
      if (f.type === "checkbox") label.append(input, caption);
      else label.append(caption, input);
      form.appendChild(label);
      // `enabledWhen: {field, is?, not?}` greys a control out while another
      // field's answer makes it meaningless — pitch glissando quantises onto
      // the notation's grid, so there is nothing left for a dither to round.
      // A disabled control still RESOLVES (its value is simply ignored by the
      // caller), so nothing downstream has to learn about the dependency.
      if (f.enabledWhen) deps.push({ label, input, on: f.enabledWhen });
      // `hint` is the explanation that used to be crammed into the label in
      // brackets. Under the field and dimmed, it can be a whole sentence
      // without pushing the control off to the right or drowning the name of
      // the setting in it.
      //
      // `hints` is the same place, keyed by the field's OWN value: a select
      // whose options each need a sentence describes the chosen one here
      // rather than carrying the sentence in the option text, which would set
      // the width of the closed dropdown to the longest of them.
      if (f.hint || f.hints) {
        const hint = document.createElement("p");
        hint.className = "modal-hint";
        const text = () => (f.hints ? f.hints[input.value] ?? f.hint ?? "" : f.hint);
        hint.textContent = text();
        form.appendChild(hint);
        if (f.hints) {
          const sync = () => { hint.textContent = text(); };
          input.addEventListener("change", sync);
          input.addEventListener("input", sync);
        }
      }
    }
    for (const d of deps) {
      const src = inputs[d.on.field];
      if (!src) continue;
      const sync = () => {
        const v = src.type === "checkbox" ? src.checked : src.value;
        const on = d.on.is !== undefined ? v === d.on.is : v !== d.on.not;
        d.input.disabled = !on;
        d.label.classList.toggle("modal-disabled", !on);
      };
      src.addEventListener("change", sync);
      sync();
    }
    dlg.appendChild(form);
    const row = document.createElement("div");
    row.className = "modal-buttons";
    const ok = document.createElement("button");
    ok.textContent = okLabel;
    const cancel = document.createElement("button");
    cancel.textContent = t("common.cancel");
    row.append(ok, cancel);
    dlg.appendChild(row);
    document.body.appendChild(dlg);

    const finish = (result) => {
      dlg.close();
      dlg.remove();
      resolve(result);
    };
    ok.addEventListener("click", (e) => {
      e.preventDefault();
      const values = {};
      for (const [name, input] of Object.entries(inputs)) {
        values[name] = input.type === "checkbox" ? input.checked : input.value;
      }
      finish(values);
    });
    cancel.addEventListener("click", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("cancel", () => finish(null));
    dlg.addEventListener("keydown", (e) => {
      e.stopPropagation(); // don't leak piano/transport keys while a modal is up
      if (e.key === "Enter" && e.target.tagName !== "BUTTON") { e.preventDefault(); ok.click(); }
    });
    dlg.showModal();
    const first = Object.values(inputs)[0];
    if (first) first.focus();
  });
}
