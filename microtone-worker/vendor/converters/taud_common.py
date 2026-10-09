"""taud_common.py — Shared constants and helpers for *2taud converters.

Imported by s3m2taud.py, it2taud.py, and mod2taud.py. Holds the Taud
container constants, the effect-letter index table, and the small set
of helpers (sample resampler, vol/pan column packer, cue encoder,
pattern deduper, sample normaliser) that all three converters used to
duplicate verbatim.
"""

import gzip as _gzip
import math
import struct
import sys

try:
    import zstandard as _zstd
    _ZSTD_CCTX = _zstd.ZstdCompressor(level=22)
except ImportError:
    _ZSTD_CCTX = None


# ── Verbose logging (shared across converters via set_verbose) ───────────────

VERBOSE = False

def set_verbose(b: bool) -> None:
    global VERBOSE
    VERBOSE = bool(b)

def vprint(*a, **kw) -> None:
    if VERBOSE:
        print(*a, **kw, file=sys.stderr)


# ── Compression (gzip vs zstd; whichever is smaller) ─────────────────────────
#
# The Taud loader sniffs the 4-byte magic of every compressed slot and routes
# to GZIPInputStream or ZstdInputStream accordingly (CompressorDelegate.kt:148-149),
# so each blob can independently pick whichever codec compresses it smaller.

def best_compress(payload: bytes) -> tuple:
    """Return (compressed_bytes, method) for the smaller of gzip/zstd output.

    Method is "gzip" or "zstd". Falls back to gzip when the `zstandard`
    package is not installed.
    """
    gz = _gzip.compress(payload, compresslevel=9, mtime=0)
    if _ZSTD_CCTX is None:
        return gz, "gzip"
    zs = _ZSTD_CCTX.compress(payload)
    if len(zs) < len(gz):
        return zs, "zstd"
    return gz, "gzip"


def compress_blob(payload: bytes, label: str) -> bytes:
    """Compress `payload` with whichever of gzip/zstd is smaller; vprint stats; return bytes.

    `label` is the human-readable name in the verbose log line, e.g. "sample+inst bin".
    """
    out, method = best_compress(payload)
    vprint(f"  {label}: {len(payload)} → {len(out)} bytes ({method})")
    return out


# ── Taud container constants ─────────────────────────────────────────────────

TAUD_MAGIC       = bytes([0x1F,0x54,0x53,0x56,0x4D,0x61,0x75,0x64])
# Format version carried in the low six bits of the version byte (top two = kind).
#   1 → legacy cue sheet (20 voices, 12-bit pattern numbers, 32-byte cues).
#   2 → extended cue sheet (2026-07-01): 32 voices, 15-bit pattern numbers, 64-byte
#       cues with sign-bit instructions; song-table reserved[0:2] carries the cue
#       count. See terranmon.txt §"Cue sheet". Loaders branch on this to pick the
#       cue-image layout; a v1 file must be re-converted for full 32-channel range.
TAUD_VERSION     = 2
TAUD_HEADER_SIZE = 32       # magic(8)+ver(1)+numSongs(1)+compSize(4)+projOff(4)+sig(14)
TAUD_SONG_ENTRY  = 32       # full spec entry (see encode_song_entry)

# Container kind = top two bits of the version byte (terranmon.txt §.tsii / §.tpif,
# 3342-3401). The low six bits always carry TAUD_VERSION, so the full version byte
# is `kind | TAUD_VERSION`.
#   00 → full song file (.taud): sample+inst image + song table + patterns
#   10 → sample+instrument image (.tsii): numSongs = 0, no song table/patterns;
#        project data carries only I*/S* blocks (INam, SNam, Ixmp)
#   11 → pattern image (.tpif): sample+inst compSize = 0 (section absent), song
#        table + patterns present; project data carries only p*/s* blocks (pNam, sMet)
TAUD_KIND_FULL       = 0x00
TAUD_KIND_SAMPLEINST = 0x80
TAUD_KIND_PATTERN    = 0xC0
INST_RECORD_SIZE = 256      # widened 2026-05-06 (was 192). 256 inst × 256 = 64K.
# Sample+instrument image (terranmon.txt:1985-1997, 2533-2564 — updated 2026-05-08).
# Sample pool is now 8 MB, banked through MMIO 46 in 16 × 512 K windows.
# Converters write the pool bank-major (bank 0's 512 K first, then bank 1's, ...);
# the runtime decompresses the whole blob straight into native peripheral storage,
# so converters just lay out an 8 MB linear array as if banking didn't exist.
SAMPLE_BANK_SIZE = 524288               # 512 K per bank
SAMPLE_BANK_COUNT = 16                  # 16 banks × 512 K = 8 MB
SAMPLEBIN_SIZE   = SAMPLE_BANK_SIZE * SAMPLE_BANK_COUNT   # 8 MB
# 1024 instrument records: 0..255 = directly-addressable bin $00..$FF, 256..1023 =
# auxiliary bin $100..$3FF (Metainstrument-layer-only; terranmon.txt:2036-2044, 2026-07-01).
# The aux bin is exposed in-hardware through a banked 64K window (MMIO 48 = bank 0..2), but
# the file image is a flat 1024-record array uploaded straight into instruments[].
INSTBIN_SIZE     = INST_RECORD_SIZE * 1024   # 262144 = 256K
SAMPLEINST_SIZE  = SAMPLEBIN_SIZE + INSTBIN_SIZE          # 8650752 = 8448 kB
PATTERN_ROWS     = 64
PATTERN_BYTES    = PATTERN_ROWS * 8     # 512
# Extended cue sheet (terranmon.txt §"Cue sheet", 2026-07-01). Pattern numbers are now
# 15-bit (0..0x7FFE; 0x7FFF = "no pattern on this channel"), so a song may carry up to
# 32767 distinct patterns. Cues are 64 bytes = 32 little-endian Sint16 (one per channel);
# the sign bits encode two per-cue instruction words. The engine holds 8192 cues (4 banks).
NUM_PATTERNS_MAX = 32767            # max distinct patterns (indices 0..32766)
NUM_CUES         = 8192            # 4 banks × 2048 cues (32-channel mode)
CUE_SIZE         = 64             # bytes per cue entry (32 × Sint16)
NUM_VOICES       = 32
CUE_EMPTY        = 0x7FFF          # pattern-number sentinel: no pattern on this channel
# 64-channel mode (terranmon.txt §xHDR / :2039-2053): a cue spans two 64-byte "rows" =
# 128 bytes / 64 channels, so a 128 K bank holds 1024 cues (4096 total). Instruction words
# still ride the sign bits of channels 0..31 (row 0); channels 32..63 carry none. The mode
# is signalled by an xHDR Project-Data section (Flags1 bit 0) and the version byte's bit 5.
MAX_VOICES       = 64
CUE_SIZE_64      = 128            # bytes per cue entry (64 × Sint16)
NUM_CUES_64      = 4096           # 4 banks × 1024 cues (64-channel mode)
XHDR_FLAG        = 0x20           # version byte bit 5: Project Data carries an xHDR section

# Per-sample length cap. Taud instrument records carry the sample length as
# a u16 (terranmon.txt:2001+ — bytes 4..5), so any single sample must fit in
# 65535 bytes. Converters resample over-long samples individually after the
# global pool-overflow pass and rescale the affected channel's TOP_O args.
SAMPLE_LEN_LIMIT = 65535

# Note word sentinels
NOTE_NOP    = 0x0000
NOTE_KEYOFF = 0x0001
NOTE_CUT    = 0x0002
NOTE_NOTEFADE = 0x0003   # IT Note Fade ("~~~"): CHN_NOTEFADE — fade by instrument fadeout, sustain kept
NOTE_FASTFADE = 0x0004   # ~0.3 s note-fade (SF2 exclusiveClass choke; fluid_voice_kill_excl)
TAUD_C4     = 0x5000   # The audio engine's Middle C

# Cue sheet instruction byte (cue offset 30; offset 31 = arg byte for 2-byte forms).
# Per terranmon.txt §"Cue Sheet":
#   00000010 00xxxxxx (LEN)    pattern length: rows = (xxxxxx) + 1, range 1..64
#   00000001 00000000 (HALT)   play the full pattern then stop (end of song)
#   00000001 01xxxxxx (HALT x) play x rows then stop (x = 0 ⇒ full length)
#   00000000          (NOP)    default 64-row cue
#   1000xxxx yyyyyyyy (BAK)    go back 12-bit arg
#   1001xxxx yyyyyyyy (FWD)    skip forward 12-bit arg
#   1111xxxx yyyyyyyy (JMP)    go to absolute pattern
CUE_INST_NOP  = 0x00
CUE_INST_HALT = 0x01
CUE_INST_LEN  = 0x02

# Taud effect opcodes (base-36: 0..9 → 0x00..0x09, A..Z → 0x0A..0x23)
TOP_NONE = 0x00
TOP_A    = 0x0A
TOP_B    = 0x0B
TOP_C    = 0x0C
TOP_D    = 0x0D
TOP_E    = 0x0E
TOP_F    = 0x0F
TOP_G    = 0x10
TOP_H    = 0x11
TOP_I    = 0x12
TOP_J    = 0x13
TOP_K    = 0x14
TOP_L    = 0x15
TOP_M    = 0x16
TOP_N    = 0x17
TOP_O    = 0x18
TOP_P    = 0x19
TOP_Q    = 0x1A
TOP_R    = 0x1B
TOP_S    = 0x1C
TOP_T    = 0x1D
TOP_U    = 0x1E
TOP_V    = 0x1F
TOP_W    = 0x20
TOP_Y    = 0x22

# The tempo register: ten bits biased by -25 (song table byte 7, byte 8 bit 7,
# byte 28 bit 7), so 25..1048 BPM (TAUD_FILE_FORMAT.md §4).
TAUD_BPM_MIN = 25
TAUD_BPM_MAX = 25 + 0x3FF


def tempo_effect_arg(bpm: int) -> int:
    """Argument of the `T` effect that sets `bpm` (TAUD_NOTE_EFFECTS.md §T).

    `T $xx00` sets 26..280. Above that, `T $FFxx`..`T $FCxx` with a NON-ZERO xx
    each carry on where the one above stops: $FF 281..535, $FE 536..790,
    $FD 791..1045, $FC 1046..1048. 25 BPM itself has no set form ($0000 is an
    empty tempo slide), so it comes out as that no-op, as it always has."""
    bpm = max(TAUD_BPM_MIN, min(TAUD_BPM_MAX, int(bpm)))
    if bpm <= 280:
        return ((bpm - 25) & 0xFF) << 8
    k = (bpm - 281) // 255
    return ((0xFF - k) << 8) | (bpm - 280 - 255 * k)


# Volume / pan column selectors (2-bit field at top of vol/pan byte)
SEL_SET  = 0     # 6-bit value: set vol / pan
SEL_UP   = 1     # 6-bit per-tick slide up / right
SEL_DOWN = 2     # 6-bit per-tick slide down / left
SEL_FINE = 3     # 1-bit dir + 5-bit magnitude, fired on tick 0

# 12-TET semitone → Taud J-arpeggio byte (high byte of pitch delta).
# byte = round(semitone * 4096 / 12 / 256) = round(semitone * 4 / 3).
J_SEMI_TABLE = [0x00, 0x01, 0x03, 0x04, 0x05, 0x07, 0x08, 0x09,
                0x0B, 0x0C, 0x0D, 0x0F, 0x10, 0x11, 0x13, 0x14]

# Effect-letter indices (1-based; A=1..Z=26). Shared by s3m2taud and it2taud.
EFF_A = 1;  EFF_B = 2;  EFF_C = 3;  EFF_D = 4;  EFF_E = 5
EFF_F = 6;  EFF_G = 7;  EFF_H = 8;  EFF_I = 9;  EFF_J = 10
EFF_K = 11; EFF_L = 12; EFF_M = 13; EFF_N = 14; EFF_O = 15
EFF_P = 16; EFF_Q = 17; EFF_R = 18; EFF_S = 19; EFF_T = 20
EFF_U = 21; EFF_V = 22; EFF_W = 23; EFF_X = 24; EFF_Y = 25
EFF_Z = 26


# ── Envelope offset minifloat ────────────────────────────────────────────────
#
# Mirror of tsvm_core/.../ThreeFiveMinifloat.kt — used by every *2taud
# converter that emits envelope nodes. 3.5 unsigned minifloat (3-bit exponent
# + 5-bit mantissa) rebiased so the smallest non-zero step is 1/256 s ≈ 3.91
# ms and the maximum is 15.75 s. The previous bias (1/32-step, max 126 s)
# under-resolved single-tick deltas at typical tracker BPMs. Every value here
# is the original LUT divided by 8.

MINUFLOAT_LUT = (
    0.0, 0.00390625, 0.0078125, 0.01171875, 0.015625, 0.01953125, 0.0234375, 0.02734375,
    0.03125, 0.03515625, 0.0390625, 0.04296875, 0.046875, 0.05078125, 0.0546875, 0.05859375,
    0.0625, 0.06640625, 0.0703125, 0.07421875, 0.078125, 0.08203125, 0.0859375, 0.08984375,
    0.09375, 0.09765625, 0.1015625, 0.10546875, 0.109375, 0.11328125, 0.1171875, 0.12109375,
    0.125, 0.12890625, 0.1328125, 0.13671875, 0.140625, 0.14453125, 0.1484375, 0.15234375,
    0.15625, 0.16015625, 0.1640625, 0.16796875, 0.171875, 0.17578125, 0.1796875, 0.18359375,
    0.1875, 0.19140625, 0.1953125, 0.19921875, 0.203125, 0.20703125, 0.2109375, 0.21484375,
    0.21875, 0.22265625, 0.2265625, 0.23046875, 0.234375, 0.23828125, 0.2421875, 0.24609375,
    0.25, 0.2578125, 0.265625, 0.2734375, 0.28125, 0.2890625, 0.296875, 0.3046875,
    0.3125, 0.3203125, 0.328125, 0.3359375, 0.34375, 0.3515625, 0.359375, 0.3671875,
    0.375, 0.3828125, 0.390625, 0.3984375, 0.40625, 0.4140625, 0.421875, 0.4296875,
    0.4375, 0.4453125, 0.453125, 0.4609375, 0.46875, 0.4765625, 0.484375, 0.4921875,
    0.5, 0.515625, 0.53125, 0.546875, 0.5625, 0.578125, 0.59375, 0.609375,
    0.625, 0.640625, 0.65625, 0.671875, 0.6875, 0.703125, 0.71875, 0.734375,
    0.75, 0.765625, 0.78125, 0.796875, 0.8125, 0.828125, 0.84375, 0.859375,
    0.875, 0.890625, 0.90625, 0.921875, 0.9375, 0.953125, 0.96875, 0.984375,
    1.0, 1.03125, 1.0625, 1.09375, 1.125, 1.15625, 1.1875, 1.21875,
    1.25, 1.28125, 1.3125, 1.34375, 1.375, 1.40625, 1.4375, 1.46875,
    1.5, 1.53125, 1.5625, 1.59375, 1.625, 1.65625, 1.6875, 1.71875,
    1.75, 1.78125, 1.8125, 1.84375, 1.875, 1.90625, 1.9375, 1.96875,
    2.0, 2.0625, 2.125, 2.1875, 2.25, 2.3125, 2.375, 2.4375,
    2.5, 2.5625, 2.625, 2.6875, 2.75, 2.8125, 2.875, 2.9375,
    3.0, 3.0625, 3.125, 3.1875, 3.25, 3.3125, 3.375, 3.4375,
    3.5, 3.5625, 3.625, 3.6875, 3.75, 3.8125, 3.875, 3.9375,
    4.0, 4.125, 4.25, 4.375, 4.5, 4.625, 4.75, 4.875,
    5.0, 5.125, 5.25, 5.375, 5.5, 5.625, 5.75, 5.875,
    6.0, 6.125, 6.25, 6.375, 6.5, 6.625, 6.75, 6.875,
    7.0, 7.125, 7.25, 7.375, 7.5, 7.625, 7.75, 7.875,
    8.0, 8.25, 8.5, 8.75, 9.0, 9.25, 9.5, 9.75,
    10.0, 10.25, 10.5, 10.75, 11.0, 11.25, 11.5, 11.75,
    12.0, 12.25, 12.5, 12.75, 13.0, 13.25, 13.5, 13.75,
    14.0, 14.25, 14.5, 14.75, 15.0, 15.25, 15.5, 15.75,
)


def nearest_minifloat(sec: float) -> int:
    """Return the ThreeFiveMiniUfloat index (0..255) for the LUT entry nearest to `sec`."""
    if sec <= 0.0:
        return 0
    if sec >= MINUFLOAT_LUT[-1]:
        return 255
    lo, hi = 0, len(MINUFLOAT_LUT) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if MINUFLOAT_LUT[mid] < sec:
            lo = mid + 1
        else:
            hi = mid
    if lo > 0 and abs(MINUFLOAT_LUT[lo - 1] - sec) < abs(MINUFLOAT_LUT[lo] - sec):
        return lo - 1
    return lo


# ── Helpers ──────────────────────────────────────────────────────────────────

def d_arg_to_col(arg: int):
    """Convert a two-nibble D-style vol/pan slide arg into a column override.

    Returns (selector, value) or None for no-op. Volume column treats
    selector 1 as up / 2 as down; pan column reuses 1 = right, 2 = left.
    Both-nibbles-non-zero (and neither $F) is ambiguous; ST3/PT/IT all
    prefer up.
    """
    if arg == 0:
        return None
    hi = (arg >> 4) & 0xF
    lo = arg & 0xF
    if hi == 0xF and lo > 0:
        return (SEL_FINE, lo & 0x1F)              # fine slide down (dir bit 0)
    if lo == 0xF and hi > 0:
        return (SEL_FINE, (hi & 0x1F) | 0x20)     # fine slide up (dir bit 1)
    if hi > 0 and lo == 0:
        return (SEL_UP, hi)
    if lo > 0 and hi == 0:
        return (SEL_DOWN, lo)
    return (SEL_UP, hi)


_SINC_TABLE_CACHE = {}
_KAISER_BETA = 8.0          # ~-70 dB stop-band, near-flat pass-band to the corner

def _bessel_i0(x: float) -> float:
    """Modified Bessel function of the first kind, order 0 (for the Kaiser window)."""
    s = 1.0
    t = 1.0
    k = 1
    while True:
        t *= (x * x) / (4.0 * k * k)
        s += t
        if t < 1e-12 * s:
            return s
        k += 1

def _windowed_sinc_table(cutoff: float, half_width: int, phases: int):
    """Precompute a polyphase Kaiser-windowed-sinc kernel.

    `cutoff` is the low-pass corner in cycles/input-sample (<= 0.5); for a
    downsample it is half the TARGET rate so the kernel doubles as the
    anti-alias filter. Each of `phases` sub-sample positions gets a row of
    `2*half_width` taps, DC-normalised to unity gain so a constant signal
    (e.g. the u8 128 silence bias, or any DC offset) passes through unchanged.
    Cached: the same (cutoff, width, phases) recurs across a whole sample pool.
    """
    key = (round(cutoff, 6), half_width, phases)
    cached = _SINC_TABLE_CACHE.get(key)
    if cached is not None:
        return cached
    n_taps = 2 * half_width
    inv_i0 = 1.0 / _bessel_i0(_KAISER_BETA)
    table  = []
    for p in range(phases):
        frac = p / phases
        row  = [0.0] * n_taps
        s    = 0.0
        for k in range(n_taps):
            t = k - (half_width - 1)            # tap index relative to left sample
            x = t - frac                        # distance from the output position
            a = 2.0 * cutoff * x
            sinc = 1.0 if a == 0.0 else math.sin(math.pi * a) / (math.pi * a)
            # Kaiser window over [-half_width, +half_width]
            r   = x / half_width                # -1..1
            win = _bessel_i0(_KAISER_BETA * math.sqrt(max(0.0, 1.0 - r * r))) * inv_i0
            c = sinc * win
            row[k] = c
            s += c
        inv = 1.0 / s if s else 1.0
        table.append([c * inv for c in row])
    _SINC_TABLE_CACHE[key] = table
    return table


def resample_bandlimited(data: bytes, ratio: float) -> bytes:
    """Resample u8 bytes by `ratio` (< 1 = downsample) with a band-limited
    windowed-sinc kernel.

    Replaces the old linear interpolator, whose triangular kernel has a sinc^2
    response that rolled off the top octave (~3.4 dB @ 15 kHz, worse near the
    source Nyquist) and audibly muffled bright percussion and any SF2 sample
    downsampled to the 65535-frame / 32 kHz fit — e.g. the GeneralUser-GS open
    hi-hat, ~3.6% spectral-centroid loss on a single pass, compounding on the
    sub-32 kHz fit and 8 MB-pool re-resample paths. The windowed sinc stays
    flat to the post-resample Nyquist and anti-aliases on the way down (cutoff
    follows `ratio`). DC-normalised so the u8 128 bias is preserved; output is
    CLAMPED (not wrapped like the old `& 0xFF`) because sinc ringing can
    overshoot 0..255.
    """
    if not data or ratio == 1.0:
        return data
    n_in  = len(data)
    n_out = max(1, int(n_in * ratio))
    cutoff = 0.5 * min(1.0, ratio)              # anti-alias corner (== target Nyquist)
    # More taps when downsampling so the (wider) sinc keeps the same lobe count and the
    # stop-band stays steep at the lower corner. 16 half-taps at unity matches a scipy
    # polyphase resample to within ~0.3% spectral centroid; capped for the rare 8 MB pass.
    half_width = max(8, min(24, round(12.0 / min(1.0, ratio))))
    PHASES = 512                                # power of two → cheap phase index
    table  = _windowed_sinc_table(cutoff, half_width, PHASES)
    out    = bytearray(n_out)
    inv_ratio = 1.0 / ratio
    last   = n_in - 1
    n_taps = 2 * half_width
    for i in range(n_out):
        src  = i * inv_ratio
        i0   = int(src)
        frac = src - i0
        row  = table[int(frac * PHASES) & (PHASES - 1)]
        base = i0 - (half_width - 1)
        acc  = 0.0
        for k in range(n_taps):
            idx = base + k
            if idx < 0:
                idx = 0
            elif idx > last:
                idx = last
            acc += data[idx] * row[k]
        v = int(acc + 0.5)
        out[i] = 0 if v < 0 else (255 if v > 255 else v)
    return bytes(out)


# Back-compat alias: every *2taud converter imports `resample_linear` by name.
# It is now band-limited (the name is kept to avoid churn across six converters).
resample_linear = resample_bandlimited


def loop_resample_ratio(ratio: float, loops) -> float:
    """The ratio to resample by in place of `ratio`, for a sample whose ACTIVE
    loops are `loops` — (begin, end) frame pairs; None entries and loops under
    two frames are ignored.

    A loop is a whole number of frames, so a loop scaled by an arbitrary ratio
    has to be rounded, and that moves the pitch of everything it sustains — by
    up to a frame in a loop that may be a dozen frames long, most of a semitone
    on a single-cycle wave (TAUD_CONVERSION_NOTES.md §1.2). This lowers `ratio`
    to the nearest value at which the SHORTEST loop spans exactly
    floor(length × ratio) frames: that loop keeps its period exactly, and any
    other is off by half a frame at most (scale_loop). Lowering, never raising,
    keeps a pool-overflow pass inside its budget and a capped sample under its
    cap. The resampler scales time by exactly the ratio it is given, so the
    sample's rate, its loop points and any offset into it all scale by the
    returned value — never by the output length over the input length, which
    int() truncation makes short. No loop, or no resampling: `ratio` itself.
    """
    if ratio == 1.0:
        return ratio
    lengths = [lp[1] - lp[0] for lp in loops if lp and lp[1] - lp[0] >= 2]
    if not lengths:
        return ratio
    shortest = min(lengths)
    frames = math.floor(shortest * ratio)
    return frames / shortest if frames >= 2 else ratio


def scale_loop(begin: int, end: int, ratio: float, length: int) -> tuple:
    """A loop's (begin, end) once its sample has been resampled by exactly
    `ratio` into `length` frames. The start rounds to the nearest frame and the
    LENGTH is rounded once — never the two ends separately — so the loop keeps
    its period (exactly, when `ratio` came from loop_resample_ratio). A loop
    that would run past the data slides back rather than shrinking. Ratio 1.0
    returns the loop untouched."""
    if ratio == 1.0:
        return begin, end
    n = max(0, round((end - begin) * ratio))
    b = max(0, round(begin * ratio))
    if b + n > length:
        b = max(0, length - n)
        n = min(n, length - b)
    return b, b + n


def rescale_offset_effects(pat_bin: bytes, ratio: float) -> bytes:
    """Scale TOP_O sample-offset args in raw pattern bytes by `ratio`.

    Each row is 8 bytes; byte 5 is the effect opcode, bytes 6-7 are the
    little-endian 16-bit arg (= byte offset into the sample). When the
    sample bin overflows and every sample is downsampled globally, the
    offset commands must shrink the same amount or O-jumps land past
    the new end of sample.
    """
    if ratio == 1.0 or not pat_bin:
        return pat_bin
    out = bytearray(pat_bin)
    for i in range(0, len(out) - 7, 8):
        if out[i + 5] == TOP_O:
            arg = out[i + 6] | (out[i + 7] << 8)
            arg = max(0, min(0xFFFF, int(arg * ratio + 0.5)))
            out[i + 6] = arg & 0xFF
            out[i + 7] = (arg >> 8) & 0xFF
    return bytes(out)


def rescale_offset_effects_per_slot(pat_bin: bytes,
                                     num_cues: int,
                                     num_channels: int,
                                     slot_ratios: dict) -> bytes:
    """Scale TOP_O args using a per-slot ratio map.

    `pat_bin` is laid out as `num_cues × num_channels` consecutive
    PATTERN_BYTES (=512) blocks, channel-minor within each cue. For each
    channel, walk the rows in cue order and track the most recently
    written slot byte (row offset 2). When a TOP_O effect appears, scale
    its arg by `slot_ratios[active_slot]`, falling back to ratio 1.0 if
    the slot is unknown (e.g. row hits an O before any inst byte has
    selected a sample for the channel).
    """
    if not pat_bin or not slot_ratios:
        return pat_bin
    if all(r == 1.0 for r in slot_ratios.values()):
        return pat_bin
    out = bytearray(pat_bin)
    active = [0] * num_channels
    for cue in range(num_cues):
        for ch in range(num_channels):
            block = (cue * num_channels + ch) * PATTERN_BYTES
            for row in range(PATTERN_ROWS):
                rb = block + row * 8
                inst = out[rb + 2]
                if inst != 0:
                    active[ch] = inst
                if out[rb + 5] == TOP_O:
                    ratio = slot_ratios.get(active[ch], 1.0)
                    if ratio != 1.0:
                        arg = out[rb + 6] | (out[rb + 7] << 8)
                        arg = max(0, min(0xFFFF, int(arg * ratio + 0.5)))
                        out[rb + 6] = arg & 0xFF
                        out[rb + 7] = (arg >> 8) & 0xFF
    return bytes(out)


def _inst_to_word(instruction) -> int:
    """Fold a cue instruction into its 16-bit word (terranmon.txt §"Cue sheet").

    `instruction` is either an int (single byte30 value, byte31 = 0 — e.g. a plain
    HALT 0x01) or a 2-tuple `(byte30, byte31)` for two-byte forms (LEN, HALT-at,
    BAK, FWD, JMP). The word is `(byte30 << 8) | byte31`, the same encoding the old
    byte30/byte31 pair used; it is spread across channel sign bits by encode_cue.
    """
    if isinstance(instruction, tuple):
        b30, b31 = instruction
    else:
        b30, b31 = instruction, 0
    return ((b30 & 0xFF) << 8) | (b31 & 0xFF)


def encode_cue(patterns, instruction=0, instruction1=None, num_voices=NUM_VOICES) -> bytearray:
    """Encode a cue entry for up to `num_voices` channels (terranmon.txt §"Cue sheet").

    The cue is `num_voices` little-endian Sint16, one per channel (64 bytes for the
    default 32 channels; 128 bytes for 64-channel mode): low 15 bits = pattern number
    (0..0x7FFE; CUE_EMPTY = 0x7FFF = no pattern on this channel), sign bit = one bit of
    an instruction word. Sign bits of channels 0..15 form `instruction` (word 0);
    16..31 form `instruction1` (word 1); channels 32..63 (64-channel mode) carry no
    instruction bit. Each word uses the same layout as the legacy byte30/byte31 pair.
    Most callers emit a single instruction (word 0) and leave word 1 as NOP.
    """
    pats = list(patterns) + [CUE_EMPTY] * num_voices
    pats = pats[:num_voices]
    word0 = _inst_to_word(instruction)
    word1 = _inst_to_word(instruction1) if instruction1 is not None else 0
    entry = bytearray(num_voices * 2)
    for ch in range(num_voices):
        val = pats[ch] & 0x7FFF
        if ch < 16:
            if (word0 >> ch) & 1:                    val |= 0x8000
        elif ch < 32:
            if (word1 >> (ch - 16)) & 1:             val |= 0x8000
        entry[ch*2]     = val & 0xFF
        entry[ch*2 + 1] = (val >> 8) & 0xFF
    return entry


# A fully-empty cue: every channel CUE_EMPTY, both instruction words NOP. Two widths:
# 64-byte (32-channel) and 128-byte (64-channel mode).
EMPTY_CUE    = bytes(encode_cue([], 0))
EMPTY_CUE_64 = bytes(encode_cue([], 0, num_voices=MAX_VOICES))


def set_cue_instruction(sheet: bytearray, cue_idx: int, instruction, instruction1=None,
                        num_voices=NUM_VOICES) -> None:
    """Overlay instruction words onto an already-encoded cue's channel sign bits.

    Replaces the legacy `sheet[cue*CUE_SIZE + 30] = ...` poke: the instruction no
    longer occupies dedicated bytes, so we set the sign bit of each affected
    channel's Sint16 in place, leaving the pattern numbers intact. Instruction bits
    only ride channels 0..31 (both 32- and 64-channel modes).
    """
    word0 = _inst_to_word(instruction)
    word1 = _inst_to_word(instruction1) if instruction1 is not None else 0
    cue_size = num_voices * 2
    base = cue_idx * cue_size
    for ch in range(min(32, num_voices)):
        bit = ((word0 >> ch) & 1) if ch < 16 else ((word1 >> (ch - 16)) & 1)
        hi = base + ch*2 + 1
        sheet[hi] = (sheet[hi] & 0x7F) | (0x80 if bit else 0x00)


def finalize_cue_sheet(sheet: bytearray, num_voices=NUM_VOICES) -> tuple:
    """Trim trailing empty cues and return (trimmed_bytes, num_cues).

    A cue is "empty" only when every channel is CUE_EMPTY and both instruction
    words are NOP. Only TRAILING empties are dropped so interior rests survive; at
    least one cue is always kept. `num_cues` is the kept count, to be stored in the
    song table (terranmon.txt §"Song Table"). Cue width follows `num_voices`.
    """
    cue_size = num_voices * 2
    empty = EMPTY_CUE_64 if num_voices > NUM_VOICES else EMPTY_CUE
    n = len(sheet) // cue_size
    last = 0
    for ci in range(n):
        if bytes(sheet[ci*cue_size:(ci+1)*cue_size]) != empty:
            last = ci
    num_cues = last + 1
    return bytes(sheet[:num_cues * cue_size]), num_cues


def cue_instruction_len(rows: int) -> tuple:
    """Build the 2-byte LEN cue instruction for `rows` (1..64).

    Returns (byte30, byte31) where byte30 = 0x02 and byte31 = (rows - 1) & 0x3F.
    """
    if not 1 <= rows <= 64:
        raise ValueError(f"LEN row count must be 1..64, got {rows}")
    return (CUE_INST_LEN, (rows - 1) & 0x3F)


def cue_instruction_halt_at(rows: int) -> tuple:
    """Build the 2-byte 'Halt at x' cue instruction (terranmon.txt §"Cue Sheet").

    Plays `rows` rows of the pattern (1..64) then stops playback. Encoding is
    byte30 = 0x01, byte31 = 0b01xxxxxx where x is the row count itself (NOT
    rows-1 like LEN); x = 0 means "full length". A full-length halt (rows >= 64)
    is therefore emitted as a plain HALT (byte31 = 0) so existing full-pattern
    final cues stay byte-identical.
    """
    if not 1 <= rows <= 64:
        raise ValueError(f"halt-at row count must be 1..64, got {rows}")
    if rows >= 64:
        return (CUE_INST_HALT, 0x00)
    return (CUE_INST_HALT, 0x40 | (rows & 0x3F))


def cue_instruction_jump(cue: int) -> tuple:
    """Build the 2-byte JMP cue instruction (terranmon.txt §"Cue Sheet").

    Go to absolute cue `cue` when this cue finishes its full pattern — the engine
    never halts here, so it loops. Encoding is byte30 = 0b1111xxxx (high nybble of
    the 12-bit cue) and byte31 = low 8 bits; the instruction word is 12-bit, so a
    JMP target must be 0..4095 even though the sheet holds up to 8192 cues.
    """
    if not 0 <= cue <= 0xFFF:
        raise ValueError(f"JMP cue target must be 0..4095, got {cue}")
    return (0xF0 | ((cue >> 8) & 0x0F), cue & 0xFF)


def last_note_cue_index(pat_bin: bytes, num_cues: int, num_channels: int) -> int:
    """Index of the last cue holding an *actual* note, or -1 if none.

    `pat_bin` is the raw (pre-dedup) pattern binary, laid out as
    `num_cues × num_channels` consecutive PATTERN_BYTES blocks, channel-minor
    within each cue (block = (cue*num_channels + ch)*PATTERN_BYTES; each row is
    8 bytes, note = little-endian u16 at offset 0). Special notes — NOP,
    key-off, cut, note-fade, fast-fade (values 0..NOTE_FASTFADE) — are not
    notes; only pitches above that count. Used to trim trailing note-free cues
    (e.g. a MIDI conversion's final all-key-off release cue).
    """
    for cue in range(num_cues - 1, -1, -1):
        for ch in range(num_channels):
            block = (cue * num_channels + ch) * PATTERN_BYTES
            for row in range(PATTERN_ROWS):
                rb = block + row * 8
                note = pat_bin[rb] | (pat_bin[rb + 1] << 8)
                if note > NOTE_FASTFADE:
                    return cue
    return -1


def deduplicate_patterns(pat_bin: bytes, num_pats: int) -> tuple:
    """Consolidate identical 512-byte Taud patterns into a single copy.

    Returns (deduped_bin, remap, num_unique) where remap[original_idx] =
    canonical_idx.
    """
    seen = {}
    remap = {}
    canonical = []
    for i in range(num_pats):
        pat = pat_bin[i * PATTERN_BYTES : (i + 1) * PATTERN_BYTES]
        if pat in seen:
            remap[i] = seen[pat]
        else:
            ci = len(canonical)
            seen[pat] = ci
            remap[i] = ci
            canonical.append(pat)
    return b''.join(canonical), remap, len(canonical)


def encode_song_entry(song_offset: int, num_voices: int, num_patterns: int,
                      bpm_stored: int, tick_rate: int,
                      base_note: int, base_freq: float, flags_byte: int,
                      pat_bin_comp_size: int, cue_sheet_comp_size: int,
                      global_vol: int = 0x80, mixing_vol: int = 0x80,
                      num_cues: int = 0) -> bytes:
    """Pack a 32-byte Taud song table entry.

    Layout:
        u32 song_offset, u8 num_voices, u16 num_patterns,
        u8 bpm_stored, u8 bpm_hi_bit<<7 | tick_rate,
        u16 base_note, f32 base_freq,
        u8 flags, u8 global_vol, u8 mixing_vol,
        u32 pat_bin_comp_size, u32 cue_sheet_comp_size,
        u16 num_cues (was reserved), u8 bpm_bit9<<7 (immutable song flags),
        byte[3] reserved.

    `bpm_stored` is `bpm - 25`, a 10-bit value (0..1023 ⇒ BPM 25..1048): its
    low 8 bits go to the bpm byte, bit 8 into bit 7 of the tick-rate byte (which
    therefore caps tick_rate at 0..127) and bit 9 into bit 7 of the immutable
    song flags, whose surround model (bits 0..1) a converter leaves 0. `num_cues` is the
    cue count of the (v2) cue sheet, so a loader need not derive it from the
    decompressed size (0 in a legacy v1 file). See terranmon.txt §"Song Table".
    """
    bpm_stored = max(0, min(TAUD_BPM_MAX - TAUD_BPM_MIN, bpm_stored))
    entry = struct.pack('<IBHBBHfBBBIIH',
        song_offset,
        num_voices & 0xFF,
        num_patterns & 0xFFFF,
        bpm_stored & 0xFF,
        (((bpm_stored >> 8) & 1) << 7) | (tick_rate & 0x7F),
        base_note & 0xFFFF,
        float(base_freq),
        flags_byte & 0xFF,
        global_vol & 0xFF,
        mixing_vol & 0xFF,
        pat_bin_comp_size & 0xFFFFFFFF,
        cue_sheet_comp_size & 0xFFFFFFFF,
        num_cues & 0xFFFF,
    ) + bytes([((bpm_stored >> 9) & 1) << 7, 0, 0, 0])
    assert len(entry) == TAUD_SONG_ENTRY
    return entry


# ── Subsong detection (multi-song .taud emission) ────────────────────────────
#
# Modules and trackers don't natively carry a subsong table; subsongs emerge
# from the order-list flow graph. OpenMPT-style: take the lowest unvisited
# non-terminator order as the next subsong entry, do forward reachability via
# fall-through (oi→oi+1) plus pattern-Bxx targets, mark all reached orders
# visited, repeat until no entries remain.
#
# Fall-through is treated as dead when the pattern at oi has a Bxx on its
# absolute last row — the convention every tracker uses for "song ends here,
# loop back" — which lets non-looping subsongs separated by Bxx-terminated
# predecessors be detected even without an explicit 0xFF marker.
#
# WHEN.s3m → 4 subsongs (0xFF separators); Insaniq2.it → 8 subsongs (Bxx-row-63
# terminators, no 0xFF separators). Single-song files collapse to 1 subsong.

def detect_subsongs(orders, pattern_bxx_fn, *,
                    terminators=(0xFF,), skip_marker=0xFE):
    """Detect subsongs by repeated forward reachability.

    Args:
        orders: list of raw order bytes from the source file. Each element is
            either a pattern index (0..n-1), a skip value (transparently
            skipped), or a terminator value (ends a path).
        pattern_bxx_fn: callable(pattern_idx) → (set_of_bxx_target_order_indices,
            kills_fallthrough). `kills_fallthrough` is True when the pattern's
            last row carries a Bxx (unconditional terminator); when False,
            fall-through to oi+1 is kept as a graph edge.
        terminators: int, or iterable of ints. Order values that end a path
            (default 0xFF). Pass an empty iterable for formats without a
            terminator marker (XM).
        skip_marker: int, or iterable of ints. Order values that are
            transparently passed during traversal (default 0xFE). XM passes
            `range(pattern_count, 256)` to skip out-of-range pattern refs.

    Returns:
        List of subsongs in entry-order. Each subsong is a dict:
            'entry': original order-list position of the entry (int)
            'positions': list of original order-list positions belonging to this
                subsong, in cue-sheet order (entry first, then ascending index
                wrap-around). Each position's pattern index = orders[pos].
        For a single-song file the result has one element whose 'positions'
        covers the whole order list (minus terminators/skips). For files where
        every order is a terminator/skip, the result is empty.
    """
    n = len(orders)
    term = {terminators} if isinstance(terminators, int) else set(terminators)
    skips = ({skip_marker} if isinstance(skip_marker, int)
             else set(skip_marker))

    def _is_traversable(pos: int) -> bool:
        if pos < 0 or pos >= n:
            return False
        v = orders[pos]
        return v not in term and v not in skips

    visited = set()
    songs = []

    while True:
        # Lowest unvisited traversable position = next subsong entry.
        entry = next((i for i in range(n)
                      if i not in visited and _is_traversable(i)), None)
        if entry is None:
            break

        # Reachability claims orders for this subsong, stopping at orders
        # already owned by a previous subsong.
        owned = set()
        stack = [entry]
        while stack:
            oi = stack.pop()
            if oi in owned or oi in visited:
                continue
            if oi < 0 or oi >= n:
                continue
            v = orders[oi]
            if v in term:
                continue
            if v in skips:
                if oi + 1 < n:
                    stack.append(oi + 1)
                continue
            owned.add(oi)
            tgts, kills = pattern_bxx_fn(v)
            for t in tgts:
                if 0 <= t < n:
                    stack.append(t)
            if not kills and oi + 1 < n:
                stack.append(oi + 1)

        if not owned:
            # Avoid infinite loop on a degenerate entry (shouldn't happen
            # since _is_traversable already filtered terminators / skips).
            visited.add(entry)
            continue
        visited |= owned

        # Cue-sheet order: ascending index, rotated so entry comes first.
        # The natural order-list traversal is sequential, so increasing index
        # matches the play sequence when fall-through is alive; rotation
        # ensures cue 0 is the entry order.
        sorted_owned = sorted(owned)
        rot = sorted_owned.index(entry)
        positions = sorted_owned[rot:] + sorted_owned[:rot]

        songs.append({'entry': entry, 'positions': positions})

    return songs


# ── Project Data section (terranmon.txt:2601+) ───────────────────────────────

PROJECT_DATA_MAGIC = bytes([0x1E, 0x54, 0x61, 0x75, 0x64, 0x50, 0x72, 0x4A])  # \x1ETaudPrJ
PROJECT_DATA_HEADER_SIZE = 16   # 8-byte magic + 8 reserved


def _name_table_blob(names) -> bytes:
    """Encode a list of names as 0x1E-separated UTF-8 bytes. Trailing empty
    entries are trimmed to save space; returns b'' when every name is empty.

    The caller chooses the indexing: INam/pNam are slot-indexed (entry 0 = the
    unused slot 0), while SNam is pool-ordered and 0-based (pool sample i =
    entry i).
    """
    if not names:
        return b''
    end = len(names)
    while end > 0 and not names[end - 1]:
        end -= 1
    if end == 0:
        return b''
    return b'\x1E'.join((n or '').encode('utf-8', 'replace') for n in names[:end])


# ── Ixmp encoder (terranmon.txt §Project Data → Ixmp) ───────────────────────

# Per-patch byte layout. Field offsets / version flags must match
# AudioJSR223Delegate.uploadInstrumentPatches (Kotlin parser) and terranmon.txt
# "Ixmp. Instrument extra samples". Patches are VARIABLE LENGTH since 2026-06-13:
# a version byte (feature bit-flags) + 30 common bytes + optional blocks. A
# version byte with only the 'i' bit set yields the legacy 31-byte record.
IXMP_COMMON_SIZE    = 31     # version byte + 30 common bytes (legacy record size)
IXMP_PAN_NO_OVERRIDE = 0xFF
IXMP_DNV_NO_OVERRIDE = 0
IXMP_VIBWAVE_NO_OVERRIDE = 0xFF

# Version byte feature bits (terranmon.txt 0b x00Pfpvi).
IXMP_VER_I = 0x01            # always set (version 1)
IXMP_VER_V = 0x02            # has volume envelope block
IXMP_VER_P = 0x04            # has panning envelope block
IXMP_VER_F = 0x08            # has filter envelope block
IXMP_VER_PITCH = 0x10        # has pitch envelope block ('P')
IXMP_VER_S = 0x20            # has stereo/surround channel block ('s')
IXMP_VER_X = 0x80            # has extra-base-info block

# 's' block channel modes (low nibble of the count/mode byte).
IXMP_CHAN_DISCRETE = 0       # XY stereo, 4-track quad — one channel per speaker feed
IXMP_CHAN_MATRIX   = 1       # M/S stereo, ambisonic B-format — decoded before panning


# "Perceptually Significant Octet to Decibel Table" → linear gain (octet → amplitude).
# The canonical perceptual loudness curve shared by the engine (AudioAdapter.META_MIX_GAIN),
# the Metainstrument layer mix volume, and the base/patch initialAttenuation octet.
# Octet 0 = silence, 159 = unity (0 dB), 255 = +24 dB.
META_GAIN = (
    0.0, 5e-05, 5.6e-05, 6.3e-05, 7.1e-05, 7.9e-05, 8.9e-05, 0.0001,
    0.000112, 0.000126, 0.000141, 0.000158, 0.000178, 0.0002, 0.000224, 0.000251,
    0.000282, 0.000316, 0.000355, 0.000398, 0.000447, 0.000501, 0.000562, 0.000631,
    0.000708, 0.000794, 0.000891, 0.001, 0.001122, 0.001259, 0.001413, 0.001585,
    0.001778, 0.001995, 0.002239, 0.002512, 0.002818, 0.003162, 0.003548, 0.003981,
    0.004467, 0.005012, 0.005623, 0.00631, 0.007079, 0.007943, 0.008913, 0.01,
    0.01122, 0.012589, 0.014125, 0.015849, 0.017783, 0.019953, 0.022387, 0.025119,
    0.028184, 0.031623, 0.035481, 0.039811, 0.044668, 0.050119, 0.056234, 0.063096,
    0.066834, 0.070795, 0.074989, 0.079433, 0.08414, 0.089125, 0.094406, 0.1,
    0.105925, 0.112202, 0.11885, 0.125893, 0.133352, 0.141254, 0.149624, 0.158489,
    0.16788, 0.177828, 0.188365, 0.199526, 0.211349, 0.223872, 0.237137, 0.251189,
    0.258523, 0.266073, 0.273842, 0.281838, 0.290068, 0.298538, 0.307256, 0.316228,
    0.325462, 0.334965, 0.344747, 0.354813, 0.365174, 0.375837, 0.386812, 0.398107,
    0.409732, 0.421697, 0.43401, 0.446684, 0.459727, 0.473151, 0.486968, 0.501187,
    0.508452, 0.515822, 0.523299, 0.530884, 0.53858, 0.546387, 0.554307, 0.562341,
    0.570493, 0.578762, 0.587151, 0.595662, 0.604296, 0.613056, 0.621942, 0.630957,
    0.640103, 0.649382, 0.658795, 0.668344, 0.678032, 0.68786, 0.697831, 0.707946,
    0.718208, 0.728618, 0.73918, 0.749894, 0.760764, 0.771792, 0.782979, 0.794328,
    0.805842, 0.817523, 0.829373, 0.841395, 0.853591, 0.865964, 0.878517, 0.891251,
    0.90417, 0.917276, 0.930572, 0.944061, 0.957745, 0.971628, 0.985712, 1.0,
    1.014495, 1.029201, 1.044119, 1.059254, 1.074608, 1.090184, 1.105987, 1.122018,
    1.138282, 1.154782, 1.171521, 1.188502, 1.20573, 1.223207, 1.240938, 1.258925,
    1.277174, 1.295687, 1.314468, 1.333521, 1.352851, 1.372461, 1.392355, 1.412538,
    1.433013, 1.453784, 1.474857, 1.496236, 1.517924, 1.539927, 1.562248, 1.584893,
    1.607867, 1.631173, 1.654817, 1.678804, 1.703139, 1.727826, 1.752871, 1.778279,
    1.804056, 1.830206, 1.856735, 1.883649, 1.910953, 1.938653, 1.966754, 1.995262,
    2.053525, 2.113489, 2.175204, 2.238721, 2.304093, 2.371374, 2.440619, 2.511886,
    2.585235, 2.660725, 2.73842, 2.818383, 2.900681, 2.985383, 3.072557, 3.162278,
    3.254618, 3.349654, 3.447466, 3.548134, 3.651741, 3.758374, 3.868121, 3.981072,
    4.216965, 4.466836, 4.731513, 5.011872, 5.308844, 5.623413, 5.956621, 6.309573,
    6.683439, 7.079458, 7.498942, 7.943282, 8.413951, 8.912509, 9.440609, 10.0,
    10.592537, 11.220185, 11.885022, 12.589254, 13.335214, 14.125375, 14.962357, 15.848932,
)


def atten_cb_to_octet(atten_cb: float) -> int:
    """SF2 initialAttenuation (centibels, ≥0) → nearest [META_GAIN] octet (159 = 0 dB /
    unity). Returns 159 for ~0 attenuation and never 0 — octet 0 is the engine's "unset"
    sentinel (treated as unity), so emitting it for a real value would silence the voice."""
    if atten_cb <= 0:
        return 159
    g = 10.0 ** (-atten_cb / 200.0)
    return min(range(1, 160), key=lambda o: abs(META_GAIN[o] - g))


def _encode_env_block(env: dict) -> bytes:
    """One v/p/f/P envelope block: LOOP word + SUSTAIN word + 25 (value, minifloat)
    node pairs = 54 bytes. `env` keys: 'loop' (u16), 'sustain' (u16), 'nodes'
    (list of (value 0..255, minifloat_index 0..255); padded/truncated to 25)."""
    out = bytearray(struct.pack('<HH', int(env.get('loop', 0)) & 0xFFFF,
                                int(env.get('sustain', 0)) & 0xFFFF))
    nodes = list(env.get('nodes', []))
    while len(nodes) < 25:
        nodes.append((nodes[-1][0] if nodes else 0, 0))
    for val, mf in nodes[:25]:
        out.append(int(val) & 0xFF)
        out.append(int(mf) & 0xFF)
    return bytes(out)


def encode_ixmp_patch(p: dict) -> bytes:
    """Encode one variable-length patch.

    Common keys (numeric; defaults applied for missing optionals):
        pitch_start, pitch_end        : Taud 4096-TET noteVal (Uint16)
        volume_start, volume_end      : 0..63 (Uint8)
        sample_ptr                    : Uint32 (sample bin offset)
        sample_length                 : Uint16
        play_start, loop_start, loop_end : Uint16
        sampling_rate                 : Uint16 (same encoding as base inst byte 6-7)
        sample_detune                 : Int16, signed 4096-TET (default 0)
        loop_mode                     : Uint8 (default 0)
        default_pan                   : Uint8, 0xFF = no override (default 0xFF)
        default_note_volume           : Uint8 IT-scaled (0 = no override, default 0)
        vibrato_speed/sweep/depth/rate: Uint8 (default 0)
        vibrato_waveform              : Uint8 (0..7 or 0xFF for no override, default 0xFF)

    Optional blocks (presence sets the version flag; appended in spec order x,v,p,f,P):
        extra      : dict {fadeout (u16), default_cutoff (u16), default_resonance (u16),
                           initial_attenuation (u8 dB-table octet),
                           filter_sf_mode (bool — flag1 bit 0; SoundFont filter params)}
                     → 'x' block (15 bytes)
        vol_env    : env-block dict → 'v' block (54 bytes)
        pan_env    : env-block dict → 'p' block
        filter_env : env-block dict → 'f' block
        pitch_env  : env-block dict → 'P' block
        channels   : dict {mode (0 discrete / 1 matrix), flags (u24, reserved),
                           ptrs [u32, …]} → 's' block, emitted LAST. `ptrs` are the
                     EXTRA channels' sample pointers (channel 1 is sample_ptr), so a
                     stereo sample passes one pointer. Every channel shares this
                     record's length / play-start / loop / rate.
    """
    pitch_start = max(0, min(0xFFFF, int(p['pitch_start'])))
    pitch_end   = max(0, min(0xFFFF, int(p['pitch_end'])))
    vol_start   = max(0, min(63,     int(p.get('volume_start', 0))))
    vol_end     = max(0, min(63,     int(p.get('volume_end', 63))))
    sample_ptr  = int(p['sample_ptr']) & 0xFFFFFFFF
    sample_len  = max(0, min(0xFFFF, int(p['sample_length'])))
    play_start  = max(0, min(0xFFFF, int(p.get('play_start', 0))))
    loop_start  = max(0, min(0xFFFF, int(p.get('loop_start', 0))))
    loop_end    = max(0, min(0xFFFF, int(p.get('loop_end',   0))))
    rate        = max(0, min(0xFFFF, int(p.get('sampling_rate', 0))))
    detune      = max(-0x8000, min(0x7FFF, int(p.get('sample_detune', 0))))

    extra  = p.get('extra')
    vol_e  = p.get('vol_env')
    pan_e  = p.get('pan_env')
    filt_e = p.get('filter_env')
    pit_e  = p.get('pitch_env')
    chans  = p.get('channels')
    if chans is not None and not chans.get('ptrs'):
        chans = None                             # no extra channels ⇒ plain mono patch

    ver = IXMP_VER_I
    if extra  is not None: ver |= IXMP_VER_X
    if vol_e  is not None: ver |= IXMP_VER_V
    if pan_e  is not None: ver |= IXMP_VER_P
    if filt_e is not None: ver |= IXMP_VER_F
    if pit_e  is not None: ver |= IXMP_VER_PITCH
    if chans  is not None: ver |= IXMP_VER_S

    common = struct.pack(
        '<BHHBBIHHHHHhBBBBBBBB',
        ver,                                     # patch version / feature flags
        pitch_start, pitch_end,
        vol_start,   vol_end,
        sample_ptr,
        sample_len,
        play_start, loop_start, loop_end,
        rate,
        detune,
        int(p.get('loop_mode', 0))            & 0x07,
        int(p.get('default_pan', IXMP_PAN_NO_OVERRIDE))     & 0xFF,
        int(p.get('default_note_volume', IXMP_DNV_NO_OVERRIDE)) & 0xFF,
        int(p.get('vibrato_speed', 0))        & 0xFF,
        int(p.get('vibrato_sweep', 0))        & 0xFF,
        int(p.get('vibrato_depth', 0))        & 0xFF,
        int(p.get('vibrato_rate',  0))        & 0xFF,
        int(p.get('vibrato_waveform', IXMP_VIBWAVE_NO_OVERRIDE)) & 0xFF,
    )
    out = bytearray(common)
    if extra is not None:                        # 'x' block (15 bytes), spec order
        # flags1 bit 0 (m): 0 = IT filter params, 1 = SoundFont (Fc cents / Q centibels).
        flags1 = 0x01 if extra.get('filter_sf_mode') else 0x00
        out += struct.pack('<I', flags1)         # Bit32 extra-feature-flags 1..32
        out += struct.pack('<I', 0)              # Bit32 extra-feature-flags 33..64 (reserved)
        out += struct.pack('<H', int(extra.get('fadeout', 0)) & 0xFFFF)
        out += struct.pack('<H', int(extra.get('default_cutoff', 0xFFFF)) & 0xFFFF)
        out += struct.pack('<H', int(extra.get('default_resonance', 0xFFFF)) & 0xFFFF)
        # per-patch initialAttenuation as a dB-table octet (159 = unity); 0 = unset sentinel.
        out.append(int(extra.get('initial_attenuation', 0)) & 0xFF)
    if vol_e  is not None: out += _encode_env_block(vol_e)
    if pan_e  is not None: out += _encode_env_block(pan_e)
    if filt_e is not None: out += _encode_env_block(filt_e)
    if pit_e  is not None: out += _encode_env_block(pit_e)
    if chans is not None:                        # 's' block, always LAST
        ptrs = list(chans['ptrs'])[:15]          # count-1 fits a nibble
        out.append(((len(ptrs) & 0x0F) << 4) | (int(chans.get('mode', IXMP_CHAN_DISCRETE)) & 0x0F))
        flags = int(chans.get('flags', 0)) & 0xFFFFFF
        out += bytes([flags & 0xFF, (flags >> 8) & 0xFF, (flags >> 16) & 0xFF])
        for ptr in ptrs:
            out += struct.pack('<I', int(ptr) & 0xFFFFFFFF)
    return bytes(out)


def encode_ixmp_payload(patches_by_inst: dict) -> bytes:
    """Encode a dict {instrument_id: [patch_dict, ...]} as one Ixmp section payload
    (the body that follows the FourCC + length header). Instruments are written in
    ascending id order. Overlapping pitch+volume rectangles within one instrument
    are INVALID per spec and the caller is responsible for keeping them disjoint."""
    if not patches_by_inst:
        return b''
    out = bytearray()
    for inst_id in sorted(patches_by_inst):
        patches = patches_by_inst[inst_id]
        if not patches:
            continue
        iid = int(inst_id) & 0x3FF                                # 10-bit: 0..1023
        # Header is 4 bytes. byte0 = instId low 8; bytes1-2 = Uint16 count; byte3 =
        # instId high (bits 0..1 -> instId bits 8..9; the auxiliary-bin $100..$3FF selector).
        # byte3 was the Uint24 count's top byte (always 0 for the tiny real counts),
        # so a pre-2026-06-30 reader still parses legacy $00..$FF entries correctly.
        out.append(iid & 0xFF)
        cnt = len(patches)
        out += bytes([cnt & 0xFF, (cnt >> 8) & 0xFF, (iid >> 8) & 0x03])
        for patch in patches:
            out += encode_ixmp_patch(patch)
    return bytes(out)


def build_project_data(*, project_name: str = '',
                       author: str = '',
                       copyright_str: str = '',
                       message: str = '',
                       sample_names=None,
                       instrument_names=None,
                       pattern_names=None,
                       song_metadata=None,
                       ixmp_patches=None,
                       is_64channel: bool = False) -> bytes:
    """Build the optional PROJECT DATA section payload.

    Returns the full block (8-byte magic + 8 reserved bytes + concatenated
    FourCC sections), or b'' when there's nothing to write so the caller can
    leave the header's projOff field at zero.

    When `is_64channel` is set, an xHDR (Extended header) section is emitted with
    Flags1 bit 0 (64-channel mode) — the caller MUST also set the version byte's
    xHDR bit (0x20). This forces a non-empty block even with no other sections.

    `project_name` / `author` / `copyright_str` / `message` become the four
    project strings PNam / PCom / PCpr / PMsg; each is skipped when empty.

    `instrument_names` / `pattern_names` are slot-indexed lists (entry 0 is
    typically empty since slot 0 is reserved); `sample_names` is pool-ordered
    and 0-based (entry i names pool sample i — NO reserved leading entry).
    All three are encoded as 0x1E-separated UTF-8 strings inside INam / pNam /
    SNam blocks.

    `song_metadata` is an optional list of dicts, one per song:
        { 'index': int (0..255),
          'notation': int = 0,
          'beat_pri': int = 4,
          'beat_sec': int = 16,
          'name': str = '',
          'composer': str = '',
          'copyright': str = '' }
    """
    sections = []

    def add(fourcc: bytes, payload: bytes) -> None:
        if not payload:
            return
        sections.append(fourcc + struct.pack('<I', len(payload)) + payload)

    # xHDR (Extended header) leads when 64-channel mode is on: Flags1 bit 0 = 64ch,
    # then 255 reserved bytes (terranmon.txt §xHDR).
    if is_64channel:
        add(b'xHDR', bytes([0x01]) + b'\x00' * 255)

    if project_name:
        add(b'PNam', project_name.encode('utf-8', 'replace'))
    if author:
        add(b'PCom', author.encode('utf-8', 'replace'))
    if copyright_str:
        add(b'PCpr', copyright_str.encode('utf-8', 'replace'))
    if message:
        # PMsg is the one project string that may hold line breaks, and they are
        # LF ($0A) — a source whose message separates lines with CR (IT) or CRLF
        # must have been translated before it gets here (TAUD_FILE_FORMAT §9.2).
        add(b'PMsg', message.encode('utf-8', 'replace'))

    add(b'INam', _name_table_blob(instrument_names))
    add(b'SNam', _name_table_blob(sample_names))
    add(b'pNam', _name_table_blob(pattern_names))

    if song_metadata:
        smet = bytearray()
        for entry in song_metadata:
            idx      = entry.get('index', 0) & 0xFF
            notation = entry.get('notation', 0) & 0xFFFF
            beat_pri = entry.get('beat_pri', 4) & 0xFF
            beat_sec = entry.get('beat_sec', 16) & 0xFF
            name_b = entry.get('name', '').encode('utf-8', 'replace') + b'\x00'
            comp_b = entry.get('composer', '').encode('utf-8', 'replace') + b'\x00'
            copr_b = entry.get('copyright', '').encode('utf-8', 'replace') + b'\x00'
            payload = (struct.pack('<HBB', notation, beat_pri, beat_sec)
                       + name_b + comp_b + copr_b)
            smet.append(idx)
            smet += struct.pack('<I', len(payload))
            smet += payload
        add(b'sMet', bytes(smet))

    if ixmp_patches:
        add(b'Ixmp', encode_ixmp_payload(ixmp_patches))

    if not sections:
        return b''

    return PROJECT_DATA_MAGIC + b'\x00' * 8 + b''.join(sections)


# ── Sample normalisation ─────────────────────────────────────────────────────

def normalise_sample_channels(raw: bytes, signed: bool, is_16bit: bool,
                              is_stereo: bool, name: str) -> list:
    """Return unsigned 8-bit sample bytes PER CHANNEL — [mono] or [left, right].

    Same depth conversion as [normalise_sample], minus the downmix: a stereo
    source keeps its two channels, which the Taud side stores as two pool spans
    tied together by an Ixmp 's' patch (terranmon.txt "Patch definition flag
    's'"). The on-disk layout is split (non-interleaved): the whole left channel
    block followed by the whole right one, matching IT/S3M/XM (Schism's SF_SS).
    """
    bps      = 2 if is_16bit else 1
    chans    = 2 if is_stereo else 1
    n_frames = len(raw) // (bps * chans)
    chan_bytes = n_frames * bps
    out = []
    for c in range(chans):
        base = c * chan_bytes
        buf = bytearray(n_frames)
        for i in range(n_frames):
            if is_16bit:
                s16 = struct.unpack_from('<h', raw, base + i * 2)[0]
                buf[i] = ((s16 >> 8) + 128) & 0xFF
            else:
                b = raw[base + i]
                buf[i] = ((b ^ 0x80) & 0xFF) if signed else b
        out.append(bytes(buf))
    if is_16bit or is_stereo:
        vprint(f"  info: '{name}' converted to unsigned 8-bit "
               f"{'stereo' if chans == 2 else 'mono'} ({n_frames} frames)")
    return out


def normalise_sample(raw: bytes, signed: bool, is_16bit: bool,
                     is_stereo: bool, name: str) -> bytes:
    """Return unsigned 8-bit mono sample bytes, downmixing/depthing as needed.

    Stereo samples are stored as a split (non-interleaved) layout — the full
    left channel block followed by the full right channel block — matching the
    on-disk format used by IT, S3M, and XM (Schism's SF_SS).
    """
    out = []
    bps     = 2 if is_16bit else 1
    chans   = 2 if is_stereo else 1
    n_frames = len(raw) // (bps * chans)
    chan_bytes = n_frames * bps

    for i in range(n_frames):
        if is_16bit:
            if is_stereo:
                l16 = struct.unpack_from('<h', raw, i*2)[0]
                r16 = struct.unpack_from('<h', raw, chan_bytes + i*2)[0]
                s = (l16 + r16) >> 1
            else:
                s = struct.unpack_from('<h', raw, i*2)[0]
            v = (s >> 8) + 128
        else:
            if is_stereo:
                l8 = raw[i]
                r8 = raw[chan_bytes + i]
                if signed:
                    l_s = l8 - 256 if l8 >= 0x80 else l8
                    r_s = r8 - 256 if r8 >= 0x80 else r8
                    v = ((l_s + r_s) >> 1) + 128
                else:
                    v = (l8 + r8) >> 1
            else:
                raw_s = raw[i]
                if signed:
                    v = (raw_s ^ 0x80) & 0xFF
                else:
                    v = raw_s
        out.append(v & 0xFF)
    if is_16bit or is_stereo:
        vprint(f"  info: '{name}' converted to unsigned 8-bit mono ({len(out)} samples)")
    return bytes(out)
