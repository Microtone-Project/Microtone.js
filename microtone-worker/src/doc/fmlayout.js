// The FM algorithm diagram's layout (item 159.2): an expression tree in, a grid
// of boxes and wires out. doc/fmedit.js reads an FM Rack's program into such a
// tree, doc/oplgraph.js writes each OPL connection as one, and ui/fmgraph.js
// paints the grid — so the OPL tab draws its operators in the FM Rack's hand.
//
// It imports nothing, and nor does oplgraph.js beyond it: IMS Studio carries
// the pair (and the painter) as verbatim copies.

/**
 * Place an expression tree on a grid for the algorithm diagram — the FM
 * chip's own picture, which says in one glance what the formula says in one
 * sentence.
 *
 * Nodes (doc/fmedit.js fmTree's): `{kind:"op", op, mod}` (an operator,
 * optionally read through the subtree that modulates it), `{kind:"tap", op}`
 * (a z-1 feedback tap; it may carry the feedback depth as `level`, which the
 * loop then carries as `feedback`), `{kind:"add"|"mul", a, b}` and
 * `{kind:"neg", a}`.
 *
 * `col` counts modulation depth AWAY from the output, so column 0 is the
 * carrier and the deepest modulator has the highest column; the painter mirrors
 * that into left-to-right, which puts the signal flow the way it is read.
 * `row` is a lane: parallel carriers get one each, a chain stays on one.
 *
 * Every node returns the rows it occupies and the ANCHORS its parent draws a
 * wire from — a list, because a sum has no box of its own and its branches
 * converge directly on whatever consumes them, exactly as several carriers
 * converge on OUTPUT.
 *
 * Returns {cells, edges, cols, rows, outRow} in grid coordinates. An edge into
 * a product's junction from its second operand carries `side: "bottom"`.
 */
export function fmTreeGraph(tree) {
  const cells = [];
  const edges = [];
  const root = placeFmNode(tree, 0, 0, cells, edges);
  let cols = 1;
  for (const c of cells) if (c.col + 1 > cols) cols = c.col + 1;
  // OUT sits level with what feeds it: a product's junction is level with its
  // first operand, not with the middle of everything it reads.
  const outRow = root.anchors.length === 1 ? root.anchors[0].row : (root.height - 1) >> 1;
  for (const a of root.anchors) edges.push({ from: a, to: { col: -1, row: outRow } });
  return { cells, edges, cols, rows: root.height, outRow };
}

/** One node of fmTreeGraph's placement. See its comment for the contract. */
function placeFmNode(node, col, row, cells, edges) {
  if (node.kind === "tap") {
    cells.push({ kind: "op", op: node.op, tap: true, col, row });
    return { height: 1, anchors: [{ col, row }] };
  }
  if (node.kind === "op") {
    // An operator read through its OWN previous output is the self-feedback
    // loop every FM chip draws as a curl on the box, so it is one box here too
    // rather than a box wired to a copy of itself.
    if (node.mod !== null && node.mod.kind === "tap" && node.mod.op === node.op) {
      const cell = { kind: "op", op: node.op, selfFeedback: true, col, row };
      if (node.mod.level !== undefined) cell.feedback = node.mod.level;
      cells.push(cell);
      return { height: 1, anchors: [{ col, row }] };
    }
    if (node.mod === null) {
      cells.push({ kind: "op", op: node.op, col, row });
      return { height: 1, anchors: [{ col, row }] };
    }
    const m = placeFmNode(node.mod, col + 1, row, cells, edges);
    const r = row + ((m.height - 1) >> 1);
    cells.push({ kind: "op", op: node.op, col, row: r });
    for (const a of m.anchors) edges.push({ from: a, to: { col, row: r } });
    return { height: m.height, anchors: [{ col, row: r }] };
  }
  if (node.kind === "add") {
    // No box: a sum is what the wires already do where they meet.
    const a = placeFmNode(node.a, col, row, cells, edges);
    const b = placeFmNode(node.b, col, row + a.height, cells, edges);
    return { height: a.height + b.height, anchors: [...a.anchors, ...b.anchors] };
  }
  // mul / neg — these DO need a mark, because meeting wires would read as a sum.
  // A product's two operands must not meet the way a sum's branches do, or
  // `(a + b) × c` reads as a three-way sum: the first operand comes in from
  // the LEFT, as everything else does, and the second is placed under it and
  // comes in from BELOW (`side: "bottom"`), so wires meeting from the left
  // always mean addition.
  const a = placeFmNode(node.a, col + 1, row, cells, edges);
  const r = row + ((a.height - 1) >> 1);
  cells.push({ kind: node.kind, col, row: r });
  for (const an of a.anchors) edges.push({ from: an, to: { col, row: r } });
  let h = a.height;
  if (node.kind === "mul") {
    const b = placeFmNode(node.b, col + 1, row + a.height, cells, edges);
    for (const an of b.anchors) edges.push({ from: an, to: { col, row: r }, side: "bottom" });
    h += b.height;
  }
  return { height: h, anchors: [{ col, row: r }] };
}
