// Re-tune the zones a song actually plays so they sound on the grid.
//
// SoundFont samples carry small tuning errors, and single-cycle synth loops
// pick up larger ones when they are resampled (a loop cannot be a fraction of
// a sample long). In 31-TET, where neighbouring notes are 38.7 cents apart, a
// zone 13 cents sharp is a third of the way to the next note. So: for every
// combination of zones that the song's notes trigger, render a held note,
// measure where it really sounds, and move those zones' detune by the error.
// Every layer a note sounds moves together, so a deliberately detuned layer
// pair (a chorus) keeps its spread and only its centre is corrected.

import { parsePatchesBlob, writePatchesBlob } from "../../core/engine/inst.js";
import { buildIxmpSection } from "../doc/bankmerge.js";
import { patchDetune, patchDetuneFields, pitchPatchesOf } from "../doc/pitchedit.js";
import { measureWords } from "./zonetune.js";

const UNITS_PER_CENT = 4096 / 1200;

/** Layer slots a pattern-visible slot sounds (itself, or its meta layers). */
function layersOf(doc, slot) {
  const inst = doc.instruments[slot];
  return inst.isMeta ? inst.metaLayers.filter((l) => l.instIdx >= 1).map((l) => l.instIdx & 0x3ff) : [slot];
}

/** Patch index each layer resolves `word` at `vol` to (−1 = base record). */
function zoneKey(doc, slot, word, vol) {
  return layersOf(doc, slot).map((L) => {
    const inst = doc.instruments[L];
    const p = inst.resolvePatch(word, vol);
    return `${L}:${p === null ? -1 : inst.extraPatches.indexOf(p)}`;
  }).join(",");
}

/**
 * `uses`: Map slot → array of {word, vol}. Returns a report; edits doc.ixmp and
 * the Ixmp section in place. `pause` (awaited between measurements) lets a
 * page draw while this runs; `progress(done, total)` counts measurements.
 *
 * `fine` (a TML 2 build): a correction is written to the sixteenth of a unit,
 * the patch's detune field and its `IPit` extension (file format §9.18), and
 * the doc's section follows; otherwise to the unit, as it always was. `wide`
 * measures a note in a format-3 cell, so a note between two units sounds
 * where the song plays it.
 */
export async function retune(doc, uses, { passes = 2, log = () => {}, pause = null, progress = null, fine = false, wide = false } = {}) {
  const report = [];
  let done = 0;
  let total = 0;
  if (progress) {
    for (const [slot, list] of uses) total += new Set(list.map((u) => zoneKey(doc, slot, u.word, u.vol))).size * passes;
  }
  for (let pass = 0; pass < passes; pass++) {
    const corr = new Map(); // "layer:patchIdx" → [cents…]
    for (const [slot, list] of uses) {
      const groups = new Map();
      for (const u of list) {
        const key = zoneKey(doc, slot, u.word, u.vol);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(u);
      }
      for (const [key, members] of groups) {
        members.sort((a, b) => a.word - b.word);
        const rep = members[members.length >> 1];
        if (pause) await pause();
        const [m] = measureWords(doc, slot, [rep.word], rep.vol, wide);
        progress?.(++done, total);
        if (!Number.isFinite(m.cents)) continue;
        if (pass === passes - 1) report.push({ slot, key, word: rep.word, cents: m.cents });
        for (const z of key.split(",")) {
          if (z.endsWith(":-1")) continue;
          if (!corr.has(z)) corr.set(z, []);
          corr.get(z).push(m.cents);
        }
      }
    }
    if (pass === passes - 1) break;
    // Apply the mean correction per zone.
    const bySlot = new Map();
    for (const [z, list] of corr) {
      const [L, idx] = z.split(":").map(Number);
      const mean = list.reduce((s, x) => s + x, 0) / list.length;
      if (!bySlot.has(L)) bySlot.set(L, []);
      bySlot.get(L).push([idx, -mean]);
    }
    const touched = [];
    for (const e of doc.ixmp) {
      const L = e.instId & 0x3ff;
      const fixes = bySlot.get(L);
      if (!fixes) continue;
      const patches = parsePatchesBlob(e.blob);
      if (fine) {
        // Each zone starts from the pitch it has now, its extension included.
        const live = doc.instruments[L].extraPatches ?? [];
        patches.forEach((p, i) => {
          if (live[i]) { p.dLo = live[i].dLo; p.dHi = live[i].dHi; p.dDetune = live[i].dDetune; }
        });
      }
      for (const [idx, cents] of fixes) {
        const p = patches[idx];
        if (fine) {
          Object.assign(p, patchDetuneFields(patchDetune(p) + cents * UNITS_PER_CENT));
        } else {
          const d0 = (p.sampleDetune << 16) >> 16;
          const d1 = Math.max(-0x8000, Math.min(0x7fff, d0 + Math.round(cents * UNITS_PER_CENT)));
          p.sampleDetune = d1 & 0xffff;
        }
        log(`pass ${pass}: slot ${L} zone ${idx}: ${cents >= 0 ? "+" : ""}${cents.toFixed(1)} c`);
      }
      e.blob = writePatchesBlob(patches);
      touched.push({ slot: L, patches, groups: { patches: pitchPatchesOf(patches) } });
    }
    // The zones' extensions, against the patch lists as they now stand.
    const ipit = fine ? doc.pitchExtPayloadAfter(touched) : undefined;
    doc.setSection("Ixmp", buildIxmpSection(doc.ixmp));
    if (ipit !== undefined) doc.setPitchExtPayload(ipit);
    doc._resetInstrumentCache();
  }
  return report;
}
