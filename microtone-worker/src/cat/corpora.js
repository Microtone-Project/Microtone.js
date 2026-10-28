// What the workbench translates: each app's language tables, found by URL
// relative to the page (translation/index.html) and saved by their path in
// the repository.
//
// The tracker's tables are part of the site. Touch's are not (it is its own
// site, touch.microtone.cc), so the tracker's deploy stages a copy at
// translation/touch/ (tools/stage-site.js --translation); served from the
// repository root, the page reaches the real ones instead.

export const CORPORA = [
  {
    id: "tracker",
    name: "Microtone",
    urls: ["../src/ui/lang/"],
    repo: "microtone-worker/src/ui/lang/",
    register: "microtone-worker/src/ui/i18n.js (LANGS)",
  },
  {
    id: "touch",
    name: "Microtone Touch",
    urls: ["touch/", "../../microtone-touch-worker/src/lang/"],
    repo: "microtone-touch-worker/src/lang/",
    register: "microtone-touch-worker/src/i18n.js (LANGS, TABLES) and its index.html's early script",
  },
];

/** Every language the apps speak besides English, by its own name — the
 *  union of both apps' LANGS (test/node/cat.test.js keeps it so). */
export const LANGUAGES = { ko: "한국어" };

/** The workbench's own record per language: the glossary, and what each
 *  translation was last checked against (project.js). */
export const dataUrl = (lang) => `data/${lang}.json`;
export const dataRepoPath = (lang) => `microtone-worker/translation/data/${lang}.json`;

/** A language code as BCP 47 spells it: ko, pt-BR, zh-Hant. */
export const LANG_CODE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** Keys that are not prose: shown and editable, never checked or remembered. */
export const isTechnical = (key) => key.startsWith("css.");
