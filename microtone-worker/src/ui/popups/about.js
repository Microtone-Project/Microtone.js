// About popup — opened by clicking the topbar brand. Carries the project
// blurb, source/support links, the "keeping it free" ask and the special-thanks
// section (donors and sponsors get listed here as they come in).
//
// The blurb is three separate keys, not one: the text goes through esc(), so a
// single string cannot carry paragraph markup.

import { t } from "../i18n.js";

const THANKS = [
  // ["Name", "note"], — donors/sponsors, newest first
];

export function showAbout() {
  const dlg = document.createElement("dialog");
  dlg.className = "modal about-modal";
  const thanksList = THANKS.length
    ? `<ul class="about-thanks">${THANKS.map(([n, note]) =>
        `<li><b>${esc(n)}</b>${note ? ` — ${esc(note)}` : ""}</li>`).join("")}</ul>`
    : `<p class="dim">${esc(t("about.thanksEmpty"))}</p>`;
  dlg.innerHTML = `
    <h3 class="brand-container"><span class="brand brand-red">Micro</span><span class="brand brand-white">tone</span><span class="brand brand-tm"></span></h3>
    <p>${esc(t("about.blurb1"))}</p>
    <p>${esc(t("about.blurb2"))}</p>
    <p>${esc(t("about.blurb3"))}</p>
    <p class="dim">${esc(t("about.license"))}</p>
    <p>
      <a href="docs.html" target="_blank" rel="noopener">${esc(t("about.docs"))}</a> ·
      <a href="docs.html#patchnotes" target="_blank" rel="noopener">${esc(t("about.patchNotes"))}</a> ·
      <a href="https://github.com/curioustorvald/Microtone.js" target="_blank" rel="noopener">GitHub</a> ·
      <a href="https://bsky.app/profile/did:plc:3enk4wk6acr23segkntcdzzc" target="_blank" rel="noopener">Bluesky</a>
    </p>
    <h4>${esc(t("about.supportHead"))}</h4>
    <p>${esc(t("about.support"))}</p>
    <p>
      <a href="https://ko-fi.com/curioustorvald" target="_blank" rel="noopener">${esc(t("topbar.donate"))}</a> ·
      <a href="https://github.com/sponsors/curioustorvald" target="_blank" rel="noopener">${esc(t("topbar.sponsor"))}</a>
    </p>
    <h4>${esc(t("about.thanks"))}</h4>
    ${thanksList}
    <div class="modal-buttons"><button>${esc(t("common.close"))}</button></div>`;
  document.body.appendChild(dlg);
  dlg.querySelector(".modal-buttons button").addEventListener("click", () => { dlg.close(); dlg.remove(); });
  dlg.addEventListener("cancel", () => dlg.remove());
  dlg.addEventListener("keydown", (e) => e.stopPropagation());
  dlg.showModal();
}

function esc(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
