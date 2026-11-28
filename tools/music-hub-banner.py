#!/usr/bin/env python3
"""The Microtone Music Hub's 88x31 web button (item 386).

    python3 tools/music-hub-banner.py   (from the repo root; needs Pillow)

writes microtone-worker/assets/site_banners/musichub.gif, the sibling of
microtone.gif beside it: same frame, same ground, and the SAME wordmark — its
pixels are lifted from microtone.gif's last frame, so the two buttons can never
spell "Microtone" differently. The story is the Hub's: level meters bounce (the
radio is on), a playhead sweeps the wordmark in, then a seek bar fills while
the caption runs through what the Hub is for and ends on its address.

Colours are the dark theme's tokens (css/microtone.css); the captions are a
5-pixel font drawn here, since nothing antialiased stays legible at 4 px a
character, and the address needs that to fit. Deterministic: no clock, no
unseeded randomness — rerunning writes the same bytes.
"""
import random
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
BANNERS = ROOT / "microtone-worker" / "assets" / "site_banners"
W, H = 88, 31

def rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))

BG = rgb("#16181d")        # --bg
BORDER = rgb("#404655")    # --border
FG = rgb("#e2e5eb")        # --fg
AMBER = rgb("#ffc043")     # --accent
BLUE = rgb("#78dce7")      # --accent-2
GREEN = rgb("#8be400")     # --meter
TROUGH = rgb("#2a2f3a")    # --meter-bg
BRAND = rgb("#ff4362")     # --brand

# ── the captions' font: 5 rows; lowercase x-height 4 (rows 1-4) ──
GLYPHS = {
    "A": [".#.", "#.#", "###", "#.#", "#.#"],
    "B": ["##.", "#.#", "##.", "#.#", "##."],
    "C": [".##", "#..", "#..", "#..", ".##"],
    "D": ["##.", "#.#", "#.#", "#.#", "##."],
    "E": ["###", "#..", "##.", "#..", "###"],
    "G": [".##", "#..", "#.#", "#.#", ".##"],
    "H": ["#.#", "#.#", "###", "#.#", "#.#"],
    "I": ["###", ".#.", ".#.", ".#.", "###"],
    "L": ["#..", "#..", "#..", "#..", "###"],
    "M": ["#...#", "##.##", "#.#.#", "#...#", "#...#"],
    "N": ["#..#", "##.#", "#.##", "#..#", "#..#"],
    "O": [".#.", "#.#", "#.#", "#.#", ".#."],
    "R": ["##.", "#.#", "##.", "#.#", "#.#"],
    "S": [".##", "#..", ".#.", "..#", "##."],
    "T": ["###", ".#.", ".#.", ".#.", ".#."],
    "U": ["#.#", "#.#", "#.#", "#.#", "###"],
    "W": ["#...#", "#...#", "#.#.#", "##.##", "#...#"],
    "X": ["#.#", "#.#", ".#.", "#.#", "#.#"],
    "Y": ["#.#", "#.#", ".#.", ".#.", ".#."],
    "c": ["..", ".#", "#.", "#.", ".#"],
    "e": ["...", ".#.", "###", "#..", ".##"],
    "i": ["#", ".", "#", "#", "#"],
    "m": [".....", "####.", "#.#.#", "#.#.#", "#.#.#"],
    "n": ["...", "##.", "#.#", "#.#", "#.#"],
    "o": ["...", ".#.", "#.#", "#.#", ".#."],
    "r": ["..", "#.", "##", "#.", "#."],
    "s": ["..", ".#", "#.", ".#", "#."],
    "t": [".#.", "###", ".#.", ".#.", "..#"],
    "u": ["...", "#.#", "#.#", "#.#", ".##"],
    ".": [".", ".", ".", ".", "#"],
    " ": ["..", "..", "..", "..", ".."],
}
def text_width(s):
    return sum(len(GLYPHS[ch][0]) for ch in s) + len(s) - 1

def draw_text(px, s, y, colour):
    x = (W - text_width(s)) // 2
    for ch in s:
        g = GLYPHS[ch]
        for r, row in enumerate(g):
            for c, bit in enumerate(row):
                if bit == "#":
                    px[x + c, y + r] = colour
        x += len(g[0]) + 1

# ── the pieces ──

def blank():
    im = Image.new("RGB", (W, H), BG)
    px = im.load()
    for x in range(W):
        px[x, 0] = px[x, H - 1] = BORDER
    for y in range(H):
        px[0, y] = px[W - 1, y] = BORDER
    return im

WORDMARK_ROWS = (3, 16)   # microtone.gif's wordmark: rows 4-14, a row of ground round it

def wordmark():
    src = Image.open(BANNERS / "microtone.gif")
    src.seek(src.n_frames - 1)
    src = src.convert("RGB")
    return src.crop((1, WORDMARK_ROWS[0], W - 1, WORDMARK_ROWS[1]))

BAR_Y, BAR_X0, BAR_X1 = 17, 5, 83        # the seek bar: rows 17-18, under the wordmark
TEXT_Y = 22                              # captions: rows 22-26

def layout(mark, caption, colour, filled):
    """The settled button: wordmark, seek bar `filled` of 1, caption."""
    im = blank()
    im.paste(mark, (1, WORDMARK_ROWS[0]))
    px = im.load()
    edge = BAR_X0 + round(filled * (BAR_X1 - BAR_X0 + 1))
    for x in range(BAR_X0, BAR_X1 + 1):
        c = BRAND if x < edge else TROUGH
        px[x, BAR_Y] = px[x, BAR_Y + 1] = c
    if caption:
        draw_text(px, caption, TEXT_Y, colour)
    return im

# Level meters: 13 columns of 5 px, LED segments 2 px tall with a 1 px gap.
COLS, COL_W, COL_GAP = 13, 5, 1
SEG_TOP, SEG_BOTTOM = 3, 27
SEGS = (SEG_BOTTOM - SEG_TOP + 2) // 3          # 8

def seg_colour(k):
    if k >= SEGS - 1:
        return BRAND
    if k >= SEGS - 3:
        return AMBER
    return GREEN

def meters(levels):
    im = blank()
    px = im.load()
    x0 = (W - (COLS * (COL_W + COL_GAP) - COL_GAP)) // 2
    for col, level in enumerate(levels):
        x = x0 + col * (COL_W + COL_GAP)
        for k in range(SEGS):
            yb = SEG_BOTTOM - 3 * k
            c = seg_colour(k) if k < level else TROUGH
            for dx in range(COL_W):
                px[x + dx, yb] = px[x + dx, yb - 1] = c
    return im

def meter_levels(n, seed=386):
    """n frames of levels: a bass-heavy spectrum that breathes, seeded."""
    rng = random.Random(seed)
    lv = [3] * COLS
    out = []
    for f in range(n):
        nxt = []
        for col in range(COLS):
            tilt = 1.6 - col / (COLS - 1)          # lows sit higher
            target = 2 + tilt * 3 + rng.uniform(-2.2, 2.6)
            if f % 4 == 0 and col < 4:
                target += 2.5                      # a kick on the beat
            v = round((lv[col] + 2 * target) / 3)
            nxt.append(max(1, min(SEGS, v)))
        lv = nxt
        out.append(lv)
    return out

# ── the film ──

CAPTIONS = [                 # (text, colour, ms)
    ("MUSIC HUB", FG, 1100),
    ("LISTEN", AMBER, 500),
    ("DOWNLOAD", AMBER, 500),
    ("REMIX", AMBER, 500),
    ("ANY TUNING", GREEN, 800),
    ("music.microtone.cc", BLUE, 2400),
]
TICK = 100                   # the seek bar moves every 100 ms

def film():
    mark = wordmark()
    frames = []
    levels = meter_levels(26)
    for lv in levels[:14]:                       # the radio is on
        frames.append((meters(lv), 80))
    sweep = list(range(2, W - 1, 6)) + [W - 2]   # the playhead
    first = layout(mark, CAPTIONS[0][0], CAPTIONS[0][1], 0)
    for i, ph in enumerate(sweep):
        im = meters(levels[14 + i % 12])
        im.paste(first.crop((1, 1, ph, H - 1)), (1, 1))
        px = im.load()
        for y in range(1, H - 1):
            px[ph, y] = BRAND
        frames.append((im, 40))
    total = sum(ms for _, _, ms in CAPTIONS)
    t = 0
    for text, colour, ms in CAPTIONS:
        for k in range(0, ms, TICK):
            frames.append((layout(mark, text, colour, min(1, (t + k) / total)), min(TICK, ms - k)))
        t += ms
    last, ms = frames[-1]
    frames[-1] = (layout(mark, CAPTIONS[-1][0], CAPTIONS[-1][1], 1), ms)
    return frames

def merge(frames):
    """Fold identical neighbours into one longer frame."""
    out = []
    for im, ms in frames:
        if out and out[-1][0].tobytes() == im.tobytes():
            out[-1] = (out[-1][0], out[-1][1] + ms)
        else:
            out.append((im, ms))
    return out

def main():
    frames = merge(film())
    colours = sorted({c for im, _ in frames for _, c in im.getcolors(4096)})
    assert len(colours) <= 256, len(colours)
    size = 2
    while size < len(colours):
        size *= 2
    pal = Image.new("P", (1, 1))
    flat = [v for c in colours for v in c]
    pal.putpalette(flat + [0] * (3 * size - len(flat)))   # one global table, no padding to 256
    index = {c: i for i, c in enumerate(colours)}
    images = []
    for im, _ in frames:                 # exact indices: quantize() snaps to near shades
        p = Image.frombytes("P", (W, H), bytes(index[c] for c in zip(*[iter(im.tobytes())] * 3)))
        p.putpalette(pal.getpalette())
        images.append(p)
    out = BANNERS / "musichub.gif"
    images[0].save(out, save_all=True, append_images=images[1:],
                   duration=[ms for _, ms in frames], loop=0, optimize=False, disposal=1,
                   palette=bytes(pal.getpalette()[:3 * size]))   # else a table per frame
    print(f"{out.relative_to(ROOT)}: {len(images)} frames, "
          f"{sum(ms for _, ms in frames)} ms, {out.stat().st_size} bytes")

if __name__ == "__main__":
    main()
