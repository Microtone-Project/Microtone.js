// To sample (item 242) — the UI over doc/pattosample.js, reached from the
// toolbox and from the grids' right-click menus.
//
// A CHORD STACK (several lanes always striking the same chord) is offered as a
// layered metainstrument first: nothing to render, every note still through
// its own instrument. Anything else is rendered and opened in the Sample Lab,
// where it is auditioned, trimmed, sized and imported like any other take.
// Either way the document changes in TWO undo steps — the instrument, then the
// patterns — so one Ctrl+Z puts the music back and leaves the instrument.

import {
  timelineRegion, patternRegion, findTrigger, renderRegion, detectChordStack,
  planSampleReplacement, planStackReplacement, RENDER_MAX_SECONDS,
} from "../doc/pattosample.js";
import { planChordMeta } from "../doc/bankmerge.js";
import { importBankOp, setCellsBytesOp } from "../doc/ops.js";
import { showModal, showNotice } from "./components/modal.js";
import { escapeNonAscii, unescapeName } from "../../core/format/names.js";
import { t } from "./i18n.js";

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, "0");

/** The block a renderSpec() names, its "this applies to …" label and the
 *  name the new instrument starts with. */
function describe(store, spec) {
  if (spec.kind === "timeline") {
    return {
      region: timelineRegion(store.song, spec.r0, spec.r1, spec.c0, spec.c1),
      scope: t("ctx.scopeBlock", { rows: spec.r1 - spec.r0 + 1, chans: spec.c1 - spec.c0 + 1 }),
      name: t("p2s.nameRows", { r0: spec.r0, r1: spec.r1 }),
    };
  }
  return {
    region: patternRegion(spec.pat, spec.r0, spec.r1, store.doc.channelCount),
    scope: t("pat.scopeSel", { r0: spec.r0, r1: spec.r1 }),
    name: t("p2s.namePattern", { pat: hex2(spec.pat), r0: spec.r0, r1: spec.r1 }),
  };
}

/**
 * Render `spec` (a view's renderSpec()) to a new instrument and replace the
 * block with it. Resolves true when the patterns changed.
 */
export async function patternToSample(store, spec) {
  if (!store.doc || !store.song) return false;
  const title = t("p2s.title");
  if (!spec) {
    await showNotice({ title, body: t("p2s.needBlock") });
    return false;
  }
  const s = store.songIndex;
  const { region, scope, name } = describe(store, spec);
  if (region.cues.length === 0 || !findTrigger(store.doc, s, region)) {
    await showNotice({ title, body: t("p2s.empty") });
    return false;
  }

  const stack = detectChordStack(store.doc, s, region);
  if (stack) {
    const names = stack.layers.map((l) => unescapeName(store.doc.instrumentName(l.slot)) || `$${hex2(l.slot)}`);
    const v = await showModal({
      title: t("p2s.stackTitle"),
      body: t("p2s.stackBody", { n: stack.lanes.length, scope }),
      fields: [
        { name: "as", label: t("p2s.as"), type: "select", value: "meta",
          options: [{ value: "meta", label: t("p2s.asMeta") }, { value: "sample", label: t("p2s.asSample") }],
          hints: { meta: t("p2s.asMetaHint"), sample: t("p2s.asSampleHint") } },
        { name: "name", label: t("inst.sampleImportName"), value: [...new Set(names)].join(" + "),
          enabledWhen: { field: "as", is: "meta" } },
      ],
      okLabel: t("common.create"),
    });
    if (!v) return false;
    if (v.as === "meta") {
      const plan = planChordMeta(store.doc, stack.layers.map((l) => ({ slot: l.slot, detune: l.detune })),
        escapeNonAscii(v.name?.trim() || names.join(" + ")));
      if (plan.error) { alert(plan.error); return false; }
      store.undo.apply(importBankOp(plan));
      const writes = planStackReplacement(store.doc, s, region, stack, plan.metaSlot);
      if (writes.length) store.undo.apply(setCellsBytesOp(s, writes));
      return true;
    }
  }

  const { showProgress } = await import("./popups/progress.js");
  const progress = showProgress(t("p2s.rendering"), { cancellable: true, holdBack: true });
  let r;
  try {
    r = await renderRegion(store.doc, s, region,
      { signal: progress.signal, onProgress: (f) => progress.set(f) });
  } finally {
    progress.done();
  }
  if (r.aborted) return false;
  if (r.error) {
    await showNotice({ title, body: t(`p2s.${r.error}`, { max: RENDER_MAX_SECONDS }) });
    return false;
  }

  const { openSampleLab } = await import("./popups/samplelab.js");
  const done = await openSampleLab(store, {
    data: r.channels,
    rate: r.rate,
    name,
    sourceLabel: t("p2s.source", { scope }),
    importExtras: { attenOctet: r.attenOctet, detune: r.detune },
  });
  if (!done?.firstSlot) return false;
  const writes = planSampleReplacement(store.doc, s, region, r.trigger, done.firstSlot);
  if (writes.length) store.undo.apply(setCellsBytesOp(s, writes));
  return true;
}
