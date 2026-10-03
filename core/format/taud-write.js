// Taud container serialiser — multi-song generalisation of LibTaud's
// captureTrackerDataToFile (taud.mjs:415-698). Emits format v2 (v3 for a wide-
// cell document). writeTaud compresses the sections with gzip; writeTaudWith
// takes the compressor, which is how a save gets Zstandard — every Taud loader
// tells the two apart by magic (compress.js). Project-Data sections are
// emitted verbatim from doc.projSections — callers that edit Ixmp/xHDR/sMet
// must rebuild those sections before writing (document-layer concern).

import {
  TAUD_MAGIC, PROJ_MAGIC,
  TAUD_VERSION, TAUD_XHDR_FLAG,
  TAUD_KIND_SAMPLEINST, TAUD_KIND_PATTERN,
  TAUD_HEADER_SIZE, TAUD_SONG_ENTRY,
  PATTERN_SIZE, patternSizeFor, TAUD_VERSION_WIDE, NUM_VOICES, MAX_VOICES, CUE_SIZE, CUE_SIZE_64,
  CAPTURE_SIGNATURE,
} from "./taud-const.js";
import { comp } from "./compress.js";

function pushU16(a, v) { a.push(v & 0xff, (v >>> 8) & 0xff); }
function pushU32(a, v) { a.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); }
function pushF32(a, v) {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setFloat32(0, v, true);
  a.push(buf[0], buf[1], buf[2], buf[3]);
}

/**
 * Serialise a parsed/edited Taud structure (the shape parseTaud returns) back
 * to container bytes, gzip sections. Synchronous and deterministic: the byte
 * view every in-memory comparison (undo byte-exactness, round trips) is made
 * of. A save to disk goes through writeTaudWith instead.
 */
export function writeTaud(doc) {
  const plan = planTaud(doc);
  return assembleTaud(plan, plan.sections.map((bytes) => comp(bytes)));
}

/**
 * writeTaud with the sections compressed by `compressAll`: an async function
 * from the raw sections to their compressed frames, same order and count —
 * core/format/zstd.js's zstdCompressAll for a save. Any frame
 * compress.js decomp() sniffs will do; the loaders only ever look at the
 * magic.
 *
 * `doc` is read completely before the first await, and the raw sections handed
 * over belong to this call (the image, the one section that is the document's
 * own array, is copied), so an edit made while they compress cannot leak into
 * the bytes.
 */
export async function writeTaudWith(doc, compressAll) {
  const plan = planTaud(doc);
  if (plan.hasImage) plan.sections[0] = plan.sections[0].slice();
  const packed = await compressAll(plan.sections);
  if (packed?.length !== plan.sections.length) {
    throw new Error(`taud: ${plan.sections.length} sections went to compress, ${packed?.length} came back`);
  }
  return assembleTaud(plan, packed);
}

/**
 * Everything the container is made of, read out of `doc`: the raw sections
 * still to be compressed, in file order (the sample/instrument image, then each
 * song's pattern bin and cue sheet), and what the header and the song table say
 * about them. Only the compressed SIZES are missing — the offsets depend on
 * them, which is why compression comes between this and assembleTaud.
 */
function planTaud(doc) {
  const kindBits =
    doc.kind === "tsii" ? TAUD_KIND_SAMPLEINST :
    doc.kind === "tpif" ? TAUD_KIND_PATTERN : 0;
  const hasXhdr = doc.projSections.some((s) => s.fourcc === "xHDR");
  // A document that was READ as version 3 is written back as version 3: the
  // wide cell is not something a writer may quietly drop (§5.5, no downgrade).
  const fmtVer = doc.fmtVer >= TAUD_VERSION_WIDE ? TAUD_VERSION_WIDE : TAUD_VERSION;
  const patSize = patternSizeFor(fmtVer);
  const version = fmtVer | (hasXhdr ? TAUD_XHDR_FLAG : 0) | kindBits;

  const sections = [];
  const hasImage = doc.kind !== "tpif" && !!doc.sampleInstImage;
  if (hasImage) sections.push(doc.sampleInstImage);

  const stride = doc.is64Channel ? CUE_SIZE_64 : CUE_SIZE;
  const chans = doc.is64Channel ? MAX_VOICES : NUM_VOICES;
  const songs = (doc.kind === "tsii" ? [] : doc.songs).map((song) => {
    const patBin = new Uint8Array(song.patterns.length * patSize);
    song.patterns.forEach((p, i) => patBin.set(p, i * patSize));
    const fullBin = new Uint8Array(song.cues.length * stride);
    song.cues.forEach((words, c) => {
      for (let ch = 0; ch < chans; ch++) {
        fullBin[c * stride + ch * 2] = words[ch] & 0xff;
        fullBin[c * stride + ch * 2 + 1] = (words[ch] >>> 8) & 0xff;
      }
    });
    // Trim TRAILING empty cues (taud_common.finalize_cue_sheet): a cue is empty
    // only when every lane is CUE_EMPTY (0x7FFF → bytes 0xFF,0x7F) AND both
    // instruction words are NOP, i.e. all its stride bytes are 0xFF/0x7F. Only
    // the trailing run is dropped (interior rests survive); at least one cue is
    // always kept. This is what makes "save only what's used": deleting content
    // past cue N shrinks the stored count, matching the device + the converters.
    let lastCue = 0;
    for (let c = 0; c < song.cues.length; c++) {
      for (let i = 0; i < stride; i += 2) {
        if (fullBin[c * stride + i] !== 0xff || fullBin[c * stride + i + 1] !== 0x7f) {
          lastCue = c;
          break;
        }
      }
    }
    const numCues = Math.max(1, lastCue + 1);
    sections.push(patBin, fullBin.slice(0, numCues * stride));
    return {
      numVoices: song.numVoices,
      numPatterns: song.patterns.length,
      bpmStored: Math.max(0, Math.min(0x1fe, song.bpm - 25)),
      tickRate: song.tickRate,
      tuningBaseNote: song.tuningBaseNote,
      tuningFreq: song.tuningFreq,
      globalFlags: song.globalFlags,
      globalVolume: song.globalVolume,
      mixingVolume: song.mixingVolume,
      numCues,
      surroundModel: song.surroundModel ?? 0,
    };
  });

  // ── project data (stored, not compressed; copied, so it is this call's) ──
  const projParts = [];
  if (doc.projSections.length > 0) {
    projParts.push(PROJ_MAGIC, new Uint8Array(8)); // magic + reserved
    for (const sec of doc.projSections) {
      const hdr = [];
      for (let i = 0; i < 4; i++) hdr.push(sec.fourcc.charCodeAt(i));
      pushU32(hdr, sec.payload.length);
      projParts.push(Uint8Array.from(hdr), sec.payload);
    }
  }

  const signature = doc.signature && doc.signature.length === 14 ? doc.signature : CAPTURE_SIGNATURE;
  return { version, signature, hasImage, sections, songs, proj: concat(projParts) };
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** The container: header, image, song table, each song's two bins, project
 *  data — `packed` being plan.sections compressed, in the same order. */
function assembleTaud(plan, packed) {
  let next = 0;
  const imageComp = plan.hasImage ? packed[next++] : null;
  const compSize = imageComp ? imageComp.length : 0;
  const songBins = plan.songs.map(() => ({ patComp: packed[next++], cueComp: packed[next++] }));

  // ── song table ──
  const tableOff = TAUD_HEADER_SIZE + compSize;
  let binOff = tableOff + plan.songs.length * TAUD_SONG_ENTRY;
  const table = [];
  plan.songs.forEach((song, s) => {
    const bins = songBins[s];
    pushU32(table, binOff);
    table.push(song.numVoices & 0xff);
    pushU16(table, song.numPatterns);
    table.push(song.bpmStored & 0xff);
    table.push((((song.bpmStored >> 8) & 1) << 7) | (song.tickRate & 0x7f));
    pushU16(table, song.tuningBaseNote);
    pushF32(table, song.tuningFreq);
    table.push(song.globalFlags & 0xff, song.globalVolume & 0xff, song.mixingVolume & 0xff);
    pushU32(table, bins.patComp.length);
    pushU32(table, bins.cueComp.length);
    pushU16(table, song.numCues); // num_cues (v2) — trailing empties trimmed
    table.push(song.surroundModel & 3); // immutable flags: `ss` surround model
    table.push(0, 0, 0);              // reserved
    binOff += bins.patComp.length + bins.cueComp.length;
  });
  const projOff = plan.proj.length > 0 ? binOff : 0;

  // ── header ──
  const header = [];
  header.push(...TAUD_MAGIC);
  header.push(plan.version, plan.songs.length);
  pushU32(header, compSize);
  pushU32(header, projOff);
  for (let i = 0; i < 14; i++) header.push(plan.signature.charCodeAt(i) & 0xff);

  // ── assemble ──
  const parts = [Uint8Array.from(header)];
  if (imageComp) parts.push(imageComp);
  parts.push(Uint8Array.from(table));
  for (const bins of songBins) parts.push(bins.patComp, bins.cueComp);
  parts.push(plan.proj);
  return concat(parts);
}
