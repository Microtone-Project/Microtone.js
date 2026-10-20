#!/usr/bin/env python3
"""Build the Motif fonts (item 220): Chivo Mono made into Microtone's
tracker-grid, transport and code faces.

    python3 build.py                 build every variant, then the proofs
    python3 build.py --no-proof      …without the proofs
    python3 build.py --chiron PATH   refresh sources/ChironHeiHK-lu.otf from
                                     the full Chiron Hei HK variable font

Needs Python 3.11+ and fontTools (with brotli for WOFF2); the proofs need
hb-view (HarfBuzz). See README.md. The faces themselves are made in
motiffont/faces.py; this writes them where Microtone serves them.
"""

import argparse
import sys
import tomllib
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from motiffont import assemble, cjk, faces  # noqa: E402

SOURCES = HERE / "sources"
OUT = HERE.parent.parent / "core" / "fonts"
BUILD = HERE / "build"

ASCII = list(range(0x20, 0x7F))
MIDDOT, MINUS = 0x00B7, 0x2212


def load_config():
    with open(HERE / "motif.toml", "rb") as f:
        return tomllib.load(f)


def save(font, file_stem, label):
    """The face's .woff2 into core/fonts/, its .ttf into build/."""
    OUT.mkdir(parents=True, exist_ok=True)
    BUILD.mkdir(parents=True, exist_ok=True)
    ttf = BUILD / f"{file_stem}.ttf"
    woff2 = OUT / f"{file_stem}.woff2"
    assemble.save(font, ttf, woff2)
    print(f"  {label}: {len(font.getGlyphOrder())} glyphs, "
          f"{woff2.stat().st_size} bytes → {woff2.relative_to(HERE.parent.parent)}")
    return ttf


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-proof", action="store_true")
    ap.add_argument("--chiron", metavar="PATH", help="the full ChironHeiHKVF.otf to take the lü from")
    args = ap.parse_args()
    cfg = load_config()
    if args.chiron:
        chiron = SOURCES / faces.CHIRON_SUBSET
        cjk.subset_chiron(args.chiron, chiron)
        print(f"  refreshed {chiron.relative_to(HERE)}")
    built = []
    built.append(save(faces.build_monospaced(cfg, SOURCES, "Motif Grid", ASCII + [MIDDOT, MINUS],
                                             1 + cfg["grid"]["widen"] / 100, cfg["grid"]["margin"],
                                             faces.grid_extra(cfg), cfg["grid"]["centred"], natural2=True),
                      "motif-grid", "Motif Grid"))
    built.append(save(faces.build_monospaced(cfg, SOURCES, "Motif Transport", ASCII,
                                             1 - cfg["transport"]["narrow"] / 100, 0, lambda src, cell: []),
                      "motif-transport", "Motif Transport"))
    built.append(save(faces.build_code(cfg, SOURCES, italic=False), "motif-code", "Motif Code"))
    built.append(save(faces.build_code(cfg, SOURCES, italic=True), "motif-code-italic", "Motif Code Italic"))
    built.append(save(faces.build_code(cfg, SOURCES, italic=False, mono=True), "motif-mono", "Motif Mono"))
    (OUT / "OFL.txt").write_text((HERE / "OFL.txt").read_text())
    if not args.no_proof:
        from motiffont import proof
        proof.render_all(built, BUILD / "proof")
        print(f"  proofs in {(BUILD / 'proof').relative_to(HERE)}")


if __name__ == "__main__":
    main()
