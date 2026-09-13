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

export async function writeAutosave(name, bytes) {
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
      out.push({ name, size: f.size, mtime: f.lastModified });
    }
    return out;
  } catch {
    return [];
  }
}

export async function readAutosave(name) {
  const dir = await projectsDir(false, "autosave");
  const f = await (await dir.getFileHandle(name)).getFile();
  return new Uint8Array(await f.arrayBuffer());
}

export async function removeAutosave(name) {
  try {
    const dir = await projectsDir(false, "autosave");
    await dir.removeEntry(name);
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

export async function list() {
  try {
    const dir = await projectsDir(false);
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== "file") continue;
      const f = await handle.getFile();
      out.push({ name, size: f.size, mtime: f.lastModified });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  } catch {
    return [];
  }
}

export async function read(name) {
  const dir = await projectsDir(false);
  const handle = await dir.getFileHandle(name);
  const f = await handle.getFile();
  return new Uint8Array(await f.arrayBuffer());
}

export async function write(name, bytes) {
  const dir = await projectsDir(true);
  const handle = await dir.getFileHandle(name, { create: true });
  if (typeof handle.createWritable === "function") {
    const w = await handle.createWritable();
    await w.write(bytes);
    await w.close();
    return;
  }
  // Safari: sync access handles only exist in workers.
  await workerWrite(name, bytes);
}

export async function remove(name) {
  const dir = await projectsDir(false);
  await dir.removeEntry(name);
}

export async function rename(oldName, newName) {
  const bytes = await read(oldName);
  await write(newName, bytes);
  await remove(oldName);
}

function workerWrite(name, bytes, dirName = "projects") {
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
    _worker.postMessage({ id, name, dirName, bytes: copy.buffer }, [copy.buffer]);
  });
}
