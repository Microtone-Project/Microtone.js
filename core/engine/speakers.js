// ITU speaker layouts and their render target (#998.6) — quadraphonic, 5.1 and
// 7.1 export.
//
// Like every other renderer, this one only answers "what gain does a source at
// (az, el) get in each of my channels?" — the mixer, the voices and the effects
// know nothing about it. It is not loaded by the worklet: playback monitors in
// stereo or binaural, and speaker feeds are an EXPORT target.
//
// ── Placement ──
// Angles are BS.775 / BS.2051: ±30° front pair, centre dead ahead, ±110°
// surrounds (quad drops the centre and the LFE), and for 7.1 the BS.2051
// System C split of ±90° sides and ±135° rears. Channel ORDER is the Microsoft
// WAVEFORMATEXTENSIBLE order that goes with each mask (…, BL, BR, SL, SR),
// which is what every DAW expects from a .wav; the ADM labels below carry the
// ITU names, where the sign convention is the opposite one (M+030 is LEFT).
// Note this is a different ordering question from a multi-channel SAMPLE's
// channels (spatial.js SAMPLE_CHANNEL_LAYOUT) — that order is fixed by the
// file format's 's' block, this one by the container we write.
//
// ── The LFE ──
// stays silent. There is no bass-management stage in this engine, and folding
// low frequencies into a separate channel would change the sound of the mix for
// anyone whose player redirects it back. The channel exists because the format
// has it; a mastering engineer fills it.

import { AZIMUTH_TURN, wrapAzimuth, StereoRenderer } from "./spatial.js";

const SPK_AZ_PER_DEG = AZIMUTH_TURN / 360;
const SPK_EL_TO_RAD = Math.PI / 256; // 128 elevation units = 90°

/**
 * `deg` is degrees CLOCKWISE from front (negative = left), the same convention
 * as SAMPLE_CHANNEL_LAYOUT; `label` is the WAV/DAW name and `adm` the BS.2051
 * one. `mask` is the WAVEFORMATEXTENSIBLE dwChannelMask for the whole layout.
 */
export const SPEAKER_LAYOUTS = Object.freeze({
  quad: {
    name: "quad",
    mask: 0x0033, // FL | FR | BL | BR
    speakers: [
      { label: "L", adm: "M+030", deg: -30 },
      { label: "R", adm: "M-030", deg: 30 },
      { label: "Ls", adm: "M+110", deg: -110 },
      { label: "Rs", adm: "M-110", deg: 110 },
    ],
  },
  "5.1": {
    name: "5.1",
    mask: 0x003f, // FL | FR | FC | LFE | BL | BR
    speakers: [
      { label: "L", adm: "M+030", deg: -30 },
      { label: "R", adm: "M-030", deg: 30 },
      { label: "C", adm: "M+000", deg: 0 },
      { label: "LFE", adm: "LFE1", deg: 0, lfe: true },
      { label: "Ls", adm: "M+110", deg: -110 },
      { label: "Rs", adm: "M-110", deg: 110 },
    ],
  },
  "7.1": {
    name: "7.1",
    mask: 0x063f, // FL | FR | FC | LFE | BL | BR | SL | SR
    speakers: [
      { label: "L", adm: "M+030", deg: -30 },
      { label: "R", adm: "M-030", deg: 30 },
      { label: "C", adm: "M+000", deg: 0 },
      { label: "LFE", adm: "LFE1", deg: 0, lfe: true },
      { label: "Lrs", adm: "M+135", deg: -135 },
      { label: "Rrs", adm: "M-135", deg: 135 },
      { label: "Lss", adm: "M+090", deg: -90 },
      { label: "Rss", adm: "M-090", deg: 90 },
    ],
  },
});

/** Layout names in the order the UI offers them (fewest channels first). */
export const SPEAKER_LAYOUT_NAMES = Object.freeze(["quad", "5.1", "7.1"]);

/** Engine azimuth of a speaker (front = 128, clockwise). */
export function speakerAzimuth(deg) {
  return wrapAzimuth(128 + deg * SPK_AZ_PER_DEG);
}

/**
 * Speaker-feed render target. Sources are panned pairwise around the horizontal
 * ring — constant power between the two speakers that bracket them, which is
 * the classic surround panner and is exact at every speaker — and elevation,
 * which no ITU layout can reproduce, spreads the source evenly over the ring as
 * it climbs, reaching a fully diffuse image at the poles. That keeps the level
 * constant and the movement continuous, and it is the same idea as the stereo
 * fold's collapse toward the centre, generalised to n speakers.
 */
export class SpeakerRenderer {
  constructor(layoutName) {
    const layout = SPEAKER_LAYOUTS[layoutName];
    if (!layout) throw new Error(`unknown speaker layout: ${layoutName}`);
    this.layout = layout;
    this.name = `speakers-${layout.name}`;
    this.numChannels = layout.speakers.length;

    // Ring = every non-LFE speaker, sorted by azimuth so the bracketing pair is
    // a search away rather than a special case per layout.
    const ring = [];
    for (let i = 0; i < layout.speakers.length; i++) {
      const s = layout.speakers[i];
      if (s.lfe) continue;
      ring.push({ channel: i, az: speakerAzimuth(s.deg) });
    }
    ring.sort((a, b) => a.az - b.az);
    this.ringChannel = Int32Array.from(ring, (r) => r.channel);
    this.ringAz = Float64Array.from(ring, (r) => r.az);
    this.ringSize = ring.length;

    // Stereo monitor: fold each speaker as if it were itself a source, so the
    // preview agrees with what the stereo export of the same song would give.
    const fold = new StereoRenderer();
    this.monitorGains = new Float64Array(this.numChannels * 2);
    for (let i = 0; i < layout.speakers.length; i++) {
      if (layout.speakers[i].lfe) continue;
      fold.channelGains(speakerAzimuth(layout.speakers[i].deg), 0, this.monitorGains, i * 2);
    }
  }

  channelGains(az, el, out, off) {
    const n = this.numChannels;
    for (let c = 0; c < n; c++) out[off + c] = 0.0;

    const size = this.ringSize;
    const a = wrapAzimuth(az);
    // The bracketing pair, with the wrap-around arc as the last segment.
    let i = size - 1;
    for (let k = 0; k < size; k++) {
      if (a < this.ringAz[k]) { i = (k - 1 + size) % size; break; }
    }
    const j = (i + 1) % size;
    const a0 = this.ringAz[i];
    let span = this.ringAz[j] - a0;
    if (span <= 0) span += AZIMUTH_TURN;
    let d = a - a0;
    if (d < 0) d += AZIMUTH_TURN;
    const t = (d / span) * (Math.PI / 2);
    out[off + this.ringChannel[i]] = Math.cos(t);
    out[off + this.ringChannel[j]] = Math.sin(t);

    // Height has nowhere to go in a planar layout: spread it instead.
    const w = Math.abs(Math.sin(el * SPK_EL_TO_RAD));
    if (w > 0) {
      const diffuse = w / size;
      for (let k = 0; k < size; k++) {
        const c = off + this.ringChannel[k];
        out[c] = Math.sqrt((1 - w) * out[c] * out[c] + diffuse);
      }
    }
  }

  monitorStereo(data, frames, n, out) {
    let l = 0.0;
    let r = 0.0;
    for (let c = 0; c < this.numChannels; c++) {
      const v = data[c * frames + n];
      l += v * this.monitorGains[c * 2];
      r += v * this.monitorGains[c * 2 + 1];
    }
    out[0] = l;
    out[1] = r;
  }
}
