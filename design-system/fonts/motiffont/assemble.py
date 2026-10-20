"""Putting a Motif font together.

Start from Chivo Mono subset to the variant's characters, replace the glyphs
the variant changes with VarGlyphs (outline at the default master in glyf,
the other two masters as gvar deltas), add the drawn symbols and the lü,
subset once more to drop what nothing reaches, then name it, describe it and
stamp it with the configured date so a rebuild is byte-for-byte repeatable.
"""

import datetime
from array import array

from fontTools import subset
from fontTools.misc.roundTools import otRound
from fontTools.otlLib.builder import buildStatTable
from fontTools.ttLib import newTable
from fontTools.ttLib.tables import ttProgram
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable
from fontTools.ttLib.tables._g_l_y_f import Glyph, GlyphCoordinates
from fontTools.ttLib.tables.TupleVariation import TupleVariation
from fontTools.varLib.hvar import add_HVAR

from .varglyph import MASTERS

REGIONS = {-1.0: (-1.0, -1.0, 0.0), 1.0: (0.0, 1.0, 1.0)}

WEIGHTS = [(100, "Thin"), (200, "ExtraLight"), (300, "Light"), (400, "Regular"),
           (500, "Medium"), (600, "SemiBold"), (700, "Bold"), (800, "ExtraBold"),
           (900, "Black")]


def subset_font(font, unicodes, features, glyphs=()):
    opts = subset.Options()
    opts.layout_features = list(features)
    opts.name_IDs = ["*"]
    opts.name_languages = ["*"]
    opts.notdef_outline = True
    opts.glyph_names = True
    opts.hinting = True
    if not features:
        opts.drop_tables += ["GSUB", "GPOS", "GDEF"]
    s = subset.Subsetter(opts)
    s.populate(unicodes=unicodes, glyphs=list(glyphs))
    s.subset(font)


def put_glyph(font, vg):
    """Write a VarGlyph into glyf/hmtx/gvar under its name."""
    glyf, gvar, hmtx = font["glyf"], font["gvar"], font["hmtx"]
    base = [[(otRound(x), otRound(y), on) for x, y, on in c] for c in vg.masters[0.0]]
    g = Glyph()
    coords, flags, ends = [], [], []
    for c in base:
        for x, y, on in c:
            coords.append((x, y))
            flags.append(1 if on else 0)
        ends.append(len(coords) - 1)
    if coords:
        g.numberOfContours = len(base)
        g.coordinates = GlyphCoordinates(coords)
        g.flags = array("B", flags)
        g.endPtsOfContours = ends
        g.program = ttProgram.Program()
        g.program.fromBytecode(b"")
        if len(base) > 1:
            g.flags[0] |= 0x40  # OVERLAP_SIMPLE: contours may overlap (drawn strokes do)
    else:
        g.numberOfContours = 0
    glyf.glyphs[vg.name] = g
    g.recalcBounds(glyf)
    lsb = g.xMin if coords else 0
    hmtx.metrics[vg.name] = (vg.advance, lsb)
    phantoms = [(0, 0), (vg.advance, 0), (0, 0), (0, 0)]
    variations = []
    for t in (-1.0, 1.0):
        deltas = []
        for cb, cm in zip(base, vg.masters[t]):
            for (bx, by, _), (mx, my, _) in zip(cb, cm):
                deltas.append((otRound(mx) - bx, otRound(my) - by))
        if any(d != (0, 0) for d in deltas):
            tv = TupleVariation({"wght": REGIONS[t]}, deltas + [(0, 0)] * 4)
            tv.optimize(GlyphCoordinates(coords + phantoms), ends)
            variations.append(tv)
    gvar.variations[vg.name] = variations


def set_cmap(font, mapping):
    table = newTable("cmap")
    table.tableVersion = 0
    table.tables = []
    bmp = {cp: g for cp, g in mapping.items() if cp <= 0xFFFF}
    wide = len(bmp) != len(mapping)
    for pid, eid, fmt, m in ((0, 3, 4, bmp), (3, 1, 4, bmp), (0, 4, 12, mapping), (3, 10, 12, mapping)):
        if fmt == 12 and not wide:
            continue
        st = CmapSubtable.newSubtable(fmt)
        st.platformID, st.platEncID, st.language = pid, eid, 0
        st.cmap = dict(m)
        table.tables.append(st)
    font["cmap"] = table


def set_names(font, family, italic, version, meta):
    name = font["name"]
    name.names = []
    ps_family = family.replace(" ", "")
    default = "Medium"
    style = default + (" Italic" if italic else "")
    ps = f"{ps_family}-{default}{'Italic' if italic else ''}"
    win = ((3, 1, 0x409),)
    for nid, s in ((0, meta["copyright"]), (1, f"{family} {default}"),
                   (2, "Italic" if italic else "Regular"), (3, f"{version};MCTN;{ps}"),
                   (4, f"{family} {style}"), (5, f"Version {version}"), (6, ps),
                   (8, meta["manufacturer"]), (9, meta["designer"]), (10, meta["description"]),
                   (11, meta["url"]), (13, meta["license"]), (14, meta["license_url"]),
                   (16, family), (17, style), (25, ps_family + ("Italic" if italic else ""))):
        name.setName(s, nid, 3, 1, 0x409)
    fvar = font["fvar"]
    for axis in fvar.axes:
        axis.axisNameID = name.addName("Weight", platforms=win)
    for inst in fvar.instances:
        w = inst.coordinates["wght"]
        label = dict(WEIGHTS)[int(w)]
        sub = (label + " Italic" if label != "Regular" else "Italic") if italic else label
        inst.subfamilyNameID = name.addName(sub, platforms=win)
        inst.postscriptNameID = name.addName(f"{ps_family}-{sub.replace(' ', '')}", platforms=win)
    if "STAT" in font:
        del font["STAT"]
    values = []
    for v, label in WEIGHTS:
        d = dict(value=v, name=label)
        if v == 400:
            d.update(flags=0x2, linkedValue=700)
        values.append(d)
    ital = (dict(value=1, name="Italic") if italic
            else dict(value=0, name="Roman", flags=0x2, linkedValue=1))
    buildStatTable(font, [dict(tag="wght", name="Weight", values=values),
                          dict(tag="ital", name="Italic", values=[ital])],
                   elidedFallbackName=2, windowsNames=True, macNames=False)


def finish(font, version, date, fixed_pitch, vendor="MCTN"):
    head = font["head"]
    head.fontRevision = float(version)
    stamp = int((datetime.datetime.fromisoformat(date) - datetime.datetime(1904, 1, 1)).total_seconds())
    head.created = head.modified = stamp
    font.recalcTimestamp = False
    os2 = font["OS/2"]
    os2.achVendID = vendor
    os2.recalcUnicodeRanges(font)
    os2.recalcCodePageRanges(font)
    os2.recalcAvgCharWidth(font)
    if not fixed_pitch:
        os2.panose.bProportion = 0
    font["post"].isFixedPitch = 1 if fixed_pitch else 0
    if "HVAR" in font:
        del font["HVAR"]
    add_HVAR(font)


def patch_anchors(font, moved):
    """Mark-to-base anchors follow a base glyph that was narrowed or widened.
    `moved` maps a glyph name to fn(x, y) → x'. A varying anchor loses its
    x variation (the glyphs concerned barely move with weight)."""
    if "GPOS" not in font:
        return
    for lookup in font["GPOS"].table.LookupList.Lookup:
        for st in lookup.SubTable:
            kind = lookup.LookupType
            if kind == 9:
                kind, st = st.ExtensionLookupType, st.ExtSubTable
            if kind != 4:
                continue
            for gname, rec in zip(st.BaseCoverage.glyphs, st.BaseArray.BaseRecord):
                if gname not in moved:
                    continue
                for anchor in rec.BaseAnchor:
                    if anchor is None:
                        continue
                    anchor.XCoordinate = otRound(moved[gname](anchor.XCoordinate, anchor.YCoordinate))
                    if anchor.Format == 3:
                        anchor.XDeviceTable = None
                        if anchor.YDeviceTable is None:
                            anchor.Format = 1


def save(font, ttf_path, woff2_path):
    font.save(ttf_path)
    font.flavor = "woff2"
    font.save(woff2_path)
    font.flavor = None
