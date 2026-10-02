// Chord stack (item 113) — turn ONE layer of a metainstrument into a chord or a
// unison spread in a single action. This is the two-click path to the thing
// metainstruments were always able to do but nobody could reach: a chorded
// piano out of one piano.
//
// The copies are LINKED (same $100+ sub-instrument, doc/metaedit.js stackLayer),
// so the stack stays ONE editable instrument sounded at several pitches — retune
// or refilter it once and every voice follows. Only the detune differs.
//
// The chord vocabulary is doc/chord.js's, the same one the Sample Lab's chord
// maker uses, so a just major third means the same interval in both places. The
// voice nearest unison is the REFERENCE: the base layer keeps the detune it
// already had and the others are placed relative to it, which is why "octaves"
// adds one above and one below instead of transposing the whole stack down.

import {
  CHORD_GROUPS, applyChordPreset, chordPresetLabel, chordPresetsFor,
  maxInversion, voiceUnits, UNITS_PER_OCTAVE,
} from "../../doc/chord.js";
import {
  metaLayers, metaRecordOf, stackLayer, clampDetune, clampLayerPitch, META_MAX_LAYERS,
} from "../../doc/metaedit.js";
import { setMetaRecordOp } from "../../doc/ops.js";
import { ANCHOR_NOTE } from "../../../core/tuning/pitchtables.js";
import { JAM_VOICES, JAM_VOICE_BASE } from "../../../core/engine/constants.js";
import { noteGlyphCanvas } from "../noteglyph.js";
import { setIconLabel } from "../icons.js";
import { unescapeName } from "../../../core/format/names.js";
import { t } from "../i18n.js";

/** How long a preview rings before it releases itself. A stack of sustaining
 *  layers would otherwise drone until the dialog closed. */
const PREVIEW_MS = 2500;

const centsOf = (units) => (units * 1200) / UNITS_PER_OCTAVE;
const signedCents = (units) =>
  (units >= 0 ? "+" : "−") + Math.abs(centsOf(units)).toFixed(1) + " ¢";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * Detune offsets a preset adds to the layer it is built on, relative to the
 * voice nearest unison (which IS that layer — it is not added again).
 *
 * An inversion moves which voice that is: the 1st inversion of a major triad
 * is built UP from its third, so the layer you already have becomes the third
 * and the stack sits above it.
 */
export function chordOffsets(presetId, pitchPreset, inversion = 0) {
  const voices = applyChordPreset(presetId, inversion, pitchPreset).filter((v) => v.on);
  if (voices.length === 0) return [];
  const units = voices.map((v) => voiceUnits(v, pitchPreset));
  let ref = 0;
  for (let i = 1; i < units.length; i++) {
    if (Math.abs(units[i]) < Math.abs(units[ref])) ref = i;
  }
  return units.filter((_, i) => i !== ref).map((u) => clampDetune(u - units[ref]));
}

/**
 * Open the chord stack on layer `layerIdx` of the metainstrument in `metaSlot`.
 * Resolves the number of layers added, or null on cancel.
 */
export function showChordStack(store, metaSlot, layerIdx) {
  const doc = store.doc;
  const inst = doc?.instruments[metaSlot & 0x3ff];
  if (!inst?.isMeta) return Promise.resolve(null);
  const layers = metaLayers(inst);
  if (layerIdx < 0 || layerIdx >= layers.length) return Promise.resolve(null);
  if (layers.length >= META_MAX_LAYERS) {
    alert(t("meta.fullTable", { max: META_MAX_LAYERS }));
    return Promise.resolve(null);
  }

  const base = layers[layerIdx];
  const pitchPreset = store.pitchPreset;
  // Tetrachords are offered only in the tuning they belong to (item 141).
  const menu = chordPresetsFor(pitchPreset);
  let presetId = menu[0].id;
  const families = CHORD_GROUPS.filter((g) => menu.some((p) => p.group === g));
  let family = menu[0].group;
  let inversion = 0;
  /** Note words the preview panel is currently showing, root first — what the
   *  Preview button sounds, so the two can never disagree. */
  const voiceNotes = [];
  let playing = false;
  let previewTimer = 0;

  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "modal import-modal";

    const baseName = unescapeName(doc.instrumentName(base.instIdx & 0x3ff)) || t("inst.unnamed");
    const head = el("h3", "", t("meta.chordTitle"));
    const hint = el("p", "dim", t("meta.chordHint", {
      layer: layerIdx, inst: `$${(base.instIdx & 0x3ff).toString(16).toUpperCase().padStart(3, "0")} ${baseName}`,
    }));

    const bar = el("div", "chord-bar");
    const familyField = el("div", "chord-bar-field");
    const presetField = el("div", "chord-bar-field");
    const invField = el("div", "chord-bar-field");
    // Family first, chords second — the same two-step the Sample Lab's maker
    // uses, because one dropdown cannot hold 143 chords (item 167).
    const familySel = document.createElement("select");
    for (const g of families) {
      const o = document.createElement("option");
      o.value = g;
      o.textContent = t(`chord.group.${g}`);
      familySel.appendChild(o);
    }
    familySel.value = family;
    const sel = document.createElement("select");
    const renderPresets = () => {
      sel.replaceChildren();
      for (const p of menu.filter((q) => q.group === family)) {
        const o = document.createElement("option");
        o.value = p.id;
        o.textContent = chordPresetLabel(p, t);
        sel.appendChild(o);
      }
      sel.value = presetId;
      if (!sel.value) {
        presetId = sel.options[0]?.value ?? presetId;
        sel.value = presetId;
      }
      sel.mtSync?.();
    };
    renderPresets();
    const invSel = document.createElement("select");
    invSel.title = t("chord.inversionTitle");
    familyField.append(el("span", "", t("chord.family")), familySel);
    presetField.append(el("span", "", t("meta.chordPreset")), sel);
    invField.append(el("span", "", t("chord.inversion")), invSel);
    bar.append(familyField, presetField, invField);

    const preview = el("div", "meta-chord-preview");
    const tally = el("p", "dim", "");
    const errEl = el("p", "import-error", "");
    errEl.hidden = true;

    const btnRow = el("div", "modal-buttons");
    const playBtn = el("button", "");
    setIconLabel(playBtn, "play", t("chord.preview"));
    const okBtn = el("button", "", t("meta.chordApply"));
    const cancelBtn = el("button", "", t("common.cancel"));
    btnRow.append(playBtn, okBtn, cancelBtn);

    /** Only the inversions this chord has, same as the Sample Lab's menu. */
    const renderInversions = () => {
      const top = maxInversion(presetId);
      inversion = Math.min(inversion, top);
      invSel.replaceChildren();
      for (let i = 0; i <= top; i++) {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = t(`chord.inv${i}`);
        invSel.appendChild(o);
      }
      invSel.value = String(inversion);
      invSel.disabled = top === 0;
    };

    // The preview lists every voice the stack will have — the base layer's own
    // pitch first — as the note it sounds when the pattern plays C4.
    const refresh = () => {
      const offsets = chordOffsets(presetId, pitchPreset, inversion);
      const room = META_MAX_LAYERS - layers.length;
      const use = offsets.slice(0, Math.max(0, room));
      preview.replaceChildren();
      voiceNotes.length = 0;
      const rows = [{ d: 0, root: true }, ...use.map((o) => ({ d: o, root: false }))];
      for (const r of rows) {
        const units = clampLayerPitch(base, base.detune + r.d);
        const line = el("div", "meta-chord-voice" + (r.root ? " root" : ""));
        // Painted in the song's own notation, like every other note readout —
        // a stack built from degrees of a 31-TET table must not report itself
        // in 12-EDO letter names.
        const noteEl = el("span", "meta-chord-note");
        // A fixed-pitch base layer (item 179) holds a note word, not an
        // offset — the stack it seeds is a chord of absolute pitches, so the
        // preview reads the value itself rather than middle C plus it.
        const note = Math.min(
          Math.max(base.fixedPitch ? units : ANCHOR_NOTE + units, 0x20), 0xffff);
        voiceNotes.push(note);
        noteEl.appendChild(noteGlyphCanvas(note, pitchPreset));
        line.append(noteEl, el("span", "dim", r.root ? t("meta.chordRoot") : signedCents(r.d)));
        preview.appendChild(line);
      }
      const total = layers.length + use.length;
      tally.textContent = `${t("meta.chordAdds", { n: use.length })} · ` +
        `${t("meta.tally", { n: total, max: META_MAX_LAYERS })} · ${t("meta.voiceCost", { n: total })}`;
      okBtn.disabled = use.length === 0;
      playBtn.disabled = !store.audio;
      // The chord it would sound just changed, so anything still ringing is
      // the OLD one — a preview never outlives the choice that made it.
      stopPreview();
      errEl.hidden = use.length >= offsets.length;
      if (!errEl.hidden) errEl.textContent = t("meta.chordTruncated", { max: META_MAX_LAYERS });
    };

    // Preview: sound the stack the way it will actually sound — the base
    // layer's OWN sub-instrument at each of the chord's pitches, on the jam
    // bank (so it never touches the song's voices), one voice per note. This
    // is the same path the piano auditions through, which is why a strict
    // metainstrument gets the same note-snapping courtesy here.
    const stopPreview = () => {
      if (previewTimer) { clearTimeout(previewTimer); previewTimer = 0; }
      if (!playing) return;
      playing = false;
      setIconLabel(playBtn, "play", t("chord.preview"));
      store.audio?.jamStopVoice(0, -1);
    };
    const startPreview = () => {
      const audio = store.audio;
      if (!audio || voiceNotes.length === 0) return;
      playing = true;
      setIconLabel(playBtn, "stop", t("chord.stop"));
      const instIdx = base.instIdx & 0x3ff;
      voiceNotes.slice(0, JAM_VOICES).forEach((note, i) => {
        audio.jamNote(0, JAM_VOICE_BASE + i, note, instIdx, true);
      });
      previewTimer = setTimeout(stopPreview, PREVIEW_MS);
    };
    playBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (playing) stopPreview(); else startPreview();
    });

    familySel.addEventListener("change", () => {
      family = familySel.value;
      presetId = menu.find((p) => p.group === family)?.id ?? presetId;
      renderPresets();
      renderInversions(); // …keeping the inversion, clamped to the new chord
      refresh();
    });
    sel.addEventListener("change", () => { presetId = sel.value; renderInversions(); refresh(); });
    invSel.addEventListener("change", () => {
      inversion = parseInt(invSel.value, 10) || 0;
      refresh();
    });

    dlg.append(head, hint, bar, preview, tally, errEl, btnRow);
    document.body.appendChild(dlg);
    renderInversions();
    refresh();

    const finish = (result) => { stopPreview(); dlg.close(); dlg.remove(); resolve(result); };
    cancelBtn.addEventListener("click", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("cancel", () => finish(null));
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    okBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const offsets = chordOffsets(presetId, pitchPreset, inversion)
        .map((o) => clampLayerPitch(base, base.detune + o));
      const next = stackLayer(layers, layerIdx, offsets);
      const added = next.length - layers.length;
      if (added <= 0) { finish(null); return; }
      store.undo.apply(setMetaRecordOp(metaSlot & 0x3ff, metaRecordOf(inst, next)));
      finish(added);
    });
    dlg.showModal();
    sel.focus();
  });
}
