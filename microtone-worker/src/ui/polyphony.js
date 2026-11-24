// The polyphony limit (item 355): how many background voices — the ghosts a
// New Note Action leaves ringing, a layered instrument's further layers, an FM
// rack's operators — may sound at once, beyond the lanes' own voices.
//
// The engine's default is MAX_BG_VOICES (64), and the website keeps it: a
// browser's audio thread has the budget it has. The desktop app runs the
// engine natively and offers POLYPHONY_CHOICES in its Settings tab, starting
// at POLYPHONY_DESKTOP. The choice is the computer's, like the audio device:
// kept per installation (localStorage), never in a song. Playback and every
// export from the page use the same limit, so a render sounds as playback did.

import {
  MAX_BG_VOICES, POLYPHONY_CHOICES, POLYPHONY_DESKTOP,
} from "../../core/engine/constants.js";
import { setRenderPolyphony } from "../../core/audio/offline-render.js";

const KEY = "microtone-polyphony";

/** Whether this page may choose: only where the desktop shell runs the engine. */
export function polyphonyChoosable(host = globalThis) {
  return !!host.__MICROTONE_NATIVE__?.engine;
}

/** The limit in force: the saved choice on the desktop (POLYPHONY_DESKTOP
 *  until one is made), MAX_BG_VOICES everywhere else. */
export function polyphonySetting(host = globalThis) {
  if (!polyphonyChoosable(host)) return MAX_BG_VOICES;
  let saved = NaN;
  try { saved = Number(host.localStorage?.getItem(KEY)); } catch { /* private window */ }
  return POLYPHONY_CHOICES.includes(saved) ? saved : POLYPHONY_DESKTOP;
}

/** Apply the limit in force to offline renders and, when given, the live
 *  engine. Called at start-up and on every change. */
export function applyPolyphony(audio = null, host = globalThis) {
  const n = polyphonySetting(host);
  setRenderPolyphony(n);
  audio?.setPolyphony(n);
  return n;
}

/** Choose a limit (one of POLYPHONY_CHOICES) and apply it. */
export function choosePolyphony(n, audio = null, host = globalThis) {
  if (!POLYPHONY_CHOICES.includes(n) || !polyphonyChoosable(host)) return polyphonySetting(host);
  try { host.localStorage?.setItem(KEY, String(n)); } catch { /* private window */ }
  return applyPolyphony(audio, host);
}
