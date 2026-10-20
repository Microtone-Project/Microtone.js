"""An elliptical-nib stroker for Motif's drawn symbols.

Chivo is a low-contrast grotesque: its vertical stems are a little heavier
than its horizontal bars (H at Medium: stem 119 units, bar 100). A symbol
drawn with a round nib would read as foreign next to it. So every symbol is
the path of an ELLIPTICAL nib whose horizontal semi-axis is half a stem and
whose vertical semi-axis is half a bar: a vertical stroke comes out exactly a
stem thick, a horizontal one exactly a bar, and every slant in between gets
what the letters' own diagonals get.

A stroke is a list of nodes (x, y[, kind]) along its centre line:

  'corner'  a mitred corner (the default)
  'flat'    a corner whose outer point is cut off square across the bisector,
            the way Chivo cuts the apex of ^ < > v V
  'smooth'  a sample of a curve; its offsets become TrueType OFF-curve points,
            so a densely sampled curve renders as a smooth quadratic spline

and two caps:

  'butt'    square across the stroke
  'hcut'    cut along the horizontal through the end point (feet on a line)
  'vcut'    cut along the vertical through the end point (a waveform's edge
            at the cell boundary, so the next glyph continues it seamlessly)

The number of points a stroke produces depends only on its nodes, never on the
nib, so the same design stroked with each master's nib yields point-compatible
outlines — which is what makes the symbols variable.
"""

import math

from .geometry import unit, sub, add, mul, dot, cross, line_x_line, seg_x_seg, signed_area


class Nib:
    def __init__(self, a, b):
        self.a = a  # horizontal semi-axis: half a vertical stem
        self.b = b  # vertical semi-axis: half a horizontal bar

    def scaled(self, ka, kb=None):
        return Nib(self.a * ka, self.b * (ka if kb is None else kb))

    def off(self, d):
        """Offset from the centre line to the stroke's LEFT edge, travelling d."""
        nx, ny = -d[1], d[0]
        h = math.hypot(self.a * nx, self.b * ny)
        return (self.a * self.a * nx / h, self.b * self.b * ny / h)

    def reach(self, u):
        """How far the nib extends in the unit direction u."""
        return math.hypot(self.a * u[0], self.b * u[1])


def _kind(node):
    return node[2] if len(node) > 2 else "corner"


def _cap(p, d, how, nib):
    """(left, right) edge points at an end travelling d."""
    o = nib.off(d)
    lp, rp = add(p, o), sub(p, o)
    if how == "hcut" and abs(d[1]) > 1e-9:
        lp = line_x_line(lp, d, p, (1.0, 0.0)) or lp
        rp = line_x_line(rp, d, p, (1.0, 0.0)) or rp
    elif how == "vcut" and abs(d[0]) > 1e-9:
        lp = line_x_line(lp, d, p, (0.0, 1.0)) or lp
        rp = line_x_line(rp, d, p, (0.0, 1.0)) or rp
    return [(lp[0], lp[1], True)], [(rp[0], rp[1], True)]


def _join(p, din, dout, kind, nib, flat_cut):
    """(left points, right points) at an interior corner."""
    z = cross(din, dout)
    sides = []
    for sgn in (1.0, -1.0):
        oi, oo = mul(nib.off(din), sgn), mul(nib.off(dout), sgn)
        if abs(z) < 1e-6:
            sides.append([(p[0] + oi[0], p[1] + oi[1], True)])
            continue
        m = line_x_line(add(p, oi), din, add(p, oo), dout)
        outer = (z > 0 and sgn < 0) or (z < 0 and sgn > 0)
        if kind == "flat" and outer:
            u = unit(sub(din, dout))  # outward along the bisector
            h = nib.reach(u) * flat_cut
            pts = []
            for o, d in ((oi, din), (oo, dout)):
                a = add(p, o)
                den = dot(d, u)
                if abs(den) < 1e-9 or dot(sub(m, p), u) <= h:
                    pts.append(m)
                else:
                    s = (h - dot(sub(a, p), u)) / den
                    pts.append((a[0] + d[0] * s, a[1] + d[1] * s))
            sides.append([(q[0], q[1], True) for q in pts])
        else:
            sides.append([(m[0], m[1], True)])
    return sides[0], sides[1]


def _untangle(side, window=14):
    """Collapse the swallowtails a curve's inner offset grows where the curve
    bends tighter than the nib is wide. Points are moved, never removed, so
    the outline stays compatible with the other masters'."""
    side = list(side)
    n = len(side)
    i = 0
    while i < n - 1:
        hit = None
        for j in range(min(n - 2, i + window), i + 1, -1):
            x = seg_x_seg(side[i][:2], side[i + 1][:2], side[j][:2], side[j + 1][:2])
            if x is not None:
                hit = (j, x)
                break
        if hit:
            j, x = hit
            for k in range(i + 1, j + 1):
                side[k] = (x[0], x[1], side[k][2])
            i = j
        i += 1
    return side


def stroke(nodes, nib, start="butt", end="butt", flat_cut=1.0, closed=False):
    """Outline (a list of contours) of a stroke along `nodes`."""
    pts = [(float(n[0]), float(n[1])) for n in nodes]
    kinds = [_kind(n) for n in nodes]
    count = len(pts)
    left, right = [], []
    for i in range(count):
        p = pts[i]
        if closed:
            prev, nxt = pts[i - 1], pts[(i + 1) % count]
        else:
            prev = pts[i - 1] if i > 0 else None
            nxt = pts[i + 1] if i < count - 1 else None
        if prev is None:
            lp, rp = _cap(p, unit(sub(nxt, p)), start, nib)
        elif nxt is None:
            lp, rp = _cap(p, unit(sub(p, prev)), end, nib)
        elif kinds[i] == "smooth":
            t = unit(sub(nxt, prev))
            o = nib.off(t)
            lp, rp = [(p[0] + o[0], p[1] + o[1], False)], [(p[0] - o[0], p[1] - o[1], False)]
        else:
            lp, rp = _join(p, unit(sub(p, prev)), unit(sub(nxt, p)), kinds[i], nib, flat_cut)
        left.extend(lp)
        right.extend(rp)
    left, right = _untangle(left), _untangle(right[::-1])[::-1]
    if closed:
        return [orient(left, True), orient(right, False)]
    return [left + right[::-1]]


def orient(contour, clockwise):
    """TrueType wants outer contours clockwise, counters anticlockwise."""
    cw = signed_area(contour) < 0
    if cw == clockwise:
        return contour
    return [contour[0]] + contour[1:][::-1]


def polygon(points, clockwise=True):
    return orient([(float(x), float(y), True) for x, y in points], clockwise)


def sample(fn, t0, t1, steps):
    """Nodes along a parametric curve fn(t) → (x, y): the ends are corners,
    every sample between them is smooth."""
    nodes = []
    for i in range(steps + 1):
        t = t0 + (t1 - t0) * i / steps
        x, y = fn(t)
        nodes.append((x, y, "corner" if i in (0, steps) else "smooth"))
    return nodes


def cubic(p0, p1, p2, p3, steps=16):
    def fn(t):
        mt = 1 - t
        return (mt ** 3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t ** 3 * p3[0],
                mt ** 3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t ** 3 * p3[1])
    return sample(fn, 0.0, 1.0, steps)
