// About Microtone Touch — opened by tapping the wordmark in the bar, as the
// tracker's About is opened by tapping its own (microtone-worker's
// src/ui/popups/about.js, whose shape this follows), or from the menu while
// the bar has no room left for the wordmark. Its link to Microtone asks for
// the tracker (`tracker=1`): a phone is otherwise sent straight back here.
//
// The version is package.json's, read where it is served beside the page —
// as the tracker's About reads its own — so a bump there is the whole of it;
// test/node/touch.test.js keeps the file shipped.

import { t, tHtml } from "./i18n.js";

let version = null;

/** package.json's version, read once; null when it cannot be read. */
function appVersion() {
  version ??= fetch(new URL("../package.json", import.meta.url))
    .then((res) => (res.ok ? res.json() : null))
    .then((pkg) => (typeof pkg?.version === "string" ? pkg.version : null))
    .catch(() => null);
  return version;
}

/** Open About in the page's sheet: `showSheet(html, bind)` is app.js's. */
export function openAbout(showSheet) {
  showSheet(aboutHtml(), (body) => {
    const line = body.querySelector(".about-version");
    appVersion().then((v) => {
      if (!v || !line.isConnected) return;
      line.textContent = t("about.version", { version: v });
      line.hidden = false;
    });
  });
}

function aboutHtml() {
  const link = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
  return `
    <div class="about">
      <h2 class="brand-container"><span class="brand brand-red">Micro</span><span class="brand brand-white">tone</span><span class="brand brand-tm"></span><span class="brand brand-touch">Touch</span></h2>
      <p class="about-fine about-version" hidden></p>
      <p>${tHtml("about.blurb1")}</p>
      <p>${tHtml("about.blurb2")}</p>
      <p class="about-fine">${tHtml("about.license")}</p>
      <p>
        ${link("https://microtone.cc/?tracker=1", "Microtone")} ·
        ${link("https://github.com/curioustorvald/Microtone.js", "GitHub")} ·
        ${link("https://bsky.app/profile/did:plc:3enk4wk6acr23segkntcdzzc", "Bluesky")}
      </p>
      <h3>${tHtml("about.supportHead")}</h3>
      <p>${tHtml("about.support")}</p>
      <p>
        ${link("https://ko-fi.com/curioustorvald", tHtml("about.donate"))} ·
        ${link("https://github.com/sponsors/curioustorvald", tHtml("about.sponsor"))}
      </p>
    </div>
    <div class="row about-buttons"><button class="tbtn" value="close">${tHtml("sheet.close")}</button></div>`;
}
