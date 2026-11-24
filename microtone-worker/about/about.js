// microtone.cc/about — the three things the page does: name the current
// version in the hero (package.json's, as the About popup reads it), work
// the plan tabs (an ARIA tablist: arrows move between tabs, Home/End jump),
// and play the films.

const kicker = document.querySelector("[data-version]");
fetch(new URL("../package.json", import.meta.url))
  .then((res) => (res.ok ? res.json() : null))
  .then((pkg) => {
    if (typeof pkg?.version !== "string") return;
    kicker.textContent = `Microtone ${pkg.version.replace(/\.0$/, "")}`;
  })
  .catch(() => { /* the plain wordmark stays */ });

const tabs = [...document.querySelectorAll('.ab-tabs [role="tab"]')];

function select(tab, focus) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
  }
  if (focus) tab.focus();
}

for (const tab of tabs) {
  tab.addEventListener("click", () => select(tab, false));
  tab.addEventListener("keydown", (e) => {
    const i = tabs.indexOf(tab);
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    select(tabs[(to + tabs.length) % tabs.length], true);
  });
}

// The films are posters that link to YouTube, so they work without this
// script and nothing of YouTube's loads until somebody presses one. A plain
// click puts the no-cookie player in the poster's place; a click meant for a
// new tab or window is left to go to YouTube.
//
// `credentialless` is for a host that still sends COEP require-corp here (the
// dev server; _headers drops it for /about/ on the site): YouTube sends no
// CORP header, so without it Chromium refuses the frame. Firefox has no
// credentialless frames, hence the header.
for (const link of document.querySelectorAll("a.ab-video[data-video]")) {
  link.addEventListener("click", (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const frame = document.createElement("iframe");
    frame.setAttribute("credentialless", "");
    frame.title = link.dataset.title;
    frame.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    frame.allowFullscreen = true;
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    frame.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(link.dataset.video)}?autoplay=1&rel=0`;
    const box = document.createElement("div");
    box.className = "ab-video";
    box.append(frame);
    link.replaceWith(box);
    frame.focus();
  });
}
