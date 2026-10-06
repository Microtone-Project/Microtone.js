// Microtone Touch — the phone sketchpad, at its own site — and the tracker's
// links to it (the welcome screen, About).
//
// index.html sends a phone to Touch unless the tracker was asked for once
// (`tracker=1`, which Touch's and the player's "Open the tracker" links carry),
// and it remembers that choice. Following one of these links is the opposite
// choice, so it forgets it again: whichever of the two was chosen last is what
// microtone.cc opens on that phone. Anywhere else nothing was remembered, and
// forgetting it does nothing.

export const TOUCH_URL = "https://touch.microtone.cc/";
const STAY_KEY = "microtone-tracker-on-phone"; // index.html's phone redirect

function forgetTracker() {
  try { localStorage.removeItem(STAY_KEY); } catch { /* private mode: nothing was kept */ }
}

/** Make `a` a link to Touch, opening beside the tracker. → `a`. */
export function linkTouch(a) {
  a.href = TOUCH_URL;
  a.target = "_blank";
  a.rel = "noopener";
  a.addEventListener("click", forgetTracker);
  a.addEventListener("auxclick", forgetTracker); // a middle click opens it too
  return a;
}
