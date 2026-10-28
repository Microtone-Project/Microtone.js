"""Wider and narrower Chivo, and the HP-terminal capital O.

A plain horizontal stretch would thicken every vertical stem by the same
percentage and leave the horizontals alone, so a widened grid letter would
read bolder than a narrowed transport one. Instead each master takes its
x coordinates from the weight whose stems, once scaled, come out as thick as
this master's own stems — a lighter weight when widening, a heavier one when
narrowing — and its y coordinates from the master itself. Chivo's masters
are point-compatible, so mixing two weights' coordinates is legitimate, and
the result interpolates like any other master. [stems] compensate in
motif.toml dials this between none (0) and full (1).
"""

from .geometry import hits, superellipse, superellipse_arc
from .varglyph import VarGlyph, MASTERS, bounds


class Stems:
    """Chivo's vertical stem and horizontal bar at each master, measured off
    the H (and the period, for the Kite dot)."""

    def __init__(self, font, glyphsets, extrapolate=0.1):
        from .varglyph import outline_from_glyphset
        self.extrapolate = extrapolate
        self._v, self._h, self._dot = {}, {}, {}
        for t in MASTERS:
            h = outline_from_glyphset(glyphsets[t], "H")
            xs = hits(h, y=200)
            self._v[t] = ((xs[1] - xs[0]) + (xs[3] - xs[2])) / 2
            b = bounds(h)
            ys = hits(h, x=(b[0] + b[2]) / 2 + 0.5)
            self._h[t] = ys[1] - ys[0]
            p = bounds(outline_from_glyphset(glyphsets[t], "period"))
            self._dot[t] = p[2] - p[0]

    @staticmethod
    def _lerp(table, t):
        lo, hi = (-1.0, 0.0) if t < 0 else (0.0, 1.0)
        return table[lo] + (table[hi] - table[lo]) * (t - lo) / (hi - lo)

    def v(self, t): return self._lerp(self._v, t)
    def h(self, t): return self._lerp(self._h, t)
    def dot(self, t): return self._lerp(self._dot, t)

    def weight_for_stem(self, stem):
        """The normalised weight whose vertical stem is `stem` (clamped to the
        masters, give or take `extrapolate`)."""
        v = self._v
        if stem <= v[0.0]:
            t = -(v[0.0] - stem) / (v[0.0] - v[-1.0])
        else:
            t = (stem - v[0.0]) / (v[1.0] - v[0.0])
        lim = 1.0 + self.extrapolate
        return max(-lim, min(lim, t))


def rescale(vg, s_of_t, advance, stems, compensate, slant=0.0, y0=0.0, tx_of_t=None, keep=()):
    """`vg` scaled horizontally by s_of_t(t) at each master about its cell's
    centre, into a cell `advance` wide, stems compensated. For an italic the
    scaling happens with the slant taken out, so it neither steepens nor
    flattens the italic angle. `tx_of_t` overrides which weight each master
    takes its x coordinates from. Contours whose indices are in `keep` (an
    i's dot) keep the master's own shape and size and only move with the
    letter."""
    c_in, c_out = vg.advance / 2, advance / 2
    masters = {}
    for t in MASTERS:
        s = s_of_t(t)
        if tx_of_t:
            tx = tx_of_t(t)
        else:
            tx = stems.weight_for_stem(stems.v(t) / (s ** compensate)) if compensate else t
        src_x, src_y = vg.at(tx), vg.masters[t]
        out = []
        for i, (cx, cy) in enumerate(zip(src_x, src_y)):
            if i in keep:
                us = [x - slant * (y - y0) for x, y, _ in cy]
                mid = (min(us) + max(us)) / 2
                ux = [x - slant * (y - y0) for x, y, _ in cx]
                to = c_out + s * ((min(ux) + max(ux)) / 2 - c_in)
                out.append([(to + u - mid + slant * (y - y0), y, on) for u, (_, y, on) in zip(us, cy)])
                continue
            cont = []
            for (xa, ya, on), (_, yb, _) in zip(cx, cy):
                u = xa - slant * (ya - y0)
                cont.append((c_out + s * (u - c_in) + slant * (yb - y0), yb, on))
            out.append(cont)
        masters[t] = out
    return VarGlyph(vg.name, advance, masters, vg.unicode)


def stroke_width(outline, y):
    """The width of the leftmost stroke a horizontal line at y crosses — the
    outermost one, which never merges with a neighbour as the weight grows
    (W's inner diagonals do), so it thickens steadily with weight."""
    xs = hits(outline, y=y)
    return xs[1] - xs[0] if len(xs) >= 2 else None


LIGHTER = 0.5  # how far below Thin a widened letter may look for thinner stems


def _search_range(s, reach):
    """Widening wants lighter stems, narrowing heavier: search that way only."""
    return (-1.0 - LIGHTER, 1.0 + min(reach, 0.25)) if s > 1 else (-1.0, 1.0 + reach)


def _steady_line(glyph, height, lo, hi):
    """A height to measure `glyph`'s leftmost stroke at where it thickens
    steadily over every weight the search may visit, crossing the same
    rate throughout — low down, W's two diagonals merge into one at heavy
    weights, and the measure would jump."""
    ts = [lo + i * (hi - lo) / 16 for i in range(17)]
    for k in (0.3, 0.5, 0.7, 0.85, 0.4, 0.6, 0.2):
        y = height * k
        ws = [stroke_width(glyph.at(t), y) for t in ts]
        if any(w is None for w in ws):
            continue
        steps = sorted(b - a for a, b in zip(ws, ws[1:]))
        if steps[0] > 0 and steps[-1] < 2.5 * steps[len(steps) // 2]:
            return y
    raise ValueError(f"{glyph.name}: no height where its stroke thickens steadily")


def matched_weights(letter, ref, s, height, ref_y, reach):
    """For a letter scaled by s: at each master, the weight to take its x
    coordinates from so that its leftmost stroke comes out exactly as thick
    as `ref`'s stem at that master.

    Chivo squeezes its widest letters as it gets heavier — at Black an m's
    stems are three quarters of an n's — because three stems must share one
    cell. Widened, M m W w have the room again, so they get the n's or H's
    stems back; narrowed, i I l keep the stems their neighbours have. `reach`
    is how far past Thin or Black the answer may go: a narrowed i at Black
    needs a weight Chivo does not have (the letters it is used on have no
    counters to close); a widened one looks at most LIGHTER below Thin."""
    lo0, hi0 = _search_range(s, reach)
    y = _steady_line(letter, height, lo0, hi0)
    out = {}
    for t in MASTERS:
        target = stroke_width(ref.masters[t], ref_y) / s
        lo, hi = lo0, hi0
        for _ in range(40):
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if stroke_width(letter.at(mid), y) < target else (lo, mid)
        out[t] = (lo + hi) / 2
    return lambda t: out[t]


def fitted_rescale(vg, s, advance, stems, compensate, margin, slant=0.0, y0=0.0):
    """rescale(), but at each master never wider than leaves `margin` units
    of the cell clear on either side (and never narrower than it came)."""
    if s <= 1.0:
        return rescale(vg, lambda t: s, advance, stems, compensate, slant, y0)

    def fits(t, k):
        g = rescale(vg, lambda _t: k, advance, stems, compensate, slant, y0)
        b = bounds(_unslant(g.masters[t], slant, y0))
        return b is None or (b[0] >= margin - 0.5 and b[2] <= advance - margin + 0.5)

    best = {}
    for t in MASTERS:
        if fits(t, s):
            best[t] = s
            continue
        lo, hi = 1.0, s
        if not fits(t, lo):
            best[t] = 1.0
            continue
        for _ in range(24):
            mid = (lo + hi) / 2
            lo, hi = (mid, hi) if fits(t, mid) else (lo, mid)
        best[t] = lo
    return rescale(vg, lambda t: best[t], advance, stems, compensate, slant, y0)


def _unslant(outline, slant, y0):
    if not slant:
        return outline
    return [[(x - slant * (y - y0), y, on) for x, y, on in c] for c in outline]


def hp_capital_o(vg, exponent, exponent_inner, widen, margin, slant=0.0, y0=0.0):
    """Chivo's O redrawn as a superellipse, its sides pushed out by `widen`
    (but no closer than `margin` to the cell edge), keeping every master's
    own stroke thicknesses and heights. Wide and square against the narrow,
    oval zero — the way HP's terminals told them apart."""
    def master(t, outline):
        flat = _unslant(outline, slant, y0)
        boxes = sorted((bounds([c]) for c in flat), key=lambda b: (b[2] - b[0]) * (b[3] - b[1]),
                       reverse=True)
        bo, bi = boxes[0], boxes[1]
        left, right = bi[0] - bo[0], bo[2] - bi[2]
        bottom, top = bi[1] - bo[1], bo[3] - bi[3]
        x0 = max(margin, bo[0] - widen)
        x1 = min(vg.advance - margin, bo[2] + widen)
        outer = superellipse(x0, bo[1], x1, bo[3], exponent, clockwise=True)
        inner = superellipse(x0 + left, bo[1] + bottom, x1 - right, bo[3] - top, exponent_inner,
                             clockwise=False)
        res = [outer, inner]
        if slant:
            res = [[(x + slant * (y - y0), y, on) for x, y, on in c] for c in res]
        return res
    return vg.map(master)


def round_capital_d(vg, exponent, exponent_inner, bowl, slant=0.0, y0=0.0):
    """Chivo's D (or a letter built on it: Ð, Đ) with its bowl redrawn as half
    a superellipse, `bowl` times half the D's height wide (no wider than
    reaches the counter's left edge), the bars running straight from the stem
    into it. Every master keeps its own stem, bar and bowl thicknesses and
    heights, and any further contour (Ð's bar) is kept as it is. Round beside
    the square O, and with a stem where the zero has none."""
    # The bowl's two contours, picked at the middle master (at Black, Ð's bar
    # is as big as the counter); every master has them in the same place.
    mid = _unslant(vg.masters[0.0], slant, y0)
    size = lambda i: (lambda b: (b[2] - b[0]) * (b[3] - b[1]))(bounds([mid[i]]))
    io, ii = sorted(range(len(mid)), key=size, reverse=True)[:2]

    def master(t, outline):
        flat = _unslant(outline, slant, y0)
        bo, bi = bounds([flat[io]]), bounds([flat[ii]])
        b = (bo[3] - bo[1]) / 2
        xs = bo[2] - min(bowl * b, bo[2] - bi[0])
        xi = max(xs, bi[0])
        outer = [(bo[0], bo[1], True), (bo[0], bo[3], True),
                 *superellipse_arc(xs, bo[1] + b, bo[2] - xs, b, exponent, 90, -90)]
        inner = [(bi[0], bi[1], True),
                 *superellipse_arc(xi, (bi[1] + bi[3]) / 2, bi[2] - xi, (bi[3] - bi[1]) / 2,
                                   exponent_inner, -90, 90),
                 (bi[0], bi[3], True)]
        res = list(flat)
        res[io], res[ii] = outer, inner
        if slant:
            res = [[(x + slant * (y - y0), y, on) for x, y, on in c] for c in res]
        return res
    return vg.map(master)
