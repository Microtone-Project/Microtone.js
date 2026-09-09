// Surround and ambisonic export (#998.4/.5/.6) — the render targets a song can
// be written to, and the pipeline that gets there.
//
// The engine is format-agnostic by construction (spatial.js): a voice is a
// source at a direction, and a SpatialRenderer is the only thing that knows
// about channels. So "export to 5.1" is not a downmix stage bolted onto the
// stereo output — it is the SAME song re-rendered with a different renderer
// installed, and every option below is one of those renderers plus the metadata
// that describes it to whoever opens the file.
//
// ── The list ──
//   stereo      — the fold (or the binaural head, #998.3), 16-bit. Handled by
//                 offline-render.js, since a stereo song has no object bus.
//   quad/5.1/7.1— ITU speaker feeds (speakers.js), 24-bit, WAVE_FORMAT_EXTENSIBLE
//                 with the layout's channel mask + ADM DirectSpeakers metadata.
//   ambix1/2/3  — AmbiX: ACN order, SN3D normalisation, 24-bit, channel mask 0,
//                 ADM HOA metadata. Always the FULL (order+1)² basis, never the
//                 horizontal-only subset: a planar song still excites the
//                 z-dependent harmonics (ACN 6 is −½ at ear level, not zero),
//                 so dropping them and zero-filling would be a different scene.
//
// A stereo song can be exported to any of these: it is promoted to the planar
// model for the render, which is bit-identical for ordinary pan (#998.0) and
// differs only in that a pan SLIDE wraps round the circle instead of stopping
// at the ends.
//
// ── The mastering chain ──
// The song's chain (item 178) reaches these files too, as a MULTICHANNEL master
// (item 178.1, engine spec §12.3): one `MasterChain` as wide as the bus, run
// over the object bus after each chunk, before the resampler. That is the only
// place it can go — the stereo pair the mixer folds down to is not this file's
// signal — and it is why the pair chain is switched off for the render: the
// device output a multichannel export produces is thrown away, and mastering it
// as well would be work nobody would ever hear.

import { TaudEngine } from "../engine/engine.js";
import { SAMPLING_RATE, TRACKER_CHUNK } from "../engine/constants.js";
import { MasterChain, masteringEngaged, defaultMastering } from "../engine/mastering.js";
import {
  SURROUND_STEREO, SURROUND_PLANAR, AmbisonicRenderer, AMBISONIC_ORDER_MAX,
} from "../engine/spatial.js";
import { SPEAKER_LAYOUTS, SpeakerRenderer } from "../engine/speakers.js";
import { loadIntoEngine } from "./offline-render.js";
import { StreamResampler } from "./resampler.js";
import { WavWriter, riffChunk } from "./wavwrite.js";
import {
  buildAdmXml, buildChna, admXmlBytes, speakerChannelSpecs, hoaChannelSpecs,
} from "./adm.js";

/**
 * Every export target, in the order the dialog shows them. Names are in the
 * translation files (`export.fmt.<id>`), so `id` is the only handle needed
 * here; every target is reachable from every song (see targetKindFor in the
 * dialog for what each one costs a given song).
 */
export const AUDIO_EXPORT_FORMATS = Object.freeze([
  { id: "stereo", channels: 2, bits: 16, kind: "stereo" },
  { id: "quad", channels: 4, bits: 24, kind: "speakers", layout: "quad" },
  { id: "5.1", channels: 6, bits: 24, kind: "speakers", layout: "5.1" },
  { id: "7.1", channels: 8, bits: 24, kind: "speakers", layout: "7.1" },
  { id: "ambix1", channels: 4, bits: 24, kind: "hoa", order: 1 },
  { id: "ambix2", channels: 9, bits: 24, kind: "hoa", order: 2 },
  { id: "ambix3", channels: 16, bits: 24, kind: "hoa", order: 3 },
]);

export function exportFormat(id) {
  const f = AUDIO_EXPORT_FORMATS.find((x) => x.id === id);
  if (!f) throw new Error(`unknown export format: ${id}`);
  return f;
}

/** The renderer a target installs. Stereo has none — it is the engine default. */
export function makeExportRenderer(id) {
  const f = exportFormat(id);
  if (f.kind === "speakers") return new SpeakerRenderer(f.layout);
  if (f.kind === "hoa") return new AmbisonicRenderer(Math.min(f.order, AMBISONIC_ORDER_MAX), false);
  return null;
}

/** File suffix: `.wav` everywhere, but AmbiX files conventionally say so. */
export function exportFileSuffix(id) {
  return exportFormat(id).kind === "hoa" ? ".ambix.wav" : ".wav";
}

/** ADM chunks (`chna` before the data, `axml` after it) for a target. */
export function admChunksFor(id, { title, sampleRate, bitDepth }) {
  const f = exportFormat(id);
  if (f.kind === "speakers") {
    const layout = SPEAKER_LAYOUTS[f.layout];
    const xml = buildAdmXml({
      kind: "DirectSpeakers", title, packName: layout.name,
      channels: speakerChannelSpecs(layout), sampleRate, bitDepth,
    });
    return {
      before: [riffChunk("chna", buildChna("DirectSpeakers", f.channels))],
      after: [riffChunk("axml", admXmlBytes(xml))],
    };
  }
  if (f.kind === "hoa") {
    const xml = buildAdmXml({
      kind: "HOA", title, packName: `HOA order ${f.order} (ACN/SN3D)`,
      channels: hoaChannelSpecs(f.channels), sampleRate, bitDepth,
    });
    return {
      before: [riffChunk("chna", buildChna("HOA", f.channels))],
      after: [riffChunk("axml", admXmlBytes(xml))],
    };
  }
  return { before: [], after: [] };
}

/**
 * Render a song to a multichannel WAV. Yields to the event loop like every
 * other long export so a progress bar can paint, and returns the file as byte
 * BLOCKS — a five-minute third-order export is half a gigabyte, and it is never
 * held twice.
 *
 * @returns {blocks, channels, frames, seconds, halted, aborted, mastered}
 */
export async function renderMultichannelAsync(docLike, songIndex, maxSeconds, {
  format, outRate = 48000, title = "", onProgress = null, signal = null, yieldMs = 60,
} = {}) {
  const f = exportFormat(format);
  if (f.kind === "stereo") throw new Error("stereo export goes through renderToWavAsync");

  const eng = new TaudEngine();
  loadIntoEngine(eng, docLike, songIndex);
  // No object bus in a stereo song — promote it (see the header).
  if (eng.getSurroundModel(0) === SURROUND_STEREO) eng.setSurroundModel(0, SURROUND_PLANAR);
  const renderer = makeExportRenderer(format);
  eng.setSpatialRenderer(0, renderer);

  const channels = renderer.numChannels;
  const ts = eng.playheads[0].trackerState;

  // The chain, moved off the pair and onto the bus (see the header). Read the
  // parameters BEFORE clearing the engine's own chain — `getMastering` is where
  // loadIntoEngine put whatever the song declared.
  const masterParams = eng.getMastering(0);
  const master = masteringEngaged(masterParams)
    ? new MasterChain(masterParams, SAMPLING_RATE, channels)
    : null;
  if (master !== null) eng.setMastering(0, defaultMastering());
  const writer = new WavWriter({
    channels, sampleRate: outRate, bits: f.bits,
    mask: f.kind === "speakers" ? SPEAKER_LAYOUTS[f.layout].mask : 0,
  });
  const resampler = new StreamResampler(channels, SAMPLING_RATE, outRate);
  const inter = new Float32Array(TRACKER_CHUNK * channels);
  const out = new Float32Array(resampler.maxOut(TRACKER_CHUNK) * channels);
  const device = new Uint8Array(TRACKER_CHUNK * 2); // the engine still wants its U8 sink

  const maxFrames = maxSeconds * SAMPLING_RATE;
  eng.setCuePosition(0, 0);
  eng.play(0);

  let frames = 0;
  let halted = false;
  let aborted = false;
  let lastYield = (typeof performance !== "undefined" ? performance.now() : Date.now());
  while (frames < maxFrames) {
    if (signal?.aborted) { aborted = true; break; }
    if (!eng.isPlaying(0)) { halted = true; break; }
    if (eng.renderChunk(0, device) === null) { halted = true; break; }
    const bus = ts.spatial.data; // channel-major, one chunk deep
    if (master !== null) master.processPlanar(bus, TRACKER_CHUNK, TRACKER_CHUNK);
    for (let n = 0; n < TRACKER_CHUNK; n++) {
      for (let c = 0; c < channels; c++) inter[n * channels + c] = bus[c * TRACKER_CHUNK + n];
    }
    writer.push(out, resampler.process(inter, TRACKER_CHUNK, out));
    frames += TRACKER_CHUNK;

    const now = (typeof performance !== "undefined" ? performance.now() : Date.now());
    if (now - lastYield >= yieldMs) {
      lastYield = now;
      onProgress?.(Math.min(frames / maxFrames, 1));
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  onProgress?.(1);
  if (aborted) {
    return {
      blocks: null, channels, frames, seconds: frames / SAMPLING_RATE,
      halted, aborted, mastered: master !== null,
    };
  }
  // The sinc kernel holds a few frames back waiting for their look-ahead; drain
  // them or the file ends half a millisecond early.
  writer.push(out, resampler.flush(out));

  const adm = admChunksFor(format, { title, sampleRate: outRate, bitDepth: f.bits });
  return {
    blocks: writer.finish(adm),
    channels,
    frames: writer.frames,
    seconds: frames / SAMPLING_RATE,
    halted,
    aborted: false,
    mastered: master !== null,
  };
}
