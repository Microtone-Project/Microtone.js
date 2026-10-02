// Session soundfont sources — the bundled GeneralUser bank next to
// index.html and/or a user-picked .sf2, each fetched/picked once per session.
// MIDI import (topbar button, drag-drop, ?load=) and the Instruments Add…
// shortcut share these caches.
//
// The primary bundle is GeneralUser-GS.taud.sf2.gz — the sf2taudify.py build
// (Taud-conformant samples, gzipped under the Cloudflare Pages 25 MiB
// per-file limit; committed as a plain git object, no LFS). The plain
// GeneralUser-GS.sf2 stays as a fallback for trees without the build.

import { pickFile } from "../storage/import-export.js";
import { gunzipSync } from "../../core/vendor/fflate.esm.js";

let bundled;        // undefined = not tried, null = unavailable, else {name, bytes}
let userSf2 = null; // last user-picked {name, bytes}

const BUNDLE_CANDIDATES = ["GeneralUser-GS.taud.sf2.gz", "GeneralUser-GS.sf2"];

/** The bundled soundfont, or null when not deployed alongside the app.
 *  Gunzips a .gz candidate (sniffed, so a host that transparently decodes it
 *  also works) and guards the RIFF magic: a host that checked out Git LFS
 *  without pulling objects serves the ~130-byte POINTER FILE with a 200. */
export async function getBundledSoundfont() {
  if (bundled !== undefined) return bundled;
  bundled = null;
  for (const candidate of BUNDLE_CANDIDATES) {
    try {
      const res = await fetch(new URL("assets/"+candidate, document.baseURI));
      if (!res.ok) continue;
      let bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
        try { bytes = gunzipSync(bytes); } catch { continue; }
      }
      if (bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 &&
          bytes[2] === 0x46 && bytes[3] === 0x46) { // "RIFF"
        bundled = { name: candidate.replace(/\.gz$/, ""), bytes };
        break;
      }
      console.warn(`bundled ${candidate} is not a RIFF file (Git LFS pointer?) — ignoring`);
    } catch { /* try the next candidate */ }
  }
  return bundled;
}

/** Ask the user for an .sf2; null on cancel. The pick is cached for reuse. */
export async function pickUserSoundfont() {
  const file = await pickFile(".sf2");
  if (!file) return null;
  userSf2 = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
  return userSf2;
}

/** Automatic resolution: bundled → last user pick → file picker. Null when
 *  the user cancels. Used by the paths without an explicit choice UI
 *  (drag-drop / ?load= MIDI, Instruments Add…). */
export async function getSoundfont() {
  return (await getBundledSoundfont()) ?? userSf2 ?? pickUserSoundfont();
}
