// Format version 2 → 3: widening a project's pattern cells (file format §5.5).
//
// The wide cell exists to serve surround songs, so this runs when a project
// first declares one. It is a ONE-WAY door — the wide cell can say things the
// 8-byte cell cannot (a source behind the listener, a volume between two of the
// old steps, a second effect), so there is no defined way back and the editor
// asks before doing it.
//
// Everything here is pure byte-shuffling over pattern images, deliberately
// separate from the Document so it can be tested on its own and so the mapping
// table in the spec has exactly one implementation.

import { PATTERN_SIZE, PATTERN_SIZE_WIDE } from "../format/taud-const.js";
import { EffectOp } from "../engine/tables.js";

/** A 6-bit column value in the wide cell's 8-bit units: 0x3F ↦ 255, exactly. */
export function widenVolume(v6) {
  return Math.round((Math.min(v6, 63) * 255) / 63);
}

/**
 * One 512-byte pattern image → its 1024-byte equivalent. Field by field:
 *
 *   volume    value scaled ×255/63, FINE's direction bit 5 → bit 7
 *   panning   SET becomes the azimuth the v2 engine would have derived
 *             ((v << 2) | (v >> 4), i.e. the front arc); slides and FINE keep
 *             their magnitude verbatim, because a pan-byte step and an azimuth
 *             step are the same unit — only FINE's direction bit moves, to `A`
 *   effects   copied into slot 1; slot 2 empty. `M` (lane volume) is the one
 *             effect whose ARGUMENT is an absolute volume level, so it scales
 *   elevation 0 — a v2 song has no height to carry
 */
export function widenPattern(src) {
  const out = new Uint8Array(PATTERN_SIZE_WIDE);
  for (let r = 0; r < 64; r++) {
    const s = r * 8;
    const d = r * 16;
    out[d] = src[s];          // note lo
    out[d + 1] = src[s + 1];  // note hi
    out[d + 2] = src[s + 2];  // instrument

    const volByte = src[s + 3];
    const volSel = (volByte >>> 6) & 3;
    const volVal = volByte & 0x3f;
    if (volSel === 3) {
      // FINE: direction rides the top of the value field, which just got wider.
      const mag = widenVolume(volVal & 0x1f);
      out[d + 3] = ((volVal & 0x20) !== 0 ? 0x80 : 0) | Math.min(mag, 0x7f);
    } else {
      out[d + 3] = widenVolume(volVal);
    }

    const panByte = src[s + 4];
    const panSel = (panByte >>> 6) & 3;
    const panVal = panByte & 0x3f;
    let azimuth;
    if (panSel === 0) {
      azimuth = (panVal << 2) | (panVal >>> 4); // the front-arc byte, as before
    } else if (panSel === 3) {
      azimuth = ((panVal & 0x20) !== 0 ? 0x100 : 0) | (panVal & 0x1f);
    } else {
      azimuth = panVal;
    }
    out[d + 4] = azimuth & 0xff;
    out[d + 9] = 0; // elevation

    let effect = src[s + 5];
    let arg = src[s + 6] | (src[s + 7] << 8);
    if (effect === EffectOp.OP_M) {
      // M $xx00 sets an absolute lane volume; the wide cell's is 8-bit.
      arg = (widenVolume((arg >>> 8) & 0x3f) << 8) | (arg & 0xff);
    }
    out[d + 5] = effect;
    out[d + 6] = arg & 0xff;
    out[d + 7] = (arg >>> 8) & 0xff;

    out[d + 8] = (((azimuth >>> 8) & 1) << 7) | (volSel << 4) | panSel;
    // bytes 10..12 (effect 2) and 13..15 (reserved) stay zero
  }
  return out;
}

/** True if `bytes` is a v2 pattern image (the only thing widenPattern accepts). */
export function isNarrowPattern(bytes) {
  return bytes.length === PATTERN_SIZE;
}

/**
 * Widen a whole parsed-shape document in place: every pattern of every song,
 * plus the version stamp. Returns the number of patterns converted.
 */
export function upgradeParsedToWide(parsed) {
  let n = 0;
  for (const song of parsed.songs) {
    song.patterns = song.patterns.map((p) => {
      if (!isNarrowPattern(p)) return p;
      n++;
      return widenPattern(p);
    });
  }
  parsed.fmtVer = 3;
  return n;
}
