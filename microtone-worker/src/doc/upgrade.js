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

import { PATTERN_SIZE, PATTERN_SIZE_WIDE } from "../../core/format/taud-const.js";
import { EffectOp } from "../../core/engine/tables.js";
import { TaudPlayData } from "../../core/engine/state.js";

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

// ── Format 3 → a version-2 READING, for the module exporters ──
//
// Format 3 is the only format the editor holds, but a .mod or an .it is a
// version-2 world: a 6-bit volume column, a front-arc panning column, one
// effect a row. There is no downgrade of the FILE (§5.5), and this is not one:
// it is a view an exporter reads — exactly the inverse of widenPattern, so a
// song that came from version 2 reads back as the cells it was — and it counts
// what the wide cell said that a narrow one cannot, for the export to report.
// Notes keep their 65536-TET fraction; the exporters take pitch as a number.


const SEL_FINE = 3;

/**
 * An 8-bit column value back in 6-bit units: `v8 >> 2`, the engine's own
 * reading of a wide volume against 6-bit data (columns.js narrowVolAxis), so an
 * exporter that picks a key-map zone or a layer by the narrowed volume picks
 * the one Microtone plays. It is also the exact inverse of widenVolume:
 * round(v × 255 ÷ 63) lies in 4v…4v+3 for every v of 0…63.
 */
export function narrowVolume(v8) {
  return Math.min(63, Math.max(0, v8 | 0) >> 2);
}

/** One wide cell → its version-2 reading; `lost` counts what did not fit. */
export function narrowCell(w, lost) {
  const c = new TaudPlayData();
  c.note = w.note;
  c.instrment = w.instrment;

  if (w.volumeEff > SEL_FINE) { c.volumeEff = SEL_FINE; c.volume = 0; } // RESERVED: the no-op
  else if (w.volumeEff === SEL_FINE) {
    const mag = Math.min(31, narrowVolume(w.volume & 0x7f));
    c.volumeEff = SEL_FINE;
    c.volume = mag === 0 ? 0 : ((w.volume & 0x80) !== 0 ? 0x20 : 0) | mag;
  } else {
    c.volumeEff = w.volumeEff;
    c.volume = narrowVolume(w.volume);
  }
  // The wide SET as it stands, for a format whose own volume is finer than
  // 0…63 (an IT or MOD volume of 0…64 is round(v × 64 ÷ 255) of it, exactly
  // the inverse of a converter's round(v × 255 ÷ 64)).
  c.volume8 = c.volumeEff === 0 ? w.volume : null;

  const az = w.azimuth & 0x1ff;
  if (w.panEff > SEL_FINE) { c.panEff = SEL_FINE; c.pan = 0; }
  else if (w.panEff === SEL_FINE) {
    const mag = Math.min(31, az & 0xff);
    c.panEff = SEL_FINE;
    c.pan = mag === 0 ? 0 : ((az & 0x100) !== 0 ? 0x20 : 0) | mag;
  } else if (w.panEff === 0) {
    // The front arc is 0 (left) … 256 (right); behind folds onto it the way a
    // stereo song hears it (the left–right component), above is dropped.
    let front = az;
    if (az > 256) front = 512 - az;
    if (az > 256 || w.elevation !== 0) lost.position++;
    c.panEff = 0;
    c.pan = Math.min(63, front >>> 2);
  } else {
    c.panEff = w.panEff;
    c.pan = Math.min(63, az & 0xff);
  }

  c.effect = w.effect;
  c.effectArg = w.effectArg;
  if (w.effect === EffectOp.OP_M) {
    c.effectArg = (narrowVolume((w.effectArg >>> 8) & 0xff) << 8) | (w.effectArg & 0xff);
    c.lane8 = (w.effectArg >>> 8) & 0xff;   // the wide lane volume, as volume8 is the note's
  }
  if (w.effect2 !== 0 || w.effectArg2 !== 0) lost.effect2++;
  return c;
}

/**
 * A read-only version-2 view of a format-3 document for an exporter: the same
 * document (instruments, names, cues, every method) with each song's patterns
 * narrowed. Returns {doc, lost: {effect2, position}} — counted over song
 * `countSong` alone when given (the one being exported); a narrow document
 * comes back as itself with nothing lost.
 */
export function narrowedForExport(doc, countSong = -1) {
  const lost = { effect2: 0, position: 0 };
  if (!doc.wideCells) return { doc, lost };
  const view = Object.create(doc);
  view.wideCells = false;
  view.fmtVer = 2;
  const scratch = { effect2: 0, position: 0 };
  view.songs = doc.songs.map((song, i) => {
    const s = Object.create(song);
    const tally = countSong < 0 || i === countSong ? lost : scratch;
    s.patterns = song.patterns.map((rows) => rows && rows.map((cell) => narrowCell(cell, tally)));
    return s;
  });
  return { doc: view, lost };
}
