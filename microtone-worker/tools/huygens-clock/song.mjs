// "Huygens' Clock" — the notes. 31-TET, 7/8 (2+2+3), 64 bars, two rows per
// eighth. Every pitch is a 31-EDO step (C0 = 0); see lib.mjs.
//
// Form (bars):  1–8 intro · 9–16 theme · 17–24 solo · 25–40 neutral-third
// chain · 41–48 the five thirds · 49–56 theme in the major · 57–64 coda on the
// harmonic series.

import {
  R, BAR_ROWS, DEG, st, midiStep, defLane, hit, keyOff, fx, put, has, cellAt, melody,
  glide, glideSpeed, vibrato, voiceLead, volFineDown, volSlideUp, lanes, L, stepName as sn,
} from "./lib.mjs";

// Instrument slots, in the order the bank is built (meta.mjs PRESETS).
const KIT = 1, FRETLESS = 2, EP = 3, MAR = 4, PAD = 5, STR = 6, LEAD = 7, FLUTE = 8, GTR = 9, VIB = 10;

defLane("kick", KIT, 0x80, "Kick", 1, 2);
defLane("snare", KIT, 0x7a, "Snare", 1, 2);
defLane("hat", KIT, 0xa6, "Hats", 1, 4);
defLane("cym", KIT, 0x66, "Cymbals", 1, 3);
defLane("tom", KIT, 0x80, "Toms");
defLane("perc", KIT, 0x9c, "Percussion", 1, 3);
defLane("bass", FRETLESS, 0x80, "Fretless", 0.8);
defLane("ep1", EP, 0x4a, "Tines 1");
defLane("ep2", EP, 0x6e, "Tines 2");
defLane("ep3", EP, 0x92, "Tines 3");
defLane("ep4", EP, 0xb5, "Tines 4");
defLane("mar", MAR, 0x56, "Marimba", 1, 2);
defLane("vib", VIB, 0xae, "Vibes");
defLane("pad1", PAD, 0x40, "Pad 1");
defLane("pad2", PAD, 0x6a, "Pad 2");
defLane("pad3", PAD, 0x96, "Pad 3");
defLane("pad4", PAD, 0xc0, "Pad 4");
defLane("str1", STR, 0x4a, "Strings 1");
defLane("str2", STR, 0x6c, "Strings 2");
defLane("str3", STR, 0x94, "Strings 3");
defLane("str4", STR, 0xb6, "Strings 4");
defLane("lead", LEAD, 0x8a, "Lead");
defLane("flute", FLUTE, 0x72, "Flute");
defLane("gtr", GTR, 0xb2, "Guitar", 1, 2);

const EPS = ["ep1", "ep2", "ep3", "ep4"];
const PADS = ["pad1", "pad2", "pad3", "pad4"];
const STRS = ["str1", "str2", "str3", "str4"];
const S = (names) => names.map(st);

// ── harmony ────────────────────────────────────────────────────────────────
const ch = (root, ivs, name) => ({ root: DEG[root], ivs, name });
const SUB7 = [0, 7, 18, 25];   // 12:14:18:21 — subminor third, harmonic seventh
const H7 = [0, 10, 18, 25];    // 4:5:6:7
const MAJ = [0, 10, 18];
const OTON = [0, 10, 18, 25, 36, 45]; // 4:5:6:7:9:11
const Dsub7 = ch("D", SUB7, "Dsub7");
const Bb7 = ch("Bb", H7, "Bb7h");
const A7 = ch("A", H7, "A7h");
const D7 = ch("D", H7, "D7h");
const Doton = ch("D", OTON, "Doton");
// Major triads climbing by neutral thirds (9 steps): two make a fifth, so every
// other chord is the circle of fifths and the ones between sit half a fifth off.
const CHAIN = ["Bb", "Dp", "F", "Ap", "C", "Ep", "G", "Bp"].map((r) => ch(r, MAJ, r));
// The five thirds over D, then the harmonic series assembling itself.
const LADDER = [
  ch("D", [0, 7, 18, 25], "D 12:14:18:21"),   // subminor
  ch("D", [0, 8, 18, 26], "D minor 7"),       // minor
  ch("D", [0, 9, 18, 27], "D neutral 7"),     // neutral
  ch("D", [0, 10, 18, 28], "D major 7"),      // major
  ch("D", [0, 11, 18, 28], "D supermajor 7"), // supermajor
  ch("D", H7, "D 4:5:6:7"),
  ch("D", [0, 10, 18, 25, 36], "D 4:5:6:7:9"),
  Doton,
];

const CH = [];
for (let b = 1; b <= 24; b++) CH[b] = [Dsub7, Dsub7, Bb7, A7][(b - 1) % 4];
for (let b = 25; b <= 40; b++) CH[b] = CHAIN[(b - 25) >> 1];
for (let b = 41; b <= 48; b++) CH[b] = LADDER[b - 41];
for (let b = 49; b <= 56; b++) CH[b] = [D7, D7, Bb7, A7][(b - 49) % 4];
for (let b = 57; b <= 60; b++) CH[b] = [Bb7, A7][(b - 57) % 2];
for (let b = 61; b <= 64; b++) CH[b] = Doton;

export const sectionOfCue = (c) =>
  ["intro", "intro", "theme", "theme", "solo", "solo", "chain", "chain", "chain", "chain",
    "thirds", "thirds", "major", "major", "coda", "coda"][c];

// ── drums ──────────────────────────────────────────────────────────────────
const GM = {
  kick: 36, rim: 37, snare: 38, hatC: 42, hatP: 44, hatO: 46, crash: 49, crash2: 57,
  ride: 51, bell: 53, splash: 55, tomHi: 50, tomHM: 48, tomLM: 47, tomLo: 45,
  flHi: 43, flLo: 41, tamb: 54, shaker: 82, chimes: 84,
};
const dr = (lane, bar, row, name, vol, f = null, a = 0) => hit(lane, R(bar, row), midiStep(GM[name]), vol, f, a);
/** Open hat that the next hat on the lane chokes (NNA cut on this note, S $73). */
const openHat = (bar, row, vol) => dr("hat", bar, row, "hatO", vol, "S", 0x7300);
/** A ride stroke re-strikes the one cymbal: the next stroke cuts this one (S $73)
 *  instead of leaving its looped tail to fade for ten seconds under the rest. */
const ride = (bar, row, name, vol) => dr("cym", bar, row, name, vol, "S", 0x7300);

function grooveA(bar, { variant = 0, tamb = false, open = false, fillFrom = 14 } = {}) {
  const k = (row, name, vol) => { if (row < fillFrom) dr("kick", bar, row, name, vol); };
  const sn = (row, name, vol) => { if (row < fillFrom) dr("snare", bar, row, name, vol); };
  k(0, "kick", 54);
  k(6, "kick", 41);
  k(8, "kick", 50);
  if (variant & 1) k(11, "kick", 38);
  sn(4, "snare", 49);
  sn(10, "snare", 53);
  sn(7, "snare", 13);
  if (!(variant & 1)) sn(13, "snare", 17);
  const hv = [60, 0, 44, 0, 56, 0, 44, 0, 58, 30, 44, 32, 50, 0];
  for (let r = 0; r < 14; r++) {
    if (!hv[r] || r >= fillFrom) continue;
    if ((r === 9 || r === 11) && !(variant & 1)) continue;
    if (r === 12 && open) { openHat(bar, 12, 46); continue; }
    dr("hat", bar, r, "hatC", hv[r]);
  }
  if (tamb) { dr("perc", bar, 4, "tamb", 26); if (10 < fillFrom) dr("perc", bar, 10, "tamb", 30); }
}

function grooveSolo(bar, variant = 0) {
  dr("kick", bar, 0, "kick", 54);
  dr("kick", bar, 6, "kick", 41);
  dr("kick", bar, 8, "kick", 49);
  dr("kick", bar, 11, "kick", 39);
  dr("snare", bar, 4, "snare", 50);
  dr("snare", bar, 10, "snare", 53);
  dr("snare", bar, 2, "snare", 12);
  dr("snare", bar, 7, "snare", 14);
  if (variant & 1) dr("snare", bar, 13, "snare", 18);
  const rv = [58, 0, 44, 0, 52, 0, 44, 0, 54, 0, 44, 0, 48, 0];
  for (let r = 0; r < 14; r += 2) {
    if (has("cym", R(bar, r))) continue;
    ride(bar, r, r === 8 ? "bell" : "ride", r === 8 ? 44 : rv[r]);
  }
  dr("hat", bar, 4, "hatP", 50);
  dr("hat", bar, 10, "hatP", 50);
}

/** Half time for the chain: kick on one, snare on the three-group, ride and shaker moving. */
function grooveHalf(bar, second) {
  dr("kick", bar, 0, "kick", second ? 46 : 52);
  if (!second) dr("kick", bar, 11, "kick", 36);
  else dr("kick", bar, 6, "kick", 34);
  dr("snare", bar, 8, "snare", 48);
  if (second) dr("snare", bar, 4, "rim", 30);
  for (let r = 0; r < 14; r += 2) {
    if (has("cym", R(bar, r))) continue;
    ride(bar, r, (r === 0 && !second) ? "bell" : "ride", r % 4 === 0 || r === 8 ? 46 : 36);
  }
  dr("hat", bar, 4, "hatP", 42);
  dr("hat", bar, 12, "hatP", 38);
  for (let r = 0; r < 14; r++) {
    if (has("perc", R(bar, r))) continue;
    dr("perc", bar, r, "shaker", [34, 20, 28, 20][r % 4] - (r >= 8 && r % 2 ? 2 : 0));
  }
}

function fillToms(bar, from = 8) {
  const seq = [["tomHi", 46], ["tomHi", 40], ["tomHM", 50], ["tomLM", 48], ["flHi", 54], ["flLo", 58]];
  for (let i = 0; i < 14 - from; i++) {
    const [n, v] = seq[Math.max(0, seq.length - (14 - from) + i)];
    dr("tom", bar, from + i, n, v);
  }
}

function snareFill(bar, from, vols) {
  vols.forEach((v, i) => dr("snare", bar, from + i, "snare", v));
}

// ── bass ───────────────────────────────────────────────────────────────────
const BASS = {
  Dsub7a: "D2:3@54 D2:1@28 D3:2@46 Cp2:2@48 A2:3@52 A2:1@26 G2:2@44",
  Dsub7b: "D2:3@54 D2:1@28 D3:2@46 Cp2:2@48 A2:2@50 Fp2:2@44 D2:2@46",
  Bb7h: "Bb1:3@54 Bb1:1@28 Bb2:2@46 G#2:2@48 F2:3@52 F2:1@26 Bb1:1@44 ~A1:1",
  A7h: "A1:3@54 A1:1@28 A2:2@46 Gp2:2@48 E2:3@52 E2:1@26 C#2:2@46",
  D7a: "D2:3@54 D2:1@28 D3:2@46 Cp2:2@48 A2:3@52 A2:1@26 G2:2@44",
  D7b: "D2:3@54 D2:1@28 D3:2@46 Cp2:2@48 A2:2@50 F#2:2@44 D2:2@46",
};
const bassBar = (bar, key) => melody("bass", R(bar), BASS[key], { glideRows: 1 });

// ── keys, mallets, guitar ──────────────────────────────────────────────────
const EPV = {
  Dsub7: S(["A3", "Cp3", "D4", "Fp4"]),
  Bb7h: S(["G#3", "Bb3", "D4", "F4"]),
  A7h: S(["Gp3", "A3", "C#4", "E4"]),
  D7h: S(["A3", "Cp3", "D4", "F#4"]),
};
function epChord(bar, row, steps, vol, len) {
  steps.forEach((s, i) => {
    hit(EPS[i], R(bar, row), s, vol - (i === 0 ? 2 : 0));
    if (len) keyOff(EPS[i], R(bar, row) + len);
  });
}
/** Two-bar comping cell in 2+2+3. */
function epComp(bar, voicing, alt) {
  if (!alt) { epChord(bar, 0, voicing, 36, 4); epChord(bar, 6, voicing, 27, 2); epChord(bar, 10, voicing, 32, 4); }
  else { epChord(bar, 0, voicing, 35, 3); epChord(bar, 3, voicing, 26, 2); epChord(bar, 8, voicing, 32, 6); }
}

const MARV = {
  Dsub7: S(["D3", "A3", "Cp3", "D4", "Fp4", "A4"]),
  Bb7h: S(["Bb2", "F3", "G#3", "Bb3", "D4", "F4"]),
  A7h: S(["A2", "E3", "Gp3", "A3", "C#4", "E4"]),
  D7h: S(["D3", "A3", "Cp3", "D4", "F#4", "A4"]),
  Doton: S(["D3", "A3", "Cp3", "D4", "F#4", "Gt4"]),
};
const MAR_IDX = [0, 1, 3, 1, 2, 1, 4, 1, 3, 1, 4, 3, 5, 4];
const MAR_ACC = [8, -4, 2, -4, 7, -4, 2, -4, 7, -4, 2, -2, 3, -4];
/** The clock: a 14-sixteenth ostinato round a pivot tone. */
function marimbaBar(bar, voicing, base, { upto = 14 } = {}) {
  for (let r = 0; r < upto; r++) {
    hit("mar", R(bar, r), voicing[MAR_IDX[r]], Math.max(4, Math.round(base + MAR_ACC[r])));
  }
}

const GTRV = {
  Dsub7: S(["D4", "A4", "Cp4", "Fp5"]),
  Bb7h: S(["Bb3", "F4", "G#4", "D5"]),
  A7h: S(["A3", "E4", "Gp4", "C#5"]),
  D7h: S(["D4", "A4", "Cp4", "F#5"]),
};
const GTR_ROWS = [0, 2, 3, 5, 6, 8, 10, 11, 13];
const GTR_IDX = [0, 1, 2, 1, 3, 0, 2, 1, 3];
const GTR_VOL = [42, 32, 30, 28, 38, 40, 32, 28, 34];
function guitarBar(bar, voicing, lift = 0) {
  GTR_ROWS.forEach((r, i) => hit("gtr", R(bar, r), voicing[GTR_IDX[i]], GTR_VOL[i] + lift));
}

/** Vibraphone arpeggio in eighths over a chord voicing (ascending steps). */
function vibesBar(bar, tones, idx, base) {
  idx.forEach((k, i) => {
    const r = i * 2;
    hit("vib", R(bar, r), tones[k], base + (r === 0 || r === 4 || r === 8 ? 5 : 0));
  });
}

// ── sustained parts ────────────────────────────────────────────────────────
function holdChord(laneIds, bar, row, steps, vol, lenRows) {
  steps.forEach((s, i) => {
    hit(laneIds[i], R(bar, row), s, vol);
    if (lenRows) keyOff(laneIds[i], R(bar, row) + lenRows);
  });
}
/** Glide every lane to its new step (no re-attack), each at its own speed. */
function glideChord(laneIds, row, from, to, rows) {
  to.forEach((s, i) => {
    if (s === from[i]) return;
    glide(laneIds[i], row, s, glideSpeed(from[i], s, rows));
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 1–8  INTRO — the clock alone, then the band arriving
// ════════════════════════════════════════════════════════════════════════════
for (let b = 1; b <= 8; b++) {
  const c = CH[b].name;
  const base = b <= 2 ? 26 + b * 3 : b <= 4 ? 34 + (b - 3) * 2 : 40;
  marimbaBar(b, MARV[c], base);
}
// Pad from bar 3, swelling in.
{
  let v = S(["D3", "A3", "Fp4", "Cp4"]);
  for (let b = 3; b <= 8; b++) {
    if (b > 3 && CH[b] === CH[b - 1]) continue;
    v = voiceLead(v, CH[b], st("C3"), st("D5"));
    holdChord(PADS, b, 0, v, b === 3 ? 16 : 32, 0);
    if (b === 3) for (const p of PADS) for (let r = 1; r <= 5; r++) volSlideUp(p, R(3, r), 1);
  }
  for (const p of PADS) keyOff(p, R(9));
}
// Bass, hats and tines from bar 5; toms into the theme.
for (let b = 5; b <= 8; b++) {
  const c = CH[b].name;
  if (b === 5 || b === 6) melody("bass", R(b), b === 5 ? "D2:8@46 A2:4@40 Cp2:2@40" : "D2:6@46 D3:2@36 A2:4@40 Cp1:2@40");
  else if (b === 7) melody("bass", R(b), "Bb1:6@46 Bb2:2@36 F2:4@40 Bb1:1@40 ~A1:1");
  else melody("bass", R(b), "A1:6@48 A2:2@38 E2:2@42 Gp2:2@42 C#2:2@44");
  epChord(b, 0, EPV[c], 30, b === 8 ? 8 : 13);
  for (let r = 0; r < 14; r += 2) dr("hat", b, r, "hatC", (r === 0 || r === 4 || r === 8 ? 44 : 32) + (b - 5) * 3);
  if (b >= 6) { dr("snare", b, 4, "rim", 30); dr("snare", b, 10, "rim", 34); }
}
dr("kick", 7, 0, "kick", 48);
dr("kick", 8, 0, "kick", 54);
dr("kick", 8, 8, "kick", 50);
fillToms(8, 8);

// ════════════════════════════════════════════════════════════════════════════
// 9–16  THEME — the septimal blues pentatonic: D, Fp (7/6), G, A, Cp (7/4)
// ════════════════════════════════════════════════════════════════════════════
const THEME_MINOR = `
  D5:2 Fp5:2 G5:2 A5:2 ~Cp5:6v |
  A5:3 G5:1 Fp5:4v D5:4v E5:2 |
  F5:2 D5:2 G#5:6v F5:2 G#5:2 |
  A5:4v Gp5:4v E5:2 C#5:2 E5:2 |
  D5:2 Fp5:2 G5:2 A5:2 ~Cp5:4v D6:2 |
  Cp5:3 A5:1 G5:4v Fp5:2 G5:2 A5:2 |
  Bb5:4v G#5:2 F5:2 D5:2 F5:2 G#5:2 |
  A5:6v E5:2 C#5:2 Gp5:4v`;
melody("lead", R(9), THEME_MINOR, { vol: 55 });
dr("cym", 9, 0, "crash", 54);
for (let b = 9; b <= 16; b++) {
  const c = CH[b].name;
  grooveA(b, { variant: b % 2, open: b % 4 === 0 && b !== 16, fillFrom: b === 16 ? 8 : 14 });
  bassBar(b, c === "Dsub7" ? ((b - 9) % 4 === 0 ? "Dsub7a" : "Dsub7b") : c);
  epComp(b, EPV[c], b % 2 === 0);
  marimbaBar(b, MARV[c], 22);
}
snareFill(16, 8, [30, 34, 40, 44, 50, 56]);

// ════════════════════════════════════════════════════════════════════════════
// 17–24  SOLO — lead synth over the same loop, ride cymbal, guitar figure
// ════════════════════════════════════════════════════════════════════════════
const SOLO = `
  Fp5:4v D5:1 Fp5:1 G5:1 A5:1 ~Cp5:6v |
  ~C6:2 ~Cp5:2 A5:2 G5:1 Fp5:1 D5:2 Cp4:2 D5:2 |
  F5:1 G#5:1 Bb5:2 D6:2 F6:2 D6:1 Bb5:1 G#5:2 F5:2 |
  E6:4v C#6:2 A5:2 Gp5:2 A5:1 C#6:1 E6:2 |
  Fp6:6v D6:2 Cp5:2 A5:2 G5:1 Fp5:1 |
  D5:1 Gt5:1 A5:2 Gt5:1 A5:1 Cp5:2 A5:1 Gt5:1 G5:2 Fp5:2 |
  D6:2 F6:2 ~G#6:6v F6:2 D6:2 |
  C#6:2 E6:2 Gp6:4v E6:1 C#6:1 A5:2 Gp5:2`;
melody("lead", R(17), SOLO, { vol: 55, vib: [0x80, 0x18] });
dr("perc", 17, 0, "crash2", 52);
for (let b = 17; b <= 24; b++) {
  const c = CH[b].name;
  grooveSolo(b, b % 2);
  bassBar(b, c === "Dsub7" ? ((b - 17) % 4 === 0 ? "Dsub7a" : "Dsub7b") : c);
  epComp(b, EPV[c], b % 2 === 1);
  guitarBar(b, GTRV[c]);
}
fillToms(24, 8);

// ════════════════════════════════════════════════════════════════════════════
// 25–40  CHAIN — Bb, Dp, F, Ap, C, Ep, G, Bp: up a neutral third every two bars.
// Two notes of each triad move by one diesis, the third by a neutral second.
// ════════════════════════════════════════════════════════════════════════════
{
  // Pad: one attack at bar 25, then the triads MORPH — every change is a glide.
  let v = S(["Bb3", "D4", "F4"]);
  holdChord(PADS, 25, 0, v, 48, 0);
  for (let k = 1; k < 8; k++) {
    const nv = voiceLead(v, CHAIN[k], st("D3"), st("A4"));
    glideChord(PADS, R(25 + 2 * k), v, nv, 4);
    v = nv;
  }
  for (const p of PADS.slice(0, 3)) keyOff(p, R(41));
  // Strings join at bar 33 an octave up, gliding the same way.
  let w = voiceLead(S(["E4", "G4", "C5", "E5"]), CHAIN[4], st("C4"), st("G5"));
  holdChord(STRS, 33, 0, w, 10, 0);
  for (const s of STRS) for (let r = 1; r <= 3; r+=2) volSlideUp(s, R(33, r), 1); // milder vol slideup
  for (let k = 5; k < 8; k++) {
    const nw = voiceLead(w, CHAIN[k], st("A3"), st("G5"));
    glideChord(STRS, R(25 + 2 * k), w, nw, 4);
    w = nw;
  }
  for (const s of STRS) keyOff(s, R(41));
}
// Bass: half-time roots, ripping up the neutral third into each new chord.
{
  const roots = S(["Bb1", "Dp2", "F2", "Ap2", "C2", "Ep2", "G2", "Bp2"]);
  for (let k = 0; k < 8; k++) {
    const b = 25 + 2 * k, r0 = roots[k];
    const high = r0 >= st("G2");
    const fifth = high ? r0 - 13 : r0 + 18, oct = high ? r0 - 31 : r0 + 31;
    melody("bass", R(b), `${sn(r0)}:8@52 ${sn(fifth)}:3@40 ${sn(oct)}:3@36 | ${sn(r0)}:8@48 ${sn(fifth)}:4@42`);
    const resets = k === 3 || k === 7; // the line drops back an octave here
    if (!resets) {
      hit("bass", R(b + 1, 12), r0, 44);
      glide("bass", R(b + 1, 13), roots[k + 1], glideSpeed(r0, roots[k + 1], 1));
    } else {
      hit("bass", R(b + 1, 12), oct, 42);
    }
  }
  keyOff("bass", R(41));
}
// Vibes: the chord tones in eighths.
for (let k = 0; k < 8; k++) {
  const chd = CHAIN[k];
  let rs = 31 * 3 + chd.root;
  if (rs < st("Ab3")) rs += 31;
  const tones = [rs, rs + 18, rs + 31, rs + 41, rs + 49];
  vibesBar(25 + 2 * k, tones, [0, 1, 2, 3, 4, 3, 2], 19);
  vibesBar(26 + 2 * k, tones, [1, 2, 3, 4, 2, 3, 1], 18);
}
keyOff("vib", R(41));
// Flute: each long note slides one diesis as the harmony turns under it.
const CHAIN_FLUTE = `
  D6:10v C6:2 D6:2 |
  C6:2 D6:2 F6:4v D6:6v |
  ~Dp6:14v |
  Ft6:2 Dp6:2 Ap5:4v Ft5:2 Ap5:4v |
  ~A5:14v |
  C6:2 A5:2 F5:4v A5:6v |
  ~Ap5:14v |
  Ct6:2 Ep6:4v Ct6:2 Ap5:2 Ep6:4v |
  ~E6:14v |
  D6:2 E6:2 G6:4v E6:6v |
  ~Ep6:14v |
  Gt6:2 Ep6:2 Bp5:4v Gt5:2 Bp5:4v |
  ~B5:14v |
  D6:2 B5:2 G5:4v B5:6v |
  ~Bp5:14v |
  Dt6:2 Ft6:4v Dt6:2 Bp5:4v A5:22v`;
melody("flute", R(25), CHAIN_FLUTE, { vol: 29, glideRows: 3, vib: [0x70, 0x10] });
for (let r = R(41, 4); r < R(42, 8); r++) volFineDown("flute", r, 2);
// Drums
dr("cym", 25, 0, "crash", 40);
dr("perc", 25, 0, "chimes", 30);
dr("cym", 33, 0, "crash", 48);
dr("perc", 33, 0, "chimes", 26);
for (let b = 25; b <= 40; b++) grooveHalf(b, (b - 25) % 2 === 1);
snareFill(32, 10, [26, 32, 38, 44]);
for (const [r, n, v] of [[8, "tomHM", 34], [10, "tomLM", 30], [12, "flHi", 28], [13, "flLo", 26]]) dr("tom", 40, r, n, v);

// ════════════════════════════════════════════════════════════════════════════
// 41–48  THE FIVE THIRDS — over D, the third climbs one diesis a bar:
// subminor, minor, neutral, major, supermajor; then 4:5:6:7, 9, 11.
// ════════════════════════════════════════════════════════════════════════════
{
  const third = S(["Fp4", "F4", "Ft4", "F#4", "Gb4", "F#4", "F#4", "F#4"]);
  const seventh = S(["Cp4", "C5", "Ct5", "C#5", "C#5", "Cp4", "Cp4", "Cp4"]);
  // Pad: D and A held, the third and seventh glide.
  holdChord(PADS, 41, 0, [st("D3"), st("A3"), third[0], seventh[0]], 54, 0);
  for (let b = 42; b <= 48; b++) {
    const k = b - 41;
    if (third[k] !== third[k - 1]) glide("pad3", R(b), third[k], glideSpeed(third[k - 1], third[k], 3));
    if (seventh[k] !== seventh[k - 1]) glide("pad4", R(b), seventh[k], glideSpeed(seventh[k - 1], seventh[k], 3));
  }
  // Tines re-strike every bar so each quality is heard on its own.
  for (let b = 41; b <= 48; b++) {
    const k = b - 41;
    epChord(b, 0, [st("D4"), third[k], st("A4"), seventh[k]], b <= 45 ? 36 : 40, b >= 47 ? 8 : 12);
    if (b >= 47) epChord(b, 8, [st("D4"), third[k], st("A4"), seventh[k]], 32, 6);
  }
  // Strings from bar 43, an octave over the pad's moving notes; then the 9th and 11th.
  holdChord(STRS, 43, 0, [st("D4"), third[2] + 31, st("A4"), seventh[2]], 10, 0);
  for (const s of STRS) for (let r = 1; r <= 4; r+=2) volSlideUp(s, R(43, r), 1); // milder vol slideup
  for (let b = 44; b <= 46; b++) {
    const k = b - 41;
    if (third[k] !== third[k - 1]) glide("str2", R(b), third[k] + 31, glideSpeed(third[k - 1], third[k], 3));
    if (seventh[k] !== seventh[k - 1]) glide("str4", R(b), seventh[k], glideSpeed(seventh[k - 1], seventh[k], 3));
  }
  hit("str1", R(47), st("E5"), 40);   // the 9th harmonic
  hit("str3", R(48), st("Gt5"), 42);  // the 11th harmonic
  for (const s of STRS) keyOff(s, R(49));
  for (const p of PADS) keyOff(p, R(49));
  // Vibes: soft eighths through each chord.
  for (let b = 41; b <= 48; b++) {
    const k = b - 41;
    const tones = [st("D4"), st("A4"), seventh[k], third[k] + 31];
    if (b === 47) tones.push(st("E5"));
    if (b === 48) tones.push(st("E5"), st("Gt5"));
    const idx = b < 47 ? [0, 1, 2, 3, 2, 1, 3] : b === 47 ? [0, 1, 2, 3, 4, 3, 4] : [1, 2, 3, 4, 5, 4, 5];
    vibesBar(b, tones, idx, b < 45 ? 19 : 22);
  }
  keyOff("vib", R(49));
}
// Bass pedal, then driving eighths into the return.
melody("bass", R(41), "D2:28@44 | | D2:28@44 | | D2:14@46 | D2:14@48 |");
for (let b = 47; b <= 48; b++) for (let r = 0; r < 14; r += 2) hit("bass", R(b, r), r % 4 === 0 || r === 8 ? st("D2") : st("D3"), 42 + (b - 47) * 6 + (r === 0 ? 4 : 0));
// Drums: silence, then the build.
for (let b = 45; b <= 46; b++) {
  for (let r = 0; r < 14; r += 2) ride(b, r, "ride", r === 0 || r === 4 || r === 8 ? 24 : 16);
  dr("hat", b, 4, "hatP", 22); dr("hat", b, 10, "hatP", 22);
}
for (let b = 47; b <= 48; b++) for (let r = 0; r < 14; r += 2) dr("kick", b, r, "kick", 40 + (b - 47) * 10 + r);
// Snare roll: 32nds (retrigger every 3 ticks) swelling over two bars.
for (let r = 0; r < 24; r++) {
  const row = R(47) + r;
  const vol = Math.round(14 + (r * 40) / 23);
  if (r === 0) hit("snare", row, midiStep(GM.snare), vol, "Q", 0x0300);
  else { fx("snare", row, "Q", 0x0300); put("snare", row, { vol }); }
}
fillToms(48, 10);

// ════════════════════════════════════════════════════════════════════════════
// 49–56  THEME IN THE MAJOR — the subminor third becomes 5/4; 4:5:6:7 tonic
// ════════════════════════════════════════════════════════════════════════════
const THEME_MAJOR = THEME_MINOR.replaceAll("Fp5", "F#5");
melody("lead", R(49), THEME_MAJOR, { vol: 56 });
melody("flute", R(49), THEME_MAJOR, { vol: 17, transpose: 31, vib: [0x70, 0x10] });
dr("cym", 49, 0, "crash", 58);
dr("cym", 53, 0, "crash2", 50);
{
  let w = S(["D4", "F#4", "A4", "Cp4"]);
  for (let b = 49; b <= 56; b++) {
    const c = CH[b].name;
    grooveA(b, { variant: b % 2, tamb: true, open: b % 2 === 0 && b !== 56, fillFrom: b === 56 ? 10 : 14 });
    bassBar(b, c === "D7h" ? ((b - 49) % 4 === 0 ? "D7a" : "D7b") : c);
    epComp(b, EPV[c], b % 2 === 0);
    marimbaBar(b, MARV[c], 24);
    guitarBar(b, GTRV[c], -4);
    if (b === 49 || CH[b] !== CH[b - 1]) {
      if (b > 49) w = voiceLead(w, CH[b], st("A3"), st("A5"));
      holdChord(STRS, b, 0, w, 24, 0);
    }
    if (b === 49 || CH[b] !== CH[b - 1]) holdChord(PADS.slice(0, 3), b, 0, voiceLead([st("D3"), st("A3"), st("F#4")], CH[b], st("C3"), st("C5"), { n: 3 }), 35, 0);
  }
}
snareFill(56, 10, [36, 42, 48, 54]);

// ════════════════════════════════════════════════════════════════════════════
// 57–64  CODA — German sixth and dominant, both harmonic sevenths, then the
// harmonic series on D (4:5:6:7:9:11) while the clock runs down.
// ════════════════════════════════════════════════════════════════════════════
const TAG = `
  G#5:4v Bb5:2 D6:2 F6:2 G#6:4v |
  A6:6v Gp6:2 E6:2 C#6:2 A5:2 |
  Bb5:2 D6:2 F6:2 G#6:8v |
  A6:4v Gp6:2 E6:2 C#6:2 E6:2 Gp6:2 |
  ~F#6:28v`;
melody("lead", R(57), TAG, { vol: 54, glideRows: 3 });
melody("flute", R(57), TAG.replace("~F#6:28v", "D7:28v"), { vol: 24, transpose: -31, glideRows: 3 });
for (let r = R(62); r < R(63); r++) { volFineDown("lead", r, 3); volFineDown("flute", r, 2); }
dr("cym", 57, 0, "crash", 54);
{
  let w = S(["D4", "F#4", "A4", "Cp4"]);
  for (let b = 57; b <= 60; b++) {
    const c = CH[b].name;
    grooveA(b, { variant: b % 2, tamb: true, open: b === 58, fillFrom: b === 60 ? 4 : 14 });
    bassBar(b, c);
    epComp(b, EPV[c], b % 2 === 0);
    marimbaBar(b, MARV[c], 26);
    guitarBar(b, GTRV[c], -2);
    w = voiceLead(w, CH[b], st("A3"), st("A5"));
    holdChord(STRS, b, 0, w, 28, 0);
    holdChord(PADS.slice(0, 3), b, 0, voiceLead([st("D3"), st("A3"), st("F#4")], CH[b], st("C3"), st("C5"), { n: 3 }), 38, 0);
  }
}
snareFill(60, 4, [30, 0, 34, 38, 0, 42, 46, 50, 54, 58].filter(Boolean));
for (const [r, n, v] of [[5, "tomHi", 44], [8, "tomHM", 48], [11, "flHi", 52]]) dr("tom", 60, r, n, v);

// 61: the chord. Everyone strikes; then it rings down and the marimba keeps time.
dr("kick", 61, 0, "kick", 62);
dr("cym", 61, 0, "crash", 60);
dr("perc", 61, 0, "splash", 40);
hit("bass", R(61), st("D2"), 56);
keyOff("bass", R(63, 8));
holdChord(STRS, 61, 0, S(["D4", "Cp4", "E5", "Gt5"]), 34, 0);
holdChord(PADS, 61, 0, S(["D3", "A3", "F#4", "A4"]), 48, 0);
epChord(61, 0, S(["F#4", "A4", "Cp4", "E5"]), 40, 20);
for (const lane of [...STRS, ...PADS]) {
  for (let r = R(61, 6); r < R(64, 10); r++) volFineDown(lane, r, r < R(63) ? 1 : 2);
  keyOff(lane, R(64, 10));
}
vibesBar(61, S(["D4", "A4", "Cp4", "E5", "F#5", "Gt5"]), [0, 1, 2, 3, 4, 5, 4], 30);
vibesBar(62, S(["D4", "A4", "Cp4", "E5", "F#5", "Gt5"]), [3, 2, 1, 2, 3, 4, 3], 24);
keyOff("vib", R(63, 4));
for (let b = 61; b <= 64; b++) {
  marimbaBar(b, MARV.Doton, [36, 31, 26, 20][b - 61], { upto: b === 64 ? 4 : 14 });
}
hit("mar", R(64, 4), st("D3"), 22);
keyOff("mar", R(64, 12));
for (let b = 62; b <= 64; b++) {
  for (let r = 0; r < (b === 64 ? 6 : 14); r += 2) dr("hat", b, r, "hatC", [30, 24, 18][b - 62] + (r % 4 === 0 ? 4 : 0));
}

export { CH, lanes, L };
