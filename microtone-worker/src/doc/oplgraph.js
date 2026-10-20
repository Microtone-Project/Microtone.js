// The OPL chip's operator connections as diagrams (item 222): each one written
// as the expression tree doc/fmlayout.js places, so the OPL tab draws its
// operators exactly as the FM Rack draws its own, and ui/fmgraph.js paints both.
//
// Imports nothing but the layout, so IMS Studio carries it verbatim too.

import { fmTreeGraph } from "./fmlayout.js";

/**
 * The connection of `ops` operators (1, 2 or 4; indexes 0…ops−1) as a diagram
 * grid (fmTreeGraph). Two operators: the first modulates the second (CNT 0),
 * or both are heard (CNT 1). Four: the YMF262 data sheet's four figures
 * (catalogue 4MF262A6, p. 13), by CNT A and CNT B —
 *
 *   0,0   1 → 2 → 3 → 4          0,1   1 → 2, and 3 → 4
 *   1,0   1, and 2 → 3 → 4       1,1   1, and 2 → 3, and 4
 *
 * The first operator carries the feedback curl, at depth `feedback`, whenever
 * there is more than one: it is the only operator the chip feeds back. A lone
 * operator — a rhythm drum's — has none.
 */
export function oplGraph(ops, cntA = 0, cntB = 0, feedback = 0) {
  const op = (k, mod = null) => ({ kind: "op", op: k, mod });
  const add = (a, b) => ({ kind: "add", a, b });
  if (ops < 2) return fmTreeGraph(op(0));
  const first = op(0, { kind: "tap", op: 0, level: feedback });
  if (ops === 2) return fmTreeGraph(cntA ? add(first, op(1)) : op(1, first));
  if (!cntA) {
    return fmTreeGraph(cntB
      ? add(op(1, first), op(3, op(2)))
      : op(3, op(2, op(1, first))));
  }
  return fmTreeGraph(cntB
    ? add(add(first, op(2, op(1))), op(3))
    : add(first, op(3, op(2, op(1)))));
}

/** The canvas every connection of `ops` operators fits ({cols, rows}, for
 *  ui/fmgraph.js fmGraphSvg's `canvas`), so stepping through the connections
 *  redraws the picture without resizing it. */
export function oplGraphCanvas(ops) {
  let cols = 1, rows = 1;
  for (const c of [0, 1, 2, 3]) {
    const g = oplGraph(ops, c >> 1, c & 1);
    cols = Math.max(cols, g.cols);
    rows = Math.max(rows, g.rows);
  }
  return { cols, rows };
}

/** The operators whose wires reach OUT in a graph — the ones the listener hears. */
export function graphOutputs(graph) {
  const at = new Map(graph.cells.map((c) => [`${c.col},${c.row}`, c]));
  return graph.edges
    .filter((e) => e.to.col === -1)
    .map((e) => at.get(`${e.from.col},${e.from.row}`).op)
    .sort((a, b) => a - b);
}
