// The splitter between the song and the keyboard, and the orientation knob on
// it.
//
// Two arrangements: STACKED (song above, keyboard below) and SIDE BY SIDE
// (song left, keyboard right). Which one is a choice remembered per screen
// orientation — a phone held upright starts stacked, turned on its side it
// starts side by side, and the knob overrides only the orientation the screen
// is in — and each of the four (upright or sideways, stacked or side by side)
// keeps its own split, so turning the phone back and forth gives each its own
// layout back. Dragging the bar moves the split; a double-tap puts it back.
//
// Side by side, a second knob picks the HAND: the keyboard on the right (the
// default) or on the left, for whoever plays with their left. That is one
// choice per person, not per orientation. Stacked there is no such knob — the
// keyboard is always the bottom panel.
//
// A folded device that reports screen segments is NOT ours to arrange: the
// song and the keyboard each take a segment (touch.css), and the bar hides.
// A device that reports a folded posture without segments keeps the bar, and
// only starts with the keyboard taking the larger share.

const SHARE_MIN = 0.2;
const SHARE_MAX = 0.8;
const DRAG_SLOP = 5; // px a press may wander and still count as a tap

const SEGMENTED = "(horizontal-viewport-segments: 2), (vertical-viewport-segments: 2)";

/**
 * `els` = { app, song, keys, bar, knob, handKnob }; `prefs` is the page's
 * preference object (this adds `split`, `share` and `hand` to it) and
 * `save()` persists it.
 */
export function initSplit(els, prefs, save) {
  const { app, song, keys, bar, knob, handKnob } = els;
  prefs.split = prefs.split && typeof prefs.split === "object" ? prefs.split : {};
  prefs.share = prefs.share && typeof prefs.share === "object" ? prefs.share : {};
  prefs.hand = prefs.hand === "left" ? "left" : "right";

  const landscape = matchMedia("(orientation: landscape)");
  const segmented = matchMedia(SEGMENTED);
  const screenKey = () => (landscape.matches ? "landscape" : "portrait");
  const arrangement = () =>
    prefs.split[screenKey()] ?? (landscape.matches ? "cols" : "rows");
  const folded = () => document.documentElement.dataset.posture === "folded";
  const defaultShare = (mode) => (folded() ? 0.42 : mode === "cols" ? 0.5 : 0.52);
  const clampShare = (v) => Math.min(SHARE_MAX, Math.max(SHARE_MIN, v));

  /** The split's key: the screen orientation and the arrangement in it. */
  const shareKey = () => `${screenKey()}-${arrangement()}`;
  /** Side by side with the keyboard on the left: the song is on the right,
   *  so a split measured from the left edge belongs to the keyboard. */
  const mirrored = () => arrangement() === "cols" && prefs.hand === "left";

  function apply() {
    const mode = arrangement();
    if (app.dataset.split !== mode) app.dataset.split = mode;
    if (app.dataset.hand !== prefs.hand) app.dataset.hand = prefs.hand;
    const share = clampShare(prefs.share[shareKey()] ?? defaultShare(mode));
    // Flex-grow on a zero basis: the two panes divide what the bar leaves.
    song.style.flexGrow = String(share);
    keys.style.flexGrow = String(1 - share);
    bar.setAttribute("aria-orientation", mode === "cols" ? "vertical" : "horizontal");
    bar.setAttribute("aria-valuenow", String(Math.round(share * 100)));
    knob.textContent = mode === "cols" ? "⇅" : "⇄";
    knob.title = mode === "cols" ? "Song above the keyboard" : "Song beside the keyboard";
    knob.setAttribute("aria-label", knob.title);
    const toLeft = prefs.hand === "right";
    handKnob.textContent = "⇆";
    handKnob.title = toLeft ? "Keyboard on the left (left-handed)" : "Keyboard on the right (right-handed)";
    handKnob.setAttribute("aria-label", handKnob.title);
    handKnob.setAttribute("aria-pressed", String(prefs.hand === "left"));
  }

  function setShare(v) {
    prefs.share[shareKey()] = clampShare(v);
    apply();
  }

  function flip() {
    prefs.split[screenKey()] = arrangement() === "cols" ? "rows" : "cols";
    apply();
    save();
  }

  /** Swap the hands — side by side only; stacked, the keyboard stays below. */
  function swapHands() {
    if (arrangement() !== "cols") return;
    prefs.hand = prefs.hand === "left" ? "right" : "left";
    apply();
    save();
  }

  const knobOf = (target) => (knob.contains(target) ? flip : handKnob.contains(target) ? swapHands : null);

  // ── dragging ──
  let drag = null; // { id, x, y, moved, tap: what a tap on the knob under it does }
  bar.addEventListener("pointerdown", (e) => {
    if (segmented.matches) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, tap: knobOf(e.target) };
    try { bar.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    e.preventDefault();
  });
  bar.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_SLOP) return;
    drag.moved = true;
    const box = app.getBoundingClientRect();
    const barSize = arrangement() === "cols" ? bar.offsetWidth : bar.offsetHeight;
    const along = arrangement() === "cols"
      ? (e.clientX - box.left - barSize / 2) / (box.width - barSize)
      : (e.clientY - box.top - barSize / 2) / (box.height - barSize);
    setShare(mirrored() ? 1 - along : along);
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { moved, tap } = drag;
    drag = null;
    if (moved) save();
    else if (tap && e.type === "pointerup") tap();
  };
  bar.addEventListener("pointerup", end);
  bar.addEventListener("pointercancel", end);
  bar.addEventListener("dblclick", (e) => {
    if (knobOf(e.target)) return;
    delete prefs.share[shareKey()];
    apply();
    save();
  });
  // Keyboard: arrows move the split, Enter or Space on the knob flips.
  bar.addEventListener("keydown", (e) => {
    let step = { ArrowUp: -0.05, ArrowLeft: -0.05, ArrowDown: 0.05, ArrowRight: 0.05 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    if (mirrored()) step = -step; // the bar moves the way the arrow points
    setShare((prefs.share[shareKey()] ?? defaultShare(arrangement())) + step);
    save();
  });
  for (const [el, act] of [[knob, flip], [handKnob, swapHands]]) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(); }
    });
  }

  landscape.addEventListener("change", apply);
  segmented.addEventListener("change", apply);
  navigator.devicePosture?.addEventListener("change", apply);
  apply();
  return { apply, flip, swapHands, setShare, arrangement };
}
