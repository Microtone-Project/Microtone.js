// File → Send to Music Hub… (item 373): put the open project on
// music.microtone.cc, the Microtone Music Hub, for its curator to hear.
//
// What the Hub lists — title, author, message, tuning — is read from the
// FILE (src/player/songfacts.js, the same reading the Hub and the player do),
// so the dialog shows it as it will appear and asks only what the file
// cannot say: is it the sender's own song or a cover (and of what), a
// genre, a note to the curator. Then two statements, which are The IMS
// Archive's terms carried over: anyone may download, change and take from the
// song; and once it is up it cannot be changed or taken down, because the
// Hub keeps nothing that would tell its sender from anyone else. A cover
// adds a third: it can be taken down at the request of whoever holds the
// rights to the original.
//
// A project with no title or no author is not sent at all — the Hub would
// refuse it — and the dialog says where to fill them in.

import { actionRow } from "../components/actions.js";
import { songFacts, displayTempo } from "../../player/songfacts.js";
import { ZSTD_LEVEL_SAVE } from "../../../core/format/zstd.js";
import { withSaveProgress } from "../saveprogress.js";
import { appVersion } from "./about.js";
import { t } from "../i18n.js";

/** The Hub. A developer may point it elsewhere (`microtone-hub-origin` in
 *  localStorage); nothing in the app writes that key. */
export function hubOrigin() {
  try {
    const o = localStorage.getItem("microtone-hub-origin");
    if (o && /^https?:\/\/[^/]+$/.test(o)) return o;
  } catch { /* private mode */ }
  return "https://music.microtone.cc";
}

/** The Hub's genres; its own list when it answers, else this one. */
const GENRES = ["Ambient", "Chiptune", "Classical", "Electronic", "Experimental", "Folk", "Game", "Jazz", "Pop",
  "Rock", "Soundtrack", "Study", "Other"];

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (v === true) e.setAttribute(k, "");
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k);
  return e;
}
const check = (name, label) =>
  el("label", { class: "sendhub-check" }, el("input", { type: "checkbox", name }), " ", label);

/**
 * Show the dialog for `doc` (the editor's Document); `store` is the app's
 * (the save-progress bar). Resolves when the dialog closes.
 */
export function showSendToHub(doc, store) {
  const facts = songFacts(doc, 0);
  return new Promise((resolve) => {
    const dlg = el("dialog", { class: "modal modal-text sendhub" });
    const finish = () => { dlg.close(); dlg.remove(); resolve(); };
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); });
    dlg.addEventListener("keydown", (e) => e.stopPropagation());

    // Nothing to send without a title and an author: say where they go.
    const missing = [!facts.title && t("sendhub.noTitle"), !facts.author && t("sendhub.noAuthor")].filter(Boolean);
    if (missing.length) {
      const a = actionRow({ dismiss: true });
      dlg.append(el("h3", { text: t("sendhub.title") }), ...missing.map((m) => el("p", { text: m })),
        el("p", { class: "dim", text: t("sendhub.fillIn") }), a.row);
      a.dismiss.addEventListener("click", finish);
      document.body.append(dlg);
      dlg.showModal();
      a.dismiss.focus();
      return;
    }

    // What the Hub will show, read from the file.
    const shown = el("dl", { class: "sendhub-facts" },
      ...[[t("sendhub.fTitle"), facts.title], [t("sendhub.fAuthor"), facts.author], [t("sendhub.fTuning"), facts.tuning],
        [t("sendhub.fTempo"), String(displayTempo(facts.tempo))]]
        .map(([k, v]) => el("div", {}, el("dt", { text: k }), el("dd", { text: v }))));
    const message = facts.message.trim()
      ? el("details", { class: "sendhub-msg" }, el("summary", { text: t("sendhub.message") }), el("pre", { text: facts.message }))
      : el("p", { class: "dim", text: t("sendhub.noMessage") });

    const kindOwn = el("input", { type: "radio", name: "sendhub-kind", value: "original", checked: true });
    const kindCover = el("input", { type: "radio", name: "sendhub-kind", value: "cover" });
    const origTitle = el("input", { type: "text", maxlength: "200" });
    const origArtist = el("input", { type: "text", maxlength: "200" });
    const takedown = check("takedown", t("sendhub.consentTakedown"));
    const coverBox = el("div", { class: "sendhub-cover", hidden: true },
      el("label", {}, t("sendhub.origTitle"), origTitle),
      el("label", {}, t("sendhub.origArtist"), origArtist),
      takedown);
    const genre = el("select", {}, el("option", { value: "", text: "—" }), ...GENRES.map((g) => el("option", { value: g, text: g })));
    const note = el("textarea", { rows: "3", maxlength: "2000" });
    const licence = check("licence", t("sendhub.consentLicence"));
    const permanent = check("permanent", t("sendhub.consentPermanent"));
    const status = el("p", { class: "sendhub-status", role: "status" });

    const a = actionRow({ cancel: true, proceed: { label: t("sendhub.send") } });
    const ticked = (label) => label.querySelector("input").checked;
    const sync = () => {
      coverBox.hidden = !kindCover.checked;
      const coverOk = !kindCover.checked || (origTitle.value.trim() !== "" && ticked(takedown));
      a.proceed.disabled = !(ticked(licence) && ticked(permanent) && coverOk);
    };
    dlg.addEventListener("input", sync);
    dlg.addEventListener("change", sync);

    dlg.append(
      el("h3", { text: t("sendhub.title") }),
      el("p", { class: "dim", text: t("sendhub.intro") }),
      shown, message,
      el("fieldset", { class: "sendhub-kind" }, el("legend", { text: t("sendhub.kind") }),
        el("label", {}, kindOwn, " ", t("sendhub.kindOwn")),
        el("label", {}, kindCover, " ", t("sendhub.kindCover"))),
      coverBox,
      el("label", { class: "sendhub-field" }, t("sendhub.genre"), genre),
      el("label", { class: "sendhub-field" }, t("sendhub.note"), note),
      el("fieldset", { class: "sendhub-consents" }, el("legend", { text: t("sendhub.before") }), licence, permanent),
      status, a.row);
    sync();

    a.cancel.addEventListener("click", finish);
    a.proceed.addEventListener("click", async () => {
      a.proceed.disabled = true;
      a.cancel.disabled = true;
      status.textContent = t("sendhub.sending");
      try {
        const bytes = await withSaveProgress(store, (progress) => doc.toSaveBytes(ZSTD_LEVEL_SAVE, progress));
        const form = new FormData();
        form.set("file", new Blob([bytes], { type: "application/octet-stream" }), `${facts.title || "song"}.taud`);
        form.set("kind", kindCover.checked ? "cover" : "original");
        if (kindCover.checked) {
          form.set("original_title", origTitle.value.trim());
          form.set("original_artist", origArtist.value.trim());
          form.set("consent_takedown", "yes");
        }
        form.set("genre", genre.value);
        form.set("note", note.value);
        form.set("consent_licence", "yes");
        form.set("consent_permanent", "yes");
        form.set("client", `Microtone ${(await appVersion()) ?? ""}`.trim());
        const res = await fetch(`${hubOrigin()}/api/submissions`, { method: "POST", body: form, credentials: "omit" });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.message ?? `${res.status} ${res.statusText}`);
        // Done: the dialog becomes its own receipt, with one button.
        const done = actionRow({ dismiss: true });
        dlg.replaceChildren(el("h3", { text: t("sendhub.sentTitle") }),
          el("p", { text: t(body.again ? "sendhub.sentAgain" : "sendhub.sent") }), done.row);
        done.dismiss.addEventListener("click", finish);
        done.dismiss.focus();
      } catch (e) {
        status.textContent = t("sendhub.failed", { reason: e.message === "Failed to fetch" ? t("sendhub.offline") : e.message });
        a.cancel.disabled = false;
        sync();
      }
    });

    document.body.append(dlg);
    dlg.showModal();
    kindOwn.focus();
  });
}
