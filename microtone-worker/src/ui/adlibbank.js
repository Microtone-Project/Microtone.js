// Session AdLib instrument banks — the bundled general bank next to
// index.html and/or a user-picked .BNK, each fetched/picked once per session.
//
// An .ims (and a .rol) stores nothing but nine-character PATCH NAMES, so a bank
// is not optional the way a soundfont is for MIDI: without one every instrument
// is silent. Resolution is most-specific-first and case-INSENSITIVE — exact
// matching resolves 29% of the reference corpus's references and case-folded
// matching 99.95% — which is why the song's own bank is passed ahead of the
// general one rather than merged with it.

import { pickFile } from "../storage/import-export.js";
import { gunzipSync } from "../../core/vendor/fflate.esm.js";

let bundled;        // undefined = not tried, null = unavailable, else {name, bytes}
let userBank = null; // last user-picked {name, bytes}

const BUNDLE_CANDIDATES = ["STANDARD.BNK.gz", "STANDARD.BNK"];

/** True for something that really is an AdLib bank: the signature sits at
 *  offset 2, after the two version bytes. */
function isBank(bytes) {
  return bytes.length >= 8 &&
    String.fromCharCode(...bytes.subarray(2, 8)) === "ADLIB-";
}

/** The bundled general bank, or null when not deployed alongside the app. */
export async function getBundledBank() {
  if (bundled !== undefined) return bundled;
  bundled = null;
  for (const candidate of BUNDLE_CANDIDATES) {
    try {
      const res = await fetch(new URL("assets/" + candidate, document.baseURI));
      if (!res.ok) continue;
      let bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
        try { bytes = gunzipSync(bytes); } catch { continue; }
      }
      if (isBank(bytes)) {
        bundled = { name: candidate.replace(/\.gz$/, ""), bytes };
        break;
      }
      console.warn(`bundled ${candidate} is not an AdLib bank — ignoring`);
    } catch { /* try the next candidate */ }
  }
  return bundled;
}

/** Ask the user for a .BNK; null on cancel. The pick is cached for reuse. */
export async function pickUserBank() {
  const file = await pickFile(".bnk");
  if (!file) return null;
  return rememberBank({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
}

/** Keep a bank for the rest of the session — what a `.bnk` dropped on its own
 *  means, since a bank is not a project and there is nothing else to do with
 *  one. Returns it, or null when the bytes are not a bank. */
export function rememberBank(bank) {
  if (!bank || !isBank(bank.bytes)) return null;
  userBank = bank;
  return userBank;
}

/**
 * The banks one .ims conversion should resolve against, most specific first:
 * whatever came alongside the song, then this session's own pick, then the
 * bundled general bank. Empty only when nothing at all is available.
 */
export async function resolveBanks(songBank = null) {
  const out = [];
  if (songBank && isBank(songBank.bytes)) out.push(songBank);
  if (userBank && userBank !== songBank) out.push(userBank);
  const general = await getBundledBank();
  if (general) out.push(general);
  // A tree without the bundled bank, and nothing supplied: ask, rather than
  // converting a song every one of whose instruments would be silent.
  if (!out.length) {
    const picked = await pickUserBank();
    if (picked) out.push(picked);
  }
  return out;
}
