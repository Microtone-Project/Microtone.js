// Turning music round in time (TML 2): reverse() plays a phrase backwards,
// stretch() plays it slower or faster. Both work on what the music IS rather
// than on its rows, since a tracker row is not a note: a note SOUNDS from its
// row until something ends it, a glide carries a sound on to another pitch,
// and effects and volume commands act on the sound between.
//
// reverse — on each lane the sounds and silences come in the opposite order,
// each as long as it was. A sound keeps how it is struck (instrument, its own
// effects, its position) but is struck at the volume it ENDED at; inside it,
// its glides run the other way and every change of volume is undone in
// reverse, so a swell becomes a fade. Effects between notes turn round with
// their rows (a run of one effect is restated at its new first row). Fitted
// vibratos and ramps are fitted again where their music now lies — a ramp
// from 20 to 50 becomes one from 50 to 20. The phrase keeps its span.
//
// Endings: a reversed sound is let go where the original was ENTERED from
// silence — with the ending that began that silence, or, after the phrase's
// start or a leading rest, the way the music lets its notes go (its ending on
// its last row, else its last ending; music that lets nothing go, a ringing
// melody, gets none). So a reversed melody is let go at its end as a melody
// is, and reversing twice gives the music back.
//
// Rows (T = from + to): a sound over [a, b) is over [T − b, T − a). Inside a
// sound, what is on its striking row goes with the strike, and what is on a
// row after it keeps its distance from the sound's END — j rows after the
// strike becomes j rows before the end: row r → T − r, never the strike's row.
// Between sounds a row is mirrored: r → T − 1 − r. Both are their own inverse,
// so reversing twice gives the music back.
//
// stretch — every row of the music lasts `factor` rows, counted from its
// start. What happens at a moment — a note, a glide, an ending, a volume or
// pan set, a lone effect, a fine volume step — must land on a whole row. A
// glide takes as much longer (its speed divided by the factor). What goes on
// through rows is drawn out over its new length: an effect on rows in a row (a
// vibrato, a roll), and volume slides, whose change is spread over the new
// rows; fitted vibratos and ramps are fitted again over their new rows.

import { Phrase, fail } from "./values.js";
import {
  Music, mergeCells, transformParts, capturing, captured, FX_G, isEnding, endingOnly,
} from "./phrase.js";

// ── volume-column commands ──

/** A cell's volume command: {fine: Δ} (tick 0), {slide: per tick}, or null. */
function volCmd(c, wide) {
  if (c.volRaw === undefined) return null;
  const raw = c.volRaw;
  if (wide) {
    if (c.volSel === 3) return { fine: (raw & 0x80 ? 1 : -1) * (raw & 0x7f) };
    if (c.volSel === 1) return { slide: raw };
    if (c.volSel === 2) return { slide: -raw };
    return null;
  }
  if ((raw & 0xc0) === 0xc0) return { fine: (raw & 0x20 ? 1 : -1) * (raw & 0x1f) };
  if ((raw & 0xc0) === 0x40) return { slide: raw & 0x3f };
  if ((raw & 0xc0) === 0x80) return { slide: -(raw & 0x3f) };
  return null;
}
const FINE_MAX = (wide) => (wide ? 127 : 31);
const SLIDE_MAX = (wide) => (wide ? 255 : 63);
function fineCell(d, wide) {
  const m = Math.abs(d);
  if (m > FINE_MAX(wide)) throw fail(`that needs a fine volume slide of ${m} on one row (at most ${FINE_MAX(wide)})`);
  return wide ? { volSel: 3, volRaw: (d > 0 ? 0x80 : 0) | m } : { volRaw: 0xc0 | (d > 0 ? 0x20 : 0) | m };
}
function slideCell(d, wide) {
  const m = Math.abs(d);
  if (m > SLIDE_MAX(wide)) throw fail(`that needs a volume slide of ${m} a tick (at most ${SLIDE_MAX(wide)})`);
  return wide ? { volSel: d > 0 ? 1 : 2, volRaw: m } : { volRaw: (d > 0 ? 0x40 : 0x80) | m };
}

/** `keys` of cell `c` (those it has), with whether each was captured. */
function pick(c, keys) {
  const o = {};
  for (const k of keys) {
    if (c[k] === undefined) continue;
    o[k] = c[k];
    if (c.cap?.[k]) (o.cap ??= {})[k] = true;
  }
  return o;
}
/** New fields that stand for `src`'s `key`: captured when it was. */
function capAs(src, key, fields) {
  if (src?.cap?.[key]) {
    fields.cap = {};
    for (const k in fields) if (k !== "cap") fields.cap[k] = true;
  }
  return fields;
}
const empty = (o) => Object.keys(o).every((k) => k === "cap");

const STRIKE = ["inst", "fx", "arg", "fx2", "arg2", "panRaw", "az", "el"]; // how a sound is struck
const GLIDE = ["inst", "fx", "arg", "fx2", "arg2", "panRaw", "az", "el"];  // a glide (its G and speed among them)

/**
 * One lane's cells as sounds and what lies between:
 * {rows (sorted, within the phrase), sounds: [{start, end, segs: [{r, cell}],
 *  before: "direct" (another sound ran into it) | "start" | "lead" (after the
 *  leading rest) | an ending cell (the one that began the silence before it)}],
 *  endings (rows of the endings the sounds and silences account for), loose
 *  (endings in a silence that already had one), letGo (how the music lets a
 *  note go: its ending on the phrase's last row, else its last ending, else null)}.
 */
function readLane(lane, cells, from, to) {
  const rows = [...cells.keys()].sort((a, b) => a - b);
  const sounds = [], endings = [], loose = [];
  let cur = null, silenceEnding = null, lastEnding = null, tailEnding = null;
  for (const r of rows) {
    const c = cells.get(r);
    if (r >= to) {
      if (!endingOnly(c)) throw fail(`lane ${lane.id} has music on row ${r}, after the end of the phrase (row ${to})`);
      tailEnding ??= c;
      continue;
    }
    if (r < from) throw fail(`lane ${lane.id} has music on row ${r}, before the start of the phrase (row ${from})`);
    if (c.note === undefined) continue;
    if (isEnding(c.note)) {
      lastEnding = c;
      if (cur) { cur.end = r; sounds.push(cur); cur = null; silenceEnding = c; endings.push(r); }
      else if (!silenceEnding) { silenceEnding = c; endings.push(r); }
      else loose.push(r);
      continue;
    }
    if (cur && c.fx === FX_G) { cur.segs.push({ r, cell: c }); continue; } // glides on
    let before;
    if (cur) { cur.end = r; sounds.push(cur); before = "direct"; }
    else if (silenceEnding) before = silenceEnding;
    else before = r === from ? "start" : "lead";
    cur = { start: r, segs: [{ r, cell: c }], before };
    silenceEnding = null;
  }
  if (cur) { cur.end = to; sounds.push(cur); }
  return { rows: rows.filter((r) => r >= from && r < to), sounds, endings, loose, letGo: tailEnding ?? lastEnding };
}

/**
 * One lane's cells reversed about T (its window [from, to)). `ramps`: the
 * fitted ramps on the lane ({r0, end, v0, v1}), for the volume a sound ends at.
 */
function reverseLane(score, lane, cells, from, to, T, ramps) {
  const wide = score.wide;
  const out = new Map();
  const put = (r, cell) => {
    if (!cell || empty(cell)) return;
    if (r >= score.rows && endingOnly(cell)) return; // nothing left to end
    const e = out.get(r);
    out.set(r, e ? mergeCells(score, lane, r, e, cell) : cell);
  };
  const L = readLane(lane, cells, from, to);
  /** Where what is on row r goes (its strike row: with the strike). */
  const strikeOf = new Map(), inside = new Set();
  for (const s of L.sounds) {
    strikeOf.set(s.start, s);
    for (let r = s.start + 1; r < s.end; r++) inside.add(r);
  }
  const place = (r) => (strikeOf.has(r) ? T - strikeOf.get(r).end : inside.has(r) ? T - r : T - 1 - r);
  const done = new Set(); // "row:field" handled with its sound
  const mark = (r, ...keys) => { for (const k of keys) done.add(`${r}:${k}`); };
  const trim = lane.trim, ticks = score.song.speed - 1, vmax = score.volMax;
  const clamp = (v) => Math.max(0, Math.min(vmax, v));

  for (const s of L.sounds) {
    // the volume through the sound, in the lane's own units (after its trim)
    const att = s.segs[0].cell;
    let v = att.vol !== undefined ? att.vol * trim : null;
    let struck = 0; // the change the strike's own row makes (it goes with the strike)
    let pan = att.panRaw ?? null;
    let pos = att.az !== undefined ? { az: att.az, el: att.el ?? 0 } : null;
    mark(s.start, "vol");
    for (let r = s.start; r < s.end; r++) {
      for (const ramp of ramps) if (ramp.end - 1 === r && v !== null) v = clamp(v + (ramp.v1 - ramp.v0));
      const c = cells.get(r);
      if (!c) continue;
      if (r > s.start && c.vol !== undefined) {
        // a volume set (on a glide, or alone): reversed, the volume before it,
        // from its row's mirror on
        if (v !== null) put(T - r, capAs(c, "vol", { vol: Math.round(clamp(v) / trim) }));
        v = c.vol * trim;
        mark(r, "vol");
      }
      if (r > s.start && c.note === undefined && c.panRaw !== undefined) {
        if (pan !== null) put(T - r, capAs(c, "panRaw", { panRaw: pan }));
        pan = c.panRaw;
        mark(r, "panRaw");
      }
      if (r > s.start && c.note === undefined && c.az !== undefined) {
        if (pos !== null) put(T - r, capAs(c, "az", { az: pos.az, el: pos.el }));
        pos = { az: c.az, el: c.el ?? 0 };
        mark(r, "az", "el");
      }
      const cmd = volCmd(c, wide);
      if (cmd && r === s.start) {
        // the strike's own row: the change goes with the strike, which is
        // struck that much short of where the sound ended
        struck = cmd.fine ?? cmd.slide * ticks;
        if (v !== null) v = clamp(v + struck);
      } else if (cmd?.fine !== undefined) {
        if (v !== null) v = clamp(v + cmd.fine);
        put(T - r, capAs(c, "volRaw", fineCell(-cmd.fine, wide)));
        mark(r, "volRaw", "volSel");
      } else if (cmd?.slide !== undefined) {
        if (v !== null) v = clamp(v + cmd.slide * ticks);
        put(place(r), capAs(c, "volRaw", slideCell(-cmd.slide, wide)));
        mark(r, "volRaw", "volSel");
      }
    }
    // struck as it ended; its glides the other way round
    const m = s.segs.length - 1;
    const strike = { ...pick(att, [...STRIKE, "volRaw", "volSel"]), ...pick(s.segs[m].cell, ["note"]) };
    if (v !== null) Object.assign(strike, capAs(att, "vol", { vol: Math.round(clamp(v - struck) / trim) }));
    if (pan !== null && att.panRaw !== undefined) strike.panRaw = pan;
    if (pos !== null && att.az !== undefined) { strike.az = pos.az; strike.el = pos.el; }
    put(T - s.end, strike);
    mark(s.start, ...STRIKE, "note", "volRaw", "volSel");
    for (let j = 1; j <= m; j++) {
      const g = s.segs[m - j + 1];
      put(T - g.r, { ...pick(g.cell, GLIDE), ...pick(s.segs[m - j].cell, ["note"]) });
      mark(g.r, ...GLIDE, "note");
    }
    // let go where the original was entered from silence
    const ending = s.before === "direct" ? null : s.before === "start" || s.before === "lead" ? L.letGo : s.before;
    if (ending) put(T - s.start, pick(ending, ["note"]));
  }
  for (const r of L.endings) mark(r, "note");
  for (const r of L.loose) { put(T - r, pick(cells.get(r), ["note"])); mark(r, "note"); }

  // what is left on each row turns round with it
  const runs = { fx: [], fx2: [] };
  for (const r of L.rows) {
    const c = cells.get(r);
    const rest = {};
    for (const k in c) {
      if (k === "cap" || done.has(`${r}:${k}`)) continue;
      rest[k] = c[k];
      if (c.cap?.[k]) (rest.cap ??= {})[k] = true;
    }
    if (rest.fx !== undefined) { runs.fx.push({ r, op: rest.fx, arg: rest.arg ?? 0, cap: rest.cap?.fx }); delete rest.fx; delete rest.arg; }
    if (rest.fx2 !== undefined) { runs.fx2.push({ r, op: rest.fx2, arg: rest.arg2 ?? 0, cap: rest.cap?.fx2 }); delete rest.fx2; delete rest.arg2; }
    const cmd = rest.volRaw !== undefined ? volCmd(rest, wide) : null;
    // (between sounds: a row's place; sounds and silences map onto rows of their own)
    if (cmd?.fine !== undefined) { put(place(r), capAs(rest, "volRaw", fineCell(-cmd.fine, wide))); delete rest.volRaw; delete rest.volSel; }
    else if (cmd?.slide !== undefined) { put(place(r), capAs(rest, "volRaw", slideCell(-cmd.slide, wide))); delete rest.volRaw; delete rest.volSel; }
    if (rest.cap) for (const k of Object.keys(rest.cap)) if (rest[k] === undefined) delete rest.cap[k];
    if (!empty(rest)) put(place(r), rest);
  }
  for (const [col, argKey] of [["fx", "arg"], ["fx2", "arg2"]]) {
    for (const run of effectRuns(runs[col])) {
      // a run of one effect is stated on its first row: reversed, that is the
      // row the run now starts on
      const placed = run.map((it) => ({ it, at: place(it.r) })).sort((x, y) => x.at - y.at);
      placed.forEach(({ it, at: row }, i) => {
        const cell = { [col]: it.op, [argKey]: run.length > 1 ? (i === 0 ? run[0].arg : 0) : it.arg };
        if (it.cap) cell.cap = { [col]: true, [argKey]: true };
        put(row, cell);
      });
    }
  }
  return out;
}

/** Effects as runs: rows in a row with one effect, stated on the first and
 *  recalled (argument 0) on the rest. A lone effect is a run of one. */
function effectRuns(items) {
  const runs = [];
  for (const it of items) {
    const run = runs[runs.length - 1];
    const last = run?.[run.length - 1];
    if (last && it.r === last.r + 1 && it.op === last.op && it.arg === 0) run.push(it);
    else runs.push([it]);
  }
  return runs;
}

/** `p` backwards, about T (its own from + to unless given): see the top. */
export function reversePhrase(score, p, T = p.from + p.to) {
  const cap = capturing(score);
  const ramps = new Map();
  for (const part of p.soft) {
    if (part.spec?.type !== "ramp") continue;
    if (!ramps.has(part.spec.lane)) ramps.set(part.spec.lane, []);
    ramps.get(part.spec.lane).push(part.spec);
  }
  const m = new Music(score);
  for (const [lane, cells] of p.cells) {
    let out = reverseLane(score, lane, cells, p.from, p.to, T, ramps.get(lane) ?? []);
    if (cap) out = new Map([...out].map(([r, c]) => [r, captured(c)]));
    m.add(new Phrase(new Map([[lane, out]]), [], T - p.to, T - p.from));
  }
  const soft = transformParts(score, p, {
    spec: (s) => {
      switch (s.type) {
        // a fitted vibrato is fitted again over the mirror image of its rows
        // (it steps round whatever it lands on), which keeps reverse and
        // stretch in step
        case "vibrato": return { ...s, from: T - s.to, to: T - s.from };
        case "ramp": {
          // a ramp's slides are steps at the start of its rows, inside a
          // sound: r → T − r, so a swell that starts the row after its strike
          // becomes a fade that ends on the sound's last row (rather than one
          // that starts on the strike's row, whose volume is taken). One the
          // song's end cut short runs back from where it got to.
          const got = s.end < s.r1 ? Math.round(s.v0 + ((s.v1 - s.v0) * (s.end - s.r0)) / (s.r1 - s.r0)) : s.v1;
          const r0 = T - s.end + 1, r1 = T - s.r0 + 1;
          return { ...s, r0, r1, end: Math.min(r1, score.rows), v0: got, v1: s.v0 };
        }
        case "under": return { ...s, cells: reverseLane(score, s.lane, s.cells, s.from, s.to, T, []), from: T - s.to, to: T - s.from };
        default: return null;
      }
    },
    view: (r) => T - 1 - r,
    wrap: (q) => reversePhrase(score, q, T),
  });
  return new Phrase(m.cells, soft, T - p.to, T - p.from);
}

// ── stretch ──

/** Row r of music that starts at `origin`, stretched by k: a whole row, or an error. */
function stretcher(lane0, origin, k) {
  return (r, lane = lane0) => {
    const x = origin + (r - origin) * k;
    const n = Math.round(x);
    if (Math.abs(x - n) > 1e-9) {
      throw fail(`stretching by ${k} puts row ${r}${lane ? ` of lane ${lane.id}` : ""} between two rows (at ${Math.round(x * 1000) / 1000}): every cell of the music must land on a whole row`);
    }
    return n;
  };
}

/** One lane's cells stretched by k from `origin`. */
function stretchLane(score, lane, cells, origin, k) {
  const wide = score.wide;
  const at = stretcher(lane, origin, k);
  const exact = (r) => origin + (r - origin) * k;      // where row r's start lands, maybe between rows
  const back = (t) => origin + (t - origin) / k;       // the original time at row t's start
  const near = (x) => Math.round(x + 1e-9);            // the nearest row (a half rounds up)
  const out = new Map();
  const put = (r, cell) => {
    if (!cell || empty(cell)) return;
    if (r >= score.rows && endingOnly(cell)) return;
    if (r < 0 || r >= score.rows) throw fail(`stretching by ${k} puts music of lane ${lane.id} on row ${r}, outside the song (rows 0–${score.rows - 1})`);
    const e = out.get(r);
    out.set(r, e ? mergeCells(score, lane, r, e, cell) : cell);
  };
  const rows = [...cells.keys()].sort((a, b) => a - b);
  const fx = [], fx2 = [], fine = new Map(), slide = new Map();
  let volCap = false;
  for (const r of rows) {
    const c = cells.get(r);
    const rest = {};
    for (const key in c) {
      if (key === "cap") continue;
      rest[key] = c[key];
      if (c.cap?.[key]) (rest.cap ??= {})[key] = true;
    }
    // volume commands are a contour, whatever row they are on
    const cmd = rest.volRaw !== undefined ? volCmd(rest, wide) : null;
    if (cmd) {
      if (cmd.fine !== undefined) fine.set(r, cmd.fine);
      else slide.set(r, cmd.slide);
      if (rest.cap?.volRaw) volCap = true;
      delete rest.volRaw; delete rest.volSel;
    }
    if (c.note !== undefined) {
      // notes, glides and endings move (and keep their own effects); a glide
      // takes k times as long
      if (c.fx === FX_G && c.note >= 0x20) rest.arg = Math.max(1, Math.min(0xffff, Math.round((c.arg ?? 0) / k)));
    } else {
      if (rest.fx !== undefined) { fx.push({ r, op: rest.fx, arg: rest.arg ?? 0, cap: rest.cap?.fx }); delete rest.fx; delete rest.arg; }
      if (rest.fx2 !== undefined) { fx2.push({ r, op: rest.fx2, arg: rest.arg2 ?? 0, cap: rest.cap?.fx2 }); delete rest.fx2; delete rest.arg2; }
    }
    if (rest.cap) for (const key of Object.keys(rest.cap)) if (rest[key] === undefined) delete rest.cap[key];
    if (!empty(rest)) put(at(r), rest);
  }
  // an effect on rows in a row is drawn out over its new length: a vibrato
  // (stated, then recalled) is stated once; one restated on every row (a roll
  // of retriggers) goes on being restated
  for (const [items, col, argKey] of [[fx, "fx", "arg"], [fx2, "fx2", "arg2"]]) {
    const runs = [];
    for (const it of items) {
      const run = runs[runs.length - 1];
      if (run && it.r === run[run.length - 1].r + 1 && it.op === run[0].op) run.push(it);
      else runs.push([it]);
    }
    for (const run of runs) {
      const cell = (it, arg) => Object.assign({ [col]: it.op, [argKey]: arg }, it.cap ? { cap: { [col]: true, [argKey]: true } } : {});
      if (run.length === 1) { put(at(run[0].r), cell(run[0], run[0].arg)); continue; }
      const recalls = run.slice(1).every((it) => it.arg === 0);
      const a = near(exact(run[0].r)), b = Math.max(a + 1, near(exact(run[run.length - 1].r + 1)));
      let seen = -1;
      for (let t = a; t < b; t++) {
        const i = Math.min(run.length - 1, Math.max(0, Math.floor(back(t) + 1e-9) - run[0].r));
        put(t, cell(run[i], i !== seen || !recalls ? run[i].arg : 0));
        seen = i;
      }
    }
  }
  // volume: a fine slide is a step at the start of its row and stays one
  // (steps that meet on a row add up); a slide changes the volume through its
  // row, and the same change is spread over the new rows. Neither is written
  // on a row whose volume a note sets: it carries on to the next row.
  const capOf = (cell) => (volCap ? Object.assign(cell, { cap: { volRaw: true, volSel: true } }) : cell);
  const steps = new Map();
  for (const [r, d] of fine) { const t = near(exact(r)); steps.set(t, (steps.get(t) ?? 0) + d); }
  let carry = 0;
  for (const t of [...steps.keys()].sort((x, y) => x - y)) {
    const d = steps.get(t) + carry;
    carry = 0;
    if (out.get(t)?.vol !== undefined) { carry = d; continue; }
    if (d !== 0) put(t, capOf(fineCell(d, wide)));
  }
  if (slide.size) {
    const first = Math.min(...slide.keys()), last = Math.max(...slide.keys());
    const total = (x) => { // the slide so far at time x (rows, possibly between)
      let sum = 0;
      for (const [r, v] of slide) if (r < x) sum += v * Math.min(1, x - r);
      return sum;
    };
    const a = near(exact(first)), b = Math.max(a + 1, near(exact(last + 1)));
    let carried = 0;
    for (let t = a; t < b; t++) {
      const d = Math.round(total(back(t + 1)) + 1e-9) - Math.round(total(back(t)) + 1e-9) + carried;
      carried = 0;
      if (out.get(t)?.vol !== undefined) { carried = d; continue; }
      if (d !== 0) put(t, capOf(slideCell(d, wide)));
    }
  }
  return out;
}

/** `p` stretched by k (2: twice as slow; 0.5: twice as fast), from its start. */
export function stretchPhrase(score, p, k, origin = p.from) {
  if (k === 1) return p;
  const cap = capturing(score);
  const at = stretcher(null, origin, k);
  const to = at(p.to);
  const m = new Music(score);
  for (const [lane, cells] of p.cells) {
    let out = stretchLane(score, lane, cells, origin, k);
    if (cap) out = new Map([...out].map(([r, c]) => [r, captured(c)]));
    m.add(new Phrase(new Map([[lane, out]]), [], at(p.from), to));
  }
  const soft = transformParts(score, p, {
    spec: (s) => {
      switch (s.type) {
        case "vibrato": return { ...s, from: at(s.from, s.lane), to: at(s.to, s.lane) };
        case "ramp": {
          const r0 = at(s.r0, s.lane), r1 = at(s.r1, s.lane);
          return { ...s, r0, r1, end: Math.min(r1, score.rows) };
        }
        case "under": return { ...s, cells: stretchLane(score, s.lane, s.cells, origin, k), from: at(s.from, s.lane), to: at(s.to, s.lane) };
        default: return null;
      }
    },
    view: (r) => at(r),
    wrap: (q) => stretchPhrase(score, q, k, origin),
  });
  return new Phrase(m.cells, soft, at(p.from), to);
}
