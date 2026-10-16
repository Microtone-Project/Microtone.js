// The OPL envelope sketch, shared by the OPL tab and the PSG tab (whose
// oscillators take the chip's envelope unchanged, so the same picture is
// the right one for both).

/**
 * A sketch of one OPL operator's envelope (IMS Studio's): attack up, decay to
 * the sustain level, a hold while the key is down if the operator sustains,
 * then release. Times are drawn on the chip's own doubling scale — each rate
 * step halves the time — so the shape reads the way the numbers do.
 */
export function oplEnvelopeSvg(op, index) {
  const W = 150, H = 48;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "opl-env");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.dataset.op = String(index);
  const time = (rate) => (rate === 0 ? 1.2 : Math.min(1, 1.6 / (1 + rate)));
  const level = 1 - op.tl / 63;
  const sus = level * (1 - op.sl / 15);
  const a = time(op.ar) * 40, d = time(op.dr) * 40, hold = op.eg ? 30 : 0, r = time(op.rr) * 40;
  const y = (v) => H - 4 - v * (H - 8);
  const pts = [[2, y(0)], [2 + a, y(level)], [2 + a + d, y(sus)],
    [2 + a + d + hold, y(op.eg ? sus : sus * 0.4)], [Math.min(W - 2, 2 + a + d + hold + r), y(0)]];
  const line = document.createElementNS(NS, "polyline");
  line.setAttribute("points", pts.map((p) => p.join(",")).join(" "));
  line.setAttribute("vector-effect", "non-scaling-stroke");
  svg.appendChild(line);
  return svg;
}
