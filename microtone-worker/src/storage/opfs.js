// OPFS virtual disk: projects live under <opfs>/projects/*.taud. Writes go
// through createWritable when the browser has it (Chromium/Firefox) and fall
// back to a worker + createSyncAccessHandle (Safari lacks main-thread
// createWritable). Absent OPFS entirely (some private modes) the caller gets
// available() === false and should degrade to in-memory + export-banner.

const WORKER_URL = new URL("./opfs-worker.js", import.meta.url);

let _root = null;
let _worker = null;
let _workerSeq = 0;
const _workerPending = new Map();

export async function available() {
  try {
    if (_root === null) _root = await navigator.storage.getDirectory();
    return true;
  } catch {
    return false;
  }
}

async function projectsDir(create = true, dirName = "projects") {
  if (_root === null) _root = await navigator.storage.getDirectory();
  return _root.getDirectoryHandle(dirName, { create });
}

// ── autosave dir (recovery copies, outside the project listing) ──
//
// Named by the project's PATH; a folder's "/" cannot be in a file name, so it
// is stored as %2F (and a "%" as %25). Every function here takes and gives
// the path.

const autosaveFile = (path) => path.replace(/%/g, "%25").replace(/\//g, "%2F");
const autosavePath = (file) => file.replace(/%(25|2F)/g, (_, c) => (c === "25" ? "%" : "/"));

export async function writeAutosave(path, bytes) {
  const name = autosaveFile(path);
  const dir = await projectsDir(true, "autosave");
  const handle = await dir.getFileHandle(name, { create: true });
  if (typeof handle.createWritable === "function") {
    const w = await handle.createWritable();
    await w.write(bytes);
    await w.close();
  } else {
    await workerWrite(name, bytes, "autosave");
  }
}

export async function listAutosaves() {
  try {
    const dir = await projectsDir(false, "autosave");
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== "file") continue;
      const f = await handle.getFile();
      out.push({ name: autosavePath(name), size: f.size, mtime: f.lastModified });
    }
    return out;
  } catch {
    return [];
  }
}

export async function readAutosave(path) {
  const dir = await projectsDir(false, "autosave");
  const f = await (await dir.getFileHandle(autosaveFile(path))).getFile();
  return new Uint8Array(await f.arrayBuffer());
}

export async function removeAutosave(path) {
  try {
    const dir = await projectsDir(false, "autosave");
    await dir.removeEntry(autosaveFile(path));
  } catch { /* absent is fine */ }
}

// ── keymap dir (.taudkey jam layouts) ──
//
// A keymap is a PERFORMER preference, not project data, so it lives in its own
// directory and never appears in the File tab's song list. Text in, text out —
// .taudkey is a text format, unlike everything else stored here.

const KEYMAP_DIR = "keymaps";

export async function writeKeymap(name, text) {
  const dir = await projectsDir(true, KEYMAP_DIR);
  const bytes = new TextEncoder().encode(text);
  const handle = await dir.getFileHandle(name, { create: true });
  if (typeof handle.createWritable === "function") {
    const w = await handle.createWritable();
    await w.write(bytes);
    await w.close();
  } else {
    await workerWrite(name, bytes, KEYMAP_DIR);
  }
}

export async function listKeymaps() {
  try {
    const dir = await projectsDir(false, KEYMAP_DIR);
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "file") out.push(name);
    }
    out.sort((a, b) => a.localeCompare(b));
    return out;
  } catch {
    return [];
  }
}

export async function readKeymap(name) {
  const dir = await projectsDir(false, KEYMAP_DIR);
  const f = await (await dir.getFileHandle(name)).getFile();
  return f.text();
}

export async function removeKeymap(name) {
  try {
    const dir = await projectsDir(false, KEYMAP_DIR);
    await dir.removeEntry(name);
  } catch { /* absent is fine */ }
}

// ── soundfont dir (converted .taud.sf2.gz, the File view's Soundfonts tab) ──
//
// A soundfont is an instrument SOURCE, not a project, so like a keymap it has
// its own directory and stays out of the song list. Each file is the gzipped
// output of sf2taudify.py, kept as it came out; a reader gets the File itself,
// which can be streamed through a DecompressionStream or downloaded as is.

const SOUNDFONT_DIR = "soundfonts";

export async function writeSoundfont(name, bytes) {
  const dir = await projectsDir(true, SOUNDFONT_DIR);
  const handle = await dir.getFileHandle(name, { create: true });
  if (typeof handle.createWritable === "function") {
    const w = await handle.createWritable();
    await w.write(bytes);
    await w.close();
  } else {
    await workerWrite(name, bytes, SOUNDFONT_DIR);
  }
}

/** Beside the soundfonts: what is known about each one that its file does not
 *  say — the note its owner left on it, the .sf2 it was made from — as JSON,
 *  { "<file name>": { note, source } }. */
const SOUNDFONT_INDEX = "index.json";

export async function readSoundfontIndex() {
  try {
    const dir = await projectsDir(false, SOUNDFONT_DIR);
    const f = await (await dir.getFileHandle(SOUNDFONT_INDEX)).getFile();
    const index = JSON.parse(await f.text());
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
    const dir = await projectsDir(false, SOUNDFONT_DIR);
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== "file" || name === SOUNDFONT_INDEX) continue;
      const f = await handle.getFile();
      out.push({ name, size: f.size, mtime: f.lastModified });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  } catch {
    return [];
  }
}

/** The stored file (a File, so it can be streamed or downloaded as is). */
export async function soundfontFile(name) {
  const dir = await projectsDir(false, SOUNDFONT_DIR);
  return (await dir.getFileHandle(name)).getFile();
}

export async function removeSoundfont(name) {
  try {
    const dir = await projectsDir(false, SOUNDFONT_DIR);
    await dir.removeEntry(name);
  } catch { /* absent is fine */ }
}

// ── projects (the File view's list) ──
//
// A project is named by its PATH under projects/: "song.taud" at the top,
// "Album/Demos/song.taud" in folders, which are real OPFS directories. Every
// function here takes such a path; "" is the top folder itself.

/** A name a file or folder may have: no separators, not "." or "..", and
 *  nothing an OPFS refuses on some platform. */
export function validName(name) {
  return typeof name === "string" && name.trim() === name && name !== "" &&
    name !== "." && name !== ".." && !/[\\/\x00-\x1f]/.test(name) && name.length <= 200;
}

/** "A/B/x.taud" → { folder: "A/B", name: "x.taud" }. */
export function splitPath(path) {
  const at = path.lastIndexOf("/");
  return at < 0 ? { folder: "", name: path } : { folder: path.slice(0, at), name: path.slice(at + 1) };
}

/** Folder + name → path ("" + "x.taud" → "x.taud"). */
export function joinPath(folder, name) {
  return folder ? `${folder}/${name}` : name;
}

/** The directory handle of `folder` under projects/, made on the way when
 *  `create`; throws NotFoundError otherwise. */
async function folderDir(folder, create) {
  let dir = await projectsDir(create);
  for (const part of folder ? folder.split("/") : []) {
    dir = await dir.getDirectoryHandle(part, { create });
  }
  return dir;
}

/**
 * Everything under projects/, in one walk: `files` [{ name: path, size,
 * mtime }] and `folders` [path] (empty ones included), each sorted by path.
 * Empty when there is no OPFS or nothing yet.
 */
export async function tree() {
  const files = [];
  const folders = [];
  async function walk(dir, prefix) {
    for await (const [name, handle] of dir.entries()) {
      const path = joinPath(prefix, name);
      if (handle.kind === "directory") {
        folders.push(path);
        await walk(handle, path);
      } else {
        const f = await handle.getFile();
        files.push({ name: path, size: f.size, mtime: f.lastModified });
      }
    }
  }
  try {
    await walk(await projectsDir(false), "");
  } catch { /* no projects directory yet */ }
  const byPath = (a, b) => a.localeCompare(b);
  files.sort((a, b) => byPath(a.name, b.name));
  folders.sort(byPath);
  return { files, folders };
}

/** Every project, in every folder: [{ name: path, size, mtime }]. */
export async function list() {
  return (await tree()).files;
}

/** Is there a file — or a folder — at `path`? */
export async function exists(path) {
  const { folder, name } = splitPath(path);
  let dir;
  try {
    dir = await folderDir(folder, false);
  } catch {
    return false;
  }
  for (const kind of ["getFileHandle", "getDirectoryHandle"]) {
    try {
      await dir[kind](name);
      return true;
    } catch { /* not this kind */ }
  }
  return false;
}

export async function read(path) {
  const { folder, name } = splitPath(path);
  const dir = await folderDir(folder, false);
  const handle = await dir.getFileHandle(name);
  const f = await handle.getFile();
  return new Uint8Array(await f.arrayBuffer());
}

/** Write a project; its folder is made if it is not there (a Save after the
 *  folder was deleted puts it back). */
export async function write(path, bytes) {
  const { folder, name } = splitPath(path);
  const dir = await folderDir(folder, true);
  const handle = await dir.getFileHandle(name, { create: true });
  if (typeof handle.createWritable === "function") {
    const w = await handle.createWritable();
    await w.write(bytes);
    await w.close();
    return;
  }
  // Safari: sync access handles only exist in workers.
  await workerWrite(name, bytes, ["projects", ...(folder ? folder.split("/") : [])]);
}

export async function remove(path) {
  const { folder, name } = splitPath(path);
  const dir = await folderDir(folder, false);
  await dir.removeEntry(name);
}

/** Rename or move a project. The new copy is written before the old one goes,
 *  so a failure half-way leaves two copies, never none. */
export async function rename(oldPath, newPath) {
  const bytes = await read(oldPath);
  await write(newPath, bytes);
  await remove(oldPath);
}

/** Make a folder (and any folder above it). */
export async function makeFolder(path) {
  await folderDir(path, true);
}

/** Delete a folder and everything in it. */
export async function removeFolder(path) {
  const { folder, name } = splitPath(path);
  const dir = await folderDir(folder, false);
  await dir.removeEntry(name, { recursive: true });
}

/**
 * Rename or move a folder with everything in it. OPFS has no portable way to
 * move a directory, so its projects are copied across one by one and the old
 * folder goes only once all of them have landed.
 */
export async function renameFolder(oldPath, newPath) {
  const { files, folders } = await tree();
  const inside = (p) => p.startsWith(oldPath + "/");
  const moved = (p) => newPath + p.slice(oldPath.length);
  await makeFolder(newPath);
  for (const f of folders.filter(inside)) await makeFolder(moved(f));
  for (const f of files.filter((e) => inside(e.name))) await write(moved(f.name), await read(f.name));
  await removeFolder(oldPath);
}

/** `dirs`: the directory path from the OPFS root — a name, or a list of them. */
function workerWrite(name, bytes, dirs = "projects") {
  if (_worker === null) {
    _worker = new Worker(WORKER_URL, { type: "module" });
    _worker.onmessage = (e) => {
      const { id, error } = e.data;
      const pending = _workerPending.get(id);
      if (!pending) return;
      _workerPending.delete(id);
      if (error) pending.reject(new Error(error));
      else pending.resolve();
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++_workerSeq;
    _workerPending.set(id, { resolve, reject });
    const copy = bytes.slice(); // transfer a private copy
    const dirPath = Array.isArray(dirs) ? dirs : [dirs];
    _worker.postMessage({ id, name, dirPath, bytes: copy.buffer }, [copy.buffer]);
  });
}
