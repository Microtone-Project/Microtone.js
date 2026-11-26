// A Mackie Control surface as the tracker's second keyboard (item 379).
//
// What each control does is the app's, reached through a HOST the shell
// builds (app.js) — so this file knows the protocol's names and the editing
// rules, and nothing of the views. The rules:
//
//   - Mackie Control groups faders in banks of eight strips. That is ignored:
//     every strip's buttons, knob and fader act on the lane being edited, and
//     every strip's lamps show that lane.
//   - The knob and the fader WRITE: `S $8xxx` / `X $eeaa` and `M $xx00` into
//     the cursor's cell, in record mode only, as the keyboard does. The master
//     fader writes `V $xx00`. A touch-to-release movement is ONE undo step.
//   - Lamps, the motor fader, the knob's ring and the displays are sent only
//     when they change (`frame()`, from the app's animation frame) — except
//     the motor, which is also sent again after a hand moved it and every
//     FADER_REFRESH_MS (see `forgetFader`).
//
// The protocol itself is ../midi/mackie.js.

import {
  decode, BUTTON, STRIP_BUTTON, LED, FADER_MAX, RING,
  ledMessage, faderMessage, ringMessage, segmentCells, timecodeMessages,
  assignmentMessages, lcdMessage, meterMessage, meterEnableMessage, TIMECODE_DIGITS,
} from "../midi/mackie.js";
import { EffectOp } from "../../core/engine/tables.js";
import { SURROUND_STEREO, SURROUND_SPATIAL } from "../../core/engine/spatial.js";

/** Held arrows repeat as a held key does. */
const REPEAT_DELAY_MS = 400;
const REPEAT_EVERY_MS = 60;
/** A fader with no touch sensing moves in bursts; a pause this long ends the
 *  burst's undo step. */
const UNTOUCHED_GESTURE_MS = 400;
/** The knob has no touch: detents this close together are one turn, and one
 *  undo step (on one cell — another cell is another step anyway). */
const KNOB_GESTURE_MS = 1000;
/** …and a touch this soon after the last movement continues it. */
const TOUCH_GRACE_MS = 400;
/** After a move, the motor leaves the fader alone this long. */
const MOTOR_HOLD_MS = 300;
/** The motor's position is sent again this often even when it has not
 *  changed (see `forgetFader`). */
const FADER_REFRESH_MS = 1000;
/** How long a written value stays on the scribble strip. */
const STATUS_MS = 1500;

/** One knob detent, in each command's own units: a stereo pan byte, a 512-unit
 *  azimuth (`S $8xxx`), X's 256-unit azimuth and its signed elevation. All
 *  about 2.8° of turn, or a 64th of the stereo field. */
const STEP_PAN = 4;
const STEP_AZ9 = 4;
const STEP_AZ8 = 2;
const STEP_EL = 2;

/**
 * The strip the surface is kept on. A one-fader surface (the X-Touch One)
 * walks the eight strips ITSELF with its Channel ◀ ▶ and says so with the next
 * strip's Select, and it follows the strip whose Select the host lights. So
 * the host lights strip 4's and puts it back there after every step: a Select
 * from strip 4 is the Select button, one from another strip is a step of that
 * many lanes. (On an eight-strip surface: strip k's Select goes to the lane
 * k − 4 from the cursor's.)
 */
export const HOME_STRIP = 3;

/**
 * The jog wheel. The X-Touch One's is coarse and rate-limited: one step per
 * message, a message per ~51 ms at most however fast it turns, and about one
 * a second on a slow, steady turn (tsvm reference_materials/mackie-control,
 * the CC capture). So a step is worth more the closer it follows the last:
 * `jogGain` units of JOG_ROWS rows, kept as a fraction, and the cursor moves
 * only by whole units, onto every JOG_ROWS-th row — so a turn back and forth
 * comes back to where it began rather than drifting.
 */
export const JOG_ROWS = 2;
const JOG_TICK_MS = 50;   // the device's fastest message rate (~51 ms apart)
const JOG_SLOW_MS = 400;  // at least this far apart: one unit a step
const JOG_RESET_MS = 600; // a pause this long starts the speed afresh

/** Units a jog step is worth, from the (smoothed) time since the last: 1 when
 *  slow, rising to about 4 at the device's fastest. */
export function jogGain(gapMs) {
  const g = Math.max(JOG_TICK_MS, gapMs);
  return g >= JOG_SLOW_MS ? 1 : Math.pow(JOG_SLOW_MS / g, 2 / 3);
}

/** Rows to move from `row` by `units` whole jog units: onto the JOG_ROWS grid
 *  (from between two of its rows, the first unit lands on the next one in
 *  that direction). `row` null (no row grid: the Cues view) moves plainly. */
export function jogRows(row, units) {
  if (row === null || row === undefined) return units * JOG_ROWS;
  const target = units > 0
    ? Math.floor(row / JOG_ROWS) * JOG_ROWS + units * JOG_ROWS
    : Math.ceil(row / JOG_ROWS) * JOG_ROWS + units * JOG_ROWS;
  return target - row;
}

/**
 * The level meter: the cursor lane's peak, in dB of full scale, on the strip's
 * LED meter (channel pressure: strip << 4 | segment). 0x0…0xB follow Ardour's
 * deflection curve (reference_materials/mackie-control/ardour/meter.cc: −60 dB
 * near the bottom, 0 dB at the top), and 0xC is CLIPPING: the lane at or over
 * full scale, held CLIP_HOLD_MS so it is seen. A rise shows at once; a fall is
 * eased at METER_FALL_DB_S, and a lit meter is sent again every
 * METER_REFRESH_MS so a surface's own decay cannot take it down early.
 */
export const METER_CLIP = 0xc;
const METER_TOP = 0xb;
const METER_FALL_DB_S = 24;
const METER_REFRESH_MS = 250;
const CLIP_HOLD_MS = 1000;

/** Ardour's meter deflection, 0…100 % at 0 dBFS (calculate_meter_over_and_deflection). */
export function meterDeflection(dB) {
  if (dB < -70) return 0;
  if (dB < -60) return (dB + 70) * 0.25;
  if (dB < -50) return (dB + 60) * 0.5 + 2.5;
  if (dB < -40) return (dB + 50) * 0.75 + 7.5;
  if (dB < -30) return (dB + 40) * 1.5 + 15;
  if (dB < -20) return (dB + 30) * 2 + 30;
  return Math.min(100, (dB + 20) * 2.5 + 50);
}

/** The meter's segment for a level in dBFS: 0xC at or over full scale. */
export function meterSegment(dB) {
  if (!(dB > -Infinity)) return 0;
  if (dB >= 0) return METER_CLIP;
  return Math.max(0, Math.min(METER_TOP, Math.round((meterDeflection(dB) / 100) * METER_TOP)));
}

/** The function keys: the tabs, as F1…F7 are on the keyboard; F8 splits. */
const F_KEYS = ["f1", "f2", "f3", "f4", "f5", "f6", "f7"];
const ARROW_CODE = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" };

const isS8 = (op, arg) => op === EffectOp.OP_S && (arg & 0xf000) === 0x8000;
const isX = (op) => op === EffectOp.OP_X;
const isM = (op) => op === EffectOp.OP_M;
const isV = (op) => op === EffectOp.OP_V;

/**
 * Where an effect goes in a cell: over the same command if the cell has one
 * (either slot, the second only where it is shown), else the first empty
 * slot, else over the first slot. Returns the fields to write.
 */
export function effectFields(cell, match, effect, effectArg, slot2Shown) {
  if (match(cell.effect, cell.effectArg)) return { effect, effectArg };
  if (slot2Shown && match(cell.effect2, cell.effectArg2)) return { effect2: effect, effectArg2: effectArg };
  if (cell.effect === EffectOp.OP_NONE && cell.effectArg === 0) return { effect, effectArg };
  if (slot2Shown && cell.effect2 === EffectOp.OP_NONE && cell.effectArg2 === 0) {
    return { effect2: effect, effectArg2: effectArg };
  }
  return { effect, effectArg };
}

/** The argument of the command `match` finds in a cell (the second slot is
 *  applied after the first, so it wins), or null. */
export function cellArg(cell, match) {
  if (!cell) return null;
  if (match(cell.effect2, cell.effectArg2)) return { effect: cell.effect2, arg: cell.effectArg2 };
  if (match(cell.effect, cell.effectArg)) return { effect: cell.effect, arg: cell.effectArg };
  return null;
}

/**
 * The lane's position as the knob edits it, for `model`: {az, el} with az in
 * the units the model's command writes (stereo pan byte, 512-unit azimuth, or
 * X's 256-unit one). A command in the cell itself wins over the lane's live
 * state, because the cell is what is being edited.
 */
export function panStart(model, cell, live) {
  if (model === SURROUND_STEREO) {
    const c = cellArg(cell, isS8);
    return { az: c ? c.arg & 0xff : Math.max(0, Math.min(255, Math.round(live.az))), el: 0 };
  }
  const c = cellArg(cell, (op, arg) => isS8(op, arg) || isX(op));
  let az9 = live.az, el = live.el;
  if (c && isX(c.effect)) { az9 = (c.arg & 0xff) * 2; el = (c.arg << 16) >> 24; }
  else if (c) az9 = c.arg & 0x1ff;
  if (model === SURROUND_SPATIAL) return { az: Math.round(az9 / 2) & 0xff, el: Math.max(-128, Math.min(127, Math.round(el))) };
  return { az: Math.round(az9) & 0x1ff, el: 0 };
}

/** Turn the knob `delta` detents: the new {az, el} and the cell's command. */
export function panTurn(model, start, delta, axis) {
  if (model === SURROUND_STEREO) {
    const az = Math.max(0, Math.min(255, start.az + delta * STEP_PAN));
    return { az, el: 0, effect: EffectOp.OP_S, arg: 0x8000 | az };
  }
  if (model !== SURROUND_SPATIAL) {
    const az = (((start.az + delta * STEP_AZ9) % 512) + 512) % 512;
    return { az, el: 0, effect: EffectOp.OP_S, arg: 0x8000 | az };
  }
  let { az, el } = start;
  if (axis === "elevation") el = Math.max(-128, Math.min(127, el + delta * STEP_EL));
  else az = (((az + delta * STEP_AZ8) % 256) + 256) % 256;
  return { az, el, effect: EffectOp.OP_X, arg: ((el & 0xff) << 8) | az };
}

/** The knob's ring for a position: {mode, pos 1…11, centre}. Stereo and the
 *  azimuths read as a dot that is in the middle at the centre / front and at
 *  the ends at the far left/right (stereo) or behind (azimuth); elevation
 *  reads boost/cut from the horizon. */
export function panRing(model, p, axis) {
  if (model === SURROUND_SPATIAL && axis === "elevation") {
    return { mode: RING.boostCut, pos: 6 + Math.round((p.el / 128) * 5), centre: p.el === 0 };
  }
  let frac; // −1 … 1, 0 at the centre / front
  if (model === SURROUND_STEREO) frac = (p.az - 128) / 128;
  else {
    const units = model === SURROUND_SPATIAL ? 256 : 512;
    let d = p.az - units / 4; // front is a quarter turn from left
    if (d > units / 2) d -= units;
    if (d <= -units / 2) d += units;
    frac = d / (units / 2);
  }
  frac = Math.max(-1, Math.min(1, frac));
  return { mode: RING.dot, pos: 6 + Math.round(frac * 5), centre: Math.abs(frac) < 1 / 64 };
}

/** A fader's 14 bits as a 0…255 level, and back. */
export const faderLevel = (v) => Math.round((v * 255) / FADER_MAX);
export const levelFader = (l) => Math.round((l * FADER_MAX) / 255);

/** The two readings of the timecode display, ten characters each (3-2-2-3).
 *  `pos` is {cue, row (in the cue), speed, bpm, barsBefore (whole bars of the
 *  cues before), pri, sec}. */
export function positionText(pos, beats) {
  const pad = (v, n, radix = 10) => {
    const s = Math.max(0, Math.floor(v)).toString(radix).toUpperCase();
    return s.length > n ? s.slice(-n) : s.padStart(n, " ");
  };
  if (beats) {
    // bars / beats / subdivision, from the row highlights: a bar is `sec`
    // rows, a beat `pri`, a subdivision one row. All counted from 1.
    // rows per bar, `pri` per beat, a subdivision one row — restarting with
    // every cue as the grid's banding does, so a bar is counted the way the
    // grid draws it. All counted from 1.
    const bar = pos.barsBefore + Math.floor(pos.row / pos.sec) + 1;
    const inBar = pos.row % pos.sec;
    const beat = Math.floor(inBar / pos.pri) + 1;
    const sub = (inBar % pos.pri) + 1;
    return pad(bar, 3) + pad(beat, 2) + pad(sub, 2) + "   ";
  }
  // cue / row / speed in hex, as the grids and A / B / C write them; BPM in
  // decimal, as the top bar shows it.
  const zero = (v, n) => pad(v, n, 16).replaceAll(" ", "0");
  return pad(pos.cue, 3, 16) + zero(pos.row, 2) + zero(pos.speed, 2) + pad(pos.bpm, 3);
}

/** The panels Replace walks: neither → instruments → both → master. */
export function nextPanels({ inst, master }) {
  if (!inst && !master) return { inst: true, master: false };
  if (inst && !master) return { inst: true, master: true };
  if (inst && master) return { inst: false, master: true };
  return { inst: false, master: false };
}

let gestureSerial = 0;
const newGesture = () => `surface:${++gestureSerial}`;

export class ControlSurface {
  /** `host`: see app.js `surfaceHost`. `now` is injectable for the tests. */
  constructor(host, now = () => performance.now()) {
    this.host = host;
    this.now = now;
    this.send = null;
    /** The timecode display: false cue/row/speed/BPM, true bars/beats. */
    this.beats = false;
    /** The knob's axis in a spatial song. */
    this.axis = "azimuth";
    // Per fader, 0 the strip's and 1 the master's.
    this.touched = [false, false];
    this.gesture = [null, null];
    this.written = [null, null];
    this.movedAt = [-Infinity, -Infinity];
    this.faderSentAt = -Infinity;
    this.lastVpotAt = -Infinity;
    this.knobGesture = null;
    /** Stop pressed while stopped: 0 = playback just stopped (or never
     *  cleared), 1 = the playback position was cleared (see stop()). */
    this.stopStage = 0;
    this.jogAt = -Infinity;  // the jog wheel's speed and its fraction of a unit
    this.jogGap = JOG_SLOW_MS;
    this.jogDir = 0;
    this.jogAcc = 0;
    this.held = null;     // a held arrow: {code, next}
    this.meterDb = -Infinity; // the meter's level, eased (see METER_*)
    this.meterAt = 0;
    this.clipUntil = -Infinity;
    this.meterSeg = -1;       // the segment last sent, and when
    this.meterSentAt = -Infinity;
    this.status = "";     // what the scribble strip's second line says
    this.statusUntil = 0;
    this.sent = new Map(); // feedback key → what was last sent
    this.prevCells = null;
  }

  /** Connected (`send(bytes)`) or disconnected (null). Everything the surface
   *  shows is sent afresh on the next frame. */
  attach(send) {
    this.send = send;
    // The engine measures the lanes' peaks only while a surface listens.
    this.host.setLanePeak?.(send !== null);
    this.meterSeg = -1;
    this.meterDb = -Infinity;
    this.sent.clear();
    this.prevCells = null;
    this.touched = [false, false];
    this.gesture = [null, null];
    this.held = null;
  }

  /** One message from the surface. */
  receive(bytes) {
    const ev = decode(bytes);
    if (!ev) return;
    switch (ev.type) {
      case "button": ev.down ? this.press(ev) : this.release(ev); break;
      case "touch": this.touch(ev); break;
      case "fader": this.fader(ev); break;
      case "vpot": this.vpot(ev.delta); break;
      case "jog": this.jog(ev.delta); break;
    }
  }

  say(text) {
    this.status = text;
    this.statusUntil = this.now() + STATUS_MS;
  }

  // ── buttons ──

  press(ev) {
    const h = this.host;
    const ch = h.lane();
    if (ev.name === "select" && ev.strip !== HOME_STRIP) {
      const d = ev.strip - HOME_STRIP;
      this.goHome();
      const code = d > 0 ? "ArrowRight" : "ArrowLeft";
      for (let i = 0; i < Math.abs(d); i++) {
        if (h.dialogOpen()) h.dialogKey(code);
        else h.key(code, { shift: true, ctrl: true });
      }
      return;
    }
    // An open dialog or menu has the keyboard, and so has the surface: the
    // arrows walk it, the knob's push (Enter, Zoom) takes what is highlighted,
    // Select (or Cancel) closes it. The transport carries on.
    if (h.dialogOpen()) {
      switch (ev.name) {
        case "up": case "down": case "left": case "right": h.dialogKey(ARROW_CODE[ev.name]); return;
        // Zoom is the Enter: it takes what is highlighted
        case "enter": case "zoom": h.dialogTake(); return;
        case "select": case "cancel": h.dialogCancel(); return;
        case "stop": case "play": case "record": case "userA": case "userB": case "timecodeBeats": break;
        default: return;
      }
    }
    switch (ev.name) {
      // a strip's buttons: the lane being edited, whichever strip
      case "mute": if (ch !== null) h.toggleMute(ch); return;
      case "solo": if (ch !== null) h.toggleSolo(ch); return;
      case "rec": if (ch !== null) h.toggleFx2(ch); return;
      case "select": h.laneMenu(); return;
      case "vpotPush":
        if (h.surroundModel() === SURROUND_SPATIAL) {
          this.axis = this.axis === "azimuth" ? "elevation" : "azimuth";
          this.knobGesture = null; // the other axis is another step
          this.say(this.axis === "azimuth" ? "Azimuth" : "Elevatn");
        }
        return;
      // display
      case "timecodeBeats": this.beats = !this.beats; return;
      // the Timeline's cells: Cycle walks the widths as the Cells button
      // does, Global View goes to mini and back, Drop is Raw
      case "cycle": h.stepCells(1); return;
      case "globalView": h.toggleMiniCells(); return;
      case "drop": h.toggleRaw(); return;
      // Replace walks the side panels (nextPanels)
      case "replace": h.cyclePanels(); return;
      // transport
      case "rewind": h.seekCue(-1); return;
      case "fastForward": h.seekCue(1); return;
      case "stop": this.stop(); return;
      case "play": if (!h.playing()) h.play(); return;
      case "record": h.setRecord(!h.record()); return;
      case "userA": case "userB": h.togglePlay(); return; // the foot pedal
      case "marker": {
        const row = h.cursorRow();
        if (row === null) return;
        h.setMarker(h.marker() === row ? null : row);
        return;
      }
      case "nudge": h.gotoMarker(); return;
      // Click walks the panes, one way round.
      case "click": h.paneStep(1); return;
      case "transportSolo": h.splitToggle(); return;
      // navigation: the keyboard's own chords (app.js arrowChord)
      case "channelLeft": case "channelRight":
        h.key(ev.name === "channelLeft" ? "ArrowLeft" : "ArrowRight", { shift: true, ctrl: true });
        return;
      case "bankLeft": case "bankRight": {
        const back = ev.name === "bankLeft";
        // the Patterns view steps through patterns; elsewhere four lanes
        if (h.view() === "pattern") h.key(back ? "ArrowUp" : "ArrowDown", { shift: true, ctrl: true, alt: true });
        else h.key(back ? "ArrowLeft" : "ArrowRight", { shift: true, ctrl: true, alt: true });
        return;
      }
      case "up": case "down": case "left": case "right": {
        const code = ARROW_CODE[ev.name];
        h.key(code, {});
        this.held = { code, next: this.now() + REPEAT_DELAY_MS };
        return;
      }
      case "zoom": h.setSelMode(!h.selMode()); return;
      case "scrub": h.undo(); return;
      case "f8": h.splitToggle(); return;
    }
    const f = F_KEYS.indexOf(ev.name);
    if (f >= 0) h.showView(f);
  }

  /** Stop, three ways: playing, it stops; stopped, it clears the playback
   *  position (onto the editor cursor) and brings the view to the cursor;
   *  pressed again, the cursor goes to cue 0, row 0. */
  stop() {
    const h = this.host;
    if (h.playing()) { h.stop(); this.stopStage = 0; return; }
    if (this.stopStage === 0) { h.clearPlayhead(); this.stopStage = 1; return; }
    h.returnToZero();
  }

  release(ev) {
    if (this.held && ARROW_CODE[ev.name] === this.held.code) this.held = null;
  }

  // ── the jog wheel: rows, further the faster it turns (JOG_ROWS) ──

  jog(delta) {
    const h = this.host;
    if (h.dialogOpen()) {
      // in a menu, a row a step
      for (let i = 0; i < Math.abs(delta); i++) h.dialogKey(delta > 0 ? "ArrowDown" : "ArrowUp");
      return;
    }
    const now = this.now();
    const dir = Math.sign(delta);
    const gap = now - this.jogAt;
    this.jogAt = now;
    if (dir !== this.jogDir || gap > JOG_RESET_MS) {
      this.jogAcc = 0;
      this.jogGap = JOG_SLOW_MS;
    } else {
      // smoothed: the device sometimes sends two messages a millisecond apart
      this.jogGap = (this.jogGap + Math.max(gap, JOG_TICK_MS)) / 2;
    }
    this.jogDir = dir;
    this.jogAcc += delta * jogGain(this.jogGap);
    const units = Math.trunc(this.jogAcc);
    if (units === 0) return;
    this.jogAcc -= units;
    // Plain arrows, so selection mode extends the block as it does from the
    // keyboard.
    const rows = jogRows(h.gridRow(), units);
    for (let i = 0; i < Math.abs(rows); i++) h.key(rows > 0 ? "ArrowDown" : "ArrowUp", {});
  }

  // ── the knob: the lane's position ──

  vpot(delta) {
    const h = this.host;
    const now = this.now();
    // A quick turn goes further: detents closer than 25 ms count four times,
    // closer than 50 ms twice.
    const gap = now - this.lastVpotAt;
    this.lastVpotAt = now;
    const accel = gap < 25 ? 4 : gap < 50 ? 2 : 1;
    if (this.knobGesture === null || gap > KNOB_GESTURE_MS) this.knobGesture = newGesture();
    if (h.dialogOpen()) {
      // in a menu, an item a detent
      for (let i = 0; i < Math.abs(delta); i++) h.dialogKey(delta > 0 ? "ArrowRight" : "ArrowLeft");
      return;
    }
    const ch = h.lane();
    if (ch === null) return;
    const target = h.editTarget();
    if (!target) { this.say("Rec off"); return; }
    const model = h.surroundModel();
    const start = panStart(model, target.cell, h.engineLane(ch));
    const p = panTurn(model, start, delta * accel, this.axis);
    const match = model === SURROUND_STEREO ? isS8 : (op, arg) => isS8(op, arg) || isX(op);
    target.apply(effectFields(target.cell, match, p.effect, p.arg, target.fx2), this.knobGesture);
    this.say(panLabel(model, p, this.axis));
  }

  // ── the faders: the lane's volume (M), the master's the song's (V) ──

  touch(ev) {
    const i = ev.master ? 1 : 0;
    const now = this.now();
    if (ev.down) {
      // A touch sensor bounces (on, off, on within a few milliseconds — the
      // X-Touch One does), and a fader may report a move just before its
      // touch: a touch that follows the last movement this closely carries
      // on the same undo step.
      if (!this.gesture[i] || now - this.movedAt[i] > TOUCH_GRACE_MS) {
        this.gesture[i] = newGesture();
        this.written[i] = null;
      }
    }
    this.touched[i] = ev.down;
    this.movedAt[i] = now;
    this.forgetFader(i);
  }

  fader(ev) {
    const i = ev.master ? 1 : 0;
    const now = this.now();
    if (!this.gesture[i] || (!this.touched[i] && now - this.movedAt[i] > UNTOUCHED_GESTURE_MS)) {
      this.gesture[i] = newGesture();
      this.written[i] = null;
    }
    this.movedAt[i] = now;
    this.forgetFader(i);
    const level = faderLevel(ev.value);
    // Out of record mode the master fader is the project's own global volume,
    // as the master strip's fader is (one undo step a touch).
    if (i === 1 && !this.host.record()) {
      if (level === this.written[i]) return;
      this.written[i] = level;
      this.host.setGlobalVolume(level, this.gesture[i]);
      this.say(`GV $${level.toString(16).toUpperCase().padStart(2, "0")}`);
      return;
    }
    const target = this.host.editTarget();
    if (!target) { this.say("Rec off"); return; }
    if (level === this.written[i]) return;
    this.written[i] = level;
    const op = i ? EffectOp.OP_V : EffectOp.OP_M;
    target.apply(effectFields(target.cell, i ? isV : isM, op, level << 8, target.fx2),
      this.gesture[i]);
    this.say(`${i ? "V" : "M"} $${level.toString(16).toUpperCase().padStart(2, "0")}`);
  }

  // ── what the surface shows ──

  frame() {
    if (!this.send) return;
    const h = this.host;
    const now = this.now();
    if (this.held && now >= this.held.next) {
      h.key(this.held.code, {});
      this.held.next = now + REPEAT_EVERY_MS;
    }
    const ready = h.ready();
    const ch = ready ? h.lane() : null;
    const on = (b) => (b ? "on" : "off");

    // the strips' lamps: all eight show the lane being edited
    const muted = ch !== null && h.muted(ch), soloed = ch !== null && h.soloed(ch);
    const fx2 = ch !== null && h.fx2(ch);
    for (let s = 0; s < 8; s++) {
      this.led(STRIP_BUTTON.mute + s, on(muted));
      this.led(STRIP_BUTTON.solo + s, on(soloed));
      this.led(STRIP_BUTTON.rec + s, on(fx2));
      this.led(STRIP_BUTTON.select + s, on(s === HOME_STRIP));
      this.out(`meterOn${s}`, true, () => meterEnableMessage(s, true));
    }
    const playing = ready && h.playing();
    if (playing) this.stopStage = 0; // a new play: the next Stop stops it
    this.led(BUTTON.play, on(playing));
    this.led(BUTTON.stop, on(ready && !playing));
    this.led(BUTTON.record, on(h.record()));
    this.led(BUTTON.zoom, on(h.selMode()));
    this.led(BUTTON.marker, on(ready && h.marker() !== null));
    this.led(BUTTON.transportSolo, on(h.isSplit()));
    this.led(LED.smpte, on(!this.beats));
    this.led(LED.beats, on(this.beats));
    const viewIndex = h.viewIndex();
    F_KEYS.forEach((k, i) => this.led(BUTTON[k], on(i === viewIndex)));

    // the motor faders: where the lane and the song stand, unless a hand is
    // on them or just was
    if (now - this.faderSentAt >= FADER_REFRESH_MS) {
      this.faderSentAt = now;
      this.forgetFader(0);
      this.forgetFader(1);
    }
    // Stopped, the motor and the ring show the cursor's row: its cell's own
    // command if it has one, else the lane as the song arrives there
    // (engineLane, a chase). Playing, the lane as the engine has it — a cell
    // under a cursor that stays put would hold them there for the whole song
    // (a song that sets every lane's volume on row 0, the cursor on row 0).
    const target = ready && !playing ? { cell: h.cursorCell() } : null;
    if (ch !== null && !this.touched[0] && now - this.movedAt[0] > MOTOR_HOLD_MS) {
      const own = cellArg(target?.cell, isM);
      const level = own ? own.arg >> 8 : h.engineLane(ch).vol;
      const v = levelFader(level);
      for (let s = 0; s < 8; s++) this.out(`fader${s}`, v, () => faderMessage(s, v));
    }
    if (ready && !this.touched[1] && now - this.movedAt[1] > MOTOR_HOLD_MS) {
      const own = cellArg(target?.cell, isV);
      const v = levelFader(own ? own.arg >> 8 : h.globalVolume());
      this.out("faderM", v, () => faderMessage(null, v));
    }

    this.meter(ready ? ch : null, now);

    // the knob's ring
    const model = ready ? h.surroundModel() : SURROUND_STEREO;
    if (model !== SURROUND_SPATIAL) this.axis = "azimuth";
    let ring = { mode: RING.dot, pos: 0, centre: false };
    let p = null;
    if (ch !== null) {
      p = panStart(model, target?.cell ?? null, h.engineLane(ch));
      ring = panRing(model, p, this.axis);
    }
    for (let s = 0; s < 8; s++) {
      const key = `${ring.mode},${ring.pos},${ring.centre}`;
      this.out(`ring${s}`, key, () => ringMessage(s, ring.mode, ring.pos, ring.centre));
    }

    // the displays
    let text = " ".repeat(TIMECODE_DIGITS);
    if (ready) {
      const pos = h.position();
      if (pos) text = positionText(pos, this.beats);
    }
    const cells = segmentCells(text, TIMECODE_DIGITS);
    const msgs = timecodeMessages(cells, this.prevCells);
    if (msgs.length) { for (const m of msgs) this.send(m); this.prevCells = cells; }
    const lane = ch === null ? "  " : String(ch + 1).padStart(2, "0").slice(-2);
    this.out("assign", lane, () => assignmentMessages(segmentCells(lane, 2)));
    const line1 = ch === null ? "" : `Lane ${String(ch + 1).padStart(2, "0")}`;
    let line2 = "";
    if (now < this.statusUntil) line2 = this.status;
    else if (ch !== null && !h.record()) line2 = "Rec off";
    else if (p) line2 = panLabel(model, p, this.axis);
    for (let s = 0; s < 8; s++) {
      this.out(`lcd${s}a`, line1, () => lcdMessage(s, 0, line1));
      this.out(`lcd${s}b`, line2, () => lcdMessage(s, 1, line2));
    }
  }

  /** The level meter (see METER_*): the lane's peak since the last frame. */
  meter(ch, now) {
    const peak = ch === null ? null : this.host.lanePeak(ch);
    const dt = Math.max(0, (now - this.meterAt) / 1000);
    this.meterAt = now;
    const dB = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    const fallen = this.meterDb - METER_FALL_DB_S * dt;
    this.meterDb = dB > fallen ? dB : fallen;
    if (dB >= 0) this.clipUntil = now + CLIP_HOLD_MS;
    const seg = now < this.clipUntil ? METER_CLIP : meterSegment(this.meterDb);
    if (seg === this.meterSeg && (seg === 0 || now - this.meterSentAt < METER_REFRESH_MS)) return;
    this.meterSeg = seg;
    this.meterSentAt = now;
    for (let s = 0; s < 8; s++) this.send(meterMessage(s, seg));
  }

  /** Put out every lamp this lit and blank the displays: the surface is
   *  being let go of. */
  goodbye() {
    if (!this.send) return;
    for (let s = 0; s < 8; s++) this.send(meterMessage(s, 0));
    for (const [key, value] of this.sent) {
      if (key.startsWith("led") && value !== "off") this.send(ledMessage(Number(key.slice(3)), "off"));
      if (key.startsWith("ring")) this.send(ringMessage(Number(key.slice(4)), RING.dot, 0));
      if (key.startsWith("lcd")) this.send(lcdMessage(Number(key[3]), key[4] === "a" ? 0 : 1, ""));
    }
    for (const m of timecodeMessages(segmentCells("", TIMECODE_DIGITS), this.prevCells)) this.send(m);
    for (const m of assignmentMessages(segmentCells("", 2))) this.send(m);
    this.attach(null);
  }

  /** Light the home strip's Select again on the next frame, which brings a
   *  one-fader surface back to it. */
  goHome() {
    for (let s = 0; s < 8; s++) this.sent.delete(`led${STRIP_BUTTON.select + s}`);
    this.forgetFader(0);
  }

  /** Send fader `i`'s motor position (0 the strips', 1 the master's) on the
   *  next frame that may move it, changed or not. What `sent` remembers is
   *  what the HOST sent, not where the fader stands: a hand moves it (out of
   *  record mode the strip's writes nothing, and the fader stayed where it was
   *  let go, since the lane's volume had not changed), and a one-fader surface
   *  switches what its fader is without a word to the host (the X-Touch One's
   *  Master button, its walk through the strips). A motor already in place
   *  does not move. */
  forgetFader(i) {
    if (i === 1) { this.sent.delete("faderM"); return; }
    for (let s = 0; s < 8; s++) this.sent.delete(`fader${s}`);
  }

  led(note, state) { this.out(`led${note}`, state, () => ledMessage(note, state)); }

  /** Send what `make()` gives (one message or a list) when `key`'s value
   *  differs from the last one sent. */
  out(key, value, make) {
    if (this.sent.get(key) === value) return;
    this.sent.set(key, value);
    const m = make();
    if (Array.isArray(m[0])) for (const one of m) this.send(one);
    else this.send(m);
  }
}

/** The knob's value as the scribble strip shows it (seven characters). */
function panLabel(model, p, axis) {
  const hex = (v, n) => v.toString(16).toUpperCase().padStart(n, "0");
  if (model === SURROUND_STEREO) return `Pan $${hex(p.az, 2)}`;
  if (model !== SURROUND_SPATIAL) return `Az $${hex(p.az, 3)}`;
  if (axis === "elevation") return `El ${p.el >= 0 ? "+" : "-"}${hex(Math.abs(p.el), 2)}`;
  return `Az $${hex(p.az, 2)}`;
}
