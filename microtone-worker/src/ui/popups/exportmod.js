// Module export (ProTracker, item 219; Impulse Tracker, item 268): what the
// export found, shown before anything is saved. When a song fails a
// prerequisite there is nothing to commit, so the dialog lists why and has one
// button; when the songs can be written but lose something on the way, it
// lists that and asks. A clean export never shows it at all. The two formats
// share the dialog and differ only in their strings: `prefix` names the set
// ("modexport" or "itexport").

import { actionRow } from "../components/actions.js";
import { t } from "../i18n.js";

/** Findings shown per song before the rest collapse into "…and N more". */
const SHOWN = 12;

const hex2 = (v) => v.toString(16).toUpperCase().padStart(2, "0");

/** One finding (src/convert/modexport.js, itexport.js) as a sentence. The
 *  joining words ("first at…", "(×n)") are the ProTracker set's for both. */
export function describeFinding(f, prefix = "modexport") {
  const args = { ...f.args };
  if (f.code === "instrument") args.kind = t(`${prefix}.kind.${args.kind}`);
  let s = t(`${prefix}.f.${f.code}`, args);
  if (f.count > 1) s += t("modexport.times", { n: f.count });
  if (f.where) {
    s += t("modexport.where", { cue: hex2(f.where.cue), lane: f.where.lane + 1, row: hex2(f.where.row) });
  }
  return s;
}

/**
 * @param results exportModSongs' (or exportItSongs') list
 * @param prefix  the string set: "modexport" or "itexport"
 * @returns Promise<boolean> — true to save the modules
 */
export function showModExport(results, prefix = "modexport") {
  const blocked = results.some((r) => r.bytes === null);
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "modal modal-text modexport";
    const h = document.createElement("h3");
    h.textContent = t(blocked ? `${prefix}.blockedTitle` : `${prefix}.title`);
    const intro = document.createElement("p");
    intro.className = "dim";
    intro.textContent = t(blocked ? `${prefix}.blockedBody` : `${prefix}.warnBody`);
    const body = document.createElement("div");
    body.className = "modexport-songs";
    for (const r of results) {
      const list = blocked ? r.errors : r.warnings;
      if (list.length === 0) continue;
      const section = document.createElement("section");
      if (results.length > 1) {
        const head = document.createElement("h4");
        head.textContent = t("modexport.song", { n: r.songIndex + 1, title: r.title });
        section.appendChild(head);
      }
      const ul = document.createElement("ul");
      ul.className = blocked ? "modexport-list modexport-errors" : "modexport-list";
      for (const f of list.slice(0, SHOWN)) {
        const li = document.createElement("li");
        li.textContent = describeFinding(f, prefix);
        ul.appendChild(li);
      }
      if (list.length > SHOWN) {
        const li = document.createElement("li");
        li.className = "dim";
        li.textContent = t("modexport.more", { n: list.length - SHOWN });
        ul.appendChild(li);
      }
      section.appendChild(ul);
      body.appendChild(section);
    }
    const actions = blocked
      ? actionRow({ dismiss: true })
      : actionRow({ cancel: true, proceed: { label: t("modexport.export"), icon: "download", iconAfter: true } });
    dlg.append(h, intro, body, actions.row);
    document.body.appendChild(dlg);

    const finish = (go) => { dlg.close(); dlg.remove(); resolve(go); };
    if (blocked) {
      actions.dismiss.addEventListener("click", (e) => { e.preventDefault(); finish(false); });
    } else {
      actions.proceed.addEventListener("click", (e) => { e.preventDefault(); finish(true); });
      actions.cancel.addEventListener("click", (e) => { e.preventDefault(); finish(false); });
    }
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(false); });
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    dlg.showModal();
    (actions.proceed ?? actions.dismiss).focus();
  });
}
