// "Load a recording into memory" (item 175) — the other way to fill the pool.
//
// The ordinary sample import decodes a file, squeezes it into the 65535-byte
// budget an instrument's length field can address, and mints an instrument for
// it. This one does none of that: it drops the WHOLE recording into the pool as
// a region, at whatever rate the user picks, and leaves it there with no
// instrument attached. Instruments are cut out of it afterwards, in the map
// view — which is the working method item 175 asks for, and the reason the
// length ceiling stops being the thing that decides how a project is built.

import { pickFile } from "../../storage/import-export.js";
import { decodeAudioToFloat } from "../audiodecode.js";
import { resample, quantiseU8 } from "../../doc/wavelab.js";
import { planImportRegion } from "../../doc/bankmerge.js";
import { importBankOp } from "../../doc/ops.js";
import { largestFreeRun } from "../../doc/sampleregions.js";
import { sampleSpans } from "../../doc/document.js";
import { showModal } from "../widgets/modal.js";
import { escapeNonAscii } from "../../../core/format/names.js";
import { t } from "../i18n.js";

const ACCEPT = ".wav,.mp3,.ogg,.oga,.flac,.aif,.aiff,.m4a,audio/*";

/** The decode context's rate. Everything below is a plain ratio off this. */
const DECODE_RATE = 32000;

/** Rates offered, highest first. A long recording is a trade between fidelity
 *  and how much of an 8 MB pool it eats, and that is the user's call. */
const RATES = [32000, 24000, 22050, 16000, 11025, 8000];

function fmtBytes(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(2) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

/**
 * Pick an audio file and load it into the pool as a region.
 * Resolves with the new region on success, else null.
 */
export async function importRegion(store) {
  const doc = store.doc;
  if (!doc) return null;
  const file = await pickFile(ACCEPT);
  if (!file) return null;

  let decoded;
  try {
    decoded = await decodeAudioToFloat(new Uint8Array(await file.arrayBuffer()),
      { rate: DECODE_RATE, stereo: true });
  } catch (err) {
    alert(t("import.cantDecode", { name: file.name, err: err.message ?? err }));
    return null;
  }

  const free = largestFreeRun(
    doc.sampleList().flatMap(sampleSpans),
    doc.sampleRegions());
  const baseName = file.name.replace(/\.[^.]+$/, "");
  const frames = decoded.channels[0].length;
  const stereo = decoded.channels.length > 1;

  const res = await showModal({
    title: t("rgn.importTitle", { name: file.name }),
    body: t("rgn.importBody", {
      secs: decoded.seconds.toFixed(1),
      chans: decoded.srcChannels,
      free: fmtBytes(free),
      // The full-rate cost is the headline number: everything else in the
      // dialog is a way of making it smaller.
      cost: fmtBytes(frames * (stereo ? 2 : 1)),
    }),
    fields: [
      { name: "name", label: t("inst.sampleImportName"), value: baseName },
      {
        name: "rate", label: t("rgn.importRate"), type: "select", value: String(DECODE_RATE),
        options: RATES.map((r) => ({
          value: String(r),
          label: `${r} Hz · ${fmtBytes(Math.round(frames * (r / DECODE_RATE)) * (stereo ? 2 : 1))}`,
        })),
        hint: t("rgn.importRateHint"),
      },
      ...(stereo ? [{
        name: "mono", label: t("rgn.importMono"), type: "checkbox", value: false,
        hint: t("rgn.importMonoHint"),
      }] : []),
    ],
    okLabel: t("rgn.importOk"),
  });
  if (!res) return null;

  const rate = Math.max(1, Math.min(0xffff, parseInt(res.rate, 10) || DECODE_RATE));
  const ratio = rate / DECODE_RATE;
  let chans = decoded.channels;
  if (res.mono && chans.length > 1) {
    const mono = new Float32Array(chans[0].length);
    for (let i = 0; i < mono.length; i++) {
      let s = 0;
      for (const c of chans) s += c[i];
      mono[i] = s / chans.length;
    }
    chans = [mono];
  }
  const pcm = chans.map((c) => quantiseU8(ratio === 1 ? c : resample(c, ratio)).pcm);

  const nameBytes = new TextEncoder().encode(escapeNonAscii(res.name || baseName));
  const plan = planImportRegion(doc, { channels: pcm, rate, nameBytes });
  if (plan.error) { alert(plan.error); return null; }
  store.undo.apply(importBankOp(plan));
  store.emit("edit", [{ kind: "bank" }]);
  return plan.region;
}
