// Touch's languages, after the tracker's (microtone-worker/src/ui/i18n.js):
// each one is a flat key → string module in lang/, en.js is the reference
// list, and "{name}" placeholders are filled in at run time. To add a
// language, copy en.js to <code>.js, translate the VALUES (never the keys),
// and register it in LANGS and TABLES below and in index.html's early script.
//
// Where the tracker defaults to English, Touch defaults to the PHONE's own
// language — SYSTEM, the first of navigator.languages that it speaks — and
// a choice made under Language… overrides that. Every table is imported up
// front: they are small, and a language then switches at once, with nothing
// to fetch and nothing to wait for.
//
// Static markup (index.html, and any sheet built from a template) is
// translated by applyDom(): data-i18n sets the text, data-i18n-title the
// title, data-i18n-aria the aria-label. Until initLang() runs — and always in
// Node, where the tests run — the language is English.

import en from "./lang/en.js";
import ko from "./lang/ko.js";

/** Every language Touch speaks, each by its own name. */
export const LANGS = Object.freeze({ en: "English", ko: "한국어" });
const TABLES = { en, ko };
const KEY = "microtone-touch:lang"; // index.html's early script reads it too

let choice = "system";
let code = "en";
let table = en;
let plurals = new Intl.PluralRules("en");
let changed = () => {};

/** The first of the phone's languages that Touch speaks, else English. */
export function phoneLang(list = typeof navigator === "undefined" ? [] : navigator.languages ?? [navigator.language]) {
  for (const tag of list) {
    const primary = String(tag ?? "").toLowerCase().split(/[-_]/)[0];
    if (Object.hasOwn(LANGS, primary)) return primary;
  }
  return "en";
}

function readChoice() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && Object.hasOwn(LANGS, saved)) return saved;
  } catch { /* private mode: the default */ }
  return "system";
}

/** The language choice: "system" or a code from LANGS. */
export const langChoice = () => choice;
/** The language showing: a code from LANGS — also a BCP 47 tag, for Intl. */
export const currentLang = () => code;

/** Make the choice the language showing; true when that changed it. <html
 *  lang> follows, which also picks the right face for the lü's Han
 *  characters, and Korean's own line breaking (touch.css). */
function activate() {
  const want = choice === "system" ? phoneLang() : choice;
  const root = typeof document === "undefined" ? null : document.documentElement;
  if (root && root.lang !== want) root.lang = want;
  if (want === code) return false;
  code = want;
  table = TABLES[want];
  plurals = new Intl.PluralRules(code);
  return true;
}

/** Load the saved choice and apply it to the page. `onChange()` runs after
 *  every later switch, for whatever was drawn in the old language. */
export function initLang(onChange) {
  changed = onChange;
  choice = readChoice();
  activate();
  applyDom();
  addEventListener("languagechange", () => {
    if (choice === "system" && activate()) relabel();
  });
}

/** Choose a language ("system" or a code), remembered on this phone. */
export function setLang(id) {
  if (id !== "system" && !Object.hasOwn(LANGS, id)) return;
  choice = id;
  try {
    if (id === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, id);
  } catch { /* kept for this visit only */ }
  if (activate()) relabel();
}

function relabel() {
  applyDom();
  changed();
}

function template(key) {
  return table[key] ?? en[key] ?? key;
}

/** `key` in the language showing, "{name}" filled in from `params`. */
export function t(key, params = null) {
  let s = template(key);
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** A count's form: `key.one`, `key.other`, … as Intl.PluralRules picks for
 *  `n` in the language showing (Korean has only `other`); "{n}" is `n`. */
export function plural(key, n, params = {}) {
  const form = `${key}.${plurals.select(n)}`;
  return t(table[form] !== undefined || en[form] !== undefined ? form : `${key}.other`, { n, ...params });
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Mark a parameter of tHtml() as markup, to go in as it is. */
export const html = (markup) => ({ html: markup });

/** As t(), for innerHTML: the string and every parameter are escaped, but
 *  for a parameter given as html(…). */
export function tHtml(key, params = {}) {
  return template(key).split(/(\{\w+\})/).map((part) => {
    const m = /^\{(\w+)\}$/.exec(part);
    if (!m || !Object.hasOwn(params, m[1])) return esc(part);
    const v = params[m[1]];
    return v && typeof v === "object" && "html" in v ? v.html : esc(v);
  }).join("");
}

/** Translate the static markup below `root`, writing only what differs. */
export function applyDom(root = typeof document === "undefined" ? null : document) {
  if (!root) return;
  for (const el of root.querySelectorAll("[data-i18n]")) {
    const s = t(el.dataset.i18n);
    if (el.textContent !== s) el.textContent = s;
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    const s = t(el.dataset.i18nTitle);
    if (el.title !== s) el.title = s;
  }
  for (const el of root.querySelectorAll("[data-i18n-aria]")) {
    const s = t(el.dataset.i18nAria);
    if (el.getAttribute("aria-label") !== s) el.setAttribute("aria-label", s);
  }
}
