#!/usr/bin/env python3
"""Bake Open Sans — the tracker's chrome face — into static fonts.

The tracker sets its chrome in Open Sans at four widths (the `--ui-*font`
stacks in microtone-worker/css/microtone.css). It used to take the variable
font from Google Fonts and pick the width with `font-variation-settings`, but
Google Fonts sniffs the user agent, and WebKitGTK's (the desktop app's
webview on Linux: "Version/60.5 Safari/605.1.15") gets static TTFs at three
named widths — condensed, semi-condensed, normal — with no axes, so every
variation was a no-op there and the chrome came out at full width. So each
width is now a family of its own, built here from the variable sources as
plain static instances — one file per width × weight × style × subset — and
served from microtone-worker/fonts/ (Microtone Touch does not use Open Sans):
the same files whatever the agent, and nothing the page asks for depends on
font variations. (WebKitGTK itself varies a font it is given: measured on
2.52.6, 2026-11-05.)

    python3 opensans.py

writes microtone-worker/fonts/open-sans/*.woff2, its OFL.txt, and
microtone-worker/fonts/open-sans.css (the @font-face rules, imported at the
top of microtone.css). Deterministic: the same sources, table and fontTools
make the same bytes. test/node/opensans-font.test.js pins the result.

A new width or weight is an entry in WIDTHS or WEIGHTS and a rebuild; a width
the stylesheet should use also needs a token in microtone.css's FONT STACKS.

Sources (sources/): OpenSans[wdth,wght].ttf and OpenSans-Italic[wdth,wght].ttf
from github.com/google/fonts, ofl/opensans/ at db398e70ce14 (2023-11-16),
Open Sans 3.003, renamed OpenSans-VF.ttf and OpenSans-Italic-VF.ttf; the
licence is OpenSans-OFL.txt (OFL 1.1, no Reserved Font Name).
"""

from __future__ import annotations

import io
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = Path(__file__).resolve().parent
SOURCES = HERE / "sources"
SITE = HERE.parent.parent / "microtone-worker" / "fonts"
OUT = SITE / "open-sans"
CSS = SITE / "open-sans.css"

# Family suffix → wdth. 86.6667 is the chrome's own width (13/15 of full).
WIDTHS = {
    "W75": 75.0,       # --ui-condensed-font: a picker that must fit twelve digits
    "W87": 86.6667,    # --ui-font: all chrome
    "W96": 96.0,       # --ui-small-font: small text and uppercase captions
    "W100": 100.0,     # --ui-full-font: tab labels, the project title, IPA
}
WEIGHTS = {400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold"}
STYLES = {"normal": "OpenSans-VF.ttf", "italic": "OpenSans-Italic-VF.ttf"}

# Google Fonts' own "latin" subset widened to every Latin letter, IPA, the
# spacing modifiers and the combining marks, so a sound the formant and lyric
# views spell (ŋ̍, ã) is shaped in ONE file — split across two, a mark would
# lose its anchor on the letter. Everything else the font has (Greek,
# Cyrillic, Hebrew, symbols) is the "ext" file, which a page downloads only
# when it shows such a character.
LATIN = ("U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, "
         "U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, "
         "U+2212, U+2215, U+FEFF, U+FFFD, "
         "U+0100-036F, U+1E00-1EFF")


def parse_ranges(text: str) -> set[int]:
    cps: set[int] = set()
    for part in text.split(","):
        lo, _, hi = part.strip()[2:].partition("-")
        cps.update(range(int(lo, 16), int(hi or lo, 16) + 1))
    return cps


def css_ranges(cps: set[int]) -> str:
    runs, start, prev = [], None, None
    for cp in sorted(cps):
        if start is None:
            start = prev = cp
        elif cp == prev + 1:
            prev = cp
        else:
            runs.append((start, prev))
            start = prev = cp
    if start is not None:
        runs.append((start, prev))
    return ", ".join(f"U+{a:04X}" if a == b else f"U+{a:04X}-{b:04X}" for a, b in runs)


def width_class(wdth: float) -> int:
    """OS/2 usWidthClass: the nearest of 75 / 87.5 / 100 / ...% (classes 3, 4, 5)."""
    table = {1: 50, 2: 62.5, 3: 75, 4: 87.5, 5: 100, 6: 112.5, 7: 125, 8: 150, 9: 200}
    return min(table, key=lambda k: abs(table[k] - wdth))


def rename(font: TTFont, family: str, weight: int, italic: bool) -> None:
    wname = WEIGHTS[weight]
    ribbi = weight in (400, 700)
    sub = ("Bold" if weight == 700 else "Regular") if ribbi else "Regular"
    if italic:
        sub = "Bold Italic" if sub == "Bold" else "Italic"
    style = wname + (" Italic" if italic else "")
    if style == "Regular Italic":
        style = "Italic"
    legacy = family if ribbi else f"{family} {wname}"
    ps = (family + "-" + style).replace(" ", "")
    name = font["name"]
    keep = {0, 3, 5, 7, 8, 9, 11, 12, 13, 14}
    name.names = [n for n in name.names if n.nameID in keep]
    for nid, text in ((1, legacy), (2, sub), (4, f"{family} {style}"), (6, ps),
                      (16, family), (17, style)):
        name.setName(text, nid, 3, 1, 0x409)
    unique = f"{name.getDebugName(5).split(';')[0]};{ps}"
    name.setName(unique, 3, 3, 1, 0x409)
    os2, head = font["OS/2"], font["head"]
    os2.usWeightClass = weight
    bold = weight == 700  # the legacy (RIBBI) family's Bold; the rest are "Regular" of their own
    sel = os2.fsSelection & ~0b1100001  # clear ITALIC (0), BOLD (5), REGULAR (6)
    sel |= (1 << 0 if italic else 0) | (1 << 5 if bold else 0) | (1 << 6 if not (italic or bold) else 0)
    os2.fsSelection = sel
    head.macStyle = (1 if bold else 0) | (2 if italic else 0)


def instance(src: Path, wdth: float, weight: int) -> TTFont:
    vf = TTFont(src, recalcTimestamp=False)
    font = instancer.instantiateVariableFont(vf, {"wdth": wdth, "wght": weight}, updateFontNames=False)
    for tag in ("STAT", "DSIG"):
        if tag in font:
            del font[tag]
    return font


def subset_woff2(font: TTFont, unicodes: set[int]) -> bytes:
    buf = io.BytesIO()
    font.save(buf)
    f = TTFont(io.BytesIO(buf.getvalue()), recalcTimestamp=False)
    opts = subset.Options()
    opts.layout_features = ["*"]          # tnum, kern, the lot
    opts.name_IDs = ["*"]
    opts.name_languages = ["*"]
    opts.notdef_outline = True
    opts.glyph_names = False
    opts.hinting = True
    opts.flavor = "woff2"
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=sorted(unicodes))
    sub.subset(f)
    f.flavor = "woff2"
    out = io.BytesIO()
    f.save(out)
    return out.getvalue()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.woff2"):
        old.unlink()
    latin_want = parse_ranges(LATIN)
    rules = []
    total = 0
    for style, srcname in STYLES.items():
        src = SOURCES / srcname
        cmap = set(TTFont(src, lazy=True).getBestCmap())
        parts = {"latin": cmap & latin_want, "ext": cmap - latin_want}
        for suffix, wdth in WIDTHS.items():
            family = f"Open Sans {suffix}"
            for weight in WEIGHTS:
                font = instance(src, wdth, weight)
                rename(font, family, weight, style == "italic")
                font["OS/2"].usWidthClass = width_class(wdth)
                for part, cps in parts.items():
                    file = f"{suffix.lower()}-{weight}{'-italic' if style == 'italic' else ''}-{part}.woff2"
                    data = subset_woff2(font, cps)
                    (OUT / file).write_bytes(data)
                    total += len(data)
                    rules.append(
                        "@font-face {\n"
                        f'  font-family: "{family}";\n'
                        f'  src: url("open-sans/{file}") format("woff2");\n'
                        f"  font-weight: {weight}; font-style: {style}; font-display: swap;\n"
                        f"  unicode-range: {css_ranges(cps)};\n"
                        "}\n")
    (OUT / "OFL.txt").write_bytes((SOURCES / "OpenSans-OFL.txt").read_bytes())
    head = (
        "/* GENERATED by design-system/fonts/opensans.py — never edit by hand.\n"
        " *\n"
        " * Open Sans 3.003 (OFL 1.1, open-sans/OFL.txt) baked into static fonts, one\n"
        " * family per width, the same files for every browser (Google Fonts sends\n"
        " * the Linux desktop webview static files without the widths the app\n"
        " * uses). The stacks that name these families are the --ui-*font tokens in\n"
        " * css/microtone.css:\n"
        + "".join(f' *   "Open Sans {k}"  wdth {v:g}\n' for k, v in WIDTHS.items())
        + f" * Weights {', '.join(map(str, WEIGHTS))}, upright and italic; each split into\n"
        " * a Latin file (with IPA and the combining marks) and an \"ext\" file a page\n"
        " * fetches only when it shows Greek, Cyrillic, Hebrew or a rare symbol. */\n\n")
    CSS.write_text(head + "\n".join(rules), encoding="utf-8")
    print(f"wrote {len(rules)} faces ({total / 1024:.0f} KiB) to {OUT.relative_to(HERE.parent.parent)}, "
          f"and {CSS.relative_to(HERE.parent.parent)}")


if __name__ == "__main__":
    main()
