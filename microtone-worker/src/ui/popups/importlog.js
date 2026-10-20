// Import progress popup — spinner + the converter's streaming (-v) output in
// a small scrollable pane. Stays up for the whole conversion; on failure the
// spinner freezes red and a Close button appears (the log stays readable).

import { actionRow } from "../components/actions.js";

export function showImportProgress(title) {
  const dlg = document.createElement("dialog");
  dlg.className = "modal import-progress";
  const h = document.createElement("h3");
  const spin = document.createElement("span");
  spin.className = "spinner";
  h.append(spin, document.createTextNode(" " + title));
  const pane = document.createElement("pre");
  pane.className = "import-log";
  const { row: btnRow, dismiss: closeBtn } = actionRow({ dismiss: true });
  btnRow.hidden = true;
  dlg.append(h, pane, btnRow);
  document.body.appendChild(dlg);

  let running = true;
  dlg.addEventListener("cancel", (e) => { if (running) e.preventDefault(); });
  dlg.addEventListener("keydown", (e) => e.stopPropagation());
  closeBtn.addEventListener("click", (e) => { e.preventDefault(); dlg.close(); dlg.remove(); });
  dlg.showModal();

  const log = (line) => {
    pane.textContent += line + "\n";
    pane.scrollTop = pane.scrollHeight;
  };
  return {
    log,
    done() { running = false; dlg.close(); dlg.remove(); },
    fail(message) {
      running = false;
      log("✖ " + message);
      spin.classList.add("stopped");
      btnRow.hidden = false;
      closeBtn.focus();
    },
  };
}
