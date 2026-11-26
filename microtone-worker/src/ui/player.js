// The Microtone Player (item 373) — the browser twin of TSVM's playtaud.js,
// grown into a page to LISTEN on: the song's own words (title, author,
// tuning, its message), its rows marching past the playhead, and a radio
// that goes on to another song when this one comes round again.
//
// This page is still the reference consumer of `src/taudplay/` (item 179): it
// drives the standalone player library, not the editor's AudioSystem. The
// only things it takes from the editor are its Document, to READ the file
// (src/player/songfacts.js, marching.js), and the cell painter.
//
// It stands alone (drop files, or `?load=`), and it is the Music Hub's player
// (`?embed=1`, framed by music.microtone.cc): there the Hub hands it songs by
// postMessage and is told what it is doing — see `embed` below.

import { TaudPlayer } from "../taudplay/index.js";
import { parseTaud } from "../../core/format/taud-parse.js";
import { Document } from "../doc/document.js";
import { applyIcons } from "./icons.js";
import { startControlEnhancer } from "./components/spinner.js";
import { holdBrowserZoom } from "./zoom.js";
import { loadCanvasFonts } from "./fonts.js";
import { songFacts, displayTempo, tempoOf } from "../player/songfacts.js";
import { LoopWatch, matchScale, glideSeconds, pickNext } from "../player/radio.js";
import { RowMarch } from "../player/marching.js";

const $ = (id) => document.getElementById(id);
const EMBEDDED = document.documentElement.classList.contains("pl-embedded");

applyIcons(document); // vector transport symbols (item 107)
startControlEnhancer(); // …and the song chooser as a step-button group (item 156)
holdBrowserZoom(); // a pinch beside a fader is a stray finger, not a zoom

const player = new TaudPlayer();
let audioReady = false;

// ── "Open the tracker" — the way back out of index.html's phone redirect ──
// index.html bounces a phone UA to this page; `tracker=1` is the override it
// looks for, and it remembers the choice, so a false positive costs one tap
// once. The rest of the query string rides along, which is what lets a
// `?load=` link open the same song on the other side. The note is only for
// someone who was SENT here — otherwise this is simply a link to the tracker.
{
  const back = new URLSearchParams(location.search);
  back.set("tracker", "1");
  const href = "index.html?" + back.toString() + location.hash;
  $("trackerLink").href = href;
  $("trackerLink2").href = href;
  let redirected = false;
  try {
    redirected = sessionStorage.getItem("microtone-phone-redirect") === "1";
  } catch { /* private mode — then it was never set either */ }
  $("phoneNote").hidden = !redirected || EMBEDDED;
}

// The page's handle on the library, for the browser smoke test (and for anyone
// poking at it from the console) — the same idea as the editor's `__microtone`.
window.__taudplay = player;

// One init for everyone: a Play pressed while the worklet module is still
// being fetched must wait for that same init, not start a second one that
// returns before there is a node to send the play to.
let audioInit = null;
async function ensureAudio() {
  audioInit ??= player.init().then(() => {
    audioReady = true;
    player.onSnapshot = onSnapshot;
    player.onLoaded = onLoaded;
  });
  await audioInit;
  await player.resume();
  updateAudioBadge();
}

function updateAudioBadge() {
  const el = $("audioState");
  if (player.running) {
    const rate = player.sampleRate;
    el.textContent = `audio on @ ${rate} Hz${rate !== 48000 ? " (resampled)" : ""}`;
    el.classList.add("on");
  }
}

// Resume-on-gesture: any key/pointer wakes the context.
for (const ev of ["pointerdown", "keydown"]) {
  window.addEventListener(ev, () => { if (audioReady) ensureAudio(); });
}

// ── the songs ──
// An entry is one file: its bytes, the parsed file the library plays, the
// editor's Document the page reads, and the facts read from it. Standalone,
// the queue is every file dropped here; embedded, it is what the Hub sent —
// the song playing and the one it has lined up next.

let serial = 0;
const queue = [];        // standalone: every file loaded, in order
let current = null;      // the entry playing (or loaded)
let upcoming = null;     // embedded: the Hub's next song, fetched ahead
const recent = [];       // ids played lately, so the radio does not repeat itself

function makeEntry(name, bytes, extra = {}) {
  const parsed = parseTaud(bytes);
  if (parsed.kind !== "taud") throw new Error(`.${parsed.kind} has no song to play — a full .taud is needed`);
  const doc = new Document(parsed);
  return { id: extra.id ?? `local-${++serial}`, name, bytes, parsed, doc, facts: songFacts(doc, 0), hub: extra.hub ?? null };
}

const watch = new LoopWatch();
let watchArmed = false;   // false between a load and the worklet's LOADED
let pendingPlay = null;   // what to do once the worklet says it has the song
let startedId = null;     // the entry a "started" was reported for

/**
 * Put `entry` on the player. `how` is "manual" (the listener chose it: the
 * song as written) or "radio" (the seam of a radio mix: it starts at the
 * outgoing song's tempo and glides to its own). `play` starts it.
 */
async function openEntry(entry, { how = "manual", play = false } = {}) {
  const outTempo = how === "radio" && current
    ? tempoOf(player.bpm || current.facts.bpm, player.speed || current.facts.speed) * (player.tempoScale || 1)
    : 0;
  current = entry;
  watchArmed = false;
  if (audioReady) player.stop();
  const songs = await player.load(entry.bytes);
  if (how === "radio" && outTempo > 0) {
    const f = entry.facts;
    player.setTempoScale(matchScale(outTempo, f.tempo));
    player.setTempoScale(1, glideSeconds(f.bpm, f.speed, f.rowsPerBar));
  } else {
    player.setTempoScale(1);
  }
  pendingPlay = play;
  showSong(entry, songs);
  remember(entry.id);
  // Not awaited: a context that has had no gesture yet may sit suspended
  // until one comes, and the Hub should hear what was loaded meanwhile.
  if (play) ensureAudio().catch(() => {});
  embed.post("loaded", { id: entry.id, facts: entry.facts });
  if (EMBEDDED) embed.post("wantNext", { id: entry.id });
}

function remember(id) {
  const i = recent.indexOf(id);
  if (i >= 0) recent.splice(i, 1);
  recent.push(id);
  while (recent.length > Math.max(1, Math.floor(queue.length / 2))) recent.shift();
}

/** The worklet has the song: play it if asked to, and start watching. */
function onLoaded() {
  watch.reset(0);
  watchArmed = true;
  if (pendingPlay) {
    pendingPlay = false;
    player.play();
  }
  refreshBinaural();
}

/** Every snapshot (≈60 Hz, also in a background tab): the radio's clock. */
function onSnapshot() {
  if (!watchArmed || !current) return;
  if (player.playing && startedId !== current.id) {
    startedId = current.id;
    embed.post("started", { id: current.id });
  }
  const ev = watch.observe(player.cue, player.playing);
  if (ev === "loop") {
    if (!$("radio").checked) {
      // Radio off: the song plays as it was written — round and round.
      watch.reset(player.cue);
    }
  } else if (ev === "seam" || ev === "end") {
    seam(ev);
  }
  if (ev) embed.post("state", { playing: player.playing, event: ev });
}

/** The song is over (it looped and played one more cue, or it stopped). */
function seam(ev) {
  const next = nextEntry();
  watchArmed = false;
  if (next) {
    openEntry(next, { how: "radio", play: true }).then(() => {
      if (EMBEDDED) embed.post("changed", { id: next.id });
      upcoming = null;
    });
    return;
  }
  player.stop();
  embed.post("ended", { id: current?.id ?? null });
  paintQueue();
}

/** What the radio plays next: the Hub's choice, or a random file of the
 *  queue — never the one playing unless it is the only one there is, which
 *  makes a single song end rather than loop. */
function nextEntry() {
  if (!$("radio").checked && !EMBEDDED) return null;
  if (EMBEDDED) return upcoming;
  if (queue.length < 2) return null;
  return pickNext(queue, current?.id, recent);
}

// ── showing a song ──

const march = new RowMarch($("meters"));

function showSong(entry, songs) {
  const f = entry.facts;
  $("now").hidden = false;
  $("nowTitle").textContent = f.title || entry.name;
  $("nowAuthor").textContent = f.author ? `by ${f.author}` : "";
  $("nowAuthor").hidden = !f.author;
  const facts = $("nowFacts");
  facts.replaceChildren();
  const fact = (k, v, wide = false) => {
    if (v === "" || v == null) return;
    const dt = document.createElement("dt"); dt.textContent = k;
    const dd = document.createElement("dd"); dd.textContent = v;
    const cell = document.createElement("div"); // dl > div groups a pair
    if (wide || v.length > 24) cell.className = "wide";
    cell.append(dt, dd);
    facts.append(cell);
  };
  fact("Tuning", f.tuning);
  fact("Tempo", String(displayTempo(f.tempo)));
  fact("Lanes", String(f.lanes));
  if (f.copyright) fact("©", f.copyright);
  if (f.songName && f.songName !== f.title) fact("Song", f.songName);
  const msg = f.message.trim();
  $("messageBox").hidden = msg === "";
  $("message").textContent = msg;
  document.title = f.title ? `${f.title} — Microtone Player` : "Microtone Player";

  const sel = $("song");
  sel.innerHTML = "";
  songs.forEach((song) => {
    const opt = document.createElement("option");
    opt.value = song.index;
    opt.textContent = `${song.index}: ${song.name} (${song.patterns} pats, ${song.bpm} BPM)`;
    sel.appendChild(opt);
  });
  $("song").closest("label").hidden = songs.length < 2;

  const info = player.info;
  $("fileinfo").textContent =
    `${entry.name} — ${info.title ?? "untitled"} · ${info.songCount} ${info.songCount === 1 ? "song" : "songs"} · ` +
    `format v${info.formatVersion} · ${info.channels} lanes` +
    (info.patchedInstruments ? ` · Ixmp on ${info.patchedInstruments} inst` : "");
  $("transport").hidden = false;
  $("visualiser").hidden = false; // the other half of the landscape split
  $("nextSong").hidden = !EMBEDDED && queue.length < 2;
  march.setSong(entry.doc, 0, f);
  paintQueue();
}

function paintQueue() {
  const box = $("queueBox");
  box.hidden = EMBEDDED || queue.length < 2;
  if (box.hidden) return;
  const list = $("queue");
  list.replaceChildren(...queue.map((e) => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pl-queue-item" + (e === current ? " current" : "");
    const t = document.createElement("span"); t.className = "pl-q-title"; t.textContent = e.facts.title || e.name;
    const a = document.createElement("span"); a.className = "pl-q-meta";
    a.textContent = [e.facts.author, e.facts.tuning, `tempo ${displayTempo(e.facts.tempo)}`].filter(Boolean).join(" · ");
    b.append(t, a);
    if (e === current) b.setAttribute("aria-current", "true");
    b.addEventListener("click", () => openEntry(e, { play: true }));
    li.append(b);
    return li;
  }));
}

/** #998.3: the head model is only meaningful for a surround song, so the
 *  control appears with one. On by default, as in the editor — a fold cannot
 *  render height, and this player is where someone LISTENS to a spatial song. */
function refreshBinaural() {
  const surround = player.songs[player.songIndex]?.surround ?? false;
  $("binauralWrap").hidden = !surround;
  player.setBinaural($("binaural").checked);
}
$("binaural").addEventListener("change", () => refreshBinaural());

// ── files ──

async function addFiles(files, { play = true } = {}) {
  let first = null;
  const errors = [];
  for (const file of files) {
    try {
      const e = makeEntry(file.name, new Uint8Array(await file.arrayBuffer()));
      queue.push(e);
      first ??= e;
    } catch (err) {
      errors.push(`${file.name}: ${err.message}`);
    }
  }
  if (errors.length) $("fileinfo").textContent = errors.join(" · ");
  if (first) await openEntry(first, { play });
}

async function loadBytes(name, bytes, extra = {}) {
  try {
    const e = makeEntry(name, bytes, extra);
    if (!EMBEDDED) queue.push(e);
    await openEntry(e, { play: false });
    await ensureAudio();
    return e;
  } catch (err) {
    $("fileinfo").textContent = `${err.message}`;
    return null;
  }
}

$("file").addEventListener("change", (e) => { if (e.target.files.length) addFiles([...e.target.files]); });
const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("hover"); });
drop.addEventListener("dragleave", () => drop.classList.remove("hover"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("hover");
  if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]);
});

$("song").addEventListener("change", (e) => {
  player.selectSong(parseInt(e.target.value, 10));
  if (current) {
    current.facts = songFacts(current.doc, parseInt(e.target.value, 10));
    march.setSong(current.doc, parseInt(e.target.value, 10), current.facts);
  }
  watch.reset(0);
  refreshBinaural(); // …and the next song may not be surround
});

$("play").addEventListener("click", async () => {
  // The redirect note has said its piece by the time you reach for Play, and on
  // a landscape phone it is a fifth of the half it sits in — so it goes, and
  // stays gone across a reload.
  $("phoneNote").hidden = true;
  try { sessionStorage.removeItem("microtone-phone-redirect"); } catch { /* private mode */ }
  await ensureAudio();
  watch.reset(0);
  watchArmed = !!current;
  player.play();
});
$("stopBtn").addEventListener("click", () => { player.stop(); watchArmed = false; });
$("prevCue").addEventListener("click", () => player.seekCue(Math.max(0, player.cue - 1)));
$("nextCue").addEventListener("click", () => player.seekCue(player.cue + 1));
$("nextSong").addEventListener("click", () => {
  const next = EMBEDDED ? upcoming : pickNext(queue, current?.id, recent);
  if (!next) { if (EMBEDDED) embed.post("wantNext", { id: current?.id ?? null, now: true }); return; }
  openEntry(next, { play: true }).then(() => { if (EMBEDDED) embed.post("changed", { id: next.id }); upcoming = null; });
});
$("vol").addEventListener("input", (e) => player.setVolume(parseInt(e.target.value, 10) / 255));

// ── the frame loop: the march and the readouts ──

const shown = new Map();
function showText(id, s) {
  if (shown.get(id) === s) return; // a textContent write costs a layout even when equal
  shown.set(id, s);
  $(id).textContent = s;
}

function frame(now) {
  if (!$("visualiser").hidden) march.frame(player, now);
  showText("cue", "$" + player.cue.toString(16).toUpperCase());
  showText("rowIdx", "$" + player.row.toString(16).toUpperCase().padStart(2, "0"));
  showText("bpm", player.bpm ? String(player.bpm) : "—");
  showText("speed", player.speed ? String(player.speed) : "—");
  const scale = player.tempoScale || 1;
  const t = player.bpm && player.speed ? displayTempo(tempoOf(player.bpm, player.speed) * scale) : null;
  showText("tempo", t === null ? "—" : String(t) + (Math.abs(scale - 1) > 0.002 ? ` (${scale >= 1 ? "+" : "−"}${Math.abs((scale - 1) * 100).toFixed(1)}%)` : ""));
  requestAnimationFrame(frame);
}
// Canvas text never fetches a webfont itself; ask for the faces it draws in.
loadCanvasFonts([10, 12, 14, 16], () => { march.lastPaintKey = ""; });
requestAnimationFrame(frame);

// ── embedded in the Music Hub ──
// The Hub frames this page and speaks to it by postMessage, both ways, in
// messages `{ mt: "player", cmd | ev, … }`. Only the frame's parent is
// listened to, and only from this page's own origin or the Hub's: the Hub
// serves a copy of this player beside itself (the same origin), and
// microtone.cc's copy may be framed by the Hub too.
//
//   in   load {url, id, autoplay}   the song to play now
//        next {url, id}             the one to follow it (fetched at once)
//        play | stop | toggle
//        radio {on}
//        layout {layout: "bar" | "full"}
//        theme {theme}
//   out  ready · loaded {id, facts} · started {id} (the first sound: the Hub
//        counts a play) · wantNext {id} · changed {id} (the radio moved on)
//        · ended {id} · state {playing, event} · size {height}

const HUB_ORIGINS = new Set(["https://music.microtone.cc", location.origin]);

const embed = {
  origin: null,
  post(ev, data = {}) {
    if (!EMBEDDED || window.parent === window) return;
    window.parent.postMessage({ mt: "player", ev, ...data }, this.origin ?? location.origin);
  },
};

async function fetchEntry(url, id) {
  // Same-origin credentials (fetch's default), not "omit": the Hub's console
  // serves its submissions behind HTTP sign-in, and an omitted credential is a
  // 401. The public Hub keeps no cookies, so this sends nothing there.
  const resp = await fetch(new URL(url, location.href), { credentials: "same-origin" });
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  return makeEntry(decodeURIComponent(new URL(url, location.href).pathname.split("/").pop() || "song.taud"), bytes, { id });
}

if (EMBEDDED) {
  window.addEventListener("message", async (e) => {
    if (e.source !== window.parent || !HUB_ORIGINS.has(e.origin)) return;
    const m = e.data;
    if (!m || m.mt !== "player") return;
    embed.origin = e.origin;
    try {
      switch (m.cmd) {
        case "load": {
          const entry = await fetchEntry(m.url, m.id);
          upcoming = null;
          await openEntry(entry, { play: !!m.autoplay });
          break;
        }
        case "next":
          upcoming = m.url ? await fetchEntry(m.url, m.id) : null;
          break;
        case "play": await ensureAudio(); watchArmed = !!current; player.play(); break;
        case "stop": player.stop(); break;
        case "toggle":
          await ensureAudio();
          if (player.playing) player.stop(); else { watch.reset(0); watchArmed = !!current; player.play(); }
          break;
        case "radio": $("radio").checked = !!m.on; break;
        case "layout": document.documentElement.dataset.layout = m.layout === "bar" ? "bar" : "full"; break;
        case "theme":
          if (["dark", "dim", "light"].includes(m.theme)) document.documentElement.dataset.theme = m.theme;
          break;
      }
    } catch (err) {
      embed.post("error", { id: m.id ?? null, message: String(err.message ?? err) });
    }
  });
  window.parent.postMessage({ mt: "player", ev: "ready" }, "*");
  // The bar's play button reports the state the Hub shows beside it.
  setInterval(() => embed.post("state", { playing: player.playing }), 1000);
}

// ── ?load= bootstrap (demo links) ──
const bootParams = new URLSearchParams(location.search);
if (bootParams.has("load")) {
  const url = bootParams.get("load");
  fetch(url).then(async (resp) => {
    await loadBytes(url.split("/").pop(), new Uint8Array(await resp.arrayBuffer()));
  }).catch((err) => console.error(`PLAYER: load failed ${err.message}`));
}
