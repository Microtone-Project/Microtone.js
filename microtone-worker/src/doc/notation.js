// Custom notation definitions — the "nota" Project-Data section
// (terranmon.txt §"nota. Custom notation definition (version 'a')").
//
// A project carries up to 16 custom notations in slots 0..15; songs reference
// them through the sMet notation field with the INTERNAL values 65535 down to
// 65520 (slot 0 = 65535, slot 15 = 65520). A definition is display-only — the
// engine plays raw 4096-TET note words regardless — so edits ride the generic
// setSectionOp ({kind:"section"} dirty tag, no device upload).
//
// A definition (all integers little-endian, like every Taud table):
//   Uint8   slot (notation index 0..15)
//   Uint32  size of the record following this field
//   Uint16  flags (reserved, 0)
//   Uint16  interval in 4096-TET units (octave 0x1000, tritave 0x195C);
//           0 = "no interval system": the table then lists every note the
//           notation can express, absolutely, rather than one period's worth
//   Uint16  reserved (float32 interval, undecided upstream — write 0)
//   Uint16  note count MINUS ONE (12-TET stores 11)
//   Uint16  base note the frequency table is offset against (C4 = 0x5000);
//           0 = default C4. Offsets are unsigned, so an interval-0 notation
//           that reaches below C4 declares its lowest note here. Must be 0
//           for an interval system (the base note IS the root interval's root)
//   Byte[6] reserved
//   Byte[*] name, NUL-terminated UTF-8
//   Byte[*] notation table: one display string per degree in the TAUD CHARSET
//           (the tautfont code page), 0xFF-separated, NUL-terminated
//   Uint16[count] frequency table: 4096-TET offsets from the base note (the
//           period root for an interval system); index 0 must be 0
//
// The suggested standalone serialisation (".taudnot", for sharing definitions
// between projects) is the same repetition behind an 9-byte header:
//   Byte[8] magic \x1E T a u d n o t · Uint8 version 'a'
//
// Symbols use the same 3-char token DSL as core/tuning/pitchtables.js presets
// ([tick][letter][accidental], single-char = CJK), converted to/from the Taud
// charset here. The byte values are transcribed from taut.js `sym` (taut.js:45).

// ── notation-value ↔ slot mapping ──

export const NOTA_SLOTS = 16;
export const CUSTOM_NOTATION_MIN = 0xfff0; // slot 15
export const CUSTOM_NOTATION_MAX = 0xffff; // slot 0

export function isCustomNotation(value) {
  return value >= CUSTOM_NOTATION_MIN && value <= CUSTOM_NOTATION_MAX;
}
export function notationValueForSlot(slot) { return 0xffff - slot; }
export function slotForNotationValue(value) {
  return isCustomNotation(value) ? 0xffff - value : -1;
}

// ── Taud charset ↔ sym-token DSL ──

const TICK_TO_TAUD = { ".": 0xf9, u: 0x9a, d: 0x9b, U: 0x9c, D: 0x9d };
const TAUD_TO_TICK = Object.fromEntries(
  Object.entries(TICK_TO_TAUD).map(([k, v]) => [v, k]));

// Two-cell accidentals (normal presets): taut sym.accnull/demisharp/… pairs.
const ACC2_TO_TAUD = {
  "-": [0xa2, 0xa3], t: [0x80, 0x81], "#": [0x82, 0x83], x: [0x86, 0x87],
  3: [0x88, 0x89], 4: [0x8a, 0x8b], p: [0x8c, 0x8d], b: [0x8e, 0x8f],
  B: [0x92, 0x93], T: [0x94, 0x95],
};
const TAUD_TO_ACC2 = Object.fromEntries(
  Object.entries(ACC2_TO_TAUD).map(([k, [a, b]]) => [(a << 8) | b, k]));

// Compact one-cell accidentals (Kite-style tokens): taut sym.csharp/….
const ACC1_TO_TAUD = { "-": 0x2d, "#": 0x98, t: 0xa7, p: 0xa8 };
const TAUD_TO_ACC1 = Object.fromEntries(
  Object.entries(ACC1_TO_TAUD).map(([k, v]) => [v, k]));

// Shi'er lü glyph pairs 0xC0C1.. in file order (matches preset 10123's sym).
const CJK_LU = "黃大太夶姑仲蕤林夷南無應";

export const FALLBACK_SYM = " ?-";

/**
 * One sym token → Taud-charset bytes, mirroring taut.js exactly:
 * normal = [letter][acc ×2], Kite = [tick][letter][compact acc], Shi'er lü =
 * [space][pair]. A CJK char outside the known pairs uses the TSVM arbitrary-
 * unicode escape 0x84 + decimal codepoint + 'u'.
 */
export function symTokenToTaud(token) {
  const out = [];
  if (token.length === 1) {
    out.push(0x20);
    const i = CJK_LU.indexOf(token);
    if (i >= 0) out.push(0xc0 + i * 2, 0xc1 + i * 2);
    else {
      out.push(0x84);
      for (const ch of String(token.codePointAt(0))) out.push(ch.charCodeAt(0));
      out.push(0x75); // 'u'
    }
    return out;
  }
  const [tick, letter, acc] = token;
  if (tick !== " ") {
    out.push(TICK_TO_TAUD[tick] ?? 0x20);
    out.push(letter.charCodeAt(0));
    if (acc in ACC1_TO_TAUD) out.push(ACC1_TO_TAUD[acc]);
    else out.push(...(ACC2_TO_TAUD[acc] ?? ACC2_TO_TAUD["-"]));
  } else {
    out.push(letter.charCodeAt(0));
    out.push(...(ACC2_TO_TAUD[acc] ?? ACC2_TO_TAUD["-"]));
  }
  return out;
}

/** Taud-charset bytes → sym token; null when the bytes aren't recognised. */
export function taudToSymToken(bytes) {
  if (bytes.length === 0) return null;
  const b0 = bytes[0];
  // Shi'er lü pair / escaped unicode, taut writes them behind a leading space.
  if (b0 === 0x20 && bytes.length >= 3 && bytes[1] >= 0xc0 && bytes[1] <= 0xd6) {
    const i = (bytes[1] - 0xc0) >> 1;
    return CJK_LU[i] ?? null;
  }
  if ((b0 === 0x20 && bytes[1] === 0x84) || b0 === 0x84) {
    const esc = b0 === 0x84 ? bytes.slice(1) : bytes.slice(2);
    let dec = "";
    for (const b of esc) {
      if (b === 0x75) return dec ? String.fromCodePoint(parseInt(dec, 10)) : null;
      dec += String.fromCharCode(b);
    }
    return null;
  }
  const readAcc = (accBytes) => {
    if (accBytes.length === 0) return "-";
    if (accBytes.length === 1) return TAUD_TO_ACC1[accBytes[0]] ?? null;
    if (accBytes.length === 2) return TAUD_TO_ACC2[(accBytes[0] << 8) | accBytes[1]] ?? null;
    return null;
  };
  const isLetter = (b) => b >= 0x41 && b <= 0x5a;
  if (b0 in TAUD_TO_TICK) {
    if (bytes.length < 2 || !isLetter(bytes[1])) return null;
    const acc = readAcc(bytes.slice(2));
    return acc === null ? null : TAUD_TO_TICK[b0] + String.fromCharCode(bytes[1]) + acc;
  }
  if (isLetter(b0)) {
    const acc = readAcc(bytes.slice(1));
    return acc === null ? null : " " + String.fromCharCode(b0) + acc;
  }
  return null;
}

// ── nota payload codec ──

const te = new TextEncoder();
const td = new TextDecoder();

function encodeDef(def) {
  const name = te.encode(def.name ?? "");
  const symBytes = [];
  const syms = def.syms ?? [];
  for (let i = 0; i < def.table.length; i++) {
    if (i > 0) symBytes.push(0xff);
    symBytes.push(...symTokenToTaud(syms[i] ?? FALLBACK_SYM));
  }
  symBytes.push(0x00);
  const size = 2 + 2 + 2 + 2 + 8 + name.length + 1 + symBytes.length + def.table.length * 2;
  const out = new Uint8Array(1 + 4 + size);
  let o = 0;
  out[o++] = def.slot & 0xff;
  out[o++] = size & 0xff; out[o++] = (size >>> 8) & 0xff;
  out[o++] = (size >>> 16) & 0xff; out[o++] = (size >>> 24) & 0xff;
  out[o++] = (def.flags ?? 0) & 0xff; out[o++] = ((def.flags ?? 0) >>> 8) & 0xff;
  out[o++] = def.interval & 0xff; out[o++] = (def.interval >>> 8) & 0xff;
  out[o++] = 0; out[o++] = 0; // reserved float32-interval field
  const nm1 = def.table.length - 1;
  out[o++] = nm1 & 0xff; out[o++] = (nm1 >>> 8) & 0xff;
  // Base note: 0 means "the default C4", so an unset base stays byte-for-byte
  // what this field held while it was reserved.
  const base = (def.base ?? 0) & 0xffff;
  out[o++] = base & 0xff; out[o++] = (base >>> 8) & 0xff;
  o += 6; // reserved
  out.set(name, o); o += name.length;
  out[o++] = 0;
  out.set(Uint8Array.from(symBytes), o); o += symBytes.length;
  for (const v of def.table) { out[o++] = v & 0xff; out[o++] = (v >>> 8) & 0xff; }
  return out;
}

/** Serialise definitions (ascending slot order) into a nota section payload. */
export function buildNotaPayload(defs) {
  const parts = [...defs].sort((a, b) => a.slot - b.slot).map(encodeDef);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Parse a nota section payload → [{slot, flags, interval, base, name, table, syms}].
 * Unknown/undecodable symbol strings become null entries in `syms` (the preset
 * builder substitutes FALLBACK_SYM); malformed trailing records are dropped.
 */
export function parseNotaPayload(u8) {
  const defs = [];
  let o = 0;
  while (o + 5 <= u8.length) {
    const slot = u8[o];
    const size = u8[o + 1] | (u8[o + 2] << 8) | (u8[o + 3] << 16) | (u8[o + 4] << 24);
    const body = u8.subarray(o + 5, o + 5 + size);
    o += 5 + size;
    if (body.length < 16) break;
    const flags = body[0] | (body[1] << 8);
    const interval = body[2] | (body[3] << 8);
    const count = (body[6] | (body[7] << 8)) + 1;
    const base = body[8] | (body[9] << 8); // 0 = default C4
    let p = 16;
    const nameEnd = body.indexOf(0, p);
    if (nameEnd < 0) break;
    const name = td.decode(body.subarray(p, nameEnd));
    p = nameEnd + 1;
    // notation table: count strings, 0xFF-separated, the whole table NUL-terminated
    const syms = [];
    let start = p;
    while (p < body.length && syms.length < count) {
      if (body[p] === 0xff || body[p] === 0x00) {
        syms.push(taudToSymToken(Array.from(body.subarray(start, p))));
        if (body[p] === 0x00) { p++; break; }
        start = ++p;
      } else p++;
    }
    while (syms.length < count) syms.push(null);
    const table = [];
    for (let i = 0; i < count && p + 2 <= body.length; i++, p += 2) {
      table.push(body[p] | (body[p + 1] << 8));
    }
    while (table.length < count) table.push(0);
    defs.push({ slot, flags, interval, base, name, table, syms });
  }
  return defs;
}

// ── .taudnot standalone file ──

const TAUDNOT_MAGIC = [0x1e, 0x54, 0x61, 0x75, 0x64, 0x6e, 0x6f, 0x74]; // \x1ETaudnot
const TAUDNOT_VERSION = 0x61; // 'a'

export function buildTaudnot(defs) {
  const payload = buildNotaPayload(defs);
  const out = new Uint8Array(9 + payload.length);
  out.set(TAUDNOT_MAGIC, 0);
  out[8] = TAUDNOT_VERSION;
  out.set(payload, 9);
  return out;
}

/** Parse a .taudnot file; returns defs or null when the magic doesn't match. */
export function parseTaudnot(bytes) {
  if (bytes.length < 9) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== TAUDNOT_MAGIC[i]) return null;
  if (bytes[8] !== TAUDNOT_VERSION) return null;
  return parseNotaPayload(bytes.subarray(9));
}

// ── Scala .scl import ──

/**
 * Parse Scala .scl text (https://www.huygens-fokker.org/scala/scl_format.html):
 * '!' lines are comments; first non-comment line = description, second = note
 * count, then one pitch per line — cents when the value contains '.', else a
 * ratio ("3/2" or a bare integer). 1/1 is implicit; the LAST pitch is the
 * formal period (octave/tritave/…). Returns {name, cents:[...]} (cents EXCLUDE
 * the implicit 1/1, INCLUDE the period as the last entry). Throws on malformed
 * input with a human-readable message.
 */
export function parseScl(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => !l.trimStart().startsWith("!"));
  if (lines.length < 2) throw new Error("not a Scala file (missing header lines)");
  const name = lines[0].trim();
  const count = parseInt(lines[1].trim(), 10);
  if (!Number.isFinite(count) || count < 0) throw new Error("bad note count line");
  if (count === 0) throw new Error("empty scale (0 notes)");
  const cents = [];
  for (let i = 0; i < count; i++) {
    const line = lines[2 + i];
    if (line === undefined) throw new Error(`missing pitch line ${i + 1} of ${count}`);
    const tok = line.trim().split(/\s+/)[0];
    if (!tok) throw new Error(`blank pitch line ${i + 1}`);
    let c;
    if (tok.includes(".")) {
      c = parseFloat(tok);
      if (!Number.isFinite(c)) throw new Error(`bad cents value "${tok}"`);
    } else {
      const m = tok.match(/^(\d+)(?:\/(\d+))?$/);
      if (!m) throw new Error(`bad ratio "${tok}"`);
      const num = parseInt(m[1], 10);
      const den = m[2] !== undefined ? parseInt(m[2], 10) : 1;
      if (num <= 0 || den <= 0) throw new Error(`bad ratio "${tok}"`);
      c = 1200 * Math.log2(num / den);
    }
    cents.push(c);
  }
  return { name, cents };
}

/** Cents → 4096-TET units (0x1000 per octave). */
export function centsToUnits(cents) { return Math.round((cents * 4096) / 1200); }
export function unitsToCents(units) { return (units * 1200) / 4096; }

/**
 * Parsed .scl → a notation definition for `slot`. Degree 0 (the implicit 1/1)
 * becomes table[0] = 0; the last listed pitch becomes the interval. Symbols
 * are auto-assigned by nearest-24-TET (editable afterwards).
 */
export function sclToDef(parsed, slot) {
  const units = parsed.cents.map(centsToUnits);
  const interval = units[units.length - 1];
  const table = [0, ...units.slice(0, -1)];
  const def = { slot, flags: 0, interval, name: parsed.name, table, syms: [] };
  def.syms = autoAssignSyms(def, "nearest");
  return def;
}

// ── symbol auto-assignment ──

// SYM_24 from pitchtables.js — the quarter-tone naming grid used for the
// "nearest" mode (kept local: doc/ must not import from ui/).
const NEAREST_24 = [" C-", " Ct", " C#", " Dp", " D-", " Dt", " D#", " Ep", " E-", " Et", " F-", " Ft",
                    " F#", " Gp", " G-", " Gt", " G#", " Ap", " A-", " At", " A#", " Bp", " B-", " Bt"];
const SEQ_LETTERS = 26; // A..Z

// Sequence-mode variant ladders (item 72.1), as [tick, accidental] pairs of the
// 3-char DSL. A scale with more than 26 degrees can't get a letter each, so the
// letters are spread evenly and the degrees sharing one are told apart by a
// variant from the ladder that fits — ladders ascend, and are the sets the
// notation spec fixes: 2 → [♮ ♯], 3 → [v · ^], 4 → [v · ^ ^^], 5 → [vv v · ^ ^^].
// (The old scheme instead ran A..Z then restarted at A with a tick, so degree 27
// read ·A — a step DOWN from Z, which is why this exists.)
//
// In a TICK-BEARING ladder the middle (·) is the Kite big-dot '.', NOT ' ':
// ' ' means the preset has no tick column at all (12-TET " C-"), while every
// shipped Kite table spells its unmarked degree with the dot (41-TET (Kite)
// ".C-", SYM_96 "." + name). Dropping the dot would render those degrees with a
// blank tick slot — inconsistent with the presets the user already reads.
const SEQ_LADDERS = [
  null,
  [" -"],                               // 1: plain letters, no tick column
  [" -", " #"],                         // 2: ♮ ♯ — still no ticks
  ["d-", ".-", "u-"],                   // 3: v · ^
  ["d-", ".-", "u-", "U-"],             // 4: v · ^ ^^
  ["D-", "d-", ".-", "u-", "U-"],       // 5: vv v · ^ ^^
];
// Past 5 per letter the spec stops naming ladders, so we build them (item 88).
// The whole accidental palette the glyph painter can draw, in ascending pitch
// order — ♭♭♭ ♭♭ ♭ demiflat ♮ demisharp ♯ 𝄪 ♯𝄪 𝄪𝄪:
const ACC_ASC = ["T", "B", "b", "p", "-", "t", "#", "x", "3", "4"];
const ACC_NEUTRAL = 4;                              // index of '-' (♮)
// …and the tick ladder, ascending: vv v · ^ ^^.
const TICK_ASC = ["D", "d", ".", "u", "U"];
const TICK_NEUTRAL = 2;                             // index of '.' (the Kite dot)

/** `k` consecutive entries of `list` centred on `neutral` (the whole list when
 *  it is too short — the caller then cycles). */
function centredWindow(list, neutral, k) {
  if (k >= list.length) return list.slice();
  const start = Math.min(Math.max(neutral - ((k - 1) >> 1), 0), list.length - k);
  return list.slice(start, start + k);
}

/**
 * Variant ladder for `per` degrees sharing one letter. Up to 5 the spec's fixed
 * tick ladders; past that accidentals carry the distinction — a bare A..Z run
 * with only ticks runs out at 5 and used to cycle, which is what made a
 * 1200-EDO table repeat the same symbol every 10 degrees (item 88).
 *   6..10   accidentals alone, ♮ in the middle, no tick column
 *   11..50  accidental (coarse) × tick (fine) — 50 distinct variants, so every
 *           scale up to 26 × 50 = 1300 degrees still names each degree once
 * Beyond that the caller cycles; such a scale is past readable naming anyway.
 */
function ladderFor(per) {
  if (per <= 5) return SEQ_LADDERS[per];
  if (per <= ACC_ASC.length) {
    return centredWindow(ACC_ASC, ACC_NEUTRAL, per).map((a) => " " + a);
  }
  const cross = [];
  for (const acc of ACC_ASC) for (const tick of TICK_ASC) cross.push(tick + acc);
  return centredWindow(cross, ACC_NEUTRAL * TICK_ASC.length + TICK_NEUTRAL, per);
}

/** Sequence mode: plain ascending letters, extended by variant when a scale has
 *  more degrees than letters. Degrees spread evenly over all 26 letters. */
function sequenceSyms(n) {
  const out = [];
  if (n <= SEQ_LETTERS) { // a letter each: A, B, C…
    for (let i = 0; i < n; i++) out.push(" " + String.fromCharCode(0x41 + i) + "-");
    return out;
  }
  const per = Math.ceil(n / SEQ_LETTERS);
  const ladder = ladderFor(per);
  // Even spread → each letter's run is `per` or `per - 1` long, so a run never
  // outgrows its ladder; a degree's variant is its position within that run.
  let runStart = 0, runLetter = 0;
  for (let i = 0; i < n; i++) {
    const letter = Math.floor((i * SEQ_LETTERS) / n);
    if (letter !== runLetter) { runStart = i; runLetter = letter; }
    const v = ladder[(i - runStart) % ladder.length];
    out.push(v[0] + String.fromCharCode(0x41 + letter) + v[1]);
  }
  return out;
}

/**
 * Generate a full sym list for a definition:
 *   'nearest'  nearest quarter-tone name (12-TET letters + demi accidentals),
 *              wrapped into the octave — a musical starting point;
 *   'sequence' ascending letters A, B, C…, sharing letters by variant once a
 *              scale outruns the alphabet — a neutral scheme for scales that
 *              fight diatonic names.
 */
export function autoAssignSyms(def, mode = "nearest") {
  const n = def.table.length;
  if (mode === "sequence") return sequenceSyms(n);
  const out = [];
  for (let i = 0; i < n; i++) {
    const deg = ((Math.round((def.table[i] * 24) / 0x1000) % 24) + 24) % 24;
    out.push(NEAREST_24[deg]);
  }
  return out;
}

// ── preset bridge + validation ──

/**
 * Definition → a pitch-table preset consumable by everything in
 * core/tuning/pitchtables.js / glyphs.js (index = the internal notation value).
 * An interval-less definition (interval 0) becomes an ABSOLUTE preset: the
 * table is every note the notation can express, offset from the definition's
 * base note — or C4 when it declares none, which `presetBase` supplies.
 * ProTracker pitch is the built-in example of the same mode.
 */
export function defToPreset(def) {
  const index = notationValueForSlot(def.slot);
  const name = def.name || `Custom ${def.slot}`;
  const absolute = def.interval === 0;
  // Degrees per OCTAVE drives the type badge. For an interval preset that is
  // the table length (when the interval is the octave); an absolute table has
  // no interval, so measure across the span it actually covers.
  const last = def.table[def.table.length - 1] || 0;
  const density = absolute && def.table.length > 1 && last > 0
    ? Math.round((def.table.length - 1) / (last / 0x1000))
    : def.table.length;
  const p = {
    index, name,
    table: def.table.slice(),
    interval: def.interval,
    t: density === 12 && (absolute || def.interval === 0x1000) ? "d"
      : density <= 10 ? "M" : "m",
    sym: def.syms.map((s) => s ?? FALLBACK_SYM),
    custom: true, slot: def.slot,
  };
  // Only carry a base when the definition declares one — 0 means "default C4",
  // which presetBase already supplies, and interval presets never use it.
  if (absolute && def.base) p.base = def.base;
  return p;
}

/**
 * Sanity-check a definition; returns issue codes (empty = good):
 *   'count'     no degrees / more than 4096
 *   'zeroFirst' table[0] is not 0 (spec requirement)
 *   'ascending' offsets not strictly ascending
 *   'range'     an offset or the interval exceeds Uint16
 *   'interval'  interval is negative, or not above the last degree
 *   'base'      base note exceeds Uint16, or is declared on an interval system
 *               (there the base note IS the root interval's root, so the field
 *               must stay 0 — move the tuning with the song table instead)
 *
 * interval 0 is legal: it is the spec's "not using an interval system (which
 * means you are responsible for defining every note expressible)" mode, where
 * the degrees are absolute notes rather than one period's worth, so there is
 * no period for them to fit inside.
 */
export function validateDef(def) {
  const issues = [];
  const t = def.table;
  if (t.length < 1 || t.length > 4096) issues.push("count");
  if (t.length >= 1 && t[0] !== 0) issues.push("zeroFirst");
  for (let i = 1; i < t.length; i++) {
    if (t[i] <= t[i - 1]) { issues.push("ascending"); break; }
  }
  if (t.some((v) => v < 0 || v > 0xffff) || def.interval > 0xffff || def.interval < 0) {
    issues.push("range");
  }
  if (def.interval !== 0
      && (def.interval < 0 || (t.length > 0 && def.interval <= t[t.length - 1]))) {
    issues.push("interval");
  }
  const base = def.base ?? 0;
  if (base < 0 || base > 0xffff || (base !== 0 && def.interval !== 0)) {
    issues.push("base");
  }
  return issues;
}
