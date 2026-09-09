// taudplay — the whole public surface, in one place.
//
// A .taud player for the browser and for Node, cut down from the Microtone
// tracker's engine to the part that PLAYS: one fader per voice, and two
// numbers per voice to look at.
//
//   import { TaudPlayer } from "taudplay";
//   const player = await new TaudPlayer().init();
//   await player.load(await (await fetch("song.taud")).arrayBuffer());
//   await player.resume();      // from a user gesture
//   player.play();
//   player.setVoiceGain(3, 0, 1500);   // fade channel 4 out over 1.5 s
//   player.getVoiceVolume(3);          // …and watch it go
//
// Copyright (C) 2026 CuriousTorvald. Licensed under the GNU Lesser General
// Public License version 3 or later — see COPYING.LESSER.

export { TaudPlayer } from "./player.js";
export { TaudRenderer, encodeWav } from "./render.js";
export { gainToFader, faderToGain } from "./faders.js";
export { SAMPLING_RATE } from "../engine/constants.js";
