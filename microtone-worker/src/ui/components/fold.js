// A panel that folds shut to its titlebar — the Mixing tab's equipment units
// first, and anything else built as a titlebar over a body.
//
// What folds is the BODY only. The titlebar stays whole: its switch, its slider
// and its readouts keep working while the panel is shut, because a folded unit
// is still in the chain and still something you may want to bypass or mix
// without opening it. The twisty is a real button at the titlebar's left end
// (Tab reaches it, Enter and Space work it); the panel's name beside it is a
// second, larger target for the pointer, never for the keyboard — one control
// per action in the Tab order.
//
// Where the state lives is the caller's choice, and there are two answers:
//   - the PROJECT, when what the panel shows is saved in it and the format has
//     a place for the fold — a mixing chain's equipment carries a folded flag
//     beside its bypass (TAUD_FILE_FORMAT.md §9.15). The caller passes `get` and
//     `set`; folding is then saved with the file but is never an undo step.
//   - the VIEWER otherwise: localStorage under one `key` per kind of panel,
//     kept across a re-render and a reload, never in a file.
// Either way a panel whose state was never touched takes the caller's default,
// so a caller can open what matters and shut what does not.

import { icon } from "../icons.js";

const STORE = "microtone-fold";

let memo = null;

/** Every stored state, read once and kept (a private window throws). */
function states() {
  if (memo !== null) return memo;
  memo = {};
  try {
    const raw = globalThis.localStorage?.getItem(STORE);
    const v = raw ? JSON.parse(raw) : null;
    if (v && typeof v === "object") memo = v;
  } catch { /* private mode, or junk: start empty */ }
  return memo;
}

function store(key, open) {
  states()[key] = open;
  try { globalThis.localStorage?.setItem(STORE, JSON.stringify(memo)); } catch { /* private mode */ }
}

/** Whether the panel stored under `key` is open, or `fallback` if it was never touched. */
export function foldOpen(key, fallback = true) {
  const v = states()[key];
  return typeof v === "boolean" ? v : fallback;
}

/**
 * Make `box` fold. `head` is its titlebar and `body` what folds away; `name`
 * (optional, inside `head`) also toggles on a click. The state comes from
 * `get()` and goes to `set(open)` when the caller keeps it (in the project);
 * else from localStorage under `key`; else it resets with the page, starting
 * at `open`. `onToggle(open)` runs after every change, so a view can paint what
 * just came into sight. Returns { toggle, isOpen(), setOpen(open), sync() } —
 * sync() re-reads `get()` after the caller's state moved under it.
 */
export function makeFoldable(box, {
  head, body, name = null, key = null, open = true, label = "", onToggle = null, get = null, set = null,
}) {
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "fold-toggle";
  toggle.innerHTML = icon("caretDown"); // our own markup; turned to point right while shut (CSS)
  if (label) { toggle.title = label; toggle.setAttribute("aria-label", label); }
  if (!body.id) body.id = `fold-${Math.random().toString(36).slice(2, 10)}`;
  toggle.setAttribute("aria-controls", body.id);
  body.classList.add("fold-body");
  head.prepend(toggle);

  let isOpen = get ? !!get() : key ? foldOpen(key, open) : open;
  const apply = () => {
    box.classList.toggle("folded", !isOpen);
    const s = String(isOpen);
    if (toggle.getAttribute("aria-expanded") !== s) toggle.setAttribute("aria-expanded", s);
  };
  const setOpen = (v) => {
    v = !!v;
    if (v === isOpen) return;
    isOpen = v;
    if (set) set(v); else if (key) store(key, v);
    apply();
    onToggle?.(v);
  };
  const sync = () => {
    if (!get) return;
    const v = !!get();
    if (v === isOpen) return;
    isOpen = v;
    apply();
    onToggle?.(v);
  };
  toggle.addEventListener("click", () => setOpen(!isOpen));
  if (name) {
    name.classList.add("fold-name");
    name.addEventListener("click", () => setOpen(!isOpen));
  }
  apply();
  return { toggle, isOpen: () => isOpen, setOpen, sync };
}
