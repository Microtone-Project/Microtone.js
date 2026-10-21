"""The Motif faces, each built from Chivo Mono into a finished TTFont.

build.py writes them where Microtone serves them; the Motif Code release
(a separate repository, which carries this package verbatim) instances and
packages the code face. Every function here takes the directory holding
`sources/`'s files, so neither needs to know where the other keeps them.
"""

import math
import unicodedata

from fontTools.ttLib import TTFont

from . import assemble, cjk, symbols
from .apertures import open_aperture
from .varglyph import VarGlyph, master_glyphsets, source_glyph, bounds, translate
from .widths import Stems, rescale, fitted_rescale, hp_capital_o, matched_weights

ROMAN, ITALIC = "ChivoMono-VF.ttf", "ChivoMono-Italic-VF.ttf"
CHIRON_SUBSET = "ChironHeiHK-lu.otf"
ZERO_WIDTH = (0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF)

META = {
    "copyright": "Copyright 2018 The Chivo Project Authors (https://github.com/Omnibus-Type/Chivo). "
                 "Lü ideographs: Copyright 2023-2026 Tamcy (https://github.com/chiron-fonts/chiron-hei-hk), "
                 "based on Source Han Sans, Copyright 2014-2025 Adobe (http://www.adobe.com/). "
                 "Motif modifications and symbols: Copyright 2026 The Microtone Project Authors.",
    "manufacturer": "The Microtone Project",
    "designer": "Omnibus-Type (Chivo Mono); Tamcy and Adobe (Chiron Hei HK); the Microtone Project (Motif)",
    "description": "Motif is Microtone's interface face, derived from Chivo Mono. "
                   "Chivo is a trademark of Omnibus-Type.",
    "url": "https://microtone.cc",
    "license": "This Font Software is licensed under the SIL Open Font License, Version 1.1. "
               "This license is available with a FAQ at: https://openfontlicense.org",
    "license_url": "https://openfontlicense.org",
}


class Source:
    """One Chivo Mono master set (roman or italic) and what is measured off it."""

    def __init__(self, path, cfg):
        self.path = path
        self.dir = path.parent
        self.font = TTFont(path)
        self.sets = master_glyphsets(self.font)
        self.stems = Stems(self.font, self.sets, cfg["stems"]["extrapolate"])
        angle = self.font["post"].italicAngle
        self.slant = math.tan(math.radians(-angle)) if angle else 0.0
        self.y0 = self.font["OS/2"].sxHeight / 2
        cmap = self.font.getBestCmap()
        self.apertures = {cmap[ord(ch)]: units for ch, units in cfg["apertures"].items() if units}

    def glyph(self, name, unicode=None):
        return source_glyph(self.font, self.sets, name, unicode)

    def letter(self, name, cfg):
        """Chivo's glyph, or Motif's own drawing of it: the square O, the
        opened C G c."""
        if name == "O":
            return capital_o(self, cfg)
        if name in self.apertures:
            return open_aperture(self.glyph(name), self.apertures[name])
        return self.glyph(name)


def capital_o(src, cfg):
    o = cfg["capital_O"]
    return hp_capital_o(src.glyph("O", 0x4F), o["exponent"], o["exponent_inner"], o["widen"],
                        o["margin"], src.slant, src.y0)


def lu(src, cfg, cell):
    c = cfg["cjk"]
    return cjk.lu_glyphs(src.dir / CHIRON_SUBSET, c["weights"], cell, c["scale"])


def drawn(cfg, src, table, cell=600):
    s = cfg["symbols"]
    return symbols.build_symbols(table, src.stems, s["weight"], s["beam"], cell, src.slant, src.y0)


def build_monospaced(cfg, sources, family, unicodes, scale, fit_margin, extra, centred="",
                     natural2=False):
    """Grid and Transport: every Chivo glyph rescaled by the same factor.
    The characters in `centred` are moved up or down to sit on the middle of
    the capitals, where the Kite marks and the tracker's digits sit."""
    src = Source(sources / ROMAN, cfg)
    comp = cfg["stems"]["compensate"]
    font = TTFont(src.path)
    assemble.subset_font(font, unicodes, [])
    del font["HVAR"]  # rebuilt from gvar once every advance is final
    cell = round(600 * scale) if scale < 1 else 600
    zero = 1 - cfg["zero"]["narrow"] / 100
    cmap = font.getBestCmap()
    centred_names = {cmap[ord(ch)] for ch in centred if ord(ch) in cmap}
    derived = []
    minus = cmap.get(0x2212)
    for name in font.getGlyphOrder():
        vg = src.letter(name, cfg)
        k = scale * zero if name == "zero" else scale
        # Widening keeps the cell; narrowing narrows it with the glyph.
        advance = vg.advance if scale >= 1 else round(vg.advance * scale)
        if k > 1:
            vg = fitted_rescale(vg, k, advance, src.stems, comp, fit_margin)
        else:
            vg = rescale(vg, lambda t: k, advance, src.stems, comp)
        if name in centred_names:
            vg = vg.map(lambda t, ol: translate(ol, 0, symbols.MID - (bounds(ol)[1] + bounds(ol)[3]) / 2))
        assemble.put_glyph(font, vg)
        if name == minus and natural2:
            # The grid's natural: this minus centred on two cells, so a note
            # cell is one string of characters, in a canvas or in the DOM.
            derived.append(VarGlyph("uniF01B", 2 * vg.advance,
                                    {t: translate(ol, vg.advance / 2, 0) for t, ol in vg.masters.items()},
                                    0xF01B))
    _add(font, extra(src, cell) + derived)
    return _finish(font, cfg, family, italic=False, fixed_pitch=True)


def build_code(cfg, sources, italic, mono=False):
    """Motif Code: Chivo Mono with i I l narrow and M m W w wide, digits and
    punctuation on the cell. With `mono`, Motif Mono: the same face with every
    letter left on the cell — Chivo Mono's own widths, Motif's O and zero."""
    src = Source(sources / (ITALIC if italic else ROMAN), cfg)
    c, comp = cfg["code"], cfg["stems"]["compensate"]
    font = TTFont(src.path)
    features = ["ccmp", "locl", "mark", "mkmk"]
    assemble.subset_font(font, list(font.getBestCmap()), features)
    del font["HVAR"]
    factor, base = ({}, {}) if mono else code_factors(font, c)
    # Chivo's hyphen is less than half the + and =, so "-=" reads as ".=";
    # the code face lengthens it, and the en and em dashes after it so the
    # three stay apart (the em dash on a wider cell). Their raised .cap forms
    # follow.
    cmap = font.getBestCmap()
    bars = {} if mono else {cmap[cp]: (c[key], c.get(key + "_advance", 600))
                            for cp, key in ((0x2D, "hyphen"), (0x2013, "endash"), (0x2014, "emdash"))}
    bars.update({g: bars[g.split(".")[0]] for g in font.getGlyphOrder() if g.split(".")[0] in bars})
    glyf = font["glyf"]
    moved = {}
    # Each narrowed or widened letter takes its stems from where they match
    # the n's (lowercase) or the H's (capitals); its accented forms follow it.
    xh, cap = src.font["OS/2"].sxHeight, src.font["OS/2"].sCapHeight
    weights = {}
    for letter in set(base.values()):
        low = letter.islower()
        weights[letter] = matched_weights(src.glyph(letter), src.glyph("n" if low else "H"),
                                          c["narrow_factor"] if letter in c["narrow_letters"] else c["wide_factor"],
                                          xh if low else cap, xh * 0.5 if low else cap * 0.3, c["extrapolate"])
    for name in font.getGlyphOrder():
        if name in factor:
            s = factor[name]
            g = src.letter(name, cfg)
            vg = rescale(g, lambda t: s, round(600 * s), src.stems, comp, src.slant, src.y0,
                         tx_of_t=weights[base[name]],
                         keep=_lone_mark(g, xh if base[name].islower() else cap))
            moved[name] = _anchor_mover(s, 600, round(600 * s), src.slant, src.y0)
        elif name == "O" or name in src.apertures:
            vg = src.letter(name, cfg)
        elif name == "zero":
            k = 1 - cfg["zero"]["narrow"] / 100
            vg = rescale(src.glyph(name), lambda t: k, 600, src.stems, comp, src.slant, src.y0)
        elif name in bars:
            vg = _lengthen(src.glyph(name), *bars[name], src.slant, src.y0)
        elif glyf[name].isComposite() and _reaches(glyf, name, factor):
            vg = src.glyph(name)  # decomposed: its parts are about to change shape
        else:
            continue
        assemble.put_glyph(font, vg)
    assemble.patch_anchors(font, moved)
    # Chivo's italic gives U+FEFF a cell where the roman gives it none; the
    # editor needs every character to measure alike in both.
    for cp in ZERO_WIDTH:
        g = font.getBestCmap().get(cp)
        if g and font["glyf"][g].numberOfContours == 0:
            font["hmtx"][g] = (0, 0)
    extra = drawn(cfg, src, symbols.SINGLE_CELL_MUSIC) + lu(src, cfg, 600)
    _add(font, extra)
    family = "Motif Mono" if mono else "Motif Code"
    return _finish(font, cfg, family, italic=italic, fixed_pitch=mono, features=features)


def code_factors(font, c):
    """Which glyphs the code face narrows or widens, and by what: the
    configured letters, their accented forms (by canonical decomposition),
    dotless i and l with stroke, and any unencoded alternate named after one
    of them. Also returns each one's base letter."""
    extra = {0x0131: "i", 0x0142: "l"}
    out, base = {}, {}
    cmap = font.getBestCmap()
    for cp, g in cmap.items():
        b = extra.get(cp) or unicodedata.normalize("NFD", chr(cp))[0]
        if b in c["narrow_letters"]:
            out[g], base[g] = c["narrow_factor"], b
        elif b in c["wide_letters"]:
            out[g], base[g] = c["wide_factor"], b
    for g in font.getGlyphOrder():
        root = g.split(".")[0]
        if g not in out and "." in g and root in out:
            out[g], base[g] = out[root], base[root]
    return out, base


def grid_extra(cfg):
    """Motif Grid's own glyphs: every drawn symbol and the lü."""
    def extra(src, cell):
        return drawn(cfg, src, symbols.SINGLE_CELL_MUSIC + symbols.GRID_PUA) + lu(src, cfg, 600)
    return extra


def _lone_mark(vg, height):
    """The index of the one contour standing wholly above the letter (an i's
    dot, a single accent), which keeps its size when the letter narrows; none
    when there are several (ï's two dots would collide)."""
    above = [i for i, c in enumerate(vg.masters[0.0]) if min(p[1] for p in c) > height * 0.95]
    return set(above) if len(above) == 1 else set()


def _lengthen(vg, length, advance, slant, y0):
    """A level bar made `length` units long at every weight, about its own
    middle, on a cell `advance` wide (centred as it was): the points left of
    the middle move left, the rest right. Italic bars are measured and moved
    along the slant, so they keep their angle."""
    shift = (advance - vg.advance) / 2
    def fn(t, ol):
        u = [x - slant * (y - y0) for c in ol for x, y, _ in c]
        mid, d = (min(u) + max(u)) / 2, (length - (max(u) - min(u))) / 2
        return [[(x + shift + (d if x - slant * (y - y0) > mid else -d), y, on) for x, y, on in c]
                for c in ol]
    return VarGlyph(vg.name, advance, {t: fn(t, vg.masters[t]) for t in vg.masters}, vg.unicode)


def _reaches(glyf, name, targets, seen=None):
    seen = seen or set()
    for comp in glyf[name].components:
        if comp.glyphName in targets:
            return True
        if comp.glyphName not in seen and glyf[comp.glyphName].isComposite():
            seen.add(comp.glyphName)
            if _reaches(glyf, comp.glyphName, targets, seen):
                return True
    return False


def _anchor_mover(s, adv_in, adv_out, slant, y0):
    def move(x, y):
        u = x - slant * (y - y0)
        return adv_out / 2 + s * (u - adv_in / 2) + slant * (y - y0)
    return move


def _add(font, glyphs):
    order = font.getGlyphOrder()
    for vg in glyphs:
        if vg.name not in order:
            order.append(vg.name)
    font.setGlyphOrder(order)
    font["glyf"].glyphOrder = order
    for vg in glyphs:
        assemble.put_glyph(font, vg)
    cmap = dict(font.getBestCmap())
    cmap.update({vg.unicode: vg.name for vg in glyphs if vg.unicode is not None})
    assemble.set_cmap(font, cmap)


def _finish(font, cfg, family, italic, fixed_pitch, features=()):
    # A second pass drops what nothing reaches any more (components that were
    # decomposed away).
    assemble.subset_font(font, list(font.getBestCmap()), features)
    assemble.set_names(font, family, italic, cfg["version"], META)
    assemble.finish(font, cfg["version"], cfg["date"], fixed_pitch)
    return font
