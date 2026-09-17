// Item 156 — one look for every value control in the app.
//
// A browser's native number field and dropdown are drawn by the platform, so
// they never matched the pushbuttons beside them and looked different again on
// every OS. Both are rebuilt here as button GROUPS, which is what the app's own
// chrome already is:
//
//   ┌─┬───┬─┐        ┌─┬───┬─┐
//   │–│123│+│        │◄│abc│►│
//   └─┴───┴─┘        └─┴───┴─┘
//
// The native element is KEPT, not replaced: an `<input type="number">` stays a
// real number field (typing, ↑/↓, min/max/step validation, the mobile numeric
// keypad) and a `<select>` stays a real select (its option list, its keyboard
// handling, its type-ahead, its accessibility tree). Each is stripped of the
// platform's own chrome and slotted between two step buttons as the middle
// segment of the group. So every call site keeps working unchanged: the same
// element, the same `.value`, the same listeners.
//
// Enhancement is automatic. `startControlEnhancer()` watches the document and
// upgrades controls as views build them, so a control added anywhere gets the
// look without its author having to ask. Opt a control out with data-mt="off".

/** Steps per second while a − / + button is held, and when the ramp kicks in. */
const HOLD_DELAY_MS = 400;
const HOLD_RATE_MS = 60;
const HOLD_FAST_AFTER_MS = 1200;
const HOLD_FAST_MS = 22;

/** Per-input value↔display mapping (see mapSpinner). */
const maps = new WeakMap();

/**
 * Give a number field an arbitrary mapping between the value the DOCUMENT
 * stores and the number a person reads (item 156.2). − / + walk the stored
 * units — one minifloat step, one mix octet, one hex count — while the box
 * shows what that lands on: seconds, decibels, whatever the field is really
 * about. Typing goes the other way through `fromDisplay`.
 *
 *   toDisplay(raw)        → the string to show (required)
 *   fromDisplay(text)     → the raw value a typed string means (required)
 *   step(raw, dir)        → the raw value one press of ∓ lands on (required)
 *
 * The input's own `value` is the DISPLAY text throughout, so existing readers
 * see what the user sees; `rawValue` on the element carries the stored number.
 */
export function mapSpinner(input, map, raw) {
  maps.set(input, map);
  // A mapped field shows a SENTENCE, not a number — "0.320 s", "−∞ dB" — so it
  // stops being a native number input. Nothing is lost: the mapping owns the
  // range and the rounding, which is what min/max/step were doing.
  input.type = "text";
  input.inputMode = map.inputMode ?? "decimal";
  input.dataset.mtSpin = "1";
  setMapped(input, raw);
  // The enhancer watches for nodes being ADDED, so a field mapped after it is
  // already in the document would otherwise stay bare until something else
  // moved it. (A field mapped before insertion is caught on insertion.)
  enhanceControls(input);
  if (!input.dataset.mtMapListener) {
    input.dataset.mtMapListener = "1";
    // Typing writes the raw value back, so a step from there is measured in
    // stored units rather than from a stale one, and the box settles on the
    // exact value that landed rather than on what was typed at it.
    input.addEventListener("change", () => {
      const m = maps.get(input);
      if (!m) return;
      // A step already put the exact raw value there; re-reading its own text
      // would round-trip through the display's precision and could land on a
      // neighbouring code. Only a HAND edit needs mapping back.
      if (input.value === m.toDisplay(input.rawValue)) return;
      setMapped(input, m.fromDisplay(input.value));
    });
  }
  return input;
}

/** Put `raw` on a mapped input: stored value on the element, text in the box. */
export function setMapped(input, raw) {
  const m = maps.get(input);
  if (!m) return;
  input.rawValue = raw;
  input.value = m.toDisplay(raw);
  if (input.dataset.mt === "on") fitAlign(input);
}

// ── the two groups ────────────────────────────────────────────────────────

function stepButton(label, title) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mt-step";
  b.textContent = label;
  // Not a tab stop: the field between them already steps on ↑ / ↓, so putting
  // the arrows in the tab order would only make every form twice as long to
  // walk without reaching anything new.
  b.tabIndex = -1;
  b.setAttribute("aria-hidden", "true");
  if (title) b.title = title;
  return b;
}

/**
 * Centre the value, unless it does not fit — then anchor it to the left, where
 * the beginning of a long name or a big number is worth more than its end.
 *
 * There is no CSS for "centre until it overflows" inside a form control (flex's
 * `safe center` does not reach a control's own text), so it is measured:
 * `scrollWidth` tracks the SELECTED value on both an <input> and a <select>,
 * so this is per-value rather than per-widest-option. The class is only ever
 * toggled when it actually changes, which keeps a whole view's worth of these
 * to a single layout pass instead of one per control.
 */
function fitAlign(el) {
  const over = el.scrollWidth > el.clientWidth + 1;
  if (over !== el.classList.contains("mt-clip")) el.classList.toggle("mt-clip", over);
}

/** Fire the events a hand-typed edit would, so existing listeners run. */
function announce(el) {
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Press-and-hold repeat on `btn`, calling `act()` once per step. */
function holdRepeat(btn, act) {
  let timer = null;
  let start = 0;
  const stop = () => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  };
  const tick = () => {
    act();
    const held = Date.now() - start;
    timer = setTimeout(tick, held > HOLD_FAST_AFTER_MS ? HOLD_FAST_MS : HOLD_RATE_MS);
  };
  btn.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || btn.disabled) return;
    e.preventDefault(); // no focus steal: the field keeps the caret
    start = Date.now();
    act();
    timer = setTimeout(tick, HOLD_DELAY_MS);
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) {
    btn.addEventListener(ev, stop);
  }
  // A pointer released outside the button never delivers pointerup TO it.
  window.addEventListener("pointerup", stop);
}

// ── reading a number the way a tracker writes one ─────────────────────────
// Half these fields carry a `$xx` annotation, and the effect column, the
// pattern grid and every manual page speak hex — so a spinner takes `$FF` and
// `0xFF` as readily as 255, with a sign in front of either. Everything else is
// plain decimal, floats included.

const HEX_TEXT = /^([+-]?)(?:\$|0[xX])([0-9a-fA-F]+)$/;

/** A typed value as a number: decimal, `$FF`, `0xFF`, or NaN if it is neither. */
export function parseNumberText(text) {
  const t = String(text ?? "").trim();
  if (t === "") return NaN;
  const m = HEX_TEXT.exec(t);
  if (m !== null) {
    const v = Number.parseInt(m[2], 16);
    return m[1] === "-" ? -v : v;
  }
  return Number(t);
}

/** A finite number from an attribute, or NaN. */
function attrNum(v) {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
}

/** Decimal places the step implies, so stepping cannot accrete float noise. */
function stepDecimals(step) {
  const s = String(step);
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * Where one press of ∓ lands: the next value ON the step grid, measured from
 * `min` (or 0), clamped to the ends. This is what `stepUp()`/`stepDown()` were
 * doing before the field stopped being a number input — including their rule
 * that an off-grid value snaps ONTO the grid rather than skipping a whole step
 * past it.
 */
function stepFrom(input, dir) {
  const step = attrNum(input.step) || 1;          // step="any" → 1, as before
  const min = attrNum(input.min);
  const max = attrNum(input.max);
  const base = Number.isFinite(min) ? min : 0;
  const cur = parseNumberText(input.value);
  if (!Number.isFinite(cur)) return Number.isFinite(min) ? min : 0;
  const n = (cur - base) / step;
  // The epsilon is for a value that IS on the grid but lands a hair off it
  // through binary division — without it every other press would stand still.
  let next = dir > 0
    ? base + (Math.floor(n + 1e-9) + 1) * step
    : base + (Math.ceil(n - 1e-9) - 1) * step;
  if (Number.isFinite(min)) next = Math.max(next, min);
  if (Number.isFinite(max)) next = Math.min(next, max);
  const dp = stepDecimals(step);
  return dp > 0 ? Number(next.toFixed(Math.min(dp, 12))) : Math.round(next);
}

/** The last text this field committed, to fall back on when the next is junk. */
const lastGood = new WeakMap();

/**
 * Settle a hand-typed value, BEFORE the call site's own change listener reads
 * it: `$FF` and `0xFF` become the number they name, so everything downstream
 * sees exactly what a typed 255 would have given it. Text that is not a number
 * at all puts the last good value back — a native number field blanked itself
 * here, and every call site read that blank as 0.
 *
 * A rewrite is announced with an `input` event, because several fields commit
 * on `input` and never listen for `change` at all (the chord maker's notes,
 * the panner, the export cap). Without it they would keep the 0 that `$FF`
 * parsed to while it was still `$FF`.
 */
function normaliseNumber(input) {
  if (maps.has(input)) return; // a mapping owns its own text
  const before = input.value;
  const v = parseNumberText(before);
  if (Number.isFinite(v)) {
    const text = String(v);
    if (before !== text) input.value = text;
    lastGood.set(input, text);
  } else {
    const min = attrNum(input.min);
    input.value = lastGood.get(input) ?? (Number.isFinite(min) ? String(min) : "");
  }
  if (input.value !== before) {
    fitAlign(input);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function stepNumber(input, dir) {
  if (input.disabled || input.readOnly) return;
  const m = maps.get(input);
  if (m) {
    setMapped(input, m.step(input.rawValue, dir));
    announce(input);
    return;
  }
  input.value = String(stepFrom(input, dir));
  lastGood.set(input, input.value);
  fitAlign(input);
  announce(input);
}

function upgradeNumber(input) {
  // A native number field cannot HOLD "$FF": its value sanitiser blanks
  // anything that is not a plain decimal number, and there is no way to read
  // the typed text back out of it. So the field becomes a text one and this
  // module takes over what the browser was doing — the step grid, the min/max
  // ends, and refusing what does not parse. (A mapped field is already text.)
  if (input.type === "number") {
    input.type = "text";
    if (!input.inputMode) input.inputMode = "decimal";
  }
  const group = document.createElement("span");
  group.className = "mt-spin";
  const dec = stepButton("–", input.dataset.mtDecTitle ?? "");
  const inc = stepButton("+", input.dataset.mtIncTitle ?? "");
  input.replaceWith(group);
  group.append(dec, input, inc);
  holdRepeat(dec, () => stepNumber(input, -1));
  holdRepeat(inc, () => stepNumber(input, +1));
  const sync = () => {
    dec.disabled = inc.disabled = input.disabled || input.readOnly;
    group.hidden = input.hidden;
    fitAlign(input);
  };
  // Typing changes what fits as surely as stepping does.
  input.addEventListener("input", () => fitAlign(input));
  // Settle the typed text on the GROUP, in the capture phase: a listener bound
  // to the input itself would run after the call site's own (which was bound
  // first, when the field was built), and that one must never see a `$FF`.
  group.addEventListener("change", () => normaliseNumber(input), true);
  if (Number.isFinite(parseNumberText(input.value))) lastGood.set(input, input.value);
  sync();
  input.mtSync = sync;
  return group;
}

/** The next option index in `dir` that can actually be selected, or -1. */
function nextIndex(sel, dir) {
  for (let i = sel.selectedIndex + dir; i >= 0 && i < sel.options.length; i += dir) {
    const o = sel.options[i];
    if (!o.disabled && !(o.parentElement instanceof HTMLOptGroupElement && o.parentElement.disabled)) {
      return i;
    }
  }
  return -1;
}

function stepSelect(sel, dir) {
  if (sel.disabled) return;
  const i = nextIndex(sel, dir);
  if (i < 0) return;
  sel.selectedIndex = i;
  announce(sel);
}

function upgradeSelect(sel) {
  const group = document.createElement("span");
  group.className = "mt-pick";
  const prev = stepButton("◄", "");
  const next = stepButton("►", "");
  sel.replaceWith(group);
  // The select itself is the middle segment — `appearance: none` takes the
  // platform's chrome off it and leaves the app's own type and colours, and it
  // still sizes itself to its widest option, so the group lands exactly where
  // the plain dropdown did. Clicking it opens the real option list, which is
  // the one part of a dropdown nothing hand-built does as well: keyboard
  // navigation, type-ahead, the OS picker on a phone.
  group.append(prev, sel, next);
  holdRepeat(prev, () => stepSelect(sel, -1));
  holdRepeat(next, () => stepSelect(sel, +1));
  const sync = () => {
    prev.disabled = sel.disabled || nextIndex(sel, -1) < 0;
    next.disabled = sel.disabled || nextIndex(sel, +1) < 0;
    group.hidden = sel.hidden;
    fitAlign(sel);
  };
  sel.addEventListener("change", sync);
  sel.mtSync = sync;
  sync();
  return group;
}

// ── the enhancer ──────────────────────────────────────────────────────────

const SELECTOR = 'input[type="number"], input[data-mt-spin], select';

function upgradable(el) {
  if (el.dataset.mt === "off" || el.dataset.mt === "on") return false;
  if (el.closest("[data-mt='off']")) return false;
  if (el.tagName === "SELECT" && el.multiple) return false;
  if (el.tagName === "SELECT" && el.size > 1) return false;
  return el.isConnected;
}

/** Upgrade every not-yet-upgraded control in `root` (which may be a control). */
export function enhanceControls(root = document) {
  const list = [];
  if (root.matches?.(SELECTOR)) list.push(root);
  for (const el of root.querySelectorAll?.(SELECTOR) ?? []) list.push(el);
  for (const el of list) {
    if (!upgradable(el)) continue;
    el.dataset.mt = "on";
    if (el.tagName === "SELECT") upgradeSelect(el);
    else upgradeNumber(el);
  }
}

/** Re-read every upgraded control's state — options replaced, disabled flipped. */
export function syncControls(root = document) {
  for (const el of root.querySelectorAll?.("[data-mt='on']") ?? []) el.mtSync?.();
}

let observer = null;

/**
 * Watch `root` and upgrade controls as they appear.
 *
 * Batched on a MICROTASK, not an animation frame: a view rebuild replaces
 * hundreds of nodes at once and every one of them would otherwise be its own
 * pass, but waiting for a frame would also let the browser paint the bare
 * control first — a flash of platform chrome on every rebuild. A microtask runs
 * before the paint and before any layout the caller goes on to measure.
 *
 * And it works from the mutation records rather than re-scanning the document:
 * the transport readouts rewrite their text sixty times a second, which is
 * sixty batches of records carrying nothing but text nodes. Those cost one type
 * check each here; a whole-document querySelectorAll twice a frame is a real
 * bill on a tablet.
 */
export function startControlEnhancer(root = document.body) {
  if (observer !== null) return observer;
  const doc = root.ownerDocument ?? document;
  const roots = new Set();  // freshly added subtrees to look in
  const stale = new Set();  // upgraded controls whose own children changed
  let queued = false;
  const flush = () => {
    queued = false;
    for (const el of roots) if (el.isConnected) enhanceControls(el);
    for (const el of stale) el.mtSync?.();
    roots.clear();
    stale.clear();
  };
  observer = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) if (n.nodeType === 1) roots.add(n);
      if (r.type === "attributes") {
        if (r.target.dataset?.mt === "on") stale.add(r.target);
        continue;
      }
      // An upgraded control whose own children moved — a <select> whose option
      // list was rebuilt — has to re-read which way its arrows can go.
      if (r.target.nodeType === 1) {
        const owner = r.target.closest("[data-mt='on']");
        if (owner !== null) stale.add(owner);
      }
    }
    if (queued || (roots.size === 0 && stale.size === 0)) return;
    queued = true;
    queueMicrotask(flush);
  });
  // `disabled` and `hidden` are watched as well as the tree, because both are
  // things a caller does to the CONTROL that the GROUP round it has to follow:
  // greying the arrows out, and going away entirely. A caller that hides a
  // control has no idea it is wrapped — `el.hidden = true` has to keep meaning
  // what it always meant (the chord maker hides three of its four value fields
  // to show the fourth), and neither is a node change the tree observer sees.
  observer.observe(root, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ["disabled", "hidden"],
  });
  enhanceControls(doc);
  return observer;
}

export function stopControlEnhancer() {
  observer?.disconnect();
  observer = null;
}
