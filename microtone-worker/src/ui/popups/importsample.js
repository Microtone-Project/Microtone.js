// "New instrument from sample" flow — pick an audio file, decode it to mono
// FLOAT (audiodecode.js), then open the Sample Lab (item 83) on the take:
// crop/chop/EQ happen there, and its commit lands the result as fresh
// instruments through planMultiSampleImport + the invertible importBankOp
// (the same pipeline the bank importer uses, so undo/sync come for free).

import { pickFile } from "../../storage/import-export.js";
import { decodeAudioToFloat } from "../audiodecode.js";
import { planExistingSampleAsInstrument } from "../../doc/bankmerge.js";
import { importBankOp } from "../../doc/ops.js";
import { showModal } from "../widgets/modal.js";
import { escapeNonAscii, unescapeName } from "../../../core/format/names.js";
import { t } from "../i18n.js";

const ACCEPT = ".wav,.mp3,.ogg,.oga,.flac,.aif,.aiff,.m4a,audio/*";

/** Resolves with {firstSlot, count} after a successful import, else null. */
export async function importSampleAsInstrument(store) {
  if (!store.doc) return null;
  const file = await pickFile(ACCEPT);
  if (!file) return null;

  let decoded;
  try {
    decoded = await decodeAudioToFloat(new Uint8Array(await file.arrayBuffer()));
  } catch (err) {
    alert(t("import.cantDecode", { name: file.name, err: err.message ?? err }));
    return null;
  }

  const { openSampleLab } = await import("./samplelab.js");
  return openSampleLab(store, {
    // A stereo file opens as a stereo take (item 90); the Lab's channel button
    // folds it to mono when the user would rather spend half the pool bytes.
    data: decoded.channels,
    rate: decoded.rate,
    name: file.name.replace(/\.[^.]+$/, ""),
    sourceLabel: file.name,
  });
}

/**
 * Create a fresh instrument that plays an EXISTING pooled sample (item 40) —
 * `sample` is a doc.sampleList() census entry. Confirm the name, then land it
 * through the same importBankOp pipeline (no new pool bytes; inherits the
 * sample's loop/rate). Resolves with {firstSlot, count} on success, else null.
 */
export async function newInstrumentFromSample(store, sample) {
  if (!store.doc || !sample) return null;
  const base = unescapeName(sample.name) || `sample ${sample.index}`;
  const result = await showModal({
    title: t("smp.newInstTitle", { name: base }),
    body: t("smp.newInstBody", { len: sample.len, rate: sample.rate }),
    fields: [{ name: "name", label: t("inst.sampleImportName"), value: base }],
    okLabel: t("common.create"),
  });
  if (!result) return null;

  const nameBytes = new TextEncoder().encode(escapeNonAscii(result.name || base));
  const plan = planExistingSampleAsInstrument(store.doc, sample, nameBytes);
  if (plan.error) { alert(plan.error); return null; }
  store.undo.apply(importBankOp(plan));
  return { firstSlot: plan.insts[0].destSlot, count: 1 };
}
