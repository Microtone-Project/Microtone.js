// Microtone.js application shell (M6): document open/save (OPFS + import/
// export), editing dispatch (record mode, jam keyboard, undo/redo), Timeline
// + Cues + Files views. Samples/Instruments/Project views come with M7.

import { parseTaud } from "../format/taud-parse.js";
import { Document, combineTpif } from "../doc/document.js";
import { DocSync } from "../doc/sync.js";
import { UndoStack } from "../doc/undo.js";
import { AudioSystem } from "../audio/audio-system.js";
import { createProfileOverlay } from "./profileoverlay.js";
import { Store } from "./store.js";
import { TimelineView } from "./views/timeline.js";
import { CuesView } from "./views/cues.js";
import { PatternView, FX2_BASE_STEP } from "./views/pattern.js";
import { FilesView } from "./views/files.js";
import { SamplesView } from "./views/samples.js";
import { InstrumentsView } from "./views/instruments.js";
import { MasteringView } from "./views/mastering.js";
import { ProjectView } from "./views/project.js";
import { WelcomeView } from "./views/welcome.js";
import { MasterStrip } from "./views/masterstrip.js";
import { SplitView, VIEWS } from "./splitview.js";
import { JamKeyboard } from "./jam.js";
import { InstLookup } from "./instlookup.js";
import { SUB_NOTE } from "./edit.js";
import { CommandPalette } from "./palette.js";
import { FindBar } from "./findbar.js";
import { setCellOp } from "../doc/ops.js";
import { emptyPatternBytes } from "../doc/patterntools.js";
import { hex2 } from "./notenames.js";
import { showHelp } from "./popups/help.js";
import { showAbout } from "./popups/about.js";
import { showWarmthSplash } from "./popups/warmth.js";
import { showNewProject } from "./popups/newproject.js";
import { showModal } from "./widgets/modal.js";
import * as opfs from "../storage/opfs.js";
import { pickFile } from "../storage/import-export.js";
import { convertToTaud, converterFor, CONVERT_ACCEPT } from "../convert/convert.js";
import { showImportProgress } from "./popups/importlog.js";
import { showProgress } from "./popups/progress.js";
import { fetchDemo } from "./demos.js";
import { getSoundfont, getBundledSoundfont, pickUserSoundfont } from "./soundfont.js";
import { resolveBanks, rememberBank } from "./adlibbank.js";
import { decodeHandoff, handoffArmed } from "./handoff.js";
import { presetForNotation } from "./pitchtables.js";
import { initTheme, toggleTheme, onThemeChange, currentTheme, isThemeName, WARMTH } from "./theme.js";
import { initI18n, applyDom, t, LANGS, changeLang, onLangChange, currentLang } from "./i18n.js";
import { escapeNonAscii, unescapeName } from "./names.js";
import { loadCanvasFonts, refreshCanvasFont } from "./fonts.js";
import { startControlEnhancer } from "./widgets/spinner.js";

initTheme(); // before any canvas paints (saved choice ?? OS preference)
await initI18n(); // strings before any UI is built
applyDom(); // translate the static index.html chrome
{
  // ?theme=dark|dim|light overrides for this load (and persists like the toggle).
  // `warmth` is accepted too — that is the only way to reach the Analogue
  // Warmth Edition out of season — but applyTheme declines to persist it.
  const t = new URLSearchParams(location.search).get("theme");
  if (isThemeName(t)) {
    const { applyTheme } = await import("./theme.js");
    applyTheme(t);
  }
}

const $ = (id) => document.getElementById(id);
const store = new Store();
store.record = true;
store.editStep = 1;
let audioInitPromise = null;

// ?profile=1 attaches the dev audio profiler (worklet timing + on-screen
// overlay). Off by default → zero overhead in production.
const PROFILE = new URLSearchParams(location.search).has("profile");
let profileOverlay = null;

// ── audio bring-up (single-flight; owns DocSync creation) ──
// The worklet is warmed up eagerly on load (resume:false → suspended context,
// no sound, no autoplay-policy violation) so store.audio + DocSync exist before
// the first gesture; the first pointer/key then resume()s it (resume:true).
// That is what lets note jamming work without first pressing Play (item 26).
async function ensureAudio({ resume = true } = {}) {
  if (!audioInitPromise) {
    audioInitPromise = (async () => {
      const audio = new AudioSystem();
      await audio.init({ profile: PROFILE });
      if (PROFILE) {
        profileOverlay = createProfileOverlay();
        document.body.appendChild(profileOverlay.el);
        audio.onProfile = (p) => profileOverlay.update(p);
      }
      audio.setMonitorMode(0, store.binaural ? 1 : 0); // #998.3, survives reloads
      store.audio = audio;
    })();
  }
  await audioInitPromise;
  if (resume) await store.audio.resume();
  if (store.doc && !store.sync) {
    store.sync = new DocSync(store.audio, store.doc, store.songIndex);
    store.sync.loadAll();
    // mutes toggled before the first audio gesture only exist in the store
    store.voiceMutes.forEach((m, ch) => { if (m) store.audio.setVoiceMute(0, ch, true); });
  }
  const badge = $("audioBadge");
  if (store.audio.running) {
    badge.textContent = `audio @ ${store.audio.context.sampleRate} Hz`;
    badge.classList.add("on");
  }
}
for (const ev of ["pointerdown", "keydown"]) {
  window.addEventListener(ev, () => ensureAudio(), { capture: true });
}
// Warm up the engine now (suspended) so jamming is ready pre-Play. Fire-and-
// forget: a headless/virtual-time boot where addModule never settles just
// leaves audio uninitialised, which the rest of the app already tolerates.
ensureAudio({ resume: false }).catch((e) => console.warn("APP: eager audio warmup failed", e));

// ── import conversion (tracker/MIDI → .taud via the vendored Python converters) ──

async function convertImport(name, bytes, { sf2: sf2Override = null, bank = null,
                                            rpb = null,
                                            trimPatches = false, stereoSamples = false,
                                            keepDuplicatePatterns = false, realign = null,
                                            quantise = null, quantiseStrength = 100 } = {}) {
  let sf2 = sf2Override;
  const conv = converterFor(name);
  if (!sf2 && conv.isMidi) {
    $("stFile").textContent = t("midi.needSf");
    sf2 = await getSoundfont();
    if (!sf2) { $("stFile").textContent = t("midi.cancelled"); return null; }
  }
  // An AdLib song names its instruments instead of storing them, so a bank is
  // not a nicety: the song's own .BNK when one came with it, else the bundled
  // general bank, which resolves nearly every name in the wild.
  let banks = null;
  if (conv.needsBank) {
    banks = await resolveBanks(bank);
    if (!banks.length) {
      $("stFile").textContent = t("status.importFailed",
        { name, err: t("handoff.noBank") });
      return null;
    }
  }
  const progress = showImportProgress(`Importing ${name}`);
  try {
    const out = await convertToTaud(name, bytes,
      { sf2, banks, rpb, trimPatches, stereoSamples, keepDuplicatePatterns,
        realign, quantise, quantiseStrength, onStatus: progress.log });
    progress.done();
    return out;
  } catch (err) {
    const last = err.message.trim().split("\n").pop();
    progress.fail(last);
    $("stFile").textContent = t("status.importFailed", { name, err: last });
    console.error("import failed:", err);
    return null;
  }
}

// ── document loading ──
async function loadBytes(name, bytes, { sf2 = null, bank = null, saveToOpfs = false,
                                        rpb = null,
                                        trimPatches = false, stereoSamples = false,
                                        keepDuplicatePatterns = false, realign = null,
                                        quantise = null, quantiseStrength = 100 } = {}) {
  let converted = false;
  if (converterFor(name)) {
    bytes = await convertImport(name, bytes,
      { sf2, bank, rpb, trimPatches, stereoSamples, keepDuplicatePatterns,
        realign, quantise, quantiseStrength });
    if (bytes === null) return;
    name = name.replace(/\.[^.]+$/, "") + ".taud";
    converted = true;
  }

  let parsed;
  try {
    parsed = parseTaud(bytes);
  } catch (err) {
    $("stFile").textContent = t("status.parseError", { err: err.message });
    return;
  }

  // .tsii = a sample+instrument bank. Into a loaded project it REPLACES the
  // instrument domain (the taud.mjs "load the companion .tsii first" flow);
  // standalone it seeds a new project.
  if (parsed.kind === "tsii") {
    if (store.doc) {
      if (!confirm(t("confirm.replaceBank", { name }))) return;
      store.audio?.stop(0);
      store.doc.sampleInstImage = parsed.sampleInstImage;
      store.doc.ixmp = parsed.ixmp.map((e) => ({ instId: e.instId, count: e.count, blob: Uint8Array.from(e.blob) }));
      store.doc._instruments = null; // re-decode from the new image
      store.doc._instrumentsEdited = false;
      // Carry the bank's name tables + Ixmp/SRgn sections over; keep song
      // sections. SRgn travels with the bank because a region names POOL bytes,
      // and the pool is exactly what a .tsii replaces (item 175).
      store.doc.projSections = store.doc.projSections.filter(
        (s) => !["INam", "SNam", "Ixmp", "SRgn"].includes(s.fourcc));
      for (const s of parsed.projSections) {
        if (["INam", "SNam", "Ixmp", "SRgn"].includes(s.fourcc)) {
          store.doc.projSections.push({ fourcc: s.fourcc, payload: Uint8Array.from(s.payload) });
        }
      }
      store.doc.dirty = true;
      store.sync?.loadAll();
      store.syncVoiceMutes(); // loadAll resets the engine (item 125) — mutes are ours
      store.emit("doc");
      updateStatus();
    } else {
      await newProject({ fromBank: parsed, bankName: name });
    }
    return;
  }
  // .tpif = one song's patterns over a resident bank (taud.mjs:173). Combine
  // it with the current project's bank when one is loaded, else prompt for
  // the companion .tsii; the result is a full (unsaved) .taud document.
  if (parsed.kind === "tpif") {
    let bank;
    if (store.doc?.sampleInstImage) {
      store.doc._rebuildInstRegion(); // decoded inst edits are canonical
      bank = store.doc;
    } else {
      $("stFile").textContent = t("status.tpifNeedsBank", { name });
      const bankFile = await pickFile(".tsii,.taud");
      if (!bankFile) return;
      try {
        bank = parseTaud(new Uint8Array(await bankFile.arrayBuffer()));
      } catch (err) {
        $("stFile").textContent = t("status.parseErrorIn", { name: bankFile.name, err: err.message });
        return;
      }
      if (!bank.sampleInstImage) {
        $("stFile").textContent = t("status.noBankIn", { name: bankFile.name });
        return;
      }
    }
    parsed = combineTpif(bank, parsed);
    name = name.replace(/\.[^.]+$/, "") + ".taud";
    converted = true; // synthesised container — load it unsaved
  }

  if (store.doc?.dirty) {
    if (!confirm(t("confirm.discardNamed", { name: store.fileName ?? t("common.currentProject") }))) return;
  }
  store.audio?.stop(0);
  store.doc = new Document(parsed);
  store.clearMutes(); // per-song UI state (taut finishLoadCommon)
  store.clearFx2();   // …and the second effect goes back to hidden
  store.fileName = name;
  store.songIndex = 0;
  store.cursor = { row: 0, ch: 0, sub: 0, nib: 0 };
  store.pitchPreset = presetForNotation(store.doc.meta.songMeta[0]?.notation ?? 120, store.doc);
  store.undo = new UndoStack(store.doc, (dirty) => {
    store.sync?.onDirty(dirty);
    // A channel insert shifts the mute array along with the patterns; the tag
    // is direction-free because UndoStack replays the forward op's tags. A
    // "format" tag re-pushes the whole document, which resets the engine (item
    // 125) — the mutes are the desk's, so they go back down after it.
    if (dirty.some((tg) => tg.kind === "voices" || tg.kind === "format")) store.syncVoiceMutes();
    store.emit("edit", dirty);
    updateStatus();
  });
  store.sync = null; // (re)created by ensureAudio
  if (store.audio) {
    store.sync = new DocSync(store.audio, store.doc, 0);
    store.sync.loadAll();
  }

  rebuildSongList();
  // the welcome screen's Recent list sorts on this (every copy of it)
  eachView("timeline", (_obj, entry) => entry.welcome.noteOpened(name));

  // Invalidate the views' cached song state (Timeline songMap crop, etc.) for
  // the NEW document BEFORE showView draws — otherwise the first frame paints
  // with the previous song's map and, if the canvas dims are unchanged, that
  // stale crop can persist (item 49a: crop-to-length failed on a file-tab reload).
  store.emit("doc");
  showView("timeline"); // hides the welcome screen: a document is loaded now
  if (converted) store.doc.dirty = true; // imported, not yet saved anywhere
  if (converted && saveToOpfs && (await opfs.available())) {
    // Files-tab MIDI import: the CONVERSION RESULT lands in OPFS right away.
    await opfs.write(name, store.doc.toBytes());
    store.doc.dirty = false;
    store.emit("saved", name);
  }
  updateStatus();
}

function updateStatus() {
  const doc = store.doc;
  $("stFile").textContent = doc
    ? `${store.fileName ?? "untitled"} — ${unescapeName(doc.meta.projectName ?? "untitled")} · ${doc.songs.length} ${doc.songs.length === 1 ? "song" : "songs"} · ${doc.channelCount}ch`
    : t("status.noFile");
  $("stDirty").hidden = !doc?.dirty;
  $("octDisp").textContent = jam.octave;
  $("instDisp").textContent = hex2(jam.currentInst);
  updateUndoUI();
  updateHint();
}

/** Contextual status-bar hint (item 78): text follows the active view — and,
 *  on the grid views, the record mode. No doc → a "get started" prompt. */
function updateHint() {
  const el = $("stHint");
  if (!el) return;
  let key = "status.hint"; // generic / no-doc prompt
  if (store.doc || store.view === "files") {
    switch (store.view) {
      case "timeline": key = store.record ? "status.hint.timelineRec" : "status.hint.timeline"; break;
      case "pattern":  key = store.record ? "status.hint.patternRec" : "status.hint.pattern"; break;
      case "cues": key = "status.hint.cues"; break;
      case "samples": key = "status.hint.samples"; break;
      case "instruments": key = "status.hint.instruments"; break;
      case "mastering": key = "status.hint.mastering"; break;
      case "project": key = "status.hint.project"; break;
      case "files": key = "status.hint.files"; break;
    }
  }
  el.textContent = t(key);
}

function updateUndoUI() {
  const u = store.undo;
  const canU = !!u?.canUndo();
  const canR = !!u?.canRedo();
  $("undoBtn").disabled = !canU;
  $("redoBtn").disabled = !canR;
  const nU = u?.undoStack.length ?? 0;
  const nR = u?.redoStack.length ?? 0;
  $("undoStat").textContent = nU || nR ? `${nU}/${nR}` : "";
  $("undoStat").title = `${nU} undo · ${nR} redo`;
}
store.on("saved", updateStatus);
store.on("edit", updateUndoUI);
store.on("status", updateStatus); // e.g. project rename
store.on("view", updateHint);     // per-view contextual hint (item 78)
updateHint();                     // initial no-doc prompt

/** New Project wizard — optionally seeded from a .tsii instrument bank. */
async function newProject({ fromBank = null, bankName = null } = {}) {
  const result = await showNewProject({ fromBank, bankName });
  if (!result) return;
  if (store.doc?.dirty) {
    if (!confirm(t("confirm.discard"))) return;
  }
  const is64 = result.channels === 64;
  const chans = is64 ? 64 : 32;
  const projName = result.name || "untitled";
  // A surround project is born in format version 3 — the wide cell (§5.5) is
  // what makes its panning column able to say where a source is at all.
  const surroundModel = result.surroundModel ?? 0;
  const wide = surroundModel !== 0;

  // Empty pattern: FINE-by-zero in both columns (the converter convention),
  // which in the wide cell is one selector byte instead of two.
  const emptyPat = emptyPatternBytes(wide);
  // Cue 0: one private pattern per channel (pattern n on channel n).
  const cue0 = new Uint16Array(64).fill(0x7fff);
  const patterns = [];
  for (let ch = 0; ch < chans; ch++) {
    cue0[ch] = ch;
    patterns.push(Uint8Array.from(emptyPat));
  }

  const enc = new TextEncoder();
  const projSections = [];
  if (is64) {
    const xhdr = new Uint8Array(256);
    xhdr[0] = 0x01;
    projSections.push({ fourcc: "xHDR", payload: xhdr });
  }
  if (fromBank) {
    for (const s of fromBank.projSections) {
      if (["INam", "SNam", "Ixmp"].includes(s.fourcc)) {
        projSections.push({ fourcc: s.fourcc, payload: Uint8Array.from(s.payload) });
      }
    }
  }
  const escapedProjName = escapeNonAscii(projName);
  projSections.push({ fourcc: "PNam", payload: Uint8Array.from([...enc.encode(escapedProjName), 0]) });

  const parsedShape = {
    kind: "taud",
    fmtVer: wide ? 3 : 2,
    is64Channel: is64,
    signature: "Microtone.js  ",
    sampleInstImage: fromBank ? fromBank.sampleInstImage : new Uint8Array(8650752),
    songs: [{
      numVoices: chans,
      numPats: patterns.length,
      bpm: result.bpm,
      tickRate: result.tickRate,
      tuningBaseNote: result.baseNote,
      tuningFreq: result.baseFreq,
      globalFlags: 0,
      globalVolume: 0x80,
      mixingVolume: 0x80,
      surroundModel,
      numCuesStored: 1,
      patterns,
      cues: [cue0],
    }],
    projSections,
    ixmp: fromBank ? fromBank.ixmp : [],
    meta: {
      projectName: escapedProjName,
      songMeta: { 0: {
        notation: result.notation, beatPri: result.beatPri, beatSec: result.beatSec,
        name: escapedProjName, composer: escapeNonAscii(result.composer || ""),
        copyright: escapeNonAscii(result.copyright || ""),
      } },
    },
  };
  store.audio?.stop(0);
  store.doc = new Document(parsedShape);
  store.doc.smetEdited = true; // bake the fresh sMet on first save
  store.doc.dirty = true;
  store.fileName = null;
  store.songIndex = 0;
  store.cursor = { row: 0, ch: 0, sub: 0, nib: 0 };
  store.pitchPreset = presetForNotation(result.notation, store.doc);
  store.undo = new UndoStack(store.doc, (dirty) => {
    store.sync?.onDirty(dirty);
    // A channel insert shifts the mute array along with the patterns; the tag
    // is direction-free because UndoStack replays the forward op's tags. A
    // "format" tag re-pushes the whole document, which resets the engine (item
    // 125) — the mutes are the desk's, so they go back down after it.
    if (dirty.some((tg) => tg.kind === "voices" || tg.kind === "format")) store.syncVoiceMutes();
    store.emit("edit", dirty);
    updateStatus();
  });
  store.sync = null;
  if (store.audio) {
    store.sync = new DocSync(store.audio, store.doc, 0);
    store.sync.loadAll();
  }
  const sel = $("songSel");
  sel.innerHTML = "";
  const opt = document.createElement("option");
  opt.value = 0;
  opt.textContent = `0: ${projName}`;
  sel.appendChild(opt);
  store.emit("doc"); // invalidate view caches before the first draw (item 49a)
  showView("timeline"); // hides the welcome screen: a document is loaded now
  updateStatus();
}

$("newBtn").addEventListener("click", () => newProject());
// Open takes native containers + tracker files; MIDI goes through the
// dedicated Import MIDI… button (explicit soundfont choice). Drag-drop and
// ?load= still accept .mid via the automatic bundled-else-picker path.
// `.bnk` is here so an AdLib song and its bank can be picked TOGETHER; a bank
// on its own is not a project and loadFileSet ignores it.
const OPEN_ACCEPT = ".taud,.tsii,.tpif,.bnk," +
  CONVERT_ACCEPT.split(",").filter((e) => !e.startsWith(".mid")).join(",");
$("fileInput").accept = OPEN_ACCEPT;
$("fileInput").multiple = true;
$("openBtn").addEventListener("click", () => $("fileInput").click());

/** Pick a .mid + soundfont, convert, load. `toOpfs` (Files-tab button) also
 *  persists the conversion result into OPFS. */
async function importMidiInteractive({ toOpfs = false } = {}) {
  const file = await pickFile(".mid,.midi");
  if (!file) return;
  const bundledAvail = (await getBundledSoundfont()) !== null;
  const choice = await showModal({
    title: t("midi.title", { name: file.name }),
    body: t("midi.body"),
    // Value settings first, then the tick-box options: with the boxes in one
    // column and the controls in another, the dialog reads as a form. Each
    // option's explanation is a `hint` under it rather than a parenthesis
    // inside its label — the label is the NAME of the setting, and a name you
    // have to read to the end of to find the checkbox is not one.
    fields: [{
      name: "sf", label: t("midi.soundfont"), type: "select",
      value: bundledAvail ? "bundled" : "own",
      options: [
        ...(bundledAvail ? [{ value: "bundled", label: t("midi.bundled") }] : []),
        { value: "own", label: t("midi.chooseSf2") },
      ],
    }, {
      // Rows-per-beat: pins midi2taud's grid (else auto from time signatures
      // + onset analysis). Choices mirror the converter's --rpb argparse.
      name: "rpb", label: t("midi.rpb"), type: "select", value: "auto",
      options: [
        { value: "auto", label: t("midi.rpbAuto") },
        ...[2, 4, 8, 16, 32, 64].map((n) => ({ value: String(n), label: String(n) })),
      ],
    }, {
      // Item 183: for a MIDI whose declared tempo does not describe its own
      // events — a beat that is 1.2 or 1.35 quarter notes long, so bar lines
      // fall mid-phrase and rows/beat means nothing. The converter rescales
      // every tick AND every tempo by one factor, so the performance keeps its
      // real-time timing and the music's own beat becomes the quarter note.
      // "Detect" reads the grid off the note onsets and is inert on a file
      // that is already aligned; the BPM box below overrules it.
      name: "realign", label: t("midi.realign"), type: "select", value: "off",
      hint: t("midi.realignHint"),
      options: [
        { value: "off", label: t("midi.realignOff") },
        { value: "auto", label: t("midi.realignAuto") },
      ],
    }, {
      // The punch-in half of the same setting, and the only thing that can help
      // a file whose GRID is fine and whose tempo NUMBER is simply wrong — that
      // case leaves no trace in the event positions for detection to find.
      name: "realignBpm", label: t("midi.realignBpm"), type: "number",
      value: "", min: 15, max: 800, placeholder: t("midi.realignBpmPlaceholder"),
      hint: t("midi.realignBpmHint"),
    }, {
      // Item 168: quantisation is OFF by default, and the hint says what it
      // costs — this is the one import option that rewrites the performance
      // rather than how it is encoded, and a MIDI that was PLAYED (rather than
      // stepped in) usually wants its timing left alone. "Auto" snaps to the
      // subdivision the onsets already use, which is the grid the piece is
      // written on; "row" snaps to the tracker's own rows.
      name: "quantise", label: t("midi.quantise"), type: "select", value: "off",
      hint: t("midi.quantiseHint"),
      options: [
        { value: "off", label: t("midi.quantiseOff") },
        { value: "auto", label: t("midi.quantiseAuto") },
        { value: "row", label: t("midi.quantiseRow") },
        ...[4, 8, 16].map((n) => ({ value: String(n), label: t("midi.quantiseNth", { n }) })),
      ],
    }, {
      // Item 75: the converter keeps every preset's full zone map by default, so
      // imported instruments stay playable beyond the notes this song uses and
      // Housekeeping cleans up on demand. Ticking this restores the old
      // trim-to-triggered behaviour — worth it for a preset-heavy MIDI whose
      // untrimmed pool would overflow 8 MB (that path resamples EVERYTHING down).
      name: "trim", label: t("midi.trimPatches"), type: "checkbox", value: false,
      hint: t("midi.trimPatchesHint"),
    }, {
      // Item 90.1: SoundFont instruments built from a stereo sample pair are
      // mixed to mono by default — stereo doubles their pool cost, and pool
      // overflow resamples the WHOLE bank down.
      name: "stereo", label: t("midi.stereoSamples"), type: "checkbox", value: false,
      hint: t("midi.stereoSamplesHint"),
    }, {
      // The converter pools byte-identical patterns, so a repeated bar (and
      // every silent column) is ONE pattern the cue sheet points at several
      // times — edit it in one cue and every other cue changes with it. Ticking
      // this gives each cue×voice cell its own pattern, which is what you want
      // when the import is a starting point for editing rather than a finished
      // song. Costs pattern slots (32767 cap), barely any file size.
      name: "nodedup", label: t("midi.keepDupPatterns"), type: "checkbox", value: false,
      hint: t("midi.keepDupPatternsHint"),
    }],
    okLabel: t("common.import"),
  });
  if (!choice) return;
  // A typed BPM outranks the select: it is the more specific answer, and it is
  // the only one that helps when the events carry no evidence of the mistake.
  let realign = choice.realign === "auto" ? "auto" : null;
  const typedBpm = String(choice.realignBpm ?? "").trim();
  if (typedBpm !== "") {
    const bpm = Number(typedBpm);
    if (!Number.isFinite(bpm) || bpm < 15 || bpm > 800) {
      $("stFile").textContent = t("midi.realignBadBpm", { bpm: typedBpm });
      return;
    }
    realign = bpm;
  }
  const sf2 = choice.sf === "bundled" ? await getBundledSoundfont() : await pickUserSoundfont();
  if (!sf2) { $("stFile").textContent = t("midi.cancelled"); return; }
  await loadBytes(file.name, new Uint8Array(await file.arrayBuffer()),
    {
      sf2, saveToOpfs: toOpfs, rpb: choice.rpb,
      trimPatches: choice.trim === true,
      stereoSamples: choice.stereo === true,
      keepDuplicatePatterns: choice.nodedup === true,
      realign,
      quantise: choice.quantise,
    });
}
$("importMidiBtn").addEventListener("click", () => importMidiInteractive());
/** Load the first file of a picked/dropped set, pairing an AdLib song with a
 *  .BNK dropped alongside it — the two halves of one .ims arrive together far
 *  more often than not, and the bank is what makes the song audible. */
async function loadFileSet(files) {
  const list = [...files];
  const bnk = list.find((f) => /\.bnk$/i.test(f.name));
  const bank = bnk
    ? { name: bnk.name, bytes: new Uint8Array(await bnk.arrayBuffer()) }
    : null;
  const song = list.find((f) => f !== bnk);
  if (!song) {
    // A bank on its own is not a project: keep it for the songs to come.
    if (bank && rememberBank(bank)) $("stFile").textContent = t("bank.remembered", { name: bank.name });
    return;
  }
  await loadBytes(song.name, new Uint8Array(await song.arrayBuffer()), { bank });
}

$("fileInput").addEventListener("change", async (e) => {
  await loadFileSet(e.target.files);
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault();
  await loadFileSet(e.dataTransfer.files);
});
window.addEventListener("beforeunload", (e) => {
  if (store.doc?.dirty) e.preventDefault();
});

function rebuildSongList() {
  const sel = $("songSel");
  sel.innerHTML = "";
  store.doc.songs.forEach((song, i) => {
    const opt = document.createElement("option");
    const sm = store.doc.meta.songMeta[i];
    opt.value = i;
    opt.textContent = sm?.name ? `${i}: ${unescapeName(sm.name)}` : `song ${i}`;
    sel.appendChild(opt);
  });
  sel.value = store.songIndex;
}

function selectSong(index) {
  store.songIndex = Math.min(Math.max(index, 0), store.doc.songs.length - 1);
  $("songSel").value = store.songIndex;
  store.clearMutes(); // per-song state (taut finishLoadCommon)
  store.clearFx2();
  store.cursor = { row: 0, ch: 0, sub: 0, nib: 0 };
  store.pitchPreset = presetForNotation(store.doc.meta.songMeta[store.songIndex]?.notation ?? 120, store.doc);
  if (store.audio) {
    store.audio.stop(0);
    store.sync = new DocSync(store.audio, store.doc, store.songIndex);
    store.sync.loadAll();
  }
  store.emit("doc");
  updateStatus();
}

$("songSel").addEventListener("change", (e) => selectSong(parseInt(e.target.value, 10)));

// Edit song `index`'s own metadata — offered per-row on the Project tab's song
// list. All three sMet strings, since a project of several songs is exactly
// where a per-song composer and copyright mean something; the write goes
// through ProjectView.changeSongMeta so there is one code path. The inputs show
// the DECODED text; changeSongMeta re-escapes on save.
async function editSongInteractive(index) {
  if (!store.doc) return;
  const sm = store.doc.meta.songMeta[index];
  const result = await showModal({
    title: t("song.editTitle", { n: index }),
    fields: [
      { name: "name", label: t("files.name"), value: unescapeName(sm?.name ?? "") },
      { name: "composer", label: t("song.composer"), value: unescapeName(sm?.composer ?? "") },
      { name: "copyright", label: t("song.copyright"), value: unescapeName(sm?.copyright ?? "") },
    ],
    okLabel: t("common.apply"),
  });
  if (result === null) return;
  viewNamed("project").changeSongMeta({
    name: result.name, composer: result.composer, copyright: result.copyright,
  }, index);
  rebuildSongList();
  updateStatus();
}

// Project view add/remove-song: rebuild the picker + switch to the target song.
store.on("songs", (payload) => {
  rebuildSongList();
  selectSong(payload?.select ?? store.songIndex);
});
store.on("doc", updateStatus); // keep the dirty dot in sync on doc-level edits
// The Panner button appears with the song's surround model — which arrives on a
// load ("doc") and can be switched in the Project view ("edit").
store.on("doc", refreshToolbox);
store.on("edit", refreshToolbox);

// ── views ──
// EVERY view can be open twice (item 148.1) — one copy per split pane, each
// with its own host element, scroll position and selection, so two Timelines
// can sit at different bars of the same song. That is why nothing here is a
// singleton any more: the shell builds a view through VIEW_SPEC, once per
// pane that asks for it, and reaches copies through viewNamed/eachView.
const jam = new JamKeyboard(store);
window.__microtoneEnsureAudio = ensureAudio; // pattern preview needs lazy audio

/** New instrument from a pooled sample (item 40): adopt it + jump to it. */
function adoptNewInstrument(slot) {
  jam.currentInst = slot;
  eachView("instruments", (v) => { v.selected = slot; });
  store.emit("instsel");
  showView("instruments");
  updateStatus();
}

/**
 * Save the upgraded project under a NEW name and continue working on that
 * one (format v3, §5.5). The original file is left alone deliberately: the
 * upgrade has no defined way back, so the version-2 copy stays readable by
 * anything that reads version 2 — including the TSVM device.
 */
async function saveProjectCopyAs(name) {
  if (!(await opfs.available())) return; // nothing persists here; keep the edit in memory
  let target = name;
  for (let n = 2; (await opfs.list()).some((f) => f.name === target); n++) {
    target = name.replace(/\.taud$/, `-${n}.taud`);
  }
  await opfs.write(target, store.doc.toBytes());
  store.doc.dirty = false;
  store.fileName = target;
  store.emit("saved", target);
  updateStatus();
}

/**
 * Load one of the bundled demo songs (item 163). Half a megabyte over the
 * network, so it gets a real progress bar rather than a silent pause; the
 * bytes then go through the ordinary load path, which means the
 * discard-unsaved-work prompt applies exactly as it does to any other open.
 *
 * Nothing is written to OPFS: a demo is fetched from assets/ every time, and
 * only a Save the user asks for makes a local copy.
 */
async function loadDemo(entry) {
  const progress = showProgress(t("demos.loading", { title: entry.title ?? entry.file }));
  let bytes;
  try {
    bytes = await fetchDemo(entry, (f) => progress.set(f));
  } catch (err) {
    progress.fail(t("demos.loadFail", { title: entry.title ?? entry.file }));
    console.error(`DEMO: ${entry.file} failed`, err);
    return;
  }
  progress.done();
  await loadBytes(entry.file, bytes);
}

/** Welcome screen (item 104) — the Timeline tab's content before a project is
 *  loaded. Everything it offers is an existing entry point, wired here rather
 *  than re-implemented. */
const WELCOME_HOOKS = {
  newProject: () => newProject(),
  open: () => $("fileInput").click(),
  importMidi: () => importMidiInteractive(),
  openRecent: async (name) => loadBytes(name, await opfs.read(name)),
  browseFiles: () => showView("files"),
  help: () => showHelp(),
  openDemo: (entry) => loadDemo(entry),
};

/**
 * How each view is built: the host element it draws into — `id` names the one
 * index.html already declares, which the FIRST copy reuses (those ids are what
 * the smoke tests address) — and how to construct it. `copy` is 0 for the
 * first, 1 for the one in the other pane; only the Patterns view cares, since
 * its per-column second-effect flags live in the store, keyed by pane index.
 */
const VIEW_SPEC = {
  timeline: {
    host: { id: "timeline", tag: "canvas", cls: "view-canvas" },
    make: (el) => new TimelineView(store, el),
  },
  cues: {
    host: { id: "cuesCanvas", tag: "canvas", cls: "view-canvas" },
    make: (el) => new CuesView(store, el),
  },
  pattern: {
    host: { id: "patternHost" },
    make: (el, copy) => new PatternView(store, el, jam, { fx2Base: copy * FX2_BASE_STEP }),
  },
  samples: {
    host: { id: "samplesHost" },
    make: (el) => new SamplesView(store, el, { onNewInstrument: adoptNewInstrument }),
  },
  instruments: {
    host: { id: "instrumentsHost" },
    make: (el) => new InstrumentsView(store, el, jam),
  },
  mastering: {
    host: { id: "masteringHost" },
    make: (el) => new MasteringView(store, el),
  },
  project: {
    host: { id: "projectHost" },
    make: (el) => new ProjectView(store, el, {
      editSong: (i) => editSongInteractive(i),
      saveCopyAs: saveProjectCopyAs,
    }),
  },
  files: {
    host: { id: "filesHost", cls: "files-host" },
    make: (el) => new FilesView(store, el, {
      openBytes: (name, bytes) => loadBytes(name, bytes),
      currentDoc: () => ({ doc: store.doc, fileName: store.fileName }),
      songIndex: () => store.songIndex,
      importMidi: () => importMidiInteractive({ toOpfs: true }),
      editSong: (i) => editSongInteractive(i),
      openDemo: (entry) => loadDemo(entry),
    }),
  },
};

// Fixtures that stay single whatever the split does: the instrument lookup is
// one panel the shell docks to the left of whichever pane holds a grid (item
// 168), and the master strip sits beside the whole split.
const instLookup = new InstLookup(store, jam, $("instLookup"), () => updateStatus());
const masterStrip = new MasterStrip(store, $("masterStrip"));
masterStrip.onToggle = () => refreshToolbox();

/** Toolbox buttons that depend on the document, not on the view. */
function refreshToolbox() {
  const surround = (store.doc?.songs[store.songIndex]?.surroundModel ?? 0) !== 0;
  $("tbPanner").hidden = !surround;
  $("tbRadar").hidden = !surround;
  $("tbRadar").textContent = t(store.surroundMeters ? "toolbox.radarOn" : "toolbox.radarOff");
  $("tbBinaural").hidden = !surround;
  $("tbBinaural").textContent = t(store.binaural ? "toolbox.binauralOn" : "toolbox.binauralOff");
  $("tbBinaural").classList.toggle("active", store.binaural);
  // Second effect column (§5.5): only a format-v3 project HAS one, and the
  // button is the all-channels switch — the per-channel one is on the channel
  // header's right-click menu (Timeline) and each column's E2 button (Patterns).
  refreshFx2Btn();
  // Master strip (item 98) — a Timeline fixture, so the button only means
  // anything while a pane is showing one (item 148).
  $("tbMaster").hidden = !store.viewOpen("timeline");
  $("tbMaster").textContent = t(masterStrip.visible ? "toolbox.masterOn" : "toolbox.masterOff");
  $("tbMaster").classList.toggle("active", masterStrip.visible);
}

// The views that mean something with nothing loaded: the Timeline (which is
// where the welcome screen lives) and the File tab (browse OPFS, import
// something). Item 104.1 — before this, going to the File tab with no document
// was a one-way trip, because the Timeline tab was as inert as the rest.
const NO_DOC_VIEWS = ["timeline", "files"];

/** Is this view reachable at all right now? (The dead-end tabs say so rather
 *  than silently swallowing the click — item 104.1.) */
function viewEnabled(name) { return !!store.doc || NO_DOC_VIEWS.includes(name); }

/** paneViews[i] holds pane i's copy of each view it has ever shown, as
 *  {el, els, obj} (+ the welcome screen on a Timeline entry). */
const paneViews = [new Map(), new Map()];
/** …and how many copies of each view exist, so a second one knows it is one. */
const viewCopies = new Map();

// The view area: one pane or two, each with its own tabs (item 148).
const split = new SplitView($("splitHost"), {
  onChange: () => applyViews(),
  enabled: viewEnabled,
  onAdopt: (from, to, name) => adoptPaneView(from, to, name),
});

/** The element a view draws into. The first copy takes the one index.html
 *  declares; a second gets an id-less twin in its own pane's stage. */
function hostFor(stage, spec, first) {
  if (first) return $(spec.id);
  const el = document.createElement(spec.tag ?? "div");
  el.className = spec.cls ?? "view-dom";
  el.hidden = true;
  stage.appendChild(el);
  return el;
}

function makeView(name, stage, copy) {
  const spec = VIEW_SPEC[name];
  const el = hostFor(stage, spec.host, copy === 0);
  const entry = { el, els: [el], obj: spec.make(el, copy) };
  if (name === "timeline") {
    // The welcome screen is what the Timeline shows before a project is loaded
    // (item 104), so it belongs to the Timeline's pane and travels with it.
    entry.welcomeEl = hostFor(stage, { id: "welcomeHost" }, copy === 0);
    entry.welcome = new WelcomeView(store, entry.welcomeEl, WELCOME_HOOKS);
    entry.els.push(entry.welcomeEl);
  }
  return entry;
}

/** Pane `pane`'s copy of `name`, built on first use. */
function ensureView(pane, name) {
  const existing = paneViews[pane].get(name);
  if (existing) return existing;
  const copy = viewCopies.get(name) ?? 0;
  viewCopies.set(name, copy + 1);
  const entry = makeView(name, split.stage(pane), copy);
  paneViews[pane].set(name, entry);
  return entry;
}

/** Move a view's copy (and its host elements) between panes — what closing
 *  pane 0 does, so the survivor you keep is the one you were looking at. */
function adoptPaneView(from, to, name) {
  const entry = paneViews[from].get(name);
  if (!entry) return;
  const displaced = paneViews[to].get(name) ?? null;
  paneViews[to].set(name, entry);
  if (displaced) paneViews[from].set(name, displaced);
  else paneViews[from].delete(name);
  for (const el of entry.els) split.stage(to).appendChild(el);
  if (displaced) for (const el of displaced.els) split.stage(from).appendChild(el);
  entry.obj.rehost?.();       // a canvas measures whichever stage it is in now
  displaced?.obj.rehost?.();
}

/** The copy of `name` the keyboard is talking to: the focused pane's when that
 *  pane is showing it, else the other pane's, else the first copy (which
 *  always exists — pane 0 builds all eight at boot, so the smoke tests can
 *  drive a view that is not on screen). */
function viewNamed(name) {
  for (const i of [split.focus, 1 - split.focus]) {
    if (split.paneView(i) === name) return paneViews[i].get(name).obj;
  }
  return paneViews[0].get(name)?.obj ?? paneViews[1].get(name)?.obj ?? null;
}
/** Every copy of `name` that exists, shown or not — invalidations, rebuilds. */
function eachView(name, fn) {
  for (const map of paneViews) { const e = map.get(name); if (e) fn(e.obj, e); }
}
/** …and only the copies a pane is actually showing — re-renders. */
function eachOpenView(name, fn) {
  for (let i = 0; i < paneViews.length; i++) {
    const e = split.paneView(i) === name ? paneViews[i].get(name) : null;
    if (e) fn(e.obj, e);
  }
}
/** Repaint every grid copy: record mode, theme, canvas font, the raw-note and
 *  panner toggles — all of them change what a grid draws, in any pane. */
function invalidateGrids() {
  for (const name of ["timeline", "cues", "pattern"]) eachView(name, (v) => v.invalidate());
}

// Pane 0 gets all eight up front, the way the shell always built them: the
// hosts are in index.html already, several views are driven before they are
// first shown (the smoke tests, the language switch), and it keeps "the first
// copy" a fixed, predictable thing.
for (const name of VIEWS) ensureView(0, name);

/** Go to a view: the pane already showing it takes the keyboard, otherwise the
 *  focused pane switches to it. (A tab CLICK goes through SplitView, which
 *  will happily give both panes the same view.) */
function showView(name) { split.reveal(name); }

/** One view's show/hide, per pane copy. `on` = its pane is showing it. */
function applyEntry(name, entry, on) {
  const noDoc = !store.doc;
  if (name === "timeline") {
    const welcome = on && noDoc;
    entry.welcomeEl.hidden = !welcome;
    welcome ? entry.welcome.show() : entry.welcome.hide();
    entry.el.hidden = !on || noDoc;
    if (on && !noDoc) entry.obj.resize();
    return;
  }
  entry.el.hidden = !on;
  switch (name) {
    case "cues": if (on) entry.obj.resize(); break;
    case "files": if (on) entry.obj.refresh(); break;
    default: on ? entry.obj.show() : entry.obj.hide(); break;
  }
}

/**
 * Reflect the pane layout onto the views: build what a pane now needs, then
 * show/hide every copy that exists. Driven by "is THIS pane showing it", so
 * the same view being open in both panes is just two copies both on. Runs
 * after every split change; everything in it is idempotent.
 */
function applyViews() {
  const noDoc = !store.doc;
  const open = split.views; // one or two view names, in pane order
  store.views = open;
  store.view = split.view;
  const has = (v) => open.includes(v);

  for (let i = 0; i < paneViews.length; i++) {
    const shown = split.paneView(i);
    if (shown) ensureView(i, shown);
    for (const [name, entry] of paneViews[i]) applyEntry(name, entry, name === shown);
  }
  // The instrument lookup docks against a GRID (item 168) — hand it to the
  // focused pane when that is one, else to whichever pane holds a grid at
  // all. Prepended, not appended: it is the flex row's LEFT-most sibling of
  // stage(i), same as the master strip's own right-hand edge.
  const gridPane = store.view === "timeline" || store.view === "pattern"
    ? split.focus
    : Math.max(split.paneOf("timeline"), split.paneOf("pattern"));
  if (gridPane >= 0) {
    const dockHost = split.dockHost(gridPane);
    if ($("instLookup").parentElement !== dockHost) dockHost.prepend($("instLookup"));
  }

  $("toolbox").hidden = !(has("timeline") || has("pattern")) || noDoc;
  refreshToolbox();
  $("placeholder").hidden = true;
  store.emit("view");
}

// ── transport ──
async function playFrom(cue, row) {
  if (!store.doc) return;
  await ensureAudio(); // guarantees store.sync exists for the loaded doc
  store.sync.flushPatterns();
  store.audio.resetSampleFxState(0);
  store.audio.setCuePosition(0, cue);
  store.audio.setTrackerRow(0, row);
  store.audio.play(0);
}

/** Where a "play from cue"/"play from cursor" starts, honouring the active
 *  view. The Cues view drives its OWN row cursor (item 39) — the Timeline
 *  cursor doesn't move while you navigate cues, so playing from the Timeline
 *  cursor there ignored the selected cue. Every other view maps the Timeline
 *  cursor's absolute row to its cue/row. Clamped to the materialised cue list. */
function playCursor() {
  if (store.view === "cues") {
    const nCues = store.song?.cues.length ?? 0;
    const cue = Math.min(Math.max(viewNamed("cues").cursor.cue, 0), Math.max(nCues - 1, 0));
    return { cue, row: 0 };
  }
  const loc = viewNamed("timeline").locate(store.cursor.row);
  return { cue: loc ? loc.entry.cue : 0, row: loc ? loc.rowInCue : 0 };
}

$("playSong").addEventListener("click", () => playFrom(0, 0));
$("playCue").addEventListener("click", () => playFrom(playCursor().cue, 0));
$("stopBtn").addEventListener("click", () => store.audio?.stop(0));
$("follow").addEventListener("change", (e) => { store.follow = e.target.checked; });

function setRecord(on) {
  store.record = on;
  $("recBtn").classList.toggle("on", on);
  invalidateGrids();
  updateHint(); // record mode changes the grid-view hint (item 78)
}
$("recBtn").addEventListener("click", () => setRecord(!store.record));
$("undoBtn").addEventListener("click", () => store.undo?.undo());
$("redoBtn").addEventListener("click", () => store.undo?.redo());

// ── About (brand click) ──
$("brandBtn").addEventListener("click", () => showAbout());

// ── reload (refresh the page back to the initial state) ──
$("reloadBtn").addEventListener("click", () => {
  if (store.doc?.dirty && !confirm(t("confirm.discard"))) return;
  location.reload();
});

// ── on-screen help (mirrors the '?' key; works regardless of view/doc) ──
$("helpBtn").addEventListener("click", () => showHelp());

// ── language picker (applied live — no reload; item 29) ──
$("langBtn").textContent = currentLang().toUpperCase();
$("langBtn").addEventListener("click", async () => {
  const result = await showModal({
    title: t("lang.title"),
    body: t("lang.body"),
    fields: [{
      name: "lang", label: t("lang.field"), type: "select", value: currentLang(),
      options: Object.entries(LANGS).map(([value, label]) => ({ value, label })),
    }],
    okLabel: t("common.ok"),
  });
  if (!result || result.lang === currentLang()) return;
  await changeLang(result.lang); // swaps strings + applyDom + fires onLangChange
});
// Re-apply the imperatively-set (non data-i18n) labels + re-render dynamic views.
onLangChange(() => {
  $("langBtn").textContent = currentLang().toUpperCase();
  $("tbRaw").textContent = t(store.rawNoteView ? "toolbox.rawOn" : "toolbox.rawOff");
  split.refresh();  // the panes' split/close button titles (item 148)
  refreshToolbox(); // the other imperatively-labelled toolbox buttons
  eachView("pattern", (v) => v.buildBar());
  palette.refresh();
  instLookup.render();
  if (store.doc) rebuildSongList();
  for (const name of ["samples", "instruments", "project", "files"]) {
    eachOpenView(name, (v) => v.refresh());
  }
  // The Mastering view's labels are all built at rebuild time (item 178).
  eachOpenView("mastering", (v) => v.rebuild());
  updateStatus();
});

// ── theme toggle ──
$("themeBtn").addEventListener("click", () => toggleTheme());
// The Warmth edition announces itself every time it is switched on, the way
// the plugins it parodies do. A boot INTO warmth happens before this listener
// exists, so the bottom of the file catches that one.
onThemeChange((name) => { if (name === WARMTH) showWarmthSplash(); });
onThemeChange(() => {
  // repaint every canvas + refresh DOM views that cache colours implicitly
  refreshCanvasFont(); // --cv-font could be themed too
  invalidateGrids();
  eachOpenView("samples", (v) => v.refresh());
  eachOpenView("instruments", (v) => v.renderPanel());
});

// ── canvas grid webfont (--cv-font) ──
// Canvas text never triggers a webfont download on its own; force-load the
// faces at the sizes the grids draw (12px timeline/cues, 13px patterns) and
// repaint once the real font is in (early paints show the fallback stack).
loadCanvasFonts([13, 14], () => invalidateGrids());

// ── toolbox (Timeline / Patterns) ──
$("tbRetune").addEventListener("click", () => viewNamed("project").openRetune());
store.rawNoteView = false;
$("tbRaw").textContent = t("toolbox.rawOff");
$("tbRaw").addEventListener("click", () => {
  store.rawNoteView = !store.rawNoteView;
  $("tbRaw").textContent = t(store.rawNoteView ? "toolbox.rawOn" : "toolbox.rawOff");
  $("tbRaw").classList.toggle("active", store.rawNoteView);
  invalidateGrids();
});
// Second effect column (§5.5) — hidden by default, because most songs never
// write one and it costs six characters of the widest column on screen. This
// button is the ALL-channels switch: on when anything is showing it, and one
// click puts every channel and every pattern column back the other way.
function refreshFx2Btn() {
  const btn = $("tbFx2");
  const wide = store.doc?.wideCells === true;
  btn.hidden = !wide;
  const on = wide && store.fx2Any();
  btn.textContent = t(on ? "toolbox.fx2On" : "toolbox.fx2Off");
  btn.classList.toggle("active", on);
}
$("tbFx2").addEventListener("click", () => store.setAllFx2(!store.fx2Any()));
store.on("fx2", () => refreshFx2Btn());
// Surround radar (#998.6): expands every Timeline channel header into a
// top-down dial. Collapsed, the pan strip already shows that dial's horizontal
// shadow, so the toggle is "show me the other axis", not a different reading.
store.surroundMeters = false;
$("tbRadar").addEventListener("click", () => {
  store.surroundMeters = !store.surroundMeters;
  $("tbRadar").textContent = t(store.surroundMeters ? "toolbox.radarOn" : "toolbox.radarOff");
  $("tbRadar").classList.toggle("active", store.surroundMeters);
  // the header got taller/shorter — every Timeline's row layout follows
  eachView("timeline", (v) => { v.resize(); v.invalidate(); });
});
// Binaural monitoring (#998.3): the stereo fold cannot render height, and it
// mirrors the rear arc onto the front, so a surround song is monitored through
// a head model by DEFAULT — otherwise you would be authoring positions you
// cannot hear. Turning it off is how you check the downmix everyone else gets.
// (The default lives in the Store — audio bring-up reads it before this runs.)
$("tbBinaural").addEventListener("click", () => {
  store.binaural = !store.binaural;
  store.audio?.setMonitorMode(0, store.binaural ? 1 : 0);
  refreshToolbox();
});
// Spatial panner (#998.6) — only meaningful once the song declares a surround
// model, so the button appears with it.
$("tbPanner").addEventListener("click", async () => {
  const { showPanner } = await import("./popups/panner.js");
  await showPanner(store, cursorCellTarget());
  invalidateGrids();
});
// Master strip (item 98): the mastering panel down the right-hand edge —
// vectorscopes, RMS/peak metering and the song's global-volume fader. Visible
// by default; hiding it also drops the engine's analysis tap.
$("tbMaster").addEventListener("click", () => {
  masterStrip.toggle();
  refreshToolbox();
});
// Quick instrument lookup toggle (persists per session).
$("tbInstList").classList.toggle("active", instLookup.visible);
$("tbInstList").addEventListener("click", () => {
  $("tbInstList").classList.toggle("active", instLookup.toggle());
});

// ── wheelable topbar controls (hover + wheel) ──
function onWheelCtl(id, fn) {
  $(id).addEventListener("wheel", (e) => {
    e.preventDefault();
    const d = e.deltaY !== 0 ? e.deltaY : e.deltaX;
    fn(d < 0 ? 1 : -1);
  }, { passive: false });
}
// Step the current (jam/entry) instrument by dir through the selectable
// (top-level) slots — never land on a metainstrument's sub-instrument (item 59).
// Wrap-free clamp at the ends. Shared by the topbar instCtl wheel and the
// not-record bracket keys (item 47.6: { } = instrument down / up).
function stepCurrentInst(dir) {
  if (!store.doc) return;
  const slots = store.doc.selectableInstrumentSlots();
  if (slots.length === 0) return;
  let i = slots.indexOf(jam.currentInst);
  if (i < 0) i = 0;
  else i = Math.min(Math.max(i + dir, 0), slots.length - 1);
  jam.currentInst = slots[i];
  updateStatus();
  store.emit("instsel");
}
onWheelCtl("octCtl", (dir) => { jam.octaveDelta(dir); updateStatus(); });
onWheelCtl("instCtl", (dir) => stepCurrentInst(dir));

/** The bracket-key scheme (items 47.2 + 47.6). `dir` = -1 for '[' / +1 for ']';
 *  `shift` selects the '{' / '}' variant. In record mode on a grid view the
 *  brackets edit the cell under the cursor (contextual per column); otherwise
 *  they are the global octave ([ ]) / instrument ({ }) steppers. */
function handleBracket(dir, shift) {
  if (store.record && (store.view === "timeline" || store.view === "pattern")) {
    if (viewNamed(store.view).bracketEdit(dir, shift)) { updateStatus(); return; }
  }
  if (shift) stepCurrentInst(dir);                       // { } = instrument down/up
  else { jam.octaveDelta(dir); updateStatus(); }         // [ ] = octave down/up
}
onWheelCtl("spdCtl", (dir) => {
  // live playback speed tweak (device only — the A effect can still override)
  const audio = store.audio;
  if (!audio) return;
  const cur = audio.getTickRate() || store.song?.tickRate || 6;
  audio.setTickRate(0, Math.min(Math.max(cur + dir, 1), 127));
});

// ── contextual command palette (screen bottom) ──
/** The cell under the cursor in whichever grid view is showing, as
 *  {sub, channel, rowLabel, cell, apply(fields)} — or null. Record mode is NOT
 *  required here: the palette adds that rule, the Panner deliberately does not
 *  (you place a source the same way you would run Retune). */
function cursorCellTarget() {
  if (!store.doc) return null;
  if (store.view === "timeline") {
    const target = viewNamed("timeline").cursorCell();
    if (!target) return null;
    return {
      sub: store.cursor.sub,
      channel: store.cursor.ch,
      rowLabel: String(store.cursor.row),
      wide: store.doc.wideCells === true, // format v3's columns (§5.5)
      cell: target.cell,
      apply: (fields) => store.undo.apply(
        setCellOp(store.songIndex, target.pat, target.rowInCue, fields)),
    };
  }
  if (store.view === "pattern") {
    const pat = viewNamed("pattern");
    const pattern = pat.pattern();
    if (!pattern) return null;
    const row = pat.cursor.row;
    return {
      sub: pat.cursor.sub,
      channel: pat.cursor.ch ?? 0,
      rowLabel: String(row),
      wide: store.doc.wideCells === true,
      cell: pattern[row],
      apply: (fields) => store.undo.apply(
        setCellOp(store.songIndex, pat.patIdx, row, fields)),
    };
  }
  return null;
}

function editContext() {
  return store.record ? cursorCellTarget() : null;
}
const palette = new CommandPalette($("cmdPalette"), editContext);
for (const topic of ["cursor", "edit", "view", "doc"]) {
  store.on(topic, () => palette.refresh());
}

// ── Find (item 177) ──
// The bar owns the criteria and the walk; going to a match is the views' own
// business, because only they know what "there" means — an absolute song row
// and channel on the Timeline, a pattern and a row in Patterns. Every copy of
// the view follows (a split shows the same music twice, and "take me there"
// means both panes), exactly as Goto does.
const findBar = new FindBar($("findBar"), store, {
  view: () => store.view,
  goSong: (m) => {
    store.cursor.row = m.row;
    store.cursor.ch = m.ch;
    eachView("timeline", (v) => v.centreRow(m.row));
    store.emit("cursor");
    updateStatus();
  },
  goPattern: (m) => {
    const pat = viewNamed("pattern");
    if (!pat) return;
    pat.goTo(m.pat, m.row);
    store.emit("cursor");
    updateStatus();
  },
  // …and where the walk starts from: the ACTIVE pane's pattern and row, since
  // that is the one the keyboard is in.
  patternCursor: () => {
    const pat = viewNamed("pattern");
    return pat ? { pat: pat.patIdx, row: pat.cursor.row } : null;
  },
  // The bar is a text field: while it has focus the grid sees no keys at all,
  // so closing it has to give them back.
  focusGrid: () => document.activeElement?.blur?.(),
});
store.on("cursor", () => { if (findBar.open) findBar.paintCount(); });

// The grid views that support block selection + clipboard (item 17; Cues added
// later — it keeps its own cue-word clipboard, store.cueClipboard).
function selView() {
  return ["timeline", "pattern", "cues"].includes(store.view) ? viewNamed(store.view) : null;
}

// A button keeps DOM focus after it is clicked, and a focused button treats
// Enter and Space as "press me again" — so the transport keys would re-open the
// dialog you just used instead of starting playback (item 105). Hand focus back
// to the app after every POINTER activation, so Enter always means play/stop.
//
// `detail === 0` is a click the KEYBOARD synthesised (Enter/Space on a focused
// control, or .click() from our own code): leaving that one focused is what
// keeps tab-through navigation usable. Dialogs are left alone — inside a modal,
// activating the focused button IS what Enter should do, and contextmenu.js
// walks its cells with the same focus.
document.addEventListener("click", (e) => {
  if (e.detail === 0) return;
  const btn = e.target.closest?.("button, a");
  if (btn && !btn.closest("dialog")) btn.blur();
});

// ── keyboard dispatch ──
// A focused text field is TYPING, and the grid shortcuts (and the jam keyboard)
// must keep their hands off it. TEXTAREA belongs here as much as INPUT does:
// without it the Project tab's message box never sees an Enter, because the
// dispatch below claims the key first.
function isTypingTarget(el) {
  const tag = el?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
    el?.isContentEditable === true;
}

window.addEventListener("keydown", (e) => {
  // Save works anywhere, any time (item 47.4): before the input/dialog and
  // no-doc guards below, so a focused field or open modal can't swallow it.
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    if (store.doc) viewNamed("files").save();
    return;
  }
  if (!store.doc) {
    // The welcome screen (F1) and the File tab (F9) stay reachable before
    // anything is loaded — and so does the way back (item 104.1).
    if ((e.code === "F1" || e.code === "F9") && !e.ctrlKey && !e.metaKey && !e.altKey &&
        !isTypingTarget(e.target) && !e.target.closest?.("dialog")) {
      e.preventDefault();
      showView(e.code === "F1" ? "timeline" : "files");
    }
    return;
  }
  if (isTypingTarget(e.target) || e.target.closest?.("dialog")) return;

  // global chords
  if ((e.ctrlKey || e.metaKey) && e.key === "z") {
    e.preventDefault();
    if (e.shiftKey) store.undo.redo();
    else store.undo.undo();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "y") {
    e.preventDefault();
    store.undo.redo();
    return;
  }
  // Ctrl/Cmd+Enter — play from the cue under the cursor / stop (item 47.1).
  // Plain Enter (below) keeps playing from the cursor ROW.
  if ((e.ctrlKey || e.metaKey) && e.code === "Enter") {
    e.preventDefault();
    if (store.audio?.isPlaying()) store.audio.stop(0);
    else playFrom(playCursor().cue, 0);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "g") {
    e.preventDefault();
    openGoto();
    return;
  }
  // Ctrl/Cmd+F — the find bar (item 177). Only the two grids have somewhere to
  // go, so elsewhere the key is left to the browser's own find, which is the
  // right tool for a DOM view's text.
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    if (store.view === "timeline" || store.view === "pattern") {
      e.preventDefault();
      findBar.show();
      return;
    }
  }
  // Ctrl/Cmd+A — block-select the whole column (Timeline / Cues: the cursor's
  // single voice; Patterns: the active pane's pattern). Item 47.5.
  if ((e.ctrlKey || e.metaKey) && e.key === "a") {
    const v = selView();
    if (v?.selectColumn) {
      e.preventDefault();
      v.selectColumn();
      updateStatus();
      return;
    }
  }
  // Ctrl/Cmd+←/→ — grow that column block sideways, a whole voice at a time.
  // Only the two channel-column grids have a neighbouring column to reach: a
  // Taud pattern is one channel, so the Patterns view leaves the keys alone.
  if ((e.ctrlKey || e.metaKey) && (e.code === "ArrowLeft" || e.code === "ArrowRight")) {
    const v = selView();
    if (v?.extendColumn) {
      e.preventDefault();
      v.extendColumn(e.code === "ArrowLeft" ? -1 : 1);
      updateStatus();
      return;
    }
  }
  // Block clipboard (Timeline / Patterns): copy / cut / paste.
  if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "x" || e.key === "v")) {
    const v = selView();
    if (v) {
      e.preventDefault();
      if (e.key === "c") v.copySelection();
      else if (e.key === "x") v.cutSelection();
      else v.paste();
      updateStatus();
      return;
    }
  }
  // Escape clears a block selection; Delete/Backspace blanks a selected block.
  if (e.code === "Escape") {
    const v = selView();
    if (v?.hasSelection()) { v.clearSelection(); e.preventDefault(); return; }
  }
  if (e.code === "Delete" || e.code === "Backspace") {
    const v = selView();
    if (v?.hasSelection()) { e.preventDefault(); v.deleteSelection(); updateStatus(); return; }
  }
  if (e.key === "?" && store.view !== "files") {
    e.preventDefault();
    showHelp();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  switch (e.code) {
    // Enter — play from the cursor ROW / stop (item 47.1: the keyboard shortcut
    // deliberately plays from the cursor, not the cue; Ctrl+Enter plays the cue).
    // Shift+Enter — play from the start / stop. (Ctrl+Enter handled as a chord above.)
    case "Enter": {
      e.preventDefault();
      if (store.audio?.isPlaying()) store.audio.stop(0);
      else if (e.shiftKey) playFrom(0, 0);
      else { const p = playCursor(); playFrom(p.cue, p.row); }
      return;
    }
    /* double action: stop playing, or toggle record mode (not both) */
    case "Space": {
      if (store.audio?.isPlaying())
        store.audio.stop(0);
      else if (store.view === "cues" && viewNamed("cues").cursor.col <= 1) {
        // Space on a Cmd column opens the command popup, like Enter — the
        // record toggle is meaningless on the command words.
        e.preventDefault();
        viewNamed("cues").openCmdEditor();
      } else
        setRecord(!store.record);
      return;
    }
    case "BracketLeft": e.preventDefault(); handleBracket(-1, e.shiftKey); return;
    case "BracketRight": e.preventDefault(); handleBracket(1, e.shiftKey); return;
    // Fn goes to the nth TAB, which is the rule the strip has always followed —
    // so the Mastering tab (item 178) taking the sixth place moved Project to
    // F7 and pushed the File tab off the run entirely. It lands on F9 rather
    // than displacing the split binding below.
    case "F1": case "F2": case "F3": case "F4": case "F5": case "F6": case "F7": {
      e.preventDefault();
      showView(VIEWS[parseInt(e.code.slice(1), 10) - 1]);
      return;
    }
    // F8 — split the view area in two / close the pane the keyboard is in
    // (item 148). Shift+F8 walks the keyboard between the two panes.
    case "F8": {
      e.preventDefault();
      if (e.shiftKey) split.setFocus(1 - split.focus);
      else if (split.isSplit) split.close(split.focus);
      else split.split();
      return;
    }
    case "F9": {
      e.preventDefault();
      showView("files");
      return;
    }
  }

  if (store.view === "cues") {
    if (viewNamed("cues").processKey(e)) { e.preventDefault(); return; }
    return;
  }

  if (store.view === "pattern") {
    const pat = viewNamed("pattern");
    if (pat.processKey(e)) { e.preventDefault(); updateStatus(); return; }
    // jam-only fallback on the note column / when record is off
    if (!store.record || pat.cursor.sub === SUB_NOTE) {
      if (jam.down(e.code, e.repeat)) { e.preventDefault(); return; }
    }
    return;
  }

  if (store.view === "samples" || store.view === "instruments") {
    // Instrument/sample DOM views audition through the piano keys.
    if (jam.down(e.code, e.repeat)) { e.preventDefault(); return; }
    return;
  }
  // Cues / Mastering / Project / File never jam — piano keys are inert there
  // (item 24). (Cues returns above; the rest fall through to no-op.)
  if (store.view === "mastering" || store.view === "project" || store.view === "files") return;

  if (store.view === "timeline") {
    const timeline = viewNamed("timeline"); // the focused pane's copy
    switch (e.code) {
      case "ArrowUp": e.preventDefault();
        e.shiftKey ? timeline.extendSelection(-1, 0) : timeline.moveCursor(-store.editStep || -1, 0); return;
      case "ArrowDown": e.preventDefault();
        e.shiftKey ? timeline.extendSelection(1, 0) : timeline.moveCursor(store.editStep || 1, 0); return;
      case "ArrowLeft": e.preventDefault();
        e.shiftKey ? timeline.extendSelectionSub(-1) : timeline.moveSubCursor(-1); return;
      case "ArrowRight": e.preventDefault();
        e.shiftKey ? timeline.extendSelectionSub(1) : timeline.moveSubCursor(1); return;
      case "Tab":
        e.preventDefault();
        store.cursor.sub = SUB_NOTE;
        store.cursor.nib = 0;
        timeline.moveCursor(0, e.shiftKey ? -1 : 1);
        return;
      case "PageUp": e.preventDefault();
        e.shiftKey ? timeline.extendSelection(-16, 0) : timeline.moveCursor(-16, 0); return;
      case "PageDown": e.preventDefault();
        e.shiftKey ? timeline.extendSelection(16, 0) : timeline.moveCursor(16, 0); return;
      case "Home": e.preventDefault();
        e.shiftKey ? timeline.extendSelection(-1e9, 0) : timeline.moveCursor(-1e9, 0); return;
      case "End": e.preventDefault();
        e.shiftKey ? timeline.extendSelection(1e9, 0) : timeline.moveCursor(1e9, 0); return;
      case "Enter": { // pick up the cell's instrument as current
        e.preventDefault();
        const target = timeline.cursorCell();
        if (target && target.cell.instrment !== 0) {
          jam.currentInst = target.cell.instrment;
          updateStatus();
          store.emit("instsel");
        }
        return;
      }
      // Mute/solo on the cursor channel — navigate mode only, like taut
      // (in record mode M and N stay piano keys).
      case "KeyM":
        if (!store.record) { e.preventDefault(); store.toggleMute(store.cursor.ch); return; }
        break;
      case "KeyN":
        if (!store.record) { e.preventDefault(); store.toggleSolo(store.cursor.ch); return; }
        break;
    }
    if (store.record && timeline.processEditKey(e, jam)) {
      e.preventDefault();
      updateStatus();
      return;
    }
    // jam-only fallback: piano keys audition without recording
    if (!store.record || store.cursor.sub === SUB_NOTE) {
      if (jam.down(e.code, e.repeat)) { e.preventDefault(); return; }
    }
  }
});

window.addEventListener("keyup", (e) => {
  // Mirror the keydown guards (chords, focused inputs/dialogs) so a keyup
  // whose keydown never reached jam.down/hold can't hit jam.up's safety net —
  // that net clears the whole jam bank when nothing is held, which would cut
  // an audition the Instruments/Samples view started. Releasing the letter of
  // any Ctrl/Meta chord that doubles as a piano key (S = Save, A = Select All,
  // G = Goto, Y = Redo) must not count as a piano release.
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (isTypingTarget(e.target) || e.target.closest?.("dialog")) return;
  jam.up(e.code);
});
// Focus loss eats the keyup, which would leave the audition sounding for ever.
window.addEventListener("blur", () => jam.allUp());

async function openGoto() {
  if (!store.doc) return;
  const result = await showModal({
    title: t("goto.title"),
    fields: [
      { name: "cue", label: t("goto.cue"), value: "0" },
      { name: "row", label: t("goto.row"), value: "0" },
    ],
    okLabel: t("common.go"),
  });
  if (!result) return;
  const cue = parseInt(result.cue || "0", 16);
  const row = parseInt(result.row || "0", 16);
  const map = store.song.songMap();
  const entry = map.entries[Math.min(cue, map.entries.length - 1)];
  if (!entry) return;
  store.cursor.row = entry.startRow + Math.min(row, entry.rowLimit - 1);
  // "Take me there" means every pane looking at it, not just the focused one.
  eachView("timeline", (v) => v.centreRow(store.cursor.row));
  store.emit("cursor");
  if (store.view === "cues") {
    eachView("cues", (v) => { v.cursor.cue = entry.cue; v.invalidate(); });
  }
}

// ── autosave (debounced 45 s after the last edit) + recovery prompt ──
let autosaveTimer = null;
store.on("edit", () => {
  if (autosaveTimer !== null) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    autosaveTimer = null;
    if (!store.doc?.dirty) return;
    if (!(await opfs.available())) return;
    const name = store.fileName ?? "untitled.taud";
    try {
      await opfs.writeAutosave(name, store.doc.toBytes());
      console.info(`APP: autosaved ${name}`);
    } catch (err) {
      console.warn(`APP: autosave failed: ${err.message}`);
    }
  }, 45000);
});
store.on("saved", (name) => opfs.removeAutosave(name)); // clean save supersedes

(async function offerRecovery() {
  if (!(await opfs.available())) return;
  const autosaves = await opfs.listAutosaves();
  if (autosaves.length === 0) return;
  const newest = autosaves.sort((a, b) => b.mtime - a.mtime)[0];
  const result = await showModal({
    title: t("recover.title"),
    body: t("recover.body", { name: newest.name, when: new Date(newest.mtime).toLocaleString() }),
    fields: [],
    okLabel: t("recover.ok"),
  });
  if (result) {
    await loadBytes(newest.name, await opfs.readAutosave(newest.name));
    store.doc.dirty = true; // recovered content is unsaved by definition
    updateStatus();
  } else {
    for (const a of autosaves) await opfs.removeAutosave(a.name);
  }
})();

// ── #import= handoff (item 171) ──
// A sibling page — the IyagiMusic .ims player — sent a song over in the URL,
// with the instrument bank the format needs alongside it. The hash is spent
// before the import starts, so a reload does not repeat it, and the bytes go
// down exactly the drag-and-drop path from there.
if (handoffArmed()) {
  try {
    const handed = decodeHandoff(location.hash);
    history.replaceState(null, "", location.pathname + location.search);
    $("stFile").textContent = t("handoff.receiving", { name: handed.name });
    loadBytes(handed.name, handed.bytes, { bank: handed.bank });
  } catch (err) {
    history.replaceState(null, "", location.pathname + location.search);
    $("stFile").textContent = t("handoff.bad", { err: err.message });
    console.error("APP: handoff failed", err);
  }
}

// ── ?load= bootstrap (demo links; also drives the headless smoke test) ──
const bootParams = new URLSearchParams(location.search);
if (bootParams.has("load")) {
  const url = bootParams.get("load");
  fetch(url).then(async (resp) => {
    await loadBytes(url.split("/").pop(), new Uint8Array(await resp.arrayBuffer()));
    console.info(`APP: loaded ${url} songs=${store.doc?.songs.length}`);
    if (bootParams.has("view")) showView(bootParams.get("view"));
    if (bootParams.has("autoplay")) {
      await playFrom(0, 0);
      setTimeout(() => {
        console.info(`APP: autoplay check playing=${store.audio?.isPlaying()} cue=${store.audio?.getCuePosition()} row=${store.audio?.getTrackerRow()}`);
      }, 2500);
    }
  }).catch((err) => console.error(`APP: load failed ${err.message}`));
}

// Expose internals for the headless editing smoke test (harmless in prod).
// The view handles are GETTERS: with the screen split there can be two copies
// of a view, and the one that matters is the one the keyboard is on (item
// 148.1). Unsplit — which is how the smoke tests run — they answer exactly the
// single instance they always did.
window.__microtone = {
  store, jam, instLookup, masterStrip, split, loadBytes, playCursor, paneViews, findBar,
  __VIEWS: VIEWS,
  get timeline() { return viewNamed("timeline"); },
  get cuesView() { return viewNamed("cues"); },
  get patternView() { return viewNamed("pattern"); },
  get samplesView() { return viewNamed("samples"); },
  get instrumentsView() { return viewNamed("instruments"); },
  get masteringView() { return viewNamed("mastering"); },
  get projectView() { return viewNamed("project"); },
  get filesView() { return viewNamed("files"); },
  get welcomeView() { return paneViews[split.focus].get("timeline")?.welcome ?? paneViews[0].get("timeline").welcome; },
};

// Paint the initial view (item 104): with nothing loaded that is the welcome
// screen, and it also puts the no-document tabs into their disabled state. A
// ?load= / recovery boot calls showView again once the document is in.
showView(store.view);

// ── frame loop ──
function frame() {
  const audio = store.audio;
  if (audio && store.doc) {
    // Cue/row shown in hex (matches the grid gutters + note-fx B/C hex args).
    $("posCue").textContent = "$" + audio.getCuePosition().toString(16).toUpperCase();
    $("posRow").textContent = "$" + audio.getTrackerRow().toString(16).toUpperCase().padStart(2, "0");
    $("posBpm").textContent = audio.getBPM() || "–";
    $("posSpd").textContent = audio.getTickRate() || "–";
  }
  // Every view a pane is showing gets a frame, not just the focused one — and
  // two panes on the same view are two copies, each with its own scroll.
  for (let i = 0; i < paneViews.length; i++) {
    const name = split.paneView(i);
    if (name) paneViews[i].get(name)?.obj.frame?.();
  }
  if (store.viewOpen("timeline")) masterStrip.frame();
  instLookup.frame(); // play-indicator lamps (item 169); no-ops while hidden
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Every number field and dropdown in the app becomes a step-button group
// (item 156). Started here rather than called per view: the panes, the
// popups and the modals all build their own controls, and a watcher is the
// only way none of them can be forgotten.
startControlEnhancer();

window.__splash?.done(); // app shell ready — fade out the boot splash (item 67)

// Booted straight into the Analogue Warmth Edition (April 1st, a published
// run, or ?theme=warmth) — all three land before the onThemeChange listener
// above is registered, so the pitch goes out from here, after the shell is up
// and nothing else is about to open over it.
if (currentTheme() === WARMTH) showWarmthSplash();
