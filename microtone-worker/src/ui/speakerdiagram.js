// Channel-configuration diagrams for the export dialog (#998.4).
//
// The picture on each format button is drawn FROM THE LAYOUT TABLE
// (engine/speakers.js), not from a hand-drawn asset: a speaker sits on the
// diagram wherever the renderer actually places it, so the two cannot drift and
// a new layout gets a correct diagram for free. Same orientation as everything
// else spatial in this app — front is UP, azimuth grows clockwise.
//
// Ambisonic targets have no speakers to draw, so they get a sphere with the
// order written on it: the point of B-format is precisely that the speakers are
// the listener's problem, not the file's.

import { SPEAKER_LAYOUTS, speakerAzimuth } from "../../core/engine/speakers.js";
import { AZIMUTH_TURN } from "../../core/engine/spatial.js";

const SVG_NS = "http://www.w3.org/2000/svg";

const el = (name, attrs) => {
  const n = document.createElementNS(SVG_NS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};

/** Screen offset of an engine azimuth on a dial of radius r (front up). */
function place(az, r) {
  const rad = ((az - 128) * 2 * Math.PI) / AZIMUTH_TURN;
  return [Math.sin(rad) * r, -Math.cos(rad) * r];
}

/** The listener: a head seen from above, facing up the page. */
function listener(g, size) {
  const rr = size * 0.055;
  g.append(
    el("circle", { cx: 0, cy: 0, r: rr, fill: "none", stroke: "currentColor", "stroke-width": 1.2 }),
    // nose, so "front is up" is legible without a caption
    el("path", {
      d: `M ${-rr * 0.45} ${-rr * 0.85} L 0 ${-rr * 1.7} L ${rr * 0.45} ${-rr * 0.85}`,
      fill: "none", stroke: "currentColor", "stroke-width": 1.2,
      "stroke-linejoin": "round",
    }),
  );
}

/**
 * @param formatId one of AUDIO_EXPORT_FORMATS' ids
 * @param opts {size} square side in CSS px
 * @returns SVGSVGElement — inherits colour from its button (currentColor).
 */
export function speakerDiagram(formatId, { size = 96 } = {}) {
  const svg = el("svg", {
    width: size, height: size, viewBox: `${-size / 2} ${-size / 2} ${size} ${size}`,
    class: "chandiagram", role: "img",
  });
  const g = el("g", {});
  svg.appendChild(g);
  const r = size * 0.34;

  if (formatId.startsWith("ambix")) {
    const order = Number(formatId.slice(5));
    // A sphere: horizon plus two meridians, and the order in the middle.
    g.append(
      el("circle", { cx: 0, cy: 0, r, fill: "none", stroke: "currentColor", "stroke-width": 1.2 }),
      el("ellipse", { cx: 0, cy: 0, rx: r, ry: r * 0.38, fill: "none", stroke: "currentColor", "stroke-width": 0.8, opacity: 0.65 }),
      el("ellipse", { cx: 0, cy: 0, rx: r * 0.38, ry: r, fill: "none", stroke: "currentColor", "stroke-width": 0.8, opacity: 0.65 }),
    );
    const label = el("text", {
      x: 0, y: 0, "text-anchor": "middle", "dominant-baseline": "central",
      "font-size": size * 0.24, fill: "currentColor",
    });
    label.textContent = `${order}°`;
    g.appendChild(label);
    return svg;
  }

  const layout = formatId === "stereo"
    ? { speakers: [{ label: "L", deg: -30 }, { label: "R", deg: 30 }] }
    : SPEAKER_LAYOUTS[formatId];
  if (!layout) return svg;

  g.appendChild(el("circle", {
    cx: 0, cy: 0, r, fill: "none", stroke: "currentColor",
    "stroke-width": 0.8, opacity: 0.35, "stroke-dasharray": "3 3",
  }));
  listener(g, size);

  const w = size * 0.15;
  const h = size * 0.1;
  for (const s of layout.speakers) {
    if (s.lfe) {
      // The LFE has no direction — draw it as a box under the listener, in the
      // same place every consumer layout puts it, and mark it silent.
      const box = el("rect", {
        x: -w * 0.5, y: r * 0.42, width: w, height: h * 0.9, rx: 2,
        fill: "none", stroke: "currentColor", "stroke-width": 1, opacity: 0.45,
      });
      const tx = el("text", {
        x: 0, y: r * 0.42 + h * 0.45, "text-anchor": "middle", "dominant-baseline": "central",
        "font-size": size * 0.085, fill: "currentColor", opacity: 0.45,
      });
      tx.textContent = "LFE";
      g.append(box, tx);
      continue;
    }
    const [x, y] = place(speakerAzimuth(s.deg), r);
    const box = el("rect", {
      x: -w / 2, y: -h / 2, width: w, height: h, rx: 1.5,
      fill: "currentColor", opacity: 0.85,
      // Speakers face the listener.
      transform: `translate(${x} ${y}) rotate(${s.deg})`,
    });
    g.appendChild(box);
  }
  return svg;
}
