#!/usr/bin/env python3
"""The tracker's Korean: Pretendard for Hangul, and a few hanja.

The chrome is Open Sans (opensans.py), which has no Hangul, and Motif has none
either, so Korean used to come out in whatever the platform had — or as boxes
in a desktop build on a machine without a Korean font. Pretendard (OFL 1.1,
Reserved Font Name "Pretendard") now stands behind every font stack in
css/microtone.css, ONLY for Hangul and the CJK punctuation: every other
character keeps the face it had.

    python3 korean.py [--pretendard PKG] [--chiron PATH]

writes microtone-worker/fonts/korean/ and microtone-worker/fonts/korean.css
(the @font-face rules, imported at the top of microtone.css).

- Pretendard ships UNMODIFIED: its own web build's dynamic subset (the
  variable font cut by its author into 92 files by character), so a page
  downloads only the files holding the syllables it shows, and the Reserved
  Font Name is never in question (we neither cut nor rename it). This script
  picks the files that hold Hangul and narrows each one's unicode-range to the
  Hangul part; the files are copied byte for byte. `--pretendard PKG` takes
  them from an unpacked npm package `pretendard` (1.3.9: the tarball's sha256
  is in the README) and refreshes sources/Pretendard-dynamic-subset.css, its
  stylesheet, verbatim; without it the files already in place are kept.
- Pretendard has no hanja, and the interface writes a few (十二律, a language's
  own name, a glossed Korean word). "Microtone Hanja" is those characters cut
  from Chiron Hei HK, the source of Motif's twelve lü (motiffont/cjk.py), kept
  variable (wght 200…900). HANJA below is the list; the font test fails on an
  ideograph in the app's sources that it lacks. `--chiron PATH` refreshes
  sources/ChironHeiHK-hanja.otf from a full ChironHeiHKVF.otf.

Deterministic: the same sources and fontTools make the same bytes.
test/node/korean-font.test.js pins the result.
"""

from __future__ import annotations

import argparse
import io
import re
import shutil
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

HERE = Path(__file__).resolve().parent
SOURCES = HERE / "sources"
SITE = HERE.parent.parent / "microtone-worker" / "fonts"
OUT = SITE / "korean"
CSS = SITE / "korean.css"

PRETENDARD_CSS = SOURCES / "Pretendard-dynamic-subset.css"
PRETENDARD_OFL = SOURCES / "Pretendard-OFL.txt"
CHIRON_CUT = SOURCES / "ChironHeiHK-hanja.otf"
CHIRON_OFL = SOURCES / "ChironHeiHK-LICENSE.md"

# What Pretendard is asked for: Hangul in every form a text may carry it
# (jamo, compatibility jamo, both extensions, the syllables, the enclosed and
# the halfwidth forms) and the CJK symbols and punctuation (「」〈〉 、。).
HANGUL = ("U+1100-11FF, U+3000-303F, U+3130-318F, U+3200-321E, U+3260-327F, "
          "U+A960-A97F, U+AC00-D7A3, U+D7B0-D7FF, U+FFA0-FFDC")

# Every ideograph the app writes outside a note grid (the grids have Motif's
# own lü): the Shi'er lü keymap and notation (十二律, and the twelve lü), the
# translation workbench's example (日本語), a Korean string's gloss (聲道), the
# Korean glossary (數), the Motif reference's example (世界).
HANJA = "十二律黃大太夾姑仲蕤林夷南無應日本語聲道數世界"


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


def upstream_faces(css: str) -> list[tuple[str, set[int]]]:
    """(file name, unicode-range) of each face in Pretendard's stylesheet."""
    faces = []
    for body in re.findall(r"@font-face\s*\{([^}]*)\}", css):
        url = re.search(r"url\(\s*['\"]?([^'\")]+)", body).group(1)
        rng = re.search(r"unicode-range:\s*([^;]+);", body).group(1)
        faces.append((Path(url).name, parse_ranges(rng)))
    return faces


def cut_chiron(src: str) -> None:
    """HANJA out of the full Chiron Hei HK (26 MB), as a small variable font."""
    opts = subset.Options()
    opts.layout_features = []
    opts.name_IDs = ["*"]
    opts.name_languages = ["*"]
    opts.notdef_outline = True
    opts.drop_tables += ["BASE", "VORG", "vhea", "vmtx", "VVAR"]
    font = TTFont(src, recalcTimestamp=False)
    s = subset.Subsetter(opts)
    s.populate(unicodes=[ord(c) for c in HANJA])
    s.subset(font)
    font.save(CHIRON_CUT)


def hanja_woff2() -> bytes:
    font = TTFont(CHIRON_CUT, recalcTimestamp=False)
    missing = [c for c in HANJA if ord(c) not in font.getBestCmap()]
    if missing:
        raise SystemExit(f"{CHIRON_CUT.name} lacks {''.join(missing)}: run with --chiron PATH")
    font.flavor = "woff2"
    out = io.BytesIO()
    font.save(out)
    return out.getvalue()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--pretendard", metavar="PKG", help="an unpacked npm package `pretendard` to take the files from")
    ap.add_argument("--chiron", metavar="PATH", help="the full ChironHeiHKVF.otf to cut the hanja from")
    args = ap.parse_args()

    if args.chiron:
        cut_chiron(args.chiron)
        print(f"  refreshed {CHIRON_CUT.relative_to(HERE)}")
    web = None
    if args.pretendard:
        web = Path(args.pretendard) / "dist" / "web" / "variable"
        shutil.copyfile(web / "pretendardvariable-dynamic-subset.css", PRETENDARD_CSS)
        print(f"  refreshed {PRETENDARD_CSS.relative_to(HERE)}")

    want = parse_ranges(HANGUL)
    pret = OUT / "pretendard"
    pret.mkdir(parents=True, exist_ok=True)
    rules, kept = [], set()
    for name, rng in upstream_faces(PRETENDARD_CSS.read_text(encoding="utf-8")):
        cps = rng & want
        if not cps:
            continue
        dst = pret / name
        if web is not None:
            shutil.copyfile(web / "woff2-dynamic-subset" / name, dst)
        if not dst.exists():
            raise SystemExit(f"{dst} is missing: run with --pretendard PKG")
        cmap = set(TTFont(dst, lazy=True).getBestCmap())
        cps &= cmap       # promise only what the file really holds
        kept.add(name)
        rules.append(
            "@font-face {\n"
            '  font-family: "Pretendard";\n'
            f'  src: url("korean/pretendard/{name}") format("woff2");\n'
            "  font-weight: 45 920; font-style: normal; font-display: swap;\n"
            f"  unicode-range: {css_ranges(cps)};\n"
            "}\n")
    for old in pret.glob("*.woff2"):
        if old.name not in kept:
            old.unlink()
    shutil.copyfile(PRETENDARD_OFL, pret / "OFL.txt")

    (OUT / "hanja.woff2").write_bytes(hanja_woff2())
    shutil.copyfile(CHIRON_OFL, OUT / "OFL-hanja.md")
    rules.append(
        "@font-face {\n"
        '  font-family: "Microtone Hanja";\n'
        '  src: url("korean/hanja.woff2") format("woff2");\n'
        "  font-weight: 200 900; font-style: normal; font-display: swap;\n"
        f"  unicode-range: {css_ranges({ord(c) for c in HANJA})};\n"
        "}\n")

    head = (
        "/* GENERATED by design-system/fonts/korean.py — never edit by hand.\n"
        " *\n"
        " * \"Pretendard\": Pretendard 1.3.9 (OFL 1.1, Reserved Font Name Pretendard;\n"
        " * korean/pretendard/OFL.txt), its author's own dynamic-subset files,\n"
        " * unmodified, each narrowed here to the Hangul and CJK punctuation it\n"
        " * holds — a page fetches only the files for the syllables it shows.\n"
        " * \"Microtone Hanja\": the few ideographs the interface writes, cut from\n"
        " * Chiron Hei HK (OFL 1.1; korean/OFL-hanja.md).\n"
        " * Both stand behind every font stack in css/microtone.css. */\n\n")
    CSS.write_text(head + "\n".join(rules), encoding="utf-8")
    total = sum(p.stat().st_size for p in OUT.rglob("*.woff2"))
    print(f"  {len(kept)} Pretendard files + hanja.woff2, {total / 1e6:.2f} MB → {CSS.relative_to(HERE.parent.parent)}")


if __name__ == "__main__":
    main()
