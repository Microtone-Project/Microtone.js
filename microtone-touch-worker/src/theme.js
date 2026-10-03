// Themes: the tracker's three under its own names — dark, dim and light —
// or SYSTEM, the default, which is the phone's own dark or light and follows
// it when it changes.
//
// Every colour is a token in touch.css under :root[data-theme=…]. The early
// script in index.html sets the attribute from the same saved choice before
// the first paint, so nothing flashes the wrong palette; this module keeps it
// right afterwards and tells the one view that caches colours (the keyboard
// canvas) to read them again.

export const THEMES = Object.freeze([
  { id: "system", name: "System" },
  { id: "dark", name: "Dark" },
  { id: "dim", name: "Dim" },
  { id: "light", name: "Light" },
]);
const KEY = "microtone-touch:theme"; // index.html's early script reads it too
const phoneIsLight = matchMedia("(prefers-color-scheme: light)");

let choice = readChoice();
let changed = () => {};

function readChoice() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved !== "system" && THEMES.some((t) => t.id === saved)) return saved;
  } catch { /* private mode: the default */ }
  return "system";
}

/** The theme picked: "system", "dark", "dim" or "light". */
export const themeChoice = () => choice;

/** The palette actually showing. */
const resolved = () => (choice === "system" ? (phoneIsLight.matches ? "light" : "dark") : choice);

function apply() {
  const root = document.documentElement;
  const want = resolved();
  if (root.dataset.theme !== want) root.dataset.theme = want;
  // The browser's own chrome takes the ground colour, whichever media its
  // tag was written for.
  const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    if (meta.content !== bg) meta.content = bg;
  }
  changed();
}

export function setTheme(id) {
  if (!THEMES.some((t) => t.id === id)) return;
  choice = id;
  try {
    if (id === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, id);
  } catch { /* kept for this visit only */ }
  apply();
}

/** `onChange()` runs after every switch of palette. */
export function initTheme(onChange) {
  changed = onChange;
  phoneIsLight.addEventListener("change", () => { if (choice === "system") apply(); });
  apply();
}
