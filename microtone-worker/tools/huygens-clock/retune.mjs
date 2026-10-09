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
import { buildIxmpSection } from "../../src/doc/bankmerge.js";
import { measureWords } from "./zonetune.mjs";

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
 * the Ixmp section in place.
 */
export function retune(doc, uses, { passes = 2, log = () => {} } = {}) {
  const report = [];
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
        const [m] = measureWords(doc, slot, [rep.word], rep.vol);
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
    for (const e of doc.ixmp) {
      const L = e.instId & 0x3ff;
      const fixes = bySlot.get(L);
      if (!fixes) continue;
      const patches = parsePatchesBlob(e.blob);
      for (const [idx, cents] of fixes) {
        const p = patches[idx];
        const d0 = (p.sampleDetune << 16) >> 16;
        const d1 = Math.max(-0x8000, Math.min(0x7fff, d0 + Math.round(cents * UNITS_PER_CENT)));
        p.sampleDetune = d1 & 0xffff;
        log(`pass ${pass}: slot ${L} zone ${idx}: ${cents >= 0 ? "+" : ""}${cents.toFixed(1)} c`);
      }
      e.blob = writePatchesBlob(patches);
    }
    doc.setSection("Ixmp", buildIxmpSection(doc.ixmp));
    doc._resetInstrumentCache();
  }
  return report;
}

/** Every (word, vol) each pattern-visible melodic instrument is triggered with. */
export function usesFromLanes(lanes, skipSlots) {
  const uses = new Map();
  for (const lane of lanes) {
    if (skipSlots.has(lane.inst)) continue;
    for (const c of lane.ev.values()) {
      if (c.note === undefined || c.note < 0x20 || c.inst === undefined) continue; // glides trigger nothing
      const vol = c.vol !== undefined ? Math.max(0, Math.min(63, Math.round(c.vol * (lane.trim ?? 1)))) : 63;
      if (!uses.has(lane.inst)) uses.set(lane.inst, []);
      uses.get(lane.inst).push({ word: c.note, vol });
    }
  }
  return uses;
}
