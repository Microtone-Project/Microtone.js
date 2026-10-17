// OPL instrument editing (item 209) — the patch of a type-8 instrument as fields,
// and the record bytes that carry them (TAUD_FILE_FORMAT §7.8).
//
// A type-8 record is an ordinary instrument record, so everything but the patch
// is edited the ordinary way; the patch lives in bytes 197…250 and is edited as
// bytes too, through setInstBytesOp, which TaudInst.setByte decodes in place —
// a voice sounding the instrument hears the edit at once, as a chip channel
// does when a driver rewrites its registers.
//
// The operator fields are named after the chip's own, as IMS Studio names them
// (theimsarchive-web studio/instruments.js): AR DR SL RR TL KSL MULT WS, and the
// AM / VIB / EG / KSR switches.

import {
  OPL_BLOCK_START, OPL_B_KIND, OPL_B_C0A, OPL_B_C0B, OPL_B_PARTNER_MULT,
  OPL_B_PARTNER_DETUNE, OPL_B_OPS, OPL_OP_BYTES, OPL_KIND_MASK, OPL_KIND_OPERATORS,
  OPL_KIND_2OP, OPL_KIND_4OP, OPL_KIND_BD, OPL_KIND_SD, OPL_KIND_TOM, OPL_KIND_TC,
  OPL_KIND_HH, OPL_FLAG_DEEP_TREMOLO, OPL_FLAG_DEEP_VIBRATO, OPL_FLAG_NTS,
  OPL_FLAG_LOW_FNUM, encodeOplPatch,
} from "../../core/engine/opl.js";
import { buildOplRecord } from "../../core/engine/inst.js";

export {
  OPL_KIND_2OP, OPL_KIND_4OP, OPL_KIND_BD, OPL_KIND_SD, OPL_KIND_TOM, OPL_KIND_TC,
  OPL_KIND_HH, OPL_KIND_OPERATORS,
};

/** The operator fields, in the order the editor shows them, with their widths. */
export const OPL_OP_FIELDS = [
  { key: "ar", max: 15 }, { key: "dr", max: 15 }, { key: "sl", max: 15 }, { key: "rr", max: 15 },
  { key: "tl", max: 63 }, { key: "ksl", max: 3 }, { key: "mult", max: 15 }, { key: "ws", max: 7 },
  { key: "am", max: 1 }, { key: "vib", max: 1 }, { key: "eg", max: 1 }, { key: "ksr", max: 1 },
];

/** Where each operator field lives in its five register bytes: [byte, shift, mask]. */
const FIELD_BITS = {
  am: [0, 7, 1], vib: [0, 6, 1], eg: [0, 5, 1], ksr: [0, 4, 1], mult: [0, 0, 15],
  ksl: [1, 6, 3], tl: [1, 0, 63],
  ar: [2, 4, 15], dr: [2, 0, 15],
  sl: [3, 4, 15], rr: [3, 0, 15],
  ws: [4, 0, 7],
};

/** The chip-wide switches byte 197 carries beside the kind. */
export const OPL_SWITCHES = {
  deepTremolo: OPL_FLAG_DEEP_TREMOLO, deepVibrato: OPL_FLAG_DEEP_VIBRATO,
  nts: OPL_FLAG_NTS, lowFnum: OPL_FLAG_LOW_FNUM,
};

const rawOf = (inst) => inst.oplRaw;

/** Operator `i`'s fields as plain numbers — the SUSTAIN LEVEL as its 4-bit
 *  field, which the decoded patch has already turned into envelope steps. */
export function oplOperator(inst, i) {
  const raw = rawOf(inst);
  const o = OPL_B_OPS + i * OPL_OP_BYTES;
  const out = {};
  for (const [key, [b, shift, mask]] of Object.entries(FIELD_BITS)) {
    out[key] = (raw[o + b] >> shift) & mask;
  }
  return out;
}

/** The patch as the editor reads it: kind, switches, both channels, partner. */
export function oplFields(inst) {
  const raw = rawOf(inst);
  const k = raw[OPL_B_KIND];
  const pd = raw[OPL_B_PARTNER_DETUNE] | (raw[OPL_B_PARTNER_DETUNE + 1] << 8);
  return {
    kind: k & OPL_KIND_MASK,
    deepTremolo: (k & OPL_FLAG_DEEP_TREMOLO) !== 0,
    deepVibrato: (k & OPL_FLAG_DEEP_VIBRATO) !== 0,
    nts: (k & OPL_FLAG_NTS) !== 0,
    lowFnum: (k & OPL_FLAG_LOW_FNUM) !== 0,
    feedback: (raw[OPL_B_C0A] >> 1) & 7,
    cntA: raw[OPL_B_C0A] & 1,
    cntB: raw[OPL_B_C0B] & 1,
    partnerMult: raw[OPL_B_PARTNER_MULT] & 15,
    partnerDetune: pd >= 0x8000 ? pd - 0x10000 : pd,
    ops: [0, 1, 2, 3].map((i) => oplOperator(inst, i)),
  };
}

/** [[recordOffset, byte]] pairs that set operator `i`'s `key` to `value`. */
export function oplOpBytes(inst, i, key, value) {
  const [b, shift, mask] = FIELD_BITS[key];
  const at = OPL_B_OPS + i * OPL_OP_BYTES + b;
  const old = rawOf(inst)[at];
  const v = (old & ~(mask << shift)) | ((value & mask) << shift);
  return [[OPL_BLOCK_START + at, v]];
}

/** …the kind. Operators beyond the old kind's are left as they were, so a
 *  trip to another kind and back loses nothing — except that a four-operator
 *  kind whose second pair has never been written gets IMS Studio's start
 *  (studio/instruments.js `fourOp`): the first pair, then the same again, the
 *  second channel connected as the first is. A blank pair has no attack and
 *  would silence the chain it ends. */
export function oplKindBytes(inst, kind) {
  const raw = rawOf(inst);
  const old = raw[OPL_B_KIND];
  const out = [[OPL_BLOCK_START + OPL_B_KIND, (old & ~OPL_KIND_MASK) | (kind & OPL_KIND_MASK)]];
  const second = OPL_B_OPS + 2 * OPL_OP_BYTES;
  if ((kind & OPL_KIND_MASK) === OPL_KIND_4OP &&
      raw.subarray(second, second + 2 * OPL_OP_BYTES).every((b) => b === 0)) {
    for (let i = 0; i < 2 * OPL_OP_BYTES; i++) {
      out.push([OPL_BLOCK_START + second + i, raw[OPL_B_OPS + i]]);
    }
    out.push([OPL_BLOCK_START + OPL_B_C0B, (raw[OPL_B_C0B] & ~1) | (raw[OPL_B_C0A] & 1)]);
  }
  return out;
}

/** …one of the chip switches. */
export function oplSwitchBytes(inst, name, on) {
  const bit = OPL_SWITCHES[name];
  const old = rawOf(inst)[OPL_B_KIND];
  return [[OPL_BLOCK_START + OPL_B_KIND, on ? old | bit : old & ~bit]];
}

/** …a channel's feedback (channel A only; the chip has no other) or connection. */
export function oplChannelBytes(inst, channel, key, value) {
  const at = channel === 0 ? OPL_B_C0A : OPL_B_C0B;
  const old = rawOf(inst)[at];
  const v = key === "feedback"
    ? (old & ~0x0e) | ((value & 7) << 1)
    : (old & ~1) | (value & 1);
  return [[OPL_BLOCK_START + at, v]];
}

/** …the rhythm partner's multiplier. */
export function oplPartnerMultBytes(value) {
  return [[OPL_BLOCK_START + OPL_B_PARTNER_MULT, value & 15]];
}

/** …the rhythm partner's channel pitch, S16 4096-TET from the voice's own. */
export function oplPartnerDetuneBytes(value) {
  const v = Math.max(-32768, Math.min(32767, Math.round(value))) & 0xffff;
  return [[OPL_BLOCK_START + OPL_B_PARTNER_DETUNE, v & 0xff],
    [OPL_BLOCK_START + OPL_B_PARTNER_DETUNE + 1, (v >>> 8) & 0xff]];
}

/** Which operators a kind plays (the others are kept, not shown). */
export function oplOperatorCount(kind) {
  return OPL_KIND_OPERATORS[kind & OPL_KIND_MASK];
}

/** Whether a kind is one of the noise drums, whose sound reads a partner. */
export function oplHasPartner(kind) {
  return kind === OPL_KIND_SD || kind === OPL_KIND_TC || kind === OPL_KIND_HH;
}

/**
 * IMS Studio's starting voice (studio/instruments.js `defaultVoice`): a sine
 * carrier with a quiet modulator, both sustaining. What a new OPL instrument starts as.
 */
export function defaultOplRecord() {
  return buildOplRecord(encodeOplPatch({
    kind: OPL_KIND_2OP,
    ops: [
      { mult: 1, tl: 32, ar: 15, dr: 4, sl: 4, rr: 6, eg: 1 },
      { mult: 1, tl: 0, ar: 15, dr: 2, sl: 3, rr: 6, eg: 1 },
    ],
  }));
}

/** What the list badge says an OPL instrument is. */
export function oplBadge(inst) {
  const kind = inst.opl.kind;
  return ["OPL", "OPL·4", "OPL·BD", "OPL·SD", "OPL·TOM", "OPL·CY", "OPL·HH", "OPL·?"][kind & 7];
}
