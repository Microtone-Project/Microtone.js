"""Open apertures: C, G and c with their terminals cut further round the bowl.

Chivo ends the arms of C, G and c in horizontal cuts placed about where the
bowl turns vertical, so the apertures are nearly shut — at Black a c is not
far from an o, and a G's arm nearly meets its bar. Here each cut moves
`units` further from the middle (up for a terminal at the top, down for one
at the bottom) and stays horizontal, the way Chivo cuts them. The two curves
leading into a cut, outer and inner, each from the bowl's top or bottom
extreme, are drawn again as the same curves, only shorter: every spline of
an arm is refitted to its share of the shortened curve with the points it
had, so the masters stay compatible and the weights interpolate as before.

A cut is found, not named: two on-curve points level with each other, each
followed by a curve, both curves leaving on the same side — the underside of
a terminal at the top, or the upper side of one at the bottom. G's bar and
spur meet straight lines, so only its arm qualifies.
"""

import math

from .geometry import add, line_x_line, mul, sub, unit

TOLERANCE = 1.0  # units: how far a refitted arm may stray from Chivo's curve
SAMPLES = 64     # per quadratic segment, for arc length and the error check
FIT_ROUNDS = 6   # least-squares solves, each after moving the parameters
ALONG = 0.1      # how much the fit minds distance along the curve, against distance across it
FIT_EVERY = 4    # fit to every FIT_EVERY-th sample of the curve


def open_aperture(vg, units):
    """`vg` with every terminal cut moved `units` away from the middle."""
    base = vg.masters[0.0]
    cuts = [(ci, i, d) for ci, c in enumerate(base) for i in range(len(c)) if (d := _cut_at(c, i))]
    if not cuts:
        raise ValueError(f"{vg.name}: no terminal to open")

    def master(t, outline):
        out = [list(c) for c in outline]
        for ci, i, d in cuts:
            c = out[ci]
            if _cut_at(c, i) != d:
                raise ValueError(f"{vg.name}: master {t} is cut differently from the default")
            y = c[i][1] + d * units
            for arm in (_arm(base[ci], i, -1), _arm(base[ci], (i + 1) % len(c), 1)):
                new = _shorten([c[k] for k in arm], y, f"{vg.name} at weight {t}")
                for k, p in zip(arm, new):
                    c[k] = p
        return out
    return vg.map(master)


def _cut_at(c, i):
    """+1 when c[i]→c[i+1] is the underside of a terminal at the top, -1 when
    it is the upper side of one at the bottom, 0 when it is no cut."""
    n = len(c)
    a, b = c[i], c[(i + 1) % n]
    before, after = c[i - 1], c[(i + 2) % n]
    if not (a[2] and b[2]) or before[2] or after[2] or abs(a[1] - b[1]) > 0.5:
        return 0
    if before[1] > a[1] and after[1] > b[1]:
        return 1
    if before[1] < a[1] and after[1] < b[1]:
        return -1
    return 0


def _arm(c, i, step):
    """The indices of the arm ending at the cut point c[i], walking away from
    the cut by `step` to the first on-curve point with a level tangent (the
    bowl's top or bottom), listed from there to the cut."""
    n = len(c)
    idx = [i]
    k = i
    for _ in range(n):
        k = (k + step) % n
        idx.append(k)
        if c[k][2] and abs(c[k - 1][1] - c[k][1]) < 0.5 and abs(c[(k + 1) % n][1] - c[k][1]) < 0.5:
            return idx[::-1]
    raise ValueError("an arm with no extreme")


class _Path:
    """A TrueType path, on-curve at both ends, as quadratic segments with an
    arc-length table."""

    def __init__(self, pts):
        self.segs, self.splines = [], []  # splines: (offs in it, its first segment)
        start, offs = pts[0][:2], []
        for x, y, on in pts[1:]:
            if not on:
                offs.append((x, y))
                continue
            self.splines.append((len(offs), len(self.segs)))
            if not offs:
                offs = [mul(add(start, (x, y)), 0.5)]
            for j, q in enumerate(offs):
                end = mul(add(q, offs[j + 1]), 0.5) if j + 1 < len(offs) else (x, y)
                self.segs.append((start, q, end))
                start = end
            offs = []
        self.table = []  # (arc length, segment, u)
        s, prev = 0.0, self.segs[0][0]
        for k, seg in enumerate(self.segs):
            for j in range(SAMPLES + (k == len(self.segs) - 1)):
                u = j / SAMPLES
                p = _quad(seg, u)
                s += math.dist(prev, p)
                prev = p
                self.table.append((s, k, u))
        self.length = s

    def _locate(self, s):
        lo, hi = 0, len(self.table) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            lo, hi = (mid, hi) if self.table[mid][0] <= s else (lo, mid)
        (sa, ka, ua), (sb, kb, ub) = self.table[lo], self.table[hi]
        if kb != ka:
            kb, ub = ka, 1.0
        f = (s - sa) / (sb - sa) if sb > sa else 0.0
        return ka, ua + (ub - ua) * f

    def point(self, s):
        k, u = self._locate(s)
        return _quad(self.segs[k], u)

    def tangent(self, s):
        k, u = self._locate(s)
        p0, q, p2 = self.segs[k]
        return unit(add(mul(sub(q, p0), 1 - u), mul(sub(p2, q), u)))

    def knot(self, j):
        """The arc length at the start of spline j (the path's length at j = len)."""
        if j == len(self.splines):
            return self.length
        first = self.splines[j][1]
        return next(s for s, k, u in self.table if k == first)

    def polyline(self, s0, s1):
        """The curve from s0 to s1 as (arc length, point) pairs."""
        out = [(s0, self.point(s0))]
        out += [(s, _quad(self.segs[k], u)) for s, k, u in self.table if s0 < s < s1]
        out.append((s1, self.point(s1)))
        return out

    def tau(self, j, s):
        """Where arc length s falls along spline j: its segment, counted from
        the spline's first, plus the parameter within it."""
        k, u = self._locate(s)
        m, first = self.splines[j]
        return min(max(k - first + u, 0.0), max(m, 1))


def _shorten(pts, y, label):
    """The arm `pts` (from the bowl's extreme to the cut) ending where it
    crosses the level y instead, with the same points: each spline refitted
    to its proportional share of the shorter curve."""
    path = _Path(pts)
    lo, hi = 0.0, path.length
    rising = path.point(hi)[1] > path.point(lo)[1]
    if not (min(pts[0][1], pts[-1][1]) < y < max(pts[0][1], pts[-1][1])):
        raise ValueError(f"{label}: cannot cut its arm at y = {y}, past the bowl's extreme")
    for _ in range(60):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if (path.point(mid)[1] < y) == rising else (lo, mid)
    end = (lo + hi) / 2
    k = end / path.length
    out = [pts[0]]
    for j, (m, _) in enumerate(path.splines):
        s0, s1 = path.knot(j) * k, path.knot(j + 1) * k
        p0, p3 = path.point(s0), path.point(s1)
        if j == len(path.splines) - 1:
            p3 = (p3[0], y)
        if m == 0:
            out.append((*p3, True))
            continue
        # Each point of the shorter curve starts at the parameter its
        # proportional place had on Chivo's spline (exactly Chivo's, uncut).
        along = path.polyline(s0, s1)
        target = [p for _, p in along]
        sparse = along[:-1:FIT_EVERY] + along[-1:]
        taus = [path.tau(j, path.knot(j) + (s - s0) / k) for s, _ in sparse]
        qs = _fit_spline(p0, path.tangent(s0), p3, path.tangent(s1), m, [p for _, p in sparse], taus)
        err = _deviation(p0, qs, p3, target)
        if err > TOLERANCE:
            raise ValueError(f"{label}: a refitted arm strays {err:.2f} units from the curve")
        out += [(*q, False) for q in qs] + [(*p3, True)]
    return out


def _quad(seg, u):
    p0, q, p2 = seg
    a, b, c = (1 - u) ** 2, 2 * u * (1 - u), u * u
    return (a * p0[0] + b * q[0] + c * p2[0], a * p0[1] + b * q[1] + c * p2[1])


def _fit_spline(p0, t0, p3, t1, m, target, taus):
    """The m off-curve points of a TrueType spline (implied on-curve points
    between them) from p0 to p3 that come closest to the polyline `target`,
    leaving p0 along t0 and arriving at p3 along t1. Given where along the
    spline each target point falls (`taus`, 0…m, to begin with), the spline
    is linear in its off-curve points. Each round solves for them by least
    squares on the distance across the current spline (with a little of the
    distance along it, to keep the solve steady), then moves each target
    point's parameter to the nearest point of the new spline — which
    converges in a few rounds where plain point distances take dozens."""
    if m == 1:
        return [line_x_line(p0, t0, p3, t1) or mul(add(p0, p3), 0.5)]
    qs = None
    for _ in range(FIT_ROUNDS):
        rows, rhs = [], []
        for tau, r in zip(taus, target):
            w, c0, c3 = _weights(tau, m)
            const = add(mul(p0, c0 + w[0]), mul(p3, c3 + w[-1]))
            # x and y rows of P(tau) = const + A·z
            ax = [w[0] * t0[0], -w[-1] * t1[0]]
            ay = [w[0] * t0[1], -w[-1] * t1[1]]
            for k in range(1, m - 1):
                ax += [w[k], 0.0]
                ay += [0.0, w[k]]
            d = sub(r, const)
            if qs:
                tan = _tangent(p0, qs, p3, tau)
                axes = (((-tan[1], tan[0]), 1.0), (tan, ALONG))
            else:  # the first solve has no spline yet: plain distances
                axes = (((1.0, 0.0), 1.0), ((0.0, 1.0), 1.0))
            for v, weight in axes:
                rows.append([weight * (v[0] * x + v[1] * y) for x, y in zip(ax, ay)])
                rhs.append(weight * (v[0] * d[0] + v[1] * d[1]))
        z = _least_squares(rows, rhs)
        qs = [add(p0, mul(t0, z[0]))] + [(z[2 + 2 * k], z[3 + 2 * k]) for k in range(m - 2)] + \
             [sub(p3, mul(t1, z[1]))]
        taus = [taus[0]] + [_project(p0, qs, p3, tau, r) for tau, r in zip(taus[1:-1], target[1:-1])] + [taus[-1]]
    return qs


def _tangent(p0, qs, p3, tau):
    (s, q, e), u = _segment(p0, qs, p3, tau)
    return unit(add(mul(sub(q, s), 1 - u), mul(sub(e, q), u)))


def _weights(tau, m):
    """At spline parameter tau (0…m), each off-curve point's weight in the
    point there, and the end points' own."""
    j = min(int(tau), m - 1)
    u = tau - j
    a, b, c = (1 - u) ** 2, 2 * u * (1 - u), u * u
    w = [0.0] * m
    c0 = c3 = 0.0
    if j == 0:
        c0 += a
    else:
        w[j - 1] += a / 2
        w[j] += a / 2
    w[j] += b
    if j == m - 1:
        c3 += c
    else:
        w[j] += c / 2
        w[j + 1] += c / 2
    return w, c0, c3


def _segment(p0, qs, p3, tau):
    m = len(qs)
    j = min(int(tau), m - 1)
    start = p0 if j == 0 else mul(add(qs[j - 1], qs[j]), 0.5)
    end = p3 if j == m - 1 else mul(add(qs[j], qs[j + 1]), 0.5)
    return (start, qs[j], end), tau - j


def _project(p0, qs, p3, tau, r):
    """Newton steps towards the parameter of the spline's point nearest r."""
    for _ in range(4):
        (s, q, e), u = _segment(p0, qs, p3, tau)
        p = _quad((s, q, e), u)
        d1 = mul(add(mul(sub(q, s), 1 - u), mul(sub(e, q), u)), 2)
        d2 = mul(add(sub(s, mul(q, 2)), e), 2)
        err = sub(p, r)
        den = d1[0] ** 2 + d1[1] ** 2 + err[0] * d2[0] + err[1] * d2[1]
        if abs(den) < 1e-12:
            break
        tau = min(len(qs), max(0.0, tau - (err[0] * d1[0] + err[1] * d1[1]) / den))
    return tau


def _least_squares(rows, rhs):
    """x minimising |rows·x − rhs|, by the normal equations."""
    n = len(rows[0])
    a = [[sum(r[i] * r[j] for r in rows) for j in range(n)] + [sum(r[i] * v for r, v in zip(rows, rhs))]
         for i in range(n)]
    for i in range(n):
        p = max(range(i, n), key=lambda k: abs(a[k][i]))
        a[i], a[p] = a[p], a[i]
        for k in range(i + 1, n):
            f = a[k][i] / a[i][i]
            a[k] = [x - f * y for x, y in zip(a[k], a[i])]
    x = [0.0] * n
    for i in reversed(range(n)):
        x[i] = (a[i][n] - sum(a[i][j] * x[j] for j in range(i + 1, n))) / a[i][i]
    return x


def _deviation(p0, qs, p3, target):
    """How far the spline p0, qs…, p3 strays from the polyline `target`."""
    pts = [(*p0, True)] + [(*q, False) for q in qs] + [(*p3, True)]
    spline = _Path(pts)
    worst = 0.0
    for s, k, u in spline.table[::4]:
        p = _quad(spline.segs[k], u)
        worst = max(worst, min(_to_segment(p, a, b) for a, b in zip(target, target[1:])))
    return worst


def _to_segment(p, a, b):
    d = sub(b, a)
    L = d[0] * d[0] + d[1] * d[1]
    t = 0.0 if L == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / L))
    return math.dist(p, (a[0] + d[0] * t, a[1] + d[1] * t))
