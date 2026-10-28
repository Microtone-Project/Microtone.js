// microtone.cc/about — the two things the page does: name the current
// version in the hero (package.json's, as the About popup reads it), and work
// the plan tabs (an ARIA tablist: arrows move between tabs, Home/End jump).

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
