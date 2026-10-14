// Motif's music values (TML 2). A phrase is music a program has made: the
// cells it writes, by lane and row, and its FITTED parts — the ones that can
// only be placed once the whole song is known, because they step round what
// the rest of the song writes (a vibrato round effects, a ramp round volumes,
// music under() the rest, music that follow()s a lane). A phrase never
// changes; every operation here makes a new one.
//
// Putting phrases together MERGES their cells by the rules of §8.2, which do
// not depend on order: two different values for one field of one row are a
// mistake in the program, except that a note wins over a key-off, cut or fade.
// So the song a TML 2 program makes is the same whatever order its parts are
// written in. A song is placed in two passes (resolve()): every cell placed
// for certain, then each fitted part against those — fitted parts see the
// certain cells and never one another.
//
// The cells are the score's own (music.js): note (a 4096-TET word or an
// ending), inst (an instrument), vol, volRaw/volSel (a volume-column command),
// panRaw, az/el (a position), fx/arg, fx2/arg2 — plus `cap`, the fields a
// preview captured ({field: true}), present only while one is being taken.
// When a note from elsewhere wins over an ending the previewed call made,
// `cap.$note` keeps that ending: it is still how the call's last note ends.
//
// A fitted part is {lane, self, cap, pos, trace, gen(view, interp) → Phrase},
// `view(row)` being the certain cell the song has on its lane there. The
// builtins' own (a vibrato, a ramp, music under() the rest) also carry their
// `spec` — what they are, as data — so a transformation can fit them again
// where their music now lies (retime.js turns a ramp round, draws a vibrato
// out); any other part is wrapped: read through a mapped view, its music
// transformed afterwards.

import { Phrase, Rec, fail, typeName, MotifError } from "./values.js";

export const KEY_OFF = 0x0001;
export const NOTE_CUT = 0x0002;
export const NOTE_FADE = 0x0003;
export const FX_G = 16; // "G", a tone portamento: a note that glides rather than strikes
const FX_H = 17;        // "H", vibrato
export const isEnding = (w) => w === KEY_OFF || w === NOTE_CUT || w === NOTE_FADE;
/** A cell that only ends a note. */
export const endingOnly = (c) => isEnding(c.note) && Object.keys(c).every((k) => k === "note" || k === "cap");

function copyCell(c) {
  const out = { ...c };
  if (c.cap) out.cap = { ...c.cap };
  return out;
}
/** The field `k` of `out` now comes from `from`: so does whether it was captured. */
function takeCap(out, k, from) {
  if (from.cap?.[k]) (out.cap ??= {})[k] = true;
  else if (out.cap) delete out.cap[k];
}

/**
 * Cell `b` merged into cell `a`, as a new cell (neither changes; `a` itself
 * when `b` adds nothing). Throws the score's clash error for two different
 * values of one field — a note over an ending, or an ending under a note,
 * excepted.
 */
export function mergeCells(score, lane, row, a, b) {
  let out = null;
  for (const k in b) {
    if (k === "cap") continue;
    const v = b[k];
    const old = a[k];
    if (old === undefined) {
      out ??= copyCell(a);
      out[k] = v;
      takeCap(out, k, b);
      continue;
    }
    if (old === v) {
      if (b.cap?.[k] && !a.cap?.[k]) { out ??= copyCell(a); takeCap(out, k, b); }
      continue;
    }
    if (k === "note") {
      if (isEnding(old) && v >= 0x20) {
        out ??= copyCell(a);
        out.note = v;
        const ghost = a.cap?.note && !b.cap?.note ? old : undefined;
        takeCap(out, k, b);
        if (ghost !== undefined) (out.cap ??= {}).$note = ghost;
        continue;
      }
      if (isEnding(v) && old >= 0x20) {
        if (b.cap?.note && !a.cap?.note) { out ??= copyCell(a); (out.cap ??= {}).$note = v; }
        continue;
      }
    }
    throw score.clash(lane, row, k, old, v);
  }
  // the volume column holds a volume or a command, not both
  const c = out ?? a;
  if (c.vol !== undefined && c.volRaw !== undefined) throw score.clash(lane, row, "volume", c.vol, "a volume command");
  return c;
}

/**
 * Phrases put together, one at a time — a block's music as its statements
 * make it, so a clash is reported at the statement that brings it.
 */
export class Music {
  constructor(score) {
    this.score = score;
    this.cells = new Map();
    this.soft = [];
    this.from = Infinity;
    this.to = -Infinity;
    this.any = false;
  }

  add(p) {
    this.any = true;
    for (const [lane, rows] of p.cells) {
      let o = this.cells.get(lane);
      if (!o) this.cells.set(lane, (o = new Map()));
      for (const [row, c] of rows) {
        const e = o.get(row);
        o.set(row, e ? mergeCells(this.score, lane, row, e, c) : c);
      }
    }
    for (const part of p.soft) this.soft.push(part);
    if (p.from < this.from) this.from = p.from;
    if (p.to > this.to) this.to = p.to;
  }

  /** What has been put together, as a phrase — none when nothing was. */
  phrase() {
    return this.any ? new Phrase(this.cells, this.soft, this.from, this.to) : null;
  }
}

/** Several phrases as one; `none`s are skipped, lists flattened. */
export function union(score, items) {
  const m = new Music(score);
  const add = (v) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) { v.forEach(add); return; }
    if (!(v instanceof Phrase)) throw fail(`music is phrases (or none), not ${typeName(v)}`);
    m.add(v);
  };
  items.forEach(add);
  return m.phrase();
}

export function emptyPhrase(from, to) {
  return new Phrase(new Map(), [], from, to);
}

// ── fitted parts ──

/** The vibrato rule, over any cells: `read(row)` → the cell there. The first
 *  row states speed and depth, the rest recall it; a row that already has an
 *  effect is stepped round (the next free one restates), a key-off ends it. */
export function vibratoRows(read, from, to, speed, depth, write) {
  let first = true;
  for (let r = from; r < to; r++) {
    const c = read(r);
    if (c?.fx !== undefined) { first = true; continue; }
    if (c?.note === KEY_OFF) break;
    write(r, { fx: FX_H, arg: first ? ((speed << 8) | depth) : 0 });
    first = false;
  }
}

/**
 * The volume ramp rule, over any cells: one fine slide a row over [r0, end)
 * of a ramp that runs to r1, each the rounded share of what is left, stepping
 * round rows whose volume column is taken.
 */
export function volRampRows(read, r0, end, r1, from, to, wide, write) {
  const lim = wide ? 127 : 31;
  let cur = from;
  for (let r = r0; r < end; r++) {
    const want = Math.round(from + ((to - from) * (r - r0 + 1)) / (r1 - r0));
    const d = Math.max(-lim, Math.min(lim, want - cur));
    const c = read(r);
    if (c && (c.volRaw !== undefined || c.vol !== undefined)) continue;
    if (d === 0) continue;
    const m = Math.abs(d);
    if (wide) write(r, { volSel: 3, volRaw: (d > 0 ? 0x80 : 0) | m });
    else write(r, { volRaw: 0xc0 | (d > 0 ? 0x20 : 0) | m });
    cur += d;
  }
}

/** Columns as the pattern grid names them → the cell fields each holds. */
export const COLUMNS = {
  note: ["note"], inst: ["inst"], vol: ["vol", "volRaw", "volSel"], pan: ["panRaw", "az", "el"],
  fx: ["fx", "arg"], fx2: ["fx2", "arg2"],
};

/**
 * A fitted part from its spec:
 *   {type: "vibrato", lane, from, to, speed, depth}
 *   {type: "ramp", lane, r0, r1, end, v0, v1, wide}   (volumes in the lane's own units)
 *   {type: "under", lane, cells: Map row → cell, keys (the fields that take a row, or null: any), from, to}
 */
export function fittedPart(spec, meta = {}) {
  return { lane: spec.lane, self: true, cap: meta.cap ?? false, pos: meta.pos ?? null, trace: meta.trace ?? null, spec, gen: specGen(spec) };
}

function specGen(spec) {
  const one = (from, to, rule) => (view) => {
    const out = new Map();
    rule(view, (r, f) => out.set(r, { ...f }));
    return new Phrase(new Map([[spec.lane, out]]), [], from, to);
  };
  switch (spec.type) {
    case "vibrato":
      return one(spec.from, spec.to, (view, write) => vibratoRows(view, spec.from, spec.to, spec.speed, spec.depth, write));
    case "ramp":
      return one(spec.r0, spec.end, (view, write) => volRampRows(view, spec.r0, spec.end, spec.r1, spec.v0, spec.v1, spec.wide, write));
    case "under": {
      const taken = (c) => c !== undefined && (spec.keys === null || spec.keys.some((k) => c[k] !== undefined));
      return (view) => {
        const kept = new Map();
        for (const [r, c] of spec.cells) if (!taken(view(r))) kept.set(r, c);
        return new Phrase(new Map([[spec.lane, kept]]), [], spec.from, spec.to);
      };
    }
    default: throw new Error(`internal error: fitted part ${spec.type}`);
  }
}

/**
 * A phrase's fitted parts through a transformation: fitted again from `spec(s)`
 * when it gives a new spec; otherwise wrapped — the part reads the song through
 * `view(row)` (its row → the song's) and what it places goes through `wrap`.
 * Parts that step round their own lane move to `lane` when one is given.
 */
export function transformParts(score, p, { spec = null, view = null, wrap, lane = null }) {
  const cap = capturing(score);
  return p.soft.map((part) => {
    const meta = { cap: part.cap || cap, pos: part.pos, trace: part.trace };
    if (part.spec && spec) {
      const s = spec(part.spec);
      if (s) return fittedPart(s, meta);
    }
    return {
      ...part, ...meta, spec: null,
      lane: lane && part.self ? lane : part.lane,
      gen: (v, interp) => {
        const q = part.gen(view ? (r) => v(view(r)) : v, interp);
        return q && wrap(q, interp);
      },
    };
  });
}

// ── transformations ──
// Each applies to the cells placed for certain and to what the fitted parts
// will place, so a transformed phrase fits the song the same way. What a
// transformation makes while a preview is capturing (the call being previewed
// is being evaluated) is part of what that call makes: its cells, and the
// fitted parts it carries, are marked as captured.

export const capturing = (score) => score.capture?.test() ?? false;
export function captured(c) {
  const d = { ...c, cap: {} };
  for (const k in c) if (k !== "cap") d.cap[k] = true;
  return d;
}

/** One lane's cells moved `n` rows; an ending pushed past the song's end has
 *  nothing left to end (a melody writes none there either) and is left out. */
function shiftRows(score, lane, src, n, cap) {
  const rows = score.rows;
  const dst = new Map();
  for (const [r, c] of src) {
    const at = r + n;
    if (at >= rows && endingOnly(c)) continue;
    if (at < 0 || at >= rows) {
      throw fail(`moving the music ${n} rows puts a cell of lane ${lane.id} on row ${at}, outside the song (rows 0–${rows - 1})`);
    }
    dst.set(at, cap ? captured(c) : c);
  }
  return dst;
}

/** `p` moved `n` rows later (earlier when negative). */
export function shiftPhrase(score, p, n) {
  if (n === 0) return p;
  const cap = capturing(score);
  const cells = new Map();
  for (const [lane, src] of p.cells) cells.set(lane, shiftRows(score, lane, src, n, cap));
  const inSong = (lane, a, b) => {
    if (a < 0 || b > score.rows) {
      throw fail(`moving the music ${n} rows puts fitted music of lane ${lane.id} on rows ${a}–${b - 1}, outside the song (rows 0–${score.rows - 1})`);
    }
  };
  const soft = transformParts(score, p, {
    spec: (s) => {
      switch (s.type) {
        case "vibrato": inSong(s.lane, s.from + n, s.to + n); return { ...s, from: s.from + n, to: s.to + n };
        case "ramp": inSong(s.lane, s.r0 + n, s.end + n); return { ...s, r0: s.r0 + n, r1: s.r1 + n, end: Math.min(s.end + n, score.rows) };
        case "under": return { ...s, cells: shiftRows(score, s.lane, s.cells, n, false), from: s.from + n, to: s.to + n };
        default: return null;
      }
    },
    view: (r) => r + n,
    wrap: (q) => shiftPhrase(score, q, n),
  });
  return new Phrase(cells, soft, p.from + n, p.to + n);
}

/**
 * Every cell through `f(cell, lane, row)` → a cell, or null to drop it; the
 * span is `span` ([from, to]) or the phrase's own. `keepsFitted`: `f` leaves
 * vibratos and ramps alone (it changes notes or set volumes only), so they
 * stay as they are and can still be fitted again later.
 */
export function mapCells(score, p, f, span = null, keepsFitted = false) {
  const cap = capturing(score);
  const mapRows = (lane, src, mark) => {
    const dst = new Map();
    for (const [r, c] of src) {
      const d = f(c, lane, r);
      if (d) dst.set(r, mark ? captured(d) : d);
    }
    return dst;
  };
  const cells = new Map();
  for (const [lane, src] of p.cells) cells.set(lane, mapRows(lane, src, cap));
  const soft = transformParts(score, p, {
    spec: (s) => (s.type === "under" ? { ...s, cells: mapRows(s.lane, s.cells, false) } : keepsFitted ? s : null),
    wrap: (q) => mapCells(score, q, f, span, keepsFitted),
  });
  return new Phrase(cells, soft, span ? span[0] : p.from, span ? span[1] : p.to);
}

/** The rows [from, to) of `p`. */
export function slicePhrase(score, p, from, to) {
  const a = Math.max(p.from, from), b = Math.max(a, Math.min(p.to, to));
  return mapCells(score, p, (c, _l, r) => (r >= from && r < to ? c : null), [a, b]);
}

/**
 * `p` played on `lane`: every cell moves there, and a note that played the
 * lane it came from's own instrument plays the new lane's (a note given an
 * instrument of its own keeps it). Fitted parts that step round their own
 * lane step round the new one.
 */
export function onLane(score, p, lane) {
  const cap = capturing(score);
  const m = new Music(score);
  const move = (src, rows, mark) => {
    const swap = src.instrument !== lane.instrument ? src.instrument : null;
    const moved = new Map();
    for (const [r, c] of rows) {
      const d = swap && c.inst === swap ? { ...c, inst: lane.instrument } : c;
      moved.set(r, mark ? captured(d) : d);
    }
    return moved;
  };
  for (const [src, rows] of p.cells) m.add(new Phrase(new Map([[lane, move(src, rows, cap)]]), [], p.from, p.to));
  const soft = transformParts(score, p, {
    spec: (s) => (s.type === "under" ? { ...s, lane, cells: move(s.lane, s.cells, false) } : { ...s, lane }),
    wrap: (q) => onLane(score, q, lane),
    lane,
  });
  return new Phrase(m.cells, soft, p.from, p.to);
}

/**
 * `p`, placed only where the rest of the song leaves room: a row of a lane
 * that already writes anything there (or, given `columns`, anything in those
 * columns) is left out, the whole row of `p` with it.
 */
export function underPhrase(p, columns, where) {
  const keys = columns.length ? columns.flatMap((c) => COLUMNS[c]) : null;
  const soft = [...p.soft];
  for (const [lane, rows] of p.cells) {
    if (!rows.size) continue;
    soft.push(fittedPart({ type: "under", lane, cells: rows, keys, from: p.from, to: p.to }, where));
  }
  return new Phrase(new Map(), soft, p.from, p.to);
}

/** Every field of every cell marked as captured (a preview's fitted part). */
function captureAll(p) {
  const cells = new Map();
  for (const [lane, rows] of p.cells) {
    const dst = new Map();
    for (const [r, c] of rows) dst.set(r, captured(c));
    cells.set(lane, dst);
  }
  return new Phrase(cells, p.soft.map((part) => ({ ...part, cap: true })), p.from, p.to);
}

/**
 * The song a TML 2 program makes: the cells of `p` placed for certain, then
 * each fitted part against them. Returns Map lane → Map row → cell.
 */
export function resolve(score, p, interp) {
  const m = new Music(score);
  if (!p) return m.cells;
  const hard = p.cells;
  m.add(new Phrase(hard, [], p.from, p.to));
  const run = (parts, depth) => {
    for (const part of parts) {
      if (depth > 16) throw new MotifError("fitted music nests more than 16 deep", part.pos ?? null, part.trace ?? null);
      try {
        const view = (r) => hard.get(part.lane)?.get(r);
        let q = part.gen(view, interp);
        if (!q) continue;
        if (!(q instanceof Phrase)) throw fail(`fitted music is a phrase, not ${typeName(q)}`);
        if (part.cap) q = captureAll(q);
        m.add(new Phrase(q.cells, [], q.from, q.to));
        if (q.soft.length) run(q.soft, depth + 1);
      } catch (err) {
        if (err instanceof MotifError) {
          if (!err.pos && part.pos) err.pos = part.pos;
          if (!err.trace && part.trace?.length) err.trace = part.trace;
        }
        throw err;
      }
    }
  };
  run(p.soft, 0);
  return m.cells;
}

// ── reading a phrase ──

/** A cell as the record cell() and cells() give (the fields it has). */
export function cellRecord(score, c, lane = null, row = null) {
  const out = new Rec();
  if (lane) out.m.set("lane", lane.handle);
  if (row !== null) out.m.set("row", row);
  if (c.note !== undefined) {
    out.m.set("note", c.note === KEY_OFF ? "off" : c.note === NOTE_CUT ? "cut" : c.note === NOTE_FADE ? "fade"
      : (score.tuning.stepOfWord(c.note) ?? null));
  }
  if (c.inst !== undefined) out.m.set("inst", c.inst.handle);
  if (c.vol !== undefined) out.m.set("vol", c.vol);
  if (c.volRaw !== undefined) out.m.set("vol_cmd", true);
  if (c.fx !== undefined) { out.m.set("fx", opLetter(c.fx)); out.m.set("arg", c.arg ?? 0); }
  if (c.fx2 !== undefined) { out.m.set("fx2", opLetter(c.fx2)); out.m.set("arg2", c.arg2 ?? 0); }
  if (c.az !== undefined) out.m.set("pos", new Rec([["az", c.az], ["el", c.el ?? 0]]));
  return out;
}

const B36 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const opLetter = (b) => (b < 36 ? B36[b] : String.fromCharCode(b - 0x80));

/** Every cell of `p` (of one lane, given `lane`), in lane order then row order. */
export function cellList(score, p, lane = null) {
  const out = [];
  for (const l of score.lanes) {
    if (lane && l !== lane) continue;
    const rows = p.cells.get(l);
    if (!rows) continue;
    for (const r of [...rows.keys()].sort((a, b) => a - b)) out.push(cellRecord(score, rows.get(r), l, r));
  }
  return out;
}

/** The step of a note word, for transforming it (an error off the grid). */
export function stepOf(score, word) {
  const s = score.tuning.stepOfWord(word);
  if (s === null || s === undefined) throw fail(`a note at word $${word.toString(16).toUpperCase()} is not a step of the song's tuning`);
  return s;
}
