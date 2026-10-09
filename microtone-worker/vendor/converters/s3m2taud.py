#!/usr/bin/env python3
"""s3m2taud.py — Convert Scream Tracker 3 (.s3m) to TSVM Taud (.taud)

Usage:
    python3 s3m2taud.py input.s3m output.taud [-v]

Limits:
    - Up to 20 S3M channels (excess disabled; hard error if pattern count
      × channel count > 4095).
    - Sample bin is 8 MB (8388608 bytes); if all samples together exceed
      this, every sample is globally resampled down (with c2spd adjusted)
      so pitch is preserved.
    - AdLib instruments are skipped.

Effect support:
    Full A..Z dispatch per TAUD_NOTE_EFFECTS.md "ProTracker to Taud conversion
    table" and "ScreamTracker 3 conversion notes". ST3 shared-memory recalls
    (D/E/F/I/J/K/L/Q/R/S with $00 arg) are eagerly resolved per channel.
    Cxx is BCD-decoded. K/L are split into H $0000 / G $0000 + volume-column
    slide. M/N/X/P fold into volume / pan columns. W (global vol slide)
    converts to Taud W (arg in high byte, same encoding as D). X converts to
    pan column. Y (panbrello) converts
    to Taud Y. S5 selects the panbrello LFO waveform. S8x converts to a pan
    column SET of round(x * 4.2), mapping nibble 0-15 directly to pan 0-63.
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
    TOP_J, TOP_K, TOP_L, TOP_M, TOP_N, TOP_O, TOP_P, TOP_Q, TOP_R, TOP_S, TOP_T, TOP_U, TOP_V, TOP_W, TOP_Y,
    SEL_SET, SEL_UP, SEL_DOWN, SEL_FINE,
    EFF_A, EFF_B, EFF_C, EFF_D, EFF_E, EFF_F, EFF_G, EFF_H, EFF_I, EFF_J,
    EFF_K, EFF_L, EFF_M, EFF_N, EFF_O, EFF_P, EFF_Q, EFF_R, EFF_S, EFF_T,
    EFF_U, EFF_V, EFF_W, EFF_X, EFF_Y, EFF_Z,
    J_SEMI_TABLE,
    d_arg_to_col, resample_linear, rescale_offset_effects_per_slot, encode_cue, deduplicate_patterns,
    loop_resample_ratio, scale_loop,
    finalize_cue_sheet, set_cue_instruction, CUE_INST_HALT,
    normalise_sample, encode_song_entry, compress_blob,
    build_project_data, detect_subsongs,
)


# ── S3M constants ────────────────────────────────────────────────────────────

S3M_MAGIC        = b"SCRM"
S3M_TYPE_PCM     = 1
S3M_NOTE_EMPTY   = 0xFF
S3M_NOTE_OFF     = 0xFE
S3M_ORDER_SKIP   = 0xFE
S3M_ORDER_END    = 0xFF

SIGNATURE        = b"s3m2taud/TSVM "    # 14 bytes

# ST3's single shared memory slot backs these effects.
ST3_SHARED_EFFECTS = frozenset({
    EFF_D, EFF_E, EFF_F, EFF_I, EFF_J, EFF_K, EFF_L, EFF_Q, EFF_R, EFF_S
})


# ── S3M parser ───────────────────────────────────────────────────────────────

class S3MHeader:
    __slots__ = ('title','order_count','inst_count','pat_count',
                 'flags','cwt_v','sample_type','global_vol',
                 'initial_speed','initial_tempo','master_vol',
                 'linear_slides','default_pan_flag',
                 'channel_settings','pan_values','order_list',
                 'inst_ptrs','pat_ptrs')

def parse_s3m(data: bytes) -> S3MHeader:
    if len(data) < 0x60:
        sys.exit("error: file too short to be S3M")
    if data[0x2C:0x30] != S3M_MAGIC:
        sys.exit("error: not an S3M file (bad magic at 0x2C)")

    h = S3MHeader()
    h.title          = data[0x00:0x1C].rstrip(b'\x00').decode('latin-1', errors='replace')
    h.order_count    = struct.unpack_from('<H', data, 0x20)[0]
    h.inst_count     = struct.unpack_from('<H', data, 0x22)[0]
    h.pat_count      = struct.unpack_from('<H', data, 0x24)[0]
    h.flags          = struct.unpack_from('<H', data, 0x26)[0]
    h.cwt_v          = struct.unpack_from('<H', data, 0x28)[0]
    h.sample_type    = data[0x2B]          # 1=signed, 2=unsigned
    h.global_vol     = data[0x30]
    h.initial_speed  = data[0x31]          # ticks per row
    h.initial_tempo  = data[0x32]          # BPM
    h.master_vol     = data[0x33]
    h.linear_slides  = bool(h.flags & 0x40)  # flag bit 6 → linear freq slides
    h.default_pan_flag = data[0x35]        # 0xFC → use pan values

    # Channel settings: bytes 0x40..0x5F; bit 7 = disabled
    h.channel_settings = list(data[0x40:0x60])

    # Order list
    off = 0x60
    h.order_list = list(data[off:off + h.order_count])

    # Instrument parapointers (×16 = file offset)
    off2 = off + h.order_count
    h.inst_ptrs = [struct.unpack_from('<H', data, off2 + i*2)[0] * 16
                   for i in range(h.inst_count)]

    # Pattern parapointers
    off3 = off2 + h.inst_count * 2
    h.pat_ptrs  = [struct.unpack_from('<H', data, off3 + i*2)[0] * 16
                   for i in range(h.pat_count)]

    # Default pan values (if present)
    pan_off = off3 + h.pat_count * 2
    h.pan_values = []
    if h.default_pan_flag == 0xFC and pan_off + h.inst_count <= len(data):
        for i in range(h.inst_count):
            h.pan_values.append(data[pan_off + i])
    # per-channel pan is in channel settings nibbles (separate from above)

    return h


class S3MInstrument:
    __slots__ = ('itype','filename','memseg','length','loop_begin','loop_end',
                 'volume','flags','c2spd','name','sample_data','signed')

def parse_instruments(data: bytes, h: S3MHeader) -> list:
    insts = []
    for ptr in h.inst_ptrs:
        if ptr + 0x50 > len(data):
            vprint(f"  warning: instrument pointer {ptr:#x} out of range, skipping")
            insts.append(None)
            continue
        inst = S3MInstrument()
        inst.itype    = data[ptr]
        # 12-byte DOS filename field; null-terminated with possible trailing
        # garbage after the terminator (ST3 doesn't zero the tail). Truncate at
        # the first null. This field carries the per-sample short name (e.g.
        # 'HIT1') as distinct from the 28-byte title at 0x30.
        inst.filename = data[ptr+1:ptr+13].split(b'\x00', 1)[0].decode('latin-1', errors='replace')
        # memseg: 3 bytes at offsets 0x0D,0x0E,0x0F — high byte first (quirk)
        memseg_hi  = data[ptr + 0x0D]
        memseg_lo  = struct.unpack_from('<H', data, ptr + 0x0E)[0]
        inst.memseg   = (memseg_hi << 16) | memseg_lo
        inst.length   = struct.unpack_from('<I', data, ptr + 0x10)[0]
        inst.loop_begin = struct.unpack_from('<I', data, ptr + 0x14)[0]
        inst.loop_end   = struct.unpack_from('<I', data, ptr + 0x18)[0]
        inst.volume   = data[ptr + 0x1C]
        inst.flags    = data[ptr + 0x1F]     # bit0=loop, bit1=stereo, bit2=16bit
        inst.c2spd    = struct.unpack_from('<I', data, ptr + 0x20)[0] or 8363
        inst.name     = data[ptr + 0x30:ptr + 0x4C].rstrip(b'\x00').decode('latin-1', errors='replace')
        inst.signed   = (h.sample_type == 1)
        inst.sample_data = b''

        if inst.itype == S3M_TYPE_PCM:
            sample_off = inst.memseg * 16
            sample_len = inst.length
            is_16bit  = bool(inst.flags & 4)
            is_stereo = bool(inst.flags & 2)
            if sample_off + sample_len > len(data):
                vprint(f"  warning: sample '{inst.name}' data out of range, zeroing")
                inst.sample_data = bytes(min(sample_len, 256))
            else:
                raw = data[sample_off:sample_off + sample_len]
                inst.sample_data = normalise_sample(raw, inst.signed, is_16bit, is_stereo, inst.name)
                inst.length      = len(inst.sample_data)
                inst.loop_begin  = min(inst.loop_begin, inst.length)
                inst.loop_end    = min(inst.loop_end,   inst.length)
        insts.append(inst)
    return insts


# ── S3M pattern parser ───────────────────────────────────────────────────────

class S3MRow:
    """One cell in a pattern grid."""
    __slots__ = ('note','inst','vol','effect','effect_arg')
    def __init__(self):
        self.note       = S3M_NOTE_EMPTY   # 0xFF=empty, 0xFE=off, else (oct<<4|pitch)
        self.inst       = 0
        self.vol        = -1               # -1 = not set (use instrument default)
        self.effect     = 0               # 1-based letter index (0=none)
        self.effect_arg = 0

def parse_patterns(data: bytes, h: S3MHeader) -> list:
    """Returns list[pat_idx] of list[channel][row] → S3MRow."""
    patterns = []
    for pi, ptr in enumerate(h.pat_ptrs):
        # 32 channels × 64 rows
        grid = [[S3MRow() for _ in range(PATTERN_ROWS)] for _ in range(32)]
        if ptr == 0 or ptr + 2 > len(data):
            patterns.append(grid)
            continue
        pat_len = struct.unpack_from('<H', data, ptr)[0]
        end     = min(ptr + 2 + pat_len, len(data))
        pos     = ptr + 2
        row     = 0
        while row < PATTERN_ROWS and pos < end:
            b = data[pos]; pos += 1
            if b == 0:
                row += 1
                continue
            ch    = b & 0x1F
            has_n = bool(b & 0x20)
            has_v = bool(b & 0x40)
            has_e = bool(b & 0x80)
            cell  = grid[ch][row] if ch < 32 else S3MRow()
            if has_n:
                if pos + 1 >= end: break
                cell.note = data[pos]; pos += 1
                cell.inst = data[pos]; pos += 1
            if has_v:
                if pos >= end: break
                cell.vol = data[pos]; pos += 1
            if has_e:
                if pos + 1 >= end: break
                cell.effect     = data[pos];     pos += 1
                cell.effect_arg = data[pos];     pos += 1
        patterns.append(grid)
    return patterns


# ── Note / effect encoding ───────────────────────────────────────────────────

def encode_note(s3m_note: int) -> int:
    if s3m_note == S3M_NOTE_EMPTY:
        return NOTE_NOP
    if s3m_note == S3M_NOTE_OFF:
        return NOTE_CUT
    octave = (s3m_note >> 4) & 0xF
    pitch  = s3m_note & 0xF
    if pitch > 11:
        return NOTE_NOP
    semitones = (octave - 4) * 12 + pitch
    val = round(TAUD_C4 + semitones * 4096 / 12)
    return max(0x20, min(0xFFFF, val))


def encode_effect(cmd: int, arg: int, ch: int = 0, row: int = 0,
                  amiga_mode: bool = False) -> tuple:
    """Return (taud_op, taud_arg16, vol_override, pan_override).

    vol/pan_override is None or (selector, value). The caller is responsible
    for resolving ST3 zero-arg recalls before this point — see
    resolve_st3_recalls().

    amiga_mode mirrors the inverse of the S3M ``linear_slides`` flag.  When
    set, E/F coarse pitch-slide arguments are emitted as raw ST3 period units
    (the engine applies them directly in period space); when clear they are
    quantised to 4096-TET units via ``round(× 64/3)``.  Fine/extra-fine
    slides and tone portamento (G) are always linear regardless of mode.
    """
    if cmd == 0:
        return (TOP_NONE, 0, None, None)

    if cmd == EFF_A:
        if arg == 0:
            return (TOP_NONE, 0, None, None)
        return (TOP_A, (arg & 0xFF) << 8, None, None)

    if cmd == EFF_B:
        return (TOP_B, arg & 0xFF, None, None)

    if cmd == EFF_C:
        # ST3 stores break-row as BCD: $10 means decimal 10.
        bcd_row = ((arg >> 4) & 0xF) * 10 + (arg & 0xF)
        if bcd_row >= PATTERN_ROWS:
            bcd_row = 0
        return (TOP_C, bcd_row & 0xFF, None, None)

    if cmd == EFF_D:
        # D-style four-form arg passed through verbatim in the high byte.
        return (TOP_D, (arg & 0xFF) << 8, None, None)

    if cmd in (EFF_E, EFF_F):
        # Coarse: 1/16 semitone = 64/3 Taud units in linear mode; raw ST3 period
        # units in Amiga mode (engine consumes them in period space).
        # Fine/extra-fine (Exx with hi ∈ {E,F}): 1/64 semitone = 16/3 Taud units
        # in linear mode; raw ST3 period units in Amiga mode (engine consumes
        # them in period space, applied once per row at tick 0).
        op = TOP_E if cmd == EFF_E else TOP_F
        hi = (arg >> 4) & 0xF
        lo = arg & 0xF
        if hi in (0xE, 0xF) and lo > 0:
            if amiga_mode:
                return (op, 0xF000 | (lo & 0xFFF), None, None)
            return (op, 0xF000 | (round(lo * 16 / 3) & 0xFFF), None, None)
        if amiga_mode:
            return (op, arg & 0xFFFF, None, None)
        return (op, round(arg * 64 / 3) & 0xFFFF, None, None)

    if cmd == EFF_G:
        return (TOP_G, round(arg * 64 / 3) & 0xFFFF, None, None)

    if cmd in (EFF_H, EFF_I, EFF_R, EFF_U):
        op = {EFF_H: TOP_H, EFF_I: TOP_I, EFF_R: TOP_R, EFF_U: TOP_U}[cmd]
        hi = (arg >> 4) & 0xF
        lo = arg & 0xF
        return (op, ((hi * 0x11) << 8) | (lo * 0x11), None, None)

    if cmd == EFF_J:
        hi_semi = (arg >> 4) & 0xF
        lo_semi = arg & 0xF
        return (TOP_J, (J_SEMI_TABLE[hi_semi] << 8) | J_SEMI_TABLE[lo_semi],
                None, None)

    if cmd == EFF_K:
        # K = vibrato continuation + vol slide; emitted verbatim. ST3's shared
        # memory cohort is already resolved upstream by resolve_st3_recalls.
        return (TOP_K, (arg & 0xFF) << 8, None, None)

    if cmd == EFF_L:
        # L = tone-porta continuation + vol slide; emitted verbatim.
        return (TOP_L, (arg & 0xFF) << 8, None, None)

    if cmd == EFF_M:
        # M = set channel volume; literal byte (no recall). Clamp ST3/IT $40 → $3F.
        return (TOP_M, (min(arg, 0x3F) & 0xFF) << 8, None, None)

    if cmd == EFF_N:
        # N = channel volume slide; D-style encoding.
        return (TOP_N, (arg & 0xFF) << 8, None, None)

    if cmd == EFF_O:
        return (TOP_O, (arg & 0xFF) << 8, None, None)

    if cmd == EFF_P:
        # P = channel panning slide; D-style encoding (low nib = right, high nib = left).
        return (TOP_P, (arg & 0xFF) << 8, None, None)

    if cmd == EFF_Q:
        return (TOP_Q, (arg & 0xFF) << 8, None, None)

    if cmd == EFF_S:
        sub = (arg >> 4) & 0xF
        val = arg & 0xF
        if sub in (0x1, 0x2, 0x3, 0x4, 0xB, 0xC, 0xD, 0xE):
            vprint(f"    dropped S{sub:01X} at ch{ch} row{row}")
            return (TOP_S, (sub << 12) | (val << 8), None, None)
        if sub == 0x5:
            # Panbrello LFO waveform — maps directly to Taud S$5x00.
            return (TOP_S, 0x5000 | (val << 8), None, None)
        if sub == 0x8:
            # S8x: 4-bit → nibble-repeat into 8-bit SEL_SET pan
            pan8 = (val << 4) | val
            return (TOP_S, 0x8000 | pan8, None, None)
        if sub == 0xF:
            funk_table = [0, 5, 6, 7, 8, 0xA, 0xB, 0xD, 0x10, 0x13, 0x16, 0x1A, 0x20, 0x2B, 0x40, 0x80]
            return (TOP_S, 0xF000 | funk_table[x], None, None)
        # S0/S6/S7/S9/SA: filter, NNA, sound-control, stereo — drop silently.
        return (TOP_NONE, 0, None, None)

    if cmd == EFF_T:
        if arg >= 0x20:
            return (TOP_T, ((arg - 0x19) & 0xFF) << 8, None, None)
        # OpenMPT slide forms: $0y down per tick, $1y up per tick.
        return (TOP_T, arg & 0xFF, None, None)

    if cmd == EFF_V:
        return (TOP_V, (min(arg * 4, 0xFF) & 0xFF) << 8, None, None)

    if cmd == EFF_W:
        # W$xy: same nibble-pair layout as D, passed in the high byte.
        return (TOP_W, (arg & 0xFF) << 8, None, None)

    if cmd == EFF_X:
        return (TOP_S, 0x8000 | (arg & 0xFF), None, None)

    if cmd == EFF_Y:
        hi = (arg >> 4) & 0xF
        lo = arg & 0xF
        return (TOP_Y, ((hi * 0x11) << 8) | (lo * 0x11), None, None)

    if cmd == EFF_Z:
        return (TOP_NONE, 0, None, None)

    return (TOP_NONE, 0, None, None)


def resolve_st3_recalls(patterns: list, order_list: list, num_channels: int) -> None:
    """In-place: replace ST3 zero-arg recalls with the last non-zero arg.

    ST3 backs D/E/F/I/J/K/L/Q/R/S with a single per-channel memory slot.
    Taud's narrower cohort model can't recover this, so we eagerly resolve
    by walking patterns in order-list order and rewriting recall args.

    Limitation: patterns reused across multiple order entries are mutated
    once (with the memory state from their first visit); subsequent visits
    may differ from ST3 if cross-pattern memory state changed in between.
    """
    last_arg = [0] * num_channels
    for order in order_list:
        if order >= S3M_ORDER_END:
            break
        if order >= len(patterns):
            continue
        grid = patterns[order]
        for r in range(PATTERN_ROWS):
            for ch in range(num_channels):
                if ch >= len(grid):
                    continue
                row = grid[ch][r]
                if row.effect in ST3_SHARED_EFFECTS:
                    if row.effect_arg == 0:
                        row.effect_arg = last_arg[ch]
                    else:
                        last_arg[ch] = row.effect_arg


def warn_st3_quirks(patterns: list, order_list: list, num_channels: int) -> None:
    """Emit -v warnings for ST3 quirks Taud handles differently."""
    seen_pats = set()
    for order in order_list:
        if order >= S3M_ORDER_END:
            break
        if order >= len(patterns) or order in seen_pats:
            continue
        seen_pats.add(order)
        grid = patterns[order]
        for ch in range(min(num_channels, len(grid))):
            saw_sbx = saw_sex = False
            for r in range(PATTERN_ROWS):
                row = grid[ch][r]
                if row.effect == EFF_S:
                    sub = (row.effect_arg >> 4) & 0xF
                    if sub == 0xB: saw_sbx = True
                    elif sub == 0xE: saw_sex = True
            if saw_sbx and saw_sex:
                vprint(f"  warning: pattern {order} ch{ch} mixes SBx and SEx "
                       f"(Taud fixes the ST3 loop-counter bug; loop count may differ)")
        for r in range(PATTERN_ROWS):
            sex_channels = [ch for ch in range(min(num_channels, len(grid)))
                            if grid[ch][r].effect == EFF_S
                            and ((grid[ch][r].effect_arg >> 4) & 0xF) == 0xE]
            if len(sex_channels) > 1:
                vprint(f"  warning: pattern {order} row {r} SEx on multiple "
                       f"channels {sex_channels} (Taud uses ascending channel order)")


# ── Taud builders ────────────────────────────────────────────────────────────

def build_sample_inst_bin(instruments: list) -> tuple:
    """
    Returns (bin_bytes[786432], offsets_list, slot_ratios).
    Resamples globally if total exceeds SAMPLEBIN_SIZE; slot_ratios maps Taud
    slot → the ratio that slot's sample was resampled by (for TOP_O
    rescaling), and slot 0 — an O before any instrument byte — gets the pass's
    nominal ratio.
    """
    pcm_insts = [(i, inst) for i, inst in enumerate(instruments)
                 if inst is not None and inst.itype == S3M_TYPE_PCM and inst.sample_data]

    total = sum(len(inst.sample_data) for _, inst in pcm_insts)
    ratio = 1.0
    slot_ratios = {}
    if total > SAMPLEBIN_SIZE:
        ratio = SAMPLEBIN_SIZE / total
        vprint(f"  info: sample bin overflow ({total} bytes); resampling all by {ratio:.4f}")
        slot_ratios[0] = ratio
        for i, inst in pcm_insts:
            # Each looped sample gets the ratio that keeps its loop a whole
            # number of frames (taud_common.loop_resample_ratio).
            r = loop_resample_ratio(ratio, [(inst.loop_begin, inst.loop_end)] if (inst.flags & 1) else [])
            inst.sample_data  = resample_linear(inst.sample_data, r)
            inst.length       = len(inst.sample_data)
            inst.loop_begin, inst.loop_end = scale_loop(inst.loop_begin, inst.loop_end, r, inst.length)
            inst.c2spd        = max(1, round(inst.c2spd * r))
            slot_ratios[i + 1] = r

    sample_bin = bytearray(SAMPLEBIN_SIZE)
    offsets    = {}
    pos        = 0
    for idx, inst in pcm_insts:
        n = min(len(inst.sample_data), SAMPLEBIN_SIZE - pos)
        if n <= 0:
            vprint(f"  warning: sample bin full, dropping '{inst.name}'")
            offsets[idx] = 0
            inst.length  = 0
            continue
        sample_bin[pos:pos+n] = inst.sample_data[:n]
        offsets[idx] = pos
        if n < len(inst.sample_data):
            vprint(f"  warning: '{inst.name}' truncated from {len(inst.sample_data)} to {n}")
            inst.length = n
            inst.loop_end = min(inst.loop_end, n)
        pos += n

    # Build instrument bin (256 × 256 bytes)
    # New layout (terranmon.txt:2001+): LOOP words at 15/17/19, SUSTAIN words at 189/191/193.
    # S3M has no envelope sustain or loop, so SUSTAIN words stay zero.
    INST_STRIDE = 256
    inst_bin = bytearray(INSTBIN_SIZE)
    for i, inst in enumerate(instruments):
        taud_idx = i + 1
        if i >= 256:
            break
        if inst is None or inst.itype != S3M_TYPE_PCM:
            continue
        ptr      = offsets.get(i, 0) & 0xFFFFFFFF
        s_len    = min(inst.length, 65535)
        c2spd    = min(inst.c2spd, 65535)
        ps       = 0
        ls       = min(inst.loop_begin, 65535)
        le       = min(inst.loop_end,   65535)
        loop_mode = 1 if (inst.flags & 1) else 0
        flags_byte = loop_mode & 0x3   # 0b 0000 00pp

        # Volume envelope first point is full-scale; per-trigger initial level
        # is carried by Default Note Volume (byte 196), so the envelope
        # contributes a unit multiplier.
        env_vol = 63
        # Vol LOOP word: P=1 (envelope present) | b=1 (use envelope) — no actual
        # loop / sustain. P added 2026-05-06 alongside the pan/pf gate spec
        # change (terranmon.txt byte 16/18/20 bit 5); informational for vol but
        # set for consistency. Pan/PF stay zero so the engine sees P=0 there.
        vol_env_loop = 0x2020

        base = taud_idx * INST_STRIDE
        struct.pack_into('<I', inst_bin, base + 0,  ptr)        # u32 sample pointer
        struct.pack_into('<H', inst_bin, base + 4,  s_len)
        struct.pack_into('<H', inst_bin, base + 6,  c2spd)      # rate at TAUD_C4
        struct.pack_into('<H', inst_bin, base + 8,  ps)
        struct.pack_into('<H', inst_bin, base + 10, ls)
        struct.pack_into('<H', inst_bin, base + 12, le)
        inst_bin[base + 14] = flags_byte
        # LOOP words at 15/17/19; SUSTAIN words at 189/191/193 (left zero).
        struct.pack_into('<H', inst_bin, base + 15, vol_env_loop)
        struct.pack_into('<H', inst_bin, base + 17, 0)
        struct.pack_into('<H', inst_bin, base + 19, 0)
        # Volume env point 0: hold at env_vol indefinitely (offset minifloat = 0 → hold).
        inst_bin[base + 21] = env_vol
        inst_bin[base + 22] = 0
        # S3M has no continuous instrumentwise volume scaler — its `inst.volume`
        # (0..64) is purely the per-trigger initial value, equivalent to IT's
        # sample.vol. So byte 171 (IGV) stays at full and byte 196 (DNV)
        # carries the per-instrument default. Pre-2026-05-09 layout folded
        # inst.volume into IGV — see terranmon §2350.
        inst_bin[base + 171] = 0xFF                                                    # IGV: continuous unity
        inst_bin[base + 177] = 0x80 # default pan = centre (unused; pan env "p" flag not set)
        inst_bin[base + 182] = 0xFF # filter cutoff = off
        inst_bin[base + 183] = 0xFF # filter resonance = off
        inst_bin[base + 186] = 1 # NNA: note cut
        inst_bin[base + 196] = min(0xFF, round(min(inst.volume, 64) * 255 / 64))       # DNV

        vprint(f"  instrument[{base // INST_STRIDE}] '{inst.name}' ptr: '{ptr}', sampling rate: '{inst.c2spd}'")
        if inst.c2spd > 65535:
            vprint(f"  warning: sampling rate of '{inst.name}' exceeds 65535 (got '{inst.c2spd}')")

    return bytes(sample_bin) + bytes(inst_bin), offsets, slot_ratios


def _default_channel_pan(ch_setting: int) -> int:
    """Return Taud pan 0..63 from S3M channel-setting byte."""
    # Bits 4-7 of channel setting are ignored; left/right from bit 3
    # Actually the channel type (0-7 left, 8-15 right) encodes stereo side
    ch_type = ch_setting & 0x7F
    if 0 <= ch_type <= 7:
        return 16   # left
    elif 8 <= ch_type <= 15:
        return 47   # right
    return 31   # centre


def build_pattern(s3m_grid: list, ch_idx: int, default_pan: int,
                  linear_slides: bool, inst_vols: dict = None,
                  amiga_mode: bool = False) -> bytes:
    """Build a 512-byte Taud pattern for one S3M channel.

    Volume column: explicit S3M cell vol -> SEL_SET; M/N/K/L vol slides folded
    by encode_effect -> vol_override; otherwise SEL_FINE/0 (no-op). Per-
    instrument default volume lives in DNV (byte 196) and is consulted by
    the engine when the trigger row has no V column, so the converter
    doesn't need to emit SEL_SET=Sv on plain trigger rows.
    Pan column: row 0 emits SEL_SET = default_pan to position the channel;
    other rows default to SEL_FINE/0 unless an X/P/etc effect overrides.
    """
    if inst_vols is None:
        inst_vols = {}
    out = bytearray(PATTERN_BYTES)
    rows = s3m_grid[ch_idx] if ch_idx < len(s3m_grid) else [S3MRow()] * PATTERN_ROWS
    last_inst = 0             # 1-based; tracks which instrument is loaded on this channel
    for r, row in enumerate(rows[:PATTERN_ROWS]):
        note = encode_note(row.note)
        inst = row.inst   # S3M 1-based -> Taud 1-based

        if row.inst > 0:
            last_inst = row.inst

        op, arg, vol_override, pan_override = encode_effect(
            row.effect, row.effect_arg, ch_idx, r, amiga_mode=amiga_mode)

        # -- Volume column --
        if row.vol >= 0:
            vol_sel, vol_value = SEL_SET, min(row.vol, 0x3F)
            if vol_override is not None and vol_override[0] != SEL_SET:
                vprint(f"    ch{ch_idx} row{r}: dropped vol slide "
                       f"(cell already carries explicit volume)")
        elif vol_override is not None:
            vol_sel, vol_value = vol_override
        else:
            vol_sel, vol_value = SEL_FINE, 0   # no-op fine slide

        # ── Pan column ──
        if pan_override is not None:
            pan_sel, pan_value = pan_override
        elif r == 0:
            # Position channel to its default pan once per pattern (row 0).
            pan_sel, pan_value = SEL_SET, default_pan & 0x3F
        else:
            pan_sel, pan_value = SEL_FINE, 0

        vol_byte = (vol_value & 0x3F) | ((vol_sel & 0x3) << 6)
        pan_byte = (pan_value & 0x3F) | ((pan_sel & 0x3) << 6)

        base = r * 8
        struct.pack_into('<H', out, base + 0, note)
        out[base + 2] = inst & 0xFF
        out[base + 3] = vol_byte
        out[base + 4] = pan_byte
        out[base + 5] = op & 0xFF
        struct.pack_into('<H', out, base + 6, arg & 0xFFFF)
    return bytes(out)


def build_cue_sheet(order_list: list, num_pats_s3m: int, num_channels: int,
                    pat_remap: dict = None) -> bytes:
    """Build the 1024×32-byte cue sheet with 12-bit packed pattern numbers."""
    sheet = bytearray(NUM_CUES * CUE_SIZE)
    # Fill entire sheet with the "all disabled" cue (patterns=0xFFF, instr=0)
    for c in range(NUM_CUES):
        sheet[c*CUE_SIZE : c*CUE_SIZE+CUE_SIZE] = encode_cue([], 0)

    cue_idx = 0
    last_active = -1
    for order in order_list:
        if order == S3M_ORDER_END or cue_idx >= NUM_CUES:
            break
        if order == S3M_ORDER_SKIP:
            continue
        orig = [order * num_channels + v for v in range(num_channels)]
        pats = [pat_remap[p] if pat_remap else p for p in orig]
        sheet[cue_idx*CUE_SIZE : cue_idx*CUE_SIZE+CUE_SIZE] = encode_cue(pats, 0)
        last_active = cue_idx
        cue_idx += 1

    # Halt on the last active cue (instruction byte at offset 30), so the
    # engine stops immediately after that pattern completes with no silent gap.
    if last_active >= 0:
        set_cue_instruction(sheet, last_active, CUE_INST_HALT)
    elif cue_idx < NUM_CUES:
        # Edge case: no active cues at all — halt at cue 0.
        set_cue_instruction(sheet, 0, CUE_INST_HALT)

    return finalize_cue_sheet(sheet)[0]


def relocate_late_note_delays(patterns: list, order_list: list,
                              num_channels: int, initial_speed: int) -> None:
    """Move SDx-delayed notes to the next row when x ≥ tick speed.

    ST3 triggers a Note Delay during the current row; if x reaches the tick
    speed, the trigger never lands. When the next row in the same channel is
    empty, relocate the note (with delay = x − speed) so it actually plays.
    """
    visited = set()
    for order in order_list:
        if order >= S3M_ORDER_END:
            break
        if order >= len(patterns) or order in visited:
            continue
        visited.add(order)
        grid = patterns[order]
        speed = initial_speed
        for r in range(PATTERN_ROWS):
            for ch in range(min(num_channels, len(grid))):
                row = grid[ch][r]
                if row.effect == EFF_A and row.effect_arg > 0:
                    speed = row.effect_arg
                    break
            if r + 1 >= PATTERN_ROWS or speed <= 0:
                continue
            for ch in range(min(num_channels, len(grid))):
                row = grid[ch][r]
                if row.effect != EFF_S or row.note == S3M_NOTE_EMPTY:
                    continue
                if ((row.effect_arg >> 4) & 0xF) != 0xD:
                    continue
                x = row.effect_arg & 0xF
                if x < speed:
                    continue
                nxt = grid[ch][r + 1]
                if (nxt.note != S3M_NOTE_EMPTY or nxt.inst or nxt.effect
                        or nxt.effect_arg or nxt.vol != -1):
                    continue
                new_delay = x - speed
                nxt.note       = row.note
                nxt.inst       = row.inst
                nxt.vol        = row.vol
                if new_delay > 0:
                    nxt.effect     = EFF_S
                    nxt.effect_arg = 0xD0 | (new_delay & 0xF)
                row.note       = S3M_NOTE_EMPTY
                row.inst       = 0
                row.vol        = -1
                row.effect     = 0
                row.effect_arg = 0
                vprint(f"  fix: pat{order} ch{ch} row{r}: SD{x:X} ≥ speed{speed}, "
                       f"moved note to row{r+1}"
                       + (f" with SD{new_delay:X}" if new_delay > 0 else ""))


def find_initial_bpm_speed(patterns: list, order_list: list,
                           default_speed: int, default_tempo: int) -> tuple:
    """Scan first pattern in order for Axx/Txx in row 0 of any channel."""
    speed = default_speed or 6
    tempo = default_tempo or 125
    for order in order_list:
        if order >= S3M_ORDER_END:
            break
        if order >= len(patterns):
            continue
        grid = patterns[order]
        for ch_rows in grid:
            row = ch_rows[0]
            if row.effect == EFF_A and row.effect_arg > 0:
                speed = row.effect_arg
            if row.effect == EFF_T and row.effect_arg > 0:
                tempo = row.effect_arg
        break
    return speed, tempo


def _per_pattern_bxx_s3m(patterns: list):
    """Return callable(pat_idx) → (set_of_bxx_target_orders, kills_fallthrough)
    for `detect_subsongs`. `kills_fallthrough` is True iff the pattern carries
    a Bxx on its absolute last row (the unconditional terminating-jump idiom).
    S3M patterns are always 64 rows.
    """
    def fn(pat_idx: int):
        if pat_idx < 0 or pat_idx >= len(patterns):
            return set(), False
        grid = patterns[pat_idx]
        targets = set()
        last_row_has_b = False
        for ch in range(min(32, len(grid))):
            ch_rows = grid[ch]
            for r in range(min(PATTERN_ROWS, len(ch_rows))):
                cell = ch_rows[r]
                if getattr(cell, 'effect', 0) == EFF_B:
                    targets.add(cell.effect_arg)
                    if r == PATTERN_ROWS - 1:
                        last_row_has_b = True
        return targets, last_row_has_b
    return fn


def _build_song_payload_s3m(h: S3MHeader, patterns_template: list,
                            positions: list, sample_ratio: dict,
                            inst_vols: dict, active_channels: list,
                            *, song_label: str = 'song') -> tuple:
    """Build pattern bin + cue sheet + song-entry kwargs for one subsong.

    Returns (pat_comp, cue_comp, entry_kwargs). The caller fills in
    `song_offset` from the global layout. `patterns_template` is deep-copied
    so per-song stateful walks (recall resolution, late-note-delay
    relocation, Bxx remap) don't leak into the next subsong.
    """
    pats = copy.deepcopy(patterns_template)
    virtual_orders = [h.order_list[pos] for pos in positions]

    vprint(f"  [{song_label}] resolving ST3 shared-memory recalls…")
    resolve_st3_recalls(pats, virtual_orders, 32)
    warn_st3_quirks(pats, virtual_orders, 32)

    init_speed, _ = find_initial_bpm_speed(pats, virtual_orders,
                                           h.initial_speed, h.initial_tempo)
    relocate_late_note_delays(pats, virtual_orders, 32, init_speed)

    speed, tempo = find_initial_bpm_speed(pats, virtual_orders,
                                          h.initial_speed, h.initial_tempo)
    tempo = max(25, min(280, tempo))
    bpm_stored = (tempo - 25) & 0xFF
    vprint(f"  [{song_label}] initial speed={speed}, tempo(BPM)={tempo}")

    # Cue list (source pattern indices) and pos→cue mapping. Skip orders that
    # already terminate (S3M_ORDER_END) or point past the pattern table.
    cue_list = []
    pos_to_cue = {}
    for pos in positions:
        order = h.order_list[pos]
        if order >= S3M_ORDER_END or order >= len(pats):
            continue
        pos_to_cue[pos] = len(cue_list)
        cue_list.append(order)

    # Densely renumber the patterns this song actually emits.
    used_ordered = []
    seen = set()
    for src_pat in cue_list:
        if src_pat not in seen:
            used_ordered.append(src_pat)
            seen.add(src_pat)
    pat_idx_remap = {src: i for i, src in enumerate(used_ordered)}
    P_used = len(used_ordered)

    C = len(active_channels)
    if P_used * C > NUM_PATTERNS_MAX:
        sys.exit(
            f"error: [{song_label}] {P_used} patterns × {C} channels = "
            f"{P_used*C} > {NUM_PATTERNS_MAX} Taud pattern limit."
        )

    # Bxx remap: target source-position → cue-index. Cross-subsong jumps
    # clamp to cue 0 (loop the subsong rather than jump out of bounds). Walk
    # only the patterns this song actually emits.
    crossings = 0
    for src_pat in used_ordered:
        if src_pat >= len(pats): continue
        grid = pats[src_pat]
        for ch in range(min(32, len(grid))):
            for row in grid[ch]:
                if row.effect == EFF_B:
                    if row.effect_arg in pos_to_cue:
                        row.effect_arg = pos_to_cue[row.effect_arg] & 0xFF
                    else:
                        crossings += 1
                        row.effect_arg = 0
    if crossings:
        vprint(f"  warning: [{song_label}]: {crossings} Bxx target(s) cross "
               f"subsong boundary; clamped to cue 0")

    # Pattern bin: emit only patterns this song uses (densely indexed).
    default_pans = [_default_channel_pan(h.channel_settings[ch])
                    for ch in active_channels]
    pat_bin = bytearray()
    for src_pat in used_ordered:
        grid = pats[src_pat]
        for vi, ch in enumerate(active_channels):
            pat_bin += build_pattern(grid, ch, default_pans[vi],
                                      h.linear_slides, inst_vols,
                                      amiga_mode=not h.linear_slides)

    pat_bin = rescale_offset_effects_per_slot(bytes(pat_bin), P_used, C, sample_ratio)
    orig_count = P_used * C
    pat_bin, pat_remap, num_taud_pats = deduplicate_patterns(pat_bin, orig_count)
    vprint(f"  [{song_label}] patterns: {orig_count} → {num_taud_pats} unique "
           f"({orig_count - num_taud_pats} deduplicated)")

    # Cue sheet
    sheet = bytearray(NUM_CUES * CUE_SIZE)
    for c in range(NUM_CUES):
        sheet[c*CUE_SIZE:c*CUE_SIZE+CUE_SIZE] = encode_cue([], 0)

    last_active = -1
    for cue_idx, src_pat in enumerate(cue_list):
        if cue_idx >= NUM_CUES: break
        new_pat_idx = pat_idx_remap[src_pat]
        orig_pats = [new_pat_idx * C + v for v in range(C)]
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

    flags_byte = (0x00 if h.linear_slides else 0x01)
    entry_kwargs = dict(
        num_voices=C,
        num_patterns=num_taud_pats,
        bpm_stored=bpm_stored,
        tick_rate=speed,
        base_note=0xA000,   # C9
        base_freq=8363.0,
        flags_byte=flags_byte,
        pat_bin_comp_size=len(pat_comp),
        cue_sheet_comp_size=len(cue_comp),
        global_vol=0xFF,
        mixing_vol=180,
        num_cues=num_cues,
    )
    return pat_comp, cue_comp, entry_kwargs


def assemble_taud(h: S3MHeader, instruments: list, patterns: list,
                  with_project_data: bool = True) -> bytes:
    # Determine active channels (bit7 clear = enabled)
    active_channels = [i for i, cs in enumerate(h.channel_settings)
                       if i < 32 and not (cs & 0x80)][:NUM_VOICES]
    C = len(active_channels)
    P = len(patterns)
    vprint(f"  channels: {C}, s3m patterns: {P}")

    # Build sample+instrument bin (shared across subsongs)
    vprint("  building sample/instrument bin…")
    sampleinst_raw, _offsets, sample_ratio = build_sample_inst_bin(instruments)
    assert len(sampleinst_raw) == SAMPLEINST_SIZE
    compressed = compress_blob(sampleinst_raw, "sample+inst bin")
    comp_size  = len(compressed)

    # 1-based inst index → default volume (0..63) for note-trigger vol injection.
    inst_vols = {
        i + 1: min(inst.volume, 0x3F)
        for i, inst in enumerate(instruments)
        if inst is not None and inst.itype == S3M_TYPE_PCM
    }

    # ── Detect subsongs ──────────────────────────────────────────────────────
    subsongs = detect_subsongs(h.order_list, _per_pattern_bxx_s3m(patterns),
                               terminators=(S3M_ORDER_END,),
                               skip_marker=S3M_ORDER_SKIP)
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
        song_payloads.append(_build_song_payload_s3m(
            h, patterns, ss['positions'], sample_ratio, inst_vols,
            active_channels, song_label=label))

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

    # ── Project Data (optional) ──────────────────────────────────────────────
    # S3M instruments and samples share the same slot space, but carry two
    # distinct name fields: the 28-byte title (inst.name → INam) and the
    # 12-byte DOS filename (inst.filename → SNam). e.g. WHEN.s3m instrument #1
    # is titled "(c) Purple Motion / 1994" with sample name 'HIT1'.
    proj_data = b''
    proj_off  = 0
    if with_project_data:
        # INam is slot-indexed (slot 0 empty); SNam is pool-ordered and 0-based.
        inst_names   = [''] + [(inst.name     if inst is not None else '')
                               for inst in instruments[:255]]
        sample_names =        [(inst.filename if inst is not None else '')
                               for inst in instruments[:255]]
        proj_data = build_project_data(
            project_name=h.title,
            instrument_names=inst_names,
            sample_names=sample_names,
        )
        if proj_data:
            proj_off = cur_off
            vprint(f"  project data: {len(proj_data)} bytes @ offset {proj_off}")

    # ── Header ───────────────────────────────────────────────────────────────
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
    ap.add_argument('input',  help='Input .s3m file')
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
    h = parse_s3m(data)
    vprint(f"  title: '{h.title}'")
    vprint(f"  orders={h.order_count}, instruments={h.inst_count}, patterns={h.pat_count}")

    instruments = parse_instruments(data, h)
    patterns    = parse_patterns(data, h)

    taud = assemble_taud(h, instruments, patterns,
                         with_project_data=not args.no_project_data)

    with open(args.output, 'wb') as f:
        f.write(taud)

    print(f"wrote {len(taud)} bytes to '{args.output}'")
    if args.verbose:
        print(f"  magic ok: {taud[:8].hex()}", file=sys.stderr)


if __name__ == '__main__':
    main()
