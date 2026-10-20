// Demo projects (item 163) — the songs bundled under assets/demo_projects/,
// offered by the welcome screen's Demos panel and the File tab's "Demo songs…".
//
// demos.json is the list, so shipping another demo is dropping the .taud beside
// it and adding a row — no code change. Those rows repeat what the container
// already stores (title, composer, song count, size) because a row has to be
// DRAWN before half a megabyte is fetched; test/node/demos.test.js parses every
// listed file and fails if the two ever disagree.
//
// The files are not GPL — each is included by its copyright holder's
// permission. See assets/demo_projects/README.md for the terms.

import { t } from "./i18n.js";
import { actionRow } from "./components/actions.js";
import { setIconLabel } from "./icons.js";

// Module-relative, so the list is found wherever the app is served from
// (src/ui/ → the deploy root).
const DIR = new URL("../../assets/demo_projects/", import.meta.url);

let listing = null; // in-flight/settled fetch of demos.json

/** The manifest rows, fetched once per session (a failed fetch may retry). */
export function demoList() {
  if (!listing) {
    listing = fetch(new URL("demos.json", DIR))
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((j) => (Array.isArray(j?.demos) ? j.demos : []))
      .catch((err) => { listing = null; throw err; });
  }
  return listing;
}

/**
 * One demo's bytes. Read through a stream when the length is known so the
 * caller can show a real bar — these are the largest single fetch the app
 * makes, and a determinate popup that never moves reads as a hang.
 */
export async function fetchDemo(entry, onProgress = null) {
  const resp = await fetch(new URL(entry.file, DIR));
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const total = Number(resp.headers.get("content-length")) || entry.bytes || 0;
  if (!onProgress || !total || !resp.body?.getReader) {
    return new Uint8Array(await resp.arrayBuffer());
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(Math.min(1, got / total));
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** "Ambisonic · 4 songs · 552 K" — the dim half of a demo row. */
export function demoMeta(entry) {
  const parts = [];
  const model = entry.surroundModel ?? 0;
  parts.push(t(model === 2 ? "demos.ambisonic" : model === 1 ? "demos.surround" : "demos.stereo"));
  if (entry.songs) parts.push(t(entry.songs === 1 ? "demos.song" : "demos.songs", { n: entry.songs }));
  if (entry.bytes) parts.push(`${Math.round(entry.bytes / 1024)} K`);
  return parts.join(" · ");
}

/** A demo as one full-width clickable row — the shape the Recent list uses. */
export function demoRow(entry, onClick) {
  const b = document.createElement("button");
  b.className = "wc-file demo-row";
  b.title = entry.file;
  const name = document.createElement("span");
  name.className = "wc-file-name";
  const title = document.createElement("b");
  title.textContent = entry.title ?? entry.file;
  name.append(title);
  if (entry.composer) {
    const by = document.createElement("span");
    by.className = "demo-by";
    by.textContent = ` ${t("demos.by", { composer: entry.composer })}`;
    name.append(by);
  }
  const meta = document.createElement("span");
  meta.className = "wc-file-meta";
  meta.textContent = demoMeta(entry);
  b.append(demoIcon(), name, meta);
  b.addEventListener("click", () => onClick(entry));
  return b;
}

/**
 * Fill `body` with the demo rows (or the empty/failed note). Shared by the
 * welcome panel and the File tab's picker so the two can never drift apart.
 * `alive` lets a caller abandon a render its own refresh has superseded.
 */
export async function fillDemos(body, onPick, alive = () => true) {
  let rows;
  try {
    rows = await demoList();
  } catch (err) {
    console.warn(`DEMOS: list unavailable (${err.message})`);
    if (alive()) body.replaceChildren(demoNote(t("demos.listFail"), "wc-warn"));
    return;
  }
  if (!alive()) return;
  body.replaceChildren();
  if (rows.length === 0) { body.appendChild(demoNote(t("demos.none"))); return; }
  for (const e of rows) body.appendChild(demoRow(e, onPick));
  if (rows.some((e) => e.permission)) {
    body.appendChild(demoNote(t("demos.permission"), "demo-foot"));
  }
}

/** The File tab's picker — the same rows in a dialog, for when a document is
 *  already loaded and the welcome screen is out of reach. */
export function showDemoPicker() {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "modal modal-text demo-modal";
    const h = document.createElement("h3");
    h.textContent = t("demos.pickTitle");
    const intro = document.createElement("p");
    intro.className = "dim";
    intro.textContent = t("demos.pickBody");
    const body = document.createElement("div");
    body.className = "demo-list";
    body.appendChild(demoNote(t("welcome.loading")));
    const { row, cancel } = actionRow({ cancel: true });
    dlg.append(h, intro, body, row);
    document.body.appendChild(dlg);

    const finish = (entry) => { dlg.close(); dlg.remove(); resolve(entry); };
    cancel.addEventListener("click", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    dlg.showModal();
    fillDemos(body, finish, () => dlg.isConnected);
  });
}

/** The row's leading glyph. setIconLabel writes INTO an element, so the icon
 *  has to be unwrapped from a throwaway holder to sit as the row's own child —
 *  a wrapper span would take the flex sizing off `.btn-ico`. */
function demoIcon() {
  const holder = document.createElement("span");
  setIconLabel(holder, "demo");
  return holder.firstElementChild ?? holder;
}

function demoNote(text, cls = "") {
  const p = document.createElement("p");
  p.className = cls ? `wc-note ${cls}` : "wc-note";
  p.textContent = text;
  return p;
}
