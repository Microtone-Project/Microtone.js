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
  $("phoneNote").hidden = !redirected;
}

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
  $("visualiser").hidden = false; // the other half of the landscape split

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
  // The redirect note has said its piece by the time you reach for Play, and on
  // a landscape phone it is a fifth of the half it sits in — so it goes, and
  // stays gone across a reload.
  $("phoneNote").hidden = true;
  try { sessionStorage.removeItem("microtone-phone-redirect"); } catch { /* private mode */ }
  await ensureAudio();
  player.play();
});
$("stopBtn").addEventListener("click", () => player.stop());
$("prevCue").addEventListener("click", () => player.seekCue(Math.max(0, player.cue - 1)));
$("nextCue").addEventListener("click", () => player.seekCue(player.cue + 1));
$("vol").addEventListener("input", (e) => player.setVolume(parseInt(e.target.value, 10) / 255));

// ── meters ──
// The visualiser owns a whole half of the page in landscape, so the canvas has
// no fixed size any more: it is sized to whatever box CSS gives it, in device
// pixels, and it lays itself out ALONG THE LONG AXIS of that box. A wide box
// gets the familiar channels-across mixer strip; a tall one — the right half of
// an unfolded foldable is taller than it is wide — turns the strip on its side
// so 32 channels get 27 px of height each instead of 17 px of width.
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

/**
 * Match the backing store to the box, and put the context in CSS pixels so
 * every measurement below is one. Both axes come from CSS (an aspect-ratio in
 * portrait, a stretched grid item in landscape), which is what keeps this from
 * feeding back into its own layout. DPR is capped at 2: past that the extra
 * pixels cost fill rate and buy nothing on a meter made of rectangles.
 */
function fitMeters() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

/**
 * How often to print a channel number when the cells are too small to letter
 * every one: all of them, every fourth as a scale, or none at all. A strip you
 * cannot count along is worse than one with a scale down the side — and 32
 * two-digit labels in 390 px is not a scale, it is a smudge.
 */
function labelStride(cell, need) {
  if (cell >= need) return 1;
  if (cell >= need / 2.5) return 4;
  return 0;
}

/** One voice's level and peak-hold, decayed. Peaks fall at ~6% a frame. */
function level(vi) {
  const vol = player.getVoiceVolume(vi);
  peaks[vi] = Math.max(peaks[vi] * 0.94, vol);
  return vol;
}

/** Channels across, bars growing upward — the mixer strip, for a wide box. */
function drawColumns(chans, W, H) {
  const labelH = 14;
  const panH = 8;
  const top = 8;
  const meterH = Math.max(4, H - top - panH - labelH - 6);
  const colW = W / chans;
  const barW = Math.max(2, colW - 4);
  const panY = top + meterH + 4;

  const stride = labelStride(colW, 15);
  ctx.font = "10px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  for (let vi = 0; vi < chans; vi++) {
    const x = vi * colW + 2;
    ctx.fillStyle = COL.barBg;
    ctx.fillRect(x, top, barW, meterH);
    const h = Math.round(level(vi) * meterH);
    ctx.fillStyle = COL.bar;
    ctx.fillRect(x, top + meterH - h, barW, h);
    const ph = Math.round(peaks[vi] * meterH);
    if (ph > 0) {
      ctx.fillStyle = COL.accent;
      ctx.fillRect(x, top + meterH - ph - 1, barW, 2);
    }
    ctx.fillStyle = COL.pan;
    ctx.fillRect(x + player.getVoicePan(vi) * (barW - 3), panY, 3, panH);
    if (stride && vi % stride === 0) {
      ctx.fillStyle = COL.text;
      ctx.fillText(String(vi + 1), x + barW / 2, H - 4);
    }
  }
}

/** Channels down, bars growing rightward — the same strip on its side, for a
 *  tall box. The pan track sits under each bar rather than beside it: pan is a
 *  left-to-right quantity and stays one here, which is the whole reason this
 *  layout reads at a glance rather than needing to be worked out. */
function drawRows(chans, W, H) {
  const rowH = H / chans;
  const numW = Math.max(14, Math.min(26, rowH * 1.6));
  const x0 = numW + 2;
  const barW = Math.max(4, W - x0 - 6);
  const panH = Math.max(2, Math.min(4, Math.round(rowH * 0.18)));
  const barH = Math.max(2, Math.min(rowH - panH - 3, Math.round(rowH * 0.52)));
  const pad = Math.max(0, (rowH - barH - panH - 1) / 2);

  const fontPx = Math.max(7, Math.min(11, Math.round(rowH * 0.5)));
  const stride = labelStride(rowH, fontPx + 5);
  ctx.font = `${fontPx}px monospace`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let vi = 0; vi < chans; vi++) {
    const y = vi * rowH + pad;
    ctx.fillStyle = COL.barBg;
    ctx.fillRect(x0, y, barW, barH);
    const w = Math.round(level(vi) * barW);
    ctx.fillStyle = COL.bar;
    ctx.fillRect(x0, y, w, barH);
    const pw = Math.round(peaks[vi] * barW);
    if (pw > 0) {
      ctx.fillStyle = COL.accent;
      ctx.fillRect(x0 + pw - 1, y, 2, barH);
    }
    const panY = y + barH + 1;
    ctx.fillStyle = COL.pan;
    ctx.fillRect(x0 + player.getVoicePan(vi) * (barW - 3), panY, 3, panH);
    if (stride && vi % stride === 0) {
      ctx.fillStyle = COL.text;
      ctx.fillText(String(vi + 1), numW - 3, y + barH / 2);
    }
  }
}

function drawMeters() {
  const { w: W, h: H } = fitMeters();
  ctx.fillStyle = COL.bg;
  ctx.fillRect(0, 0, W, H);

  const chans = player.channelCount || 32;
  if (H > W) drawRows(chans, W, H);
  else drawColumns(chans, W, H);

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
