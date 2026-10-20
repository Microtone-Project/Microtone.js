// Determinate progress popup — a spinner + a <progress> bar + a percentage
// readout, optionally cancellable (exposes an AbortSignal). Used by the WAV
// export (item 38); shaped like showImportProgress but for a known-length job.
//
// `holdBack` is for a wait that is often over in a blink (an online project
// arriving): the popup is up at once — so the page behind it is already out
// of reach — but it stays invisible for a moment, and a quick job never
// flashes it.

import { actionRow } from "../components/actions.js";
import { setIconLabel } from "../icons.js";

export function showProgress(title, { cancellable = false, holdBack = false } = {}) {
  const dlg = document.createElement("dialog");
  dlg.className = "modal progress-modal" + (holdBack ? " progress-held" : "");
  const h = document.createElement("h3");
  const spin = document.createElement("span");
  spin.className = "spinner";
  h.append(spin, document.createTextNode(" " + title));
  const bar = document.createElement("progress");
  bar.className = "progress-bar";
  bar.max = 1; bar.value = 0;
  const pct = document.createElement("div");
  pct.className = "progress-pct dim";
  pct.textContent = "0%";
  // While it runs, the row holds Cancel (when the job can be stopped); once it
  // has failed there is nothing left to abandon, so it holds one Close.
  const controller = new AbortController();
  const { row: btnRow, cancel: cancelBtn } = actionRow({ cancel: true });
  if (cancellable) cancelBtn.addEventListener("click", (e) => { e.preventDefault(); controller.abort(); });
  else btnRow.hidden = true;

  dlg.append(h, bar, pct, btnRow);
  document.body.appendChild(dlg);

  let running = true;
  dlg.addEventListener("cancel", (e) => { if (running) e.preventDefault(); });
  dlg.addEventListener("keydown", (e) => e.stopPropagation());
  dlg.showModal();

  return {
    signal: controller.signal,
    set(frac) {
      const f = Math.max(0, Math.min(1, frac || 0));
      bar.value = f;
      pct.textContent = Math.round(f * 100) + "%";
    },
    done() { running = false; dlg.close(); dlg.remove(); },
    fail(message) {
      running = false;
      spin.classList.add("stopped");
      setIconLabel(pct, "close", message);
      const { row, dismiss: closeBtn } = actionRow({ dismiss: true });
      closeBtn.addEventListener("click", (e) => { e.preventDefault(); dlg.close(); dlg.remove(); });
      btnRow.replaceWith(row);
      closeBtn.focus();
    },
  };
}
