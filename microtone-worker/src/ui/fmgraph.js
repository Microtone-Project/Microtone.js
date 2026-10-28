// The FM algorithm diagram (item 159.2) — an SVG of the picture every FM chip's
// manual prints, drawn from the rack's own RPN program via doc/fmedit.js's
// fmGraph. Layout is pure and lives there; this file only paints it.
//
// HORIZONTAL, not the vertical stack the DX7 and its descendants draw. The
// reason is the shape of the panel it sits in: the algorithm shares a tab with
// the operator table and the word list, both of which are wide and short, and a
// six-deep vertical chain would push the word list off the bottom of the pane.
// Turned on its side the same chain is a strip a few rows tall, and the signal
// then runs left to right into OUTPUT, which is the direction everything else
// here is read in.
//
// Nothing is hard-coded to a theme: strokes and fills are `currentColor` and CSS
// variables, so the diagram follows the palette like the rest of the app.
//
// The OPL tab draws its connections with it too (doc/oplgraph.js), and IMS
// Studio carries a verbatim copy, so it imports nothing.

const SVG_NS = "http://www.w3.org/2000/svg";

const el = (name, attrs, text) => {
  const n = document.createElementNS(SVG_NS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (text !== undefined) n.textContent = text;
  return n;
};

// Grid geometry. BOX is the operator; the pitches leave room for the elbow in
// a wire that changes lane, which is what stops two branches sharing a line.
const BOX_W = 30;
const BOX_H = 24;
const COL_PITCH = 54;
const ROW_PITCH = 36;
const OUT_W = 46;
const JUNCTION_R = 9;
const PAD_X = 4;
const PAD_BOTTOM = 4;
// A self-feedback curl arcs over its box, so a row carrying one needs headroom.
const PAD_TOP_PLAIN = 4;
const PAD_TOP_LOOP = 15;

/**
 * Paint `graph` (doc/fmlayout.js fmTreeGraph: an FM Rack's fmGraph, an OPL
 * connection's oplGraph) as an `<svg>`.
 *
 * `label(k)` names operator k in its box — the index by default; `title(k)`
 * fills its tooltip, and `loopTitle(k, feedback)` its feedback curl's. A curl
 * whose cell says its depth is 0 is drawn idle: the path is there, nothing
 * goes round it. `outLabel` names the sink.
 *
 * `canvas` ({cols, rows}) draws on a canvas at least that big, the picture
 * keeping OUT at the right-hand end and centred on the height, so diagrams
 * drawn on one canvas — an OPL channel's connections — replace one another
 * without moving anything around them.
 */
export function fmGraphSvg(graph, {
  label = String, title = null, loopTitle = null, outLabel = "OUT", canvas = null,
} = {}) {
  const loops = graph.cells.some((c) => c.selfFeedback);
  const padTop = loops ? PAD_TOP_LOOP : PAD_TOP_PLAIN;
  const cols = Math.max(graph.cols, canvas?.cols ?? 0);
  const rows = Math.max(graph.rows, canvas?.rows ?? 0);
  const width = PAD_X * 2 + cols * COL_PITCH + OUT_W;
  const height = padTop + PAD_BOTTOM + (rows - 1) * ROW_PITCH + BOX_H;
  // Everything below is placed on the graph's own grid; the view box widens
  // it leftwards and evenly up and down.
  const dx = (cols - graph.cols) * COL_PITCH;
  const dy = ((rows - graph.rows) * ROW_PITCH) / 2;

  const svg = el("svg", {
    class: "fm-graph",
    viewBox: `${-dx} ${-dy} ${width} ${height}`,
    width, height,
    role: "img",
  });

  // Column 0 is the carrier and the deepest modulator has the highest column,
  // so the mirror here is what turns "depth away from the output" into "left to
  // right", and OUTPUT (column −1) lands past the right-hand end.
  const xOf = (col) => PAD_X + (graph.cols - 1 - col) * COL_PITCH;
  const yOf = (row) => padTop + row * ROW_PITCH;
  const cy = (row) => yOf(row) + BOX_H / 2;

  // A junction is a circle inside the same cell a box would fill, so a wire has
  // to stop at the circle rather than at the cell — otherwise every ring
  // modulation and every inversion shows a gap where the arrowhead fell short.
  const kindAt = new Map();
  for (const c of graph.cells) kindAt.set(`${c.col},${c.row}`, c.kind);
  const round = (col, row) => {
    const k = kindAt.get(`${col},${row}`);
    return k === "mul" || k === "neg";
  };
  const leftX = (col, row) =>
    xOf(col) + (round(col, row) ? BOX_W / 2 - JUNCTION_R : 0);
  const rightX = (col, row) =>
    xOf(col) + (round(col, row) ? BOX_W / 2 + JUNCTION_R : BOX_W);

  // ── wires first, so a box always sits on top of the line into it ──
  const wires = el("g", { class: "fm-graph-wires" });
  for (const e of graph.edges) {
    const x1 = rightX(e.from.col, e.from.row);
    const y1 = cy(e.from.row);
    if (e.side === "bottom") {
      // A product's second operand: along its own lane to under the junction,
      // then up into it, so it never merges with the first operand's wire.
      const x2 = xOf(e.to.col) + BOX_W / 2;
      const y2 = cy(e.to.row) + JUNCTION_R;
      wires.append(el("path", { class: "fm-graph-wire", d: `M${x1} ${y1} H${x2} V${y2}` }));
      wires.append(el("path", { class: "fm-graph-arrow", d: `M${x2} ${y2} l-3.5 5 h7 z` }));
      continue;
    }
    const x2 = leftX(e.to.col, e.to.row);
    const y2 = cy(e.to.row);
    // Straight along the lane, or an elbow through the gap between the columns
    // — the same stepped shape a chip manual draws, which keeps two wires into
    // one box visibly separate right up to the box.
    const d = y1 === y2
      ? `M${x1} ${y1} H${x2}`
      : `M${x1} ${y1} H${(x1 + x2) / 2} V${y2} H${x2}`;
    wires.append(el("path", { class: "fm-graph-wire", d }));
    // A horizontal graph has no gravity to say which way it flows, so every
    // wire carries the arrowhead the vertical layout can leave out.
    wires.append(el("path", {
      class: "fm-graph-arrow",
      d: `M${x2} ${y2} l-5 -3.5 v7 z`,
    }));
  }
  svg.append(wires);

  for (const c of graph.cells) {
    const x = xOf(c.col);
    const y = yOf(c.row);
    const g = el("g", { class: "fm-graph-cell" });
    if (c.kind === "op") {
      // Hooks for an editor that drags wires between boxes (the FM Easy tab):
      // the operator a box draws, and whether it is a feedback tap's copy.
      g.setAttribute("data-op", String(c.op));
      if (c.tap) g.setAttribute("data-tap", "");
      g.append(el("rect", {
        class: `fm-graph-box${c.tap ? " tap" : ""}`,
        x, y, width: BOX_W, height: BOX_H, rx: 3,
      }));
      g.append(el("text", {
        class: "fm-graph-num", x: x + BOX_W / 2, y: y + BOX_H / 2,
        "text-anchor": "middle", "dominant-baseline": "central",
      }, label(c.op) + (c.tap ? "′" : "")));
      if (c.selfFeedback) {
        // The curl over the box: an operator reading its own last sample. Drawn
        // as the loop rather than as a second box, because that is the idiom.
        const loop = el("g", { class: `fm-graph-fb${c.feedback === 0 ? " idle" : ""}` });
        loop.append(el("path", {
          class: "fm-graph-wire fm-graph-loop",
          d: `M${x + BOX_W - 5} ${y} C${x + BOX_W + 6} ${y - 13} ${x - 6} ${y - 13} ${x + 5} ${y}`,
        }));
        loop.append(el("path", {
          class: "fm-graph-arrow",
          d: `M${x + 5} ${y} l-3.5 -5 h7 z`,
        }));
        if (loopTitle !== null) loop.append(el("title", {}, loopTitle(c.op, c.feedback)));
        g.append(loop);
      }
      if (title !== null) g.append(el("title", {}, title(c.op)));
    } else {
      // A junction, for the two things meeting wires cannot say on their own.
      g.append(el("circle", {
        class: "fm-graph-junction",
        cx: x + BOX_W / 2, cy: y + BOX_H / 2, r: JUNCTION_R,
      }));
      g.append(el("text", {
        class: "fm-graph-sign", x: x + BOX_W / 2, y: y + BOX_H / 2,
        "text-anchor": "middle", "dominant-baseline": "central",
      }, c.kind === "mul" ? "×" : "−"));
    }
    svg.append(g);
  }

  const ox = xOf(-1);
  const oy = yOf(graph.outRow);
  const out = el("g", { class: "fm-graph-cell", "data-out": "" });
  out.append(el("rect", {
    class: "fm-graph-out", x: ox, y: oy, width: OUT_W, height: BOX_H, rx: 3,
  }));
  out.append(el("text", {
    class: "fm-graph-outlabel", x: ox + OUT_W / 2, y: oy + BOX_H / 2,
    "text-anchor": "middle", "dominant-baseline": "central",
  }, outLabel));
  svg.append(out);
  return svg;
}
