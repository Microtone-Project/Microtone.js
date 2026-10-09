#!/usr/bin/env python3
"""mod2taud.py — Convert ProTracker (.mod) to TSVM Taud (.taud)

Usage:
    python3 mod2taud.py input.mod output.taud [-v]

Limits:
    - Up to 20 MOD channels (excess disabled; hard error if pattern count
      × channel count > 4095).
    - Sample bin is 8 MB (8388608 bytes); if all samples together exceed
      this, every sample is globally resampled down (with c2spd adjusted)
      so pitch is preserved.

Effect support:
    Full PT effect dispatch per TAUD_NOTE_EFFECTS.md "ProTracker to Taud
    conversion table". PT recalls (effect $00 args) are eagerly resolved
    per channel using PT's per-effect private memory model. Cxx folds
    into the volume column (0.$xx). Axy / EAx / EBx fold into the volume
    column. 8xx and E8x fold into the pan column. Periods convert to Taud
    units via log2 against PT period 428 (≡ Taud C3). Sample finetune is
    pre-baked into the per-instrument c2spd. Amiga-mode flag is set in
    the song-table flags byte so the engine applies coarse pitch slides
    in period space.
"""

import argparse
import copy
import math
import struct
import sys

from taud_common import (
    set_verbose, vprint,
    TAUD_MAGIC, TAUD_VERSION, TAUD_HEADER_SIZE, TAUD_SONG_ENTRY,
    SAMPLEBIN_SIZE, INSTBIN_SIZE, SAMPLEINST_SIZE,
    PATTERN_ROWS, PATTERN_BYTES, NUM_PATTERNS_MAX, NUM_CUES, CUE_SIZE, NUM_VOICES,
    NOTE_NOP, NOTE_KEYOFF, NOTE_CUT, TAUD_C4,
    TOP_NONE, TOP_A, TOP_B, TOP_C, TOP_D, TOP_E, TOP_F, TOP_G, TOP_H, TOP_I,
    TOP_J, TOP_K, TOP_L, TOP_O, TOP_Q, TOP_R, TOP_S, TOP_T, TOP_U, TOP_V, TOP_Y,
    SEL_SET, SEL_UP, SEL_DOWN, SEL_FINE,
    J_SEMI_TABLE,
    d_arg_to_col, resample_linear, rescale_offset_effects_per_slot, encode_cue, deduplicate_patterns,
    loop_resample_ratio, scale_loop,
    finalize_cue_sheet, set_cue_instruction, CUE_INST_HALT,
    encode_song_entry, compress_blob,
    build_project_data, detect_subsongs,
)


# ── MOD constants ────────────────────────────────────────────────────────────

MOD_NUM_SAMPLES = 31
MOD_PATTERN_ROWS = 64

# PT effect numbers (single hex digit 0..F). Effect $E uses sub-nibbles.
PT_E_BASE = 0xE
PT_F = 0xF

# PT effects that have private memory and therefore recall their last
# non-zero argument when re-issued with $00. Top-level effects:
PT_MEM_TOP = frozenset({0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0xA})
# E sub-effects with memory (key is sub-nibble of the E command):
PT_MEM_E_SUB = frozenset({0x1, 0x2, 0xA, 0xB})

GLOBAL_FLAGS_AMIGA_FREQ = 0b01
GLOBAL_FLAGS_A500_INTP = 0b1000


# ── Taud constants (mod-specific) ────────────────────────────────────────────

SIGNATURE        = b"mod2taud/TSVM "    # 14 bytes

# PT period 428 (PT "C-2") corresponds to OpenMPT/IT C-4 which s3m2taud
# anchors to Taud C4 (0x5000). We use the same anchor so MOD/S3M imports
# share a pitch reference.
PT_REFERENCE_PERIOD = 428.0

# sMet notation index 1 = "ProTracker pitch". PT tunes from a hand-made table
# of integer Amiga periods, not from 12-TET, so its notes sit up to ~6 cents
# off the 12-TET grid -- and the table is not even exactly octave-periodic
# (E-3 is period 170, not 339/2 = 169.5). Stamping the notation lets the
# editor name those notes correctly instead of flagging the song out of tune.
PT_NOTATION = 1


# ── MOD parser ───────────────────────────────────────────────────────────────

class ModSample:
    __slots__ = ('name','length','finetune','volume','loop_begin','loop_end',
                 'sample_data','c2spd','flags')

class ModRow:
    __slots__ = ('period','inst','effect','effect_arg','vol_set')
    def __init__(self):
        self.period     = 0      # 0 = empty / no trigger
        self.inst       = 0      # 0 = no instrument set
        self.effect     = 0      # PT effect digit ($0..$F)
        self.effect_arg = 0
        # PT has no volume column; Cxx folds into vol_set during parsing.
        # -1 = no explicit volume.
        self.vol_set    = -1


def _parse_magic(magic: bytes) -> int:
    """Return number of channels declared by the 4-byte MOD magic."""
    if magic in (b'M.K.', b'M!K!', b'FLT4', b'M&K!', b'N.T.'):
        return 4
    if magic == b'FLT8':
        return 8
    if magic == b'OCTA' or magic == b'CD81':
        return 8
    # xCHN (1..9 channels)
    if len(magic) == 4 and magic[1:] == b'CHN' and 0x31 <= magic[0] <= 0x39:
        return magic[0] - 0x30
    # xxCH (10..32 channels)
    if len(magic) == 4 and magic[2:] == b'CH' and magic[:2].isdigit():
        return int(magic[:2].decode('ascii'))
    # xxCN (e.g., 16CN — rare)
    if len(magic) == 4 and magic[2:] == b'CN' and magic[:2].isdigit():
        return int(magic[:2].decode('ascii'))
    return 0


def parse_mod(data: bytes):
    if len(data) < 0x43C:
        sys.exit("error: file too short to be a ProTracker module")

    title = data[0x00:0x14].rstrip(b'\x00').decode('latin-1', errors='replace')

    # 31 sample headers
    samples = []
    for i in range(MOD_NUM_SAMPLES):
        base = 0x14 + i * 30
        s = ModSample()
        s.name        = data[base:base+22].rstrip(b'\x00').decode('latin-1', errors='replace')
        s.length      = struct.unpack_from('>H', data, base + 22)[0] * 2
        s.finetune    = data[base + 24] & 0x0F     # signed nibble 0..15
        s.volume      = data[base + 25]            # 0..64
        s.loop_begin  = struct.unpack_from('>H', data, base + 26)[0] * 2
        loop_len_w    = struct.unpack_from('>H', data, base + 28)[0]
        loop_len      = loop_len_w * 2
        s.loop_end    = s.loop_begin + loop_len
        # Flag bit 0 = looped (loop_len > 2 by convention; loop_len_w == 1 means no loop)
        s.flags       = 1 if loop_len_w > 1 else 0
        if not s.flags:
            s.loop_begin = 0
            s.loop_end   = 0
        s.sample_data = b''
        s.c2spd       = round(8363.0 * (2.0 ** (_signed4(s.finetune) / 96.0)))
        samples.append(s)

    song_length = data[0x3B6]
    # 0x3B7 = restart byte (unused by us)
    order_table = list(data[0x3B8:0x438])

    magic = data[0x438:0x43C]
    n_channels = _parse_magic(magic)
    if n_channels == 0:
        # Some very old MODs have only 15 samples and no magic. Detect 15-sample MOD.
        # Header is 0x14 (title) + 15*30 (samples) = 0x14 + 0x1C2 = 0x1D6.
        # Order table at 0x1D6, then 0x1D6+0x80 = 0x256, then patterns directly.
        # We don't auto-detect that; require a magic.
        sys.exit(f"error: unrecognised MOD magic {magic!r} at 0x438; "
                 f"expected M.K., M!K!, FLT4, FLT8, xCHN or xxCH")

    # Order list: only the first song_length entries are part of the song.
    # Pattern count = 1 + max(order_table[0..127]) (scan all 128).
    n_patterns = 1 + max(order_table)

    pat_data_off = 0x43C
    cell_size    = 4
    pattern_size = MOD_PATTERN_ROWS * n_channels * cell_size

    # Parse patterns
    patterns = []   # patterns[pat_idx][channel][row] -> ModRow
    for pi in range(n_patterns):
        grid = [[ModRow() for _ in range(MOD_PATTERN_ROWS)] for _ in range(n_channels)]
        base = pat_data_off + pi * pattern_size
        if base + pattern_size > len(data):
            vprint(f"  warning: pattern {pi} truncated; padding with empty rows")
            patterns.append(grid)
            continue
        for r in range(MOD_PATTERN_ROWS):
            row_off = base + r * n_channels * cell_size
            for ch in range(n_channels):
                cell_off = row_off + ch * cell_size
                b0 = data[cell_off]
                b1 = data[cell_off + 1]
                b2 = data[cell_off + 2]
                b3 = data[cell_off + 3]
                period = ((b0 & 0x0F) << 8) | b1
                inst   = (b0 & 0xF0) | ((b2 >> 4) & 0x0F)
                effect = b2 & 0x0F
                arg    = b3
                # MT-style PT-strict cell rewrites (LoaderMOD.cpp:354-365):
                # PT does not recall arg for portamento up/down (1xx, 2xx) or
                # volume slide (Axx); the literal arg is read every tick. The
                # vol-slide nibbles in 5xx/6xx likewise take literal args, with
                # the recalled state living in the porta/vibrato side. So a
                # zero-arg cell decays to a no-slide variant: 1/2/A drop to
                # no-op, 5 collapses to bare tone-porta (3), 6 to bare vibrato
                # (4). Without this, resolve_pt_recalls would back-fill these
                # zero args from the cohort memory and produce a continuous
                # slide where PT plays a single-row swell (canonical bug:
                # GSLINGER ord 0x03 ch1 — `5 01` on r30/r38 with `5 00` on the
                # rest, was fading 24→0 in 5 rows instead of stair-stepping
                # 24→14 across 16 rows).
                if arg == 0:
                    if effect in (0x1, 0x2, 0xA):
                        effect = 0x0
                    elif effect == 0x5:
                        effect = 0x3
                    elif effect == 0x6:
                        effect = 0x4
                cell = grid[ch][r]
                cell.period     = period
                cell.inst       = inst
                cell.effect     = effect
                cell.effect_arg = arg
        patterns.append(grid)

    # Sample data follows pattern data
    sample_off = pat_data_off + n_patterns * pattern_size
    for s in samples:
        if s.length == 0:
            continue
        n = min(s.length, max(0, len(data) - sample_off))
        if n <= 0:
            break
        raw = data[sample_off:sample_off + n]
        # PT samples are signed 8-bit; convert to unsigned by XOR 0x80.
        s.sample_data = bytes((b ^ 0x80) for b in raw)
        s.length      = len(s.sample_data)
        if s.flags:
            s.loop_begin = min(s.loop_begin, s.length)
            s.loop_end   = min(s.loop_end,   s.length)
        sample_off += n

    return {
        'title':      title,
        'samples':    samples,
        'order_list': order_table[:song_length],
        'order_full': order_table,
        'n_channels': n_channels,
        'n_patterns': n_patterns,
        'patterns':   patterns,
        'magic':      magic,
    }


def _signed4(nibble: int) -> int:
    """Convert a 4-bit unsigned nibble to signed -8..+7."""
    return nibble - 16 if nibble >= 8 else nibble


# ── Note encoding (period → Taud) ────────────────────────────────────────────

def period_to_taud_note(period: int) -> int:
    if period <= 0:
        return NOTE_NOP
    val = round(TAUD_C4 + 4096.0 * math.log2(PT_REFERENCE_PERIOD / period))
    return max(0x20, min(0xFFFF, val))


# ── PT effect → Taud effect ──────────────────────────────────────────────────

def encode_effect(cmd: int, arg: int, ch: int = 0, row: int = 0) -> tuple:
    """Return (taud_op, taud_arg16, vol_override, pan_override).

    The caller is responsible for resolving PT zero-arg recalls before this
    point — see resolve_pt_recalls(). cmd is the raw PT digit ($0..$F).
    """
    # $0 with arg 0 is a true no-op; $0 with arg != 0 is arpeggio.
    if cmd == 0x0:
        if arg == 0:
            return (TOP_NONE, 0, None, None)
        hi = (arg >> 4) & 0xF
        lo = arg & 0xF
        return (TOP_J, (J_SEMI_TABLE[hi] << 8) | J_SEMI_TABLE[lo], None, None)

    # PT is Amiga-cycle-based by definition (the Taud Amiga-mode flag is set in
    # the song table, see end of build_taud()).  E/F coarse pitch-slide arguments
    # are therefore stored as raw PT period units; the engine consumes them
    # directly in period space.  G (tone portamento) is treated as linear even
    # in Amiga mode per the Taud spec, so its argument is still quantised to
    # 4096-TET units.  Fine slides (E1x/E2x below) likewise remain linear.
    if cmd == 0x1:
        return (TOP_F, arg & 0xFFFF, None, None)

    if cmd == 0x2:
        return (TOP_E, arg & 0xFFFF, None, None)

    if cmd == 0x3:
        return (TOP_G, round(arg * 64 / 3) & 0xFFFF, None, None)

    if cmd == 0x4:
        hi = (arg >> 4) & 0xF
        lo = arg & 0xF
        return (TOP_H, ((hi * 0x11) << 8) | (lo * 0x11), None, None)

    if cmd == 0x5:
        # Tone porta + vol slide → Taud L verbatim. PT's 500 recall is already
        # collapsed by resolve_pt_recalls; if the source had no prior 5xy the
        # resolved arg is 0, which Taud's L $0000 then recalls from L's own
        # private memory. Emitting a real L (rather than the previous
        # G+vol-col split) preserves the slide on rows that also carry a
        # vol-column SET (e.g., a Cxx fold) — see TAUD_NOTE_EFFECTS.md §L.
        return (TOP_L, (arg & 0xFF) << 8, None, None)

    if cmd == 0x6:
        # Vibrato + vol slide → Taud K verbatim (same rationale as 0x5).
        return (TOP_K, (arg & 0xFF) << 8, None, None)

    if cmd == 0x7:
        hi = (arg >> 4) & 0xF
        lo = arg & 0xF
        return (TOP_R, ((hi * 0x11) << 8) | (lo * 0x11), None, None)

    if cmd == 0x8:
        # PT 8xx is fine pan (or unused/sync in some trackers). Map to pan
        # column 0.$yy where yy is the upper 6 bits of the 8-bit pan.
        return (TOP_NONE, 0, None, (SEL_SET, (arg >> 2) & 0x3F))

    if cmd == 0x9:
        return (TOP_O, (arg & 0xFF) << 8, None, None)

    if cmd == 0xA:
        # Route Axy via Taud's effect-column D so it can coexist with a Cxx
        # SET on the same row. (Vol-column slide selectors share the cell with
        # the SET selector — when both Cxx and Axy land on a trigger row the
        # vol-col slot can only encode one, and the slide gets dropped, losing
        # 5 ticks of slide per row.) Resolution-time A00 is already collapsed
        # to a concrete arg in resolve_pt_recalls; a remaining 0 means truly
        # no-op (memory was empty), so emit nothing rather than D 00 (which
        # would recall TSVM's D memory).
        if arg == 0:
            return (TOP_NONE, 0, None, None)
        return (TOP_D, (arg & 0xFF) << 8, None, None)

    if cmd == 0xB:
        return (TOP_B, arg & 0xFF, None, None)

    if cmd == 0xC:
        # Caller folds Cxx into vol_set during parsing; this branch is a
        # safety net in case a Cxx slips through.
        return (TOP_NONE, 0, (SEL_SET, min(arg, 0x3F)), None)

    if cmd == 0xD:
        # PT pattern break is BCD on disk.
        bcd_row = ((arg >> 4) & 0xF) * 10 + (arg & 0xF)
        if bcd_row >= PATTERN_ROWS:
            bcd_row = 0
        return (TOP_C, bcd_row & 0xFF, None, None)

    if cmd == 0xE:
        sub = (arg >> 4) & 0xF
        x   = arg & 0xF
        if sub == 0x0:
            # E0x = filter on/off (Amiga LED filter); no Taud equivalent.
            return (TOP_NONE, 0, None, None)
        if sub == 0x1:
            # Fine pitch up — raw PT period units in Amiga mode (file is always Amiga).
            return (TOP_F, 0xF000 | (x & 0xFFF), None, None)
        if sub == 0x2:
            # Fine pitch down — raw PT period units in Amiga mode.
            return (TOP_E, 0xF000 | (x & 0xFFF), None, None)
        if sub == 0x3:
            return (TOP_S, 0x1000 | (x << 8), None, None)
        if sub == 0x4:
            return (TOP_S, 0x3000 | (x << 8), None, None)
        if sub == 0x5:
            return (TOP_S, 0x2000 | (x << 8), None, None)
        if sub == 0x6:
            return (TOP_S, 0xB000 | (x << 8), None, None)
        if sub == 0x7:
            return (TOP_S, 0x4000 | (x << 8), None, None)
        if sub == 0x8:
            # Coarse pan (4-bit). Map nibble 0..15 to pan 0..63 via × 4.2.
            return (TOP_NONE, 0, None, (SEL_SET, round(x * 4.2)))
        if sub == 0x9:
            return (TOP_Q, (x & 0xF) << 8, None, None)
        if sub == 0xA:
            # Fine vol slide up.
            return (TOP_NONE, 0, (SEL_FINE, (x & 0xF) | 0x20), None)
        if sub == 0xB:
            # Fine vol slide down.
            return (TOP_NONE, 0, (SEL_FINE, x & 0xF), None)
        if sub == 0xC:
            return (TOP_S, 0xC000 | (x << 8), None, None)
        if sub == 0xD:
            return (TOP_S, 0xD000 | (x << 8), None, None)
        if sub == 0xE:
            return (TOP_S, 0xE000 | (x << 8), None, None)
        if sub == 0xF:
            funk_table = [0, 5, 6, 7, 8, 0xA, 0xB, 0xD, 0x10, 0x13, 0x16, 0x1A, 0x20, 0x2B, 0x40, 0x80]
            return (TOP_S, 0xF000 | funk_table[x], None, None)
        return (TOP_NONE, 0, None, None)

    if cmd == 0xF:
        if arg < 0x20:
            if arg == 0:
                return (TOP_NONE, 0, None, None)
            return (TOP_A, (arg & 0xFF) << 8, None, None)
        return (TOP_T, ((arg - 0x19) & 0xFF) << 8, None, None)

    return (TOP_NONE, 0, None, None)


def relocate_late_note_delays(patterns: list, order_list: list,
                              n_channels: int, initial_speed: int) -> None:
    """Move EDx-delayed notes to the next row when x ≥ tick speed.

    PT triggers a Note Delay during the current row; if x reaches the tick
    speed, the trigger never lands. When the next row in the same channel is
    empty, relocate the note (with delay = x − speed) so it actually plays.
    """
    visited = set()
    for order in order_list:
        if order >= 0xFF:
            break
        if order >= len(patterns) or order in visited:
            continue
        visited.add(order)
        grid = patterns[order]
        speed = initial_speed
        for r in range(MOD_PATTERN_ROWS):
            for ch in range(min(n_channels, len(grid))):
                row = grid[ch][r]
                if row.effect == 0xF and 0 < row.effect_arg < 0x20:
                    speed = row.effect_arg
                    break
            if r + 1 >= MOD_PATTERN_ROWS or speed <= 0:
                continue
            for ch in range(min(n_channels, len(grid))):
                row = grid[ch][r]
                if row.effect != 0xE or row.period == 0:
                    continue
                if ((row.effect_arg >> 4) & 0xF) != 0xD:
                    continue
                x = row.effect_arg & 0xF
                if x < speed:
                    continue
                nxt = grid[ch][r + 1]
                if (nxt.period or nxt.inst or nxt.effect or nxt.effect_arg
                        or nxt.vol_set != -1):
                    continue
                new_delay = x - speed
                nxt.period     = row.period
                nxt.inst       = row.inst
                nxt.vol_set    = row.vol_set
                if new_delay > 0:
                    nxt.effect     = 0xE
                    nxt.effect_arg = 0xD0 | (new_delay & 0xF)
                row.period     = 0
                row.inst       = 0
                row.effect     = 0
                row.effect_arg = 0
                row.vol_set    = -1
                vprint(f"  fix: pat{order} ch{ch} row{r}: ED{x:X} ≥ speed{speed}, "
                       f"moved note to row{r+1}"
                       + (f" with ED{new_delay:X}" if new_delay > 0 else ""))


def resolve_pt_recalls(patterns: list, order_list: list, n_channels: int) -> None:
    """In-place: replace PT zero-arg recalls with each effect's last non-zero arg.

    PT memory is per-effect-private. Walking patterns in order-list order,
    we track each channel's last non-zero arg per memorising effect and
    rewrite recall args to make them explicit.
    """
    # mem[ch][key] = last_non_zero_arg
    # key is either an int (top-level 0..F) or a tuple ('E', sub) for E-subs.
    mem = [dict() for _ in range(n_channels)]
    for order in order_list:
        if order >= 0xFF:
            break
        if order >= len(patterns):
            continue
        grid = patterns[order]
        for r in range(MOD_PATTERN_ROWS):
            for ch in range(n_channels):
                if ch >= len(grid):
                    continue
                row = grid[ch][r]
                cmd = row.effect
                arg = row.effect_arg
                if cmd in PT_MEM_TOP:
                    if arg == 0:
                        row.effect_arg = mem[ch].get(cmd, 0)
                    else:
                        mem[ch][cmd] = arg
                elif cmd == 0xE:
                    sub = (arg >> 4) & 0xF
                    x   = arg & 0xF
                    if sub in PT_MEM_E_SUB:
                        key = ('E', sub)
                        if x == 0:
                            recalled = mem[ch].get(key, 0)
                            row.effect_arg = (sub << 4) | (recalled & 0xF)
                        else:
                            mem[ch][key] = x


# ── Sample resampling and Taud sample/instrument bin (port of s3m2taud) ──────

def build_sample_inst_bin(samples: list) -> tuple:
    """Returns (bin_bytes[786432], offsets_dict, slot_ratios). 1-based indexing.

    slot_ratios maps Taud slot → the ratio that slot's sample was resampled by
    (for TOP_O rescaling); slot 0 — an O before any instrument byte — gets the
    pass's nominal ratio."""
    pcm = [(i, s) for i, s in enumerate(samples) if s.sample_data]

    total = sum(len(s.sample_data) for _, s in pcm)
    ratio = 1.0
    slot_ratios = {}
    if total > SAMPLEBIN_SIZE:
        ratio = SAMPLEBIN_SIZE / total
        vprint(f"  info: sample bin overflow ({total} bytes); resampling all by {ratio:.4f}")
        slot_ratios[0] = ratio
        for i, s in pcm:
            # Each looped sample gets the ratio that keeps its loop a whole
            # number of frames (taud_common.loop_resample_ratio).
            r = loop_resample_ratio(ratio, [(s.loop_begin, s.loop_end)] if (s.flags & 1) else [])
            s.sample_data = resample_linear(s.sample_data, r)
            s.length      = len(s.sample_data)
            s.loop_begin, s.loop_end = scale_loop(s.loop_begin, s.loop_end, r, s.length)
            s.c2spd       = max(1, round(s.c2spd * r))
            slot_ratios[i + 1] = r

    sample_bin = bytearray(SAMPLEBIN_SIZE)
    offsets    = {}
    pos        = 0
    for idx, s in pcm:
        n = min(len(s.sample_data), SAMPLEBIN_SIZE - pos)
        if n <= 0:
            vprint(f"  warning: sample bin full, dropping '{s.name}'")
            offsets[idx] = 0
            s.length = 0
            continue
        sample_bin[pos:pos+n] = s.sample_data[:n]
        offsets[idx] = pos
        if n < len(s.sample_data):
            vprint(f"  warning: '{s.name}' truncated from {len(s.sample_data)} to {n}")
            s.length   = n
            s.loop_end = min(s.loop_end, n)
        pos += n

    # New 256-byte instrument layout (terranmon.txt:2001+).
    INST_STRIDE = 256
    inst_bin = bytearray(INSTBIN_SIZE)
    for i, s in enumerate(samples):
        taud_idx = i + 1     # 1-based instrument number
        if i >= 256:
            break
        if not s.sample_data:
            continue
        ptr      = offsets.get(i, 0) & 0xFFFFFFFF
        s_len    = min(s.length, 65535)
        c2spd    = min(s.c2spd, 65535)
        ps       = 0
        ls       = min(s.loop_begin, 65535)
        le       = min(s.loop_end,   65535)
        loop_mode = 1 if (s.flags & 1) else 0
        flags_byte = loop_mode & 0x3
        # Envelope first point is full-scale; per-trigger initial level is
        # carried by Default Note Volume (byte 196) so the envelope must
        # contribute a unit multiplier.
        env_vol   = 63
        # MOD has no envelopes; vol LOOP word b=1 just so the engine evaluates
        # the unit envelope, plus P=1 (envelope present) for consistency with
        # the new gate spec (terranmon.txt byte 16/18/20 bit 5). Pan/PF stay
        # fully zero — the engine sees P=0 there and skips them.
        vol_env_loop = 0x2020   # P (bit 13) | b (bit 5)

        base = taud_idx * INST_STRIDE
        struct.pack_into('<I', inst_bin, base + 0,  ptr)
        struct.pack_into('<H', inst_bin, base + 4,  s_len)
        struct.pack_into('<H', inst_bin, base + 6,  c2spd)
        struct.pack_into('<H', inst_bin, base + 8,  ps)
        struct.pack_into('<H', inst_bin, base + 10, ls)
        struct.pack_into('<H', inst_bin, base + 12, le)
        inst_bin[base + 14] = flags_byte
        # LOOP words at 15/17/19; SUSTAIN words at 189/191/193 (left zero).
        struct.pack_into('<H', inst_bin, base + 15, vol_env_loop)
        struct.pack_into('<H', inst_bin, base + 17, 0)
        struct.pack_into('<H', inst_bin, base + 19, 0)
        inst_bin[base + 21] = env_vol
        inst_bin[base + 22] = 0
        # MOD has no continuous instrumentwise volume scaler — its `s.volume`
        # (0..64) is purely the per-trigger initial value. Byte 171 (IGV)
        # stays at full and byte 196 (DNV) carries the per-instrument default.
        # Pre-2026-05-09 layout folded s.volume into IGV — see terranmon §2350.
        inst_bin[base + 171] = 0xFF                                                 # IGV: continuous unity
        inst_bin[base + 177] = 0x80 # default pan = centre (unused; pan env "p" flag not set)
        inst_bin[base + 182] = 0xFF # filter cutoff = off
        inst_bin[base + 183] = 0xFF # filter resonance = off
        inst_bin[base + 186] = 1 # NNA: note cut
        inst_bin[base + 196] = min(0xFF, round(min(s.volume, 64) * 255 / 64))       # DNV

        vprint(f"  instrument[{taud_idx}] '{s.name}' ptr={ptr} c2spd={s.c2spd} "
               f"vol={s.volume} loop=({ls},{le},{'on' if loop_mode else 'off'})")

    return bytes(sample_bin) + bytes(inst_bin), offsets, slot_ratios


# ── Pattern build ────────────────────────────────────────────────────────────

# PT hard-pans channels in LRRL order: 0=L 1=R 2=R 3=L (and tile for >4).
def _default_channel_pan(ch_idx: int) -> int:
    side = (ch_idx % 4)
    return 8 if side in (0, 3) else 55


def build_pattern(grid: list, ch_idx: int, default_pan: int,
                  inst_vols: dict) -> bytes:
    """Build a 512-byte Taud pattern for one MOD channel.

    Volume column: explicit Cxx → SEL_SET; effect-folded vol slide → vol_override;
    otherwise SEL_FINE/0 (no-op). Per-instrument default volume lives in DNV
    (byte 196) and is consulted by the engine when the trigger row has no V
    column — the converter doesn't need to emit SEL_SET=Sv on plain triggers.
    """
    out = bytearray(PATTERN_BYTES)
    rows = grid[ch_idx] if ch_idx < len(grid) else [ModRow()] * MOD_PATTERN_ROWS
    last_inst = 0
    last_period = 0
    for r, row in enumerate(rows[:MOD_PATTERN_ROWS]):
        note_taud = period_to_taud_note(row.period)
        note_triggers = (row.period > 0)

        if row.inst > 0:
            last_inst = row.inst

        op, arg, vol_override, pan_override = encode_effect(
            row.effect, row.effect_arg, ch_idx, r)

        # ── Volume column ──
        if row.vol_set >= 0:
            vol_sel, vol_value = SEL_SET, min(row.vol_set, 0x3F)
            if vol_override is not None and vol_override[0] != SEL_SET:
                vprint(f"    ch{ch_idx} row{r}: dropped vol slide "
                       f"(cell already carries explicit Cxx volume)")
        elif vol_override is not None:
            vol_sel, vol_value = vol_override
        else:
            vol_sel, vol_value = SEL_FINE, 0

        if note_triggers:
            last_period = row.period

        # ── Pan column ──
        if pan_override is not None:
            pan_sel, pan_value = pan_override
        elif r == 0:
            pan_sel, pan_value = SEL_SET, default_pan & 0x3F
        else:
            pan_sel, pan_value = SEL_FINE, 0

        vol_byte = (vol_value & 0x3F) | ((vol_sel & 0x3) << 6)
        pan_byte = (pan_value & 0x3F) | ((pan_sel & 0x3) << 6)

        base = r * 8
        struct.pack_into('<H', out, base + 0, note_taud)
        out[base + 2] = row.inst & 0xFF
        out[base + 3] = vol_byte
        out[base + 4] = pan_byte
        out[base + 5] = op & 0xFF
        struct.pack_into('<H', out, base + 6, arg & 0xFFFF)
    return bytes(out)


def build_cue_sheet(order_list: list, n_pats_mod: int, n_channels: int,
                    pat_remap: dict = None) -> bytes:
    sheet = bytearray(NUM_CUES * CUE_SIZE)
    for c in range(NUM_CUES):
        sheet[c*CUE_SIZE : c*CUE_SIZE+CUE_SIZE] = encode_cue([], 0)

    cue_idx = 0
    last_active = -1
    for order in order_list:
        if order == 0xFF or cue_idx >= NUM_CUES:
            break
        if order == 0xFE:
            continue
        if order >= n_pats_mod:
            continue
        orig = [order * n_channels + v for v in range(n_channels)]
        pats = [pat_remap[p] if pat_remap else p for p in orig]
        sheet[cue_idx*CUE_SIZE : cue_idx*CUE_SIZE+CUE_SIZE] = encode_cue(pats, 0)
        last_active = cue_idx
        cue_idx += 1

    if last_active >= 0:
        set_cue_instruction(sheet, last_active, CUE_INST_HALT)
    elif cue_idx < NUM_CUES:
        set_cue_instruction(sheet, 0, CUE_INST_HALT)

    return finalize_cue_sheet(sheet)[0]


def find_initial_bpm_speed(patterns: list, order_list: list) -> tuple:
    """Scan first pattern in order for Fxx in row 0 of any channel."""
    speed = 6
    tempo = 125
    for order in order_list:
        if order >= 0xFF:
            break
        if order >= len(patterns):
            continue
        grid = patterns[order]
        for ch_rows in grid:
            row = ch_rows[0]
            if row.effect == 0xF and row.effect_arg > 0:
                if row.effect_arg < 0x20:
                    speed = row.effect_arg
                else:
                    tempo = row.effect_arg
        break
    return speed, tempo


def _per_pattern_bxx_mod(patterns: list, n_channels: int):
    """Return callable(pat_idx) → (set_of_bxx_target_orders, kills_fallthrough)
    for `detect_subsongs`. MOD patterns are 64 rows × n_channels; Bxx is
    raw effect digit 0xB.
    """
    def fn(pat_idx: int):
        if pat_idx < 0 or pat_idx >= len(patterns):
            return set(), False
        grid = patterns[pat_idx]
        targets = set()
        last_row_has_b = False
        for ch in range(min(n_channels, len(grid))):
            ch_rows = grid[ch]
            for r in range(min(PATTERN_ROWS, len(ch_rows))):
                cell = ch_rows[r]
                if cell.effect == 0xB:
                    targets.add(cell.effect_arg & 0xFF)
                    if r == PATTERN_ROWS - 1:
                        last_row_has_b = True
        return targets, last_row_has_b
    return fn


def _build_song_payload_mod(mod: dict, patterns_template: list,
                            positions: list, sample_ratio: dict,
                            inst_vols: dict, n_channels: int,
                            *, song_label: str = 'song') -> tuple:
    """Build pattern bin + cue sheet + song-entry kwargs for one MOD subsong.

    `patterns_template` is deep-copied so per-song stateful transforms
    (recall resolution, late-note-delay relocation, Bxx remap) don't leak
    into the next subsong.
    """
    patterns = copy.deepcopy(patterns_template)
    order_list = mod['order_list']
    virtual_orders = [order_list[pos] for pos in positions]

    vprint(f"  [{song_label}] resolving PT per-effect recalls…")
    resolve_pt_recalls(patterns, virtual_orders, n_channels)

    init_speed, _ = find_initial_bpm_speed(patterns, virtual_orders)
    relocate_late_note_delays(patterns, virtual_orders, n_channels, init_speed)

    speed, tempo = find_initial_bpm_speed(patterns, virtual_orders)
    tempo = max(25, min(280, tempo))
    bpm_stored = (tempo - 25) & 0xFF
    vprint(f"  [{song_label}] initial speed={speed}, tempo(BPM)={tempo}")

    n_patterns = mod['n_patterns']

    # Cue list and pos→cue mapping, skipping orders that aren't valid pattern refs.
    cue_list = []
    pos_to_cue = {}
    for pos in positions:
        order = order_list[pos]
        if order >= n_patterns:
            continue
        pos_to_cue[pos] = len(cue_list)
        cue_list.append(order)

    # Densely renumber the patterns this song uses.
    used_ordered = []
    seen = set()
    for src_pat in cue_list:
        if src_pat not in seen:
            used_ordered.append(src_pat)
            seen.add(src_pat)
    pat_idx_remap = {src: i for i, src in enumerate(used_ordered)}
    P_used = len(used_ordered)

    if P_used * n_channels > NUM_PATTERNS_MAX:
        sys.exit(f"error: [{song_label}] {P_used} patterns × {n_channels} channels = "
                 f"{P_used*n_channels} > {NUM_PATTERNS_MAX} Taud pattern limit.")

    # Bxx remap on the patterns this song actually emits.
    crossings = 0
    for src_pat in used_ordered:
        if src_pat >= len(patterns): continue
        grid = patterns[src_pat]
        for ch in range(min(n_channels, len(grid))):
            for row in grid[ch]:
                if row.effect == 0xB:
                    if row.effect_arg in pos_to_cue:
                        row.effect_arg = pos_to_cue[row.effect_arg] & 0xFF
                    else:
                        crossings += 1
                        row.effect_arg = 0
    if crossings:
        vprint(f"  warning: [{song_label}]: {crossings} Bxx target(s) cross "
               f"subsong boundary; clamped to cue 0")

    pat_bin = bytearray()
    for src_pat in used_ordered:
        grid = patterns[src_pat]
        for ch in range(n_channels):
            default_pan = _default_channel_pan(ch)
            pat_bin += build_pattern(grid, ch, default_pan, inst_vols)
    pat_bin = rescale_offset_effects_per_slot(bytes(pat_bin), P_used, n_channels, sample_ratio)

    orig_count = P_used * n_channels
    pat_bin, pat_remap, num_taud_pats = deduplicate_patterns(pat_bin, orig_count)
    vprint(f"  [{song_label}] patterns: {orig_count} → {num_taud_pats} unique "
           f"({orig_count - num_taud_pats} deduplicated)")

    sheet = bytearray(NUM_CUES * CUE_SIZE)
    for c in range(NUM_CUES):
        sheet[c*CUE_SIZE:c*CUE_SIZE+CUE_SIZE] = encode_cue([], 0)

    last_active = -1
    for cue_idx, src_pat in enumerate(cue_list):
        if cue_idx >= NUM_CUES: break
        new_pat_idx = pat_idx_remap[src_pat]
        orig_pats = [new_pat_idx * n_channels + v for v in range(n_channels)]
        sheet[cue_idx*CUE_SIZE:(cue_idx+1)*CUE_SIZE] = encode_cue(
            [pat_remap[p] for p in orig_pats], 0)
        last_active = cue_idx

    if last_active >= 0:
        set_cue_instruction(sheet, last_active, CUE_INST_HALT)
    else:
        set_cue_instruction(sheet, 0, CUE_INST_HALT)

    cue_bytes, num_cues = finalize_cue_sheet(sheet)
    pat_comp = compress_blob(bytes(pat_bin), f"[{song_label}] pattern bin")
    cue_comp = compress_blob(cue_bytes,      f"[{song_label}] cue sheet")

    flags_byte = GLOBAL_FLAGS_AMIGA_FREQ | GLOBAL_FLAGS_A500_INTP
    entry_kwargs = dict(
        num_voices=n_channels,
        num_patterns=num_taud_pats,
        bpm_stored=bpm_stored,
        tick_rate=speed,
        base_note=0xA000,
        base_freq=8363.0,
        flags_byte=flags_byte,
        pat_bin_comp_size=len(pat_comp),
        cue_sheet_comp_size=len(cue_comp),
        global_vol=0xFF,
        mixing_vol=180,
        num_cues=num_cues,
    )
    return pat_comp, cue_comp, entry_kwargs


def assemble_taud(mod: dict, with_project_data: bool = True) -> bytes:
    samples    = mod['samples']
    patterns   = mod['patterns']
    order_list = mod['order_list']
    n_channels = mod['n_channels']
    n_patterns = mod['n_patterns']

    if n_channels > NUM_VOICES:
        vprint(f"  warning: MOD has {n_channels} channels; truncating to {NUM_VOICES}")
        n_channels = NUM_VOICES
    vprint(f"  channels: {n_channels}, mod patterns: {n_patterns}")

    # Fold Cxx into row.vol_set so the volume column carries explicit set-volume.
    # This is non-stateful (doesn't depend on order list) so it runs once on the
    # shared template; per-song deepcopies inherit the folded form.
    for grid in patterns:
        for ch in range(min(n_channels, len(grid))):
            for row in grid[ch]:
                if row.effect == 0xC:
                    row.vol_set = min(row.effect_arg, 0x3F)
                    row.effect = 0
                    row.effect_arg = 0

    vprint("  building sample/instrument bin…")
    sampleinst_raw, _offsets, sample_ratio = build_sample_inst_bin(samples)
    assert len(sampleinst_raw) == SAMPLEINST_SIZE
    compressed = compress_blob(sampleinst_raw, "sample+inst bin")
    comp_size  = len(compressed)

    inst_vols = {
        i + 1: min(s.volume, 0x3F)
        for i, s in enumerate(samples)
        if s.sample_data
    }

    # ── Detect subsongs ──────────────────────────────────────────────────────
    # MOD shares IT/S3M's 0xFF-end / 0xFE-skip convention; orders ≥ n_patterns
    # are also unplayable and treated as skips by the player (build_cue_sheet).
    skip_set = set([0xFE]) | set(range(n_patterns, 256))
    subsongs = detect_subsongs(order_list,
                               _per_pattern_bxx_mod(patterns, n_channels),
                               terminators=(0xFF,),
                               skip_marker=skip_set)
    if not subsongs:
        vprint("  warning: no traversable orders in source; emitting empty song")
        subsongs = [{'entry': 0, 'positions': []}]
    n_songs = len(subsongs)
    if n_songs == 1:
        vprint(f"  detected 1 song ({len(subsongs[0]['positions'])} orders)")
    else:
        vprint(f"  detected {n_songs} subsongs:")
        for i, ss in enumerate(subsongs):
            vprint(f"    song {i}: entry@{ss['entry']}, {len(ss['positions'])} orders")

    # ── Build per-song payloads ──────────────────────────────────────────────
    song_payloads = []
    for i, ss in enumerate(subsongs):
        label = f"song {i}" if n_songs > 1 else "song"
        song_payloads.append(_build_song_payload_mod(
            mod, patterns, ss['positions'], sample_ratio, inst_vols,
            n_channels, song_label=label))

    # ── Layout offsets and song table ────────────────────────────────────────
    song_table_off = TAUD_HEADER_SIZE + comp_size
    first_song_off = song_table_off + TAUD_SONG_ENTRY * n_songs

    song_table = bytearray()
    cur_off = first_song_off
    for pat_comp, cue_comp, entry_kwargs in song_payloads:
        entry = encode_song_entry(song_offset=cur_off, **entry_kwargs)
        assert len(entry) == TAUD_SONG_ENTRY
        song_table += entry
        cur_off += len(pat_comp) + len(cue_comp)

    # Project Data (optional). MOD samples *are* its instruments — the same
    # names populate INam and SNam, but with different indexing: INam is
    # slot-indexed (slot 0 empty, sample #1 → slot $01), while SNam is
    # pool-ordered and 0-based (pool sample i → SNam[i]).
    proj_data = b''
    proj_off  = 0
    if with_project_data:
        inst_names = [''] + [s.name for s in samples[:255]]
        smp_names  = [s.name for s in samples[:255]]
        proj_data = build_project_data(
            project_name=mod['title'],
            instrument_names=inst_names,
            sample_names=smp_names,
            song_metadata=[{'index': i, 'notation': PT_NOTATION}
                           for i in range(n_songs)],
        )
        if proj_data:
            proj_off = cur_off
            vprint(f"  project data: {len(proj_data)} bytes @ offset {proj_off}")

    sig = (SIGNATURE + b' ' * 14)[:14]
    header = (
        TAUD_MAGIC +
        bytes([TAUD_VERSION, n_songs & 0xFF]) +
        struct.pack('<I', comp_size) +
        struct.pack('<I', proj_off) +
        sig
    )
    assert len(header) == TAUD_HEADER_SIZE

    out = bytearray()
    out += header
    out += compressed
    out += song_table
    for pat_comp, cue_comp, _ in song_payloads:
        out += pat_comp
        out += cue_comp
    out += proj_data
    return bytes(out)


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('input',  help='Input .mod file')
    ap.add_argument('output', help='Output .taud file')
    ap.add_argument('-v', '--verbose', action='store_true',
                    help='Print conversion details to stderr')
    ap.add_argument('--no-project-data', action='store_true',
                    help='Omit the optional Project Data section '
                         '(song / instrument / sample names)')
    args = ap.parse_args()

    set_verbose(args.verbose)

    with open(args.input, 'rb') as f:
        data = f.read()

    vprint(f"parsing '{args.input}' ({len(data)} bytes)…")
    mod = parse_mod(data)
    vprint(f"  title: '{mod['title']}'")
    vprint(f"  magic: {mod['magic']!r} ({mod['n_channels']} channels)")
    vprint(f"  orders={len(mod['order_list'])}, patterns={mod['n_patterns']}, "
           f"samples={sum(1 for s in mod['samples'] if s.sample_data)}")

    taud = assemble_taud(mod, with_project_data=not args.no_project_data)

    with open(args.output, 'wb') as f:
        f.write(taud)

    print(f"wrote {len(taud)} bytes to '{args.output}'")
    if args.verbose:
        print(f"  magic ok: {taud[:8].hex()}", file=sys.stderr)


if __name__ == '__main__':
    main()
