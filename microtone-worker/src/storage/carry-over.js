// The desktop app's first start with its file store (desktop-qt, 2026-11-19):
// whatever the earlier Qt builds kept in this profile's OPFS — projects with
// their folders, soundfonts with their notes, keymaps — is copied into the
// person's folder (~/Microtone), once.
//
// Nothing in OPFS is deleted, and nothing in the folder is overwritten: a
// path already there keeps what it has. A name a Windows or a Mac folder
// cannot hold is made into one that it can. Autosave copies stay behind:
// they are recovery copies of projects nobody saved. Finished only when
// everything landed; a copy cut short is taken up on the next start, and
// skips what it already did.

import * as browser from "./opfs-browser.js";
import * as native from "./native-files.js";

const DONE_KEY = "microtone-opfs-carried-over";

/** A name every system can hold, made from one that maybe is not. */
export function portableName(name) {
  let n = name.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(n)) n = "_" + n;
  return n || "_";
}

const portablePath = (path) => path.split("/").map(portableName).join("/");

/**
 * What the earlier desktop app (the Tauri build) kept in its webview, which
 * the shell copies into the folder at every start (desktop-qt/src/oldapp.h:
 * read only there; a copy someone has changed since is never overwritten, the
 * new one goes beside it). Waits for that copy and returns { projects,
 * soundfonts, keymaps, beside, tell } — tell: the first time anything came
 * over, to say so — or null where there is no shell or no earlier app.
 */
export async function oldAppCopy({ every = 1000, patience = 30 * 60 } = {}) {
  if (!native.enabled) return null;
  for (let i = 0; i < patience; i++) {
    const status = await native.oldAppStatus();
    if (status.state === "done") return status.found ? status : null;
    await new Promise((r) => setTimeout(r, every));
  }
  return null;
}

/** Said once: the next copies are quiet. */
export const oldAppTold = () => native.oldAppTold();

/**
 * Copy the profile's OPFS into the folder, if that has not been done. Returns
 * { projects, soundfonts, keymaps } (how many were copied), or null when
 * there was nothing to do (a browser, already done, no OPFS).
 */
export async function carryOverFromOpfs() {
  if (!native.enabled) return null;
  try {
    if (localStorage.getItem(DONE_KEY)) return null;
  } catch {
    return null;
  }
  const counts = { projects: 0, soundfonts: 0, keymaps: 0 };
  if (await browser.available()) {
    const { files, folders } = await browser.tree();
    for (const f of folders) await native.makeFolder(portablePath(f));
    for (const f of files) {
      const to = portablePath(f.name);
      if (await native.exists(to)) continue;
      await native.write(to, await browser.read(f.name));
      counts.projects++;
    }

    const have = new Set((await native.listSoundfonts()).map((s) => s.name));
    const theirIndex = await browser.readSoundfontIndex();
    const ourIndex = await native.readSoundfontIndex();
    let indexChanged = false;
    for (const sf of await browser.listSoundfonts()) {
      const to = portableName(sf.name);
      if (have.has(to)) continue;
      await native.writeSoundfont(to, new Uint8Array(await (await browser.soundfontFile(sf.name)).arrayBuffer()));
      counts.soundfonts++;
      if (theirIndex[sf.name] && !ourIndex[to]) {
        ourIndex[to] = theirIndex[sf.name];
        indexChanged = true;
      }
    }
    if (indexChanged) await native.writeSoundfontIndex(ourIndex);

    const keymaps = new Set(await native.listKeymaps());
    for (const name of await browser.listKeymaps()) {
      const to = portableName(name);
      if (keymaps.has(to)) continue;
      await native.writeKeymap(to, await browser.readKeymap(name));
      counts.keymaps++;
    }
  }
  try {
    localStorage.setItem(DONE_KEY, new Date().toISOString());
  } catch { /* the next start tries again, and skips what is there */ }
  return counts;
}
