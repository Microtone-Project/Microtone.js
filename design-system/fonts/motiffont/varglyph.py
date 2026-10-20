"""Variable glyphs as point-compatible master outlines.

Every Motif font is variable on one axis, weight, with the three masters Chivo
Mono itself is built from: normalised location -1 (Thin, wght 100), 0 (Medium,
wght 500, the default instance) and +1 (Black, wght 900). A VarGlyph holds one
outline per master; all three have the same contours, the same points and the
same on/off-curve flags, so the gvar table can carry the difference as deltas.
Anything between masters is linear, exactly as a renderer will make it, and
`at(t)` extrapolates the same lines beyond them (the stem compensation in
widths.py reads a little past Thin or Black when it has to).

An outline is a list of contours; a contour is a list of (x, y, on_curve)
points in TrueType's sense — quadratic, implied on-curve points between two
off-curve ones, clockwise outer contours.
"""

from fontTools.pens.recordingPen import DecomposingRecordingPointPen

MASTERS = (-1.0, 0.0, 1.0)
WGHT_OF = {-1.0: 100, 0.0: 500, 1.0: 900}


class VarGlyph:
    def __init__(self, name, advance, masters, unicode=None):
        self.name = name
        self.advance = advance
        self.masters = {t: masters[t] for t in MASTERS}
        self.unicode = unicode
        self.check()

    def check(self):
        shape = _shape(self.masters[0.0])
        for t in MASTERS:
            if _shape(self.masters[t]) != shape:
                raise ValueError(f"{self.name}: master {t} is not point-compatible")

    def at(self, t):
        """The outline at normalised weight t, piecewise linear through the
        masters and extrapolated past them."""
        if t in self.masters:
            return self.masters[t]
        lo, hi = (-1.0, 0.0) if t < 0 else (0.0, 1.0)
        f = (t - lo) / (hi - lo)
        a, b = self.masters[lo], self.masters[hi]
        return [[(pa[0] + (pb[0] - pa[0]) * f, pa[1] + (pb[1] - pa[1]) * f, pa[2])
                 for pa, pb in zip(ca, cb)] for ca, cb in zip(a, b)]

    def map(self, fn):
        """A new VarGlyph whose master t is fn(t, outline)."""
        return VarGlyph(self.name, self.advance, {t: fn(t, self.masters[t]) for t in MASTERS},
                        self.unicode)


def _shape(outline):
    return tuple(tuple(p[2] for p in c) for c in outline)


def outline_from_glyphset(glyphset, name):
    """The outline of `name` in a (location-bound) glyph set, components
    decomposed, points exactly as the glyf table stores them."""
    pen = DecomposingRecordingPointPen(glyphset)
    glyphset[name].drawPoints(pen)
    contours, cur = [], None
    for op, args, kwargs in pen.value:
        if op == "beginPath":
            cur = []
        elif op == "addPoint":
            pt = args[0]
            seg = args[1] if len(args) > 1 else kwargs.get("segmentType")
            cur.append((float(pt[0]), float(pt[1]), seg is not None))
        elif op == "endPath":
            contours.append(cur)
    return contours


def source_glyph(font, glyphsets, name, unicode=None):
    """A VarGlyph straight from a Chivo Mono master set."""
    adv = font["hmtx"][name][0]
    return VarGlyph(name, adv, {t: outline_from_glyphset(glyphsets[t], name) for t in MASTERS},
                    unicode)


def master_glyphsets(font):
    return {t: font.getGlyphSet(location={"wght": WGHT_OF[t]}) for t in MASTERS}


def bounds(outline):
    xs = [p[0] for c in outline for p in c]
    ys = [p[1] for c in outline for p in c]
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def translate(outline, dx, dy):
    return [[(x + dx, y + dy, on) for x, y, on in c] for c in outline]


def transform(outline, fn):
    return [[(*fn(x, y), on) for x, y, on in c] for c in outline]
