// Motif's music model: the song a TML program declares and the events it
// places, plus the builtins that place them. Everything here is pure data and
// computation; turning it into patterns is compile.js, into a project build.js.
//
// A lane holds its events as a map from absolute row to a cell of fields
// (note, inst, vol, fx, arg…). Two writes to one row MERGE; two different
// values for one field on one row are a composing mistake and stop the build —
// except that a note replaces a key-off, cut or fade written there earlier,
// and a key-off never replaces a note. (The rules the Huygens' Clock generator
// composed by, before Motif existed.)

import { MotifError } from "./lexer.js";
import {
  Builtin, Handle, Rec, Range, asNumber, asInt, asString, asList, asRecord, asFunction, fail, typeName,
} from "./values.js";
import { tuningFrom } from "./tuning.js";
import { mulberry32 } from "./stdlib.js";

export const KEY_OFF = 0x0001;
export const NOTE_CUT = 0x0002;
export const NOTE_FADE = 0x0003;
const isSentinel = (w) => w === KEY_OFF || w === NOTE_CUT || w === NOTE_FADE;

const B36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** An effect letter → its opcode byte: a base-36 digit (0–9, A–Z) or a symbol
 *  (":" is $BA — the byte minus $80 is the character). */
export function opByte(op) {
  const s = asString(op, "an effect");
  if (s.length !== 1) throw fail(`"${s}" is not an effect: an effect is one character, like "S" or "G"`);
  const i = B36.indexOf(s.toUpperCase());
  if (i >= 0) return i;
  const c = s.charCodeAt(0);
  if (c >= 0x20 && c < 0x7f && 0x80 + c >= 0xa0) return 0x80 + c;
  throw fail(`"${s}" is not an effect`);
}
export function opName(b) {
  return b < 36 ? B36[b] : String.fromCharCode(b - 0x80);
}

// ── option schemas ──

const str = (v, what) => asString(v, what);
const bool = (v, what) => { if (typeof v !== "boolean") throw fail(`${what} must be true or false, not ${typeName(v)}`); return v; };
const int = (lo, hi) => (v, what) => {
  asInt(v, what);
  if (v < lo || v > hi) throw fail(`${what} must be ${lo}…${hi}, not ${v}`);
  return v;
};
const num = (lo, hi) => (v, what) => {
  asNumber(v, what);
  if (v < lo || v > hi) throw fail(`${what} must be ${lo}…${hi}, not ${v}`);
  return v;
};
const oneOf = (map) => (v, what) => {
  if (typeof v === "string" && Object.prototype.hasOwnProperty.call(map, v)) return map[v];
  throw fail(`${what} must be one of ${Object.keys(map).map((k) => `"${k}"`).join(", ")}`);
};
const any = (v) => v;

/** "did you mean …?" for a misspelt option. */
function suggest(word, options) {
  const dist = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return d[a.length][b.length];
  };
  let best = null, bd = 3;
  for (const o of options) { const x = dist(word, o); if (x < bd) { bd = x; best = o; } }
  return best ? ` (did you mean "${best}"?)` : "";
}

function readOptions(value, schema, what) {
  const r = asRecord(value, what);
  const out = {};
  for (const [k, v] of r.m) {
    const check = schema[k];
    if (!check) throw fail(`${what} has no option "${k}"${suggest(k, Object.keys(schema))}`);
    out[k] = check(v, `${what}'s ${k}`);
  }
  return out;
}

const SONG = {
  title: str, composer: str, copyright: str, message: str, signature: str,
  tuning: any, a4: num(1, 100000), tempo: int(25, 1048), speed: int(1, 127),
  bars: int(1, 100000), bar_rows: int(1, 64), beat_rows: int(1, 255), cue_bars: int(1, 64),
  format: int(2, 3), surround: oneOf({ stereo: 0, planar: 1, spatial: 2 }),
  global_volume: int(0, 255), mixing_volume: int(0, 255), seed: int(-2147483648, 4294967295),
  soundfont: str, retune: bool,
};
const INSTRUMENT = {
  bank: int(0, 128), program: int(0, 127), name: str, retune: bool,
  layer_gain: num(-86, 24), min_fadeout: int(0, 4095), fadeout: int(0, 4095),
  nna: oneOf({ off: 0, cut: 1, continue: 2, fade: 3 }), layers: any,
};
const LANE = { inst: any, pan: int(0, 511), label: str, trim: num(0, 1000), jitter: int(0, 255) };

// The master block: snake_case spellings of the engine's mastering record.
const MASTER = {
  on: bool, trim_db: num(-48, 48), hp_on: bool, hp_freq: num(5, 1000),
  hp_slope: (v, what) => { if (v === 12) return 0; if (v === 24) return 1; throw fail(`${what} is 12 or 24 (dB per octave)`); },
  eq_on: bool, eq: any, comp_on: bool,
  comp_detector: oneOf({ peak: 0, rms: 1 }), comp_thresh_db: num(-80, 0), comp_ratio: num(1, 100),
  comp_attack_ms: num(0, 1000), comp_release_ms: num(1, 5000), comp_knee_db: num(0, 48), comp_makeup_db: num(-48, 48),
  width_on: bool, width: num(0, 4), lim_on: bool, lim_true_peak: bool, lim_ceiling_db: num(-48, 0),
  lim_release_ms: num(1, 5000), out_gain_db: num(-48, 48),
};
const EQ_BAND = {
  on: bool, type: oneOf({ low_shelf: 0, peak: 1, high_shelf: 2 }), freq: num(10, 24000),
  gain_db: num(-48, 48), q: num(0.05, 30),
};
const camel = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

/** dB → the decibel octet (TAUD_FILE_FORMAT.md §7.5): $9F is unity. */
export function dbOctet(db) {
  let best = 0, bd = Infinity;
  for (let o = 1; o < 256; o++) {
    const d = Math.abs(octetDb(o) - db);
    if (d < bd - 1e-9) { bd = d; best = o; }
  }
  return best;
}
function octetDb(o) {
  if (o >= 232) return 12.5 + (o - 232) * 0.5;
  if (o >= 208) return 6.25 + (o - 208) * 0.25;
  if (o >= 112) return -5.875 + (o - 112) * 0.125;
  if (o >= 88) return -11.75 + (o - 88) * 0.25;
  if (o >= 64) return -23.5 + (o - 64) * 0.5;
  if (o >= 2) return -85 + (o - 2);
  return -86;
}

// ── the score ──

export class Score {
  constructor({ log = () => {} } = {}) {
    this.song = null;
    this.tuning = null;
    this.instruments = [];
    this.lanes = [];
    this.sections = [];
    this.master = null;
    this.seed = 1;
    this.random = mulberry32(1);
    this.log = log;
  }

  get rows() { return this.song.bars * this.song.barRows; }
  get wide() { return this.song.format === 3; }
  get volMax() { return this.wide ? 255 : 63; }

  reseed(n) { this.seed = n; this.random = mulberry32(n); }

  needSong(what) {
    if (!this.song) throw fail(`${what} needs the song first: start the file with song { … }`);
  }

  // ── declarations ──

  declareSong(value) {
    if (this.song) throw fail("the song is declared once");
    const o = readOptions(value, SONG, "song");
    if (o.bars === undefined) throw fail("song needs bars: how many bars long it is");
    const barRows = o.bar_rows ?? 16;
    const cueBars = o.cue_bars ?? Math.max(1, Math.floor(64 / barRows));
    if (barRows * cueBars > 64) {
      throw fail(`a cue holds at most 64 rows: ${cueBars} bars of ${barRows} rows is ${barRows * cueBars} (lower cue_bars)`);
    }
    const surround = o.surround ?? 0;
    const format = o.format ?? (surround ? 3 : 2);
    if (format === 3 && surround === 0) throw fail("format 3 (the wide cell) is for surround songs: set surround to \"planar\" or \"spatial\"");
    const sig = o.signature ?? "Microtone.js";
    if (sig.length > 14 || /[^\x20-\x7e]/.test(sig)) throw fail("song's signature is up to 14 plain ASCII characters");
    const rec = value.m.get("tuning");
    this.tuning = tuningFrom(rec instanceof Rec ? null : (o.tuning ?? "12-TET"), rec instanceof Rec ? rec.m : null);
    this.song = {
      title: o.title ?? "", composer: o.composer ?? "", copyright: o.copyright ?? "", message: o.message ?? "",
      signature: sig.padEnd(14, " "),
      a4: o.a4 ?? 440, tempo: o.tempo ?? 125, speed: o.speed ?? 6,
      bars: o.bars, barRows, beatRows: o.beat_rows ?? 4, cueBars,
      format, surround,
      globalVolume: o.global_volume ?? 128, mixingVolume: o.mixing_volume ?? 128,
      soundfont: o.soundfont ?? null, retune: o.retune ?? false,
    };
    this.reseed(o.seed ?? 1);
  }

  declareInstrument(name, value) {
    this.needSong("an instrument");
    if (this.lanes.length) throw fail("declare every instrument before the first lane");
    if (this.instruments.length >= 255) throw fail("a song has at most 255 instruments");
    const o = readOptions(value, INSTRUMENT, `instrument ${name}`);
    if (o.bank === undefined || o.program === undefined) {
      throw fail(`instrument ${name} needs bank and program: the soundfont preset it plays`);
    }
    let layers = null;
    if (o.layers !== undefined) {
      layers = asList(o.layers, `instrument ${name}'s layers`).map((x) => asInt(x, "a layer number"));
      if (!layers.length) throw fail(`instrument ${name} keeps no layers`);
    }
    const slot = this.instruments.length + 1;
    const inst = {
      id: name, slot, bank: o.bank, program: o.program, name: o.name ?? null,
      retune: o.retune ?? true, layerGain: o.layer_gain ?? null, minFadeout: o.min_fadeout ?? null,
      fadeout: o.fadeout ?? null, nna: o.nna ?? null, layers,
    };
    inst.handle = new Handle("instrument", { name, slot });
    inst.handle.instrument = inst;
    this.instruments.push(inst);
    return inst.handle;
  }

  declareLane(name, value) {
    this.needSong("a lane");
    if (this.lanes.length >= 64) throw fail("a song has at most 64 lanes");
    const o = readOptions(value, LANE, `lane ${name}`);
    const inst = instrumentOf(o.inst, `lane ${name}'s inst`);
    const lane = {
      id: name, index: this.lanes.length, inst: inst.slot, instrument: inst,
      pan: o.pan ?? null, label: o.label ?? name, trim: o.trim ?? 1, jitter: o.jitter ?? 0,
      ev: new Map(),
    };
    lane.handle = new Handle("lane", { name, label: lane.label, index: lane.index, inst: inst.handle });
    lane.handle.lane = lane;
    this.lanes.push(lane);
    return lane.handle;
  }

  declareMaster(value) {
    if (this.master) throw fail("the master is declared once");
    const o = readOptions(value, MASTER, "master");
    const m = { on: true };
    for (const [k, v] of Object.entries(o)) {
      if (k === "eq") continue;
      m[camel(k)] = v;
    }
    if (o.eq !== undefined) {
      const bands = asList(o.eq, "master's eq");
      if (bands.length > 4) throw fail("the master's eq has four bands");
      m.eq = bands.map((b, i) => {
        const bo = readOptions(b, EQ_BAND, `eq band ${i + 1}`);
        const out = {};
        for (const [k, v] of Object.entries(bo)) out[camel(k)] = v;
        return out;
      });
    }
    this.master = m;
  }

  declareSection(name, range) {
    this.needSong("a section");
    const label = asString(name, "a section's name");
    if (!(range instanceof Range) || range.step !== 1) throw fail(`section "${label}" spans a range of bars, like 9..16`);
    const from = range.from, to = range.inclusive ? range.to : range.to - 1;
    if (from < 1 || to > this.song.bars || to < from) {
      throw fail(`section "${label}" covers bars ${from}–${to}; the song has bars 1–${this.song.bars}`);
    }
    this.sections.push({ name: label, from, to });
  }

  sectionOfCue(c) {
    const bar = c * this.song.cueBars + 1;
    return this.sections.find((s) => bar >= s.from && bar <= s.to)?.name ?? null;
  }

  // ── cells ──

  put(lane, row, f) {
    if (row < 0 || row >= this.rows || !Number.isInteger(row)) {
      throw fail(`row ${row} is outside the song (rows 0–${this.rows - 1}: ${this.song.bars} bars of ${this.song.barRows})`);
    }
    const c = lane.ev.get(row) ?? {};
    for (const [k, v] of Object.entries(f)) {
      if (v === undefined || v === null) continue;
      if (k === "note" && isSentinel(c.note) && v >= 0x20) continue;
      if (c[k] !== undefined && c[k] !== v) throw this.clash(lane, row, k, c[k], v);
    }
    for (const [k, v] of Object.entries(f)) {
      if (v === undefined || v === null) continue;
      if (k === "note" && isSentinel(c.note) && v >= 0x20) { c.note = v; continue; }
      c[k] = v;
    }
    lane.ev.set(row, c);
  }

  clash(lane, row, k, a, b) {
    const where = `lane ${lane.id}, bar ${Math.floor(row / this.song.barRows) + 1} row ${row % this.song.barRows}`;
    const word = {
      note: "notes", inst: "instruments", vol: "volumes", volRaw: "volume-column commands", volSel: "volume-column commands",
      fx: "effects", arg: "effect arguments", fx2: "second effects", arg2: "second-effect arguments",
      panRaw: "panning-column commands", az: "positions", el: "positions",
    }[k] ?? k;
    const fmt = (x) => {
      if (k === "note") {
        if (x === KEY_OFF) return "key-off";
        if (x === NOTE_CUT) return "note cut";
        if (x === NOTE_FADE) return "note fade";
        return this.tuning.nameOfWord(x) ?? `$${x.toString(16).toUpperCase()}`;
      }
      if (k === "fx" || k === "fx2") return opName(x);
      if (k === "arg" || k === "arg2") return `$${x.toString(16).toUpperCase().padStart(4, "0")}`;
      return String(x);
    };
    return fail(`${where}: two different ${word} on one row (${fmt(a)} and ${fmt(b)})`);
  }

  has(lane, row) { return lane.ev.has(row); }
  cellAt(lane, row) { return lane.ev.get(row); }

  word(step) { return this.tuning.word(step); }

  hit(lane, row, step, vol, fx = null, arg = 0, inst = null, pos = null) {
    this.put(lane, row, {
      note: this.word(step), inst: inst ?? lane.inst, vol: vol ?? undefined,
      fx: fx === null ? undefined : fx, arg: fx === null ? undefined : arg,
    });
    if (pos) this.put(lane, row, { az: pos.az, el: pos.el });
  }

  keyOff(lane, row, word = KEY_OFF) {
    const c = this.cellAt(lane, row);
    if (c?.note !== undefined) return; // never over a note something else put there
    this.put(lane, row, { note: word });
  }

  glide(lane, row, step, speed) {
    this.put(lane, row, { note: this.word(step), fx: opByte("G"), arg: speed });
  }

  glideSpeed(from, to, rows) {
    const units = Math.abs(this.word(to) - this.word(from));
    return Math.max(1, Math.ceil(units / (rows * (this.song.speed - 1))));
  }

  /** Vibrato on rows [from, to): the first row states speed and depth, the rest
   *  recall it; rows that already carry an effect are stepped round (and the
   *  next free one restates), and a key-off ends it. */
  vibrato(lane, from, to, speed, depth) {
    let first = true;
    for (let r = from; r < to; r++) {
      const c = this.cellAt(lane, r);
      if (c?.fx !== undefined) { first = true; continue; }
      if (c?.note === KEY_OFF) break;
      this.put(lane, r, { fx: opByte("H"), arg: first ? ((speed << 8) | depth) : 0 });
      first = false;
    }
  }
}

function instrumentOf(v, what) {
  if (v instanceof Handle && v.kind === "instrument") return v.instrument;
  throw fail(`${what} must be an instrument, not ${typeName(v)}`);
}
function laneOf(v, what = "the lane") {
  if (v instanceof Handle && v.kind === "lane") return v.lane;
  throw fail(`${what} must be a lane, not ${typeName(v)}`);
}
const MELODY_TOKEN = /^(~?)([^:@~]+):(\d+)(?:@(\d+))?([v>]*)$/;

// ── the music builtins ──

export function musicBuiltins(score) {
  const T = () => { score.needSong("a pitch"); return score.tuning; };
  const S = () => { score.needSong("this"); return score.song; };
  const row = (v, what = "the row") => {
    asInt(v, what);
    if (v < 0 || v >= score.rows) throw fail(`${what} ${v} is outside the song (rows 0–${score.rows - 1})`);
    return v;
  };
  const pitch = (v, what = "the pitch") => asInt(v, what);
  const vol = (v, what = "the volume") => {
    if (v === null) return null;
    asNumber(v, what);
    if (v < 0 || v > score.volMax) throw fail(`${what} is 0…${score.volMax} in a format-${S().format} song, not ${v}`);
    return v;
  };
  const arg16 = (v, what = "the effect argument") => {
    asInt(v, what);
    if (v < 0 || v > 0xffff) throw fail(`${what} is $0000…$FFFF, not ${v}`);
    return v;
  };
  const wideOnly = (what) => { if (!score.wide) throw fail(`${what} needs a format-3 song (surround: "planar" or "spatial")`); };
  const callTml = (interp, f, args) => interp.call(f, args, null, null);

  const melody = (interp, laneV, start, text, v, vib, glideRows, transpose, ring, map) => {
    const lane = laneOf(laneV);
    let r = row(start, "the melody's start");
    const src = asString(text, "the melody");
    const t = T();
    const vibs = vib === null ? [0x7d, 0x14] : asList(vib, "vib").map((x) => asInt(x, "a vibrato value"));
    if (vibs.length !== 2) throw fail("vib is [speed, depth]");
    const gRows = asInt(glideRows, "glide_rows");
    if (gRows < 1) throw fail("glide_rows is at least 1");
    asInt(transpose, "transpose");
    if (map !== null) asFunction(map, "map");
    vol(v, "the melody's volume");
    let prev = null;
    const ends = [];
    const startRow = r;
    for (const tok of src.trim().split(/\s+/)) {
      if (!tok) continue;
      if (tok === "|") {
        if ((r - startRow) % score.song.barRows !== 0) {
          throw fail(`the bar line "|" falls ${r - startRow} rows into a melody that started on bar ${Math.floor(startRow / score.song.barRows) + 1} row ${startRow % score.song.barRows}: the notes before it do not fill whole bars`);
        }
        continue;
      }
      const m = MELODY_TOKEN.exec(tok);
      if (!m) throw fail(`"${tok}" is not a melody token: write NAME:ROWS (D5:2), ~NAME:ROWS to glide, r:ROWS to rest, and @VOL, v (vibrato) or > (tie) after it`);
      const [, tilde, name, lenS, volS, flags] = m;
      const len = Number(lenS);
      if (len < 1) throw fail(`"${tok}" lasts no rows`);
      if (name === "r") {
        if (prev && !prev.tie && !ring) score.keyOff(lane, r);
        prev = null;
        r += len;
        continue;
      }
      let step = t.parse(name) + transpose;
      if (map !== null) step = asInt(callTml(interp, map, [step]), "what map returns");
      const nv = volS ? vol(Number(volS), `the volume in "${tok}"`) : v;
      if (tilde && prev) {
        score.glide(lane, r, step, score.glideSpeed(prev.step, step, gRows));
        if (volS) score.put(lane, r, { vol: nv });
      } else {
        score.hit(lane, r, step, nv);
      }
      if (flags.includes("v") && len >= 4) ends.push([r + 2, r + len]);
      prev = { step, tie: flags.includes(">") };
      r += len;
    }
    // the last note is let go where the line ends — unless the song does
    if (prev && !prev.tie && !ring && r < score.rows) score.keyOff(lane, r);
    for (const [a, b] of ends) score.vibrato(lane, a, Math.min(b, score.rows), vibs[0], vibs[1]);
    return r;
  };

  /**
   * The notes of `chord` that move least from `prev` (one pitch per lane):
   * every pitch inside lo…hi, ascending, covering as many of the chord's pitch
   * classes as there are notes, the root among them when need_root. Ties go to
   * the lower spelling. A brute-force search — the spaces are tiny.
   */
  const nearestChord = (interp, prevV, chordV, loV, hiV, nV, needRoot) => {
    const t = T();
    const prev = asList(prevV, "the chord to move from").map((x) => pitch(x, "a pitch of the chord to move from"));
    const chord = asRecord(chordV, "the chord");
    if (!chord.m.has("root") || !chord.m.has("ivs")) throw fail("a chord is a record with root (a degree) and ivs (its intervals in steps)");
    const root = asInt(chord.m.get("root"), "the chord's root");
    const ivs = asList(chord.m.get("ivs"), "the chord's ivs").map((x) => asInt(x, "an interval"));
    const label = chord.m.has("name") ? String(chord.m.get("name")) : "the chord";
    const lo = pitch(loV, "the lowest pitch"), hi = pitch(hiV, "the highest pitch");
    const n = nV === null ? prev.length : asInt(nV, "n");
    if (n < 1 || n > prev.length) throw fail(`n is 1…${prev.length} (how many notes the chord to move from has)`);
    const P = t.n;
    const pc = (s) => ((s % P) + P) % P;
    const classes = ivs.map((iv) => pc(root + iv));
    const cand = [];
    for (let s = lo; s <= hi; s++) if (classes.includes(pc(s))) cand.push(s);
    let best = null;
    const pick = [];
    const rec = (i, minS) => {
      if (--interp.steps < 0) interp.tick(null);
      if (i === n) {
        const got = new Set(pick.map(pc));
        if (got.size < Math.min(n, classes.length)) return;
        if (truthyFlag(needRoot) && !got.has(pc(root))) return;
        let cost = 0;
        for (let k = 0; k < n; k++) cost += Math.abs(pick[k] - prev[k]);
        if (best === null || cost < best.cost) best = { cost, v: pick.slice() };
        return;
      }
      for (const s of cand) {
        if (s <= minS) continue;
        pick.push(s); rec(i + 1, s); pick.pop();
      }
    };
    rec(0, -Infinity);
    if (!best) throw fail(`no spelling of ${label} with ${n} notes fits ${t.nameOf(lo)}…${t.nameOf(hi)}`);
    return best.v;
  };

  const fns = [
    // ── pitch ──
    new Builtin("note", "name", (_, nm) => T().parse(asString(nm, "the note name"))),
    new Builtin("notes", "names", (_, s) => {
      const t = T();
      return asString(s, "the note names").trim().split(/\s+/).filter(Boolean).map((x) => t.parse(x));
    }),
    new Builtin("note_name", "pitch", (_, p) => T().nameOf(pitch(p))),
    new Builtin("degree", "name", (_, nm) => T().degree(asString(nm, "the degree name"))),
    new Builtin("period", "", () => T().n),
    new Builtin("word", "pitch", (_, p) => T().word(pitch(p))),
    new Builtin("midi", "key", (_, k) => {
      asInt(k, "the MIDI key");
      if (k < 0 || k > 127) throw fail(`a MIDI key is 0…127, not ${k}`);
      return T().midi(k);
    }),
    new Builtin("mirror", "pitch, axis", (_, p, a) => 2 * pitch(a, "the axis") - pitch(p)),
    new Builtin("transpose", "pitches, steps", (_, ps, n) => {
      asInt(n, "the steps");
      return asList(ps, "the pitches").map((p) => pitch(p, "a pitch") + n);
    }),
    new Builtin("invert", "pitches, axis", (_, ps, a) => {
      const ax = pitch(a, "the axis");
      return asList(ps, "the pitches").map((p) => 2 * ax - pitch(p, "a pitch"));
    }),

    // ── time ──
    new Builtin("at", "bar, row=0", (_, b, r) => {
      S();
      return (asInt(b, "the bar") - 1) * score.song.barRows + asInt(r, "the row");
    }),
    new Builtin("bar_of", "row", (_, r) => Math.floor(asInt(r, "the row") / S().barRows) + 1),
    new Builtin("row_in_bar", "row", (_, r) => { const br = S().barRows; return ((asInt(r, "the row") % br) + br) % br; }),
    new Builtin("lanes", "", () => score.lanes.map((l) => l.handle)),

    // ── events ──
    new Builtin("hit", "lane, row, pitch, vol=none, fx=none, arg=0, inst=none, pos=none, delay=0",
      (_, l, r, p, v, fx, arg, inst, pos, delay) => {
        const lane = laneOf(l);
        const at = row(r);
        let slot = null;
        if (inst !== null) slot = instrumentOf(inst, "inst").slot;
        let where = null;
        if (pos !== null) {
          wideOnly("pos");
          const pr = asRecord(pos, "pos");
          where = { az: asInt(pr.m.get("az"), "pos.az"), el: asInt(pr.m.get("el"), "pos.el") };
        }
        score.hit(lane, at, pitch(p), vol(v), fx === null ? null : opByte(fx), fx === null ? 0 : arg16(arg), slot, where);
        const d = asInt(delay, "delay");
        if (d < 0 || d > 15) throw fail("delay is 0…15 ticks");
        if (d > 0) score.put(lane, at, { fx: opByte("S"), arg: 0xd000 | (d << 8) });
      }),
    new Builtin("keyoff", "lane, row", (_, l, r) => { score.keyOff(laneOf(l), row(r), KEY_OFF); }),
    new Builtin("cut", "lane, row", (_, l, r) => { score.keyOff(laneOf(l), row(r), NOTE_CUT); }),
    new Builtin("fade", "lane, row", (_, l, r) => { score.keyOff(laneOf(l), row(r), NOTE_FADE); }),
    new Builtin("fx", "lane, row, op, arg=0", (_, l, r, op, arg) => {
      score.put(laneOf(l), row(r), { fx: opByte(op), arg: arg16(arg) });
    }),
    new Builtin("fx2", "lane, row, op, arg=0", (_, l, r, op, arg) => {
      wideOnly("fx2");
      score.put(laneOf(l), row(r), { fx2: opByte(op), arg2: arg16(arg) });
    }),
    new Builtin("set_vol", "lane, row, vol", (_, l, r, v) => {
      if (v === null) throw fail("set_vol needs a volume");
      score.put(laneOf(l), row(r), { vol: vol(v) });
    }),
    new Builtin("set_pan", "lane, row, pan", (_, l, r, p) => {
      if (score.wide) {
        const pr = asRecord(p, "the position (a format-3 song places a note with dir(az, el))");
        score.put(laneOf(l), row(r), { az: asInt(pr.m.get("az"), "az"), el: asInt(pr.m.get("el"), "el") });
        return;
      }
      asInt(p, "the pan");
      if (p < 0 || p > 63) throw fail("the panning column's pan is 0…63 in a format-2 song");
      score.put(laneOf(l), row(r), { panRaw: p });
    }),
    new Builtin("vol_fine", "lane, row, delta", (_, l, r, d) => {
      asInt(d, "the delta");
      if (d === 0) return;
      const m = Math.abs(d);
      if (score.wide) {
        if (m > 127) throw fail("a fine volume slide moves at most 127 in a format-3 song");
        score.put(laneOf(l), row(r), { volSel: 3, volRaw: (d > 0 ? 0x80 : 0) | m });
      } else {
        if (m > 31) throw fail("a fine volume slide moves at most 31 in a format-2 song");
        score.put(laneOf(l), row(r), { volRaw: 0xc0 | (d > 0 ? 0x20 : 0) | m });
      }
    }),
    new Builtin("vol_slide", "lane, row, per_tick", (_, l, r, x) => {
      asInt(x, "the slide");
      if (x === 0) return;
      const m = Math.abs(x);
      if (score.wide) {
        if (m > 255) throw fail("a volume slide moves at most 255 a tick in a format-3 song");
        score.put(laneOf(l), row(r), { volSel: x > 0 ? 1 : 2, volRaw: m });
      } else {
        if (m > 63) throw fail("a volume slide moves at most 63 a tick in a format-2 song");
        score.put(laneOf(l), row(r), { volRaw: (x > 0 ? 0x40 : 0x80) | m });
      }
    }),
    new Builtin("glide", "lane, row, pitch, speed", (_, l, r, p, sp) => {
      const s = asInt(sp, "the glide speed");
      if (s < 1 || s > 0xffff) throw fail("a glide's speed is 1…$FFFF");
      score.glide(laneOf(l), row(r), pitch(p), s);
    }),
    new Builtin("glide_speed", "from, to, rows", (_, a, b, n) => {
      S();
      const rows = asInt(n, "the rows");
      if (rows < 1) throw fail("a glide takes at least one row");
      if (score.song.speed < 2) throw fail("a glide needs a speed of at least 2 ticks a row");
      return score.glideSpeed(pitch(a), pitch(b), rows);
    }),
    new Builtin("vibrato", "lane, from, to, speed, depth", (_, l, a, b, sp, dp) => {
      const speed = asInt(sp, "the vibrato speed"), depth = asInt(dp, "the vibrato depth");
      if (speed < 0 || speed > 255 || depth < 0 || depth > 255) throw fail("vibrato's speed and depth are 0…255");
      const lane = laneOf(l);
      const from = row(a, "the first row"), to = asInt(b, "the end row");
      score.vibrato(lane, from, Math.min(to, score.rows), speed, depth);
    }),
    new Builtin("melody", "lane, row, text, vol=none, vib=none, glide_rows=1, transpose=0, ring=false, map=none", melody),
    new Builtin("occupied", "lane, row", (_, l, r) => score.has(laneOf(l), row(r))),

    // ── harmony and space ──
    new Builtin("nearest_chord", "prev, chord, lo, hi, n=none, need_root=false", nearestChord),
    new Builtin("dir", "az, el=0", (_, a, e) => {
      // degrees as a listener names them (0 ahead, +90 right, 180 behind; +90
      // up) → the engine's 9-bit azimuth and signed elevation (128 = 90°)
      const az = ((Math.round(128 + (asNumber(a, "the azimuth") * 512) / 360) % 512) + 512) % 512;
      const el = Math.max(-128, Math.min(127, Math.round((asNumber(e, "the elevation") * 128) / 90)));
      return new Rec([["az", az], ["el", el]]);
    }),
  ];
  return new Map(fns.map((f) => [f.name, f]));
}

function truthyFlag(v) { return v === true; }

/** The interpreter hooks that route declarations and pitches to `score`. */
export function musicHooks(score) {
  return {
    declare(st, scope, interp) {
      if (st.k === "section") {
        score.declareSection(interp.eval(st.name, scope), interp.eval(st.range, scope));
        return;
      }
      const value = interp.eval(st.value, scope);
      switch (st.kind) {
        case "song": score.declareSong(value); return;
        case "master": score.declareMaster(value); return;
        case "instrument": interp.declare(scope, st.name, score.declareInstrument(st.name, value), st.namePos); return;
        case "lane": interp.declare(scope, st.name, score.declareLane(st.name, value), st.namePos); return;
        default: throw new MotifError(`internal error: declaration ${st.kind}`, st.pos);
      }
    },
    pitch(text) {
      if (!score.tuning) throw fail(`the pitch '${text}' needs the song's tuning: declare song { … } first`);
      return score.tuning.parse(text);
    },
  };
}
