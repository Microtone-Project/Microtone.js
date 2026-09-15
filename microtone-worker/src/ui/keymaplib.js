// The keymap library — where layouts live, and how the app remembers which one
// you play on.
//
// Keymaps are a PERFORMER preference. They survive switching songs, and they
// persist the way the theme and the language do: a localStorage key for the
// choice, OPFS for the user's own layouts. Nothing here is undoable, because
// nothing here is part of a document.
//
// With ONE exception, and it is a deliberate one: a project may carry a layout
// of its own (item 189.1, the `PKey` section). A piece written for a nine-note
// unequal tuning on a split four-row board is unplayable on anything else, so
// the layout is part of what the piece needs — and a listener who opens the
// .taud gets the keyboard it was written on without being sent to fetch a file.
// That copy lives in the document; the library only READS it, lists it beside
// the others and lets it volunteer. Writing it is the Keymap tab's job, as one
// undoable document edit.
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

import { KEYMAP_FOURCC } from "../format/taud-const.js";
export { KEYMAP_FOURCC };

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

    // The song's tuning can change WITHOUT a song being loaded — the Project
    // tab's notation picker, a retune, the Notation Maker. All three announce
    // it the same way, so the rule lives here once rather than at each call
    // site: whenever the tuning moves, re-fit the layout and let one bound to
    // the new tuning volunteer.
    store.on("doc", () => this.applyForPreset(store.pitchPreset, this.songNotation()));

    // …and so can the layout the PROJECT carries (item 189.1) — embedding one,
    // taking it back out, and either of those being undone or redone all arrive
    // as the same section edit. Listened for here rather than at the Keymap
    // tab, because Ctrl+Z lands wherever the user happens to be standing.
    store.on("edit", (dirty) => {
      if (!Array.isArray(dirty)) return;
      if (dirty.some((tag) => tag?.kind === "section" && tag.fourcc === KEYMAP_FOURCC)) {
        this.applyForPreset(store.pitchPreset, this.songNotation());
      }
    });
  }

  /** The notation the open song is written in, or null when there is none. */
  songNotation() {
    const sm = this.store.doc?.meta?.songMeta?.[this.store.songIndex];
    return Number.isFinite(sm?.notation) ? sm.notation : null;
  }

  /**
   * The layout the OPEN PROJECT carries (item 189.1), or null. Cached by the
   * section text, so undo/redo — which swaps the payload — invalidates it by
   * itself, and the forty-odd keys are not re-parsed on every list redraw.
   *
   * A layout the file says is newer than this build reads, or one that is
   * simply malformed, comes back null rather than throwing: the song still
   * plays, and the keyboard falls back to the one the user chose.
   */
  projectKeymap() {
    const text = this.store.doc?.embeddedKeymap() ?? null;
    if (this._project?.text !== text) {
      let spec = null;
      if (text !== null) { try { spec = parseTaudkey(text); } catch { spec = null; } }
      this._project = { text, spec };
    }
    return this._project.spec;
  }

  /** Built-ins, the project's own layout, then saved layouts — each tagged with
   *  where it came from, which is what decides whether it can be edited. */
  entries() {
    const project = this.projectKeymap();
    return [
      ...BUILTIN_KEYMAPS.map((spec) => ({ name: spec.name, spec, builtin: true })),
      ...(project ? [{ name: project.name, spec: project, builtin: false, project: true }] : []),
      ...[...this.user.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((spec) => ({ name: spec.name, spec, builtin: false })),
    ];
  }

  /** A saved layout shadows a built-in of the same name — you can supersede
   *  "Harmonic Table" with your own without having to rename it — and the
   *  project's own copy is the last resort, so saving one under its name keeps
   *  editing yours rather than the song's snapshot. */
  find(name) {
    const project = this.projectKeymap();
    return this.user.get(name)
      ?? BUILTIN_KEYMAPS.find((k) => k.name === name)
      ?? (project?.name === name ? project : null);
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

  /**
   * Is `name` already used by a SAVED layout other than `except`? Built-ins are
   * deliberately NOT consulted: a saved layout shadowing one of them is a
   * feature (see find), so renaming yours to "Harmonic Table" is allowed.
   */
  savedNameTaken(name, except = null) {
    return this.user.has(name) && name !== except;
  }

  /**
   * Rename a saved layout, moving its file with it. Built-ins cannot be
   * renamed — duplicate one first, which is what the button offers.
   *
   * The two preferences key on the NAME, so a rename of the layout you are on
   * has to carry them along or the next launch would look for a layout that no
   * longer exists and quietly fall back to the default.
   */
  async rename(oldName, newName) {
    const spec = this.user.get(oldName);
    const name = String(newName ?? "").trim();
    if (!spec || !name || name === oldName) return null;
    const next = normaliseKeymap({ ...spec, name });
    await this.remove(oldName);
    await this.save(next);
    if (this.activeName === oldName) this.activeName = name;
    if (this.chosenName === oldName) {
      this.chosenName = name;
      savePref(KEYMAP_PREF, name);
    }
    return next;
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
   * volunteers for the song: the layout the PROJECT carries first, then one
   * that declares itself for the song's notation — so opening a Shi'er lü song
   * brings up the Shi'er lü keyboard without anyone going to fetch it.
   *
   * Always computed from the CHOSEN layout, never from whatever is currently
   * playing. Otherwise a volunteer would be sticky — auto-select it for its own
   * tuning once, and it would still be there on the next song, which has no
   * layout of its own to displace it. Leaving a bound tuning therefore hands
   * the keyboard back to the layout you actually picked, and so does closing a
   * project that carried one.
   */
  applyForPreset(preset, notation = null) {
    // A ?load= boot reaches here before init() has read the saved choice, and
    // acting on an unknown name would answer "Piano" for a moment and — worse,
    // before the persist rule above — write it over the real one. Hold the
    // request instead; init() replays it once it knows what was chosen.
    if (!this._ready) { this._pending = { preset, notation }; return null; }
    const chosen = this.find(this.chosenName) ?? DEFAULT_KEYMAP;
    // The project's own layout outranks a tuning binding: it was put there by
    // whoever wrote the piece, and it is the more specific statement of the two
    // — "this song plays on THIS keyboard", not "this tuning suits that one".
    const project = this.projectKeymap();
    if (project && chosen.name !== project.name) return this.setActive(project, preset, false);
    if (notation !== null && chosen.notation !== notation) {
      const volunteer = this.forNotation(notation)[0];
      if (volunteer) return this.setActive(volunteer, preset, false);
    }
    return this.setActive(chosen, preset, false);
  }

  // ── the project's own copy (item 189.1) ──

  /** Is `spec` exactly what the open project carries? Compared as the TEXT that
   *  would be written, so it answers "is the song's copy still this layout"
   *  rather than "did these two objects come from the same place" — which is
   *  what the tab's one button has to know to say Embed or Remove. */
  isEmbedded(spec) {
    const text = this.store.doc?.embeddedKeymap() ?? null;
    return text !== null && spec != null && text === buildTaudkey(spec);
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
