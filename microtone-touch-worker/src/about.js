// About Microtone Touch — opened by tapping the wordmark in the bar, as the
// tracker's About is opened by tapping its own (microtone-worker's
// src/ui/popups/about.js, whose shape this follows), or from the menu while
// the bar has no room left for the wordmark.
//
// The version is package.json's, read where it is served beside the page —
// as the tracker's About reads its own — so a bump there is the whole of it;
// test/node/touch.test.js keeps the file shipped.

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
      line.textContent = `Version ${v}`;
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
      <p>Microtone Touch is a sketchpad for the notes a piano cannot play: an isomorphic keyboard in 4- to 53-tone equal temperaments, Bohlen–Pierce and the twelve lü, eight lanes of preset instruments, and a pattern grid cut down to notes and a handful of effects.</p>
      <p>A sketch is kept on your phone, or online with the account you use in Microtone — which opens it as an ordinary project, to carry on with everything the tracker can do.</p>
      <p class="about-fine">Microtone Touch is free software distributed under the terms of the GNU General Public License version 3.</p>
      <p>
        ${link("https://microtone.cc/", "Microtone")} ·
        ${link("https://github.com/curioustorvald/Microtone.js", "GitHub")} ·
        ${link("https://bsky.app/profile/did:plc:3enk4wk6acr23segkntcdzzc", "Bluesky")}
      </p>
      <h3>Keeping it free</h3>
      <p>Microtone has no ads, no tracking and no paid tier — and it is not going to grow any. It is written by one person in their spare time; donations and sponsorships cover the hosting and buy the hours that go into it.</p>
      <p>
        ${link("https://ko-fi.com/curioustorvald", "Donate")} ·
        ${link("https://github.com/sponsors/curioustorvald", "Sponsor")}
      </p>
    </div>
    <div class="row about-buttons"><button class="tbtn" value="close">Close</button></div>`;
}
