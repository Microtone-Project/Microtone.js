// Microtone Touch — the page.
//
// The sketch (sketch.js) is the canonical document, kept in local storage
// after every edit. The engine plays a COPY, exactly as the tracker's does: a
// cell edit re-uploads that one lane's pattern, a structural change (sections,
// the loop, the transport's scope) reloads the copy, and the playhead and the
// sounding notes come back in the engine's ~16 ms snapshots.
//
// Writing is the tracker's model, cut down: Record off, the keyboard only
// plays. Record on and stopped, a key writes at the cursor and the cursor
// steps down. Record on and playing, a key writes where the playhead is — and
// lifting it writes the key-off — so a phrase can be played in over the loop.
//
// The sketch in hand is a working copy: where it is KEPT — on this phone or
// online — is its home (saving.js), and Save writes it back there. Opening
// another sketch, or starting a new one, starts a new undo history.

import { AudioSystem } from "../core/audio/audio-system.js";
import { pitchTablePresets, nearestDegreeIndex, noteForDegree } from "../core/tuning/pitchtables.js";
import { buildBank, PRESETS, DRUMS, presetById } from "../core/sketch/pack.js";
import { LAYOUTS, fitLayout } from "./lattice.js";
import {
  newSketch, normaliseSketch, toTaudDoc, patternBytes, patternSlot, emptySection, sketchDigest, isBlank,
  LANES, ROWS, MAX_SECTIONS, NOTE_OFF, TUNINGS, FX, FX_IDS, tuningById,
} from "./sketch.js";
import { Keyboard, originPeriod } from "./keyboard.js";
import { Grid } from "./grid.js";
import { noteLabel } from "./notes.js";
import { save, openSaveAs, keepOrDiscard } from "./saving.js";
import { FilesPanel, openLoad } from "./files.js";
import { fitBrand, initMenu } from "./topbar.js";
import { initSplit } from "./split.js";
import { THEMES, themeChoice, setTheme, initTheme } from "./theme.js";
import { openAbout } from "./about.js";

const $ = (id) => document.getElementById(id);
const STORE_KEY = "microtone-touch:sketch";
const FILE_KEY = "microtone-touch:file";
const PREFS_KEY = "microtone-touch:prefs";
const STEPS = [1, 2, 4, 0];
const SECTION_NAMES = "ABCDEFGHIJKLMNOP";
const UNDO_DEPTH = 100;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ── state ────────────────────────────────────────────────────────────────────

const bank = buildBank();
const stored = load(STORE_KEY, (raw) => raw, () => null);
let sketch = stored ? normaliseSketch(stored) : newSketch();
const prefs = load(PREFS_KEY, (p) => ({
  layout: LAYOUTS.some((l) => l.id === p?.layout) ? p.layout : "wicki",
  size: Number.isFinite(p?.size) ? Math.min(48, Math.max(20, p.size)) : 30,
  octaves: p?.octaves && typeof p.octaves === "object" ? p.octaves : {},
  split: p?.split, // split.js checks these three itself
  share: p?.share,
  hand: p?.hand,
}), () => ({ layout: "wicki", size: 30, octaves: {} }));

const ui = { section: 0, lane: 0, row: 0, step: 1, record: false, loopSection: true };

/**
 * Where the sketch in hand is kept — null (nowhere yet), { where: "local",
 * id } or { where: "online", id, etag } — and its digest as it was last
 * saved or opened: anything else is unsaved. Neither is part of the sketch,
 * so undo never moves them. A sketch from before Save had only `sent`, the
 * online project it was last sent as.
 */
let { home, savedDigest } = load(FILE_KEY, (f) => ({
  home: validHome(f?.home),
  savedDigest: typeof f?.saved === "string" ? f.saved : "",
}), () => ({
  home: stored?.sent?.id ? validHome({ where: "online", ...stored.sent }) : null,
  savedDigest: isBlank(sketch) ? sketchDigest(sketch) : "",
}));

function validHome(h) {
  if (!h || typeof h.id !== "string") return null;
  if (h.where === "local") return { where: "local", id: h.id };
  if (h.where === "online") return { where: "online", id: h.id, etag: typeof h.etag === "string" ? h.etag : null };
  return null;
}
let audio = null;
let playing = false;
let audioDocKey = null;
const undoStack = [];
const redoStack = [];
let take = null; // the undo snapshot a live take began from

function load(key, normalise, fresh) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? normalise(JSON.parse(raw)) : fresh();
  } catch {
    return fresh();
  }
}

let saveTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}
function saveNow() {
  clearTimeout(saveTimer);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(sketch)); } catch { /* full or private */ }
}
/** The working copy and its home go together: a home saved beside a stale
 *  copy would have Save put the wrong sketch there. */
function saveFileState() {
  saveNow();
  try { localStorage.setItem(FILE_KEY, JSON.stringify({ home, saved: savedDigest })); } catch { /* ignore */ }
}
const unsaved = () => sketchDigest(sketch) !== savedDigest;
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
}

const tuning = () => pitchTablePresets[tuningById(sketch.tuning).notation];
const lanePreset = (l = ui.lane) => presetById(sketch.lanes[l].preset);
const octaveFor = (preset) => prefs.octaves[preset.id] ?? preset.octave;

// ── views ────────────────────────────────────────────────────────────────────

const grid = new Grid($("grid"), $("gridWrap"), {
  cell: (lane, row) => {
    selectLane(lane);
    ui.row = row;
    grid.setCursor(ui.lane, ui.row);
    const c = cells(ui.section, lane)[row];
    if (c && c.n !== NOTE_OFF && !playing) audition(lane, c);
  },
  lane: (lane) => (lane === ui.lane ? openLaneSheet(lane) : selectLane(lane)),
});

const fingers = new Map(); // pointer id → { voice, lane, inst, note, drum, row, section, wrote }
let nextVoice = 0;

const keyboard = new Keyboard($("keys"), {
  down: (id, key) => fingerDown(id, key),
  slide: (id, key) => fingerSlide(id, key),
  up: (id) => fingerUp(id),
});

function configureKeyboard() {
  const p = lanePreset();
  const t = tuning();
  const layout = fitLayout(prefs.layout, t.table.length, t.interval);
  keyboard.configure({
    preset: t, layout, octave: octaveFor(p), size: prefs.size, drums: !!p.kit,
  });
  // The origin key's own name: C3 on an octave tuning, 黃3 in Shi'er lü.
  const origin = noteForDegree(4 + originPeriod(t, octaveFor(p)), 0, t);
  showText($("octVal"), p.kit ? "Kit" : noteLabel(origin, t));
  $("octDown").disabled = $("octUp").disabled = !!p.kit;
  $("layoutSel").disabled = !!p.kit;
  setValue($("layoutSel"), layout);
  const tag = $("laneTag");
  showText(tag, p.name);
  tag.title = `Lane ${ui.lane + 1}`;
  tag.style.setProperty("--lane-colour", `var(--lane-${ui.lane})`);
}

function renderAll() {
  grid.render(sketch, ui.section, tuning(), ui.lane);
  grid.setCursor(ui.lane, ui.row);
  renderSections();
  showText($("stepVal"), String(ui.step));
  $("undoBtn").disabled = undoStack.length === 0;
  $("redoBtn").disabled = redoStack.length === 0;
  showText($("loopBtn"), ui.loopSection ? "Section" : "Song");
  $("loopBtn").setAttribute("aria-pressed", String(ui.loopSection));
}

function renderSections() {
  const nav = $("sections");
  const want = sketch.sections.length;
  const buttons = [...nav.querySelectorAll(".sec.s")];
  if (buttons.length !== want) {
    nav.replaceChildren();
    for (let i = 0; i < want; i++) {
      const b = document.createElement("button");
      b.className = "sec s";
      b.textContent = SECTION_NAMES[i];
      b.addEventListener("click", () => (i === ui.section ? openSectionSheet() : selectSection(i)));
      nav.append(b);
    }
    const add = document.createElement("button");
    add.className = "sec add";
    add.textContent = "+";
    add.title = "Add a section (a copy of this one)";
    add.disabled = want >= MAX_SECTIONS;
    add.addEventListener("click", () => addSection());
    nav.append(add);
  }
  nav.querySelectorAll(".sec.s").forEach((b, i) => {
    const cur = String(i === ui.section);
    if (b.getAttribute("aria-current") !== cur) b.setAttribute("aria-current", cur);
  });
}

/** Write text only when it differs: the same string still re-lays-out. */
function showText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}
function setValue(el, v) {
  if (el.value !== v) el.value = v;
}

let toastTimer = 0;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ── editing ──────────────────────────────────────────────────────────────────

const cells = (section, lane) => sketch.sections[section].cells[lane];

/**
 * Change the sketch. `fn` mutates it; `touched` names what to resend:
 * `{ patterns: [[section, lane]…] }`, `{ lanes: [lane…] }` or
 * `{ structure: true }`. Inside a live take the whole take is one undo step.
 */
function edit(fn, touched = {}) {
  const before = JSON.stringify(sketch);
  fn();
  if (JSON.stringify(sketch) === before) return;
  if (take === null || !take.open) {
    undoStack.push(before);
    if (undoStack.length > UNDO_DEPTH) undoStack.shift();
    if (take) take.open = true;
  }
  redoStack.length = 0;
  afterChange(touched);
}

function afterChange(touched) {
  saveSoon();
  if (audio) {
    if (touched.structure) syncAudio();
    for (const [s, l] of touched.patterns ?? []) uploadPattern(s, l);
    for (const l of touched.lanes ?? []) {
      for (let s = 0; s < sketch.sections.length; s++) uploadPattern(s, l);
    }
  }
  renderAll();
}

function restore(json) {
  sketch = normaliseSketch(JSON.parse(json));
  ui.section = Math.min(ui.section, sketch.sections.length - 1);
  if (audio) {
    syncAudio();
    for (let s = 0; s < sketch.sections.length; s++) for (let l = 0; l < LANES; l++) uploadPattern(s, l);
    sketch.lanes.forEach((lane, l) => audio.setVoiceMute(0, l, lane.mute));
  }
  saveSoon();
  configureKeyboard();
  renderAll();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(JSON.stringify(sketch));
  restore(undoStack.pop());
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(sketch));
  restore(redoStack.pop());
}

function advance() {
  if (ui.step > 0) ui.row = (ui.row + ui.step) % ROWS;
  grid.setCursor(ui.lane, ui.row);
}

function writeCell(section, lane, row, cell) {
  edit(() => { cells(section, lane)[row] = cell; }, { patterns: [[section, lane]] });
}

function selectLane(lane) {
  if (lane === ui.lane) return;
  keyboard.releaseAll();
  ui.lane = lane;
  configureKeyboard();
  grid.render(sketch, ui.section, tuning(), ui.lane);
  grid.setCursor(ui.lane, ui.row);
}

function selectSection(i) {
  if (i === ui.section) return;
  ui.section = i;
  if (audio && ui.loopSection) syncAudio();
  // Playing the whole song, the view follows the playhead — so choosing a
  // section there means "play from here".
  else if (audio && playing) audio.setCuePosition(0, i);
  renderAll();
}

function addSection() {
  if (sketch.sections.length >= MAX_SECTIONS) return;
  const at = ui.section + 1;
  edit(() => { sketch.sections.splice(at, 0, structuredClone(sketch.sections[ui.section])); }, { structure: true });
  selectSection(at);
}

/** Retune every melodic note to the nearest degree of the new tuning: the
 *  melody keeps its note words as nearly as the new grid allows. (Between
 *  A-ak and Hyang-ak nothing moves at all: same degrees, another reference.) */
function setTuning(id) {
  const to = pitchTablePresets[tuningById(id).notation];
  edit(() => {
    sketch.tuning = id;
    for (const sec of sketch.sections) {
      sec.cells.forEach((lane, l) => {
        if (presetById(sketch.lanes[l].preset).kit) return;
        for (const c of lane) {
          if (!c || c.n === NOTE_OFF || c.d !== undefined) continue;
          const { index, period } = nearestDegreeIndex(c.n, to);
          c.n = noteForDegree(4 + period, index, to);
        }
      });
    }
  }, { structure: true, lanes: [...Array(LANES).keys()] });
  configureKeyboard();
  warnUnfit();
}

/** Say so when the chosen layout cannot work on this tuning and the board has
 *  fallen back to the degree run. */
function warnUnfit() {
  const t = tuning();
  if (fitLayout(prefs.layout, t.table.length, t.interval) !== prefs.layout) {
    toast(`${layoutName(prefs.layout)} does not work on ${tuningById(sketch.tuning).name}; the keyboard plays a degree run instead.`);
  }
}

const layoutName = (id) => LAYOUTS.find((l) => l.id === id)?.name ?? id;

// ── audio ────────────────────────────────────────────────────────────────────

/** The tap on the veil. The sound starts inside it (a browser starts audio
 *  only from a gesture), and the veil stays up, its keys lit, until the
 *  engine runs — on a slow connection, until the worklet has arrived — so no
 *  key is played into an engine that is not there yet. */
async function startAudio() {
  const veil = $("startVeil");
  veil.dataset.state = "starting";
  $("startBtn").disabled = true;
  showText($("startHint"), "Starting the sound…");
  try {
    const system = new AudioSystem();
    await system.init();
    await system.resume();
    audio = system;
    audioDocKey = null;
    syncAudio();
  } catch (e) {
    audio = null;
    toast(`No sound: ${e.message}`);
  }
  veil.hidden = true;
}

/** The transport's copy: reloaded only when its shape changed. */
function syncAudio() {
  const key = `${ui.loopSection ? ui.section : "song"}|${sketch.sections.length}|${sketch.loop}|${sketch.tuning}`;
  if (key === audioDocKey) return;
  const row = playing ? audio.getTrackerRow() : 0;
  const cue = playing && !ui.loopSection ? audio.getCuePosition() : 0;
  audio.loadDocument(toTaudDoc(sketch, bank, { only: ui.loopSection ? ui.section : null }));
  audioDocKey = key;
  sketch.lanes.forEach((lane, l) => audio.setVoiceMute(0, l, lane.mute));
  if (playing) { // loadDocument stopped it: carry on from where it was
    audio.setCuePosition(0, ui.loopSection ? 0 : Math.min(cue, sketch.sections.length - 1));
    audio.setTrackerRow(0, row);
    audio.play(0);
  }
}

function uploadPattern(section, lane) {
  audio.uploadPattern(patternSlot(section, lane), patternBytes(sketch, section, lane, bank));
}

function instFor(lane, key) {
  const slot = bank.slots[sketch.lanes[lane].preset];
  return Array.isArray(slot) ? slot[key.drum ?? 0] : slot;
}

function allocVoice() {
  const busy = new Set([...fingers.values()].map((f) => f.voice));
  for (let i = 0; i < 16; i++) {
    const v = (nextVoice + i) % 16;
    if (!busy.has(v)) { nextVoice = v + 1; return audio.jamVoice(v); }
  }
  return audio.jamVoice(nextVoice++);
}

function audition(lane, cell) {
  if (!audio) return;
  const voice = allocVoice();
  audio.jamNote(0, voice, cell.n, instFor(lane, { drum: cell.d }));
  setTimeout(() => audio.jamKeyOff(0, voice), 350);
}

/** Put the engine's playhead on row 0 of the section in view — where Stop
 *  leaves it and where Play starts. A cue position on its own keeps the row
 *  it was on; setTrackerRow is the engine's pre-play reset. */
function rewind() {
  audio.setCuePosition(0, ui.loopSection ? 0 : ui.section);
  audio.setTrackerRow(0, 0);
  grid.setPlayRow(0);
}

function togglePlay() {
  if (!audio) return;
  if (playing) {
    audio.stop(0);
    playing = false;
    take = null;
    rewind();
    $("playBtn").setAttribute("aria-pressed", "false");
    $("playBtn").firstElementChild.className = "ico ico-play";
    keyboard.lit.clear();
    litKey = "";
    keyboard.paint();
    return;
  }
  syncAudio();
  rewind();
  audio.play(0);
  playing = true;
  heardPlaying = false;
  if (ui.record) take = { open: false };
  $("playBtn").setAttribute("aria-pressed", "true");
  $("playBtn").firstElementChild.className = "ico ico-stop";
  requestAnimationFrame(frame);
}

let litKey = "";
let heardPlaying = false; // the engine's snapshot has said "playing" since Play
function frame() {
  if (!playing) return;
  // A HALT at the end of a non-looping song stops the engine by itself. The
  // first snapshots after Play can predate it, so only a "stopped" that
  // follows a "playing" counts.
  if (audio.isPlaying()) heardPlaying = true;
  else if (heardPlaying) { togglePlay(); return; }
  const cue = audio.getCuePosition();
  const playSection = ui.loopSection ? ui.section : cue;
  if (playSection !== ui.section && playSection < sketch.sections.length) {
    ui.section = playSection; // a song plays through: the view follows it
    renderAll();
  }
  grid.setPlayRow(playSection === ui.section ? audio.getTrackerRow() : -1);
  // Keys the song is sounding right now, drawn as ghosts on the board.
  const notes = [];
  for (let l = 0; l < LANES; l++) {
    if (l === ui.lane || !audio.getVoiceActive(l)) continue;
    notes.push(audio.getVoiceNote(l));
  }
  const key = notes.join(",");
  if (key !== litKey) {
    litKey = key;
    keyboard.lit = new Set(notes);
    keyboard.paint();
  }
  requestAnimationFrame(frame);
}

// ── fingers ──────────────────────────────────────────────────────────────────

/** The lane a new finger writes to: the selected lane for the first finger,
 *  then the next lanes holding the SAME preset, so a chord spreads across
 *  them. A finger with nowhere to go still sounds, but writes nothing. */
function laneForFinger() {
  const taken = new Set([...fingers.values()].map((f) => f.lane));
  if (!taken.has(ui.lane)) return ui.lane;
  const want = sketch.lanes[ui.lane].preset;
  for (let k = 1; k < LANES; k++) {
    const l = (ui.lane + k) % LANES;
    if (!taken.has(l) && sketch.lanes[l].preset === want) return l;
  }
  return -1;
}

function fingerDown(id, key) {
  if (!audio) return;
  const lane = laneForFinger();
  const playLane = lane >= 0 ? lane : ui.lane;
  const f = {
    voice: allocVoice(), lane, inst: instFor(playLane, key), note: key.note, drum: key.drum,
    row: -1, section: ui.section,
  };
  fingers.set(id, f);
  audio.jamNote(0, f.voice, key.note, f.inst);
  if (ui.record && lane >= 0) writeFinger(f);
}

function fingerSlide(id, key) {
  const f = fingers.get(id);
  if (!f) return;
  f.note = key.note;
  f.drum = key.drum;
  f.inst = instFor(f.lane >= 0 ? f.lane : ui.lane, key);
  audio.jamNote(0, f.voice, key.note, f.inst);
  if (!ui.record || f.lane < 0 || f.row < 0) return; // f.row < 0: Record came on mid-hold
  if (playing) writeFinger(f);
  else writeCell(f.section, f.lane, f.row, noteCell(f)); // step entry: the note follows the finger
}

function fingerUp(id) {
  const f = fingers.get(id);
  if (!f) return;
  fingers.delete(id);
  audio.jamKeyOff(0, f.voice);
  if (!ui.record || f.lane < 0 || f.row < 0) return;
  if (playing) {
    // A held note gets its key-off where the finger lifted; a drum hit, or a
    // note let go on the row it started, just rings as the preset rings.
    const now = audio.getTrackerRow();
    const lane = cells(f.section, f.lane);
    if (f.drum === undefined && now !== f.row && lane[now] === null) {
      writeCell(f.section, f.lane, now, { n: NOTE_OFF });
    }
  } else if (fingers.size === 0) {
    advance();
  }
}

const noteCell = (f) => (f.drum !== undefined ? { n: f.note, d: f.drum } : { n: f.note });

function writeFinger(f) {
  if (playing) {
    if (!take) take = { open: false };
    f.section = ui.loopSection ? ui.section : Math.min(audio.getCuePosition(), sketch.sections.length - 1);
    f.row = audio.getTrackerRow();
  } else {
    f.section = ui.section;
    f.row = ui.row;
  }
  writeCell(f.section, f.lane, f.row, noteCell(f));
}

// ── sheets ───────────────────────────────────────────────────────────────────

const sheet = $("sheet");
const sheetBody = $("sheetBody");

function showSheet(html, bind) {
  sheetBody.innerHTML = html;
  bind?.(sheetBody);
  if (!sheet.open) sheet.showModal();
}
const closeSheet = () => sheet.close();

function openLaneSheet(lane) {
  const cur = sketch.lanes[lane];
  showSheet(`
    <h2>Lane ${lane + 1}</h2>
    <div class="chips">${PRESETS.map((p) => `
      <button type="button" class="tbtn" data-preset="${p.id}" aria-pressed="${p.id === cur.preset}">${esc(p.name)}</button>`).join("")}
    </div>
    <div class="row">
      <button type="button" class="tbtn" data-act="mute" aria-pressed="${cur.mute}">${cur.mute ? "Unmute" : "Mute"}</button>
      <button type="button" class="tbtn" data-act="clear">Clear this lane in ${SECTION_NAMES[ui.section]}</button>
      <button class="tbtn" value="close">Done</button>
    </div>`, (body) => {
    body.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => {
      const id = b.dataset.preset;
      const toKit = presetById(id).kit, fromKit = presetById(cur.preset).kit;
      edit(() => {
        sketch.lanes[lane].preset = id;
        // Notes and drum hits do not translate into each other: a lane that
        // changes between the two starts empty rather than playing nonsense.
        if (toKit !== fromKit) for (const sec of sketch.sections) sec.cells[lane].fill(null);
      }, { lanes: [lane] });
      keyboard.releaseAll();
      configureKeyboard();
      closeSheet();
    }));
    body.querySelector('[data-act="mute"]').addEventListener("click", () => {
      edit(() => { sketch.lanes[lane].mute = !sketch.lanes[lane].mute; });
      audio?.setVoiceMute(0, lane, sketch.lanes[lane].mute);
      closeSheet();
    });
    body.querySelector('[data-act="clear"]').addEventListener("click", () => {
      edit(() => cells(ui.section, lane).fill(null), { patterns: [[ui.section, lane]] });
      closeSheet();
    });
  });
}

function openSectionSheet() {
  const n = sketch.sections.length;
  const name = SECTION_NAMES[ui.section];
  showSheet(`
    <h2>Section ${name}</h2>
    <div class="row">
      <button type="button" class="tbtn" data-act="left" ${ui.section === 0 ? "disabled" : ""}>Move earlier</button>
      <button type="button" class="tbtn" data-act="right" ${ui.section === n - 1 ? "disabled" : ""}>Move later</button>
      <button type="button" class="tbtn" data-act="clear">Clear</button>
      <button type="button" class="tbtn" data-act="delete" ${n === 1 ? "disabled" : ""}>Delete</button>
      <button class="tbtn" value="close">Done</button>
    </div>`, (body) => {
    const act = (a, fn) => body.querySelector(`[data-act="${a}"]`).addEventListener("click", () => { fn(); closeSheet(); });
    const move = (d) => {
      const i = ui.section;
      edit(() => {
        const [s] = sketch.sections.splice(i, 1);
        sketch.sections.splice(i + d, 0, s);
      }, { structure: true, lanes: [...Array(LANES).keys()] });
      ui.section = i + d;
      if (audio) { audioDocKey = null; syncAudio(); }
      renderAll();
    };
    act("left", () => move(-1));
    act("right", () => move(1));
    act("clear", () => edit(() => { sketch.sections[ui.section] = emptySection(); },
      { lanes: [...Array(LANES).keys()] }));
    act("delete", () => {
      const i = ui.section;
      edit(() => { sketch.sections.splice(i, 1); }, { structure: true, lanes: [...Array(LANES).keys()] });
      ui.section = Math.min(i, sketch.sections.length - 1);
      if (audio) { audioDocKey = null; syncAudio(); }
      renderAll();
    });
  });
}

function openFxSheet() {
  const c = cells(ui.section, ui.lane)[ui.row];
  if (!c || c.n === NOTE_OFF) { toast("Put the cursor on a note first."); return; }
  const levels = ["light", "medium", "strong"];
  showSheet(`
    <h2>Effect on ${esc(c.d !== undefined ? DRUMS[c.d].name : noteLabel(c.n, tuning()))}</h2>
    <p>It lasts until the lane's next note or key-off.</p>
    <div class="fx-grid">${FX_IDS.map((id) => `
      <span>${FX[id].name}</span>${levels.map((lv, i) => `
      <button type="button" class="tbtn" data-fx="${id}" data-lv="${i}" aria-pressed="${c.fx === id && (c.lv ?? 1) === i}">${lv}</button>`).join("")}`).join("")}
    </div>
    <div class="row">
      <button type="button" class="tbtn" data-fx="" ${c.fx ? "" : "disabled"}>No effect</button>
      <button class="tbtn" value="close">Done</button>
    </div>`, (body) => {
    body.querySelectorAll("[data-fx]").forEach((b) => b.addEventListener("click", () => {
      const fx = b.dataset.fx;
      edit(() => {
        const cell = cells(ui.section, ui.lane)[ui.row];
        if (fx) { cell.fx = fx; cell.lv = Number(b.dataset.lv); } else { delete cell.fx; delete cell.lv; }
      }, { patterns: [[ui.section, ui.lane]] });
      closeSheet();
    }));
  });
}

/** BPM… — and, since it is about how the song runs, what happens when it
 *  ends. */
function openTempoSheet() {
  showSheet(`
    <h2>Tempo</h2>
    <div class="row" style="align-items:center">
      <button type="button" class="tbtn" data-d="-5">−5</button>
      <button type="button" class="tbtn" data-d="-1">−1</button>
      <b data-bpm style="min-width:4em;text-align:center;font-size:20px">${sketch.bpm}</b>
      <button type="button" class="tbtn" data-d="1">+1</button>
      <button type="button" class="tbtn" data-d="5">+5</button>
    </div>
    <input type="range" min="40" max="240" value="${sketch.bpm}" data-range>
    <label class="check"><input type="checkbox" name="loop" ${sketch.loop ? "checked" : ""}> At the end of the song, loop back to A</label>
    <div class="row"><button class="tbtn" value="close">Done</button></div>`, (body) => {
    const set = (v) => {
      const bpm = Math.min(240, Math.max(40, Math.round(v)));
      edit(() => { sketch.bpm = bpm; });
      audio?.setBPM(0, bpm);
      showText(body.querySelector("[data-bpm]"), String(bpm));
      setValue(body.querySelector("[data-range]"), String(bpm));
    };
    body.querySelectorAll("[data-d]").forEach((b) => b.addEventListener("click", () => set(sketch.bpm + Number(b.dataset.d))));
    body.querySelector("[data-range]").addEventListener("input", (e) => set(Number(e.target.value)));
    body.querySelector('[name="loop"]').addEventListener("change", (e) => {
      edit(() => { sketch.loop = e.target.checked; }, { structure: true });
    });
  });
}

function openTuningSheet() {
  showSheet(`
    <h2>Temperament</h2>
    <div class="chips">${TUNINGS.map((t) => `
      <button type="button" class="tbtn" data-tuning="${t.id}" aria-pressed="${t.id === sketch.tuning}">${esc(t.name)}</button>`).join("")}
    </div>
    <p>Notes already written move to the nearest step of the new tuning.</p>
    <div class="row"><button class="tbtn" value="close">Done</button></div>`, (body) => {
    body.querySelectorAll("[data-tuning]").forEach((b) => b.addEventListener("click", () => {
      closeSheet();
      if (b.dataset.tuning !== sketch.tuning) setTuning(b.dataset.tuning);
    }));
  });
}

/** Theme… — applied as it is tapped, so the choice can be seen before Done. */
function openThemeSheet() {
  showSheet(`
    <h2>Theme</h2>
    <div class="chips">${THEMES.map((t) => `
      <button type="button" class="tbtn" data-theme-id="${t.id}" aria-pressed="${t.id === themeChoice()}">${t.name}</button>`).join("")}
    </div>
    <p>System follows the phone's own dark or light setting.</p>
    <div class="row"><button class="tbtn" value="close">Done</button></div>`, (body) => {
    const chips = [...body.querySelectorAll("[data-theme-id]")];
    for (const b of chips) {
      b.addEventListener("click", () => {
        setTheme(b.dataset.themeId);
        for (const o of chips) o.setAttribute("aria-pressed", String(o === b));
      });
    }
  });
}

// ── keeping sketches ─────────────────────────────────────────────────────────

/** Put another sketch in hand — opened from `where`, or new (null) — with a
 *  fresh undo history: undoing into the last one would have Save write it
 *  over this one's home. */
function replaceSketch(next, where) {
  if (playing) togglePlay();
  keyboard.releaseAll();
  sketch = next;
  undoStack.length = 0;
  redoStack.length = 0;
  take = null;
  ui.section = 0;
  ui.row = 0;
  if (audio) { audioDocKey = null; syncAudio(); }
  home = where;
  savedDigest = sketchDigest(sketch);
  saveFileState();
  configureKeyboard();
  renderAll();
  grid.setPlayRow(0);
  if (sheet.open) closeSheet();
  files.close();
}

/** What saving.js and files.js see of the page. */
const docs = {
  sheet, body: sheetBody, bank, toast, unsaved,
  sketch: () => sketch,
  home: () => home,
  snapshot(name = sketch.name) {
    const copy = { ...structuredClone(sketch), name };
    return { sketch: copy, digest: sketchDigest(copy) };
  },
  saved(where, snap) {
    if (sketch.name !== snap.sketch.name) edit(() => { sketch.name = snap.sketch.name; });
    home = where;
    savedDigest = snap.digest; // a change made while it was saving stays unsaved
    saveFileState();
  },
  renamed(name, where) {
    const clean = !unsaved();
    if (sketch.name !== name) edit(() => { sketch.name = name; });
    home = where;
    if (clean) savedDigest = sketchDigest(sketch);
    saveFileState();
  },
  homeGone() {
    home = null;
    savedDigest = "";
    saveFileState();
  },
  open: replaceSketch,
  newSketch: () => keepOrDiscard(docs, () => {
    replaceSketch(Object.assign(newSketch(), { bpm: sketch.bpm, tuning: sketch.tuning }), null);
  }),
  covered(on) {
    $("app").inert = on;
    if (on) keyboard.releaseAll();
  },
};

const files = new FilesPanel($("files"), docs);

/** The menu's first line: the sketch, where it is kept, and whether all of
 *  it is. */
function menuCaption() {
  const where = !home ? "not saved yet" : home.where === "local" ? "on this phone" : "online";
  return `${sketch.name} — ${where}${home && unsaved() ? ", unsaved changes" : ""}`;
}

// ── wiring ───────────────────────────────────────────────────────────────────

for (const l of LAYOUTS) {
  const o = document.createElement("option");
  o.value = l.id;
  o.textContent = l.short;
  o.title = l.name;
  $("layoutSel").append(o);
}

$("startBtn").addEventListener("click", startAudio);
$("playBtn").addEventListener("click", togglePlay);
$("recBtn").addEventListener("click", () => {
  ui.record = !ui.record;
  $("recBtn").setAttribute("aria-pressed", String(ui.record));
  take = ui.record && playing ? { open: false } : null;
});
$("loopBtn").addEventListener("click", () => {
  ui.loopSection = !ui.loopSection;
  if (audio) syncAudio();
  renderAll();
});
initMenu($("menu"), $("menuBtn"), {
  before() {
    showText($("menuCap"), menuCaption());
    showText($("menuBpm"), String(sketch.bpm));
    showText($("menuTuning"), tuningById(sketch.tuning).name);
    showText($("menuTheme"), THEMES.find((t) => t.id === themeChoice()).name);
    // About… lives on the wordmark; the menu offers it only while the bar
    // has no room for the wordmark to be tapped.
    $("menuAbout").hidden = $("brand").dataset.fit !== "none";
  },
  items: {
    bpm: openTempoSheet,
    tuning: openTuningSheet,
    save: () => save(docs),
    saveAs: () => openSaveAs(docs),
    load: () => openLoad(docs),
    files: () => files.open(),
    theme: openThemeSheet,
    about: () => openAbout(showSheet),
  },
});
fitBrand($("transport"), $("brand"), $("topSpacer"));
$("brand").addEventListener("click", () => openAbout(showSheet));
$("brand").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  openAbout(showSheet);
});
$("offBtn").addEventListener("click", () => { writeCell(ui.section, ui.lane, ui.row, { n: NOTE_OFF }); advance(); });
$("clearBtn").addEventListener("click", () => { writeCell(ui.section, ui.lane, ui.row, null); advance(); });
$("stepBtn").addEventListener("click", () => {
  ui.step = STEPS[(STEPS.indexOf(ui.step) + 1) % STEPS.length];
  renderAll();
});
$("fxBtn").addEventListener("click", openFxSheet);
$("undoBtn").addEventListener("click", undo);
$("redoBtn").addEventListener("click", redo);
const shiftOctave = (d) => {
  const p = lanePreset();
  prefs.octaves[p.id] = Math.min(7, Math.max(0, octaveFor(p) + d));
  savePrefs();
  configureKeyboard();
};
$("octDown").addEventListener("click", () => shiftOctave(-1));
$("octUp").addEventListener("click", () => shiftOctave(1));
$("layoutSel").addEventListener("change", (e) => {
  prefs.layout = e.target.value;
  savePrefs();
  warnUnfit();
  configureKeyboard();
});
const zoom = (d) => {
  prefs.size = Math.min(80, Math.max(20, prefs.size + d));
  savePrefs();
  configureKeyboard();
};
$("zoomOut").addEventListener("click", () => zoom(-4));
$("zoomIn").addEventListener("click", () => zoom(4));

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) return;
  keyboard.releaseAll();
  saveNow(); // a phone may never come back to this page
});
addEventListener("pagehide", saveNow);

// Device Posture: mirrored onto the root for browsers that have the API but
// not the CSS media feature (touch.css reads both).
const posture = navigator.devicePosture;
if (posture) {
  const mirror = () => { document.documentElement.dataset.posture = posture.type; };
  mirror();
  posture.addEventListener("change", mirror);
}

const split = initSplit({
  app: $("app"), song: document.querySelector(".pane-song"), keys: document.querySelector(".pane-keys"),
  bar: $("splitter"), knob: $("splitKnob"), handKnob: $("handKnob"),
}, prefs, savePrefs);

initTheme(() => keyboard.retheme());
configureKeyboard();
renderAll();
grid.setPlayRow(0); // stopped: the playhead waits on row 0, where Play begins

// For the browser smoke test and for poking at it from a console.
window.__touch = {
  get sketch() { return sketch; }, ui, bank, keyboard, grid,
  get audio() { return audio; }, get playing() { return playing; }, startAudio, togglePlay, split, prefs,
  get home() { return home; }, docs, files,
};

// Everything has loaded and is wired: the veil stops saying "Loading…" and
// takes the tap that starts the sound.
$("startVeil").dataset.state = "ready";
$("startBtn").disabled = false;
showText($("startHint"), "Tap to start the sound");
