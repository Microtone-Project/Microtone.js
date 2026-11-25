// The instrument library — instrument packs (.tsii) kept with the projects:
// what Export… in the Instruments view writes, and what the File view's
// Instruments tab lists (OPFS instruments/ in a browser, ~/Microtone/
// Instruments on the desktop). A pack goes out from there as a download, or
// into the open project through the same picker Import… uses.
//
// A pack may carry its OWN name, copyright and message (PNam / PCpr / PMsg,
// TAUD_FILE_FORMAT.md §8) — the pack's, not the project's it was exported
// from; loading a .tsii never touches the project's strings. They are read
// once, when a pack comes in, and kept in the index beside the note its owner
// leaves on it: { "<file>": { note, pack: { name, copyright } } }. A file
// someone drops into the desktop's folder by hand has no copy there until the
// tab reads it (`fillPackStrings`).
//
// Every File view copy reads the same state through this module;
// `onInstrumentLibraryChange` tells them when to redraw.

import * as opfs from "../storage/opfs.js";
import { downloadBlob } from "../storage/import-export.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { decodeProjectString, encodeProjectString } from "../../core/format/names.js";

export const PACK_EXT = ".tsii";

/** The pack strings a .tsii may carry, in the order a dialog asks for them. */
export const PACK_FIELDS = Object.freeze([
  ["name", "PNam"], ["copyright", "PCpr"], ["message", "PMsg"],
]);

const listeners = new Set();
let showLibrary = null; // set by the app: open the File view on this tab

function changed() { for (const fn of listeners) fn(); }

/** Call `fn` whenever the library changes. Returns an unsubscribe. */
export function onInstrumentLibraryChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** The app's way to the Instruments tab, for a banner's Show button. */
export function setShowInstrumentLibrary(fn) { showLibrary = fn; }
export function showInstrumentLibrary() { showLibrary?.(); }

/** The name a pack is shown under: its file name without the extension. */
export function packTitle(file) {
  return file.replace(/\.tsii$/i, "");
}

/** The file a pack called `title` is stored as. */
export function packFile(title) {
  return packTitle(String(title).trim()) + PACK_EXT;
}

/** The stored packs, by name: [{ file, title, size, mtime, note, pack }]. */
export async function libraryPacks() {
  if (!(await opfs.available())) return [];
  const [files, index] = await Promise.all([opfs.listInstrumentPacks(), opfs.readInstrumentIndex()]);
  return files.filter((f) => f.name.toLowerCase().endsWith(PACK_EXT)).map((f) => ({
    file: f.name, title: packTitle(f.name), size: f.size, mtime: f.mtime,
    note: String(index[f.name]?.note ?? ""),
    pack: index[f.name]?.pack ?? null,
  }));
}

/**
 * The pack strings in a .tsii's bytes: { name, copyright, message }, each ""
 * when absent. Throws when the bytes are not a .tsii.
 */
export function readPackStrings(bytes) {
  const parsed = parseTaud(bytes);
  if (parsed.kind !== "tsii") throw new Error("not an instrument pack (.tsii)");
  const out = {};
  for (const [key, fourcc] of PACK_FIELDS) {
    const sec = parsed.projSections.find((s) => s.fourcc === fourcc);
    let text = "";
    if (sec) {
      const nul = sec.payload.indexOf(0);
      text = new TextDecoder().decode(sec.payload.subarray(0, nul < 0 ? sec.payload.length : nul));
    }
    out[key] = decodeProjectString(fourcc, text);
  }
  return out;
}

/** The sections a pack's strings become (only the ones that are filled in). */
export function packSections(pack = {}) {
  const out = [];
  for (const [key, fourcc] of PACK_FIELDS) {
    const text = String(pack?.[key] ?? "").trim();
    if (text) out.push({ fourcc, payload: encodeProjectString(fourcc, text) });
  }
  return out;
}

/** Is `file` taken? */
export async function packExists(file) {
  return (await libraryPacks()).some((p) => p.file === file);
}

/**
 * Store a pack under `file` (replacing one of that name), with the strings it
 * carries copied into the index. The note on a replaced pack stays.
 */
export async function savePack(file, bytes, pack) {
  await opfs.writeInstrumentPack(file, bytes);
  const index = await opfs.readInstrumentIndex();
  const entry = { ...(index[file] ?? {}) };
  // Recorded even when empty: it says the file has been read.
  entry.pack = { name: String(pack?.name ?? "").trim(), copyright: String(pack?.copyright ?? "").trim() };
  index[file] = entry;
  await opfs.writeInstrumentIndex(index);
  changed();
}

/**
 * Add picked .tsii files to the library. `confirmReplace(title)` →
 * Promise<boolean> is asked when the name is taken; `failed(name, err)` hears
 * about a file that is not a pack. Resolves with how many went in.
 */
export async function addPackFiles(files, { confirmReplace, failed = () => {} }) {
  const stored = new Set((await libraryPacks()).map((p) => p.file));
  let taken = 0;
  for (const f of files) {
    const file = packFile(f.name);
    let bytes, pack;
    try {
      bytes = new Uint8Array(await f.arrayBuffer());
      pack = readPackStrings(bytes);
    } catch (err) {
      failed(f.name, err);
      continue;
    }
    if (stored.has(file) && !(await confirmReplace(packTitle(file)))) continue;
    await savePack(file, bytes, pack);
    stored.add(file);
    taken++;
  }
  return taken;
}

/** Leave a note on a stored pack (an empty one removes it). */
export async function setPackNote(file, note) {
  const index = await opfs.readInstrumentIndex();
  const entry = { ...(index[file] ?? {}) };
  const text = note.trim();
  if (text) entry.note = text; else delete entry.note;
  if (Object.keys(entry).length) index[file] = entry; else delete index[file];
  await opfs.writeInstrumentIndex(index);
  changed();
}

export async function removePack(file) {
  await opfs.removeInstrumentPack(file);
  const index = await opfs.readInstrumentIndex();
  if (file in index) { delete index[file]; await opfs.writeInstrumentIndex(index); }
  changed();
}

/** The stored pack's bytes. */
export async function loadPack(file) {
  return new Uint8Array(await (await opfs.instrumentPackFile(file)).arrayBuffer());
}

/** Save the stored .tsii as it is. */
export async function downloadPack(file) {
  downloadBlob(await opfs.instrumentPackFile(file), file);
}

/**
 * Read the strings of the packs the index has no copy of (one dropped into
 * the desktop's folder by hand) and remember them. Resolves true when any
 * were added. Quietly skips a file it cannot read.
 */
const unreadable = new Set(); // files already found not to be packs, this session

export async function fillPackStrings(packs) {
  const missing = packs.filter((p) => p.pack === null && !unreadable.has(p.file));
  if (missing.length === 0) return false;
  const index = await opfs.readInstrumentIndex();
  let any = false;
  for (const p of missing) {
    try {
      const s = readPackStrings(await loadPack(p.file));
      index[p.file] = { ...(index[p.file] ?? {}), pack: { name: s.name, copyright: s.copyright } };
      any = true;
    } catch {
      unreadable.add(p.file); // the Import button says what is wrong with it
    }
  }
  if (any) {
    await opfs.writeInstrumentIndex(index);
    changed();
  }
  return any;
}
