#!/usr/bin/env node
// Taud container inspector — header/song-table/section dumper for debugging the
// format layer. Cross-check against the TSVM repo's taud_inspect.py.
// Usage: node tools/inspect-taud.js <file.taud> [--cues] [--ixmp]

import { readFile } from "node:fs/promises";
import { parseTaud, cueInstructionWords } from "../src/format/taud-parse.js";
import { ixmpPatchLen, ixmpChanCount, CUE_EMPTY } from "../src/format/taud-const.js";

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith("--"));
if (!path) {
  console.error("usage: inspect-taud.js <file.taud> [--cues] [--ixmp]");
  process.exit(2);
}
const showCues = args.includes("--cues");
const showIxmp = args.includes("--ixmp");

const file = await readFile(path);
const doc = parseTaud(file);

console.log(`file        : ${path} (${file.length} bytes)`);
console.log(`kind        : .${doc.kind}  format v${doc.fmtVer}  ${doc.is64Channel ? "64" : "32"}-lane`);
console.log(`signature   : "${doc.signature}"`);
console.log(`sample+inst : ${doc.sampleInstImage ? doc.sampleInstImage.length + " bytes decompressed" : "absent"}`);

if (doc.sampleInstImage) {
  // Instrument census: non-empty 256-byte records (sample ptr high16 == 0xFFFF → Metainstrument).
  const inst = doc.sampleInstImage.subarray(8388608);
  let normal = 0, meta = 0;
  for (let s = 0; s < 1024; s++) {
    const rec = inst.subarray(s * 256, (s + 1) * 256);
    if (rec.every((b) => b === 0)) continue;
    const ptrHi = rec[2] | (rec[3] << 8);
    if (ptrHi === 0xffff) meta++;
    else normal++;
  }
  console.log(`instruments : ${normal} normal + ${meta} meta`);
}

doc.songs.forEach((song, s) => {
  console.log(`song ${s}      : lanes=${song.numVoices} pats=${song.patterns.length} cues=${song.cues.length}` +
    ` bpm=${song.bpm} speed=${song.tickRate} flags=0x${song.globalFlags.toString(16).padStart(2, "0")}` +
    ` gv=${song.globalVolume} mv=${song.mixingVolume}` +
    ` tuning=0x${song.tuningBaseNote.toString(16)}@${song.tuningFreq}Hz`);
  const sm = doc.meta.songMeta[s];
  if (sm) console.log(`  sMet      : "${sm.name}" by "${sm.composer}" (c) "${sm.copyright}" notation=${sm.notation} beat=${sm.beatPri}/${sm.beatSec}`);
  if (showCues) {
    song.cues.forEach((words, c) => {
      const cols = [];
      for (let ch = 0; ch < (doc.is64Channel ? 64 : 32); ch++) {
        const pat = words[ch] & 0x7fff;
        cols.push(pat === CUE_EMPTY ? "..." : pat.toString(16).padStart(3, "0"));
      }
      const [w0, w1] = cueInstructionWords(words);
      console.log(`  cue ${String(c).padStart(4)}: ${cols.join(" ")}  w0=0x${w0.toString(16).padStart(4, "0")} w1=0x${w1.toString(16).padStart(4, "0")}`);
    });
  }
});

if (doc.projSections.length > 0) {
  console.log(`projData    : ${doc.projSections.map((x) => `${x.fourcc}(${x.payload.length})`).join(" ")}`);
}
if (doc.meta.projectName) console.log(`projectName : "${doc.meta.projectName}"`);

if (doc.ixmp.length > 0) {
  console.log(`Ixmp        : ${doc.ixmp.length} instruments carry patches`);
  if (showIxmp) {
    for (const e of doc.ixmp) {
      const feats = [];
      let o = 0;
      for (let i = 0; i < e.count; i++) {
        const ver = e.blob[o];
        const f = [];
        if (ver & 0x80) f.push("x");
        if (ver & 0x02) f.push("v");
        if (ver & 0x04) f.push("p");
        if (ver & 0x08) f.push("f");
        if (ver & 0x10) f.push("P");
        if (ver & 0x20) f.push(`s${ixmpChanCount(e.blob, o)}`);
        feats.push(f.join("") || "i");
        o += ixmpPatchLen(e.blob, o);
      }
      console.log(`  inst $${e.instId.toString(16).padStart(3, "0")}: ${e.count} patches [${feats.join(",")}]`);
    }
  }
}
