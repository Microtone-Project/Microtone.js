// The Mackie Control (MCU) wire format, both ways (item 379). Pure: bytes in,
// events out, and messages to send — no ports, no DOM, no app.
//
// Mackie never published the protocol. The tables below are the ones in tsvm
// `reference_materials/mackie-control/README.md`: Ardour's MCP surface for the
// layout, checked against what a Behringer X-Touch One in its factory MC mode
// actually sends. Where they differ, the device wins.

/** The global buttons by note number (all on MIDI channel 1). */
export const BUTTON = Object.freeze({
  // assignment
  track: 0x28, send: 0x29, pan: 0x2a, plugin: 0x2b, eq: 0x2c, instrument: 0x2d,
  // banks
  bankLeft: 0x2e, bankRight: 0x2f, channelLeft: 0x30, channelRight: 0x31,
  flip: 0x32, globalView: 0x33,
  // display ("BPM/Time" on the X-Touch One is Timecode/Beats)
  nameValue: 0x34, timecodeBeats: 0x35,
  f1: 0x36, f2: 0x37, f3: 0x38, f4: 0x39, f5: 0x3a, f6: 0x3b, f7: 0x3c, f8: 0x3d,
  // global view group
  midiTracks: 0x3e, inputs: 0x3f, audioTracks: 0x40, audioInstruments: 0x41,
  aux: 0x42, busses: 0x43, outputs: 0x44, user: 0x45,
  // modifiers
  shift: 0x46, option: 0x47, control: 0x48, alt: 0x49,
  // automation
  read: 0x4a, write: 0x4b, trim: 0x4c, touch: 0x4d, latch: 0x4e, group: 0x4f,
  // utilities
  save: 0x50, undo: 0x51, cancel: 0x52, enter: 0x53,
  // transport (its Solo is not a strip's: transportSolo)
  marker: 0x54, nudge: 0x55, cycle: 0x56, drop: 0x57, replace: 0x58, click: 0x59,
  transportSolo: 0x5a, rewind: 0x5b, fastForward: 0x5c, stop: 0x5d, play: 0x5e, record: 0x5f,
  // cursor
  up: 0x60, down: 0x61, left: 0x62, right: 0x63, zoom: 0x64, scrub: 0x65,
  // the rear panel's two footswitch jacks
  userA: 0x66, userB: 0x67,
});

/** Name of each global button, by note. */
const NAME_OF = new Map(Object.entries(BUTTON).map(([k, v]) => [v, k]));

/** The eight strips' buttons: base note + strip (0…7). */
export const STRIP_BUTTON = Object.freeze({
  rec: 0x00, solo: 0x08, mute: 0x10, select: 0x18, vpotPush: 0x20,
});
const STRIP_NAMES = ["rec", "solo", "mute", "select", "vpotPush"];

/** Fader touch: strip n at 0x68 + n, the master fader at 0x70. */
export const FADER_TOUCH = 0x68;
export const MASTER_TOUCH = 0x70;

/** LEDs that are not buttons: the timecode display's two mode lamps. */
export const LED = Object.freeze({ smpte: 0x71, beats: 0x72, rudeSolo: 0x73 });

/** The master fader's pitch-bend channel (0-based; MIDI channel 9). */
export const MASTER_CHANNEL = 8;
/** A fader's travel: 14-bit pitch bend. */
export const FADER_MAX = 0x3fff;

/** The V-Pot LED ring's display modes (CC 0x30 + strip, bits 4–5). */
export const RING = Object.freeze({ dot: 0, boostCut: 1, wrap: 2, spread: 3 });

/** The SysEx header every Mackie Control message carries. */
export const SYSEX_HEADER = Object.freeze([0xf0, 0x00, 0x00, 0x66, 0x14]);

/** Characters per strip on a scribble-strip LCD, and per line on the whole
 *  display (eight strips). */
export const LCD_STRIP_CHARS = 7;
export const LCD_LINE_CHARS = 56;

/** The timecode display's ten digits, grouped 3-2-2-3. */
export const TIMECODE_DIGITS = 10;

/** A relative control's step count: bit 6 says anticlockwise, bits 0–5 how
 *  many steps (the V-Pots and the jog wheel alike). */
export function relativeDelta(v) {
  const n = v & 0x3f;
  return (v & 0x40) ? -n : n;
}

/**
 * One incoming message as an event, or null for anything that is not Mackie
 * Control (a clock, active sensing, another device's chatter):
 *
 *   {type: "button", name, strip?, down}   name: a BUTTON key, or a strip
 *                                          button's (rec/solo/mute/select/
 *                                          vpotPush) with its strip
 *   {type: "touch", strip | master, down}  a touch-sensitive fader
 *   {type: "fader", strip | master, value} 0…FADER_MAX
 *   {type: "vpot", strip, delta}           signed steps
 *   {type: "jog", delta}
 *
 * `master` is true for the master fader, whose strip is null.
 */
export function decode(bytes) {
  if (!bytes || bytes.length < 3) return null;
  const status = bytes[0] & 0xf0;
  const ch = bytes[0] & 0x0f;
  const d1 = bytes[1] & 0x7f, d2 = bytes[2] & 0x7f;
  if (status === 0xe0) {
    const value = d1 | (d2 << 7);
    if (ch === MASTER_CHANNEL) return { type: "fader", strip: null, master: true, value };
    if (ch < 8) return { type: "fader", strip: ch, master: false, value };
    return null;
  }
  if (ch !== 0) return null;
  if (status === 0x90 || status === 0x80) {
    const down = status === 0x90 && d2 !== 0;
    if (d1 < 0x28) return { type: "button", name: STRIP_NAMES[d1 >> 3], strip: d1 & 7, down };
    if (d1 >= FADER_TOUCH && d1 < FADER_TOUCH + 8) return { type: "touch", strip: d1 - FADER_TOUCH, master: false, down };
    if (d1 === MASTER_TOUCH) return { type: "touch", strip: null, master: true, down };
    const name = NAME_OF.get(d1);
    return name ? { type: "button", name, strip: null, down } : null;
  }
  if (status === 0xb0) {
    if (d1 >= 0x10 && d1 < 0x18) return { type: "vpot", strip: d1 - 0x10, delta: relativeDelta(d2) };
    if (d1 === 0x3c) return { type: "jog", delta: relativeDelta(d2) };
  }
  return null;
}

// ── outgoing ──

/** A button's (or a lamp's) LED: "off", "on" or "flash". */
export function ledMessage(note, state) {
  return [0x90, note & 0x7f, state === "on" ? 0x7f : state === "flash" ? 0x01 : 0x00];
}

/** Move a motor fader: strip 0…7, or null for the master fader. */
export function faderMessage(strip, value) {
  const v = Math.max(0, Math.min(FADER_MAX, Math.round(value)));
  return [0xe0 | (strip === null ? MASTER_CHANNEL : strip), v & 0x7f, v >> 7];
}

/** A V-Pot's LED ring: `position` 0 (dark) or 1…11, `centre` the lone LED
 *  under the ring. */
export function ringMessage(strip, mode, position, centre = false) {
  const p = Math.max(0, Math.min(11, Math.round(position)));
  return [0xb0, 0x30 + strip, (centre ? 0x40 : 0) | ((mode & 3) << 4) | p];
}

/** The seven-segment code of a character: Ardour's translate_seven_segment —
 *  upper-cased; 0x40…0x5F lose 0x40, 0x20…0x3F stand, the rest are blank. */
export function segmentCode(char) {
  const c = String(char).toUpperCase().charCodeAt(0) || 0x20;
  if (c >= 0x40 && c <= 0x5f) return c - 0x40;
  if (c >= 0x20 && c <= 0x3f) return c;
  return 0x20;
}

/**
 * The cells of a seven-segment display, left to right, from text in which a
 * "." lights the dot of the character before it ("12.34" is four cells, the
 * second dotted). Padded with blanks or cut to `width`.
 */
export function segmentCells(text, width) {
  const cells = [];
  for (const ch of String(text)) {
    if (ch === "." && cells.length > 0 && !(cells[cells.length - 1] & 0x40)) {
      cells[cells.length - 1] |= 0x40;
      continue;
    }
    cells.push(segmentCode(ch));
  }
  while (cells.length < width) cells.push(0x20);
  return cells.slice(0, width);
}

/** The timecode display's messages for `cells` (segmentCells, ten of them,
 *  left to right): digit i from the left is CC 0x49 − i. Only the cells that
 *  differ from `previous` (same shape, or null for all) are sent. */
export function timecodeMessages(cells, previous = null) {
  const out = [];
  for (let i = 0; i < TIMECODE_DIGITS; i++) {
    if (previous && previous[i] === cells[i]) continue;
    out.push([0xb0, 0x49 - i, cells[i]]);
  }
  return out;
}

/** The two-character assignment display: CC 0x4B is the LEFT character,
 *  0x4A the right (surface.cc show_two_char_display). */
export function assignmentMessages(cells) {
  return [[0xb0, 0x4b, cells[0]], [0xb0, 0x4a, cells[1]]];
}

/** Text for an LCD: printable ASCII only, anything else a "?". */
function lcdBytes(text, length) {
  const out = [];
  for (const ch of String(text)) {
    if (out.length === length) break;
    const c = ch.charCodeAt(0);
    out.push(c >= 0x20 && c < 0x7f ? c : 0x3f);
  }
  while (out.length < length) out.push(0x20);
  return out;
}

/** Write `text` to the scribble-strip LCD of `strip` (0…7), `line` 0 or 1:
 *  seven characters at offset strip × 7 of that line. */
export function lcdMessage(strip, line, text) {
  const offset = (line ? 0x38 : 0) + strip * LCD_STRIP_CHARS;
  return [...SYSEX_HEADER, 0x12, offset, ...lcdBytes(text, LCD_STRIP_CHARS), 0xf7];
}

/** A strip's level meter: channel pressure, strip << 4 | segment (0…0xC;
 *  0xE / 0xF light and clear the overload lamp). */
export function meterMessage(strip, segment) {
  return [0xd0, ((strip & 7) << 4) | (segment & 0x0f)];
}

/** Switch a strip's metering on (Ardour's Channel Meter Enable: the LCD's
 *  level meter, peak hold and signal LED, 0x07) or off. */
export function meterEnableMessage(strip, on) {
  return [...SYSEX_HEADER, 0x20, strip & 7, on ? 0x07 : 0x00, 0xf7];
}

/** Does `bytes` need SysEx permission to send? (Web MIDI refuses a SysEx
 *  message on an access granted without it.) */
export function isSysex(bytes) { return bytes[0] === 0xf0; }
