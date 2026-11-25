// Choosing a lane's or an instrument's own notation (item 374). The song's
// notation is chosen on the Project view; a lane's from its header's menu in
// the Timeline, an instrument's on the Instruments view's General tab. Both
// lists are the song's list — every notation Microtone has, then the
// project's own (the `nota` section) — behind the choice of having none.

import { pitchTablePresets, GM_DRUM_NOTATION } from "../../core/tuning/pitchtables.js";
import { defToPreset } from "../doc/notation.js";
import { showModal } from "./components/modal.js";
import { t } from "./i18n.js";
import { ICON } from "./icons.js";

/** Every notation a song, a lane or an instrument may have, as select
 *  options: {value: the index as a string, label}. */
export function notationOptions(doc) {
  const out = Object.values(pitchTablePresets).map((p) => ({ value: String(p.index), label: p.name }));
  for (const d of doc?.customNotations() ?? []) {
    const p = defToPreset(d);
    out.push({ value: String(p.index), label: t("nota.customOption", { name: p.name }) });
  }
  return out;
}

/** The name of notation `value` in `doc` — a custom one's by its definition. */
export function notationName(store, value) {
  return store.presetOf(value)?.name ?? String(value);
}

/** Lane `ch`'s notation, for its header's menu: one item that opens the
 *  choice, saying what the lane has now. */
export function laneNotationItems(store, ch) {
  if (!store.doc) return [];
  const own = store.laneNotationIndex(ch);
  return [{
    id: "laneNotation", icon: ICON.laneNotation,
    label: own === null ? t("ctx.laneNotation") : t("ctx.laneNotationOwn", { name: notationName(store, own) }),
    title: t("ctx.laneNotationTitle", { ch: ch + 1 }),
  }];
}

/** Ask for lane `ch`'s notation and set it. Resolves true when it changed. */
export async function pickLaneNotation(store, ch) {
  const own = store.laneNotationIndex(ch);
  const song = store.pitchPreset?.name ?? "";
  const v = await showModal({
    title: t("laneNota.title", { ch: ch + 1 }),
    body: t("laneNota.body"),
    fields: [{
      name: "notation", label: t("laneNota.label"), type: "select",
      value: own === null ? "song" : String(own),
      options: [{ value: "song", label: t("laneNota.song", { name: song }) }, ...notationOptions(store.doc)],
    }],
    okLabel: t("common.apply"),
  });
  if (!v) return false;
  const next = v.notation === "song" ? null : parseInt(v.notation, 10);
  if (next === own) return false;
  store.setLaneNotation(ch, next);
  return true;
}

/**
 * The choices for instrument `slot`'s notation: "auto" (it says nothing — a
 * drum kit then gets the General MIDI drum names, anything else its lane's),
 * "follow" (a drum kit that should NOT be spelled as drums), then every
 * notation. The value is what Document.instNotation answers, as a string.
 */
export function instNotationOptions(store, slot) {
  const doc = store.doc;
  const kit = doc.isDrumKit(slot);
  const out = [{
    value: "auto",
    label: kit ? t("instNota.autoKit", { name: pitchTablePresets[GM_DRUM_NOTATION].name }) : t("instNota.auto"),
  }];
  if (kit) out.push({ value: "follow", label: t("instNota.follow") });
  return [...out, ...notationOptions(doc)];
}

/** Document.instNotation's answer as an option value, and back. */
export function instNotationValue(own) {
  return own === null ? "auto" : own === "follow" ? "follow" : String(own);
}
export function instNotationFromValue(v) {
  return v === "auto" ? null : v === "follow" ? "follow" : parseInt(v, 10);
}
