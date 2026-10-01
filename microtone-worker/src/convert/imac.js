// IMAC (Iyagi Music Archival Container) — the files The IMS Archive serves
// (imsarchive.curioustorvald.com). One IMAC is one original song: every
// arrangement and revision of it that circulated is a VARIANT, and each variant
// keeps the files that travelled together — the song, its instrument bank, its
// lyrics — byte for byte as they were found, plus a JSON of what is known.
//
// Microtone opens the songs inside, not the container: a variant's .ims (with
// its own .bnk, when it came with one) or .sop goes down the ordinary import
// path, so an IMAC needs no converter of its own.
//
// The container is RIFF, form type "IMAC":
//
//   RIFF <size> "IMAC"
//     "modT" <8>  u64 LE, last update, Unix seconds
//     "creT" <8>  u64 LE, creation, Unix seconds
//     "V000" <n>  a variant: a run of sub-chunks, exactly like a LIST body
//       "IMS " / "ROL " / "SOP " / "KIS " / "ONG "   the music, one per kind present
//       "ISS " / "TXT "                              lyrics, and their text source
//       "BNK " / "2IM " / "2IS "                     instruments
//       "META"                                       UTF-8 JSON
//     "V001" ...
//
// Every chunk is padded to an even length and the size never counts the pad.
// A chunk ID names what the bytes ARE, which the archive established when it
// built the file — so a song filed under a name that lies (this corpus is full
// of them) is still found under the right ID. META carries the verbatim file
// names, which is what the import is labelled with.
//
// The archive's own reader is tapgol-worker/imac.js in theimsarchive-web; this
// is the reading half of it.

const dec = new TextDecoder();

/** Song kinds inside an IMAC that Microtone has a converter for. A variant's
 *  .rol, .kis or .ong is shown to nobody: there is nothing to convert it with. */
const SONG_CHUNKS = { "IMS ": "ims", "SOP ": "sop" };

/** True when `bytes` is an IMAC, whatever the file was called. */
export function isImac(bytes) {
  return bytes.length >= 12
    && dec.decode(bytes.subarray(0, 4)) === "RIFF"
    && dec.decode(bytes.subarray(8, 12)) === "IMAC";
}

function* chunks(b, from, to) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = from;
  while (o + 8 <= to) {
    const id = dec.decode(b.subarray(o, o + 4));
    const size = dv.getUint32(o + 4, true);
    if (o + 8 + size > to) throw new Error(`IMAC chunk ${id} runs past its parent`);
    yield { id, body: b.subarray(o + 8, o + 8 + size) };
    o += 8 + size + (size & 1);
  }
}

/**
 * The variants of an IMAC, in order: `{index, files, meta}`, with `files`
 * keyed by chunk ID and `meta` the parsed JSON (or null).
 * @param {Uint8Array} bytes
 */
export function readImac(bytes) {
  if (!isImac(bytes)) throw new Error("not an IMAC file");
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  const variants = [];
  for (const c of chunks(bytes, 12, Math.min(bytes.length, 8 + size))) {
    if (!/^V\d{3}$/.test(c.id)) continue;
    const v = { index: Number(c.id.slice(1)), files: {}, meta: null };
    for (const s of chunks(c.body, 0, c.body.length)) {
      if (s.id !== "META") { v.files[s.id] = s.body; continue; }
      try { v.meta = JSON.parse(dec.decode(s.body)); } catch { /* a label is all it was for */ }
    }
    variants.push(v);
  }
  return variants.sort((a, b) => a.index - b.index);
}

/**
 * Everything in an IMAC that Microtone can import, as
 * `{variant, name, bytes, bank, title}`: one entry per song file, variant by
 * variant (a few variants carry both an .ims and a .sop of one arrangement).
 *
 * `name` is the file's own name from META with its extension set to what the
 * chunk says it is, because the converter is chosen by extension. `bank` is the
 * variant's own .bnk for an .ims, else null — the import then falls back the way
 * it does for a lone .ims. `title` is the archive's name for the song.
 * @param {Uint8Array} bytes
 * @param {string} [fileName] the IMAC's own name, for a variant META leaves unnamed
 */
export function imacSongs(bytes, fileName = "song.imac") {
  const stem = (n) => String(n).replace(/\.[^.]*$/, "");
  const fallback = stem(fileName.split("/").pop());
  const out = [];
  for (const v of readImac(bytes)) {
    const named = v.meta?.files ?? {};
    const title = v.meta?.metadata?.songname ?? "";
    for (const [id, kind] of Object.entries(SONG_CHUNKS)) {
      const song = v.files[id];
      if (!song?.length) continue;
      const bank = kind === "ims" && v.files["BNK "]?.length
        ? { name: named.bnk_filename || `${fallback}.bnk`, bytes: Uint8Array.from(v.files["BNK "]) }
        : null;
      out.push({
        variant: v.index,
        name: `${stem(named[`${kind}_filename`] || fallback)}.${kind}`,
        bytes: Uint8Array.from(song),
        bank,
        title,
      });
    }
  }
  return out;
}
