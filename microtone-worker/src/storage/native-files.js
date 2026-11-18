// The desktop app's store (desktop-qt/src/filestore.cpp): projects,
// soundfonts and keymaps as ordinary files in a folder of the person's own —
// ~/Microtone/{Projects,Soundfonts,Keymaps}, %USERPROFILE%\Microtone on
// Windows — and the autosave copies in the app's data. The same functions as
// opfs-browser.js, over /api/files on the app's own server; opfs.js picks
// this one wherever the shell says it has a store
// (window.__MICROTONE_NATIVE__.files).
//
// An error a caller may catch as "not there" is thrown as OPFS throws it: a
// NotFoundError.

const FILES = globalThis.__MICROTONE_NATIVE__?.files ?? null;

/** Is the shell's store there? */
export const enabled = FILES !== null;

const BASE = FILES?.base ?? "/api/files";
const SOUNDFONT_INDEX = "index.json";

/** "A/B c/x.taud" → "A/B%20c/x.taud": each name encoded, the separators not. */
const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

function url(store, path = "", query = "") {
  return `${BASE}/${store}${path ? "/" + encodePath(path) : ""}${query ? "?" + query : ""}`;
}

async function check(res, what) {
  if (res.ok) return res;
  const why = await res.text().catch(() => "");
  const err = new Error(`${what}: ${why || res.status}`);
  if (res.status === 404) err.name = "NotFoundError";
  throw err;
}

async function listStore(store) {
  const res = await fetch(url(store, "", "list"));
  await check(res, `listing ${store}`);
  return res.json();  // { files: [{ name, size, mtime }], folders: [path] }
}

async function readBytes(store, path) {
  const res = await check(await fetch(url(store, path)), `reading ${path}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function writeBytes(store, path, bytes) {
  await check(await fetch(url(store, path), { method: "PUT", body: bytes }), `writing ${path}`);
}

async function removePath(store, path, recursive = false) {
  await check(await fetch(url(store, path, recursive ? "recursive" : ""), { method: "DELETE" }), `deleting ${path}`);
}

async function stat(store, path) {
  const res = await fetch(url(store, path, "stat"));
  if (res.status === 404) return null;
  await check(res, `looking at ${path}`);
  return res.json();  // { kind, size, mtime }
}

async function move(store, from, to) {
  await check(await fetch(url(store, from, "moveTo=" + encodeURIComponent(to)), { method: "POST" }), `moving ${from}`);
}

export async function available() {
  return true;
}

/** Where a store's files are, as the person would write it ("~/Microtone/Projects"). */
export function location(store) {
  return FILES?.[store] ?? null;
}

/** Show a store's folder (or `path`'s) in the system's file manager. */
export async function reveal(store, path = "") {
  await check(await fetch(url(store, path, "reveal"), { method: "POST" }), "showing the folder");
}

// ── autosave (named by the project's path, flattened as opfs-browser.js does) ──

const autosaveFile = (path) => path.replace(/%/g, "%25").replace(/\//g, "%2F");
const autosavePath = (file) => file.replace(/%(25|2F)/g, (_, c) => (c === "25" ? "%" : "/"));

export async function writeAutosave(path, bytes) {
  await writeBytes("autosave", autosaveFile(path), bytes);
}

export async function listAutosaves() {
  try {
    const { files } = await listStore("autosave");
    return files.filter((f) => !f.name.includes("/")).map((f) => ({ ...f, name: autosavePath(f.name) }));
  } catch {
    return [];
  }
}

export async function readAutosave(path) {
  return readBytes("autosave", autosaveFile(path));
}

export async function removeAutosave(path) {
  try { await removePath("autosave", autosaveFile(path)); } catch { /* absent is fine */ }
}

// ── keymaps ──

export async function writeKeymap(name, text) {
  await writeBytes("keymaps", name, new TextEncoder().encode(text));
}

export async function listKeymaps() {
  try {
    const { files } = await listStore("keymaps");
    return files.map((f) => f.name).filter((n) => !n.includes("/")).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export async function readKeymap(name) {
  return new TextDecoder().decode(await readBytes("keymaps", name));
}

export async function removeKeymap(name) {
  try { await removePath("keymaps", name); } catch { /* absent is fine */ }
}

// ── soundfonts ──

export async function writeSoundfont(name, bytes) {
  await writeBytes("soundfonts", name, bytes);
}

export async function readSoundfontIndex() {
  try {
    const index = JSON.parse(new TextDecoder().decode(await readBytes("soundfonts", SOUNDFONT_INDEX)));
    return index && typeof index === "object" ? index : {};
  } catch {
    return {};
  }
}

export async function writeSoundfontIndex(index) {
  await writeSoundfont(SOUNDFONT_INDEX, new TextEncoder().encode(JSON.stringify(index, null, 1)));
}

export async function listSoundfonts() {
  try {
    const { files } = await listStore("soundfonts");
    return files.filter((f) => !f.name.includes("/") && f.name !== SOUNDFONT_INDEX)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** The stored file, as a File (streamed or downloaded as is). */
export async function soundfontFile(name) {
  const res = await check(await fetch(url("soundfonts", name)), `reading ${name}`);
  const modified = Date.parse(res.headers.get("Last-Modified") ?? "");
  return new File([await res.blob()], name, Number.isFinite(modified) ? { lastModified: modified } : {});
}

export async function removeSoundfont(name) {
  try { await removePath("soundfonts", name); } catch { /* absent is fine */ }
}

// ── projects ──

export async function tree() {
  try {
    const { files, folders } = await listStore("projects");
    const byPath = (a, b) => a.localeCompare(b);
    return { files: files.sort((a, b) => byPath(a.name, b.name)), folders: folders.sort(byPath) };
  } catch {
    return { files: [], folders: [] };
  }
}

export async function list() {
  return (await tree()).files;
}

export async function exists(path) {
  return (await stat("projects", path)) !== null;
}

export async function read(path) {
  return readBytes("projects", path);
}

export async function write(path, bytes) {
  await writeBytes("projects", path, bytes);
}

export async function remove(path) {
  await removePath("projects", path);
}

/** A real rename: no copy, so a big project moves at once. */
export async function rename(oldPath, newPath) {
  await move("projects", oldPath, newPath);
}

export async function makeFolder(path) {
  await check(await fetch(url("projects", path, "mkdir"), { method: "POST" }), `making ${path}`);
}

export async function removeFolder(path) {
  await removePath("projects", path, true);
}

export async function renameFolder(oldPath, newPath) {
  await move("projects", oldPath, newPath);
}

// ── what the earlier desktop app kept (desktop-qt/src/oldapp.h) ──

/** How the shell's copy from the earlier desktop app went: { state:
 *  "running"|"done", found, projects, soundfonts, keymaps, beside, failed,
 *  tell }. */
export async function oldAppStatus() {
  const res = await fetch(`${BASE}/oldapp`);
  await check(res, "asking how the earlier app's projects came over");
  return res.json();
}

/** The person has been told: `tell` is false from now on. */
export async function oldAppTold() {
  await check(await fetch(`${BASE}/oldapp?told`, { method: "POST" }), "noting that it was said");
}

/** A name every system can hold (filestore.cpp's portableName): the folder
 *  may be synced between them. */
export function portableName(name) {
  return !/[<>:"|?*]/.test(name) && !/[. ]$/.test(name) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name);
}
