"""Proof sheets: every variant rendered with HarfBuzz (hb-view) at a few
weights and sizes, stacked into one PNG per font in build/proof/."""

import shutil
import subprocess
import tempfile
from pathlib import Path

PUA = "".join(chr(c) for c in (0xF000, 0xF001, 0xF002, 0xF003, 0xF004, 0xF00C, 0xF00D, 0xF00E, 0xF00F))
DW = "".join(chr(c) for c in range(0xF010, 0xF01B))
SENT = "".join(chr(c) for c in range(0xF030, 0xF034))
WAVES = "".join(chr(c) * 2 + " " for c in range(0xF040, 0xF045))
MUSIC = "\u266F\u266E\u266D\U0001D12A\U0001D12B\U0001D260\U0001D1EB\U0001D1EC\U0001D1ED\U0001D1EE"
LU = "黃大太夾姑仲蕤林夷南無應"

SAMPLES = {
    "motif-grid": [
        "0123456789ABCDEF O0O0 OQDC 0O0",
        "C\uF0104 D\uF0115 E-3 \uF0004C♯4 \uF001D♭3 \uF004E-4",
        PUA + " ·− " + MUSIC,
        DW,
        SENT,
        WAVES,
        LU[:6] + "4 " + LU[6:] + "5",
        "A-4 01 \uF00C20 \uF00E1F E0102 ····· \uF0304 0A",
    ],
    "motif-transport": ["Oct 4  Inst 01  Step 1", "Cue 012 Row 3F BPM 125.0 Spd 06", "O0O0 0123456789ABCDEF"],
    "motif-code": ["fn arp(i, l) { let MmWw = [i, I, l] }", "illustrate Maximum WWW mmm iiii llll",
                   "O0O0 0123456789 ()[]{}<>=+-*/%", "C♯4 D♭3 " + LU[:4]],
    "motif-mono": ["$5000 $1EAB 0x7F Int3 01 ·· C#4", "illustrate Maximum WWW mmm iiii llll",
                   "O0O0 0123456789 ()[]{}<>=+-*/%", "C♯4 D♭3 " + LU[:4]],
    "motif-code-italic": ["fn arp(i, l) { let MmWw = [i, I, l] }", "illustrate Maximum WWW mmm iiii llll",
                          "O0O0 0123456789 ()[]{}<>=+-*/%"],
}

WEIGHTS = (100, 400, 500, 700, 900)


def _render(font, text, size, wght, out):
    subprocess.run(["hb-view", f"--font-size={size}", f"--variations=wght={wght}", "--margin=6",
                    "-o", str(out), str(font), text], check=True)


def render_all(fonts, out_dir):
    if not shutil.which("hb-view"):
        print("  (hb-view not found: no proofs)")
        return
    from PIL import Image, ImageDraw
    out_dir.mkdir(parents=True, exist_ok=True)
    for font in fonts:
        stem = Path(font).stem
        lines = SAMPLES.get(stem, ["The quick brown fox"])
        tiles = []
        with tempfile.TemporaryDirectory() as tmp:
            n = 0
            for wght in WEIGHTS:
                for text in lines:
                    p = Path(tmp) / f"{n}.png"
                    n += 1
                    _render(font, text, 56, wght, p)
                    tiles.append((f"{wght}", Image.open(p).convert("L").copy()))
            for text in lines:
                p = Path(tmp) / f"{n}.png"
                n += 1
                _render(font, text, 14, 400, p)
                tiles.append(("14px", Image.open(p).convert("L").copy()))
        w = max(t.width for _, t in tiles) + 60
        h = sum(t.height for _, t in tiles)
        sheet = Image.new("L", (w, h), 255)
        draw = ImageDraw.Draw(sheet)
        y = 0
        for label, t in tiles:
            draw.text((4, y + 4), label, fill=120)
            sheet.paste(t, (60, y))
            y += t.height
        sheet.save(out_dir / f"{stem}.png")
