"""Motif's drawn symbols: accidentals, Kite ticks, slide marks, the four note
sentinels and the vibrato waveforms.

Every symbol is a function of a Ctx — one weight master's nib and metrics —
returning an outline; `build_symbols` runs each one at the three masters to
make a VarGlyph. The nib is Chivo's own stem and bar at that weight times
SYMBOL WEIGHT (motif.toml [symbols] weight), so the symbols get heavier and
lighter exactly as the letters do.

Units are font units (1000 per em). A cell is 600 wide; the capitals stand
on the baseline (0) and reach 686, so MID = 343 is the middle of a capital,
which is also where a tracker row's text sits: everything "vertically centred"
here is centred on MID.

Ink stays between DESC_LIMIT and ASC_LIMIT, the band a 13 px font keeps clear
of the next row in a 16 px tracker row.
"""

import math

from .geometry import superellipse, signed_area, unit
from .stroke import Nib, stroke, polygon, sample, cubic
from .varglyph import VarGlyph, MASTERS, bounds, translate

CELL = 600
CAP = 686
MID = CAP / 2
ASC_LIMIT = 900
DESC_LIMIT = -230


class Ctx:
    def __init__(self, t, stem_v, stem_h, dot_w, weight, beam):
        self.t = t
        self.stem_v, self.stem_h = stem_v, stem_h
        self.nib = Nib(stem_v * weight / 2, stem_h * weight / 2)
        # A sharp's crossbars are beams: a little heavier than its stems.
        self.beam = Nib(stem_v * weight / 2, stem_h * weight * beam / 2)
        self.dot_w = dot_w  # Chivo's period, for the Kite big dot


# ── helpers ────────────────────────────────────────────────────────────────

def _centre_v(outline, mid=MID):
    b = bounds(outline)
    return translate(outline, 0, mid - (b[1] + b[3]) / 2)


def _top_to(outline, y):
    return translate(outline, 0, y - bounds(outline)[3])


def _bottom_to(outline, y):
    return translate(outline, 0, y - bounds(outline)[1])


def _mirror_nodes(nodes, cx):
    return [(2 * cx - n[0], n[1], *n[2:]) for n in nodes]


# ── sharps ─────────────────────────────────────────────────────────────────
# Upright stems, beams rising to the right, the left stem sitting a little
# lower than the right, as in engraved music.

def _sharp(c, cx, stems, beam_half, rise=70, beam_gap=230, stem_half=395, stagger=34):
    out = []
    span = max(abs(s) for s in stems) or 1
    for dx in stems:
        lift = stagger * dx / span
        out += stroke([(cx + dx, MID - stem_half + lift), (cx + dx, MID + stem_half + lift)], c.nib)
    for yc in (MID - beam_gap / 2, MID + beam_gap / 2):
        out += stroke([(cx - beam_half, yc - rise / 2), (cx + beam_half, yc + rise / 2)], c.beam,
                      "vcut", "vcut")
    return out


# The half sharp's beams are nine tenths of the sharp's, in either size: one
# stem makes it read narrower than its beams.
def sharp(c):              return _sharp(c, 300, (-92, 92), 212)
def half_sharp(c):         return _sharp(c, 300, (0,), 190, rise=64)
def sesqui_sharp(c):       return _sharp(c, 300, (-150, 0, 150), 232, rise=78)

# The two-cell accidentals are matched by eye to one width, DW_WIDTH: a
# sharp's beams span it, the half sharp's nine tenths, the sesquisharp's a
# little more; a flat, whose open bowl reads wider than its ink, is about
# four fifths of it from stem to bowl; a double sharp about as wide.
DW_WIDTH = 600


def dw_sharp(c):           return _sharp(c, 600, (-150, 150), DW_WIDTH * 0.50, rise=100, beam_gap=245)
def dw_half_sharp(c):      return _sharp(c, 600, (0,), DW_WIDTH * 0.45, rise=92, beam_gap=245)
def dw_sesqui_sharp(c):    return _sharp(c, 600, (-200, 0, 200), DW_WIDTH * 0.57, rise=112, beam_gap=245)


# ── flats ──────────────────────────────────────────────────────────────────
# A stem from above the ascender to the baseline, and a bowl that leaves the
# stem a little above mid-height with a slight rise, is widest high up, and
# runs in one long curve down into the stem's foot. Bowl and stem end on the
# baseline in a single flat cut, the way Chivo cuts the foot of its v.

FLAT_TOP = 770     # the stem's top
FLAT_ATTACH = 365  # where the bowl leaves the stem
FLAT_WIDEST = 285  # the height of the bowl's widest point
FOOT_TURN = 10     # degrees: how much flatter than the chord the bowl runs into the foot


def _foot_dir(bw):
    """The bowl's direction as it runs into the foot: a little flatter than
    the straight line from its widest point to the foot, so the lower curve
    is convex all the way down however wide the bowl is."""
    a = math.atan2(bw, FLAT_WIDEST) + math.radians(FOOT_TURN)
    return (-math.sin(a), -math.cos(a))


def _foot_end(sx, d, nib, stem_nib):
    """Where the bowl's centre line ends: at the point whose underside edge
    is exactly the stem's bottom outer corner. The stem's flat foot then runs
    straight into the bowl's underside — no step where the stem's corner
    would stick out, no hairline along the baseline — and the square end of
    the stroke lies wholly inside the stem."""
    off = nib.off(d)  # the underside, for a bowl running down to the left
    return (sx + stem_nib.a - off[0], -off[1])


def _flat_nodes(sx, bw, d, end, mirror=False):
    # However wide the bowl, it rises no higher, so a wide flat is rounder
    # rather than taller.
    rise = 0.30 * min(bw, 260)
    up = cubic((sx, FLAT_ATTACH), (sx + 0.42 * bw, FLAT_ATTACH + rise),
               (sx + bw, FLAT_WIDEST + 0.42 * min(bw, 260)), (sx + bw, FLAT_WIDEST), 12)
    # The lower curve keeps to the right for a long way before turning in,
    # so the bowl stays full rather than closing like a check mark.
    k = 0.30 * math.hypot(bw, FLAT_WIDEST)
    ex, ey = end
    down = cubic((sx + bw, FLAT_WIDEST), (sx + bw, FLAT_WIDEST * 0.40),
                 (ex - d[0] * k, ey - d[1] * k), (ex, ey), 16)
    nodes = up[:-1] + [(sx + bw, FLAT_WIDEST, "smooth")] + down[1:]
    return _mirror_nodes(nodes, sx) if mirror else nodes


def _flat(c, sx, bw, mirror=False, stem=True, nib=None):
    nib = nib or c.nib
    d = _foot_dir(bw)
    out = stroke(_flat_nodes(sx, bw, d, _foot_end(sx, d, nib, nib), mirror), nib, "vcut", "butt")
    if stem:
        out = stroke([(sx, 0), (sx, FLAT_TOP)], nib) + out
    return out


def _flats(c, cx, count, bw, room, nib=None):
    """`count` full flats, each bowl leaning on the next flat's stem — the
    engraved double and triple flat — centred on cx. The bowls shrink only
    when `room` (the ink's width) could not hold them otherwise."""
    nib = nib or c.nib
    bw = min(bw, (room - 2 * nib.a) / count)
    x0 = cx - count * bw / 2
    out = []
    for i in range(count):
        out += _flat(c, x0 + i * bw, bw, nib=nib)
    return out


FLAT_BOWL = 245     # a one-cell flat's bowl, stem centre to the bowl's widest point
FLAT_BOWL_2 = round(DW_WIDTH * 0.65)  # a two-cell flat's (ink ≈ 0.8 DW_WIDTH)


def flat(c):               return _flat(c, 300 - FLAT_BOWL / 2, FLAT_BOWL)
def reversed_flat(c):      return _flat(c, 300 + FLAT_BOWL / 2, FLAT_BOWL, mirror=True)
def double_flat(c):        return _flats(c, 300, 2, FLAT_BOWL, 560)
def triple_flat(c):        return _flats(c, 300, 3, FLAT_BOWL, 580, c.nib.scaled(0.8))
def dw_flat(c):            return _flat(c, 600 - FLAT_BOWL_2 / 2, FLAT_BOWL_2)
def dw_reversed_flat(c):   return _flat(c, 600 + FLAT_BOWL_2 / 2, FLAT_BOWL_2, mirror=True)
def dw_double_flat(c):     return _flats(c, 600, 2, 300, 1000)
def dw_triple_flat(c):     return _flats(c, 600, 3, 300, 940)


def sesqui_flat(c):
    """Reversed flat and flat back to back on ONE stem (Unicode 18's chart)."""
    return _flat(c, 300, 225) + _flat(c, 300, 225, mirror=True, stem=False)


def dw_sesqui_flat(c):
    return _flat(c, 600, 265) + _flat(c, 600, 265, mirror=True, stem=False)


# ── natural, double sharp ──────────────────────────────────────────────────

def natural(c):
    cx, dx, rise = 300, 100, 50
    out = stroke([(cx - dx, MID + 400), (cx - dx, MID - 175)], c.nib)
    out += stroke([(cx + dx, MID + 175), (cx + dx, MID - 400)], c.nib)
    for yc in (MID - 110, MID + 110):
        out += stroke([(cx - dx, yc - rise / 2), (cx + dx, yc + rise / 2)], c.beam, "vcut", "vcut")
    return out


def _double_sharp(c, cx, r, blob=1.5):
    out = []
    for (x0, y0, x1, y1) in ((cx - r, MID - r, cx + r, MID + r), (cx - r, MID + r, cx + r, MID - r)):
        out += stroke([(x0, y0), (x1, y1)], c.nib)
    q = min(c.nib.a * blob, 0.42 * r)  # never so big that a heavy X fills in
    for sx in (-1, 1):
        for sy in (-1, 1):
            px, py = cx + sx * (r - q * 0.35), MID + sy * (r - q * 0.35)
            out.append(polygon([(px - q, py - q), (px - q, py + q), (px + q, py + q), (px + q, py - q)]))
    return out


def double_sharp(c):       return _double_sharp(c, 300, 170)
def dw_double_sharp(c):    return _double_sharp(c, 600, 235, blob=1.6)


def dw_triple_sharp(c):
    """♯𝄪 — Unicode has no triple sharp (its proposal spells it this way): a
    sharp, and a double sharp just clear of its beams' ends."""
    return _sharp(c, 345, (-105, 105), 210, rise=80, beam_gap=245) + _double_sharp(c, 845, 160, blob=1.5)


def dw_quad_sharp(c):
    """𝄪𝄪 — two large double sharps overlapping on a shared pair of blobs."""
    r = 200
    return _double_sharp(c, 600 - r, r, blob=1.6) + _double_sharp(c, 600 + r, r, blob=1.6)


# ── Kite ticks and the slide marks ─────────────────────────────────────────
# A chevron with Chivo's flat-cut apex and feet cut level.

TICK_HALF_W = 175
TICK_H = 230
KITE_END_OFFH = 50

def _chevron(c, cx, apex, up=True, half_w=TICK_HALF_W, h=TICK_H):
    s = 1 if up else -1
    return stroke([(cx - half_w, apex - s * h), (cx, apex, "flat"), (cx + half_w, apex - s * h)],
                  c.nib, "hcut", "hcut")


def _side_chevron(c, cx, cy, right=True, half_w=TICK_HALF_W, h=TICK_H):
    s = 1 if right else -1
    apex = cx + s * h / 2
    return stroke([(apex - s * h, cy + half_w), (apex, cy, "flat"), (apex - s * h, cy - half_w)],
                  c.nib, "vcut", "vcut")


def kite_up(c):            return _top_to(_chevron(c, 300, 500, True), CAP - KITE_END_OFFH)
def kite_down(c):          return _bottom_to(_chevron(c, 300, 200, False), KITE_END_OFFH)


def kite_up2(c):
    return _top_to(_chevron(c, 300, 500, True), CAP - KITE_END_OFFH) + _bottom_to(_chevron(c, 300, 300, True), KITE_END_OFFH)


def kite_down2(c):
    return _top_to(_chevron(c, 300, 500, False), CAP - KITE_END_OFFH) + _bottom_to(_chevron(c, 300, 300, False), KITE_END_OFFH)


def kite_dot(c):
    r = c.dot_w * 0.72
    return [superellipse(300 - r, MID - r, 300 + r, MID + r, 2.0)]


def _height(outline):
    b = bounds(outline)
    return b[3] - b[1]


def _slide_depth(c):
    """How deep the slide chevrons are: the depth at which a volume tick
    stands exactly as tall as a panning mark of the same depth is. A panning
    mark is then the volume tick lying on its side, as wide as the tick is
    tall, and the two are the same size either way up."""
    h = TICK_H
    for _ in range(12):
        h += _height(_side_chevron(c, 300, MID, True, h=h)) - _height(_chevron(c, 300, 500, True, h=h))
    return h


def _centre_h(outline, mid=300):
    b = bounds(outline)
    return translate(outline, mid - (b[0] + b[2]) / 2, 0)


def slide_up(c):           return _centre_v(_chevron(c, 300, 500, True, h=_slide_depth(c)))
def slide_down(c):         return _centre_v(_chevron(c, 300, 500, False, h=_slide_depth(c)))
def slide_left(c):         return _centre_h(_side_chevron(c, 300, MID, False, h=_slide_depth(c)))
def slide_right(c):        return _centre_h(_side_chevron(c, 300, MID, True, h=_slide_depth(c)))


# ── note sentinels: four cells wide ────────────────────────────────────────

def keyoff(c):
    x0, x1, y0, y1 = 300, 2100, MID - 165, MID + 165
    return stroke([(x0, y0), (x0, y1), (x1, y1), (x1, y0)], c.nib, closed=True)


def note_cut(c):
    x0, x1, amp, peaks = 250, 2150, 205, 3
    seg = (x1 - x0) / (peaks * 2)
    nodes = [(x0, MID - amp)]
    for i in range(peaks):
        nodes.append((x0 + seg * (2 * i + 1), MID + amp, "flat"))
        nodes.append((x0 + seg * (2 * i + 2), MID - amp, "flat" if i < peaks - 1 else "corner"))
    return _centre_v(stroke(nodes, c.nib, "hcut", "hcut"))


def fade(c):
    """Three whole cycles of a sine, 0 to 6π: it starts and ends on the
    middle line, so it reads as a wave and not as the cut's row of peaks."""
    x0, x1, amp, periods = 290, 2110, 165, 3
    nodes = sample(lambda t: (x0 + (x1 - x0) * t, MID + amp * math.sin(2 * math.pi * periods * t)),
                   0.0, 1.0, 26 * periods)
    return stroke(nodes, c.nib)


def _wedge_foot(gain):
    """Where a straight line from the apex (height 1 at t = 0) touches the
    sinc tail gain·sin(πt)/(πt): the wedge's sides are that tangent, so the
    sinc carries on from the wedge without a corner."""
    f = lambda t: gain * math.sin(math.pi * t) / (math.pi * t)
    df = lambda t: gain * (math.pi * t * math.cos(math.pi * t) - math.sin(math.pi * t)) / (math.pi * t * t)
    lo, hi = 1.0, 1.43  # from the first zero to the first trough
    for _ in range(60):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if f(mid) - mid * df(mid) > 1 else (lo, mid)
    return (lo + hi) / 2


def fast_fade(c):
    """A sinc whose main lobe is a straight-sided wedge: the cut's instant
    edge inside a fade's decaying tail. The wedge's sides are tangent to the
    tail where they meet it."""
    x0, x1, amp, reach, gain = 150, 2250, 330, 4.0, 1.8
    tj = _wedge_foot(gain)
    xs = lambda t: x0 + (x1 - x0) * (t + reach) / (2 * reach)
    ys = lambda t: MID + amp * gain * math.sin(math.pi * t) / (math.pi * t)
    left = sample(lambda t: (xs(t), ys(t)), -reach, -tj, 44)
    right = sample(lambda t: (xs(t), ys(t)), tj, reach, 44)
    nodes = left + [(xs(0.0), MID + amp, "flat")] + right
    return _centre_v(stroke(nodes, c.nib))


# ── vibrato waveforms: two cells, edge to edge ─────────────────────────────
# Each is one period that starts and ends at the same height on the cell
# edges, cut vertically there, so "" draws two seamless periods.

WAVE_AMP = 225


def wave_sine(c):
    nodes = sample(lambda t: (1200 * t, MID + WAVE_AMP * math.sin(2 * math.pi * t)), 0.0, 1.0, 48)
    return stroke(nodes, c.nib, "vcut", "vcut")


def wave_ramp_down(c):
    a = WAVE_AMP
    return stroke([(0, MID), (600, MID - a), (600, MID + a), (1200, MID)], c.nib, "vcut", "vcut")


def wave_ramp_up(c):
    a = WAVE_AMP
    return stroke([(0, MID), (600, MID + a), (600, MID - a), (1200, MID)], c.nib, "vcut", "vcut")


def wave_triangle(c):
    a = WAVE_AMP
    return stroke([(0, MID), (300, MID + a), (900, MID - a), (1200, MID)], c.nib, "vcut", "vcut")


def wave_square(c):
    a = WAVE_AMP
    return stroke([(0, MID + a), (300, MID + a), (300, MID - a), (900, MID - a), (900, MID + a),
                   (1200, MID + a)], c.nib, "vcut", "vcut")


RANDOM_LEVELS = (-0.2, 0.85, -0.75, 0.4)


def wave_random(c):
    """Sample-and-hold: four held levels; the first is split across the cell
    edges so that two copies join."""
    a = WAVE_AMP
    levels = [MID + a * v for v in RANDOM_LEVELS] + [MID + a * RANDOM_LEVELS[0]]
    edges = [0, 150, 450, 750, 1050, 1200]
    nodes = [(0, levels[0])]
    for i in range(1, len(levels)):
        nodes.append((edges[i], levels[i - 1]))
        nodes.append((edges[i], levels[i]))
    nodes.append((1200, levels[-1]))
    return stroke(nodes, c.nib, "vcut", "vcut")


# ── the table ──────────────────────────────────────────────────────────────
# (code point, glyph name, advance in cells, design)

SINGLE_CELL_MUSIC = [
    (0x266F, "uni266F", 1, sharp),
    (0x266E, "uni266E", 1, natural),
    (0x266D, "uni266D", 1, flat),
    (0x1D12A, "u1D12A", 1, double_sharp),
    (0x1D12B, "u1D12B", 1, double_flat),
    (0x1D260, "u1D260", 1, triple_flat),
    (0x1D1EB, "u1D1EB", 1, half_sharp),
    (0x1D1EC, "u1D1EC", 1, sesqui_sharp),
    (0x1D1ED, "u1D1ED", 1, reversed_flat),
    (0x1D1EE, "u1D1EE", 1, sesqui_flat),
]

GRID_PUA = [
    (0xF000, "uniF000", 1, kite_up),
    (0xF001, "uniF001", 1, kite_down),
    (0xF002, "uniF002", 1, kite_up2),
    (0xF003, "uniF003", 1, kite_down2),
    (0xF004, "uniF004", 1, kite_dot),
    (0xF00C, "uniF00C", 1, slide_up),
    (0xF00D, "uniF00D", 1, slide_down),
    (0xF00E, "uniF00E", 1, slide_left),
    (0xF00F, "uniF00F", 1, slide_right),
    (0xF010, "uniF010", 2, dw_sharp),
    (0xF011, "uniF011", 2, dw_flat),
    (0xF012, "uniF012", 2, dw_double_sharp),
    (0xF013, "uniF013", 2, dw_double_flat),
    (0xF014, "uniF014", 2, dw_triple_flat),
    (0xF015, "uniF015", 2, dw_half_sharp),
    (0xF016, "uniF016", 2, dw_sesqui_sharp),
    (0xF017, "uniF017", 2, dw_reversed_flat),
    (0xF018, "uniF018", 2, dw_sesqui_flat),
    (0xF019, "uniF019", 2, dw_triple_sharp),
    (0xF01A, "uniF01A", 2, dw_quad_sharp),
    (0xF030, "uniF030", 4, keyoff),
    (0xF031, "uniF031", 4, note_cut),
    (0xF032, "uniF032", 4, fade),
    (0xF033, "uniF033", 4, fast_fade),
    (0xF040, "uniF040", 2, wave_sine),
    (0xF041, "uniF041", 2, wave_ramp_down),
    (0xF042, "uniF042", 2, wave_square),
    (0xF043, "uniF043", 2, wave_random),
    (0xF044, "uniF044", 2, wave_ramp_up),
    (0xF045, "uniF045", 2, wave_triangle),
]


def build_symbols(table, stems, weight, beam, cell=CELL, slant=0.0, y0=0.0):
    """VarGlyphs for `table`, drawn at each master with that master's nib.
    `stems` is a widths.Stems; `slant` shears them for an italic."""
    out = []
    for cp, name, cells, design in table:
        masters = {}
        for t in MASTERS:
            c = Ctx(t, stems.v(t), stems.h(t), stems.dot(t), weight, beam)
            outline = design(c)
            if cell != CELL:
                k = cell / CELL
                outline = [[(x * k, y, on) for x, y, on in ct] for ct in outline]
            if slant:
                outline = [[(x + slant * (y - y0), y, on) for x, y, on in ct] for ct in outline]
            masters[t] = outline
        out.append(VarGlyph(name, round(cells * cell), masters, cp))
    return out
