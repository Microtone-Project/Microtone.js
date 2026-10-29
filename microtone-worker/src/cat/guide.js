// "How to get started": a short guide to translating with the workbench,
// glossary first. It opens by itself the first time a language with no
// tables yet is opened here, and from the top bar's Help button any time.

import { actionRow } from "../ui/components/actions.js";
import { h, fill } from "./dom.js";

const SEEN_KEY = "microtone-cat:guided";

const readSeen = () => {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]"); } catch { return []; }
};

/** A language nothing has been done for yet: no table in any app, no glossary. */
export const isFresh = (p) => p.corpora.every((c) => c.target === null) && !p.glossary.length;

/** Whether the guide has opened by itself for `lang` before (in this browser). */
export function guided(lang) { return readSeen().includes(lang); }
export function markGuided(lang) {
  const seen = readSeen();
  if (seen.includes(lang)) return;
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, lang])); } catch { /* private mode */ }
}

const step = (title, ...body) => h("li", {}, h("b", {}, title), " ", ...body);
const kbd = (k) => h("kbd", {}, k);

/** Show the guide; resolves true when the translator chose to start with the glossary. */
export function showGuide({ langName }) {
  return new Promise((resolve) => {
    const dlg = h("dialog", { className: "modal modal-text cat-dialog-wide cat-guide" });
    const { row, cancel, proceed } = actionRow({
      cancel: "Close",
      proceed: { label: "Start with the glossary", title: "Open the Glossary tab's proposals" },
    });
    fill(dlg,
      h("h3", {}, `Getting started with ${langName}`),
      h("ol", { className: "cat-steps" },
        step("Settle the glossary first.",
          "The Glossary tab proposes the terms the English uses most. Type your word for each and press ", kbd("Enter"),
          "; reject what is not a term; under Accepted, tick Keep for names and units that stay in English, and leave a note where the choice needs a reason. ",
          "Every string after that underlines the terms, offers your word to insert, and the Issues tab flags a translation that strays from it."),
        step("Keep apart the words the apps keep apart.",
          "A lane is one part of the song, never a channel or a voice; a voice is one sounding instance of an instrument; a channel is audio routing only. ",
          "Notation, tuning system and tuning are three different things too. Switch to 한국어 above to see how its glossary splits them."),
        step("Translate the meaning, not the words.",
          "Leaving a word out, or adding one, is right when it says better what the app does. The key and its comment tell you where a string sits; ",
          h("a", { href: "../?lang=debug", target: "_blank", rel: "noopener" }, "Microtone with ?lang=debug"),
          " shows each key on screen. Keep {placeholders} and the marked codes exactly as they are."),
        step("Work through To do.",
          "Short, common strings first (buttons, menus): they become the memory that suggests the rest. ", kbd("Ctrl+Enter"),
          " confirms and moves on, ", kbd("Ctrl+1…9"), " uses a match, and Fill from memory translates repeats in one go."),
        step("Check, then save often.",
          "Look through the Issues tab and dismiss what is right as it is. Until you save, your work lives only in this browser; ",
          "Save writes the files, or downloads them with instructions, and says where to register the new language.")),
      h("p", { className: "dim" }, "This guide is always under Help in the top bar."),
      row);
    document.body.append(dlg);
    const finish = (go) => { dlg.close(); dlg.remove(); resolve(go); };
    cancel.addEventListener("click", () => finish(false));
    proceed.addEventListener("click", () => finish(true));
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(false); });
    dlg.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && e.target.tagName !== "BUTTON" && e.target.tagName !== "A") { e.preventDefault(); finish(true); }
    });
    dlg.showModal();
    proceed.focus({ preventScroll: true }); // a short screen starts at step 1
  });
}
