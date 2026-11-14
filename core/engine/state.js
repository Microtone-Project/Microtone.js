// The pattern cell (TaudPlayData) and the cue sheet's instruction words, as
// the page reads and writes them — port of AudioAdapter.kt:4484-4494 and
// 5210-5244. The engine's own are C (core/engine/c/src/parse.c, row.c).

// ── PlayInstruction (4484-4494) — tagged objects ──
export const INST_NOP = 0;
export const INST_GOBACK = 1;
export const INST_SKIP = 2;
export const INST_JUMP = 3;
export const INST_PATLEN = 4;
export const INST_HALTAT = 5;
export const INST_HALT = 6;

const PLAY_INST_NOP = Object.freeze({ type: INST_NOP, arg: 0 });
const PLAY_INST_HALT = Object.freeze({ type: INST_HALT, arg: 0 });

export function decodeInstWord(w) {
  if (w === 0) return PLAY_INST_NOP;
  const b30 = (w >>> 8) & 0xff;
  const b31 = w & 0xff;
  if (b30 === 0x02) return { type: INST_PATLEN, arg: (b31 & 0x3f) + 1, rows: (b31 & 0x3f) + 1 };
  if (b30 === 0x01) {
    // HALT family: arg 01xxxxxx ⇒ "halt at x" (x = 0 ⇒ full length); else plain HALT.
    if ((b31 & 0xc0) === 0x40) {
      const x = b31 & 0x3f;
      return { type: INST_HALTAT, arg: x === 0 ? 64 : x, rows: x === 0 ? 64 : x };
    }
    return PLAY_INST_HALT;
  }
  if ((b30 & 0xf0) === 0x80) return { type: INST_GOBACK, arg: ((b30 & 0xf) << 8) | b31 };
  if ((b30 & 0xf0) === 0x90) return { type: INST_SKIP, arg: ((b30 & 0xf) << 8) | b31 };
  if ((b30 & 0xf0) === 0xf0) return { type: INST_JUMP, arg: ((b30 & 0xf) << 8) | b31 };
  return PLAY_INST_NOP;
}

/** A wide cell's pitch in 65536-TET: `note` (4096-TET units, sixteenths
 *  allowed) times 16, rounded and clamped to 20 bits. */
export function wideNotePitch(note) {
  return Math.min(Math.max(Math.round(note * 16), 0), 0xfffff);
}
/** The 16-bit word a wide cell stores at bytes 0–1. */
export function wideNoteWord(note) { return wideNotePitch(note) >>> 4; }
/** The fine nibble a wide cell stores at byte 13's high nibble (0 under a sentinel). */
export function wideNoteFine(note) {
  const p = wideNotePitch(note);
  return (p >>> 4) >= 0x20 ? p & 0xf : 0;
}

// ── TaudPlayData — one pattern cell (5210-5244) ──
// Two wire layouts share these fields: the 8-byte cell of format versions 1-2
// (getByte/setByte) and version 3's 16-byte WIDE cell (getByteWide/setByteWide).
// The wide layout is a superset in meaning, not in encoding — its volume is a
// whole byte and its panning column is an azimuth plus an elevation rather than
// a 6-bit front-arc value — so the two codecs stay separate and the v2 path is
// untouched, which is what keeps it bit-exact.
export class TaudPlayData {
  constructor() {
    // 0..65535, a note word in 4096-TET units. In a wide cell it may carry a
    // fraction in sixteenths — byte 13's high nibble, the four bits that make
    // the wide cell's pitch 65536-TET (file format §5.1) — so `note` is a
    // number, not a word: every pitch path takes it as it stands, and a
    // sentinel (< $20) never has one.
    this.note = 0;
    this.noteFine = 0;   // wide decode only: byte 13's nibble as it arrived
    this.instrment = 0;  // 0..255 (sic — Kotlin field name kept for diffability)
    this.volume = 0;     // 0..63, or 0..255 in a wide cell
    this.volumeEff = 0;  // 0..3, or 0..7 in a wide cell
    this.pan = 0;        // 0..63 — the 8-byte cell's front-arc column value
    this.panEff = 0;     // 0..3, or 0..15 in a wide cell
    this.effect = 0;     // 0..255
    this.effectArg = 0;  // 0..65535
    // ── wide cell only (#v3) ──
    this.azimuth = 0;    // 0..511, the panning column's 9-bit angle
    this.elevation = 0;  // -128..127, signed
    this.effect2 = 0;    // second effect, applied after the first
    this.effectArg2 = 0;
  }

  /** Wide-cell byte view — see the file format's §5.5 table. The three pitch
   *  bytes (0, 1 and 13's high nibble) are all read off `note`, so code that
   *  writes `note` needs to know nothing about where the fraction goes. */
  getByteWide(offset) {
    switch (offset) {
      case 0: return wideNoteWord(this.note) & 0xff;
      case 1: return (wideNoteWord(this.note) >>> 8) & 0xff;
      case 2: return this.instrment & 0xff;
      case 3: return this.volume & 0xff;
      case 4: return this.azimuth & 0xff;
      case 5: return this.effect & 0xff;
      case 6: return this.effectArg & 0xff;
      case 7: return (this.effectArg >>> 8) & 0xff;
      case 8: return (((this.azimuth >>> 8) & 1) << 7) |
                     ((this.volumeEff & 7) << 4) | (this.panEff & 0xf);
      case 9: return this.elevation & 0xff;
      case 10: return this.effect2 & 0xff;
      case 11: return this.effectArg2 & 0xff;
      case 12: return (this.effectArg2 >>> 8) & 0xff;
      case 13: return wideNoteFine(this.note) << 4; // low nibble RESERVED
      case 14: case 15: return 0; // RESERVED
      default: throw new Error(`Bad offset ${offset}`);
    }
  }

  setByteWide(offset, byte) {
    switch (offset) {
      case 0: this._setWideNote((this.note & 0xff00) | byte); break;
      case 1: this._setWideNote((this.note & 0x00ff) | (byte << 8)); break;
      case 2: this.instrment = byte; break;
      case 3: this.volume = byte & 0xff; break;
      case 4: this.azimuth = (this.azimuth & 0x100) | byte; break;
      case 5: this.effect = byte; break;
      case 6: this.effectArg = (this.effectArg & 0xff00) | byte; break;
      case 7: this.effectArg = (this.effectArg & 0x00ff) | (byte << 8); break;
      case 8:
        this.azimuth = (this.azimuth & 0xff) | ((byte & 0x80) << 1);
        this.volumeEff = (byte >>> 4) & 7;
        this.panEff = byte & 0xf;
        break;
      case 9: this.elevation = byte >= 0x80 ? byte - 0x100 : byte; break;
      case 10: this.effect2 = byte; break;
      case 11: this.effectArg2 = (this.effectArg2 & 0xff00) | byte; break;
      case 12: this.effectArg2 = (this.effectArg2 & 0x00ff) | (byte << 8); break;
      case 13: this.noteFine = byte >>> 4; this._setWideNote(this.note & 0xffff); break;
      case 14: case 15: break; // RESERVED
      default: throw new Error(`Bad offset ${offset}`);
    }
  }

  /** The note from its word and the fine nibble last decoded; a sentinel word
   *  takes no fraction (§5.5: the nibble is RESERVED under one). */
  _setWideNote(word) {
    this.note = word >= 0x20 ? word + this.noteFine / 16 : word;
  }

  // The 8-byte cell has no room for a fraction: a note that carries one (a
  // pitch computed at 65536-TET and written into a narrow song) rounds to the
  // nearest word, never truncates.
  getByte(offset) {
    switch (offset) {
      case 0: return Math.round(this.note) & 0xff;
      case 1: return (Math.round(this.note) >>> 8) & 0xff;
      case 2: return this.instrment & 0xff;
      case 3: return (this.volume | (this.volumeEff << 6)) & 0xff;
      case 4: return (this.pan | (this.panEff << 6)) & 0xff;
      case 5: return this.effect & 0xff;
      case 6: return this.effectArg & 0xff;
      case 7: return (this.effectArg >>> 8) & 0xff;
      default: throw new Error(`Bad offset ${offset}`);
    }
  }

  setByte(offset, byte) {
    switch (offset) {
      case 0: this.note = (this.note & 0xff00) | byte; break;
      case 1: this.note = (this.note & 0x00ff) | (byte << 8); break;
      case 2: this.instrment = byte; break;
      case 3: this.volume = byte & 63; this.volumeEff = (byte >>> 6) & 3; break;
      case 4: this.pan = byte & 63; this.panEff = (byte >>> 6) & 3; break;
      case 5: this.effect = byte; break;
      case 6: this.effectArg = (this.effectArg & 0xff00) | byte; break;
      case 7: this.effectArg = (this.effectArg & 0x00ff) | (byte << 8); break;
      default: throw new Error(`Bad offset ${offset}`);
    }
  }
}
