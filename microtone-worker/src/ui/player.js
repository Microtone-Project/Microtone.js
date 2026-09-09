// Minimal Taud player (M4 artefact) — the browser twin of TSVM's playtaud.js:
// load a .taud, play/stop/seek by cue, live per-voice VU + pan meters.
//
// This page is the reference consumer of `src/taudplay/` (item 179): it drives
// the standalone player library, not the editor's AudioSystem. Everything it
// needs is the transport, one fader group and two probes, which is exactly
// what that library exposes — so if the page can still do its job, the cut is
// the right size. (The faders are what the *editor* uses for mute/solo; here
// nothing touches them, and the meters read the same voices regardless.)

import { TaudPlayer } from "../taudplay/index.js";
import { applyIcons } from "./icons.js";
import { startControlEnhancer } from "./widgets/spinner.js";

const $ = (id) => document.getElementById(id);

applyIcons(document); // vector transport symbols (item 107)
startControlEnhancer(); // …and the song chooser as a step-button group (item 156)

const player = new TaudPlayer();
let audioReady = false;

// The page's handle on the library, for the browser smoke test (and for anyone
// poking at it from the console) — the same idea as the editor's `__microtone`.
window.__taudplay = player;

async function ensureAudio() {
  if (!audioReady) {
    await player.init();
    audioReady = true;
  }
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

async function loadBytes(name, bytes) {
  let songs;
  try {
    songs = await player.load(bytes);
  } catch (err) {
    $("fileinfo").textContent = `${err.message}`;
    return;
  }

  const sel = $("song");
  sel.innerHTML = "";
  songs.forEach((song) => {
    const opt = document.createElement("option");
    opt.value = song.index;
    opt.textContent = `${song.index}: ${song.name} (${song.patterns} pats, ${song.bpm} BPM)`;
    sel.appendChild(opt);
  });

  const info = player.info;
  $("fileinfo").textContent =
    `${name} — ${info.title ?? "untitled"} · ${info.songCount} ${info.songCount === 1 ? "song" : "songs"} · ` +
    `format v${info.formatVersion} · ${info.channels}ch` +
    (info.patchedInstruments ? ` · Ixmp on ${info.patchedInstruments} inst` : "");
  $("transport").hidden = false;

  await ensureAudio();
  refreshBinaural();
}

async function loadFile(file) {
  await loadBytes(file.name, new Uint8Array(await file.arrayBuffer()));
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

$("file").addEventListener("change", (e) => {
  if (e.target.files[0]) loadFile(e.target.files[0]);
});
const drop = $("drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("hover"); });
drop.addEventListener("dragleave", () => drop.classList.remove("hover"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("hover");
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});

$("song").addEventListener("change", (e) => {
  player.selectSong(parseInt(e.target.value, 10));
  refreshBinaural(); // …and the next song may not be surround
});

$("play").addEventListener("click", async () => {
  await ensureAudio();
  player.play();
});
$("stopBtn").addEventListener("click", () => player.stop());
$("prevCue").addEventListener("click", () => player.seekCue(Math.max(0, player.cue - 1)));
$("nextCue").addEventListener("click", () => player.seekCue(player.cue + 1));
$("vol").addEventListener("input", (e) => player.setVolume(parseInt(e.target.value, 10) / 255));

// ── meters ──
const canvas = $("meters");
const ctx = canvas.getContext("2d");
const css = getComputedStyle(document.documentElement);
const COL = {
  bg: css.getPropertyValue("--panel").trim(),
  bar: css.getPropertyValue("--meter").trim(),
  barBg: css.getPropertyValue("--meter-bg").trim(),
  pan: css.getPropertyValue("--accent-2").trim(),
  text: css.getPropertyValue("--dim").trim(),
  accent: css.getPropertyValue("--accent").trim(),
};
// Peak-hold state per voice.
const peaks = new Float32Array(64);

function drawMeters() {
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = COL.bg;
  ctx.fillRect(0, 0, W, H);

  const chans = player.channelCount || 32;
  const colW = W / chans;
  const barW = Math.max(2, colW - 4);
  const meterH = H - 40;

  ctx.font = "10px monospace";
  ctx.textAlign = "center";
  for (let vi = 0; vi < chans; vi++) {
    const x = vi * colW + 2;
    // VU bar
    ctx.fillStyle = COL.barBg;
    ctx.fillRect(x, 10, barW, meterH);
    const vol = player.getVoiceVolume(vi);
    peaks[vi] = Math.max(peaks[vi] * 0.94, vol);
    const h = Math.round(vol * meterH);
    ctx.fillStyle = COL.bar;
    ctx.fillRect(x, 10 + meterH - h, barW, h);
    const ph = Math.round(peaks[vi] * meterH);
    if (ph > 0) {
      ctx.fillStyle = COL.accent;
      ctx.fillRect(x, 10 + meterH - ph - 1, barW, 2);
    }
    // pan tick
    const pan = player.getVoicePan(vi);
    ctx.fillStyle = COL.pan;
    ctx.fillRect(x + pan * (barW - 3), H - 24, 3, 8);
    // channel number
    ctx.fillStyle = COL.text;
    ctx.fillText(String(vi + 1), x + barW / 2, H - 4);
  }

  $("cue").textContent = "$" + player.cue.toString(16).toUpperCase();
  $("rowIdx").textContent = "$" + player.row.toString(16).toUpperCase().padStart(2, "0");
  $("bpm").textContent = player.bpm || "—";
  $("speed").textContent = player.speed || "—";
  requestAnimationFrame(drawMeters);
}
requestAnimationFrame(drawMeters);

// ── ?load= bootstrap (demo links) ──
const bootParams = new URLSearchParams(location.search);
if (bootParams.has("load")) {
  const url = bootParams.get("load");
  fetch(url).then(async (resp) => {
    await loadBytes(url.split("/").pop(), new Uint8Array(await resp.arrayBuffer()));
  }).catch((err) => console.error(`PLAYER: load failed ${err.message}`));
}
