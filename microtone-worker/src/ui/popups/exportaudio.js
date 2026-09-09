// Audio export dialog (#998.4) — pick a render TARGET, not a downmix.
//
// The song's own surround model decides what is worth offering: a stereo song
// gets stereo (anything else would be inventing a soundstage it never had), a
// planar song can fill a speaker ring, and a spatial song can do that or keep
// the whole sphere as ambisonic B-format. Every target other than the song's
// own model is a downmix, and says so on the card.
//
// The pictures come from the layout tables (speakerdiagram.js), so what you
// pick is what the renderer does.

import {
  AUDIO_EXPORT_FORMATS, exportFormat,
} from "../../audio/surround-export.js";
import { SURROUND_STEREO, SURROUND_PLANAR, SURROUND_SPATIAL } from "../../engine/spatial.js";
import { speakerDiagram } from "../speakerdiagram.js";
import { t } from "../i18n.js";

const RATES = [32000, 44100, 48000, 96000];

/**
 * Which targets a song can be written to, and how each relates to its model.
 * Everything is always REACHABLE — a stereo song rendered to 5.1 is a legal
 * thing to ask for — but the badge tells you whether you are keeping the scene
 * ("native"), flattening it ("downmix") or inflating it ("upmix").
 */
export function targetKindFor(formatId, surroundModel) {
  const f = exportFormat(formatId);
  const carriesHeight = f.kind === "hoa";
  const carriesCircle = f.kind !== "stereo";
  if (surroundModel === SURROUND_SPATIAL) {
    if (carriesHeight) return "native";
    return "downmix";
  }
  if (surroundModel === SURROUND_PLANAR) {
    if (carriesHeight) return "native";     // the sphere holds a circle exactly
    return carriesCircle ? "native" : "downmix";
  }
  return carriesCircle ? "upmix" : "native"; // stereo song
}

/**
 * @param opts {surroundModel, mastered, fileName, defaults}
 * @returns Promise<null | {format, outRate, cap, monitor}>
 */
export function showExportAudio({ surroundModel = 0, mastered = false, defaults = {} } = {}) {
  return new Promise((resolve) => {
    let format = defaults.format ?? "stereo";
    let outRate = defaults.outRate ?? 48000;
    let cap = defaults.cap ?? 300;
    let monitor = defaults.monitor ?? (surroundModel === SURROUND_STEREO ? "fold" : "binaural");

    const dlg = document.createElement("dialog");
    dlg.className = "modal export-audio";
    const h = document.createElement("h3");
    h.textContent = t("export.title");
    const intro = document.createElement("p");
    intro.className = "dim";
    intro.textContent = t(surroundModel === SURROUND_SPATIAL ? "export.introSpatial"
      : surroundModel === SURROUND_PLANAR ? "export.introPlanar" : "export.introStereo");

    // ── format cards ──
    const cards = document.createElement("div");
    cards.className = "export-cards";
    const cardEls = new Map();
    for (const f of AUDIO_EXPORT_FORMATS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "export-card";
      b.dataset.format = f.id;
      b.appendChild(speakerDiagram(f.id, { size: 84 }));
      const name = document.createElement("span");
      name.className = "export-card-name";
      name.textContent = t(`export.fmt.${f.id}`);
      const sub = document.createElement("span");
      sub.className = "export-card-sub";
      const kind = targetKindFor(f.id, surroundModel);
      sub.textContent = `${t("export.channels", { n: f.channels })} · ${f.bits}-bit · ${t(`export.kind.${kind}`)}`;
      b.append(name, sub);
      b.title = t(`export.fmtTitle.${f.id}`);
      b.addEventListener("click", (e) => { e.preventDefault(); format = f.id; refresh(); });
      cards.appendChild(b);
      cardEls.set(f.id, b);
    }

    // ── options ──
    const opts = document.createElement("div");
    opts.className = "export-opts";
    const mkSelect = (labelKey, value, options, onChange) => {
      const lab = document.createElement("label");
      lab.className = "modal-field";
      lab.append(t(labelKey) + " ");
      const sel = document.createElement("select");
      for (const [v, text] of options) {
        const o = document.createElement("option");
        o.value = String(v);
        o.textContent = text;
        sel.appendChild(o);
      }
      sel.value = String(value);
      sel.addEventListener("change", () => { onChange(sel.value); refresh(); });
      lab.appendChild(sel);
      opts.appendChild(lab);
      return sel;
    };

    const monitorSel = mkSelect("export.downmix", monitor, [
      ["fold", t("export.downmixFold")],
      ["binaural", t("export.downmixBinaural")],
    ], (v) => { monitor = v; });
    const monitorField = monitorSel.parentElement;
    const monitorHint = document.createElement("p");
    monitorHint.className = "dim export-hint";
    monitorHint.textContent = t("export.downmixHint");

    mkSelect("export.rate", outRate, RATES.map((r) => [r, `${r} Hz`]), (v) => { outRate = Number(v); });

    const capLab = document.createElement("label");
    capLab.className = "modal-field";
    capLab.append(t("export.cap") + " ");
    const capInp = document.createElement("input");
    capInp.type = "number";
    capInp.min = 1;
    capInp.max = 3600;
    capInp.value = String(cap);
    capInp.addEventListener("input", () => {
      const v = parseInt(capInp.value || "300", 10);
      cap = Number.isFinite(v) ? Math.min(Math.max(v, 1), 3600) : 300;
      refresh();
    });
    capLab.appendChild(capInp);
    opts.appendChild(capLab);

    // The mastering chain (item 178) acts on the stereo pair, which is what
    // the output stage delivers — a multichannel target is written from the
    // object bus, upstream of it. Say so where the choice is made rather than
    // letting someone find out by comparing files.
    const masterHint = document.createElement("p");
    masterHint.className = "dim export-hint";
    masterHint.textContent = t("export.masteringHint");

    const size = document.createElement("p");
    size.className = "dim export-hint";

    const row = document.createElement("div");
    row.className = "modal-buttons";
    const ok = document.createElement("button");
    ok.textContent = t("export.render");
    const cancel = document.createElement("button");
    cancel.textContent = t("common.cancel");
    row.append(ok, cancel);

    dlg.append(h, intro, cards, opts, monitorHint, masterHint, size, row);
    document.body.appendChild(dlg);

    function refresh() {
      for (const [id, b] of cardEls) b.classList.toggle("selected", id === format);
      const f = exportFormat(format);
      // The downmix choice only exists where there is a scene to fold: a stereo
      // TARGET fed by a surround song.
      const foldable = f.kind === "stereo" && surroundModel !== SURROUND_STEREO;
      monitorField.hidden = !foldable;
      monitorHint.hidden = !foldable;
      // Only worth saying when the song HAS a chain and the target would miss it.
      masterHint.hidden = f.kind === "stereo" || !mastered;
      // …and a rough idea of what is about to land in the downloads folder.
      const bytes = cap * outRate * f.channels * (f.bits >> 3);
      size.textContent = t("export.sizeHint", {
        mb: (bytes / 1048576).toFixed(0), n: f.channels,
      });
    }

    const finish = (value) => {
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    ok.addEventListener("click", (e) => {
      e.preventDefault();
      finish({ format, outRate, cap, monitor: exportFormat(format).kind === "stereo" ? monitor : "fold" });
    });
    cancel.addEventListener("click", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(null); });
    dlg.addEventListener("keydown", (e) => e.stopPropagation());

    refresh();
    dlg.showModal();
    // Otherwise the dialog focuses the first card, which then wears a focus
    // ring next to the amber selection ring on a different card.
    cardEls.get(format)?.focus();
    dlg.__exportAudio = { // test hook, as every other popup has
      pick: (id) => { format = id; refresh(); },
      set: (o) => {
        if (o.outRate !== undefined) outRate = o.outRate;
        if (o.cap !== undefined) cap = o.cap;
        if (o.monitor !== undefined) monitor = o.monitor;
        refresh();
      },
      state: () => ({ format, outRate, cap, monitor, monitorShown: !monitorField.hidden }),
      ok: () => ok.click(),
      cancel: () => cancel.click(),
    };
  });
}
