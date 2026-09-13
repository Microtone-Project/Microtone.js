// The keymap library — where layouts live, and how the app remembers which one
// you play on.
//
// Keymaps are a PERFORMER preference. They never enter the .taud, they survive
// switching songs, and they persist the way the theme and the language do: a
// localStorage key for the choice, OPFS for the user's own layouts. Nothing
// here is undoable, because nothing here is part of a document.
//
// Two preferences, both app-level:
//   microtone-keymap       the active layout's name (built-in or saved)
//   microtone-quotekey     what the Quote key writes (keymap.js QUOTE_ACTIONS)
//   microtone-keymaportho  draw the board in columns, for ortholinear keyboards
//
// Private-mode browsers throw on localStorage and have no OPFS; every access
// below degrades to the shipped built-ins rather than failing, which is the
// same bargain the File tab makes.

import * as opfs from "../storage/opfs.js";
import { sanitiseName } from "../audio/stem-export.js";
import {
  BUILTIN_KEYMAPS, DEFAULT_KEYMAP, QUOTE_ACTIONS, QUOTE_DEFAULT,
  buildTaudkey, parseTaudkey, fitKeymapToPreset, normaliseKeymap,
} from "./keymap.js";

export const KEYMAP_PREF = "microtone-keymap";
export const QUOTE_PREF = "microtone-quotekey";
export const ORTHO_PREF = "microtone-keymaportho";
const EXT = ".taudkey";

function loadPref(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function savePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

/** OPFS file name for a layout. The spec's real name lives INSIDE the file, so
 *  this only has to be unique and safe — a name with a slash in it is fine. */
export const keymapFileName = (name) => sanitiseName(name, "keymap") + EXT;

export class KeymapLibrary {
  constructor(store) {
    this.store = store;
    /** Saved layouts: name → spec. */
    this.user = new Map();
    this.available = false;
    /** The layout the user PICKED, as opposed to `activeName`, which is what a
     *  song's own tuning may have put on top of it for now. */
    this.chosenName = DEFAULT_KEYMAP.name;
    this.activeName = DEFAULT_KEYMAP.name;
    /** Has init() read the saved choice yet? Until it has, a song load cannot
     *  be answered — see applyForPreset. */
    this._ready = false;
    this._pending = null;
  }

  /** Built-ins then saved layouts, each tagged with whether it can be edited. */
  entries() {
    return [
      ...BUILTIN_KEYMAPS.map((spec) => ({ name: spec.name, spec, builtin: true })),
      ...[...this.user.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((spec) => ({ name: spec.name, spec, builtin: false })),
    ];
  }

  /** A saved layout shadows a built-in of the same name — you can supersede
   *  "Harmonic Table" with your own without having to rename it. */
  find(name) {
    return this.user.get(name) ?? BUILTIN_KEYMAPS.find((k) => k.name === name) ?? null;
  }

  /** Layouts that declare themselves for `notation`, best first. */
  forNotation(notation) {
    return this.entries()
      .filter((e) => e.spec.notation === notation)
      .map((e) => e.spec);
  }

  // ── persistence ──

  async refresh() {
    this.user.clear();
    this.available = await opfs.available();
    if (!this.available) return this;
    for (const file of await opfs.listKeymaps()) {
      try {
        const spec = parseTaudkey(await opfs.readKeymap(file));
        this.user.set(spec.name, spec);
      } catch {
        // A layout we cannot read is one the user can still delete from the
        // tab; skipping it keeps one bad file from emptying the library.
      }
    }
    return this;
  }

  async save(spec) {
    const clean = normaliseKeymap(spec);
    this.user.set(clean.name, clean);
    if (this.available) {
      await opfs.writeKeymap(keymapFileName(clean.name), buildTaudkey(clean));
    }
    return clean;
  }

  async remove(name) {
    this.user.delete(name);
    if (this.available) await opfs.removeKeymap(keymapFileName(name));
  }

  /** A name nothing else in the library is using. */
  uniqueName(base) {
    const taken = new Set(this.entries().map((e) => e.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base} ${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  // ── the active layout ──

  /**
   * Make `spec` the layout the keyboard plays. Fitted to the tuning first, so
   * "Octave rows" means octaves of THIS tuning; the name is what persists, not
   * the fitted copy, since the fit has to happen again for the next song.
   */
  setActive(spec, preset = this.store.pitchPreset, persist = true) {
    const fitted = fitKeymapToPreset(spec ?? DEFAULT_KEYMAP, preset);
    this.store.keymap = fitted;
    this.activeName = (spec ?? DEFAULT_KEYMAP).name;
    // Two different questions, and keeping them apart is what stops a layout
    // that volunteered for one song from following you into the next:
    // `activeName` is what is PLAYING, `chosenName` is what you PICKED. Only an
    // explicit choice moves the second, and only the second is remembered — so
    // the next launch comes up on the layout you chose rather than on whatever
    // the last song happened to want.
    if (persist) {
      this.chosenName = this.activeName;
      savePref(KEYMAP_PREF, this.chosenName);
    }
    this.store.emit?.("keymap");
    return fitted;
  }

  /** Ortholinear drawing on or off — the board's shape, not the layout's. */
  setOrtho(on) {
    this.store.keymapOrtho = !!on;
    savePref(ORTHO_PREF, on ? "1" : "0");
    this.store.emit?.("keymap");
    return this.store.keymapOrtho;
  }

  setQuoteKey(action) {
    const clean = QUOTE_ACTIONS.includes(action) ? action : QUOTE_DEFAULT;
    this.store.quoteKey = clean;
    savePref(QUOTE_PREF, clean);
    this.store.emit?.("keymap");
    return clean;
  }

  /**
   * Re-apply the layout against a (possibly new) tuning, and honour one that
   * declares itself for it: opening a Shi'er lü song brings up the Shi'er lü
   * keyboard without anyone going to fetch it.
   *
   * Always computed from the CHOSEN layout, never from whatever is currently
   * playing. Otherwise a volunteer would be sticky — auto-select it for its own
   * tuning once, and it would still be there on the next song, which has no
   * layout of its own to displace it. Leaving a bound tuning therefore hands
   * the keyboard back to the layout you actually picked.
   */
  applyForPreset(preset, notation = null) {
    // A ?load= boot reaches here before init() has read the saved choice, and
    // acting on an unknown name would answer "Piano" for a moment and — worse,
    // before the persist rule above — write it over the real one. Hold the
    // request instead; init() replays it once it knows what was chosen.
    if (!this._ready) { this._pending = { preset, notation }; return null; }
    const chosen = this.find(this.chosenName) ?? DEFAULT_KEYMAP;
    if (notation !== null && chosen.notation !== notation) {
      const volunteer = this.forNotation(notation)[0];
      if (volunteer) return this.setActive(volunteer, preset, false);
    }
    return this.setActive(chosen, preset, false);
  }

  /** Restore both preferences at boot. */
  async init(preset) {
    await this.refresh();
    this.chosenName = loadPref(KEYMAP_PREF) ?? DEFAULT_KEYMAP.name;
    this.setQuoteKey(loadPref(QUOTE_PREF) ?? QUOTE_DEFAULT);
    this.setOrtho(loadPref(ORTHO_PREF) === "1");
    this.setActive(this.find(this.chosenName) ?? DEFAULT_KEYMAP, preset, false);
    this._ready = true;
    const held = this._pending;
    this._pending = null;
    if (held) this.applyForPreset(held.preset, held.notation);
    return this;
  }
}
