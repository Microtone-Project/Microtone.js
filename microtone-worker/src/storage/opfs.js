// Where the app keeps its projects, soundfonts, keymaps and autosave copies:
//
//   in a browser       OPFS, the origin's private storage (opfs-browser.js)
//   the desktop app    ordinary files in ~/Microtone, through the shell's
//                      file store (native-files.js, desktop-qt/src/filestore.cpp)
//
// Callers import this module and never learn which — except to say where the
// files are (`location`) and to show the folder (`reveal`), which only the
// desktop has. The name stays "opfs" for the many places that import it.

import * as browser from "./opfs-browser.js";
import * as native from "./native-files.js";

const store = native.enabled ? native : browser;

/** "native" (files in a folder) or "browser" (OPFS). */
export const backend = native.enabled ? "native" : "browser";

export const {
  available,
  writeAutosave, listAutosaves, readAutosave, removeAutosave,
  writeKeymap, listKeymaps, readKeymap, removeKeymap,
  writeSoundfont, readSoundfontIndex, writeSoundfontIndex, listSoundfonts, soundfontFile, removeSoundfont,
  tree, list, exists, read, write, remove, rename, makeFolder, removeFolder, renameFolder,
} = store;

export const { splitPath, joinPath } = browser;

/** A name a file or folder may have. On the desktop it must also be one
 *  every system can hold (no <>:"|?*, no trailing dot or space, no CON…):
 *  the folder may be synced between them. */
export function validName(name) {
  return browser.validName(name) && (!native.enabled || native.portableName(name));
}

/** Where a store's files are, as the person would write it, or null (a
 *  browser: nowhere a person can see). `store`: "projects", "soundfonts",
 *  "keymaps". */
export function location(storeName) {
  return native.enabled ? native.location(storeName) : null;
}

/** Show the folder in the system's file manager (the desktop only). */
export function reveal(storeName, path = "") {
  return native.enabled ? native.reveal(storeName, path) : Promise.resolve();
}
