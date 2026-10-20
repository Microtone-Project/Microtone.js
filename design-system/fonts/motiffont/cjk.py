"""The twelve lü (the Chinese pitch names) from Chiron Hei HK.

Chiron Hei HK is a CFF2 variable font: cubic outlines on a weight axis of its
own (200…900, with an avar). Each ideograph is read at the three weights
motif.toml maps onto Motif's masters, converted to quadratic splines with
cu2qu — all three masters at once, so the conversion picks the same number
of points for each and the result stays variable — and set two cells wide.
"""

from fontTools.cu2qu import curves_to_quadratic
from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont

from .varglyph import VarGlyph, MASTERS

LU = "黃大太夾姑仲蕤林夷南無應"


def subset_chiron(src_path, dst_path):
    """The twelve glyphs of the full Chiron Hei HK (26 MB) as a small variable
    font, kept in sources/ so a build never needs the original."""
    from fontTools import subset
    opts = subset.Options()
    opts.layout_features = []
    opts.name_IDs = ["*"]
    opts.name_languages = ["*"]
    opts.notdef_outline = True
    opts.drop_tables += ["BASE", "VORG", "vhea", "vmtx", "VVAR"]
    font = TTFont(src_path)
    s = subset.Subsetter(opts)
    s.populate(unicodes=[ord(c) for c in LU])
    s.subset(font)
    font.save(dst_path)


def _record(glyphset, name):
    pen = RecordingPen()
    glyphset[name].draw(pen)
    return pen.value


def lu_glyphs(path, weights, cell, scale=1.0, max_err=0.6):
    font = TTFont(path)
    cmap = font.getBestCmap()
    sets = {t: font.getGlyphSet(location={"wght": w, "PADG": 0}) for t, w in zip(MASTERS, weights)}
    em_adv = font["hmtx"][cmap[ord(LU[0])]][0]
    # The ideographic em box (−120…880 in Chiron) is scaled about its centre
    # and centred in the two-cell advance.
    box_mid = (-120 + 880) / 2
    dx = cell - em_adv / 2

    def place(p):
        x, y = p
        return ((x - em_adv / 2) * scale + em_adv / 2 + dx, (y - box_mid) * scale + box_mid)

    out = []
    for ch in LU:
        gname = cmap[ord(ch)]
        recs = [_record(sets[t], gname) for t in MASTERS]
        ops = [[op for op, _ in r] for r in recs]
        if any(o != ops[0] for o in ops):
            raise ValueError(f"{ch}: Chiron masters are not compatible")
        masters = {t: [] for t in MASTERS}
        cur = {t: None for t in MASTERS}
        for i, (op, _) in enumerate(recs[0]):
            args = [r[i][1] for r in recs]
            if op == "moveTo":
                for t, a in zip(MASTERS, args):
                    masters[t].append([(*place(a[0]), True)])
                    cur[t] = a[0]
            elif op == "lineTo":
                for t, a in zip(MASTERS, args):
                    masters[t][-1].append((*place(a[0]), True))
                    cur[t] = a[0]
            elif op == "curveTo":
                curves = [[cur[t], *a] for t, a in zip(MASTERS, args)]
                quads = curves_to_quadratic(curves, [max_err] * len(curves))
                for t, q in zip(MASTERS, quads):
                    for p in q[1:-1]:
                        masters[t][-1].append((*place(p), False))
                    masters[t][-1].append((*place(q[-1]), True))
                    cur[t] = q[-1]
            elif op in ("closePath", "endPath"):
                pass
            else:
                raise ValueError(f"{ch}: unexpected pen op {op}")
        # CFF closes a contour implicitly; drop a final point that repeats the
        # first (in every master, or in none), and turn CFF's anticlockwise
        # outer contours clockwise.
        for ci in range(len(masters[0.0])):
            if all(_same(masters[t][ci][0], masters[t][ci][-1]) for t in MASTERS):
                for t in MASTERS:
                    masters[t][ci].pop()
            for t in MASTERS:
                c = masters[t][ci]
                masters[t][ci] = [c[0]] + c[1:][::-1]
        out.append(VarGlyph(f"uni{ord(ch):04X}", round(2 * cell), masters, ord(ch)))
    return out


def _same(a, b):
    return abs(a[0] - b[0]) < 1e-6 and abs(a[1] - b[1]) < 1e-6
