// What a listener is told about a song (item 373): pulled straight from the
// file — the project strings (§9.2), the song's metadata (§9.6) and its
// notation (§9.7) — never typed in by anyone else. The Microtone Player shows
// it; the Music Hub's catalogue is built from the same function, so the page
// and the listing cannot disagree about a song's name, author or tuning.
//
// Pure: takes the editor's Document (src/doc/document.js), touches no DOM.

import { decodeProjectString, unescapeName } from "../../core/format/names.js";
import { presetForNotation } from "../../core/tuning/pitchtables.js";

/** The tempo unit (item 373): declared BPM ÷ speed. A tick is 2.5 ÷ BPM
 *  seconds and a row is `speed` ticks, so this is proportional to rows per
 *  second — BPM 747 at speed 14 (53.4) is not a fast song. Shown ×6, which
 *  is the BPM the same row rate would have at the trackers' default speed. */
export function tempoOf(bpm, speed) {
  return speed > 0 && bpm > 0 ? bpm / speed : 0;
}
export const TEMPO_DISPLAY_SPEED = 6;
export function displayTempo(tempo) {
  return Math.round(tempo * TEMPO_DISPLAY_SPEED * 10) / 10;
}

/** The facts of song `songIndex` of `doc`. Strings are "" when absent. */
export function songFacts(doc, songIndex = 0) {
  const song = doc.songs[songIndex] ?? doc.songs[0];
  const sm = doc.meta?.songMeta?.[songIndex] ?? {};
  const str = (fourcc) => decodeProjectString(fourcc, doc.projectString(fourcc)) ?? "";
  const notationValue = sm.notation ?? 120;
  const preset = presetForNotation(notationValue, doc);
  const songName = unescapeName(sm.name ?? "");
  const composer = unescapeName(sm.composer ?? "");
  const project = unescapeName(doc.meta?.projectName ?? "") || str("PNam");
  return {
    title: (project || songName).trim(),
    songName: songName.trim(),
    author: (str("PCom") || composer).trim(),
    copyright: (str("PCpr") || unescapeName(sm.copyright ?? "")).trim(),
    message: str("PMsg").replace(/\s+$/, ""),
    notation: notationValue,
    tuning: preset?.name ?? "12-TET",
    bpm: song?.bpm ?? 125,
    speed: song?.tickRate ?? 6,
    tempo: tempoOf(song?.bpm ?? 125, song?.tickRate ?? 6),
    rowsPerBeat: sm.beatPri || 4,
    rowsPerBar: sm.beatSec || 16,
    lanes: song?.numVoices ?? (doc.is64Channel ? 64 : 32),
    songs: doc.songs.length,
    surround: (song?.surroundModel ?? 0) !== 0,
    wide: !!doc.wideCells,
  };
}
