"""Plane geometry shared by the stroker, the superelliptic O and the measurer."""

import math


def unit(v):
    d = math.hypot(v[0], v[1])
    return (v[0] / d, v[1] / d) if d else (0.0, 0.0)


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1])


def add(a, b):
    return (a[0] + b[0], a[1] + b[1])


def mul(a, k):
    return (a[0] * k, a[1] * k)


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1]


def cross(a, b):
    return a[0] * b[1] - a[1] * b[0]


def line_x_line(p, d, q, e):
    """Intersection of the lines p + s·d and q + u·e, or None when parallel."""
    den = cross(d, e)
    if abs(den) < 1e-9:
        return None
    s = cross(sub(q, p), e) / den
    return (p[0] + d[0] * s, p[1] + d[1] * s)


def seg_x_seg(a, b, c, d):
    """Intersection of segments ab and cd (interiors), or None."""
    r, s = sub(b, a), sub(d, c)
    den = cross(r, s)
    if abs(den) < 1e-12:
        return None
    t = cross(sub(c, a), s) / den
    u = cross(sub(c, a), r) / den
    if 1e-9 < t < 1 - 1e-9 and 1e-9 < u < 1 - 1e-9:
        return (a[0] + r[0] * t, a[1] + r[1] * t)
    return None


def signed_area(points):
    s = 0.0
    for i in range(len(points)):
        x0, y0 = points[i][0], points[i][1]
        x1, y1 = points[(i + 1) % len(points)][0], points[(i + 1) % len(points)][1]
        s += x0 * y1 - x1 * y0
    return s / 2


def flatten(contour, steps=16):
    """A TrueType contour (x, y, on) as a polygon."""
    pts = contour
    n = len(pts)
    if n == 0:
        return []
    # Start from an on-curve point (or an implied one).
    start = next((i for i, p in enumerate(pts) if p[2]), None)
    if start is None:
        a, b = pts[0], pts[1]
        seq = [((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, True)] + pts[1:] + pts[:1]
    else:
        seq = pts[start:] + pts[:start]
    out = [(seq[0][0], seq[0][1])]
    cur = (seq[0][0], seq[0][1])
    ctrl = None
    for p in seq[1:] + [seq[0]]:
        if p[2]:
            if ctrl is None:
                out.append((p[0], p[1]))
            else:
                out.extend(_quad(cur, ctrl, (p[0], p[1]), steps))
                ctrl = None
            cur = (p[0], p[1])
        else:
            if ctrl is not None:
                mid = ((ctrl[0] + p[0]) / 2, (ctrl[1] + p[1]) / 2)
                out.extend(_quad(cur, ctrl, mid, steps))
                cur = mid
            ctrl = (p[0], p[1])
    return out[:-1] if len(out) > 1 and out[-1] == out[0] else out


def _quad(p0, p1, p2, steps):
    res = []
    for i in range(1, steps + 1):
        t = i / steps
        mt = 1 - t
        res.append((mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0],
                    mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1]))
    return res


def hits(outline, y=None, x=None):
    """Where a horizontal (y=…) or vertical (x=…) line crosses an outline."""
    out = []
    for contour in outline:
        poly = flatten(contour)
        for i in range(len(poly)):
            a, b = poly[i], poly[(i + 1) % len(poly)]
            if y is not None and (a[1] - y) * (b[1] - y) < 0:
                out.append(a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]))
            if x is not None and (a[0] - x) * (b[0] - x) < 0:
                out.append(a[1] + (x - a[0]) / (b[0] - a[0]) * (b[1] - a[1]))
    return sorted(out)


def superellipse(x0, y0, x1, y1, n, clockwise=True, per_quadrant=4):
    """A closed TrueType contour approximating |x/a|^n + |y/b|^n = 1 inside the
    box (x0, y0)–(x1, y1). On-curve points sit where the normal turns by equal
    steps, each joined to the next by the quadratic whose control point is the
    meeting of their tangents. Starts at the bottom centre, like Chivo's own
    round letters. The point count depends only on per_quadrant, never on the
    box, so outlines made this way at different weights interpolate."""
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    a, b = (x1 - x0) / 2, (y1 - y0) / 2
    k = 4 * per_quadrant
    step = 360.0 / k
    # normal angle: 270° is the bottom; clockwise travel lowers it.
    angles = [270.0 - i * step if clockwise else 270.0 + i * step for i in range(k)]
    return _se_run(cx, cy, a, b, n, angles, closed=True)


def superellipse_arc(cx, cy, a, b, n, start, end, per_quadrant=4):
    """The part of the superellipse centred on (cx, cy), semi-axes a and b,
    whose normal turns from `start` to `end` degrees (0° points right, 90°
    up; either way round): an open TrueType run, on-curve at both ends, built
    as superellipse() builds the whole. The point count depends only on the
    angle swept and per_quadrant."""
    k = max(1, round(abs(end - start) / 90.0 * per_quadrant))
    angles = [start + (end - start) * i / k for i in range(k + 1)]
    return _se_run(cx, cy, a, b, n, angles, closed=False)


def _se_run(cx, cy, a, b, n, angles, closed):
    pts = [_se_point(cx, cy, a, b, n, phi) for phi in angles]
    tans = [(-math.sin(math.radians(phi)), math.cos(math.radians(phi))) for phi in angles]
    k = len(angles)
    run = []
    for i in range(k if closed else k - 1):
        p, q = pts[i], pts[(i + 1) % k]
        run.append((p[0], p[1], True))
        c = line_x_line(p, tans[i], q, tans[(i + 1) % k])
        if c is None:
            c = ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
        run.append((c[0], c[1], False))
    if not closed:
        run.append((pts[-1][0], pts[-1][1], True))
    return run


def _se_point(cx, cy, a, b, n, phi):
    phi %= 360.0
    rad = math.radians(phi)
    c, s = math.cos(rad), math.sin(rad)
    if abs(c) < 1e-12:
        return (cx, cy + math.copysign(b, s))
    if abs(s) < 1e-12:
        return (cx + math.copysign(a, c), cy)
    r = ((b / a) * abs(s / c)) ** (1.0 / (n - 1))
    u = (1 + r ** n) ** (-1.0 / n)
    v = r * u
    return (cx + math.copysign(a * u, c), cy + math.copysign(b * v, s))
