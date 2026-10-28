// Where a save goes. Served by tools/cat-server.py (the repository, locally),
// the workbench writes the files straight into the checkout; anywhere else
// (microtone.cc) it hands over one .zip of them, laid out by their paths in
// the repository, to unpack at its root.

import { zipSync, strToU8 } from "../../core/vendor/fflate.esm.js";

const PING = "/__cat/ping";
const SAVE = "/__cat/save";

/** True when the page is served by tools/cat-server.py, which can write. */
export async function canWrite() {
  try {
    const r = await fetch(PING, { cache: "no-store" });
    if (!r.ok) return false;
    return (await r.json()).cat === 1;
  } catch {
    return false;
  }
}

/** Write the files into the checkout; resolves the paths written. */
export async function writeFiles(files) {
  const r = await fetch(SAVE, {
    method: "POST",
    // The custom header makes a cross-site page's request a preflighted one,
    // which the server never answers: only this origin can save.
    headers: { "content-type": "application/json", "x-microtone-cat": "1" },
    body: JSON.stringify({ files: files.map(({ path, text }) => ({ path, text })) }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error ?? `the server said ${r.status}`);
  return body.written ?? [];
}

/** The files as a .zip, each at its repository path. */
export function zipBlob(files) {
  const entries = {};
  for (const f of files) entries[f.path] = strToU8(f.text);
  return new Blob([zipSync(entries, { level: 6 })], { type: "application/zip" });
}

export function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}
